# Orb native porting spec

`src/orb.js` is the reference implementation. This document is the contract every native SDK
(`native/apple`, `native/android`, `native/windows`) implements, so that **the same seed produces
the same orb on every platform**, and so the four ports cannot drift apart silently.

The web module is the source of truth. When the reference changes, re-run

```bash
node native/conformance/generate.mjs
```

and make every port's conformance test pass again.

## 1. What is portable, what is not

| Portable (ported verbatim, tested) | Platform-specific (rewritten per port) |
| --- | --- |
| Identity: FNV-1a hash, 14 hues, palette math, phase / spin / timeOffset | View hosting, DPI, lifecycle, visibility, reduced-motion query |
| Dynamics: state crossfade, two envelopes, spin integrator, direction flips | Render loop, surface / swap chain, alpha compositing |
| The galaxy shader (`GLSL_GALAXY` + hero `main()`) | Shader dialect: MSL / GLSL ES / HLSL |
| Uniform semantics and the fullscreen quad | Audio capture and RMS sampling |
| Options and their validation rules | Public API idiom (Swift / Kotlin / C++) |

The instanced **batch atlas** is *not* ported. It exists to dodge WebGL's per-page context cap and
the cost of many `<canvas>` elements; native views draw straight into their own layer, so every
native orb takes the hero path. The `lens` and `dualLayer` behaviour is unchanged.

## 2. Identity

```
hash        = FNV-1a 32-bit over the seed's UTF-16 code units (JS charCodeAt)
                h = 0x811c9dc5; for each unit: h ^= unit; h = (h * 0x01000193) mod 2^32
phase       = (hash mod 6283) / 1000                      seconds, 0 .. 6.282
spin        = phase * 3.7                                 initial spin angle, radians
timeOffset  = ((hash >> 8) mod 40009) / 100               initial clock, seconds
palette     = PALETTES[hash mod 14]
archetype   = ARCHETYPES[(hash >> 16) mod 4]              ['spiral','nebula','core','deep']
```

Seeds are strings. A port must hash **UTF-16 code units**, not bytes and not code points:
`'🪐'` is two units (`0xD83E 0xDEB0`). Swift: `seed.utf16`. Kotlin: `String.get(i).code`.
C++: convert UTF-8 → UTF-16 first (`orb::hashSeed` does).

### Palette

```
HUES = [13, 34, 125, 146, 166, 187, 208, 228, 249, 270, 290, 311, 332, 353]

hsl(h, s, l) -> rgb in 0..1:     a = s * min(l, 1 - l)
                                 f(n) = l - a * max(-1, min(k - 3, 9 - k, 1)),  k = (n + h/30) mod 12
                                 rgb = (f(0), f(8), f(4))
hueLuma(h)  = 0.299 r + 0.587 g + 0.114 b   of hsl(h, 1, 0.5)

makePalette(hue):
  h = ((hue mod 360) + 360) mod 360          (non-finite hue -> 0)
  k = 0.2 * (1 - hueLuma(h))
  anchor  = hsl(h,        0.85, 0.42 + k)
  accents = hsl(h,        0.95, min(0.72, 0.60 + k))
            hsl(h + 16,   0.80, min(0.82, 0.70 + k))
            hsl(h + 34,   0.90, min(0.90, 0.80 + k))
```

Every channel is **quantised to 8 bits** (`round(255 * v) / 255`, round-half-up) because the
reference goes through `#rrggbb` hex. Ports must quantise too, or accent colours differ in the
third decimal and the conformance test fails on the hex strings.

## 3. Dynamics (`advanceDynamics`)

State per orb:

```
level, drive, audioSlow, audioFast, spin, spinVel, spinDir (+1/-1), prevFast,
flipQueued, oscSign, lastT (null at mount and after re-seed),
state (target, 0..3 continuous), stateBlend (what the shader sees), stateW[4]
```

Per frame, with `t` = the orb's clock in seconds (starts at `timeOffset`, advances by
`clamp(wallDt, 0, 0.1)`):

