//  OrbAudioSource.swift
//  OrbKit
//
//  A level in 0...1, sampled once per frame. The two speech envelopes live in
//  OrbDynamics, so a source hands over raw loudness and nothing else: no smoothing
//  here, or it fights the envelopes and rounds off the onsets the spin integrator
//  needs.
//
//  Reference measurement (SPEC.md §5): RMS over the most recent 512 mono samples,
//  level = min(1, gain * rms), gain 3.2 for speech.

import Foundation
import AVFoundation

public class OrbAudioSource {
  public enum Kind: String, Sendable { case custom, constant, synthetic, pcm, microphone, tap }

  public let kind: Kind
  /// Last sampled level, 0...1.
  public private(set) var level: Double = 0
  public private(set) var isActive = false
  public private(set) var isStopped = false

  private let sample: (Double) -> Double
  private var dispose: (() -> Void)?
  private var subscribers: [UUID: (Double) -> Void] = [:]
  private var lastTick: Double = -1
  private let lock = NSLock()

  /// Build a source from any `(seconds) -> 0...1` function.
  public init(kind: Kind = .custom, dispose: (() -> Void)? = nil, sample: @escaping (Double) -> Double) {
    self.kind = kind
    self.sample = sample
    self.dispose = dispose
  }

  /// Begin sampling. Idempotent. No-op once stopped.
  @discardableResult public func start() -> OrbAudioSource {
    lock.lock(); defer { lock.unlock() }
    if isActive || isStopped { return self }
    isActive = true
    return self
  }

  /// Stop and release whatever the source owns. Terminal: build a fresh one instead of
  /// restarting a stopped source.
  @discardableResult public func stop() -> OrbAudioSource {
    lock.lock()
    if isStopped { lock.unlock(); return self }
    isStopped = true
    isActive = false
    level = 0
    let d = dispose; dispose = nil
    let subs = Array(subscribers.values)
    lock.unlock()
    subs.forEach { $0(0) }
    d?()
    return self
  }

  /// Subscribe to the raw level, once per rendered frame. Returns an unsubscribe closure.
  public func onLevel(_ fn: @escaping (Double) -> Void) -> () -> Void {
    let id = UUID()
    lock.lock(); subscribers[id] = fn; lock.unlock()
    return { [weak self] in
      guard let self else { return }
      self.lock.lock(); self.subscribers.removeValue(forKey: id); self.lock.unlock()
    }
  }

  /// Called by every view that listens, once per frame. Several orbs sharing one
  /// source only sample it once per timestamp.
  func tick(_ t: Double) {
    lock.lock()
    guard isActive, t != lastTick else { lock.unlock(); return }
    lastTick = t
    let raw = sample(t)
    let v = raw.isFinite ? OrbMath.clamp01(raw) : 0
    level = v
    let subs = Array(subscribers.values)
    lock.unlock()
    subs.forEach { $0(v) }
  }

  // MARK: - Factories

  /// A constant level, for a quick poke.
  public static func constant(_ v: Double) -> OrbAudioSource {
    OrbAudioSource(kind: .constant) { _ in v }
  }

  /// Your own function of time.
  public static func custom(_ fn: @escaping (Double) -> Double) -> OrbAudioSource {
    OrbAudioSource(kind: .custom, sample: fn)
  }

  /// Silent, permission-free speech-shaped envelope. What you get when there is no
  /// audio to analyse but the orb still has to look alive.
  public static func synthetic() -> OrbAudioSource {
    OrbAudioSource(kind: .synthetic) { t in
      let phrase = 0.55 + 0.45 * sin(0.9 * t + 2 * sin(0.37 * t))
      let syllable = 0.6 + 0.4 * sin(6.2 * t + 3 * sin(2.3 * t))
      let breath: Double = sin(0.7 * t + 1.7) > -0.6 ? 1 : 0.12
      return phrase * syllable * breath
    }
  }

  /// A push-based PCM source. Feed it from any audio callback: an `AVAudioEngine` tap,
  /// a WebRTC / LiveKit audio renderer, your own decoder. Thread-safe.
  public static func pcm(gain: Double = 3.2, window: Int = 512) -> OrbPCMSource {
    OrbPCMSource(gain: gain, window: window)
  }

  /// The live microphone through `AVAudioEngine`. Ask for permission first
  /// (`AVAudioApplication.requestRecordPermission` / `AVCaptureDevice`), and on iOS
  /// configure `AVAudioSession` for recording; the source will set `.playAndRecord`
  /// only if the current category cannot record at all.
  public static func microphone(gain: Double = 3.2) throws -> OrbPCMSource {
    #if os(iOS)
    let session = AVAudioSession.sharedInstance()
    if session.category != .record && session.category != .playAndRecord && session.category != .multiRoute {
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
    }
    try session.setActive(true)
    #endif
    let engine = AVAudioEngine()
    let src = OrbPCMSource(gain: gain, window: 512, kind: .microphone)
    let input = engine.inputNode
    let fmt = input.inputFormat(forBus: 0)
    guard fmt.sampleRate > 0, fmt.channelCount > 0 else {
      throw OrbError.invalid("no microphone input format available")
    }
    input.installTap(onBus: 0, bufferSize: 512, format: fmt) { [weak src] buf, _ in src?.push(buf) }
    engine.prepare()
    try engine.start()
    src.setDispose {
      input.removeTap(onBus: 0)
      engine.stop()
    }
    return src
  }

