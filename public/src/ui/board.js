/**
 * board.js —— 11×11 棋盘渲染（几何口径 1:1 来自 gen_playkit_jingcheng.py::cell_geom）
 *
 * 口径（权威）：
 *   格 0 在**右下角**（col=10,row=10），沿底边向左走、逆时针绕行。
 *   四角旋转 0 / -90 / 180 / 90。
 *
 * 两种朝向：
 *   flat  —— 全部正向（默认，屏幕可读性好）
 *   paper —— 还原纸样朝向（顶行 180°、左列 -90°、右列 90°）
 */

import { h, clear } from "./dom.js";
import { zoneColor, zonePat, TYPE_COLOR, seatColor, pawnKey, SEAT_EMOJI, JC } from "./theme.js";

/** 格号 -> 网格坐标与纸样旋转角（0 基）。 */
export function cellGeom(idx) {
  if (idx === 0) return { c: 10, r: 10, rot: 0 };
  if (idx <= 9) return { c: 10 - idx, r: 10, rot: 0 };
  if (idx === 10) return { c: 0, r: 10, rot: -90 };
  if (idx <= 19) return { c: 0, r: 10 - (idx - 10), rot: -90 };
  if (idx === 20) return { c: 0, r: 0, rot: 180 };
  if (idx <= 29) return { c: idx - 20, r: 0, rot: 180 };
  if (idx === 30) return { c: 10, r: 0, rot: 90 };
  return { c: 10, r: idx - 30, rot: 90 };
}

/** 四角格 -> 特殊格图标键（manifest.special 的键） */
const CORNER_ICON = { 0: "start", 10: "rest", 20: "teahouse", 30: "lost" };
/** 非地标格 -> 牌堆键（用卡背当格子图标） */
const TYPE_DECK = { 机会: "chance", 命运: "destiny", 寻宝: "treasure" };
const LEVEL_NAME = ["空地", "四合院", "城楼"];

/** 组装单格静态结构。 */
function buildCell(i, data, manifest, url) {
  const g = cellGeom(i);
  const cell = data.board[i];
  const isLm = cell.type === "地标";
  const lm = data.byCell[i];

  const inner = h("div", { class: "cellin" });

  // 主图
  let art = "";
  if (isLm) art = manifest.landmarks[lm.id];
  else if (cell.type === "角") art = manifest.special[CORNER_ICON[i]];
  else art = manifest.cardBacks[TYPE_DECK[cell.type]];
  inner.append(h("img", { class: "cell-art", src: url(art), alt: cell.name, loading: "lazy", draggable: "false" }));

  // 分区/类型色条
  const stripColor = isLm ? zoneColor(lm.zone) : (TYPE_COLOR[cell.type] || JC.ink);
  const stripPat = isLm ? zonePat(lm.zone) : "pat-solid";
  const stripText = isLm ? lm.zone : cell.type;
  inner.append(h("div", {
    class: `cell-strip ${stripPat}`, title: stripText,
    style: { "--zc": stripColor },
  }, stripText));

  // 名称 + 价格
  const label = h("div", { class: "cell-label" },
    h("span", { class: "nm" }, isLm ? lm.name : cell.name));
  if (isLm) label.append(h("span", { class: "pr" }, `¥${lm.price}`));
  inner.append(label);

  // 动态层：归属徽章 + 棋子
  const ownerEl = h("div", { class: "cell-owner" });
  const pawnsEl = h("div", { class: "cell-pawns" });
  inner.append(ownerEl, pawnsEl);

  const el = h("div", {
    class: `cell t-${cell.type}${isLm ? "" : " t-plain"}`,
    style: { gridColumn: g.c + 1, gridRow: g.r + 1, "--rot": `${g.rot}deg` },
    dataset: { cell: String(i) },
    title: `${i}. ${cell.name}${isLm ? `（${lm.zone}｜¥${lm.price}｜租金 ¥${lm.rent0}/${lm.rent1}/${lm.rent2}）` : ""}`,
  }, inner);
  if (isLm) el.classList.add("is-lm");
  if (cell.type === "角") el.classList.add("is-corner");
  return { el, ownerEl, pawnsEl, type: cell.type };
}

/**
 * 中心区（照 R3 优化稿版式重做）：
 *   标题居上 → 常驻骰子盘 → 四摞卡位横排 → 季节盘；底层铺 R3 中心插画。
 *   骰子是「可点即掷」的常驻交互件（触屏仿真，不再用底部按钮）。
 *   卡摞平时呈「未激活」态（灰、不可点），只有落点命中才亮起（见 board.css .pile.armed）。
 */
