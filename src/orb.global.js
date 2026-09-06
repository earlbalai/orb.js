/*!
 * Orb 1.0.0 — classic-script build.  (c) Earl Balai.  MIT.
 *
 * GENERATED FILE. Do not edit by hand; edit src/orb.js and src/element.js and
 * run:  node scripts/build-embed.mjs
 *
 * It is committed to the repository on purpose: this project is served by Vercel
 * with no build step, so whatever is in git is what customers download.
 *
 *   <script src="https://xyorb.vidome.app/v1/orb.global.js"></script>
 *   <orb-js seed="agent-7" size="160"></orb-js>
 *
 * No module syntax, no bundler runtime, no globals besides window.Orb. The
 * <orb-js> element registers itself as soon as this file runs. window.Orb is
 * both the orb class and the namespace:
 *
 *   var Orb = window.Orb, createOrb = Orb.createOrb;
 *   var orb = Orb.mount(document.getElementById('orb'), { seed: 'a' });
 *
 * Namespace: ARCHETYPES, audioReady, closeAudio, createAudioSource, createOrb, defineOrbElement, diagnostics, dispose, GLSL, hashSeed, HUES, identityForSeed, isSupported, loseContextForTesting, makePalette, Orb, OrbAudioSource, OrbElement, PALETTES, resetCounters, resumeAudio, setBatching, STATES, TAG, toRGB, version
 *
 * Prefer the ES module where you can write one:
 *   <script type="module" src="https://xyorb.vidome.app/v1/element.js"></script>
 */
