// orb_shaders.h — the galaxy and the glass body in HLSL (Shader Model 4.0+).
//
// A transliteration of GLSL_GALAXY + FRAG_HERO from src/orb.js. Compiled at runtime
// with D3DCompile, like the web build, so there is no .cso to ship and the text can be
// diffed against the reference. Comments explaining the rendering live in src/orb.js.
//
// Dialect: vec -> float, fract -> frac, mix -> lerp, atan(y,x) -> atan2, discard ->
// discard. Uniforms are globals in GLSL and cbuffer members here, so the names read the
// same. HLSL has no broadcast constructor: float3(1.0) is written out in full.

#pragma once

namespace orb {

inline const char* const kOrbHlsl = R"HLSL(
cbuffer Uniforms : register(b0) {
  float4 uRes4;      // (px, px, 0, 0)
  float4 uBg4;
  float4 uAnchor4;
  float4 uC04, uC14, uC24;
  float uTime, uPhase, uAudio, uSpin;
  float uArch, uLens, uState, uBevel;
};

#define uRes    (uRes4.xy)
#define uBg     (uBg4.xyz)
#define uAnchor (uAnchor4.xyz)
#define uC0     (uC04.xyz)
#define uC1     (uC14.xyz)
#define uC2     (uC24.xyz)

struct VOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };

// Fullscreen quad, TRIANGLE_STRIP. v = 1 at the bottom of the viewport, so p.y = +1 is
// the bottom of the orb and -N.y is up. See SPEC.md §4.
static const float4 kQuad[4] = {
  float4(-1.0, -1.0, 0.0, 1.0),
  float4( 1.0, -1.0, 1.0, 1.0),
  float4(-1.0,  1.0, 0.0, 0.0),
  float4( 1.0,  1.0, 1.0, 0.0),
};

VOut orb_vs(uint vid : SV_VertexID) {
  VOut o;
  o.pos = float4(kQuad[vid].xy, 0.0, 1.0);
  o.uv = kQuad[vid].zw;
  return o;
}

// ---- GLSL_GALAXY -----------------------------------------------------------

float h1(float x) { return frac(sin(x * 127.1) * 43758.5453); }

float stateW(float s, float i) { return 1.0 - smoothstep(0.35, 1.0, abs(s - i)); }

float3 meteorTrail(float2 p, float t, float met, float off) {
  float tt = t + off * met;
  float epoch = floor(tt / met) + off * 17.0;
  float ph = frac(tt / met);
  float2 s0 = float2(-1.1 + 2.2 * h1(epoch * 1.3), 0.85 - 1.4 * h1(epoch * 2.9));
  float2 sd = normalize(float2(0.7 + 0.5 * h1(epoch * 4.1), -0.35 - 0.4 * h1(epoch * 5.3)));
  float2 head = s0 + sd * ph * 2.8;
  float2 rel = p - head;
  float along = dot(rel, sd);
  float perp = dot(rel, float2(-sd.y, sd.x));
  float vis = smoothstep(0.0, 0.06, ph) * smoothstep(0.5, 0.32, ph);
  float tail = exp(-perp * perp * 1600.0) * exp(along * 9.0) * step(along, 0.0)
             * smoothstep(-0.5, -0.02, along);
  float headGlow = exp(-dot(rel, rel) * 900.0);
  return float3(headGlow, tail, vis);
}

