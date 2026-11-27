const $ = (id) => document.getElementById(id);

// Wires pointer, wheel, keyboard and button input to the app's actions.
// Distances handed to the app are in units of the view height.
export function bindInput(canvas, app) {
  $('play').onclick = app.togglePlay;
  $('reset').onclick = () => app.reset();
  $('palette').onclick = app.nextPalette;
  $('speed').onchange = (event) => {
    const value = Number(event.target.value);
    if (Number.isFinite(value) && value > 0) app.setSpeed(value);
  };
  $('fullscreen').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  };

  addEventListener('keydown', (event) => {
    if (/SELECT|INPUT|TEXTAREA/.test(event.target.tagName)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (event.code === 'Space') {
      event.preventDefault();
      app.togglePlay();
    } else if (key === 'r') app.reset();
    else if (key === 'f') $('fullscreen').click();
    else if (key === 'h') document.body.classList.toggle('immersive');
  });

  const pointers = new Map();
  let previous = null, origin = null, pinchDistance = 0, dragging = false;

  const pinchSpan = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    previous = origin = { x: event.clientX, y: event.clientY };
    pinchDistance = pointers.size === 2 ? pinchSpan() : 0;
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const distance = pinchSpan();
      if (pinchDistance && distance) app.zoomBy(Math.log2(distance / pinchDistance));
      pinchDistance = distance;
    } else if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 5) {
      if (!dragging) {
        dragging = true;
        app.beginDrag();
      }
      app.pan(-(event.clientX - previous.x) / innerHeight, (event.clientY - previous.y) / innerHeight);
    }
    previous = { x: event.clientX, y: event.clientY };
  });

  function release(event) {
    pointers.delete(event.pointerId);
    if (pointers.size) {
      previous = origin = { ...pointers.values().next().value };
      return;
    }
    previous = origin = null;
    if (dragging) {
      dragging = false;
      app.endDrag();
    }
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const change = Math.max(-1, Math.min(1, -pixels * 0.003));
      app.zoomBy(change, {
        x: (event.clientX - innerWidth / 2) / innerHeight,
        y: -(event.clientY - innerHeight / 2) / innerHeight,
      });
    },
    { passive: false },
  );
}
