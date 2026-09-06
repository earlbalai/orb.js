/**
 * Real TTS through the orb, served from your own origin.
 *
 *     import { speak } from './voice.js';
 *     await speak(orb, 'Hello, I am your agent.', { voice: 'alloy' });
 *
 * Four things worth knowing before you change anything here.
 *
 * The audio comes from our own /api/tts rather than straight from OpenAI, for
 * two unrelated reasons. The key stays server-side (any key that reaches a
 * browser is a public key), and an AnalyserNode can only tap same-origin media.
 * Third-party audio fails that test, Orb's fromMedia() refuses to tap it, and
 * you get a synthetic envelope running alongside real speech. Fetching the
 * bytes ourselves and handing the element a blob: URL sidesteps both.
 *
 * speak() must be called from a click or tap handler. createMediaElementSource
 * routes the element through the AudioContext permanently, and a suspended
 * context means silence with no error anywhere, so speak() fires resumeAudio()
 * before its first await, while the browser still counts us as inside the
 * gesture.
 *
 * Each orb gets one <audio> element, kept in a WeakMap and reused forever.
 * createMediaElementSource is one-shot per element and cannot be undone, so a
 * fresh element per utterance would strand a node on the destination every call.
 *
 * /api/tts answers 501 when OPENAI_API_KEY is not set. That is a deployment
 * state, not a crash, and it is where every fresh clone starts. speak() rejects
 * with code 'not_configured' so the caller can fall back:
 *
 *     try {
 *       await speak(orb, text);
 *     } catch (err) {
 *       if (isNotConfigured(err)) {
 *         orb.listenTo(OrbAudioSource.speech());   // audible, keyless demo
 *         orb.state = 'speaking';
 *       } else throw err;
 *     }
 *
 * No dependencies, no build step, browser only.
 *
 * @module orb/voice
 */

import { resumeAudio } from './orb.js';

/** Same-origin, and that part is load-bearing. */
export const DEFAULT_ENDPOINT = '/api/tts';

export const DEFAULT_VOICE = 'alloy';

/**
 * Voice names for building a picker. The server validates whatever it is sent,
 * so this is only here to save a UI hard-coding strings.
 *
 * @type {readonly string[]}
 */
export const VOICES = Object.freeze([
  'alloy', 'ash', 'ballad', 'coral', 'echo',
  'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse',
]);

/**
 * What speak() rejects with. Enough to branch on without parsing messages.
 *
 * .code is one of:
 *   'not_configured'  no OPENAI_API_KEY on the server (501). Fall back.
 *   'bad_request'     4xx, usually empty text or an unknown voice.
 *   'server_error'    5xx from us or from OpenAI behind us.
 *   'network'         fetch never completed. Offline, or no /api routes at all,
 *                     which is what you get off a plain static file server.
 *   'empty'           200 with no audio bytes.
 *   'playback'        the browser would not decode or play it.
 *   'usage'           a mistake in the call itself.
 */
export class OrbVoiceError extends Error {
  /**
   * @param {string} message
   * @param {{code?:string, status?:number, cause?:*}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'OrbVoiceError';
    /** @type {string} */
    this.code = info.code || 'error';
    /** @type {number} HTTP status, or 0 if the request never got that far. */
    this.status = info.status || 0;
    if (info.cause !== undefined) this.cause = info.cause;
  }

  /** @type {boolean} */
  get notConfigured() { return this.code === 'not_configured'; }
}

/**
 * Should the caller fall back to OrbAudioSource.speech()? Safe on any thrown
 * value.
 *
 * @param {*} err
 * @returns {boolean}
 */
export function isNotConfigured(err) {
  return !!err && (err.code === 'not_configured' || err.status === 501);
}

/**
 * orb -> its <audio> element. Weak so this module never keeps an orb alive.
 * @type {WeakMap<object, HTMLAudioElement>}
 */
const players = new WeakMap();

/**
 * orb -> the utterance in flight or playing.
 * @type {WeakMap<object, object>}
 */
const sessions = new WeakMap();