float4 starfield(float3 n, float t) {
  float lon = atan2(n.z, n.x);
  float lat = asin(clamp(n.y, -1.0, 1.0));

  float v1 = frac(uPhase * 7.13);
  float v2 = frac(uPhase * 3.71);
  float v3 = frac(uPhase * 5.37);

  float at = uArch >= 0.0 ? uArch : floor(frac(uPhase * 9.73) * 4.0);
  float isNeb  = step(0.5, at) * (1.0 - step(1.5, at));
  float isCore = step(1.5, at) * (1.0 - step(2.5, at));
  float isDeep = step(2.5, at);

  float gb = lat + (0.15 + 0.4 * v1) * sin(lon * (1.0 + floor(v2 * 2.0)) + 1.3)
           + 0.12 * sin(lon * 3.0 + t * 0.1);
  float band = exp(-gb * gb * (5.0 + 10.0 * v3));
  band = lerp(band, max(band, 0.8), isNeb);
  band *= 1.0 - 0.85 * isDeep;

  float n1 = sin(lon * 2.0 + sin(lat * 3.0 + t * 0.25) * 1.6 + t * 0.15);
  float n2 = sin(lon * 5.0 - sin(lat * 4.0 - t * 0.2) * 1.2 - t * 0.22 + 2.4);
  float neb = pow(0.5 + 0.5 * n1, 2.0) * (0.45 + 0.55 * pow(0.5 + 0.5 * n2, 2.0));
  float lane = pow(0.5 + 0.5 * sin(lon * 4.0 + lat * 7.0 + sin(lon * 2.0) * 2.0), 3.0);
  float galaxy = clamp(band * neb * (1.0 - lane * (0.55 + 0.35 * v2)), 0.0, 1.0);

  float3 hue = lerp(lerp(uC0, uC1, v1), lerp(uC1, uC2, v3),
                    0.5 + 0.5 * sin(lon + lat * 2.0 - t * 0.2));
  float hueLum = dot(hue, float3(0.299, 0.587, 0.114));
  float3 hueGrey = hueLum.xxx;
  hue = clamp(hueGrey + (hue - hueGrey) * 1.45, 0.0, 1.0);
  float3 dust = lerp(float3(0.72, 0.78, 0.92), hue, 0.45 + 0.3 * v1 + 0.45 * isNeb);

  float aud  = uAudio * uAudio;
  float audT = uAudio;

  float3 col = dust * galaxy * (0.6 + 0.9 * isNeb) * (1.0 + 0.85 * aud);

  float shear = sin(lon * 13.0 + lat * 4.0 - t * 0.35) * sin(lon * 5.0 + t * 0.2);
  col += dust * band * neb * max(shear, 0.0) * (0.14 + 0.26 * aud);

  float gb2 = lat - (0.35 + 0.25 * v2) * sin(lon * 2.0 - 1.1) + 0.4;
  float arm = exp(-gb2 * gb2 * 7.0) * neb;
  col += lerp(dust, uC1, 0.35) * arm * 0.2;

  float3 voidGlow = lerp(float3(0.04, 0.03, 0.1), lerp(uC0, lerp(uC1, uC2, v3), v1) * 0.22, 0.75);
  col += voidGlow * (0.5 + 0.22 * sin(t * 0.4 + lon)) * (0.4 + 0.6 * band);

  col += float3(1.0, 0.88, 0.68) * pow(band, 4.0) * pow(neb, 2.0) * (0.4 + 0.55 * aud);

  float ca = v2 * 6.28318;
  float3 Cdir = normalize(float3(cos(ca) * 0.85, 0.6 * (v3 - 0.5), sin(ca) * 0.85));
  float bulge = max(dot(n, Cdir), 0.0);
  col += lerp(float3(1.0, 0.85, 0.6), uC2, 0.25)
       * (pow(bulge, 14.0) * 1.6 + pow(bulge, 4.0) * 0.5) * isCore;

  float pocket = pow(neb, 5.0) * band * (0.7 + 0.3 * sin(t * (0.6 + 1.6 * audT) + lon * 3.0));
  col += lerp(uC2, uC0, frac(v1 + 0.5 * sin(lon * 2.0) + 0.5))
       * pocket * (0.5 + 0.4 * v2 + 0.8 * isNeb) * (1.0 + 1.1 * aud);
  float pocket2 = pow(0.5 + 0.5 * sin(lon * 3.0 + lat * 4.0 - t * 0.18 + 2.0), 6.0) * band;
  col += lerp(uC1, uC2, v3) * pocket2 * (0.25 + 0.3 * v1 + 0.5 * isNeb) * (1.0 + 0.9 * aud);

  float detail = smoothstep(90.0, 200.0, uRes.y);

  float2 gg = float2(lon, lat) * 34.0;
  float2 gc = floor(gg);
  float2 gf = frac(gg);
  float gh = h1(gc.x * 3.7 + gc.y * 11.3);
  float2 gp = float2(0.2 + 0.6 * h1(gh * 91.0), 0.2 + 0.6 * h1(gh * 47.0));
  float gd = length((gf - gp) * float2(cos(lat), 1.0));
  float grain = exp(-gd * gd * 240.0 * clamp(uRes.y / 420.0, 0.22, 1.0))
              * step(0.58, gh) * (0.15 + 0.85 * band);
  col += float3(0.88, 0.9, 1.0) * grain * 0.32 * detail;

  float w = clamp(galaxy * 0.7 + pow(band, 4.0) * 0.25, 0.0, 1.0);

  [unroll]
  for (int s = 0; s < 3; s++) {
    float K = s == 0 ? 6.0 : (s == 1 ? 11.0 : 19.0);
    float2 g = float2(lon, lat) * K;
    float2 cell = floor(g);
    float2 f = frac(g);
    float hx = h1(cell.x * 13.7 + cell.y * 7.3 + float(s) * 91.0);
    float hy = h1(cell.x * 5.1 + cell.y * 17.9 + float(s) * 37.0);
    float2 sp = float2(0.15 + 0.7 * hx, 0.15 + 0.7 * hy);
    float d = length((f - sp) * float2(cos(lat), 1.0));

    float census = (v2 - 0.5) * 0.2 + 0.35 * isNeb - 0.2 * isCore + 0.3 * isDeep;
    float keep = step((s == 2 ? 0.3 : 0.55) + census - 0.16 * aud,
                      h1(hx * 89.0 + hy * 31.0) + band * 0.25);

    float resFac = clamp(uRes.y / 420.0, 0.22, 1.0);
    float twRate  = (1.5 + 3.0 * hx) * (1.0 + 2.4 * audT);
    float twDepth = 0.4 + 0.42 * aud;
    float tw = lerp(0.92, max(0.0, (1.0 - twDepth) + twDepth * sin(t * twRate + hx * 40.0)), resFac);

    float hz = h1(hx * 53.0 + hy * 71.0 + cell.x);
    float sizeJit = 0.35 + 1.8 * hz * hz;
    float sharp = (s == 0 ? 260.0 : (s == 1 ? 700.0 : 1600.0)) / (sizeJit * (1.0 + 0.35 * aud)) * resFac;
    float star = exp(-d * d * sharp) * keep * tw;

    float3 tint = lerp(float3(1.0, 1.0, 1.0),
                       hx < 0.33 ? float3(0.85, 0.9, 1.0)
                                 : (hx < 0.66 ? float3(1.0, 0.95, 0.85) : lerp(float3(1.0, 1.0, 1.0), uC1, 0.3)),
                       0.6);
    float bright = (s == 0 ? 1.7 : (s == 1 ? 0.9 : 0.5)) * (0.55 + 0.7 * sizeJit) * (1.0 + 0.85 * aud);
    float starFade = lerp(s == 2 ? 0.14 : 0.45, 1.0, detail);
    col += tint * star * bright * starFade;

    if (s == 0) {
      float big = smoothstep(1.2, 2.0, sizeJit);
      col += tint * exp(-d * d * 60.0) * (0.18 + 0.34 * aud) * big * tw * starFade;
      float2 dd = (f - sp) * float2(cos(lat), 1.0);
      float spike = exp(-dd.x * dd.x * 1200.0) * exp(-dd.y * dd.y * 26.0)
                  + exp(-dd.y * dd.y * 1200.0) * exp(-dd.x * dd.x * 26.0);
      col += tint * spike * (0.3 + 0.6 * aud) * big * tw * starFade;
      w = max(w, spike * 0.3 * big * starFade);
    }
    w = max(w, star * min(bright, 1.5) * starFade);
  }

  float pa = v1 * 6.28318;
  float3 P = normalize(float3(sin(pa) * 0.9, 1.4 * (v2 - 0.5), cos(pa) * 0.9));
  float pd = max(dot(n, P), 0.0);
  float beat = pow(0.5 + 0.5 * sin(t * (1.2 + v3 + 1.5 * uAudio) + v3 * 6.28), 8.0);
  beat = min(1.0, beat + 0.6 * uAudio);
  float pulsarFade = lerp(0.45, 1.0, detail);
  col += float3(0.9, 0.95, 1.0)
       * (pow(pd, 900.0) * (0.6 + 1.2 * beat) + pow(pd, 110.0) * 0.5 * beat) * pulsarFade;
  w = max(w, pow(pd, 900.0) * (0.5 + 0.5 * beat) * pulsarFade);

  return float4(min(col, float3(1.0, 1.0, 1.0)), min(w, 1.0));
}

