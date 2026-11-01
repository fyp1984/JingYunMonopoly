/**
 * app.js —— UI 控制器：装配内核 + 分步驱动 + 面板刷新 + 人机交互
 *
 * 设计要点：
 *   ① 内核（core/）零 DOM、零改动 —— UI 只用 hooks / decisions / onCard 三个观察点。
 *   ② 人类玩家的三个决策点（买地 / 建房 / 背包客走位）走异步 provider，
 *      与 AI 共用同一套规则（AI 决策不消耗随机数，所以同种子仍可对拍）。
 *   ③ 存档 = 配置 + 种子 + 人工决策序列；因为整局是确定性的，
 *      读档 = 用同样输入重放（人工选择照录回放），到存档轮自动交还控制权。
 */

import { Game } from "../core/engine.js";
import { PyRandom } from "../core/pyrandom.js";
import { aiProvider } from "../core/ai.js";
import { loadAssets } from "./assets.js";
import { buildBoard, updateBoard, setOrientation, cellCenter, pawnSrc, fitBoard } from "./board.js";
import { renderSeason, renderPlayers, renderMarket, renderLog } from "./panels.js";
import {
  openSetup, dialog, revealCard, clearReveal, toast, showSheet, hideSheet,
  needsOnboard, openOnboard, badge,
} from "./overlay.js";
import { openCoach } from "./coach.js";
import { check as checkAchievements, reset as resetAchievements } from "./achievements.js";
import { $, h, sleep, num } from "./dom.js";
import { zoneColor, seatColor, SEAT_EMOJI, APP_VERSION } from "./theme.js";
import { buildSave, validateSave } from "../core/savefmt.js";
import { getItem, setItem, removeItem, hasNativeMirror } from "./store.js";
import { loadPrefs, savePrefs } from "./prefs.js";
import { setSound, isSoundOn, unlock as unlockSfx, sfx } from "./sfx.js";

// 存档槽：第 0 个是「自动存档」（每完成整轮自动写、启动时可续），其余是命名档位。
const SAVE_SLOTS = [
  { key: "jym.save.auto", label: "自动存档", auto: true },
  { key: "jym.save.slot.1", label: "档位 1", auto: false },
  { key: "jym.save.slot.2", label: "档位 2", auto: false },
  { key: "jym.save.slot.3", label: "档位 3", auto: false },
];
const AUTO_KEY = SAVE_SLOTS[0].key;
// 停在标题页多久没人碰屏幕就进入「电脑演示」（60–90s，取 75s）
const ATTRACT_MS = 75000;
const STOP = Symbol("stop-for-resume");

const state = {
  assets: null,
  game: null,
  cfg: null,
  refs: null,
  logDrawn: 0,
  logFilter: "all",   // 日志筛选：all / lg-buy / lg-rent / lg-card …（纯 UI，靠容器 data-filter + CSS）
  curPlayer: null,
  gen: 0,          // 局世代号：新局/读档时 +1，让上一局仍在跑的驱动循环自行退出
  recorded: [],   // 人工决策序列（存档用）
  replay: null,   // 读档回放队列
  // walkMode: manual = 逐格点棋子走；auto = 自动跳格
  ctrl: { paused: false, speed: 650, stopRound: null, orient: "flat", walkMode: "manual" },
  rollResolve: null,   // 等真人点骰子
  stepResolve: null,   // 手动走格：等真人点棋子 / 下一格
  cardQueue: [],       // 落点抽到的卡（等真人点卡摞翻开，逐张消化）
  cardResolve: null,   // 卡队列清空后放行内核
  // 当前「等玩家做什么」——供问号助手（coach.js）按现状支招；纯 UI 状态
  pending: null,
  // 存档快照只取「整轮边界」：内核 play() 每轮从轮首重启，
  // 半轮快照读档会丢掉当轮剩余回合，故只记录最近一个已完成整轮的状态。
  snapRound: null,
  snapRecorded: [],
  // 闲置演示：true 时全电脑快跑，且一切存档写入都被挡住（演示局不落盘）
  attractMode: false,
  alivePrev: null,     // 上一帧存活人数：减少即有人破产 → 出破产音效
};

// ==================================================================
// 启动
// ==================================================================
async function init() {
  // 顶栏显示版本号（与安装包 versionName 保持同源）
  const verEl = $("#appVer");
  if (verEl) verEl.textContent = `v${APP_VERSION}`;

  let assets;
  try {
    assets = await loadAssets("./assets/");
  } catch (e) {
    document.body.innerHTML = `<div class="fatal">素材加载失败：${e.message}<br>
      请在工程根目录执行 <code>python3 tools/sync_assets.py</code>，再用
      <code>npm run serve</code> 打开 http://localhost:8099/</div>`;
    return;
  }
  state.assets = assets;
  if (assets.errors.length) toast(`数据校验未通过：${assets.errors[0]}`, 8000);
  applyBrandAssets(assets);

  bindControls();
  syncRegionTools();
  unlockAudioOnGesture();
  // 首次打开：先用「五张图看懂怎么玩」图文引导快速入局（只出现一次，
  // 之后随时可点右上角「?」问玩法助手）。引导是纯展示，不碰内核与随机数。
  if (needsOnboard()) await openOnboard();
  await mainMenu();
}

/**
 * 标题页主循环：开局设置 ←→ 闲置演示。
 * 停在设置里太久（ATTRACT_MS 毫秒）会返回 action="attract"，这里接上全电脑演示；
 * 演示被点一下就结束，循环回来重新摆出设置 —— 触屏终端的「待机屏」。
 */
async function mainMenu() {
  for (;;) {
    state.attractMode = false;
    hideAttract();
    const save = currentSave();
    const prefs = loadPrefs();
    applyPrefsToControls(prefs);
    const pick = await openSetup({
      defaults: prefs,
      hasSave: !!save,
      saveInfo: save ? saveInfo(save) : "",
      idleMs: ATTRACT_MS,
    });
    if (pick.action === "attract") { await runAttract(); continue; }
    if (pick.action === "resume" && save) { await startResume(save); return; }
    await startNew(pick.cfg);
    return;
  }
}

/** 把本机记住的偏好铺到控制条与音效上（进标题页 / 起局前都会走一遍）。 */
function applyPrefsToControls(p) {
  state.ctrl.speed = p.speed;
  state.ctrl.orient = p.orient;
  state.ctrl.walkMode = p.walkMode;
  const sp = $("#speed"); if (sp) sp.value = String(p.speed);
  const bw = $("#btnWalk");
  if (bw) bw.textContent = p.walkMode === "manual" ? "👣 走格：手动" : "🤖 走格：自动";
  const bo = $("#btnOrient");
  if (bo) bo.textContent = p.orient === "flat" ? "🧭 棋盘：正向" : "🧭 棋盘：纸样";
  setSound(p.sound);
  updateSoundBtn();
}

/** 喇叭开关的字形 / 状态。 */
function updateSoundBtn() {
  const b = $("#btnSound");
  if (!b) return;
  const on = isSoundOn();
  b.textContent = on ? "🔊" : "🔇";
  b.classList.toggle("off", !on);
  b.setAttribute("aria-pressed", on ? "true" : "false");
  b.title = on ? "音效：开（点一下关掉）" : "音效：关（点一下打开）";
}

