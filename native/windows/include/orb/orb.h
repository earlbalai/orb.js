// orb.h
//
// Orb for Windows: an audio-reactive procedural galaxy-in-glass orb for AI voice
// agents. C++17, Direct3D 11, HLSL compiled at runtime, zero third-party dependencies.
// A native port of src/orb.js; the shared contract is native/SPEC.md.
//
// Three layers, use whichever fits:
//
//   orb::Identity / orb::Dynamics      pure math, no D3D. Same seed -> same orb on every
//                                      platform (pinned by tests/conformance.cpp)
//   orb::Renderer                      draws one orb into any ID3D11RenderTargetView you
//                                      hand it, on your device. For engines and apps that
//                                      already own a swap chain
//   orb::Orb                           the logical orb: options, clock, dynamics, audio
//                                      binding. Host calls tick() then draw()
//   orb::Window                        convenience: an HWND, a swap chain, a frame loop
//
// Everything throws std::invalid_argument at the boundary on a bad option, never a frame
// later inside a constant-buffer upload.

#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

struct ID3D11Device;
struct ID3D11DeviceContext;
struct ID3D11RenderTargetView;

namespace orb {

// ---------------------------------------------------------------------------- identity

/// The four galaxy archetypes, in shader-index order.
enum class Archetype : int { Spiral = 0, Nebula = 1, Core = 2, Deep = 3 };

/// The four agent states, in shader-index order. The order is the conversational loop.
enum class State : int { Idle = 0, Listening = 1, Thinking = 2, Speaking = 3 };

const char* name(Archetype a);
const char* name(State s);

/// An RGB triple in 0..1. Alpha is never part of an orb colour.
struct Color {
  double r = 0, g = 0, b = 0;
  Color() = default;
  Color(double r_, double g_, double b_);
  /// `#rgb`, `#rrggbb`, `rgb`, `rrggbb`.
  static std::optional<Color> fromHex(std::string_view hex);
  /// From a packed 0xRRGGBB (or 0xAARRGGBB; alpha ignored).
  static Color fromRGB(uint32_t rgb);
  /// `#rrggbb`, quantised the way the reference does (round-half-up to 8 bits).
  std::string hex() const;
  bool operator==(const Color& o) const { return r == o.r && g == o.g && b == o.b; }
  bool operator!=(const Color& o) const { return !(*this == o); }
  static const Color Black;
  static const Color White;
};

/// An anchor colour plus three luminance-compensated accents.
struct Palette {
  /// Degrees, 0..360. Unset for a hand-built palette.
  std::optional<double> hue;
  Color anchor;
  Color accents[3];

  /// Build a palette around a hue in degrees.
  static Palette ofHue(double degrees);
  /// A hand-built palette.
  static Palette custom(Color anchor, Color a0, Color a1, Color a2);
  bool operator==(const Palette& o) const;
};

/// Everything a seed determines. Pure and stable.
struct Identity {
  uint32_t hash = 0;
  std::string seed;
  Palette palette;
  Archetype archetype = Archetype::Spiral;
  /// Structural phase, seconds.
  double phase = 0;
  /// Starting spin angle, radians.
  double spin = 0;
  /// Starting clock, seconds.
  double timeOffset = 0;

  /// `seed` is UTF-8. It is hashed as UTF-16 code units, like the web.
  explicit Identity(std::string_view utf8Seed);
  Identity() = default;

  /// FNV-1a 32-bit over the UTF-16 code units of a UTF-8 string.
  static uint32_t hashSeed(std::string_view utf8);
  /// FNV-1a 32-bit over UTF-16 code units directly.
  static uint32_t hashSeedUtf16(std::u16string_view units);

  /// The fourteen identity hues.
  static const std::vector<double>& hues();
  /// The fourteen built-in palettes, one per hue.
  static const std::vector<Palette>& palettes();
};

// ---------------------------------------------------------------------------- dynamics

/// State crossfade, two asymmetric audio envelopes and the spin integrator. A
/// line-for-line port of advanceDynamics() in src/orb.js. See SPEC.md §3.
struct Dynamics {
  // identity input
  double phase = 0;
  // host inputs
  double level = 0;      ///< raw 0..1 amplitude
  double state = 0;      ///< target, continuous on 0..3
  // outputs
  double stateBlend = 0; ///< what the shader sees as uState
  bool stateSettling = false;
  double stateWeights[4] = {1, 0, 0, 0};
  double drive = 0;
  double audioSlow = 0;  ///< uAudio
  double audioFast = 0;
  double spin = 0;       ///< uSpin
  double spinVel = 0;
  double spinDir = 1;

  void reseed(const Identity& id);
  void setState(double target, bool instant);
  void advance(double t);