;(function (globalScope) {
  'use strict';

  /* ══ src/orb.js ══════════════════════════════════════════════════════════ */
  var __orb_core = (function () {
  'use strict';
/**
 * Orb. An audio-reactive procedural galaxy sealed inside a glass sphere, for
 * voice agents. © Earl Balai, MIT.
 *
 * Zero dependencies. WebGL1 / GLSL ES 1.00. No build step.
 *
 * No geometry anywhere in here. Each orb is a four-vertex TRIANGLE_STRIP over
 * its own square, and the sphere is solved in the fragment shader:
 *
 *     rr = min(r, 0.9995)            // r = |p|, p in [-1,1]^2
 *     z  = sqrt(1 - rr*rr)           // near hemisphere
 *     N  = vec3(p.x, p.y, z)         // surface normal, free
 *
 * That normal gives lighting, fresnel, refraction, and two samples of the
 * galaxy: the near wall, and the far wall along the refracted ray. The second
 * sample is what makes it read as glass instead of a textured circle.
 *
 * Quick start:
 *
 *     import { Orb } from './orb.js';
 *
 *     const orb = Orb.mount(document.querySelector('#orb'), {
 *       seed:  'agent-42',
 *       size:  320,
 *       state: 'idle',
 *     });
 *
 *     // a MediaStream, a track, an <audio>, an AnalyserNode, an AudioNode:
 *     const stop = orb.listenTo(remoteStream);
 *
 *     orb.state = 'listening';   // 'idle' | 'listening' | 'thinking' | 'speaking'
 *     orb.level = 0.4;           // or drive it by hand, 0..1
 *     orb.seed  = 'agent-43';    // re-roll the identity, keep the motion
 *
 *     stop();
 *     orb.destroy();
 *
 * Deterministic in `seed`: same string, same hue, archetype, galaxy structure,
 * meteor cadence and starting spin.
 *
 * The four states:
 *
 *   idle       slow drift, dim aurora, low spin.
 *   listening  cool cast; the rim ignites with the human's level.
 *   thinking   no audio at all, but visibly busy: spin roughly triples, a bead
 *              of light orbits the core, an inner pulse breathes, a second
 *              meteor stream runs.
 *   speaking   full reactivity from the agent's audio; the aurora blooms.
 *
 * Transitions crossfade over ~350ms through one smoothed uniform (`uState`).
 * `stateW()` in the GLSL and `stateBasis()` in the dynamics are deliberately
 * the same function.
 *
 * Serving: this is a real ES module, so the page has to come off http(s). A
 * `file://` document has an opaque origin, module scripts are fetched with CORS,
 * and an opaque origin can never satisfy it. Nothing in this file can work
 * around that. Any static server will do:
 *
 *     python -m http.server 8000        # or:  npx serve .
 *
 * Also publishes `globalThis.Orb` for non-module consumers on the page.
 *
 * @module orb
 * @version 1.0.0
 */

/* 1. Constants */

/** Largest edge of the shared hero surface, in device pixels. */
const MAX_PX = 1280;

/** Edge of the instanced batch atlas, in device pixels. */
const ATLAS_PX = 1024;

/** Instance-buffer capacity, in orbs. 1024 * 96 bytes = 96 KB, allocated once. */
const BATCH_MAX_INSTANCES = 1024;

/** 6 vec4 instance attributes = 24 floats = 96 bytes per orb. */
const INSTANCE_FLOATS = 24;

/** Orbs at or below this device size, lens off, go through the atlas. */
const BATCH_MAX_TILE = 128;

/** DPR ceiling. Past 2x the extra galaxy detail is invisible. */
const MAX_DPR = 2;

/** Below this CSS size an orb renders at 1x and skips the chromatic lens. */
const HERO_MIN_SIZE = 48;

/** Smallest orb we will build DOM for. */
const MIN_SIZE = 8;

/** Render cadence cap, in ms. Also the pacing quantum. */
const FRAME_MS = 1000 / 60;

/** Device size the chromatic lens was tuned at; above it the amplitude tapers. */
const LENS_REF_PX = 420;

/** Idle ms with no orbs and no sources before the GPU resources are freed. */
const IDLE_RELEASE_MS = 10000;

/**
 * `preserveDrawingBuffer` is the one that matters: every orb's frame is blitted
 * out of this surface with drawImage after the draw call returns, and the batch
 * path cuts many tiles out of one atlas.
 */
const GL_ATTRS = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: true,
  preserveDrawingBuffer: true,
  depth: false,
  stencil: false,
};

/** The four galaxy archetypes, in shader-index order. */
const ARCHETYPES = ['spiral', 'nebula', 'core', 'deep'];
const ARCHETYPE_INDEX = { spiral: 0, nebula: 1, core: 2, deep: 3 };

/**
 * The four agent states, in shader-index order.
 *
 * The order is load-bearing. `uState` is one smoothed scalar, so a transition
 * slides along this axis, and the axis is the conversational loop:
 * idle -> listening -> thinking -> speaking -> listening. Ordinary transitions
 * are between adjacent states and never pass through a third look. The two
 * non-adjacent jumps (hang-up, and the agent opening the call) sweep the axis in
 * ~350ms, which reads as a wind-down or a wind-up rather than a glitch.
 */
const STATES = ['idle', 'listening', 'thinking', 'speaking'];
const STATE_INDEX = { idle: 0, listening: 1, thinking: 2, speaking: 3 };

/** State crossfade time constant, seconds. 1 - exp(-0.35/0.12) is ~94.5%. */
const STATE_TAU = 0.12;

/**
 * The fourteen identity hues, unevenly spaced. On an even wheel neighbouring
 * seeds land on colours the eye reads as the same one again.
 */
const HUES = [13, 34, 125, 146, 166, 187, 208, 228, 249, 270, 290, 311, 332, 353];

/* 2. GLSL
 *
 * One copy of the galaxy (`GLSL_GALAXY`), compiled into two programs:
 *
 *   hero   one orb per draw, everything a uniform. Dual-layer refraction is
 *          compiled in and the chromatic lens branches on uLens.
 *   batch  many orbs per draw via ANGLE_instanced_arrays. Every hero uniform is
 *          a varying here, filled from per-instance attributes.
 *
 * Only the declaration prologue differs, so the two paths cannot drift apart.
 */

/** Hero vertex shader: a bare fullscreen quad. */
const VERT_HERO = `
attribute vec2 aPos;
attribute vec2 aUV;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/**
 * Batch vertex shader.
 *
 * Six vec4 instance attributes plus aPos/aUV is 8, exactly the WebGL1 floor
 * (MAX_VERTEX_ATTRIBS >= 8). iC2.w was the one spare float in that budget and
 * the agent state lives there, so adding it cost no attribute, no buffer and no
 * change to the 96-byte stride.
 *
 * Varyings: each vec3 gets a row with .w free, absorbing five of the six floats;
 * vUV and uRes share a row; uState takes a seventh. Seven of the 8 guaranteed
 * vectors, budgeted against the spec floor rather than against one GPU.
 */
const VERT_BATCH = `
attribute vec2 aPos;
attribute vec2 aUV;
attribute vec4 iPos;  // cellX, cellY, tilePx, spin
attribute vec4 iDyn;  // audio, phase, arch, time
attribute vec4 iBg;   // bg.rgb, anchor.r
attribute vec4 iAnc;  // anchor.gb, c0.rg
attribute vec4 iC0b;  // c0.b, c1.rgb
attribute vec4 iC2;   // c2.rgb, state
uniform vec2 uCanvas; // atlas size in device px
varying vec2 vUV;
varying vec2 uRes;
varying vec3 uBg, uAnchor, uC0, uC1, uC2;
varying float uPhase, uAudio, uSpin, uArch, uTime, uState;
void main() {
  vUV = aUV;
  uSpin = iPos.w;
  uAudio = iDyn.x;
  uPhase = iDyn.y;
  uArch = iDyn.z;
  uTime = iDyn.w;
  uState = iC2.w;
  uRes = vec2(iPos.z);
  uBg = iBg.rgb;
  uAnchor = vec3(iBg.a, iAnc.x, iAnc.y);
  uC0 = vec3(iAnc.z, iAnc.w, iC0b.x);
  uC1 = iC0b.yzw;
  uC2 = iC2.xyz;
  vec2 pPx = iPos.xy + aUV * iPos.z;          // top-down px within the cell
  float ndcX = pPx.x / uCanvas.x * 2.0 - 1.0;
  float ndcY = 1.0 - pPx.y / uCanvas.y * 2.0; // flip to GL y-up
  gl_Position = vec4(ndcX, ndcY, 0.0, 1.0);
}`;

/**
 * Fragment `highp` is optional in GLSL ES 1.00, and declaring it where it is
 * missing is a hard compile error rather than a silent demotion, hence the
 * guard. mediump does not actually rescue this shader though:
 * fract(sin(x * 127.1) * 43758.5453) at a 10-bit mantissa is noise, not a hash,
 * and pow(pd, 900.0) collapses. The guard only keeps the program compiling.
 * probeHighp() checks the real precision and routes such devices to the static
 * fallback.
 */
const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

/**
 * The galaxy and the glass body, shared verbatim by both programs.
 *
 * Reads uRes / uBg / uAnchor / uC0..2 / uTime / uPhase / uAudio / uSpin / uArch /
 * uState: uniforms in one program, varyings in the other. Declared in the
 * per-program prologue.
 */
const GLSL_GALAXY = `
// One 1D hash behind every star position, magnitude, colour temperature, grain
// cell and meteor trajectory below.
float h1(float x) { return fract(sin(x * 127.1) * 43758.5453); }

// Agent-state basis. uState is one smoothed float in [0,3] (0 idle, 3 speaking);
// the CPU has already eased it, so what arrives here is never a step.
//
// Plateau-ramp: exactly 1 within +/-0.35 of a state, easing to 0 a unit away.
// The plateau is what stops each state reading as a permanent blend of its
// neighbours. shade() normalises the four weights, so a transition dissolves one
// look into the next rather than summing them into a brighter mush.
//
// stateBasis() in the JS is the same function, and the spin integrator uses it.
// Keep them in step.
float stateW(float s, float i) { return 1.0 - smoothstep(0.35, 1.0, abs(s - i)); }

// One meteor stream: white-hot head, fading tail. Returns (headGlow, tail, vis).
// The epoch index seeds the trajectory, so every fragment in a pass agrees on it.
//
// 'off' shifts the clock AND the epoch index, which is how thinking gets a
// second independent stream. What it must not do is shorten the period of the
// existing one: floor(t / met) jumps the moment met changes, teleporting a
// meteor mid-flight on every crossfade. Adding a stream is glitch-free,
// retuning one is not.
vec3 meteorTrail(vec2 p, float t, float met, float off) {
  float tt = t + off * met;
  float epoch = floor(tt / met) + off * 17.0;
  float ph = fract(tt / met);
  vec2 s0 = vec2(-1.1 + 2.2 * h1(epoch * 1.3), 0.85 - 1.4 * h1(epoch * 2.9));
  vec2 sd = normalize(vec2(0.7 + 0.5 * h1(epoch * 4.1), -0.35 - 0.4 * h1(epoch * 5.3)));
  vec2 head = s0 + sd * ph * 2.8;
  vec2 rel = p - head;
  float along = dot(rel, sd);
  float perp = dot(rel, vec2(-sd.y, sd.x));
  float vis = smoothstep(0.0, 0.06, ph) * smoothstep(0.5, 0.32, ph);
  float tail = exp(-perp * perp * 1600.0) * exp(along * 9.0) * step(along, 0.0)
             * smoothstep(-0.5, -0.02, along);
  float headGlow = exp(-dot(rel, rel) * 900.0);
  return vec3(headGlow, tail, vis);
}

// A whole sky as a pure function of a point on the unit sphere: tilted band of
// star dust, nebula pockets, dust lanes, three magnitude classes of twinkling
// stars, shear streaks, a pulsar.
//
// Integer rule: every frequency applied to 'lon' must be a whole number. lon is
// atan(), so it wraps at +/-pi; a fractional frequency does not tile across that
// seam and stamps a hard crease down the sphere that tumbles into view once per
// rotation. Every literal multiplying lon below is an integer on purpose.
vec4 starfield(vec3 n, float t) {
  float lon = atan(n.z, n.x);
  float lat = asin(clamp(n.y, -1.0, 1.0));

  // Three decorrelated variates off the seed phase. Band tilt, undulation,
  // width, star census, pocket hues, core direction, pulsar position and meteor
  // cadence all come off these. This is where one orb stops looking like another.
  float v1 = fract(uPhase * 7.13);
  float v2 = fract(uPhase * 3.71);
  float v3 = fract(uPhase * 5.37);

  // Archetype. uArch < 0 means derive it from the seed phase.
  //   0 spiral  a Milky-Way band
  //   1 nebula  vivid cloud over the whole sky, star-poor
  //   2 core    blazing warm bulge, star-rich
  //   3 deep    near-empty void, sparse and crystalline
  float at = uArch >= 0.0 ? uArch : floor(fract(uPhase * 9.73) * 4.0);
  float isNeb  = step(0.5, at) * (1.0 - step(1.5, at));
  float isCore = step(1.5, at) * (1.0 - step(2.5, at));
  float isDeep = step(2.5, at);

  // Density concentrates in a gaussian band around a tilted, gently undulating
  // equator. gb is signed distance from it, in radians.
  float gb = lat + (0.15 + 0.4 * v1) * sin(lon * (1.0 + floor(v2 * 2.0)) + 1.3)
           + 0.12 * sin(lon * 3.0 + t * 0.1);
  float band = exp(-gb * gb * (5.0 + 10.0 * v3));
  band = mix(band, max(band, 0.8), isNeb);   // nebula: cloud everywhere
  band *= 1.0 - 0.85 * isDeep;               // deep field: almost nothing

  // Two octaves of domain-warped wisps for the nebula, a third for the dust
  // lanes cutting across the bright band.
  float n1 = sin(lon * 2.0 + sin(lat * 3.0 + t * 0.25) * 1.6 + t * 0.15);
  float n2 = sin(lon * 5.0 - sin(lat * 4.0 - t * 0.2) * 1.2 - t * 0.22 + 2.4);
  float neb = pow(0.5 + 0.5 * n1, 2.0) * (0.45 + 0.55 * pow(0.5 + 0.5 * n2, 2.0));
  float lane = pow(0.5 + 0.5 * sin(lon * 4.0 + lat * 7.0 + sin(lon * 2.0) * 2.0), 3.0);
  float galaxy = clamp(band * neb * (1.0 - lane * (0.55 + 0.35 * v2)), 0.0, 1.0);

  // Real galactic dust is mostly cool blue-white haze. The palette rides on top
  // as a cast, re-saturated so it survives the mixing. How hard the dust leans
  // into the palette varies per orb, so a screen full of orbs reads as different
  // skies rather than one recoloured sky.
  vec3 hue = mix(mix(uC0, uC1, v1), mix(uC1, uC2, v3),
                 0.5 + 0.5 * sin(lon + lat * 2.0 - t * 0.2));
  vec3 hueGrey = vec3(dot(hue, vec3(0.299, 0.587, 0.114)));
  hue = clamp(hueGrey + (hue - hueGrey) * 1.45, 0.0, 1.0);
  vec3 dust = mix(vec3(0.72, 0.78, 0.92), hue, 0.45 + 0.3 * v1 + 0.45 * isNeb);

  // Squaring pulls the floor down so room noise does not keep the whole galaxy
  // lit, while peaks still reach full strength. aud drives brightness, audT
  // (linear, gentler) drives rates so nothing strobes.
  float aud  = uAudio * uAudio;
  float audT = uAudio;

  vec3 col = dust * galaxy * (0.6 + 0.9 * isNeb) * (1.0 + 0.85 * aud);

  // Orbital shear: faint drifting streaks inside the band. Without them the
  // galaxy only slides across the sphere instead of turning.
  float shear = sin(lon * 13.0 + lat * 4.0 - t * 0.35) * sin(lon * 5.0 + t * 0.2);
  col += dust * band * neb * max(shear, 0.0) * (0.14 + 0.26 * aud);

  // Second, fainter arm crossing the main band. Spiral depth.
  float gb2 = lat - (0.35 + 0.25 * v2) * sin(lon * 2.0 - 1.1) + 0.4;
  float arm = exp(-gb2 * gb2 * 7.0) * neb;
  col += mix(dust, uC1, 0.35) * arm * 0.2;

  // The void is never pure black: a breathing whisper of deep indigo carrying
  // the orb's hue. It covers the whole sphere, so it is the strongest identity
  // cue in the image.
  vec3 voidGlow = mix(vec3(0.04, 0.03, 0.1), mix(uC0, mix(uC1, uC2, v3), v1) * 0.22, 0.75);
  col += voidGlow * (0.5 + 0.22 * sin(t * 0.4 + lon)) * (0.4 + 0.6 * band);

  // Warm amber deep inside the densest part of the band.
  col += vec3(1.0, 0.88, 0.68) * pow(band, 4.0) * pow(neb, 2.0) * (0.4 + 0.55 * aud);

  // core archetype: bulge pinned to the rotating sphere (n, not the view
  // normal), so it wheels around the limb as the galaxy turns.
  float ca = v2 * 6.28318;
  vec3 Cdir = normalize(vec3(cos(ca) * 0.85, 0.6 * (v3 - 0.5), sin(ca) * 0.85));
  float bulge = max(dot(n, Cdir), 0.0);
  col += mix(vec3(1.0, 0.85, 0.6), uC2, 0.25)
       * (pow(bulge, 14.0) * 1.6 + pow(bulge, 4.0) * 0.5) * isCore;

  // Two layers of nebula pocket in different hues, slowly breathing.
  float pocket = pow(neb, 5.0) * band * (0.7 + 0.3 * sin(t * (0.6 + 1.6 * audT) + lon * 3.0));
  col += mix(uC2, uC0, fract(v1 + 0.5 * sin(lon * 2.0) + 0.5))
       * pocket * (0.5 + 0.4 * v2 + 0.8 * isNeb) * (1.0 + 1.1 * aud);
  float pocket2 = pow(0.5 + 0.5 * sin(lon * 3.0 + lat * 4.0 - t * 0.18 + 2.0), 6.0) * band;
  col += mix(uC1, uC2, v3) * pocket2 * (0.25 + 0.3 * v1 + 0.5 * isNeb) * (1.0 + 0.9 * aud);

  // Detail budget by rendered size, not CSS size. Below ~90 device px the fine
  // grain and the faint star class stop reading as texture and start strobing
  // as the sphere tumbles, so they fade out.
  float detail = smoothstep(90.0, 200.0, uRes.y);

  // Sub-pixel star dust packed into the band. Long exposure rather than
  // gradient.
  vec2 gg = vec2(lon, lat) * 34.0;
  vec2 gc = floor(gg);
  vec2 gf = fract(gg);
  float gh = h1(gc.x * 3.7 + gc.y * 11.3);
  vec2 gp = vec2(0.2 + 0.6 * h1(gh * 91.0), 0.2 + 0.6 * h1(gh * 47.0));
  // cos(lat) stretch keeps grains and stars round where the lat/lon
  // parameterisation converges at the poles.
  float gd = length((gf - gp) * vec2(cos(lat), 1.0));
  // Sharper than this and each grain lands on ~1px of a ~3px cell, which reads
  // as pixel noise rather than dust. Wider gaussian, fewer lit cells, same
  // long-exposure texture without the speckle.
  float grain = exp(-gd * gd * 240.0 * clamp(uRes.y / 420.0, 0.22, 1.0))
              * step(0.58, gh) * (0.15 + 0.85 * band);
  col += vec3(0.88, 0.9, 1.0) * grain * 0.32 * detail;

  // w is this layer's alpha: how much of the glass the sky replaces.
  float w = clamp(galaxy * 0.7 + pow(band, 4.0) * 0.25, 0.0, 1.0);

  // Three magnitude classes on three lattice scales: a few bright, many mid,
  // dense faint dust. Constant bound, index never assigned, so it stays inside
  // GLSL ES 1.00 Appendix A.
  for (int s = 0; s < 3; s++) {
    float K = s == 0 ? 6.0 : (s == 1 ? 11.0 : 19.0);
    vec2 g = vec2(lon, lat) * K;
    vec2 cell = floor(g);
    vec2 f = fract(g);
    float hx = h1(cell.x * 13.7 + cell.y * 7.3 + float(s) * 91.0);
    float hy = h1(cell.x * 5.1 + cell.y * 17.9 + float(s) * 37.0);
    vec2 sp = vec2(0.15 + 0.7 * hx, 0.15 + 0.7 * hy);
    float d = length((f - sp) * vec2(cos(lat), 1.0));

    // Star census by archetype: nebulae star-poor, cores star-rich, deep fields
    // sparse.
    float census = (v2 - 0.5) * 0.2 + 0.35 * isNeb - 0.2 * isCore + 0.3 * isDeep;
    // Audio lowers the visibility threshold, so fainter stars fade in as the
    // voice rises and the sky deepens while the agent speaks.
    float keep = step((s == 2 ? 0.3 : 0.55) + census - 0.16 * aud,
                      h1(hx * 89.0 + hy * 31.0) + band * 0.25);

    // At small sizes a star has to stay ~1px wide and twinkle gently or it
    // aliases into strobing as the sphere tumbles.
    float resFac = clamp(uRes.y / 420.0, 0.22, 1.0);
    // Audio drives rate and depth of scintillation together. Clamped at zero so
    // the faintest stars wink right out at high depth; without that it reads as
    // a brightness ramp, not twinkle.
    float twRate  = (1.5 + 3.0 * hx) * (1.0 + 2.4 * audT);
    float twDepth = 0.4 + 0.42 * aud;
    float tw = mix(0.92, max(0.0, (1.0 - twDepth) + twDepth * sin(t * twRate + hx * 40.0)), resFac);

    // Radius from the hash, squared, so there are few big ones and many small.
    // Brightness follows size, roughly a real magnitude distribution.
    float hz = h1(hx * 53.0 + hy * 71.0 + cell.x);
    float sizeJit = 0.35 + 1.8 * hz * hz;
    float sharp = (s == 0 ? 260.0 : (s == 1 ? 700.0 : 1600.0)) / (sizeJit * (1.0 + 0.35 * aud)) * resFac;
    float star = exp(-d * d * sharp) * keep * tw;

    // Near-white with a faint colour-temperature spread.
    vec3 tint = mix(vec3(1.0),
                    hx < 0.33 ? vec3(0.85, 0.9, 1.0)
                              : (hx < 0.66 ? vec3(1.0, 0.95, 0.85) : mix(vec3(1.0), uC1, 0.3)),
                    0.6);
    float bright = (s == 0 ? 1.7 : (s == 1 ? 0.9 : 0.5)) * (0.55 + 0.7 * sizeJit) * (1.0 + 0.85 * aud);
    float starFade = mix(s == 2 ? 0.14 : 0.45, 1.0, detail);
    col += tint * star * bright * starFade;

    // Brightest class gets a halo and a diffraction cross.
    if (s == 0) {
      float big = smoothstep(1.2, 2.0, sizeJit);
      col += tint * exp(-d * d * 60.0) * (0.18 + 0.34 * aud) * big * tw * starFade;
      vec2 dd = (f - sp) * vec2(cos(lat), 1.0);
      float spike = exp(-dd.x * dd.x * 1200.0) * exp(-dd.y * dd.y * 26.0)
                  + exp(-dd.y * dd.y * 1200.0) * exp(-dd.x * dd.x * 26.0);
      col += tint * spike * (0.3 + 0.6 * aud) * big * tw * starFade;
      w = max(w, spike * 0.3 * big * starFade);
    }
    w = max(w, star * min(bright, 1.5) * starFade);
  }

  // One flashing star per orb, with a halo. pow(pd, 900) is tight enough to be
  // a point; audio pushes the beat brighter and faster.
  float pa = v1 * 6.28318;
  vec3 P = normalize(vec3(sin(pa) * 0.9, 1.4 * (v2 - 0.5), cos(pa) * 0.9));
  float pd = max(dot(n, P), 0.0);
  float beat = pow(0.5 + 0.5 * sin(t * (1.2 + v3 + 1.5 * uAudio) + v3 * 6.28), 8.0);
  beat = min(1.0, beat + 0.6 * uAudio);
  float pulsarFade = mix(0.45, 1.0, detail);
  col += vec3(0.9, 0.95, 1.0)
       * (pow(pd, 900.0) * (0.6 + 1.2 * beat) + pow(pd, 110.0) * 0.5 * beat) * pulsarFade;
  w = max(w, pow(pd, 900.0) * (0.5 + 0.5 * beat) * pulsarFade);

  return vec4(min(col, vec3(1.0)), min(w, 1.0));
}

// Sample the tumbling sphere. Three composed rotations: a roll about the view
// axis, a tilt about x whose angle precesses, and the CPU-integrated spin about
// y. One rotation only slides the pattern sideways; three give a marble turned
// in the hand, so the galaxy travels over the poles and never repeats a pass.
vec4 sphereAt(vec3 n, float spin, float t) {
  float roll = t * 0.13;
  float cr = cos(roll), sr = sin(roll);
  n = vec3(cr * n.x - sr * n.y, sr * n.x + cr * n.y, n.z);

  float tilt = 0.45 + 0.35 * sin(t * 0.24);
  float cx = cos(tilt), sx = sin(tilt);
  n = vec3(n.x, cx * n.y - sx * n.z, sx * n.y + cx * n.z);

  float cs = cos(spin), ss = sin(spin);
  n = vec3(cs * n.x + ss * n.z, n.y, -ss * n.x + cs * n.z);

  return starfield(n, t);
}

// The whole orb as a pure function of the pre-lens screen point p. Purity is
// required: the chromatic lens in main() calls this three times per fragment at
// three displaced coordinates and keeps one channel from each.
vec4 shade(vec2 p) {
  float r = length(p);
#ifndef DUAL_LAYER
  // No lens in the batch program, so nothing ever samples a tile's corners.
  // Discarding them skips the galaxy for ~21% of the fragments.
  if (r > 1.0) { discard; }
#endif
  float t = uTime * 0.8 + uPhase;

  // Four normalised weights off one smoothed scalar. Everything per-state below
  // is a lerp against these, so a change dissolves rather than cuts, and the sum
  // stays 1 so no state can brighten the orb just by existing.
  float wIdle   = stateW(uState, 0.0);
  float wListen = stateW(uState, 1.0);
  float wThink  = stateW(uState, 2.0);
  float wSpeak  = stateW(uState, 3.0);
  float wSum = max(wIdle + wListen + wThink + wSpeak, 0.0001);
  wIdle /= wSum; wListen /= wSum; wThink /= wSum; wSpeak /= wSum;

  // Clamping rr just under 1 closes three NaN paths at once: sqrt(1 - rr*rr)
  // never takes a negative radicand, refract()'s internal k = 1 - 0.5625*rr^2
  // stays >= 0.4376 so it cannot hit total internal reflection and return
  // vec3(0.0), and normalize(N + R*dHit) therefore never sees the zero vector.
  //
  // Past r = 1 the colours smear outward. That overscan is deliberate: the lens
  // needs real pixels to displace, or it pulls transparent samples and stamps a
  // hard arc inside the silhouette. The circular cut happens in CSS.
  float rr = min(r, 0.9995);
  float z = sqrt(1.0 - rr * rr);
  vec3 N = vec3(p.x, p.y, z);
  float fres = pow(1.0 - z, 2.4);          // 0 at the centre -> 1 at the limb

  // Dual-layer glass. Refract at the near wall, follow the ray through the body,
  // sample the galaxy again where it exits the far wall.
  //
  // For a unit sphere the chord from surface point N along unit direction R has
  // length -2*dot(N, R): |N + dR|^2 = 1 with |N| = 1 gives d^2 + 2d*dot(N,R) = 0.
  // So the exit point is N + R*dHit and normalize() only mops up float error.
  // No marching, no iteration.
  vec3 I = vec3(0.0, 0.0, -1.0);
  vec3 R = refract(I, N, 0.75);
  float dHit = -2.0 * dot(N, R);
  vec3 B = normalize(N + R * dHit);

  // Pattern time gets a non-linear warp from two incommensurate sines so the
  // drift never settles into a visible loop. Spin angle is separate, integrated
  // on the CPU (uSpin), so it can accelerate, ease and reverse.
  float sv = fract(uPhase * 6.31);
  float sw = fract(uPhase * 2.17);
  float tWarp = t
    + (0.9 + 1.3 * sv) * sin(t * (0.09 + 0.07 * sw))
    + (0.5 + 0.8 * sw) * sin(t * (0.21 + 0.09 * sv) + 2.6);

  // Both layers ride the same rotating sphere, so the far wall counter-slides in
  // true perspective as the ball turns and it reads as one object.
  vec4 front = sphereAt(N, uSpin, tWarp);
#ifdef DUAL_LAYER
  vec4 back = sphereAt(B, uSpin, tWarp * 0.8 + 2.7);
#else
  vec4 back = vec4(0.0);
#endif

  // Near-black void carrying the anchor colour, brighter at the rim. uBg leaks
  // through at a few percent, which is what keeps the orb reading as translucent
  // glass instead of a flat disc, and why 'background' has to track the page
  // rather than be hard-coded.
  vec3 voidCol = mix(uAnchor * 0.05, uAnchor * 0.40, fres);
  // A little of the page's light scatters through the body. The page itself is
  // not painted here: we emit real coverage below and let the compositor put the
  // actual backdrop behind us, so this works over a card, a gradient or a photo
  // and not only over the one colour we guessed.
  vec3 col = mix(voidCol, voidCol + uBg * 0.18, 1.0 - fres);

  // mix, not add: the band replaces the glass colour where it lives, so it still
  // reads on a light page instead of clipping to white.
  float fa = clamp(front.a, 0.0, 1.0);
  float ba = clamp(back.a, 0.0, 1.0);
  col = mix(col, back.rgb, ba * 0.16);     // far-wall echo, deliberately faint
  col = mix(col, front.rgb, fa * 0.85);

  // listening: cool cast on the body only, before aurora, meteors and speculars
  // go in, so the orb cools without the highlights going dead. Desaturating
  // toward grey and re-tinting keeps the luminance, so it is the same brightness
  // as idle, just colder.
  float coolLum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(coolLum) * vec3(0.74, 0.88, 1.22), wListen * 0.5);

  // Coverage handed to the compositor. Glass haze thickens toward the limb
  // (fresnel) and the galaxy occludes what it covers.
  float bodyA = 0.34 + 0.46 * fres;
  float alpha = clamp(bodyA + fa * 0.72 + ba * 0.10, 0.0, 1.0);

  // Aurora, drawn in view space rather than sphere space so the curtains always
  // hang in the visible upper sky while the galaxy tumbles behind them. Green at
  // the base climbing into violet, pulled toward the orb's palette by a per-orb
  // amount.
  float alon = atan(N.x, N.z);
  float speech = pow(0.5 + 0.5 * sin(alon * 3.0 + sin(alon * 7.0 + t * 1.1) * 0.7 + t * 0.5), 3.0)
               * (0.55 + 0.45 * sin(alon * 5.0 - t * 0.65 + 1.7));
  float sky = -N.y;                        // the quad's v is flipped: -N.y is up
  float hang = smoothstep(-0.15, 0.5, sky);
  float rays = 0.7 + 0.3 * sin(alon * 24.0 + sin(alon * 9.0 - t * 0.8) * 2.0 + t * 1.6);
  float aur = clamp(speech, 0.0, 1.0) * hang * rays * (1.0 + 2.2 * uAudio);
  float av = fract(uPhase * 2.93);
  vec3 aurCol = mix(vec3(0.12, 0.95, 0.55), vec3(0.45, 0.35, 1.0),
                    smoothstep(0.0, 0.95, sky + 0.35 * speech));
  aurCol = mix(aurCol, mix(uC0, uC2, av), 0.15 + 0.4 * av);
  // Loudest state cue in the image. Thinking stays low deliberately, so the core
  // is what reads as busy.
  float aurGain = wIdle * 0.42 + wListen * 0.72 + wThink * 0.50 + wSpeak * 1.30;
  col += aurCol * aur * 0.8 * aurGain;

  // A meteor every few seconds on a fresh trajectory. Thinking adds a second
  // stream on a shorter offset clock, which quickens the sky without the primary
  // stream ever jumping (see meteorTrail). wThink is constant across an orb, so
  // the branch costs nothing in divergence and skips the work in the other three
  // states.
  float met = 4.5 + 3.5 * fract(uPhase * 4.91);
  vec3 m0 = meteorTrail(p, t, met, 0.0);
  col += (vec3(1.0) * m0.x * 1.2 + mix(vec3(1.0), uC1, 0.3) * m0.y * 0.85) * m0.z;
  if (wThink > 0.01) {
    vec3 m1 = meteorTrail(p, t, met * 0.61, 0.37);
    col += (vec3(1.0) * m1.x * 1.1 + mix(vec3(1.0), uC1, 0.3) * m1.y * 0.8) * m1.z * wThink;
  }

  // thinking: no external audio in this state, so the activity has to be
  // intrinsic. A deep inner pulse breathing at ~0.5 Hz, phase-offset per orb,
  // and a bead of light orbiting the core, which is the part the eye tracks.
  // Spin roughly triples on the CPU side at the same time (advanceDynamics).
  float thinkPulse = 0.42 + 0.58 * pow(0.5 + 0.5 * sin(t * 3.1 + uPhase * 4.0), 2.0);
  col += mix(uC1, vec3(1.0), 0.35) * pow(1.0 - rr, 3.0) * wThink * thinkPulse * 1.15;
  float beadA = t * 1.35 + uPhase * 3.0;
  vec2 bead = vec2(cos(beadA), sin(beadA)) * 0.42;
  vec2 bd = p - bead;
  col += mix(uC2, vec3(1.0), 0.30) * exp(-dot(bd, bd) * 55.0) * wThink * 0.5;

  // A broad diffuse terminator sweeping around the sphere, brightening whole
  // regions of sky and dust in turn. Makes the ball feel lit rather than printed.
  vec3 LD = normalize(vec3(0.85 * sin(t * 0.42), 0.45 * sin(t * 0.26 + 1.2), 0.5));
  float diffuse = 0.62 + 0.65 * max(dot(N, LD), 0.0);
  diffuse *= 1.0 + 0.35 * uAudio;          // the whole sky breathes with the voice
  col *= diffuse;

  // Voice light. Speaking pushes the inner flare, listening pushes the rim
  // instead: same level, different reading. The agent lights from within when it
  // talks and catches the room's light at its edge when it is taking the room in.
  vec3 voiceCol = mix(uC1, vec3(1.0, 0.97, 0.9), 0.45);
  col += voiceCol * pow(1.0 - rr, 1.8) * uAudio * (0.5 + 0.35 * wSpeak);  // inner flare
  col += (uC1 * 0.7 + vec3(0.12)) * fres * uAudio * (0.65 + 0.55 * wListen);  // rim catch

  // Concentric shockwaves while the voice is live. Keyed off the radius so the
  // ring spacing scales with the orb, and multiplied by col so it only lights
  // what is already bright.
  col += col * uAudio * 0.18 * sin(t * 14.0 + rr * 40.0 + uPhase * 7.0);

  // Faint atmospheric scatter opposite the moving key light.
  float counter = max(dot(N.xy, -LD.xy), 0.0) * fres;
  col += mix(uC0, vec3(0.5, 0.6, 0.9), 0.5) * counter * 0.18;

  // Speculars off the sphere normal. The key light drifts and breathes in
  // intensity. A highlight that sits still reads as CG immediately.
  vec3 L1 = normalize(vec3(-0.45 + 0.3 * sin(t * 0.34),
                            0.62 + 0.2 * sin(t * 0.27 + 1.7), 0.64));
  float keyAmp = 0.5 * (0.78 + 0.22 * sin(t * 0.45 + 2.2));
  col += vec3(1.0) * pow(max(dot(N, L1), 0.0), 150.0) * keyAmp;

  vec3 LS = normalize(vec3(sin(t * 0.07) * 0.9, 0.35 + 0.3 * cos(t * 0.05), 0.7));
  col += vec3(1.0) * pow(max(dot(N, LS), 0.0), 7.0) * 0.05;        // broad soft sheen

  vec3 L2 = normalize(vec3(0.52, -0.5 + 0.12 * sin(t * 0.09), 0.69));
  col += vec3(1.0) * pow(max(dot(N, L2), 0.0), 140.0) * 0.25;      // counter glint

  // A bubble's edge catches a touch of the band's colour.
  col = mix(col, front.rgb, fa * fres * 0.3);

  // Whisper of limb darkening.
  float limb = smoothstep(0.94, 1.0, rr);
  col = mix(col, col * 0.85, limb * 0.4);

  // idle: last word, over everything including the speculars, so the orb goes
  // uniformly quieter rather than selectively dull. Landing before the luminance
  // term below also makes it slightly more transparent, which suits waiting.
  col *= 1.0 - wIdle * 0.16;

  // Everything added after the body is emitted light and has to survive on any
  // backdrop, so luminance drives coverage: bright things go opaque, the dark
  // glass body stays translucent and the page shows through.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  alpha = clamp(alpha + lum * 0.85, 0.0, 1.0);

  return vec4(col, alpha);
}`;

/**
 * Hero fragment program: dual-layer glass plus the in-shader chromatic lens.
 *
 * The discard has to be absent whenever the lens is on, or the lens pulls
 * transparent samples from outside the disc and stamps a hard arc inside the
 * sphere. Tying it to `uLens <= 0` makes that invariant automatic instead of
 * needing two compiled variants. uLens is a uniform, so the branch is
 * dynamically uniform and the discard costs no divergence.
 */
const FRAG_HERO = PRECISION + `
#define DUAL_LAYER
varying vec2 vUV;
uniform vec2  uRes;          // rendered size in device px, drives the detail budget
uniform vec3  uBg;           // page colour bleeding through the glass
uniform vec3  uAnchor;       // identity anchor colour
uniform vec3  uC0, uC1, uC2; // three luminance-compensated accents
uniform float uTime;         // seconds
uniform float uPhase;        // seed phase; all per-orb structure comes off this
uniform float uAudio;        // 0..1 slow envelope
uniform float uSpin;         // CPU-integrated spin angle (accelerates, reverses)
uniform float uArch;         // archetype override; < 0 = derive from the seed
uniform float uLens;         // lens displacement in p-units; 0 = off
uniform float uState;        // smoothed agent state, 0 idle .. 3 speaking
` + GLSL_GALAXY + `

void main() {
  vec2 p = vUV * 2.0 - 1.0;
  float r = length(p);

  // Lens off, so nothing samples the corners. Discarding them skips the galaxy
  // for ~21% of the fragments.
  if (uLens <= 0.0) {
    if (r > 1.0) discard;
    vec4 s = shade(p);
    gl_FragColor = vec4(s.rgb * s.a, s.a);
    return;
  }

  // Chromatic rim lens. erf-shaped falloff: ~0 through the middle of the disc,
  // 1 at the silhouette. erf(x) ~= tanh(1.7724539 x) and GLSL ES 1.00 has no
  // tanh, so it is expanded by hand as (e^2y - 1)/(e^2y + 1). The band starts at
  // 1 - depth (depth = 0.1) with scale 1/(depth*sqrt(2)).
  float ex = exp(2.0 * 1.7724539 * (r - 0.9) / 0.1414214);
  float fall = 0.5 + 0.5 * (ex - 1.0) / (ex + 1.0);

  if (fall > 0.004) {
    // Incommensurate sines, so the rim compression re-spikes and the fringe
    // shimmers without repeating.
    float swell = 1.0 + 0.16 * (0.6 * sin(uTime * 0.9 + uPhase)
                              + 0.4 * sin(uTime * 1.7 + uPhase * 1.3));
    float k = uLens * fall * swell;

    // Per-channel displacement (R x1.4, G x1.2, B x1.0), each with its own slow
    // shimmer. shade() runs three times in full here, which with both glass
    // layers is six galaxy evaluations per fragment. Expensive, but a real lens
    // rather than a screen-space smear.
    float cR = 1.4 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase));
    float cG = 1.2 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase + 2.1));
    float cB = 1.0 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase + 4.2));
    // Alpha comes from the green sample. Free, and since the lens only displaces
    // inward (1.0 - k < 1.0) it cannot pull a transparent sample from outside
    // the disc.
    vec4 sG = shade(p * (1.0 - k * cG));
    vec3 col = vec3(shade(p * (1.0 - k * cR)).r,
                    sG.g,
                    shade(p * (1.0 - k * cB)).b);
    float a = sG.a;

    // Broad glow lobes at +/-40 degrees (0.766 = cos 40, 0.643 = sin 40) fading
    // in toward the rim, plus hard catchlights at the edge.
    vec2 a2 = min(abs(p), 1.0);
    float lobe = max(abs(a2.x * 0.766 + a2.y * 0.643), abs(a2.x * 0.766 - a2.y * 0.643));
    float glow = 0.65 * pow(clamp((lobe - 0.0707) / 1.3435, 0.0, 1.0), 2.4) * fall;
    glow += 1.02 * clamp(1.0 + (r - 1.0) / 0.15, 0.0, 1.0) * step(r, 1.0) * pow(lobe, 2.0);
    col += vec3(0.25) * min(glow, 1.0);
    a = clamp(a + min(glow, 1.0) * 0.6, 0.0, 1.0);  // catchlights are opaque

    gl_FragColor = vec4(col * a, a);
    return;
  }

  vec4 s2 = shade(p);
  gl_FragColor = vec4(s2.rgb * s2.a, s2.a);
}`;

/**
 * Batch fragment program: same galaxy, no dual layer, no lens, discards outside
 * the disc. Roughly a third of the hero cost per pixel, and hundreds of orbs per
 * call.
 */
const FRAG_BATCH = PRECISION + `
varying vec2 vUV;
varying vec2 uRes;
varying vec3 uBg, uAnchor, uC0, uC1, uC2;
varying float uPhase, uAudio, uSpin, uArch, uTime, uState;
` + GLSL_GALAXY + `