```
dt         = lastT == null ? 0 : clamp(t - lastT, 0, 0.1);  lastT = t
level      = finite ? clamp01(level) : 0
target     = clamp(state, 0, 3)
stateBlend += (target - stateBlend) * lerp(dt, 0.12);  snap when |diff| < 0.002
w_i        = 1 - smoothstep(0.35, 1.0, |stateBlend - i|),  i = 0..3, then normalised (sum >= 1e-4)

gate       = 0.22 w0 + w1 + w3                              (thinking is deaf)
cognition  = 0.34 + 0.30 sin(3.2 t + 3 phase) * (0.55 + 0.45 sin(1.17 t + phase))
drive      = clamp01(level * gate + w2 * cognition)

audioSlow += (drive - audioSlow) * lerp(dt, drive > audioSlow ? 0.11 : 0.30)
audioFast += (drive - audioFast) * lerp(dt, drive > audioFast ? 0.04 : 0.18)
v = audioFast

a = frac(6.31 phase);  b = frac(2.17 phase)
breathe    = 0.35 sin(t (0.11 + 0.08 b) + phase)
osc        = sin(t (0.45 + 0.2 a) + phase);  sign = sign(osc) or +1 if zero
if sign != oscSign: oscSign = sign; flipQueued = true
if flipQueued and v < 0.18: spinDir = -spinDir; flipQueued = false

spinScale  = 0.55 w0 + 0.85 w1 + 1.95 w2 + 1.15 w3
audioSpin  = spinDir * v * 2.2 * (w0 + w1 + w3) + v * 1.3 * w2
target     = 0.65 (0.65 + 0.7 a) (1 + breathe) spinScale + audioSpin
spinVel   += (target - spinVel) * lerp(dt, 0.35)

onset      = max(0, v - prevFast);  prevFast = v;  onsetRate = dt > 0 ? onset / dt : 0
kickDir    = spinDir (w0 + w1 + w3) + w2
spinVel   += kickDir * min(6 * onsetRate / 60, 1.4) * 14 * dt
spin      += spinVel * dt

lerp(dt, tau) = dt > 0 ? 1 - exp(-dt / tau) : 0
smoothstep(e0, e1, x) = GLSL's, exactly
```

If `spin` or `spinVel` goes non-finite, reset spin/spinVel/audioFast/audioSlow/prevFast to 0 and
`stateBlend = target`.

**Mount semantics.** The state given at construction applies instantly (`stateBlend = state`).
Every later change crossfades. Changing the seed sets `phase`, `timeOffset` → clock,
`lastT = null`, and sets `spin = identity.spin` only if `spin == 0`.

## 4. Shader contract

One fullscreen quad, `TRIANGLE_STRIP`, 4 vertices `(x, y, u, v)`:

```
(-1,-1, 0,1)  (1,-1, 1,1)  (-1,1, 0,0)  (1,1, 1,0)
```

