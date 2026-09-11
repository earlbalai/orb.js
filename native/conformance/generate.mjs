/**
 * Conformance vector generator.
 *
 * Drives the real `src/orb.js` (identity, palette) and its `advanceDynamics`
 * (extracted verbatim from the source text, so it cannot drift) and writes the
 * results out as test fixtures for every native port:
 *
 *   native/conformance/vectors.json                 canonical
 *   native/apple/Tests/OrbKitTests/ConformanceVectors.swift
 *   native/android/orb/src/test/kotlin/com/earlbalai/orb/ConformanceVectors.kt
 *   native/windows/tests/conformance_vectors.h
 *
 * Run:  node native/conformance/generate.mjs
 *
 * A native port passes when, for every seed, it reproduces hash / palette /
 * archetype / phase / spin / timeOffset exactly, and for the dynamics scenario
 * it tracks stateBlend, the two envelopes and the spin integrator within the
 * tolerances documented in SPEC.md.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const orbPath = resolve(root, 'src', 'orb.js');

const orb = await import(pathToFileURL(orbPath).href);

/* ---------------------------------------------------------------- identity */

const SEEDS = [
  '', 'a', 'agent-42', 'agent-43', 'Agent-42', 'orb', 'Orb.js', 'hello world',
  '0', '1', '42', '12345678901234567890', 'user_7f3a9c', 'c0ffee', 'the quick brown fox',
  'sk-live-abcdef', 'ゆき', 'émilie', '🪐', 'seed with spaces  ', 'UPPER', 'lower',
  'a'.repeat(64), 'x'.repeat(200),
];

const hexToRGB = (hex) => {
  const h = hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};

const identity = SEEDS.map((seed) => {
  const id = orb.identityForSeed(seed);
  return {
    seed,
    hash: id.hash,
    hue: id.palette.hue,
    archetype: id.archetype,
    archetypeIndex: orb.ARCHETYPES.indexOf(id.archetype),
    phase: id.phase,
    spin: id.spin,
    timeOffset: id.timeOffset,
    anchor: id.palette.anchor,
    accents: id.palette.accents,
    anchorRGB: hexToRGB(id.palette.anchor),
    accentsRGB: id.palette.accents.map(hexToRGB),
  };
});

const palettes = orb.HUES.map((hue, i) => ({
  hue,
  anchor: orb.PALETTES[i].anchor,
  accents: orb.PALETTES[i].accents,
}));

// makePalette on hues that are not in the built-in table, for custom-hue ports.
const customHues = [0, 7.5, 90, 180, 200.25, 359.9, 360, 720, -30, 1e6].map((hue) => {
  const p = orb.makePalette(hue);
  return { input: hue, hue: p.hue, anchor: p.anchor, accents: p.accents };
});

/* ---------------------------------------------------------------- dynamics */

// Pull advanceDynamics and the helpers it closes over straight out of the
// module text. Keeping a second copy here would defeat the purpose.
const src = readFileSync(orbPath, 'utf8');
function extract(re) {
  const m = src.match(re);
  if (!m) throw new Error('generate.mjs: could not locate ' + re);
  return m[0];
}
const body = [
  extract(/const clamp01 = [^\n]+/),
  extract(/const clamp = [^\n]+/),
  extract(/const STATE_TAU = [^\n]+/),
  extract(/const lerpRate = [^\n]+/),
  extract(/const REF_DT = [^\n]+/),
  extract(/function smoothstep\(e0, e1, x\) \{[\s\S]*?\n\}/),
  extract(/const stateBasis = [^\n]+/),
  extract(/function advanceDynamics\(s, t\) \{[\s\S]*?\n\}/),
  'return advanceDynamics;',
].join('\n');
const advanceDynamics = new Function(body)();

// The scenario. Everything here has to be reproducible in Swift, Kotlin and
// C++ with plain double math, so the level is the synthetic envelope from
// OrbAudioSource.synthetic() and the state schedule is a step function.
const DT = 1 / 60;
const STEPS = 600;                    // ten seconds
const SAMPLE_EVERY = 30;              // every half second