float4 sphereAt(float3 n, float spin, float t) {
  float roll = t * 0.13;
  float cr = cos(roll), sr = sin(roll);
  n = float3(cr * n.x - sr * n.y, sr * n.x + cr * n.y, n.z);

  float tilt = 0.45 + 0.35 * sin(t * 0.24);
  float cx = cos(tilt), sx = sin(tilt);
  n = float3(n.x, cx * n.y - sx * n.z, sx * n.y + cx * n.z);

  float cs = cos(spin), ss = sin(spin);
  n = float3(cs * n.x + ss * n.z, n.y, -ss * n.x + cs * n.z);

  return starfield(n, t);
}

float4 shade(float2 p) {
  float r = length(p);
  float t = uTime * 0.8 + uPhase;

  float wIdle   = stateW(uState, 0.0);
  float wListen = stateW(uState, 1.0);
  float wThink  = stateW(uState, 2.0);
  float wSpeak  = stateW(uState, 3.0);
  float wSum = max(wIdle + wListen + wThink + wSpeak, 0.0001);
  wIdle /= wSum; wListen /= wSum; wThink /= wSum; wSpeak /= wSum;

  float rr = min(r, 0.9995);
  float z = sqrt(1.0 - rr * rr);
  float3 N = float3(p.x, p.y, z);
  float fres = pow(1.0 - z, 2.4);

  float3 I = float3(0.0, 0.0, -1.0);
  float3 R = refract(I, N, 0.75);
  float dHit = -2.0 * dot(N, R);
  float3 B = normalize(N + R * dHit);

  float sv = frac(uPhase * 6.31);
  float sw = frac(uPhase * 2.17);
  float tWarp = t
    + (0.9 + 1.3 * sv) * sin(t * (0.09 + 0.07 * sw))
    + (0.5 + 0.8 * sw) * sin(t * (0.21 + 0.09 * sv) + 2.6);

  float4 front = sphereAt(N, uSpin, tWarp);
  float4 back = sphereAt(B, uSpin, tWarp * 0.8 + 2.7);

  float3 voidCol = lerp(uAnchor * 0.05, uAnchor * 0.40, fres);
  float3 col = lerp(voidCol, voidCol + uBg * 0.18, 1.0 - fres);

  float fa = clamp(front.a, 0.0, 1.0);
  float ba = clamp(back.a, 0.0, 1.0);
  col = lerp(col, back.rgb, ba * 0.16);
  col = lerp(col, front.rgb, fa * 0.85);

  float coolLum = dot(col, float3(0.299, 0.587, 0.114));
  col = lerp(col, coolLum.xxx * float3(0.74, 0.88, 1.22), wListen * 0.5);

  float bodyA = 0.34 + 0.46 * fres;
  float alpha = clamp(bodyA + fa * 0.72 + ba * 0.10, 0.0, 1.0);

  float alon = atan2(N.x, N.z);
  float speech = pow(0.5 + 0.5 * sin(alon * 3.0 + sin(alon * 7.0 + t * 1.1) * 0.7 + t * 0.5), 3.0)
               * (0.55 + 0.45 * sin(alon * 5.0 - t * 0.65 + 1.7));
  float sky = -N.y;
  float hang = smoothstep(-0.15, 0.5, sky);
  float rays = 0.7 + 0.3 * sin(alon * 24.0 + sin(alon * 9.0 - t * 0.8) * 2.0 + t * 1.6);
  float aur = clamp(speech, 0.0, 1.0) * hang * rays * (1.0 + 2.2 * uAudio);
  float av = frac(uPhase * 2.93);
  float3 aurCol = lerp(float3(0.12, 0.95, 0.55), float3(0.45, 0.35, 1.0),
                       smoothstep(0.0, 0.95, sky + 0.35 * speech));
  aurCol = lerp(aurCol, lerp(uC0, uC2, av), 0.15 + 0.4 * av);
  float aurGain = wIdle * 0.42 + wListen * 0.72 + wThink * 0.50 + wSpeak * 1.30;
  col += aurCol * aur * 0.8 * aurGain;

  float met = 4.5 + 3.5 * frac(uPhase * 4.91);
  float3 m0 = meteorTrail(p, t, met, 0.0);
  col += (float3(1.0, 1.0, 1.0) * m0.x * 1.2 + lerp(float3(1.0, 1.0, 1.0), uC1, 0.3) * m0.y * 0.85) * m0.z;
  if (wThink > 0.01) {
    float3 m1 = meteorTrail(p, t, met * 0.61, 0.37);
    col += (float3(1.0, 1.0, 1.0) * m1.x * 1.1 + lerp(float3(1.0, 1.0, 1.0), uC1, 0.3) * m1.y * 0.8) * m1.z * wThink;
  }

  float thinkPulse = 0.42 + 0.58 * pow(0.5 + 0.5 * sin(t * 3.1 + uPhase * 4.0), 2.0);
  col += lerp(uC1, float3(1.0, 1.0, 1.0), 0.35) * pow(1.0 - rr, 3.0) * wThink * thinkPulse * 1.15;
  float beadA = t * 1.35 + uPhase * 3.0;
  float2 bead = float2(cos(beadA), sin(beadA)) * 0.42;
  float2 bd = p - bead;
  col += lerp(uC2, float3(1.0, 1.0, 1.0), 0.30) * exp(-dot(bd, bd) * 55.0) * wThink * 0.5;

  float3 LD = normalize(float3(0.85 * sin(t * 0.42), 0.45 * sin(t * 0.26 + 1.2), 0.5));
  float diffuse = 0.62 + 0.65 * max(dot(N, LD), 0.0);
  diffuse *= 1.0 + 0.35 * uAudio;
  col *= diffuse;

  float3 voiceCol = lerp(uC1, float3(1.0, 0.97, 0.9), 0.45);
  col += voiceCol * pow(1.0 - rr, 1.8) * uAudio * (0.5 + 0.35 * wSpeak);
  col += (uC1 * 0.7 + float3(0.12, 0.12, 0.12)) * fres * uAudio * (0.65 + 0.55 * wListen);

  col += col * uAudio * 0.18 * sin(t * 14.0 + rr * 40.0 + uPhase * 7.0);

  float counter = max(dot(N.xy, -LD.xy), 0.0) * fres;
  col += lerp(uC0, float3(0.5, 0.6, 0.9), 0.5) * counter * 0.18;

  float3 L1 = normalize(float3(-0.45 + 0.3 * sin(t * 0.34),
                               0.62 + 0.2 * sin(t * 0.27 + 1.7), 0.64));
  float keyAmp = 0.5 * (0.78 + 0.22 * sin(t * 0.45 + 2.2));
  col += pow(max(dot(N, L1), 0.0), 150.0) * keyAmp;

  float3 LS = normalize(float3(sin(t * 0.07) * 0.9, 0.35 + 0.3 * cos(t * 0.05), 0.7));
  col += pow(max(dot(N, LS), 0.0), 7.0) * 0.05;

  float3 L2 = normalize(float3(0.52, -0.5 + 0.12 * sin(t * 0.09), 0.69));
  col += pow(max(dot(N, L2), 0.0), 140.0) * 0.25;

  col = lerp(col, front.rgb, fa * fres * 0.3);

  float limb = smoothstep(0.94, 1.0, rr);
  col = lerp(col, col * 0.85, limb * 0.4);

  col *= 1.0 - wIdle * 0.16;

  float lum = dot(col, float3(0.299, 0.587, 0.114));
  alpha = clamp(alpha + lum * 0.85, 0.0, 1.0);

  return float4(col, alpha);
}

