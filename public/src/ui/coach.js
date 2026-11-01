/**
 * coach.js —— 隐藏式「玩法助手」（主界面角落的问号按钮）
 *
 * 只有玩家主动点问号时才打开，内容完全按**当前棋局现状**生成：
 *   ① 现在该做什么（当前这一步的交互）
 *   ② 这一步涉及什么规则（一句话讲清）
 *   ③ 我建议你怎么做 + 为什么（用现金 / 安全线 / 租金这些孩子看得懂的数字说话）
 * 另外附一份随时可查的「基本规则速查」。
 *
 * 铁律：只读内核（g），不写内核，不消耗随机数 —— 与同种子对拍、存档重放完全无关。
 */

import { h, num } from "./dom.js";
import { seatColor, zoneColor } from "./theme.js";
import { aiProvider } from "../core/ai.js";

const money = (v) => `¥${num(Math.round(v || 0))}`;

/** 局面速览：现金 / 资产 / 安全线 / 季节。 */
function overview(g, p) {
  const rows = [];
  if (p) {
    rows.push(["你的现金", money(p.cash)]);
    rows.push(["你的总资产", money(p.assets)]);
    rows.push(["你的地块", `${p.owned.size} 块（已建房 ${p.nBuild} 座）`]);
  }
  rows.push(["活命钱线", `${money(g.safetyLine())} —— 手上至少留这么多，才不会被一次收租打垮`]);
  rows.push(["全场最贵租金", money(g.maxRentOnBoard())]);
  if (g.seasonOn) {
    const sd = g.season ? g.d.seasons[g.season] : null;
    rows.push(["当前季节", g.season ? `${g.season}${sd ? `（${sd.zone}）` : ""}` : "还没抽到季节卡"]);
  } else {
    rows.push(["当前季节", "本局已关闭"]);
  }
  return h("table", { class: "kv coach-kv" },
    rows.map(([k, v]) => h("tr", null, h("th", null, k), h("td", null, v))));
}

/** 买地建议：给出「买 / 不买」与理由。 */
function adviseBuy(g, p, lm) {
  const after = p.cash - lm.price;
  const line = g.safetyLine();
  const ai = aiProvider.shouldBuy(g, p, lm);
  if (p.cash < lm.price) {
    return { call: "先别买", why: `你的现金 ${money(p.cash)} 不够付售价 ${money(lm.price)}，买不了。` };
  }
  if (after < line) {
    return {
      call: "先别买",
      why: `买下后现金只剩 ${money(after)}，低于活命钱线 ${money(line)}。`
        + `万一马上踩到别人的高价地，就要被迫抵押房子换钱，很吃亏。`,
    };
  }
  const r0 = g.rentOf(lm.cell, p) || lm.rent0;
  return {
    call: ai ? "买下来" : "可以买，但不急",
    why: `买下后还剩 ${money(after)}，在活命钱线 ${money(line)} 之上，安全。`
      + `这块地别人踩到要付租 ${money(lm.rent0)}，收几次就回本；`
      + `升成四合院后租金涨到 ${money(lm.rent1)}。`,
    extra: r0 ? `（当季加成下，你现在的租金是 ${money(r0)}）` : "",
  };
}

/** 建房建议：挑「租金涨得最狠又买得起」的那块。 */
function adviseBuild(g, p) {
  const opts = g.buildOptions(p);
  if (!opts.length) return { call: "这回合先不建", why: "现在没有可以升级的地块。" };
  const line = g.safetyLine();
  const ok = opts.filter((o) => o.affordable && p.cash - o.cost >= line * 0.5);
  const best = (ok.length ? ok : opts.filter((o) => o.affordable))
    .sort((a, b) => (b.gain / Math.max(1, b.cost)) - (a.gain / Math.max(1, a.cost)))[0];
  if (!best) {
    return {
      call: "这回合先不建",
      why: `升级至少要 ${money(Math.min(...opts.map((o) => o.cost)))}，`
        + `你的现金 ${money(p.cash)} 建完就低于活命钱线 ${money(line)} 了，先攒钱。`,
    };
  }
  const lm = g.lm(best.cell);
  return {
    call: `升「${lm.name}」`,
    why: `花 ${money(best.cost)}，别人踩到时租金多收 ${money(best.gain)}，`
      + `建完还剩 ${money(p.cash - best.cost)}，不影响安全。`,
  };
}

