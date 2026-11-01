/**
 * run_all.mjs —— 全量测试入口（package.json 的 `npm test`）
 *
 * 顺序执行，任一失败即整体失败。退出码可直接接 CI 卡点。
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUITES = [
  ["数据层单元测试", "unit/test_gamedata.mjs"],
  ["存档格式 / 规则指纹", "unit/test_savefmt.mjs"],
  ["建房规则回归", "unit/test_build_rule.mjs"],
  ["CPython 随机数对拍", "parity/verify_pyrandom.mjs"],
  ["规则内核 vs engine.py 同种子对拍", "parity/py_vs_js.mjs"],
];

let failed = 0;
for (const [name, rel] of SUITES) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, rel)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

console.log(`\n[run_all] ${SUITES.length - failed} / ${SUITES.length} 套件通过`);
process.exit(failed === 0 ? 0 : 1);
