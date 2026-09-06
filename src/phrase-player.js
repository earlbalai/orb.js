/**
 * Plays pre-generated phrase audio.
 *
 * The companion to voice.js. speak() hits a TTS endpoint per utterance; this
 * plays static files produced once by scripts/generate-phrases.mjs and
 * committed to audio/ at the repo root. For a public demo that means no cost
 * per play, no API key needed, no round trip before playback starts, and
 * same-origin files an AnalyserNode can actually read. Cross-origin audio is
 * silently unreadable and the orb falls back to a fake envelope without saying
 * so.
 *
 *     import { playPhrase } from './phrase-player.js';
 *     await playPhrase(orb, 'greeting');
 *
 * @module phrase-player
 */

import { getPhrase, randomPhrase } from './phrases.js';

/** Where generate-phrases.mjs writes. */
export const DEFAULT_AUDIO_BASE = '/audio';

/** The file is missing and no fallback saved it. */
export class PhraseUnavailableError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'PhraseUnavailableError';
    this.phraseId = info.phraseId;
    this.src = info.src;
  }
}

/**
 * Audio not generated yet, which is where every fresh clone starts. Worth
 * separating from a real playback failure so a UI can say "run the generator"
 * instead of "something broke".
 *
 * @param {*} err
 * @returns {boolean}
 */
export function isNotGenerated(err) {
  return err instanceof PhraseUnavailableError;
}

/**
 * Play one phrase and drive the orb from its waveform.
 *
 * @param {object} orb          an Orb instance
 * @param {string|object} phrase a phrase id, or a phrase object
 * @param {object} [options]
 * @param {string} [options.base='/audio'] where the mp3s live
 * @param {string} [options.endState='idle'] state to return to
 * @param {number} [options.gain] passed through to listenTo
 * @param {(orb:object, text:string) => Promise<*>} [options.fallback]
 *        used when the file is missing. Pass speak from voice.js for live TTS;
 *        omit to get a PhraseUnavailableError instead.
 * @returns {Promise<void> & {stop: () => void, audio: HTMLAudioElement}}
 */
export function playPhrase(orb, phrase, options = {}) {
  const {
    base = DEFAULT_AUDIO_BASE,
    endState = 'idle',
    gain,
    fallback,
  } = options;

  const resolved =
    typeof phrase === 'string' ? getPhrase(phrase) : phrase || randomPhrase();

  if (!resolved) {
    const err = new PhraseUnavailableError(`Unknown phrase: ${String(phrase)}`, {
      phraseId: String(phrase),
    });
    const dead = Promise.reject(err);
    dead.catch(() => {});           // never an unhandled rejection
    return Object.assign(dead, { stop() {}, audio: null });
  }

  const src = `${base.replace(/\/$/, '')}/${resolved.id}.mp3`;

  const audio = new Audio();
  audio.preload = 'auto';
  audio.src = src;

  let settled = false;
  let stopped = false;

  const cleanup = () => {
    audio.onended = audio.onerror = null;
    try { audio.pause(); } catch {}
    try { orb.unlisten(); } catch {}
    try { orb.state = endState; } catch {}
  };

  const run = new Promise((resolve, reject) => {
    const finish = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err); else resolve();
    };

    audio.onended = () => finish(null);

    audio.onerror = async () => {
      // Missing or undecodable file. Use the fallback if there is one, else
      // report something the caller can act on.
      if (stopped) return finish(null);
      if (typeof fallback === 'function') {
        try {
          settled = true;
          cleanup();
          await fallback(orb, resolved.text);
          resolve();
          return;
        } catch (fallbackErr) {
          reject(fallbackErr);
          return;
        }
      }
      finish(new PhraseUnavailableError(
        `No audio at ${src}. Run: node scripts/generate-phrases.mjs`,
        { phraseId: resolved.id, src }
      ));
    };

    // Attach before play() so the analyser catches the attack of the first
    // syllable. That onset is what the spin integrator keys off.
    try {
      orb.state = 'speaking';
      orb.listenTo(audio, gain == null ? undefined : { gain });
    } catch (err) {
      finish(err);
      return;
    }

    audio.play().catch((err) => {
      // Autoplay policy. play() has to come from a user gesture.
      finish(err);
    });
  });

  return Object.assign(run, {
    stop() {
      stopped = true;
      if (!settled) { settled = true; cleanup(); }
    },
    audio,
  });
}

/**
 * Has the audio been generated? Lets a UI enable or explain the phrase controls
 * up front instead of failing on the first click.
 *
 * @param {string} [base='/audio']
 * @returns {Promise<boolean>}
 */
export async function phrasesAvailable(base = DEFAULT_AUDIO_BASE) {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/manifest.json`, {
      method: 'GET',
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default playPhrase;
