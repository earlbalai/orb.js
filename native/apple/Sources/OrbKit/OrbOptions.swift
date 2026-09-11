//  OrbOptions.swift
//  OrbKit
//
//  The option set, same names and defaults as the web module. Validation is at the
//  boundary: a bad value fails where you wrote it, not a frame later inside a
//  uniform upload.

import Foundation

/// How the palette is chosen.
public enum OrbPaletteChoice: Equatable, Sendable {
  /// Derived from the seed (default).
  case auto
  /// Built around a hue in degrees.
  case hue(Double)
  /// A hand-built palette.
  case custom(OrbPalette)
}

/// Archetype option: seed-derived or forced.
public enum OrbArchetypeChoice: Equatable, Sendable {
  case auto
  case fixed(OrbArchetype)
}

/// Chromatic rim lens option.
public enum OrbLensChoice: Equatable, Sendable {
  /// On at or above 48 pt, amplitude tapered by resolution (default).
  case auto
  case off
  case on
  /// Explicit amplitude in p-units, opts out of the taper. Must be >= 0.
  case amplitude(Double)
}

public struct OrbOptions: Equatable, Sendable {
  /// Identity. Sets palette, archetype, galaxy structure, meteor cadence and starting spin.
  public var seed: String = ""
  /// Points, square. Minimum 8.
  public var size: Double = 320
  /// Instant at mount, crossfades (~350 ms) afterwards. Continuous on 0...3.
  public var state: Double = 0
  public var archetype: OrbArchetypeChoice = .auto
  public var palette: OrbPaletteChoice = .auto
  /// The colour behind the orb, transmitted through the glass. There is no DOM to walk
  /// on a native platform, so set it to your card colour; black by default.
  public var background: OrbColor = .black
  /// `false` freezes on the current frame. State changes still repaint.
  public var animate: Bool = true
  public var lens: OrbLensChoice = .auto
  /// The inset glass highlight ring.
  public var bevel: Bool = true
  /// Render one static frame while the OS reduce-motion setting is on.
  public var respectReducedMotion: Bool = true

  public init() {}

  public init(seed: String, size: Double = 320, state: OrbState = .idle) {
    self.seed = seed
    self.size = size
    self.state = Double(state.rawValue)
  }

  /// Throws on anything the renderer could not use.
  func validate() throws {
    guard size.isFinite, size >= 8 else { throw OrbError.invalid("size must be a finite number >= 8") }
    guard state.isFinite, (0...3).contains(state) else { throw OrbError.invalid("state must be within 0...3") }
    if case .amplitude(let a) = lens, !(a.isFinite && a >= 0) {
      throw OrbError.invalid("lens amplitude must be a finite number >= 0")
    }
    if case .hue(let h) = palette, !h.isFinite { throw OrbError.invalid("palette hue must be finite") }
    if case .custom(let p) = palette, p.accents.count != 3 { throw OrbError.invalid("palette needs 3 accents") }
  }
}

public enum OrbError: Error, CustomStringConvertible {
  case invalid(String)
  case metalUnavailable
  case shaderCompile(String)

  public var description: String {
    switch self {
    case .invalid(let m): return "[Orb] " + m
    case .metalUnavailable: return "[Orb] Metal is unavailable on this device"
    case .shaderCompile(let m): return "[Orb] shader failed to compile: " + m
    }
  }
}

/// Resolution and lens rules shared by every port. SPEC.md §4.
enum OrbResolution {
  static let maxPx = 1280
  static let minPx = 8
  static let maxDpr = 2.0
  static let heroMinSize = 48.0
  static let lensRefPx = 420.0

  static func pixels(size: Double, scale: Double) -> Int {
    let dpr = size >= heroMinSize ? min(maxDpr, max(scale, 1)) : 1
    return Int(OrbMath.clamp((size * dpr).rounded(), Double(minPx), Double(maxPx)))
  }

  static func lens(_ choice: OrbLensChoice, size: Double, px: Int) -> Double {
    switch choice {
    case .amplitude(let a): return a
    case .off: return 0
    case .on: return 0.4 * OrbMath.clamp(lensRefPx / Double(px), 0.55, 1)
    case .auto:
      guard size >= heroMinSize else { return 0 }
      return 0.4 * OrbMath.clamp(lensRefPx / Double(px), 0.55, 1)
    }
  }
}
