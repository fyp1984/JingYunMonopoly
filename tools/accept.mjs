/**
 * tools/accept.mjs —— 本机 Web 版端到端验收（零依赖，走系统 Chrome 的 DevTools 协议）
 *
 * 前置：
 *   1) 起静态服务： npm run serve        （= python3 -m http.server 8099 --directory public）
 *   2) 起 Chrome：   npm run chrome       （= 系统 Chrome headless + 9222 调试端口）
 *      若 9222 不可达，本脚本会自己拉一个 headless Chrome（临时 profile）。
 *   然后：         npm run accept
 *
 * 环境变量：
 *   JYM_URL    默认 http://localhost:8099/
 *   JYM_CDP    默认 http://127.0.0.1:9222
 *   JYM_SHOTS  截图目录；设了才出图（默认不出）
 *
 * 覆盖场景：
 *   A 整局收官（4 人 · 人机混战，跑到分出胜负）
 *   B 标准 2 人局（视觉/几何度量）
 *   C 暂停 / 恢复
 *   D 存档 → 读档（整轮边界快照 + 确定性重放）
 *   E 棋盘朝向切换（正向 ↔ 纸样）
 *   F 5 条加料开关全关（季节/胡同规则不应生效）
 *   G 儿童化交互（掷骰跳动 / 逐格跳格玩偶 / 落格脉冲 / 区域折叠全屏 / 中心新版式）
 *   H 触屏仿真 + 权限控制（点骰才掷 · 点棋子才走 · 点卡才翻；骰子仅回合内可点）
 *   I 连续仿真 ≥10 轮（手动走格 + 点卡，全程不卡死）
 *   J 手机竖屏触摸（390×844 · DPR3 · 纯 touch 事件：点骰 / 点棋子 / 点卡）
 *   K 多真人混战（2 真人 + 2 电脑 · 自定义称呼 · 真人手动 / 电脑自动组合）
 *   L 首次图文引导 / 高级设置图文卡 / 提示可点关（含触屏终端尺寸下的弹层几何）
 *   M 弹层几何 / 玩法助手滚动（矮视口：内容不裁切 · 可上下滑 · 刷新不打回顶部）
 *   N 首轮买地不弹建房窗（建房规则：第一轮只占空地，UI 侧守护）
 *   O 真人建房真正落地（走回旧地点「建」→ 玩家卡出「四合院」· 建房计数 +1 · 日志留痕）
 *   P 存档箱（多档位 · 坏档 / 旧结构版本被明确拒绝并禁读）
 *   Q 用户设置持久化 + 音效（静音不建 AudioContext · 喇叭开关即时生效并回写）
 *   R 儿童化增强（成就徽章 / 资产领先条 + 现金飘字 / 日志筛选 + 轮次吸顶 /
 *     手动走格「下一格预告」/ 全键盘操作 / 系统「减少动态效果」降级）
 *   S 弹层底栏不遮内容（1280×672：sticky 底栏上沿 ≥ 最后一项内容下沿）
 *   T 翻牌提示手动关 / 自动关（auto 到点自己收、manual 一直等玩家点、时长可设）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const URL_TARGET = process.env.JYM_URL || "http://localhost:8099/";
const CDP_HTTP = process.env.JYM_CDP || "http://127.0.0.1:9222";
const SHOTS = process.env.JYM_SHOTS || "";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** 在文档开始前把 AudioContext 换成带计数的壳（见 openPage 的 instrument 选项）。 */
const AUDIO_COUNT_SHIM = `try{
  window.__acCount = 0;
  const __Orig = window.AudioContext || window.webkitAudioContext;
  if (__Orig) {
    const __W = function (...a) { window.__acCount++; return new __Orig(...a); };
    __W.prototype = __Orig.prototype;
    window.AudioContext = __W; window.webkitAudioContext = __W;
  }
}catch(e){}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------
// CDP 最小客户端
// ------------------------------------------------------------------
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else for (const h of this.handlers) h(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(fn) { this.handlers.push(fn); }
}

const waitOpen = (ws) => new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", () => rej(new Error("WebSocket 连接失败")), { once: true });
});

let chromeProc = null;

async function ensureChrome() {
  try {
    const r = await fetch(`${CDP_HTTP}/json/version`);
    if (r.ok) return null;
  } catch { /* 未起 */ }
  if (!fs.existsSync(CHROME)) throw new Error(`未找到 Chrome：${CHROME}（可用 JYM_CDP 指向已开的调试端口）`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jym-accept-chrome-"));
  chromeProc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=9222",
    `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "about:blank",
  ], { stdio: "ignore", detached: false });
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try { const r = await fetch(`${CDP_HTTP}/json/version`); if (r.ok) return chromeProc; } catch { /* 继续等 */ }
  }
  throw new Error("headless Chrome 启动超时");
}

async function ensureServer() {
  try {
    const r = await fetch(URL_TARGET);
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    throw new Error(`静态服务不可达 ${URL_TARGET}\n  请先执行： npm run serve`);
  }
}

/** 起服务与浏览器。 */

// ------------------------------------------------------------------
// 页面封装
// ------------------------------------------------------------------
async function openPage(cdp, { mobile = false, fresh = false, keepPrefs = false, instrument = false, prefs = null } = {}) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: S } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const problems = [];

  cdp.on((m) => {
    if (m.sessionId !== S) return;
    if (m.method === "Runtime.exceptionThrown") {
      problems.push("[exception] " + (m.params.exceptionDetails?.exception?.description
        || m.params.exceptionDetails?.text));
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      problems.push("[console.error] " + m.params.args.map((a) => a.value ?? a.description).join(" "));
    } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      problems.push("[log] " + m.params.entry.text + " " + (m.params.entry.url || ""));
    } else if (m.method === "Network.responseReceived" && m.params.response.status >= 400) {
      problems.push(`[http ${m.params.response.status}] ${m.params.response.url}`);
    }
  });

  for (const m of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]) {
    await cdp.send(m, {}, S);
  }
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, S);
  await cdp.send("Emulation.setDeviceMetricsOverride", mobile
    ? { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
    : { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, S);
  if (mobile) {
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, S);
    await cdp.send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" }, S);
  }

  const load = new Promise((res) => cdp.on((m) => {
    if (m.sessionId === S && m.method === "Page.loadEventFired") res();
  }));
  // 除场景 L 外，一律先把「首次打开图文引导」标记成已看过 —— 它是给真人首玩的，
  // 会挡在开局表单前面；在文档创建前写入，保证 app.js 读到的就是「已看过」。
  // 场景 L 反过来：同一浏览器 profile 里前面的场景已经把该标记写成「已看过」，
  // 必须显式清掉，才能验证「首次打开」真的会弹引导。
  //
  // 同理，除个别要验证「记住设置」的场景（keepPrefs）外，一律清掉已记住的设置：
  // 否则前面的场景会把人数 / 开关等写成新的默认值，后面的场景就被隐式带偏了。
  //
  // instrument：在文档开始前把 AudioContext 换成带计数的壳。必须这么早注入 ——
  // app.js 起标题页时就会按「音效开」建好上下文并缓存，之后再打桩就拦不住了。
  // prefs：预置一份本机设置（用于「开机就是静音」这类场景）。
  const boot = [
    fresh ? `try{localStorage.removeItem('jym.onboard.v1')}catch(e){}`
          : `try{localStorage.setItem('jym.onboard.v1','1')}catch(e){}`,
    keepPrefs ? "" : `try{localStorage.removeItem('jym.prefs.v1')}catch(e){}`,
    prefs ? `try{localStorage.setItem('jym.prefs.v1', ${JSON.stringify(JSON.stringify(prefs))})}catch(e){}` : "",
    instrument ? AUDIO_COUNT_SHIM : "",
  ].filter(Boolean).join(";");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: boot }, S);
  await cdp.send("Page.navigate", { url: `${URL_TARGET}?t=${Date.now()}` }, S);
  await load;

  const api = {};
  api.S = S;
  api.problems = problems;
  api.evalJs = async (expression) => {
    const r = await cdp.send("Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
    }
    return r.result.value;
  };
  api.waitFor = async (expr, { timeout = 15000, interval = 150, label = expr } = {}) => {
    const t0 = Date.now();
    for (;;) {
      let v = false;
      try { v = await api.evalJs(expr); } catch { v = false; }
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error(`等待超时：${label}`);
      await sleep(interval);
    }
  };
  api.shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, S);
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
  };
  api.close = async () => { try { await cdp.send("Target.closeTarget", { targetId }); } catch { /* noop */ } };

  /** 真·触摸点击：按元素中心派发 touchStart/touchEnd（手机仿真，不走 mouse）。 */
  api.tap = async (sel) => {
    const box = await api.evalJs(`(()=>{
      const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return null;
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return { x: r.left + r.width / 2, y: r.top + r.height / 2,
               w: Math.round(r.width), h: Math.round(r.height),
               pe: cs.pointerEvents, vis: cs.visibility, disp: cs.display };
    })()`);
    if (!box) throw new Error(`触摸目标不存在或不可见：${sel}`);
    const x = Math.round(box.x), y = Math.round(box.y);
    await cdp.send("Input.dispatchTouchEvent",
      { type: "touchStart", touchPoints: [{ x, y, radiusX: 1, radiusY: 1, force: 1 }] }, S);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, S);
    return box;
  };

  /** 按「JS 表达式取元素」再触摸（用于 overlay 按钮等不好写选择器的目标）。 */
  api.tapBy = async (expr) => {
    await api.evalJs(`(()=>{
      document.querySelectorAll('[data-tapx]').forEach((e) => e.removeAttribute('data-tapx'));
      const e = (${expr});
      if (e) e.setAttribute('data-tapx', '1');
      return !!e;
    })()`);
    return api.tap("[data-tapx]");
  };

  // 页面就绪信号：常规场景 = 开局设置弹层；fresh（场景 L）= 首次图文引导弹层
  await api.waitFor(
    fresh
      ? `(()=>{const o=document.querySelector('.overlay');
           return !!o && !o.hidden && !!document.querySelector('.onboard');})()`
      : `(()=>{const o=document.querySelector('.overlay');
           return !!o && !o.hidden && !!document.querySelector('.setup');})()`,
    { timeout: 20000, label: fresh ? "首次图文引导弹层" : "开局设置弹层" });
  return api;
}

/** 推进一步（弹层 > 卡摞 > 走格 > 骰子）。返回动作名。 */
const advance = (p) => p.evalJs(`(()=>{
  const ov = document.querySelector('.overlay');
  if (ov && !ov.hidden) {
    const btns = [...ov.querySelectorAll('.dlg-actions .btn, .dlg-body .btn')];
    if (!btns.length) return 'dlg-wait';
    const b = btns.find(x => /放弃|跳过|看看棋盘/.test(x.textContent)) || btns[btns.length-1];
    const t = b.textContent.trim();
    b.click(); return 'dlg:' + t;
  }
  const pile = document.querySelector('.pile.armed');
  if (pile) { pile.click(); return 'card'; }
  const walk = document.querySelector('.walker.armed');
  if (walk) { walk.click(); return 'step'; }
  const tray = document.querySelector('#diceTray.armed');
  if (tray) { tray.click(); return 'roll'; }
  return 'wait';
})()`);

/** 切到「自动走格」——只关心其它机制的场景用，省掉逐格点击。 */
const setWalkAuto = (p) => p.evalJs(`(()=>{
  const b = document.querySelector('#btnWalk');
  if (b && /手动/.test(b.textContent)) b.click();
  return b ? b.textContent : '';
})()`);

