//  OrbDynamics.swift
//  OrbKit
//
//  The per-frame state machine: state crossfade, two asymmetric audio envelopes and
//  the spin integrator. A line-for-line port of advanceDynamics() in src/orb.js,
//  pinned by the dynamics scenario in the conformance test. See native/SPEC.md §3.

import Foundation

/// State crossfade time constant, seconds. 1 - exp(-0.35/0.12) is ~94.5%.
let orbStateTau = 0.12

/// Frame time the transient constants were tuned at.
private let refDt = 1.0 / 60.0

/// Everything the shader needs per orb that changes over time, plus the accumulators
/// that produce it. Value type; the view owns one and advances it once per frame.
public struct OrbDynamics: Equatable, Sendable {
  // Identity inputs
  public var phase: Double = 0

  // Inputs written by the host between frames
  /// Raw 0...1 amplitude from the audio source.
  public var level: Double = 0
  /// Target state, continuous on 0...3. `2.5` is a legitimate half-thinking, half-speaking pose.
  public var state: Double = 0

  // Outputs read by the renderer
  /// The eased scalar the shader sees as `uState`.
  public private(set) var stateBlend: Double = 0
  /// True while a crossfade is still in flight, so a paused orb keeps drawing until it lands.
  public private(set) var stateSettling = false
  /// The four normalised state weights.
  public private(set) var stateWeights: [Double] = [1, 0, 0, 0]
  /// State-gated drive the envelopes actually track.
  public private(set) var drive: Double = 0
  /// 110 ms / 300 ms envelope. Drives colour. This is `uAudio`.
  public private(set) var audioSlow: Double = 0
  /// 40 ms / 180 ms envelope. Drives motion.
  public private(set) var audioFast: Double = 0
  /// Integrated spin angle, radians. `uSpin`.
  public var spin: Double = 0
  public private(set) var spinVel: Double = 0
  public private(set) var spinDir: Double = 1

  // Private accumulators
  private var prevFast: Double = 0
  private var flipQueued = false
  private var oscSign: Double = 1
  private var lastT: Double? = nil

  public init() {}

  /// Re-seed. Resets the clock reference so the next frame does not see a huge dt.
  mutating func reseed(_ id: OrbIdentity) {
    phase = id.phase
    if spin == 0 { spin = id.spin }
    lastT = nil
  }

  /// Set the state target. `instant` applies it without a crossfade (mount semantics).
  mutating func setState(_ target: Double, instant: Bool) {
    let t = OrbMath.clamp(target.isFinite ? target : 0, 0, 3)
    state = t
    if instant {
      stateBlend = t
      stateSettling = false
    } else if stateBlend != t {
      stateSettling = true
    }
  }

  /// JS twin of `stateW()` in the shader. Keep them identical.
  @inline(__always) static func stateBasis(_ s: Double, _ i: Double) -> Double {
    1 - OrbMath.smoothstep(0.35, 1.0, abs(s - i))
  }

  /// Advance to animation time `t` (seconds, the orb's own clock).
  public mutating func advance(to t: Double) {
    let dt = lastT == nil ? 0 : OrbMath.clamp(t - lastT!, 0, 0.1)
    lastT = t

    // One non-finite level would poison every accumulator below permanently.
    let lvl = level.isFinite ? OrbMath.clamp01(level) : 0
    level = lvl

    let stateTarget = OrbMath.clamp(state.isFinite ? state : 0, 0, 3)
    if !stateBlend.isFinite { stateBlend = stateTarget }
    if stateBlend != stateTarget {
      stateBlend += (stateTarget - stateBlend) * OrbMath.lerpRate(dt, orbStateTau)
      if abs(stateTarget - stateBlend) < 0.002 {
        stateBlend = stateTarget
        stateSettling = false
      } else {
        stateSettling = true
      }
    } else {
      stateSettling = false
    }

    let sb = stateBlend
    var w0 = OrbDynamics.stateBasis(sb, 0), w1 = OrbDynamics.stateBasis(sb, 1)
    var w2 = OrbDynamics.stateBasis(sb, 2), w3 = OrbDynamics.stateBasis(sb, 3)
    let wSum = max(w0 + w1 + w2 + w3, 1e-4)
    w0 /= wSum; w1 /= wSum; w2 /= wSum; w3 /= wSum
    stateWeights = [w0, w1, w2, w3]

    // idle barely notices the room (22%), listening and speaking are fully reactive,
    // thinking is deaf on purpose and runs on its own cognition pulse instead.
    let gate = w0 * 0.22 + w1 + w3
    let cognition = 0.34 + 0.30 * sin(t * 3.2 + phase * 3.0) * (0.55 + 0.45 * sin(t * 1.17 + phase))
    let d = OrbMath.clamp01(lvl * gate + w2 * cognition)
    drive = d

    audioSlow += (d - audioSlow) * OrbMath.lerpRate(dt, d > audioSlow ? 0.11 : 0.30)
    audioFast += (d - audioFast) * OrbMath.lerpRate(dt, d > audioFast ? 0.04 : 0.18)

    let v = audioFast

    // Per-orb idle character, two decorrelated variates off the seed phase.
    let a = (6.31 * phase).truncatingRemainder(dividingBy: 1)
    let b = (2.17 * phase).truncatingRemainder(dividingBy: 1)
    let breathe = 0.35 * sin(t * (0.11 + 0.08 * b) + phase)

    // Direction flips queue on an oscillator zero-crossing and commit only while the
    // room is quiet, so the orb never reverses mid-syllable.
    let osc = sin(t * (0.45 + 0.2 * a) + phase)
    let sign: Double = osc > 0 ? 1 : (osc < 0 ? -1 : 1)
    if sign != oscSign { oscSign = sign; flipQueued = true }
    if flipQueued && v < 0.18 { spinDir = -spinDir; flipQueued = false }

    // Per-state spin. Thinking is ~3.5x idle at the base rate.
    let spinScale = w0 * 0.55 + w1 * 0.85 + w2 * 1.95 + w3 * 1.15

    // Signed by spinDir where real audio drives; unsigned in thinking so the cognition
    // pulse only ever adds speed.
    let audioSpin = spinDir * v * 2.2 * (w0 + w1 + w3) + v * 1.3 * w2
    let target = 0.65 * (0.65 + 0.7 * a) * (1 + breathe) * spinScale + audioSpin
    spinVel += (target - spinVel) * OrbMath.lerpRate(dt, 0.35)

    // Transient kick off the rate of rise of the fast envelope. Frame-rate independent.
    let onset = max(0, v - prevFast)
    prevFast = v
    let onsetRate = dt > 0 ? onset / dt : 0
    let kickDir = spinDir * (w0 + w1 + w3) + w2
    spinVel += kickDir * min(6 * onsetRate * refDt, 1.4) * 14 * dt

    spin += spinVel * dt

    if !spin.isFinite || !spinVel.isFinite {
      spin = 0; spinVel = 0; audioFast = 0; audioSlow = 0; prevFast = 0
      stateBlend = stateTarget; stateSettling = false
    }
  }
}
