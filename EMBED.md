# Orb, embed guide

An audio-reactive orb for AI voice agents. One tag, no install, no build step. The files are
hosted, you point at a URL.

## 1. The 10-second version

```html
<script type="module" src="https://xyorb.vidome.app/v1/element.js"></script>

<orb-js seed="agent-7" size="160"></orb-js>
```

That is the whole integration. The `seed` string decides the orb's colour, galaxy
archetype and structure, deterministically and forever: the same seed is always the
same orb, on every device.

Drive it from anywhere:

```js
const orb = document.querySelector('orb-js');

orb.state = 'listening';        // idle | listening | thinking | speaking
orb.listenTo(remoteStream);     // a WebRTC MediaStream from your agent
```

## 2. The module version (modern stacks)

```js
import { createOrb } from 'https://xyorb.vidome.app/v1/orb.js';

const orb = createOrb(document.querySelector('#orb'), {
  seed: 'agent-7',
  size: 160,
  state: 'idle',
});

const stop = orb.listenTo(agentStream);
orb.state = 'speaking';

stop();          // detach the audio
orb.destroy();   // and everything else
```

Bundler users can import the same URL, or copy the file into their own assets. It is a
plain ES module with no dependencies.

Also served under the same path: `element.js` (the custom element, imports `./orb.js`
relatively) and `react.js` (a React wrapper that never imports React itself, you pass
yours in).

## 3. The classic / global version (GTM, no-code, plain scripts)

No `type="module"`, no import, nothing to configure:

```html
<script src="https://xyorb.vidome.app/v1/orb.global.js"></script>
<div id="orb"></div>
<script>
  var orb = window.Orb.createOrb(document.getElementById('orb'), {
    seed: 'agent-7',
    size: 160
  });
  orb.state = 'listening';
</script>
```

`window.Orb.mount(el, options)` is the same call under another name. The global also
carries `Orb.isSupported()`, `Orb.identityForSeed()`, `Orb.createAudioSource()`,
`Orb.AudioSource`, `Orb.resumeAudio()`, `Orb.STATES`, `Orb.ARCHETYPES` and
`Orb.diagnostics()`.

## 4. `<orb-js>` attributes

Every attribute reflects to a like-named JS property, so HTML, JS and devtools all drive
the same thing.

| Attribute | Values | Default | What it does |
|---|---|---|---|
| `seed` | any string | `""` | Identity. Palette, archetype, galaxy structure, meteor cadence and starting spin all derive from it. |
| `size` | positive number (CSS px) | `320` | Square edge. |
| `state` | `idle` \| `listening` \| `thinking` \| `speaking`, or a number `0`–`3` | `idle` | The agent state. Changes crossfade over ~350 ms. Numbers are legal, `2.5` is a continuous pose between thinking and speaking. |
| `archetype` | `spiral` \| `nebula` \| `core` \| `deep` \| `auto` | `auto` | Overrides the seed-derived galaxy type. |
| `lens` | number ≥ 0, `on`/`off`/`true`/`false`, or `auto` | `auto` | Chromatic rim lens strength. Auto turns it on at 48px and up. |
| `background` | any CSS colour, or `auto` | `auto` | The page colour bleeding through the glass. `auto` reads it from the DOM (it walks out through shadow roots). Set it explicitly over a gradient or an image. |
| `animate` | boolean-ish, absent means animating | on | `animate="false"` freezes the current frame. |

Properties beyond the attributes (set them in JS, they have no sensible string form):
`palette`, `dpr`, `level`, `label`.

Read-only: `orb` (the underlying instance), `identity`, `metrics`, `supported`.

Methods: `listenTo(input, opts)`, `unlisten()`, `setState(s)`, `update(patch)`,
`play()`, `pause()`.

```js
orb.label = 'Support agent';   // exposes it to screen readers; otherwise aria-hidden
orb.level = 0.4;               // drive amplitude by hand, 0..1
orb.update({ seed: 'agent-8', size: 220, state: 'thinking' });   // one repaint
```

## 5. `createOrb(container, options)`

