/*
 * OrbIdentity.kt
 *
 * Seed -> identity. A straight port of sections 3 and 4 of src/orb.js, pinned by
 * ConformanceTest. See native/SPEC.md §2.
 */
package com.earlbalai.orb

import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** The four galaxy archetypes, in shader-index order. */
enum class OrbArchetype(val index: Int) {
  SPIRAL(0), NEBULA(1), CORE(2), DEEP(3);

  val displayName: String get() = name.lowercase()

  companion object {
    fun fromIndex(i: Int): OrbArchetype = values()[i]
    fun fromName(n: String): OrbArchetype? = values().firstOrNull { it.displayName == n.lowercase() }
  }
}

/**
 * The four agent states, in shader-index order. The order is the conversational loop:
 * idle -> listening -> thinking -> speaking.
 */
enum class OrbState(val index: Int) {
  IDLE(0), LISTENING(1), THINKING(2), SPEAKING(3);

  val displayName: String get() = name.lowercase()

  companion object {
    fun fromIndex(i: Int): OrbState = values()[i.coerceIn(0, 3)]
    fun fromName(n: String): OrbState? = values().firstOrNull { it.displayName == n.lowercase() }
  }
}

/** An RGB triple in 0..1. Alpha is never part of an orb colour. */
data class OrbColor(val r: Double, val g: Double, val b: Double) {
  init {
    require(r.isFinite() && g.isFinite() && b.isFinite()) { "[Orb] colour channel is not finite" }
  }

  /** `#rrggbb`, quantised the way the reference does (round-half-up to 8 bits). */
  val hex: String
    get() = "#%02x%02x%02x".format(q8(r), q8(g), q8(b))

  /** The colour after the 8-bit round trip the palette goes through. */
  internal val quantised: OrbColor
    get() = OrbColor(q8(r) / 255.0, q8(g) / 255.0, q8(b) / 255.0)

  companion object {
    val BLACK = OrbColor(0.0, 0.0, 0.0)
    val WHITE = OrbColor(1.0, 1.0, 1.0)

    private fun q8(v: Double): Int = (255 * OrbMath.clamp01(v)).roundToInt()

    /** `#rgb`, `#rrggbb`, `rgb`, `rrggbb`; null for anything else. */
    fun fromHex(hex: String): OrbColor? {
      var s = hex.trim().removePrefix("#")
      if (s.length != 3 && s.length != 6) return null
      if (!s.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) return null
      if (s.length == 3) s = s.map { "$it$it" }.joinToString("")
      val v = s.toLong(16)
      return OrbColor(((v shr 16) and 0xff) / 255.0, ((v shr 8) and 0xff) / 255.0, (v and 0xff) / 255.0)
    }

    /** From an Android packed ARGB int. Alpha is discarded. */
    fun fromArgb(argb: Int): OrbColor =
      OrbColor(((argb shr 16) and 0xff) / 255.0, ((argb shr 8) and 0xff) / 255.0, (argb and 0xff) / 255.0)
  }
}

/** An anchor colour plus three luminance-compensated accents. */
class OrbPalette internal constructor(
  /** Degrees, 0 until 360. Null for a hand-built palette. */
  val hue: Double?,
  val anchor: OrbColor,
  val accents: List<OrbColor>,
) {
  /** A hand-built palette. */
  constructor(anchor: OrbColor, accents: List<OrbColor>) : this(null, anchor, accents) {
    require(accents.size == 3) { "[Orb] palette.accents must be exactly 3 colours" }
  }

  override fun equals(other: Any?): Boolean =
    other is OrbPalette && other.hue == hue && other.anchor == anchor && other.accents == accents
  override fun hashCode(): Int = (hue?.hashCode() ?: 0) * 31 + anchor.hashCode() * 7 + accents.hashCode()
  override fun toString(): String = "OrbPalette(hue=$hue, anchor=${anchor.hex}, accents=${accents.map { it.hex }})"

  companion object {
    /**
     * Build a palette around a hue in degrees. Yellows and greens are far brighter than
     * blues and violets at the same nominal lightness, so `k` nudges lightness up in
     * proportion to how dark the hue is.
     */
    fun ofHue(hue: Double): OrbPalette {
      val hin = if (hue.isFinite()) hue else 0.0
      val h = ((hin % 360.0) + 360.0) % 360.0
      val k = 0.2 * (1 - OrbIdentity.hueLuma(h))
      return OrbPalette(
        h,
        OrbIdentity.hsl(h, 0.85, 0.42 + k).quantised,
        listOf(
          OrbIdentity.hsl(h, 0.95, min(0.72, 0.6 + k)).quantised,
          OrbIdentity.hsl((h + 16) % 360.0, 0.8, min(0.82, 0.7 + k)).quantised,
          OrbIdentity.hsl((h + 34) % 360.0, 0.9, min(0.9, 0.8 + k)).quantised,
        ),
      )
    }
  }
}