void main() {
  vec4 s = shade(vUV * 2.0 - 1.0);
  gl_FragColor = vec4(s.rgb * s.a, s.a);
}`;

/** The shader sources, exposed for tests and for anyone wanting to read them. */
const GLSL = { VERT_HERO, FRAG_HERO, VERT_BATCH, FRAG_BATCH, GLSL_GALAXY };

/**
 * Fullscreen quad: x, y, u, v. Four vertices, TRIANGLE_STRIP, 16-byte stride.
 *
 * v is flipped (v = 1 at the bottom of the GL viewport). After the y-down
 * drawImage blit that puts the shader's +y in the lower half of the orb, which
 * is what makes -N.y the visible upper sky. Get it wrong and the aurora hangs
 * upside down.
 */
const QUAD_VERTS = new Float32Array([
  -1, -1, 0, 1,
   1, -1, 1, 1,
  -1,  1, 0, 0,
   1,  1, 1, 0,
]);

const HERO_UNIFORMS = [
  'uRes', 'uBg', 'uAnchor', 'uC0', 'uC1', 'uC2',
  'uTime', 'uPhase', 'uAudio', 'uSpin', 'uArch', 'uLens', 'uState',
];

/* 3. Colour */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Lazy 1x1 2D context, used only to normalise CSS colour strings. */
let colorProbe;

/**
 * Any CSS colour to `#rrggbb` (or `rgba(...)`) via the 2D canvas, the only
 * colour parser guaranteed to be present and correct. Null if the browser
 * rejects the value.
 *
 * Two sentinels because assigning an invalid value to fillStyle is a silent
 * no-op that leaves the previous value in place. Requiring the same answer from
 * both is the only reliable validity test.
 */
function normaliseCss(value) {
  if (typeof document === 'undefined') return null;
  if (colorProbe === undefined) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    colorProbe = c.getContext('2d') || null;
  }
  if (!colorProbe) return null;
  colorProbe.fillStyle = '#000000';
  colorProbe.fillStyle = value;
  const a = colorProbe.fillStyle;
  colorProbe.fillStyle = '#ffffff';
  colorProbe.fillStyle = value;
  return colorProbe.fillStyle === a ? a : null;
}

/**
 * Colour to an RGB triple in 0..1. Takes `#rgb`, `#rrggbb`, and via the canvas
 * parser every other CSS form. Alpha is discarded; the orb composites against
 * the page itself.
 *
 * Throws on anything unparseable rather than returning NaN. These values go
 * straight into gl.uniform3f, where one NaN poisons every mix() downstream and
 * you get a blank orb with nothing logged.
 *
 * @param {string|[number,number,number]} input
 * @returns {[number, number, number]}
 */
function toRGB(input) {
  if (Array.isArray(input) && input.length >= 3) {
    const out = [Number(input[0]), Number(input[1]), Number(input[2])];
    if (out.every(Number.isFinite)) {
      // Accept both 0..1 and 0..255 triples.
      const scale = out.some((v) => v > 1.0001) ? 1 / 255 : 1;
      return [clamp01(out[0] * scale), clamp01(out[1] * scale), clamp01(out[2] * scale)];
    }
    throw new TypeError('[Orb] toRGB: numeric triple contained a non-finite value');
  }

  const raw = String(input == null ? '' : input).trim();
  let hex = /^#?[0-9a-f]{3}$/i.test(raw) || /^#?[0-9a-f]{6}$/i.test(raw)
    ? raw.replace('#', '')
    : null;

  if (hex === null) {
    const css = normaliseCss(raw);
    if (css === null) {
      throw new TypeError(
        `[Orb] toRGB: "${raw}" is not a colour. Use #rgb, #rrggbb, or any CSS colour.`);
    }
    if (css[0] === '#') {
      hex = css.slice(1);
    } else {
      const m = css.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
      if (!m) throw new TypeError(`[Orb] toRGB: cannot read "${css}"`);
      return [clamp01(+m[1] / 255), clamp01(+m[2] / 255), clamp01(+m[3] / 255)];
    }
  }

  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

/** HSL to an RGB triple in 0..1. */
function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

const hex2 = (v) => Math.round(255 * clamp01(v)).toString(16).padStart(2, '0');
const hslHex = (h, s, l) => '#' + hsl(h, s, l).map(hex2).join('');

/** Rec.601 luma of a fully saturated hue, used to compensate lightness. */
function hueLuma(h) {
  const [r, g, b] = hsl(h, 1, 0.5);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Build a palette around a hue.
 *
 * Yellows and greens are far brighter than blues and violets at the same
 * nominal lightness, so `k` nudges lightness up in proportion to how dark the
 * hue is. Without it the blue and violet orbs read as sludge next to the amber
 * ones.
 *
 * @param {number} hue degrees
 * @returns {{hue:number, anchor:string, accents:[string,string,string]}}
 */
function makePalette(hue) {
  const h = ((Number(hue) || 0) % 360 + 360) % 360;
  const k = 0.2 * (1 - hueLuma(h));
  return {
    hue: h,
    anchor: hslHex(h, 0.85, 0.42 + k),
    accents: [
      hslHex(h, 0.95, Math.min(0.72, 0.6 + k)),
      hslHex((h + 16) % 360, 0.8, Math.min(0.82, 0.7 + k)),
      hslHex((h + 34) % 360, 0.9, Math.min(0.9, 0.8 + k)),
    ],
  };
}

/** The fourteen built-in identity palettes, one per hue. */
const PALETTES = HUES.map(makePalette);

/**
 * Palette-shaped object to GL-ready RGB triples. Called at the API boundary so a
 * malformed palette fails synchronously rather than a frame later inside a
 * uniform upload.
 */
function resolvePalette(pal) {
  if (!pal || typeof pal !== 'object') {
    throw new TypeError('[Orb] palette must be an object with {anchor, accents}');
  }
  if (!Array.isArray(pal.accents) || pal.accents.length !== 3) {
    throw new TypeError('[Orb] palette.accents must be an array of exactly 3 colours');
  }
  return {
    anchor: toRGB(pal.anchor),
    accents: [toRGB(pal.accents[0]), toRGB(pal.accents[1]), toRGB(pal.accents[2])],
  };
}

/* 4. Seed to identity */

/**
 * FNV-1a, 32-bit. Well distributed over short strings and stable across engines,
 * since Math.imul is exact 32-bit multiplication where `*` is not.
 *
 * Coerce to a string first. A Number has no .length, so `hashSeed(user.id)`
 * would otherwise skip the loop and hand every user the same orb.
 *
 * @param {*} seed
 * @returns {number} unsigned 32-bit hash
 */
function hashSeed(seed) {
  const str = String(seed == null ? '' : seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Everything a seed determines: palette, archetype, structural phase, starting
 * spin angle, clock offset. Pure and stable, so the same string is the same orb.
 *
 * @param {*} seed
 * @returns {{hash:number, seed:string, palette:object, archetype:string,
 *            phase:number, spin:number, timeOffset:number}}
 */
function identityForSeed(seed) {
  const str = String(seed == null ? '' : seed);
  const h = hashSeed(str);
  const phase = (h % 6283) / 1000;
  return {
    hash: h,
    seed: str,
    palette: PALETTES[h % PALETTES.length],
    archetype: ARCHETYPES[(h >>> 16) % ARCHETYPES.length],
    phase,
    spin: phase * 3.7,
    // Offset so two seeds are never in lockstep, while the same seed stays
    // pixel-identical. Capped near 400s: the shader evaluates sin(t * 14.0 + ...)
    // and a highp float has only ~0.008 rad of angular resolution once that
    // argument reaches five figures, where the glitter term visibly quantises.
    timeOffset: ((h >>> 8) % 40009) / 100,
  };
}

/* 5. GL plumbing */

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[Orb] shader compile failed:\n' + gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/**
 * Compile, bind attribute locations, link. The binding has to happen before
 * linkProgram; after it, the driver picks its own locations and nothing warns
 * you.
 */
function createProgram(gl, vsSrc, fsSrc, attribNames) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const prog = gl.createProgram();
  if (!prog) { gl.deleteShader(vs); gl.deleteShader(fs); return null; }
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  for (let i = 0; i < attribNames.length; i++) gl.bindAttribLocation(prog, i, attribNames[i]);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[Orb] program link failed:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

/**
 * Usable fragment precision? The starfield hash needs the full 23-bit mantissa,
 * and pow(pd, 900.0) / exp(-d*d*1600.0) need the exponent range. Where a device
 * clamps fragment highp the right answer is the static fallback, not a badly
 * drawn orb.
 */
function probeHighp(gl) {
  if (!gl.getShaderPrecisionFormat) return true;   // ancient impl; assume ok
  const p = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  return !!p && p.precision >= 23 && p.rangeMax >= 62;
}

/**
 * One WebGL context, one program. At most two of these exist: the hero surface
 * and the batch atlas. Both are lazy and independent, so a page of 32px avatars
 * never compiles the dual-layer program and a page with one big hero never
 * allocates the atlas.
 *
 * Subclasses call init() at the end of their own constructors rather than
 * letting the base do it, so their fields exist before init() touches them.
 *
 * @abstract
 */
class GLSurface {
  constructor(edge) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = edge;
    this.canvas.height = edge;
    this.gl = null;
    this.prog = null;
    this.quad = null;
    this.ready = false;
    this.failed = false;
    this.lowPrecision = false;
    this.drawCalls = 0;
    /** Consecutive init() failures. A transient one on restore must not be fatal. */
    this.initFailures = 0;

    this.canvas.addEventListener('webglcontextlost', (e) => {
      // Without preventDefault() the context never comes back.
      e.preventDefault();
      this.ready = false;
      // Every GL object died with the context. Dropping the handles stops init()
      // deleting them against the new context, which is an INVALID_OPERATION.
      this.forgetObjects();
    }, false);
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.ready = false;
      this.init();
      // Repaint everything, including orbs that do not animate and whose loop had
      // parked. Otherwise a reduced-motion page stays frozen on a stale frame, or
      // blank if the loss beat the first draw.
      markAllDirty();
    }, false);
  }

  /** @abstract */
  init() {}

  /** Drop every GL object handle without trying to delete it. */
  forgetObjects() { this.prog = null; this.quad = null; }

  /** @returns {WebGLRenderingContext|null} */
  acquireContext() {
    if (this.gl) return this.gl;
    const gl = this.canvas.getContext('webgl', GL_ATTRS)
            || this.canvas.getContext('experimental-webgl', GL_ATTRS);
    // No context at all is not transient, so latch it now.
    if (!gl) { this.failed = true; return null; }
    if (!probeHighp(gl)) {
      this.failed = true;
      this.lowPrecision = true;
      console.warn('[Orb] this fragment stage has no usable high precision ' +
                   '(the star hashes need the full 23-bit mantissa); ' +
                   'switching to the static gradient fallback.');
      return null;
    }
    this.gl = gl;
    return gl;
  }

  /**
   * A compile or link failure straight after a restore is often a one-frame
   * driver hiccup, so give it a few tries. Latching on the first would kill every
   * orb permanently for a transient fault.
   */
  noteInitFailure() {
    if (++this.initFailures >= 3) {
      this.failed = true;
      console.error('[Orb] GL initialisation failed three times; giving up on this surface.');
    }
  }

  /**
   * Drain the GL error queue. getError() returns the first error since it was
   * last called and clears one flag at a time, so an older error (usually
   * CONTEXT_LOST_WEBGL from calls issued while the context was gone) would
   * otherwise be blamed on the next thing we check.
   */
  drainErrors(gl) {
    for (let i = 0; i < 16; i++) if (gl.getError() === 0) return;
  }

  /** Release everything. Safe to call more than once. */
  dispose() {
    const gl = this.gl;
    this.ready = false;
    if (gl) {
      try {
        if (this.prog) gl.deleteProgram(this.prog);
        this.releaseBuffers(gl);
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      } catch { /* the context may already be gone */ }
    }
    this.gl = null;
    this.prog = null;
  }

  /* eslint-disable-next-line no-unused-vars */
  releaseBuffers(gl) {}
}

/**
 * The hero surface.
 *
 * Browsers cap live WebGL contexts at around 16, so a list of orbs cannot give
 * each one its own. Every orb owns a cheap 2D canvas instead, and this draws
 * into the top-left `px` square of one shared offscreen surface which is then
 * blitted out with drawImage. One context, any number of orbs.
 */
class HeroSurface extends GLSurface {
  constructor() { super(MAX_PX); this.init(); }

  init() {
    if (this.failed) return;
    const gl = this.acquireContext();
    if (!gl) return;
    if (gl.isContextLost && gl.isContextLost()) return;

    const prog = createProgram(gl, VERT_HERO, FRAG_HERO, ['aPos', 'aUV']);
    if (!prog) { this.noteInitFailure(); return; }
    if (this.prog) { try { gl.deleteProgram(this.prog); } catch {} }
    this.prog = prog;

    this.u = {};
    for (const n of HERO_UNIFORMS) this.u[n] = gl.getUniformLocation(prog, n);

    // Re-created on every init(), so the old one has to go or a restore leaks a
    // buffer per cycle.
    if (this.quad) { try { gl.deleteBuffer(this.quad); } catch {} }
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTS, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);
    this.drainErrors(gl);
    this.initFailures = 0;
    this.ready = true;
  }

  releaseBuffers(gl) { if (this.quad) gl.deleteBuffer(this.quad); this.quad = null; }

  /**
   * Draw one orb into the top-left `px` square.
   * @returns {boolean} false if the context was unavailable this frame.
   */
  render(spec, px, time) {
    if (!this.ready || !this.prog) return false;
    const gl = this.gl;
    if (gl.isContextLost()) { this.ready = false; return false; }

    gl.useProgram(this.prog);

    // GL's origin is bottom-left, so the square we blit is the top rows.
    const y = this.canvas.height - px;
    gl.viewport(0, y, px, px);
    gl.scissor(0, y, px, px);

    const u = this.u;
    const a = spec.accents;
    gl.uniform2f(u.uRes, px, px);
    gl.uniform3f(u.uBg, spec.bg[0], spec.bg[1], spec.bg[2]);
    gl.uniform3f(u.uAnchor, spec.anchor[0], spec.anchor[1], spec.anchor[2]);
    gl.uniform3f(u.uC0, a[0][0], a[0][1], a[0][2]);
    gl.uniform3f(u.uC1, a[1][0], a[1][1], a[1][2]);
    gl.uniform3f(u.uC2, a[2][0], a[2][1], a[2][2]);
    gl.uniform1f(u.uTime, time);
    gl.uniform1f(u.uPhase, spec.phase);
    gl.uniform1f(u.uArch, spec.arch);
    gl.uniform1f(u.uLens, spec.lens);
    // Smoothed state, never the target. The crossfade lives on the CPU so both
    // programs get a value that is already eased.
    gl.uniform1f(u.uState, spec.stateBlend);
    // Slow envelope: colour should swell across a phrase, not strobe on every
    // consonant. The fast envelope drives motion instead.
    gl.uniform1f(u.uAudio, spec.audioSlow);
    gl.uniform1f(u.uSpin, spec.spin);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.drawCalls++;
    return true;
  }
}

/**
 * The instanced batch atlas.
 *
 * Small orbs become a grid of tiles in one atlas, drawn with a single
 * drawArraysInstancedANGLE. Every per-orb parameter travels as an instance
 * attribute, so nothing needs a uniform update between orbs. Each tile is then
 * blitted into its own 2D canvas, which is a GPU-side copy, not a readback.
 */
class BatchSurface extends GLSurface {
  constructor() {
    super(ATLAS_PX);
    // Allocated once, never per frame. 1024 * 96 bytes = 96 KB.
    this.data = new Float32Array(BATCH_MAX_INSTANCES * INSTANCE_FLOATS);
    this.ext = null;
    this.instBuffer = null;
    this.uCanvas = null;
    /** Cleared on every init so the first draw after a restore is checked. */
    this.verified = false;
    this.init();
  }