/** 首次用户手势时唤醒音频上下文（浏览器自动播放策略要求）。 */
function unlockAudioOnGesture() {
  const once = () => {
    unlockSfx();
    window.removeEventListener("pointerdown", once, true);
    window.removeEventListener("keydown", once, true);
  };
  window.addEventListener("pointerdown", once, true);
  window.addEventListener("keydown", once, true);
}

// ==================================================================
// 闲置演示（attract）：全电脑快跑，点一下即回到开局设置
// ==================================================================
async function runAttract() {
  hideSheet();
  const attract = $("#attract");
  if (attract) attract.hidden = false;
  state.attractMode = true;
  setSound(false);                   // 待机屏不出声，避免全速演示里连珠炮似的响

  await new Promise((resolve) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      document.removeEventListener("pointerdown", stop, true);
      document.removeEventListener("keydown", stop, true);
      killRunning();                 // 让演示局在下一个钩子处退出
      resolve();
    };
    document.addEventListener("pointerdown", stop, true);
    document.addEventListener("keydown", stop, true);

    (async () => {
      while (!stopped) {
        beginDemoGame();
        await run();
        if (stopped) break;
        await sleep(1100);           // 一盘走完，停一下再开下一盘
      }
    })();
  });

  state.attractMode = false;
  hideAttract();
  killRunning();
  setSound(loadPrefs().sound);       // 回到玩家自己的音效偏好
  updateSoundBtn();
}

function hideAttract() { const a = $("#attract"); if (a) a.hidden = true; }

/** 摆一局纯电脑、全速的对局（不写存档）。 */
function beginDemoGame() {
  const cfg = {
    players: 4, humans: [false, false, false, false], names: ["", "", "", ""],
    seed: Math.floor(Math.random() * 2 ** 31),
    seasonOn: true, hutong: true, hutongDraw: false,
    buildRule: "free", skillLimit: 2, seasonMode: "cell", seasonScale: 1, sound: false,
    cardMode: "auto", cardMs: 3000,
  };
  state.cfg = cfg;
  state.recorded = [];
  state.replay = null;
  state.snapRound = null;
  state.snapRecorded = [];
  state.ctrl.stopRound = null;
  state.ctrl.speed = 0;              // 全速快跑
  resetControls();
  attach(newGame(cfg));
  renderAll();
}

// ==================================================================
// 建局
// ==================================================================
/** 品牌图（Logo / favicon）走 manifest，不在 HTML 里硬编码素材文件名。 */
function applyBrandAssets(assets) {
  const p = assets.manifest.special && assets.manifest.special.logo;
  if (!p) return;
  const src = assets.url(p);
  const logo = document.querySelector(".topbar .logo");
  if (logo) logo.src = src;
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) icon.href = src;
}

function newGame(cfg) {
  const g = new Game(state.assets.data, {
    rng: new PyRandom(cfg.seed),
    nPlayers: cfg.players,
    pawns: cfg.pawns,
    seasonOn: cfg.seasonOn,
    buildRule: cfg.buildRule,
    skillLimit: cfg.skillLimit,
    seasonMode: cfg.seasonMode,
    seasonScale: cfg.seasonScale,
    hutong: cfg.hutong,
    hutongDraw: cfg.hutongDraw,
    decisions: makeDecisions(),
  });
  cfg.humans.forEach((isHuman, i) => { g.players[i].kind = isHuman ? "human" : "ai"; });
  // 称呼：只在玩家填了才覆盖（身份卡是每局随机抽的，所以默认名每局会变）
  (cfg.names || []).forEach((nm, i) => {
    const t = String(nm || "").trim();
    if (t && g.players[i]) g.players[i].name = t;
  });
  return g;
}

async function startNew(cfg) {
  state.cfg = cfg;
  state.recorded = [];
  state.replay = null;
  state.snapRound = null;
  state.snapRecorded = [];
  state.ctrl.stopRound = null;
  state.attractMode = false;
  hideAttract();
  rememberCfg(cfg);                 // 记住这局的设置，下次打开就是它
  resetControls();
  state.ctrl.speed = Number($("#speed").value) || 650;
  attach(newGame(cfg));
  renderAll();
  await run();
}

/** 把开局面板里的选择写回「本机设置」，下次默认值就是它。 */
function rememberCfg(cfg) {
  savePrefs({
    players: cfg.players, humans: cfg.humans, names: cfg.names,
    seasonOn: cfg.seasonOn, hutong: cfg.hutong, hutongDraw: cfg.hutongDraw,
    monopoly: cfg.buildRule === "monopoly", skillFree: cfg.skillLimit === 0,
    seasonMode: cfg.seasonMode, seasonScale: cfg.seasonScale, sound: cfg.sound,
    cardMode: cfg.cardMode, cardMs: cfg.cardMs,
  });
  setSound(!!cfg.sound);            // 开局面板里的「音效」勾选要真的生效，不能只记进设置
  updateSoundBtn();
}

async function startResume(save) {
  const chk = validateSave(save);
  if (!chk.ok) { toast(`这局没法继续：${chk.reason}`); return; }
  state.attractMode = false;
  hideAttract();
  // 翻牌提示是纯展示偏好（不进内核指纹）：续档时以「本机当前设置」为准，
  // 旧存档没这两个字段也能拿到用户当前的选择。
  const pref = loadPrefs();
  state.cfg = { ...save.cfg, cardMode: save.cfg.cardMode ?? pref.cardMode, cardMs: save.cfg.cardMs ?? pref.cardMs };
  state.recorded = [];
  state.replay = (save.recorded || []).slice();
  state.ctrl.stopRound = save.round;
  resetControls();
  state.ctrl.speed = 0;              // 回放阶段全速
  state.hitStop = false;
  attach(newGame(save.cfg));
  renderAll();

  await run();                        // 回放到存档轮末（抛 STOP）
  if (!state.hitStop) return;         // 回放期间就分出胜负 → 结果弹层已出，不再续跑
  state.replay = null;
  state.ctrl.stopRound = null;
  state.ctrl.speed = 650;
  state.hitStop = false;
  state.logDrawn = state.game.log.length;
  toast(`已恢复到第 ${save.round} 轮`);
  run();
}

/** 挂上棋盘与观察点（onCard 只做展示，同步、不阻塞）。 */
function attach(game) {
  state.game = game;
  state.curPlayer = null;
  state.pending = null;
  state.logDrawn = 0;
  state.logFilter = "all";
  state.alivePrev = null;
  state.cardQueue.length = 0;
  resetAchievements();          // 新局 / 读档：成就徽章的一次性标记清零
  clearReveal();
  hideStepTip();
  // 落点抽卡：只把卡「排队」，等 afterLand 里让真人点卡摞逐张翻开。
  // 不阻塞内核、不消耗随机数 → 同种子对拍不受影响。
  game.onCard = (g, deck, p, card, delta) => {
    if (state.replay) return;         // 回放阶段不刷屏
    state.cardQueue.push({ deck, card, player: p, delta, human: p.kind === "human" });
  };
  state.refs = buildBoard($("#board"), state.assets);
  setOrientation($("#board"), state.ctrl.orient);
  $("#log").replaceChildren();
  syncLogTools();
  setRoll(false);
  disarmPiles(true);
  const sum = $("#diceSum");
  if (sum) sum.textContent = "等待开局";
  hideTurnBubble();
  syncRegionTools();
}

