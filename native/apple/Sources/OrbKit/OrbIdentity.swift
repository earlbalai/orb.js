//  OrbIdentity.swift
//  OrbKit
//
//  Seed -> identity. A straight port of section 3 and 4 of src/orb.js, pinned by
//  Tests/OrbKitTests/ConformanceTests.swift. See native/SPEC.md §2.

import Foundation

/// The four galaxy archetypes, in shader-index order.
public enum OrbArchetype: Int, CaseIterable, Sendable {
  case spiral = 0, nebula, core, deep

  public var name: String { ["spiral", "nebula", "core", "deep"][rawValue] }

  public init?(name: String) {
    guard let i = OrbArchetype.allCases.firstIndex(where: { $0.name == name }) else { return nil }
    self = OrbArchetype.allCases[i]
  }
}

/// The four agent states, in shader-index order. The order is the conversational loop:
/// idle -> listening -> thinking -> speaking; ordinary transitions are between neighbours.
public enum OrbState: Int, CaseIterable, Sendable {
  case idle = 0, listening, thinking, speaking

  public var name: String { ["idle", "listening", "thinking", "speaking"][rawValue] }

  public init?(name: String) {
    guard let i = OrbState.allCases.firstIndex(where: { $0.name == name }) else { return nil }
    self = OrbState.allCases[i]
  }
}

/// An RGB triple in 0...1. Alpha is never part of an orb colour: the orb composites
/// against whatever is behind it.
public struct OrbColor: Equatable, Sendable {
  public var r: Double
  public var g: Double
  public var b: Double

  public init(r: Double, g: Double, b: Double) {
    self.r = OrbMath.clamp01(r); self.g = OrbMath.clamp01(g); self.b = OrbMath.clamp01(b)
  }

  /// `#rgb`, `#rrggbb`, `rgb`, `rrggbb`. Returns nil for anything else.
  public init?(hex: String) {
    var s = hex.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 3 || s.count == 6, s.allSatisfy({ $0.isHexDigit }) else { return nil }
    if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
    let v = UInt32(s, radix: 16)!
    self.init(r: Double((v >> 16) & 0xff) / 255, g: Double((v >> 8) & 0xff) / 255, b: Double(v & 0xff) / 255)
  }

  /// `#rrggbb`, quantised the same way the reference does (round-half-up to 8 bits).
  public var hex: String {
    let q = { (v: Double) -> Int32 in Int32((255 * OrbMath.clamp01(v)).rounded(.toNearestOrAwayFromZero)) }
    return String(format: "#%02x%02x%02x", q(r), q(g), q(b))
  }

  /// The colour after the 8-bit round trip the palette goes through.
  var quantised: OrbColor {
    let q = { (v: Double) -> Double in (255 * OrbMath.clamp01(v)).rounded(.toNearestOrAwayFromZero) / 255 }
    return OrbColor(r: q(r), g: q(g), b: q(b))
  }

  public static let black = OrbColor(r: 0, g: 0, b: 0)
  public static let white = OrbColor(r: 1, g: 1, b: 1)
}

/// An anchor colour plus three luminance-compensated accents.
public struct OrbPalette: Equatable, Sendable {
  /// Degrees, 0..<360. Nil for a hand-built palette.
  public let hue: Double?
  public let anchor: OrbColor
  public let accents: [OrbColor]

  public init(anchor: OrbColor, accents: [OrbColor]) {
    precondition(accents.count == 3, "OrbPalette needs exactly 3 accents")
    self.hue = nil
    self.anchor = anchor
    self.accents = accents
  }

  init(hue: Double, anchor: OrbColor, accents: [OrbColor]) {
    self.hue = hue; self.anchor = anchor; self.accents = accents
  }

