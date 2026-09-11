/*
 * OrbShaders.kt
 *
 * The hero program for OpenGL ES 2.0. GLSL ES 1.00 is exactly WebGL1's dialect, so the
 * galaxy (ORB_GLSL_GALAXY, generated verbatim from src/orb.js) and the hero main() are
 * the reference text. The only additions are the circular cut and the bevel, which
 * the web does in CSS.
 */
package com.earlbalai.orb

internal object OrbShaders {

  /** Fullscreen quad: x, y, u, v. v = 1 at the bottom, so p.y = +1 is the bottom of the orb. */
  val QUAD: FloatArray = floatArrayOf(
    -1f, -1f, 0f, 1f,
     1f, -1f, 1f, 1f,
    -1f,  1f, 0f, 0f,
     1f,  1f, 1f, 0f,
  )

  val UNIFORMS: List<String> = listOf(
    "uRes", "uBg", "uAnchor", "uC0", "uC1", "uC2",
    "uTime", "uPhase", "uAudio", "uSpin", "uArch", "uLens", "uState", "uBevel",
  )

  const val VERTEX: String = """
attribute vec2 aPos;
attribute vec2 aUV;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}"""

  private const val PRECISION: String = """
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
"""

  val FRAGMENT: String = PRECISION + """
#define DUAL_LAYER
varying vec2 vUV;
uniform vec2  uRes;
uniform vec3  uBg;
uniform vec3  uAnchor;
uniform vec3  uC0, uC1, uC2;
uniform float uTime;
uniform float uPhase;
uniform float uAudio;
uniform float uSpin;
uniform float uArch;
uniform float uLens;
uniform float uState;
uniform float uBevel;
""" + ORB_GLSL_GALAXY + """

// Native finish: the web cuts the silhouette in CSS (clip-path + half-pixel mask) and
// draws the bevel as inset box-shadows. No CSS here, so both land on the premultiplied
// result.
vec4 finish(vec4 pm, vec2 p, float r) {
  float halfPx = uRes.y * 0.5;
  float cov = clamp((1.0 - r) * halfPx + 0.5, 0.0, 1.0);
  pm *= cov;
  if (uBevel > 0.0) {
    float edge = max((1.0 - r) * halfPx, 0.0);
    float ring = 0.22 * smoothstep(1.5, 0.0, edge);
    float top  = 0.70 * smoothstep(2.5, 0.0, edge) * max(-p.y, 0.0);
    float bot  = 0.45 * smoothstep(2.5, 0.0, edge) * max( p.y, 0.0);
    float glow = 0.18 * exp(-edge / max(0.06 * uRes.y, 1.0));
    float bev = (ring + top + bot + glow) * 0.35 * cov;
    pm = min(pm + vec4(bev), vec4(1.0));
  }
  return pm;
}

void main() {
  vec2 p = vUV * 2.0 - 1.0;
  float r = length(p);

  if (uLens <= 0.0) {
    if (r > 1.0) discard;
    vec4 s = shade(p);
    gl_FragColor = finish(vec4(s.rgb * s.a, s.a), p, r);
    return;
  }

  float ex = exp(2.0 * 1.7724539 * (r - 0.9) / 0.1414214);
  float fall = 0.5 + 0.5 * (ex - 1.0) / (ex + 1.0);

  if (fall > 0.004) {
    float swell = 1.0 + 0.16 * (0.6 * sin(uTime * 0.9 + uPhase)
                              + 0.4 * sin(uTime * 1.7 + uPhase * 1.3));
    float k = uLens * fall * swell;

    float cR = 1.4 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase));
    float cG = 1.2 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase + 2.1));
    float cB = 1.0 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase + 4.2));
    vec4 sG = shade(p * (1.0 - k * cG));
    vec3 col = vec3(shade(p * (1.0 - k * cR)).r,
                    sG.g,
                    shade(p * (1.0 - k * cB)).b);
    float a = sG.a;

    vec2 a2 = min(abs(p), 1.0);
    float lobe = max(abs(a2.x * 0.766 + a2.y * 0.643), abs(a2.x * 0.766 - a2.y * 0.643));
    float glow = 0.65 * pow(clamp((lobe - 0.0707) / 1.3435, 0.0, 1.0), 2.4) * fall;
    glow += 1.02 * clamp(1.0 + (r - 1.0) / 0.15, 0.0, 1.0) * step(r, 1.0) * pow(lobe, 2.0);
    col += vec3(0.25) * min(glow, 1.0);
    a = clamp(a + min(glow, 1.0) * 0.6, 0.0, 1.0);

    gl_FragColor = finish(vec4(col * a, a), p, r);
    return;
  }

  vec4 s2 = shade(p);
  gl_FragColor = finish(vec4(s2.rgb * s2.a, s2.a), p, r);
}"""
}
