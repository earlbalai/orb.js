# Orb for Android

Kotlin + OpenGL ES 2.0. API 21+. The `orb` module has zero dependencies; `orb-compose` adds a
one-line composable on top of it.

## Install

Until it is on Maven Central, use it as a source dependency or a local AAR:

```kotlin
// settings.gradle.kts
includeBuild("path/to/orb.js/native/android")

// app/build.gradle.kts
dependencies {
  implementation("com.earlbalai.orb:orb:1.0.0")
  implementation("com.earlbalai.orb:orb-compose:1.0.0")   // optional
}
```

Or build the AARs: `./gradlew assembleRelease` → `orb/build/outputs/aar/orb-release.aar`.

## Compose

```kotlin
import com.earlbalai.orb.compose.Orb

Orb(
  seed = "agent-42",
  size = 320.dp,
  state = OrbState.THINKING,
  audio = mic,                       // an OrbAudioSource, or null
  background = OrbColor.fromArgb(0xFF0B0B10.toInt()),
)
```

## Views

```kotlin
val orb = OrbView(context)
orb.update(OrbOptions(seed = "agent-42", size = 320.0, state = OrbState.LISTENING))
container.addView(orb)

orb.state = OrbState.SPEAKING           // crossfades over ~350 ms
orb.listen(agentAudio)                  // any OrbAudioSource; returns a disposer
orb.level = 0.4                         // or drive it by hand, 0..1
orb.update { copy(seed = "agent-43", lens = OrbLensChoice.Off) }
orb.pause(); orb.play()
orb.identity.palette.anchor.hex         // "#e98c13"
orb.metrics.spin
```

`OrbView` is a `TextureView`, so it composites with real alpha inside any layout, over a card or
a photo, unlike a `GLSurfaceView`. It owns one EGL context on its own render thread, measures
itself to `size` dp, and sleeps when nothing is changing.

## Audio

```kotlin
// A voice SDK that hands you PCM (LiveKit, WebRTC, your own decoder, the buffer you
// are about to write to an AudioTrack):
val pcm = OrbAudioSource.pcm()
orb.listen(pcm)
pcm.push(shortArray, count, channels = 1)     // 16-bit
pcm.push(floatArray, count, channels = 2)     // float, interleaved
pcm.push(byteBuffer, channels = 1)            // 16-bit LE bytes

// The human speaking. The app must hold RECORD_AUDIO.
orb.listen(OrbAudioSource.microphone())

// No audio, but the orb still has to look alive:
orb.listen(OrbAudioSource.synthetic())
```

Sources measure RMS over the last 512 mono samples with a 3.2 gain; smoothing happens inside the
orb's two speech envelopes. If the orb started a source it stops it on `unlisten()` / detach; a
source you started yourself stays yours.

## Options

Same names and defaults as the web (`OrbOptions`): `seed`, `size`, `state`, `archetype`,
`palette` (`Auto`, `Hue(deg)`, `Custom(OrbPalette)`), `background`, `animate`, `lens` (`Auto`,
`Off`, `On`, `Amplitude(x)`), `bevel`, `respectReducedMotion` (honours a zero animator scale).
Bad values throw `IllegalArgumentException` at the call site.

## Tests

```bash
cd native/android && ./gradlew :orb:testDebugUnitTest
```

`ConformanceTest` pins identity, palettes and the dynamics trajectory to fixtures generated from
`src/orb.js`. The fragment shader's galaxy block (`OrbGalaxyGlsl.kt`) is generated verbatim from
the web module by `node native/conformance/generate.mjs`.
