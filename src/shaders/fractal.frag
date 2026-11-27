#version 300 es
precision highp float;
precision highp int;

// Perturbation renderer. Each pixel tracks its offset (delta) from a shared
// high-precision reference orbit instead of iterating the full coordinate.
//
// A pixel moves through up to two stages:
//   1. Perturbation: delta = d * 2^e with a float mantissa and a separate
//      exponent, so it survives far below what a float can hold.
//   2. Direct: once delta is no longer small, z = Z + delta is an ordinary
//      number and plain z^2 + c in single floats is both exact enough and
//      several times cheaper.
// tests/shader-emulation.js mirrors this file line for line; keep them in sync.

uniform sampler2D uOrbit;      // reference Z_n as (re hi, re lo, im hi, im lo)
uniform vec2 uResolution;
uniform float uAspect;
uniform float uExponent;       // pixel offset dc = dcm * 2^uExponent
uniform float uFraction;
uniform vec2 uOffset;
uniform vec2 uDerivative;      // initial delta = uDerivative * dcm * 2^uDeltaExponent
uniform float uDeltaExponent;
uniform int uIterations, uStart, uSkipped, uPreperiod, uWrap, uLast;
uniform int uProbe, uPalette;
uniform vec2 uColorPhase;
out vec4 fragColor;

const float ESCAPE = 256.;
// |delta|^2 above which a pixel leaves the perturbation stage.
const float DIRECT = 1. / 4096.;
const float TINY = 1. / 4096.;
const float HUGE = 4096.;

vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

// Renormalise d * 2^e so the mantissa is near 1, and refresh the two scale
// factors the iteration needs: s = 2^e and t = 2^(uExponent - e).
void renorm(inout vec2 d, inout float e, out float s, out float t) {
  float m = max(abs(d.x), abs(d.y));
  if (m > 0.) {
    float q = clamp(floor(log2(m)), -100., 100.);
    d *= exp2(-q);
    e += q;
  }
  // A delta below the pixel-offset scale is pinned to that scale.
  if (m == 0. || e < uExponent) {
    d *= exp2(max(e - uExponent, -100.));
    e = uExponent;
  }
  s = e > -100. ? exp2(e) : 0.;
  t = uExponent - e > -100. ? exp2(uExponent - e) : 0.;
}

vec3 palette(float t) {
  if (uPalette == 1) return .50 + .49 * cos(6.2831853 * (vec3(.0, .13, .27) + t * vec3(.8, 1., 1.1)));
  if (uPalette == 2) return .5 + .49 * cos(6.2831853 * (vec3(.12, .38, .58) + t));
  return .5 + .49 * cos(6.2831853 * (vec3(.57, .32, .18) + t));
}

void main() {
  vec2 pixel = (gl_FragCoord.xy / uResolution - .5) * vec2(uAspect, 1.);
  vec2 dcm = pixel * uFraction + uOffset;

  // c as a plain float, for the direct stage. Orbit entry 1 is the reference c.
  vec4 cref = texelFetch(uOrbit, ivec2(1, 0), 0);
  vec2 dc = uExponent > -100. ? dcm * exp2(uExponent) : vec2(0.);
  vec2 c = (cref.xz + dc) + cref.yw;

  vec2 d = cmul(uDerivative, dcm);
  float e = uDeltaExponent, s, t;
  renorm(d, e, s, t);

  int j = uStart;
  vec2 Z = texelFetch(uOrbit, ivec2(j & 1023, j >> 10), 0).xz;
  vec2 z = vec2(0.);
  float magnitude = 0.;
  int count = uIterations;
  bool direct = false;

  for (int i = 0; i < uIterations; i++) {
    if (direct) {
      z = vec2(z.x * z.x - z.y * z.y, 2. * z.x * z.y) + c;
      magnitude = dot(z, z);
      if (magnitude > ESCAPE) { count = i + 1; break; }
      continue;
    }

    // delta' = 2 Z delta + delta^2 + dc, in mantissa form.
    d = 2. * cmul(Z, d) + cmul(d, d) * s + dcm * t;
    float m = max(abs(d.x), abs(d.y));
    if (m > HUGE || m < TINY) renorm(d, e, s, t);
    if (++j == uWrap) j = uPreperiod;

    vec4 R = texelFetch(uOrbit, ivec2(j & 1023, j >> 10), 0);
    vec2 delta = d * s;
    z = (R.xz + delta) + R.yw;
    magnitude = dot(z, z);
    if (magnitude > ESCAPE) { count = i + 1; break; }

    float deltaMagnitude = dot(delta, delta);
    if (deltaMagnitude > DIRECT) {
      direct = true;
    } else if (magnitude < deltaMagnitude || j >= uLast) {
      // The pixel has drifted closer to the critical point than to the
      // reference (or the reference ran out): restart against Z_0 = 0.
      if (magnitude > DIRECT) {
        direct = true;
      } else {
        d = z;
        e = 0.;
        renorm(d, e, s, t);
        j = 0;
        R = vec4(0.);
      }
    }
    Z = R.xz;
  }

  bool inside = count == uIterations;
  if (uProbe == 1) {
    int total = min(65535, count + uSkipped);
    fragColor = vec4(float(total % 256) / 255., float(total / 256) / 255., inside ? 0. : 1., 1.);
    return;
  }
  if (inside) {
    fragColor = vec4(.012, .018, .030, 1.);
    return;
  }
  float smoothCount = float(count) + 1. - log2(max(1., log2(max(magnitude, 1.)) * .5));
  vec3 color = palette(smoothCount * .018 + uColorPhase.x);
  color *= .72 + .28 * cos(smoothCount * .11 + uColorPhase.y);
  fragColor = vec4(pow(max(color, 0.), vec3(.9)), 1.);
}
