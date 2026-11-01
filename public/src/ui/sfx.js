/**
 * sfx.js —— 零素材音效（WebAudio 现场合成）
 *
 * 不引入任何音频文件：全部用振荡器 / 噪声临时合成，
 * APK 体积零增长，也不占用素材目录。
 *
 * 两条硬约束：
 *   ① 静音时**不创建** AudioContext（部分设备上创建音频上下文本身就会打断后台音乐）。
 *   ② 全部包在 try/catch 里 —— 浏览器不支持 / 被策略拦截时静默失效，绝不影响棋局。
 *
 * 与内核无关：这里只出声，不读也不写棋局状态，更不消耗内核随机数。
 */

let ctx = null;
let master = null;
let enabled = true;

/** 取（或首次创建）音频上下文；静音或不支持时返回 null。 */
function ac() {
  if (!enabled) return null;
  if (ctx) return ctx;
  try {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
    master = null;
  }
  return ctx;
}

/** 单个音符：可带频率滑音。 */
function tone({ freq, dur = 0.12, type = "sine", vol = 0.18, delay = 0, to = 0 }) {
  const c = ac();
  if (!c) return;
  try {
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(40, to), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.04);
  } catch { /* noop */ }
}

/** 一段噪声（骰子滚动 / 翻卡的风声）。 */
function noise({ dur = 0.16, vol = 0.10, delay = 0, lp = 5200 }) {
  const c = ac();
  if (!c) return;
  try {
    const t0 = c.currentTime + delay;
    const n = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = c.createBufferSource();
    src.buffer = buf;
    const flt = c.createBiquadFilter();
    flt.type = "lowpass";
    flt.frequency.value = lp;
    const g = c.createGain();
    g.gain.value = vol;
    src.connect(flt); flt.connect(g); g.connect(master);
    src.start(t0);
  } catch { /* noop */ }
}

/** 开关音效。关掉时不创建上下文；已存在的先挂起。 */
export function setSound(on) {
  enabled = !!on;
  if (!enabled) {
    try { if (ctx && ctx.state === "running") ctx.suspend(); } catch { /* noop */ }
    return;
  }
  const c = ac();
  try { if (c && c.state === "suspended") c.resume(); } catch { /* noop */ }
}

export function isSoundOn() { return enabled; }

/** 首次用户手势时调用：把被浏览器策略挂起的上下文唤醒。 */
export function unlock() {
  if (!enabled) return;
  const c = ac();
  try { if (c && c.state === "suspended") c.resume(); } catch { /* noop */ }
}

export const sfx = {
  /** 掷骰子：几粒骰子滚过桌面 */
  roll() {
    for (let i = 0; i < 5; i++) noise({ dur: 0.07, vol: 0.09, delay: i * 0.085, lp: 7000 });
    tone({ freq: 320, dur: 0.06, type: "square", vol: 0.05, delay: 0.42, to: 180 });
  },
  /** 棋子跳一格 */
  hop() { tone({ freq: 520, dur: 0.075, type: "triangle", vol: 0.16, to: 760 }); },
  /** 棋子落格 */
  land() { tone({ freq: 190, dur: 0.16, type: "sine", vol: 0.22, to: 88 }); },
  /** 翻卡 */
  card() { noise({ dur: 0.22, vol: 0.11, lp: 4200 }); tone({ freq: 700, dur: 0.09, type: "sine", vol: 0.08, delay: 0.05, to: 980 }); },
  /** 进账（收租 / 拿到钱） */
  coin() {
    tone({ freq: 988, dur: 0.08, type: "square", vol: 0.13 });
    tone({ freq: 1319, dur: 0.16, type: "square", vol: 0.12, delay: 0.08 });
  },
  /** 出账（付租金 / 花钱） */
  pay() { tone({ freq: 420, dur: 0.18, type: "sawtooth", vol: 0.12, to: 220 }); },
  /** 买地确认 */
  buy() {
    tone({ freq: 587, dur: 0.10, type: "triangle", vol: 0.16 });
    tone({ freq: 880, dur: 0.16, type: "triangle", vol: 0.15, delay: 0.09 });
  },
  /** 建房 */
  build() {
    [523, 659, 784].forEach((f, i) => tone({ freq: f, dur: 0.14, type: "triangle", vol: 0.16, delay: i * 0.07 }));
  },
  /** 破产 / 出局 */
  dead() { tone({ freq: 320, dur: 0.5, type: "sawtooth", vol: 0.16, to: 90 }); },
  /** 结算获胜 */
  win() {
    [523, 659, 784, 1047, 1319].forEach((f, i) =>
      tone({ freq: f, dur: 0.22, type: "square", vol: 0.14, delay: i * 0.11 }));
  },
  /** 成就徽章：一声向上「叮～」 */
  badge() {
    tone({ freq: 784, dur: 0.10, type: "triangle", vol: 0.15 });
    tone({ freq: 1047, dur: 0.10, type: "triangle", vol: 0.14, delay: 0.09 });
    tone({ freq: 1319, dur: 0.20, type: "triangle", vol: 0.13, delay: 0.18 });
  },
  /** 轻点反馈 */
  tap() { tone({ freq: 660, dur: 0.05, type: "sine", vol: 0.10 }); },
};