  init() {
    if (this.failed) return;
    const gl = this.acquireContext();
    if (!gl) return;
    if (gl.isContextLost && gl.isContextLost()) return;

    // Extension objects do not survive a context restore. The old object keeps
    // its methods but they silently no-op, and getError() reports success, so the
    // draw-call counters cheerfully report a full recovery over a blank page.
    // Re-query on every init(), never capture once at construction.
    this.ext = gl.getExtension('ANGLE_instanced_arrays');
    if (!this.ext) { this.failed = true; return; }
    this.verified = false;

    const prog = createProgram(gl, VERT_BATCH, FRAG_BATCH,
      ['aPos', 'aUV', 'iPos', 'iDyn', 'iBg', 'iAnc', 'iC0b', 'iC2']);
    if (!prog) { this.noteInitFailure(); return; }
    if (this.prog) { try { gl.deleteProgram(this.prog); } catch {} }
    this.prog = prog;
    this.uCanvas = gl.getUniformLocation(prog, 'uCanvas');

    if (this.quad) { try { gl.deleteBuffer(this.quad); } catch {} }
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTS, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    if (this.instBuffer) { try { gl.deleteBuffer(this.instBuffer); } catch {} }
    this.instBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    for (let i = 0; i < 6; i++) {
      const loc = 2 + i;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, 16 * i);
      this.ext.vertexAttribDivisorANGLE(loc, 1);   // advance once per instance
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.SCISSOR_TEST);
    this.drainErrors(gl);        // so the first verified draw reports only itself
    this.initFailures = 0;
    this.ready = true;
  }

  forgetObjects() { this.prog = null; this.quad = null; this.instBuffer = null; this.ext = null; }

  releaseBuffers(gl) {
    if (this.quad) gl.deleteBuffer(this.quad);
    if (this.instBuffer) gl.deleteBuffer(this.instBuffer);
    this.quad = this.instBuffer = null;
  }

  /** Pack one orb into instance slot i. Layout mirrors VERT_BATCH exactly. */
  writeInstance(i, cellX, cellY, tile, spec, t) {
    const o = i * INSTANCE_FLOATS, d = this.data, a = spec.accents;
    d[o]      = cellX;  d[o + 1]  = cellY;  d[o + 2]  = tile;  d[o + 3]  = spec.spin;
    d[o + 4]  = spec.audioSlow;
    d[o + 5]  = spec.phase;
    d[o + 6]  = spec.arch;
    d[o + 7]  = t;
    d[o + 8]  = spec.bg[0];     d[o + 9]  = spec.bg[1];     d[o + 10] = spec.bg[2];
    d[o + 11] = spec.anchor[0]; d[o + 12] = spec.anchor[1]; d[o + 13] = spec.anchor[2];
    d[o + 14] = a[0][0];        d[o + 15] = a[0][1];        d[o + 16] = a[0][2];
    d[o + 17] = a[1][0];        d[o + 18] = a[1][1];        d[o + 19] = a[1][2];
    d[o + 20] = a[2][0];        d[o + 21] = a[2][1];        d[o + 22] = a[2][2];
    d[o + 23] = spec.stateBlend;   // iC2.w -> uState, the spare float
  }

  /**
   * Render every orb in `list`, all of the same device pixel size, and blit each
   * tile into its own canvas.
   *
   * @param {Array<{_spec:object, _px:number, _time:number, ctx:CanvasRenderingContext2D}>} list
   * @param {number} tile device px per orb
   * @returns {boolean}
   */
  renderGroup(list, tile) {
    if (!this.ready || !this.prog || !this.ext) return false;
    const gl = this.gl;
    if (gl.isContextLost()) { this.ready = false; return false; }

    const cols = Math.max(1, Math.floor(this.canvas.width / tile));
    const rows = Math.max(1, Math.floor(this.canvas.height / tile));
    const perPass = Math.min(cols * rows, BATCH_MAX_INSTANCES);

    gl.useProgram(this.prog);
    gl.uniform2f(this.uCanvas, this.canvas.width, this.canvas.height);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuffer);

    for (let base = 0; base < list.length; base += perPass) {
      const n = Math.min(perPass, list.length - base);
      for (let i = 0; i < n; i++) {
        const orb = list[base + i];
        this.writeInstance(i, (i % cols) * tile, Math.floor(i / cols) * tile,
                           tile, orb._spec, orb._time);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, n * INSTANCE_FLOATS));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, n);   // <- one call
      this.drawCalls++;

      // A draw-call counter is not proof anything was drawn. A broken extension
      // binding shows up on the first pass after init and is permanent, so one
      // check is enough and steady state costs nothing.
      if (!this.verified) {
        this.verified = true;
        const err = gl.getError();
        if (err === 0x9242 /* CONTEXT_LOST_WEBGL */ || (gl.isContextLost && gl.isContextLost())) {
          // Transient. The restore handler re-inits and we try again.
          this.ready = false;
          this.verified = false;
          return false;
        }
        if (err !== 0) {
          console.error('[Orb] instanced draw reported gl error 0x' + err.toString(16) +
                        '; disabling the batch path and falling back to the hero program.');
          this.failed = true;
          return false;
        }
      }

      for (let i = 0; i < n; i++) {
        const orb = list[base + i];
        if (!orb.ctx) continue;
        orb.ctx.drawImage(this.canvas, (i % cols) * tile, Math.floor(i / cols) * tile,
                          tile, tile, 0, 0, tile, tile);
      }
    }
    return true;
  }
}

/* Lazy, releasable surface ownership. */

let heroSurface = null;
let batchSurface = null;
let batchDisabled = false;
/** Cached answer from the one throwaway capability probe. */
let supportProbe = null;

function getHero() {
  if (typeof document === 'undefined') return null;
  if (!heroSurface) heroSurface = new HeroSurface();
  return heroSurface.failed ? null : heroSurface;
}

function getBatch() {
  if (batchDisabled || typeof document === 'undefined') return null;
  if (!batchSurface) batchSurface = new BatchSurface();
  return batchSurface.failed ? null : batchSurface;
}

/**
 * Free both GL contexts. Called by {@link dispose}, and automatically after
 * IDLE_RELEASE_MS with nothing live. An SPA that navigates away from a page of
 * orbs should not pin megabytes of VRAM; the delay stops a UI that rebuilds its
 * hero on every keystroke from thrashing the context.
 */
function releaseSurfaces() {
  if (heroSurface) { heroSurface.dispose(); heroSurface = null; }
  if (batchSurface) { batchSurface.dispose(); batchSurface = null; }
}

/* 6. Dynamics: the two envelopes and the spin integrator */

/**
 * Exponential smoothing coefficient. 1 - exp(-dt/tau) is the exact discrete
 * solution of dx/dt = (target - x)/tau, so the envelopes behave the same at 30,
 * 60 and 144 fps. The usual `x += (target - x) * 0.1` is a per-frame lerp and
 * quietly frame-rate dependent.
 */
const lerpRate = (dt, tau) => (dt > 0 ? 1 - Math.exp(-dt / tau) : 0);

/** Frame time the transient constants were tuned at. */
const REF_DT = 1 / 60;

/** GLSL's smoothstep, exactly, so stateBasis matches stateW(). */
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * JS twin of stateW() in the GLSL. Keep them identical: the shader picks a look
 * from these weights and the spin integrator picks a speed. Drift and you get an
 * orb that looks like it is thinking while turning at its idle rate.
 *
 * @param {number} s smoothed state scalar, 0..3
 * @param {number} i state index to weigh against
 */
const stateBasis = (s, i) => 1 - smoothstep(0.35, 1.0, Math.abs(s - i));

/**
 * Advance one orb's audio envelopes and spin state.
 *
 * Two envelopes, both with asymmetric attack and release, since a symmetric
 * filter either smears the onset or chatters on the tail:
 *
 *   fast (40ms / 180ms) drives motion. Quick enough that one consonant is a
 *        discrete event the eye can see.
 *   slow (110ms / 300ms) drives colour, so the aurora and rim swell across a
 *        phrase instead of flickering per syllable.
 *
 * Spin is a real integrator rather than a value mapped from level: a per-orb
 * idle target with a slow breathing modulation, a sustained audio term on top,
 * and a transient term where the positive derivative of the fast envelope goes
 * straight into velocity so a speech onset makes the ball lurch. Velocity
 * chases the target on a 350ms constant, so it coasts rather than snapping.
 *
 * Direction flips are queued on an oscillator zero-crossing and only commit
 * while the room is quiet (fast < 0.18), so the orb never reverses mid-syllable.
 * The reversal eases through zero because what changes sign is the velocity
 * target, not the velocity.
 *
 * @param {object} s orb spec (mutated in place)
 * @param {number} t animation time in seconds
 */
function advanceDynamics(s, t) {
  const dt = s.lastT === null ? 0 : clamp(t - s.lastT, 0, 0.1);
  s.lastT = t;

  // One non-finite level would poison every accumulator below permanently:
  // NaN + (0 - NaN) * k is still NaN, so resetting the input never recovers the
  // orb. Math.max(0, NaN) is NaN too, so the finiteness test has to come first.
  const level = Number.isFinite(s.level) ? clamp01(s.level) : 0;
  s.level = level;

  // One scalar, eased. stateSettling keeps the loop alive across the crossfade
  // on an orb that is otherwise parked (reduced motion, or animate: false).
  // Without it a paused orb freezes a third of the way through a transition.
  const stateTarget = clamp(Number.isFinite(s.state) ? s.state : 0, 0, 3);
  if (!Number.isFinite(s.stateBlend)) s.stateBlend = stateTarget;
  if (s.stateBlend !== stateTarget) {
    s.stateBlend += (stateTarget - s.stateBlend) * lerpRate(dt, STATE_TAU);
    if (Math.abs(stateTarget - s.stateBlend) < 0.002) {
      s.stateBlend = stateTarget;
      s.stateSettling = false;
    } else {
      s.stateSettling = true;
    }
  } else {
    s.stateSettling = false;
  }

  const sb = s.stateBlend;
  let w0 = stateBasis(sb, 0), w1 = stateBasis(sb, 1);
  let w2 = stateBasis(sb, 2), w3 = stateBasis(sb, 3);
  const wSum = Math.max(w0 + w1 + w2 + w3, 1e-4);
  w0 /= wSum; w1 /= wSum; w2 /= wSum; w3 /= wSum;
  const w = s.stateW;
  w[0] = w0; w[1] = w1; w[2] = w2; w[3] = w3;

  // The envelopes track the state-gated drive, not the raw level.
  //
  //   idle       barely notices the room (22%), so a noisy office does not make
  //              a parked orb twitch
  //   listening  full reactivity, the human talking
  //   thinking   deaf on purpose (0%), running on its own cognition pulse: an
  //              agent that reacts to room noise while reasoning reads as
  //              distracted rather than busy
  //   speaking   full reactivity, the agent talking
  //
  // The cognition pulse is two incommensurate sines so it breathes rather than
  // ticks, phase-offset per orb so a row of thinking agents is not a metronome.
  // Running it through the same envelopes as real audio means thinking drives
  // the existing uniforms, with no extra shader pass and no change to the batch
  // program.
  const gate = w0 * 0.22 + w1 + w3;
  const cognition = 0.34 + 0.30 * Math.sin(t * 3.2 + s.phase * 3.0)
                         * (0.55 + 0.45 * Math.sin(t * 1.17 + s.phase));
  const drive = clamp01(level * gate + w2 * cognition);
  s.drive = drive;

  s.audioSlow += (drive - s.audioSlow) * lerpRate(dt, drive > s.audioSlow ? 0.11 : 0.30);
  s.audioFast += (drive - s.audioFast) * lerpRate(dt, drive > s.audioFast ? 0.04 : 0.18);

  const v = s.audioFast;

  // Per-orb idle character, two decorrelated variates off the seed phase.
  const a = (6.31 * s.phase) % 1;
  const b = (2.17 * s.phase) % 1;
  const breathe = 0.35 * Math.sin(t * (0.11 + 0.08 * b) + s.phase);

  const osc = Math.sin(t * (0.45 + 0.2 * a) + s.phase);
  const sign = Math.sign(osc) || 1;
  if (sign !== s.oscSign) { s.oscSign = sign; s.flipQueued = true; }
  if (s.flipQueued && v < 0.18) { s.spinDir = -s.spinDir; s.flipQueued = false; }

  // Per-state spin. Thinking is ~3.5x idle at the base rate, the difference
  // between a ball drifting and a ball working, and the one cue that survives
  // being seen out of the corner of the eye. It moves the target rather than the
  // velocity, so a state change accelerates through the integrator below.
  const spinScale = w0 * 0.55 + w1 * 0.85 + w2 * 1.95 + w3 * 1.15;

  // Signed by spinDir in the three states driven by real audio, which is what
  // lets a loud phrase overpower the base rate and reverse the ball. Unsigned in
  // thinking: the cognition pulse must only add speed. Signed, it would cancel
  // most of the base rate on half the direction cycle, and a reversal mid-thought
  // reads as hesitation.
  const audioSpin = s.spinDir * v * 2.2 * (w0 + w1 + w3) + v * 1.3 * w2;
  const target = 0.65 * (0.65 + 0.7 * a) * (1 + breathe) * spinScale + audioSpin;
  s.spinVel += (target - s.spinVel) * lerpRate(dt, 0.35);

  // Transient kick. The obvious form, min(6 * onset, 1.4) * dt * 14 on the
  // per-frame rise of the fast envelope, scales as dt-squared because the rise
  // is itself proportional to dt, so a 30fps page lurches about twice as hard as
  // the same speech at 60. Converting the rise to a rate first fixes it: this is
  // identical at 60fps and frame-rate independent elsewhere, including where the
  // 1.4 clamp saturates.
  const onset = Math.max(0, v - s.prevFast);
  s.prevFast = v;
  const onsetRate = dt > 0 ? onset / dt : 0;
  // Same rule as the sustained term: signed while real audio drives, forward-only
  // while the cognition pulse does. The weights are normalised, so this lerps
  // cleanly from spinDir to +1 across a crossfade.
  const kickDir = s.spinDir * (w0 + w1 + w3) + w2;
  s.spinVel += kickDir * Math.min(6 * onsetRate * REF_DT, 1.4) * 14 * dt;

  s.spin += s.spinVel * dt;

  // If anything upstream still manages to inject a NaN, heal on the next frame
  // rather than dying permanently.
  if (!Number.isFinite(s.spin) || !Number.isFinite(s.spinVel)) {
    s.spin = 0; s.spinVel = 0; s.audioFast = 0; s.audioSlow = 0; s.prevFast = 0;
    s.stateBlend = stateTarget; s.stateSettling = false;
  }
}

/* 7. Scheduler: one rAF for every orb and every audio source
 *
 * Whether the loop exists is a pure function of state. needsFrames() is the only
 * predicate, kick() the only way to start, and frame() returning without
 * rescheduling the only way to stop. Every mutation path (construct, update,
 * listen, source start, IntersectionObserver, visibilitychange) just calls
 * kick() and lets the predicate decide, which removes the whole class of "who
 * cancels the loop" bug.
 */

const liveOrbs = new Set();
const liveSources = new Set();
/** canvas -> Orb. A WeakMap, not an expando, so a dropped canvas is collectable. */
const canvasToOrb = new WeakMap();

let rafId = 0;
let timerId = 0;
let nextDueAt = 0;
let observer = null;
let visibilityBound = false;
let idleTimer = 0;
let frameCount = 0;
let lastFrameStamp = 0;
let measuredFps = 0;

function getObserver() {
  if (observer || typeof IntersectionObserver === 'undefined') return observer;
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const orb = canvasToOrb.get(e.target);
      if (!orb) continue;
      orb._visible = e.isIntersecting;
      // Time means nothing across a visibility gap. Nulling both clocks makes
      // the first frame back integrate dt = 0 instead of a clamped but still
      // wrong 100ms step.
      orb._spec.lastT = null;
      orb._lastNow = null;
      if (e.isIntersecting) kick();
    }
  }, { threshold: 0 });
  return observer;
}

function bindVisibility() {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState !== 'visible';
    const io = getObserver();
    for (const orb of liveOrbs) {
      if (hidden) {
        orb._visible = false;
      } else if (io) {
        // Do not optimistically mark everything visible. With hundreds of orbs
        // that is a hitch on every tab focus. Re-observing makes the observer
        // re-report real geometry on its own schedule.
        io.unobserve(orb.canvas);
        io.observe(orb.canvas);
      } else {
        orb._visible = true;   // no observer available: assume visible or freeze
      }
      orb._spec.lastT = null;
      orb._lastNow = null;
    }
    if (hidden) stopLoop(); else kick();
  });
}

/**
 * The one predicate. A state crossfade counts as work even where animation is
 * off (animate: false, or reduced motion), or the orb stalls half way between
 * two looks until something else wakes the loop. Still gated on visibility, so
 * an offscreen orb costs nothing and settles when it comes back.
 */
function orbNeedsFrame(o) {
  return o._dirty || (o._visible && (o._animate || o._spec.stateSettling));
}

function needsFrames() {
  for (const s of liveSources) if (s.active) return true;
  for (const o of liveOrbs) if (orbNeedsFrame(o)) return true;
  return false;
}

function kick() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
  if (!rafId && !timerId && needsFrames() && typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(frame);
  }
}

function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  if (timerId) clearTimeout(timerId);
  rafId = timerId = 0;
  scheduleIdleRelease();
}

/** Free the GPU contexts once nothing has needed them for a while. */
function scheduleIdleRelease() {
  if (idleTimer || liveOrbs.size || liveSources.size) return;
  if (!heroSurface && !batchSurface) return;
  idleTimer = setTimeout(() => {
    idleTimer = 0;
    if (!liveOrbs.size && !liveSources.size) releaseSurfaces();
  }, IDLE_RELEASE_MS);
}

/** Repaint everything on the next frame. Used after a context restore. */
function markAllDirty() {
  for (const o of liveOrbs) o._dirty = true;
  kick();
}

/** Advance one orb's own clock and its dynamics. */
function advanceOrb(orb, now) {
  const dt = orb._lastNow === null ? 0 : clamp((now - orb._lastNow) / 1000, 0, 0.1);
  orb._lastNow = now;
  orb._time += dt;
  advanceDynamics(orb._spec, orb._time);
}

/**
 * Per-size batch buckets and the hero work list. Both persist across frames and
 * are reset by length rather than rebuilt, so the hot path allocates nothing.
 */
const batchGroups = new Map();
const heroJobs = [];

/**
 * No renderer, and there never will be one. Convert every live orb to its seeded
 * static gradient and park the loop instead of burning a full-rate rAF drawing
 * nothing.
 */
function giveUpOnGL() {
  console.error('[Orb] no usable WebGL renderer; every orb is switching to the ' +
                'static gradient fallback.');
  for (const orb of [...liveOrbs]) {
    orb.supported = false;
    orb._dirty = false;
    liveOrbs.delete(orb);
    try { orb._paintFallback(); } catch {}
  }
  stopLoop();
}

function frame(now) {
  rafId = 0;
  try {
    if (!needsFrames()) {
      for (const o of liveOrbs) o._lastNow = null;
      return;
    }

    // Cap against an absolute deadline, so the cadence does not sag to
    // work + interval the way a limiter measuring from the end of the work does.
    // Sleeping on a timer instead of burning a rAF keeps a 144Hz display cheap,
    // and nextDueAt is clamped forward so a long stall does not queue a burst of
    // catch-up frames.
    if (nextDueAt === 0) nextDueAt = now;
    const wait = nextDueAt - now;
    if (wait > 1) {
      timerId = setTimeout(() => { timerId = 0; kick(); }, wait);
      return;
    }
    nextDueAt = Math.max(now + 1, nextDueAt + FRAME_MS);

    if (lastFrameStamp) {
      const d = now - lastFrameStamp;
      if (d > 0) measuredFps = measuredFps ? measuredFps * 0.9 + (1000 / d) * 0.1 : 1000 / d;
    }
    lastFrameStamp = now;
    frameCount++;

    // Audio sources sampled once per frame however many orbs share them.
    // Iterating the Set directly is safe even though stop() deletes from it:
    // removing the current element mid-iteration is well defined for Set.
    const seconds = now / 1000;
    for (const src of liveSources) {
      if (!src.active) continue;
      try {
        src._tick(seconds);
      } catch (err) {
        console.error('[Orb] audio source failed; stopping it', err);
        try { src.stop(); } catch { liveSources.delete(src); }
      }
    }

    // Advance and partition.
    for (const list of batchGroups.values()) list.length = 0;
    heroJobs.length = 0;

    for (const orb of liveOrbs) {
      if (!orbNeedsFrame(orb)) { orb._lastNow = null; continue; }
      try {
        advanceOrb(orb, now);
        if (!batchDisabled && orb._batchable()) {
          let g = batchGroups.get(orb._px);
          if (!g) { g = []; batchGroups.set(orb._px, g); }
          g.push(orb);
        } else {
          heroJobs.push(orb);
        }
      } catch (err) {
        ejectOrb(orb, err);
      }
    }

    // Per-orb isolation is not optional with one shared loop. Without the
    // try/catch, one bad orb takes animation down for the whole page
    // permanently, because the reschedule sits after this.
    let renderable = false;

    if (heroJobs.length) {
      const hero = getHero();          // allocated only now, only if needed
      if (hero) renderable = true;
      for (const orb of heroJobs) {
        try { orb._blitHero(hero); } catch (err) { ejectOrb(orb, err); }
      }
    }

    // Stays undefined until a size bucket actually has work, so a page of
    // nothing but hero orbs never allocates the atlas.
    let batch;
    let batchWork = false;
    for (const [tile, list] of batchGroups) {
      if (!list.length) continue;
      batchWork = true;
      if (batch === undefined) batch = getBatch();
      if (batch) {
        renderable = true;
        let ok = false;
        try {
          ok = batch.renderGroup(list, tile);
        } catch (err) {
          console.error('[Orb] batch pass threw; routing this size to the hero path', err);
        }
        if (ok) { for (const o of list) o._dirty = false; continue; }
      }
      // No instancing, or the pass failed. The hero program renders the same
      // galaxy one orb at a time.
      const hero = getHero();
      if (hero) renderable = true;
      for (const o of list) {
        try { o._blitHero(hero); } catch (err) { ejectOrb(o, err); }
      }
    }

    // There was work, nothing could draw it, and nothing ever will. A transient
    // context loss leaves the surface non-null, so it does not land here.
    if (!renderable && (heroJobs.length || batchWork)) giveUpOnGL();
  } finally {
    // In a finally, so no throw above can leave the page frozen.
    kick();
  }
}

