/**
 * Demo phrases for previewing speak mode.
 *
 * Picked for what they do to the envelope, not for what they say. The spin
 * integrator keys off the positive derivative of the fast envelope, so it needs
 * onsets to react to; flat monotone text makes the orb look broken when it is
 * working fine. Every line here has varied stress and real pauses.
 *
 * @module phrases
 */

/**
 * @typedef {object} Phrase
 * @property {string} id     stable key
 * @property {string} label  for a picker UI
 * @property {'idle'|'listening'|'thinking'|'speaking'} state the state it shows
 * @property {string} text   what gets spoken
 * @property {string} [note] why it is in the set
 */

/** @type {Phrase[]} */
export const PHRASES = [
  {
    id: 'greeting',
    label: 'Greeting',
    state: 'speaking',
    text: "Hey — good to meet you. I'm listening whenever you're ready.",
    note: 'Short and warm, one clear pause. Good first impression.',
  },
  {
    id: 'thinking-aloud',
    label: 'Thinking aloud',
    state: 'thinking',
    text: "Let me check that... okay. Give me one second while I pull it up.",
    note: 'Trails off then resumes. Exercises the release side of the slow envelope.',
  },
  {
    id: 'short-answer',
    label: 'Short answer',
    state: 'speaking',
    text: "Yes. Three of them, all before noon.",
    note: 'Staccato. Hard onsets make the spin kick and reverse.',
  },
  {
    id: 'list',
    label: 'Reading a list',
    state: 'speaking',
    text:
      "I found four options. The first leaves at six forty, the second at nine " +
      "fifteen, the third just after noon, and the last one at half past four.",
    note: 'Regular commas, steady pulse.',
  },
  {
    id: 'explanation',
    label: 'Long explanation',
    state: 'speaking',
    text:
      "So the way this works is fairly simple. There is no geometry in the orb " +
      "at all — the sphere is solved analytically for every pixel, the view ray " +
      "is refracted through the glass, and the galaxy behind it is sampled a " +
      "second time where that ray exits the far wall. That second sample is the " +
      "whole trick. Without it you have a flat disc with a picture on it.",
    note: 'Long form. The envelope settles into a normal speaking cadence.',
  },
  {
    id: 'question',
    label: 'Asking back',
    state: 'listening',
    text: "Before I book it — do you want the window seat, or is the aisle fine?",
    note: 'Rising intonation, mid-sentence break.',
  },
  {
    id: 'confirm',
    label: 'Confirming',
    state: 'speaking',
    text: "Done. I've sent the confirmation to your email.",
    note: 'Clipped. Sharp attack, fast decay to silence.',
  },
  {
    id: 'apology',
    label: 'Bad news',
    state: 'speaking',
    text: "I'm sorry — that one just sold out. Want me to look at the next day instead?",
    note: 'Soft dynamics. The orb should visibly calm down.',
  },
];

/** Every phrase id, in order. @type {string[]} */
export const PHRASE_IDS = PHRASES.map((p) => p.id);

/**
 * Look a phrase up by id.
 * @param {string} id
 * @returns {Phrase|undefined}
 */
export function getPhrase(id) {
  return PHRASES.find((p) => p.id === id);
}

/**
 * Random phrase, optionally skipping the one just played so repeated clicks do
 * not replay the same line.
 *
 * @param {string} [excludeId]
 * @returns {Phrase}
 */
export function randomPhrase(excludeId) {
  const pool = PHRASES.length > 1 && excludeId
    ? PHRASES.filter((p) => p.id !== excludeId)
    : PHRASES;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * @param {'idle'|'listening'|'thinking'|'speaking'} state
 * @returns {Phrase[]}
 */
export function phrasesForState(state) {
  return PHRASES.filter((p) => p.state === state);
}

export default PHRASES;
