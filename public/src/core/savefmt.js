/**
 * savefmt.js —— 存档格式与「规则指纹」（纯逻辑，零 DOM）
 *
 * 存档 = 配置 + 随机种子 + 人工决策序列；读档靠「确定性重放」。
 * 重放是**位置式**的（`recorded.shift()`），只要规则一变，决策序列就会静默错位，
 * 读出来的将是一盘看似正常、其实已经跑偏的棋。所以在存档头里写入两枚指纹，
 * 读档前先校验：对不上就明确拒绝，而不是悄悄放行。
 *
 *   ① rulesFingerprint()   —— RULES_PATCH 的**全部取值**（口径改了 → 指纹翻）
 *   ② cfgFingerprint(cfg)  —— 影响内核走向的开局字段（人数/棋子/加料开关/高级设置）
 *
 * ⚠️ 指纹只覆盖「规则与配置」，不覆盖 APP_VERSION ——
 *    纯 UI 版本升级不应让旧存档失效；真正会破坏重放的是规则变化，由指纹兜住。
 */

import { RULES_PATCH } from "./rules.js";

/** 当前存档结构版本。结构一变就 +1，旧存档会被明确拒绝（而不是解析出一盘错棋）。 */
export const SAVE_VERSION = 2;

/** 影响内核走向的 cfg 字段（顺序固定，保证串化稳定）。 */
const CFG_KERNEL_KEYS = [
  "players", "pawns", "seasonOn", "buildRule", "skillLimit",
  "seasonMode", "seasonScale", "hutong", "hutongDraw",
];

/** 缺省值：与 ui/app.js 的建局默认、core/engine.js 的内核默认保持一致。 */
const CFG_DEFAULTS = {
  players: 4, pawns: 1, seasonOn: true, buildRule: "free", skillLimit: 2,
  seasonMode: "cell", seasonScale: 1, hutong: true, hutongDraw: false,
};

/**
 * 稳定串化：对象键按字典序排列，同一份数据永远得到同一串。
 * （JSON.stringify 依赖插入顺序，取指纹必须自己排序，否则跨版本/跨端会漂。）
 */
export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

/** FNV-1a 32 位 → 8 位十六进制。用于指纹，不用于任何安全用途。 */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 规则指纹：RULES_PATCH 里每一条取值。任何一条口径改动都会让指纹变化。 */
export function rulesFingerprint() {
  const o = {};
  for (const [k, def] of Object.entries(RULES_PATCH)) o[k] = def.value;
  return hash32(stableStringify(o));
}

/** 把 cfg 归一成「内核实际看到的形态」（补默认值、统一数值类型）。 */
function kernelCfg(cfg) {
  const src = cfg && typeof cfg === "object" ? cfg : {};
  const o = {};
  for (const k of CFG_KERNEL_KEYS) {
    let v = src[k];
    if (v === undefined || v === null) v = CFG_DEFAULTS[k];
    if (k === "players" || k === "pawns" || k === "skillLimit") v = Number(v);
    if (k === "seasonScale") v = Number(v) || 1;
    if (k === "seasonOn" || k === "hutong" || k === "hutongDraw") v = !!v;
    o[k] = v;
  }
  return o;
}

/** 配置指纹：只覆盖影响内核走向的字段（称呼 / 种子 / 音效等不影响重放）。 */
export function cfgFingerprint(cfg) {
  return hash32(stableStringify(kernelCfg(cfg)));
}

/** 每轮最多产生的人工决策条数（买地 / 建房 / 走位）× 座位数 —— 长度异常的上限。 */
const DECISIONS_PER_TURN = 3;

/**
 * 校验一份存档。
 * @returns {{ok:boolean, reason:string}} reason 为可直接展示给用户的中文原因
 */
export function validateSave(save) {
  if (!save || typeof save !== "object" || Array.isArray(save)) return { ok: false, reason: "存档内容为空或格式不对" };
  if (save.v !== SAVE_VERSION) {
    return { ok: false, reason: `存档结构版本 ${save.v ?? "未知"}，当前需 ${SAVE_VERSION}` };
  }
  if (!save.cfg || typeof save.cfg !== "object") return { ok: false, reason: "存档缺少开局配置" };
  if (save.fp !== rulesFingerprint()) return { ok: false, reason: "游戏规则已更新，旧存档无法重放" };
  if (save.cfgFp !== cfgFingerprint(save.cfg)) return { ok: false, reason: "开局配置与存档不符" };

  if (!Number.isInteger(save.round) || save.round < 1) return { ok: false, reason: "存档轮次非法" };
  if (!Array.isArray(save.recorded)) return { ok: false, reason: "人工决策序列缺失" };
  for (const v of save.recorded) {
    if (v !== null && typeof v !== "boolean" && typeof v !== "number") {
      return { ok: false, reason: "人工决策序列含非法条目（只允许 真/假/数字）" };
    }
  }
  const players = Number(save.cfg.players) || CFG_DEFAULTS.players;
  const cap = players * save.round * DECISIONS_PER_TURN + 16;
  if (save.recorded.length > cap) {
    return { ok: false, reason: `人工决策序列长度异常（${save.recorded.length} > 上限 ${cap}）` };
  }
  return { ok: true, reason: "" };
}

/**
 * 组装一份存档（统一出口，保证指纹字段永远与内容同步）。
 * @param {{cfg:object, round:number, recorded:Array, engine?:string, savedAt?:number}} o
 */
export function buildSave({ cfg, round, recorded, engine = "", savedAt = 0 }) {
  return {
    v: SAVE_VERSION,
    engine,
    fp: rulesFingerprint(),
    cfgFp: cfgFingerprint(cfg),
    savedAt,
    cfg,
    round,
    recorded: Array.isArray(recorded) ? recorded.slice() : [],
  };
}

/** 存档摘要（存档列表用；对损坏存档返回 null）。 */
export function summarize(save) {
  if (!save || typeof save !== "object") return null;
  const names = (save.cfg && save.cfg.names || []).filter((s) => String(s || "").trim());
  return {
    round: Number(save.round) || 0,
    players: Number(save.cfg && save.cfg.players) || 0,
    names: names.slice(0, 4),
    savedAt: Number(save.savedAt) || 0,
    engine: String(save.engine || ""),
  };
}