function buildCenter(data, manifest, url) {
  const artFile = (manifest.special && manifest.special.center)
    || Object.values(manifest.special || {}).find((p) => p.includes("board_center_illustration"));

  const piles = [
    { deck: "chance", name: "机会", cls: "p-chance" },
    { deck: "destiny", name: "命运", cls: "p-destiny" },
    { deck: "treasure", name: "寻宝", cls: "p-treasure" },
    { deck: "season", name: "季节", cls: "p-season" },
  ].map(({ deck, name, cls }) => h("div", {
    class: `pile ${cls}`, dataset: { deck }, title: `${name}卡`,
  },
  h("img", { src: url(manifest.cardBacks[deck]), alt: `${name}卡背`, draggable: "false" }),
  h("div", { class: "pile-meta" },
    h("b", null, name),
    h("span", { class: "pile-count", dataset: { count: deck } }, "—")),
  ));

  const tray = h("div", {
    class: "dice-tray", id: "diceTray", role: "button", tabindex: "0",
    "aria-label": "掷骰子", title: "点我掷骰子",
  },
  h("div", { class: "dice-row" },
    h("div", { class: "die", id: "dieA" }),
    h("div", { class: "die", id: "dieB" })),
  h("div", { class: "dice-sum", id: "diceSum" }, "等待开局"),
  );

  const dial = h("div", { class: "season-dial", id: "seasonDial" },
    data.seasonOrder.map((s) => h("div", {
      class: "s-chip", dataset: { season: s },
      style: { "--zc": zoneColor(data.seasons[s].zone) },
    },
    h("b", null, s),
    h("span", null, data.seasons[s].zone))),
  );

  const head = h("div", { class: "center-head" },
    h("div", { class: "ct-main" }, "京韵大富翁"),
    h("div", { class: "ct-sub" }, "胡同漫游记"),
    h("div", { class: "center-turn", id: "centerTurn" }),
  );

  return h("div", { class: "center", style: { gridColumn: "2 / 11", gridRow: "2 / 11" } },
    artFile ? h("img", { class: "center-art", src: url(artFile), alt: "棋盘中心插画", draggable: "false" }) : null,
    head, tray, ...piles, dial,
  );
}

// ==================================================================
// 尺寸自适应（替代容器查询单位）
// ==================================================================
/*
 * 设备端 WebView 为 101，而容器查询单位 cqw 自 Chrome 105 才引入 ——
 * board.css 里所有 cqw 声明会被整条判为非法丢弃，格内字号退化成继承值，
 * 于是「字体过大、11×11 棋盘被撑破」。这里用最朴素的办法取代它：
 * 量出棋盘可用区域（宽高中的较小边），写成两个自定义属性给 CSS 用。
 *   --bw  棋盘外框边长（px）
 *   --u   棋盘内边长度的 1%（px）—— 所有格内尺寸按它等比缩放
 */
const BOARD_PAD = 6;      // 与 board.css 的 .board padding 对应
const BOARD_BORDER = 2;   // 与 board.css 的 .board border 对应

/** 量测并把 --bw / --u 写到棋盘元素上。 */
export function fitBoard(root) {
  const wrap = root.parentElement;
  if (!wrap) return;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  if (!w || !h) return;
  const size = Math.max(160, Math.floor(Math.min(w, h)));
  const inner = Math.max(80, size - (BOARD_PAD + BOARD_BORDER) * 2);
  root.style.setProperty("--bw", `${size}px`);
  root.style.setProperty("--u", `${inner / 100}px`);
}

let boardRO = null;
let boardRAF = 0;
/** 监听棋盘可用区域变化（窗口缩放、侧栏收起/全屏），节流到下一帧。 */
function watchBoardSize(root) {
  fitBoard(root);
  const kick = () => {
    if (boardRAF) return;
    boardRAF = requestAnimationFrame(() => { boardRAF = 0; fitBoard(root); });
  };
  if (typeof ResizeObserver === "function") {
    if (boardRO) boardRO.disconnect();
    boardRO = new ResizeObserver(kick);
    boardRO.observe(root.parentElement);
  }
  window.addEventListener("resize", kick);
  window.addEventListener("orientationchange", kick);
}

/** 一次性建棋盘（之后只做增量更新）。 */
export function buildBoard(root, assets) {
  clear(root);
  const { data, manifest, url } = assets;
  const cells = [];
  for (let i = 0; i < data.board.length; i++) cells.push(buildCell(i, data, manifest, url));
  // 跳格玩偶：纯展示层，挂在棋盘内随格移动（不参与布局）
  // 本体用「座位配色圆环 + 棋子立绘」（糖葫芦/鸽哨/脸谱/黄包车）
  const walker = h("div", { class: "walker", hidden: true },
    h("img", { class: "wk-img", alt: "", draggable: "false" }),
    h("span", { class: "wk-no" }, ""),
    h("span", { class: "wk-step" }, "0"));
  // 走格预告小标签：手动推棋子时贴在「下一格」上方，写清那格是谁的、要付多少 / 可买多少。
  // 纯展示层，pointer-events:none，不拦任何点击。
  const stepTip = h("div", { class: "step-tip", hidden: true },
    h("span", { class: "st-txt" }, ""));
  const center = buildCenter(data, manifest, url);
  root.append(...cells.map((c) => c.el), center, walker, stepTip);
  root.dataset.orient = "flat";
  const piles = {};
  for (const el of center.querySelectorAll(".pile")) piles[el.dataset.deck] = el;
  watchBoardSize(root);
  return { cells, pawnSig: "", ownerSig: "", walker, stepTip, piles, assets };
}

