import { TILE_COUNT } from './renderer.js';

// Two ways of keeping frames quick, for two situations.
//
// The guided descent draws a whole new image every frame, so it trades
// resolution: `scale` backs off only when the GPU cannot hold the frame rate.
//
// Free exploration keeps full resolution and the full iteration budget, and
// instead spreads an expensive image over several frames: `tiles()` is how
// many tiles of it to draw in the next one.
const MAX_RATIO = 2;
const MAX_PIXELS = 2560 * 1440;
const MIN_SCALE = 0.35;
const LOWER_COOLDOWN_MS = 500;
const RAISE_COOLDOWN_MS = 1500;
// GPU time per frame, where the browser can measure it.
const GPU_SLOW_MS = 11, GPU_TARGET_MS = 7, GPU_FAST_MS = 5;
// Frame intervals, where it cannot (Firefox, Safari).
const FRAME_SLOW_MS = 24, FRAME_FAST_MS = 19;

export function createQuality(renderer, onResize) {
  let scale = 1, changedAt = 0, applied = '';
  let wholeFrameMs = 0, frameAverage = 0;
  // Without a GPU timer, raising resolution is a guess. Each guess that has
  // to be taken back doubles the wait before the next one.
  let raisedAt = -Infinity, raiseWait = RAISE_COOLDOWN_MS;
  let tiles = TILE_COUNT, msPerTile = 0;

  renderer.setTimingListener((gpuMs, tileCount) => {
    if (tileCount === TILE_COUNT) wholeFrameMs = wholeFrameMs ? wholeFrameMs * 0.8 + gpuMs * 0.2 : gpuMs;
    const sample = gpuMs / tileCount;
    // Follow rising cost at once, falling cost more cautiously.
    msPerTile = sample > msPerTile ? sample : msPerTile * 0.7 + sample * 0.3;
    tiles = Math.max(1, Math.min(TILE_COUNT, Math.floor(GPU_TARGET_MS / msPerTile)));
  });

  function setScale(next, now) {
    next = Math.min(1, Math.max(MIN_SCALE, next));
    if (next === scale) return;
    scale = next;
    changedAt = now;
    wholeFrameMs = frameAverage = 0;
  }

  return {
    scale: () => scale,
    gpuMs: () => wholeFrameMs,
    tiles: () => tiles,
    // Called every frame before drawing. Window size and pixel ratio are
    // polled because resize events are not delivered reliably when a tab
    // starts hidden or moves between displays; a resize clears the canvas, so
    // it must happen in the same task as the draw that follows.
    sync() {
      const wanted = `${innerWidth}x${innerHeight}@${devicePixelRatio}*${scale}`;
      if (wanted === applied) return;
      applied = wanted;
      const ratio = Math.min(devicePixelRatio || 1, MAX_RATIO) * scale;
      let width = innerWidth * ratio, height = innerHeight * ratio;
      const excess = Math.sqrt((width * height) / MAX_PIXELS);
      if (excess > 1) {
        width /= excess;
        height /= excess;
      }
      if (renderer.resize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)))) onResize();
    },
    // Called after each frame of the guided descent.
    updateScale(now, frameMs) {
      if (renderer.hasTimer()) {
        if (!wholeFrameMs) return;
        if (wholeFrameMs > GPU_SLOW_MS && now - changedAt > LOWER_COOLDOWN_MS) {
          setScale(scale * Math.sqrt(GPU_TARGET_MS / wholeFrameMs), now);
        } else if (wholeFrameMs < GPU_FAST_MS && now - changedAt > RAISE_COOLDOWN_MS) {
          setScale(scale * Math.min(1.25, Math.sqrt(GPU_TARGET_MS / wholeFrameMs)), now);
        }
        return;
      }
      if (frameMs > 250) return; // a pause, not a slow frame
      frameAverage = frameAverage ? frameAverage * 0.85 + frameMs * 0.15 : frameMs;
      if (frameAverage > FRAME_SLOW_MS && now - changedAt > LOWER_COOLDOWN_MS) {
        raiseWait = now - raisedAt < 4000 ? Math.min(60000, raiseWait * 2) : RAISE_COOLDOWN_MS;
        setScale(scale * Math.max(0.6, Math.sqrt(16 / frameAverage)), now);
      } else if (frameAverage < FRAME_FAST_MS && scale < 1 && now - changedAt > raiseWait) {
        setScale(scale * 1.15, now);
        raisedAt = now;
      }
    },
    // Called after each frame that drew part of a larger image, where there is
    // no GPU timer: steer the tile count by how long the frame took.
    updateTiles(frameMs) {
      if (renderer.hasTimer()) return;
      if (frameMs > FRAME_SLOW_MS) tiles = Math.max(1, Math.floor(tiles * Math.max(0.1, 16 / frameMs)));
      else if (frameMs < FRAME_FAST_MS) tiles = Math.min(TILE_COUNT, Math.ceil(tiles * 1.3));
    },
  };
}