/**
 * Everything a seed determines. Pure and stable: the same string is the same orb, on
 * every platform.
 */
class OrbIdentity(val seed: String) {
  /** Unsigned 32-bit FNV-1a hash, held in a Long. */
  val hash: Long = hashSeed(seed)
  val palette: OrbPalette = PALETTES[(hash % PALETTES.size).toInt()]
  val archetype: OrbArchetype = OrbArchetype.fromIndex(((hash ushr 16) % 4).toInt())
  /** Structural phase, seconds. Every per-orb variation in the shader comes off this. */
  val phase: Double = (hash % 6283) / 1000.0
  /** Starting spin angle, radians. */
  val spin: Double = phase * 3.7
  /** Starting clock, seconds, so two seeds are never in lockstep. */
  val timeOffset: Double = ((hash ushr 8) % 40009) / 100.0

  override fun toString(): String =
    "OrbIdentity(seed=$seed, hash=$hash, hue=${palette.hue}, archetype=${archetype.displayName}, phase=$phase)"

  companion object {
    /** The fourteen identity hues, unevenly spaced. */
    val HUES: List<Double> = listOf(13.0, 34.0, 125.0, 146.0, 166.0, 187.0, 208.0, 228.0, 249.0, 270.0, 290.0, 311.0, 332.0, 353.0)

    /** The fourteen built-in palettes, one per hue. */
    val PALETTES: List<OrbPalette> = HUES.map { OrbPalette.ofHue(it) }

    /** FNV-1a, 32-bit, over UTF-16 code units (what JS `charCodeAt` yields). Unsigned, as a Long. */
    fun hashSeed(seed: String): Long {
      var h = 0x811c9dc5.toInt()
      for (ch in seed) {
        h = h xor ch.code
        h *= 0x01000193
      }
      return h.toLong() and 0xffffffffL
    }

    /** HSL to RGB, 0..1, the CSS algorithm. */
    internal fun hsl(h: Double, s: Double, l: Double): OrbColor {
      val a = s * min(l, 1 - l)
      fun f(n: Double): Double {
        val k = (n + h / 30) % 12
        return l - a * max(-1.0, min(min(k - 3, 9 - k), 1.0))
      }
      return OrbColor(f(0.0), f(8.0), f(4.0))
    }

    /** Rec.601 luma of a fully saturated hue. */
    internal fun hueLuma(h: Double): Double {
      val c = hsl(h, 1.0, 0.5)
      return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b
    }
  }
}

internal object OrbMath {
  fun clamp01(v: Double): Double = if (v < 0) 0.0 else if (v > 1) 1.0 else v
  fun clamp(v: Double, lo: Double, hi: Double): Double = if (v < lo) lo else if (v > hi) hi else v
  /** GLSL's smoothstep, exactly, so the CPU state basis matches `stateW()` in the shader. */
  fun smoothstep(e0: Double, e1: Double, x: Double): Double {
    val t = clamp((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)
  }
  /** Frame-rate independent first-order lerp factor. */
  fun lerpRate(dt: Double, tau: Double): Double = if (dt > 0) 1 - exp(-dt / tau) else 0.0
}
