//  OrbView.swift
//  OrbKit
//
//  The orb as a UIView (iOS) / NSView (macOS), hosted on an MTKView. Owns one
//  OrbDynamics, one audio binding and the frame clock; rendering goes through the
//  shared OrbRenderer. The public surface mirrors the web `Orb` instance: state,
//  level, seed, size, update(), listen(), play()/pause(), identity, metrics.

import Foundation
import Metal
import MetalKit
import QuartzCore

#if canImport(UIKit)
import UIKit
public typealias OrbPlatformView = UIView
#elseif canImport(AppKit)
import AppKit
public typealias OrbPlatformView = NSView
#endif

/// Live renderer readings, the twin of `orb.metrics` on the web.
public struct OrbMetrics: Sendable {
  public let level: Double
  public let drive: Double
  public let fast: Double
  public let slow: Double
  public let spin: Double
  public let spinVel: Double
  public let direction: Double
  public let time: Double
  public let px: Int
  public let state: OrbState
  public let stateBlend: Double
  public let stateWeights: [Double]
}

public final class OrbView: OrbPlatformView, MTKViewDelegate {

  // MARK: Public API

  /// Current options. Assigning re-validates and applies the whole set; use `update`
  /// for a partial change.
  public private(set) var options = OrbOptions()

  /// Nearest named state. Setting crossfades over ~350 ms.
  public var state: OrbState {
    get { OrbState(rawValue: Int(OrbMath.clamp(dyn.state.rounded(), 0, 3)))! }
    set { setState(Double(newValue.rawValue)) }
  }

  /// Raw 0...1 amplitude. Write it yourself, or bind a source with `listen`.
  public var level: Double {
    get { dyn.level }
    set { dyn.level = newValue.isFinite ? OrbMath.clamp01(newValue) : 0; requestFrame() }
  }

  public var seed: String {
    get { options.seed }
    set { try? update { $0.seed = newValue } }
  }

  /// Points, square.
  public var size: Double {
    get { options.size }
    set { try? update { $0.size = newValue } }
  }

  /// Everything the seed determined, or the overrides in effect.
  public private(set) var identity: OrbIdentity = OrbIdentity(seed: "")

  /// The palette actually in use.
  public var palette: OrbPalette { resolvedPalette }

  /// False when Metal is unavailable and the seeded static fallback is showing.
  public private(set) var supported = true

  public var metrics: OrbMetrics {
    OrbMetrics(level: dyn.level, drive: dyn.drive, fast: dyn.audioFast, slow: dyn.audioSlow,
               spin: dyn.spin, spinVel: dyn.spinVel, direction: dyn.spinDir, time: time, px: px,
               state: state, stateBlend: dyn.stateBlend, stateWeights: dyn.stateWeights)
  }

  /// Set the state, chainable. Continuous values are allowed: 2.5 is half thinking, half speaking.
  @discardableResult public func setState(_ s: Double) -> OrbView {
    let v = OrbMath.clamp(s.isFinite ? s : 0, 0, 3)
    guard dyn.state != v else { return self }
    options.state = v
    dyn.setState(v, instant: false)
    requestFrame()
    return self
  }

  @discardableResult public func setState(_ s: OrbState) -> OrbView { setState(Double(s.rawValue)) }

  /// Partial option patch. Anything you do not touch keeps its value. Throws on an
  /// invalid value, and leaves the orb unchanged when it does.
  @discardableResult public func update(_ patch: (inout OrbOptions) -> Void) throws -> OrbView {
    var o = options
    patch(&o)
    try apply(o)
    return self
  }

  /// Bind an audio source. Several orbs may share one. Returns a disposer. If the
  /// source was not already started, the orb starts it and stops it on unlisten/deinit.
  @discardableResult public func listen(_ source: OrbAudioSource) -> () -> Void {
    unlisten()
    ownsSource = !source.isActive
    if ownsSource { source.start() }
    self.source = source
    unsubscribe = source.onLevel { [weak self] v in self?.dyn.level = v }
    requestFrame()
    return { [weak self] in self?.unlisten() }
  }

  /// Convenience: a constant level, or a `(t) -> level` function.
  @discardableResult public func listen(level v: Double) -> () -> Void { listen(.constant(v)) }
  @discardableResult public func listen(_ fn: @escaping (Double) -> Double) -> () -> Void { listen(.custom(fn)) }

  /// Detach the audio and decay to silence.
  @discardableResult public func unlisten() -> OrbView {
    unsubscribe?(); unsubscribe = nil
    if ownsSource { source?.stop() }
    ownsSource = false
    source = nil
    dyn.level = 0
    requestFrame()
    return self
  }

  /// Resume the loop after `pause()`.
  @discardableResult public func play() -> OrbView { paused = false; scheduleLoop(); return self }

