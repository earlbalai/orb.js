# Orb native SDKs

The same orb, off the web. Four ports of `src/orb.js`, one per platform family, each idiomatic
to its platform and each with **zero third-party dependencies**:

| Platform | SDK | Language / GPU | Package |
| --- | --- | --- | --- |
| iOS 15+, macOS 12+ | [`apple/`](apple/) — **OrbKit** | Swift + Metal | Swift Package (SwiftPM) |
| Android 5.0+ (API 21) | [`android/`](android/) — **orb**, **orb-compose** | Kotlin + OpenGL ES 2.0 | AAR (Maven) |
| Windows 10+ | [`windows/`](windows/) — **orb** | C++17 + Direct3D 11 | static lib (CMake) |

**Same seed, same orb, everywhere.** Identity (hash → palette, archetype, phase), the four-state
dynamics (crossfade, both speech envelopes, the spin integrator) and the galaxy shader are ported
line for line and pinned to the web build by a shared conformance suite. The contract is
[`SPEC.md`](SPEC.md).

```
native/
  SPEC.md              the porting contract every SDK implements
  conformance/         generate.mjs drives the real src/orb.js and emits test fixtures
  apple/               Swift package: OrbView (UIKit/AppKit), Orb (SwiftUI), OrbAudioSource
  android/             Gradle project: OrbView (TextureView), Orb() composable, OrbAudioSource
  windows/             CMake project: orb::Renderer, orb::Orb, orb::Window, orb::PCMSource
```

## What is shared, what is native

| Ported verbatim, tested | Rewritten per platform |
| --- | --- |
| FNV-1a identity, 14 hues, palette math | view hosting, DPI, lifecycle |
| state crossfade, 40/180 ms and 110/300 ms envelopes, spin integrator | render loop, surface, alpha compositing |
| the galaxy + glass shader | shader dialect (MSL / GLSL ES / HLSL) |
| options, defaults, validation rules | audio capture |

The web's instanced batch atlas is not ported: it exists to dodge WebGL's per-page context cap,
and a native view draws straight into its own layer. Every native orb takes the hero path (dual
layer refraction, chromatic lens) at full quality.

Two things the web does in CSS are done in the shader natively: the circular silhouette cut (one
device pixel of anti-aliasing) and the glass bevel ring (`bevel: true`).

## Audio

Every SDK consumes a level in 0…1 sampled once per frame and ships the same set of sources:

| Source | Apple | Android | Windows |
| --- | --- | --- | --- |
| constant / custom `(t) → level` | ✓ | ✓ | ✓ |
| `synthetic()` silent speech envelope | ✓ | ✓ | ✓ |
| push PCM from any voice SDK's audio callback | `OrbPCMSource` | `OrbPCMSource` | `orb::PCMSource` |
| microphone | AVAudioEngine | AudioRecord | WASAPI capture |
| the agent's own playback | `tap(node)` on your AVAudioEngine | push from your `AudioTrack` feed | WASAPI **loopback** (what the machine is playing) |

The two speech envelopes live in the dynamics, so a source hands over raw RMS and nothing else.

## Conformance

```bash
node native/conformance/generate.mjs          # regenerate fixtures from src/orb.js

# Apple
cd native/apple && swift test

# Android
cd native/android && ./gradlew :orb:testDebugUnitTest

# Windows
cmake -S native/windows -B native/windows/build && cmake --build native/windows/build --config Release
native/windows/build/Release/orb_conformance.exe
```

Each suite checks, against fixtures generated from the real `src/orb.js`:

1. 24 seeds (ASCII, Unicode, emoji, long): hash, archetype, hue, palette hex **exactly**.
2. The 14 built-in palettes and custom-hue wrapping.
3. A 10-second dynamics scenario through all four states with the synthetic envelope as input:
   `stateBlend`, `drive`, both envelopes within 1e-4, `spin`/`spinVel` within 2e-3, direction flips exact.
4. Resolution and lens rules, option validation.
5. Windows additionally compiles the HLSL and renders a frame offscreen, checking coverage and
   premultiplication. Android's GLSL is WebGL1's dialect and is generated verbatim from `src/orb.js`.

When `src/orb.js` changes, re-run the generator and make all three suites green again.