`v = 1` at NDC `y = -1` (screen bottom). In the fragment shader `p = uv * 2 - 1`, so **`p.y = +1 is
the bottom of the orb** and `-N.y` is up. Metal and D3D both have NDC `y` up, so the same quad data
is correct everywhere. Get this wrong and the aurora hangs upside down.

Uniforms (hero program):

| Name | Type | Value |
| --- | --- | --- |
| `uRes` | vec2 | rendered size in device px, `(px, px)` |
| `uBg` | vec3 | background colour transmitted through the glass, 0..1 |
| `uAnchor` | vec3 | palette anchor |
| `uC0 uC1 uC2` | vec3 | palette accents |
| `uTime` | float | orb clock, seconds (starts at `timeOffset`) |
| `uPhase` | float | identity phase |
| `uAudio` | float | **`audioSlow`**, not level and not `audioFast` |
| `uSpin` | float | integrated spin angle |
| `uArch` | float | archetype index 0..3. **`auto` resolves on the CPU to `identity.archetype`**; never pass `-1` for auto — the shader's phase-derived fallback picks a different archetype for the same seed |
| `uLens` | float | chromatic lens amplitude; `0` = off |
| `uState` | float | **`stateBlend`**, the eased scalar |
| `uBevel` | float | native only: 1 draws the glass bevel ring in-shader, 0 skips it |

Output is **premultiplied alpha** `(rgb * a, a)` and the surface must composite premultiplied.

Native additions to `main()` (the web does these in CSS, native has no CSS):

* **Circular cut**: after the lens, `cov = clamp((1 - r) * uRes.y * 0.5 + 0.5, 0, 1)` and multiply
  the whole premultiplied output by `cov`. One device pixel of anti-aliasing at the silhouette.
* **Bevel** (`uBevel > 0`): white inset ring approximating the CSS
  `inset 0 1px 1px .7 / inset 0 -1px 1px .45 / inset 0 0 0 1px .22 / inset 0 0 6% .18`
  at 35% opacity. Additive, premultiplied.

Resolution rules (`size` in points/dp, `scale` = device pixel ratio):

```
dpr  = size >= 48 ? min(2, scale) : 1
px   = clamp(round(size * dpr), 8, 1280)
lens = size >= 48 ? 0.4 * clamp(420 / px, 0.55, 1) : 0        (unless overridden)
```

Dialect notes:

| GLSL ES 1.00 | MSL | HLSL |
| --- | --- | --- |
| `vec2/3/4` | `float2/3/4` | `float2/3/4` |
| `fract` | `fract` | `frac` |
| `mix` | `mix` | `lerp` |
| `atan(y, x)` | `atan2(y, x)` | `atan2(y, x)` |
| `discard` | `discard_fragment()` | `discard` |
| `refract(I, N, eta)` | `refract` | `refract` |
| `highp float` | `float` | `float` |

`h1(x) = fract(sin(x * 127.1) * 43758.5453)` needs 32-bit float. Never use half precision.

## 5. Audio

The orb consumes a **level in 0..1 sampled once per frame**. How a port obtains it is its own
business, but the reference measurement is:

```
RMS over the most recent 512 mono samples, x in -1..1
level = min(1, gain * sqrt(mean(x^2)))       gain default 3.2
```

with **no smoothing before the orb**: both envelopes live in `advanceDynamics`.

Every port ships at minimum: constant level, custom `(t) -> level` function, the synthetic
envelope below (silent, no permissions), a push-based PCM source (integrators feed it from any
voice SDK's audio callback), and the microphone.

```
synthetic(t) = phrase * syllable * breath
  phrase   = 0.55 + 0.45 sin(0.9 t + 2 sin(0.37 t))
  syllable = 0.60 + 0.40 sin(6.2 t + 3 sin(2.3 t))
  breath   = sin(0.7 t + 1.7) > -0.6 ? 1 : 0.12
```

## 6. Options and validation

Same names, same defaults, same rules as the README's options table. Invalid values fail at the
call site (throw / `IllegalArgumentException` / `std::invalid_argument`), never one frame later.

| Option | Default | Notes |
| --- | --- | --- |
| `seed` | `""` | any string |
| `size` | `320` | points / dp, square, `>= 8` |
| `state` | `idle` | enum or continuous `0..3` |
| `archetype` | `auto` | `auto` → `uArch = identity.archetype` index (hash-derived, §2) |
| `palette` | `auto` | `auto`, a hue in degrees, or `{anchor, accents[3]}` |
| `background` | platform default | colour transmitted through the glass; no DOM to walk, so ports default to black and expose a setter |
| `animate` | `true` | `false` freezes on the current frame; state changes still repaint |
| `lens` | auto | `true/false` or a number `>= 0` |
| `bevel` | `true` | |
| `respectReducedMotion` | `true` | one static frame under the OS reduced-motion setting |

## 7. Conformance

`native/conformance/generate.mjs` emits `vectors.json` plus a fixture file per port. Each port
has a unit test that:

1. For every identity vector: `hash`, `archetypeIndex`, `hue`, palette hex strings **exactly**;
   `phase`, `spin`, `timeOffset` within 1e-9.
2. For the 14 built-in palettes and the custom-hue cases: hex strings exactly.
3. Runs the dynamics scenario (fixed `dt = 1/60`, 600 steps, the synthetic level, the state
   schedule idle → listening → thinking → speaking → idle) and matches the sampled trajectory:
   `stateBlend`, `drive`, `audioSlow`, `audioFast` within 1e-4 abs; `spin`, `spinVel` within
   2e-3 abs; `spinDir` exactly.

Tolerances exist only because `sin`/`exp` differ by an ulp across libm implementations.
