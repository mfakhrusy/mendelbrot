import fragmentSource from './shaders/fractal.frag?raw';
import vertexSource from './shaders/fractal.vert?raw';
import presentSource from './shaders/present.frag?raw';

const ORBIT_WIDTH = 1024;
const PROBE_SIZE = 80;
const MASK_DIVISOR = 8;
const MODE = { draw: 0, probe: 1, mask: 2 };
const UNIFORMS = [
  'uOrbit', 'uResolution', 'uAspect', 'uExponent', 'uFraction', 'uOffset', 'uDerivative',
  'uDeltaExponent', 'uIterations', 'uStart', 'uSkipped', 'uPreperiod', 'uWrap', 'uLast',
  'uMode', 'uPalette', 'uColorPhase', 'uMask', 'uMaskTexel',
];
const PRESENT_UNIFORMS = ['uCache', 'uJob', 'uCacheView', 'uJobView', 'uCacheOn', 'uJobOn'];

// The frame is split into a grid of tiles, rendered from the centre outwards.
const TILE_GRID = 16;
export const TILE_COUNT = TILE_GRID * TILE_GRID;
const TILE_ORDER = Array.from({ length: TILE_COUNT }, (_, i) => i).sort((a, b) => {
  const d = (i) => Math.hypot((i % TILE_GRID) + 0.5 - TILE_GRID / 2, Math.floor(i / TILE_GRID) + 0.5 - TILE_GRID / 2);
  return d(a) - d(b);
});

