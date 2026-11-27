import { relative } from './math/fixed.js';
import { recursiveFrame } from './math/recursive-zoom.js';

// Mirrors DIRECT_FROM in the shader: views this large skip perturbation.
const DIRECT_FROM = -8;

// Everything the shader needs for one frame, derived from the camera and the
// current reference orbit. Pure, so tests can drive it without a GPU.
//
// A pixel's parameter offset from the reference is dcm * 2^exponent, where
// dcm = pixel * fraction + offset. Its orbit starts at reference index `start`
// with delta = derivative * dcm * 2^deltaExponent, `skipped` iterations in.
export function frameParams({ cx, cy, bits, depth, aspect, orbit, iterations }) {
  const exponent = Math.floor(2 - depth);
  const fraction = 2 ** (2 - depth - exponent);
  const ox = relative(cx - orbit.x, bits, exponent);
  const oy = relative(cy - orbit.y, bits, exponent);
  const radius = Math.hypot(fraction * aspect * 0.5 + Math.abs(ox), fraction * 0.5 + Math.abs(oy));

  let start = 0, skipped = 0, dr = 0, di = 0, de = 0;
  if (exponent >= DIRECT_FROM) {
    // Shallow views are iterated directly from the first step.
  } else if (orbit.model) {
    const frame = recursiveFrame(orbit.model, exponent, radius);
    start = frame.start;
    skipped = frame.skipped;
    [dr, di] = frame.derivative.z;
    de = frame.derivative.exponent;
  } else {
    // Longest prefix whose series approximation is safe for this view.
    const radiusLog = exponent + Math.log2(radius);
    let lo = 1, hi = orbit.length - 2;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (radiusLog < orbit.prefix[4 * mid + 3]) {
        start = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    dr = orbit.prefix[4 * start];
    di = orbit.prefix[4 * start + 1];
    de = orbit.prefix[4 * start + 2];
    skipped = start;
  }

  const periodic = orbit.periodic;
  return {
    aspect,
    exponent,
    fraction,
    offset: [ox, oy],
    derivative: [dr, di],
    deltaExponent: exponent + de,
    start,
    skipped,
    iterations,
    preperiod: periodic ? periodic.preperiod : 0,
    // Reference index at which a periodic orbit wraps back to `preperiod`.
    wrap: periodic ? periodic.preperiod + periodic.period : 2 ** 30,
    // Last usable reference index of a finite orbit.
    last: periodic ? 2 ** 30 : orbit.length - 1,
    colorPhase: [(skipped * 0.018) % 10, (skipped * 0.11) % (2 * Math.PI)],
  };
}
