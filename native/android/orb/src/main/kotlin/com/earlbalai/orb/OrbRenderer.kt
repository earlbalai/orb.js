/*
 * OrbRenderer.kt
 *
 * EGL + OpenGL ES 2.0 plumbing for one orb surface: context, program, uniform
 * locations, the four-vertex strip, and one draw call per frame. Lives entirely on
 * the render thread that owns it.
 */
package com.earlbalai.orb

import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.GLES20
import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

/** Static per-orb inputs to a frame that are not dynamics. Built by the view from its options. */
internal data class OrbFrameSpec(
  val bg: OrbColor = OrbColor.BLACK,
  val anchor: OrbColor = OrbColor.BLACK,
  val accents: List<OrbColor> = listOf(OrbColor.BLACK, OrbColor.BLACK, OrbColor.BLACK),
  val phase: Double = 0.0,
  val arch: Double = -1.0,
  val lens: Double = 0.0,
  val bevel: Boolean = true,
)

internal class OrbRenderer(private val surfaceTexture: SurfaceTexture) {
  private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
  private var context: EGLContext = EGL14.EGL_NO_CONTEXT
  private var surface: EGLSurface = EGL14.EGL_NO_SURFACE
  private var program = 0
  private var quad = 0
  private val uniforms = HashMap<String, Int>()
  private val quadData: FloatBuffer = ByteBuffer.allocateDirect(OrbShaders.QUAD.size * 4)
    .order(ByteOrder.nativeOrder()).asFloatBuffer().put(OrbShaders.QUAD).apply { position(0) }

  var ready = false; private set
  var drawCalls = 0L; private set

