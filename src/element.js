/**
 * <orb-js> custom element. Wraps the core in ./orb.js.
 * Earl Balai · zero dependencies · native ES module · no build step
 *
 *     <script type="module" src="./src/element.js"></script>
 *     <orb-js seed="agent-7" size="160" state="speaking" archetype="nebula"></orb-js>
 *
 * The core leaves three things to its host, and they live here.
 *
 * Attributes reflect both ways, so the orb is drivable from HTML, from JS
 * properties, from a framework that only sets attributes, or from devtools.
 *
 * The circular clip and the bevel ring live in a shadow root, so page CSS cannot
 * square off the sphere and the orb's styles cannot leak out. The core's own
 * bevel is switched off; the glass is in one place.
 *
 * disconnectedCallback destroys the orb outright. rAF loop, GL registration and
 * any audio this element started all go with it.
 *
 * With no WebGL the element paints a seeded CSS sphere instead, so you get the
 * right agent in the right colour rather than an empty box.
 */

import {
  createOrb,
  isSupported,
  identityForSeed,
  makePalette,
  toRGB,
  STATES,
  ARCHETYPES,
} from './orb.js';

/* constants */

/** The tag this module defines. */
export const TAG = 'orb-js';

const OBSERVED = ['seed', 'size', 'state', 'archetype', 'lens', 'background', 'animate'];

/** Same list, string-backed both ways. */
const REFLECTED = OBSERVED;

const DEFAULT_SIZE = 320;

const TRUE_WORDS = ['', 'true', 'on', 'yes', '1'];
const FALSE_WORDS = ['false', 'off', 'no', '0', 'none'];

/**
 * Shadow CSS. The clip is tripled on purpose (border-radius, clip-path, and a
 * half-pixel radial mask). Each one leaks on a different engine when a
 * composited canvas layer sits underneath.
 */
const SHEET = `
:host {
  display: inline-block;
  position: relative;
  width: var(--orb-size, 320px);
  height: var(--orb-size, 320px);
  line-height: 0;
  flex: 0 0 auto;
  vertical-align: middle;
  -webkit-tap-highlight-color: transparent;
}
:host([hidden]) { display: none; }

.frame {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  overflow: hidden;
  clip-path: circle(50% at 50% 50%);
  -webkit-clip-path: circle(50% at 50% 50%);
  mask-image: radial-gradient(closest-side, #000 calc(100% - 0.5px), transparent);
  -webkit-mask-image: radial-gradient(closest-side, #000 calc(100% - 0.5px), transparent);
}

.mount {
  position: absolute;
  inset: 0;
  display: block;
  line-height: 0;
}

/* The no-WebGL sphere. Painted from the seed's palette so identity survives
   when the shader cannot run. */
.fallback {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: transparent;
}
.fallback[hidden] { display: none; }

/* The glass. Matches the core's bevel geometry, so an element orb and a
   createOrb() orb look identical. */
.bevel {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  opacity: 0.35;
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.7),
    inset 0 -1px 1px rgba(255, 255, 255, 0.45),
    inset 0 0 0 1px rgba(255, 255, 255, 0.22),
    inset 0 0 calc(var(--orb-size, 320px) * 0.06) rgba(255, 255, 255, 0.18);
}
.bevel[hidden] { display: none; }
`;

/* attribute parsing */

const warn = (msg) => { try { console.warn('[orb-js] ' + msg); } catch { /* muted console */ } };

const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * Attributes get typed by hand, and a throw out of attributeChangedCallback
 * aborts the browser's parser task, taking unrelated markup with it. So every
 * parser below warns and falls back instead.
 */
function parseSize(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    warn('size="' + raw + '" is not a positive number; using ' + DEFAULT_SIZE);
    return DEFAULT_SIZE;
  }
  return n;
}

