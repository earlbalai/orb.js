/*
 * OrbAudioSource.kt
 *
 * A level in 0..1, sampled once per frame. The two speech envelopes live in
 * OrbDynamics, so a source hands over raw loudness and nothing else.
 *
 * Reference measurement (SPEC.md §5): RMS over the most recent 512 mono samples,
 * level = min(1, gain * rms), gain 3.2 for speech.
 */
package com.earlbalai.orb

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

open class OrbAudioSource(
  val kind: Kind = Kind.CUSTOM,
  private var dispose: (() -> Unit)? = null,
  private val sample: (Double) -> Double = { 0.0 },
) {
  enum class Kind { CUSTOM, CONSTANT, SYNTHETIC, PCM, MICROPHONE }

  /** Last sampled level, 0..1. */
  @Volatile var level: Double = 0.0; private set
  private val active = AtomicBoolean(false)
  private val stopped = AtomicBoolean(false)
  private val subscribers = CopyOnWriteArrayList<(Double) -> Unit>()
  @Volatile private var lastTick = Double.NaN

  val isActive: Boolean get() = active.get()
  val isStopped: Boolean get() = stopped.get()

  /** Begin sampling. Idempotent. No-op once stopped. */
  fun start(): OrbAudioSource {
    if (!stopped.get()) active.set(true)
    return this
  }

  /**
   * Stop and release whatever the source owns. Terminal: build a fresh one instead of
   * restarting a stopped source.
   */
  fun stop(): OrbAudioSource {
    if (!stopped.compareAndSet(false, true)) return this
    active.set(false)
    level = 0.0
    subscribers.forEach { it(0.0) }
    val d = dispose; dispose = null
    try { d?.invoke() } catch (_: Throwable) {}
    try { onDispose() } catch (_: Throwable) {}
    return this
  }

  /** Sample the level at time `t`. Subclasses with their own measurement override this. */
  protected open fun sampleAt(t: Double): Double = sample(t)

  /** Release hook for subclasses. */
  protected open fun onDispose() {}

  /** Subscribe to the raw level, once per rendered frame. Returns an unsubscribe. */
  fun onLevel(fn: (Double) -> Unit): () -> Unit {
    subscribers.add(fn)
    return { subscribers.remove(fn) }
  }

  /** Called by every view that listens, once per frame. Shared sources sample once per timestamp. */
  internal fun tick(t: Double) {
    if (!active.get() || t == lastTick) return
    lastTick = t
    val raw = sampleAt(t)
    val v = if (raw.isFinite()) OrbMath.clamp01(raw) else 0.0
    level = v
    subscribers.forEach { it(v) }
  }

  companion object {
    /** A constant level, for a quick poke. */
    fun constant(v: Double): OrbAudioSource = OrbAudioSource(Kind.CONSTANT) { v }

    /** Your own function of time. */
    fun custom(fn: (Double) -> Double): OrbAudioSource = OrbAudioSource(Kind.CUSTOM, sample = fn)

    /** Silent, permission-free speech-shaped envelope. */
    fun synthetic(): OrbAudioSource = OrbAudioSource(Kind.SYNTHETIC) { t ->
      val phrase = 0.55 + 0.45 * sin(0.9 * t + 2 * sin(0.37 * t))
      val syllable = 0.6 + 0.4 * sin(6.2 * t + 3 * sin(2.3 * t))
      val breath = if (sin(0.7 * t + 1.7) > -0.6) 1.0 else 0.12
      phrase * syllable * breath
    }

    /**
     * A push-based PCM source. Feed it from any audio callback: an `AudioTrack` you are
     * writing to, a WebRTC / LiveKit audio sink, your own decoder. Thread-safe.
     */
    fun pcm(gain: Double = 3.2, window: Int = 512): OrbPCMSource = OrbPCMSource(gain, window)

    /**
     * The live microphone through [AudioRecord]. The app must hold RECORD_AUDIO;
     * this throws [SecurityException] / [IllegalStateException] otherwise.
     */
    @SuppressLint("MissingPermission")
    fun microphone(gain: Double = 3.2, sampleRate: Int = 48000): OrbPCMSource {
      val minBuf = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      check(minBuf > 0) { "[Orb] microphone: no usable AudioRecord configuration at $sampleRate Hz" }
      val rec = AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION, sampleRate,
        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, 4096),
      )
      check(rec.state == AudioRecord.STATE_INITIALIZED) { "[Orb] microphone: AudioRecord failed to initialise" }
      val src = OrbPCMSource(gain, 512, Kind.MICROPHONE)
      val running = AtomicBoolean(true)
      val thread = Thread({
        val buf = ShortArray(512)
        rec.startRecording()
        while (running.get()) {
          val n = rec.read(buf, 0, buf.size)
          if (n > 0) src.push(buf, n, 1) else if (n < 0) break
        }
        try { rec.stop() } catch (_: Throwable) {}
        rec.release()
      }, "OrbMicrophone").apply { isDaemon = true; start() }
      src.setDispose { running.set(false); thread.interrupt() }
      return src
    }
  }
}

/** Ring buffer of the last `window` mono samples; RMS on demand at frame time. */
class OrbPCMSource internal constructor(
  private val gain: Double,
  window: Int,
  kind: Kind = Kind.PCM,
) : OrbAudioSource(kind) {

  private val ring = FloatArray(maxOf(64, window))
  private var head = 0
  private var filled = 0
  private val lock = Any()
  private var disposeHook: (() -> Unit)? = null

  internal fun setDispose(fn: () -> Unit) { disposeHook = fn }

  override fun sampleAt(t: Double): Double = rms()
  override fun onDispose() { disposeHook?.invoke() }

  /** Push interleaved float samples in -1..1. Channels are averaged to mono. */
  fun push(samples: FloatArray, count: Int = samples.size, channels: Int = 1) {
    if (channels <= 0 || count < channels) return
    val frames = count / channels
    val inv = 1f / channels
    synchronized(lock) {
      for (i in 0 until frames) {
        var s = 0f
        for (c in 0 until channels) s += samples[i * channels + c]
        ring[head] = s * inv
        head = (head + 1) % ring.size
        if (filled < ring.size) filled++
      }
    }
  }

  /** Push interleaved 16-bit PCM. */
  fun push(samples: ShortArray, count: Int = samples.size, channels: Int = 1) {
    if (channels <= 0 || count < channels) return
    val frames = count / channels
    val inv = 1f / (channels * 32768f)
    synchronized(lock) {
      for (i in 0 until frames) {
        var s = 0f
        for (c in 0 until channels) s += samples[i * channels + c].toFloat()
        ring[head] = s * inv
        head = (head + 1) % ring.size
        if (filled < ring.size) filled++
      }
    }
  }

  /** Push interleaved 16-bit little-endian PCM bytes, as most codecs and `AudioTrack` feeds hand over. */
  fun push(bytes: ByteBuffer, channels: Int = 1) {
    val bb = bytes.duplicate().order(ByteOrder.LITTLE_ENDIAN)
    val n = bb.remaining() / 2
    if (n < channels) return
    val tmp = ShortArray(n)
    bb.asShortBuffer().get(tmp)
    push(tmp, n, channels)
  }

  private fun rms(): Double {
    synchronized(lock) {
      if (filled == 0) return 0.0
      var sum = 0.0
      for (i in 0 until filled) { val x = ring[i].toDouble(); sum += x * x }
      return min(1.0, gain * sqrt(sum / filled))
    }
  }
}
