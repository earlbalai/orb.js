//  OrbSwiftUI.swift
//  OrbKit
//
//  SwiftUI wrapper over OrbView. Declarative inputs map onto the imperative API the
//  same way the React wrapper does on the web: mount once, then patch what changed.

#if canImport(SwiftUI)
import SwiftUI

/// ```swift
/// Orb(seed: "agent-42", state: .thinking)
///   .orbAudio(micSource)
///   .frame(width: 320, height: 320)
/// ```
public struct Orb: View {
  private var options: OrbOptions
  private var audio: OrbAudioSource?
  private var level: Double?

  /// - Parameters:
  ///   - seed: identity
  ///   - size: points, square
  ///   - state: crossfades when it changes
  public init(seed: String, size: Double = 320, state: OrbState = .idle) {
    self.options = OrbOptions(seed: seed, size: size, state: state)
  }

  public init(options: OrbOptions) { self.options = options }

  /// Bind a live audio source (the agent's stream, the microphone, a PCM push source).
  public func orbAudio(_ source: OrbAudioSource?) -> Orb { var c = self; c.audio = source; return c }
  /// Drive the level by hand instead of from a source.
  public func orbLevel(_ v: Double) -> Orb { var c = self; c.level = v; return c }
  public func orbArchetype(_ a: OrbArchetypeChoice) -> Orb { var c = self; c.options.archetype = a; return c }
  public func orbPalette(_ p: OrbPaletteChoice) -> Orb { var c = self; c.options.palette = p; return c }
  /// The colour behind the orb, transmitted through the glass.
  public func orbBackground(_ c: OrbColor) -> Orb { var v = self; v.options.background = c; return v }
  public func orbLens(_ l: OrbLensChoice) -> Orb { var c = self; c.options.lens = l; return c }
  public func orbBevel(_ on: Bool) -> Orb { var c = self; c.options.bevel = on; return c }
  public func orbAnimate(_ on: Bool) -> Orb { var c = self; c.options.animate = on; return c }

  public var body: some View {
    OrbRepresentable(options: options, audio: audio, level: level)
      .frame(width: options.size, height: options.size)
  }
}

#if canImport(UIKit)
private struct OrbRepresentable: UIViewRepresentable {
  let options: OrbOptions
  let audio: OrbAudioSource?
  let level: Double?

  func makeUIView(context: Context) -> OrbView {
    let v = (try? OrbView(options: options)) ?? OrbView(seed: options.seed, size: options.size)
    context.coordinator.bind(v, audio: audio, level: level)
    return v
  }
  func updateUIView(_ v: OrbView, context: Context) {
    try? v.update { $0 = options }
    context.coordinator.bind(v, audio: audio, level: level)
  }
  static func dismantleUIView(_ v: OrbView, coordinator: Coordinator) { v.unlisten() }
  func makeCoordinator() -> Coordinator { Coordinator() }
  final class Coordinator { var bound: ObjectIdentifier?; func bind(_ v: OrbView, audio: OrbAudioSource?, level: Double?) { OrbSwiftUIBinding.bind(v, audio: audio, level: level, bound: &bound) } }
}
#elseif canImport(AppKit)
private struct OrbRepresentable: NSViewRepresentable {
  let options: OrbOptions
  let audio: OrbAudioSource?
  let level: Double?

  func makeNSView(context: Context) -> OrbView {
    let v = (try? OrbView(options: options)) ?? OrbView(seed: options.seed, size: options.size)
    context.coordinator.bind(v, audio: audio, level: level)
    return v
  }
  func updateNSView(_ v: OrbView, context: Context) {
    try? v.update { $0 = options }
    context.coordinator.bind(v, audio: audio, level: level)
  }
  static func dismantleNSView(_ v: OrbView, coordinator: Coordinator) { v.unlisten() }
  func makeCoordinator() -> Coordinator { Coordinator() }
  final class Coordinator { var bound: ObjectIdentifier?; func bind(_ v: OrbView, audio: OrbAudioSource?, level: Double?) { OrbSwiftUIBinding.bind(v, audio: audio, level: level, bound: &bound) } }
}
#endif

/// Rebind only when the source identity changes; SwiftUI calls update often.
private enum OrbSwiftUIBinding {
  static func bind(_ v: OrbView, audio: OrbAudioSource?, level: Double?, bound: inout ObjectIdentifier?) {
    if let audio {
      let id = ObjectIdentifier(audio)
      if bound != id { v.listen(audio); bound = id }
    } else {
      if bound != nil { v.unlisten(); bound = nil }
      if let level { v.level = level }
    }
  }
}
#endif
