// Seeded random numbers. The Python simulator uses numpy's generator, which is
// not reproduced here: a browser-built world is a different draw from the same
// distributions, not the same world. (Tests replay Python-built worlds instead.)

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spare: number | null = null;

  constructor(seed: number) {
    // splitmix32 spreads the seed over the four words of sfc32's state.
    let s = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
    const next = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = 1;
    for (let i = 0; i < 16; i++) this.u32();
  }

  private u32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform in [0, 1), 53 random bits. */
  random(): number {
    const hi = this.u32() >>> 5;
    const lo = this.u32() >>> 6;
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  uniform(low: number, high: number): number {
    return low + (high - low) * this.random();
  }

  integers(n: number): number {
    return Math.floor(this.random() * n);
  }

  exponential(scale: number): number {
    return -scale * Math.log(1 - this.random());
  }

  normal(mean = 0, sd = 1): number {
    if (this.spare !== null) {
      const z = this.spare;
      this.spare = null;
      return mean + sd * z;
    }
    const r = Math.sqrt(-2 * Math.log(1 - this.random()));
    const angle = 2 * Math.PI * this.random();
    this.spare = r * Math.sin(angle);
    return mean + sd * r * Math.cos(angle);
  }

  lognormal(mu: number, sigma: number): number {
    return Math.exp(this.normal(mu, sigma));
  }

  /** An index drawn with the given weights, passed as running totals. */
  pick(cumulative: Float64Array): number {
    const x = this.random() * cumulative[cumulative.length - 1];
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] > x) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /** k different whole numbers from 0..n-1. */
  sample(n: number, k: number): Int32Array {
    const pool = new Int32Array(n);
    for (let i = 0; i < n; i++) pool[i] = i;
    const count = Math.min(k, n);
    for (let i = 0; i < count; i++) {
      const j = i + this.integers(n - i);
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return pool.slice(0, count);
  }
}

export function cumulative(weights: ArrayLike<number>): Float64Array {
  const out = new Float64Array(weights.length);
  let total = 0;
  for (let i = 0; i < weights.length; i++) {
    total += weights[i];
    out[i] = total;
  }
  return out;
}