function ejectOrb(orb, err) {
  console.error('[Orb] draw failed; ejecting this orb from the render loop', err);
  orb._broken = true;
  orb._dirty = false;
  liveOrbs.delete(orb);
  if (observer) { try { observer.unobserve(orb.canvas); } catch {} }
}

/* 8. Environment queries */

const mq = (q) => (typeof matchMedia === 'function' ? matchMedia(q) : null);

const reducedMotionQuery = mq('(prefers-reduced-motion: reduce)');
const darkQuery = mq('(prefers-color-scheme: dark)');

function prefersReducedMotion() { return !!(reducedMotionQuery && reducedMotionQuery.matches); }

let mediaBound = false;

/** Re-apply every orb's options. Cheap, and the right answer to any environment
 *  change: reduced motion, colour scheme, pixel density. */
function refreshAllOrbs() {
  for (const o of [...liveOrbs]) { try { o.update({}); } catch (e) { console.error(e); } }
}

function onMq(q, fn, once) {
  if (!q) return;
  if (q.addEventListener) q.addEventListener('change', fn, once ? { once: true } : undefined);
  else if (q.addListener) q.addListener(fn);      // Safari < 14
}

/**
 * Environment changes have to land without recreating orbs: the OS reduced-motion
 * switch, light/dark, or dragging the window onto a monitor with a different
 * pixel density.
 */
function bindMediaListeners() {
  if (mediaBound) return;
  mediaBound = true;
  onMq(reducedMotionQuery, refreshAllOrbs);
  onMq(darkQuery, refreshAllOrbs);

  // devicePixelRatio changes do not reliably fire resize, but a resolution media
  // query does. Re-arm it each time: the query is written against the old ratio.
  const watchDpr = () => {
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
    onMq(mq(`(resolution: ${dpr}dppx)`), () => { refreshAllOrbs(); watchDpr(); }, true);
  };
  watchDpr();
}

/**
 * Resolve `background: 'auto'`: walk up from the container for the first
 * ancestor with an opaque background colour, else fall back to the OS colour
 * scheme. uBg carries a few percent of weight at the limb, and it is the reason
 * an orb on a light page reads as translucent glass and not a black disc.
 */
function resolveAutoBackground(el) {
  try {
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = getComputedStyle(node).backgroundColor;
      const m = bg && bg.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i);
      if (m && (m[4] === undefined || parseFloat(m[4]) > 0.9)) {
        return [clamp01(+m[1] / 255), clamp01(+m[2] / 255), clamp01(+m[3] / 255)];
      }
      node = node.parentElement;
    }
  } catch { /* detached node, or no layout engine */ }
  return darkQuery && !darkQuery.matches ? [1, 1, 1] : [0, 0, 0];
}

/**
 * Lens amplitude for a device size.
 *
 * A flat 0.4 works at the 160-200 device px the lens was tuned at, where resFac
 * is well below 1 and stars are fat enough that the three displaced channels
 * overlap into a soft fringe. At 680 device px (a 340 CSS px hero on retina)
 * resFac saturates, stars are at their sharpest, and a diffraction spike lands
 * in three visibly separate places near the rim: red/green/blue confetti rather
 * than sparkle.
 *
 * Tapering above LENS_REF_PX keeps the fringe a constant fraction of the tuned
 * look at any size. Pass an explicit number to opt out.
 */
function resolveLens(opt, size, px) {
  if (typeof opt === 'number') {
    if (!Number.isFinite(opt) || opt < 0) throw new TypeError('[Orb] lens must be a number >= 0');
    return opt;
  }
  if (opt === false) return 0;
  const on = opt === true || size >= HERO_MIN_SIZE;
  if (!on) return 0;
  return 0.4 * clamp(LENS_REF_PX / px, 0.55, 1);
}

/* 9. Orb */

/**
 * @typedef {object} OrbOptions
 * @property {*}       [seed='']         Identity, coerced to a string.
 * @property {number}  [size=320]        CSS pixels, square.
 * @property {'idle'|'listening'|'thinking'|'speaking'|number} [state='idle'] Instant at mount, crossfades after.
 * @property {'spiral'|'nebula'|'core'|'deep'|'auto'} [archetype='auto']
 * @property {object|number|'auto'} [palette='auto'] A `{anchor, accents:[a,b,c]}`, a hue in degrees, or 'auto'.
 * @property {string|'auto'} [background='auto'] Page colour bleeding through the glass; 'auto' reads the DOM.
 * @property {boolean} [animate=true]
 * @property {'auto'|'full'|number} [dpr='auto'] 'auto' = 1x below 48px, capped device ratio above.
 * @property {boolean|number} [lens]     Chromatic rim lens. On at or above 48px, resolution-tapered.
 * @property {boolean} [bevel=true]      The inset glass highlight ring.
 * @property {boolean} [respectReducedMotion=true]
 * @property {string}  [ariaLabel]       Exposes the orb to assistive tech with this label instead of hiding it.
 */

const DEFAULTS = {
  seed: '',
  size: 320,
  state: 'idle',
  archetype: 'auto',
  palette: 'auto',
  background: 'auto',
  animate: true,
  dpr: 'auto',
  lens: undefined,
  bevel: true,
  respectReducedMotion: true,
  ariaLabel: null,
};

/**
 * One orb bound to a container element. Construct with {@link Orb.mount} or
 * {@link createOrb}, which are the same thing.
 *
 * Setters are cheap and idempotent. Repaints happen on the shared loop, never
 * synchronously, apart from one immediate frame at construction so the orb never
 * flashes empty.
 *
 *     const orb = Orb.mount(el, { seed: 'agent-42', size: 320 });
 *     const stop = orb.listenTo(agentStream);
 *     orb.state = 'speaking';
 *     ...
 *     stop();
 *     orb.destroy();
 */
class Orb {
  /**
   * Mount an orb inside a container element.
   *
   * @param {Element} container
   * @param {OrbOptions} [options]
   * @returns {Orb}
   */
  static mount(container, options) { return new Orb(container, options); }

  /**
   * @param {Element} container
   * @param {OrbOptions} [options]
   */
  constructor(container, options = {}) {
    if (!container || typeof container.appendChild !== 'function') {
      throw new TypeError('[Orb] Orb.mount(container, options): container must be an Element');
    }
    this.container = container;

    // The shader renders past r = 1 so the lens has real pixels to displace. The
    // circular silhouette is cut here instead: clip-path for the shape, plus a
    // half-pixel radial mask for the aliased outer ring clip-path leaves behind.
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'relative', display: 'block', flexShrink: '0', lineHeight: '0',
    });

    this.clip = document.createElement('div');
    Object.assign(this.clip.style, {
      position: 'absolute', inset: '0', borderRadius: '50%', overflow: 'hidden',
      clipPath: 'circle(50% at 50% 50%)',
      WebkitClipPath: 'circle(50% at 50% 50%)',
      maskImage: 'radial-gradient(closest-side, #000 calc(100% - 0.5px), transparent)',
      WebkitMaskImage: 'radial-gradient(closest-side, #000 calc(100% - 0.5px), transparent)',
    });

    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      display: 'block', position: 'relative',
      // Some engines leak the corners of a composited canvas layer through
      // overflow:hidden.
      clipPath: 'circle(50% at 50% 50%)',
      WebkitClipPath: 'circle(50% at 50% 50%)',
    });
    this.ctx = this.canvas.getContext('2d');
    canvasToOrb.set(this.canvas, this);

    this.bevel = document.createElement('div');
    Object.assign(this.bevel.style, {
      position: 'absolute', inset: '0', borderRadius: '50%',
      pointerEvents: 'none', opacity: '0.35',
    });

    this.clip.appendChild(this.canvas);
    this.root.appendChild(this.clip);
    this.root.appendChild(this.bevel);
    container.appendChild(this.root);

    this._opts = { ...DEFAULTS };
    this._spec = {
      bg: [0, 0, 0], anchor: [0, 0, 0], accents: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
      phase: 0, arch: -1, lens: 0,
      level: 0, drive: 0, audioSlow: 0, audioFast: 0,
      spin: 0, spinVel: 0, spinDir: 1, prevFast: 0,
      flipQueued: false, oscSign: 1, lastT: null,
      // state is the target index, stateBlend is what the shader sees, stateW
      // the four normalised weights the dynamics read.
      state: 0, stateBlend: 0, stateSettling: false, stateW: [1, 0, 0, 0],
    };
    /** True until the first update() lands, so the initial state does not fade in. */
    this._firstUpdate = true;
    this._time = 0;
    this._lastNow = null;
    this._visible = true;
    this._animate = true;
    this._dirty = true;
    this._broken = false;
    this._px = 0;
    this._seedHash = null;
    this._unlisten = null;
    this._source = null;
    this._ownsSource = false;
    this._destroyed = false;

    /** False when there is no usable WebGL and the static fallback is showing. */
    this.supported = true;

    // A throw below must not leave a half-built orb registered in module state
    // with no handle for the caller to destroy.
    try {
      this.update(options);

      if (!this.ctx || !isSupported()) {
        // No 2D context, or no usable WebGL. Paint the seeded fallback, stay out
        // of the loop, and say so through orb.supported. A silent transparent
        // hole is the worst possible answer here.
        this.supported = false;
        this._paintFallback();
        return;
      }

      liveOrbs.add(this);
      bindVisibility();
      bindMediaListeners();
      const io = getObserver();
      if (io) io.observe(this.canvas); else this._visible = true;

      // One immediate frame, so the orb never appears empty.
      this._blitHero(getHero());
      kick();
    } catch (err) {
      this._teardown();
      throw err;
    }
  }

  /* Introspection. */

  /** Resolved options, as a snapshot. */
  get options() { return { ...this._opts }; }

  /** The palette in use: seed-derived, hue-derived, or yours. */
  get palette() { return this._palette; }

  /** The identity this orb's seed resolves to. */
  get identity() { return identityForSeed(this._opts.seed); }

  /** The audio source currently bound, if any. */
  get source() { return this._source; }

  /**
   * Live dynamics, for meters and tests.
   * @returns {{level:number, drive:number, fast:number, slow:number, spin:number,
   *            spinVel:number, direction:number, time:number, px:number,
   *            state:string, stateBlend:number, stateWeights:number[]}}
   */
  get metrics() {
    const s = this._spec;
    return {
      level: s.level, drive: s.drive, fast: s.audioFast, slow: s.audioSlow,
      spin: s.spin, spinVel: s.spinVel, direction: s.spinDir,
      time: this._time, px: this._px,
      state: this.state, stateBlend: s.stateBlend, stateWeights: s.stateW.slice(),
    };
  }

  /* The agent surface. Four properties, and that is the whole API a voice agent
   * needs. */

  /**
   * The agent state: 'idle' | 'listening' | 'thinking' | 'speaking'.
   *
   * Assigning crossfades over ~350ms. Assigning the current state is a no-op, so
   * it is safe to write on every event from your voice SDK.
   *
   * Reads back the nearest named state, so `orb.state = 2.5` reads as
   * 'speaking'. The names are a view onto one continuous axis, not a separate
   * source of truth.
   *
   * @type {'idle'|'listening'|'thinking'|'speaking'}
   */
  get state() { return STATES[clamp(Math.round(this._spec.state), 0, 3)]; }
  set state(v) { this.setState(v); }

  /**
   * Raw 0..1 amplitude. Write it when your app already has the level and does
   * not need Orb to analyse anything.
   * @type {number}
   */
  get level() { return this._spec.level; }
  set level(v) { this.setAudioLevel(v); }

  /**
   * The identity seed. Assigning re-rolls palette, archetype and galaxy
   * structure while the orb keeps turning, so it morphs instead of restarting.
   * @type {string}
   */
  get seed() { return this._opts.seed; }
  set seed(v) { this.update({ seed: v }); }

  /** CSS pixels, square. @type {number} */
  get size() { return this._opts.size; }
  set size(v) { this.update({ size: v }); }

  /**
   * Same as assigning `orb.state`, but chainable and usable as a callback.
   *
   * @param {'idle'|'listening'|'thinking'|'speaking'|number} state
   * @returns {Orb} this
   */
  setState(state) {
    if (this._destroyed) return this;
    // Writing the current state has to be free. A voice SDK re-emits 'speaking'
    // on every audio chunk, and the full validation path re-walks the DOM for
    // background: 'auto'.
    if (state === this._opts.state) return this;
    return this.update({ state });
  }

  /* Configuration. */

  /**
   * Apply a partial option patch; anything omitted keeps its current value.
   *
   * Changing the seed re-rolls the identity but keeps the running spin, so the
   * orb morphs into its new colours rather than snapping.
   *
   * Everything is validated here at the boundary, so a mistake throws
   * synchronously with the option named, not a frame later inside a uniform
   * upload.
   *
   * @param {Partial<OrbOptions>} patch
   * @returns {Orb} this
   */
  update(patch = {}) {
    if (this._destroyed) return this;

    // Validate into a scratch object first, so a throw cannot leave the orb half
    // patched.
    const o = { ...this._opts, ...patch };
    const id = identityForSeed(o.seed);

    if (o.size == null || !Number.isFinite(Number(o.size))) {
      throw new TypeError(`[Orb] size must be a finite number, got ${JSON.stringify(o.size)}`);
    }
    const size = Math.max(MIN_SIZE, Math.round(Number(o.size)));

    let pal;
    if (o.palette && typeof o.palette === 'object') pal = o.palette;
    else if (typeof o.palette === 'number') pal = makePalette(o.palette);
    else if (o.palette === 'auto' || o.palette == null) pal = id.palette;
    else throw new TypeError('[Orb] palette must be an object, a hue number, or "auto"');
    const rgb = resolvePalette(pal);

    // Numbers pass through verbatim, so archetype: -1 reaches the shader's own
    // derive-from-the-seed branch.
    let arch;
    if (o.archetype === 'auto' || o.archetype == null) {
      arch = ARCHETYPE_INDEX[id.archetype];
    } else if (typeof o.archetype === 'number') {
      if (!Number.isFinite(o.archetype)) throw new TypeError('[Orb] archetype index must be finite');
      arch = o.archetype;
    } else if (Object.prototype.hasOwnProperty.call(ARCHETYPE_INDEX, o.archetype)) {
      arch = ARCHETYPE_INDEX[o.archetype];
    } else {
      throw new TypeError(
        `[Orb] unknown archetype "${o.archetype}". Use one of ${ARCHETYPES.join(', ')}, or "auto".`);
    }

    // Numbers pass through here too, so callers can drive uState continuously.
    // state: 2.5 is a legitimate half-thinking, half-speaking pose; the shader
    // basis is defined everywhere on [0,3].
    let stateIndex;
    if (o.state == null) {
      stateIndex = 0;
    } else if (typeof o.state === 'number') {
      if (!Number.isFinite(o.state)) throw new TypeError('[Orb] state index must be finite');
      stateIndex = clamp(o.state, 0, 3);
    } else if (Object.prototype.hasOwnProperty.call(STATE_INDEX, o.state)) {
      stateIndex = STATE_INDEX[o.state];
    } else {
      throw new TypeError(
        `[Orb] unknown state "${o.state}". Use one of ${STATES.join(', ')}.`);
    }

    const bg = o.background === 'auto' || o.background == null
      ? resolveAutoBackground(this.container)
      : toRGB(o.background);

    const deviceDpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
    let dpr;
    if (typeof o.dpr === 'number') {
      if (!Number.isFinite(o.dpr) || o.dpr <= 0) throw new TypeError('[Orb] dpr must be > 0');
      dpr = Math.min(MAX_DPR, o.dpr);
    } else if (o.dpr === 'full') {
      dpr = Math.min(MAX_DPR, deviceDpr);
    } else if (o.dpr === 'auto' || o.dpr == null) {
      dpr = size >= HERO_MIN_SIZE ? Math.min(MAX_DPR, deviceDpr) : 1;
    } else {
      throw new TypeError('[Orb] dpr must be a number, "auto" or "full"');
    }
    const px = clamp(Math.round(size * dpr), MIN_SIZE, MAX_PX);
    const lens = resolveLens(o.lens, size, px);

    /* Commit. */
    this._opts = o;
    this._palette = pal;
    const spec = this._spec;
    spec.bg = bg;
    spec.anchor = rgb.anchor;
    spec.accents = rgb.accents;
    spec.arch = arch;
    spec.lens = lens;

    // At mount the state is where the orb already is, not somewhere it fades in
    // from: an agent that boots in 'listening' should not spend 350ms looking
    // idle. Everything after that crossfades.
    if (spec.state !== stateIndex || this._firstUpdate) {
      spec.state = stateIndex;
      if (this._firstUpdate) {
        spec.stateBlend = stateIndex;
        spec.stateSettling = false;
      } else {
        spec.stateSettling = true;
      }
    }
    this._firstUpdate = false;

    // Re-seed the structural phase only when the seed changed, or a size or
    // colour tweak restarts the galaxy mid-rotation.
    if (this._seedHash !== id.hash) {
      this._seedHash = id.hash;
      spec.phase = id.phase;
      if (spec.spin === 0) spec.spin = id.spin;
      this._time = id.timeOffset;
      this._spec.lastT = null;
    }

    this.root.style.width = size + 'px';
    this.root.style.height = size + 'px';
    this.canvas.style.width = size + 'px';
    this.canvas.style.height = size + 'px';
    if (this._px !== px) {
      this._px = px;
      this.canvas.width = px;
      this.canvas.height = px;
      // Assigning width resets the 2D context state, so this has to come after.
      // copy means each blit replaces the buffer rather than compositing onto
      // the last frame: no per-frame clearRect, no ghosting.
      if (this.ctx) this.ctx.globalCompositeOperation = 'copy';
    }

    if (o.ariaLabel) {
      this.root.removeAttribute('aria-hidden');
      this.root.setAttribute('role', 'img');
      this.root.setAttribute('aria-label', String(o.ariaLabel));
    } else {
      this.root.setAttribute('aria-hidden', 'true');
      this.root.removeAttribute('role');
      this.root.removeAttribute('aria-label');
    }

    this.bevel.style.display = o.bevel ? 'block' : 'none';
    this.bevel.style.boxShadow =
      'inset 0 1px 1px rgba(255,255,255,0.7), inset 0 -1px 1px rgba(255,255,255,0.45), ' +
      'inset 0 0 0 1px rgba(255,255,255,0.22), inset 0 0 ' +
      (0.06 * size).toFixed(1) + 'px rgba(255,255,255,0.18)';

    this._reduced = !!o.respectReducedMotion && prefersReducedMotion();
    this._animate = !!o.animate && !this._reduced;
    this._dirty = true;   // repaint at least once with the new settings

    if (!this.supported) { this._paintFallback(); return this; }
    kick();
    return this;
  }

  /** Convenience setters, all forwarding to {@link Orb#update}. */
  setSeed(seed) { return this.update({ seed }); }
  setSize(size) { return this.update({ size }); }
  setArchetype(archetype) { return this.update({ archetype }); }
  setPalette(palette) { return this.update({ palette }); }
  setBackground(background) { return this.update({ background }); }
  setLens(lens) { return this.update({ lens }); }

  /** Resume animation. */
  play() { return this.update({ animate: true }); }
  /** Freeze on the current frame. */
  pause() { return this.update({ animate: false }); }

  /* Audio. */

  /**
   * Drive the orb by hand with a 0..1 amplitude, for anything the built-ins do
   * not cover: a game engine, a websocket, a slider.
   *
   * Non-finite input becomes 0 rather than propagating. One NaN would brick the
   * envelopes permanently.
   *
   * @param {number} level
   * @returns {Orb} this
   */
  setAudioLevel(level) {
    if (this._destroyed) return this;
    const v = Number(level);
    this._spec.level = Number.isFinite(v) ? clamp01(v) : 0;
    if (!this._animate) { this._dirty = true; kick(); }
    return this;
  }

  /**
   * The audio entry point. Point it at whatever your voice stack hands you:
   *
   *   MediaStream        an inbound WebRTC stream, or getUserMedia.
   *   MediaStreamTrack   a single audio track, the shape most SDKs surface.
   *   HTMLAudioElement   TTS playback. <video> works too.
   *   AnalyserNode       your graph; Orb only reads it.
   *   AudioNode          a gain, a destination tap, anything. Orb attaches its
   *                      own analyser and disconnects only that.
   *   OrbAudioSource     one you built, shared across several orbs.
   *   function           your own (t) => 0..1 sampler.
   *   number             a constant level.
   *   'microphone'       asks permission and taps the mic. Async, but the
   *                      disposer still comes back synchronously.
   *   'synthetic'        a fake speech envelope. No permission, no AudioContext.
   *   null               detach.
   *
   *     const stop = orb.listenTo(remoteStream);   // agent speaking
   *     const stop = orb.listenTo('microphone');   // human speaking
   *
   * @param {*} input
   * @param {{gain?:number, fftSize?:number, keepAlive?:boolean}} [opts]
   * @returns {() => void} disposer. Idempotent, and tears down only what this
   *   call created, so other orbs on the same source keep listening.
   */
  listenTo(input, opts) {
    if (this._destroyed) return () => {};
    if (input == null) { this.unlisten(); return () => {}; }

    if (typeof input === 'number') {
      this.setAudioLevel(input);
      return () => { if (!this._destroyed) this.setAudioLevel(0); };
    }

    let made;
    try {
      made = createAudioSource(input, opts);
    } catch (err) {
      this.unlisten();
      throw err;
    }

    // microphone is the one async factory. Returning its promise would make
    // every other call site await for nothing, so the disposer comes back now
    // and cancels the attach if it wins the race.
    if (made && typeof made.then === 'function') {
      let cancelled = false;
      let detach = null;
      made.then((src) => {
        if (cancelled || this._destroyed) { try { src.stop(); } catch {} return; }
        detach = this.listen(src);
      }, (err) => {
        console.error('[Orb] listenTo could not open that audio source', err);
      });
      return () => { cancelled = true; if (detach) { detach(); detach = null; } };
    }

    return this.listen(made);
  }

  /**
   * Bind an {@link OrbAudioSource}. Replaces any previous binding, and several
   * orbs may share one source.
   *
   * Ownership: if the source was not already started, this orb starts it and
   * stops it when unbound or destroyed. A source you started yourself stays
   * yours and keeps running, which is what you want when five orbs share one
   * microphone.
   *
   * @param {OrbAudioSource|null} source
   * @returns {() => void} unbind
   */
  listen(source) {
    if (this._destroyed) return () => {};
    this.unlisten();
    if (!source) return () => {};
    if (typeof source.onLevel !== 'function') {
      throw new TypeError('[Orb] listen(source): expected an OrbAudioSource');
    }
    this._source = source;
    this._ownsSource = !source.active;
    this._unlisten = source.onLevel((v) => { this._spec.level = v; });
    source.start();
    kick();
    // Captured, so a later rebind cannot make this disposer release the wrong
    // binding.
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this._source === source) this.unlisten();
    };
  }

  /**
   * Detach the current audio source and decay to silence.
   *
   * A source this orb started is stopped here, along with the graph, the
   * analyser and any keep-alive sink. Leaving an unsubscribed source running
   * pins the shared rAF loop open with nothing reading it: a leak with no
   * symptom until the battery dies. A source you started yourself is left alone.
   */
  unlisten() {
    const source = this._source;
    const owned = this._ownsSource;
    if (this._unlisten) this._unlisten();
    this._unlisten = null;
    this._source = null;
    this._ownsSource = false;
    this._spec.level = 0;
    if (source && owned) { try { source.stop(); } catch {} }
    if (!this._destroyed && !this._animate) { this._dirty = true; kick(); }
    return this;
  }

  /* Rendering. */

  /** @private True when this orb can ride the instanced atlas. */
  _batchable() {
    return this._spec.lens <= 0 && this._px <= BATCH_MAX_TILE && !!this.ctx;
  }

  /** @private Render through the hero surface and blit. */
  _blitHero(hero) {
    if (!hero || !this.ctx || this._destroyed) return false;
    // Clear the dirty flag on success only. Clearing it first means a failed
    // render (context lost, renderer not ready) marks the orb clean, the loop
    // parks, and the canvas stays blank with no retry.
    if (!hero.render(this._spec, this._px, this._time)) return false;
    this.ctx.drawImage(hero.canvas, 0, 0, this._px, this._px, 0, 0, this._px, this._px);
    this._dirty = false;
    return true;
  }

  /**
   * Force a frame now, outside the loop. Advances the clock by real elapsed wall
   * time first, so calling it repeatedly on a paused or reduced-motion orb gives
   * successive frames rather than the same instant over and over.
   *
   * @returns {boolean} whether a frame was actually drawn
   */
  renderNow() {
    if (this._destroyed || !this.supported) return false;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    advanceOrb(this, now);
    return this._blitHero(getHero());
  }

  /**
   * The static fallback: a radial gradient from this orb's palette. It still
   * carries the identity, so a browser without WebGL shows the right agent in
   * the right colour rather than a transparent hole.
   * @private
   */
  _paintFallback() {
    const p = this._palette || PALETTES[0];
    const bgHex = '#' + this._spec.bg.map(hex2).join('');
    this.clip.style.background =
      `radial-gradient(58% 58% at 34% 26%, ${p.accents[1]}, transparent 62%),` +
      `radial-gradient(72% 72% at 70% 74%, ${p.accents[2]}55, transparent 60%),` +
      `radial-gradient(closest-side, ${p.anchor}, ${bgHex})`;
    // A canvas holding a stale frame would sit on top of the gradient.
    this.canvas.style.display = 'none';
  }

  /* Teardown. */

  /** @private Unregister from every piece of module state. Safe to re-run. */
  _teardown() {
    liveOrbs.delete(this);
    if (observer) { try { observer.unobserve(this.canvas); } catch {} }
    canvasToOrb.delete(this.canvas);
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    // Drop the backing store: a caller holding orb.canvas should not keep up to
    // 1280x1280 of pixels alive.
    try { this.canvas.width = this.canvas.height = 1; } catch {}
    this.ctx = null;
  }

  /**
   * Remove the orb from the loop, detach observers, drop the DOM it created, and
   * stop the audio source if this orb was the one that started it.
   *
   * Idempotent. Every other method becomes a no-op afterwards.
   */
  destroy() {
    if (this._destroyed) return;
    // Before unlisten(), so the source stop below cannot re-enter kick().
    this._destroyed = true;
    this.unlisten();        // stops the source too, if this orb owned it
    this._teardown();
    if (!liveOrbs.size && !liveSources.size) stopLoop();
  }
}

