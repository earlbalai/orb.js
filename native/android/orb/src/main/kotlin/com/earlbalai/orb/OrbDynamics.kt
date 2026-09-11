/*
 * OrbDynamics.kt
 *
 * The per-frame state machine: state crossfade, two asymmetric audio envelopes and
 * the spin integrator. A line-for-line port of advanceDynamics() in src/orb.js,
 * pinned by the dynamics scenario in ConformanceTest. See native/SPEC.md §3.
 */
package com.earlbalai.orb

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** State crossfade time constant, seconds. 1 - exp(-0.35/0.12) is ~94.5%. */
internal const val ORB_STATE_TAU = 0.12

/** Frame time the transient constants were tuned at. */
private const val REF_DT = 1.0 / 60.0

/**
 * Everything the shader needs per orb that changes over time, plus the accumulators
 * that produce it. Owned by the render thread; the view writes [level] and [state].
 */
class OrbDynamics {
  // Identity input
  var phase: Double = 0.0

  // Inputs written by the host between frames
  /** Raw 0..1 amplitude from the audio source. */
  @Volatile var level: Double = 0.0
  /** Target state, continuous on 0..3. */
  @Volatile var state: Double = 0.0

  // Outputs read by the renderer
  /** The eased scalar the shader sees as `uState`. */
  var stateBlend: Double = 0.0; private set
  /** True while a crossfade is still in flight. */
  @Volatile var stateSettling: Boolean = false; private set
  /** The four normalised state weights. */
  val stateWeights: DoubleArray = doubleArrayOf(1.0, 0.0, 0.0, 0.0)
  var drive: Double = 0.0; private set
  /** 110 ms / 300 ms envelope. Drives colour. This is `uAudio`. */
  var audioSlow: Double = 0.0; private set
  /** 40 ms / 180 ms envelope. Drives motion. */
  var audioFast: Double = 0.0; private set
  /** Integrated spin angle, radians. `uSpin`. */
  var spin: Double = 0.0
  var spinVel: Double = 0.0; private set
  var spinDir: Double = 1.0; private set

  private var prevFast = 0.0
  private var flipQueued = false
  private var oscSign = 1.0
  private var lastT: Double? = null

  /** Re-seed. Resets the clock reference so the next frame does not see a huge dt. */
  fun reseed(id: OrbIdentity) {
    phase = id.phase
    if (spin == 0.0) spin = id.spin
    lastT = null
  }

  /** Set the state target. `instant` applies it without a crossfade (mount semantics). */
  fun setState(target: Double, instant: Boolean) {
    val t = OrbMath.clamp(if (target.isFinite()) target else 0.0, 0.0, 3.0)
    state = t
    if (instant) {
      stateBlend = t
      stateSettling = false
    } else if (stateBlend != t) {
      stateSettling = true
    }
  }

  /** Advance to animation time `t` (seconds, the orb's own clock). */
  fun advance(t: Double) {
    val last = lastT
    val dt = if (last == null) 0.0 else OrbMath.clamp(t - last, 0.0, 0.1)
    lastT = t

    val lvlIn = level
    val lvl = if (lvlIn.isFinite()) OrbMath.clamp01(lvlIn) else 0.0
    level = lvl

    val stIn = state
    val stateTarget = OrbMath.clamp(if (stIn.isFinite()) stIn else 0.0, 0.0, 3.0)
    if (!stateBlend.isFinite()) stateBlend = stateTarget
    if (stateBlend != stateTarget) {
      stateBlend += (stateTarget - stateBlend) * OrbMath.lerpRate(dt, ORB_STATE_TAU)
      if (abs(stateTarget - stateBlend) < 0.002) {
        stateBlend = stateTarget
        stateSettling = false
      } else {
        stateSettling = true
      }
    } else {
      stateSettling = false
    }

    val sb = stateBlend
    var w0 = stateBasis(sb, 0.0); var w1 = stateBasis(sb, 1.0)
    var w2 = stateBasis(sb, 2.0); var w3 = stateBasis(sb, 3.0)
    val wSum = max(w0 + w1 + w2 + w3, 1e-4)
    w0 /= wSum; w1 /= wSum; w2 /= wSum; w3 /= wSum
    stateWeights[0] = w0; stateWeights[1] = w1; stateWeights[2] = w2; stateWeights[3] = w3

    // idle barely notices the room (22%), listening and speaking are fully reactive,
    // thinking is deaf on purpose and runs on its own cognition pulse instead.
    val gate = w0 * 0.22 + w1 + w3
    val cognition = 0.34 + 0.30 * sin(t * 3.2 + phase * 3.0) * (0.55 + 0.45 * sin(t * 1.17 + phase))
    val d = OrbMath.clamp01(lvl * gate + w2 * cognition)
    drive = d

    audioSlow += (d - audioSlow) * OrbMath.lerpRate(dt, if (d > audioSlow) 0.11 else 0.30)
    audioFast += (d - audioFast) * OrbMath.lerpRate(dt, if (d > audioFast) 0.04 else 0.18)

    val v = audioFast

    val a = (6.31 * phase) % 1.0
    val b = (2.17 * phase) % 1.0
    val breathe = 0.35 * sin(t * (0.11 + 0.08 * b) + phase)

    // Direction flips queue on an oscillator zero-crossing and commit only while the
    // room is quiet, so the orb never reverses mid-syllable.
    val osc = sin(t * (0.45 + 0.2 * a) + phase)
    val sign = if (osc > 0) 1.0 else if (osc < 0) -1.0 else 1.0
    if (sign != oscSign) { oscSign = sign; flipQueued = true }
    if (flipQueued && v < 0.18) { spinDir = -spinDir; flipQueued = false }

    val spinScale = w0 * 0.55 + w1 * 0.85 + w2 * 1.95 + w3 * 1.15

    val audioSpin = spinDir * v * 2.2 * (w0 + w1 + w3) + v * 1.3 * w2
    val target = 0.65 * (0.65 + 0.7 * a) * (1 + breathe) * spinScale + audioSpin
    spinVel += (target - spinVel) * OrbMath.lerpRate(dt, 0.35)

    // Transient kick off the rate of rise of the fast envelope. Frame-rate independent.
    val onset = max(0.0, v - prevFast)
    prevFast = v
    val onsetRate = if (dt > 0) onset / dt else 0.0
    val kickDir = spinDir * (w0 + w1 + w3) + w2
    spinVel += kickDir * min(6 * onsetRate * REF_DT, 1.4) * 14 * dt

    spin += spinVel * dt

    if (!spin.isFinite() || !spinVel.isFinite()) {
      spin = 0.0; spinVel = 0.0; audioFast = 0.0; audioSlow = 0.0; prevFast = 0.0
      stateBlend = stateTarget; stateSettling = false
    }
  }

  companion object {
    /** JS twin of `stateW()` in the shader. Keep them identical. */
    fun stateBasis(s: Double, i: Double): Double = 1 - OrbMath.smoothstep(0.35, 1.0, abs(s - i))
  }
}