  /// Freeze on the current frame. State changes still repaint.
  @discardableResult public func pause() -> OrbView { paused = true; scheduleLoop(); return self }

  /// Render one frame now, outside the loop.
  public func renderNow() { requestFrame(); mtk.draw() }

  // MARK: Init

  public convenience init(options: OrbOptions) throws {
    self.init(frame: CGRect(x: 0, y: 0, width: options.size, height: options.size))
    try apply(options)
  }

  public convenience init(seed: String, size: Double = 320, state: OrbState = .idle) {
    self.init(frame: CGRect(x: 0, y: 0, width: size, height: size))
    try? apply(OrbOptions(seed: seed, size: size, state: state))
  }

  public override init(frame: CGRect) {
    let device = MTLCreateSystemDefaultDevice()
    mtk = MTKView(frame: CGRect(origin: .zero, size: frame.size), device: device)
    super.init(frame: frame)
    setupView()
  }

  public required init?(coder: NSCoder) {
    let device = MTLCreateSystemDefaultDevice()
    mtk = MTKView(frame: .zero, device: device)
    super.init(coder: coder)
    setupView()
  }

  deinit {
    unlisten()
    mtk.delegate = nil
  }

  // MARK: Internals

  private let mtk: MTKView
  private var renderer: OrbRenderer?
  private var dyn = OrbDynamics()
  private var spec = OrbFrameSpec()
  private var resolvedPalette = OrbIdentity.palettes[0]
  private var time: Double = 0
  private var lastNow: CFTimeInterval? = nil
  private var px = 0
  private var firstUpdate = true
  private var paused = false
  private var reduced = false
  private var animate = true
  private var dirty = true
  private var seedHash: UInt32? = nil
  private var source: OrbAudioSource?
  private var ownsSource = false
  private var unsubscribe: (() -> Void)?
  private let fallback = CAGradientLayer()

  private func setupView() {
    #if canImport(UIKit)
    backgroundColor = .clear
    isOpaque = false
    mtk.backgroundColor = .clear
    mtk.isOpaque = false
    mtk.layer.isOpaque = false
    mtk.isUserInteractionEnabled = false
    #else
    wantsLayer = true
    layer?.isOpaque = false
    layer?.backgroundColor = CGColor.clear
    mtk.layer?.isOpaque = false
    mtk.layer?.backgroundColor = CGColor.clear
    #endif

    mtk.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
    mtk.colorPixelFormat = .bgra8Unorm
    mtk.framebufferOnly = true
    mtk.autoResizeDrawable = false
    mtk.preferredFramesPerSecond = 60
    mtk.enableSetNeedsDisplay = false
    mtk.isPaused = true
    mtk.delegate = self
    addSubview(mtk)

    // Seeded static fallback: identity still reads when there is no GPU.
    fallback.type = .radial
    fallback.startPoint = CGPoint(x: 0.5, y: 0.5)
    fallback.endPoint = CGPoint(x: 1, y: 1)
    fallback.isHidden = true
    #if canImport(UIKit)
    layer.addSublayer(fallback)
    #else
    layer?.addSublayer(fallback)
    #endif

    if let device = mtk.device {
      do {
        renderer = try OrbRenderer.renderer(for: device, pixelFormat: mtk.colorPixelFormat)
      } catch {
        NSLog("%@", String(describing: error))
        renderer = nil
      }
    }
    supported = renderer != nil
    reduced = OrbView.prefersReducedMotion()
  }

  private var contentScale: Double {
    #if canImport(UIKit)
    return Double(window?.screen.scale ?? UIScreen.main.scale)
    #else
    return Double(window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2)
    #endif
  }

  private static func prefersReducedMotion() -> Bool {
    #if canImport(UIKit)
    return UIAccessibility.isReduceMotionEnabled
    #else
    return NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    #endif
  }

