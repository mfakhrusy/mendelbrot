// Picks the canvas resolution: as sharp as the display allows, backing off
// only when the GPU cannot hold the frame rate.
const MAX_RATIO = 2;
const MAX_PIXELS = 2560 * 1440;
const MIN_SCALE = 0.35;
const COOLDOWN_MS = 2000;

export function createQuality(renderer, onResize) {
  let scale = 1;
  let changedAt = 0;
  let slowFrames = 0;
  let layout = '';

  function apply() {
    layout = `${innerWidth}x${innerHeight}@${devicePixelRatio}`;
    const ratio = Math.min(devicePixelRatio || 1, MAX_RATIO) * scale;
    let width = innerWidth * ratio, height = innerHeight * ratio;
    const excess = Math.sqrt((width * height) / MAX_PIXELS);
    if (excess > 1) {
      width /= excess;
      height /= excess;
    }
    if (renderer.resize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)))) onResize();
  }

  function change(factor, now) {
    const next = Math.min(1, Math.max(MIN_SCALE, scale * factor));
    if (next === scale) return;
    scale = next;
    changedAt = now;
    slowFrames = 0;
    renderer.resetTiming();
    apply();
  }

  return {
    apply,
    scale: () => scale,
    // Window size and pixel ratio are polled every frame: resize events are
    // not delivered reliably when a tab starts hidden or moves between displays.
    sync() {
      if (layout !== `${innerWidth}x${innerHeight}@${devicePixelRatio}`) apply();
    },
    // Called once per drawn frame with the time since the previous one.
    update(now, frameMs) {
      if (now - changedAt < COOLDOWN_MS) return;
      if (renderer.hasTimer()) {
        const gpuMs = renderer.gpuMs();
        if (!gpuMs) return;
        // Cost scales with pixel count, so aim straight for the budget.
        if (gpuMs > 11) change(Math.max(0.6, Math.sqrt(8 / gpuMs)), now);
        else if (gpuMs < 5 && scale < 1) change(Math.min(1.25, Math.sqrt(7 / gpuMs)), now);
      } else {
        // No GPU timer (Safari, Firefox): back off after sustained slow frames.
        slowFrames = frameMs > 30 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
        if (slowFrames > 20) change(0.8, now);
      }
    },
  };
}
