/**
 * panels.js —— 侧栏面板：季节 / 玩家 / 行情 + 底部日志
 *
 * 所有数字都直接来自内核对象（现金、资产、租金一律走 g.rentOf 等），
 * 面板不自行推算规则，避免与 engine.py 的口径分叉。
 */

import { h, clear, num } from "./dom.js";
import { seatColor, zoneColor, pawnKey, JC } from "./theme.js";

const RULES_TEXT = {
  "I-01": (v) => `开局免费拿下前 6 格中的 1 块空地（值 ¥${num(v)}）`,
  "I-02": (v) => `每次付租可减免 ¥${num(v)}`,
  "I-03": (v) => `掷骰后自愿少走 1–2 格（避开贵地）`,
  "I-04": (v) => `自己收租时可做讲解，本次 +¥${num(v)}`,
  "I-05": (v) => `建房成本便宜 ¥${num(v)}`,
  "I-06": (v) => `别人停你地时，租金 +¥${num(v)}`,
  "I-07": (v) => `开局带 ${v} 次重掷`,
  "I-08": () => `开局连抽 3 张机会卡，但欠银行 ¥2,000（每 4 轮还 ¥1,000）`,
};

/** 季节面板：当前季节 + 效果说明 + 四个季节卡位。 */
export function renderSeason(box, g, assets) {
  const { data } = assets;
  const cur = g.seasonOn ? g.season : null;
  const sd = cur ? data.seasons[cur] : null;
  const scaleTxt = g.seasonScale === 1 ? "翻一倍" : "涨得更狠（×2 力度）";
  // 用孩子看得懂的句子说清「哪些地会变贵」
  const modeTxt = {
    cell: "🎯 只有抽到的那一片地变贵",
    player: "🏘️ 那片的房东，别处的地也跟着贵",
    focus: "✨ 抽到的那片翻倍，其他地方只贵一点点",
  }[g.seasonMode];

  clear(box);
  box.append(
    h("div", { class: "panel-h" }, "季节", h("span", { class: "panel-hint" }, g.seasonOn ? "开" : "关")),
    !g.seasonOn ? h("p", { class: "muted" }, "本局已关闭季节机制。") : h("div", { class: "season-now" },
      h("div", { class: "season-badge", style: { "--zc": sd ? zoneColor(sd.zone) : JC.ink } },
        h("b", null, cur || "—"),
        h("span", null, sd ? sd.zone : "还没抽到季节卡")),
      h("div", { class: "season-info" },
        h("div", null, "当季租金：", h("b", null, scaleTxt)),
        h("div", { class: "muted" }, modeTxt),
        sd ? h("div", { class: "muted" }, sd.reason) : null,
        h("div", { class: "muted" }, `本局已换季 ${g.seasonChanges} 次`)),
    ),
  );
}

