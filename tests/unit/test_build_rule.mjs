/**
 * test_build_rule.mjs —— 建房规则回归测试（线下大富翁口径）
 *
 * 口径（见《设计方案定稿》· 建房规则）：
 *   /Users/sevensimle/Documents/@西北人的成长/10-Projects/个人项目/童领计划/京韵大富翁_胡同漫游记/01_项目定义/02_游戏设计书/设计方案定稿.md
 *   ① 第一轮只能占空地，不建房；
 *   ② 从第二轮起，只有**本回合停留的正是自己先前已占下的地块**才能加盖 1 级；
 *   ③ 级数上限 = RULES_PATCH.build_levels.value（空地 0 → 四合院 1 → 城楼 2）。
 *
 * 这套测试用「AI 自动对局 + 记录每一次建房决策」来证明规则真的被内核执行，
 * 而不是只改了文档 —— 旧版「第一轮落下空地就弹建房窗」正是被这里拦住。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PyRandom } from "../../public/src/core/pyrandom.js";
import { GameData } from "../../public/src/core/gamedata.js";
import { Game } from "../../public/src/core/engine.js";
import { aiProvider } from "../../public/src/core/ai.js";
import { RULES_PATCH } from "../../public/src/core/rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, "../../public/assets/data/gamedata.json");

const MAX_LVL = RULES_PATCH.build_levels.value;
const SEEDS = [1, 2, 3, 7, 42, 99, 2026, 555];
const CONFIGS = [
  { name: "4人·标准", players: 4, buildRule: "free" },
  { name: "3人·标准", players: 3, buildRule: "free" },
  { name: "2人·每方2子", players: 2, pawns: 2, buildRule: "free" },
  { name: "4人·须集齐分区", players: 4, buildRule: "monopoly" },
];

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log(`  ✗ ${msg}`); }
}

/** 带记录的 decisions provider：不消耗随机数，语义与 aiProvider 完全一致。 */
function recording(records) {
  return {
    shouldBuy: (g, p, lm) => aiProvider.shouldBuy(g, p, lm),
    build: (g, p) => {
      // 决策前先快照，用来核对「必须是走回来的旧地」
      const rec = {
        round: g.round, idx: p.idx, pawn: p.cur, pos: p.pos,
        landedWasOwned: p.landedWasOwned,
        ownedBefore: p.owned.has(p.pos),
        levelBefore: p.owned.get(p.pos),
      };
      const built = aiProvider.build(g, p);
      if (built) records.push(rec);
      return built;
    },
    adjustMove: (g, p, s) => aiProvider.adjustMove(g, p, s),
  };
}

const data = new GameData(JSON.parse(fs.readFileSync(DATA, "utf8")));

let totalBuilds = 0;
for (const c of CONFIGS) {
  let cfgBuilds = 0;
  let bad = 0;
  for (const seed of SEEDS) {
    const records = [];                 // 逐局独立，避免不同种子的同号回合相互“撞车”
    const round1Violations = [];
    const g = new Game(data, {
      rng: new PyRandom(seed), nPlayers: c.players, pawns: c.pawns || 1,
      seasonOn: true, buildRule: c.buildRule,
      decisions: recording(records),
    });
    // 第一轮内每次落地后，建房候选必须为空（只占空地、不建房）
    await g.play({
      afterLand: (gg, p) => {
        if (gg.round < 2 && gg.buildOptions(p).length > 0) {
          round1Violations.push(`seed=${seed} 第${gg.round}轮 ${p.name} 落点 ${gg.posCell(p.pos).name}`);
        }
      },
    });
    ok(round1Violations.length === 0,
      `${c.name} seed=${seed} 第一轮出现了建房候选：${round1Violations.join("；")}`);

    // 逐条核对建房记录
    const perTurn = new Map();
    for (const r of records) {
      if (r.round < 2) bad += 1, ok(false, `${c.name} seed=${seed} 第${r.round}轮就建房了（应 ≥2）`);
      if (!r.landedWasOwned) bad += 1, ok(false, `${c.name} seed=${seed} 在「本回合刚落下的新地」上建房（pos=${r.pos}，应只在走回来的旧地）`);
      if (!r.ownedBefore) bad += 1, ok(false, `${c.name} seed=${seed} 在非自有地上建房（pos=${r.pos}）`);
      if (r.levelBefore < 0 || r.levelBefore >= MAX_LVL) bad += 1, ok(false, `${c.name} seed=${seed} 建房前级数 ${r.levelBefore} 越界（0..${MAX_LVL - 1}）`);
      const key = `${r.round}#${r.idx}#${r.pawn}`;
      perTurn.set(key, (perTurn.get(key) || 0) + 1);
    }
    for (const [key, n] of perTurn) {
      if (n > 1) bad += 1, ok(false, `${c.name} seed=${seed} 同一次行棋建房 ${n} 次（${key}，每回合最多升 1 级）`);
    }
    cfgBuilds += records.length;
  }
  totalBuilds += cfgBuilds;
  console.log(`  ✓ ${c.name}：${SEEDS.length} 局 · 建房 ${cfgBuilds} 次，规则全部合规`);
}

// 规则收紧后建房机制必须仍然活着（否则「合规」只是因为根本不建）
ok(totalBuilds > 0, `所有配置合计建房 ${totalBuilds} 次 —— 建房机制不应被误关`);

console.log(`\n[build-rule] 通过 ${pass} / 失败 ${fail}（累计建房 ${totalBuilds} 次）`);
process.exit(fail === 0 ? 0 : 1);
