/**
 * verify_pyrandom.mjs —— 校验 pyrandom.js 与 CPython random.Random 逐位一致。
 * 向量来源：tests/fixtures/pyrandom_vectors.json（由本机 python3.9.6 生成）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PyRandom } from "../../public/src/core/pyrandom.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(resolve(HERE, "../fixtures/pyrandom_vectors.json"), "utf8"));

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`  ✗ ${name}\n    got : ${g}\n    want: ${w}`); }
}

for (const [seedStr, exp] of Object.entries(vectors)) {
  const seed = Number(seedStr);
  // 与生成脚本一致：同一个 Random 实例上连续取值（不是每项都重置种子）。
  const r = new PyRandom(seed);
  eq(`seed=${seed} randint(1,6)x30`, Array.from({ length: 30 }, () => r.randint(1, 6)), exp.randint_1_6);
  eq(`seed=${seed} random()x10`, Array.from({ length: 10 }, () => Number(r.random().toFixed(15))), exp.random);
  const lst = Array.from({ length: 20 }, (_, i) => i); r.shuffle(lst);
  eq(`seed=${seed} shuffle(20)`, lst, exp.shuffle_20);
  eq(`seed=${seed} sample(8,4)`, r.sample(Array.from({ length: 8 }, (_, i) => i), 4), exp.sample_8_4);
  eq(`seed=${seed} sample(8,2)`, r.sample(Array.from({ length: 8 }, (_, i) => i), 2), exp.sample_8_2);
  eq(`seed=${seed} choice(8)x10`, Array.from({ length: 10 }, () => r.choice(Array.from({ length: 8 }, (_, i) => i))), exp.choice_8);
  eq(`seed=${seed} randint(0,2^31-1)x5`, Array.from({ length: 5 }, () => r.randint(0, 2 ** 31 - 1)), exp.randrange_0_2p31);
  eq(`seed=${seed} getrandbits(3)x10`, Array.from({ length: 10 }, () => r.getrandbits(3)), exp.getrandbits_3);
}

console.log(`\n[pyrandom] 通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
