/**
 * prefs.js —— 本机「用户设置」持久化（跨局、跨次开机记住）
 *
 * 只存**偏好**，不存棋局：人数 / 谁是谁 / 称呼 / 加料开关 / 高级设置 /
 * 节奏 / 棋盘朝向 / 走格方式 / 音效。开局设置面板默认值取自这里，
 * 每次起新局后再写回 —— 下次打开就是上次的样子，不用重填。
 *
 * 随机种子**不持久化**（有意为之）：记住种子会导致每局都是同一盘棋，
 * 与「随机种子 = 复现某一局」的用途冲突。想复现请在开局面板手填。
 */

import { getItem, setItem, removeItem } from "./store.js";

const PREFS_KEY = "jym.prefs.v1";

/** 出厂默认（与「恢复默认」按钮一致）。 */
export const DEFAULT_PREFS = Object.freeze({
  players: 4,
  humans: [true, false, false, false],
  names: ["", "", "", ""],
  seasonOn: true,
  hutong: true,
  hutongDraw: false,
  monopoly: false,
  skillFree: false,
  seasonMode: "cell",
  seasonScale: 1,
  speed: 650,
  orient: "flat",
  walkMode: "manual",
  sound: true,
  cardMode: "manual",   // 翻牌提示：manual = 自己关（真人抽的卡等玩家点）；auto = 到点自己关
  cardMs: 6000,         // auto 模式（以及电脑抽的卡）停留时长：毫秒
});

const SPEEDS = [0, 300, 650, 1100];
const SEASON_MODES = ["cell", "player", "focus"];
const CARD_MODES = ["manual", "auto"];
const CARD_MSS = [3000, 6000, 9000, 15000];

const bool = (v, d) => (typeof v === "boolean" ? v : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const strArr = (v, d) => (Array.isArray(v)
  ? d.map((_, i) => (typeof v[i] === "string" ? v[i].slice(0, 8) : ""))
  : d.slice());

/** 读出设置；任何字段非法都回落到默认值（绝不因为脏数据启动失败）。 */
export function loadPrefs() {
  let raw = null;
  try { raw = JSON.parse(getItem(PREFS_KEY) || "null"); } catch { raw = null; }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFS, humans: [...DEFAULT_PREFS.humans], names: [...DEFAULT_PREFS.names] };

  const players = [2, 3, 4].includes(Number(raw.players)) ? Number(raw.players) : DEFAULT_PREFS.players;
  const humans = Array.isArray(raw.humans)
    ? [0, 1, 2, 3].map((i) => bool(raw.humans[i], DEFAULT_PREFS.humans[i]))
    : [...DEFAULT_PREFS.humans];
  if (!humans.slice(0, players).some(Boolean)) humans[0] = true;   // 至少一位真人

  return {
    players,
    humans,
    names: strArr(raw.names, DEFAULT_PREFS.names),
    seasonOn: bool(raw.seasonOn, DEFAULT_PREFS.seasonOn),
    hutong: bool(raw.hutong, DEFAULT_PREFS.hutong),
    hutongDraw: bool(raw.hutongDraw, DEFAULT_PREFS.hutongDraw),
    monopoly: bool(raw.monopoly, DEFAULT_PREFS.monopoly),
    skillFree: bool(raw.skillFree, DEFAULT_PREFS.skillFree),
    seasonMode: oneOf(raw.seasonMode, SEASON_MODES, DEFAULT_PREFS.seasonMode),
    seasonScale: Number(raw.seasonScale) === 2 ? 2 : 1,
    speed: SPEEDS.includes(Number(raw.speed)) ? Number(raw.speed) : DEFAULT_PREFS.speed,
    orient: oneOf(raw.orient, ["flat", "paper"], DEFAULT_PREFS.orient),
    walkMode: oneOf(raw.walkMode, ["manual", "auto"], DEFAULT_PREFS.walkMode),
    sound: bool(raw.sound, DEFAULT_PREFS.sound),
    cardMode: oneOf(raw.cardMode, CARD_MODES, DEFAULT_PREFS.cardMode),
    cardMs: oneOf(Number(raw.cardMs), CARD_MSS, DEFAULT_PREFS.cardMs),
  };
}

/** 写回设置（只覆盖已知字段，脏键不落库）。 */
export function savePrefs(patch) {
  const next = { ...loadPrefs(), ...(patch || {}) };
  const clean = {
    players: next.players, humans: next.humans.slice(0, 4), names: next.names.slice(0, 4),
    seasonOn: !!next.seasonOn, hutong: !!next.hutong, hutongDraw: !!next.hutongDraw,
    monopoly: !!next.monopoly, skillFree: !!next.skillFree,
    seasonMode: next.seasonMode, seasonScale: next.seasonScale,
    speed: next.speed, orient: next.orient, walkMode: next.walkMode, sound: !!next.sound,
    cardMode: oneOf(next.cardMode, CARD_MODES, DEFAULT_PREFS.cardMode),
    cardMs: oneOf(Number(next.cardMs), CARD_MSS, DEFAULT_PREFS.cardMs),
  };
  setItem(PREFS_KEY, JSON.stringify(clean));
  return clean;
}

/** 恢复默认（清掉本机记录）。 */
export function clearPrefs() {
  removeItem(PREFS_KEY);
  return { ...DEFAULT_PREFS, humans: [...DEFAULT_PREFS.humans], names: [...DEFAULT_PREFS.names] };
}