/** 背包客少走建议：把「少走一格」当成避雷。 */
function adviseSteps(g, p, steps) {
  const full = g.dangerOf(p, steps);
  const cands = [];
  for (const d of [1, 2]) if (steps - d >= 2) cands.push({ s: steps - d, d });
  const better = cands.find((c) => {
    const cost = g.dangerOf(p, c.s) || 0;
    return cost < (full || 0);
  });
  if (better) {
    return {
      call: `少走 ${better.d} 格（走 ${better.s} 格）`,
      why: `按原路线走 ${steps} 格要付租 ${money(full)}；`
        + `少走 ${better.d} 格只要 ${money(g.dangerOf(p, better.s) || 0)}，能省下路费避开贵地。`,
    };
  }
  return {
    call: "不用少走",
    why: full ? `前面第 ${steps} 格要付 ${money(full)}，少走也躲不掉更划算的格子。` : "前面没有要付租的地，正常走就好。",
  };
}

/** 依当前 pending 状态生成「现在该做什么 / 规则 / 建议」。 */
function advice(state) {
  const g = state.game;
  const pd = state.pending;
  if (!g || !pd) {
    return {
      now: "还没开局（或已结束）。",
      rule: "点底部的「🔄 新局」可以重新设置人数、称呼和玩法。",
      call: "先开局", why: "开局后每一轮都会轮流掷骰子走格。",
    };
  }
  switch (pd.kind) {
    case "roll": {
      const p = pd.p;
      const line = g.safetyLine();
      const tight = p.cash < line;
      return {
        now: `轮到你（${p.name}）了，点棋盘中间的骰子就能出发。`,
        rule: "两枚骰子的点数加起来，就是你要走的格数；绕一圈经过起点能领 ¥1500 过路钱。",
        call: tight ? "这一手先攒钱" : "正常掷骰子",
        why: tight
          ? `你的现金 ${money(p.cash)} 已经低于活命钱线 ${money(line)}，落点若是空地可以考虑不买，先把钱留住。`
          : `你的现金 ${money(p.cash)} 在活命钱线 ${money(line)} 之上，遇到便宜又好的地可以买下来收租。`,
      };
    }
    case "step":
      return {
        now: `还剩 ${pd.remain} 格。点亮起来的棋子或格子，点一下走一格。`,
        rule: "本局是「手动走格」：一格一格走，像真的用手指推着棋子走一样。想省事可以在底部把走格切成「自动」。",
        call: "一格一格走", why: "路过别人或自己的地块时可以顺便看清楚租金，最后一格才算落点结算。",
      };
    case "buy": {
      const a = adviseBuy(g, pd.p, pd.lm);
      return {
        now: `你停在了「${pd.lm.name}」（${pd.lm.zone}），要不要买下？`,
        rule: "买下后，别人停在这块地上就要给你租金；你自己停自己的地不用付钱。",
        call: a.call, why: a.why + (a.extra || ""),
      };
    }
    case "build": {
      const a = adviseBuild(g, pd.p);
      return {
        now: `你又走回了自己的「${g.posCell(pd.p.pos).name}」，要不要盖一栋房？`,
        rule: "走回自己已经买下的地，才能盖房：空地 → 四合院 → 城楼。"
          + "每回合最多盖 1 级，盖好后别人停在上面要多付租金。",
        call: a.call, why: a.why,
      };
    }
    case "steps": {
      const a = adviseSteps(g, pd.p, pd.steps);
      return {
        now: `你抽到了背包客技能：掷出 ${pd.steps} 格，可以自愿少走 1–2 格。`,
        rule: "少走能避开贵地，但也会离目标更远；最少要走 2 格。整局最多用 2 次技能。",
        call: a.call, why: a.why,
      };
    }
    case "cards":
      return {
        now: "有卡要翻开：点亮的那个卡摞，点一下翻一张。",
        rule: "机会 / 命运 / 寻宝 / 季节四种卡。效果在停下的那一刻就已经算好了，翻牌只是给你看发生了什么。"
          + "（季节卡是棋子过起点时抽的：抽到就换季，并立刻做掉卡上的小效果。）",
        call: "放心点开", why: "点开看看这张卡写了什么，就知道刚才的加减钱是怎么来的。",
      };
    case "ai":
      return {
        now: `${pd.p.name}（电脑）正在行动，稍等一下。`,
        rule: "电脑和你用同一套规则，只是它自己决定买不买、建不建。",
        call: "看看它怎么走", why: "观察电脑停在哪里、买不买，能帮你判断哪一片地值得抢。",
      };
    case "done":
      return { now: "这局结束了。", rule: "到最后一轮时，总资产最多的人获胜。", call: "再来一局", why: "换个随机种子，牌序和骰子都会变，是全新的一局。" };
    default:
      return { now: "游戏进行中。", rule: "轮流掷骰子走格，买房、收租。", call: "继续玩", why: "" };
  }
}