/**
 * Same as {@link Orb.mount}. Pick whichever reads better at the call site.
 *
 * @param {Element} container
 * @param {OrbOptions} [options]
 * @returns {Orb}
 */
function createOrb(container, options) {
  return new Orb(container, options);
}


/* 10. Audio */

/**
 * One shared AudioContext for the page. Chrome throws past roughly six live
 * contexts per document, so a chat list with a voice message per row must not
 * create one each.
 */
let audioCtx = null;

/**
 * Autoplay policy.
 *
 * An orb mounted before the user has touched anything gets a suspended
 * AudioContext, and every analyser on it reads zero: a dead orb next to audible
 * speech, with no symptom. Only a user gesture fixes that.
 *
 * So arm a capturing, passive listener on the first gesture of any kind and
 * resume there. It removes itself as soon as the context is running (or gone),
 * which keeps this a safety net rather than four permanent document listeners.
 *
 * resume() must never reject into the page. Outside a gesture it rejects by
 * design, and an unhandled rejection on every page load is noise.
 */
const GESTURE_EVENTS = ['pointerdown', 'touchend', 'keydown', 'click'];
let gestureHandler = null;

function bindGestureResume() {
  if (gestureHandler || typeof window === 'undefined' || !window.addEventListener) return;
  gestureHandler = () => {
    const ctx = audioCtx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') {
      unbindGestureResume();
      return;
    }
    ctx.resume().then(() => {
      if (!audioCtx || audioCtx.state === 'running') unbindGestureResume();
    }, () => {});
  };
  for (const e of GESTURE_EVENTS) {
    window.addEventListener(e, gestureHandler, { capture: true, passive: true });
  }
}

function unbindGestureResume() {
  if (!gestureHandler || typeof window === 'undefined') return;
  for (const e of GESTURE_EVENTS) {
    window.removeEventListener(e, gestureHandler, { capture: true });
  }
  gestureHandler = null;
}

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') {
    // Works immediately if we happen to be inside a gesture; the listener covers
    // the case where we are not.
    audioCtx.resume().catch(() => {});
    bindGestureResume();
  }
  return audioCtx;
}

/**
 * Resume the shared AudioContext. Call it from your own click handler (the same
 * button that starts the call, say) rather than relying on the gesture hook.
 * Never rejects.
 *
 * @returns {Promise<boolean>} whether audio is now running
 */
function resumeAudio() {
  const ctx = getAudioContext();
  if (!ctx) return Promise.resolve(false);
  if (ctx.state === 'running') return Promise.resolve(true);
  return ctx.resume().then(() => ctx.state === 'running', () => false);
}

/**
 * False means every analyser is reading zero and the page still needs a gesture.
 * @returns {boolean}
 */
function audioReady() {
  return !!audioCtx && audioCtx.state === 'running';
}

/**
 * Close the shared AudioContext and forget it. Safe to call at any time; the
 * next source that needs one will create a fresh context.
 * @returns {Promise<void>}
 */
async function closeAudio() {
  const ctx = audioCtx;
  audioCtx = null;
  mediaGraphs = new WeakMap();
  unbindGestureResume();
  if (ctx) { try { await ctx.close(); } catch {} }
}

/**
 * Keep a WebRTC MediaStream flowing.
 *
 * Chrome will not pump a stream from an RTCPeerConnection through Web Audio
 * unless it is also attached to a media element sink. The analyser reads pure
 * silence otherwise and nothing reports an error. A muted, never-appended
 * <audio> element is the usual workaround: inaudible, free, torn down with the
 * source that made it.
 *
 * muted goes on before srcObject, and defaultMuted too: a duplicate sink that is
 * audible for even one frame is an echo of the agent's own voice.
 *
 * @param {MediaStream} stream
 * @returns {(() => void)|null} disposer
 */
function attachStreamSink(stream) {
  if (typeof document === 'undefined') return null;
  let el;
  try {
    el = document.createElement('audio');
    el.muted = true;
    el.defaultMuted = true;
    el.volume = 0;
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.srcObject = stream;
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    return null;
  }
  return () => {
    if (!el) return;
    try { el.pause(); } catch {}
    try { el.srcObject = null; } catch {}
    el = null;
  };
}

/**
 * A media element can only be analysed if its audio is same-origin or served
 * with permissive CORS. Otherwise createMediaElementSource gives back a tainted
 * node: the analyser reads silence, and since a MediaElementAudioSource can
 * never be un-routed from its element, the element's audio is dead for the rest
 * of the page's life. Has to be detected up front.
 */