function syntheticLevel(t) {
  const phrase = 0.55 + 0.45 * Math.sin(0.9 * t + 2 * Math.sin(0.37 * t));
  const syllable = 0.6 + 0.4 * Math.sin(6.2 * t + 3 * Math.sin(2.3 * t));
  const breath = Math.sin(0.7 * t + 1.7) > -0.6 ? 1 : 0.12;
  return phrase * syllable * breath;
}
function stateAt(t) {
  if (t < 1) return 0;      // idle
  if (t < 3) return 1;      // listening
  if (t < 5) return 2;      // thinking
  if (t < 9) return 3;      // speaking
  return 0;                 // hang-up: speaking -> idle
}

function runScenario(seed) {
  const id = orb.identityForSeed(seed);
  const s = {
    phase: id.phase, level: 0, drive: 0, audioSlow: 0, audioFast: 0,
    spin: id.spin, spinVel: 0, spinDir: 1, prevFast: 0,
    flipQueued: false, oscSign: 1, lastT: null,
    state: 0, stateBlend: 0, stateSettling: false, stateW: [1, 0, 0, 0],
  };
  // Mount semantics: time starts at the identity offset, first state is instant.
  let time = id.timeOffset;
  const samples = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i * DT;
    s.state = stateAt(t);
    s.level = syntheticLevel(t);
    if (i > 0) time += DT;
    advanceDynamics(s, time);
    if (i % SAMPLE_EVERY === 0) {
      samples.push({
        step: i, time,
        stateBlend: s.stateBlend, drive: s.drive,
        audioSlow: s.audioSlow, audioFast: s.audioFast,
        spin: s.spin, spinVel: s.spinVel, spinDir: s.spinDir,
      });
    }
  }
  return { seed, dt: DT, steps: STEPS, sampleEvery: SAMPLE_EVERY, samples };
}

const dynamics = ['agent-42', 'orb', ''].map(runScenario);

/* ------------------------------------------------------------------- write */

const out = {
  generatedFrom: 'src/orb.js@' + orb.version,
  tolerances: {
    identity: 'exact (hash, indices, hex); phase/spin/timeOffset to 1e-9',
    dynamics: 'stateBlend/audioSlow/audioFast/drive abs 1e-4; spin abs 2e-3; spinVel abs 2e-3; spinDir exact',
  },
  hues: orb.HUES,
  archetypes: orb.ARCHETYPES,
  states: orb.STATES,
  palettes,
  customHues,
  identity,
  dynamics,
};

writeFileSync(resolve(here, 'vectors.json'), JSON.stringify(out, null, 2) + '\n');