// ==================================================================
// 主循环驱动
// ==================================================================
async function runOnce() {
  const g = state.game;
  const gen = state.gen;
  // 世代校验：一旦切局，旧循环必须在下一个钩子处立刻退出
  const guard = () => { if (gen !== state.gen) throw STOP; };
  const hooks = {
    beforeTurn: async (gg, p) => {
      guard();
      state.curPlayer = p;
      setRoll(false);
      showTurnBubble(p);
      renderAll();
      if (p.kind === "human" && !state.replay) await waitRoll();
      else { state.pending = { kind: "ai", p }; await gate(); }
      guard();
    },
    // 掷骰 + 逐格跳动：此钩子在 move() 之前调用，此刻 p.pos 仍是起点格
    beforeMove: async (gg, p, steps) => {
      guard();
      hideTurnBubble();
      setRoll(false);                     // 骰子出手即失去「可点」态
      if (!animOff() && steps > 0) {
        await rollDiceVisual(steps, p);
        guard();
        await walkPawn(p, steps);         // 手动模式下会等玩家逐格点棋子
        guard();
      }
      // 动画/手动走格期间可能已切局：把玩偶、待点格、骰子收干净
      const walk = state.refs && state.refs.walker;
      if (walk) { walk.hidden = true; walk.classList.remove("armed", "manual"); }
      clearTapCells();
      const tray = $("#diceTray");
      if (tray) tray.classList.remove("rolling");
    },
    // 落点结算完 → 若抽到牌，等玩家点卡摞逐张翻开（全速/回放/AI 自动翻）
    afterLand: async (gg, p) => {
      guard();
      renderAll();
      await drainCards();
      guard();
    },
    afterTurn: async () => { guard(); renderAll(); },
    afterRound: async (gg) => {
      guard();
      renderAll();
      // 整轮边界：留下可安全重放的快照（含本轮的完整人工决策）
      state.snapRound = gg.round;
      state.snapRecorded = state.recorded.slice();
      autosave();
      if (state.ctrl.stopRound !== null && gg.round >= state.ctrl.stopRound) {
        state.hitStop = true;
        throw STOP;
      }
    },
  };
  return g.play(hooks);
}

async function run() {
  const mine = state.gen;
  try {
    const res = await runOnce();
    if (mine === state.gen) onFinish(res);
  } catch (e) {
    if (e !== STOP && mine === state.gen) { console.error(e); toast(`运行中断：${e.message || e}`, 6000); }
  } finally {
    if (mine === state.gen) {
      state.curPlayer = null;
      setRoll(false);
      hideTurnBubble();
      renderAll();
    }
  }
}

/** 让上一局仍在跑的驱动循环自行退出（新局 / 读档前必须先调用）。 */
function killRunning() {
  state.gen += 1;
  state.pending = null;
  releaseWait(state.rollResolve); state.rollResolve = null;   // 放掉「等真人掷骰」
  releaseWait(state.stepResolve); state.stepResolve = null;   // 放掉「等真人走格」
  releaseWait(state.cardResolve); state.cardResolve = null;   // 放掉「等真人翻卡」
  state.cardQueue.length = 0;
  setRoll(false);
  disarmPiles(true);
  clearTapCells();
  hideStepTip();
}
function releaseWait(r) { if (r) { try { r(); } catch { /* noop */ } } }

/** 控制条复位：暂停态 / 上一局循环一并清掉。 */
function resetControls() {
  state.ctrl.paused = false;
  killRunning();
  const b = $("#btnPause");
  if (b) { b.textContent = "⏸ 暂停"; b.classList.remove("on"); }
}

/** AI 节奏 / 暂停 */
async function gate() {
  if (state.replay) return;                       // 回放全速
  while (state.ctrl.paused) { await sleep(70); if (state.replay) return; }
  if (state.ctrl.speed > 0) await sleep(state.ctrl.speed);
}

/** 真人回合：等玩家点棋盘中间的骰子。 */
function waitRoll() {
  return new Promise((resolve) => {
    state.rollResolve = resolve;
    state.pending = { kind: "roll", p: state.curPlayer };
    const sum = $("#diceSum");
    if (sum && !animOff()) sum.textContent = "🎲 点我掷骰子";
    setRoll(true);
  });
}
function doRoll() {
  if (!state.rollResolve) return;
  const r = state.rollResolve;
  state.rollResolve = null;
  state.pending = null;
  setRoll(false);
  r();
}
/** 骰子可点态：只有轮到真人、且上一动作收干净时才点亮（权限控制）。 */
function setRoll(on) {
  const t = $("#diceTray");
  if (!t) return;
  t.classList.toggle("armed", !!on);
  t.setAttribute("aria-disabled", on ? "false" : "true");
}

// ==================================================================
// 儿童化交互：掷骰跳动 / 玩偶逐格跳 / 回合气泡 / 区域折叠全屏
//
// 铁律：这些动画**只读内核、不写内核**，且不消耗内核随机数 ——
//       两枚骰面是「纯视觉随机」合成，只保证点数之和 == 内核返回的步数。
// ==================================================================

/** 全速 / 回放时不放动画（保证「同种子对拍」与验收跑得动）。 */
function animOff() { return state.replay || state.ctrl.speed === 0; }

/** 骰面点数 -> 3×3 里该亮哪几格（0..8）。 */
const PIP = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function paintDie(el, v) {
  const on = new Set(PIP[v] || []);
  el.replaceChildren(...Array.from({ length: 9 }, (_, i) => h("i", { class: on.has(i) ? "on" : "" })));
}

/**
 * 纯视觉随机合成两枚骰面，和严格等于内核步数。
 * steps 落在 2..12 时两枚骰子都出；否则（半程/加成改写过步数）只出一枚。
 */
function diceFaces(steps) {
  if (steps >= 2 && steps <= 12) {
    const lo = Math.max(1, steps - 6), hi = Math.min(6, steps - 1);
    const a = lo + Math.floor(Math.random() * (hi - lo + 1));
    return [a, steps - a];
  }
  return [Math.max(1, Math.min(6, steps)), null];
}