/**
 * No crossOrigin="anonymous" on purpose. Orb's analysability check reads that
 * attribute as a claim the audio is CORS-clean; let it judge the blob: URL on
 * its own merits instead, which it passes.
 *
 * Never appended to the DOM. Playback and analysis are fine detached.
 *
 * @param {object} orb
 * @returns {HTMLAudioElement}
 */
function playerFor(orb) {
  let el = players.get(orb);
  if (!el) {
    el = new Audio();
    el.preload = 'auto';
    // iOS goes fullscreen without this.
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    players.set(orb, el);
  }
  return el;
}

/**
 * Speak text through the orb in a real voice.
 *
 * Holds orb.state at 'speaking' for the duration and restores it at the end,
 * however that end arrives. Calling it again mid-utterance is the intended way
 * to interrupt: the old one is cancelled and its promise resolves, since being
 * interrupted is not an error.
 *
 * Returns a Promise<void> that also carries cancel()/stop() and some read-only
 * fields, so both of these work:
 *
 *     await speak(orb, text);
 *     const utterance = speak(orb, text);
 *     stopButton.onclick = () => utterance.cancel();
 *
 * First call on a page must come from a click or tap handler.
 *
 * @param {object} orb an Orb instance
 * @param {string} text what to say
 * @param {object} [options]
 * @param {string} [options.voice='alloy'] one of {@link VOICES}
 * @param {string} [options.endpoint='/api/tts'] same-origin, or no analysis
 * @param {AbortSignal} [options.signal] aborts fetch and playback
 * @param {boolean} [options.thinking=true] show 'thinking' while loading
 * @param {string} [options.endState='idle'] state to return to
 * @param {number} [options.gain] passed through to listenTo
 * @returns {Promise<void> & {cancel:() => void, stop:() => void, audio:HTMLAudioElement,
 *   readonly sourceKind:string|null, readonly analysed:boolean, readonly done:boolean}}
 */