/* Swift */
const swiftStr = (s) => JSON.stringify(s);
const swiftArr = (a) => '[' + a.join(', ') + ']';
let swift = `// Generated by native/conformance/generate.mjs from ${out.generatedFrom}. Do not edit.
// swiftlint:disable all
import Foundation

struct IdentityVector {
  let seed: String; let hash: UInt32; let hue: Double; let archetypeIndex: Int
  let phase: Double; let spin: Double; let timeOffset: Double
  let anchor: String; let accents: [String]
}
struct DynamicsSample {
  let step: Int; let time: Double; let stateBlend: Double; let drive: Double
  let audioSlow: Double; let audioFast: Double; let spin: Double; let spinVel: Double; let spinDir: Double
}
struct DynamicsVector { let seed: String; let dt: Double; let steps: Int; let sampleEvery: Int; let samples: [DynamicsSample] }
struct PaletteVector { let hue: Double; let anchor: String; let accents: [String] }
struct CustomHueVector { let input: Double; let hue: Double; let anchor: String; let accents: [String] }

enum ConformanceVectors {
  static let hues: [Double] = ${swiftArr(orb.HUES)}
  static let palettes: [PaletteVector] = [
${palettes.map((p) => `    PaletteVector(hue: ${p.hue}, anchor: ${swiftStr(p.anchor)}, accents: ${swiftArr(p.accents.map(swiftStr))}),`).join('\n')}
  ]
  static let customHues: [CustomHueVector] = [
${customHues.map((p) => `    CustomHueVector(input: ${p.input}, hue: ${p.hue}, anchor: ${swiftStr(p.anchor)}, accents: ${swiftArr(p.accents.map(swiftStr))}),`).join('\n')}
  ]
  static let identity: [IdentityVector] = [
${identity.map((v) => `    IdentityVector(seed: ${swiftStr(v.seed)}, hash: ${v.hash}, hue: ${v.hue}, archetypeIndex: ${v.archetypeIndex}, phase: ${v.phase}, spin: ${v.spin}, timeOffset: ${v.timeOffset}, anchor: ${swiftStr(v.anchor)}, accents: ${swiftArr(v.accents.map(swiftStr))}),`).join('\n')}
  ]
  static let dynamics: [DynamicsVector] = [
${dynamics.map((d) => `    DynamicsVector(seed: ${swiftStr(d.seed)}, dt: ${d.dt}, steps: ${d.steps}, sampleEvery: ${d.sampleEvery}, samples: [
${d.samples.map((s) => `      DynamicsSample(step: ${s.step}, time: ${s.time}, stateBlend: ${s.stateBlend}, drive: ${s.drive}, audioSlow: ${s.audioSlow}, audioFast: ${s.audioFast}, spin: ${s.spin}, spinVel: ${s.spinVel}, spinDir: ${s.spinDir}),`).join('\n')}
    ]),`).join('\n')}
  ]
}
`;
writeFileSync(resolve(root, 'native/apple/Tests/OrbKitTests/ConformanceVectors.swift'), swift);

/* Kotlin */
const ktStr = (s) => JSON.stringify(s).replace(/\$/g, '\$');
const ktList = (a) => 'listOf(' + a.join(', ') + ')';
// Every Double literal has to look like one to the Kotlin compiler.
const kd = (n) => Number.isInteger(n) ? n.toFixed(1) : String(n);
let kotlin = `package com.earlbalai.orb

internal data class IdentityVector(
  val seed: String, val hash: Long, val hue: Double, val archetypeIndex: Int,
  val phase: Double, val spin: Double, val timeOffset: Double,
  val anchor: String, val accents: List<String>,
)
internal data class DynamicsSample(
  val step: Int, val time: Double, val stateBlend: Double, val drive: Double,
  val audioSlow: Double, val audioFast: Double, val spin: Double, val spinVel: Double, val spinDir: Double,
)
internal data class DynamicsVector(val seed: String, val dt: Double, val steps: Int, val sampleEvery: Int, val samples: List<DynamicsSample>)
internal data class PaletteVector(val hue: Double, val anchor: String, val accents: List<String>)
internal data class CustomHueVector(val input: Double, val hue: Double, val anchor: String, val accents: List<String>)

internal object ConformanceVectors {
  val hues: List<Double> = ${ktList(orb.HUES.map(kd))}
  val palettes: List<PaletteVector> = listOf(
${palettes.map((p) => `    PaletteVector(${kd(p.hue)}, ${ktStr(p.anchor)}, ${ktList(p.accents.map(ktStr))}),`).join('\n')}
  )
  val customHues: List<CustomHueVector> = listOf(
${customHues.map((p) => `    CustomHueVector(${kd(p.input)}, ${kd(p.hue)}, ${ktStr(p.anchor)}, ${ktList(p.accents.map(ktStr))}),`).join('\n')}
  )
  val identity: List<IdentityVector> = listOf(
${identity.map((v) => `    IdentityVector(${ktStr(v.seed)}, ${v.hash}L, ${kd(v.hue)}, ${v.archetypeIndex}, ${kd(v.phase)}, ${kd(v.spin)}, ${kd(v.timeOffset)}, ${ktStr(v.anchor)}, ${ktList(v.accents.map(ktStr))}),`).join('\n')}
  )
  val dynamics: List<DynamicsVector> = listOf(
${dynamics.map((d) => `    DynamicsVector(${ktStr(d.seed)}, ${kd(d.dt)}, ${d.steps}, ${d.sampleEvery}, listOf(
${d.samples.map((s) => `      DynamicsSample(${s.step}, ${kd(s.time)}, ${kd(s.stateBlend)}, ${kd(s.drive)}, ${kd(s.audioSlow)}, ${kd(s.audioFast)}, ${kd(s.spin)}, ${kd(s.spinVel)}, ${kd(s.spinDir)}),`).join('\n')}
    )),`).join('\n')}
  )
}
`;
kotlin = `// Generated by native/conformance/generate.mjs from ${out.generatedFrom}. Do not edit.\n` + kotlin;
writeFileSync(resolve(root, 'native/android/orb/src/test/kotlin/com/earlbalai/orb/ConformanceVectors.kt'), kotlin);

