/**
 * overlay.js —— 弹层与提示：开局设置 / 卡牌翻牌 / 通用选择对话框 / 轻提示
 */

import { h, clear, num } from "./dom.js";
import { JC, APP_VERSION } from "./theme.js";
import { DEFAULT_PREFS, clearPrefs } from "./prefs.js";

const overlay = () => document.getElementById("overlay");
const sheet = () => document.getElementById("sheet");

/** 当前「按 Esc 可安全关掉」的弹层关闭器；决策类对话框**不**注册（关掉会卡住内核）。 */
let escClose = null;

/** 打开弹层（内容自备）。dismissible=true 时注册为 Esc 可关。 */
export function showSheet(node, { width = 520, dismissible = false } = {}) {
  const ov = overlay();
  const sh = sheet();
  sh.style.maxWidth = `${width}px`;
  clear(sh).append(node);
  ov.hidden = false;
  ov.classList.add("in");
  escClose = dismissible ? () => hideSheet() : null;
  return () => hideSheet();
}

export function hideSheet() {
  const ov = overlay();
  ov.classList.remove("in");
  ov.hidden = true;
  clear(sheet());
  escClose = null;
}

/**
 * 通用选择对话框。
 * @param {{title:string, sub?:string, body?:Node, actions:Array<{label:string,value:any,kind?:string,disabled?:boolean,hint?:string}>}} o
 * @returns {Promise<any>}
 */
export function dialog({ title, sub, body, actions }) {
  return new Promise((resolve) => {
    let off = null;
    const done = (v) => {
      if (off) { document.removeEventListener("keydown", off, true); off = null; }
      hideSheet();
      resolve(v);
    };
    const node = h("div", { class: "dlg" },
      h("div", { class: "dlg-h" }, h("b", null, title), sub ? h("p", null, sub) : null),
      body || null,
      h("div", { class: "dlg-actions" },
        actions.map((a, i) => h("button", {
          class: `btn ${a.kind || "ghost"}${a.disabled ? " disabled" : ""}`,
          disabled: !!a.disabled,
          title: a.hint || "",
          onclick: () => { if (!a.disabled) done(a.value); },
        }, actions.length > 1 ? `${i + 1}. ${a.label}` : a.label))),
    );
    showSheet(node);
    // 键盘兜底：按数字键选第 N 个选项（触屏失灵 / 外接键盘 / 无障碍）
    if (actions.length > 1) {
      off = (e) => {
        const i = Number(e.key) - 1;
        if (Number.isInteger(i) && i >= 0 && i < actions.length && !actions[i].disabled) {
          e.preventDefault();
          done(actions[i].value);
        }
      };
      document.addEventListener("keydown", off, true);
    }
  });
}

// ------------------------------------------------------------------
// 成就徽章（右下角冒一枚小徽章，几秒后自动收）
// ------------------------------------------------------------------
const BADGE_MS = 2600;

/** 弹一枚成就徽章：who 为空表示「全场」成就。 */
export function badge({ icon, title, cap = "", who = null }) {
  let layer = document.getElementById("badgeLayer");
  if (!layer) { layer = h("div", { class: "badge-layer", id: "badgeLayer" }); document.body.append(layer); }
  const el = h("div", { class: `badge-pop${who ? "" : " global"}`, role: "status", title: cap },
    h("span", { class: "bd-ic" }, icon),
    h("div", { class: "bd-tx" },
      h("b", null, who ? `${who} · ${title}` : title),
      cap ? h("span", null, cap) : null));
  layer.append(el);
  requestAnimationFrame(() => el.classList.add("in"));
  setTimeout(() => {
    el.classList.remove("in");
    setTimeout(() => el.remove(), 340);
  }, BADGE_MS);
}

// ------------------------------------------------------------------
// 卡牌翻牌（同步展示，不阻塞内核）
// ------------------------------------------------------------------
let revealTimer = 0;
let revealHide = 0;
/** 当前翻牌卡的关闭器（Esc 可关）。 */
let revealShut = null;
/** 排队等翻的卡：同一时间只翻一张，上一张收干净才轮下一张。 */
const revealQueue = [];
let revealBusy = false;

const DECK_CN = { chance: "机会卡", destiny: "命运卡", treasure: "寻宝卡", season: "季节卡" };

