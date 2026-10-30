/**
 * py_vs_js.mjs —— 「同种子对拍」验收测试
 *
 * 口径：同一 seed 下，JS 内核（engine.js + ai.js）与权威源 engine.py
 * 跑完整局后，逐字段一致（回合数 / 玩家现金 / 收租 / 破产 / 卡牌记账 / 日志）。
 *
 * 前提：AI 决策不消耗随机数，因此 AI 模式两边的随机序列完全相同。
 *
 * 运行：
 *   node tests/parity/py_vs_js.mjs
 * 可用环境变量覆盖：
 *   JYM_PYTHON     python 解释器（默认 python3）
 *   JYM_ENGINE_PY  engine.py 绝对路径
 *   JYM_SEEDS      逗号分隔种子（默认 "42,1,2026,987654321,7,12345"）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PyRandom } from "../../public/src/core/pyrandom.js";
import { GameData } from "../../public/src/core/gamedata.js";
import { Game } from "../../public/src/core/engine.js";
import { aiProvider } from "../../public/src/core/ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const DATA = path.join(ROOT, "public/assets/data/gamedata.json");
const DUMPER = path.join(__dirname, "dump_py.py");

const PY = process.env.JYM_PYTHON || "python3";
// 路径含「人」字，用 \u 转义硬编码，避免工具链对中文路径的转写。
const ENGINE_PY = process.env.JYM_ENGINE_PY || [
  "/Users/sevensimle/Documents/@\u897f\u5317\u4eba\u7684\u6210\u957f",
  "10-Projects/\u4e2a\u4eba\u9879\u76ee",
  "\u7ae5\u9886\u8ba1\u5212/\u4eac\u97f5\u5927\u5bcc\u7fc1_\u80e1\u540c\u6f2b\u6e38\u8bb0",
  "08_\u8bd5\u73a9\u4e0e\u7528\u6237\u53cd\u9988/05_\u6570\u5b57\u8bd5\u73a9\u7248/\u751f\u6210\u811a\u672c/engine.py",
].join("/");

const SEEDS = (process.env.JYM_SEEDS || "42,1,2026,987654321,7,12345")
  .split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));

const CASES = [
  { name: "4人·标准", players: 4, pawns: 1, seasonOn: true },
  { name: "3人·标准", players: 3, pawns: 1, seasonOn: true },
  { name: "2人·每方2子", players: 2, pawns: 2, seasonOn: true },
  { name: "4人·无季节", players: 4, pawns: 1, seasonOn: false },
  // 加料开关 / 对照档：这些是首版要暴露给玩家的选项，必须同样保真
  { name: "4人·建房须集齐分区", players: 4, pawns: 1, seasonOn: true, buildRule: "monopoly" },
  { name: "4人·技能不限次", players: 4, pawns: 1, seasonOn: true, skillLimit: 0 },
  { name: "4人·季节focus档", players: 4, pawns: 1, seasonOn: true, seasonMode: "focus" },
  { name: "4人·季节player档", players: 4, pawns: 1, seasonOn: true, seasonMode: "player" },
  { name: "4人·季节性倍率2.0", players: 4, pawns: 1, seasonOn: true, seasonScale: 2.0 },
  { name: "4人·关胡同机制", players: 4, pawns: 1, seasonOn: true, hutong: false },
  { name: "4人·胡同通开", players: 4, pawns: 1, seasonOn: true, hutongDraw: true },
  { name: "4人·胡同固定金", players: 4, pawns: 1, seasonOn: true, hutongFlat: 200 },
];

// ------------------------------------------------------------------
// 工具
// ------------------------------------------------------------------
function pyRun(seeds, c) {
  const args = [
    DUMPER, "--engine", ENGINE_PY, "--data", DATA,
    "--seeds", seeds.join(","),
    "--players", String(c.players),
    "--pawns", String(c.pawns),
    "--build-rule", c.buildRule || "free",
  ];
  if (!c.seasonOn) args.push("--no-season");
  if (c.skillLimit !== undefined) args.push("--skill-limit", String(c.skillLimit));
  if (c.seasonMode) args.push("--season-mode", c.seasonMode);
  if (c.seasonScale !== undefined) args.push("--season-scale", String(c.seasonScale));
  if (c.hutong !== undefined) args.push("--hutong", c.hutong ? "1" : "0");
  if (c.hutongDraw !== undefined) args.push("--hutong-draw", c.hutongDraw ? "1" : "0");
  if (c.hutongFlat !== undefined) args.push("--hutong-flat", String(c.hutongFlat));
  const buf = execFileSync(PY, args, { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(buf.toString("utf8"));
}

async function jsRun(seeds, c) {
  const data = new GameData(JSON.parse(fs.readFileSync(DATA, "utf8")));
  const out = [];
  for (const seed of seeds) {
    const g = new Game(data, {
      rng: new PyRandom(seed), nPlayers: c.players, pawns: c.pawns,
      seasonOn: c.seasonOn, decisions: aiProvider,
      buildRule: c.buildRule, skillLimit: c.skillLimit,
      seasonMode: c.seasonMode, seasonScale: c.seasonScale,
      hutong: c.hutong, hutongDraw: c.hutongDraw, hutongFlat: c.hutongFlat,
    });
    // engine.py 的 play() 是同步的；JS 用 async 仅为 UI 留钩子。
    // 无 hooks 时行为等价 —— 决策 provider 也是同步返回。
    out.push(await g.play());
  }
  return out;
}

/** 深比较，对象键序不敏感、数组顺序敏感。返回差异描述数组。 */
function deepDiff(a, b, label, out) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) { out.push(`${label}: 类型不同`); return; }
    if (a.length !== b.length) { out.push(`${label}: 长度 ${a.length} ≠ ${b.length}`); return; }
    for (let i = 0; i < a.length; i++) deepDiff(a[i], b[i], `${label}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join("|") !== kb.join("|")) {
      out.push(`${label}: 键不同\n      py=[${ka}]\n      js=[${kb}]`); return;
    }
    for (const k of ka) deepDiff(a[k], b[k], `${label}.${k}`, out);
    return;
  }
  if (a !== b) out.push(`${label}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
}