/* C++ */
const cStr = (s) => JSON.stringify(s);   // UTF-8 source; MSVC is built with /utf-8
let cpp = `// Generated by native/conformance/generate.mjs from ${out.generatedFrom}. Do not edit.
#pragma once
#include <cstdint>
#include <vector>
#include <string>

namespace orb_conformance {

struct IdentityVector {
  const char* seed; uint32_t hash; double hue; int archetypeIndex;
  double phase; double spin; double timeOffset;
  const char* anchor; const char* accents[3];
};
struct DynamicsSample {
  int step; double time; double stateBlend; double drive;
  double audioSlow; double audioFast; double spin; double spinVel; double spinDir;
};
struct DynamicsVector { const char* seed; double dt; int steps; int sampleEvery; std::vector<DynamicsSample> samples; };
struct PaletteVector { double hue; const char* anchor; const char* accents[3]; };
struct CustomHueVector { double input; double hue; const char* anchor; const char* accents[3]; };

inline const std::vector<double> hues = {${orb.HUES.join(', ')}};

inline const std::vector<PaletteVector> palettes = {
${palettes.map((p) => `  {${p.hue}, ${cStr(p.anchor)}, {${p.accents.map(cStr).join(', ')}}},`).join('\n')}
};

inline const std::vector<CustomHueVector> customHues = {
${customHues.map((p) => `  {${p.input}, ${p.hue}, ${cStr(p.anchor)}, {${p.accents.map(cStr).join(', ')}}},`).join('\n')}
};

inline const std::vector<IdentityVector> identity = {
${identity.map((v) => `  {${cStr(v.seed)}, ${v.hash}u, ${v.hue}, ${v.archetypeIndex}, ${v.phase}, ${v.spin}, ${v.timeOffset}, ${cStr(v.anchor)}, {${v.accents.map(cStr).join(', ')}}},`).join('\n')}
};

inline const std::vector<DynamicsVector> dynamics = {
${dynamics.map((d) => `  {${cStr(d.seed)}, ${d.dt}, ${d.steps}, ${d.sampleEvery}, {
${d.samples.map((s) => `    {${s.step}, ${s.time}, ${s.stateBlend}, ${s.drive}, ${s.audioSlow}, ${s.audioFast}, ${s.spin}, ${s.spinVel}, ${s.spinDir}},`).join('\n')}
  }},`).join('\n')}
};

} // namespace orb_conformance
`;
writeFileSync(resolve(root, 'native/windows/tests/conformance_vectors.h'), cpp);

/* GLSL galaxy for Android: the dialect is the same, so it is copied verbatim. */
const glslKt = `// Generated by native/conformance/generate.mjs from ${out.generatedFrom}. Do not edit.
// GLSL_GALAXY from src/orb.js, verbatim. The GLES 2.0 dialect is WebGL1's dialect.
package com.earlbalai.orb

internal const val ORB_GLSL_GALAXY: String = \"\"\"${orb.GLSL.GLSL_GALAXY}\"\"\"
`;
writeFileSync(resolve(root, 'native/android/orb/src/main/kotlin/com/earlbalai/orb/OrbGalaxyGlsl.kt'), glslKt);

console.log(`wrote ${identity.length} identity vectors, ${palettes.length} palettes, ${customHues.length} custom hues, ${dynamics.length} dynamics scenarios`);