  /// Tap any node in an `AVAudioEngine` graph you already own, typically the
  /// `mainMixerNode` while an `AVAudioPlayerNode` plays the agent's TTS. Only the tap is
  /// touched; the graph stays yours.
  public static func tap(_ node: AVAudioNode, bus: AVAudioNodeBus = 0, gain: Double = 3.2) -> OrbPCMSource {
    let src = OrbPCMSource(gain: gain, window: 512, kind: .tap)
    let fmt = node.outputFormat(forBus: bus)
    node.installTap(onBus: bus, bufferSize: 512, format: fmt) { [weak src] buf, _ in src?.push(buf) }
    src.setDispose { node.removeTap(onBus: bus) }
    return src
  }
}

/// Ring buffer of the last `window` mono samples; RMS on demand at frame time.
public final class OrbPCMSource: OrbAudioSource {
  private var ring: [Float]
  private var head = 0
  private var filled = 0
  private let gain: Double
  private let ringLock = NSLock()
  private var disposeHook: (() -> Void)?

  init(gain: Double, window: Int, kind: Kind = .pcm) {
    self.gain = gain
    self.ring = [Float](repeating: 0, count: max(64, window))
    weak var weakSelf: OrbPCMSource?
    super.init(kind: kind, dispose: { weakSelf?.disposeHook?() }) { _ in weakSelf?.rms() ?? 0 }
    weakSelf = self
  }

  func setDispose(_ fn: @escaping () -> Void) { disposeHook = fn }

  /// Push interleaved or planar float samples. Channels are averaged to mono.
  public func push(_ samples: UnsafeBufferPointer<Float>, channels: Int = 1, interleaved: Bool = true) {
    guard channels > 0, samples.count >= channels else { return }
    ringLock.lock(); defer { ringLock.unlock() }
    let frames = samples.count / channels
    let inv = 1 / Float(channels)
    for i in 0..<frames {
      var s: Float = 0
      if channels == 1 {
        s = samples[i]
      } else if interleaved {
        for c in 0..<channels { s += samples[i * channels + c] }
        s *= inv
      } else {
        for c in 0..<channels { s += samples[c * frames + i] }
        s *= inv
      }
      ring[head] = s
      head = (head + 1) % ring.count
      if filled < ring.count { filled += 1 }
    }
  }

  /// Push 16-bit PCM. Interleaved.
  public func push(int16 samples: UnsafeBufferPointer<Int16>, channels: Int = 1) {
    guard channels > 0, samples.count >= channels else { return }
    ringLock.lock(); defer { ringLock.unlock() }
    let frames = samples.count / channels
    let inv = 1 / (Float(channels) * 32768)
    for i in 0..<frames {
      var s: Float = 0
      for c in 0..<channels { s += Float(samples[i * channels + c]) }
      ring[head] = s * inv
      head = (head + 1) % ring.count
      if filled < ring.count { filled += 1 }
    }
  }

  /// Push an `AVAudioPCMBuffer` of any common format.
  public func push(_ buffer: AVAudioPCMBuffer) {
    let n = Int(buffer.frameLength)
    let ch = Int(buffer.format.channelCount)
    guard n > 0, ch > 0 else { return }
    if let f = buffer.floatChannelData {
      if buffer.format.isInterleaved {
        push(UnsafeBufferPointer(start: f[0], count: n * ch), channels: ch, interleaved: true)
      } else {
        ringLock.lock()
        let inv = 1 / Float(ch)
        for i in 0..<n {
          var s: Float = 0
          for c in 0..<ch { s += f[c][i] }
          ring[head] = s * inv
          head = (head + 1) % ring.count
          if filled < ring.count { filled += 1 }
        }
        ringLock.unlock()
      }
    } else if let i16 = buffer.int16ChannelData {
      if buffer.format.isInterleaved {
        push(int16: UnsafeBufferPointer(start: i16[0], count: n * ch), channels: ch)
      } else {
        ringLock.lock()
        let inv = 1 / (Float(ch) * 32768)
        for i in 0..<n {
          var s: Float = 0
          for c in 0..<ch { s += Float(i16[c][i]) }
          ring[head] = s * inv
          head = (head + 1) % ring.count
          if filled < ring.count { filled += 1 }
        }
        ringLock.unlock()
      }
    }
  }

  private func rms() -> Double {
    ringLock.lock(); defer { ringLock.unlock() }
    guard filled > 0 else { return 0 }
    var sum: Double = 0
    for i in 0..<filled { let x = Double(ring[i]); sum += x * x }
    return min(1, gain * (sum / Double(filled)).squareRoot())
  }
}