/** 玩家面板：现金/资产/地块/技能。 */
export function renderPlayers(box, g, cfg, assets, opts = {}) {
  clear(box);
  box.append(h("div", { class: "panel-h" }, "玩家",
    h("span", { class: "panel-hint" }, `${g.n} 人${g.pawns > 1 ? ` · 每 ${g.pawns} 子` : ""}`)));

  // 领先条：把「总资产」画成一根根横条，谁最长谁最富 —— 比一串数字好懂。
  const lead = Math.max(1, ...g.players.map((p) => p.assets));
  box.append(h("div", { class: "lead" },
    h("div", { class: "lead-h" }, "谁最富（总资产）"),
    g.players.map((p) => h("div", { class: `lead-row${p.alive ? "" : " dead"}` },
      h("span", { class: "lead-nm", style: { "--sc": seatColor(p.idx) } }, p.name),
      h("div", { class: "lead-track" },
        h("i", { class: "lead-fill", style: { width: `${Math.round((p.assets / lead) * 100)}%` } })),
      h("span", { class: "lead-val" }, `¥${num(p.assets)}`)))));

  // 身份标签：只有「全场仅一位真人」时才叫「你」；两位以上真人时用「真人」区分，
  // 电脑一律「电脑」。旧版把所有真人都标成「你」，两人对战时两块区域都写「你」。
  const humanCount = g.players.filter((p) => p.kind === "human").length;
  for (const p of g.players) {
    const isHuman = p.kind === "human";
    const owner = !isHuman ? "电脑" : (humanCount === 1 ? "你" : "真人");
    const skillLeft = g.skillLimit ? `${g.skillLimit - p.skillUsed}/${g.skillLimit}` : "不限";
    const art = assets && assets.manifest && assets.manifest.pawns
      ? assets.manifest.pawns[pawnKey(p.idx)] : null;
    // 现金变动飘字：与上一帧比较，钱变了就在数字旁飘一个 +¥ / -¥（悄悄记在本帧快照上）
    const prevCash = p._cashUI;
    p._cashUI = p.cash;
    const cashDelta = (opts.animate && prevCash !== undefined) ? p.cash - prevCash : 0;
    const rows = [];
    for (const [cell, lvl] of [...p.owned].sort((a, b) => a[0] - b[0])) {
      const lm = g.lm(cell);
      const o = g.ownerOf.get(cell);
      const rent = o === p.idx ? g.rentOf(cell, p) : 0;
      rows.push(h("li", null,
        h("i", { style: { background: zoneColor(lm.zone) } }),
        h("span", { class: "pn" }, lm.name),
        lvl > 0 ? h("span", { class: "plv" }, lvl === 1 ? "四合院" : "城楼") : null,
        h("span", { class: "prt" }, o === p.idx ? `租 ¥${num(rent)}` : "—")));
    }
    box.append(h("div", { class: `pcard${p.alive ? "" : " dead"}${isHuman ? " me" : ""}` },
      h("div", { class: "pc-head" },
        h("span", { class: "pc-av", style: { "--sc": seatColor(p.idx) }, title: `${p.idx + 1} 号座` },
          art ? h("img", { src: assets.url(art), alt: "", draggable: "false" }) : null,
          h("i", { class: "av-no" }, String(p.idx + 1))),
        h("b", null, p.name),
        h("span", { class: "tag" }, owner),
        p.alive ? null : h("span", { class: "tag dead-tag" }, "已破产")),
      h("div", { class: "pc-stats" },
        h("div", { class: "st-cash" }, h("span", null, "现金"),
          h("b", null, `¥${num(p.cash)}`,
            cashDelta
              ? h("em", { class: `cash-float ${cashDelta > 0 ? "up" : "down"}` },
                `${cashDelta > 0 ? "+" : "-"}¥${num(Math.abs(cashDelta))}`)
              : null)),
        h("div", null, h("span", null, "总资产"), h("b", null, `¥${num(p.assets)}`)),
        h("div", null, h("span", null, "地块"), h("b", null, `${p.owned.size} 块 / 建 ${p.nBuild}`)),
        h("div", null, h("span", null, "技能余"), h("b", null, `${skillLeft} 次`))),
      h("div", { class: "pc-skill" }, (RULES_TEXT[p.id] || (() => p.identity.skill))(p.identity.skill_value)),
      rows.length ? h("ul", { class: "pc-lands" }, rows) : null,
    ));
  }
}

/** 地价表：按分区列地块——归属、价格、当前租金（当季加成已计入）。 */
export function renderMarket(box, g, assets) {
  const { data } = assets;
  clear(box);
  box.append(h("div", { class: "panel-h" }, "地价表",
    h("span", { class: "panel-hint" }, `最贵的租 ¥${num(g.maxRentOnBoard())}`)));

  const seasonZone = g.seasonOn && g.season ? data.seasons[g.season].zone : null;
  for (const z of data.zones) {
    const cells = data.zoneCells[z.name] || [];
    const seasonOn = z.name === seasonZone;
    const rows = cells.slice().sort((a, b) => a - b).map((cell) => {
      const lm = data.byCell[cell];
      const oi = g.ownerOf.has(cell) ? g.ownerOf.get(cell) : null;
      const owner = oi === null ? null : g.players[oi];
      const lvl = owner ? owner.owned.get(cell, 0) : 0;
      const rent = owner ? g.rentOf(cell, owner) : lm.rent0;
      return h("li", { class: `mk-row${owner ? "" : " free"}${seasonOn ? " season" : ""}` },
        h("span", { class: "mk-cell" }, `${cell}`),
        h("span", { class: "mk-name" }, lm.name),
        owner
          ? h("span", { class: "mk-own", style: { background: seatColor(owner.idx) } },
            `${owner.name}${lvl ? (lvl === 1 ? "·院" : "·楼") : ""}`)
          : h("span", { class: "mk-own none" }, "可买"),
        h("span", { class: "mk-rent" }, `租 ¥${num(rent)}`),
      );
    });
    box.append(h("div", { class: `zone-block${seasonOn ? " season" : ""}` },
      h("div", { class: "zone-h", style: { "--zc": zoneColor(z.name) } },
        h("i", null), h("b", null, z.name),
        h("span", null, `${cells.length} 块`),
        seasonOn ? h("em", null, "当季涨价") : null),
      h("ul", { class: "mk-list" }, ...rows),
    ));
  }
}