function parseState(raw) {
  const v = lower(raw);
  if (STATES.indexOf(v) !== -1) return v;
  const n = Number(raw);
  if (raw !== '' && Number.isFinite(n)) return n;   // continuous poses are legal
  warn('state="' + raw + '" is not one of ' + STATES.join(', ') + '; using idle');
  return 'idle';
}

function parseArchetype(raw) {
  const v = lower(raw);
  if (v === '' || v === 'auto') return 'auto';
  if (ARCHETYPES.indexOf(v) !== -1) return v;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  warn('archetype="' + raw + '" is not one of ' + ARCHETYPES.join(', ') + '; using auto');
  return 'auto';
}

function parseLens(raw) {
  const v = lower(raw);
  if (v === 'auto') return undefined;               // let the core size it
  if (TRUE_WORDS.indexOf(v) !== -1) return true;
  if (FALSE_WORDS.indexOf(v) !== -1) return false;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  warn('lens="' + raw + '" is not a number, on/off, or auto; using auto');
  return undefined;
}

function parseAnimate(raw) {
  const v = lower(raw);
  if (FALSE_WORDS.indexOf(v) !== -1) return false;
  if (TRUE_WORDS.indexOf(v) !== -1) return true;
  warn('animate="' + raw + '" is not a boolean; using true');
  return true;
}

/**
 * Not an attribute, same treatment. A bad palette dropped here rather than at
 * the core, where it would make every later update() throw and freeze the orb on
 * whatever it was showing.
 */
function parsePalette(v) {
  if (v == null || v === 'auto') return undefined;
  if (typeof v === 'number') {
    if (Number.isFinite(v)) return v;
  } else if (v && typeof v === 'object' && Array.isArray(v.accents) && v.accents.length === 3) {
    try {
      toRGB(v.anchor);
      toRGB(v.accents[0]); toRGB(v.accents[1]); toRGB(v.accents[2]);
      return v;
    } catch { /* reported below */ }
  }
  warn('palette must be a hue number, or {anchor, accents:[a,b,c]} of CSS colours; using auto');
  return undefined;
}

function parseBackground(raw) {
  const v = String(raw).trim();
  if (v === '' || lower(v) === 'auto') return 'auto';
  try { toRGB(v); return v; } catch {
    warn('background="' + v + '" is not a CSS colour; using auto');
    return 'auto';
  }
}

/* the element */

/**
 * extends HTMLElement is evaluated at import time and throws under Node/SSR.
 * A plain base keeps the module importable anywhere; nothing constructs it
 * server side.
 */
const Base = typeof HTMLElement === 'function' ? HTMLElement : class {};

/**
 * <orb-js>, an audio-reactive galaxy-in-glass orb as one HTML tag.
 *
 * Attributes (all reflected to like-named properties):
 *   seed        identity string. Palette, archetype and structure derive from it.
 *   size        CSS pixels, square. Default 320.
 *   state       idle | listening | thinking | speaking, or a 0..3 number.
 *   archetype   spiral | nebula | core | deep | auto.
 *   lens        number >= 0, on/off, or auto.
 *   background  any CSS colour, or auto (resolved through the shadow boundary).
 *   animate     boolean. Absent means animating.
 *
 * Properties beyond those: palette, dpr, level, label, orb, identity, metrics,
 * supported.
 *
 * Methods: listenTo(input, opts), unlisten(), setState(s), update(patch),
 * play(), pause().
 */
export class OrbElement extends Base {
  static get observedAttributes() { return OBSERVED.slice(); }

