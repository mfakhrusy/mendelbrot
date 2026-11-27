import assert from 'node:assert/strict';
import test from 'node:test';
import { frameParams } from '../src/frame.js';
import { fromDecimal, offsetInteger } from '../src/math/fixed.js';
import { PERIOD, PREPERIOD, solveBoundary } from '../src/math/boundary.js';
import { escapeBig, referenceOrbit } from '../src/math/reference.js';
import { cycleModel } from '../src/math/recursive-zoom.js';
import { shadePixel } from './shader-emulation.js';

const ITERATIONS = 900;
const ASPECT = 1.6;
const f = Math.fround;

// Compares the float32 shader algorithm with exact arithmetic on a grid of
// pixels. Some pixels sit on filaments finer than any renderer can resolve,
// where the escape count changes within a hundredth of a pixel; those are
// reported but only the stable ones have a single right answer to check.
const NUDGE = 1e-5; // a hundredth of a pixel on a 1000px-tall view
function compare({ cx, cy, bits, depth, orbit, grid }) {
  const params = frameParams({ cx, cy, bits, depth, aspect: ASPECT, orbit, iterations: ITERATIONS });
  const limit = params.skipped + ITERATIONS;
  const exactCount = (mx, my) =>
    escapeBig(cx + offsetInteger(mx, params.exponent, bits), cy + offsetInteger(my, params.exponent, bits), bits, limit);
  let stable = 0, matched = 0, total = 0, perturbed = 0;
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const pixel = [((gx + 0.5) / grid - 0.5) * ASPECT, (gy + 0.5) / grid - 0.5];
      const shaded = shadePixel(params, orbit.data, pixel);
      // The same float32 pixel offset the shader used, relative to the camera.
      const mx = f(f(f(pixel[0]) * f(params.fraction)) + f(params.offset[0])) - params.offset[0];
      const my = f(f(f(pixel[1]) * f(params.fraction)) + f(params.offset[1])) - params.offset[1];
      const truth = exactCount(mx, my);
      const nudge = NUDGE * params.fraction;
      total++;
      perturbed += shaded.stats.perturbed;
      if (exactCount(mx + nudge, my) !== truth || exactCount(mx, my + nudge) !== truth) continue;
      stable++;
      if (params.skipped + shaded.count === truth) matched++;
    }
  }
  return { stable: stable / total, exact: matched / stable, params, perturbed: perturbed / total };
}

const check = (result) => {
  assert.ok(result.stable > 0.85, `stable pixels ${result.stable}`);
  assert.ok(result.exact > 0.99, `exact ${result.exact}`);
};

function guidedOrbit(bits) {
  const root = solveBoundary(bits);
  const periodic = { preperiod: PREPERIOD, period: PERIOD };
  const { data, length, prefix } = referenceOrbit(root.x, root.y, bits, PREPERIOD + PERIOD, periodic);
  return { x: root.x, y: root.y, data, length, prefix, periodic, model: cycleModel(data, PREPERIOD, PERIOD) };
}

for (const [depth, grid] of [[7.5, 14], [11.3, 14], [31.7, 14], [64.2, 14], [150.9, 12], [700.4, 10], [3000.1, 6]]) {
  test(`guided descent matches exact arithmetic at depth ${depth}`, (t) => {
    const bits = Math.max(192, Math.ceil((depth + 128) / 64) * 64);
    const orbit = guidedOrbit(bits);
    const result = compare({ cx: orbit.x, cy: orbit.y, bits, depth, orbit, grid });
    check(result);
    t.diagnostic(`stable ${result.stable.toFixed(3)} exact ${result.exact.toFixed(4)} skipped ${result.params.skipped} perturbed/px ${result.perturbed.toFixed(1)}`);
    if (depth > 60) {
      assert.ok(result.params.skipped > depth / 2, 'most of the descent is folded away');
      assert.ok(result.perturbed < 60, `perturbed iterations per pixel: ${result.perturbed}`);
    }
  });
}

for (const [depth, pan] of [[6.5, 0.2], [24.6, 0.3], [47.3, -0.1], [88.8, -0.4], [240.2, 0.2]]) {
  test(`free exploration matches exact arithmetic at depth ${depth}`, (t) => {
    const bits = Math.max(192, Math.ceil((depth + 128) / 64) * 64);
    // The camera sits a little off the boundary point, with an ordinary
    // (non-periodic, eventually escaping) reference orbit at its centre.
    const root = solveBoundary(bits);
    const cx = root.x + offsetInteger(pan, 2 - depth, bits);
    const cy = root.y - offsetInteger(pan / 2, 2 - depth, bits);
    const { data, length, prefix } = referenceOrbit(cx, cy, bits, ITERATIONS);
    const orbit = { x: cx, y: cy, data, length, prefix, periodic: null, model: null };
    const result = compare({ cx, cy, bits, depth, orbit, grid: 12 });
    check(result);
    t.diagnostic(`stable ${result.stable.toFixed(3)} exact ${result.exact.toFixed(4)} skipped ${result.params.skipped} reference length ${length} perturbed/px ${result.perturbed.toFixed(1)}`);
  });
}

test('dragging away from the guided reference stays exact', (t) => {
  const depth = 120.5, bits = 256;
  const orbit = guidedOrbit(bits);
  const cx = orbit.x + offsetInteger(0.7, 2 - depth, bits);
  const cy = orbit.y + offsetInteger(-0.4, 2 - depth, bits);
  const result = compare({ cx, cy, bits, depth, orbit, grid: 12 });
  check(result);
});
