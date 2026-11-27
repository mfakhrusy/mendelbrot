import { PERIOD, PREPERIOD, solveBoundary } from './math/boundary.js';
import { referenceOrbit } from './math/reference.js';
import { cycleModel } from './math/recursive-zoom.js';

// The last solved root seeds the next, higher-precision solve.
let boundary = null;

self.onmessage = ({ data: m }) => {
  try {
    const started = performance.now();
    let { x, y } = m;
    let periodic = null;
    if (m.guided) {
      boundary = solveBoundary(m.bits, boundary);
      ({ x, y } = boundary);
      periodic = { preperiod: PREPERIOD, period: PERIOD };
    }
    // A guided orbit only needs the preperiod plus one cycle, however deep.
    const count = periodic ? PREPERIOD + PERIOD : m.iterations;
    const result = referenceOrbit(x, y, m.bits, count, periodic);
    const model = periodic ? cycleModel(result.data, PREPERIOD, PERIOD) : null;
    self.postMessage(
      { ...result, model, periodic, x, y, id: m.id, ms: performance.now() - started },
      [result.data.buffer, result.prefix.buffer],
    );
  } catch (error) {
    self.postMessage({ id: m.id, error: error.message });
  }
};