  constructor() {
    super();

    /** @type {import('./orb.js').Orb|null} */
    this._orb = null;
    /** Options that make no sense as attribute strings. */
    this._props = { palette: undefined, dpr: undefined, level: 0, label: null };
    /** Last applied option signature, so redundant update() calls are skipped. */
    this._sig = '';
    /** The core's audio disposer, plus what produced it. */
    this._audioStop = null;
    this._audio = null;
    this._mounted = false;
    this._batching = false;

    const root = this.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = SHEET;

    this._frame = document.createElement('div');
    this._frame.className = 'frame';
    this._mountEl = document.createElement('div');
    this._mountEl.className = 'mount';
    this._fallback = document.createElement('div');
    this._fallback.className = 'fallback';
    this._fallback.hidden = true;
    this._bevel = document.createElement('div');
    this._bevel.className = 'bevel';

    this._frame.appendChild(this._mountEl);
    this._frame.appendChild(this._fallback);
    root.appendChild(style);
    root.appendChild(this._frame);
    root.appendChild(this._bevel);
  }

  /* --- lifecycle ---------------------------------------------------------- */

  connectedCallback() {
    // A property assigned before the definition loaded shadows the accessor
    // forever unless it is deleted and replayed through the setter.
    for (const name of REFLECTED) upgradeProperty(this, name);
    for (const name of ['palette', 'dpr', 'level', 'label']) upgradeProperty(this, name);

    this._applyAria();
    this._mount();
  }

