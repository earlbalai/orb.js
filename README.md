# Orb.js

An audio-reactive procedural galaxy sealed in a glass sphere. A body for the voice of an AI agent.

Inspired by the agent orb on [x.ai](https://x.ai). The rendering approach is theirs; this is an
independent implementation of it, not affiliated with or endorsed by xAI. See [Credits](#credits).

One ES module. No dependencies, no npm package, no bundler, no build step, no CDN, no CSS file to
include. It draws in WebGL1 (GLSL ES 1.00), composites with real premultiplied alpha so it reads as
glass on any ground, and it is deterministic in a seed string: the same agent id always produces the
same orb.

There is no geometry in it. Every orb is a single four-vertex `TRIANGLE_STRIP` and the sphere is
solved analytically inside the fragment shader.

```
src/orb.js      the whole product
index.html      landing page + live playground
examples/       five runnable integrations
native/         the same orb for iOS, macOS, Android and Windows
```

## Quick start

Copy `src/orb.js` next to your page and serve it over http(s). That is the install.

> **It has to be served.** `orb.js` is a real ES module and a `file://` document has an opaque
> origin. Engines fetch `<script type="module">` with CORS, which an opaque origin can never
> satisfy, so the import is refused before any of your code runs. Browser rule, not something a
> library can work around. `python -m http.server 8000` is enough.

### 1. Script / ESM

```html
<div id="orb"></div>

<script type="module">
  import { createOrb } from './orb.js';

  const orb = createOrb(document.getElementById('orb'), {
    seed: 'agent-42',      // hue, archetype, structure, spin
    size: 320,             // css px, square
    state: 'idle',         // idle | listening | thinking | speaking
    background: 'auto',    // transmits whatever is behind it
  });

  // Anything your voice stack hands you.
  const stop = orb.listenTo(agentStream);

  orb.state = 'speaking';  // crossfades over ~350ms

  stop();                  // detach the audio
  orb.destroy();           // and everything else
</script>
```

The module also publishes `globalThis.Orb`, so once it has loaded, classic (non-module) scripts on
the same page can reach the whole API without an import.

### 2. `<orb-js>` custom element

Orb ships no custom element of its own. Claiming a global tag name is the page's decision, not a
library's. This is the whole wrapper:

```html
<orb-js seed="agent-42" size="320" state="thinking"></orb-js>

<script type="module">
import { Orb } from './orb.js';

customElements.define('orb-js', class extends HTMLElement {
  static observedAttributes = ['seed', 'size', 'state', 'archetype', 'lens'];

  opts() {
    const a = (n, d) => this.getAttribute(n) ?? d;
    return {
      seed:      a('seed', ''),
      size:      +a('size', 320),
      state:     a('state', 'idle'),
      archetype: a('archetype', 'auto'),
      lens:      this.hasAttribute('lens') ? +a('lens') : undefined,
    };
  }
  connectedCallback()       { this.orb ??= Orb.mount(this, this.opts()); }
  attributeChangedCallback() { this.orb?.update(this.opts()); }
  disconnectedCallback()    { this.orb?.destroy(); this.orb = null; }

  // property, so frameworks can pass a live MediaStream straight in
  set audio(src) { this._stop?.(); this._stop = this.orb?.listenTo(src); }
});
</script>
```

### 3. React

```jsx
// Orb.jsx, no wrapper package, no npm dependency. Just the module.
import { useEffect, useRef } from 'react';
import { Orb } from './orb.js';

export function Orb({ seed, size = 320, state = 'idle', audio }) {
  const host = useRef(null);
  const orb  = useRef(null);

  useEffect(() => {
    orb.current = Orb.mount(host.current, { seed, size, state });
    return () => { orb.current.destroy(); orb.current = null; };
  }, []);                                      // mount once

  useEffect(() => { orb.current?.update({ seed, size }); }, [seed, size]);
  useEffect(() => { orb.current?.setState(state); }, [state]);

  // listenTo returns its own disposer, which is what an effect wants back
  useEffect(() => audio ? orb.current?.listenTo(audio) : undefined, [audio]);

  return <div ref={host} />;
}
```

## The four states

A voice agent has four things it can be doing, and the orb shows all four without a caption.

| State | What it looks like |
| --- | --- |
| `idle` | Slow drift, dim aurora, low spin. The palette at rest. |
| `listening` | A cool, attentive cast. The rim ignites with the human's level. |
| `thinking` | No sound at all, but visibly working: spin roughly triples, a bead of light orbits the core, an inner pulse breathes, a second meteor stream quickens the sky. |
| `speaking` | Full reactivity from the agent's own audio, and the aurora blooms. |

```js
orb.state = 'thinking';   // or orb.setState('thinking'), same thing, chainable
```

The four are one smoothed scalar rather than four separate looks, and the order above is the
conversational loop. Ordinary transitions are between adjacent states and never pass through a
third look. The two non-adjacent jumps (`speaking → idle` at hang-up, `idle → speaking` when the
agent opens the call) sweep the axis in ~350 ms, which reads as a wind-down and a wind-up rather
than a glitch.

Writing the state the orb is already in is free, so it is safe to call on every event your voice SDK
emits. Numbers work too: `state: 2.5` is a legitimate half-thinking, half-speaking pose.

The state set at **mount** applies instantly, every change after that crossfades. An agent that
boots in `listening` should not spend 350 ms looking idle.

## Audio

`orb.listenTo(input)` takes whatever your stack hands you and works out the rest. It returns a
disposer. Idempotent, and it tears down only what that call created, so other orbs sharing the same
source keep listening.

| Input | Source | Typical origin |
| --- | --- | --- |
| `MediaStream` | `OrbAudioSource.fromStream(stream, opts)` | WebRTC inbound audio (OpenAI Realtime, LiveKit, Vapi, Daily) or `getUserMedia` |
| `MediaStreamTrack` | `OrbAudioSource.fromTrack(track, opts)` | the shape most SDKs actually surface |
| `HTMLAudioElement` / `<video>` | `OrbAudioSource.fromMedia(el, opts)` | TTS playback |
| `AnalyserNode` | `OrbAudioSource.fromAnalyser(node, opts)` | you already have a graph, Orb only reads it |
| any `AudioNode` | `OrbAudioSource.fromNode(node, opts)` | a gain, a destination tap |
| `'microphone'` | `OrbAudioSource.microphone(opts)` → `Promise` | the human speaking. Call from a user gesture |
| `'speech'` | `OrbAudioSource.speech(opts)` | **audible** synthesised babble, routed to the destination and an analyser |
| `'synthetic'` | `OrbAudioSource.synthetic()` | silent level-only envelope. No permission, no AudioContext |
| `(t) => 0..1` | `OrbAudioSource.custom(fn)` | a game engine, a websocket, a slider |
| `number` | | a constant level, for a quick poke |
| `OrbAudioSource` | | one you built, shared across several orbs |
| `null` | | detach |

```js
const stop = orb.listenTo(agentStream);   // the agent speaking
const stop = orb.listenTo('microphone');  // the human speaking
orb.level = 0.4;                          // or drive it by hand, 0..1
```

**Ownership.** If a source was not already started, the orb starts it and stops it again on
`unlisten()` or `destroy()`. If you started it yourself it is yours, and Orb leaves it running.
That is what you want when five orbs share one microphone.

```js
const mic = await OrbAudioSource.microphone();
mic.start();                          // now it is yours
for (const orb of orbs) orb.listen(mic);
```

**Autoplay.** Browsers start every AudioContext suspended, and an analyser on a suspended context
reads exactly zero: a silent, symptomless dead orb sitting next to audible speech. Orb arms a
one-shot passive listener on the first user gesture of any kind and resumes there. `resumeAudio()`
lets you do it explicitly from your own click handler.

`fromMedia()` degrades on purpose. If an element's audio cannot be analysed (a cross-origin stream
with no CORS headers, where the Web Audio graph returns silence and permanently mutes the element)
it falls back to a synthetic envelope gated on playback and reports `source.kind === 'synthetic'`.
A dead orb next to audible speech looks broken. This does not.

## API

### Factories

| Call | Returns |
| --- | --- |
| `createOrb(container, options)` | a new `Orb` mounted inside `container` |
| `Orb.mount(container, options)` | identical, pick whichever reads better at your call site |
| `new Orb(container, options)` | same again. `Orb` is also the default export |

### Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `seed` | any | `''` | Identity, coerced to a string. Sets palette, archetype, galaxy structure, meteor cadence and starting spin. |
| `size` | number | `320` | CSS pixels, square. |
| `state` | `'idle' \| 'listening' \| 'thinking' \| 'speaking' \| number` | `'idle'` | Instant at mount, crossfades (~350 ms) afterwards. |
| `archetype` | `'spiral' \| 'nebula' \| 'core' \| 'deep' \| 'auto'` | `'auto'` | `'auto'` derives it from the seed. |
| `palette` | object \| number \| `'auto'` | `'auto'` | A `{anchor, accents:[a,b,c]}` object, a hue in degrees, or seed-derived. |
| `background` | CSS colour \| `'auto'` | `'auto'` | The page colour transmitted through the glass. `'auto'` walks up the DOM for the nearest opaque background. |
| `animate` | boolean | `true` | `false` freezes on the current frame. |
| `dpr` | `'auto' \| 'full' \| number` | `'auto'` | `'auto'` is 1x below 48 px, capped device ratio above. Hard ceiling 2x. |
| `lens` | boolean \| number | *(auto)* | Chromatic rim lens. On at or above 48 px, amplitude tapered by resolution. A number opts out of the taper. |
| `bevel` | boolean | `true` | The inset glass highlight ring. |
| `respectReducedMotion` | boolean | `true` | Renders one static frame under `prefers-reduced-motion`. |
| `ariaLabel` | string | `null` | Set it and the orb is exposed to assistive tech, otherwise it is `aria-hidden`. |

Every value is validated at the boundary, so a mistake throws synchronously with the option named,
rather than one frame later inside a GL uniform upload.

### Instance

| Member | Type | Notes |
| --- | --- | --- |
| `.state` | get / set | Reads back the nearest named state. Setting crossfades. Setting the current state is free. |
| `.level` | get / set | Raw 0..1 amplitude. Non-finite input becomes 0 rather than propagating. |
| `.seed` | get / set | Re-rolls the identity while the orb keeps turning. It morphs, it does not restart. |
| `.size` | get / set | CSS pixels. |
| `.setState(s)` | `→ this` | Chainable `.state`, usable as a callback. |
| `.update(patch)` | `→ this` | Partial option patch. Anything omitted keeps its value. |
| `.setSeed / setSize / setArchetype / setPalette / setBackground / setLens` | `→ this` | Convenience setters, all forward to `update()`. |
| `.listenTo(input, opts)` | `→ () => void` | The agent-audio entry point. Returns a disposer synchronously, even for `'microphone'`. |
| `.listen(source)` | `→ () => void` | Bind an `OrbAudioSource` directly. Several orbs may share one. |
| `.unlisten()` | `→ this` | Detach and decay to silence. |
| `.setAudioLevel(v)` | `→ this` | Same as `.level = v`. |
| `.play()` / `.pause()` | `→ this` | Resume / freeze. |
| `.renderNow()` | `→ boolean` | One frame outside the loop, advancing the clock by real elapsed time. |
| `.destroy()` | `→ void` | Idempotent. Leaves the loop, drops the DOM, stops a source it owns. |
| `.identity` | get | `{hash, seed, palette, archetype, phase, spin, timeOffset}` |
| `.metrics` | get | `{level, drive, fast, slow, spin, spinVel, direction, time, px, state, stateBlend, stateWeights}` |
| `.palette` | get | The palette actually in use. |
| `.options` | get | Resolved options, as a snapshot. |
| `.supported` | boolean | `false` when there is no usable WebGL and the seeded static fallback is showing. |

### Module

| Export | Purpose |
| --- | --- |
| `Orb` | the class. Also the default export, and the namespace for everything below |
| `createOrb(el, opts)` | mount an orb |
| `OrbAudioSource` | every audio factory (see the table above) |
| `createAudioSource(input, opts)` | pick the right source for whatever you have, without binding it |
| `resumeAudio()` / `audioReady()` / `closeAudio()` | the shared AudioContext, one per page |
| `identityForSeed(seed)` | everything a seed determines, without mounting anything |
| `hashSeed(seed)` | FNV-1a, 32-bit, stable across engines |
| `makePalette(hue)` / `PALETTES` / `HUES` | the fourteen identity palettes, and how to build your own |
| `toRGB(colour)` | `#rgb`, `#rrggbb` or any CSS colour to a 0..1 triple |
| `STATES` / `ARCHETYPES` | `['idle','listening','thinking','speaking']`, `['spiral','nebula','core','deep']` |
| `isSupported()` | probes WebGL and fragment precision before the first orb exists |
| `diagnostics()` | live renderer state: orbs, sources, batched, draw calls, fps, context loss |
| `setBatching(on)` | force every orb through the hero program, for A/B measurement and driver escape hatches |
| `resetCounters()` | zero the per-frame draw-call counters |
| `dispose()` | destroy everything and release both GL contexts and the AudioContext |
| `loseContextForTesting(ms)` | force a context loss to exercise the recovery path |
| `version` | `'1.0.0'` |

All of it is reachable from the class too (`Orb.AudioSource.fromStream(s)`, `Orb.diagnostics()`),
so there is one name to import and no second kit object shadowing the thing it wraps.

## Examples

Runnable, self-contained, served from the same static server as everything else.

| File | What it shows |
| --- | --- |
| [`examples/microphone.html`](examples/microphone.html) | the human speaking: `getUserMedia`, permission handling, the envelopes on a meter |
| [`examples/tts-playback.html`](examples/tts-playback.html) | an `<audio>` element of synthesised speech driving the orb, with the cross-origin fallback shown honestly |
| [`examples/openai-realtime.html`](examples/openai-realtime.html) | a WebRTC inbound `MediaStream` from a realtime voice API, mapped onto the four states |
| [`examples/livekit.html`](examples/livekit.html) | the same, through a room SDK's track subscription |
| [`examples/agent-roster.html`](examples/agent-roster.html) | many small orbs, distinct seeds, live states. The instanced-atlas path |

`index.html` is the landing page and the full playground: seed, archetype, size, chromatic lens, all
four states, an audible synthetic voice, the microphone, and the same orb rendered over a white card
and a black one at once.

## Native SDKs

The web module is the reference, but the orb is not only web. [`native/`](native/) has the same
orb for **iOS and macOS** (Swift + Metal, `OrbKit`), **Android** (Kotlin + OpenGL ES, plus a
Compose wrapper) and **Windows** (C++ + Direct3D 11), each idiomatic to its platform and each
with zero third-party dependencies.

```swift
Orb(seed: "agent-42", state: .thinking).orbAudio(mic)        // SwiftUI
```
```kotlin
Orb(seed = "agent-42", state = OrbState.THINKING, audio = mic) // Compose
```
```cpp
orb::Orb agent({.seed = "agent-42"});  agent.listen(orb::PCMSource::loopback());  // C++
```

Identity, the four-state dynamics and the galaxy shader are ported line for line and pinned to
this module by a shared conformance suite, so `agent-42` is the same orb in a browser, on a phone
and in a desktop app. The contract is [`native/SPEC.md`](native/SPEC.md).

## How it works

**Analytic sphere.** No sphere mesh. Over a four-vertex quad, `rr = min(r, 0.9995)` and
`z = sqrt(1 - rr*rr)` give the near hemisphere exactly, and `N = vec3(p.x, p.y, z)` is its surface
normal for free. Lighting, fresnel and refraction all fall out of that one normal.

**Dual-layer refraction.** `refract(I, N, 0.75)` enters the glass, and for a unit sphere the chord
to the far wall is exactly `-2 * dot(N, R)`, so the galaxy gets sampled a second time where the ray
exits, at the cost of one dot product rather than a ray march. Both layers ride the same rotating
sphere, so the back counter-slides in true perspective. That second sample is what sells "glass
ball" over "circle with a texture on it".

**Chromatic rim lens.** Near the silhouette the whole shading function is re-evaluated three times
at per-channel displaced coordinates, with an erf falloff hand-expanded from
`(e^2x - 1) / (e^2x + 1)` because GLSL ES 1.00 has no `tanh`. Its amplitude is tapered above a
reference resolution: at very high device-pixel counts a star's diffraction spike would otherwise
land in three visibly separate places and read as RGB confetti instead of sparkle.

**Real alpha.** The context is `{alpha: true, premultipliedAlpha: true}` and the page colour is a
uniform, so the sphere transmits its ground instead of carrying a baked-in one. It reads as glass on
a white card and a black one without touching a setting. The shader deliberately renders past
`r = 1` so the lens always has real pixels to displace. The true circular silhouette is cut
afterwards in CSS, with `clip-path` plus a half-pixel radial mask that removes the aliased ring
`clip-path` alone leaves behind.

**Asymmetric envelopes.** Time-domain RMS, loudness rather than a spectrum sum, because a speech
onset shows up in RMS a frame or two before it shows up in any band. It runs into two envelopes with
asymmetric attack and release: fast (40 ms / 180 ms) drives motion, slow (110 ms / 300 ms) drives
colour. The positive derivative of the fast envelope adds directly into a spin *integrator*, so a
consonant makes the ball lurch while a phrase makes it swim. Direction reversals are queued on an
oscillator zero-crossing and commit only while the room is quiet, so the orb never reverses
mid-syllable.

**One context, one loop.** One WebGL context for the page, never one per orb, which would hit the
browser's ~16-context cap on any list. Orbs at or below 128 device pixels with the lens off ride an
instanced atlas, so a whole roster is a single `drawArraysInstancedANGLE`. There is exactly one copy
of the galaxy code in the file, compiled into both the hero and batch programs, so the cheap path
and the expensive path cannot drift apart. The loop self-terminates when nothing is changing, stops
on tab hide, skips offscreen orbs via `IntersectionObserver`, and releases both GPU surfaces after
ten idle seconds.

## Browser support

Any browser with WebGL1 and `highp` fragment precision: Chrome, Edge, Firefox, Safari 15+, and their
mobile equivalents. Audio needs Web Audio. `getUserMedia` additionally needs a secure context
(`https://` or `localhost`).

Where WebGL is missing or fragment precision is unusable, every orb paints a **seeded static
gradient** built from its own palette and reports `orb.supported === false`. The identity still
reads, only the motion is gone. A transparent hole is the worst possible answer, so it is never the
one you get.

`prefers-reduced-motion: reduce` renders exactly one static frame and never starts the render loop.
State changes still repaint.

## Credits

The idea and the rendering approach come from **xAI's agent orb** on [x.ai](https://x.ai): the
analytic sphere, the dual-layer refraction through the glass, and the per-channel chromatic rim
lens are all theirs. I worked out how it was done and rebuilt it from scratch.

This is an independent implementation, not a copy of their code, and it is not affiliated with or
endorsed by xAI. If you use Orb.js, the MIT licence asks you to keep the copyright notice; crediting
xAI for the original idea is the decent thing to do on top of that.

## License

MIT © Earl Balai.