  /// Validate and commit a full option set.
  private func apply(_ o: OrbOptions) throws {
    try o.validate()

    let id = OrbIdentity(seed: o.seed)
    let pal: OrbPalette
    switch o.palette {
    case .auto: pal = id.palette
    case .hue(let h): pal = OrbPalette(hue: h)
    case .custom(let p): pal = p
    }
    // 'auto' resolves on the CPU to the hash-derived archetype, exactly as the web
    // does. The shader's own derive-from-phase branch (uArch < 0) would pick a
    // different one for the same seed.
    let arch: Double
    switch o.archetype {
    case .auto: arch = Double(id.archetype.rawValue)
    case .fixed(let a): arch = Double(a.rawValue)
    }
    let newPx = OrbResolution.pixels(size: o.size, scale: contentScale)
    let lens = OrbResolution.lens(o.lens, size: o.size, px: newPx)

    // Commit.
    options = o
    identity = id
    resolvedPalette = pal
    spec.bg = o.background
    spec.anchor = pal.anchor
    spec.accents = pal.accents
    spec.arch = arch
    spec.lens = lens
    spec.bevel = o.bevel

    // Mount semantics: the first state is where the orb already is.
    dyn.setState(o.state, instant: firstUpdate)
    firstUpdate = false

    if seedHash != id.hash {
      seedHash = id.hash
      dyn.reseed(id)
      time = id.timeOffset
      lastNow = nil
    }

    if px != newPx {
      px = newPx
      mtk.drawableSize = CGSize(width: px, height: px)
    }
    reduced = o.respectReducedMotion && OrbView.prefersReducedMotion()
    animate = o.animate && !reduced

    #if canImport(UIKit)
    setNeedsLayout()
    #else
    needsLayout = true
    #endif
    paintFallbackIfNeeded()
    requestFrame()
  }

  private func paintFallbackIfNeeded() {
    fallback.isHidden = supported
    mtk.isHidden = !supported
    guard !supported else { return }
    let p = resolvedPalette
    func cg(_ c: OrbColor, _ a: CGFloat) -> CGColor {
      CGColor(srgbRed: CGFloat(c.r), green: CGFloat(c.g), blue: CGFloat(c.b), alpha: a)
    }
    fallback.colors = [cg(p.accents[1], 0.9), cg(p.anchor, 0.85), cg(p.anchor, 0.3), cg(.black, 0.6)]
    fallback.locations = [0, 0.35, 0.8, 1]
    fallback.cornerRadius = CGFloat(options.size / 2)
    fallback.masksToBounds = true
  }

  // MARK: Loop control
  //
  // Whether the view is drawing continuously is a pure function of state, as on
  // the web: animating (and not paused), or a crossfade still settling, or an
  // active source. Otherwise the view sits paused and single frames are requested.

  private var needsFrames: Bool {
    guard supported, window != nil else { return false }
    if paused { return dyn.stateSettling }
    return animate || dyn.stateSettling || (source?.isActive ?? false)
  }

  private func scheduleLoop() {
    let run = needsFrames
    if run {
      if mtk.isPaused { lastNow = nil }
      mtk.isPaused = false
      mtk.enableSetNeedsDisplay = false
    } else {
      mtk.isPaused = true
      mtk.enableSetNeedsDisplay = true
      if dirty { mtk.setNeedsDisplay(mtk.bounds) }
    }
  }

  /// Mark the orb dirty and make sure a frame lands.
  private func requestFrame() {
    dirty = true
    scheduleLoop()
  }

  // MARK: Layout

  #if canImport(UIKit)
  public override func layoutSubviews() {
    super.layoutSubviews()
    layoutOrb()
  }
  public override var intrinsicContentSize: CGSize { CGSize(width: options.size, height: options.size) }
  public override func didMoveToWindow() {
    super.didMoveToWindow()
    // DPI can change with the window (external display); recompute px.
    try? apply(options)
    scheduleLoop()
  }
  #else
  public override func layout() {
    super.layout()
    layoutOrb()
  }
  public override var intrinsicContentSize: NSSize { NSSize(width: options.size, height: options.size) }
  public override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    try? apply(options)
    scheduleLoop()
  }
  #endif

  private func layoutOrb() {
    // Square, centred, at the option size regardless of the frame we were given.
    let s = CGFloat(options.size)
    let r = CGRect(x: (bounds.width - s) / 2, y: (bounds.height - s) / 2, width: s, height: s)
    mtk.frame = r
    fallback.frame = r
    if px > 0 { mtk.drawableSize = CGSize(width: px, height: px) }
  }

  // MARK: MTKViewDelegate

  public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

  public func draw(in view: MTKView) {
    guard let renderer, let drawable = view.currentDrawable else { return }

    let now = CACurrentMediaTime()
    let dt = lastNow == nil ? 0 : OrbMath.clamp(now - lastNow!, 0, 0.1)
    lastNow = now

    // Only advance the clock while animating. A paused orb repainting for a state
    // change still eases the crossfade, but the galaxy does not jump ahead.
    if animate && !paused { time += dt }
    source?.tick(now)
    dyn.advance(to: time)

    let u = OrbRenderer.uniforms(spec: spec, dyn: dyn, px: px, time: time)
    guard let cb = renderer.queue.makeCommandBuffer() else { return }
    renderer.encode(into: drawable.texture, commandBuffer: cb, uniforms: u)
    cb.present(drawable)
    cb.commit()
    dirty = false

    // The predicate may have changed (a crossfade landed, a source stopped).
    if !needsFrames { scheduleLoop() }
  }
}