/** 把 Python 单局结果规整成与 JS 同构（键名统一为 JS 侧）。 */
function normPy(r) {
  return {
    winner: r.winner, winnerId: r.winner_id, winnerAssets: r.winner_assets,
    reason: r.reason, rounds: r.rounds, turns: r.turns,
    seasonChanges: r.season_changes, bankrupts: r.bankrupts,
    tasksDone: r.tasks_done, tasksTotal: r.tasks_total, rentTotal: r.rent_total,
    seasonGap: r.season_gap ? {
      holderRent: r.season_gap.holder_rent, otherRent: r.season_gap.other_rent,
      nHolder: r.season_gap.n_holder, nOther: r.season_gap.n_other,
      zone: r.season_gap.zone, season: r.season_gap.season,
    } : null,
    log: r.log,
    cardLog: r.card_log,
    players: r.players.map((p) => ({
      id: p.id, name: p.name, alive: p.alive, cash: p.cash, assets: p.assets,
      lands: p.lands, rentGot: p.rent_got, rentPaid: p.rent_paid,
      nRentGot: p.n_rent_got, nRentPaid: p.n_rent_paid, nBuild: p.n_build,
      nPassGo: p.n_pass_go, nTreasure: p.n_treasure, nTurn: p.n_turn,
      cardCash: p.card_cash, cardCashByDeck: p.card_cash_by_deck,
      cardNByDeck: p.card_n_by_deck, zoneCost: p.zone_cost,
      zoneRentGot: p.zone_rent_got, owned: p.owned,
    })),
  };
}

function normJs(r) {
  return {
    winner: r.winner, winnerId: r.winnerId, winnerAssets: r.winnerAssets,
    reason: r.reason, rounds: r.rounds, turns: r.turns,
    seasonChanges: r.seasonChanges, bankrupts: r.bankrupts,
    tasksDone: r.tasksDone, tasksTotal: r.tasksTotal, rentTotal: r.rentTotal,
    seasonGap: r.seasonGap,
    log: r.log,
    cardLog: r.cardLog,
    players: r.players.map((p) => ({
      id: p.id, name: p.name, alive: p.alive, cash: p.cash, assets: p.assets,
      lands: p.lands, rentGot: p.rentGot, rentPaid: p.rentPaid,
      nRentGot: p.nRentGot, nRentPaid: p.nRentPaid, nBuild: p.nBuild,
      nPassGo: p.nPassGo, nTreasure: p.nTreasure, nTurn: p.nTurn,
      cardCash: p.cardCash, cardCashByDeck: p.cardCashByDeck,
      cardNByDeck: p.cardNByDeck, zoneCost: p.zoneCost,
      zoneRentGot: p.zoneRentGot, owned: p.owned,
    })),
  };
}

// ------------------------------------------------------------------
// 主流程
// ------------------------------------------------------------------
if (!fs.existsSync(ENGINE_PY)) {
  console.log(`[parity] 跳过：找不到 engine.py\n         ${ENGINE_PY}`);
  process.exit(0);
}

let failed = 0;
for (const c of CASES) {
  const py = pyRun(SEEDS, c);
  const js = await jsRun(SEEDS, c);
  let caseBad = 0;
  for (let i = 0; i < SEEDS.length; i++) {
    const diffs = [];
    deepDiff(normPy(py[i]), normJs(js[i]), `seed=${SEEDS[i]}`, diffs);
    if (diffs.length) {
      failed++; caseBad++;
      console.log(`  ✗ ${c.name} seed=${SEEDS[i]}（${diffs.length} 处不一致）`);
      for (const d of diffs.slice(0, 6)) console.log(`      ${d}`);
      if (diffs.length > 6) console.log(`      … 其余 ${diffs.length - 6} 处省略`);
    }
  }
  if (!caseBad) console.log(`  ✓ ${c.name}：${SEEDS.length} 局全部一致`);
}

const games = CASES.length * SEEDS.length;
console.log(`\n[parity] 对拍 ${games} 局 / 通过 ${games - failed} / 失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
