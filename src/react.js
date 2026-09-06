/**
 * React wrapper.
 * Earl Balai · zero dependencies · native ES module · no build step
 *
 * This file NEVER imports React. Orb ships as plain ES modules a browser loads
 * directly, and a bare import of "react" is a hard 404 on any page without a
 * bundler or an import map, including pages that only want the vanilla orb. So
 * React gets borrowed, in this order:
 *
 *   1. passed in    createOrbReact(React)  /  useOrb(opts, React)
 *   2. registered   setReact(React)          once, at your app entry
 *   3. ambient      globalThis.React         the UMD build on a plain page
 *
 * Anything with { createElement, useRef, useState, useEffect } will do. It does
 * not have to be React, which keeps this testable and makes Preact/compat a
 * drop-in.
 *
 *     import { Orb } from './src/react.js';
 *     <Orb seed="agent-7" size={160} state="speaking" audio={remoteStream} />
 *
 *     const { ref, orb } = useOrb({ seed: 'agent-7', size: 160 });
 *     return <div ref={ref} />;
 *
 * Unmount tears down everything: the orb leaves the shared rAF loop, drops its
 * GL registration, and any audio this component started is stopped.
 */

import { createOrb, isSupported, identityForSeed, STATES, ARCHETYPES } from './orb.js';

/* borrowing React */

let registered = null;

/**
 * Call once at your app entry when React is bundled and therefore not on
 * globalThis.
 *
 * @param {object} React createElement plus the hooks
 * @returns {object} the same object, for chaining
 */
export function setReact(React) {
  registered = React || null;
  return React;
}

/** The React in use, or null if none has turned up yet. */
export function getReact() {
  return registered || ambientReact();
}

function ambientReact() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  if (!g) return null;
  return g.React || (g.window && g.window.React) || null;
}

/**
 * Resolve React, or say how to supply it. Beats a "useRef of undefined" ten
 * frames deep.
 */
function resolveReact(hint, needCreateElement) {
  const React = hint || registered || ambientReact();
  const ok = React
    && typeof React.useRef === 'function'
    && typeof React.useState === 'function'
    && typeof React.useEffect === 'function'
    && (!needCreateElement || typeof React.createElement === 'function');
  if (!ok) {
    throw new Error(
      '[Orb/react] no React found. Pass it in with createOrbReact(React) or ' +
      'useOrb(options, React), or call setReact(React) once at your entry ' +
      'point, or expose it as globalThis.React.');
  }
  return React;
}

/* options */

/** Props that configure the orb. Everything else goes to the host div. */
const ORB_PROPS = [
  'seed', 'size', 'state', 'archetype', 'palette', 'background',
  'lens', 'animate', 'dpr', 'bevel', 'respectReducedMotion', 'ariaLabel',
];

/** Ours. Never reaches the DOM. */
const OWN_PROPS = ORB_PROPS.concat(['level', 'audio', 'audioOptions', 'onOrb', 'react', 'children']);

/** undefined is dropped rather than passed on, so the core's defaults survive. */
function orbOptions(props) {
  const out = {};
  for (const key of ORB_PROPS) if (props[key] !== undefined) out[key] = props[key];
  return out;
}

/** Everything else, so <Orb onClick id title data-*> behaves like a div. */
function passthrough(props) {
  const out = {};
  for (const key of Object.keys(props)) {
    if (OWN_PROPS.indexOf(key) === -1) out[key] = props[key];
  }
  return out;
}

/**
 * Stable dependency key. Props like palette are objects reallocated every
 * render, so comparing by identity would push a full option patch (and a full
 * DOM walk for background:'auto') through the orb sixty times a second.
 */
function optionsKey(o) {
  try { return JSON.stringify([o.seed, o.size, o.archetype, o.palette, o.background, o.lens, o.animate, o.dpr, o.bevel, o.respectReducedMotion, o.ariaLabel]); } catch {
    return String(Math.random());
  }
}

/* the hook */

/**
 * Mount an orb into an element you render yourself.
 *
 *     const { ref, orb, supported } = useOrb({
 *       seed: 'agent-7', size: 160, state, audio: remoteStream,
 *     });
 *     return <div ref={ref} />;
 *
 * Created once, then patched. A new seed morphs it, a new size resizes it,
 * neither restarts it. A new audio prop rebinds and releases the old binding.
 * Unmounting destroys everything.
 *
 * @param {object} [options] orb options, plus level and audio / audioOptions
 * @param {object} [React] your React, if neither registered nor ambient
 * @returns {{ref: object, orb: object|null, supported: boolean, identity: object}}
 */