function isAnalysable(el) {
  try {
    if (el.crossOrigin === 'anonymous' || el.crossOrigin === 'use-credentials') return true;
    const src = el.currentSrc || el.src;
    if (!src) return false;
    // Object URLs and inline data are same-origin by construction, but several
    // engines report their parsed origin as the literal string "null".
    if (/^(blob:|data:)/.test(src)) return true;
    return new URL(src, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/** One analyser per media element. createMediaElementSource is one-shot. */
let mediaGraphs = new WeakMap();

/**
 * A 0..1 amplitude producer. Every source exposes the same four things:
 * `.level`, `.onLevel(fn) -> unsubscribe`, `.stop()`, `.kind`. They all tick on
 * the same shared rAF as the orbs, so ten orbs on one microphone cost one
 * analyser read per frame, not ten.
 *
 * Construct through the static factories rather than `new`.
 */
class OrbAudioSource {
  /**
   * @param {(t:number) => number} sample returns 0..1 for a time in seconds
   * @param {{dispose?:() => void, kind?:string}} [hooks]
   */
  constructor(sample, hooks = {}) {
    this._sample = sample;
    this._dispose = hooks.dispose || null;
    /**
     * @type {'analyser'|'microphone'|'media'|'stream'|'track'|'node'|'synthetic'
     *        |'speech'|'custom'}
     */
    this.kind = hooks.kind || 'custom';
    this.level = 0;
    this.active = false;
    this.stopped = false;
    this._subs = new Set();
  }

  /** Begin sampling. Idempotent. No-op once {@link OrbAudioSource#stop} has run. */
  start() {
    if (this.active || this.stopped) return this;
    this.active = true;
    liveSources.add(this);
    kick();
    return this;
  }

  /**
   * Stop sampling and release the graph. Terminal: a later start() is a no-op
   * rather than silently ticking a dead analyser. Build a fresh source instead.
   */
  stop() {
    if (this.stopped) return this;
    this.stopped = true;
    this.active = false;
    liveSources.delete(this);
    this.level = 0;
    this._emit(0);
    if (this._dispose) { const d = this._dispose; this._dispose = null; try { d(); } catch {} }
    if (!liveOrbs.size && !liveSources.size) stopLoop();
    return this;
  }

  /**
   * Subscribe to the raw level. Called once per rendered frame.
   * @param {(level:number) => void} fn
   * @returns {() => void} unsubscribe
   */
  onLevel(fn) {
    if (typeof fn !== 'function') throw new TypeError('[Orb] onLevel expects a function');
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  /** @private */
  _emit(v) { for (const fn of this._subs) { try { fn(v); } catch (e) { console.error(e); } } }

  /** @private */
  _tick(t) {
    const raw = Number(this._sample(t));
    const v = Number.isFinite(raw) ? clamp01(raw) : 0;
    this.level = v;
    this._emit(v);
  }

  /**
   * Wrap an existing AnalyserNode. Your graph stays yours; only fftSize and
   * smoothingTimeConstant are touched.
   *
   * @param {AnalyserNode} analyser
   * @param {{gain?:number, fftSize?:number}} [opts] `gain` scales RMS into 0..1 (3.2 suits speech)
   * @returns {OrbAudioSource}
   */
  static fromAnalyser(analyser, opts = {}) {
    if (!analyser || typeof analyser.getByteTimeDomainData !== 'function') {
      throw new TypeError('[Orb] fromAnalyser expects an AnalyserNode');
    }
    const gain = opts.gain ?? 3.2;
    analyser.fftSize = opts.fftSize || 512;
    // Zero smoothing, deliberately. All the smoothing happens here in two
    // asymmetric envelopes tuned for speech; browser pre-smoothing fights them
    // and rounds off the onsets the spin integrator needs.
    try { analyser.smoothingTimeConstant = 0; } catch {}
    const buf = new Uint8Array(analyser.fftSize);
    return new OrbAudioSource(() => {
      analyser.getByteTimeDomainData(buf);
      // Time-domain RMS rather than a spectrum sum. This is loudness, and an
      // onset shows up in RMS a frame or two before it shows up in any band.
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const x = (buf[i] - 128) / 128;
        sum += x * x;
      }
      return Math.min(1, gain * Math.sqrt(sum / buf.length));
    }, { kind: 'analyser' });
  }

  /**
   * Live microphone. Asks permission on call, so invoke it from a gesture. The
   * stream is not connected to the destination, so there is no feedback loop.
   *
   * @param {{gain?:number, echoCancellation?:boolean}} [opts]
   * @returns {Promise<OrbAudioSource>}
   */
  static async microphone(opts = {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('[Orb] getUserMedia is unavailable here. It needs a secure ' +
                      'context — https:// or localhost.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: opts.echoCancellation ?? true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // Everything after the await has to stop the tracks on failure, or the
    // browser keeps recording with the indicator lit and the caller holds no
    // handle to stop it.
    try {
      const ctx = getAudioContext();
      if (!ctx) throw new Error('[Orb] Web Audio is unavailable in this browser');
      const node = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      node.connect(analyser);
      const src = OrbAudioSource.fromAnalyser(analyser, { gain: opts.gain ?? 3.2 });
      src.kind = 'microphone';
      src.stream = stream;
      src._dispose = () => {
        try { node.disconnect(); } catch {}
        try { analyser.disconnect(); } catch {}
        for (const track of stream.getTracks()) track.stop();
      };
      return src;
    } catch (err) {
      for (const track of stream.getTracks()) track.stop();
      throw err;
    }
  }

  /**
   * An `<audio>` or `<video>` element.
   *
   * Where the audio can be analysed this taps it with a real analyser and passes
   * the signal through to the speakers untouched. Where it cannot (a
   * cross-origin stream with no CORS headers, which would return silence and
   * permanently mute the element) it falls back to a synthetic speech envelope
   * gated on playback and says so in `.kind`. A dead orb next to audible speech
   * looks broken; the caller can read `.kind` to find out what happened.
   *
   * createMediaElementSource reroutes the element's output through the
   * AudioContext permanently, so call this from a gesture. Outside one the
   * context stays suspended and the element goes silent.
   *
   * @param {HTMLMediaElement} el
   * @param {{gain?:number, forceSynthetic?:boolean}} [opts]
   * @returns {OrbAudioSource}
   */
  static fromMedia(el, opts = {}) {
    if (!el || typeof el.play !== 'function') {
      throw new TypeError('[Orb] fromMedia expects an <audio> or <video> element');
    }
    const gate = (inner) => (t) => (el.paused || el.ended ? 0 : inner(t));

    if (!opts.forceSynthetic && isAnalysable(el)) {
      let graph = mediaGraphs.get(el);
      if (!graph) {
        const ctx = getAudioContext();
        if (ctx) {
          try {
            const node = ctx.createMediaElementSource(el);
            const analyser = ctx.createAnalyser();
            node.connect(analyser);
            analyser.connect(ctx.destination);   // keep it audible
            graph = { ctx, analyser, node };
            mediaGraphs.set(el, graph);
          } catch {
            graph = null;   // already tapped by someone else, or blocked
          }
        }
      }
      if (graph) {
        getAudioContext();   // nudges resume() if we are inside a gesture
        const src = OrbAudioSource.fromAnalyser(graph.analyser, { gain: opts.gain ?? 3.2 });
        src.kind = 'media';
        src._sample = gate(src._sample);
        return src;
      }
    }

    const synth = OrbAudioSource.synthetic();
    synth.kind = 'synthetic';
    synth._sample = gate(synth._sample);
    return synth;
  }

  /**
   * Any MediaStream: the inbound WebRTC stream from the agent, or the human's
   * own getUserMedia stream.
   *
   * Two things here are not optional in production, and both are invisible until
   * they bite.
   *
   * A MediaStreamAudioSourceNode binds to the stream's first audio track at
   * construction and never re-binds. WebRTC streams routinely arrive from
   * `ontrack` a beat before their audio track does, and SDKs swap tracks on
   * device change, so the node is rebuilt whenever the track set changes.
   * Without that the orb sits at zero for the whole call.
   *
   * And Chrome will not pump a peer-connection stream through Web Audio at all
   * unless it is also attached to a media element (see attachStreamSink). Pass
   * `keepAlive: false` if you attach the stream yourself and would rather not
   * have a second muted sink.
   *
   * Disposing never stops the stream's tracks. The call is not ours to hang up.
   *
   * @param {MediaStream} stream
   * @param {{gain?:number, fftSize?:number, keepAlive?:boolean}} [opts]
   * @returns {OrbAudioSource}
   */
  static fromStream(stream, opts = {}) {
    if (!stream || typeof stream.getTracks !== 'function') {
      throw new TypeError('[Orb] fromStream expects a MediaStream');
    }
    const ctx = getAudioContext();
    if (!ctx) throw new Error('[Orb] Web Audio is unavailable in this browser');
    const analyser = ctx.createAnalyser();

    let node = null;
    const rebind = () => {
      if (node) { try { node.disconnect(); } catch {} node = null; }
      if (typeof stream.getAudioTracks !== 'function' || !stream.getAudioTracks().length) return;
      try {
        node = ctx.createMediaStreamSource(stream);
        node.connect(analyser);
      } catch (err) {
        node = null;
        console.warn('[Orb] could not tap this MediaStream', err);
      }
    };
    rebind();

    const listens = typeof stream.addEventListener === 'function';
    if (listens) {
      stream.addEventListener('addtrack', rebind);
      stream.addEventListener('removetrack', rebind);
    }
    const detachSink = opts.keepAlive === false ? null : attachStreamSink(stream);

    const src = OrbAudioSource.fromAnalyser(analyser, opts);
    src.kind = 'stream';
    src.stream = stream;
    src._dispose = () => {
      if (listens) {
        try { stream.removeEventListener('addtrack', rebind); } catch {}
        try { stream.removeEventListener('removetrack', rebind); } catch {}
      }
      if (node) { try { node.disconnect(); } catch {} node = null; }
      try { analyser.disconnect(); } catch {}
      if (detachSink) detachSink();
    };
    return src;
  }

  /**
   * A single MediaStreamTrack, the shape most agent SDKs hand you (`track` off
   * an RTCTrackEvent, or a LiveKit RemoteAudioTrack.mediaStreamTrack).
   *
   * Wrapped in a private one-track MediaStream, held on `.stream` so it cannot
   * be collected while the analyser reads it. Disposing does not stop the track.
   *
   * @param {MediaStreamTrack} track
   * @param {{gain?:number, fftSize?:number, keepAlive?:boolean}} [opts]
   * @returns {OrbAudioSource}
   */
  static fromTrack(track, opts = {}) {
    if (!track || typeof track.stop !== 'function' || track.kind !== 'audio') {
      throw new TypeError('[Orb] fromTrack expects an audio MediaStreamTrack');
    }
    if (typeof MediaStream === 'undefined') {
      throw new Error('[Orb] MediaStream is unavailable in this browser');
    }
    const src = OrbAudioSource.fromStream(new MediaStream([track]), opts);
    src.kind = 'track';
    src.track = track;
    return src;
  }

  /**
   * Any AudioNode already in your graph: a gain on the agent's output, a
   * worklet, an oscillator. The analyser is attached in that node's own context,
   * which may not be the shared one, and only reads.
   *
   * Disposing disconnects the edge to our analyser and nothing else. Old engines
   * that reject the one-argument disconnect() fall back to the blunt form.
   *
   * @param {AudioNode} node
   * @param {{gain?:number, fftSize?:number}} [opts]
   * @returns {OrbAudioSource}
   */
  static fromNode(node, opts = {}) {
    if (!node || typeof node.connect !== 'function' || !node.context) {
      throw new TypeError('[Orb] fromNode expects an AudioNode');
    }
    const analyser = node.context.createAnalyser();
    node.connect(analyser);
    const src = OrbAudioSource.fromAnalyser(analyser, opts);
    src.kind = 'node';
    src._dispose = () => {
      try { node.disconnect(analyser); }
      catch { try { node.disconnect(); } catch {} }
      try { analyser.disconnect(); } catch {}
    };
    return src;
  }

  /**
   * A synthetic speech envelope from layered sines. No audio, no permission
   * prompt, no AudioContext.
   *
   * Three multiplied layers, incommensurate so it never loops:
   *   phrase    a slow frequency-modulated swell, the shape of a sentence
   *   syllable  a ~6.2 rad/s beat, itself modulated
   *   breath    a hard gate down to 12% for the pauses between phrases
   *
   * @returns {OrbAudioSource}
   */
  static synthetic() {
    return new OrbAudioSource((t) => {
      const phrase = 0.55 + 0.45 * Math.sin(0.9 * t + 2 * Math.sin(0.37 * t));
      const syllable = 0.6 + 0.4 * Math.sin(6.2 * t + 3 * Math.sin(2.3 * t));
      const breath = Math.sin(0.7 * t + 1.7) > -0.6 ? 1 : 0.12;
      return phrase * syllable * breath;
    }, { kind: 'synthetic' });
  }

  /**
   * An audible synthetic voice.
   *
   * {@link OrbAudioSource.synthetic} only fabricates a level and makes no sound,
   * which is right for a cross-origin fallback but surprising when a control is
   * labelled "voice". This one synthesises speech-like babble with Web Audio and
   * routes it through the same analyser path a real agent's audio takes, so what
   * you hear and what the orb does are one measured signal.
   *
   * A sawtooth glottal source through two slowly swept bandpass formants, gated
   * by syllable- and phrase-rate LFOs. The shape of speech, no content.
   *
   * Call from a gesture: the AudioContext starts suspended and emits nothing
   * until one has happened.
   *
   * @param {{gain?:number, pitch?:number, volume?:number}} [opts]
   * @returns {OrbAudioSource}
   */
  static speech(opts = {}) {
    const ctx = getAudioContext();
    if (!ctx) throw new Error('[Orb] Web Audio is unavailable in this browser');

    const nodes = [];
    const keep = (n) => { nodes.push(n); return n; };

    // Sawtooth stands in for vocal-fold buzz.
    const osc = keep(ctx.createOscillator());
    osc.type = 'sawtooth';
    osc.frequency.value = opts.pitch ?? 118;

    // Vibrato, so the pitch is never dead flat.
    const vib = keep(ctx.createOscillator());
    vib.frequency.value = 4.7;
    const vibAmt = keep(ctx.createGain());
    vibAmt.gain.value = 3.5;
    vib.connect(vibAmt).connect(osc.frequency);

    // Two parallel bandpass formants are what make this read as a voice rather
    // than a buzzer. Sweeping their centres slowly is heard as changing vowels.
    const sum = keep(ctx.createGain());
    sum.gain.value = 1;
    for (const spec of [{ f: 700, q: 9, amp: 1.0, lfo: 0.23, sweep: 190 },
                        { f: 1220, q: 11, amp: 0.7, lfo: 0.31, sweep: 320 }]) {
      const bp = keep(ctx.createBiquadFilter());
      bp.type = 'bandpass';
      bp.frequency.value = spec.f;
      bp.Q.value = spec.q;
      const amp = keep(ctx.createGain());
      amp.gain.value = spec.amp;
      const lfo = keep(ctx.createOscillator());
      lfo.frequency.value = spec.lfo;
      const lfoAmt = keep(ctx.createGain());
      lfoAmt.gain.value = spec.sweep;
      lfo.connect(lfoAmt).connect(bp.frequency);
      osc.connect(bp).connect(amp).connect(sum);
      lfo.start();
    }

    // Constant offset plus syllable-, word- and phrase-rate LFOs summed straight
    // into the gain AudioParam. Glitch-free, and the rates are incommensurate so
    // it never audibly loops.
    const env = keep(ctx.createGain());
    env.gain.value = 0;
    const base = keep(ctx.createConstantSource());
    base.offset.value = 0.42;
    base.connect(env.gain);
    for (const [rate, depth] of [[4.3, 0.34], [0.9, 0.2], [0.27, 0.16]]) {
      const l = keep(ctx.createOscillator());
      l.frequency.value = rate;
      const g = keep(ctx.createGain());
      g.gain.value = depth;
      l.connect(g).connect(env.gain);
      l.start();
    }

    const out = keep(ctx.createGain());
    out.gain.value = opts.volume ?? 0.09;   // quiet on purpose, it is a demo tone

    const analyser = ctx.createAnalyser();
    sum.connect(env).connect(out);
    out.connect(analyser);         // measured by the orb
    out.connect(ctx.destination);  // and actually heard

    osc.start();
    vib.start();
    base.start();

    const src = OrbAudioSource.fromAnalyser(analyser, { gain: opts.gain ?? 3.2 });
    src.kind = 'speech';
    src._dispose = () => {
      for (const n of nodes) {
        try { if (typeof n.stop === 'function') n.stop(); } catch {}
        try { n.disconnect(); } catch {}
      }
      try { analyser.disconnect(); } catch {}
    };
    return src;
  }

  /**
   * Anything else: supply your own 0..1 sampler.
   * @param {(t:number) => number} fn
   * @returns {OrbAudioSource}
   */
  static custom(fn) {
    if (typeof fn !== 'function') throw new TypeError('[Orb] custom(fn) expects a function');
    return new OrbAudioSource(fn, { kind: 'custom' });
  }
}

/**
 * Pick the right source for whatever you have. {@link Orb#listenTo} is this plus
 * the binding; call it directly when several orbs share one source.
 *
 * Dispatch is by capability, not instanceof. Agent SDKs routinely hand you
 * objects from another realm (an iframe, a worker bridge, a polyfill) where
 * `instanceof MediaStream` is false but getAudioTracks is present.
 *
 * The order matters: an AnalyserNode is also an AudioNode, a MediaStreamTrack
 * also has .stop(), and a media element also has .play(). Each test is the
 * narrowest one that still identifies its type.
 *
 * @param {AnalyserNode|AudioNode|MediaStream|MediaStreamTrack|HTMLMediaElement|
 *         OrbAudioSource|Function|'microphone'|'synthetic'|'speech'} input
 * @param {object} [opts]
 * @returns {OrbAudioSource|Promise<OrbAudioSource>}
 */
function createAudioSource(input, opts) {
  if (input === 'microphone' || input === 'mic') return OrbAudioSource.microphone(opts);
  if (input === 'synthetic' || input === 'demo') return OrbAudioSource.synthetic();
  if (input === 'speech') return OrbAudioSource.speech(opts);
  if (input instanceof OrbAudioSource) return input;
  if (typeof input === 'function') return OrbAudioSource.custom(input);

  if (input && typeof input === 'object') {
    if (typeof input.getByteTimeDomainData === 'function') {
      return OrbAudioSource.fromAnalyser(input, opts);        // AnalyserNode
    }
    if (typeof input.getAudioTracks === 'function') {
      return OrbAudioSource.fromStream(input, opts);          // MediaStream
    }
    if (input.kind === 'audio' && typeof input.stop === 'function'
        && typeof input.getSettings === 'function') {
      return OrbAudioSource.fromTrack(input, opts);           // MediaStreamTrack
    }
    if (typeof input.play === 'function' && 'paused' in input) {
      return OrbAudioSource.fromMedia(input, opts);           // <audio> / <video>
    }
    if (typeof input.connect === 'function' && input.context) {
      return OrbAudioSource.fromNode(input, opts);            // any other AudioNode
    }
  }

  throw new TypeError(
    '[Orb] createAudioSource: unsupported input. Pass a MediaStream, a ' +
    'MediaStreamTrack, an <audio>/<video> element, an AnalyserNode, an ' +
    'AudioNode, a (t) => 0..1 function, "microphone", "speech" or "synthetic".');
}

/* 11. Diagnostics, teardown, namespace */

/**
 * WebGL with usable fragment precision? Unlike {@link diagnostics} this probes
 * rather than reporting on a renderer that may not exist yet, so it answers
 * correctly before the first orb is constructed.
 *
 * @returns {boolean}
 */
function isSupported() {
  if (typeof document === 'undefined') return false;
  if (heroSurface && !heroSurface.failed) return true;
  if (batchSurface && !batchSurface.failed) return true;
  if (supportProbe !== null) return supportProbe;
  try {
    // One throwaway context per page, released immediately. Not the 1280x1280
    // hero surface: a page of 32px avatars must not allocate that just to answer
    // whether WebGL exists.
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const gl = c.getContext('webgl', GL_ATTRS) || c.getContext('experimental-webgl', GL_ATTRS);
    if (!gl) return (supportProbe = false);
    const ok = probeHighp(gl);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return (supportProbe = ok);
  } catch {
    return (supportProbe = false);
  }
}

/**
 * Runtime state, for meters, tests and debugging.
 *
 * @returns {{webgl:boolean, instancing:boolean, contextLost:boolean, orbs:number,
 *            sources:number, batched:number, drawCalls:number, fps:number,
 *            frames:number, heroSurface:HTMLCanvasElement|null,
 *            batchSurface:HTMLCanvasElement|null}}
 */
function diagnostics() {
  let batched = 0;
  for (const o of liveOrbs) if (o._batchable()) batched++;
  return {
    webgl: heroSurface ? !heroSurface.failed : isSupported(),
    instancing: !!(batchSurface && !batchSurface.failed),
    contextLost: !!(heroSurface && !heroSurface.failed && !heroSurface.ready),
    orbs: liveOrbs.size,
    sources: liveSources.size,
    batched,
    drawCalls: (heroSurface ? heroSurface.drawCalls : 0) + (batchSurface ? batchSurface.drawCalls : 0),
    fps: Math.round(measuredFps * 10) / 10,
    frames: frameCount,
    heroSurface: heroSurface ? heroSurface.canvas : null,
    batchSurface: batchSurface ? batchSurface.canvas : null,
  };
}

/** Reset the draw-call counters. The demo's stats panel uses this. */
function resetCounters() {
  if (heroSurface) heroSurface.drawCalls = 0;
  if (batchSurface) batchSurface.drawCalls = 0;
}

/**
 * Turn instanced batching on or off. Off routes every orb through the hero
 * program: slower for lists, but useful for measurement and as an escape hatch
 * where ANGLE_instanced_arrays misbehaves.
 * @param {boolean} on
 */
function setBatching(on) {
  batchDisabled = !on;
  if (batchDisabled && batchSurface) { batchSurface.dispose(); batchSurface = null; }
  markAllDirty();
}

/**
 * Destroy every orb, stop every source, cancel the loop, and release both GL
 * contexts and the AudioContext. Everything can be recreated afterwards.
 */
function dispose() {
  for (const orb of [...liveOrbs]) { try { orb.destroy(); } catch {} }
  for (const src of [...liveSources]) { try { src.stop(); } catch {} }
  liveOrbs.clear();
  liveSources.clear();
  stopLoop();
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
  if (observer) { observer.disconnect(); observer = null; }
  releaseSurfaces();
  closeAudio();
}

/**
 * Force a WebGL context loss, for testing the recovery path.
 * @param {number} [restoreAfterMs=600] 0 = do not restore
 */
function loseContextForTesting(restoreAfterMs = 600) {
  for (const s of [heroSurface, batchSurface]) {
    if (!s || !s.gl) continue;
    const ext = s.gl.getExtension('WEBGL_lose_context');
    if (!ext) continue;
    ext.loseContext();
    if (restoreAfterMs > 0) setTimeout(() => { try { ext.restoreContext(); } catch {} }, restoreAfterMs);
  }
}

/** Orb, by Earl Balai. */
const version = '1.0.0';

/**
 * The namespace is the class. Orb.mount(el) builds one,
 * Orb.AudioSource.fromStream(s) builds a source, Orb.diagnostics() reports on
 * the renderer. One name to import, and no second kit object shadowing the thing
 * it wraps.
 */
Object.assign(Orb, {
  create: createOrb,          // `mount` is already a static on the class
  AudioSource: OrbAudioSource,
  createAudioSource,
  resumeAudio, audioReady, closeAudio,
  identityForSeed, hashSeed, makePalette, toRGB,
  diagnostics, isSupported, resetCounters, setBatching, dispose,
  loseContextForTesting,
  ARCHETYPES, STATES, HUES, PALETTES, GLSL, version,
});

// So non-module code on the page can reach the API once this has loaded.
if (typeof globalThis !== 'undefined') globalThis.Orb = Orb;


  return {
    "ARCHETYPES": ARCHETYPES,
    "STATES": STATES,
    "HUES": HUES,
    "GLSL": GLSL,
    "toRGB": toRGB,
    "makePalette": makePalette,
    "PALETTES": PALETTES,
    "hashSeed": hashSeed,
    "identityForSeed": identityForSeed,
    "createOrb": createOrb,
    "Orb": Orb,
    "resumeAudio": resumeAudio,
    "audioReady": audioReady,
    "closeAudio": closeAudio,
    "OrbAudioSource": OrbAudioSource,
    "createAudioSource": createAudioSource,
    "isSupported": isSupported,
    "diagnostics": diagnostics,
    "resetCounters": resetCounters,
    "setBatching": setBatching,
    "dispose": dispose,
    "loseContextForTesting": loseContextForTesting,
    "version": version,
    "default": Orb
  };
  })();

  /* ══ src/element.js ══════════════════════════════════════════════════════ */
  var __orb_element = (function (__core) {
  'use strict';
  var createOrb = __core["createOrb"];
  var isSupported = __core["isSupported"];
  var identityForSeed = __core["identityForSeed"];
  var makePalette = __core["makePalette"];
  var toRGB = __core["toRGB"];
  var STATES = __core["STATES"];
  var ARCHETYPES = __core["ARCHETYPES"];

/**
 * <orb-js> custom element. Wraps the core in ./orb.js.
 * Earl Balai · zero dependencies · native ES module · no build step
 *
 *     <script type="module" src="./src/element.js"></script>
 *     <orb-js seed="agent-7" size="160" state="speaking" archetype="nebula"></orb-js>
 *
 * The core leaves three things to its host, and they live here.
 *
 * Attributes reflect both ways, so the orb is drivable from HTML, from JS
 * properties, from a framework that only sets attributes, or from devtools.
 *
 * The circular clip and the bevel ring live in a shadow root, so page CSS cannot
 * square off the sphere and the orb's styles cannot leak out. The core's own
 * bevel is switched off; the glass is in one place.
 *
 * disconnectedCallback destroys the orb outright. rAF loop, GL registration and
 * any audio this element started all go with it.
 *
 * With no WebGL the element paints a seeded CSS sphere instead, so you get the
 * right agent in the right colour rather than an empty box.
 */


/* constants */

/** The tag this module defines. */
const TAG = 'orb-js';

const OBSERVED = ['seed', 'size', 'state', 'archetype', 'lens', 'background', 'animate'];

/** Same list, string-backed both ways. */
const REFLECTED = OBSERVED;

const DEFAULT_SIZE = 320;

const TRUE_WORDS = ['', 'true', 'on', 'yes', '1'];
const FALSE_WORDS = ['false', 'off', 'no', '0', 'none'];

/**
 * Shadow CSS. The clip is tripled on purpose (border-radius, clip-path, and a
 * half-pixel radial mask). Each one leaks on a different engine when a
 * composited canvas layer sits underneath.
 */
const SHEET = `
:host {
  display: inline-block;
  position: relative;
  width: var(--orb-size, 320px);
  height: var(--orb-size, 320px);
  line-height: 0;
  flex: 0 0 auto;
  vertical-align: middle;
  -webkit-tap-highlight-color: transparent;
}
:host([hidden]) { display: none; }

.frame {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  overflow: hidden;
  clip-path: circle(50% at 50% 50%);
  -webkit-clip-path: circle(50% at 50% 50%);
  mask-image: radial-gradient(closest-side, #000 calc(100% - 0.5px), transparent);
  -webkit-mask-image: radial-gradient(closest-side, #000 calc(100% - 0.5px), transparent);
}

.mount {
  position: absolute;
  inset: 0;
  display: block;
  line-height: 0;
}

/* The no-WebGL sphere. Painted from the seed's palette so identity survives
   when the shader cannot run. */
.fallback {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: transparent;
}
.fallback[hidden] { display: none; }

/* The glass. Matches the core's bevel geometry, so an element orb and a
   createOrb() orb look identical. */
.bevel {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  opacity: 0.35;
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.7),
    inset 0 -1px 1px rgba(255, 255, 255, 0.45),
    inset 0 0 0 1px rgba(255, 255, 255, 0.22),
    inset 0 0 calc(var(--orb-size, 320px) * 0.06) rgba(255, 255, 255, 0.18);
}
.bevel[hidden] { display: none; }
`;

/* attribute parsing */

const warn = (msg) => { try { console.warn('[orb-js] ' + msg); } catch { /* muted console */ } };

const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * Attributes get typed by hand, and a throw out of attributeChangedCallback
 * aborts the browser's parser task, taking unrelated markup with it. So every
 * parser below warns and falls back instead.
 */
function parseSize(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    warn('size="' + raw + '" is not a positive number; using ' + DEFAULT_SIZE);
    return DEFAULT_SIZE;
  }
  return n;
}

function parseState(raw) {
  const v = lower(raw);
  if (STATES.indexOf(v) !== -1) return v;
  const n = Number(raw);
  if (raw !== '' && Number.isFinite(n)) return n;   // continuous poses are legal
  warn('state="' + raw + '" is not one of ' + STATES.join(', ') + '; using idle');
  return 'idle';
}

function parseArchetype(raw) {
  const v = lower(raw);
  if (v === '' || v === 'auto') return 'auto';
  if (ARCHETYPES.indexOf(v) !== -1) return v;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  warn('archetype="' + raw + '" is not one of ' + ARCHETYPES.join(', ') + '; using auto');
  return 'auto';
}

function parseLens(raw) {
  const v = lower(raw);
  if (v === 'auto') return undefined;               // let the core size it
  if (TRUE_WORDS.indexOf(v) !== -1) return true;
  if (FALSE_WORDS.indexOf(v) !== -1) return false;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  warn('lens="' + raw + '" is not a number, on/off, or auto; using auto');
  return undefined;
}

function parseAnimate(raw) {
  const v = lower(raw);
  if (FALSE_WORDS.indexOf(v) !== -1) return false;
  if (TRUE_WORDS.indexOf(v) !== -1) return true;
  warn('animate="' + raw + '" is not a boolean; using true');
  return true;
}

/**
 * Not an attribute, same treatment. A bad palette dropped here rather than at
 * the core, where it would make every later update() throw and freeze the orb on
 * whatever it was showing.
 */
function parsePalette(v) {
  if (v == null || v === 'auto') return undefined;
  if (typeof v === 'number') {
    if (Number.isFinite(v)) return v;
  } else if (v && typeof v === 'object' && Array.isArray(v.accents) && v.accents.length === 3) {
    try {
      toRGB(v.anchor);
      toRGB(v.accents[0]); toRGB(v.accents[1]); toRGB(v.accents[2]);
      return v;
    } catch { /* reported below */ }
  }
  warn('palette must be a hue number, or {anchor, accents:[a,b,c]} of CSS colours; using auto');
  return undefined;
}

function parseBackground(raw) {
  const v = String(raw).trim();
  if (v === '' || lower(v) === 'auto') return 'auto';
  try { toRGB(v); return v; } catch {
    warn('background="' + v + '" is not a CSS colour; using auto');
    return 'auto';
  }
}

/* the element */

/**
 * extends HTMLElement is evaluated at import time and throws under Node/SSR.
 * A plain base keeps the module importable anywhere; nothing constructs it
 * server side.
 */
const Base = typeof HTMLElement === 'function' ? HTMLElement : class {};

/**
 * <orb-js>, an audio-reactive galaxy-in-glass orb as one HTML tag.
 *
 * Attributes (all reflected to like-named properties):
 *   seed        identity string. Palette, archetype and structure derive from it.
 *   size        CSS pixels, square. Default 320.
 *   state       idle | listening | thinking | speaking, or a 0..3 number.
 *   archetype   spiral | nebula | core | deep | auto.
 *   lens        number >= 0, on/off, or auto.
 *   background  any CSS colour, or auto (resolved through the shadow boundary).
 *   animate     boolean. Absent means animating.
 *
 * Properties beyond those: palette, dpr, level, label, orb, identity, metrics,
 * supported.
 *
 * Methods: listenTo(input, opts), unlisten(), setState(s), update(patch),
 * play(), pause().
 */
class OrbElement extends Base {
  static get observedAttributes() { return OBSERVED.slice(); }

  constructor() {
    super();

    /** @type {import('./orb.js').Orb|null} */
    this._orb = null;
    /** Options that make no sense as attribute strings. */
    this._props = { palette: undefined, dpr: undefined, level: 0, label: null };
    /** Last applied option signature, so redundant update() calls are skipped. */
    this._sig = '';
    /** The core's audio disposer, plus what produced it. */
    this._audioStop = null;
    this._audio = null;
    this._mounted = false;
    this._batching = false;

    const root = this.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = SHEET;

    this._frame = document.createElement('div');
    this._frame.className = 'frame';
    this._mountEl = document.createElement('div');
    this._mountEl.className = 'mount';
    this._fallback = document.createElement('div');
    this._fallback.className = 'fallback';
    this._fallback.hidden = true;
    this._bevel = document.createElement('div');
    this._bevel.className = 'bevel';

    this._frame.appendChild(this._mountEl);
    this._frame.appendChild(this._fallback);
    root.appendChild(style);
    root.appendChild(this._frame);
    root.appendChild(this._bevel);
  }

  /* --- lifecycle ---------------------------------------------------------- */

  connectedCallback() {
    // A property assigned before the definition loaded shadows the accessor
    // forever unless it is deleted and replayed through the setter.
    for (const name of REFLECTED) upgradeProperty(this, name);
    for (const name of ['palette', 'dpr', 'level', 'label']) upgradeProperty(this, name);

    this._applyAria();
    this._mount();
  }

  disconnectedCallback() {
    // Everything this element started stops here: rAF registration, GL
    // bookkeeping, the intersection observer, any audio the orb took over.
    // What is left is inert DOM.
    if (this._audioStop) { try { this._audioStop(); } catch { /* already gone */ } }
    this._audioStop = null;
    if (this._orb) { try { this._orb.destroy(); } catch { /* already gone */ } }
    this._orb = null;
    this._mounted = false;
    this._sig = '';
    this._fallback.hidden = true;
    this._fallback.style.background = '';
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'size') this._applySize();
    this._sync();
  }

  /* --- reflected properties ------------------------------------------------ */

  get seed() { return this.hasAttribute('seed') ? this.getAttribute('seed') : ''; }
  set seed(v) { this._reflect('seed', v); }

  get size() {
    return this.hasAttribute('size') ? parseSize(this.getAttribute('size')) : DEFAULT_SIZE;
  }
  set size(v) { this._reflect('size', v); }

  get state() {
    // Once mounted the orb is the truth, and it reads back the nearest named
    // state, which is what a caller asking "what is it doing" wants.
    if (this._orb) return this._orb.state;
    return this._stateOption();
  }
  set state(v) { this._reflect('state', v); }

  get archetype() {
    return this.hasAttribute('archetype') ? parseArchetype(this.getAttribute('archetype')) : 'auto';
  }
  set archetype(v) { this._reflect('archetype', v); }

  get lens() {
    return this.hasAttribute('lens') ? parseLens(this.getAttribute('lens')) : undefined;
  }
  set lens(v) {
    if (v == null) { this.removeAttribute('lens'); this._sync(); return; }
    this._reflect('lens', v === true ? 'true' : v === false ? 'false' : v);
  }

  get background() {
    return this.hasAttribute('background') ? parseBackground(this.getAttribute('background')) : 'auto';
  }
  set background(v) { this._reflect('background', v); }

  get animate() {
    return this.hasAttribute('animate') ? parseAnimate(this.getAttribute('animate')) : true;
  }
  set animate(v) {
    // Absent means animating, so true removes rather than writes. The _sync()
    // below covers the case where the attribute was already absent and no
    // attributeChangedCallback fires.
    if (v === false || FALSE_WORDS.indexOf(lower(v)) !== -1) this.setAttribute('animate', 'false');
    else this.removeAttribute('animate');
    this._sync();
  }

  /* --- non-reflected properties -------------------------------------------- */

  /** {anchor, accents}, a hue number, or 'auto'. Not an attribute. */
  get palette() { return this._orb ? this._orb.palette : this._props.palette; }
  set palette(v) { this._props.palette = parsePalette(v); this._sync(); }

  /** Device pixel ratio: a number, 'auto' or 'full'. */
  get dpr() { return this._props.dpr; }
  set dpr(v) { this._props.dpr = v; this._sync(); }

  /** Raw 0..1 amplitude. Write it if your app already has the level. */
  get level() { return this._orb ? this._orb.level : this._props.level; }
  set level(v) {
    const n = Number(v);
    this._props.level = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
    if (this._orb) this._orb.level = this._props.level;
  }

  /** Accessible name. Null (the default) leaves the orb aria-hidden. */
  get label() { return this._props.label; }
  set label(v) {
    this._props.label = v == null ? null : String(v);
    this._applyAria();
  }

  /* --- introspection ------------------------------------------------------- */

  /** The core instance, or null before connect and after disconnect. */
  get orb() { return this._orb; }

  /** True on real WebGL, false when the CSS sphere is showing. */
  get supported() { return !!(this._orb && this._orb.supported); }

  /** What this element's seed resolves to. Works with no orb mounted. */
  get identity() { return identityForSeed(this.seed); }

  /** Live dynamics, or null when nothing is mounted. */
  get metrics() { return this._orb ? this._orb.metrics : null; }

  /* --- methods ------------------------------------------------------------- */

  /**
   * Bind audio. Takes anything the core takes: a MediaStream, a track, an
   * <audio> element, an AnalyserNode, an AudioNode, a (t) => 0..1 function, a
   * number, 'microphone', 'speech', 'synthetic', or null to detach.
   *
   * Fine to call before the element is connected. The binding is remembered and
   * attached on mount, and re-attached if the element is moved in the DOM (which
   * disconnects and reconnects it).
   *
   * @param {*} input
   * @param {{gain?:number, fftSize?:number, keepAlive?:boolean}} [opts]
   * @returns {() => void} idempotent disposer
   */
  listenTo(input, opts) {
    if (input == null) { this.unlisten(); return () => {}; }
    if (this._audioStop) { try { this._audioStop(); } catch { /* already gone */ } }
    this._audioStop = null;
    this._audio = { input, opts };

    if (!this._orb) return () => { if (this._audio && this._audio.input === input) this.unlisten(); };

    this._audioStop = this._orb.listenTo(input, opts);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this._audio && this._audio.input === input) this.unlisten();
    };
  }

  /** Detach audio and decay to silence. */
  unlisten() {
    if (this._audioStop) { try { this._audioStop(); } catch { /* already gone */ } }
    this._audioStop = null;
    this._audio = null;
    if (this._orb) this._orb.unlisten();
    return this;
  }

  /** Same as assigning el.state, but chainable. */
  setState(state) { this.state = state; return this; }

  /**
   * Several options at once. Keys map to the properties above, so this is one
   * repaint instead of one per assignment.
   * @param {object} patch
   */
  update(patch = {}) {
    const keys = Object.keys(patch);
    if (!keys.length) return this;
    // Suppress the per-attribute sync, then run one at the end.
    this._batching = true;
    try {
      for (const k of keys) {
        if (k === 'audio') continue;
        this[k] = patch[k];
      }
    } finally {
      this._batching = false;
    }
    this._sync();
    if ('audio' in patch) this.listenTo(patch.audio);
    return this;
  }

  /** Resume animation. */
  play() { this.animate = true; return this; }
  /** Freeze on the current frame. */
  pause() { this.animate = false; return this; }

  /* --- internals ----------------------------------------------------------- */

  /** @private attributeChangedCallback does the rest. */
  _reflect(name, value) {
    if (value == null) this.removeAttribute(name);
    else this.setAttribute(name, String(value));
  }

  /** @private One custom property rather than inline width/height, so page CSS
   * can still override the box without a specificity fight. */
  _applySize() {
    this.style.setProperty('--orb-size', this.size + 'px');
  }

  /** @private */
  _applyAria() {
    const label = this._props.label != null ? this._props.label : this.getAttribute('label');
    if (label) {
      this.removeAttribute('aria-hidden');
      this.setAttribute('role', 'img');
      this.setAttribute('aria-label', String(label));
    } else {
      this.setAttribute('aria-hidden', 'true');
      this.removeAttribute('role');
      this.removeAttribute('aria-label');
    }
  }

  /**
   * @private The page colour bleeding through the glass.
   *
   * The core's own walk up parentElement stops dead at a shadow boundary, so
   * from in here it would always miss and settle for black or white. Do the walk
   * on this side, hopping host to host, and hand the core an explicit colour.
   */
  _autoBackground() {
    try {
      let node = this;
      for (let i = 0; node && i < 64; i++) {
        if (node.nodeType !== 1) break;
        const bg = getComputedStyle(node).backgroundColor;
        const m = bg && bg.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i);
        if (m && (m[4] === undefined || parseFloat(m[4]) > 0.9)) {
          return 'rgb(' + m[1] + ',' + m[2] + ',' + m[3] + ')';
        }
        const root = node.getRootNode ? node.getRootNode() : null;
        node = node.parentElement || (root && root.host) || null;
      }
    } catch { /* detached, or no layout engine */ }
    return 'auto';
  }

  /**
   * @private State as authored, NOT as read back. The state getter rounds a
   * continuous pose to its nearest name once an orb exists, and feeding that
   * back through update() would quantise state="2.5" into 'speaking' on the next
   * unrelated attribute change.
   */
  _stateOption() {
    return this.hasAttribute('state') ? parseState(this.getAttribute('state')) : 'idle';
  }

  /** @private Every option the core needs, read fresh from attributes. */
  _options() {
    const bg = this.background;
    return {
      seed: this.seed,
      size: this.size,
      state: this._stateOption(),
      archetype: this.archetype,
      lens: this.lens,
      background: bg === 'auto' ? this._autoBackground() : bg,
      animate: this.animate,
      palette: this._props.palette == null ? 'auto' : this._props.palette,
      dpr: this._props.dpr == null ? 'auto' : this._props.dpr,
      // The shadow root draws the glass ring; the core must not draw a second
      // one underneath.
      bevel: false,
      ariaLabel: null,
    };
  }

  /** @private The orb, or the CSS sphere if WebGL is unusable. */
  _mount() {
    if (this._orb || this._mounted) return;
    this._applySize();

    if (!isSupported()) { this._paintFallback(); return; }

    const opts = this._options();
    try {
      this._orb = createOrb(this._mountEl, opts);
    } catch (err) {
      // A bad seed cannot throw. A bad palette object, or a context lost at the
      // wrong moment, can. Better a sphere than a hole.
      warn('could not create the orb; falling back to the static sphere');
      try { console.error(err); } catch { /* muted console */ }
      this._orb = null;
      this._paintFallback();
      return;
    }

    this._mounted = true;
    this._sig = signature(opts);
    this._fallback.hidden = true;
    this._fallback.style.background = '';
    this._mountEl.style.display = '';

    if (!this._orb.supported) {
      // Core hit its own fallback. Hide its canvas layer and paint ours, so
      // there is one sphere and one bevel on screen.
      this._paintFallback();
    }
    if (this._props.level) this._orb.level = this._props.level;
    if (this._audio) this._audioStop = this._orb.listenTo(this._audio.input, this._audio.opts);
  }

  /** @private Push current attributes into the live orb. */
  _sync() {
    if (this._batching) return;
    if (!this._orb) {
      // No orb, so keep the static sphere honest about the seed and palette.
      if (this._mountEl && !this._fallback.hidden) this._paintFallback();
      this._applySize();
      return;
    }
    this._applySize();
    const opts = this._options();
    const sig = signature(opts);
    if (sig === this._sig) return;
    this._sig = sig;
    try {
      this._orb.update(opts);
    } catch (err) {
      // Forget the signature so the next change is retried rather than skipped
      // as already applied. A rejected patch must not wedge the element.
      this._sig = '';
      warn('rejected that option patch');
      try { console.error(err); } catch { /* muted console */ }
    }
    if (!this._fallback.hidden) this._paintFallback();
  }

  /**
   * @private The no-WebGL sphere. A radial gradient from this seed's palette, so
   * the identity still reads.
   *
   * Colours are normalised to #rrggbb first. One bad colour anywhere in a
   * gradient makes the browser drop the WHOLE background, which would turn the
   * fallback into the empty hole it exists to prevent. The mid layer also
   * appends an alpha pair, and that only concatenates onto hex.
   */
  _paintFallback() {
    const seedPal = identityForSeed(this.seed).palette;
    const custom = resolvePaletteish(this._props.palette);
    const src = custom || seedPal;
    const anchor = toHex(src.anchor, seedPal.anchor);
    const acc = [0, 1, 2].map((i) => toHex(
      src.accents && src.accents[i], (seedPal.accents && seedPal.accents[i]) || seedPal.anchor));

    const bgRaw = this.background;
    const bg = bgRaw === 'auto' ? this._autoBackground() : bgRaw;
    const base = bg === 'auto' ? 'transparent' : toHex(bg, 'transparent');

    this._fallback.style.background =
      'radial-gradient(58% 58% at 34% 26%, ' + acc[1] + ', transparent 62%),' +
      'radial-gradient(72% 72% at 70% 74%, ' + acc[2] + '55, transparent 60%),' +
      'radial-gradient(closest-side, ' + anchor + ', ' + base + ')';
    // An invalid value leaves the property empty, which is the one outcome this
    // method must never produce.
    if (!this._fallback.style.background) {
      this._fallback.style.background =
        'radial-gradient(closest-side, ' + seedPal.anchor + ', transparent)';
    }
    this._fallback.hidden = false;
    this._mountEl.style.display = 'none';
    this._applySize();
  }
}

