# Orb for Windows

C++17 + Direct3D 11. Windows 10+. Zero third-party dependencies: the HLSL is compiled at runtime
with `d3dcompiler_47` (ships with Windows), audio is WASAPI.

## Build

```bash
cmake -S native/windows -B native/windows/build
cmake --build native/windows/build --config Release
```

Produces `orb.lib`, `orb_conformance.exe` and `orb_example.exe`. Consume from CMake with
`add_subdirectory(native/windows)` and `target_link_libraries(app PRIVATE orb::orb)`, or install
and `find_package(orb)`.

## Three ways in

**1. You already own a D3D11 device** (a game, an engine, an app with its own swap chain):

```cpp
#include <orb/orb.h>

orb::Renderer renderer(device);              // once per device; compiles the shaders
orb::Options o; o.seed = "agent-42"; o.size = 320;
orb::Orb agent(o);

// per frame
agent.tick(nowSeconds);                      // clock + envelopes + spin
orb::Viewport vp{x, y, agent.pixels(dpiScale)};
agent.draw(renderer, context, backBufferRTV, vp, dpiScale, orb::Composite::OverExisting);
```

`Composite::OverExisting` blends the orb (premultiplied) over whatever is already in the target.
`Composite::Transparent` clears to transparent and writes premultiplied coverage, for an offscreen
texture you composite yourself. `Composite::OverBackground` clears to `Options::background` first.

**2. Just a window:**

```cpp
orb::Window win(hwnd, o);                    // device, swap chain, renderer, orb
win.orb().setState(orb::State::Speaking);
win.orb().listen(orb::PCMSource::loopback()); // whatever the machine is playing
// message loop:
bool busy = win.frame();                     // tick, clear, draw, present
if (!busy) MsgWaitForMultipleObjects(0, nullptr, FALSE, 250, QS_ALLINPUT);
```

`examples/win32/main.cpp` is a complete app: keys `1-4` set the state, `S` re-rolls the seed,
`M` microphone, `L` loopback, `V` synthetic, `0` detach, `B` bevel.

**3. No graphics at all:** `orb::Identity` and `orb::Dynamics` are plain math you can run on a
server or in a test.

```cpp
orb::Identity id("agent-42");
id.palette.anchor.hex();   // "#e98c13"
id.archetype;              // orb::Archetype::Deep
id.hash;                   // 166409783, identical to hashSeed() on the web
```

## Audio

```cpp
// The agent's own voice, without touching your playback path:
agent.listen(orb::PCMSource::loopback());     // default render endpoint, WASAPI loopback

// The human speaking:
agent.listen(orb::PCMSource::microphone());   // default capture endpoint

// A voice SDK that hands you PCM:
auto pcm = orb::PCMSource::create();
agent.listen(pcm);
pcm->push(floatSamples, count, channels);     // from any thread
pcm->push(int16Samples, count, channels);

// No audio, but the orb still has to look alive:
agent.listen(orb::AudioSource::synthetic());

// Or drive it by hand:
agent.setLevel(0.4);
```

Sources measure RMS over the last 512 mono samples with a 3.2 gain; the two speech envelopes live
in `orb::Dynamics`. If the orb started a source it stops it on `unlisten()`; a source you started
stays yours.

## Options

Same names and defaults as the web (`orb::Options`): `seed` (UTF-8), `size` (logical px at 96 DPI),
`state` (0..3), `archetype`, `palette`, `background`, `animate`, `lens`, `bevel`,
`respectReducedMotion` (`SPI_GETCLIENTAREAANIMATION`). Bad values throw `std::invalid_argument`
at the call site.

## Tests

```bash
native/windows/build/Release/orb_conformance.exe
```

Pins identity, palettes and the dynamics trajectory to fixtures generated from `src/orb.js`,
compiles the HLSL, and renders one frame offscreen (hardware or WARP) checking coverage inside the
disc, transparency outside it, and that the output is premultiplied.