const statusText = (p) => p.evalJs(`document.querySelector('#status').innerText.replace(/\\s+/g,' ')`);
const roundNo = async (p) => {
  const t = await statusText(p);
  const m = t.match(/第\s*(\d+)\s*\//);
  return m ? Number(m[1]) : 0;
};

/** 把速度切成全速（setup 完成后 startNew 会重置成“中”，需再改一次）。 */
const setSpeed = (p, v) => p.evalJs(`(()=>{
  const s = document.querySelector('#speed'); s.value = '${v}';
  s.dispatchEvent(new Event('change')); return s.value;
})()`);

/** 填开局表单并开始。o = { players, humans:[bool], names:[string], seed, switches:{key:bool} } */
async function startGame(p, o = {}) {
  const json = JSON.stringify(o);
  return p.evalJs(`(()=>{
    const o = ${json};
    const form = document.querySelector('.setup');
    const set = (sel, val) => { const e = form.querySelector(sel); if (!e) return; e.checked = !!val; };
    if (o.players) {
      const box = form.querySelector('.seg[data-name="players"]');
      [...box.children].forEach(b => b.classList.toggle('on', b.dataset.value === String(o.players)));
    }
    if (o.humans) o.humans.forEach((v, i) => set('.seats .seat-pick[data-i="' + i + '"] input', v));
    if (o.names) o.names.forEach((v, i) => { const e = form.querySelector('[name="pname_' + i + '"]'); if (e) e.value = v; });
    form.querySelector('[name="seed"]').value = String(o.seed ?? '');
    if (o.switches) for (const [k, v] of Object.entries(o.switches)) set('[name="sw_' + k + '"]', v);
    form.querySelector('.setup-actions .btn.primary').click();
    return true;
  })()`);
}

/**
 * 写一份「自动存档」。
 * 控制条原来那个「💾 存档」按钮已合并进「📂 存档」→ 存档箱，
 * 等价动作 = 开箱 → 点第 0 行（自动存档）的「存」→ 关箱。
 */
async function saveAuto(p) {
  await p.evalJs(`document.querySelector('#btnLoad').click()`);
  await p.waitFor(`!!document.querySelector('#svList')`, { label: "存档箱面板" });
  await p.evalJs(`[...document.querySelectorAll('#svList .sv-row')][0]
    .querySelectorAll('.sv-btns .btn')[0].click()`);
  await sleep(150);
  await p.evalJs(`document.querySelector('.savebox .dlg-actions .btn').click()`);
  await sleep(150);
}

// ------------------------------------------------------------------
// 场景
// ------------------------------------------------------------------
const results = [];
function record(name, ok, note) { results.push({ name, ok, note }); console.log(`  ${ok ? "✅" : "❌"} ${name}${note ? " — " + note : ""}`); }

/** 通用视觉度量（在局中调用）。 */
async function visualStats(p) {
  return p.evalJs(`(()=>{
    const q = (s) => document.querySelector(s);
    const b = q('.board');
    const br = b.getBoundingClientRect();
    const imgOk = (i) => i && i.complete && i.naturalWidth > 0;
    const cs = [];
    for (let i = 0; i < 40; i++) {
      const r = q('.cell[data-cell="' + i + '"]').getBoundingClientRect();
      cs.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width });
    }
    let brokenRing = [];
    for (let i = 0; i < 40; i++) {
      const a = cs[i], c = cs[(i + 1) % 40];
      const dx = Math.abs(a.x - c.x), dy = Math.abs(a.y - c.y);
      const adj = (dx < a.w * 0.25 && dy > a.w * 0.6 && dy < a.w * 1.6)
               || (dy < a.w * 0.25 && dx > a.w * 0.6 && dx < a.w * 1.6);
      if (!adj) brokenRing.push(i + '->' + ((i + 1) % 40));
    }
    const bx = br.left + br.width / 2, by = br.top + br.height / 2;
    const quad = (i) => (cs[i].x > bx ? 'R' : 'L') + (cs[i].y > by ? 'B' : 'T');
    const overflow = (el) => el ? el.scrollWidth - el.clientWidth : 0;
    return {
      cells: document.querySelectorAll('.cell').length,
      cellArtsLoaded: [...document.querySelectorAll('.cell-art')].filter(imgOk).length,
      centerArt: !!q('.center-art') && imgOk(q('.center-art')),
      pilesLoaded: [...document.querySelectorAll('.pile img')].filter(imgOk).length,
      fontNm: getComputedStyle(q('.cell-label .nm')).fontSize,
      nmClipped: (() => {
        // 行数截断要真正量：克隆一份解除 clamp，看它需要多高。
        // 必须挂回同一父级 —— cqw 要按棋盘容器换算，挂到 body 会退化成视口单位。
        const need = (e) => {
          const c = e.cloneNode(true);
          c.style.webkitLineClamp = "unset";
          c.style.overflow = "visible";
          c.style.position = "absolute";
          c.style.width = e.clientWidth + "px";
          c.style.visibility = "hidden";
          e.parentElement.appendChild(c);
          const h = c.scrollHeight;
          c.remove();
          return h;
        };
        return [...document.querySelectorAll('.cell-label .nm')]
          .map(e => ({ t: e.textContent, need: need(e), have: e.clientHeight }))
          .filter(x => x.need > x.have + 1);
      })(),
      nmWorst: (() => {
        const need = (e) => {
          const c = e.cloneNode(true);
          c.style.webkitLineClamp = "unset";
          c.style.overflow = "visible";
          c.style.position = "absolute";
          c.style.width = e.clientWidth + "px";
          c.style.visibility = "hidden";
          e.parentElement.appendChild(c);
          const h = c.scrollHeight;
          c.remove();
          return h;
        };
        const a = [...document.querySelectorAll('.cell-label .nm')]
          .map(e => ({ t: e.textContent, need: need(e), have: e.clientHeight }))
          .sort((x, y) => (y.need - y.have) - (x.need - x.have))[0];
        return a ? (a.t + " 需 " + a.need + " / 有 " + a.have) : "";
      })(),
      cellW: Math.round(cs[0].w),
      stripClipped: [...document.querySelectorAll('.cell-strip')]
        .filter(e => e.scrollWidth > e.clientWidth + 1).length,
      sideOverflow: Math.max(overflow(q('#playersPanel')), overflow(q('#marketPanel')), overflow(q('#log'))),
      marketRows: document.querySelectorAll('.mk-row').length,
      owners: document.querySelectorAll('.owner-chip').length,
      pawns: document.querySelectorAll('.pawn').length,
      logLines: q('#log').children.length,
      seasonChips: document.querySelectorAll('.s-chip').length,
      seasonOn: document.querySelectorAll('.s-chip.on').length,
      gridCols: getComputedStyle(b).gridTemplateColumns.split(' ').length,
      quad0: quad(0), quad10: quad(10), quad20: quad(20), quad30: quad(30),
      brokenRing: brokenRing.length,
      brokenRingAt: brokenRing.slice(0, 6).join(','),
      hOverflow: document.documentElement.scrollWidth - window.innerWidth,
      hasNullText: /(^|[\\s>])null([\\s<]|$)/.test(q('#status').innerText),
      status: q('#status').innerText.replace(/\\s+/g, ' '),
    };
  })()`);
}

function assertVisual(tag, s) {
  const bad = [];
  if (s.cells !== 40) bad.push(`格子 ${s.cells}/40`);
  if (s.cellArtsLoaded !== 40) bad.push(`格子图 ${s.cellArtsLoaded}/40`);
  if (!s.centerArt) bad.push("中心插画未加载");
  if (s.pilesLoaded !== 4) bad.push(`卡摞图 ${s.pilesLoaded}/4`);
  if (s.nmClipped.length)
    bad.push(`${s.nmClipped.length} 个格名被截断（如 ${s.nmClipped.slice(0, 3).map((x) => `${x.t} ${x.need}>${x.have}`).join("、")}）`);
  if (s.stripClipped) bad.push(`${s.stripClipped} 条分区色条溢出`);
  if (parseFloat(s.fontNm) < 6) bad.push(`格名字号仅 ${s.fontNm}`);
  if (s.sideOverflow > 2) bad.push(`侧栏横向溢出 ${s.sideOverflow}px`);
  if (s.marketRows !== 28) bad.push(`行情行 ${s.marketRows}/28`);
  if (s.gridCols !== 11) bad.push(`棋盘列数 ${s.gridCols}`);
  if (s.brokenRing) bad.push(`棋盘不成环 ${s.brokenRing} 处（${s.brokenRingAt}）`);
  const want = { quad0: "RB", quad10: "LB", quad20: "LT", quad30: "RT" };
  for (const [k, w] of Object.entries(want)) if (s[k] !== w) bad.push(`${k}=${s[k]}≠${w}`);
  if (s.hOverflow > 2) bad.push(`页面横向溢出 ${s.hOverflow}px`);
  if (s.hasNullText) bad.push("状态栏出现裸 null");
  record(`视觉/几何度量（${tag}）`, bad.length === 0, bad.join("；") || `棋盘 40 格 · 行情 28 行 · ${s.status}`);
  return bad;
}

// ---- A 整局收官 ----
async function scenarioA(cdp) {
  console.log("\n[A] 整局收官（4 人 · 1 真人 + 3 电脑 · 种子 11 · 全速）");
  const p = await openPage(cdp);
  try {
    await startGame(p, { players: 4, humans: [true, false, false, false], seed: 11 });
    await setSpeed(p, "0");
    await p.shot("A-1-start");

    let done = false;
    for (let i = 0; i < 4000 && !done; i++) {
      done = await p.evalJs(`(()=>{const b=document.querySelector('.dlg-h b');
        return !!b && /获胜/.test(b.textContent);})()`);
      if (done) break;
      await advance(p);
      await sleep(i < 200 ? 45 : 25);
    }
    await p.shot("A-2-finish");
    if (!done) { record("A 整局收官", false, "未在预期步数内分出胜负"); return; }

    const info = await p.evalJs(`(()=>{
      const rows = [...document.querySelectorAll('.overlay .tbl tbody tr')];
      return {
        title: document.querySelector('.dlg-h b').textContent,
        sub: document.querySelector('.dlg-h p').textContent,
        rows: rows.length,
        cols: rows[0] ? rows[0].children.length : 0,
        tail: document.querySelector('.dlg-body .muted').textContent.replace(/\\s+/g,' '),
      };
    })()`);
    const ok = info.rows === 4 && info.cols === 7 && /轮/.test(info.tail);
    record("A 整局收官", ok, `${info.title} · ${info.tail}`);
  } catch (e) {
    record("A 整局收官", false, e.message);
  } finally {
    if (p.problems.length) record("A 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- B 标准 2 人局 + 视觉度量 ----
async function scenarioB(cdp) {
  console.log("\n[B] 标准 2 人局（1 真人 + 1 电脑 · 种子 5 · 全速 · 视觉度量）");
  const p = await openPage(cdp);
  try {
    await startGame(p, { players: 2, humans: [true, false], seed: 5 });
    await setSpeed(p, "0");
    for (let i = 0; i < 220 && (await roundNo(p)) < 3; i++) { await advance(p); await sleep(40); }
    await p.shot("B-1-two-players");

    const st = await p.evalJs(`(()=>({
      pawns: document.querySelectorAll('.pawn').length,
      pcards: document.querySelectorAll('#playersPanel .pcard').length,
    }))()`);
    const s = await visualStats(p);
    const bad = assertVisual("标准 2 人", s);
    if (st.pawns !== 2) bad.push(`棋子数 ${st.pawns} ≠ 2`);
    if (st.pcards !== 2) bad.push(`玩家卡 ${st.pcards} ≠ 2`);
    record("B 标准 2 人局（视觉度量）", bad.length === 0, bad.join("；") || `2 枚棋子 · 2 张玩家卡`);
  } catch (e) {
    record("B 标准 2 人局", false, e.message);
  } finally {
    if (p.problems.length) record("B 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- C 暂停 / 恢复 ----
async function scenarioC(cdp) {
  console.log("\n[C] 暂停 / 恢复（2 人 · 种子 3 · 慢速）");
  const p = await openPage(cdp);
  try {
    await startGame(p, { players: 2, humans: [true, false], seed: 3 });
    await setSpeed(p, "1100");
    await setWalkAuto(p);          // 本场景看暂停，走格交给自动
    await sleep(600);

    // 暂停
    await p.evalJs(`document.querySelector('#btnPause').click()`);
    const pausedLabel = await p.evalJs(`document.querySelector('#btnPause').textContent`);
    const pausedTag = await p.evalJs(`!!document.querySelector('#status .paused')`);
    await p.shot("C-1-paused");

    // 让暂停前可能已在跑的电脑回合收尾，再从稳定点起算
    await sleep(1600);
    const r0 = await roundNo(p);
    // 窗口内一直帮真人掷骰/走格：电脑回合必须被冻结 → 轮次不能推进
    let advancedWhilePaused = false;
    for (let i = 0; i < 200; i++) {
      if ((await roundNo(p)) > r0) { advancedWhilePaused = true; break; }
      await advance(p); await sleep(35);
    }

    // 恢复
    await p.evalJs(`document.querySelector('#btnPause').click()`);
    await sleep(300);
    const resumedLabel = await p.evalJs(`document.querySelector('#btnPause').textContent`);
    const r1 = await roundNo(p);
    let ran = false;
    for (let i = 0; i < 1200; i++) { await advance(p); if ((await roundNo(p)) > r1) { ran = true; break; } await sleep(35); }

    const bad = [];
    if (!/继续/.test(pausedLabel)) bad.push(`暂停后按钮文案「${pausedLabel}」`);
    if (!pausedTag) bad.push("状态栏未显示「已暂停」");
    if (advancedWhilePaused) bad.push("暂停期间回合仍在推进（未冻结）");
    if (!/暂停/.test(resumedLabel)) bad.push(`恢复后按钮文案「${resumedLabel}」`);
    if (!ran) bad.push("恢复后未继续推进");
    record("C 暂停 / 恢复", bad.length === 0, bad.join("；") || `暂停冻结于第 ${r0} 轮 · 恢复到第 ${r1} 轮并继续`);
  } catch (e) {
    record("C 暂停 / 恢复", false, e.message);
  } finally {
    if (p.problems.length) record("C 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- D 存档 → 读档 ----
async function scenarioD(cdp) {
  console.log("\n[D] 存档 → 读档（3 人 · 种子 21 · 全速）");
  const p = await openPage(cdp);
  try {
    await p.evalJs(`localStorage.removeItem('jym.save.auto')`);
    await startGame(p, { players: 3, humans: [true, false, false], seed: 21 });
    await setSpeed(p, "0");
    for (let i = 0; i < 1200 && (await roundNo(p)) < 4; i++) { await advance(p); await sleep(30); }

    await saveAuto(p);
    const save = await p.evalJs(`(()=>{const s=JSON.parse(localStorage.getItem('jym.save.auto')||'null');
      return s ? {v:s.v, round:s.round, rec:(s.recorded||[]).length, seed:s.cfg.seed, players:s.cfg.players} : null;})()`);
    if (!save) { record("D 存档 → 读档", false, "点存档后 localStorage 无快照"); return; }

    // 新局 → 弹出设置 → 点「继续上局」
    await p.evalJs(`document.querySelector('#btnNew').click()`);
    await p.waitFor(`!!document.querySelector('.setup')`, { label: "新局设置弹层" });
    const hasResume = await p.evalJs(`[...document.querySelectorAll('.setup-actions .btn')]
      .some(b => /继续上局/.test(b.textContent))`);
    await p.evalJs(`[...document.querySelectorAll('.setup-actions .btn')]
      .find(b => /继续上局/.test(b.textContent)).click()`);

    // 恢复提示一出现就立刻冻结，避免「读到的是恢复后又跑了一轮」的竞态
    await p.waitFor(
      `[...document.querySelectorAll('.toast')].some(t => /已恢复/.test(t.textContent))`,
      { timeout: 25000, interval: 50, label: `恢复到第 ${save.round} 轮` });
    await p.evalJs(`document.querySelector('#btnPause').click()`);
    await sleep(250);
    const rAfter = await roundNo(p);
    const pausedOK = await p.evalJs(`/继续/.test(document.querySelector('#btnPause').textContent)`);

    await p.evalJs(`document.querySelector('#btnPause').click()`);   // 解冻
    let grew = false;
    for (let i = 0; i < 900; i++) { await advance(p); if ((await roundNo(p)) > rAfter) { grew = true; break; } await sleep(30); }
    await p.shot("D-1-resumed");

    const bad = [];
    if (!hasResume) bad.push("设置弹层缺「继续上局」按钮");
    // 恢复的语义 = 回到「存档轮末」，引擎随即从下一轮继续 → 轮次应为 R 或 R+1
    if (rAfter < save.round || rAfter > save.round + 1) bad.push(`恢复轮次 ${rAfter} 不在 ${save.round}~${save.round + 1}`);
    if (!pausedOK) bad.push("恢复后未能暂停冻结");
    if (!grew) bad.push("恢复后未继续推进");
    record("D 存档 → 读档", bad.length === 0,
      bad.join("；") || `存档第 ${save.round} 轮（人工决策 ${save.rec} 条）→ 恢复到第 ${rAfter} 轮并继续`);
  } catch (e) {
    record("D 存档 → 读档", false, e.message);
  } finally {
    if (p.problems.length) record("D 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- E 棋盘朝向 ----
async function scenarioE(cdp) {
  console.log("\n[E] 棋盘朝向切换（正向 ↔ 纸样）");
  const p = await openPage(cdp);
  try {
    await startGame(p, { players: 2, humans: [true, false], seed: 9 });
    await setSpeed(p, "0");
    for (let i = 0; i < 120 && (await roundNo(p)) < 2; i++) { await advance(p); await sleep(30); }

    const before = await p.evalJs(`(()=>({orient:document.querySelector('.board').dataset.orient,
      tf:getComputedStyle(document.querySelector('.cell[data-cell="20"] .cellin')).transform}))()`);
    await p.evalJs(`document.querySelector('#btnOrient').click()`);
    await sleep(250);
    const after = await p.evalJs(`(()=>({orient:document.querySelector('.board').dataset.orient,
      tf:getComputedStyle(document.querySelector('.cell[data-cell="20"] .cellin')).transform,
      label:document.querySelector('#btnOrient').textContent}))()`);
    const s = await visualStats(p);
    await p.shot("E-1-paper");
    const bad = assertVisual("纸样朝向", s);
    if (before.orient !== "flat") bad.push(`初始朝向 ${before.orient}`);
    if (after.orient !== "paper") bad.push(`切纸样后 data-orient=${after.orient}`);
    if (!/matrix\(-1/.test(after.tf)) bad.push(`第 20 格未旋转 180°（${after.tf}）`);
    if (!/纸样/.test(after.label)) bad.push(`按钮文案「${after.label}」`);
    record("E 棋盘朝向", bad.length === 0, bad.join("；") || `正向 → 纸样（第 20 格 transform=${after.tf}）`);
  } catch (e) {
    record("E 棋盘朝向", false, e.message);
  } finally {
    if (p.problems.length) record("E 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- F 5 条加料开关全关 ----
async function scenarioF(cdp) {
  console.log("\n[F] 5 条加料开关全关（季节/胡同规则不应生效）");
  const p = await openPage(cdp);
  try {
    await startGame(p, {
      players: 3, humans: [true, false, false], seed: 33,
      switches: { seasonOn: false, hutong: false, hutongDraw: false, monopoly: false, skillFree: false },
    });
    await setSpeed(p, "0");
    for (let i = 0; i < 1600 && (await roundNo(p)) < 8; i++) { await advance(p); await sleep(28); }

    const log = await p.evalJs(`document.querySelector('#log').innerText`);
    const seasonOn = await p.evalJs(`document.querySelectorAll('.s-chip.on').length`);
    const bad = [];
    if (/换季|过起点，抽季节卡/.test(log)) bad.push("季节机制未关闭");
    if (/【胡同通】|【胡同寻宝】/.test(log)) bad.push("胡同机制未关闭");
    if (seasonOn !== 0) bad.push(`季节盘仍有 ${seasonOn} 个高亮`);
    record("F 加料开关全关", bad.length === 0,
      bad.join("；") || `跑到第 ${await roundNo(p)} 轮：无换季、无胡同加成`);
  } catch (e) {
    record("F 加料开关全关", false, e.message);
  } finally {
    if (p.problems.length) record("F 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- G 儿童化交互（掷骰跳动 / 手动逐格跳 / 落格脉冲 / 区域工具） ----
async function scenarioG(cdp) {
  console.log("\n[G] 儿童化交互（2 人 · 种子 42 · 慢速 · 手动走格）");
  const p = await openPage(cdp);
  try {
    await startGame(p, { players: 2, humans: [true, false], seed: 42 });
    await sleep(250);
    // 真人回合会停在「等骰」，此时棋盘中心的骰盘亮起
    await p.waitFor(`!!document.querySelector('#diceTray.armed')`,
      { timeout: 8000, interval: 60, label: "骰盘可点" });

    // —— 静态结构：6 区域工具 / 中心新版式 / emoji 棋子 ——
    const st = await p.evalJs(`(()=>{
      const q = (s) => document.querySelector(s);
      const imgOk = (i) => !!(i && i.complete && i.naturalWidth > 0);
      const tools = {};
      for (const id of ['topbar','controls','seasonPanel','playersPanel','marketPanel','logPanel']) {
        const el = document.getElementById(id);
        tools[id] = !!(el && el.querySelector(':scope > .panel-tools'));
      }
      const emoji = ['🀄','🏮','🍡','🪁'];
      const pawns = [...document.querySelectorAll('.pawn')];
      // 棋子优先是 <img class="pawn"> 立绘（src 指向 assets/pawns/）；素材缺失才回退字符棋子
      const pawnOk = pawns.length > 0 && pawns.every((x) =>
        x.tagName === 'IMG'
          ? /assets\\/pawns\\//.test(x.getAttribute('src') || '')
          : emoji.includes(x.textContent.trim()));
      return {
        tools,
        ctMain: (q('.center-head .ct-main') || {}).textContent || '',
        ctSub: (q('.center-head .ct-sub') || {}).textContent || '',
        appVer: (q('#appVer') || {}).textContent || '',
        centerTurn: !!q('#centerTurn'),
        centerArtOk: imgOk(q('.center-art')),
        tray: !!q('#diceTray'),
        piles: document.querySelectorAll('.pile').length,
        pilesHidden: [...document.querySelectorAll('.pile')].every((e) => getComputedStyle(e).opacity === '0'),
        pawns: pawns.length,
        pawnSeat: pawns.length > 0 && pawns.every((x) => !!x.dataset.seat),
        pawnOk,
      };
    })()`);

    const bad = [];
    for (const [id, ok] of Object.entries(st.tools)) if (!ok) bad.push(`#${id} 缺区域工具`);
    if (st.ctMain !== "京韵大富翁") bad.push(`中心主标题「${st.ctMain}」`);
    if (st.ctSub !== "胡同漫游记") bad.push(`中心副标题「${st.ctSub}」`);
    if (!/^v\d+\.\d+\.\d+$/.test(st.appVer)) bad.push(`顶栏版本号缺失 / 异常「${st.appVer}」`);
    if (!st.centerTurn) bad.push("中心缺 #centerTurn");
    if (!st.centerArtOk) bad.push("中心插画未加载");
    if (!st.tray) bad.push("中心缺常驻骰盘 #diceTray");
    if (!st.pawnSeat || !st.pawnOk) bad.push(`棋子立绘 / 座位标记异常（${st.pawns} 枚）`);

    // —— 区域工具：收起 / 展开 / 全屏 / 还原 ——
    const fx = await p.evalJs(`(async()=>{
      const el = document.querySelector('#logPanel');
      const t = el.querySelector(':scope > .panel-tools');
      const col = t.children[0], fsb = t.children[1];
      const wait = () => new Promise((r)=>setTimeout(r,70));
      col.click(); await wait(); const collapsed = el.classList.contains('collapsed');
      col.click(); await wait(); const reOpened = !el.classList.contains('collapsed');
      fsb.click(); await wait();
      const fsOn = el.classList.contains('region-fs') && getComputedStyle(el).position === 'fixed';
      fsb.click(); await wait(); const fsOff = !el.classList.contains('region-fs');
      return { collapsed, reOpened, fsOn, fsOff };
    })()`);
    if (!fx.collapsed) bad.push("日志面板未能收起");
    if (!fx.reOpened) bad.push("日志面板未能展开");
    if (!fx.fsOn) bad.push("日志面板未能全屏（position 非 fixed）");
    if (!fx.fsOff) bad.push("日志面板全屏未能还原");

    // —— 棋盘全屏：只挂一个「全屏」按钮（没有收起），点了铺满窗口、棋盘等比放大 ——
    const bfx = await p.evalJs(`(async()=>{
      const el = document.querySelector('#boardwrap');
      const t = el.querySelector(':scope > .panel-tools');
      const btns = t ? t.children.length : 0;
      const fsb = t ? t.children[0] : null;
      if (!fsb) return { btns, fsOn:false, fsOff:false, grew:false, restored:false };
      const wait = () => new Promise((r)=>setTimeout(r,160));
      const bw = () => document.querySelector('#board').getBoundingClientRect().width;
      const before = bw();
      fsb.click(); await wait();
      const fsOn = el.classList.contains('region-fs') && getComputedStyle(el).position === 'fixed';
      const after = bw();
      fsb.click(); await wait(); const fsOff = !el.classList.contains('region-fs');
      const back = bw();
      return { btns, fsOn, fsOff, grew: after > before + 1, restored: Math.abs(back - before) <= 2 };
    })()`);
    if (bfx.btns !== 1) bad.push(`棋盘区域工具应只有 1 个（全屏），实为 ${bfx.btns}`);
    if (!bfx.fsOn) bad.push("棋盘未能全屏（position 非 fixed）");
    if (!bfx.fsOff) bad.push("棋盘全屏未能还原");
    if (!bfx.grew) bad.push("棋盘全屏后没有放大");
    if (!bfx.restored) bad.push("棋盘全屏还原后尺寸没回到原值");

    // —— 动画采样：骰盘翻滚 / 玩偶位移 / 落格脉冲 / 定格点数 ——
    await p.evalJs(`(()=>{
      const st = window.__jymG = { dice:0, walker:0, walkerMoved:false, hop:0, a:"", b:"", sum:"", timer:0 };
      const q = (s) => document.querySelector(s);
      let first = null;
      st.timer = setInterval(()=>{
        const t = q('#diceTray'); if (t && t.classList.contains('rolling')) st.dice++;
        if (q('.cell.hop') || q('.cell.landed')) st.hop++;
        const s = q('#diceSum');
        if (s && s.textContent.trim()) {
          const m = s.textContent.trim().match(/^(\\d+)\\s*\\+\\s*(\\d+)\\s*=\\s*(\\d+)$/);
          const m2 = s.textContent.trim().match(/^(\\d+)\\s*点$/);
          if (m) { st.a = m[1]; st.b = m[2]; st.sum = m[3]; }
          else if (m2) { st.a = m2[1]; st.b = ""; st.sum = m2[1]; }
        }
        const w = q('.board > .walker');
        if (w && !w.hidden) {
          st.walker++;
          const x = Math.round(parseFloat(w.style.left) || 0), y = Math.round(parseFloat(w.style.top) || 0);
          if (!first) first = [x, y];
          else if (x !== first[0] || y !== first[1]) st.walkerMoved = true;
        }
      }, 22);
      return true;
    })()`);

    await setSpeed(p, "1100");
    await p.evalJs(`document.querySelector('#diceTray').click()`);
    // 骰子出手后立刻失去「可点」态
    await p.waitFor(`!document.querySelector('#diceTray').classList.contains('armed')`,
      { timeout: 6000, interval: 40, label: "骰盘失去可点态" });

    // 手动走格：逐格点棋子推进，直到整段动画收干净
    const settled = `(()=>{const w=document.querySelector('.board > .walker');
      const t=document.querySelector('#diceTray');
      return !!(window.__jymG && window.__jymG.dice > 0 && w && w.hidden && t && !t.classList.contains('rolling'));})()`;
    let done = false, steps = 0;
    for (let i = 0; i < 900 && !done; i++) {
      const act = await advance(p);
      if (act === "step") steps++;
      done = !!(await p.evalJs(settled).catch(() => false));
      if (!done) await sleep(40);
    }
    if (!done) {
      const dump = await p.evalJs(`(()=>({
        dice:window.__jymG && window.__jymG.dice,
        rolling:(document.querySelector('#diceTray')||{}).className,
        walkHidden:(document.querySelector('.board > .walker')||{}).hidden,
        status:document.querySelector('#status').innerText.replace(/\\s+/g,' '),
        overlay:(()=>{const o=document.querySelector('.overlay'); return o&&!o.hidden?o.innerText.slice(0,120):'(无)';})(),
      }))()`);
      throw new Error("动画未收敛：" + JSON.stringify(dump));
    }

    const anim = await p.evalJs(`(()=>{ const s = window.__jymG; clearInterval(s.timer);
      const w = document.querySelector('.board > .walker');
      const t = document.querySelector('#diceTray');
      return { dice:s.dice, walker:s.walker, walkerMoved:s.walkerMoved, hop:s.hop,
        a:s.a, b:s.b, sum:s.sum,
        walkerHidden: !w || w.hidden, rolling: !!(t && t.classList.contains('rolling')),
        diePips: document.querySelectorAll('#dieA > i').length };
    })()`);

    if (anim.dice < 1) bad.push("未捕捉到掷骰动画");
    if (anim.walker < 1) bad.push("未捕捉到跳格玩偶");
    if (!anim.walkerMoved) bad.push("玩偶未发生位移");
    if (anim.hop < 1) bad.push("未捕捉到落格脉冲");
    if (anim.diePips !== 9) bad.push(`骰面灯位 ${anim.diePips}/9`);
    const a = Number(anim.a), b = anim.b === "" ? null : Number(anim.b), n = Number(anim.sum);
    if (!n) bad.push("骰子未定格出点数");
    else if (a + (b || 0) !== n) bad.push(`骰面 ${a}+${b} ≠ 步数 ${n}`);
    if (!anim.walkerHidden) bad.push("动画结束后玩偶未收干净");
    if (anim.rolling) bad.push("动画结束后骰盘仍在滚动态");
    if (steps < 1) bad.push("手动走格未逐格推进（未点到棋子）");

    record("G 儿童化交互", bad.length === 0, bad.join("；")
      || `骰面 ${anim.a}${anim.b !== "" ? "+" + anim.b : ""}=${anim.sum} · 手动走格 ${steps} 步 · 落格脉冲 ${anim.hop} 次 · 6 区域工具可用`);
  } catch (e) {
    record("G 儿童化交互", false, e.message);
  } finally {
    if (p.problems.length) record("G 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- H 触屏仿真 + 权限控制 ----
async function scenarioH(cdp) {
  console.log("\n[H] 触屏仿真与权限控制（2 人 · 种子 7 · 慢速）");
  const p = await openPage(cdp);
  try {
    await startGame(p, { players: 2, humans: [true, false], seed: 7 });
    await sleep(300);
    const bad = [];

    // ---- 1) 骰盘：只有轮到真人、且未掷时才 armed；其余时刻不可点 ----
    await p.waitFor(`!!document.querySelector('#diceTray.armed')`,
      { timeout: 8000, interval: 60, label: "真人回合骰盘可点" });
    const armedBefore = await p.evalJs(`document.querySelector('#diceTray').getAttribute('aria-disabled')`);

    // ---- 2) 卡摞：非命中时全部隐藏且不可点（权限：平时隐藏） ----
    const idle = await p.evalJs(`(()=>({
      piles: document.querySelectorAll('.pile').length,
      armed: document.querySelectorAll('.pile.armed').length,
      live: document.querySelectorAll('.pile.live').length,
      hitArea: [...document.querySelectorAll('.pile')].every((e) => getComputedStyle(e).pointerEvents === 'none'),
    }))()`);

    // ---- 3) 点骰子 → 立即失去 armed，随即进入掷骰动画 ----
    await setSpeed(p, "1100");
    await p.evalJs(`document.querySelector('#diceTray').click()`);
    await p.waitFor(`!document.querySelector('#diceTray').classList.contains('armed')`,
      { timeout: 5000, interval: 30, label: "掷骰后骰盘失去可点态" });
    const armedAfter = await p.evalJs(`document.querySelector('#diceTray').getAttribute('aria-disabled')`);

    // ---- 4) 手动走格：出现可点棋子与「下一格」热区；点它推进一格 ----
    await p.waitFor(`!!document.querySelector('.walker.armed') || !!(document.querySelector('.board > .walker')||{}).hidden === false`,
      { timeout: 8000, interval: 40, label: "跳格玩偶出现（手动走格就绪）" });
    const walkOn = await p.evalJs(`(()=>({
      walkerVisible: !document.querySelector('.board > .walker').hidden,
      walkerArmed: !!document.querySelector('.walker.armed'),
      tapCells: document.querySelectorAll('.cell.tap').length,
    }))()`);
    // 点棋子推进一格（手动模式必须逐格）
    const stepMoved = await p.evalJs(`(async()=>{
      const w = document.querySelector('.board > .walker');
      const before = Math.round(parseFloat(w.style.left)||0) + ',' + Math.round(parseFloat(w.style.top)||0);
      const t0 = Date.now();
      for (;;) {
        const el = document.querySelector('.board > .walker');
        if (el && el.classList.contains('armed')) { el.click(); break; }
        if (Date.now() - t0 > 6000) return { ok:false, why:'棋子未 armed' };
        await new Promise((r)=>setTimeout(r,40));
      }
      const t1 = Date.now();
      for (;;) {
        const el = document.querySelector('.board > .walker');
        const now = Math.round(parseFloat(el.style.left)||0) + ',' + Math.round(parseFloat(el.style.top)||0);
        if (now !== before) return { ok:true, before, after: now };
        if (el.hidden) return { ok:false, why:'玩偶提前收起' };
        if (Date.now() - t1 > 6000) return { ok:false, why:'点棋子后未位移', before };
        await new Promise((r)=>setTimeout(r,40));
      }
    })()`);

    // ---- 5) 跑几轮：落点命中 → 对应卡摞才 armed 且可点翻开（权限：命中才现） ----
    const DECK_OF_TYPE = { "机会": "chance", "命运": "destiny", "寻宝": "treasure" };
    let flipped = 0, armedSeen = 0, matched = 0, mismatch = 0;
    for (let i = 0; i < 6000; i++) {
      const st = await p.evalJs(`(()=>{
        const armed = [...document.querySelectorAll('.pile.armed')].map((e) => e.dataset.deck);
        const live = [...document.querySelectorAll('.pile.live')].map((e) => e.dataset.deck);
        const cur = document.querySelector('.cell.active');
        let type = '';
        if (cur) { const m = cur.className.match(/t-(机会|命运|寻宝|地标|角)/); type = m ? m[1] : ''; }
        return { armed, live, type };
      })()`);
      if (st.armed.length) {
        armedSeen++;
        // 「命中才现」：真人落点若不是抽卡格，则只可能是过起点抽的季节卡
        const want = DECK_OF_TYPE[st.type];
        if (want && st.armed.includes(want)) matched++;
        else if (st.type === "" || st.type === "地标" || st.type === "角") {
          // 非抽卡格的 armed 只允许 season（过起点）
          if (st.armed.some((d) => d !== "season")) mismatch++;
        }
        const act = await advance(p);
        if (act === "card") flipped++;
      } else {
        await advance(p);
      }
      if (flipped >= 3 && (await roundNo(p)) >= 4) break;
      await sleep(26);
    }
    const rH = await roundNo(p);

    if (armedBefore !== "false") bad.push(`真人回合骰盘 aria-disabled=${armedBefore}（应 false）`);
    if (idle.piles !== 4) bad.push(`卡摞数 ${idle.piles}/4`);
    if (idle.armed !== 0 || idle.live !== 0) bad.push(`开局卡摞未隐藏（armed ${idle.armed} / live ${idle.live}）`);
    if (!idle.hitArea) bad.push("隐藏卡摞仍可点击（pointer-events 非 none）");
    if (armedAfter !== "true") bad.push(`掷骰后骰盘 aria-disabled=${armedAfter}（应 true）`);
    if (!walkOn.walkerArmed && !walkOn.tapCells) bad.push("手动走格未给出可点热区（棋子/下一格）");
    if (!stepMoved.ok) bad.push(`点棋子未逐格推进：${stepMoved.why || JSON.stringify(stepMoved)}`);
    if (flipped < 1) bad.push(`未点到卡摞翻牌（命中抽卡 ${armedSeen} 次）`);
    if (mismatch > 0) bad.push(`${mismatch} 次非命中格却亮起机会/命运/寻宝卡摞`);
    record("H 触屏仿真 + 权限控制", bad.length === 0, bad.join("；")
      || `骰盘态切换正常 · 卡摞平时隐藏 · 手动走格定格位移 ${stepMoved.before}→${stepMoved.after} · 落点命中亮卡 ${matched} 次 / 翻牌 ${flipped} 次 · 跑到第 ${rH} 轮`);
  } catch (e) {
    record("H 触屏仿真 + 权限控制", false, e.message);
  } finally {
    if (p.problems.length) record("H 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- I 连续仿真 ≥10 轮（触屏操作路径全程走通，不卡死） ----
async function scenarioI(cdp) {
  const TARGET_ROUNDS = 10;
  console.log(`\n[I] 连续仿真 ${TARGET_ROUNDS} 轮（2 人 · 种子 2026 · 中速 · 手动走格 + 点卡）`);
  const p = await openPage(cdp);
  try {
    await startGame(p, { players: 2, humans: [true, false], seed: 2026 });
    await setSpeed(p, "650");
    // 保持手动走格 + 手动翻卡：全程只用「点骰 / 点棋子 / 点卡 / 点弹层」推进
    const counts = { roll: 0, step: 0, card: 0, dlg: 0, wait: 0 };
    let stalled = 0, lastRound = 0, lastChange = Date.now();

    for (let i = 0; i < 30000; i++) {
      const act = await advance(p);
      if (act in counts) counts[act]++;
      else if (act.startsWith("dlg")) counts.dlg++;
      const r = await roundNo(p);
      if (r !== lastRound) { lastRound = r; lastChange = Date.now(); stalled = 0; }
      // 轮次计数在「轮首」自增，真人又是每轮先手：要「满 10 轮」就得等到第 10 次点骰发生
      if (r >= TARGET_ROUNDS && counts.roll >= TARGET_ROUNDS) break;
      // 卡死检测：连续 25s 轮次不动且没有任何可点元素
      if (Date.now() - lastChange > 25000 && act === "wait") {
        if (++stalled > 60) throw new Error(`卡死：第 ${r} 轮长时间无进展（last=${JSON.stringify(counts)}）`);
      }
      await sleep(20);
    }

    const r = await roundNo(p);
    const bad = [];
    if (r < TARGET_ROUNDS) bad.push(`仅跑到第 ${r} 轮 < ${TARGET_ROUNDS}`);
    if (counts.roll < TARGET_ROUNDS) bad.push(`点骰次数 ${counts.roll} < ${TARGET_ROUNDS}`);
    if (counts.step < TARGET_ROUNDS) bad.push(`手动走格次数 ${counts.step} 过少`);
    if (p.problems.length) bad.push("运行期有异常");
    await p.shot("I-1-after10rounds");
    record(`I 连续仿真 ≥${TARGET_ROUNDS} 轮`, bad.length === 0, bad.join("；")
      || `第 ${r} 轮：点骰 ${counts.roll} · 走格 ${counts.step} · 翻卡 ${counts.card} · 弹层 ${counts.dlg}`);
  } catch (e) {
    record(`I 连续仿真 ≥${TARGET_ROUNDS} 轮`, false, e.message);
  } finally {
    if (p.problems.length) record("I 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- J 手机竖屏 + 纯触摸操作（390×844 · touch 事件，不依赖鼠标） ----
async function scenarioJ(cdp) {
  console.log("\n[J] 手机竖屏触摸（390×844 · DPR3 · 全部用 touchStart/touchEnd）");
  const p = await openPage(cdp, { mobile: true });
  try {
    await startGame(p, { players: 2, humans: [true, false], seed: 33 });
    await setSpeed(p, "650");
    await p.waitFor(`!!document.querySelector('#diceTray.armed')`,
      { timeout: 8000, interval: 60, label: "真人回合骰盘可点（手机）" });

    // ---- 1) 触控目标尺寸 + 页面不横向溢出 ----
    const m = await p.evalJs(`(()=>{
      const box = (s) => { const e = document.querySelector(s); if (!e) return null;
        const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
      return {
        vw: window.innerWidth, vh: window.innerHeight,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        tray: box('#diceTray'),
        btnPause: box('#btnPause'), btnWalk: box('#btnWalk'),
        cell: box('.cell[data-cell="0"]'),
        board: box('#board'),
      };
    })()`);

    // ---- 2) 触摸掷骰：touch 手势必须能触发（不能只有 mouse click 管用） ----
    const counts = { roll: 0, step: 0, card: 0, dlg: 0 };
    await p.tap("#diceTray");
    await p.waitFor(`!document.querySelector('#diceTray').classList.contains('armed')`,
      { timeout: 5000, interval: 30, label: "触摸掷骰后骰盘失去可点态" });
    counts.roll++;

    // ---- 2b) 触摸走格：手指落点必须真的命中棋子（合成 click 会绕过命中测试，测不出遮挡） ----
    const probe = () => p.evalJs(`(()=>{
      const q = (s) => document.querySelector(s);
      const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
      const ov = q('.overlay'), w = q('.board > .walker');
      return {
        vp: [window.innerWidth, window.innerHeight, window.scrollX, window.scrollY],
        board: rect(q('#board')), wrap: rect(q('.boardwrap')),
        walker: rect(w), walkerStyle: w ? { p: w.style.left + ',' + w.style.top, z: w.style.zIndex } : null,
        overlay: !!ov && !ov.hidden ? ov.innerText.replace(/\\s+/g, ' ').slice(0, 70) : '',
        armed: !!q('.walker.armed'), taps: document.querySelectorAll('.cell.tap').length,
        tray: (q('#diceTray.armed') ? 'armed' : '') + (q('#diceTray.rolling') ? '+rolling' : ''),
        status: q('#status').innerText.replace(/\\s+/g, ' ').slice(0, 100),
      };
    })()`);
    // 掷骰后可能先弹出决策层（如 I-03 背包客改步数），要一边处理一边等走格就绪
    {
      const t0 = Date.now();
      for (;;) {
        const st = await p.evalJs(`(()=>{
          const ov = document.querySelector('.overlay');
          if (ov && !ov.hidden) {
            const bs = [...ov.querySelectorAll('.dlg-actions .btn, .dlg-body .btn')];
            if (!bs.length) return 'dlg-wait';
            window.__jymDlgBtn = bs.find((x) => /放弃|跳过|看看棋盘/.test(x.textContent)) || bs[bs.length - 1];
            return 'dlg';
          }
          return document.querySelector('.walker.armed') ? 'step' : 'wait';
        })()`);
        if (st === "step") break;
        if (st === "dlg") await p.tapBy("window.__jymDlgBtn");
        if (Date.now() - t0 > 15000) throw new Error(`手机端未进入走格态：${JSON.stringify(await probe())}`);
        await sleep(50);
      }
    }
    const stepHit = await p.evalJs(`(()=>{
      const w = document.querySelector('.board > .walker');
      const r = w.getBoundingClientRect();
      const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        at: e ? (e.tagName + '.' + (typeof e.className === 'string' ? e.className : '')) : 'null',
        w: Math.round(r.width), h: Math.round(r.height),
        z: getComputedStyle(w).zIndex, pe: getComputedStyle(w).pointerEvents,
        left: Math.round(parseFloat(w.style.left) || 0),
      };
    })()`);
    await p.tap(".walker.armed");
    const stepMoved = await p.evalJs(`(async()=>{
      const start = ${stepHit.left};
      const t0 = Date.now();
      for (;;) {
        const w = document.querySelector('.board > .walker');
        if (!w || w.hidden) return true;                                   // 走完了（最后一步）
        if (Math.round(parseFloat(w.style.left) || 0) !== start) return true;
        if (Date.now() - t0 > 2500) return false;
        await new Promise((r) => setTimeout(r, 30));
      }
    })()`);
    counts.step++;

    // ---- 3) 触摸走格 + 触摸翻卡：全程只派发 touch 事件 ----
    const touchAdvance = async () => {
      const kind = await p.evalJs(`(()=>{
        const ov = document.querySelector('.overlay');
        if (ov && !ov.hidden) {
          const bs = [...ov.querySelectorAll('.dlg-actions .btn, .dlg-body .btn')];
          if (!bs.length) return 'dlg-wait';
          window.__jymDlgBtn = bs.find((x) => /放弃|跳过|看看棋盘/.test(x.textContent)) || bs[bs.length - 1];
          return 'dlg';
        }
        if (document.querySelector('.pile.armed')) return 'card';
        if (document.querySelector('.walker.armed')) return 'step';
        if (document.querySelector('#diceTray.armed')) return 'roll';
        return 'wait';
      })()`);
      if (kind === "wait" || kind === "dlg-wait") return kind;
      if (kind === "dlg") await p.tapBy("window.__jymDlgBtn");
      else await p.tap({ roll: "#diceTray", step: ".walker.armed", card: ".pile.armed" }[kind]);
      counts[kind]++;
      return kind;
    };

    let flipped = 0;
    const trace = [];
    let lastRound = 0, lastChange = Date.now(), stalledN = 0;
    for (let i = 0; i < 2400; i++) {
      const k = await touchAdvance();
      if (k === "card") flipped++;
      if (trace.length < 48) trace.push(k);
      const rr = await roundNo(p);
      if (rr !== lastRound) { lastRound = rr; lastChange = Date.now(); stalledN = 0; }
      if (flipped >= 1 && rr >= 3) break;
      // 卡死检测：20s 里轮次不动、也没翻到牌、又一直有可点目标 → 说明触摸没生效
      if (Date.now() - lastChange > 20000 && k !== "wait" && k !== "dlg-wait") {
        if (++stalledN > 30) throw new Error(`触摸推进无效：20s 无进展（动作尾迹 ${trace.slice(-12).join(",")}）`
          + `\n      落点=${JSON.stringify(stepHit)}\n      走格=${stepMoved}\n      现场=${JSON.stringify(await probe())}`);
      }
      await sleep(24);
    }
    const r = await roundNo(p);
    const walkerOk = await p.evalJs(`(()=>{
      const w = document.querySelector('.board > .walker');
      if (!w) return false;
      return w.hidden || !!w.style.left;
    })()`);
    await p.shot("J-1-mobile");

    const bad = [];
    const MIN = 44, MIN_CELL = 30;   // 棋盘受 11×11 网格压缩，格子按「可达热区」放宽
    if (m.overflow > 2) bad.push(`手机竖屏横向溢出 ${m.overflow}px`);
    if (!m.tray || m.tray.w < MIN || m.tray.h < MIN) bad.push(`骰盘触控区 ${m.tray ? `${m.tray.w}×${m.tray.h}` : "缺失"} < ${MIN}`);
    for (const [k, v] of Object.entries({ btnPause: m.btnPause, btnWalk: m.btnWalk }))
      if (!v || v.h < MIN) bad.push(`${k} 触控高 ${v ? v.h : "缺失"} < ${MIN}`);
    if (!m.cell || m.cell.w < MIN_CELL) bad.push(`棋盘格 ${m.cell ? m.cell.w : "缺失"} < ${MIN_CELL}`);
    if (m.board && m.board.w > m.vw + 2) bad.push(`棋盘宽 ${m.board.w} > 视口 ${m.vw}`);
    if (counts.roll < 2) bad.push(`触摸掷骰仅 ${counts.roll} 次`);
    if (counts.step < 2) bad.push(`触摸走格仅 ${counts.step} 次`);
    if (!stepMoved) bad.push(`手指点在 ${stepHit.w}×${stepHit.h} 棋子上未推进（落点命中 ${stepHit.at} · z=${stepHit.z} · pointer-events=${stepHit.pe}）`);
    if (counts.card < 1) bad.push(`触摸未翻开任何卡（动作尾迹 ${trace.slice(-24).join(",")}）`);
    if (!walkerOk) bad.push("走格玩偶未落到棋盘坐标上");
    if (p.problems.length) bad.push("运行期有异常");
    record("J 手机竖屏触摸操作", bad.length === 0, bad.join("；")
      || `${m.vw}×${m.vh} 无溢出 · 骰盘 ${m.tray.w}×${m.tray.h} · 按钮高 ${m.btnPause.h} · 格 ${m.cell.w}px · 触摸掷骰 ${counts.roll} / 走格 ${counts.step} / 翻卡 ${counts.card} · 跑到第 ${r} 轮`);
  } catch (e) {
    record("J 手机竖屏触摸操作", false, e.message);
  } finally {
    if (p.problems.length) record("J 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- K 多真人混战（2 真人 + 2 电脑 · 自定义称呼 · 自动走格） ----
async function scenarioK(cdp) {
  console.log("\n[K] 多真人对战（2 真人 + 2 电脑 · 自定义称呼 · 种子 77）");
  const p = await openPage(cdp);
  try {
    const names = ["阿爸", "阿妈", "小电脑", "大电脑"];
    const bad = [];

    // 0) 开局设置：每席都有「称呼」输入 + 「真人手动 / 电脑自动」开关
    const ui = await p.evalJs(`(()=>{
      const rows = [...document.querySelectorAll('.setup .seat-row')];
      const pick = (i) => document.querySelector('.setup .seats .seat-pick[data-i="' + i + '"]');
      const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
      return {
        rows: rows.length,
        hasName: rows.every((r) => !!r.querySelector('input.name-in')),
        hasPick: rows.every((r) => !!r.querySelector('.seat-pick input[type=checkbox]')),
        seat2off: vis(pick(1) && pick(1).querySelector('.role-off')),
        seat2on: vis(pick(1) && pick(1).querySelector('.role-on')),
      };
    })()`);
    if (ui.rows !== 4) bad.push(`开局设置座位行 ${ui.rows}/4`);
    if (!ui.hasName) bad.push("座位缺「称呼」输入框");
    if (!ui.hasPick) bad.push("座位缺「真人/电脑」开关");
    if (!ui.seat2off || ui.seat2on) bad.push("未勾选的座位未显示「电脑 · 自动」");

    await startGame(p, { players: 4, humans: [true, true, false, false], names, seed: 77 });
    await setSpeed(p, "650");
    await setWalkAuto(p);

    // 1) 玩家卡上应出现自定义称呼（座位 0/1 = 真人，2/3 = 电脑，名字都该生效）
    await sleep(500);
    const cards = await p.evalJs(`[...document.querySelectorAll('#playersPanel .pcard')]
      .map(e => e.innerText.replace(/\\s+/g,' '))`);
    for (const n of names) if (!cards.some((c) => c.includes(n))) bad.push(`玩家卡未显示称呼「${n}」`);

    // 1b) 身份标签：2 位真人时不得都写「你」（旧 bug：两块区域都显示「你」）。
    //     口径：全场仅 1 位真人时叫「你」；多真人一律「真人」；电脑一律「电脑」。
    const tags = await p.evalJs(`[...document.querySelectorAll('#playersPanel .pcard .pc-head > .tag')]
      .filter(e => !e.classList.contains('dead-tag')).map(e => e.textContent.trim())`);
    const cnt = (v) => tags.filter((t) => t === v).length;
    if (cnt("你") !== 0) bad.push(`2 位真人却出现 ${cnt("你")} 个「你」标签：${tags.join("/")}`);
    if (cnt("真人") !== 2) bad.push(`真人标签 ${cnt("真人")}/2：${tags.join("/")}`);
    if (cnt("电脑") !== 2) bad.push(`电脑标签 ${cnt("电脑")}/2：${tags.join("/")}`);

    // 2) 采样回合气泡：两枚真人座位应出现「轮到你了（X）」，电脑座位应出现「X（电脑）自己走」
    const humanTurn = new Set(), aiTurn = new Set();
    for (let i = 0; i < 12000; i++) {
      const b = await p.evalJs(`(()=>{const e=document.querySelector('#turnBubble');
        return e && !e.hidden ? e.textContent : '';})()`);
      const mH = b.match(/轮到你了（(.+?)）/);
      if (mH) humanTurn.add(mH[1]);
      const mA = b.match(/^🤖 (.+?)（电脑）自己走/);
      if (mA) aiTurn.add(mA[1]);
      if (humanTurn.size >= 2 && aiTurn.size >= 1) break;
      await advance(p);
      await sleep(22);
    }
    await p.shot("K-1-multi-human");

    if (humanTurn.size < 2) bad.push(`只有 ${humanTurn.size} 个真人座位拿到控制权（应 ≥2）：${[...humanTurn].join("、") || "无"}`);
    for (const n of ["阿爸", "阿妈"])
      if (!humanTurn.has(n)) bad.push(`真人「${n}」未出现「轮到你了」`);
    if (aiTurn.size < 1) bad.push("电脑座位未出现自动掷骰（自动/手动未混搭成功）");
    for (const n of ["小电脑", "大电脑"])
      if (humanTurn.has(n)) bad.push(`电脑「${n}」被当成真人`);

    // 3) 真人座位数量可任意（2/3/4 个真人）—— 直接由开局座位的勾选数决定
    if (p.problems.length) bad.push("运行期有异常");
    record("K 多真人混战（2 真人 + 2 电脑）", bad.length === 0, bad.join("；")
      || `真人轮到 ${humanTurn.size} 席（${[...humanTurn].join("、")}）· 电脑自动 ${[...aiTurn].join("、")} · 4 张玩家卡称呼生效`);
  } catch (e) {
    record("K 多真人混战", false, e.message);
  } finally {
    if (p.problems.length) record("K 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- L 首次引导 + 图文设置 + 提示可点关 ----
async function scenarioL(cdp) {
  console.log("\n[L] 儿童引导 / 图文设置 / 提示点关（全新 profile · 种子 7）");
  const p = await openPage(cdp, { fresh: true });
  try {
    const bad = [];

    // 1) 首次打开：先出「图文规则引导」，五张图卡齐全，且还没进开局表单
    const ob = await p.evalJs(`(()=>{
      const ov = document.querySelector('.overlay');
      return {
        visible: !!ov && !ov.hidden,
        cells: document.querySelectorAll('.onboard .ob-cell').length,
        icons: document.querySelectorAll('.onboard .ob-ic').length,
        setupShown: !!document.querySelector('.setup'),
      };
    })()`);
    if (!ob.visible) bad.push("首次打开未出现引导弹层");
    if (ob.cells !== 5) bad.push(`引导图卡 ${ob.cells}/5`);
    if (ob.icons !== 5) bad.push(`引导图标 ${ob.icons}/5`);
    if (ob.setupShown) bad.push("引导弹出了但开局表单同时出现");
    await p.shot("L-1-onboard");

    // 2) 点「知道啦，开始游戏」→ 进开局设置；高级设置是图文卡而非抽象长句
    await p.evalJs(`document.querySelector('#btnOnboardStart').click()`);
    await p.waitFor(`!!document.querySelector('.setup')`, { label: "开局设置弹层" });
    const adv = await p.evalJs(`(()=>{
      const d = document.querySelector('details.adv'); if (d) d.open = true;
      const card = (n) => document.querySelectorAll('.seg.cards[data-name="' + n + '"] .card-opt');
      const mode = card('seasonMode'), scale = card('seasonScale');
      const cm = card('cardMode'), cms = card('cardMs');
      // 点第二张卡，确认选中态会跟着走
      mode[1].click();
      return {
        mode: mode.length, scale: scale.length, cm: cm.length, cms: cms.length,
        icons: document.querySelectorAll('.seg.cards .card-opt .co-ic').length,
        movedOn: mode[1].classList.contains('on') && !mode[0].classList.contains('on'),
        abstract: /房东全部地|其余\\+20%/.test(document.querySelector('details.adv').innerText),
      };
    })()`);
    if (adv.mode !== 3) bad.push(`换季规则图文卡 ${adv.mode}/3`);
    if (adv.scale !== 2) bad.push(`房租倍数图文卡 ${adv.scale}/2`);
    if (adv.cm !== 2) bad.push(`翻牌方式图文卡 ${adv.cm}/2`);
    if (adv.cms !== 4) bad.push(`翻牌时长图文卡 ${adv.cms}/4`);
    if (adv.icons !== 11) bad.push(`图文卡图标 ${adv.icons}/11`);
    if (!adv.movedOn) bad.push("点图文卡未切换选中态");
    if (adv.abstract) bad.push("高级设置仍残留抽象表述");
    await p.shot("L-2-adv-cards");

    // 2b) 触屏终端实际尺寸（1280×672）下的开局表单几何：
    //     内容高于视口时靠自身滚动，底部「开始对局」必须始终落在视口内可点，
    //     不能被 sticky 底栏或深容器居中裁掉（旧版「底部文字/窗体显示不全」的根因）。
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 672, deviceScaleFactor: 1, mobile: false }, p.S);
    await sleep(150);
    const sgeo = await p.evalJs(`(()=>{
      const ov = document.querySelector('.overlay');
      const sh = document.querySelector('#sheet');
      const r = sh.getBoundingClientRect();
      const btn = [...sh.querySelectorAll('.setup-actions .btn')].pop();
      const br = btn.getBoundingClientRect();
      return {
        vh: window.innerHeight,
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        clientH: sh.clientHeight, scrollH: sh.scrollHeight,
        btnTop: Math.round(br.top), btnBottom: Math.round(br.bottom),
        ovTop: Math.round(ov.getBoundingClientRect().top),
        ovBottom: Math.round(ov.getBoundingClientRect().bottom),
      };
    })()`);
    if (sgeo.ovTop !== 0 || Math.abs(sgeo.ovBottom - sgeo.vh) > 1)
      bad.push(`开局遮罩未铺满视口：${sgeo.ovTop}~${sgeo.ovBottom}/${sgeo.vh}`);
    if (sgeo.top < -1) bad.push(`开局表单顶部被裁 ${sgeo.top}px`);
    if (sgeo.bottom > sgeo.vh + 1) bad.push(`开局表单底部超出视口 ${sgeo.bottom - sgeo.vh}px（应自身滚动）`);
    if (sgeo.btnTop < 0 || sgeo.btnBottom > sgeo.vh + 1)
      bad.push(`开局主按钮不在视口内：${sgeo.btnTop}~${sgeo.btnBottom}/${sgeo.vh}`);
    await p.shot("L-3-setup-1280x672");
    // 还原默认视口，后续步骤沿用
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, p.S);
    await sleep(120);

    // 3) 开局：验收能正常起局
    await startGame(p, { players: 2, humans: [true, false], seed: 7 });
    await p.waitFor(`(()=>{const t=document.querySelector('#status').innerText;
      return /第\\s*1\\s*\\//.test(t);})()`, { label: "进入第 1 轮" });

    // 4) 季节面板文案已儿童化，不再出现「工作簿加成」这类术语
    const seasonTxt = await p.evalJs(`document.querySelector('#seasonPanel').innerText.replace(/\\s+/g,' ')`);
    if (!/只有抽到的那一片地变贵|那片的房东，别处的地也跟着贵|抽到的那片翻倍/.test(seasonTxt))
      bad.push(`季节面板文案未儿童化：${seasonTxt.slice(0, 80)}`);
    if (/工作簿加成/.test(seasonTxt)) bad.push("季节面板仍有术语「工作簿加成」");

    // 5) 系统提示：带 ✕ 关闭按钮，且点一下就能立刻消失（不再干等）
    //    现在唯一的控制条存档入口是「📂 存档」= 存档箱；还没走完整轮时会先弹提示。
    await p.evalJs(`document.querySelector('#btnLoad').click()`);
    await p.waitFor(`!!document.querySelector('.toast')`, { label: "轻提示出现" });
    const hasX = await p.evalJs(`!!document.querySelector('.toast .toast-x')`);
    if (!hasX) bad.push("提示没有关闭按钮 ✕");
    await p.evalJs(`document.querySelector('.toast').click()`);
    await sleep(600);
    const gone = await p.evalJs(`!document.querySelector('.toast')`);
    if (!gone) bad.push("点提示后未关闭");

    if (p.problems.length) bad.push("运行期有异常");
    record("L 儿童引导 / 图文设置 / 提示点关", bad.length === 0, bad.join("；")
      || `引导 5 图卡 · 换季 3 卡 / 倍数 2 卡 / 翻牌方式 2 卡 / 翻牌时长 4 卡 · 季节面板去术语 · 提示可点关`
        + ` · 开局表单 ${sgeo.scrollH}/${sgeo.clientH}@1280×672 主按钮 ${sgeo.btnTop}~${sgeo.btnBottom}`);
  } catch (e) {
    record("L 儿童引导 / 图文设置 / 提示点关", false, e.message);
  } finally {
    if (p.problems.length) record("L 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- M 弹层几何 + 玩法助手滚动（内容不裁切 · 可上下滑 · 刷新不打回顶部） ----
async function scenarioM(cdp) {
  console.log("\n[M] 弹层几何 / 玩法助手滚动（1280×520 矮视口）");
  const p = await openPage(cdp);
  try {
    // 故意压成矮视口：弹层内容必然高于视口 → 强制走「自身滚动」这条路径
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 520, deviceScaleFactor: 1, mobile: false }, p.S);

    await startGame(p, { players: 2, humans: [true, false], seed: 33 });
    await setSpeed(p, "300");
    await setWalkAuto(p);
    await p.waitFor(`!!document.querySelector('#diceTray.armed')`,
      { timeout: 8000, interval: 60, label: "真人回合骰盘可点" });

    // 顶栏「?」入口 → 打开玩法助手（控制条原来那个「怎么玩」已并入这一处）
    await p.evalJs(`document.querySelector('#btnCoach').click()`);
    await p.waitFor(`!!document.querySelector('.coach-ov .coach-sheet')`, { label: "玩法助手弹层" });
    await sleep(250);

    const geo = await p.evalJs(`(()=>{
      const ov = document.querySelector('.coach-ov');
      const sh = ov.querySelector('.coach-sheet');
      const r = sh.getBoundingClientRect();
      return {
        vh: window.innerHeight,
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        clientH: sh.clientHeight, scrollH: sh.scrollHeight,
        ovTop: Math.round(ov.getBoundingClientRect().top),
        ovBottom: Math.round(ov.getBoundingClientRect().bottom),
      };
    })()`);

    const bad = [];
    // 弹层必须完整落在视口内（放不下要自身滚动），不能被上下对称裁掉
    if (geo.top < -1) bad.push(`弹层顶部被裁 ${geo.top}px`);
    if (geo.bottom > geo.vh + 1) bad.push(`弹层底部超出视口 ${geo.bottom - geo.vh}px`);
    if (geo.ovTop !== 0 || Math.abs(geo.ovBottom - geo.vh) > 1) bad.push(`遮罩未铺满视口：${geo.ovTop}~${geo.ovBottom}/${geo.vh}`);
    if (geo.scrollH <= geo.clientH) bad.push(`玩法助手内容未溢出（${geo.scrollH}≤${geo.clientH}），滚动路径未被覆盖`);

    // ---- 检验①：空闲时不得重建内容（去重守卫）----
    // 这是「滚动被打回起点」的根因守护：旧版每 700ms 无条件 replaceChildren，
    // 内容被清空再填回 → 玩家的滚动位置被打回顶部，看着就像「滑不动」。
    await p.evalJs(`(()=>{const b=document.querySelector('.coach-ov .coach-body');
      if (b && b.firstElementChild) b.firstElementChild.dataset.probe='idle';})()`);
    await sleep(2200);                                                // 跨过 ≥3 次 700ms 刷新
    const idleProbeKept = await p.evalJs(`!!document.querySelector('.coach-ov .coach-body [data-probe="idle"]')`);
    if (!idleProbeKept) bad.push("空闲等待期间玩法助手被无谓重建（内容被清空重填 → 滚动位置会被打回顶部）");

    // ---- 检验②：棋局推进后确会重建，且滚动位置保持 ----
    await p.evalJs(`(()=>{const s=document.querySelector('.coach-sheet'); s.scrollTop = 60;})()`);
    const before = await p.evalJs(`document.querySelector('.coach-sheet').scrollTop`);
    await p.evalJs(`document.querySelector('#diceTray').click()`);   // 骰盘在遮罩之下，合成点击仍可推进棋局
    await sleep(2600);                                                // 跨过 ≥2 次 700ms 刷新
    const probeGone = await p.evalJs(`!document.querySelector('.coach-ov .coach-body [data-probe]')`);
    const after = await p.evalJs(`document.querySelector('.coach-sheet').scrollTop`);
    if (!probeGone) bad.push("棋局推进后玩法助手内容未随之刷新");
    if (before < 40) bad.push(`设置滚动位置失败（scrollTop=${before}）`);
    if (after < Math.max(20, before - 12)) bad.push(`内容重建后滚动位置被打回顶部：${before} → ${after}`);

    // 滚到底：底部「知道了」按钮必须落进视口、可点
    const btn = await p.evalJs(`(()=>{
      const s = document.querySelector('.coach-sheet');
      s.scrollTop = s.scrollHeight;
      const b = [...s.querySelectorAll('.dlg-actions .btn')].pop();
      const r = b.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
    })()`);
    if (btn.top < 0 || btn.bottom > btn.vh + 1) bad.push(`滚到底后底部按钮仍在视口外：${JSON.stringify(btn)}`);
    await p.shot("M-1-coach-scroll");

    if (p.problems.length) bad.push("运行期有异常");
    record("M 弹层几何 / 玩法助手滚动", bad.length === 0, bad.join("；")
      || `弹层 ${geo.top}~${geo.bottom}/${geo.vh}px · 内容 ${geo.scrollH}>${geo.clientH} 可滚动 · 空闲不重建 · 重建后位置保持 ${before}→${after}`);
  } catch (e) {
    record("M 弹层几何 / 玩法助手滚动", false, e.message);
  } finally {
    if (p.problems.length) record("M 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- N 首轮买地不得弹建房窗（建房规则 UI 侧守护） ----
// 口径：第一轮只能占空地、不建房（见《设计方案定稿》· 5.10）：
//   /Users/sevensimle/Documents/@西北人的成长/10-Projects/个人项目/童领计划/京韵大富翁_胡同漫游记/01_项目定义/02_游戏设计书/设计方案定稿.md
// 种子 3：1 号真人首轮掷骰落到第 12 格「南锣鼓巷」（无主空地，买得起）——
// 旧版买下后会立刻弹建房窗；这里断言买完之后不弹，且玩家卡确实记录了这块地。
async function scenarioN(cdp) {
  console.log("\n[N] 首轮买地不弹建房窗（2 人 · 种子 3 · 全速）");
  const p = await openPage(cdp);
  try {
    const bad = [];
    await startGame(p, { players: 2, humans: [true, false], seed: 3 });
    await setSpeed(p, "0");
    await setWalkAuto(p);
    await p.waitFor(`!!document.querySelector('#diceTray.armed')`,
      { timeout: 9000, interval: 60, label: "真人回合骰盘可点" });
    await p.evalJs(`document.querySelector('#diceTray').click()`);

    // 等买地弹层（1 号真人落到无主空地）
    await p.waitFor(`(()=>{const ov=document.querySelector('.overlay');
      return !!ov && !ov.hidden && /买地/.test(ov.innerText);})()`,
      { timeout: 9000, interval: 60, label: "首轮买地弹层" });
    const buyTitle = await p.evalJs(`document.querySelector('.overlay .dlg-h b').textContent.trim()`);
    if (!/^轮到/.test(buyTitle)) bad.push(`买地弹层标题异常：${buyTitle}`);
    await p.shot("N-1-buy-round1");

    // 点「买下」
    const clicked = await p.evalJs(`(()=>{const ov=document.querySelector('.overlay');
      const b=[...ov.querySelectorAll('.dlg-actions .btn')].find(x=>/买下/.test(x.textContent));
      if (!b || b.disabled) return false; b.click(); return true;})()`);
    if (!clicked) bad.push("首轮买地按钮不存在或不可点");

    // 关键：买完之后（第一轮）**不得**弹出建房窗
    let sawBuild = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      const isBuild = await p.evalJs(`(()=>{const ov=document.querySelector('.overlay');
        return !!ov && !ov.hidden && /建房/.test(ov.innerText);})()`);
      if (isBuild) { sawBuild = true; break; }
      await sleep(80);
    }
    if (sawBuild) bad.push("首轮买地后弹出了建房窗（第一轮只能占空地，不应建房）");

    // 棋局继续推进（第 1 轮跑完 / 进第 2 轮）
    await p.waitFor(`(()=>{const t=document.querySelector('#status').innerText;
      return /第\\s*[12]\\s*\\//.test(t);})()`, { timeout: 12000, interval: 120, label: "棋局继续推进" });

    // 1 号玩家卡应记录刚买下的第 12 格「南锣鼓巷」
    const bought = await p.evalJs(`(()=>{
      const c = document.querySelectorAll('#playersPanel .pcard')[0];
      return c ? c.innerText.replace(/\\s+/g,' ') : '';})()`);
    if (!/南锣鼓巷/.test(bought)) bad.push(`1 号玩家卡未记录第 12 格「南锣鼓巷」：${bought.slice(0, 120)}`);

    if (p.problems.length) bad.push("运行期有异常");
    record("N 首轮买地不弹建房窗", bad.length === 0, bad.join("；")
      || `首轮买下「南锣鼓巷」后无建房窗 · 玩家卡已记录该地块`);
  } catch (e) {
    record("N 首轮买地不弹建房窗", false, e.message);
  } finally {
    if (p.problems.length) record("N 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ------------------------------------------------------------------
// O 真人建房真正落地（N 守住「首轮不弹建房窗」，O 守住「点了建就真建起来」）
// 用户报告：即使点了「建」，系统也没记录建房。这里用真人真点，核对玩家卡。
// 种子 4：1 号真人第 1 轮买下第 15 格，第 5 轮又走回该格 —— 这才是规则允许的
// 第一次建房（每回合只能前进 2~12 格，不可能第 2 轮就折返，必须先绕一圈）。
// ------------------------------------------------------------------
async function scenarioO(cdp) {
  console.log("\n[O] 真人建房真正落地（2 人 · 种子 4 · 全速）");
  const p = await openPage(cdp);
  try {
    const bad = [];
    const TARGET = { round: 5, cell: 15, name: "国家体育场(鸟巢)", cost: 1300 };
    await startGame(p, { players: 2, humans: [true, false], seed: 4 });
    await setSpeed(p, "0");
    await setWalkAuto(p);

    const cardText = () => p.evalJs(`(()=>{
      const c = document.querySelectorAll('#playersPanel .pcard')[0];
      return c ? c.innerText.replace(/\\s+/g,' ') : '';})()`);

    // 与 advance 同序（弹层 > 卡摞 > 走格 > 骰子）；区别只在遇到「建房」弹层先不动手，交给下面记录
    const step = () => p.evalJs(`(()=>{
      const ov = document.querySelector('.overlay');
      if (ov && !ov.hidden) {
        const sh = document.querySelector('#sheet') || ov;
        const hd = sh.querySelector('.dlg-h b');
        // 必须按「标题」判定窗型：买地窗的正文里有「建房成本」三个字，
        // 按正文关键词匹配会把买地窗误认成建房窗，于是永远卡住。
        const title = hd ? hd.textContent.trim() : '';
        // 「建」按钮的 class 是 .mini（不是 .btn），所以要抓全部 button。
        const btns = [...sh.querySelectorAll('button')];
        if (!btns.length) return { a: 'dlg-wait', t: title };
        if (/建房/.test(title)) {
          const b = btns.find(x => x.textContent.trim() === '建');
          if (b) { window.__jymBuild = b; return { a: 'build' }; }
          const sk = btns.find(x => /跳过/.test(x.textContent));
          if (sk) { sk.click(); return { a: 'build-skip' }; }
          return { a: 'dlg-wait', t: title };
        }
        if (/买地/.test(title)) {
          const b = btns.find(x => /买下/.test(x.textContent));
          if (b && !b.disabled) { b.click(); return { a: 'buy' }; }
          (btns.find(x => x.disabled) || btns[btns.length-1]).click();
          return { a: 'buy-skip' };
        }
        const g2 = btns.find(x => /放弃|跳过|看看棋盘|不改/.test(x.textContent)) || btns[btns.length-1];
        g2.click(); return { a: 'other' };
      }
      const pile = document.querySelector('.pile.armed');
      if (pile) { pile.click(); return { a: 'card' }; }
      const walk = document.querySelector('.walker.armed');
      if (walk) { walk.click(); return { a: 'step' }; }
      const tray = document.querySelector('#diceTray.armed');
      if (tray) { tray.click(); return { a: 'roll' }; }
      return { a: 'wait' };
    })()`);

    const logText = () => p.evalJs(`(()=>{const e=document.querySelector('#log');
      return e ? e.innerText.replace(/\\s+/g,' ') : '';})()`);

    let before = "", after = "", logAfter = "", builtRound = 0;
    const seen = {};                            // 诊断：各种动作各发生几次
    let maxRound = 0, lastDlg = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 150000) {
      const r = await step();
      seen[r.a] = (seen[r.a] || 0) + 1;
      if (r.a === "dlg-wait" && !lastDlg) {
        lastDlg = await p.evalJs(`(()=>{const ov=document.querySelector('.overlay');
          const sh=document.querySelector('#sheet');
          return 'ov.hidden=' + ov.hidden + ' | sheet=' + (sh ? sh.className + ':' + sh.innerText.replace(/\\s+/g,' ').slice(0,80) : 'none')
            + ' | html=' + (sh ? sh.innerHTML.length : 0);})()`);
      }
      maxRound = Math.max(maxRound, await roundNo(p));
      if (r.a === "build") {
        builtRound = await roundNo(p);
        before = await cardText(p);
        const clicked = await p.evalJs(`(()=>{const b=window.__jymBuild;
          if (!b || b.disabled) return false; b.click(); return true;})()`);
        if (!clicked) bad.push("建房窗里的「建」按钮不存在或不可点");
        await sleep(1500);                      // 等落库 + 下一次渲染
        after = await cardText(p);
        logAfter = await logText(p);
        break;
      }
      if (r.a === "wait") {
        const t = await statusText(p);
        if (/🏆|结束/.test(t)) break;            // 整局提前结束（理论上不会，兜底防卡死）
      }
      await sleep(25);
    }

    if (!after) bad.push(`整局跑完都没等到 1 号真人的建房窗（规则：第 5 轮走回自己第 1 轮买下的地）；跑到第 ${maxRound} 轮，动作 ${JSON.stringify(seen)}，卡在弹层「${lastDlg}」`);
    else {
      if (builtRound !== TARGET.round) bad.push(`建房弹窗出现在第 ${builtRound} 轮（应为第 ${TARGET.round} 轮）`);
      if (!before.includes(TARGET.name)) bad.push(`建房前玩家卡里没有「${TARGET.name}」：${before.slice(0, 120)}`);
      if (/四合院|城楼/.test(before)) bad.push(`建房前玩家卡已显示等级：${before.slice(0, 120)}`);
      if (!after.includes(TARGET.name)) bad.push(`建房后玩家卡里没有「${TARGET.name}」：${after.slice(0, 120)}`);
      if (!/四合院/.test(after)) bad.push(`点了「建」但玩家卡没出现「四合院」→ 建房没落地：${after.slice(0, 120)}`);
      const b0 = (before.match(/建 (\d+)/) || [])[1], b1 = (after.match(/建 (\d+)/) || [])[1];
      if (b0 === undefined || b1 === undefined) bad.push(`玩家卡缺「建 N」计数：${after.slice(0, 120)}`);
      else if (Number(b1) !== Number(b0) + 1) bad.push(`建房计数 ${b0} → ${b1}（应 +1）`);
      // 日志由 applyBuild 自己写：建到 1 级（¥1,300）—— 是「钱真的扣了、级真的加了」的硬证据
      if (!/ 在 .+? 建到 1 级（¥1,300）/.test(logAfter)) {
        bad.push(`日志里没有建房记录：${(logAfter.match(/.{0,80}建.{0,80}/) || [""])[0] || "（无「建」相关日志）"}`);
      }
    }

    if (p.problems.length) bad.push("运行期有异常");
    await p.shot("O-1-build-applied");
    record("O 真人建房真正落地", bad.length === 0, bad.join("；")
      || `第 ${builtRound} 轮走回「${TARGET.name}」点「建」→ 四合院 · 建房 0→1 · 日志「建到 1 级（¥1,300）」`);
  } catch (e) {
    record("O 真人建房真正落地", false, e.message);
  } finally {
    if (p.problems.length) record("O 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- P 存档箱：多档位 + 坏档 / 旧档被明确拒绝 ----
async function scenarioP(cdp) {
  console.log("\n[P] 存档箱（3 人 · 种子 21 · 全速）");
  const p = await openPage(cdp);
  try {
    const bad = [];
    await p.evalJs(`['jym.save.auto','jym.save.slot.1','jym.save.slot.2','jym.save.slot.3']
      .forEach((k) => localStorage.removeItem(k))`);
    await startGame(p, { players: 3, humans: [true, false, false], seed: 21 });
    await setSpeed(p, "0");
    await setWalkAuto(p);
    for (let i = 0; i < 1500 && (await roundNo(p)) < 3; i++) { await advance(p); await sleep(25); }

    await saveAuto(p);
    const autoV = await p.evalJs(`(()=>{const s=JSON.parse(localStorage.getItem('jym.save.auto')||'null');
      return s ? s.v : 0;})()`);
    if (autoV !== 2) bad.push(`自动存档结构版本 ${autoV}（应为 2）`);

    // 塞两份坏档：档位 2 = 配置被改（配置指纹对不上）；档位 3 = 旧结构版本 v1
    await p.evalJs(`(()=>{
      const auto = JSON.parse(localStorage.getItem('jym.save.auto'));
      const badCfg = JSON.parse(JSON.stringify(auto)); badCfg.cfg.players = 4;
      localStorage.setItem('jym.save.slot.2', JSON.stringify(badCfg));
      const old = JSON.parse(JSON.stringify(auto)); old.v = 1;
      localStorage.setItem('jym.save.slot.3', JSON.stringify(old));
      return true;})()`);

    await p.evalJs(`document.querySelector('#btnLoad').click()`);
    await p.waitFor(`!!document.querySelector('#svList')`, { label: "存档箱面板" });
    await sleep(200);

    const rows = () => p.evalJs(`(()=>[...document.querySelectorAll('#svList .sv-row')].map((r) => ({
      name: r.querySelector('.sv-info b').textContent.trim(),
      info: r.querySelector('.sv-info span').textContent.trim(),
      warn: !!r.querySelector('.sv-info .sv-bad'),
      empty: r.classList.contains('empty'),
      btns: [...r.querySelectorAll('.sv-btns .btn')].map((b) => ({ t: b.textContent.trim(), off: b.disabled })),
    })))()`);
    const readOff = (row) => !!((row.btns.find((b) => b.t === "读") || {}).off);

    let list = await rows();
    if (list.length !== 4) bad.push(`存档箱应有 4 行（自动 + 3 档位），实为 ${list.length}`);
    if (list[0] && !/自动存档/.test(list[0].name)) bad.push(`第 1 行不是自动存档：「${list[0] && list[0].name}」`);
    if (list[1] && !list[1].empty) bad.push("档位 1 应为空档位");
    if (list[2] && !list[2].warn) bad.push("档位 2（配置被改）没有给出警告");
    if (list[2] && !/配置/.test(list[2].info)) bad.push(`档位 2 警告文案不对：${list[2] && list[2].info}`);
    if (list[3] && !list[3].warn) bad.push("档位 3（旧结构版本）没有给出警告");
    if (list[3] && !/版本/.test(list[3].info)) bad.push(`档位 3 警告文案不对：${list[3] && list[3].info}`);
    if (list[2] && !readOff(list[2])) bad.push("档位 2 的「读」没被禁用");
    if (list[3] && !readOff(list[3])) bad.push("档位 3 的「读」没被禁用");

    // 手动存到档位 1 → 该行变成有效档；再删掉 → 回到空档位
    await p.evalJs(`[...document.querySelectorAll('#svList .sv-row')][1]
      .querySelectorAll('.sv-btns .btn')[0].click()`);
    await sleep(250);
    list = await rows();
    if (!list[1] || list[1].empty) bad.push("点「存」后档位 1 仍是空档位");
    else if (list[1].warn) bad.push(`档位 1 存进去后不该报警：${list[1].info}`);
    const slot1 = await p.evalJs(`JSON.parse(localStorage.getItem('jym.save.slot.1')||'null')`);
    if (!slot1 || slot1.v !== 2 || !slot1.fp || !slot1.cfgFp) bad.push("档位 1 里的存档缺指纹字段");

    await p.evalJs(`[...document.querySelectorAll('#svList .sv-row')][1]
      .querySelectorAll('.sv-btns .btn')[2].click()`);
    await sleep(250);
    list = await rows();
    if (!list[1] || !list[1].empty) bad.push("点「删」后档位 1 没有变回空档位");

    if (p.problems.length) bad.push("运行期有异常");
    await p.shot("P-1-savebox");
    record("P 存档箱（多槽 + 坏档拒绝）", bad.length === 0, bad.join("；")
      || "自动存档为 v2 · 配置被改 / 旧版本档均被标警告且禁读 · 命名档位可存可删");
  } catch (e) {
    record("P 存档箱（多槽 + 坏档拒绝）", false, e.message);
  } finally {
    if (p.problems.length) record("P 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- Q 用户设置持久化 + 音效 ----
async function scenarioQ(cdp) {
  console.log("\n[Q] 设置持久化 + 音效（2 人 · 种子 7）");
  // 预置「音效已关」的本机设置 + 文档开始前挂 AudioContext 计数桩：
  // 这样才能验证「开机就是静音 → 整个页面一次 AudioContext 都不建」。
  const p = await openPage(cdp, { instrument: true, prefs: { sound: false, players: 2 } });
  try {
    const bad = [];

    await startGame(p, { players: 2, humans: [true, false], names: ["爸爸", "小明"], seed: 7 });
    // 用「快」而不是「全速」：全速会跳过动画，动画里的音效自然也不触发，
    // 那样测不出「静音是否真的拦住了音效」。这里要的是「有动画但不出声」。
    await setSpeed(p, "300");
    await setWalkAuto(p);
    for (let i = 0; i < 1500 && (await roundNo(p)) < 3; i++) { await advance(p); await sleep(25); }

    const acMuted = await p.evalJs(`window.__acCount`);
    if (acMuted !== 0) bad.push(`静音下仍创建了 ${acMuted} 次 AudioContext`);

    const prefs1 = await p.evalJs(`JSON.parse(localStorage.getItem('jym.prefs.v1')||'null')`);
    if (!prefs1) bad.push("起局后没有写入本机设置（jym.prefs.v1）");
    else {
      if (prefs1.players !== 2) bad.push(`设置里人数为 ${prefs1.players}（应为 2）`);
      if (!Array.isArray(prefs1.names) || prefs1.names[0] !== "爸爸") bad.push(`设置里没记住称呼：${JSON.stringify(prefs1.names)}`);
      if (prefs1.sound !== false) bad.push(`设置里音效为 ${prefs1.sound}（应为 false）`);
    }
    const sndBtn = await p.evalJs(`document.querySelector('#btnSound').textContent`);
    if (!/🔇/.test(sndBtn)) bad.push(`静音时控制条按钮应为 🔇，实为「${sndBtn}」`);

    // 点控制条喇叭打开 → 再走几步，AudioContext 应被创建（掷骰就会出声）
    await p.evalJs(`document.querySelector('#btnSound').click()`);
    await sleep(150);
    const sndBtn2 = await p.evalJs(`document.querySelector('#btnSound').textContent`);
    if (!/🔊/.test(sndBtn2)) bad.push(`开启音效后按钮应为 🔊，实为「${sndBtn2}」`);
    for (let i = 0; i < 800 && (await roundNo(p)) < 4; i++) { await advance(p); await sleep(25); }
    const acOn = await p.evalJs(`window.__acCount`);
    if (acOn < 1) {
      const diag = await p.evalJs(`({ rounds: (document.querySelector('#status')||{}).innerText,
        acType: typeof window.AudioContext, cnt: window.__acCount,
        speed: (document.querySelector('#speed')||{}).value,
        walk: (document.querySelector('#btnWalk')||{}).textContent })`);
      bad.push(`开启音效后仍未创建 AudioContext（音效没接线）｜诊断 ${JSON.stringify(diag)}`);
    }

    const prefs2 = await p.evalJs(`JSON.parse(localStorage.getItem('jym.prefs.v1')||'null')`);
    if (!prefs2 || prefs2.sound !== true) bad.push(`控制条开关没有写回设置：${prefs2 && prefs2.sound}`);

    if (p.problems.length) bad.push("运行期有异常");
    await p.shot("Q-1-prefs-sound");
    record("Q 设置持久化 + 音效", bad.length === 0, bad.join("；")
      || "静音开局 0 次 AudioContext · 人数/称呼/音效已记住 · 喇叭开关即时生效并回写设置");
  } catch (e) {
    record("Q 设置持久化 + 音效", false, e.message);
  } finally {
    if (p.problems.length) record("Q 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- R 儿童化增强（徽章 / 领先条 / 飘字 / 日志筛选 / 走格预告 / 键盘 / 减弱动效） ----
async function scenarioR(cdp) {
  console.log("\n[R] 儿童化增强（3 人 · 种子 9 · 手动走格）");
  const p = await openPage(cdp);
  try {
    const bad = [];

    // 注入观察器：徽章冒完 2.6s 会自动收，抓不到就得靠它把「冒过谁」记下来，
    // 才能验证「同一条徽章不去重地反复冒」这个坑。
    await p.evalJs(`(()=>{
      window.__badges = [];
      const ob = new MutationObserver((ms) => {
        for (const m of ms) for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains('badge-pop')) {
            const b = n.querySelector('.bd-tx b');
            window.__badges.push(b ? b.textContent.trim() : '');
          }
        }
      });
      ob.observe(document.body, { childList: true, subtree: true });
      return true;
    })()`);

    await startGame(p, { players: 3, humans: [true, false, false], seed: 9 });
    await setSpeed(p, "300");      // 要有动画：飘字 / 徽章才出（全速会跳过动画，自然也不冒）

    // 领先条：几个人就几根，宽度用内联 style（不依赖 :has / 容器查询，兼容终端 WebView）
    await p.waitFor(`document.querySelectorAll('.lead-row').length === 3`, { label: "资产领先条" });
    const lead = await p.evalJs(`(()=>{
      const rows = [...document.querySelectorAll('.lead-row')];
      return {
        n: rows.length,
        head: (document.querySelector('.lead-h') || {}).textContent || '',
        fills: rows.map((r) => r.querySelector('.lead-fill').style.width),
        vals: rows.map((r) => r.querySelector('.lead-val').textContent.trim()),
      };
    })()`);
    if (lead.n !== 3) bad.push(`领先条 ${lead.n} 根（应 3）`);
    if (!/谁最富/.test(lead.head)) bad.push(`领先条标题不对：${lead.head}`);
    if (!lead.fills.every((w) => /%$/.test(w))) bad.push(`领先条填充宽度异常：${lead.fills.join(",")}`);
    if (!lead.vals.every((v) => /^¥/.test(v))) bad.push(`领先条数值异常：${lead.vals.join(",")}`);

    // 手动走格一路推到第 4 轮：顺手抓「下一格预告」与「现金变动飘字」
    let sawTip = false, tipText = "", sawFloat = null;
    for (let i = 0; i < 2500 && (await roundNo(p)) < 4; i++) {
      const snap = await p.evalJs(`(()=>{
        const t = document.querySelector('.step-tip');
        const f = document.querySelector('.cash-float');
        return { tip: (t && !t.hidden) ? t.textContent.trim() : null,
                 float: f ? f.textContent.trim() : null };
      })()`);
      if (snap.tip) { sawTip = true; tipText = snap.tip; }
      if (snap.float) sawFloat = snap.float;
      await advance(p);
      await sleep(25);
    }
    if (!sawTip) bad.push("手动走格全程没看到「下一格预告」");
    else if (!/[（(].+[）)]/.test(tipText)) bad.push(`「下一格预告」文案格式不对：${tipText}`);
    if (!sawFloat) bad.push("整段对局没抓到现金变动飘字（.cash-float）");
    else if (!/^[+-]¥/.test(sawFloat)) bad.push(`现金飘字文案异常：${sawFloat}`);

    // 成就徽章：至少冒过一枚；且同一条（同一人 + 同一成就）不重复冒
    const badges = await p.evalJs(`window.__badges`);
    if (!Array.isArray(badges) || badges.length === 0) bad.push("整段对局没有冒出任何成就徽章");
    else {
      if (!badges.some((b) => /第一块地|第一次收租|盖起四合院|五块地/.test(b)))
        bad.push(`徽章内容不像儿童成就：${badges.slice(0, 5).join("、")}`);
      const seen = new Set(), dup = [];
      for (const b of badges) {
        if (/反超领先/.test(b)) continue;      // 领先换人可反复报，属正常
        if (seen.has(b)) dup.push(b); else seen.add(b);
      }
      if (dup.length) bad.push(`成就重复冒泡（未去重）：${[...new Set(dup)].join("、")}`);
    }

    // 日志筛选 + 轮次锚点
    const anchors = await p.evalJs(`document.querySelectorAll('#log .lg-anchor').length`);
    if (anchors < 2) bad.push(`轮次锚点仅 ${anchors} 个（每轮第一行应各一个）`);
    const sticky = await p.evalJs(`(()=>{const a=document.querySelector('#log .lg-anchor');
      return a ? getComputedStyle(a).position : '';})()`);
    if (sticky !== "sticky") bad.push(`轮次锚点未吸顶（position=${sticky}）`);

    const visCount = () => p.evalJs(`[...document.querySelectorAll('#log .lg')]
      .filter((e) => getComputedStyle(e).display !== 'none').length`);
    const allRows = await p.evalJs(`document.querySelectorAll('#log .lg').length`);
    const jumpOpts = await p.evalJs(`document.querySelector('#logJump').options.length`);

    await p.evalJs(`document.querySelector('.ltool[data-filter="lg-rent"]').click()`);
    await sleep(150);
    const filtered = await p.evalJs(`(()=>({
      filter: document.querySelector('#log').dataset.filter,
      on: document.querySelector('.ltool[data-filter="lg-rent"]').classList.contains('on'),
      allOn: document.querySelector('.ltool[data-filter="all"]').classList.contains('on'),
      jump: document.querySelector('#logJump').disabled,
    }))()`);
    const rentRows = await visCount();
    if (filtered.filter !== "lg-rent") bad.push(`筛选未打到容器上：${filtered.filter}`);
    if (!filtered.on || filtered.allOn) bad.push("筛选按钮选中态没切换");
    if (!filtered.jump) bad.push("非「全部」视图下「跳到轮次」未禁用");
    if (!(rentRows < allRows)) bad.push(`切到「收租付租」后可见行没减少（${rentRows}/${allRows}）`);

    await p.evalJs(`document.querySelector('.ltool[data-filter="all"]').click()`);
    await sleep(150);
    const allBack = await visCount();
    if (allBack !== allRows) bad.push(`切回「全部」后可见行 ${allBack}≠总行 ${allRows}`);
    if (await p.evalJs(`document.querySelector('#logJump').disabled`)) bad.push("回到「全部」后「跳到轮次」仍禁用");
    if (jumpOpts < 2) bad.push(`「跳到轮次」下拉没有轮次项（options=${jumpOpts}）`);

    // 先把可能开着的决策对话框走完 —— 弹层开着时键盘快捷键主动不接管
    for (let i = 0; i < 60; i++) {
      if (await p.evalJs(`document.getElementById('overlay').hidden`)) break;
      await advance(p); await sleep(40);
    }
    if (!(await p.evalJs(`document.getElementById('overlay').hidden`))) bad.push("对话框始终没走完，键盘用例无法进行");

    // 键盘：? 打开玩法助手 / P 暂停 / 空格掷骰
    await p.evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true}))`);
    await p.waitFor(`!!document.querySelector('.coach-ov')`, { timeout: 5000, label: "玩法助手（键盘 ?）" });
    await p.evalJs(`[...document.querySelectorAll('.coach-ov .btn')].find((b)=>/知道了/.test(b.textContent)).click()`);
    await p.waitFor(`!document.querySelector('.coach-ov')`, { timeout: 3000, label: "关闭玩法助手" });

    await p.evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'p',bubbles:true}))`);
    if (!/继续/.test(await p.evalJs(`document.querySelector('#btnPause').textContent.trim()`)))
      bad.push("按 P 没进入暂停");
    await p.evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'p',bubbles:true}))`);
    if (!/暂停/.test(await p.evalJs(`document.querySelector('#btnPause').textContent.trim()`)))
      bad.push("再按 P 没恢复继续");

    // 空格 → 该掷骰就掷骰：先推进到骰子点亮，再按空格，应被当场消费
    let spaceOk = false;
    for (let i = 0; i < 400; i++) {
      if (await p.evalJs(`!!document.querySelector('#diceTray.armed')`)) {
        await p.evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}))`);
        spaceOk = await p.waitFor(`!document.querySelector('#diceTray.armed')`, { timeout: 3000, label: "空格掷骰" })
          .then(() => true).catch(() => false);
        break;
      }
      await advance(p); await sleep(25);
    }
    if (!spaceOk) bad.push("空格没能推进掷骰");

    // 减弱动效：模拟系统「减少动态效果」，动画 / 过渡时长应降到近乎 0
    await cdp.send("Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, p.S);
    await sleep(150);
    const rm = await p.evalJs(`(()=>{
      const el = document.querySelector('.lead-fill') || document.querySelector('.badge-pop') || document.body;
      const cs = getComputedStyle(el);
      const ms = (s) => { const v = parseFloat(s) || 0; return /ms$/.test(s) ? v : v * 1000; };
      return { mq: matchMedia('(prefers-reduced-motion: reduce)').matches,
               trans: ms(cs.transitionDuration), anim: ms(cs.animationDuration) };
    })()`);
    if (!rm.mq) bad.push("模拟「减少动态效果」后 matchMedia 仍为 false");
    if (rm.trans > 1) bad.push(`减少动态效果下过渡仍为 ${rm.trans}ms`);
    if (rm.anim > 1) bad.push(`减少动态效果下动画仍为 ${rm.anim}ms`);
    await cdp.send("Emulation.setEmulatedMedia", { features: [] }, p.S);

    if (p.problems.length) bad.push("运行期有异常");
    await p.shot("R-1-kids-enhance");
    record("R 儿童化增强（徽章/领先条/飘字/筛选/预告/键盘/减弱动效）", bad.length === 0, bad.join("；")
      || `${badges.length} 枚成就徽章且已去重 · 领先条 3 根 · 现金飘字可见 · 日志筛选与轮次吸顶生效 · 走格预告可见 · ?/P/空格 生效 · 「减少动态效果」已降级`);
  } catch (e) {
    record("R 儿童化增强", false, e.message);
  } finally {
    if (p.problems.length) record("R 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- S 弹层底栏不遮内容（sticky 底栏几何 · 1280×672 终端尺寸） ----
// 回归守护：底栏（.setup-actions / .dlg-actions）是 sticky 常驻滚动区下沿。
// 一旦它带负的 margin-bottom，滚到底后仍会「被钉住」而多压住上一行几像素 ——
// 表现就是「最后一排卡片按钮的下边线被底栏遮住」（截图里那个 bug）。
async function scenarioS(cdp) {
  console.log("\n[S] 弹层底栏不遮内容（1280×672 终端尺寸）");
  const p = await openPage(cdp);
  try {
    const bad = [];
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 672, deviceScaleFactor: 1, mobile: false }, p.S);
    await sleep(150);

    // 开局面板：展开高级设置 → 内容必然高于视口 → 强制走滚动路径，再滚到底量几何
    const geo = await p.evalJs(`(()=>{
      const sh = document.querySelector('#sheet');
      const adv = sh.querySelector('details.adv'); if (adv) adv.open = true;
      void sh.offsetHeight;
      sh.scrollTop = 1e9;
      const acts = sh.querySelector('.setup-actions').getBoundingClientRect();
      const opts = [...sh.querySelectorAll('.seg.cards .card-opt')];
      const lastOpt = opts.length ? opts[opts.length - 1].getBoundingClientRect() : null;
      const sheetR = sh.getBoundingClientRect();
      return {
        maxScroll: Math.round(sh.scrollHeight - sh.clientHeight),
        actsTop: acts.top, actsBottom: acts.bottom,
        optBottom: lastOpt ? lastOpt.bottom : null,
        sheetBottom: sheetR.bottom,
      };
    })()`);
    if (geo.maxScroll <= 0) bad.push(`开局面板未溢出，滚动路径未被覆盖（maxScroll=${geo.maxScroll}）`);
    if (geo.optBottom != null && geo.actsTop - geo.optBottom < -0.5)
      bad.push(`底栏遮住卡片按钮下边线 ${(geo.optBottom - geo.actsTop).toFixed(1)}px`);
    if (geo.actsBottom > geo.sheetBottom + 1)
      bad.push(`开局底栏溢出表单底 ${(geo.actsBottom - geo.sheetBottom).toFixed(1)}px`);
    await p.shot("S-1-setup-bottom");

    // 玩法助手：共用同一套 .dlg-actions 底栏；矮视口下滚到底，底栏不得压住正文
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 520, deviceScaleFactor: 1, mobile: false }, p.S);
    await sleep(120);
    await startGame(p, { players: 2, humans: [true, false], seed: 33 });
    await p.waitFor(`/第\\s*1\\s*\\//.test(document.querySelector('#status').innerText)`, { label: "进入第 1 轮" });
    await p.evalJs(`document.querySelector('#btnCoach').click()`);
    await p.waitFor(`!!document.querySelector('.coach-ov .coach-sheet')`, { label: "玩法助手弹层" });
    await sleep(250);
    const cgeo = await p.evalJs(`(()=>{
      const sh = document.querySelector('.coach-ov .coach-sheet');
      sh.scrollTop = sh.scrollHeight;
      const acts = sh.querySelector('.dlg-actions').getBoundingClientRect();
      const body = sh.querySelector('.coach-body').getBoundingClientRect();
      const sheetR = sh.getBoundingClientRect();
      return {
        maxScroll: Math.round(sh.scrollHeight - sh.clientHeight),
        actsTop: acts.top, actsBottom: acts.bottom,
        bodyBottom: body.bottom, sheetBottom: sheetR.bottom,
      };
    })()`);
    if (cgeo.maxScroll <= 0) bad.push(`玩法助手未溢出（maxScroll=${cgeo.maxScroll}），滚动路径未被覆盖`);
    if (cgeo.actsTop - cgeo.bodyBottom < -0.5)
      bad.push(`玩法助手底栏遮住正文 ${(cgeo.bodyBottom - cgeo.actsTop).toFixed(1)}px`);
    if (cgeo.actsBottom > cgeo.sheetBottom + 1)
      bad.push(`玩法助手底栏溢出表单底 ${(cgeo.actsBottom - cgeo.sheetBottom).toFixed(1)}px`);
    await p.shot("S-2-coach-bottom");

    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, p.S);

    if (p.problems.length) bad.push("运行期有异常");
    record("S 弹层底栏不遮内容", bad.length === 0, bad.join("；")
      || `开局底栏与卡片间隙 ${(geo.actsTop - geo.optBottom).toFixed(1)}px · 助手底栏与正文间隙 ${(cgeo.actsTop - cgeo.bodyBottom).toFixed(1)}px（均 ≥0）`);
  } catch (e) {
    record("S 弹层底栏不遮内容", false, e.message);
  } finally {
    if (p.problems.length) record("S 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await p.close();
  }
}

// ---- U 多分辨率 / 多设备布局完整性（主界面 · 只读几何） ----
// 守护「精简主界面 + 棋盘全屏」改版：跨 10 档视口，逐档确认
//   ① 没有横向撑破（文档不出现横向滚动条）；
//   ② 宽屏（>1180px，三栏布局）控制条严格单行、四个侧栏面板不被裁切；
//   ③ 棋盘完整落在棋盘区内，没被面板工具按钮压住、也没溢出容器；
//   ④ 棋盘「⤢ 全屏」在每一档都可用，全屏后棋盘只涨不缩，且完整落在视口内。
// 1180px 是 CSS 的断点（≤1180 塌成单列、控制条放开换行），所以 1181 / 1180 两档都要测。
async function scenarioU(cdp) {
  console.log("\n[U] 多分辨率 / 多设备布局完整性");
  const p = await openPage(cdp);
  const bad = [];
  const grows = [];
  const VIEWS = [
    { n: "1920×1080 台式", w: 1920, h: 1080 },
    { n: "1600×1000 笔记本", w: 1600, h: 1000 },
    { n: "1440×900 笔记本", w: 1440, h: 900 },
    { n: "1366×768 笔记本", w: 1366, h: 768 },
    { n: "1280×672 触屏终端", w: 1280, h: 672 },
    { n: "1181×800 临界·三栏", w: 1181, h: 800 },
    { n: "1180×800 临界·单列", w: 1180, h: 800 },
    { n: "1024×768 平板横屏", w: 1024, h: 768 },
    { n: "844×390 手机横屏", w: 844, h: 390, mobile: true },
    { n: "390×844 手机竖屏", w: 390, h: 844, mobile: true },
  ];

  // 一次读全部要看的量：棋盘几何 + 布局溢出 + 全屏态。
  const PROBE = `(()=>{
    const R = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
    const wrap = document.querySelector('#boardwrap');
    const tools = wrap.querySelector(':scope > .panel-tools');
    const fsb = tools ? tools.children[0] : null;
    const b = R('#board'), wr = wrap.getBoundingClientRect(), tr = tools ? tools.getBoundingClientRect() : null;
    const clip = (sel) => { const e = document.querySelector(sel); return e ? Math.max(0, e.scrollWidth - e.clientWidth) : -1; };
    const centers = [...document.querySelectorAll('.controls > .btn, .controls > .sel')]
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => Math.round((r.top + r.height / 2) * 10) / 10);
    return {
      docOver: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      ctrlRows: new Set(centers).size,
      clips: { season: clip('#seasonPanel'), players: clip('#playersPanel'),
               market: clip('#marketPanel'), log: clip('#logPanel'),
               topbar: clip('#topbar'), controls: clip('#controls') },
      boardInWrap: !!b && b.left >= wr.left - 1.5 && b.right <= wr.right + 1.5
                      && b.top >= wr.top - 1.5 && b.bottom <= wr.bottom + 1.5,
      boardW: b ? Math.round(b.width) : 0,
      fits: !!b && b.left >= -1.5 && b.top >= -1.5
                 && b.right <= window.innerWidth + 1.5 && b.bottom <= window.innerHeight + 1.5,
      toolsInside: !!tr && tr.right <= wr.right + 1.5 && tr.top >= wr.top - 1.5,
      fsBtn: !!fsb,
      fsOn: wrap.classList.contains('region-fs') && getComputedStyle(wrap).position === 'fixed',
    };
  })()`;

  // 棋盘边长要等 ResizeObserver → rAF 重算，量早了会读到上一档的旧值。
  // 所以每次改动后都轮询，直到边长连续两次读数一致（最多等 3s）再采信。
  const settle = async (max = 3000) => {
    const t0 = Date.now();
    let prev = null, stable = 0, last = null;
    while (Date.now() - t0 < max) {
      last = await p.evalJs(PROBE);
      if (prev !== null && last.boardW === prev) { if (++stable >= 2) return last; } else stable = 0;
      prev = last.boardW;
      await sleep(90);
    }
    return last;
  };
  const clickFs = () => p.evalJs(`document.querySelector('#boardwrap > .panel-tools > button').click()`);

  try {
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, p.S);
    await startGame(p, { players: 2, humans: [true, false], seed: 55 });
    await p.waitFor(`/第\\s*1\\s*\\//.test(document.querySelector('#status').innerText)`, { label: "进入第 1 轮" });

    for (const v of VIEWS) {
      await cdp.send("Emulation.setDeviceMetricsOverride",
        { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: !!v.mobile }, p.S);
      const a = await settle();
      await clickFs();
      const f = await settle();
      await clickFs();
      const back = await settle();

      if (a.docOver > 1) bad.push(`${v.n}：文档横向溢出 ${a.docOver}px`);
      if (f.docOver > 1) bad.push(`${v.n}：棋盘全屏时文档横向溢出 ${f.docOver}px`);
      if (!a.boardInWrap) bad.push(`${v.n}：棋盘超出棋盘区容器`);
      if (!a.toolsInside) bad.push(`${v.n}：棋盘区工具按钮落在容器外`);
      if (!a.fsBtn) bad.push(`${v.n}：棋盘区缺「全屏」按钮`);
      if (!f.fsOn) bad.push(`${v.n}：棋盘未能进入全屏`);
      if (!f.fits) bad.push(`${v.n}：棋盘全屏后超出视口`);
      if (back.fsOn) bad.push(`${v.n}：棋盘没能退出全屏`);
      if (f.boardW < a.boardW - 2) bad.push(`${v.n}：棋盘全屏后反而变小（${a.boardW}→${f.boardW}）`);
      if (v.w > 1180) {
        if (!a.mobile && a.ctrlRows !== 1) bad.push(`${v.n}：控制条折成 ${a.ctrlRows} 行（宽屏应严格单行）`);
        for (const [k, n] of [["season", "季节"], ["players", "玩家"], ["market", "行情"], ["log", "日志"]])
          if (a.clips[k] > 1) bad.push(`${v.n}：${n}面板横向被裁 ${a.clips[k]}px`);
        if (a.clips.topbar > 1) bad.push(`${v.n}：顶栏横向被裁 ${a.clips.topbar}px`);
      }
      if (a.clips.controls > 1) bad.push(`${v.n}：控制条横向被裁 ${a.clips.controls}px`);
      if (Math.abs(back.boardW - a.boardW) > 2) bad.push(`${v.n}：全屏还原后棋盘尺寸没回到原值（${a.boardW}→${back.boardW}）`);
      grows.push(`${v.n} ${a.boardW}→${f.boardW}`);
    }

    if (p.problems.length) bad.push("运行期有异常");
    record("U 多分辨率 / 多设备布局完整性", bad.length === 0,
      bad.join("；") || `10 档视口：无横向溢出 · 控制条单行 · 侧栏不裁切 · 棋盘全屏只涨不缩（棋盘边长 ${grows.join(" · ")}）`);
  } catch (e) {
    record("U 多分辨率 / 多设备布局完整性", false, e.message);
  } finally {
    if (p.problems.length) record("U 运行期异常", false, [...new Set(p.problems)].join(" | "));
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, p.S).catch(() => {});
    await p.close();
  }
}

// ---- T 翻牌提示：手动关 / 自动关（时长可设） ----
// 口径：cardMode=manual → 真人抽的卡等玩家点（不自动关）；auto → 到 cardMs 自己关。
async function scenarioT(cdp) {
  console.log("\n[T] 翻牌提示手动/自动 + 时长（2 人 · 种子 7）");
  const bad = [];
  const READ_CARD = `(()=>{
    const el = document.querySelector('.card-reveal');
    if (!el || el.hidden || !el.classList.contains('in')) return null;
    const w = el.querySelector('.cr-who'), h = el.querySelector('.cr-hint');
    return { who: w ? w.textContent.trim() : '', hint: h ? h.textContent.trim() : '' };
  })()`;

  // ① 自动关：预置 cardMode=auto / cardMs=3000 → 真人抽的卡应 3 秒左右自己收
  {
    const p = await openPage(cdp, { prefs: { cardMode: "auto", cardMs: 3000 } });
    try {
      const ui = await p.evalJs(`(()=>{
        const on = document.querySelector('.seg[data-name="cardMode"] .seg-btn.on');
        const ms = document.querySelector('.seg[data-name="cardMs"] .seg-btn.on');
        return { mode: on && on.dataset.value, ms: ms && ms.dataset.value };
      })()`);
      if (ui.mode !== "auto") bad.push(`[自动关] 开局面板未回填 cardMode=auto（实际 ${ui.mode}）`);
      if (ui.ms !== "3000") bad.push(`[自动关] 开局面板未回填 cardMs=3000（实际 ${ui.ms}）`);

      await startGame(p, { players: 2, humans: [true, false], names: ["小明", ""], seed: 7 });
      await setSpeed(p, "300");
      const saved = await p.evalJs(`JSON.parse(localStorage.getItem('jym.prefs.v1')||'{}')`);
      if (saved.cardMode !== "auto" || Number(saved.cardMs) !== 3000)
        bad.push(`[自动关] 设置未写回本机：cardMode=${saved.cardMode} cardMs=${saved.cardMs}`);

      let hint = "", who = "", elapsed = -1, closed = false;
      for (let i = 0; i < 9000; i++) {
        const act = await advance(p);
        if (act === "card") {
          const info = await p.evalJs(READ_CARD);
          if (info) {
            who = info.who; hint = info.hint;
            const t0 = Date.now();
            closed = await p.waitFor(
              `!document.querySelector('.card-reveal').classList.contains('in')`,
              { timeout: 6000, interval: 60, label: "卡片自动关闭" }).then(() => true).catch(() => false);
            elapsed = Date.now() - t0;
            break;
          }
        }
        if (await roundNo(p) >= 6) break;
        await sleep(26);
      }
      if (!hint) bad.push("[自动关] 6 轮内没有出现真人翻牌");
      else {
        if (who !== "小明") bad.push(`[自动关] 翻牌归属异常：${who}`);
        if (!/3 秒后自动关/.test(hint)) bad.push(`[自动关] 卡面提示未体现时长：${hint}`);
        if (!closed) bad.push("[自动关] 卡片未按时自动关闭");
        else if (elapsed < 2500 || elapsed > 4500) bad.push(`[自动关] 停留 ${elapsed}ms（预期≈3000）`);
      }
    } catch (e) { bad.push("[自动关] " + e.message); }
    finally { if (p.problems.length) bad.push("[自动关] 运行期异常"); await p.close(); }
  }

  // ② 手动关：预置 cardMode=manual / cardMs=3000 → 真人抽的卡不自动关（超过 3s 仍在）
  {
    const p = await openPage(cdp, { prefs: { cardMode: "manual", cardMs: 3000 } });
    try {
      await startGame(p, { players: 2, humans: [true, false], names: ["小明", ""], seed: 7 });
      await setSpeed(p, "300");
      let hint = "", who = "", stayed = false;
      for (let i = 0; i < 9000; i++) {
        const act = await advance(p);
        if (act === "card") {
          const info = await p.evalJs(READ_CARD);
          if (info) {
            who = info.who; hint = info.hint;
            await sleep(4000);   // 远超 cardMs(3000)，manual 下应纹丝不动
            stayed = await p.evalJs(`(()=>{const e=document.querySelector('.card-reveal');return !!e && !e.hidden && e.classList.contains('in');})()`);
            if (stayed) await p.evalJs(`document.querySelector('.card-reveal .cr-close').click()`);
            break;
          }
        }
        if (await roundNo(p) >= 6) break;
        await sleep(26);
      }
      if (!hint) bad.push("[手动关] 6 轮内没有出现真人翻牌");
      else {
        if (who !== "小明") bad.push(`[手动关] 翻牌归属异常：${who}`);
        if (!/点一下关掉/.test(hint)) bad.push(`[手动关] 卡面提示异常：${hint}`);
        if (!stayed) bad.push("[手动关] 卡片在手动模式下仍自动关闭");
      }
    } catch (e) { bad.push("[手动关] " + e.message); }
    finally { if (p.problems.length) bad.push("[手动关] 运行期异常"); await p.close(); }
  }

  record("T 翻牌提示手动/自动 + 时长", bad.length === 0, bad.join("；")
    || "auto 模式 3 秒自动关闭并写回本机设置 · manual 模式超过 3 秒仍保持打开");
}

// ------------------------------------------------------------------
async function main() {
  console.log("京韵大富翁 · 本机 Web 版验收");
  console.log(`  目标 ${URL_TARGET}`);
  await ensureServer();
  const launched = await ensureChrome();
  const ver = await (await fetch(`${CDP_HTTP}/json/version`)).json();
  console.log(`  Chrome ${ver.Browser}${launched ? "（本次自启）" : ""}`);

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await waitOpen(ws);
  const cdp = new CDP(ws);

  const only = process.argv.slice(2).map((s) => s.toUpperCase());
  const all = {
    A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD,
    E: scenarioE, F: scenarioF, G: scenarioG, H: scenarioH, I: scenarioI, J: scenarioJ,
    K: scenarioK, L: scenarioL, M: scenarioM, N: scenarioN, O: scenarioO,
    P: scenarioP, Q: scenarioQ, R: scenarioR, S: scenarioS, T: scenarioT, U: scenarioU,
  };
  for (const [k, fn] of Object.entries(all)) {
    if (only.length && !only.includes(k)) continue;
    await fn(cdp);
  }

  ws.close();
  if (chromeProc) chromeProc.kill();

  const fails = results.filter((r) => !r.ok);
  console.log("\n" + "─".repeat(56));
  console.log(`共 ${results.length} 项 · 通过 ${results.length - fails.length} · 失败 ${fails.length}`);
  if (fails.length) {
    console.log("❌ 未通过：");
    for (const f of fails) console.log(`  - ${f.name}：${f.note}`);
  } else console.log("✅ 全部场景通过");
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error("运行失败：", e.message); if (chromeProc) chromeProc.kill(); process.exit(2); });
