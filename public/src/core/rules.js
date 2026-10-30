/**
 * rules.js —— 规则常量表（RULES_PATCH）
 *
 * 单一事实来源：`engine.py` 的 RULES_PATCH（第 53–202 行）。
 * 数值必须与 Python 侧逐条一致；`why` 保留原因说明，便于日后对齐口径。
 * ⛔ 改口径 = 改这里 + 改 engine.py，然后重跑「同种子对拍」。不要只改一处。
 */

export const RULES_PATCH = {
  season_trigger: {
    value: "过起点抽季节卡",
    why: "【引擎补完·需用户确认】棋盘 40 格无季节格，但季节卡明写「抽到即换季」。"
      + "补成：每经过一次起点抽 1 张季节卡、立即换季。不改棋盘排布。",
  },
  go_salary: { value: 1500, why: "【引擎补完】过路钱占比 10% × 基础初始资金 ¥15,000。" },
  max_rounds: { value: 40, why: "【引擎补完】防无限局；到点按总资产判胜。" },
  build_levels: { value: 2, why: "空地 → 四合院(1) → 城楼(2)。工作簿只给这三级租金。" },
  monopoly_bonus: { value: 0.0, why: "不叠加经典「同色全齐翻倍」，避免与季节加成数值失控。" },
  ai_safety_cash: {
    value: 1500,
    why: "【引擎补完】AI 活命钱下限；实际还会随场上最高租金浮动（_safety_line）。",
  },
  build_rule: {
    value: "free",
    why: "【按设计书】有钱就能升，不要求凑齐分区。"
      + "（曾误加「须集齐分区」，导致 4 人局全程建不了房、500 局无一人破产。）",
  },
  skill_limit: {
    value: 2,
    why: "【儿童规则书】身份卡技能整局最多用 2 次。0 = 不限。",
  },
  season_mode: {
    value: "cell",
    why: "【v0.9 定档】只有当季分区内地块加成。规则一句话讲清、孩子好心算。"
      + "（focus/player 保留为对照档。）",
  },
  season_scale: {
    value: 1.0,
    why: "【v1.5 从 2.0 改 1.0·拆雷】最终加成 = 工作簿 bonus × 本倍率。"
      + "工作簿 bonus=1.0 即「翻倍」，×1.0 保持不变。",
  },
  season_offzone_bonus: { value: 0.20, why: "【仅 focus 档生效】非当季分区地块的加成幅度。" },
  hutong_treasure: { value: true, why: "【v0.9】停在任意寻宝格时，按持有的胡同街巷地块数多抽寻宝卡。" },
  hutong_per_draw: { value: 2, why: "【v0.9】每持有 N 块胡同地，寻宝格多抽 1 张。" },
  hutong_max_extra: { value: 3, why: "【v0.9】寻宝格额外抽卡上限。" },
  hutong_draw: { value: false, why: "【v0.9 定为关】实测只 +0.3pp，却要多讲一条规则。" },
  hutong_bonus: { value: 0.0, why: "【v0.9 定为 0】每块胡同地单次寻宝 +25%，孩子算不动，默认关。" },
  hutong_cluster: {
    value: { n: 3, bonus: 0.30 },
    why: "【v0.9】持有胡同街巷 ≥3 块时，全部胡同地租金 +30%，可与当季加成叠加。",
  },
  task_success_rate: { value: 0.75, why: "【引擎补完】寻宝/命运卡的「做个小动作」成功率估计。" },
};

/** 常用别名，供内核直接引用。 */
export const HUTONG_ZONE = "胡同街巷";
