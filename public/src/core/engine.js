/**
 * engine.js —— 《京韵大富翁·胡同漫游记》规则内核（engine.py 的 1:1 移植）
 *
 * 三条硬约束（见《设计方案定稿》：
 *   /Users/sevensimle/Documents/@西北人的成长/10-Projects/个人项目/童领计划/京韵大富翁_胡同漫游记/01_项目定义/02_游戏设计书/设计方案定稿.md ）：
 *   ① 数据零硬编码：一切地名/价格/文案来自 gamedata.json。
 *   ② 常量逐条对齐 rules.js（= engine.py 的 RULES_PATCH）。
 *   ③ 与 engine.py「同种子对拍」：同一种子下整局结果逐步一致（tests/parity）。
 *
 * 平台无关：本文件零 DOM 依赖，浏览器 / Node / 未来小程序三端共用。
 *
 * 与 Python 的三点实现差异（不影响随机序列与结果）：
 *   - Python 的 dict 保插入序 → 这里用 Map（JS 对象对数字键会按数值升序，会破坏
 *     _liquidate 的稳定排序语义）。
 *   - Python Counter → 这里用内置 Counter（Map 实现，get 默认 0）。
 *   - 决策点（买地 / 建房 / 背包客走位）改成可插拔异步 provider，默认 AI。
 *     AI 决策不消耗随机数，因此「AI 模式」的随机序列与 Python 完全一致。
 */

import { RULES_PATCH, HUTONG_ZONE } from "./rules.js";

// ------------------------------------------------------------------
// 小工具
// ------------------------------------------------------------------

/** 等价 Python collections.Counter 的最小子集（get 默认 0，加法自动初始化）。 */
export class Counter {
  constructor() { this.map = new Map(); }
  get(k, d = 0) { return this.map.has(k) ? this.map.get(k) : d; }
  set(k, v) { this.map.set(k, v); return v; }
  add(k, v = 1) { return this.set(k, this.get(k) + v); }
  has(k) { return this.map.has(k); }
  toObject() { return Object.fromEntries(this.map); }
}

/** 等价 Python dict：数字键 + 保插入序。 */
export class OrderedDict {
  constructor() { this.map = new Map(); }
  get(k, d = undefined) { return this.map.has(k) ? this.map.get(k) : d; }
  set(k, v) { this.map.set(k, v); return this; }
  has(k) { return this.map.has(k); }
  delete(k) { return this.map.delete(k); }
  keys() { return [...this.map.keys()]; }
  get size() { return this.map.size; }
}