// Owns the WebGL 2 context.
//
// The fractal is never drawn straight to the screen. A render job fills an
// offscreen image tile by tile, possibly over many frames; the screen shows
// the last finished image, moved and scaled to the current view, with the
// finished tiles of the job in progress laid over it. A cheap view completes
// its job within one frame; an expensive one stays responsive and sharpens
// as tiles land.
export function createRenderer(canvas, { onLost, onRestored }) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;

  let fractal, present, uniforms, presentUniforms, timer;
  let probeFramebuffer, maskTexture, maskFramebuffer, blankTexture;
  let cache, job; // { texture, framebuffer }
  let maskWidth = 0, maskHeight = 0;
  let query = null, queryTag = null, onTiming = null;
  const probePixels = new Uint8Array(PROBE_SIZE * PROBE_SIZE * 4);

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  function link(fragment) {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.bindAttribLocation(program, 0, 'aPosition');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    return program;
  }

  function texture(filter) {
    const result = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, result);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return result;
  }

  function target(filter) {
    const result = { texture: texture(filter), framebuffer: gl.createFramebuffer() };
    gl.bindFramebuffer(gl.FRAMEBUFFER, result.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, result.texture, 0);
    return result;
  }

  function allocate(target, width, height) {
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  function clear(target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function setup() {
    fractal = link(fragmentSource);
    present = link(presentSource);
    uniforms = {};
    for (const name of UNIFORMS) uniforms[name] = gl.getUniformLocation(fractal, name);
    presentUniforms = {};
    for (const name of PRESENT_UNIFORMS) presentUniforms[name] = gl.getUniformLocation(present, name);

    // A single triangle covering the viewport: no diagonal seam, no overdraw.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const probe = target(gl.NEAREST);
    allocate(probe, PROBE_SIZE, PROBE_SIZE);
    probeFramebuffer = probe.framebuffer;

    // The mask is sampled with linear filtering so one tap covers four texels.
    ({ texture: maskTexture, framebuffer: maskFramebuffer } = target(gl.LINEAR));
    maskWidth = maskHeight = 0;
    // Stands in for the mask while it is being rendered or is not wanted.
    blankTexture = texture(gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));

    cache = target(gl.LINEAR);
    job = target(gl.LINEAR);
    sizeTargets();

    gl.useProgram(fractal);
    gl.uniform1i(uniforms.uOrbit, 0);
    gl.uniform1i(uniforms.uMask, 1);
    gl.useProgram(present);
    gl.uniform1i(presentUniforms.uCache, 0);
    gl.uniform1i(presentUniforms.uJob, 1);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    query = null;
  }

  function sizeTargets() {
    for (const each of [cache, job]) {
      allocate(each, canvas.width, canvas.height);
      clear(each);
    }
    maskWidth = Math.ceil(canvas.width / MASK_DIVISOR);
    maskHeight = Math.ceil(canvas.height / MASK_DIVISOR);
    gl.bindTexture(gl.TEXTURE_2D, maskTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, maskWidth, maskHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  function bind(unit0, unit1) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, unit1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, unit0);
  }

  function configure(width, height, frame, palette, mode) {
    gl.useProgram(fractal);
    gl.uniform2f(uniforms.uResolution, width, height);
    gl.uniform1f(uniforms.uAspect, frame.aspect);
    gl.uniform1f(uniforms.uExponent, frame.exponent);
    gl.uniform1f(uniforms.uFraction, frame.fraction);
    gl.uniform2f(uniforms.uOffset, frame.offset[0], frame.offset[1]);
    gl.uniform2f(uniforms.uDerivative, frame.derivative[0], frame.derivative[1]);
    gl.uniform1f(uniforms.uDeltaExponent, frame.deltaExponent);
    gl.uniform1i(uniforms.uIterations, frame.iterations);
    gl.uniform1i(uniforms.uStart, frame.start);
    gl.uniform1i(uniforms.uSkipped, Math.min(frame.skipped, 2 ** 30));
    gl.uniform1i(uniforms.uPreperiod, frame.preperiod);
    gl.uniform1i(uniforms.uWrap, frame.wrap);
    gl.uniform1i(uniforms.uLast, frame.last);
    gl.uniform1i(uniforms.uMode, mode);
    gl.uniform1i(uniforms.uPalette, palette);
    gl.uniform2f(uniforms.uColorPhase, frame.colorPhase[0], frame.colorPhase[1]);
    gl.uniform2f(uniforms.uMaskTexel, 1 / maskWidth, 1 / maskHeight);
  }

  // GPU timestamps measure completed work rather than the cheap JS call.
  // Results arrive a frame or two late, tagged with what that frame drew.
  function collectTiming() {
    if (!query || !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return;
    if (!gl.getParameter(timer.GPU_DISJOINT_EXT) && onTiming) {
      onTiming(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6, queryTag);
    }
    gl.deleteQuery(query);
    query = null;
  }

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    onLost();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try {
      setup();
      onRestored();
    } catch (error) {
      onLost(error);
    }
  });

  setup();

  return {
    probeSize: PROBE_SIZE,
    hasTimer: () => !!timer,
    isLost: () => gl.isContextLost(),
    // callback(gpuMs, tag) for frames bracketed by beginFrame/endFrame.
    setTimingListener(callback) {
      onTiming = callback;
    },
    createOrbit(data) {
      const rows = Math.ceil(data.length / 4 / ORBIT_WIDTH);
      let packed = data;
      if (packed.length !== ORBIT_WIDTH * rows * 4) {
        packed = new Float32Array(ORBIT_WIDTH * rows * 4);
        packed.set(data);
      }
      const result = texture(gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, ORBIT_WIDTH, rows, 0, gl.RGBA, gl.FLOAT, packed);
      return result;
    },
    deleteOrbit(orbitTexture) {
      gl.deleteTexture(orbitTexture);
    },
    // Resizing discards both images.
    resize(width, height) {
      if (canvas.width === width && canvas.height === height) return false;
      canvas.width = width;
      canvas.height = height;
      sizeTargets();
      return true;
    },
    beginFrame(tag) {
      if (!timer) return;
      collectTiming();
      if (query || tag === null) return;
      query = gl.createQuery();
      queryTag = tag;
      gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      this.measuring = true;
    },
    endFrame() {
      if (!this.measuring) return;
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      this.measuring = false;
    },
    // Starts a job: empties its image and draws the interior mask for it.
    beginJob(frame, orbitTexture) {
      clear(job);
      bind(orbitTexture, blankTexture);
      gl.bindFramebuffer(gl.FRAMEBUFFER, maskFramebuffer);
      gl.viewport(0, 0, maskWidth, maskHeight);
      configure(maskWidth, maskHeight, frame, 0, MODE.mask);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    // Draws tiles [from, to) of the job, in centre-out order.
    drawTiles(frame, palette, orbitTexture, from, to) {
      const width = canvas.width, height = canvas.height;
      bind(orbitTexture, maskTexture);
      gl.bindFramebuffer(gl.FRAMEBUFFER, job.framebuffer);
      gl.viewport(0, 0, width, height);
      configure(width, height, frame, palette, MODE.draw);
      if (from === 0 && to === TILE_COUNT) {
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return;
      }
      gl.enable(gl.SCISSOR_TEST);
      for (let i = from; i < to; i++) {
        const tx = TILE_ORDER[i] % TILE_GRID, ty = Math.floor(TILE_ORDER[i] / TILE_GRID);
        const x0 = Math.floor((tx * width) / TILE_GRID), x1 = Math.floor(((tx + 1) * width) / TILE_GRID);
        const y0 = Math.floor((ty * height) / TILE_GRID), y1 = Math.floor(((ty + 1) * height) / TILE_GRID);
        gl.scissor(x0, y0, x1 - x0, y1 - y0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
    },
    // The finished job becomes the cached image.
    finishJob() {
      [cache, job] = [job, cache];
    },
    // Puts the cached image and the job in progress on screen. Each view is
    // [scale, offsetX, offsetY] mapping screen coordinates into that image, or
    // null when the image has nothing to show.
    present(cacheView, jobView) {
      gl.useProgram(present);
      bind(cache.texture, job.texture);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1i(presentUniforms.uCacheOn, cacheView ? 1 : 0);
      gl.uniform1i(presentUniforms.uJobOn, jobView ? 1 : 0);
      if (cacheView) gl.uniform3f(presentUniforms.uCacheView, ...cacheView);
      if (jobView) gl.uniform3f(presentUniforms.uJobView, ...jobView);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    // Escape counts on a small grid: (low byte, high byte, escaped flag).
    probe(frame, orbitTexture) {
      bind(orbitTexture, blankTexture);
      gl.bindFramebuffer(gl.FRAMEBUFFER, probeFramebuffer);
      gl.viewport(0, 0, PROBE_SIZE, PROBE_SIZE);
      configure(PROBE_SIZE, PROBE_SIZE, frame, 0, MODE.probe);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, PROBE_SIZE, PROBE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, probePixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return probePixels;
    },
  };
}