/* helpers */

/** palette-ish -> {anchor, accents}, or null for 'auto'. */
function resolvePaletteish(p) {
  if (p && typeof p === 'object' && p.anchor) return p;
  if (typeof p === 'number' && Number.isFinite(p)) return makePalette(p);
  return null;
}

const hex2 = (v) => Math.round(255 * Math.min(1, Math.max(0, v))).toString(16).padStart(2, '0');

/** Any CSS colour -> #rrggbb, or the fallback if it will not parse. */
function toHex(color, fallback) {
  try {
    const rgb = toRGB(color);
    return '#' + hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]);
  } catch { return fallback; }
}

/** Cheap comparison key for an option object. */
function signature(o) {
  try { return JSON.stringify(o); } catch { return String(Math.random()); }
}

/**
 * Replay a property assigned before upgrade. Without this, el.seed = 'x' on a
 * not-yet-defined element writes an own property that shadows the accessor for
 * good.
 */
function upgradeProperty(el, name) {
  if (!Object.prototype.hasOwnProperty.call(el, name)) return;
  const value = el[name];
  delete el[name];
  el[name] = value;
}

/* registration */

/**
 * Idempotent, so several modules can each import this file. A second define()
 * of the same tag throws NotSupportedError and takes the importing module with
 * it.
 *
 * @param {string} [tag] alternative tag name, to dodge a collision
 * @returns {typeof OrbElement|null} the constructor actually registered
 */
function defineOrbElement(tag = TAG) {
  if (typeof customElements === 'undefined' || typeof HTMLElement !== 'function') return null;
  const existing = customElements.get(tag);
  if (existing) return existing;
  try {
    customElements.define(tag, tag === TAG ? OrbElement : class extends OrbElement {});
  } catch (err) {
    // Lost a race with another copy of this module, or the name belongs to
    // something else. Either way, do not break the importing page.
    warn('could not define <' + tag + '>');
    try { console.error(err); } catch { /* muted console */ }
  }
  return customElements.get(tag) || null;
}

defineOrbElement();


  return {
    "TAG": TAG,
    "OrbElement": OrbElement,
    "defineOrbElement": defineOrbElement,
    "default": OrbElement
  };
  })(__orb_core);

  /* ══ the single global ═══════════════════════════════════════════════ */

  // src/orb.js already makes the class its own namespace object; the classic
  // build simply finishes the job with everything both modules export.
  var Orb = __orb_core["default"];
  var ns = {};
  var api = [__orb_core, __orb_element];
  for (var i = 0; i < api.length; i++) {
    for (var k in api[i]) {
      if (!Object.prototype.hasOwnProperty.call(api[i], k)) continue;
      if (k === "default") continue;
      ns[k] = api[i][k];
    }
  }
  ns["Orb"] = Orb;

  // Hang the namespace on the class. `name`, `length` and `prototype` are
  // non-writable on every function, and assigning one throws in strict mode,
  // so they are skipped — the build refuses such an export name anyway.
  var skip = ["name","length","prototype","caller","arguments"];
  for (var key in ns) {
    if (!Object.prototype.hasOwnProperty.call(ns, key)) continue;
    if (skip.indexOf(key) !== -1) continue;
    try { Orb[key] = ns[key]; } catch (e) { /* frozen host, nothing to do */ }
  }

  if (globalScope) globalScope.Orb = Orb;
  return Orb;
})(typeof globalThis !== 'undefined' ? globalThis
  : typeof window !== 'undefined' ? window
  : typeof self !== 'undefined' ? self : this);
