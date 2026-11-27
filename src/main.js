import { frameParams } from './frame.js';
import { clearError, showError, syncPlayButton, updateMagnification } from './hud.js';
import { bindInput } from './input.js';
import { fromDecimal, offsetInteger, relative } from './math/fixed.js';
import { createQuality } from './quality.js';
import { createRenderer, TILE_COUNT } from './renderer.js';

const INITIAL = { x: '-0.7482409297559107', y: '0.13646638958862622', depth: 7.5 };
const ITERATIONS = 900;
// Outside the guided descent the escape budget grows with depth: pixels near
// the edge of the set need ever more iterations before they resolve.
const ITERATIONS_PER_DEPTH = 400;
const MAX_ITERATIONS = 16000;
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
let needsDraw = true, lastTime = 0, lastStats = 0, frames = 0, skipped = 0, drawnBudget = 0;
// The image being rendered ({ frame, palette, orbit, view, next }) and the
// view ({ cx, cy, bits, depth }) the last finished image was rendered for.
let job = null, cachedView = null, drewTiles = false;
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
  const previous = orbit;
  orbit = {
    x, y,
    data: m.data,
    texture: contextLost ? null : renderer.createOrbit(m.data),
    precision: request.bits,
    depth: request.depth,
    length: m.length,
    prefix: m.prefix,
    model: m.model,
    periodic: m.periodic,
    exhausted: !m.periodic && m.length > request.iterations,
    ms: m.ms,
  };
  releaseOrbit(previous);
  needsDraw = true;
  const wasStale = stale;
  stale = false;
  if (guided) {
    if (!request.periodic || bits > orbit.precision) requestOrbit();
  } else refreshFreeOrbit(wasStale);
}

function currentFrame() {
  return frameParams({ cx, cy, bits, depth, aspect: innerWidth / innerHeight, orbit, iterations: fullBudget() });
}

// An orbit's texture lives until neither the camera nor a job uses it.
function releaseOrbit(old) {
  if (old?.texture && old !== orbit && old !== job?.orbit) {
    renderer.deleteOrbit(old.texture);
    old.texture = null;
  }
}

function endJob() {
  const finished = job;
  job = null;
  releaseOrbit(finished.orbit);
}

// How to place an image rendered for `view` under the current camera:
// [scale, offsetX, offsetY] in the image's texture coordinates, or null when
// the two views are too far apart for the image to be of any use.
function placement(view) {
  if (!view || view.bits > bits) return null;
  const zoom = view.depth - depth;
  if (Math.abs(zoom) > 6) return null;
  const shift = BigInt(bits - view.bits);
  const exponent = Math.floor(2 - view.depth);
  const toHeights = 2 ** (exponent - (2 - view.depth));
  const ox = relative(cx - (view.cx << shift), bits, exponent) * toHeights;
  const oy = relative(cy - (view.cy << shift), bits, exponent) * toHeights;
  if (!(Math.hypot(ox, oy) < 4)) return null;
  return [2 ** zoom, ox / (innerWidth / innerHeight), oy];
}

// Renders the current view into an offscreen image. During the guided descent
// that is one whole image per frame. Otherwise an image is drawn a few tiles
// per frame at full quality, while the screen keeps showing the last finished
// one, moved and scaled to follow the camera.
function render(animating) {
  drewTiles = false;
  if (job && !placement(job.view)) endJob();
  if (!job && (needsDraw || animating)) {
    const frame = currentFrame();
    job = { frame, palette, orbit, view: { cx, cy, bits, depth }, next: 0 };
    skipped = frame.skipped;
    drawnBudget = frame.iterations;
    needsDraw = false;
  }
  if (job) {
    const left = TILE_COUNT - job.next;
    const count = animating ? left : Math.min(left, quality.tiles());
    // A job's first frame also draws the mask, so it is not a fair sample of
    // tile cost unless it is the whole image.
    renderer.beginFrame(job.next > 0 || count === TILE_COUNT ? count : null);
    if (job.next === 0) renderer.beginJob(job.frame, job.orbit.texture);
    renderer.drawTiles(job.frame, job.palette, job.orbit.texture, job.next, job.next + count);
    renderer.endFrame();
    job.next += count;
    drewTiles = true;
    if (job.next === TILE_COUNT) {
      renderer.finishJob();
      cachedView = job.view;
      endJob();
      frames++;
    }
  }
}

function tick(now) {
  requestAnimationFrame(tick);
  const frameMs = now - (lastTime || now);
  lastTime = now;
  if (failure || contextLost || document.hidden || !innerWidth || !innerHeight) return;

  const animating = orbit && playing && !dragging;
  if (animating) {
    depth += Math.min(frameMs / 1000, 0.12) * speed;
    ensurePrecision();
    // Recursive folding keeps the guided orbit valid at every depth; it is
    // only recomputed to give the camera centre more digits.
    if (!pending && (bits > orbit.precision || (!guided && depth - orbit.depth > 1))) requestOrbit();
  }
  quality.sync();
  if (orbit?.texture) {
    // The previous frame's tiles decide how many this one can afford.
    if (drewTiles && !animating) quality.updateTiles(frameMs);
    const moved = needsDraw;
    render(animating);
    if (moved || drewTiles) renderer.present(placement(cachedView), job ? placement(job.view) : null);
    if (animating) quality.updateScale(now, frameMs);
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
  dropOrbit();
  restartOrbit();
  setPlaying(startPlaying ? true : playing);
}

function dropOrbit() {
  const old = orbit;
  orbit = null;
  releaseOrbit(old);
}

function pan(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  ensurePrecision();
  cx += offsetInteger(dx, 2 - depth, bits);
  cy += offsetInteger(dy, 2 - depth, bits);
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
      // Every GPU resource is gone: re-upload the orbit and start over.
      contextLost = false;
      job = null;
      cachedView = null;
      if (orbit) orbit.texture = renderer.createOrbit(orbit.data);
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

  // A resize discards both images; the frame loop repaints in the same task.
  quality = createQuality(renderer, () => {
    if (job) endJob();
    cachedView = null;
    needsDraw = true;
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
      gpuMs: quality.gpuMs(),
      tiles: quality.tiles(),
      rendering: job ? job.next / TILE_COUNT : null,
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
      const data = Array.from(renderer.probe(frame, orbit.texture));
      needsDraw = true;
      return { size: renderer.probeSize, skipped: frame.skipped, exponent: frame.exponent, fraction: frame.fraction, data };
    },
    setView: (x, y, d) => {
      depth = d;
      bits = precisionFor(d);
      cx = fromDecimal(x, bits);
      cy = fromDecimal(y, bits);
      guided = false;
      dropOrbit();
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
