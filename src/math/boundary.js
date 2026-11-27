import { fromDecimal } from './fixed.js';

// The destination is a Misiurewicz parameter: z_25(c) = z_20(c), landing on a
// repelling period-five cycle. It is an exact algebraic point on the boundary.
export const PREPERIOD = 20;
export const PERIOD = 5;
const SEED = { x: '-0.7482409297559107', y: '0.13646638958862622', bits: 53 };
const GUARD = 64;

// Newton's method on f(c) = z_25(c) - z_20(c) at one working precision.
function newton(cx, cy, workBits) {
  const p = BigInt(workBits);
  const one = 1n << p;
  for (let step = 0; step < 12; step++) {
    let x = 0n, y = 0n, dx = 0n, dy = 0n;
    let ax = 0n, ay = 0n, adx = 0n, ady = 0n;
    for (let i = 1; i <= PREPERIOD + PERIOD; i++) {
      const ndx = ((2n * (x * dx - y * dy)) >> p) + one;
      const ndy = (2n * (x * dy + y * dx)) >> p;
      const nx = ((x * x - y * y) >> p) + cx;
      const ny = ((2n * x * y) >> p) + cy;
      x = nx; y = ny; dx = ndx; dy = ndy;
      if (i === PREPERIOD) { ax = x; ay = y; adx = dx; ady = dy; }
    }
    const fr = x - ax, fi = y - ay, dr = dx - adx, di = dy - ady;
    const den = dr * dr + di * di;
    if (den === 0n) throw Error('Boundary root refinement lost its derivative.');
    const sx = ((fr * dr + fi * di) << p) / den;
    const sy = ((fi * dr - fr * di) << p) / den;
    cx -= sx;
    cy -= sy;
    // Rounding can leave a cycle of a few guard bits; those are discarded.
    if (sx >= -4n && sx <= 4n && sy >= -4n && sy <= 4n) break;
  }
  return { x: cx, y: cy };
}

// Newton doubles the number of correct bits per step, so the root is refined
// along a ladder of doubling precisions; only the last rung pays full price.
// Passing a previously solved root as `from` skips most of the ladder.
export function solveBoundary(bits, from = null) {
  let have = SEED.bits;
  let x, y;
  if (from && from.bits > bits) {
    const drop = BigInt(from.bits - bits);
    return { x: from.x >> drop, y: from.y >> drop, bits };
  }
  if (from) {
    have = from.bits;
    x = from.x;
    y = from.y;
  } else {
    x = fromDecimal(SEED.x, have);
    y = fromDecimal(SEED.y, have);
  }
  if (have === bits && from) return { x, y, bits };

  const rungs = [bits];
  while (rungs[0] > 2 * have) rungs.unshift(Math.ceil(rungs[0] / 2));
  let work = have;
  for (const rung of rungs) {
    const next = rung + GUARD;
    const shift = BigInt(Math.abs(next - work));
    x = next >= work ? x << shift : x >> shift;
    y = next >= work ? y << shift : y >> shift;
    work = next;
    ({ x, y } = newton(x, y, work));
  }
  return { x: x >> BigInt(GUARD), y: y >> BigInt(GUARD), bits };
}
