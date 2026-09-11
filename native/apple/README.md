# OrbKit — Orb for iOS and macOS

Swift + Metal. iOS 15+, macOS 12+. Zero dependencies. The shader is compiled from source at
runtime with precise math, so there is no `.metallib` to ship.

## Install

Swift Package Manager, from this repository:

```swift
.package(url: "https://github.com/earlbalai/orb.js", branch: "main")
// product: "OrbKit", path: native/apple
```

Or in Xcode: File → Add Package Dependencies → this repo → add **OrbKit**. To vendor it, drop
`native/apple` into your project as a local package.

## SwiftUI

```swift
import OrbKit

struct AgentView: View {
  @State var state: OrbState = .idle
  let mic = try? OrbAudioSource.microphone()

  var body: some View {
    Orb(seed: "agent-42", size: 320, state: state)
      .orbAudio(state == .listening ? mic : nil)
      .orbBackground(OrbColor(hex: "#0b0b10")!)
  }
}
```

`state` crossfades over ~350 ms when it changes. The first value applies instantly.

## UIKit / AppKit

```swift
let orb = OrbView(seed: "agent-42", size: 320, state: .listening)
view.addSubview(orb)

orb.state = .speaking                 // crossfades
orb.listen(agentAudio)                // any OrbAudioSource; returns a disposer
orb.level = 0.4                       // or drive it by hand, 0...1
try orb.update { $0.seed = "agent-43"; $0.lens = .off }
orb.pause(); orb.play()
orb.identity.palette.anchor.hex       // "#e98c13"
orb.metrics.spin
```

`OrbView` is a `UIView` / `NSView` hosting an `MTKView` with a transparent layer, so it composites
over anything behind it. It sizes itself to `size` points and pauses its loop when nothing is
changing (`animate: false`, reduced motion, or a settled state with no audio).

## Audio

```swift
// The agent speaking: tap the mixer of the engine playing your TTS.
let tap = OrbAudioSource.tap(engine.mainMixerNode)
orb.listen(tap)

// A voice SDK that hands you PCM (LiveKit, WebRTC, your own decoder):
let pcm = OrbAudioSource.pcm()
orb.listen(pcm)
// from the audio callback, any thread:
pcm.push(buffer)                                  // AVAudioPCMBuffer
pcm.push(floatPointer, channels: 2)               // interleaved float
pcm.push(int16: int16Pointer, channels: 1)

// The human speaking. Needs NSMicrophoneUsageDescription and record permission.
let mic = try OrbAudioSource.microphone()

// No audio at all, but the orb still has to look alive:
orb.listen(.synthetic())
```

Sources measure RMS over the last 512 mono samples with a 3.2 gain; smoothing happens inside
the orb's two speech envelopes, never in the source. If the orb started a source it stops it on
`unlisten()`; a source you started yourself stays yours, so several orbs can share one microphone.

## Options

Same names and defaults as the web (`OrbOptions`): `seed`, `size`, `state`, `archetype`,
`palette` (`.auto`, `.hue(deg)`, `.custom(OrbPalette)`), `background` (no DOM to walk, so tell it
your card colour), `animate`, `lens` (`.auto`, `.off`, `.on`, `.amplitude(x)`), `bevel`,
`respectReducedMotion`. Bad values throw `OrbError.invalid` at the call site.

## Identity without a view

```swift
let id = OrbIdentity(seed: "agent-42")
id.palette.anchor.hex     // "#e98c13"
id.archetype              // .deep
id.hash                   // 166409783, identical to hashSeed() on the web
```

## Tests

```bash
cd native/apple && swift test
```

`ConformanceTests` pins identity, palettes and the dynamics trajectory to fixtures generated from
`src/orb.js` (`node native/conformance/generate.mjs`).