/** 座位 -> 棋子立绘 URL（素材缺失时返回空串，调用方回退到字符棋子）。 */
export function pawnSrc(assets, idx) {
  const m = assets && assets.manifest && assets.manifest.pawns;
  const p = m && m[pawnKey(idx)];
  return p ? assets.url(p) : "";
}

/** 取某格中心在棋盘坐标系里的位置（供跳格玩偶定位）。 */
export function cellCenter(root, idx) {
  const el = root.querySelector(`.cell[data-cell="${idx}"]`);
  if (!el) return null;
  return { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 };
}

/** 增量刷新：归属徽章 + 棋子 + 当前格高亮。 */
export function updateBoard(refs, g, opts = {}) {
  // ---- 归属 ----
  const own = new Map(); // cell -> {idx, lvl}
  for (const [cell, idx] of g.ownerOf) {
    const pl = g.players[idx];
    own.set(cell, { idx, lvl: pl && pl.owned ? pl.owned.get(cell, 0) : 0 });
  }
  const ownSig = [...own].map(([c, v]) => `${c}:${v.idx}:${v.lvl}`).join("|");
  if (ownSig !== refs.ownerSig) {
    refs.ownerSig = ownSig;
    for (const c of refs.cells) {
      const i = Number(c.el.dataset.cell);
      const o = own.get(i);
      c.ownerEl.replaceChildren();
      c.el.classList.toggle("owned", !!o);
      if (!o) continue;
      const col = seatColor(o.idx);
      c.el.style.setProperty("--oc", col);
      c.ownerEl.append(h("span", { class: "owner-chip", style: { background: col } },
        `${o.idx + 1}号 ${LEVEL_NAME[o.lvl] || o.lvl}`));
    }
  }

  // ---- 棋子 ----
  const pawns = new Map(); // cell -> [{pi,k}]
  for (const p of g.players) {
    if (!p.alive) continue;
    p.poss.forEach((cell, k) => {
      const cur = p.cur === k ? 1 : 0;
      const arr = pawns.get(cell) || [];
      arr.push({ pi: p.idx, k, cur });
      pawns.set(cell, arr);
    });
  }
  const sig = [...pawns].map(([c, a]) => `${c}:${a.map((x) => x.pi + "." + x.k).join(",")}`).join("|");
  if (sig !== refs.pawnSig) {
    refs.pawnSig = sig;
    for (const c of refs.cells) {
      const i = Number(c.el.dataset.cell);
      const arr = pawns.get(i);
      c.pawnsEl.replaceChildren();
      if (!arr) continue;
      for (const { pi, k } of arr) {
        const src = pawnSrc(refs.assets, pi);
        const title = `${g.players[pi].name}${g.pawns > 1 ? ` · ${k + 1} 号棋子` : ""}`;
        c.pawnsEl.append(src
          ? h("img", {
            class: "pawn", src, alt: g.players[pi].name, title, draggable: "false",
            style: { "--sc": seatColor(pi) }, dataset: { seat: String(pi + 1) },
          })
          : h("span", {
            class: "pawn pawn-fallback", title,
            style: { background: seatColor(pi) }, dataset: { seat: String(pi + 1) },
          }, SEAT_EMOJI[pi % SEAT_EMOJI.length] || String(pi + 1)));
      }
    }
  }

  // ---- 当前格高亮 ----
  const active = opts.activeCell;
  for (const c of refs.cells) {
    c.el.classList.toggle("active", Number(c.el.dataset.cell) === active);
  }

  // ---- 牌堆余量 ----
  const root = refs.cells[0].el.parentElement;
  for (const [deck, d] of Object.entries(g.decks)) {
    const el = root.querySelector(`[data-count="${deck}"]`);
    if (el) el.textContent = `${d.pile.length} / ${d.src.length}`;
  }

  // ---- 季节盘 ----
  for (const chip of root.querySelectorAll(".s-chip")) {
    chip.classList.toggle("on", chip.dataset.season === g.season);
  }
  const ct = root.querySelector("#centerTurn");
  if (ct) {
    const cur = opts.currentPlayer;
    // replaceChildren 会把 null 变成文本 "null"，先滤掉空项
    ct.replaceChildren(...[
      h("span", null, `第 ${g.round} / ${g.maxRounds} 轮`),
      cur ? h("span", { class: "ct-who", style: { background: seatColor(cur.idx) } },
        `轮到 ${cur.name}`) : null,
    ].filter(Boolean));
  }
}

/** 切换棋盘朝向：flat（正向）| paper（还原纸样）。 */
export function setOrientation(root, mode) { root.dataset.orient = mode; }
