/**
 * test_savefmt.mjs —— 存档格式 / 规则指纹单元测试
 *
 * 目的：证明「规则或配置一变，旧存档必须被拒绝」这条门禁真的生效，
 *       而不是仅仅写进了文档。
 *
 * 判别力验证：本用例会**临时改写** RULES_PATCH 里的一条取值，确认
 * 指纹随之变化、旧存档被判为不可用，然后立刻还原（不改源文件）。
 */
import { strict as assert } from "node:assert";

import {
  SAVE_VERSION, stableStringify, hash32,
  rulesFingerprint, cfgFingerprint, validateSave, buildSave, summarize,
} from "../../public/src/core/savefmt.js";
import { RULES_PATCH } from "../../public/src/core/rules.js";

let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pass++;
  console.log(`  ✓ ${msg}`);
}

const CFG = {
  players: 3, humans: [true, false, false], names: ["小明", "", ""], seed: 12345, seedRaw: "12345",
  seasonOn: true, hutong: true, hutongDraw: false, buildRule: "free", skillLimit: 2,
  seasonMode: "cell", seasonScale: 1,
};

// ------------------------------------------------------------------
console.log("\n=== 1. 稳定串化：键序无关 ===");
ok(stableStringify({ a: 1, b: 2 }) === stableStringify({ b: 2, a: 1 }), "键序不同 → 同一串");
ok(stableStringify({ x: [1, { z: 2, y: 3 }] }) === '{"x":[1,{"y":3,"z":2}]}', "嵌套对象同样按键序串化");
ok(stableStringify(null) === "null" && stableStringify(true) === "true", "基本类型原样输出");

console.log("\n=== 2. 哈希：稳定且定长 ===");
ok(hash32("jym") === hash32("jym"), "同一输入 → 同一哈希");
ok(hash32("jym") !== hash32("jyn"), "微小差异 → 不同哈希");
ok(/^[0-9a-f]{8}$/.test(hash32("京韵大富翁")), "输出恒为 8 位十六进制（含中文输入）");

// ------------------------------------------------------------------
console.log("\n=== 3. 规则指纹 ===");
const fp1 = rulesFingerprint();
ok(fp1 === rulesFingerprint(), "同一进程内稳定");
ok(/^[0-9a-f]{8}$/.test(fp1), `规则指纹格式正确（${fp1}）`);

console.log("\n=== 4. 配置指纹：只看内核字段 ===");
ok(cfgFingerprint(CFG) === cfgFingerprint({ ...CFG, names: ["换个名"] }), "改称呼 → 指纹不变");
ok(cfgFingerprint(CFG) === cfgFingerprint({ ...CFG, seed: 999, seedRaw: "999" }), "改种子 → 指纹不变");
ok(cfgFingerprint(CFG) === cfgFingerprint({ ...CFG, sound: false }), "改音效等纯 UI 项 → 指纹不变");
ok(cfgFingerprint(CFG) !== cfgFingerprint({ ...CFG, seasonOn: false }), "关季节 → 指纹变");
ok(cfgFingerprint(CFG) !== cfgFingerprint({ ...CFG, buildRule: "monopoly" }), "换建房规则 → 指纹变");
ok(cfgFingerprint(CFG) !== cfgFingerprint({ ...CFG, skillLimit: 0 }), "技能不限次 → 指纹变");
ok(cfgFingerprint(CFG) !== cfgFingerprint({ ...CFG, seasonScale: 2 }), "季节倍率 → 指纹变");
ok(cfgFingerprint(CFG) === cfgFingerprint({ ...CFG, pawns: undefined }), "缺省 pawns 与显式 1 等价");

// ------------------------------------------------------------------
console.log("\n=== 5. 存档校验：好档放行 ===");
const good = buildSave({ cfg: CFG, round: 6, recorded: [true, 2, false], engine: "0.5.0" });
ok(good.v === SAVE_VERSION, `结构版本写入为 ${SAVE_VERSION}`);
ok(validateSave(good).ok, "自建存档校验通过");
ok(summarize(good).round === 6 && summarize(good).names[0] === "小明", "摘要提取轮次与称呼");

console.log("\n=== 6. 存档校验：坏档必拒 ===");
const rejects = [
  ["空对象", {}, "结构版本"],
  ["null", null, "空"],
  ["结构版本旧", { ...good, v: 1 }, "结构版本"],
  ["缺配置", { ...good, cfg: null }, "开局配置"],
  ["规则指纹被改", { ...good, fp: "deadbeef" }, "规则已更新"],
  ["配置指纹被改", { ...good, cfgFp: "deadbeef" }, "配置与存档不符"],
  ["轮次为 0", { ...good, round: 0 }, "轮次非法"],
  ["轮次非整数", { ...good, round: 2.5 }, "轮次非法"],
  ["决策序列非数组", { ...good, recorded: "abc" }, "决策序列缺失"],
  ["决策序列含对象", { ...good, recorded: [true, { a: 1 }] }, "非法条目"],
  ["决策序列超长", { ...good, recorded: new Array(3 * 6 * 3 + 17).fill(true) }, "长度异常"],
  ["配置被篡改", { ...good, cfg: { ...CFG, seasonOn: false } }, "配置与存档不符"],
];
for (const [name, obj, needle] of rejects) {
  const r = validateSave(obj);
  ok(!r.ok && r.reason.includes(needle), `拒绝「${name}」：${r.reason}`);
}

// ------------------------------------------------------------------
console.log("\n=== 7. 判别力验证：规则一变，旧档立刻失效 ===");
const before = rulesFingerprint();
const savedWithOldRules = buildSave({ cfg: CFG, round: 4, recorded: [], engine: "0.5.0" });
const original = RULES_PATCH.go_salary.value;
try {
  RULES_PATCH.go_salary.value = original + 1;          // 临时改口径（不动源文件）
  const after = rulesFingerprint();
  ok(after !== before, `改 go_salary 后指纹变化（${before} → ${after}）`);
  ok(!validateSave(savedWithOldRules).ok, `旧档被拒绝：${validateSave(savedWithOldRules).reason}`);
  ok(validateSave(buildSave({ cfg: CFG, round: 4, recorded: [], engine: "0.5.0" })).ok,
    "用新规则重建的存档随即可用");
} finally {
  RULES_PATCH.go_salary.value = original;              // 必须还原
}
ok(rulesFingerprint() === before, "还原口径后指纹回到原值");

console.log(`\n[savefmt] 全部通过（${pass} 项断言）`);