/** 骰子在桌面（棋盘中心常驻骰盘）上跳一阵，最后定格点数。 */
async function rollDiceVisual(steps, p) {
  const tray = $("#diceTray");
  const dieA = $("#dieA"), dieB = $("#dieB"), sum = $("#diceSum");
  if (!tray || !dieA || !dieB || !sum) return;
  const [a, b] = diceFaces(steps);
  const two = b !== null;

  tray.classList.add("rolling");
  sfx.roll();
  dieB.hidden = !two;
  sum.textContent = "…";
  dieA.classList.add("tumble");
  if (two) dieB.classList.add("tumble");

  const spin = Math.round(Math.max(380, Math.min(900, state.ctrl.speed * 0.55)));
  const t0 = Date.now();
  while (Date.now() - t0 < spin) {
    paintDie(dieA, 1 + Math.floor(Math.random() * 6));
    if (two) paintDie(dieB, 1 + Math.floor(Math.random() * 6));
    await sleep(70);
  }
  dieA.classList.remove("tumble");
  if (two) dieB.classList.remove("tumble");
  paintDie(dieA, a);
  if (two) paintDie(dieB, b);
  sum.textContent = two ? `${a} + ${b} = ${steps}` : `${a} 点`;

  await sleep(Math.round(Math.max(220, Math.min(520, state.ctrl.speed * 0.36))));
  tray.classList.remove("rolling");      // 点数留在盘面上，直到下一回合
}

/**
 * 玩偶从起点逐格跳到落点，边走边报剩余步数。
 *   手动模式（默认）：每一格等玩家点「棋子」或「下一格」才推进 —— 完全仿真线下走格。
 *   自动模式：按节奏自动跳完。
 */
async function walkPawn(p, steps) {
  const root = $("#board");
  const walk = state.refs && state.refs.walker;
  if (!root || !walk || steps <= 0) return;

  const img = walk.querySelector(".wk-img");
  const noEl = walk.querySelector(".wk-no");
  const stepEl = walk.querySelector(".wk-step");
  const n = Math.min(steps, 40);
  const per = Math.round(Math.max(110, Math.min(300, state.ctrl.speed * 0.32)));
  const gen = state.gen;

  walk.hidden = false;
  walk.style.setProperty("--sc", seatColor(p.idx));
  // 玩偶本体 = 该座位的京味棋子（糖葫芦 / 鸽哨 / 脸谱 / 黄包车）
  const art = pawnSrc(state.assets, p.idx);
  if (img) { img.hidden = !art; if (art) img.src = art; }
  if (noEl) noEl.textContent = art ? "" : (SEAT_EMOJI[p.idx % SEAT_EMOJI.length] || String(p.idx + 1));

  const clearHop = () => root.querySelectorAll(".cell.hop").forEach((el) => el.classList.remove("hop"));

  for (let i = 0; i <= n; i++) {
    const cell = (p.pos + i) % 40;
    const c = cellCenter(root, cell);
    if (c) { walk.style.left = `${c.x}px`; walk.style.top = `${c.y}px`; }
    clearHop();
    const el = root.querySelector(`.cell[data-cell="${cell}"]`);
    if (el) el.classList.add("hop");
    if (stepEl) stepEl.textContent = i < n ? String(n - i) : "✓";
    walk.classList.remove("hop");
    void walk.offsetWidth;               // 强制重排，让每跳都重新触发动画
    walk.classList.add("hop");
    sfx.hop();
    if (i < n) {
      // 逐格点棋子只对真人开放：电脑回合一律自动走完，玩家不必替电脑点棋子。
      if (state.ctrl.walkMode === "manual" && p.kind === "human") {
        await waitStep((p.pos + i + 1) % 40, n - i - 1, p);
        walk.hidden = false;
        if (gen !== state.gen) { walk.classList.remove("armed"); return; }
      } else {
        await sleep(per);
      }
    }
  }
  clearHop();

  const dst = root.querySelector(`.cell[data-cell="${(p.pos + n) % 40}"]`);
  if (dst) { dst.classList.add("landed"); setTimeout(() => dst.classList.remove("landed"), 700); }
  sfx.land();
  walk.hidden = true;
  walk.classList.remove("armed", "manual");
  hideStepTip();
}

/** 手动走格：点亮棋子与「下一格」，等玩家任点其一推进一格。 */
function waitStep(nextCell, remain, p) {
  return new Promise((resolve) => {
    state.stepResolve = resolve;
    state.pending = { kind: "step", p, remain: Math.max(1, remain || 1) };
    const walk = state.refs && state.refs.walker;
    if (walk) walk.classList.add("armed");
    clearTapCells();
    const root = $("#board");
    const c = root && root.querySelector(`.cell[data-cell="${nextCell}"]`);
    if (c) c.classList.add("tap");
    showStepTip(nextCell, p);        // 顺手预告「下一格会怎样」，让玩家决定点不点
  });
}
function doStep() {
  if (!state.stepResolve) return;
  const r = state.stepResolve;
  state.stepResolve = null;
  state.pending = null;
  const walk = state.refs && state.refs.walker;
  if (walk) walk.classList.remove("armed");
  clearTapCells();
  hideStepTip();
  r();
}

/**
 * 「下一格预告」：手动走格时在棋盘上浮一条小提示，说明下一格是什么、
 * 是谁的、要付多少租或能不能买 —— 全部只读内核（g.posCell / g.ownerOf / g.rentOf）。
 */
function showStepTip(cell, p) {
  const tip = state.refs && state.refs.stepTip;
  const g = state.game;
  if (!tip || !g || cell == null) return;
  const c = g.posCell(cell);
  const lm = g.lm(cell);
  let detail;
  if (c.type === "地标") {
    const oi = g.ownerOf.has(cell) ? g.ownerOf.get(cell) : null;
    if (oi === null) detail = lm.price > 0 ? `空地 · 可买 ¥${num(lm.price)}` : "空地";
    else if (oi === p.idx) detail = "你自己的地";
    else {
      const o = g.players[oi];
      detail = `${o.name} 的地 · 租 ¥${num(g.rentOf(cell, o))}`;
    }
  } else {
    detail = c.type;                 // 机会 / 命运 / 寻宝 / 角
  }
  const txt = tip.querySelector(".st-txt");
  if (txt) txt.textContent = `${c.name}（${detail}）`;
  tip.hidden = false;
}
function hideStepTip() {
  const tip = state.refs && state.refs.stepTip;
  if (tip) tip.hidden = true;
}
function clearTapCells() {
  const root = $("#board");
  if (root) root.querySelectorAll(".cell.tap").forEach((el) => el.classList.remove("tap"));
}

// ------------------------------------------------------------------
// 卡牌交互：落点抽到牌后，点亮对应卡摞等玩家点开；点一下翻一张。
// 内核已在 land() 里结算完毕 —— 这里只是「把已发生的事实翻给玩家看」。
// ------------------------------------------------------------------
function armPiles() {
  const refs = state.refs;
  if (!refs || !refs.piles) return;
  const decks = new Set(state.cardQueue.map((it) => it.deck));
  for (const [deck, el] of Object.entries(refs.piles)) {
    el.classList.toggle("live", decks.has(deck));
    el.classList.toggle("armed", decks.has(deck));
  }
}
function disarmPiles(force) {
  const refs = state.refs;
  if (!refs || !refs.piles) return;
  const hide = () => {
    if (!force && state.cardQueue.length) return;
    for (const el of Object.values(refs.piles)) el.classList.remove("live", "armed");
  };
  for (const el of Object.values(refs.piles)) el.classList.remove("armed");
  if (force) hide(); else setTimeout(hide, 900);   // 翻完留一小会儿再收
}
/** 翻牌的声音：先一声翻卡，再按收入 / 支出补一声。 */
function cardSound(delta) {
  sfx.card();
  if (delta > 0) sfx.coin();
  else if (delta < 0) sfx.pay();
}

