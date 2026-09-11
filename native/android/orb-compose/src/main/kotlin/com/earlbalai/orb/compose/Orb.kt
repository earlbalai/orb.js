/*
 * Orb.kt (Compose)
 *
 * Jetpack Compose wrapper over OrbView. Declarative inputs map onto the imperative
 * API the same way the React wrapper does on the web: mount once, then patch what
 * changed.
 */
package com.earlbalai.orb.compose

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.earlbalai.orb.OrbArchetypeChoice
import com.earlbalai.orb.OrbAudioSource
import com.earlbalai.orb.OrbColor
import com.earlbalai.orb.OrbLensChoice
import com.earlbalai.orb.OrbOptions
import com.earlbalai.orb.OrbPaletteChoice
import com.earlbalai.orb.OrbState
import com.earlbalai.orb.OrbView

/**
 * ```kotlin
 * Orb(seed = "agent-42", state = OrbState.THINKING, audio = micSource)
 * ```
 *
 * @param audio a live source; the orb starts it if it was not already started.
 * @param level drive the amplitude by hand when there is no source.
 */
@Composable
fun Orb(
  seed: String,
  modifier: Modifier = Modifier,
  size: Dp = 320.dp,
  state: OrbState = OrbState.IDLE,
  audio: OrbAudioSource? = null,
  level: Double? = null,
  archetype: OrbArchetypeChoice = OrbArchetypeChoice.Auto,
  palette: OrbPaletteChoice = OrbPaletteChoice.Auto,
  background: OrbColor = OrbColor.BLACK,
  lens: OrbLensChoice = OrbLensChoice.Auto,
  bevel: Boolean = true,
  animate: Boolean = true,
) {
  val options = OrbOptions(
    seed = seed, size = size.value.toDouble(), state = state.index.toDouble(),
    archetype = archetype, palette = palette, background = background,
    lens = lens, bevel = bevel, animate = animate,
  )
  val bound = remember { arrayOfNulls<OrbAudioSource>(1) }

  AndroidView(
    modifier = modifier,
    factory = { ctx -> OrbView(ctx).apply { update(options) } },
    update = { view ->
      if (view.options != options) view.update(options)
      if (audio != null) {
        if (bound[0] !== audio) { view.listen(audio); bound[0] = audio }
      } else {
        if (bound[0] != null) { view.unlisten(); bound[0] = null }
        if (level != null) view.level = level
      }
    },
  )

  DisposableEffect(Unit) { onDispose { bound[0] = null } }
}
