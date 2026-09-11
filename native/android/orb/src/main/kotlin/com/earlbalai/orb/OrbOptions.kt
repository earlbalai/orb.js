/*
 * OrbOptions.kt
 *
 * The option set, same names and defaults as the web module. Validation is at the
 * boundary: a bad value fails where you wrote it, not a frame later inside a uniform
 * upload.
 */
package com.earlbalai.orb

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** How the palette is chosen. */
sealed class OrbPaletteChoice {
  /** Derived from the seed (default). */
  object Auto : OrbPaletteChoice()
  /** Built around a hue in degrees. */
  data class Hue(val degrees: Double) : OrbPaletteChoice()
  /** A hand-built palette. */
  data class Custom(val palette: OrbPalette) : OrbPaletteChoice()
}

/** Archetype option: seed-derived or forced. */
sealed class OrbArchetypeChoice {
  object Auto : OrbArchetypeChoice()
  data class Fixed(val archetype: OrbArchetype) : OrbArchetypeChoice()
}

/** Chromatic rim lens option. */
sealed class OrbLensChoice {
  /** On at or above 48 dp, amplitude tapered by resolution (default). */
  object Auto : OrbLensChoice()
  object Off : OrbLensChoice()
  object On : OrbLensChoice()
  /** Explicit amplitude in p-units, opts out of the taper. Must be >= 0. */
  data class Amplitude(val value: Double) : OrbLensChoice()
}

data class OrbOptions(
  /** Identity. Sets palette, archetype, galaxy structure, meteor cadence and starting spin. */
  val seed: String = "",
  /** Density-independent pixels, square. Minimum 8. */
  val size: Double = 320.0,
  /** Instant at mount, crossfades (~350 ms) afterwards. Continuous on 0..3. */
  val state: Double = 0.0,
  val archetype: OrbArchetypeChoice = OrbArchetypeChoice.Auto,
  val palette: OrbPaletteChoice = OrbPaletteChoice.Auto,
  /**
   * The colour behind the orb, transmitted through the glass. There is no DOM to walk,
   * so set it to your card colour; black by default.
   */
  val background: OrbColor = OrbColor.BLACK,
  /** `false` freezes on the current frame. State changes still repaint. */
  val animate: Boolean = true,
  val lens: OrbLensChoice = OrbLensChoice.Auto,
  /** The inset glass highlight ring. */
  val bevel: Boolean = true,
  /** Render one static frame while the system animator scale is zero. */
  val respectReducedMotion: Boolean = true,
) {
  constructor(seed: String, size: Double = 320.0, state: OrbState = OrbState.IDLE) :
    this(seed = seed, size = size, state = state.index.toDouble())

  /** Throws [IllegalArgumentException] on anything the renderer could not use. */
  fun validate() {
    require(size.isFinite() && size >= 8) { "[Orb] size must be a finite number >= 8" }
    require(state.isFinite() && state in 0.0..3.0) { "[Orb] state must be within 0..3" }
    if (lens is OrbLensChoice.Amplitude) {
      require(lens.value.isFinite() && lens.value >= 0) { "[Orb] lens amplitude must be a finite number >= 0" }
    }
    if (palette is OrbPaletteChoice.Hue) require(palette.degrees.isFinite()) { "[Orb] palette hue must be finite" }
    if (palette is OrbPaletteChoice.Custom) require(palette.palette.accents.size == 3) { "[Orb] palette needs 3 accents" }
  }
}

/** Resolution and lens rules shared by every port. SPEC.md §4. */
internal object OrbResolution {
  const val MAX_PX = 1280
  const val MIN_PX = 8
  const val MAX_DPR = 2.0
  const val HERO_MIN_SIZE = 48.0
  const val LENS_REF_PX = 420.0

  fun pixels(size: Double, density: Double): Int {
    val dpr = if (size >= HERO_MIN_SIZE) min(MAX_DPR, max(density, 1.0)) else 1.0
    return (size * dpr).roundToInt().coerceIn(MIN_PX, MAX_PX)
  }

  fun lens(choice: OrbLensChoice, size: Double, px: Int): Double = when (choice) {
    is OrbLensChoice.Amplitude -> choice.value
    OrbLensChoice.Off -> 0.0
    OrbLensChoice.On -> 0.4 * OrbMath.clamp(LENS_REF_PX / px, 0.55, 1.0)
    OrbLensChoice.Auto -> if (size >= HERO_MIN_SIZE) 0.4 * OrbMath.clamp(LENS_REF_PX / px, 0.55, 1.0) else 0.0
  }
}
