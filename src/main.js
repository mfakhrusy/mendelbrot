import { frameParams } from './frame.js';
import { clearError, showError, syncPlayButton, updateMagnification } from './hud.js';
import { bindInput } from './input.js';
import { fromDecimal, offsetInteger } from './math/fixed.js';
import { createQuality } from './quality.js';
import { createRenderer } from './renderer.js';

const INITIAL = { x: '-0.7482409297559107', y: '0.13646638958862622', depth: 7.5 };
const ITERATIONS = 900;
// Outside the guided descent the escape budget grows with depth: pixels near
// the edge of the set need ever more iterations before they resolve.
const ITERATIONS_PER_DEPTH = 400;
const MAX_ITERATIONS = 16000;
// While the view is moving, a quarter of the budget keeps frames quick; the
// full budget is drawn once the view has been still for this long.
const SETTLE_MS = 180;
const MIN_DEPTH = -1;
const STATS_INTERVAL_MS = 250;

const canvas = document.getElementById('fractal');

// Camera: a fixed-point centre with `bits` fractional bits, and log2 zoom.
let bits = 192, cx = 0n, cy = 0n, depth = INITIAL.depth;
let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
let guided = true, dragging = false, palette = 0, speed = 0.3;

// The reference orbit currently on the GPU, and the one being computed.
let orbit = null, pending = null, requestId = 0, stale = false;

let failure = null, contextLost = false;
let needsDraw = true, lastTime = 0, lastStats = 0, frames = 0, skipped = 0;
let lastInput = 0, drawnBudget = 0;
let renderer, quality, worker;

function fail(message) {
  failure = message;
  showError(message);
}

function fullBudget() {
  if (guided) return ITERATIONS;
  const wanted = ITERATIONS + ITERATIONS_PER_DEPTH * Math.max(0, depth);
  return Math.min(MAX_ITERATIONS, Math.ceil(wanted / 1000) * 1000);
}

function precisionFor(d) {
  return Math.max(192, Math.ceil((d + 128) / 64) * 64);
}

// Precision only ever grows during a descent; widen every fixed-point value.
function ensurePrecision() {
  const next = precisionFor(depth);
  if (next <= bits) return;
  const shift = BigInt(next - bits);
  cx <<= shift;
  cy <<= shift;
  if (orbit) {
    orbit.x <<= shift;
    orbit.y <<= shift;
  }
  bits = next;
}

// Two kinds of reference: the boundary point's periodic orbit (the guided
// destination, valid at any depth) or an ordinary orbit at the camera centre.
function requestOrbit(periodic = guided) {
  if (pending) {
    stale = true;
    return;
  }
  ensurePrecision();
  stale = false;
  // An ordinary orbit is computed for the full budget (it stops early if it
  // escapes), so no pixel can outrun its reference.
  const iterations = fullBudget();
  pending = { id: ++requestId, bits, depth, periodic, iterations };
  worker.postMessage({ id: pending.id, x: cx, y: cy, bits, iterations, periodic });
}

function restartOrbit() {
  pending = null;
  requestOrbit();
}

// Free exploration near the boundary point keeps using its periodic orbit:
// panning then needs no new reference at all. Only a camera that has moved
// further away than float pixel offsets can express gets a local orbit.
const PERIODIC_REACH = 512; // view heights
function refreshFreeOrbit(force) {
  if (!orbit) return;
  if (orbit.periodic) {
    const [ox, oy] = currentFrame().offset;
    if (Math.hypot(ox, oy) < PERIODIC_REACH) {
      if (bits > orbit.precision) requestOrbit(true);
      return;
    }
  }
  if (force) requestOrbit(false);
}

function onOrbit({ data: m }) {
  if (!pending || m.id !== pending.id) return;
  const request = pending;
  pending = null;
  if (m.error) return fail('Precision calculation failed: ' + m.error);

  let { x, y } = m;
  if (request.bits < bits) {
    const shift = BigInt(bits - request.bits);
    x <<= shift;
    y <<= shift;
  }
  // The automatic destination is an exact algebraic boundary point; the
  // worker returns it at the requested precision.
  if (guided && request.periodic) {
    cx = x;
    cy = y;
  }
  renderer.setOrbit(m.data);
  orbit = {
    x, y,
    precision: request.bits,
    depth: request.depth,
    length: m.length,
    prefix: m.prefix,
    model: m.model,
    periodic: m.periodic,
    exhausted: !m.periodic && m.length > request.iterations,
    ms: m.ms,
  };
  needsDraw = true;
  const wasStale = stale;
  stale = false;
  if (guided) {
    if (!request.periodic || bits > orbit.precision) requestOrbit();
  } else refreshFreeOrbit(wasStale);
}

function currentFrame(iterations = fullBudget()) {
  return frameParams({ cx, cy, bits, depth, aspect: innerWidth / innerHeight, orbit, iterations });
}

function draw(budget = fullBudget()) {
  const frame = currentFrame(budget);
  drawnBudget = budget;
  skipped = frame.skipped;
  renderer.draw(frame, palette);
  frames++;
  needsDraw = false;
}