/**
 * 在棋盘区右下角弹出一张抽到的卡。
 *   一发多张（或别人接着抽卡）时排队逐张翻 —— 排在后面的牌，
 *   绝不会把玩家正在读的那张顶掉。
 * @param {object} o
 * @param {number} [o.duration=9000] 自动消失毫秒数；<=0 表示「不自动关，等玩家自己关」
 *   —— 真人抽到的卡用这个，玩家可以慢慢读，点卡片或 ✕ 关掉。
 */
export function revealCard(o) {
  revealQueue.push(o);
  if (!revealBusy) showNextCard();
}

/** 翻队首那张；队空则收工，把「翻牌中」的占用还回去。 */
function showNextCard() {
  const o = revealQueue.shift();
  if (!o) { revealBusy = false; return; }
  revealBusy = true;
  if (!showCard(o)) showNextCard();
}

function showCard({ deck, card, player, delta, assets, duration = 9000 }) {
  const el = document.getElementById("cardReveal");
  if (!el) return false;
  const art = (assets.manifest.vignettes[deck] || {})[String(card.no)];
  const cls = delta > 0 ? "up" : (delta < 0 ? "down" : "zero");
  let closed = false;
  const shut = () => {
    if (closed) return;
    closed = true;
    revealShut = null;
    clearTimeout(revealTimer);
    el.classList.remove("in");
    revealHide = setTimeout(() => {
      if (!closed) return;
      el.hidden = true; clear(el);
      showNextCard();                 // 这一张彻底收干净了，才轮到下一张
    }, 320);
  };
  revealShut = shut;
  const auto = duration > 0;
  const hintText = auto ? `⏱️ ${Math.round(duration / 1000)} 秒后自动关 · 点一下立刻关` : "点一下关掉";
  const box = h("div", { class: `cr ${cls}`, role: "button", tabindex: "0", title: "点一下关掉" },
    h("div", { class: "cr-art" },
      art ? h("img", { src: assets.url(art), alt: card.theme, draggable: "false" }) : h("div", { class: "cr-noart" }, "京")),
    h("div", { class: "cr-body" },
      h("div", { class: "cr-top" },
        h("span", { class: "cr-deck" }, DECK_CN[deck] || deck),
        h("span", { class: "cr-who", style: { background: JC.ink } }, player.name)),
      h("b", { class: "cr-theme" }, card.theme),
      h("p", { class: "cr-text" }, card.text),
      card.task ? h("p", { class: "cr-task" }, `小任务：${card.task}`) : null,
      h("div", { class: `cr-delta ${cls}` },
        delta ? `${delta > 0 ? "+" : "-"}¥${num(Math.abs(delta))}` : (card.value_raw || "—")),
      h("span", { class: "cr-hint" }, hintText)),
    h("button", { class: "cr-close", type: "button", "aria-label": "关掉这张卡", title: "关掉" }, "✕"),
  );
  clear(el).append(box);
  box.addEventListener("click", shut);
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); shut(); } });
  box.querySelector(".cr-close").addEventListener("click", (e) => { e.stopPropagation(); shut(); });
  el.hidden = false;
  el.classList.add("in");
  clearTimeout(revealTimer);
  if (duration > 0) revealTimer = setTimeout(shut, duration);
  return true;
}

/** 清空翻牌区（新开一局时用）。 */
export function clearReveal() {
  revealQueue.length = 0;
  revealBusy = false;
  revealShut = null;
  clearTimeout(revealTimer);
  clearTimeout(revealHide);
  const el = document.getElementById("cardReveal");
  if (el) { el.hidden = true; el.classList.remove("in"); clear(el); }
}

// ------------------------------------------------------------------
// Esc 关层（只关「安全层」：翻牌卡 / 被标记为 dismissible 的信息弹层）
// 决策类对话框不在其列 —— 关掉它会让内核永远等不到答复。
// 玩法助手（coach.js）自带 Esc 监听，不走这里。
// ------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (revealShut) { revealShut(); return; }
  const ov = overlay();
  if (ov && !ov.hidden && escClose) escClose();
});

// ------------------------------------------------------------------
// 轻提示
// ------------------------------------------------------------------
/**
 * 轻提示（底部居中）。
 * 展示时长默认 3.4 秒，且**点一下就能立刻关掉** —— 触屏上不必干等。
 * @returns {() => void} 手动关闭函数
 */