/**
 * 日志：把内核 log 的新增行追加进 DOM（自动滚到底）。
 *
 * 筛选走「容器上打标记 + CSS 隐藏」：`#log[data-filter="lg-rent"] .lg:not(.lg-rent){display:none}`，
 * 因此切换筛选**不需要重建节点**（长局也不卡），只要把 from 传 0 强制重建一次即可。
 * 每一轮的**第一行**额外加 `.lg-anchor`，配合 CSS `position:sticky` 做「第 N 轮」吸顶。
 *
 * @param {HTMLElement} logEl #log
 * @param {string[]} lines 内核 g.log
 * @param {string} filter 全部 = "all"，其余为要单看的行类别
 * @param {number} from 已绘制到的行号；0 = 清空重建
 */
export function renderLog(logEl, lines, filter = "all", from = 0) {
  logEl.dataset.filter = filter;
  if (from === 0 || from > lines.length) logEl.replaceChildren();

  const frag = document.createDocumentFragment();
  const anchored = new Set();
  for (let i = from; i < lines.length; i++) {
    const s = lines[i];
    const cls = logLineClass(s);
    const round = cls === "lg-turn" ? roundOf(s) : 0;
    const attrs = { class: `lg ${cls}` };
    if (round && !anchored.has(round)) {
      anchored.add(round);
      attrs.class += " lg-anchor";
      attrs.id = `lgr-${round}`;
    }
    frag.append(h("div", attrs, s));
  }
  logEl.append(frag);
  logEl.scrollTop = logEl.scrollHeight;
  syncLogJump(logEl, lines);
}

/** 行 -> 类别（与日志配色一一对应）。 */
function logLineClass(s) {
  if (s.startsWith("第") && s.includes("轮 ")) return "lg-turn";
  if (s.includes("★ 换季")) return "lg-seasonswap";
  if (s.includes("☠")) return "lg-dead";
  if (s.includes("买下") || s.includes("建到")) return "lg-buy";
  if (s.includes("付租")) return "lg-rent";
  if (s.includes("寻宝") || s.includes("机会：") || s.includes("命运：")) return "lg-card";
  return "";
}
const roundOf = (s) => { const m = /^第(\d+)轮/.exec(s); return m ? Number(m[1]) : 0; };

/** 日志工具条里的「跳到第 N 轮」下拉（仅「全部」视图可用，筛选时轮次行会被隐藏）。 */
function syncLogJump(logEl, lines) {
  const sel = document.getElementById("logJump");
  if (!sel) return;
  const rounds = [];
  const seen = new Set();
  for (const s of lines) {
    const n = logLineClass(s) === "lg-turn" ? roundOf(s) : 0;
    if (n && !seen.has(n)) { seen.add(n); rounds.push(n); }
  }
  sel.replaceChildren(h("option", { value: "" }, "跳到轮次…"),
    ...rounds.map((n) => h("option", { value: String(n) }, `第 ${n} 轮`)));
  sel.disabled = logEl.dataset.filter !== "all" || rounds.length === 0;
  if (!sel.__bound) {
    sel.__bound = true;
    sel.addEventListener("change", () => {
      const n = Number(sel.value);
      const target = n ? document.getElementById(`lgr-${n}`) : null;
      if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
      sel.value = "";
    });
  }
}