  disconnectedCallback() {
    // Everything this element started stops here: rAF registration, GL
    // bookkeeping, the intersection observer, any audio the orb took over.
    // What is left is inert DOM.
    if (this._audioStop) { try { this._audioStop(); } catch { /* already gone */ } }
    this._audioStop = null;
    if (this._orb) { try { this._orb.destroy(); } catch { /* already gone */ } }
    this._orb = null;
    this._mounted = false;
    this._sig = '';
    this._fallback.hidden = true;
    this._fallback.style.background = '';
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'size') this._applySize();
    this._sync();
  }

  /* --- reflected properties ------------------------------------------------ */

  get seed() { return this.hasAttribute('seed') ? this.getAttribute('seed') : ''; }
  set seed(v) { this._reflect('seed', v); }

  get size() {
    return this.hasAttribute('size') ? parseSize(this.getAttribute('size')) : DEFAULT_SIZE;
  }
  set size(v) { this._reflect('size', v); }

  get state() {
    // Once mounted the orb is the truth, and it reads back the nearest named
    // state, which is what a caller asking "what is it doing" wants.
    if (this._orb) return this._orb.state;
    return this._stateOption();
  }
  set state(v) { this._reflect('state', v); }

  get archetype() {
    return this.hasAttribute('archetype') ? parseArchetype(this.getAttribute('archetype')) : 'auto';
  }
  set archetype(v) { this._reflect('archetype', v); }

  get lens() {
    return this.hasAttribute('lens') ? parseLens(this.getAttribute('lens')) : undefined;
  }
  set lens(v) {
    if (v == null) { this.removeAttribute('lens'); this._sync(); return; }
    this._reflect('lens', v === true ? 'true' : v === false ? 'false' : v);
  }

  get background() {
    return this.hasAttribute('background') ? parseBackground(this.getAttribute('background')) : 'auto';
  }
  set background(v) { this._reflect('background', v); }

  get animate() {
    return this.hasAttribute('animate') ? parseAnimate(this.getAttribute('animate')) : true;
  }
  set animate(v) {
    // Absent means animating, so true removes rather than writes. The _sync()
    // below covers the case where the attribute was already absent and no
    // attributeChangedCallback fires.
    if (v === false || FALSE_WORDS.indexOf(lower(v)) !== -1) this.setAttribute('animate', 'false');
    else this.removeAttribute('animate');
    this._sync();
  }

  /* --- non-reflected properties -------------------------------------------- */

  /** {anchor, accents}, a hue number, or 'auto'. Not an attribute. */
  get palette() { return this._orb ? this._orb.palette : this._props.palette; }
  set palette(v) { this._props.palette = parsePalette(v); this._sync(); }

  /** Device pixel ratio: a number, 'auto' or 'full'. */
  get dpr() { return this._props.dpr; }
  set dpr(v) { this._props.dpr = v; this._sync(); }

  /** Raw 0..1 amplitude. Write it if your app already has the level. */
  get level() { return this._orb ? this._orb.level : this._props.level; }
  set level(v) {
    const n = Number(v);
    this._props.level = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
    if (this._orb) this._orb.level = this._props.level;
  }

  /** Accessible name. Null (the default) leaves the orb aria-hidden. */
  get label() { return this._props.label; }
  set label(v) {
    this._props.label = v == null ? null : String(v);
    this._applyAria();
  }

  /* --- introspection ------------------------------------------------------- */

  /** The core instance, or null before connect and after disconnect. */
  get orb() { return this._orb; }

  /** True on real WebGL, false when the CSS sphere is showing. */
  get supported() { return !!(this._orb && this._orb.supported); }

  /** What this element's seed resolves to. Works with no orb mounted. */
  get identity() { return identityForSeed(this.seed); }

  /** Live dynamics, or null when nothing is mounted. */
  get metrics() { return this._orb ? this._orb.metrics : null; }

  /* --- methods ------------------------------------------------------------- */

  /**
   * Bind audio. Takes anything the core takes: a MediaStream, a track, an
   * <audio> element, an AnalyserNode, an AudioNode, a (t) => 0..1 function, a
   * number, 'microphone', 'speech', 'synthetic', or null to detach.
   *
   * Fine to call before the element is connected. The binding is remembered and
   * attached on mount, and re-attached if the element is moved in the DOM (which
   * disconnects and reconnects it).
   *
   * @param {*} input
   * @param {{gain?:number, fftSize?:number, keepAlive?:boolean}} [opts]
   * @returns {() => void} idempotent disposer
   */
  listenTo(input, opts) {
    if (input == null) { this.unlisten(); return () => {}; }
    if (this._audioStop) { try { this._audioStop(); } catch { /* already gone */ } }
    this._audioStop = null;
    this._audio = { input, opts };

    if (!this._orb) return () => { if (this._audio && this._audio.input === input) this.unlisten(); };

    this._audioStop = this._orb.listenTo(input, opts);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this._audio && this._audio.input === input) this.unlisten();
    };
  }

  /** Detach audio and decay to silence. */
  unlisten() {
    if (this._audioStop) { try { this._audioStop(); } catch { /* already gone */ } }
    this._audioStop = null;
    this._audio = null;
    if (this._orb) this._orb.unlisten();
    return this;
  }

  /** Same as assigning el.state, but chainable. */
  setState(state) { this.state = state; return this; }

  /**
   * Several options at once. Keys map to the properties above, so this is one
   * repaint instead of one per assignment.
   * @param {object} patch
   */
  update(patch = {}) {
    const keys = Object.keys(patch);
    if (!keys.length) return this;
    // Suppress the per-attribute sync, then run one at the end.
    this._batching = true;
    try {
      for (const k of keys) {
        if (k === 'audio') continue;
        this[k] = patch[k];
      }
    } finally {
      this._batching = false;
    }
    this._sync();
    if ('audio' in patch) this.listenTo(patch.audio);
    return this;
  }

  /** Resume animation. */
  play() { this.animate = true; return this; }
  /** Freeze on the current frame. */
  pause() { this.animate = false; return this; }

  /* --- internals ----------------------------------------------------------- */

  /** @private attributeChangedCallback does the rest. */
  _reflect(name, value) {
    if (value == null) this.removeAttribute(name);
    else this.setAttribute(name, String(value));
  }

  /** @private One custom property rather than inline width/height, so page CSS
   * can still override the box without a specificity fight. */
  _applySize() {
    this.style.setProperty('--orb-size', this.size + 'px');
  }

  /** @private */
  _applyAria() {
    const label = this._props.label != null ? this._props.label : this.getAttribute('label');
    if (label) {
      this.removeAttribute('aria-hidden');
      this.setAttribute('role', 'img');
      this.setAttribute('aria-label', String(label));
    } else {
      this.setAttribute('aria-hidden', 'true');
      this.removeAttribute('role');
      this.removeAttribute('aria-label');
    }
  }

  /**
   * @private The page colour bleeding through the glass.
   *
   * The core's own walk up parentElement stops dead at a shadow boundary, so
   * from in here it would always miss and settle for black or white. Do the walk
   * on this side, hopping host to host, and hand the core an explicit colour.
   */
  _autoBackground() {
    try {
      let node = this;
      for (let i = 0; node && i < 64; i++) {
        if (node.nodeType !== 1) break;
        const bg = getComputedStyle(node).backgroundColor;
        const m = bg && bg.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i);
        if (m && (m[4] === undefined || parseFloat(m[4]) > 0.9)) {
          return 'rgb(' + m[1] + ',' + m[2] + ',' + m[3] + ')';
        }
        const root = node.getRootNode ? node.getRootNode() : null;
        node = node.parentElement || (root && root.host) || null;
      }
    } catch { /* detached, or no layout engine */ }
    return 'auto';
  }

  /**
   * @private State as authored, NOT as read back. The state getter rounds a
   * continuous pose to its nearest name once an orb exists, and feeding that
   * back through update() would quantise state="2.5" into 'speaking' on the next
   * unrelated attribute change.
   */
  _stateOption() {
    return this.hasAttribute('state') ? parseState(this.getAttribute('state')) : 'idle';
  }

  /** @private Every option the core needs, read fresh from attributes. */
  _options() {
    const bg = this.background;
    return {
      seed: this.seed,
      size: this.size,
      state: this._stateOption(),
      archetype: this.archetype,
      lens: this.lens,
      background: bg === 'auto' ? this._autoBackground() : bg,
      animate: this.animate,
      palette: this._props.palette == null ? 'auto' : this._props.palette,
      dpr: this._props.dpr == null ? 'auto' : this._props.dpr,
      // The shadow root draws the glass ring; the core must not draw a second
      // one underneath.
      bevel: false,
      ariaLabel: null,
    };
  }

  /** @private The orb, or the CSS sphere if WebGL is unusable. */
  _mount() {
    if (this._orb || this._mounted) return;
    this._applySize();

    if (!isSupported()) { this._paintFallback(); return; }

    const opts = this._options();
    try {
      this._orb = createOrb(this._mountEl, opts);
    } catch (err) {
      // A bad seed cannot throw. A bad palette object, or a context lost at the
      // wrong moment, can. Better a sphere than a hole.
      warn('could not create the orb; falling back to the static sphere');
      try { console.error(err); } catch { /* muted console */ }
      this._orb = null;
      this._paintFallback();
      return;
    }

    this._mounted = true;
    this._sig = signature(opts);
    this._fallback.hidden = true;
    this._fallback.style.background = '';
    this._mountEl.style.display = '';

    if (!this._orb.supported) {
      // Core hit its own fallback. Hide its canvas layer and paint ours, so
      // there is one sphere and one bevel on screen.
      this._paintFallback();
    }
    if (this._props.level) this._orb.level = this._props.level;
    if (this._audio) this._audioStop = this._orb.listenTo(this._audio.input, this._audio.opts);
  }

  /** @private Push current attributes into the live orb. */
  _sync() {
    if (this._batching) return;
    if (!this._orb) {
      // No orb, so keep the static sphere honest about the seed and palette.
      if (this._mountEl && !this._fallback.hidden) this._paintFallback();
      this._applySize();
      return;
    }
    this._applySize();
    const opts = this._options();
    const sig = signature(opts);
    if (sig === this._sig) return;
    this._sig = sig;
    try {
      this._orb.update(opts);
    } catch (err) {
      // Forget the signature so the next change is retried rather than skipped
      // as already applied. A rejected patch must not wedge the element.
      this._sig = '';
      warn('rejected that option patch');
      try { console.error(err); } catch { /* muted console */ }
    }
    if (!this._fallback.hidden) this._paintFallback();
  }

  /**
   * @private The no-WebGL sphere. A radial gradient from this seed's palette, so
   * the identity still reads.
   *
   * Colours are normalised to #rrggbb first. One bad colour anywhere in a
   * gradient makes the browser drop the WHOLE background, which would turn the
   * fallback into the empty hole it exists to prevent. The mid layer also
   * appends an alpha pair, and that only concatenates onto hex.
   */
  _paintFallback() {
    const seedPal = identityForSeed(this.seed).palette;
    const custom = resolvePaletteish(this._props.palette);
    const src = custom || seedPal;
    const anchor = toHex(src.anchor, seedPal.anchor);
    const acc = [0, 1, 2].map((i) => toHex(
      src.accents && src.accents[i], (seedPal.accents && seedPal.accents[i]) || seedPal.anchor));

    const bgRaw = this.background;
    const bg = bgRaw === 'auto' ? this._autoBackground() : bgRaw;
    const base = bg === 'auto' ? 'transparent' : toHex(bg, 'transparent');

    this._fallback.style.background =
      'radial-gradient(58% 58% at 34% 26%, ' + acc[1] + ', transparent 62%),' +
      'radial-gradient(72% 72% at 70% 74%, ' + acc[2] + '55, transparent 60%),' +
      'radial-gradient(closest-side, ' + anchor + ', ' + base + ')';
    // An invalid value leaves the property empty, which is the one outcome this
    // method must never produce.
    if (!this._fallback.style.background) {
      this._fallback.style.background =
        'radial-gradient(closest-side, ' + seedPal.anchor + ', transparent)';
    }
    this._fallback.hidden = false;
    this._mountEl.style.display = 'none';
    this._applySize();
  }
}

