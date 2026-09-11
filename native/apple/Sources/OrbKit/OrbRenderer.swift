//  OrbRenderer.swift
//  OrbKit
//
//  One Metal pipeline per device, shared by every orb in the process. Draws a single
//  four-vertex strip into whatever texture it is handed, with the shader's
//  premultiplied output written straight into a cleared transparent target, so no
//  blend state is needed and the compositor gets real coverage.

import Foundation
import Metal
import QuartzCore

/// Static per-orb inputs to a frame that are not dynamics: identity colours and
/// resolution-derived values. Built by the view from its options.
struct OrbFrameSpec {
  var bg: OrbColor = .black
  var anchor: OrbColor = .black
  var accents: [OrbColor] = [.black, .black, .black]
  var phase: Double = 0
  var arch: Double = -1
  var lens: Double = 0
  var bevel: Bool = true
}

final class OrbRenderer {
  let device: MTLDevice
  let queue: MTLCommandQueue
  let pipeline: MTLRenderPipelineState
  let pixelFormat: MTLPixelFormat

  private static var shared: [ObjectIdentifier: OrbRenderer] = [:]
  private static let lock = NSLock()

  /// One renderer per device and pixel format, shared across every orb.
  static func renderer(for device: MTLDevice, pixelFormat: MTLPixelFormat) throws -> OrbRenderer {
    lock.lock(); defer { lock.unlock() }
    let key = ObjectIdentifier(device)
    if let r = shared[key], r.pixelFormat == pixelFormat { return r }
    let r = try OrbRenderer(device: device, pixelFormat: pixelFormat)
    shared[key] = r
    return r
  }

  private init(device: MTLDevice, pixelFormat: MTLPixelFormat) throws {
    self.device = device
    self.pixelFormat = pixelFormat
    guard let q = device.makeCommandQueue() else { throw OrbError.metalUnavailable }
    self.queue = q

    // Precise math, deliberately. h1() is fract(sin(x * 127.1) * 43758.5453) and the
    // fast-math sin loses the low bits at large arguments, which turns the star hash
    // into noise and the glitter term into confetti.
    let opts = MTLCompileOptions()
    #if compiler(>=6.0)
    if #available(iOS 18.0, macOS 15.0, *) {
      opts.mathMode = .safe
    } else {
      opts.fastMathEnabled = false
    }
    #else
    opts.fastMathEnabled = false
    #endif

    let library: MTLLibrary
    do {
      library = try device.makeLibrary(source: OrbShaderSource.metal, options: opts)
    } catch {
      throw OrbError.shaderCompile(String(describing: error))
    }
    guard let vs = library.makeFunction(name: "orb_vertex"),
          let fs = library.makeFunction(name: "orb_fragment") else {
      throw OrbError.shaderCompile("entry points missing")
    }

    let desc = MTLRenderPipelineDescriptor()
    desc.label = "OrbKit"
    desc.vertexFunction = vs
    desc.fragmentFunction = fs
    desc.colorAttachments[0].pixelFormat = pixelFormat
    desc.colorAttachments[0].isBlendingEnabled = false
    do {
      pipeline = try device.makeRenderPipelineState(descriptor: desc)
    } catch {
      throw OrbError.shaderCompile(String(describing: error))
    }
  }

  /// Pack a frame's inputs into the uniform block.
  static func uniforms(spec: OrbFrameSpec, dyn: OrbDynamics, px: Int, time: Double) -> OrbUniforms {
    func v4(_ c: OrbColor) -> SIMD4<Float> { SIMD4(Float(c.r), Float(c.g), Float(c.b), 0) }
    return OrbUniforms(
      res: SIMD4(Float(px), Float(px), 0, 0),
      bg: v4(spec.bg), anchor: v4(spec.anchor),
      c0: v4(spec.accents[0]), c1: v4(spec.accents[1]), c2: v4(spec.accents[2]),
      time: Float(time), phase: Float(spec.phase),
      audio: Float(dyn.audioSlow),            // slow envelope drives colour
      spin: Float(dyn.spin),
      arch: Float(spec.arch), lens: Float(spec.lens),
      state: Float(dyn.stateBlend),           // eased, never the target
      bevel: spec.bevel ? 1 : 0)
  }

  /// Encode one orb into `texture`. The caller presents / commits.
  func encode(into texture: MTLTexture, commandBuffer: MTLCommandBuffer, uniforms: OrbUniforms) {
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = texture
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].storeAction = .store
    pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
    guard let enc = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { return }
    enc.label = "Orb"
    enc.setRenderPipelineState(pipeline)
    var u = uniforms
    enc.setFragmentBytes(&u, length: MemoryLayout<OrbUniforms>.stride, index: 0)
    enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    enc.endEncoding()
  }

  /// Render one frame to an offscreen texture and return it. For snapshots and tests.
  func renderOffscreen(px: Int, uniforms: OrbUniforms) -> MTLTexture? {
    let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: pixelFormat, width: px, height: px, mipmapped: false)
    td.usage = [.renderTarget, .shaderRead]
    td.storageMode = .shared
    guard let tex = device.makeTexture(descriptor: td), let cb = queue.makeCommandBuffer() else { return nil }
    encode(into: tex, commandBuffer: cb, uniforms: uniforms)
    cb.commit()
    cb.waitUntilCompleted()
    return tex
  }
}