/**
 * 翻牌停留时长（毫秒）：<=0 表示「不自动关，等玩家点」。
 *   · 闲置演示（attractMode）：跟着速度走，保持展示节奏。
 *   · 真人抽到的卡：manual = 等玩家点（0）；auto = 用设置的时长。
 *   · 电脑抽到的卡：没人盯着，一律按设置的时长自动翻（manual 模式下也一样）。
 */
function cardDuration(isHuman) {
  const cfg = state.cfg || {};
  if (state.attractMode) return Math.max(2400, state.ctrl.speed * 4);
  const ms = Number(cfg.cardMs) || 6000;
  if (isHuman && (cfg.cardMode || "manual") === "manual") return 0;
  return ms;
}

/** 翻一张牌：出画面 + 出队；队列空则放行内核。 */
function flipOne() {
  const q = state.cardQueue;
  if (!q.length) return;
  const it = q.shift();
  revealCard({
    deck: it.deck, card: it.card, player: it.player, delta: it.delta,
    assets: state.assets,
    duration: cardDuration(it.human),   // 真人 +「我自己关」→ 0，读懂后点卡片 / ✕ 关掉
  });
  cardSound(it.delta);
  if (q.length) armPiles();
  else {
    disarmPiles(false);
    state.pending = null;
    const r = state.cardResolve;
    state.cardResolve = null;
    if (r) r();
  }
}
/**
 * afterLand：把本回合抽到的牌交给玩家翻。
 *   可交互（有人类玩家的牌 + 有动画）→ 点亮卡摞等点；否则直接连翻、不阻塞。
 */
async function drainCards() {
  const q = state.cardQueue;
  if (!q.length) return;
  const interactive = !animOff() && q.some((it) => it.human);
  if (!interactive) {
    // 电脑（或全速）抽到的卡：自动连翻，但每张停留够久，玩家看得清；
    // 卡上也有 ✕，想早点跳过点一下即可。停留时长取用户设置的「自动关闭」秒数。
    const dur = cardDuration(false);
    while (q.length) {
      const it = q.shift();
      revealCard({
        deck: it.deck, card: it.card, player: it.player, delta: it.delta,
        assets: state.assets, duration: dur,
      });
      cardSound(it.delta);
      if (!animOff()) await sleep(dur + 200);
    }
    return;
  }
  armPiles();
  state.pending = { kind: "cards", n: q.length, p: q[0].player };
  await new Promise((resolve) => { state.cardResolve = resolve; });
  state.pending = null;
  renderAll();
}

/** 控制条里的回合气泡（轮到谁了）。 */
function showTurnBubble(p) {
  const el = $("#turnBubble");
  if (!el) return;
  if (animOff()) { el.hidden = true; return; }
  el.textContent = p.kind === "human"
    ? `🎈 轮到你了（${p.name}），点棋盘中间的骰子走一走！`
    : `🤖 ${p.name}（电脑）自己走，不用你点`;
  el.hidden = true; void el.offsetWidth; el.hidden = false;   // 重放气泡冒出的动画
}
function hideTurnBubble() { const el = $("#turnBubble"); if (el) el.hidden = true; }

// ------------------------------------------------------------------
// 区域工具：每个区域右上角的「收起 / 全屏」按钮
// 面板内容会被 renderXxx() 整体重绘，所以每次渲染后回填一次。
// ------------------------------------------------------------------
const REGION_IDS = ["topbar", "controls", "seasonPanel", "playersPanel", "marketPanel", "logPanel"];
/** 棋盘区另开一档：只给「全屏」（收起会把棋盘藏起来，没有意义）。 */
const BOARD_ID = "boardwrap";

function syncRegionTools() {
  for (const id of REGION_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    let tools = el.querySelector(":scope > .panel-tools");
    if (!tools) {
      tools = h("div", { class: "panel-tools" });
      const bCol = h("button", { class: "ptool", type: "button", title: "收起 / 展开", "aria-label": "收起 / 展开" }, "▾");
      const bFs = h("button", { class: "ptool", type: "button", title: "全屏 / 还原", "aria-label": "全屏 / 还原" }, "⤢");
      bCol.addEventListener("click", () => {
        el.classList.toggle("collapsed");
        bCol.textContent = el.classList.contains("collapsed") ? "▸" : "▾";
      });
      bFs.addEventListener("click", () => {
        el.classList.toggle("region-fs");
        const on = el.classList.contains("region-fs");
        bFs.classList.toggle("on", on);
        bFs.textContent = on ? "⤡" : "⤢";
      });
      tools.append(bCol, bFs);
      el.append(tools);
    }
    // 状态存在区域元素自己身上，重绘后按状态回填按钮字形
    const bCol = tools.children[0], bFs = tools.children[1];
    const collapsed = el.classList.contains("collapsed");
    const fsOn = el.classList.contains("region-fs");
    if (bCol) bCol.textContent = collapsed ? "▸" : "▾";
    if (bFs) { bFs.classList.toggle("on", fsOn); bFs.textContent = fsOn ? "⤡" : "⤢"; }
  }

  // 棋盘：只挂一个「全屏」按钮。全屏 / 还原都会让 .boardwrap 尺寸变化，
  // board.js 的 ResizeObserver 会重算 --bw/--u —— 但各引擎回调时机不一，
  // WebKit（Safari）实测要等约 300ms 才送通知，期间棋盘会停在旧尺寸。
  // 所以这里切换后立刻手动量一次，让「⤢ / ⤡」当场生效，不必等观察器。
  const board = document.getElementById(BOARD_ID);
  if (board) {
    let tools = board.querySelector(":scope > .panel-tools");
    if (!tools) {
      tools = h("div", { class: "panel-tools" });
      const bFs = h("button", { class: "ptool", type: "button", title: "棋盘全屏 / 还原", "aria-label": "棋盘全屏 / 还原" }, "⤢");
      bFs.addEventListener("click", () => {
        board.classList.toggle("region-fs");
        const on = board.classList.contains("region-fs");
        bFs.classList.toggle("on", on);
        bFs.textContent = on ? "⤡" : "⤢";
        const bb = document.getElementById("board");
        if (bb) fitBoard(bb);
      });
      tools.append(bFs);
      board.append(tools);
    }
    const bFs = tools.children[0];
    const fsOn = board.classList.contains("region-fs");
    if (bFs) { bFs.classList.toggle("on", fsOn); bFs.textContent = fsOn ? "⤡" : "⤢"; }
  }
}