  /// CPU twin of stateW() in the shader.
  static double stateBasis(double s, double i);

private:
  double prevFast_ = 0;
  bool flipQueued_ = false;
  double oscSign_ = 1;
  bool hasLast_ = false;
  double lastT_ = 0;
};

// ---------------------------------------------------------------------------- options

struct PaletteChoice {
  enum Kind { Auto, Hue, Custom } kind = Auto;
  double hue = 0;
  Palette palette;
  static PaletteChoice auto_() { return {}; }
  static PaletteChoice ofHue(double h) { PaletteChoice c; c.kind = Hue; c.hue = h; return c; }
  static PaletteChoice of(const Palette& p) { PaletteChoice c; c.kind = Custom; c.palette = p; return c; }
};

struct LensChoice {
  enum Kind { Auto, Off, On, Amplitude } kind = Auto;
  double amplitude = 0;
  static LensChoice auto_() { return {}; }
  static LensChoice off() { LensChoice c; c.kind = Off; return c; }
  static LensChoice on() { LensChoice c; c.kind = On; return c; }
  static LensChoice of(double a) { LensChoice c; c.kind = Amplitude; c.amplitude = a; return c; }
};

struct Options {
  std::string seed;                       ///< identity, UTF-8
  double size = 320;                      ///< logical pixels (at 96 DPI), square, >= 8
  double state = 0;                       ///< 0..3, continuous. Instant at mount, crossfades after
  std::optional<Archetype> archetype;     ///< unset = seed-derived
  PaletteChoice palette;
  Color background = Color::Black;        ///< the colour transmitted through the glass
  bool animate = true;
  LensChoice lens;
  bool bevel = true;
  bool respectReducedMotion = true;

  /// Throws std::invalid_argument on anything the renderer could not use.
  void validate() const;
};

/// Resolution rules shared by every port (SPEC.md §4).
int pixelsFor(double size, double scale);
double lensFor(const LensChoice& choice, double size, int px);

// ---------------------------------------------------------------------------- audio

/// A level in 0..1 sampled once per frame. No smoothing here: the envelopes live in
/// Dynamics. Thread-safe.
class AudioSource {
public:
  enum class Kind { Custom, Constant, Synthetic, PCM, Microphone, Loopback };

  virtual ~AudioSource();
  Kind kind() const { return kind_; }
  double level() const { return level_; }
  bool active() const { return active_; }
  bool stopped() const { return stopped_; }

  /// Begin sampling. Idempotent, no-op once stopped.
  void start();
  /// Stop and release what the source owns. Terminal.
  void stop();
  /// Called by every orb that listens, once per frame; shared sources sample once per timestamp.
  void tick(double t);

  /// Build a source from any (seconds) -> 0..1 function.
  static std::shared_ptr<AudioSource> custom(std::function<double(double)> fn);
  /// A constant level.
  static std::shared_ptr<AudioSource> constant(double v);
  /// Silent speech-shaped envelope. No devices, no permissions.
  static std::shared_ptr<AudioSource> synthetic();

protected:
  explicit AudioSource(Kind k, std::function<double(double)> sample = {});
  virtual double sampleAt(double t);
  virtual void onDispose() {}

private:
  Kind kind_;
  std::function<double(double)> sample_;
  double level_ = 0;
  bool active_ = false;
  bool stopped_ = false;
  double lastTick_ = -1;
  std::mutex mu_;
};

/// Ring buffer of the last `window` mono samples; RMS on demand at frame time.
/// Feed it from any audio callback: your voice SDK's PCM sink, a decoder, WASAPI.
class PCMSource : public AudioSource {
public:
  /// Interleaved float samples in -1..1. Channels are averaged to mono.
  void push(const float* samples, size_t count, int channels = 1);
  /// Interleaved 16-bit PCM.
  void push(const int16_t* samples, size_t count, int channels = 1);

  /// A push source. gain 3.2 suits speech.
  static std::shared_ptr<PCMSource> create(double gain = 3.2, int window = 512);

  /// The default capture device (microphone) through WASAPI shared mode.
  /// Throws std::runtime_error if there is no capture device.
  static std::shared_ptr<PCMSource> microphone(double gain = 3.2);

  /// What the machine is playing: the default render device in WASAPI loopback.
  /// This is how a desktop agent's TTS output drives the orb without touching the
  /// playback path. Throws std::runtime_error if there is no render device.
  static std::shared_ptr<PCMSource> loopback(double gain = 3.2);

  ~PCMSource() override;

protected:
  PCMSource(double gain, int window, Kind kind);
  double sampleAt(double) override;
  void onDispose() override;

private:
  friend struct WasapiCapture;
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// ---------------------------------------------------------------------------- renderer

/// Static per-frame inputs that are not dynamics.
struct FrameSpec {
  Color bg = Color::Black;
  Color anchor = Color::Black;
  Color accents[3] = {Color::Black, Color::Black, Color::Black};
  double phase = 0;
  double arch = -1;
  double lens = 0;
  bool bevel = true;
};

/// How the orb lands in the target.
enum class Composite {
  /// Clear the viewport to transparent, no blending. For a premultiplied offscreen
  /// texture you composite yourself.
  Transparent,
  /// Clear the viewport to `FrameSpec::bg`, then blend the orb over it. What a window wants.
  OverBackground,
  /// Do not clear; blend the orb over whatever is already there (a game's back buffer).
  OverExisting,
};

struct Viewport { int x = 0, y = 0, px = 0; };

/// One Direct3D 11 pipeline. Create one per device and share it across orbs.
class Renderer {
public:
  /// Compiles the shaders and builds the pipeline state. Throws std::runtime_error with
  /// the compiler log on failure.
  explicit Renderer(ID3D11Device* device);
  ~Renderer();
  Renderer(const Renderer&) = delete;
  Renderer& operator=(const Renderer&) = delete;