// ---- native finish: circular cut + bevel -----------------------------------
//
// The web cuts the silhouette in CSS (clip-path + a half-pixel radial mask) and draws
// the bevel as inset box-shadows. No CSS here, so both land on the premultiplied result.
float4 finish(float4 pm, float2 p, float r) {
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
    pm = min(pm + bev.xxxx, float4(1.0, 1.0, 1.0, 1.0));
  }
  return pm;
}

float4 orb_ps(VOut i) : SV_Target {
  float2 p = i.uv * 2.0 - 1.0;
  float r = length(p);

  if (uLens <= 0.0) {
    if (r > 1.0) { discard; return float4(0.0, 0.0, 0.0, 0.0); }
    float4 s = shade(p);
    return finish(float4(s.rgb * s.a, s.a), p, r);
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
    float4 sG = shade(p * (1.0 - k * cG));
    float3 col = float3(shade(p * (1.0 - k * cR)).r,
                        sG.g,
                        shade(p * (1.0 - k * cB)).b);
    float a = sG.a;

    float2 a2 = min(abs(p), 1.0);
    float lobe = max(abs(a2.x * 0.766 + a2.y * 0.643), abs(a2.x * 0.766 - a2.y * 0.643));
    float glow = 0.65 * pow(clamp((lobe - 0.0707) / 1.3435, 0.0, 1.0), 2.4) * fall;
    glow += 1.02 * clamp(1.0 + (r - 1.0) / 0.15, 0.0, 1.0) * step(r, 1.0) * pow(lobe, 2.0);
    col += 0.25 * min(glow, 1.0);
    a = clamp(a + min(glow, 1.0) * 0.6, 0.0, 1.0);

    return finish(float4(col * a, a), p, r);
  }

  float4 s2 = shade(p);
  return finish(float4(s2.rgb * s2.a, s2.a), p, r);
}
)HLSL";

} // namespace orb