// ==================================================================
// 决策 provider（人类走 UI，AI 复用 aiProvider）
// ==================================================================
function makeDecisions() {
  return {
    async shouldBuy(g, p, lm) {
      if (p.kind !== "human") return aiProvider.shouldBuy(g, p, lm);
      const v = state.replay ? state.replay.shift() : await askBuy(g, p, lm);
      state.recorded.push(v);
      return v;
    },
    async build(g, p) {
      if (p.kind !== "human") return aiProvider.build(g, p);   // AI 内部已 applyBuild
      // 人类的建房决策：askBuild 只负责「问」，真正落地统一在这里执行。
      // 这样录制（真人点建）与重放（读档回放）两条路都会真正建房 ——
      // 旧版把答案返回给内核、而内核根本不接返回值，于是「点了建却没建」。
      const v = state.replay ? state.replay.shift() : await askBuild(g, p);
      state.recorded.push(v);
      if (typeof v === "number") { g.applyBuild(p, v); if (!animOff()) sfx.build(); }
      return v;
    },
    async adjustMove(g, p, steps) {
      if (p.kind !== "human") return aiProvider.adjustMove(g, p, steps);
      const v = state.replay ? state.replay.shift() : await askSteps(g, p, steps);
      state.recorded.push(v);
      return v;
    },
  };
}

/** 买地确认 */
async function askBuy(g, p, lm) {
  const ai = aiProvider.shouldBuy(g, p, lm);
  const art = state.assets.manifest.landmarks[lm.id];
  const canPay = p.cash >= lm.price;
  state.pending = { kind: "buy", p, lm };
  const body = h("div", { class: "dlg-body" },
    h("div", { class: "buy-head" },
      art ? h("img", { src: state.assets.url(art), alt: lm.name }) : null,
      h("div", null,
        h("b", { class: "buy-name" }, lm.name),
        h("span", { class: "chip", style: { background: zoneColor(lm.zone) } }, lm.zone),
        h("p", { class: "muted" }, lm.note || ""))),
    h("table", { class: "kv" },
      h("tr", null, h("th", null, "售价"), h("td", null, `¥${num(lm.price)}`)),
      h("tr", null, h("th", null, "租金（空地/院/楼）"), h("td", null, `¥${num(lm.rent0)} / ¥${num(lm.rent1)} / ¥${num(lm.rent2)}`)),
      h("tr", null, h("th", null, "建房成本"), h("td", null, `¥${num(lm.build)}`)),
      h("tr", null, h("th", null, "你的现金"), h("td", null, `¥${num(p.cash)}`)),
      h("tr", null, h("th", null, "电脑建议"), h("td", null, h("b", null, ai ? "值得买" : "先不买")))),
  );
  const v = await dialog({
    title: `轮到 ${p.name}：买地？`,
    sub: `第 ${g.round} 轮 · 落点 ${g.posCell(p.pos).name}`,
    body,
    actions: [
      { label: `买下 ¥${num(lm.price)}`, value: true, kind: "primary", disabled: !canPay, hint: canPay ? "" : "现金不足" },
      { label: "放弃", value: false, kind: "ghost" },
    ],
  });
  state.pending = null;
  if (v) sfx.buy();
  return !!v;
}

/**
 * 建房确认（每回合最多升 1 级）。
 * 准则：只有「本轮正好走回自己旧地、且建完不低于活命钱」才会弹窗；
 * 其余情况静默跳过 —— 避免选完空地立刻弹一个用不上的建房窗。
 */
function askBuild(g, p) {
  const opts = g.buildOptions(p);
  if (!opts.some((o) => o.affordable)) return Promise.resolve(false);
  state.pending = { kind: "build", p };
  return new Promise((resolve) => {
    const done = (v) => { state.pending = null; hideSheet(); resolve(v); };
    const rows = opts.map((o) => {
      const lm = g.lm(o.cell);
      return h("tr", { class: o.affordable ? "" : "off" },
        h("td", null, h("b", null, lm.name), h("span", { class: "chip", style: { background: zoneColor(lm.zone) } }, lm.zone)),
        h("td", null, o.lvl === 0 ? "空地 → 四合院" : "四合院 → 城楼"),
        h("td", null, `¥${num(o.cost)}`),
        h("td", null, `+¥${num(o.gain)}`),
        h("td", null, h("button", {
          class: "mini", type: "button", disabled: !o.affordable,
          onclick: (e) => { e.preventDefault(); done(o.cell); },
        }, "建")));
    });
    showSheet(h("div", { class: "dlg" },
      h("div", { class: "dlg-h" },
        h("b", null, `轮到 ${p.name}：建房？`),
        h("p", null, `现金 ¥${num(p.cash)} · 活命钱线 ¥${num(g.safetyLine())} · 每回合最多升 1 级`)),
      h("div", { class: "dlg-body" },
        h("table", { class: "tbl" },
          h("thead", null, h("tr", null,
            h("th", null, "地块"), h("th", null, "升级"), h("th", null, "花费"), h("th", null, "租金增"), h("th", null, ""))),
          h("tbody", null, rows))),
      h("div", { class: "dlg-actions" },
        h("button", { class: "btn ghost", type: "button", onclick: () => done(false) }, "跳过")),
    ));
  });
}

/** I-03 背包客：掷骰后自愿少走 1–2 格 */
async function askSteps(g, p, steps) {
  const opts = [steps];
  for (const d of [1, 2]) if (steps - d >= 2) opts.push(steps - d);
  if (opts.length === 1) return steps;
  state.pending = { kind: "steps", p, steps };
  const actions = opts.map((s) => {
    const danger = g.dangerOf(p, s);
    const cell = g.posCell((p.pos + s) % 40);
    return {
      label: `走 ${s} 格 → ${cell.name}${danger ? `（租 ¥${num(danger)}）` : "（无租金）"}`,
      value: s, kind: s === steps ? "ghost" : "primary",
    };
  });
  const v = await dialog({ title: `${p.name}（背包客）要少走吗？`, sub: "掷出点数可自愿少走 1–2 格（最少 2 格）", actions });
  state.pending = null;
  return Number.isFinite(v) ? v : steps;
}

// ==================================================================
// 渲染
// ==================================================================
function renderAll() {
  const g = state.game;
  if (!g) return;
  // 有人破产（存活人数变少）时出一声，其余时刻只更新基准值
  const alive = g.players.filter((p) => p.alive).length;
  if (state.alivePrev !== null && alive < state.alivePrev && !animOff()) sfx.dead();
  state.alivePrev = alive;
  updateBoard(state.refs, g, {
    activeCell: state.curPlayer ? state.curPlayer.pos : -1,
    currentPlayer: state.curPlayer,
  });
  renderSeason($("#seasonPanel"), g, state.assets);
  // 现金飘字只在「真放动画」时出（全速 / 回放不闪，也避免回放重建时误判）
  renderPlayers($("#playersPanel"), g, state.cfg, state.assets, { animate: !animOff() });
  renderMarket($("#marketPanel"), g, state.assets);
  renderLog($("#log"), g.log, state.logFilter, state.logDrawn);
  state.logDrawn = g.log.length;
  renderStatus(g);
  syncRegionTools();          // 面板被整体重绘 → 回填右上角的收起/全屏按钮
  checkBadges(g);             // 成就徽章：只读内核，命中即冒一枚（回放 / 演示不冒）
}

/**
 * 成就徽章：每帧检查一次，把这次新解锁的徽章依次冒出来。
 * 铁律：只读 g、不写内核、不消耗随机数。
 * 回放（读档重放）与闲置演示里即使解锁也不冒，免得刷屏；
 * 但仍会推进解锁标记，避免回放结束后补冒一串旧成就。
 */