| Option | Values | Default | What it does |
|---|---|---|---|
| `seed` | any value, coerced to a string | `''` | Identity, as above. |
| `size` | number (CSS px) | `320` | Square edge. |
| `state` | `idle` \| `listening` \| `thinking` \| `speaking` \| number | `idle` | Applied instantly at mount, crossfaded afterwards. |
| `archetype` | `spiral` \| `nebula` \| `core` \| `deep` \| `auto` | `auto` | Galaxy type. |
| `palette` | `{ anchor, accents: [a, b, c] }`, a hue in degrees, or `auto` | `auto` | Your brand colours instead of the seeded ones. |
| `background` | CSS colour or `auto` | `auto` | Page colour behind the glass. |
| `animate` | boolean | `true` | |
| `dpr` | `auto` \| `full` \| number | `auto` | `auto` = 1x below 48px, capped device ratio above. |
| `lens` | boolean or number ≥ 0 | auto | Chromatic rim lens. On at 48px and up, resolution-tapered. |
| `bevel` | boolean | `true` | The inset glass highlight ring. |
| `respectReducedMotion` | boolean | `true` | Honours `prefers-reduced-motion: reduce` by holding still. |
| `ariaLabel` | string | `null` | Set it and the orb is exposed with that label, otherwise it is `aria-hidden`. |

Instance surface:

```js
orb.state = 'speaking';                 // reads back the nearest named state
orb.level = 0.4;                        // raw 0..1 amplitude
orb.seed  = 'agent-8';                  // morphs; it does not restart
orb.size  = 240;

orb.setState(s); orb.update(patch);
orb.setSeed(s); orb.setSize(n); orb.setArchetype(a); orb.setPalette(p);
orb.setBackground(c); orb.setLens(l); orb.setAudioLevel(v);
orb.play(); orb.pause(); orb.renderNow();

orb.listenTo(input, opts); orb.listen(source); orb.unlisten();
orb.destroy();

orb.options; orb.palette; orb.identity; orb.source; orb.metrics; orb.supported;
```

Other named exports on `/v1/orb.js`: `Orb` (also the default export), `isSupported`,
`identityForSeed`, `hashSeed`, `makePalette`, `toRGB`, `createAudioSource`,
`OrbAudioSource`, `resumeAudio`, `audioReady`, `closeAudio`, `diagnostics`, `dispose`,
`setBatching`, `resetCounters`, `STATES`, `ARCHETYPES`, `HUES`, `PALETTES`, `version`.

`/v1/element.js` exports `OrbElement` (default), `defineOrbElement(tag)` and `TAG`. It
registers `<orb-js>` on import. `defineOrbElement('my-orb')` gives you a second tag if
the name collides.

## 6. The four states

| State | What it shows | When to set it |
|---|---|---|
| `idle` | Slow drift, dim aurora, low spin. | Nothing is happening. |
| `listening` | A cool, attentive cast. The rim ignites with the human's level. | The mic is open. |
| `thinking` | Spin roughly triples, a bead of light orbits the core, a second meteor stream quickens. No audio needed. | Between the human stopping and the agent speaking. |
| `speaking` | Full reactivity from the agent's audio, and the aurora blooms. | The agent is talking. |

Transitions crossfade over ~350 ms, so you can write the state on every SDK event.
Assigning the state it is already in is free.

```js
orb.state = 'listening';
orb.setState('thinking');             // chainable
orb.update({ state: 'speaking' });    // with other changes, one repaint
```

## 7. Binding audio

`listenTo()` takes whatever your stack hands you and works out the rest:

```js
orb.listenTo(mediaStream);       // WebRTC MediaStream (OpenAI Realtime, LiveKit, Vapi, Daily)
orb.listenTo(track);             // a single audio MediaStreamTrack
orb.listenTo(audioEl);           // an <audio> or <video> element (TTS playback)
orb.listenTo(analyserNode);      // an AnalyserNode you already have
orb.listenTo(gainNode);          // any AudioNode; Orb taps it read-only
orb.listenTo('microphone');      // asks permission, taps the mic
orb.listenTo('speech');          // a synthesised voice, for demos
orb.listenTo('synthetic');       // a fake envelope, no permission, no AudioContext
orb.listenTo(function (t) { return 0.5; });   // your own 0..1 sampler
orb.listenTo(0.6);               // a constant level
orb.listenTo(null);              // detach
```

It returns a disposer. Call it to release just that binding, other orbs sharing the same
source keep listening.

```js
const stop = orb.listenTo(agentStream, { gain: 3.2, fftSize: 512, keepAlive: true });
stop();
```

Microphone (the human side):

```js
button.addEventListener('click', function () {
  orb.listenTo('microphone');   // needs https:// or localhost
  orb.state = 'listening';
});
```

An `<audio>` element:

```js
orb.listenTo(document.querySelector('#tts'));
```