export function speak(orb, text, options = {}) {
  const {
    voice = DEFAULT_VOICE,
    endpoint = DEFAULT_ENDPOINT,
    signal = null,
    thinking = true,
    endState = 'idle',
    gain,
  } = options;

  // Everything that has to be undone, in one object, so finish() can run from
  // any of its six callers and do the right amount of work.
  const session = {
    audio: null,          // HTMLAudioElement
    url: null,            // blob: object URL to revoke
    detach: null,         // disposer returned by orb.listenTo()
    controller: null,     // AbortController for the fetch
    sourceKind: null,     // 'media' (real analysis) or 'synthetic'
    settled: false,
    resolve: null,
    reject: null,
    cancel: null,
    unsubscribeSignal: null,   // detach from a caller's AbortSignal
  };

  const promise = new Promise((resolve, reject) => {
    session.resolve = resolve;
    session.reject = reject;
  });

  /**
   * Tear down once, restore the orb, settle the promise. Null err means a clean
   * end, finished or cancelled.
   * @param {OrbVoiceError|null} err
   */
  function finish(err) {
    if (session.settled) return;
    session.settled = true;

    // Only release the slot if a newer utterance has not already claimed it.
    if (sessions.get(orb) === session) sessions.delete(orb);

    // Signals tend to be one per conversation rather than one per sentence, and
    // this listener closes over the whole session.
    if (session.unsubscribeSignal) {
      try { session.unsubscribeSignal(); } catch { /* fine */ }
      session.unsubscribeSignal = null;
    }

    if (session.controller) {
      try { session.controller.abort(); } catch { /* already done */ }
      session.controller = null;
    }

    // Unbind before touching the element, so nothing samples a half-torn-down
    // graph. Detaches only what our listenTo() created.
    if (session.detach) {
      try { session.detach(); } catch { /* orb may be destroyed */ }
      session.detach = null;
    }

    const el = session.audio;
    if (el) {
      el.oncanplay = el.onplaying = el.onended = el.onerror = el.onpause = null;
      try { el.pause(); } catch { /* nothing playing */ }
      // Releases the decoded buffer. Do not use .src = '' instead: it
      // re-resolves to the page URL and fires a spurious error.
      try { el.removeAttribute('src'); el.load(); } catch { /* fine */ }
      session.audio = null;
    }

    // Revoke last. If the element still holds the blob, Safari can abort
    // playback of an already-buffered clip.
    if (session.url) {
      try { URL.revokeObjectURL(session.url); } catch { /* fine */ }
      session.url = null;
    }

    // Only reset state if we still own it. A newer speak() has already written
    // 'thinking' or 'speaking'.
    if (!sessions.has(orb)) {
      try { orb.state = endState; } catch { /* orb destroyed mid-flight */ }
    }

    if (err) session.reject(err); else session.resolve();
  }

  session.cancel = () => finish(null);

  // Rejected, not thrown, so every path out of speak() returns the same shape
  // and .catch() always works on the handle.
  if (!orb || typeof orb.listenTo !== 'function') {
    finish(new OrbVoiceError(
      '[Orb] speak(orb, text): first argument must be an Orb instance.',
      { code: 'usage' }));
    return decorate(promise, session);
  }
  const said = typeof text === 'string' ? text.trim() : '';
  if (!said) {
    finish(new OrbVoiceError(
      '[Orb] speak(orb, text): text must be a non-empty string.',
      { code: 'usage' }));
    return decorate(promise, session);
  }

  // Claim the slot before cancelling the old utterance. finish() reads the slot
  // to decide whether it still owns orb.state, so this ordering keeps an
  // interrupted utterance from yanking the orb back to 'idle' underneath its
  // replacement.
  const previous = sessions.get(orb);
  sessions.set(orb, session);
  if (previous) previous.cancel();

  // Gesture-critical, and it has to happen before any await. resumeAudio()
  // never rejects; firing it synchronously keeps it inside the click. Awaiting
  // first would push it into a later task, which the autoplay policy refuses.
  const audioResumed = resumeAudio();

  if (thinking) {
    try { orb.state = 'thinking'; } catch { /* not fatal */ }
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  session.controller = controller;
  if (signal) {
    if (signal.aborted) { finish(null); return decorate(promise, session); }
    const onAbort = () => finish(null);
    signal.addEventListener('abort', onAbort, { once: true });
    session.unsubscribeSignal = () => signal.removeEventListener('abort', onAbort);
  }

  request(endpoint, said, voice, controller)
    .then((blob) => {
      if (session.settled) return;   // cancelled while the bytes were in flight

      const el = playerFor(orb);
      session.audio = el;
      session.url = URL.createObjectURL(blob);
      el.src = session.url;

      // The analyser tap. A blob: URL passes Orb's same-origin check, so this
      // is a real AnalyserNode on the real waveform rather than the synthetic
      // envelope it falls back to for tainted media. source.kind says which.
      session.detach = orb.listenTo(el, gain === undefined ? undefined : { gain });
      try { session.sourceKind = orb.source ? orb.source.kind : null; } catch { /* fine */ }

      el.onended = () => finish(null);
      el.onerror = () => finish(new OrbVoiceError(
        '[Orb] The browser could not play the audio returned by ' + endpoint + '.',
        { code: 'playback' }));

      // Flip on 'playing', not on the play() promise. That promise can resolve
      // a frame before anything is audible, and an early 'speaking' orb reads
      // as a glitch.
      el.onplaying = () => { try { orb.state = 'speaking'; } catch { /* fine */ } };

      return Promise.resolve(el.play()).then(() => audioResumed);
    })
    .then((ready) => {
      // false means the context is still suspended, so the call did not come
      // from a gesture. Audio is audible through the element, but every
      // analyser reads zero and the orb sits dead still. Warn, do not throw.
      if (ready === false && !session.settled) {
        console.warn('[Orb] AudioContext is still suspended, so the orb cannot ' +
          'measure this audio. Call speak() from a click handler.');
      }
    })
    .catch((err) => {
      if (session.settled) return;              // cancel() won the race
      if (err && err.name === 'AbortError') { finish(null); return; }
      finish(err instanceof OrbVoiceError ? err : new OrbVoiceError(
        '[Orb] speak() failed: ' + (err && err.message ? err.message : String(err)),
        { code: 'playback', cause: err }));
    });

  return decorate(promise, session);
}

/**
 * POST the text, get an audio Blob back, map every failure onto a readable
 * OrbVoiceError.
 *
 * @param {string} endpoint
 * @param {string} text
 * @param {string} voice
 * @param {AbortController|null} controller
 * @returns {Promise<Blob>}
 */
async function request(endpoint, text, voice, controller) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, voice }),
      signal: controller ? controller.signal : undefined,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new OrbVoiceError(
      '[Orb] Could not reach ' + endpoint + '. A plain static file server has ' +
      'no /api routes, so run this behind Vercel (vercel dev, or a deployment) ' +
      'to give the serverless function somewhere to live.',
      { code: 'network', cause: err });
  }

  if (!res.ok) {
    const detail = await errorDetail(res);

    // 501 is our "no key configured" answer. Callers are expected to fall back.
    if (res.status === 501) {
      throw new OrbVoiceError(
        '[Orb] Real voice is not configured on the server: ' + endpoint +
        ' answered 501. Set the OPENAI_API_KEY environment variable in your ' +
        'Vercel project (Settings > Environment Variables) and redeploy. ' +
        'Until then, fall back to OrbAudioSource.speech().' +
        (detail ? ' Server said: ' + detail : ''),
        { code: 'not_configured', status: 501 });
    }

    throw new OrbVoiceError(
      '[Orb] ' + endpoint + ' answered ' + res.status + ' ' + res.statusText +
      (detail ? ': ' + detail : '.'),
      { code: res.status >= 500 ? 'server_error' : 'bad_request', status: res.status });
  }

  const blob = await res.blob();
  if (!blob || !blob.size) {
    throw new OrbVoiceError(
      '[Orb] ' + endpoint + ' returned no audio bytes.',
      { code: 'empty', status: res.status });
  }
  return blob;
}