/* helpers */

/** palette-ish -> {anchor, accents}, or null for 'auto'. */
function resolvePaletteish(p) {
  if (p && typeof p === 'object' && p.anchor) return p;
  if (typeof p === 'number' && Number.isFinite(p)) return makePalette(p);
  return null;
}

const hex2 = (v) => Math.round(255 * Math.min(1, Math.max(0, v))).toString(16).padStart(2, '0');

/** Any CSS colour -> #rrggbb, or the fallback if it will not parse. */
function toHex(color, fallback) {
  try {
    const rgb = toRGB(color);
    return '#' + hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]);
  } catch { return fallback; }
}

/** Cheap comparison key for an option object. */
function signature(o) {
  try { return JSON.stringify(o); } catch { return String(Math.random()); }
}

/**
 * Replay a property assigned before upgrade. Without this, el.seed = 'x' on a
 * not-yet-defined element writes an own property that shadows the accessor for
 * good.
 */
function upgradeProperty(el, name) {
  if (!Object.prototype.hasOwnProperty.call(el, name)) return;
  const value = el[name];
  delete el[name];
  el[name] = value;
}

/* registration */

/**
 * Idempotent, so several modules can each import this file. A second define()
 * of the same tag throws NotSupportedError and takes the importing module with
 * it.
 *
 * @param {string} [tag] alternative tag name, to dodge a collision
 * @returns {typeof OrbElement|null} the constructor actually registered
 */
export function defineOrbElement(tag = TAG) {
  if (typeof customElements === 'undefined' || typeof HTMLElement !== 'function') return null;
  const existing = customElements.get(tag);
  if (existing) return existing;
  try {
    customElements.define(tag, tag === TAG ? OrbElement : class extends OrbElement {});
  } catch (err) {
    // Lost a race with another copy of this module, or the name belongs to
    // something else. Either way, do not break the importing page.
    warn('could not define <' + tag + '>');
    try { console.error(err); } catch { /* muted console */ }
  }
  return customElements.get(tag) || null;
}

defineOrbElement();

export default OrbElement;