  /** Create the EGL context and compile the program. Returns false on any failure. */
  fun setup(): Boolean {
    try {
      display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
      if (display == EGL14.EGL_NO_DISPLAY) return fail("no EGL display")
      val version = IntArray(2)
      if (!EGL14.eglInitialize(display, version, 0, version, 1)) return fail("eglInitialize")

      // RGBA8 with a real alpha channel: the orb is glass, the view is translucent.
      val attribs = intArrayOf(
        EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
        EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT,
        EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
        EGL14.EGL_DEPTH_SIZE, 0, EGL14.EGL_STENCIL_SIZE, 0,
        EGL14.EGL_NONE,
      )
      val configs = arrayOfNulls<EGLConfig>(1)
      val num = IntArray(1)
      if (!EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, num, 0) || num[0] == 0) {
        return fail("no RGBA8 ES2 config")
      }
      val config = configs[0]!!

      context = EGL14.eglCreateContext(display, config, EGL14.EGL_NO_CONTEXT,
        intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
      if (context == EGL14.EGL_NO_CONTEXT) return fail("eglCreateContext")

      surface = EGL14.eglCreateWindowSurface(display, config, surfaceTexture, intArrayOf(EGL14.EGL_NONE), 0)
      if (surface == EGL14.EGL_NO_SURFACE) return fail("eglCreateWindowSurface")
      if (!EGL14.eglMakeCurrent(display, surface, surface, context)) return fail("eglMakeCurrent")

      // Fragment highp is optional in ES 2.0 and mediump cannot run this shader
      // (fract(sin(x * 127.1) * 43758.5453) is noise at a 10-bit mantissa).
      val range = IntArray(2); val precision = IntArray(1)
      GLES20.glGetShaderPrecisionFormat(GLES20.GL_FRAGMENT_SHADER, GLES20.GL_HIGH_FLOAT, range, 0, precision, 0)
      if (precision[0] < 16) return fail("fragment highp unavailable (precision ${precision[0]})")

      program = createProgram(OrbShaders.VERTEX, OrbShaders.FRAGMENT)
      if (program == 0) return false
      for (n in OrbShaders.UNIFORMS) uniforms[n] = GLES20.glGetUniformLocation(program, n)

      val ids = IntArray(1)
      GLES20.glGenBuffers(1, ids, 0)
      quad = ids[0]
      GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, quad)
      GLES20.glBufferData(GLES20.GL_ARRAY_BUFFER, OrbShaders.QUAD.size * 4, quadData, GLES20.GL_STATIC_DRAW)

      GLES20.glDisable(GLES20.GL_DEPTH_TEST)
      GLES20.glDisable(GLES20.GL_BLEND)   // premultiplied output into a cleared target; nothing to blend
      GLES20.glDisable(GLES20.GL_DITHER)
      ready = true
      return true
    } catch (e: Throwable) {
      return fail(e.toString())
    }
  }

  private fun fail(why: String): Boolean {
    Log.w("Orb", "[Orb] GL unavailable: $why")
    release()
    return false
  }

  /** Draw one orb into the surface at `px` device pixels and swap. */
  fun render(spec: OrbFrameSpec, dyn: OrbDynamics, px: Int, time: Double): Boolean {
    if (!ready) return false
    GLES20.glViewport(0, 0, px, px)
    GLES20.glUseProgram(program)

    val a = spec.accents
    u2("uRes", px.toFloat(), px.toFloat())
    u3("uBg", spec.bg); u3("uAnchor", spec.anchor)
    u3("uC0", a[0]); u3("uC1", a[1]); u3("uC2", a[2])
    u1("uTime", time.toFloat())
    u1("uPhase", spec.phase.toFloat())
    u1("uArch", spec.arch.toFloat())
    u1("uLens", spec.lens.toFloat())
    u1("uBevel", if (spec.bevel) 1f else 0f)
    // Smoothed state, never the target; slow envelope, never the raw level.
    u1("uState", dyn.stateBlend.toFloat())
    u1("uAudio", dyn.audioSlow.toFloat())
    u1("uSpin", dyn.spin.toFloat())

    GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, quad)
    val aPos = GLES20.glGetAttribLocation(program, "aPos")
    val aUV = GLES20.glGetAttribLocation(program, "aUV")
    GLES20.glEnableVertexAttribArray(aPos)
    GLES20.glEnableVertexAttribArray(aUV)
    GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 16, 0)
    GLES20.glVertexAttribPointer(aUV, 2, GLES20.GL_FLOAT, false, 16, 8)

    GLES20.glClearColor(0f, 0f, 0f, 0f)
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
    drawCalls++

    if (!EGL14.eglSwapBuffers(display, surface)) {
      Log.w("Orb", "[Orb] eglSwapBuffers failed: 0x${Integer.toHexString(EGL14.eglGetError())}")
      return false
    }
    return true
  }

  fun release() {
    ready = false
    if (display != EGL14.EGL_NO_DISPLAY) {
      EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
      if (program != 0) { GLES20.glDeleteProgram(program); program = 0 }
      if (surface != EGL14.EGL_NO_SURFACE) { EGL14.eglDestroySurface(display, surface); surface = EGL14.EGL_NO_SURFACE }
      if (context != EGL14.EGL_NO_CONTEXT) { EGL14.eglDestroyContext(display, context); context = EGL14.EGL_NO_CONTEXT }
      EGL14.eglTerminate(display)
      display = EGL14.EGL_NO_DISPLAY
    }
  }

  private fun u1(n: String, v: Float) { GLES20.glUniform1f(uniforms[n] ?: -1, v) }
  private fun u2(n: String, x: Float, y: Float) { GLES20.glUniform2f(uniforms[n] ?: -1, x, y) }
  private fun u3(n: String, c: OrbColor) { GLES20.glUniform3f(uniforms[n] ?: -1, c.r.toFloat(), c.g.toFloat(), c.b.toFloat()) }

  private fun compile(type: Int, src: String): Int {
    val sh = GLES20.glCreateShader(type)
    GLES20.glShaderSource(sh, src)
    GLES20.glCompileShader(sh)
    val ok = IntArray(1)
    GLES20.glGetShaderiv(sh, GLES20.GL_COMPILE_STATUS, ok, 0)
    if (ok[0] == 0) {
      Log.e("Orb", "[Orb] shader compile failed:\n" + GLES20.glGetShaderInfoLog(sh))
      GLES20.glDeleteShader(sh)
      return 0
    }
    return sh
  }

  private fun createProgram(vs: String, fs: String): Int {
    val v = compile(GLES20.GL_VERTEX_SHADER, vs); if (v == 0) return 0
    val f = compile(GLES20.GL_FRAGMENT_SHADER, fs); if (f == 0) { GLES20.glDeleteShader(v); return 0 }
    val p = GLES20.glCreateProgram()
    GLES20.glAttachShader(p, v); GLES20.glAttachShader(p, f)
    GLES20.glBindAttribLocation(p, 0, "aPos"); GLES20.glBindAttribLocation(p, 1, "aUV")
    GLES20.glLinkProgram(p)
    GLES20.glDeleteShader(v); GLES20.glDeleteShader(f)
    val ok = IntArray(1)
    GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, ok, 0)
    if (ok[0] == 0) {
      Log.e("Orb", "[Orb] program link failed:\n" + GLES20.glGetProgramInfoLog(p))
      GLES20.glDeleteProgram(p)
      return 0
    }
    return p
  }
}
