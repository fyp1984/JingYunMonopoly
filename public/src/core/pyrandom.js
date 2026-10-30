/**
 * pyrandom.js —— CPython 3.9 `random.Random` 的等价实现（MT19937 + init_by_array）
 *
 * 为什么不用普通 JS 随机数：
 *   本项目验收口径是「同种子对拍」——同一个种子喂给 Python 引擎（engine.py）与
 *   本 JS 内核，整局结果必须逐步一致。这要求两端随机序列**逐位相同**，
 *   因此必须复刻 CPython 的 Mersenne Twister 与其各方法（randint / shuffle /
 *   sample / choice / random / getrandbits）的取值算法，而不是换个 JS 随机源。
 *
 * 对照基准：本机 python3.9.6。参考向量见 tests/fixtures/pyrandom_vectors.json。
 * 所有 32 位运算一律以 >>> 0 归一为无符号，乘法一律用 Math.imul（避免越过 2^53）。
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class PyRandom {
  /**
   * @param {number|bigint|null} seed 整数种子。null = 用 Math.random 播种（不保证跨端一致）。
   */
  constructor(seed = null) {
    this.mt = new Uint32Array(N);
    this.mti = N + 1;
    if (seed === null || seed === undefined) {
      // 与 CPython 的「无种子」路径不同（它用 os.urandom），这里只求可用。
      this._initByArray([(Math.random() * 0xffffffff) >>> 0, (Math.random() * 0xffffffff) >>> 0], 2);
    } else {
      this._seedFromInt(seed);
    }
  }

  /** 把整数种子拆成 CPython 口径的 key（32 位大字序 word 数组）后 init_by_array。 */
  _seedFromInt(seed) {
    let n = BigInt(seed);
    if (n < 0n) n = -n; // CPython: PyNumber_Absolute
    const words = [];
    if (n === 0n) {
      words.push(0);
    } else {
      let x = n;
      while (x > 0n) {
        words.push(Number(x & 0xffffffffn));
        x >>= 32n;
      }
    }
    // 实测口径：key = 低位 word 在前，**不做** bswap32。
    // （CPython 源码里那行 "Convert from little-endian to big-endian" 的 bswap
    //   在 3.9 上并非最终生效路径；以本机 3.9.6 生成的黄金向量为准，见
    //   tests/fixtures/pyrandom_vectors.json —— seed=42 首个 randint(1,6)=6。）
    const key = words;
    this._initByArray(key, key.length);
  }

  _initGenrand(s) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      mt[i] = (Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i) >>> 0;
    }
    this.mti = N;
  }

  _initByArray(key, keyLength) {
    this._initGenrand(19650218 >>> 0);
    const mt = this.mt;
    let i = 1;
    let j = 0;
    let k = N > keyLength ? N : keyLength;
    for (; k; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      if (j >= keyLength) j = 0;
    }
    for (k = N - 1; k; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  /** 等价 CPython genrand_uint32。 */
  genrandUint32() {
    const mt = this.mt;
    let y;
    if (this.mti >= N) {
      let kk;
      for (kk = 0; kk < N - M; kk++) {
        y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0);
      }
      y = (mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0);
      this.mti = 0;
    }
    y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** 等价 CPython getrandbits(k)，k <= 32。 */
  getrandbits(k) {
    if (k <= 32) return this.genrandUint32() >>> (32 - k);
    // 本项目用不到 >32 位；保留抛错以暴露误用。
    throw new Error("getrandbits: 仅支持 k<=32");
  }

  /** [0.0, 1.0) 双精度，与 CPython 同式。 */
  random() {
    const a = this.genrandUint32() >>> 5;
    const b = this.genrandUint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  _randbelow(n) {
    if (!n) return 0;
    const k = bitLength(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  /** randint(a, b) 闭区间。 */
  randint(a, b) {
    return a + this._randbelow(b + 1 - a);
  }

  /** randrange(start, stop)（step=1）。 */
  randrange(start, stop) {
    return start + this._randbelow(stop - start);
  }

  choice(seq) {
    if (seq.length === 0) throw new Error("choice: 空序列");
    return seq[this._randbelow(seq.length)];
  }

  /** 原地 Fisher-Yates，与 CPython 3.9 一致（倒序 + _randbelow）。 */
  shuffle(x) {
    for (let i = x.length - 1; i > 0; i--) {
      const j = this._randbelow(i + 1);
      const t = x[i]; x[i] = x[j]; x[j] = t;
    }
    return x;
  }

  /** 与 CPython 3.9 同算法：n <= setsize 时走 pool 抽取，否则走 set 拒绝重抽。 */
  sample(population, k) {
    const n = population.length;
    if (!(k >= 0 && k <= n)) throw new Error("sample: k 越界");
    const result = new Array(k);
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= setsize) {
      const pool = population.slice();
      for (let i = 0; i < k; i++) {
        const j = this._randbelow(n - i);
        result[i] = pool[j];
        pool[j] = pool[n - i - 1];
      }
    } else {
      const selected = new Set();
      for (let i = 0; i < k; i++) {
        let j = this._randbelow(n);
        while (selected.has(j)) j = this._randbelow(n);
        selected.add(j);
        result[i] = population[j];
      }
    }
    return result;
  }
}

function bitLength(n) {
  let bits = 0;
  let v = n;
  while (v > 0) { bits++; v = Math.floor(v / 2); }
  return bits;
}

export default PyRandom;
