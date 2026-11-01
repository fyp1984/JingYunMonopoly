/**
 * assets.js —— 一次性装载「数据」与「素材索引」
 *
 * 原则：UI 侧不硬编码任何素材文件名。
 *   gamedata.json  → 规则数据（core/gamedata.js 负责校验）
 *   manifest.json  → 素材索引（由 tools/sync_assets.py 生成）
 */

import { GameData } from "../core/gamedata.js";

const json = (url) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`加载失败 ${r.status}：${url}`);
  return r.json();
});

/**
 * @param {string} base 素材根（相对 index.html）
 * @returns {Promise<{data: GameData, manifest: object, errors: string[], url: (p:string)=>string}>}
 */
export async function loadAssets(base = "./assets/") {
  const [gd, manifest] = await Promise.all([
    json(`${base}data/gamedata.json`),
    json(`${base}manifest.json`),
  ]);
  const data = new GameData(gd);
  return {
    data,
    manifest,
    errors: data.validate(),
    /** 素材相对路径 -> 可用 URL */
    url: (p) => (p ? base + p : ""),
  };
}
