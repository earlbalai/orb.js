/*
 * OrbView.kt
 *
 * The orb as an Android View. A TextureView (so it composites with real alpha inside
 * any layout, over a card or a photo) driven by its own EGL render thread. The public
 * surface mirrors the web `Orb` instance: state, level, seed, size, update(),
 * listen(), play()/pause(), identity, metrics.
 *
 * Threading: the UI thread owns the options and pushes an immutable OrbFrameSpec; the
 * render thread owns OrbDynamics and the clock. Level and state cross over through
 * @Volatile fields on OrbDynamics.
 */
package com.earlbalai.orb

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.SurfaceTexture
import android.provider.Settings
import android.util.AttributeSet
import android.view.TextureView
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.roundToInt

/** Live renderer readings, the twin of `orb.metrics` on the web. */
data class OrbMetrics(
  val level: Double, val drive: Double, val fast: Double, val slow: Double,
  val spin: Double, val spinVel: Double, val direction: Double, val time: Double, val px: Int,
  val state: OrbState, val stateBlend: Double, val stateWeights: List<Double>,
)

class OrbView @JvmOverloads constructor(
  context: Context,
  attrs: AttributeSet? = null,
  defStyleAttr: Int = 0,
) : TextureView(context, attrs, defStyleAttr), TextureView.SurfaceTextureListener {

  // ---- Public API --------------------------------------------------------------

  /** Current options. Use [update] for a change. */
  var options: OrbOptions = OrbOptions()
    private set

  /** Everything the seed determined. */
  var identity: OrbIdentity = OrbIdentity("")
    private set

  /** The palette actually in use. */
  var palette: OrbPalette = identity.palette
    private set

  /** False when there is no usable OpenGL ES 2.0 and the seeded static fallback is showing. */
  var supported: Boolean = true
    private set

  /** Nearest named state. Setting crossfades over ~350 ms. */
  var state: OrbState
    get() = OrbState.fromIndex(dyn.state.roundToInt())
    set(v) { setState(v.index.toDouble()) }

  /** Raw 0..1 amplitude. Write it yourself, or bind a source with [listen]. */
  var level: Double
    get() = dyn.level
    set(v) { dyn.level = if (v.isFinite()) OrbMath.clamp01(v) else 0.0; requestFrame() }

  var seed: String
    get() = options.seed
    set(v) { update(options.copy(seed = v)) }

  /** Density-independent pixels, square. */
  var size: Double
    get() = options.size
    set(v) { update(options.copy(size = v)) }

  val metrics: OrbMetrics
    get() = OrbMetrics(
      dyn.level, dyn.drive, dyn.audioFast, dyn.audioSlow, dyn.spin, dyn.spinVel, dyn.spinDir,
      clock, px, state, dyn.stateBlend, dyn.stateWeights.toList(),
    )

  /** Set the state, chainable. Continuous values are allowed: 2.5 is half thinking, half speaking. */
  fun setState(s: Double): OrbView {
    val v = OrbMath.clamp(if (s.isFinite()) s else 0.0, 0.0, 3.0)
    if (dyn.state == v) return this
    options = options.copy(state = v)
    lock.withLock { dyn.setState(v, instant = false) }
    requestFrame()
    return this
  }

  fun setState(s: OrbState): OrbView = setState(s.index.toDouble())

  /** Apply a full option set. Throws [IllegalArgumentException] and leaves the orb unchanged on a bad value. */
  fun update(o: OrbOptions): OrbView {
    o.validate()
    apply(o)
    return this
  }

  /** Partial option patch. */
  inline fun update(patch: OrbOptions.() -> OrbOptions): OrbView = update(options.patch())

  /**
   * Bind an audio source. Several orbs may share one. Returns a disposer. If the source
   * was not already started, the orb starts it and stops it on [unlisten] / detach.
   */
  fun listen(source: OrbAudioSource): () -> Unit {
    unlisten()
    ownsSource = !source.isActive
    if (ownsSource) source.start()
    this.source = source
    unsubscribe = source.onLevel { v -> dyn.level = v }
    requestFrame()
    return { unlisten() }
  }

  /** Convenience: a constant level, or a `(t) -> level` function. */
  fun listen(level: Double): () -> Unit = listen(OrbAudioSource.constant(level))
  fun listen(fn: (Double) -> Double): () -> Unit = listen(OrbAudioSource.custom(fn))

  /** Detach the audio and decay to silence. */
  fun unlisten(): OrbView {
    unsubscribe?.invoke(); unsubscribe = null
    if (ownsSource) source?.stop()
    ownsSource = false
    source = null
    dyn.level = 0.0
    requestFrame()
    return this
  }

  /** Resume the loop after [pause]. */
  fun play(): OrbView { paused = false; poke(); return this }

  /** Freeze on the current frame. State changes still repaint. */
  fun pause(): OrbView { paused = true; poke(); return this }

  // ---- Internals ---------------------------------------------------------------

  private val lock = ReentrantLock()
  private val cond = lock.newCondition()
  private val dyn = OrbDynamics()
  @Volatile private var spec = OrbFrameSpec()
  @Volatile private var px = 0
  @Volatile private var animate = true
  @Volatile private var paused = false
  @Volatile private var dirty = true
  @Volatile private var clock = 0.0
  @Volatile private var pendingReseed: OrbIdentity? = null
  private var firstUpdate = true
  private var seedHash: Long? = null
  private var source: OrbAudioSource? = null
  private var ownsSource = false
  private var unsubscribe: (() -> Unit)? = null
  private var thread: RenderThread? = null

  init {
    isOpaque = false
    surfaceTextureListener = this
    apply(options)
  }

  private fun density(): Double = resources.displayMetrics.density.toDouble()

  private fun prefersReducedMotion(): Boolean = try {
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
  } catch (_: Throwable) { false }

  private fun apply(o: OrbOptions) {
    val id = OrbIdentity(o.seed)
    val pal = when (val p = o.palette) {
      OrbPaletteChoice.Auto -> id.palette
      is OrbPaletteChoice.Hue -> OrbPalette.ofHue(p.degrees)
      is OrbPaletteChoice.Custom -> p.palette
    }
    // Auto resolves on the CPU to the hash-derived archetype, exactly as the web does.
    // The shader's own derive-from-phase branch (uArch < 0) would pick a different one.
    val arch = when (val a = o.archetype) {
      OrbArchetypeChoice.Auto -> id.archetype.index.toDouble()
      is OrbArchetypeChoice.Fixed -> a.archetype.index.toDouble()
    }
    val newPx = OrbResolution.pixels(o.size, density())
    val lens = OrbResolution.lens(o.lens, o.size, newPx)

    lock.withLock {
      options = o
      identity = id
      palette = pal
      spec = OrbFrameSpec(o.background, pal.anchor, pal.accents, id.phase, arch, lens, o.bevel)
      dyn.setState(o.state, instant = firstUpdate)
      firstUpdate = false
      if (seedHash != id.hash) {
        seedHash = id.hash
        pendingReseed = id      // applied on the render thread, which owns the dynamics
      }
      if (px != newPx) {
        px = newPx
        surfaceTexture?.setDefaultBufferSize(px, px)
      }
      animate = o.animate && !(o.respectReducedMotion && prefersReducedMotion())
    }
    requestLayout()
    requestFrame()
  }

  private fun requestFrame() { dirty = true; poke() }

  private fun poke() { lock.withLock { cond.signalAll() } }

  /** Whether the loop should be drawing continuously. Mirrors the web predicate. */
  private fun needsFrames(): Boolean {
    if (paused) return dyn.stateSettling
    return animate || dyn.stateSettling || (source?.isActive == true)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val want = (options.size * density()).roundToInt()
    setMeasuredDimension(resolveSize(want, widthMeasureSpec), resolveSize(want, heightMeasureSpec))
  }

  // ---- SurfaceTextureListener --------------------------------------------------

  override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
    st.setDefaultBufferSize(px, px)
    thread = RenderThread(st).also { it.start() }
  }

  override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) {
    st.setDefaultBufferSize(px, px)
    requestFrame()
  }

  override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
    thread?.shutdown()
    thread = null
    return true
  }

  override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}

  override fun onDetachedFromWindow() {
    unlisten()
    super.onDetachedFromWindow()
  }

  // ---- Fallback ----------------------------------------------------------------

  private fun paintFallback() {
    // Seeded static gradient built from the palette. Identity still reads.
    val c: Canvas = lockCanvas() ?: return
    try {
      c.drawColor(0, android.graphics.PorterDuff.Mode.CLEAR)
      val p = palette
      fun argb(col: OrbColor, a: Int) = (a shl 24) or ((col.r * 255).roundToInt() shl 16) or ((col.g * 255).roundToInt() shl 8) or (col.b * 255).roundToInt()
      val r = minOf(width, height) / 2f
      val paint = Paint(Paint.ANTI_ALIAS_FLAG)
      paint.shader = RadialGradient(
        width / 2f, height / 2f, r,
        intArrayOf(argb(p.accents[1], 230), argb(p.anchor, 217), argb(p.anchor, 77), argb(OrbColor.BLACK, 153)),
        floatArrayOf(0f, 0.35f, 0.8f, 1f), Shader.TileMode.CLAMP,
      )
      c.drawCircle(width / 2f, height / 2f, r, paint)
    } finally {
      unlockCanvasAndPost(c)
    }
  }

  // ---- Render thread -----------------------------------------------------------

  private inner class RenderThread(private val st: SurfaceTexture) : Thread("OrbRender") {
    @Volatile private var running = true

    fun shutdown() {
      running = false
      poke()
      join(2000)
    }

    override fun run() {
      val renderer = OrbRenderer(st)
      if (!renderer.setup()) {
        supported = false
        post { paintFallback() }
        return
      }
      supported = true

      var lastNow = -1L
      val frameNs = 1_000_000_000L / 60
      var nextDue = System.nanoTime()

      while (running) {
        // Sleep until something needs drawing.
        lock.withLock {
          while (running && !dirty && !needsFrames()) {
            cond.await()
            lastNow = -1L
          }
        }
        if (!running) break

        // Pace to 60 Hz against an absolute deadline; a long stall does not queue a burst.
        val now = System.nanoTime()
        val wait = nextDue - now
        if (wait > 1_000_000L) { try { sleep(wait / 1_000_000L, (wait % 1_000_000L).toInt()) } catch (_: InterruptedException) {}; continue }
        nextDue = maxOf(now + 1_000_000L, nextDue + frameNs)

        val dt = if (lastNow < 0) 0.0 else OrbMath.clamp((now - lastNow) / 1e9, 0.0, 0.1)
        lastNow = now

        val s: OrbFrameSpec
        val p: Int
        lock.withLock {
          pendingReseed?.let { dyn.reseed(it); clock = it.timeOffset; pendingReseed = null }
          if (animate && !paused) clock += dt
          s = spec; p = px
        }
        source?.tick(now / 1e9)
        dyn.advance(clock)
        dirty = false
        if (!renderer.render(s, dyn, p, clock)) {
          // Surface gone or context lost. Stop cleanly; the listener will restart us.
          break
        }
      }
      renderer.release()
    }
  }
}