/** 等价 Python f"{n:,}"（千分位，负号在前）。用于日志逐字对拍。 */
export function num(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

/**
 * 等价 Python 内置 round()：银行家舍入（.5 取偶）。
 * JS 的 Math.round 是 .5 向上取整，与 Python 不同 —— 租金算式的零头会漂。
 */
export function pyround(x) {
  const f = Math.floor(x);
  if (x - f !== 0.5) return Math.round(x);
  return (f % 2 === 0) ? f : f + 1;
}

/** 等价 Python round(x, nd)。 */
export function roundN(x, nd) {
  const p = 10 ** nd;
  const a = Math.abs(x) * p;
  const f = Math.floor(a);
  let r;
  if (Math.abs(a - f - 0.5) < 1e-9) r = (f % 2 === 0) ? f : f + 1;
  else r = Math.round(a);
  return (x < 0 ? -r : r) / p;
}

// ------------------------------------------------------------------
// 数据装载结果（由 gamedata.js 的 GameData 提供；此处只声明用法）
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// 玩家
// ------------------------------------------------------------------
export class Player {
  /**
   * @param {number} idx 座位号
   * @param {object} identity 身份卡（来自 gamedata.identities）
   * @param {number} pawns 该玩家操控的棋子数（多子补丁，默认 1）
   */
  constructor(idx, identity, pawns = 1) {
    this.idx = idx;
    this.id = identity.code;
    this.name = identity.name;
    this.identity = identity;
    this.kind = "ai";            // ai | human（UI 用；不影响内核）
    this.cash = identity.cash;
    // 多棋子共享同一现金池与地产，只是落点变多 —— 抬高 2 人局的碰撞率。
    this.poss = new Array(Math.max(1, Math.trunc(pawns))).fill(0);
    this.cur = 0;
    this.owned = new Map();      // cell -> level(0 空地/1 四合院/2 城楼)
    this.alive = true;
    this.skipNext = 0;           // 休息回合数
    this.rerollTokens = 0;       // 重掷次数
    this.props = new Counter();  // 折扣券 / 免罚券 / 额度等
    this.seasonChanges = 0;
    this.rentPaid = 0;
    this.rentGot = 0;
    this.tasksDone = 0;
    this.tasksTotal = 0;
    this.nRentPaid = 0;
    this.nRentGot = 0;
    this.nBuild = 0;
    this.nPassGo = 0;
    this.nTreasure = 0;
    this.nTurn = 0;
    this.cardCash = 0;
    this.cardCashByDeck = new Counter();
    this.cardNByDeck = new Counter();
    this.zoneCost = new Counter();
    this.zoneRentGot = new Counter();
    this.rentFreeRound = -1;     // 免租到第几轮（季节卡 #12 路面滑）
    this.skillUsed = 0;
    this.pendingMove = 0;
    this.debt = 0;
    // 本次停留的地块「在结算前」是否已归自己 —— 建房门槛：必须是走回来的旧地，
    // 而不是本回合刚买下的新地（见 buildOptions）。每回合 land() 开头刷新。
    this.landedWasOwned = false;
  }

  /** 当前棋子位置。多棋子时随 p.cur 切换，对内核其余部分透明。 */
  get pos() { return this.poss[this.cur]; }
  set pos(v) { this.poss[this.cur] = v; }

  /** 总资产 = 现金 + 地产市值（含建筑投入）。 */
  get assets() {
    let v = this.cash;
    for (const [cell, lvl] of this.owned) {
      const lm = this._lm(cell);
      v += lm.price + lvl * lm.build;
    }
    return v;
  }
}

// ------------------------------------------------------------------
// 牌堆
// ------------------------------------------------------------------
export class Deck {
  constructor(cards, rng) {
    this.src = cards.slice();
    this.rng = rng;
    this.pile = [];
    this.reshuffles = 0;
    this.reshuffle();
  }
  reshuffle() {
    this.pile = this.src.slice();
    this.rng.shuffle(this.pile);
  }
  draw() {
    if (this.pile.length === 0) { this.reshuffle(); this.reshuffles++; }
    return this.pile.pop();
  }
}

// ------------------------------------------------------------------
// 对局
// ------------------------------------------------------------------
export class Game {
  /**
   * @param {import('./gamedata.js').GameData} data
   * @param {object} opts
   *   nPlayers, seed, seasonOn, verbose, log, buildRule, skillLimit,
   *   seasonMode, hutong, seasonScale, hutongDraw, hutongFlat, pawns,
   *   decisions（默认 AI provider）
   */
  constructor(data, opts = {}) {
    const R = RULES_PATCH;
    this.d = data;
    this.rng = opts.rng;                    // PyRandom 实例（同种子对拍的关键）
    if (!this.rng) throw new Error("Game 需要传入 rng（PyRandom 实例）");
    this.n = opts.nPlayers ?? 4;
    this.pawns = Math.max(1, Math.trunc(opts.pawns ?? 1));
    this.seasonOn = opts.seasonOn ?? true;
    this.verbose = opts.verbose ?? false;
    this.log = opts.log ?? [];
    this.goSalary = R.go_salary.value;
    this.maxRounds = R.max_rounds.value;
    this.aiSafe = R.ai_safety_cash.value;
    this.taskRate = R.task_success_rate.value;
    this.buildRule = opts.buildRule || R.build_rule.value;
    this.skillLimit = opts.skillLimit === undefined ? R.skill_limit.value : opts.skillLimit;
    this.seasonMode = opts.seasonMode ?? R.season_mode.value;
    this.offzoneBonus = R.season_offzone_bonus.value;
    this.hutong = opts.hutong === undefined ? R.hutong_treasure.value : opts.hutong;
    this.hutongPer = R.hutong_per_draw.value;
    this.hutongMax = R.hutong_max_extra.value;
    this.hutongZone = HUTONG_ZONE;
    this.hutongBonus = this.hutong ? R.hutong_bonus.value : 0.0;
    this.hutongDraw = opts.hutongDraw === undefined ? R.hutong_draw.value : opts.hutongDraw;
    this.hutongFlat = opts.hutongFlat ?? null;
    if (this.hutongFlat === null && this.hutongBonus === 0.0) this.hutongFlat = undefined; // 与 Python 的 None 等价
    this.seasonScale = opts.seasonScale === undefined ? R.season_scale.value : opts.seasonScale;
    this.decisions = opts.decisions;
    this.hooks = null;                      // play() 时装配，供 UI 分步驱动
    // UI 观察点：每张卡结算完同步回调一次（onCard(game, deck, player, card, delta)）。
    // 同步、不 await、不消耗随机数 → 不影响与 engine.py 的同种子对拍。
    this.onCard = null;

    // 发身份卡（随机抽 n 张）
    const ids = this.rng.sample(data.identities, this.n);
    this.players = ids.map((ident, i) => new Player(i, ident, this.pawns));
    for (const p of this.players) p._lm = (cell) => data.byCell[cell];

    this.decks = {};
    for (const [k, v] of Object.entries(data.decks)) this.decks[k] = new Deck(v, this.rng);

    this.cardLog = new Map();
    this.season = null;
    this.seasonChanges = 0;
    this.round = 0;
    this.ownerOf = new Map();   // cell -> player idx
    this.turnCount = 0;
    this.borrows = [];
    this._openingSkills();
  }

  // ---------------- 工具 ----------------
  say(s) { this.log.push(s); if (this.verbose) console.log(s); }
  lm(cell) { return this.d.byCell[cell]; }
  posCell(i) { return this.d.board[i]; }

  /** 剩余可用技能次数。None(undefined) = 不限。 */
  skillLeft(p) { return this.skillLimit ? this.skillLimit - p.skillUsed : undefined; }
  useSkill(p) {
    if (!this.skillLimit) return true;
    if (p.skillUsed >= this.skillLimit) return false;
    p.skillUsed++;
    return true;
  }

  _openingSkills() {
    for (const p of this.players) {
      p.skillUsed = 0;
      if (p.id === "I-01") {
        const cands = [];
        for (let c = 1; c < 7; c++) if (this.d.byCell[c]) cands.push(c);
        if (cands.length) {
          const c = this.rng.choice(cands);
          p.owned.set(c, 0);
          this.ownerOf.set(c, p.idx);
          this.say(`  [${p.name}] 开局免费取得 ${this.lm(c).name}`);
        }
      } else if (p.id === "I-07") {
        p.rerollTokens = 3;
      } else if (p.id === "I-08") {
        for (let i = 0; i < 3; i++) this._resolveCard("chance", p, this.decks.chance.draw());
        p.debt = 2000;
        p.debtTimes = 2;
      }
    }
  }

  // ---------------- 收租计算 ----------------
  rentOf(cell, owner) {
    const lm = this.lm(cell);
    const lvl = owner.owned.get(cell, 0);
    let base = lvl === 0 ? lm.rent0 : (lvl === 1 ? lm.rent1 : lm.rent2);
    if (this.seasonOn && this.season) {
      const sd = this.d.seasons[this.season];
      const sz = sd.bonus_zone !== undefined ? sd.bonus_zone : sd.zone;
      const full = sd.bonus * this.seasonScale;
      const off = this.offzoneBonus * this.seasonScale;
      if (this.seasonMode === "cell") {
        if (lm.zone === sz) base = pyround(base * (1 + full));
      } else if (this.seasonMode === "player" || this.seasonMode === "focus") {
        if (this.holdsZoneAny(owner, sz)) {
          if (lm.zone === sz) base = pyround(base * (1 + full));
          else if (this.seasonMode === "focus") base = pyround(base * (1 + off));
          else base = pyround(base * (1 + full));
        }
      }
    }
    if (this.hutong && lm.zone === this.hutongZone
      && this.zoneCount(owner, this.hutongZone) >= RULES_PATCH.hutong_cluster.value.n) {
      base = pyround(base * (1 + RULES_PATCH.hutong_cluster.value.bonus));
    }
    return base;
  }

  ownsZone(p, zone) {
    const cells = this.d.zoneCells[zone] || [];
    return cells.length > 0 && cells.every((c) => p.owned.has(c));
  }
  holdsZoneAny(p, zone) { return (this.d.zoneCells[zone] || []).some((c) => p.owned.has(c)); }
  zoneCount(p, zone) { return (this.d.zoneCells[zone] || []).filter((c) => p.owned.has(c)).length; }

  // ---------------- 现金变动 ----------------
  _grant(p, amount, reason = "") {
    // 现金永不为负：要扣钱但现金不够时，先自动变卖资产（拆建筑 / 抵押）补齐；
    // 卖光仍不够就只扣到 0 —— 家庭版不引入「负债」概念。口径与 engine.py 一致。
    if (amount < 0 && p.cash < -amount) {
      this._liquidate(p, -amount);
      if (p.cash < -amount) amount = -p.cash;
    }
    p.cash += amount;
    const tag = reason ? `（${reason}）` : "";
    if (amount) this.say(`    ${p.name} ${amount > 0 ? "收入" : "支出"} ¥${num(Math.abs(amount))}${tag}`);
  }

  // ---------------- 卡牌结算 ----------------
  _resolveCard(deck, p, card) {
    const before = p.cash;
    const beforeOthers = new Map();
    for (const q of this.players) if (q !== p) beforeOthers.set(q.idx, q.cash);
    if (deck === "chance") this._resolveChance(p, card);
    else if (deck === "destiny") this._resolveDestiny(p, card);
    else if (deck === "treasure") this._resolveTreasure(p, card);
    else if (deck === "season") this._resolveSeason(p, card);
    else throw new Error(`未知牌堆：${deck}`);
    const delta = p.cash - before;
    let give = 0;
    for (const q of this.players) if (q !== p) give += q.cash - beforeOthers.get(q.idx);
    p.cardCash += delta;
    p.cardCashByDeck.add(deck, delta);
    p.cardNByDeck.add(deck, 1);
    const key = `${deck}:${card.no}`;
    const e = this.cardLog.get(key) || { n: 0, cash: 0, hit: 0, give: 0 };
    e.n += 1; e.cash += delta; e.give += give;
    if (delta) e.hit += 1;
    this.cardLog.set(key, e);
    if (this.onCard) this.onCard(this, deck, p, card, delta);
    return delta;
  }

  _resolveChance(p, c) {
    const v = c.value, eff = c.effect;
    if (eff === "现金") this._grant(p, v, c.theme);
    else if (eff === "移动") p.pendingMove += v;
    else if (eff === "折扣") p.props.add(`discount_${Math.abs(v)}`, 1);
    else if (eff === "道具") {
      if (c.text.includes("重掷")) p.rerollTokens += 1;
      else p.props.add("item", 1);
    } else if (eff === "规则") p.props.add("extra_treasure", 1);
    else if (eff === "交易") { /* 自愿交换，模拟里跳过 */ }
  }

  _resolveDestiny(p, c) {
    const v = c.value, eff = c.effect;
    if (p.props.get("plan_b") > 0 && v < 0) {
      p.props.add("plan_b", -1);
      this.say(`    ${p.name} 用掉 Plan B，免除「${c.theme}」惩罚`);
      return;
    }
    if (eff === "现金") this._grant(p, v, c.theme);
    else if (eff === "移动") {
      if (v === 1500) { p.pos = 0; this._grant(p, 1500, "退回起点安慰金"); }
      else p.pendingMove += v;
    } else if (eff === "回合") p.skipNext += 1;
    else if (eff === "选择") {
      if (this.rng.random() < this.taskRate) {
        if (v > 0) this._grant(p, v, "完成小任务");
        p.tasksDone += 1;
      } else if (v < 0) this._grant(p, v, "未完成");
      p.tasksTotal += 1;
    } else if (eff === "规则") {
      if (c.text.includes("减半")) p.props.add("half_next", 1);
      else if (c.text.includes("不能寻宝")) p.props.add("no_treasure_turn", 1);
      else if (c.text.includes("不能使用技能")) p.props.add("no_skill_turn", 1);
    } else if (eff === "道具") p.rerollTokens += 1;
  }

  _resolveTreasure(p, c) {
    let v = c.value;
    const eff = c.effect, kind = c.kind || "";
    if (v > 0 && this.hutong) {
      const hc = this.zoneCount(p, this.hutongZone);
      if (hc) {
        if (this.hutongFlat) v = v + this.hutongFlat * hc;
        else if (this.hutongBonus) v = pyround(v * (1 + hc * this.hutongBonus));
      }
    }
    p.tasksTotal += 1;
    if (kind === "陷阱") {
      if (this.rng.random() < this.taskRate) {
        this.say(`    ${p.name} 化解陷阱「${c.theme}」`);
        p.tasksDone += 1;
        return;
      }
      if (eff === "现金") this._grant(p, v, "陷阱");
      else if (eff === "移动") p.pendingMove += v;
      else if (eff === "规则") p.props.add("no_treasure_turn", 1);
      return;
    }
    const ok = this.rng.random() < this.taskRate;
    if (!ok) { this.say(`    ${p.name} 任务未成（无惩罚）：${(c.task || "").slice(0, 20)}`); return; }
    p.tasksDone += 1;
    if (eff === "现金") this._grant(p, v, "寻宝");
    else if (eff === "挑战") this._grant(p, v, "挑战成功");
    else if (eff === "移动") p.pendingMove += v;
    else if (eff === "道具") {
      if (c.text.includes("Plan B")) p.props.add("plan_b", 1);
      else if (c.text.includes("免过路费")) p.props.add("free_rent", 1);
      else if (c.text.includes("重抽")) p.props.add("redraw", 1);
      else p.props.add("item", 1);
    } else if (eff === "规则") p.props.add("rent_bonus_20", 1);
    else if (eff === "选择") { if (v < 0) this._grant(p, v, "未开口"); }
  }

  /** 下一位还活着的玩家（确定性，非随机）。 */
  nextPlayer(p) {
    for (let k = 1; k < this.n; k++) {
      const q = this.players[(p.idx + k) % this.n];
      if (q.alive && q !== p) return q;
    }
    return null;
  }
  /** 上一位还活着的玩家（「刚刚走过棋的那位」）。 */
  prevPlayer(p) {
    for (let k = 1; k < this.n; k++) {
      const q = this.players[(p.idx - k + this.n) % this.n];
      if (q.alive && q !== p) return q;
    }
    return null;
  }
  /** 随便挑一个还活着的别的玩家（互动类卡）。 */
  someoneElse(p) {
    const cands = this.players.filter((q) => q !== p && q.alive);
    return cands.length ? this.rng.choice(cands) : null;
  }

  _resolveSeason(p, c) {
    const zone = c.to_zone || "";
    const s = (zone.includes("｜") ? zone.split("｜", 1)[0] : zone).trim();
    if (Object.prototype.hasOwnProperty.call(this.d.seasons, s)) {
      if (this.season !== s) {
        this.seasonChanges += 1;
        const effB = this.d.seasons[s].bonus * this.seasonScale;
        const how = Math.abs(effB - 1.0) < 1e-9 ? "翻倍"
          : `${effB >= 0 ? "+" : ""}${pyround(effB * 100)}%`;
        this.say(`    ★ 换季：${this.season || "无"} → ${s}（${this.d.seasons[s].zone} 租金 ${how}）`);
      }
      this.season = s;
    }
    const eff = c.effect, v = c.value;
    if (eff === "现金") this._grant(p, v, `${s}季`);
    else if (eff === "选择") this._grant(p, v, "买水");
    else if (eff === "移动") p.pendingMove += 1;
    else if (eff === "讲解") { if (this.rng.random() < this.taskRate) this._grant(p, v, "30 秒讲解"); }
    else if (eff === "口播") { if (this.rng.random() < this.taskRate) this._grant(p, v, "半步口播"); }
    else if (eff === "寻宝") p.props.add("extra_treasure", 1);
    else if (eff === "赠券") {
      const nxt = this.nextPlayer(p);
      if (nxt) this._grant(nxt, v, `${p.name} 送的赏花券`);
    } else if (eff === "共游") {
      const other = this.someoneElse(p);
      this._grant(p, v, "共游");
      if (other) this._grant(other, v, "共游（对方）");
    } else if (eff === "拼车") {
      p.pendingMove += 1;
      const nxt = this.nextPlayer(p);
      if (nxt) nxt.pendingMove += 1;
    } else if (eff === "问答") {
      this.say(`    ${p.name} 发起一次问答（不涉及钱）`);
    } else if (eff === "借地") {
      this._seasonBorrow(p, v);
    } else if (eff === "免租") {
      p.rentFreeRound = this.round;
      this.say(`    ${p.name} 本回合免租金`);
    } else {
      this.say(`    [未实现] 季节卡效果类型「${eff}」（#${c.no}）`);
    }
  }

  _seasonBorrow(p, fee) {
    const lender = this.prevPlayer(p);
    if (lender === null || lender.owned.size === 0) {
      this.say(`    ${p.name} 想借地，但没处可借，这张卡作废`);
      return;
    }
    const cells = [...lender.owned.keys()].sort((a, b) => a - b);
    const cell = this.rng.choice(cells);
    this._grant(p, -fee, `借 ${this.lm(cell).name}`);
    this._grant(lender, fee, "出借地块");
    this.borrows.push({ cell, lender: lender.idx, borrower: p.idx, until: this.round });
    this.say(`    ${p.name} 借走 ${lender.name} 的 ${this.lm(cell).name}（本轮）`);
  }

  _borrowerOf(cell) {
    if (this.borrows.length) this.borrows = this.borrows.filter((b) => b.until >= this.round);
    for (const b of this.borrows) if (b.cell === cell) return b;
    return null;
  }

  // ---------------- 移动与落格 ----------------
  move(p, steps) {
    const old = p.pos;
    const crossed = (old + steps) >= 40;
    p.pos = (p.pos + steps) % 40;
    if (crossed && steps > 0) {
      this._grant(p, this.goSalary, "过路钱");
      p.nPassGo += 1;
      if (this.seasonOn) {
        const card = this.decks.season.draw();
        this.say(`  ${p.name} 过起点，抽季节卡：${card.text.slice(0, 26)}`);
        this._resolveCard("season", p, card);
      }
    }
    return p.pos;
  }

  async land(p) {
    // 在本次停留结算（含买地）之前先记下：这块地是不是早就归自己了。
    // 建房只能加在「走回来的旧地」上，不能加在本回合刚落下的新地上。
    p.landedWasOwned = p.owned.has(p.pos);
    const cell = this.posCell(p.pos);
    const t = cell.type;
    if (t === "地标") await this._landProperty(p, p.pos);
    else if (t === "角") {
      if (p.pos === 0) { /* 过路钱已在 move 结算 */ }
      else if (p.pos === 10) this.say(`  ${p.name} 在胡同口歇脚，无事发生`);
      else if (p.pos === 20) this.say(`  ${p.name} 在什刹海茶棚歇脚`);
      else if (p.pos === 30) { this.say(`  ${p.name} 迷路了，被请去喝茶 → 移到第 10 格`); p.pos = 10; }
    } else if (t === "寻宝") {
      if (p.props.get("no_treasure_turn") > 0) {
        p.props.add("no_treasure_turn", -1);
        this.say(`  ${p.name} 本回合不能寻宝`);
      } else {
        let n = 1;
        if (this.hutong && this.hutongDraw) {
          const hc = this.zoneCount(p, this.hutongZone);
          const extra = Math.min(this.hutongMax, Math.floor(hc / this.hutongPer));
          if (extra) { n += extra; this.say(`    【胡同通】${p.name} 持有 ${hc} 块胡同地，额外抽 ${extra} 张寻宝卡`); }
        }
        while (p.props.get("extra_treasure") > 0) { p.props.add("extra_treasure", -1); n += 1; this.say(`    ${p.name} 用掉「再寻一次宝」`); }
        for (let i = 0; i < n; i++) {
          const card = this.decks.treasure.draw();
          this.say(`  ${p.name} 寻宝：${card.text.slice(0, 30)}`);
          this._resolveCard("treasure", p, card);
          p.nTreasure += 1;
        }
      }
    } else if (t === "机会") {
      let card = this.decks.chance.draw();
      this.say(`  ${p.name} 机会：${card.text.slice(0, 30)}`);
      this._resolveCard("chance", p, card);
    } else if (t === "命运") {
      let card = this.decks.destiny.draw();
      this.say(`  ${p.name} 命运：${card.text.slice(0, 30)}`);
      if (p.props.get("redraw") > 0 && card.value < 0) {
        p.props.add("redraw", -1);
        card = this.decks.destiny.draw();
        this.say(`    重抽：${card.text.slice(0, 30)}`);
      }
      this._resolveCard("destiny", p, card);
    }
  }

  async _landProperty(p, cell) {
    const ownerIdx = this.ownerOf.has(cell) ? this.ownerOf.get(cell) : null;
    const lm = this.lm(cell);
    if (ownerIdx === null) {
      const price = lm.price;
      const buy = await this.decisions.shouldBuy(this, p, lm);
      if (buy) {
        p.cash -= price;
        p.owned.set(cell, 0);
        this.ownerOf.set(cell, p.idx);
        p.zoneCost.add(lm.zone, price);
        this.say(`  ${p.name} 买下 ${lm.name}（¥${num(price)}）`);
      } else {
        this.say(`  ${p.name} 放弃 ${lm.name}（¥${num(price)}）`);
      }
      return;
    }
    if (ownerIdx === p.idx) { this.say(`  ${p.name} 回到自己的 ${lm.name}`); return; }
    const owner = this.players[ownerIdx];
    if (!owner.alive) return;
    if (p.rentFreeRound === this.round) {
      this.say(`  ${p.name} 停在 ${owner.name} 的 ${lm.name}，【路面滑】本回合免租（省 ¥${num(this.rentOf(cell, owner))}）`);
      return;
    }
    let rent = this.rentOf(cell, owner);
    if (p.id === "I-02" && this.useSkill(p)) rent = Math.max(0, rent - 200);
    if (owner.id === "I-06" && this.useSkill(owner)) rent += 100;
    if (owner.id === "I-04" && this.useSkill(owner)) { this.say(`    ${owner.name} 做了 30 秒讲解，本次收租 +¥500`); rent += 500; }
    if (owner.props.get("rent_bonus_20") > 0) { owner.props.add("rent_bonus_20", -1); rent = pyround(rent * 1.2); }
    if (p.props.get("free_rent") > 0) { p.props.add("free_rent", -1); this.say(`  ${p.name} 用掉免过路费券`); return; }
    let recipient = owner;
    const b = this._borrowerOf(cell);
    if (b && b.borrower !== owner.idx) {
      recipient = this.players[b.borrower];
      if (recipient.alive) this.say(`    【借地】本轮租金归 ${recipient.name}`);
      else recipient = owner;
    }
    if (recipient === p) { this.say(`  ${p.name} 停在自己借来的 ${lm.name}，不用付租`); return; }
    this.say(`  ${p.name} 停在 ${owner.name} 的 ${lm.name}，付租 ¥${num(rent)}`);
    owner.zoneRentGot.add(lm.zone, rent);
    this._pay(p, recipient, rent);
    if (this.hutong && lm.zone === this.hutongZone && owner.alive) {
      const card = this.decks.treasure.draw();
      this.say(`    【胡同寻宝】${owner.name} 带 ${p.name} 逛胡同，寻宝：${card.text.slice(0, 24)}`);
      this._resolveCard("treasure", owner, card);
      owner.nTreasure += 1;
    }
  }

  _pay(p, to, amount) {
    if (p.cash >= amount) {
      p.cash -= amount; to.cash += amount;
      p.rentPaid += amount; to.rentGot += amount;
      p.nRentPaid += 1; to.nRentGot += 1;
      return true;
    }
    this.say(`    ${p.name} 现金不足（¥${num(p.cash)} < ¥${num(amount)}），变卖资产`);
    this._liquidate(p, amount);
    if (p.cash >= amount) {
      p.cash -= amount; to.cash += amount;
      p.rentPaid += amount; to.rentGot += amount;
      p.nRentPaid += 1; to.nRentGot += 1;
      return true;
    }
    to.cash += Math.max(0, p.cash);
    p.cash = 0;
    p.alive = false;
    for (const c of [...p.owned.keys()]) { this.ownerOf.set(c, to.idx); to.owned.set(c, p.owned.get(c)); }
    p.owned.clear();
    this.say(`    ☠ ${p.name} 破产出局，资产归 ${to.name}`);
    return false;
  }

  _liquidate(p, need) {
    // 先拆建筑（退半价）：按等级降序稳定排序（等价 Python sorted(key=-level)）
    const byLevel = [...p.owned.keys()].sort((a, b) => p.owned.get(b) - p.owned.get(a));
    for (const cell of byLevel) {
      if (p.cash >= need) return;
      let lvl = p.owned.get(cell);
      const lm = this.lm(cell);
      while (lvl > 0 && p.cash < need) {
        const back = Math.floor(lm.build / 2);
        p.cash += back;
        p.owned.set(cell, lvl - 1);
        this.say(`    拆 ${lm.name} 一级，退 ¥${num(back)}`);
        lvl -= 1;
      }
    }
    // 再抵押：按格号升序
    const byCell = [...p.owned.keys()].sort((a, b) => a - b);
    for (const cell of byCell) {
      if (p.cash >= need) return;
      const lm = this.lm(cell);
      p.cash += lm.mortgage;
      p.owned.delete(cell);
      this.ownerOf.delete(cell);
      this.say(`    抵押 ${lm.name}，得 ¥${num(lm.mortgage)}`);
    }
  }

  // ---------------- 局面评估（AI 用） ----------------
  maxRentOnBoard() {
    let m = 0;
    for (const [cell, ownerIdx] of this.ownerOf) {
      const o = this.players[ownerIdx];
      m = Math.max(m, this.rentOf(cell, o));
    }
    return m;
  }
  dangerOf(p, steps) {
    const c = (p.pos + steps) % 40;
    const cell = this.posCell(c);
    if (cell.type !== "地标") return 0;
    const oi = this.ownerOf.has(c) ? this.ownerOf.get(c) : null;
    if (oi === null || oi === p.idx) return 0;
    return this.rentOf(c, this.players[oi]);
  }

  // ---------------- 建房（AI 与人类玩家共用同一套规则） ----------------
  /** 活命钱：随场上最高租金水涨船高。 */
  safetyLine() { return Math.max(this.aiSafe, Math.trunc(this.maxRentOnBoard() * 1.5)); }

  /**
   * 可建房的候选清单。与 engine.py `_ai_build` 的候选过滤逐条一致。
   * `affordable` = 建完仍不低于活命钱（AI 只在这些里挑；人类可看到但按钮禁用）。
   *
   * 建房规则（按线下大富翁口径，取代旧版「有钱就能到处加盖」）：
   *   ① 第一轮只能占空地，不建房；
   *   ② 从第二轮起，只有**本回合停留的正是自己先前已占下的地块**才能加盖；
   *   ③ 每回合最多 1 级（空地 → 四合院 → 城楼）。
   * 因为候选只可能是「脚下这一格」，清单长度恒为 0 或 1。
   */
  buildOptions(p) {
    const out = [];
    if (this.round < 2) return out;                 // ① 第一轮只占空地
    const cell = p.pos;
    if (!p.owned.has(cell) || !p.landedWasOwned) return out;  // ② 走回来的旧地
    const lvl = p.owned.get(cell);
    if (lvl >= RULES_PATCH.build_levels.value) return out;    // ③ 已到顶（城楼）
    const lm = this.lm(cell);
    if (this.buildRule === "monopoly" && !this.ownsZone(p, lm.zone)) return out;
    let cost = lm.build;
    if (p.id === "I-05") cost = Math.max(0, cost - 200); // 京味手艺人：建房便宜 ¥200
    const gain = (lvl === 1 ? lm.rent2 : lm.rent1) - (lvl === 1 ? lm.rent1 : lm.rent0);
    const safe = this.safetyLine();
    out.push({ cell, lvl, cost, gain, ratio: gain / Math.max(cost, 1), affordable: p.cash - cost >= safe });
    return out;
  }

  /** 执行一次建房（不判定可行性，调用方负责）。 */
  applyBuild(p, cell) {
    const lm = this.lm(cell);
    let cost = lm.build;
    if (p.id === "I-05") cost = Math.max(0, cost - 200);
    p.cash -= cost;
    p.owned.set(cell, p.owned.get(cell) + 1);
    p.nBuild += 1;
    p.zoneCost.add(lm.zone, cost); // v1.5 分区记账：建房也算投入
    this.say(`  ${p.name} 在 ${lm.name} 建到 ${p.owned.get(cell)} 级（¥${num(cost)}）`);
    return true;
  }

  /** UI 分步钩子：未注册 = 纯 no-op，不影响随机序列（同种子对拍前提）。 */
  async _hook(name, ...args) {
    const h = this.hooks && this.hooks[name];
    if (h) await h(this, ...args);
  }

  _roll(p) {
    const a = this.rng.randint(1, 6), b = this.rng.randint(1, 6);
    if (p.props.get("half_next") > 0) { p.props.add("half_next", -1); return Math.floor((a + b) / 2); }
    return a + b;
  }

  // ---------------- 回合主循环 ----------------
  /**
   * 跑完整局（AI 或人机混战）。返回与 engine.py play() 同构的结果对象。
   * @param {object} [hooks] 可选：{ afterTurn: async (game) => {} } 供 UI 逐步刷新
   */
  async play(hooks = {}) {
    this.hooks = hooks;                       // 供 UI 分步驱动；无钩子时等价于纯自动
    let alive = this.players.filter((p) => p.alive);
    let stop = false;
    while (alive.length > 1 && this.round < this.maxRounds) {
      this.round += 1;
      for (const p of this.players) {
        if (stop) break;
        if (!p.alive) continue;
        if (p.skipNext > 0) { p.skipNext -= 1; this.say(`第${this.round}轮 ${p.name} 休息一回合`); continue; }
        for (let k = 0; k < this.pawns; k++) {
          p.cur = k;
          const tag = this.pawns > 1 ? `#${k + 1}` : "";
          this.turnCount += 1;
          p.nTurn += 1;
          this.say(`第${this.round}轮 ${p.name}${tag}(¥${num(p.cash)}) @${p.pos} ${this.posCell(p.pos).name}`);

          if (p.debt > 0 && this.round % 4 === 0) {
            const pay = Math.min(1000, p.debt);
            if (p.cash < pay) this._liquidate(p, pay); // 现金不够先变卖资产
            const paid = Math.min(pay, p.cash);        // 卖光也只还得起这么多
            p.cash -= paid; p.debt -= paid;
            this.say(`    ${p.name} 还款 ¥${num(paid)}，剩余 ¥${num(p.debt)}`);
          }

          await this._hook("beforeTurn", p, k);
          let steps = this._roll(p);
          if (p.rerollTokens > 0 && steps <= 5) {
            p.rerollTokens -= 1;
            steps = this._roll(p);
            this.say(`    重掷 → ${steps}`);
          }
          if (p.pendingMove) { steps += p.pendingMove; p.pendingMove = 0; }
          if (p.id === "I-03" && this.useSkill(p)) steps = await this.decisions.adjustMove(this, p, steps);
          await this._hook("beforeMove", p, steps);
          this.move(p, steps);
          this.say(`    掷 ${steps} → 第 ${p.pos} 格`);
          await this.land(p);
          await this._hook("afterLand", p);

          if (!p.alive) {
            alive = this.players.filter((x) => x.alive);
            if (alive.length <= 1) stop = true;
            break;
          }
          await this.decisions.build(this, p);

          alive = this.players.filter((x) => x.alive);
          if (alive.length <= 1) { stop = true; break; }
        }
        if (stop) break;
        if (hooks.afterTurn) await hooks.afterTurn(this, p);
      }
      if (stop) break;
      if (hooks.afterRound) await hooks.afterRound(this);
    }

    alive = this.players.filter((p) => p.alive);
    let winner, reason;
    if (alive.length === 1) { winner = alive[0]; reason = "其他人全部破产"; }
    else { winner = alive.reduce((a, b) => (b.assets > a.assets ? b : a)); reason = `打满 ${this.round} 轮，按总资产判胜`; }

    const gap = this._seasonGap();
    return {
      winner: winner.name,
      winnerId: winner.id,
      winnerAssets: winner.assets,
      seasonGap: gap,
      rounds: this.round,
      turns: this.turnCount,
      seasonChanges: this.seasonChanges,
      bankrupts: this.n - alive.length,
      reason,
      tasksDone: this.players.reduce((a, p) => a + p.tasksDone, 0),
      tasksTotal: this.players.reduce((a, p) => a + p.tasksTotal, 0),
      rentTotal: this.players.reduce((a, p) => a + p.rentPaid, 0),
      log: this.log,
      cardLog: Object.fromEntries(this.cardLog),
      players: this.players.map((p) => ({
        id: p.id, name: p.name, alive: p.alive,
        cash: p.cash, assets: p.assets, lands: p.owned.size,
        rentGot: p.rentGot, rentPaid: p.rentPaid,
        nRentGot: p.nRentGot, nRentPaid: p.nRentPaid,
        nBuild: p.nBuild, nPassGo: p.nPassGo, nTreasure: p.nTreasure, nTurn: p.nTurn,
        cardCash: p.cardCash,
        cardCashByDeck: p.cardCashByDeck.toObject(),
        cardNByDeck: p.cardNByDeck.toObject(),
        zoneCost: p.zoneCost.toObject(),
        zoneRentGot: p.zoneRentGot.toObject(),
        owned: Object.fromEntries([...p.owned].map(([c, l]) => [String(c), l])),
      })),
    };
  }

  /** 季节加成的归属（判断机制有没有落到持有者头上）。与 engine.py 同口径。 */
  _seasonGap() {
    let sz = null;
    if (this.seasonOn && this.season) {
      const sd = this.d.seasons[this.season];
      sz = sd.bonus_zone !== undefined ? sd.bonus_zone : sd.zone;
    } else {
      const pool = Object.values(this.d.seasons)
        .filter((v) => v.bonus > 0)
        .map((v) => (v.bonus_zone !== undefined ? v.bonus_zone : v.zone));
      sz = pool.length ? this.rng.choice(pool) : null;
    }
    if (!sz) return null;
    const hold = this.players.filter((p) => this.holdsZoneAny(p, sz));
    const oth = this.players.filter((p) => !this.holdsZoneAny(p, sz));
    if (!hold.length || !oth.length) return null;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    return {
      holderRent: round1(mean(hold.map((p) => p.rentGot))),
      otherRent: round1(mean(oth.map((p) => p.rentGot))),
      nHolder: hold.length, nOther: oth.length, zone: sz, season: this.season,
    };
  }
}

function round1(x) { return roundN(x, 1); }

export default Game;
