import fragmentSource from './shaders/fractal.frag?raw';
import vertexSource from './shaders/fractal.vert?raw';

const ORBIT_WIDTH = 1024;
const PROBE_SIZE = 80;
const MASK_DIVISOR = 8;
const MODE = { draw: 0, probe: 1, mask: 2 };
const UNIFORMS = [
  'uOrbit', 'uResolution', 'uAspect', 'uExponent', 'uFraction', 'uOffset', 'uDerivative',
  'uDeltaExponent', 'uIterations', 'uStart', 'uSkipped', 'uPreperiod', 'uWrap', 'uLast',
  'uMode', 'uPalette', 'uColorPhase', 'uMask', 'uMaskTexel',
];

// Owns the WebGL 2 context: one full-screen triangle, the reference-orbit
// texture, the low-resolution interior mask, and a small offscreen target
// used by the diagnostic probe.
export function createRenderer(canvas, { onLost, onRestored }) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;

  let uniforms, orbitTexture, probeFramebuffer, timer, query = null;
  let maskTexture, maskFramebuffer, blankTexture, maskWidth = 0, maskHeight = 0;
  let orbitData = null;
  let gpuMs = 0;
  const probePixels = new Uint8Array(PROBE_SIZE * PROBE_SIZE * 4);

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  function nearestTexture() {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  function setup() {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);

    // A single triangle covering the viewport: no diagonal seam, no overdraw.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    uniforms = {};
    for (const name of UNIFORMS) uniforms[name] = gl.getUniformLocation(program, name);

    const probeTexture = nearestTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PROBE_SIZE, PROBE_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    probeFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, probeFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, probeTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // The mask is sampled with linear filtering so one tap covers four texels.
    maskTexture = nearestTexture();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    maskFramebuffer = gl.createFramebuffer();
    maskWidth = maskHeight = 0;
    // Stands in for the mask while it is being rendered or is not wanted.
    blankTexture = nearestTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.uniform1i(uniforms.uMask, 1);

    gl.activeTexture(gl.TEXTURE0);
    orbitTexture = nearestTexture();
    gl.uniform1i(uniforms.uOrbit, 0);
    if (orbitData) uploadOrbit();

    timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    query = null;
  }

  function uploadOrbit() {
    const rows = Math.ceil(orbitData.length / 4 / ORBIT_WIDTH);
    let packed = orbitData;
    if (packed.length !== ORBIT_WIDTH * rows * 4) {
      packed = new Float32Array(ORBIT_WIDTH * rows * 4);
      packed.set(orbitData);
    }
    gl.bindTexture(gl.TEXTURE_2D, orbitTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, ORBIT_WIDTH, rows, 0, gl.RGBA, gl.FLOAT, packed);
  }

  function sizeMask() {
    const width = Math.ceil(canvas.width / MASK_DIVISOR), height = Math.ceil(canvas.height / MASK_DIVISOR);
    if (width === maskWidth && height === maskHeight) return;
    maskWidth = width;
    maskHeight = height;
    gl.bindTexture(gl.TEXTURE_2D, maskTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, maskFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, maskTexture, 0);
    gl.bindTexture(gl.TEXTURE_2D, orbitTexture);
  }

  function bindMask(texture) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.activeTexture(gl.TEXTURE0);
  }

  function configure(width, height, frame, palette, mode) {
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
  }

  // GPU timestamps measure completed work rather than the cheap JS call.
  function collectTiming() {
    if (!query || !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return;
    if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) {
      const sample = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
      gpuMs = gpuMs ? gpuMs * 0.8 + sample * 0.2 : sample;
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
    gpuMs: () => gpuMs,
    resetTiming() {
      gpuMs = 0;
    },
    setOrbit(data) {
      orbitData = data;
      if (!gl.isContextLost()) uploadOrbit();
    },
    resize(width, height) {
      if (canvas.width === width && canvas.height === height) return false;
      canvas.width = width;
      canvas.height = height;
      return true;
    },
    draw(frame, palette) {
      if (gl.isContextLost()) return;
      if (timer) collectTiming();
      const measure = timer && !query;
      if (measure) {
        query = gl.createQuery();
        gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      }
      // Interior mask first, at 1/64 of the pixels.
      sizeMask();
      bindMask(blankTexture);
      gl.bindFramebuffer(gl.FRAMEBUFFER, maskFramebuffer);
      gl.viewport(0, 0, maskWidth, maskHeight);
      configure(maskWidth, maskHeight, frame, palette, MODE.mask);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      bindMask(maskTexture);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.uMaskTexel, 1 / maskWidth, 1 / maskHeight);
      configure(canvas.width, canvas.height, frame, palette, MODE.draw);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (measure) gl.endQuery(timer.TIME_ELAPSED_EXT);
    },
    // Escape counts on a small grid: (low byte, high byte, escaped flag).
    probe(frame) {
      bindMask(blankTexture);
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
