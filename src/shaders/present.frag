#version 300 es
precision highp float;

// Composites the last finished image with the tiles of the job in progress.
// Each image was rendered for its own view; a view uniform (scale, offset)
// maps a screen position into that image's texture coordinates.

uniform sampler2D uCache;
uniform sampler2D uJob;
uniform vec3 uCacheView;
uniform vec3 uJobView;
uniform int uCacheOn, uJobOn;
out vec4 fragColor;

const vec3 BACKGROUND = vec3(.035, .051, .071);

vec4 layer(sampler2D image, vec3 view) {
  ivec2 size = textureSize(image, 0);
  vec2 uv = (gl_FragCoord.xy / vec2(size) - .5) * view.x + view.yz + .5;
  if (uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) return vec4(0.);
  // Unrendered texels are transparent black, so a filtered sample at the edge
  // of the rendered area is darkened by its weight; undo that.
  vec4 texel = texture(image, uv);
  return texel.a > 0. ? vec4(texel.rgb / texel.a, texel.a) : vec4(0.);
}

void main() {
  vec3 color = BACKGROUND;
  if (uCacheOn == 1) {
    vec4 cached = layer(uCache, uCacheView);
    color = mix(color, cached.rgb, step(.5, cached.a));
  }
  if (uJobOn == 1) {
    vec4 fresh = layer(uJob, uJobView);
    // Unrendered tiles are transparent; rendered ones are opaque.
    color = mix(color, fresh.rgb, step(.5, fresh.a));
  }
  fragColor = vec4(color, 1.);
}