export function toast(msg, ms = 3400) {
  const t = h("div", { class: "toast", role: "status", title: "点一下关掉" },
    h("span", { class: "toast-msg" }, msg),
    h("button", { class: "toast-x", type: "button", "aria-label": "关掉提示" }, "✕"));
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add("in"));
  let closed = false;
  const shut = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    t.classList.remove("in");
    setTimeout(() => t.remove(), 300);
  };
  const timer = setTimeout(shut, ms);
  t.addEventListener("click", shut);
  return shut;
}

// ------------------------------------------------------------------
// 开局设置
// ------------------------------------------------------------------

/** 5 条「加料开关」——首版承诺全部可开关。 */
const SWITCHES = [
  { key: "seasonOn", label: "季节机制", hint: "过起点抽季节卡，当季分区租金翻倍", def: true },
  { key: "hutong", label: "胡同寻宝", hint: "停在寻宝格时，按持有胡同地块数多抽寻宝卡", def: true },
  { key: "hutongDraw", label: "胡同通·多抽", hint: "每持 2 块胡同地，寻宝格再多抽 1 张", def: false },
  { key: "monopoly", label: "建房须集齐分区", hint: "经典规则；关=有钱就能升（默认关）", def: false },
  { key: "skillFree", label: "技能不限次", hint: "身份卡技能整局不再限制 2 次", def: false },
];

function seg(name, options, value) {
  return h("div", { class: "seg", dataset: { name } },
    options.map((o) => h("button", {
      class: `seg-btn${o.value === value ? " on" : ""}`, type: "button",
      dataset: { value: String(o.value) }, onclick: (e) => {
        const box = e.currentTarget.parentElement;
        for (const b of box.children) b.classList.toggle("on", b === e.currentTarget);
      },
    }, o.label)));
}

/**
 * 图文卡选择器：和图版一样的交互契约（.seg[data-name] + .seg-btn.on[data-value]），
 * 但每一项是「大图标 + 短标题 + 一句话」的卡片，替掉抽象的长句选项，方便小朋友秒懂。
 */
function cardSeg(name, options, value) {
  return h("div", { class: "seg cards", dataset: { name } },
    options.map((o) => h("button", {
      class: `seg-btn card-opt${o.value === value ? " on" : ""}`, type: "button",
      dataset: { value: String(o.value) }, onclick: (e) => {
        const box = e.currentTarget.parentElement;
        for (const b of box.children) b.classList.toggle("on", b === e.currentTarget);
      },
    },
      h("span", { class: "co-ic" }, o.icon),
      h("b", { class: "co-title" }, o.label),
      h("span", { class: "co-cap" }, o.cap))));
}

const segValue = (form, name) => {
  const on = form.querySelector(`.seg[data-name="${name}"] .seg-btn.on`);
  return on ? on.dataset.value : null;
};

/**
 * 开局设置表单。
 * @param {{defaults?:object, hasSave?:boolean, saveInfo?:string, idleMs?:number}} o
 *   defaults 由调用方从「本机记住的设置」组装；saveInfo 是上局摘要（第 N 轮 · 称呼）；
 *   idleMs > 0 时启用「闲置演示」：这么久没人碰屏幕，就自己关掉表单、交还给调用方
 *   （结果 action === "attract"），由调用方接着放一段全电脑演示。
 * @returns {Promise<{action:"new"|"resume"|"attract", cfg?:object}>}
 */
