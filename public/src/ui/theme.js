/**
 * theme.js —— UI 视觉常量（「京城印记」皮肤）
 *
 * ⚠️ 这里只有**外观**常量，没有一条规则数据。
 *    规则/价格/分区归属一律来自 gamedata.json（见 core/gamedata.js）。
 *
 * 来源：`04_打样与量产/生成脚本/gen_playkit_jingcheng.py` 的 JC_* / ZONE_JC 色板，
 *      以及 `.trae/skills/7smile-ui`（七笑果品牌暖橙渐变）。
 */

/**
 * 应用版本号（单一事实源）。
 * ⚠️ 改这里时，请同步 android/app/src/main/AndroidManifest.xml 的
 *    android:versionName / android:versionCode，保持界面与安装包一致。
 * v0.3.0：首次打开图文规则引导 + 高级设置图文卡 + 提示可点即关 + 电脑回合全自动。
 * v0.4.0：建房规则按线下大富翁口径重写（首轮只占空地、走回旧地才可加盖）；
 *         真人对战身份标签区分「真人/电脑」；弹层几何与玩法助手滚动修复；
 *         控制条删「单步」、重做「暂停/继续」、新增「怎么玩」；地标格格名与地标名统一。
 * v0.5.0：存档加「规则指纹 + 配置指纹」（结构版本 1 → 2，规则或配置一变就明确拒读）；
 *         用户设置持久化（人数/称呼/开关/节奏/朝向/音效，下次打开就是上次的样子）；
 *         零素材音效（WebAudio 现场合成，静音时不建 AudioContext）；
 *         多存档槽 + 存档箱（自动存档 + 3 个命名档位，坏档禁用「读」）；
 *         闲置演示（标题页 75s 无人操作 → 全电脑演示，一触即出、不写存档）。
 * v0.6.0：成就徽章（第一块地/收租/盖房/小富翁…即时正反馈）；
 *         玩家面板「谁最富」资产领先条 + 现金变动飘字；
 *         日志筛选（买地建房/收租付租/抽卡）与「跳到第 N 轮」轮次吸顶；
 *         手动走格「下一格预告」；全键盘操作（空格/回车走一格、? 玩法助手、P 暂停）；
 *         系统「减少动态效果」自动降级动画。全部为 UI 层，不碰内核与随机序列。
 * v0.7.0：弹层底栏不再压住上一行卡片按钮的下边线（sticky 底栏负 margin 修复，
 *         开局面板/对话框/存档箱/玩法助手同款底栏一处修全好）；
 *         翻牌提示改「手动关 / 自动关」两种模式，自动关可设 3/6/9/15 秒；
 *         翻牌改为串行（一张收干净才翻下一张），真人那张不再被下一位的牌顶掉。
 *         同样全在界面层，存档指纹与同种子对拍零影响。
 * v0.7.1：修复触屏终端（DC-JAV-FLIP）画面偶尔上下颠倒 —— 该机面板由厂商固件按
 *         「自然横向 + 180° 补偿」安装，正确姿态恒为 180°；应用原先声明 "user"
 *         改听重力传感器，传感器判成 0° 时画面就相对机身翻转。现改为钉死
 *         reverseLandscape(=180°)，并在每次启动/回前台自检一次。
 * v0.7.2：补「季节卡怎么用」的说明（季节面板 / 玩法助手速查 / 首次引导），
 *         讲清「过起点抽 1 张 = 立刻换季 + 卡上小效果当场生效」，并列出四季↔分区对照。
 *         纯 UI 说明，不碰内核与随机序列。
 * v0.7.3：主界面精简 —— 季节面板去掉重复的「季节卡怎么用」说明块与四季对照表，
 *         这块统一收进右上角「?」玩法助手；控制条去掉重复的「❓ 怎么玩」（并入「?」）
 *         与独立的「💾 存档」，只留「📂 存档」这一个入口（= 存档箱）；
 *         左右侧栏收窄，把宽度让给棋盘；棋盘区新增「⤢ 全局全屏」（再点还原）。
 *         同样只在界面层，存档指纹与同种子对拍零影响。
 * v1.0.0：首个对外公开发布版 —— 功能与 v0.7.3 完全一致，只是把发布口径正式定为 1.0，
 *         并统一 APP_VERSION / AndroidManifest / 构建脚本三处版本号。不碰内核与随机序列。
 */
export const APP_VERSION = "1.0.0";

/** 京城印记主色 */
export const JC = {
  primary: "#A8231C", // 宫墙红
  ink: "#1C1A17",     // 墨黑
  accent: "#2E5C6E",  // 孔雀蓝
  gold: "#9C7A3C",    // 鎏金
  bg: "#E8DCC0",      // 宣纸黄
  card: "#F5EDE0",    // 卡纸
};

/** 七笑果品牌色（按钮/高亮/品牌条） */
export const BRAND = {
  orange: "#FF9800",
  red: "#E63900",
  yellow: "#FFC107",
  ink: "#4A2311",
  ink2: "#8C6B5D",
  bgTop: "#FFF7ED",
  bgBottom: "#FFFFFF",
};

/**
 * 七个分区的「京城印记」配色（压暗 20% 后的暗色系）。
 * 分区名是 data 里的中文键，颜色只在本表里配；缺色时回落到 JC.primary。
 */
export const ZONE_JC = {
  胡同街巷: "#A8231C",
  水岸市井: "#2E5C6E",
  坛庙园林: "#4A7B4E",
  新北京: "#3D4F68",
  新城文化: "#9C7A3C",
  京郊胜境: "#6B5A42",
  中轴皇家: "#8B1A12",
};

/** 分区纹样（与纸样一致：砖 / 水波 / 圆点 / 斜纹 / 网 / 横线 / 纯色） */
export const ZONE_PAT = {
  胡同街巷: "pat-brick",
  水岸市井: "pat-wave",
  坛庙园林: "pat-dot",
  新北京: "pat-diag",
  新城文化: "pat-grid",
  京郊胜境: "pat-hline",
  中轴皇家: "pat-solid",
};

/** 非地标格的主题色 */
export const TYPE_COLOR = {
  角: "#1C1A17",
  寻宝: "#9C7A3C",
  机会: "#E63900",
  命运: "#2E5C6E",
};

/** 玩家棋子配色（座位序） */
export const SEAT_COLOR = ["#E63900", "#2E5C6E", "#4A7B4E", "#9C7A3C", "#6B4FAE", "#B07D12"];
export const SEAT_EMOJI = ["🀄", "🏮", "🍡", "🪁", "🀄", "🏮"];

/**
 * 4 枚京味棋子（键名对应 manifest.pawns）——按座位序发给玩家：
 * 糖葫芦 / 鸽哨 / 京剧脸谱 / 人力黄包车。
 * 素材来自工作空间 `07_视觉与印刷文件/06_风格包/R3_京韵微缩/04_配件与印刷品/01_棋子`，
 * 由 tools/sync_assets.py 去底缩放进 public/assets/pawns/。
 */
export const SEAT_PAWN = ["tanghulu", "geshao", "opera", "rickshaw"];
/** 座位 -> 棋子键。 */
export function pawnKey(i) { return SEAT_PAWN[i % SEAT_PAWN.length]; }

/** 取分区颜色，未登记则回落主色。 */
export function zoneColor(zone) { return ZONE_JC[zone] || JC.primary; }
export function zonePat(zone) { return ZONE_PAT[zone] || "pat-solid"; }
export function seatColor(i) { return SEAT_COLOR[i % SEAT_COLOR.length]; }