/** 基本规则速查（孩子看得懂的短句）。 */
const CHEATS = [
  ["怎么走", "点棋盘中间的骰子，两枚点数相加 = 走的格数。经过起点领 ¥1500。"],
  ["怎么赢", "走满 40 轮后，总资产（现金 + 地产价值）最多的人获胜；中途破产就出局。"],
  ["买地", "停在没有主人的地上，可以花钱买下来。别人停上去，就要给你租金。"],
  ["建房", "第一轮先占空地，不盖房。从第二轮起，只有又走回自己已经买下的那块地，才能盖 1 级房（空地 → 四合院 → 城楼）。"],
  ["租金怎么变贵", "轮到的季节会让某一片的地更贵（面板上写着是哪一片）。"],
  ["季节卡怎么用", "棋子每次经过起点，就抽 1 张季节卡：① 立刻换季 —— 当季那一片的地租金变贵；② 卡上还有个小效果（领钱 / 前进 / 免租…），抽到当场生效。"],
  ["过路费怎么算", "停在别人的地上就要付租金；付不起时系统会先帮你抵押房产换钱。"],
  ["身份技能", "开局每人抽一张身份卡，有各自的小技能，整局最多用 2 次。"],
  ["为什么有活命钱线", "系统建议你手上至少留一笔钱（约等于最贵的一次租金），不至于被一次收租打垮。"],
];

/**
 * 打开「玩法助手」弹层。内容按当前局面生成，开启期间跟随棋局自动刷新。
 * @param {object} state app.js 的 state（需要 game / pending / assets）
 * @returns {() => void} 关闭函数
 */
export function openCoach(state) {
  const body = h("div", { class: "dlg-body coach-body" });
  const close = h("button", { class: "btn primary", type: "button" }, "知道了");
  const node = h("div", { class: "dlg coach" },
    h("div", { class: "dlg-h" },
      h("b", null, "❓ 玩法助手"),
      h("p", null, "下面按你现在这盘棋的实际情况给你支招。")),
    body,
    h("div", { class: "dlg-actions" }, close));

  // 用**独立**的弹层，避免和「买地 / 建房 / 背包客」这些转盘式对话框抢同一个 #sheet：
  // 那些对话框正开着时点问号，若共用容器会把对话框顶掉，导致内核在等一个永远不来的答复。
  const sheetEl = h("div", { class: "sheet coach-sheet" }, node);
  const ov = h("div", { class: "overlay coach-ov" }, sheetEl);

  /** 局面签名：只有它变了才重建内容。 */
  const signature = () => {
    const g = state.game;
    const p = state.curPlayer && state.curPlayer.kind === "human" ? state.curPlayer : null;
    const a = advice(state);
    return JSON.stringify([
      a.now, a.rule, a.call, a.why,
      p ? [p.cash, p.assets, p.owned.size, p.nBuild, p.pos] : null,
      g ? [g.round, g.season, g.seasonChanges, g.maxRentOnBoard(), g.safetyLine(), g.log.length] : null,
      state.pending ? state.pending.kind : null,
    ]);
  };

  let lastSig = null;
  const draw = () => {
    const sig = signature();
    // 关键：局面没变就别重建。旧版每 700ms 无条件 replaceChildren，
    // 内容被清空再填回 → 滚动位置被打回起点，玩家怎么滑都滑不动。
    if (sig === lastSig) return;
    lastSig = sig;

    const g = state.game;
    const a = advice(state);
    const p = state.curPlayer && state.curPlayer.kind === "human" ? state.curPlayer : null;
    const keep = sheetEl.scrollTop;        // 重建前记住滚动位置，重建后还原
    body.replaceChildren(
      h("div", { class: "coach-sec" },
        h("h4", null, "现在这一步"),
        h("p", { class: "coach-now" }, a.now)),
      h("div", { class: "coach-sec" },
        h("h4", null, "这一步的规则"),
        h("p", null, a.rule)),
      h("div", { class: "coach-sec coach-tip" },
        h("h4", null, "我建议"),
        h("p", null, h("b", null, a.call)),
        a.why ? h("p", { class: "muted" }, a.why) : null),
      g ? h("div", { class: "coach-sec" },
        h("h4", null, "局面速览"),
        overview(g, p)) : null,
      h("details", { class: "coach-cheat" },
        h("summary", null, "基本规则速查"),
        h("ul", null, CHEATS.map(([k, v]) => h("li", null, h("b", null, k), h("span", null, v))))),
    );
    sheetEl.scrollTop = keep;
  };

  document.body.append(ov);
  draw();
  requestAnimationFrame(() => ov.classList.add("in"));

  // 打开期间跟随棋局刷新（关掉后自动停）
  const timer = setInterval(() => { if (!node.isConnected) { clearInterval(timer); return; } draw(); }, 700);

  const shut = () => { clearInterval(timer); };

  const closeUp = () => {
    shut();
    ov.classList.remove("in");
    setTimeout(() => ov.remove(), 260);
  };
  close.addEventListener("click", closeUp);
  // 点弹层背景（不是内容）也能关
  ov.addEventListener("click", (e) => { if (e.target === ov) closeUp(); });
  return closeUp;
}
