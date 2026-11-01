/**
 * test_gamedata.mjs —— 数据层单元测试
 *
 * 对应 check_consistency.py 的权威数字（地标 28 / 棋盘 40 格 / 身份卡 8 / 卡牌 108）。
 * 任一断言失败 → 说明 gamedata.json 与文档库口径脱节，必须先修数据再谈规则。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GameData, EXPECTED } from "../../public/src/core/gamedata.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, "../../public/assets/data/gamedata.json");

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${msg}`); }
}
function eq(a, b, msg) { ok(a === b, `${msg}（期望 ${b}，实际 ${a}）`); }

const raw = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
const data = new GameData(raw);

// --- 结构性校验（走内核同一条 validate）---
const errs = data.validate();
ok(errs.length === 0, `GameData.validate() 应全绿，实际：\n     ${errs.join("\n     ")}`);

// --- 权威数字逐项复核 ---
eq(data.board.length, 40, "棋盘格数");
eq(data.landmarks.length, 28, "地标数");
eq(data.identities.length, 8, "身份卡数");
eq(data.decks.chance.length, 20, "机会卡数");
eq(data.decks.destiny.length, 20, "命运卡数");
eq(data.decks.treasure.length, 20, "寻宝卡数");
eq(data.decks.season.length, 12, "季节卡数");

// --- 棋盘构成 ---
const typeCount = {};
for (const c of data.board) typeCount[c.type] = (typeCount[c.type] || 0) + 1;
eq(typeCount["地标"], 28, "棋盘上「地标」格数");
eq(typeCount["角"], 4, "棋盘上「角」格数");
eq(typeCount["寻宝"], 3, "棋盘上「寻宝」格数");
eq(typeCount["机会"] + typeCount["命运"], 5, "棋盘上「机会+命运」格数");

// --- 地标必须落在类型为「地标」的格上，且格号唯一 ---
const cells = new Set();
let dupCell = null, wrongType = null, badNum = null;
for (const lm of data.landmarks) {
  if (cells.has(lm.cell)) dupCell = lm.cell;
  cells.add(lm.cell);
  if (data.board[lm.cell]?.type !== "地标") wrongType = lm.cell;
  // 数值取整：价格必须是整百（目标年龄段要能心算）
  if (lm.price % 100 !== 0 || lm.rent0 % 100 !== 0 || lm.rent1 % 100 !== 0
    || lm.rent2 % 100 !== 0 || lm.build <= 0 || lm.mortgage <= 0) {
    badNum = lm.name;
  }
}
ok(dupCell === null, `地标格号应唯一，重复：${dupCell}`);
ok(wrongType === null, `地标落在非「地标」格：${wrongType}`);
ok(badNum === null, `地标数值应为非负整百、建筑/抵押为正：${badNum}`);

// --- 同名门禁：地标格在棋盘上的「格名」必须等于地标名 ---
// 背景：v1.7 的「价格错位重排」只落在纸样渲染器的内存里，没回写工作簿，于是
// gamedata.json 的 board[i].name 长期停留在旧格名（28 格中 24 格与地标表不符）。
// 结果同一个格子在日志/悬停提示里叫一个名、在棋盘格与买地窗里叫另一个名。
// 印刷棋盘已对账为「与地标表 28/28 一致」，故地标名为唯一权威口径 —— 这条断言
// 用来防止同步素材时再次把旧格名带进来。只比名字，不比价格/租金/归属。
const nameMismatch = [];
for (const lm of data.landmarks) {
  const c = data.board[lm.cell];
  if (c && c.name !== lm.name) nameMismatch.push(`格${lm.cell} 格名=${c.name} / 地标名=${lm.name}`);
}
ok(nameMismatch.length === 0,
  `地标格的格名应与地标名一致，不一致 ${nameMismatch.length} 处：\n     ${nameMismatch.join("\n     ")}`);

// --- 分区：7 个分区，地块合计 = 28，胡同街巷 6 块 ---
const zones = Object.keys(data.zoneCells);
eq(zones.length, 7, "分区数");
eq(data.zoneCells["胡同街巷"].length, 6, "胡同街巷地块数");
ok(!zones.some((z) => data.zoneCells[z].length < 3), "每个分区至少 3 块地");

// --- 身份卡：总估值极差 < 5%（G5）---
const totals = data.identities.map((i) => i.total);
const spread = (Math.max(...totals) - Math.min(...totals)) / Math.min(...totals);
ok(spread < 0.05, `身份卡总估值极差 ${(spread * 100).toFixed(2)}% 应 < 5%`);

// --- 恒定分区：新北京 / 新城文化 / 京郊胜境 ---
eq(data.constantZones.size, 3, "恒定分区数");
ok(data.constantZones.has("新北京") && data.constantZones.has("京郊胜境"), "恒定分区内容正确");

// --- 卡牌：字段齐备 + effect 取值在已知集合内 ---
const EFFECTS = {
  chance: new Set(["交易", "折扣", "现金", "移动", "规则", "道具"]),
  destiny: new Set(["回合", "现金", "移动", "规则", "选择", "道具"]),
  treasure: new Set(["挑战", "现金", "移动", "规则", "选择", "道具"]),
  season: new Set(["借地", "免租", "共游", "口播", "寻宝", "拼车", "现金", "移动", "讲解", "赠券", "选择", "问答"]),
};
let badField = null, unknownEff = null;
for (const [deck, cards] of Object.entries(data.decks)) {
  for (const c of cards) {
    if (c.no === undefined || c.text === undefined || c.effect === undefined || c.value === undefined) {
      badField = `${deck}#${c.no}`;
    }
    if (!EFFECTS[deck].has(c.effect)) unknownEff = `${deck}#${c.no} → ${c.effect}`;
  }
}
ok(badField === null, `卡牌字段缺失：${badField}`);
ok(unknownEff === null, `出现未登记的 effect：${unknownEff}`);

// --- 季节卡：4 色 × 3 张，且 to_zone 可解析 ---
const seasonColor = {};
for (const c of data.decks.season) {
  const head = (c.to_zone || "").split("｜")[0];
  seasonColor[head] = (seasonColor[head] || 0) + 1;
}
eq(Object.keys(seasonColor).length, 4, "季节卡颜色数");
ok(Object.values(seasonColor).every((n) => n === 3), `季节卡 4 色各 3 张，实际 ${JSON.stringify(seasonColor)}`);

// --- EXPECTED 常量自洽 ---
eq(EXPECTED.cells, data.board.length, "EXPECTED.cells 与实际一致");
eq(EXPECTED.landmarks, data.landmarks.length, "EXPECTED.landmarks 与实际一致");

console.log(`\n[gamedata] 通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