/**
 * Best-effort message out of an error response, whatever shape it is in. Never
 * throws, and never lets a whole HTML error page through.
 *
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function errorDetail(res) {
  try {
    const body = await res.text();
    if (!body) return '';
    try {
      const json = JSON.parse(body);
      const msg = json && (json.error || json.message);
      if (typeof msg === 'string') return msg.slice(0, 300);
      if (msg && typeof msg.message === 'string') return msg.message.slice(0, 300);
    } catch { /* not JSON, use the raw text */ }
    return body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * Hang cancel and a little introspection off the promise, so one return value
 * serves callers that await and callers that keep a handle.
 *
 * @param {Promise<void>} promise
 * @param {object} session
 * @returns {*}
 */
function decorate(promise, session) {
  const cancel = () => { if (session.cancel) session.cancel(); };
  return Object.defineProperties(promise, {
    cancel: { value: cancel },
    /** Alias, because half the world calls this stop(). */
    stop: { value: cancel },
    /** Null once finished. */
    audio: { get: () => session.audio },
    /**
     * 'media' or 'synthetic'. Should always be 'media' here since blob: URLs
     * are analysable, but surface it rather than assume.
     */
    sourceKind: { get: () => session.sourceKind },
    analysed: { get: () => session.sourceKind === 'media' },
    /** Finished, failed or cancelled. */
    done: { get: () => session.settled },
  });
}

/**
 * Stop whatever this orb is saying. Safe on an orb that has never spoken. The
 * in-flight promise resolves, since being interrupted is not an error.
 *
 * @param {object} orb
 * @returns {boolean} whether there was anything to stop
 */
export function stopSpeaking(orb) {
  const session = orb && sessions.get(orb);
  if (!session) return false;
  session.cancel();
  return true;
}

/**
 * Fetching or playing right now?
 *
 * @param {object} orb
 * @returns {boolean}
 */
export function isSpeaking(orb) {
  return !!(orb && sessions.get(orb));
}

export default speak;
