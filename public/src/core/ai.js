/**
 * ai.js —— AI（电脑玩家）决策 provider
 *
 * 1:1 移植 engine.py 的 `_should_buy` / `_ai_build` / `_backpacker_adjust`。
 * ⚠️ 这三个函数**不消耗随机数**，这是「AI 模式可与 Python 同种子对拍」的前提。
 *    若日后要在决策里引入随机（如随机放弃），必须同步改 engine.py，
 *    否则同种子对拍立刻失效。
 *
 * 内核（engine.js）通过 decisions provider 调用，人类玩家可换成 UI provider。
 */

import { num } from "./engine.js";

export const aiProvider = {
  /** 买地决策：留够活命钱；优先凑齐分区；季节分区加分。 */
  shouldBuy(g, p, lm) {
    const safe = Math.max(g.aiSafe, g.maxRentOnBoard());
    if (p.cash - lm.price < safe) return false;
    let score = lm.price * 0.5 + lm.rent0 * 6;
    const zone = lm.zone;
    const cells = g.d.zoneCells[zone] || [];
    const have = cells.filter((c) => p.owned.has(c)).length;
    if (have === cells.length - 1) score += 4000;
    if (g.seasonOn && g.season && zone === g.d.seasons[g.season].zone) score += 1500;
    return score > lm.price || p.cash > lm.price * 4;
  },

  /** 建房决策：按「收益/成本」挑最优的一块，每回合最多建 1 级。 */
  build(g, p) {
    const cands = g.buildOptions(p).filter((c) => c.affordable);
    if (!cands.length) return false;
    // 等价 Python `cands.sort(reverse=True)`（元组 (ratio, cell, cost) 降序）
    cands.sort((A, B) => (B.ratio - A.ratio) || (B.cell - A.cell) || (B.cost - A.cost));
    return g.applyBuild(p, cands[0].cell);
  },

  /** I-03 背包客：掷骰后自愿少走 1–2 格，只在能少付租金时才少走。 */
  adjustMove(g, p, steps) {
    if (p.id !== "I-03") return steps;
    const base = g.dangerOf(p, steps);
    let best = steps, bestd = base;
    for (const d of [1, 2]) {
      if (steps - d < 2) continue; // 2d6 最小 2
      const dd = g.dangerOf(p, steps - d);
      if (dd < bestd) { best = steps - d; bestd = dd; }
    }
    if (best !== steps) {
      g.say(`    ${p.name} 少走 ${steps - best} 格，避开 ¥${num(base)} 租金 → 落到 ¥${num(bestd)}`);
    }
    return best;
  },
};

/** 活命钱：随场上最高租金水涨船高（防 AI 后期把钱花光）。 */
export function safetyLine(g) {
  return g.safetyLine();
}

export default aiProvider;
