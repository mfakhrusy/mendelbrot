import assert from 'node:assert/strict';
import test from 'node:test';
import { fromDecimal, offsetInteger, relative, toNumber } from '../src/math/fixed.js';
import { PERIOD, PREPERIOD, solveBoundary } from '../src/math/boundary.js';
import { escapeBig, referenceOrbit } from '../src/math/reference.js';
import { cycleModel, recursiveFrame, recursivePower } from '../src/math/recursive-zoom.js';

const periodic = { preperiod: PREPERIOD, period: PERIOD };

test('fixed-point conversion', () => {
  assert.equal(fromDecimal('-2', 192), -2n << 192n);
  assert.equal(toNumber(fromDecimal('0.125', 192), 192), 0.125);
  assert.equal(relative(3n << 100n, 192, -92), 3);
  assert.equal(relative(-(1n << 60n), 1280, -1220), -1);
});

test('known membership', () => {
  const bits = 192;
  assert.equal(escapeBig(0n, 0n, bits, 1000), 1000);
  assert.equal(escapeBig(fromDecimal('-1', bits), 0n, bits, 1000), 1000);
  assert.equal(escapeBig(fromDecimal('1', bits), 0n, bits, 1000), 4);
  assert.equal(escapeBig(fromDecimal('-2', bits), 0n, bits, 1000), 1000);
});

test('offsets survive below 2^-1024', () => {
  const bits = 1280;
  const tiny = offsetInteger(-0.25, 2 - 1100, bits);
  assert.notEqual(tiny, 0n);
  assert.equal(2 ** -1100, 0);
  const escaped = escapeBig(fromDecimal('-2', bits) + tiny, 0n, bits, 800);
  assert.ok(escaped > 540 && escaped < 570, `deep escape: ${escaped}`);
});

test('reference orbit layout', () => {
  const ref = referenceOrbit(fromDecimal('-2', 1280), 0n, 1280, 800);
  assert.equal(ref.length, 801);
  assert.equal(ref.data[4], -2);
  assert.equal(ref.data[8], 2);
  assert.equal(ref.data[3200], 2);
});

test('boundary root is exact and consistent across precisions', () => {
  const root = solveBoundary(256);
  const refined = solveBoundary(1280);
  assert.equal(refined.x >> 1024n, root.x);
  assert.equal(refined.y >> 1024n, root.y);

  let x = 0n, y = 0n, z20;
  for (let i = 1; i <= 25; i++) {
    const nx = ((x * x - y * y) >> 256n) + root.x;
    y = ((2n * x * y) >> 256n) + root.y;
    x = nx;
    if (i === 20) z20 = [x, y];
  }
  const residual = (x - z20[0]) ** 2n + (y - z20[1]) ** 2n;
  assert.ok(residual < 1n << 64n, 'residual is below 2^-224');
});

test('warm-started refinement matches a cold solve', () => {
  let warm = solveBoundary(192);
  for (const bits of [256, 320, 1024, 4096]) {
    warm = solveBoundary(bits, warm);
    const cold = solveBoundary(bits);
    const dx = warm.x - cold.x, dy = warm.y - cold.y;
    assert.ok(dx >= -2n && dx <= 2n && dy >= -2n && dy <= 2n, `${bits} bits`);
  }
  const lower = solveBoundary(192, warm);
  assert.equal(lower.x, warm.x >> BigInt(4096 - 192));
});

test('periodic reference reuses its cycle and repels', () => {
  const root = solveBoundary(256);
  const orbit = referenceOrbit(root.x, root.y, 256, 1000, periodic);
  assert.deepEqual(Array.from(orbit.data.slice(80, 84)), Array.from(orbit.data.slice(100, 104)));
  assert.ok(orbit.prefix[4 * 500 + 3] < orbit.prefix[4 * 100 + 3]);
  const model = cycleModel(orbit.data);
  assert.ok(Math.hypot(...model.multiplier) > 10);
});

test('recursive power matches repeated multiplication', () => {
  for (const turns of [1, 2, 3, 16, 64]) {
    const actual = recursivePower({ z: [0.5, 0.5], exponent: 0 }, turns);
    let z = [1, 0];
    for (let i = 0; i < turns; i++) z = [z[0] * 0.5 - z[1] * 0.5, z[0] * 0.5 + z[1] * 0.5];
    assert.ok(Math.abs(actual.z[0] * 2 ** actual.exponent - z[0]) < 1e-14);
    assert.ok(Math.abs(actual.z[1] * 2 ** actual.exponent - z[1]) < 1e-14);
  }
});

test('recursive frames stay bounded at any depth', () => {
  const root = solveBoundary(256);
  const model = cycleModel(referenceOrbit(root.x, root.y, 256, 25, periodic).data);
  const frame = recursiveFrame(model, -1098, 1);
  assert.ok(frame.turns > 100);
  assert.ok(frame.skipped > 1000);
  assert.equal(frame.start, 20);
  const local = frame.derivative.exponent - 1098;
  assert.ok(local < -29 && local > -40, `first retained delta is 2^${local}`);
  const huge = recursiveFrame(model, -1e9, 1);
  assert.ok(Number.isFinite(huge.derivative.z[0]) && Number.isFinite(huge.derivative.exponent));
});
