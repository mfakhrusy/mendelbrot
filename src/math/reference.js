import { toNumber } from './fixed.js';

const logAdd = (a, b) => {
  const m = Math.max(a, b);
  return Number.isFinite(m) ? m + Math.log2(2 ** (a - m) + 2 ** (b - m)) : m;
};

// High-precision orbit of the critical point at c = (cx, cy).
//
// data:   per iteration (re hi, re lo, im hi, im lo) as float32 pairs, the
//         layout the GPU samples.
// prefix: per iteration (dz/dc mantissa re, im, exponent, safe radius log2),
//         a first-order series approximation with a conservative error bound
//         that says how many leading iterations a view of a given size may skip.
//
// A `periodic` orbit ({preperiod, period}) is only iterated through its first
// cycle; later entries reuse those values exactly.
export function referenceOrbit(cx, cy, bits, iterations, periodic = null) {
  const p = BigInt(bits);
  const data = new Float32Array((iterations + 1) * 4);
  const prefix = new Float64Array((iterations + 1) * 4);
  const escape = 256n << p;
  const cycle = [];
  let x = 0n, y = 0n, length = 1;
  let dr = 0, di = 0, de = 0, errorLog = -Infinity, safeLog = Infinity;
  let oldReal = 0, oldImag = 0;

  for (let i = 1; i <= iterations; i++) {
    let real, imag;
    if (periodic && i >= periodic.preperiod + periodic.period) {
      [real, imag] = cycle[(i - periodic.preperiod) % periodic.period];
    } else {
      const xx = (x * x) >> p, yy = (y * y) >> p;
      y = ((2n * x * y) >> p) + cy;
      x = xx - yy + cx;
      real = toNumber(x, bits);
      imag = toNumber(y, bits);
      if (periodic && i >= periodic.preperiod) cycle.push([real, imag]);
    }
    const rh = Math.fround(real), ih = Math.fround(imag);
    data[4 * i] = rh;
    data[4 * i + 1] = real - rh;
    data[4 * i + 2] = ih;
    data[4 * i + 3] = imag - ih;

    // Track the quadratic truncation error alongside the derivative.
    const dLog = de + Math.log2(Math.hypot(dr, di));
    errorLog = logAdd(Math.log2(2 * Math.hypot(oldReal, oldImag)) + errorLog, 2 * dLog);
    let nr = 2 * (oldReal * dr - oldImag * di);
    let ni = 2 * (oldReal * di + oldImag * dr);
    if (de < 0) {
      nr = nr * 2 ** de + 1;
      ni *= 2 ** de;
      de = 0;
    } else nr += 2 ** -de;
    const norm = Math.max(Math.abs(nr), Math.abs(ni));
    if (norm > 0) {
      const q = Math.floor(Math.log2(norm));
      dr = nr * 2 ** -q;
      di = ni * 2 ** -q;
      de += q;
    } else {
      dr = 0; di = 0; de = 0;
    }
    const nextLog = de + Math.log2(Math.hypot(dr, di));
    // 2^-38 relative truncation error, with every intermediate delta < 2^-20.
    safeLog = Math.min(safeLog, -38 + nextLog - errorLog, -20 - nextLog);
    prefix[4 * i] = dr;
    prefix[4 * i + 1] = di;
    prefix[4 * i + 2] = de;
    prefix[4 * i + 3] = safeLog;

    oldReal = real;
    oldImag = imag;
    length = i + 1;
    if (!periodic && (x * x + y * y) >> p > escape) break;
  }
  return { data, length, prefix };
}

// Exact escape count, used as ground truth in tests.
export function escapeBig(cx, cy, bits, iterations) {
  const p = BigInt(bits);
  const escape = 256n << p;
  let x = 0n, y = 0n;
  for (let i = 0; i < iterations; i++) {
    const xx = (x * x) >> p, yy = (y * y) >> p;
    y = ((2n * x * y) >> p) + cy;
    x = xx - yy + cx;
    if ((x * x + y * y) >> p > escape) return i + 1;
  }
  return iterations;
}