export function useOrb(options = {}, React) {
  const R = resolveReact(React || options.react, false);
  const { useRef, useState, useEffect } = R;

  const hostRef = useRef(null);
  const orbRef = useRef(null);
  const [orb, setOrb] = useState(null);

  const opts = orbOptions(options);
  const key = optionsKey(opts);

  // Assigned during render, so the mount effect builds with the props of the
  // commit that mounted it, not the first render's.
  const optsRef = useRef(opts);
  const keyRef = useRef(key);
  const audioOptsRef = useRef(options.audioOptions);
  optsRef.current = opts;
  keyRef.current = key;
  audioOptsRef.current = options.audioOptions;

  const sigRef = useRef(null);

  /* mount / unmount. The only effect that creates or destroys anything. */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let instance = null;
    try {
      instance = createOrb(host, optsRef.current);
    } catch (err) {
      try { console.error('[Orb/react] could not create the orb', err); } catch { /* muted */ }
      return undefined;
    }
    orbRef.current = instance;
    // The patch effect below runs right after this one on the same commit.
    // Recording the signature here stops it re-applying what we just built with.
    sigRef.current = keyRef.current;
    setOrb(instance);
    return () => {
      orbRef.current = null;
      // No setOrb(null) on purpose. Either the component is unmounting and
      // nothing will read it, or StrictMode is remounting and setOrb(next) lands
      // a tick later. Writing null in between just wastes a render.
      try { instance.destroy(); } catch { /* already gone */ }
    };
  }, []);

  /* configuration patches */
  useEffect(() => {
    const o = orbRef.current;
    if (!o) return;
    if (sigRef.current === key) return;
    sigRef.current = key;
    try {
      o.update(optsRef.current);
    } catch (err) {
      try { console.error('[Orb/react] rejected that option patch', err); } catch { /* muted */ }
    }
  }, [orb, key]);

  /* agent state. Separate because setState is a free no-op when unchanged, and
     voice SDKs re-emit the same state on every audio chunk. */
  const state = options.state;
  useEffect(() => {
    const o = orbRef.current;
    if (!o || state === undefined) return;
    try { o.setState(state); } catch (err) {
      try { console.error('[Orb/react] unknown state', err); } catch { /* muted */ }
    }
  }, [orb, state]);

  /* hand-driven amplitude */
  const level = options.level;
  useEffect(() => {
    const o = orbRef.current;
    if (o && level !== undefined) o.level = Number(level) || 0;
  }, [orb, level]);

  /* audio. Cleanup is the core's own disposer, which releases only this
     binding, so five orbs sharing one microphone keep listening. */
  const audio = options.audio;
  useEffect(() => {
    const o = orbRef.current;
    if (!o) return undefined;
    if (audio == null) { o.unlisten(); return undefined; }
    let stop = null;
    try {
      stop = o.listenTo(audio, audioOptsRef.current);
    } catch (err) {
      try { console.error('[Orb/react] could not bind that audio source', err); } catch { /* muted */ }
      return undefined;
    }
    return () => { try { stop(); } catch { /* already gone */ } };
  }, [orb, audio]);

  return {
    ref: hostRef,
    orb,
    supported: orb ? !!orb.supported : isSupported(),
    identity: identityForSeed(options.seed),
  };
}

/* the component */

/**
 * Bind the component to one React. For when React is bundled and you would
 * rather not register it globally.
 *
 * @param {object} React
 * @returns {Function} the <Orb /> component
 */
export function createOrbComponent(React) {
  const R = resolveReact(React, true);
  const Component = (props) => renderOrb(R, props);
  Component.displayName = 'Orb';
  return Component;
}

/**
 * Everything, bound to one React.
 *
 *     const { Orb, useOrb } = createOrbReact(React);
 *
 * @param {object} React
 * @returns {{Orb: Function, useOrb: Function}}
 */
export function createOrbReact(React) {
  const R = resolveReact(React, true);
  return {
    Orb: createOrbComponent(R),
    useOrb: (options) => useOrb(options, R),
  };
}

/** @private Shared render body. */
function renderOrb(R, props) {
  const { ref, orb } = useOrb(props, R);

  /* onOrb, the escape hatch to the live instance.
   *
   * Delivery is tracked per INSTANCE, not per callback identity, so an inline
   * arrow (how most people write this prop) fires once when the orb appears
   * rather than on every render. A callback supplied later still gets the
   * instance, since nothing has delivered it yet. */
  const onOrb = props.onOrb;
  const onOrbRef = R.useRef(null);
  const deliveredRef = R.useRef(null);
  onOrbRef.current = typeof onOrb === 'function' ? onOrb : null;
  R.useEffect(() => {
    const fn = onOrbRef.current;
    if (!fn) return undefined;
    const seen = deliveredRef.current;
    if (seen && seen.orb === orb) return undefined;
    deliveredRef.current = { orb };
    try { fn(orb); } catch (err) {
      try { console.error('[Orb/react] onOrb threw', err); } catch { /* muted */ }
    }
    return undefined;
  }, [orb, onOrb]);

  /* The one guaranteed null, meaning the instance is gone. Mount-scoped so a
   * changing callback identity cannot fire it spuriously. */
  R.useEffect(() => () => {
    const fn = onOrbRef.current;
    if (fn) { try { fn(null); } catch { /* consumer's problem, not ours */ } }
  }, []);

  const size = props.size === undefined ? 320 : Number(props.size) || 320;
  const rest = passthrough(props);
  const style = Object.assign({
    display: 'inline-block',
    position: 'relative',
    width: size + 'px',
    height: size + 'px',
    lineHeight: 0,
    flex: '0 0 auto',
  }, rest.style);
  delete rest.style;

  // The orb appends its own clipped canvas and bevel into this div, so as far
  // as React is concerned the div stays childless. Otherwise reconciliation and
  // the orb fight over the same nodes.
  return R.createElement('div', Object.assign({}, rest, { ref, style }));
}

/**
 * <Orb />, resolving React lazily at render time.
 *
 * Props: seed, size, state, archetype, palette, background, lens, animate, dpr,
 * level, audio, audioOptions, onOrb, plus any div prop (className, style, id,
 * onClick, data-*, aria-*).
 *
 * audio takes anything the core takes: a MediaStream, a track, an <audio>
 * element, an AnalyserNode, an AudioNode, a (t) => 0..1 function, a number,
 * 'microphone', 'speech', 'synthetic', or null to detach.
 */
export function Orb(props) {
  return renderOrb(resolveReact(props && props.react, true), props);
}
Orb.displayName = 'Orb';

/** Re-exported so a state prop can be typed without a second import. */
export { STATES, ARCHETYPES };

export default Orb;