function tick(now) {
  requestAnimationFrame(tick);
  const frameMs = now - (lastTime || now);
  lastTime = now;
  if (failure || contextLost || document.hidden || !innerWidth || !innerHeight) return;
  quality.sync();

  const animating = orbit && playing && !dragging;
  if (animating) {
    depth += Math.min(frameMs / 1000, 0.12) * speed;
    ensurePrecision();
    // Recursive folding keeps the guided orbit valid at every depth; it is
    // only recomputed to give the camera centre more digits.
    if (!pending && (bits > orbit.precision || (!guided && depth - orbit.depth > 1))) requestOrbit();
  }
  const full = fullBudget();
  const moving = animating || dragging || now - lastInput < SETTLE_MS;
  const budget = moving ? Math.max(ITERATIONS, full / 4) : full;
  if (orbit && (needsDraw || animating || drawnBudget !== budget)) {
    draw(budget);
    // A settled frame is a one-off and says nothing about interactive speed.
    if (moving) quality.update(now, frameMs);
  }
  if (now - lastStats > STATS_INTERVAL_MS) {
    updateMagnification(depth);
    lastStats = now;
  }
}

function setPlaying(value) {
  playing = value;
  syncPlayButton(playing);
  needsDraw = true;
}

function reset(startPlaying = true) {
  bits = 192;
  cx = fromDecimal(INITIAL.x, bits);
  cy = fromDecimal(INITIAL.y, bits);
  depth = INITIAL.depth;
  guided = true;
  orbit = null;
  restartOrbit();
  setPlaying(startPlaying ? true : playing);
}

function pan(dx, dy) {
  ensurePrecision();
  cx += offsetInteger(dx, 2 - depth, bits);
  cy += offsetInteger(dy, 2 - depth, bits);
  lastInput = performance.now();
  needsDraw = true;
}

const actions = {
  reset,
  pan,
  togglePlay() {
    // Play always resumes the guided descent, at the current depth.
    if (!playing && !guided) {
      guided = true;
      if (orbit?.periodic) {
        pending = null;
        cx = orbit.x;
        cy = orbit.y;
        if (bits > orbit.precision) requestOrbit();
      } else restartOrbit();
    }
    setPlaying(!playing);
  },
  nextPalette() {
    palette = (palette + 1) % 3;
    needsDraw = true;
  },
  setSpeed(value) {
    speed = value;
  },
  beginDrag() {
    dragging = true;
    guided = false;
    setPlaying(false);
  },
  endDrag() {
    dragging = false;
    refreshFreeOrbit(true);
    needsDraw = true;
  },
  // `anchor` is the point (in view heights from the centre) to keep fixed.
  zoomBy(change, anchor = null) {
    if (!orbit) return;
    const before = depth;
    depth = Math.max(MIN_DEPTH, depth + change);
    lastInput = performance.now();
    ensurePrecision();
    if (!guided) {
      if (anchor) {
        const factor = 2 ** (depth - before) - 1;
        pan(anchor.x * factor, anchor.y * factor);
      }
      refreshFreeOrbit(true);
    } else if (bits > orbit.precision) requestOrbit();
    needsDraw = true;
  },
};

function start() {
  renderer = createRenderer(canvas, {
    onLost(error) {
      contextLost = true;
      showError(
        error
          ? 'The renderer could not restart: ' + error.message
          : 'The GPU context was interrupted. Waiting for it to come back…',
      );
    },
    onRestored() {
      contextLost = false;
      clearError();
      needsDraw = true;
    },
  });
  if (!renderer) {
    return fail('This simulation needs WebGL 2. Please enable hardware acceleration in your browser, then reload this page.');
  }

  worker = new Worker(new URL('./orbit-worker.js', import.meta.url), { type: 'module' });
  worker.onerror = () => fail('The precision worker could not start. Reload to try again.');
  worker.onmessage = onOrbit;

  // A resize clears the canvas, so repaint in the same task to avoid a flash.
  quality = createQuality(renderer, () => {
    if (orbit && !contextLost) draw();
    else needsDraw = true;
  });

  bindInput(canvas, actions);
  document.addEventListener('visibilitychange', () => {
    lastTime = 0;
    needsDraw = true;
  });

  // Read-only diagnostic state and deterministic verification hooks.
  window.fractal = {
    state: () => ({
      depth, bits, speed, playing, guided, frames, skipped,
      iterations: drawnBudget + skipped,
      gpuIterations: drawnBudget,
      recursiveLevel: orbit?.model ? Math.max(0, Math.floor((skipped - orbit.model.preperiod) / orbit.model.period)) : 0,
      pending: !!pending,
      orbitLength: orbit?.length,
      referenceMs: orbit?.ms,
      gpuMs: renderer.gpuMs(),
      renderScale: quality.scale(),
      error: failure,
      width: canvas.width,
      height: canvas.height,
      x: cx.toString(),
      y: cy.toString(),
    }),
    probe: () => {
      if (!orbit) return null;
      const frame = currentFrame();
      const data = Array.from(renderer.probe(frame));
      needsDraw = true;
      return { size: renderer.probeSize, skipped: frame.skipped, exponent: frame.exponent, fraction: frame.fraction, data };
    },
    setView: (x, y, d) => {
      depth = d;
      bits = precisionFor(d);
      cx = fromDecimal(x, bits);
      cy = fromDecimal(y, bits);
      guided = false;
      orbit = null;
      restartOrbit();
    },
    seek: (d) => {
      depth = d;
      restartOrbit();
      needsDraw = true;
    },
    pause: () => setPlaying(false),
    resume: () => {
      if (!playing) actions.togglePlay();
    },
  };

  reset(false);
  syncPlayButton(playing);
  requestAnimationFrame(tick);
}

try {
  start();
} catch (error) {
  console.error(error);
  fail('The renderer could not start: ' + error.message);
}