**Autoplay policy.** Browsers start the AudioContext suspended, and a suspended context
makes every analyser read exactly zero: a silent orb next to audible speech. Orb resumes
on the first user gesture automatically. If you would rather do it explicitly, call
`resumeAudio()` from the same click that starts the call, and check `audioReady()`.

If your app already computes an amplitude, skip audio entirely and write
`orb.level = 0.42` each frame.

## 8. Wiring it to your voice agent

An OpenAI Realtime (WebRTC) integration. The same three hooks apply to LiveKit, Vapi and
Daily:

```js
import { createOrb } from 'https://xyorb.vidome.app/v1/orb.js';

const orb = createOrb(document.querySelector('#orb'), { seed: 'agent-7', size: 200 });

const pc = new RTCPeerConnection();

// 1. The agent's voice arrives -> bind it, and the orb reacts to what it says.
pc.ontrack = function (e) {
  orb.listenTo(e.streams[0] || e.track);
};

// 2. The human's mic -> send it, and let the orb show the room while listening.
const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
mic.getTracks().forEach(function (t) { pc.addTrack(t, mic); });

// 3. The agent's own events -> the state machine.
const events = pc.createDataChannel('oai-events');
events.addEventListener('message', function (e) {
  const msg = JSON.parse(e.data);

  if (msg.type === 'input_audio_buffer.speech_started')      orb.state = 'listening';
  else if (msg.type === 'input_audio_buffer.speech_stopped') orb.state = 'thinking';
  else if (msg.type === 'response.audio.delta')              orb.state = 'speaking';
  else if (msg.type === 'response.done')                     orb.state = 'idle';
});
```

Two rules that matter in production:

- Bind the **agent's inbound stream** while it speaks, not the mic, or the orb reacts to
  the room instead of to the voice.
- Set `thinking` in the gap. It is the state that makes latency feel intentional.

With `<orb-js>` the same code reads `el.listenTo(...)` and `el.state = '...'`.

## 9. Versioning and caching

- `/v1/…` is **immutable**. Those bytes never change meaning. They are served with a
  one-year immutable cache, so after the first hit the orb costs your users nothing.
- Breaking changes ship as a new path (`/v2/element.js`) and `/v1/` keeps working. You
  upgrade by editing one URL, on your schedule.
- Non-breaking fixes land inside `/v1/` under the same guarantee: the API and the visuals
  stay compatible.
- Any `latest` alias revalidates on every load and is therefore **not** for production.
  Pin `/v1/`.

Because `element.js` imports `./orb.js` relatively, both files have to come from the same
versioned directory, which they do. Do not mix `/v1/element.js` with `/v2/orb.js`.

## 10. Browser support and fallback

- **Requires:** WebGL1 and ES modules. Chrome/Edge 61+, Safari 11+, Firefox 63+.
  `<orb-js>` additionally needs custom elements v1, available in all of those.
- **The global build** (`orb.global.js`) needs no module support, for GTM and older embed
  contexts.
- **No WebGL, or no usable fragment precision:** the orb paints a static sphere built
  from that seed's own palette instead. Right agent, right colour, no canvas, no
  animation loop, nothing thrown. Check it with `orb.supported` / `el.supported`, or
  `isSupported()` before you mount.
- **`prefers-reduced-motion: reduce`:** the orb holds still by default. Pass
  `respectReducedMotion: false` to opt out.
- **Accessibility:** the orb is `aria-hidden` unless you give it a label
  (`el.label = '…'` or `ariaLabel: '…'`), since it is usually decoration beside a live
  transcript.
- **HTTPS.** Modules are fetched with CORS and the microphone needs a secure context, so
  serve your page over `https://` (or `localhost` in development). A `file://` page
  cannot load ES modules at all. Browser rule.

## 11. Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing renders, no console error | The module failed to load. A cross-origin module that 404s or lacks CORS headers can fail silently. Open the network panel and confirm `/v1/element.js` is `200` with `content-type: text/javascript`. |
| The orb renders but never moves with the voice | Nothing is bound, or the AudioContext is still suspended. Check `audioReady()`, call `resumeAudio()` from a click. |
| A WebRTC stream reads as silence | The stream needs a media-element sink in Chrome. Orb attaches a muted one for you unless you passed `keepAlive: false`. |
| The orb is a flat gradient | No usable WebGL. That is the fallback, working as intended. `orb.supported` is `false`. |
| A square edge or a hard corner | Page CSS is overriding the element's box. Size it with the `size` attribute rather than with `width`/`height`. |
| Every user gets the same orb | The seed is empty or constant. Pass something per-agent or per-user. |