  /// Build a palette around a hue in degrees. Yellows and greens are far brighter than
  /// blues and violets at the same nominal lightness, so `k` nudges lightness up in
  /// proportion to how dark the hue is.
  public init(hue: Double) {
    let hin = hue.isFinite ? hue : 0
    let h = (hin.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    let k = 0.2 * (1 - OrbIdentity.hueLuma(h))
    self.init(
      hue: h,
      anchor: OrbIdentity.hsl(h, 0.85, 0.42 + k).quantised,
      accents: [
        OrbIdentity.hsl(h, 0.95, min(0.72, 0.6 + k)).quantised,
        OrbIdentity.hsl((h + 16).truncatingRemainder(dividingBy: 360), 0.8, min(0.82, 0.7 + k)).quantised,
        OrbIdentity.hsl((h + 34).truncatingRemainder(dividingBy: 360), 0.9, min(0.9, 0.8 + k)).quantised,
      ])
  }
}

/// Everything a seed determines. Pure and stable: the same string is the same orb, on
/// every platform.
public struct OrbIdentity: Equatable, Sendable {
  public let hash: UInt32
  public let seed: String
  public let palette: OrbPalette
  public let archetype: OrbArchetype
  /// Structural phase, seconds. Every per-orb variation in the shader comes off this.
  public let phase: Double
  /// Starting spin angle, radians.
  public let spin: Double
  /// Starting clock, seconds, so two seeds are never in lockstep.
  public let timeOffset: Double

  /// The fourteen identity hues, unevenly spaced.
  public static let hues: [Double] = [13, 34, 125, 146, 166, 187, 208, 228, 249, 270, 290, 311, 332, 353]

  /// The fourteen built-in palettes, one per hue.
  public static let palettes: [OrbPalette] = hues.map { OrbPalette(hue: $0) }

  /// FNV-1a, 32-bit, over UTF-16 code units (what JS `charCodeAt` yields).
  public static func hashSeed(_ seed: String) -> UInt32 {
    var h: UInt32 = 0x811c9dc5
    for unit in seed.utf16 {
      h ^= UInt32(unit)
      h = h &* 0x01000193
    }
    return h
  }

  public init(seed: String) {
    let h = OrbIdentity.hashSeed(seed)
    let phase = Double(h % 6283) / 1000
    self.hash = h
    self.seed = seed
    self.palette = OrbIdentity.palettes[Int(h % UInt32(OrbIdentity.palettes.count))]
    self.archetype = OrbArchetype(rawValue: Int((h >> 16) % 4))!
    self.phase = phase
    self.spin = phase * 3.7
    self.timeOffset = Double((h >> 8) % 40009) / 100
  }

  // MARK: colour math

  /// HSL to RGB, 0...1, the CSS algorithm.
  static func hsl(_ h: Double, _ s: Double, _ l: Double) -> OrbColor {
    let a = s * min(l, 1 - l)
    func f(_ n: Double) -> Double {
      let k = (n + h / 30).truncatingRemainder(dividingBy: 12)
      return l - a * max(-1, min(k - 3, 9 - k, 1))
    }
    return OrbColor(r: f(0), g: f(8), b: f(4))
  }

  /// Rec.601 luma of a fully saturated hue.
  static func hueLuma(_ h: Double) -> Double {
    let c = hsl(h, 1, 0.5)
    return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b
  }
}

enum OrbMath {
  @inline(__always) static func clamp01(_ v: Double) -> Double { v < 0 ? 0 : (v > 1 ? 1 : v) }
  @inline(__always) static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { v < lo ? lo : (v > hi ? hi : v) }
  /// GLSL's smoothstep, exactly, so the CPU state basis matches `stateW()` in the shader.
  @inline(__always) static func smoothstep(_ e0: Double, _ e1: Double, _ x: Double) -> Double {
    let t = clamp((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)
  }
  /// Frame-rate independent first-order lerp factor.
  @inline(__always) static func lerpRate(_ dt: Double, _ tau: Double) -> Double { dt > 0 ? 1 - exp(-dt / tau) : 0 }
}