export function openSetup({ defaults = {}, hasSave = false, saveInfo = "", idleMs = 0 } = {}) {
  const form = h("form", { class: "setup", onsubmit: (e) => e.preventDefault() });

  form.append(
    h("div", { class: "setup-h" },
      h("b", null, "京韵大富翁 · 胡同漫游记"),
      h("p", null, `京城印记版 · 本机 Web 版 · v${APP_VERSION}`)),

    h("div", { class: "field" },
      h("label", null, "人数"),
      seg("players", [{ label: "2 人", value: 2 }, { label: "3 人", value: 3 }, { label: "4 人", value: 4 }], 4)),

    h("div", { class: "field" },
      h("label", null, "谁是谁（真人手动 / 电脑自动）"),
      h("div", { class: "seats", id: "seats" },
        [0, 1, 2, 3].map((i) => h("div", { class: "seat-row", dataset: { seat: String(i) } },
          h("span", { class: "seat-no" }, `${i + 1} 号`),
          h("input", {
            class: "txt name-in", name: `pname_${i}`, maxlength: "8",
            placeholder: "称呼（可留空）",
          }),
          h("label", {
            class: "seat-pick", dataset: { i }, title: "勾选 = 真人自己玩（手动）；不勾 = 电脑自动玩",
          },
            h("input", { type: "checkbox" }),
            h("span", { class: "role-on" }, "🙋 真人 · 手动"),
            h("span", { class: "role-off" }, "🤖 电脑 · 自动"))))),
      h("p", { class: "hint" }, "勾上就是真人（自己掷骰、点棋子走），不勾就是电脑自动走。想两个人一起玩，就勾两个或更多。左边那格可以给棋子取名字，比如「爸爸」「小明」。")),

    h("div", { class: "field" },
      h("label", null, "随机种子"),
      h("input", { class: "txt", name: "seed", placeholder: "留空 = 每局都不一样（填数字可复现同一局）" }),
      h("p", { class: "hint" }, "种子是一串数字，决定骰子怎么掷、卡牌怎么发。填同一个数字，就会得到一模一样的一盘棋，方便和小朋友公平对战或复盘。")),

    h("div", { class: "field" },
      h("label", null, "可选开关（加料 + 音效）"),
      h("div", { class: "switches" },
        SWITCHES.map((s) => h("label", { class: "check", title: s.hint },
          h("input", { type: "checkbox", name: `sw_${s.key}` }),
          h("span", null, h("b", null, s.label), h("em", null, s.hint)))),
        // 音效不参与规则，放在同一网格里只为「不额外占一行高度」——小屏也能完整放下。
        h("label", { class: "check", title: "关掉后整局都不出声（也可以随时点控制条上的喇叭开关）" },
          h("input", { type: "checkbox", name: "pref_sound" }),
          h("span", null, h("b", null, "音效"), h("em", null, "掷骰、跳格、收租都有声；关掉=安静玩"))))),

    h("details", { class: "adv" },
      h("summary", null, "高级设置（看不懂就保持默认）"),
      h("div", { class: "field" },
        h("label", null, "换季后，哪里的房租会变贵？"),
        cardSeg("seasonMode", [
          { value: "cell", icon: "🎯", label: "只有这一片", cap: "抽到哪一片，就那一片的地变贵" },
          { value: "player", icon: "🏘️", label: "那房东全涨", cap: "那片的房东，别处的地也跟着贵" },
          { value: "focus", icon: "✨", label: "这片翻倍", cap: "抽到那片翻倍，其他地方只贵一点点" },
        ], "cell")),
      h("p", { class: "hint" }, "小朋友默认选「只有这一片」就好：哪一片被抽中，只有那一片的地涨价，最好懂。"),
      h("div", { class: "field" },
        h("label", null, "房租会贵多少？"),
        cardSeg("seasonScale", [
          { value: 1, icon: "🙂", label: "正常（×1）", cap: "涨价幅度刚刚好，推荐" },
          { value: 2, icon: "🔥", label: "两倍（×2）", cap: "涨得更狠，收租更刺激" },
        ], 1)),
      h("div", { class: "field" },
        h("label", null, "机会卡 / 命运卡 / 季节卡弹出来以后？"),
        cardSeg("cardMode", [
          { value: "manual", icon: "✋", label: "我自己关", cap: "看完点一下卡片，慢慢读不着急" },
          { value: "auto", icon: "⏱️", label: "到点自己关", cap: "过了设定的秒数自动收起来" },
        ], DEFAULT_PREFS.cardMode)),
      h("p", { class: "hint" }, "选「我自己关」最稳妥：每张卡都等你点一下再收，绝不会看漏。选「到点自己关」就像刷短视频一样自动翻页。"),
      h("div", { class: "field" },
        h("label", null, "自动关闭：一张卡停多久？"),
        cardSeg("cardMs", [
          { value: 3000, icon: "🐇", label: "3 秒", cap: "看得快，一闪而过" },
          { value: 6000, icon: "🐱", label: "6 秒", cap: "刚好读完，推荐" },
          { value: 9000, icon: "🐢", label: "9 秒", cap: "慢慢看，不着急" },
          { value: 15000, icon: "🦥", label: "15 秒", cap: "给小朋友反复读的时间" },
        ], DEFAULT_PREFS.cardMs))),
      h("p", { class: "hint" }, "只有上面选「到点自己关」时，这里的秒数才对真人抽到的卡生效；电脑自动抽的牌也按这个时长翻，让你看得清。"),

    h("div", { class: "setup-actions" },
      h("button", {
        class: "btn ghost setup-reset", type: "button", id: "btnResetPrefs",
        title: "把人数、称呼、加料开关等一键恢复成出厂设置（不影响已存的棋局）",
        onclick: () => { resetToDefaults(); },
      }, "恢复默认"),
      hasSave ? h("button", {
        class: "btn ghost", type: "button",
        onclick: () => { hideSheet(); finish({ action: "resume" }); },
      }, `继续上局${saveInfo ? `（${saveInfo}）` : ""}`) : null,
      h("button", { class: "btn primary", type: "submit", onclick: submit }, "开始对局")),
  );

  let resolve;
  const p = new Promise((r) => { resolve = r; });

  // ---- 闲置演示计时 --------------------------------------------------
  // 表单还在（= 停在「标题页」）时，这么久没人碰屏幕，就关掉表单交还给调用方。
  // 用 document 捕获阶段监听，保证「屏幕任何角落的触碰」都算作有人在场。
  let idleTimer = 0;
  const cancelIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
    document.removeEventListener("pointerdown", bumpIdle, true);
    document.removeEventListener("keydown", bumpIdle, true);
  };
  const bumpIdle = () => {
    if (!idleMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = 0;
      cancelIdle();
      hideSheet();
      resolve({ action: "attract" });
    }, idleMs);
  };
  /** 统一出口：清掉闲置计时后交还结果。 */
  const finish = (result) => { cancelIdle(); resolve(result); };
  if (idleMs) {
    document.addEventListener("pointerdown", bumpIdle, true);
    document.addEventListener("keydown", bumpIdle, true);
    bumpIdle();
  }

  // ---- 表单取值 / 回填 ------------------------------------------------
  /** 把一份配置回填到表单（初始化与「恢复默认」共用同一条路径）。 */
  function applyValues(d = {}) {
    const setSeg = (name, val) => {
      const box = form.querySelector(`.seg[data-name="${name}"]`);
      if (!box) return;
      for (const b of box.children) b.classList.toggle("on", b.dataset.value === String(val));
    };
    setSeg("players", d.players ?? 4);
    [0, 1, 2, 3].forEach((i) => {
      const row = form.querySelector(`.seat-row[data-seat="${i}"]`);
      row.querySelector(".seat-pick input").checked = !!(d.humans && d.humans[i]);
      row.querySelector(".name-in").value = (d.names && d.names[i]) || "";
    });
    form.querySelector('[name="seed"]').value = d.seedRaw !== undefined ? d.seedRaw : (d.seed ?? "");
    for (const s of SWITCHES) {
      const el = form.querySelector(`[name="sw_${s.key}"]`);
      if (el) el.checked = d[s.key] !== undefined ? !!d[s.key] : s.def;
    }
    const snd = form.querySelector('[name="pref_sound"]');
    if (snd) snd.checked = d.sound !== undefined ? !!d.sound : DEFAULT_PREFS.sound;
    setSeg("seasonMode", d.seasonMode || DEFAULT_PREFS.seasonMode);
    setSeg("seasonScale", d.seasonScale ?? DEFAULT_PREFS.seasonScale);
    setSeg("cardMode", d.cardMode || DEFAULT_PREFS.cardMode);
    setSeg("cardMs", d.cardMs ?? DEFAULT_PREFS.cardMs);
    syncRows();
  }

  /** 恢复出厂设置：清掉本机记录 + 表单回填默认（不动已存的棋局）。 */
  function resetToDefaults() {
    const d = clearPrefs();
    applyValues({ ...d, names: [...DEFAULT_PREFS.names], seedRaw: "" });
  }

  function submit() {
    const players = Number(segValue(form, "players")) || 4;
    const humans = [0, 1, 2, 3].map((i) => form.querySelector(`.seats .seat-pick[data-i="${i}"] input`).checked);
    // 只保留前 players 个座位；若全选了电脑，则默认 1 号是真人（避免开局没人操作）。
    const seats = humans.slice(0, players);
    if (!seats.some(Boolean)) seats[0] = true;

    const seedRaw = form.querySelector('[name="seed"]').value.trim();
    const names = [0, 1, 2, 3].map((i) => {
      const el = form.querySelector(`[name="pname_${i}"]`);
      return el ? el.value.trim() : "";
    });
    const cfg = {
      players,
      humans: seats,
      names,
      seed: seedRaw === "" ? Math.floor(Math.random() * 2 ** 31) : (Number(seedRaw) || 0),
      seedRaw,
      seasonOn: form.querySelector('[name="sw_seasonOn"]').checked,
      hutong: form.querySelector('[name="sw_hutong"]').checked,
      hutongDraw: form.querySelector('[name="sw_hutongDraw"]').checked,
      buildRule: form.querySelector('[name="sw_monopoly"]').checked ? "monopoly" : "free",
      skillLimit: form.querySelector('[name="sw_skillFree"]').checked ? 0 : 2,
      seasonMode: segValue(form, "seasonMode") || "cell",
      seasonScale: Number(segValue(form, "seasonScale")) || 1,
      sound: form.querySelector('[name="pref_sound"]').checked,
      cardMode: segValue(form, "cardMode") || DEFAULT_PREFS.cardMode,
      cardMs: Number(segValue(form, "cardMs")) || DEFAULT_PREFS.cardMs,
    };
    hideSheet();
    finish({ action: "new", cfg });
  }

  // 座位行跟着「人数」联动：超出人数的座位淡出（提交时本来也会裁掉）
  function syncRows() {
    const players = Number(segValue(form, "players")) || 4;
    for (const row of form.querySelectorAll(".seat-row")) {
      row.classList.toggle("off", Number(row.dataset.seat) >= players);
    }
  }
  form.querySelector('.seg[data-name="players"]').addEventListener("click", syncRows);

  applyValues({ ...DEFAULT_PREFS, ...defaults });

  showSheet(form, { width: 560 });
  return p;
}

