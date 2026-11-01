/**
 * gamedata.js —— 数据层：加载并校验 gamedata.json。
 *
 * ⛔ 规则数据必须从 gamedata.json 动态读取，严禁在代码里硬编码地名或价格。
 * 本文件是"数据"与"规则"之间唯一的桥：内核（engine.js）只通过 GameData 取数。
 *
 * 权威来源：数据工作簿 v1.3 → export_game_data.py → gamedata.json（2026-10-07 导出）。
 */

export const EXPECTED = {
  cells: 40,
  landmarks: 28,
  identities: 8,
  decks: { chance: 20, destiny: 20, treasure: 20, season: 12 },
};

export class GameData {
  /** @param {object} raw gamedata.json 解析后的对象 */
  constructor(raw) {
    this.raw = raw;
    this.board = raw.board;
    this.landmarks = raw.landmarks;
    // cell(格号) -> 地标，键归一为数字
    this.byCell = {};
    for (const [k, v] of Object.entries(raw.landmark_by_cell)) this.byCell[Number(k)] = v;
    this.identities = raw.identities;
    this.seasons = raw.seasons;
    this.seasonOrder = raw.season_order;
    this.constantZones = new Set((raw.constant_zones || []).map((c) => c.zone));
    this.zones = raw.zones;
    this.decks = {
      chance: raw.deck_chance,
      destiny: raw.deck_destiny,
      treasure: raw.deck_treasure,
      season: raw.deck_season,
    };
    // 分区 -> 该分区上板的格子号列表
    this.zoneCells = {};
    for (const lm of this.landmarks) {
      (this.zoneCells[lm.zone] ||= []).push(lm.cell);
    }
  }

  landmarkAt(cell) { return this.byCell[cell]; }
  cellAt(idx) { return this.board[idx]; }

  /**
   * 结构性校验（对应 check_consistency.py 的权威数字）。
   * @returns {string[]} 问题列表；空数组 = 通过
   */
  validate() {
    const errs = [];
    const chk = (cond, msg) => { if (!cond) errs.push(msg); };
    chk(this.board.length === EXPECTED.cells, `棋盘格数应为 ${EXPECTED.cells}，实际 ${this.board.length}`);
    chk(this.landmarks.length === EXPECTED.landmarks, `地标数应为 ${EXPECTED.landmarks}，实际 ${this.landmarks.length}`);
    chk(this.identities.length === EXPECTED.identities, `身份卡应为 ${EXPECTED.identities}，实际 ${this.identities.length}`);
    for (const [k, n] of Object.entries(EXPECTED.decks)) {
      chk(this.decks[k].length === n, `牌堆 ${k} 应为 ${n} 张，实际 ${this.decks[k].length}`);
    }
    // 每个地标都能在棋盘上找到对应格，且类型为「地标」
    for (const lm of this.landmarks) {
      const c = this.board[lm.cell];
      chk(!!c, `地标「${lm.name}」的格号 ${lm.cell} 越界`);
      if (c) chk(c.type === "地标", `${lm.cell} 格类型应为地标，实际「${c.type}」`);
    }
    // 分数分组合计 = 地标总数
    const sumZone = Object.values(this.zoneCells).reduce((a, b) => a + b.length, 0);
    chk(sumZone === this.landmarks.length, `分区地块合计 ${sumZone} ≠ 地标数 ${this.landmarks.length}`);
    // 身份卡总估值极差 < 5%（桌游平衡门禁 G5）
    const totals = this.identities.map((i) => i.total);
    const spread = (Math.max(...totals) - Math.min(...totals)) / Math.min(...totals);
    chk(spread < 0.05, `身份卡总估值极差 ${(spread * 100).toFixed(2)}% 应 < 5%`);
    return errs;
  }
}

/** 浏览器：从 URL 加载。Node 测试请直接用 fs 读入后 new GameData(raw)。 */
export async function loadGameData(url = "./assets/data/gamedata.json") {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`加载 gamedata.json 失败：${res.status} ${url}`);
  return new GameData(await res.json());
}

export default GameData;