function checkBadges(g) {
  const got = checkAchievements(g);
  if (state.replay || state.attractMode) return;
  for (const b of got) { badge(b); sfx.badge(); }
}

function renderStatus(g) {
  const el = $("#status");
  if (!el) return;
  // 注意：replaceChildren 会把 null 变成文本 "null"，必须先把空项滤掉。
  const parts = [
    h("span", null, `第 ${g.round}/${g.maxRounds} 轮`),
    h("span", { class: "dot" }, "·"),
    h("span", null, `${g.turnCount} 次行动`),
    state.ctrl.paused ? h("span", { class: "paused" }, "已暂停") : null,
    h("span", {
      class: "seed", title: "随机种子：同一串数字 = 完全同一局（骰子与卡牌顺序都一样），用来复现或公平对战。",
    }, `种子 ${state.cfg ? state.cfg.seed : "-"}`),
  ].filter(Boolean);
  el.replaceChildren(...parts);
}

// ==================================================================
// 结束
// ==================================================================
function onFinish(res) {
  if (state.attractMode) return;      // 演示局：不出结算弹层、不写存档，直接开下一盘
  sfx.win();
  clearSave();
  state.pending = { kind: "done" };
  const rows = res.players.map((p) => h("tr", { class: p.alive ? "" : "off" },
    h("td", null, h("b", null, p.name)),
    h("td", null, p.alive ? "存活" : "破产"),
    h("td", null, `¥${num(p.cash)}`),
    h("td", null, `¥${num(p.assets)}`),
    h("td", null, `${p.lands} 块`),
    h("td", null, `${p.nBuild}`),
    h("td", null, `${p.rentGot}`)));
  showSheet(h("div", { class: "dlg" },
    h("div", { class: "dlg-h" }, h("b", null, `🏆 ${res.winner} 获胜`), h("p", null, res.reason)),
    h("div", { class: "dlg-body" },
      h("table", { class: "tbl" },
        h("thead", null, h("tr", null,
          h("th", null, "玩家"), h("th", null, "状态"), h("th", null, "现金"), h("th", null, "总资产"), h("th", null, "地块"), h("th", null, "建房"), h("th", null, "收租"))),
        h("tbody", null, rows)),
      h("p", { class: "muted" },
        `共 ${res.rounds} 轮 / ${res.turns} 次行动 · 破产 ${res.bankrupts} 人 · 换季 ${res.seasonChanges} 次 · 任务 ${res.tasksDone}/${res.tasksTotal}`)),
    h("div", { class: "dlg-actions" },
      h("button", { class: "btn primary", type: "button", onclick: () => { hideSheet(); newRound(); } }, "再来一局"),
      h("button", { class: "btn ghost", type: "button", onclick: hideSheet }, "看看棋盘")),
  ), { width: 620 });
}

async function newRound() {
  await mainMenu();
}

// ==================================================================
// 存档（配置 + 种子 + 人工决策序列；读档靠确定性重放）
//
// 存档头里带两枚指纹（见 core/savefmt.js）：规则口径变了、或开局配置对不上，
// 读档会被明确拒绝 —— 重放是位置式的，宁可拒绝也不能悄悄放行一盘错棋。
// 底层读写全部走 ui/store.js：Web 版 localStorage，Android 外壳再镜像一份到私有目录。
// ==================================================================
function readSlot(key) {
  try { return JSON.parse(getItem(key) || "null"); } catch { return null; }
}
function writeSlot(key, save) { try { setItem(key, JSON.stringify(save)); } catch { /* noop */ } }
function clearSlot(key) { try { removeItem(key); } catch { /* noop */ } }

/** 自动存档里可续的那局（通过校验才算数）。 */
function currentSave() {
  const raw = readSlot(AUTO_KEY);
  return raw && validateSave(raw).ok ? raw : null;
}

/** 用「最近一个已完成整轮」的快照组装存档；没有整轮快照时返回 null。 */
function makeSave() {
  if (!state.cfg || !state.snapRound) return null;
  return buildSave({
    cfg: state.cfg, round: state.snapRound, recorded: state.snapRecorded,
    engine: APP_VERSION, savedAt: Date.now(),
  });
}
function writeSave() {
  if (state.attractMode || state.replay) return;   // 演示局 / 回放期从不落盘
  if (!state.snapRound) return;                    // 尚无完成的整轮，不产生半轮存档
  const s = makeSave();
  if (s) writeSlot(AUTO_KEY, s);
}
function clearSave() { clearSlot(AUTO_KEY); }
const autosave = () => { if (!state.replay && !state.attractMode) writeSave(); };

/** 存档摘要里的「谁在玩」：有称呼用称呼，否则按真人 / 电脑标注。 */
function saveSummary(save) {
  const cfg = save && save.cfg;
  if (!cfg) return "";
  const n = Number(cfg.players) || 0;
  const who = Array.from({ length: n }, (_, i) => {
    const nm = String((cfg.names || [])[i] || "").trim();
    return nm || ((cfg.humans || [])[i] ? `真人${i + 1}` : `电脑${i + 1}`);
  }).join(" / ");
  return `第 ${save.round} 轮 · ${who}`;
}
const saveInfo = saveSummary;

/** 存档箱里的一行说明（时间戳 + 摘要）。 */
function slotLine(save) {
  const d = new Date(Number(save.savedAt) || Date.now());
  const p2 = (n) => String(n).padStart(2, "0");
  const when = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return `${saveSummary(save)} · ${when}`;
}

/** 存档箱面板：自动存档 + 3 个命名档位，逐个可存 / 读 / 删。 */
function openSaveBox() {
  const node = h("div", { class: "dlg savebox" },
    h("div", { class: "dlg-h" },
      h("b", null, "📂 存档箱"),
      h("p", null, "「自动存档」每完成一整轮会自动更新；下面 3 个档位可以手动存，随时读回来。"
        + (hasNativeMirror() ? "（已镜像到本机私有目录，换包也还在）" : ""))),
    h("div", { class: "dlg-body" }, h("div", { class: "sv-list", id: "svList" })),
    h("div", { class: "dlg-actions" },
      h("button", { class: "btn primary", type: "button", onclick: hideSheet }, "关闭")),
  );
  showSheet(node, { width: 580 });
  renderSaveBox();
}

function renderSaveBox() {
  const list = document.getElementById("svList");
  if (!list) return;
  const canSave = !!state.snapRound && !state.replay && !state.attractMode;
  const rows = SAVE_SLOTS.map((slot) => {
    const raw = readSlot(slot.key);
    const chk = raw ? validateSave(raw) : { ok: false, reason: "" };
    const empty = !raw;
    const info = h("div", { class: "sv-info" },
      h("b", null, slot.auto ? `${slot.label}（每轮自动）` : slot.label),
      h("span", { class: empty || chk.ok ? "" : "sv-bad" },
        empty ? "空档位" : (chk.ok ? slotLine(raw) : `⚠ ${chk.reason}`)));
    const btns = h("div", { class: "sv-btns" },
      h("button", {
        class: "btn mini", type: "button", disabled: !canSave,
        title: canSave ? "把当前进度存到这个档位" : "还没有完成整轮，暂时不能存",
        onclick: () => saveToSlot(slot.key),
      }, "存"),
      h("button", {
        class: "btn mini", type: "button", disabled: !(raw && chk.ok),
        title: raw && chk.ok ? "读取这一档" : (chk.reason || "空档位"),
        onclick: () => loadFromSlot(raw, chk),
      }, "读"),
      h("button", {
        class: "btn mini danger", type: "button", disabled: empty,
        onclick: () => { clearSlot(slot.key); renderSaveBox(); toast(`已删除「${slot.label}」`); },
      }, "删"));
    return h("div", { class: `sv-row${empty ? " empty" : ""}` }, info, btns);
  });
  list.replaceChildren(...rows);
}