// ------------------------------------------------------------------
// 首次打开：图文规则引导（只出现一次，之后可点右上角「?」随时复习）
// ------------------------------------------------------------------
const ONBOARD_KEY = "jym.onboard.v1";

/** 是否还没看过引导。 */
export function needsOnboard() {
  try { return !localStorage.getItem(ONBOARD_KEY); } catch { return true; }
}
function markOnboard() { try { localStorage.setItem(ONBOARD_KEY, "1"); } catch { /* noop */ } }

/** 五张图卡：一句话讲清「怎么玩」——以图为主，字尽量少。 */
const ONBOARD_STEPS = [
  ["🎲", "掷骰子", "点棋盘中间的骰子，棋子往前走"],
  ["🏠", "买块地", "停在没人买的地上，花钱买下它"],
  ["💰", "收租金", "别人停在你地上，就给你钱"],
  ["🍂", "季节卡", "每次经过起点抽一张：换季，某一片房租翻倍"],
  ["🏆", "谁赢", "走满 40 轮，钱最多的那个人赢"],
];

/**
 * 打开「怎么玩」引导弹层（阻塞式，点开始后才继续）。
 * @returns {Promise<void>}
 */
export function openOnboard() {
  return new Promise((resolve) => {
    const done = () => { markOnboard(); hideSheet(); resolve(); };
    const node = h("div", { class: "dlg onboard", id: "onboard" },
      h("div", { class: "dlg-h" },
        h("b", null, "欢迎来到京韵大富翁 👋"),
        h("p", null, "五张图看懂怎么玩，马上开局")),
      h("div", { class: "ob-grid" }, ONBOARD_STEPS.map(([ic, t, s]) =>
        h("div", { class: "ob-cell" },
          h("span", { class: "ob-ic" }, ic),
          h("b", null, t),
          h("span", { class: "ob-cap" }, s)))),
      h("p", { class: "ob-tip" }, "玩着忘了？点右上角的「?」随时问玩法助手。"),
      h("div", { class: "dlg-actions" },
        h("button", { class: "btn primary", type: "button", id: "btnOnboardStart", onclick: done }, "知道啦，开始游戏 ▸")),
    );
    showSheet(node, { width: 640 });
  });
}
