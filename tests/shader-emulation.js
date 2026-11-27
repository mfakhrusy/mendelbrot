// A float32 mirror of src/shaders/fractal.frag, so the per-pixel algorithm can
// be checked against exact BigInt arithmetic without a GPU. Keep it in sync
// with the shader.
const f = Math.fround;
const ESCAPE = 256, DIRECT = 1 / 4096, TINY = 1 / 4096, HUGE = 4096;

const cmul = (a, b) => [
  f(f(a[0] * b[0]) - f(a[1] * b[1])),
  f(f(a[0] * b[1]) + f(a[1] * b[0])),
];
const exp2 = (x) => f(2 ** x);

// `pixel` is the fragment's (x, y) in units of the view height, origin at the
// centre. Returns the escape count relative to params.skipped.
export function shadePixel(params, data, pixel) {
  const E = f(params.exponent);
  const dcm = [
    f(f(f(pixel[0]) * f(params.fraction)) + f(params.offset[0])),
    f(f(f(pixel[1]) * f(params.fraction)) + f(params.offset[1])),
  ];
  const dc = E > -100 ? [f(dcm[0] * exp2(E)), f(dcm[1] * exp2(E))] : [0, 0];
  const c = [f(f(data[4] + dc[0]) + data[5]), f(f(data[6] + dc[1]) + data[7])];

  let d = cmul([f(params.derivative[0]), f(params.derivative[1])], dcm);
  let e = f(params.deltaExponent), s = 0, t = 0;
  const renorm = () => {
    const m = Math.max(Math.abs(d[0]), Math.abs(d[1]));
    if (m > 0) {
      const q = Math.min(100, Math.max(-100, Math.floor(Math.log2(m))));
      d = [f(d[0] * exp2(-q)), f(d[1] * exp2(-q))];
      e = f(e + q);
    }
    if (m === 0 || e < E) {
      const k = exp2(Math.max(e - E, -100));
      d = [f(d[0] * k), f(d[1] * k)];
      e = E;
    }
    s = e > -100 ? exp2(e) : 0;
    t = E - e > -100 ? exp2(E - e) : 0;
  };
  renorm();

  let j = params.start;
  let Z = [data[4 * j], data[4 * j + 2]];
  let z = [0, 0], magnitude = 0, direct = false;
  let stats = { perturbed: 0, direct: 0, rebases: 0 };

  for (let i = 0; i < params.iterations; i++) {
    if (direct) {
      stats.direct++;
      z = [
        f(f(f(z[0] * z[0]) - f(z[1] * z[1])) + c[0]),
        f(f(f(2 * z[0]) * z[1]) + c[1]),
      ];
      magnitude = f(f(z[0] * z[0]) + f(z[1] * z[1]));
      if (magnitude > ESCAPE) return { count: i + 1, magnitude, stats };
      continue;
    }
    stats.perturbed++;
    const linear = cmul(Z, d), square = cmul(d, d);
    d = [
      f(f(f(2 * linear[0]) + f(square[0] * s)) + f(dcm[0] * t)),
      f(f(f(2 * linear[1]) + f(square[1] * s)) + f(dcm[1] * t)),
    ];
    const m = Math.max(Math.abs(d[0]), Math.abs(d[1]));
    if (m > HUGE || m < TINY) renorm();
    if (++j === params.wrap) j = params.preperiod;

    let R = [data[4 * j], data[4 * j + 1], data[4 * j + 2], data[4 * j + 3]];
    const delta = [f(d[0] * s), f(d[1] * s)];
    z = [f(f(R[0] + delta[0]) + R[1]), f(f(R[2] + delta[1]) + R[3])];
    magnitude = f(f(z[0] * z[0]) + f(z[1] * z[1]));
    if (magnitude > ESCAPE) return { count: i + 1, magnitude, stats };

    const deltaMagnitude = f(f(delta[0] * delta[0]) + f(delta[1] * delta[1]));
    if (deltaMagnitude > DIRECT) {
      direct = true;
    } else if (magnitude < deltaMagnitude || j >= params.last) {
      if (magnitude > DIRECT) {
        direct = true;
      } else {
        stats.rebases++;
        d = z;
        e = 0;
        renorm();
        j = 0;
        R = [0, 0, 0, 0];
      }
    }
    Z = [R[0], R[2]];
  }
  return { count: params.iterations, magnitude, stats };
}
