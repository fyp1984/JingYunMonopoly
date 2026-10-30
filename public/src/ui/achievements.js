/**
 * achievements.js —— 儿童向「成就徽章」（即时正反馈）
 *
 * 为什么有它：40 轮的对局对孩子偏长，中途容易走神。这里在关键节点冒一枚小徽章
 * （第一块地、第一次收租、盖起四合院 / 城楼、小富翁、反超领先…），让孩子每几步
 * 就有一次「我做到了」的正反馈。
 *
 * 铁律：只读内核（g），不写内核、不消耗随机数 —— 与「同种子对拍」「存档重放」完全无关。
 * 新局（app.js attach）时调用 reset()，把一次性标记清干净。
 */

/** 每个玩家各有一份一次性标记：命中即发，发过不再发。 */
const fired = new Set();
let lastLeader = null;

/** 新局 / 读档时复位。 */
export function reset() {
  fired.clear();
  lastLeader = null;
}

/** 每位玩家的一次性成就：test 为真即解锁。 */
const PER_PLAYER = [
  { key: "firstLand", icon: "🏠", title: "第一块地", cap: "开始当房东啦", test: (g, p) => p.owned.size >= 1 },
  { key: "firstRent", icon: "💰", title: "第一次收租", cap: "别人踩到你的地，付你钱", test: (g, p) => p.rentGot > 0 },
  { key: "house", icon: "🏡", title: "盖起四合院", cap: "租金变贵一档", test: (g, p) => p.nBuild >= 1 },
  { key: "lands5", icon: "🏘️", title: "五块地", cap: "手里攒下五块地", test: (g, p) => p.owned.size >= 5 },
  { key: "rich", icon: "💎", title: "小富翁", cap: "现金到 ¥25,000", test: (g, p) => p.cash >= 25000 },
  { key: "tower", icon: "🏯", title: "盖起城楼", cap: "最高等级的建筑", test: (g, p) => [...p.owned.values()].some((lv) => lv >= 2) },
];

/** 全场一次性成就（与具体玩家无关）。 */
const GLOBAL = [
  { key: "season1", icon: "🍂", title: "第一次换季", cap: "某一片的地变贵了", test: (g) => g.seasonChanges >= 1 },
];

/** 当前总资产领先者（只算存活玩家）；并列或无人时返回 null。 */
function leaderIdx(g) {
  const alive = g.players.filter((p) => p.alive);
  if (alive.length < 2) return null;
  const top = alive.reduce((a, b) => (b.assets > a.assets ? b : a));
  const tie = alive.some((p) => p !== top && p.assets === top.assets);
  return tie ? null : top.idx;
}

/**
 * 检查一次棋局状态，返回本次新解锁的徽章列表（可能为空）。
 * @param {object} g 内核 Game 实例（只读）
 * @returns {Array<{icon:string,title:string,cap:string,who:string|null}>}
 */
export function check(g) {
  const got = [];
  for (const p of g.players) {
    for (const a of PER_PLAYER) {
      const k = `${p.idx}:${a.key}`;
      if (fired.has(k)) continue;
      if (a.test(g, p)) { fired.add(k); got.push({ icon: a.icon, title: a.title, cap: a.cap, who: p.name }); }
    }
  }
  for (const a of GLOBAL) {
    if (fired.has(a.key)) continue;
    if (a.test(g)) { fired.add(a.key); got.push({ icon: a.icon, title: a.title, cap: a.cap, who: null }); }
  }
  // 反超领先：第 5 轮后才算数，避免开局反复横跳就报喜
  const lead = leaderIdx(g);
  if (lead !== null) {
    if (lastLeader !== null && lead !== lastLeader && g.round >= 5) {
      got.push({ icon: "📈", title: "反超领先", cap: "总资产第一换人了", who: g.players[lead].name });
    }
    lastLeader = lead;
  }
  return got;
}