  /// Draw one orb. `rtv` must be a B8G8R8A8/R8G8B8A8 UNORM target on this renderer's device.
  void render(ID3D11DeviceContext* ctx, ID3D11RenderTargetView* rtv, const Viewport& vp,
              const FrameSpec& spec, const Dynamics& dyn, double time, Composite mode);

  uint64_t drawCalls() const { return drawCalls_; }

  /// The HLSL, for anyone wanting to read it or compile it themselves.
  static const char* hlsl();

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  uint64_t drawCalls_ = 0;
};

// ---------------------------------------------------------------------------- orb

struct Metrics {
  double level, drive, fast, slow, spin, spinVel, direction, time;
  int px;
  State state;
  double stateBlend;
  double stateWeights[4];
};

/// The logical orb. No D3D of its own: the host owns the device and calls tick()
/// once per frame and draw() with a renderer. Mirrors the web `Orb` instance.
class Orb {
public:
  explicit Orb(Options options);
  ~Orb();
  Orb(const Orb&) = delete;
  Orb& operator=(const Orb&) = delete;

  const Options& options() const { return options_; }
  const Identity& identity() const { return identity_; }
  const Palette& palette() const { return palette_; }

  /// Nearest named state. Setting crossfades over ~350 ms.
  State state() const;
  Orb& setState(State s);
  /// Continuous state, 0..3. 2.5 is half thinking, half speaking.
  Orb& setState(double s);

  /// Raw 0..1 amplitude. Write it yourself or bind a source.
  double level() const { return dyn_.level; }
  Orb& setLevel(double v);

  Orb& setSeed(std::string_view seed);
  Orb& setSize(double size);
  /// Apply a full option set. Throws and leaves the orb unchanged on a bad value.
  Orb& update(const Options& o);

  /// Bind an audio source. Several orbs may share one. If the source was not already
  /// started, the orb starts it and stops it on unlisten()/destruction.
  Orb& listen(std::shared_ptr<AudioSource> source);
  Orb& unlisten();
  std::shared_ptr<AudioSource> source() const { return source_; }

  Orb& play();
  Orb& pause();
  bool paused() const { return paused_; }

  /// Advance the clock and dynamics. `nowSeconds` is wall time (any monotonic base).
  /// Call once per frame before draw().
  void tick(double nowSeconds);

  /// Whether anything is changing: false when the host may skip frames.
  bool needsFrame() const;

  /// Device pixels for a given DPI scale (1.0 = 96 DPI).
  int pixels(double scale) const;
  /// Everything draw() needs besides dynamics.
  FrameSpec frameSpec(double scale) const;
  const Dynamics& dynamics() const { return dyn_; }
  double time() const { return time_; }

  /// tick()-independent one-liner: build the spec and render.
  void draw(Renderer& r, ID3D11DeviceContext* ctx, ID3D11RenderTargetView* rtv,
            const Viewport& vp, double scale, Composite mode);

  Metrics metrics(double scale) const;

private:
  void apply(const Options& o);

  Options options_;
  Identity identity_;
  Palette palette_;
  Dynamics dyn_;
  double time_ = 0;
  bool hasLastNow_ = false;
  double lastNow_ = 0;
  bool firstUpdate_ = true;
  bool paused_ = false;
  bool reduced_ = false;
  std::optional<uint32_t> seedHash_;
  std::shared_ptr<AudioSource> source_;
  bool ownsSource_ = false;
};

/// True when the OS asks for reduced motion (client-area animations disabled).
bool prefersReducedMotion();

// ---------------------------------------------------------------------------- window

#ifdef _WIN32
/// Convenience host: a swap chain on an HWND, one orb, `OverBackground` compositing.
/// The window's client area is cleared to `Options::background`; the orb is centred.
class Window {
public:
  /// `hwnd` must already exist. Creates the device, swap chain and renderer.
  Window(void* hwnd, Options options);
  ~Window();
  Window(const Window&) = delete;
  Window& operator=(const Window&) = delete;

  Orb& orb() { return *orb_; }
  Renderer& renderer() { return *renderer_; }
  ID3D11Device* device() const;

  /// Call on WM_SIZE / WM_DPICHANGED.
  void resize();
  /// One frame: tick, clear, draw, present. Returns false if nothing needed drawing
  /// (the frame was still presented so the window stays valid).
  bool frame();

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  std::unique_ptr<Orb> orb_;
  std::unique_ptr<Renderer> renderer_;
};
#endif

extern const char* const version;

} // namespace orb