function saveToSlot(key) {
  const s = makeSave();
  if (!s) return toast("尚未完成整轮，稍后再存");
  writeSlot(key, s);
  renderSaveBox();
  toast(`已存档：第 ${state.snapRound} 轮`);
}

async function loadFromSlot(raw, chk) {
  if (!raw || !chk.ok) return toast(chk.reason || "这个档位是空的");
  hideSheet();
  state.ctrl.paused = true;
  await startResume(raw);
}

// ==================================================================
// 控制条
// ==================================================================
function bindControls() {
  // 棋盘内一律走事件委托：#board 是 HTML 里的稳定节点，而骰盘 / 卡摞 / 棋子
  // 都由 buildBoard() 重建（clear(root) 会整片换掉），直接绑它们等于绑到死节点。
  const board = $("#board");
  if (board) {
    board.addEventListener("click", (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest("#diceTray")) { doRoll(); return; }              // 点骰子 → 掷骰子
      if (t.closest(".pile.armed")) { flipOne(); return; }           // 点卡摞 → 翻开一页
      if (state.stepResolve && t.closest(".walker.armed, .cell.tap")) doStep();  // 点棋子 → 跳一格
    });
    board.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target && e.target.id === "diceTray") {
        e.preventDefault(); doRoll();
      }
    });
  }

  // 走格模式：手动逐格点 ↔ 自动跳格
  $("#btnWalk").addEventListener("click", (e) => {
    state.ctrl.walkMode = state.ctrl.walkMode === "manual" ? "auto" : "manual";
    e.currentTarget.textContent = state.ctrl.walkMode === "manual" ? "👣 走格：手动" : "🤖 走格：自动";
    savePrefs({ walkMode: state.ctrl.walkMode });
    if (state.ctrl.walkMode === "auto" && state.stepResolve) doStep();   // 半路切自动 → 立刻放行
  });

  $("#btnPause").addEventListener("click", (e) => {
    state.ctrl.paused = !state.ctrl.paused;
    e.currentTarget.textContent = state.ctrl.paused ? "▶ 继续" : "⏸ 暂停";
    e.currentTarget.classList.toggle("on", state.ctrl.paused);
    renderStatus(state.game);
  });

  // 日志筛选：纯 CSS（容器 data-filter + .lg-* 隐藏），切换不重建节点 → 长局也不卡。
  // 「跳到第 N 轮」下拉的绑定在 panels.js 的 syncLogJump 里（只需绑一次）。
  const ltools = $("#logTools");
  if (ltools) ltools.addEventListener("click", (e) => {
    const b = e.target && e.target.closest && e.target.closest(".ltool");
    if (!b) return;
    state.logFilter = b.dataset.filter || "all";
    syncLogTools();
    const g = state.game;
    if (g) renderLog($("#log"), g.log, state.logFilter, state.logDrawn);
  });

  // 键盘快捷键：外接键盘 / 无障碍也能玩（弹层打开或输入框聚焦时不接管）
  document.addEventListener("keydown", onHotkeys);

  $("#speed").addEventListener("change", (e) => {
    state.ctrl.speed = Number(e.target.value);
    savePrefs({ speed: state.ctrl.speed });
  });

  // 隐藏式玩法助手：随时点开，按当前棋局现状讲规则 + 支招
  const coachBtn = $("#btnCoach");
  if (coachBtn) coachBtn.addEventListener("click", () => openCoach(state));

  // 音效开关：随时可点；关掉时连音频上下文都不创建（见 ui/sfx.js）
  const sndBtn = $("#btnSound");
  if (sndBtn) sndBtn.addEventListener("click", () => {
    const on = !isSoundOn();
    setSound(on);
    savePrefs({ sound: on });
    updateSoundBtn();
    if (on) sfx.tap();
  });

  $("#btnOrient").addEventListener("click", (e) => {
    state.ctrl.orient = state.ctrl.orient === "flat" ? "paper" : "flat";
    setOrientation($("#board"), state.ctrl.orient);
    e.currentTarget.textContent = state.ctrl.orient === "flat" ? "🧭 棋盘：正向" : "🧭 棋盘：纸样";
    savePrefs({ orient: state.ctrl.orient });
  });

  $("#btnNew").addEventListener("click", async () => {
    state.ctrl.paused = true;
    await mainMenu();
  });

  // 存档入口只留一个：打开存档箱（「自动存档」每完成一整轮自动写；命名档位可存/读/删）
  $("#btnLoad").addEventListener("click", () => {
    if (state.attractMode) return toast("演示中，先点一下屏幕开始玩");
    state.ctrl.paused = true;
    if (!state.snapRound) toast("还没走完一整轮，先转几圈再来存～");
    openSaveBox();
  });

  // 切到后台 / 关页面前补存一次（仍只取整轮边界，不做半轮快照）。
  const flush = () => { if (!state.replay && !state.attractMode) writeSave(); };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);
}

/** 同步日志筛选按钮的选中态（attach / 切局时回填）。 */
function syncLogTools() {
  const ltools = $("#logTools");
  if (!ltools) return;
  for (const b of ltools.querySelectorAll(".ltool")) {
    b.classList.toggle("on", (b.dataset.filter || "all") === state.logFilter);
  }
}

/**
 * 键盘快捷键（触屏终端接了外接键盘、或无障碍场景也能玩）：
 *   空格 / 回车 → 该掷骰就掷骰、该走格就走一格（可连按，一格一格推着走）
 *   ? 或 /      → 打开玩法助手
 *   P           → 暂停 / 继续
 * 输入框聚焦或弹层打开时一律不接管（弹层有自己的一套键位：数字选选项、Esc 关闭）。
 */
function onHotkeys(e) {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA"
            || t.tagName === "BUTTON" || t.isContentEditable)) return;
  const ov = document.getElementById("overlay");
  if (ov && !ov.hidden) return;
  if (document.querySelector(".coach-ov")) return;   // 玩法助手开着时不接管（避免隔层操作）
  if (e.key === " " || e.key === "Spacebar" || e.key === "Enter") {
    if (state.rollResolve) { e.preventDefault(); doRoll(); }
    else if (state.stepResolve) { e.preventDefault(); doStep(); }
  } else if (e.key === "?" || e.key === "/") {
    e.preventDefault();
    openCoach(state);
  } else if (e.key === "p" || e.key === "P") {
    const b = $("#btnPause");
    if (b) b.click();
  }
}

window.addEventListener("error", (e) => console.error("[jym]", e.error || e.message));

init();
