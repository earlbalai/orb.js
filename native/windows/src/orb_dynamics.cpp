// orb_dynamics.cpp — state crossfade, envelopes, spin integrator, and the logical Orb.
// advanceDynamics() from src/orb.js line for line. SPEC.md §3.

#include "orb/orb.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

namespace orb {

namespace {
constexpr double kStateTau = 0.12;   // 1 - exp(-0.35/0.12) is ~94.5%
constexpr double kRefDt = 1.0 / 60.0;

double clamp01(double v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
double clampd(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }
double smoothstep(double e0, double e1, double x) {
  const double t = clampd((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
double lerpRate(double dt, double tau) { return dt > 0 ? 1 - std::exp(-dt / tau) : 0; }
} // namespace

double Dynamics::stateBasis(double s, double i) { return 1 - smoothstep(0.35, 1.0, std::fabs(s - i)); }

void Dynamics::reseed(const Identity& id) {
  phase = id.phase;
  if (spin == 0) spin = id.spin;
  hasLast_ = false;
}

void Dynamics::setState(double target, bool instant) {
  const double t = clampd(std::isfinite(target) ? target : 0, 0, 3);
  state = t;
  if (instant) {
    stateBlend = t;
    stateSettling = false;
  } else if (stateBlend != t) {
    stateSettling = true;
  }
}

void Dynamics::advance(double t) {
  const double dt = hasLast_ ? clampd(t - lastT_, 0, 0.1) : 0;
  lastT_ = t;
  hasLast_ = true;

  const double lvl = std::isfinite(level) ? clamp01(level) : 0;
  level = lvl;

  const double stateTarget = clampd(std::isfinite(state) ? state : 0, 0, 3);
  if (!std::isfinite(stateBlend)) stateBlend = stateTarget;
  if (stateBlend != stateTarget) {
    stateBlend += (stateTarget - stateBlend) * lerpRate(dt, kStateTau);
    if (std::fabs(stateTarget - stateBlend) < 0.002) {
      stateBlend = stateTarget;
      stateSettling = false;
    } else {
      stateSettling = true;
    }
  } else {
    stateSettling = false;
  }

  const double sb = stateBlend;
  double w0 = stateBasis(sb, 0), w1 = stateBasis(sb, 1);
  double w2 = stateBasis(sb, 2), w3 = stateBasis(sb, 3);
  const double wSum = std::max(w0 + w1 + w2 + w3, 1e-4);
  w0 /= wSum; w1 /= wSum; w2 /= wSum; w3 /= wSum;
  stateWeights[0] = w0; stateWeights[1] = w1; stateWeights[2] = w2; stateWeights[3] = w3;

  // idle barely notices the room (22%), listening and speaking are fully reactive,
  // thinking is deaf on purpose and runs on its own cognition pulse instead.
  const double gate = w0 * 0.22 + w1 + w3;
  const double cognition = 0.34 + 0.30 * std::sin(t * 3.2 + phase * 3.0) * (0.55 + 0.45 * std::sin(t * 1.17 + phase));
  const double d = clamp01(lvl * gate + w2 * cognition);
  drive = d;

  audioSlow += (d - audioSlow) * lerpRate(dt, d > audioSlow ? 0.11 : 0.30);
  audioFast += (d - audioFast) * lerpRate(dt, d > audioFast ? 0.04 : 0.18);

  const double v = audioFast;

  const double a = std::fmod(6.31 * phase, 1.0);
  const double b = std::fmod(2.17 * phase, 1.0);
  const double breathe = 0.35 * std::sin(t * (0.11 + 0.08 * b) + phase);

  // Direction flips queue on an oscillator zero-crossing and commit only while the
  // room is quiet, so the orb never reverses mid-syllable.
  const double osc = std::sin(t * (0.45 + 0.2 * a) + phase);
  const double sign = osc > 0 ? 1 : (osc < 0 ? -1 : 1);
  if (sign != oscSign_) { oscSign_ = sign; flipQueued_ = true; }
  if (flipQueued_ && v < 0.18) { spinDir = -spinDir; flipQueued_ = false; }

  const double spinScale = w0 * 0.55 + w1 * 0.85 + w2 * 1.95 + w3 * 1.15;

  const double audioSpin = spinDir * v * 2.2 * (w0 + w1 + w3) + v * 1.3 * w2;
  const double target = 0.65 * (0.65 + 0.7 * a) * (1 + breathe) * spinScale + audioSpin;
  spinVel += (target - spinVel) * lerpRate(dt, 0.35);

  // Transient kick off the rate of rise of the fast envelope. Frame-rate independent.
  const double onset = std::max(0.0, v - prevFast_);
  prevFast_ = v;
  const double onsetRate = dt > 0 ? onset / dt : 0;
  const double kickDir = spinDir * (w0 + w1 + w3) + w2;
  spinVel += kickDir * std::min(6 * onsetRate * kRefDt, 1.4) * 14 * dt;

  spin += spinVel * dt;

  if (!std::isfinite(spin) || !std::isfinite(spinVel)) {
    spin = 0; spinVel = 0; audioFast = 0; audioSlow = 0; prevFast_ = 0;
    stateBlend = stateTarget; stateSettling = false;
  }
}

// ---------------------------------------------------------------------------- Orb

bool prefersReducedMotion() {
#ifdef _WIN32
  BOOL anim = TRUE;
  if (SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &anim, 0)) return !anim;
#endif
  return false;
}

Orb::Orb(Options options) { apply(std::move(options)); }

Orb::~Orb() { unlisten(); }

void Orb::apply(const Options& o) {
  o.validate();

  Identity id(o.seed);
  Palette pal;
  switch (o.palette.kind) {
    case PaletteChoice::Hue: pal = Palette::ofHue(o.palette.hue); break;
    case PaletteChoice::Custom: pal = o.palette.palette; break;
    case PaletteChoice::Auto:
    default: pal = id.palette; break;
  }

  options_ = o;
  identity_ = std::move(id);
  palette_ = pal;

  // Mount semantics: the first state is where the orb already is.
  dyn_.setState(o.state, firstUpdate_);
  firstUpdate_ = false;

  if (!seedHash_ || *seedHash_ != identity_.hash) {
    seedHash_ = identity_.hash;
    dyn_.reseed(identity_);
    time_ = identity_.timeOffset;
    hasLastNow_ = false;
  }
  reduced_ = o.respectReducedMotion && prefersReducedMotion();
}

State Orb::state() const {
  const int i = static_cast<int>(std::floor(clampd(dyn_.state, 0, 3) + 0.5));
  return static_cast<State>(std::clamp(i, 0, 3));
}

Orb& Orb::setState(State s) { return setState(static_cast<double>(static_cast<int>(s))); }

Orb& Orb::setState(double s) {
  const double v = clampd(std::isfinite(s) ? s : 0, 0, 3);
  if (dyn_.state == v) return *this;
  options_.state = v;
  dyn_.setState(v, false);
  return *this;
}

Orb& Orb::setLevel(double v) {
  dyn_.level = std::isfinite(v) ? clamp01(v) : 0;
  return *this;
}

Orb& Orb::setSeed(std::string_view seed) { Options o = options_; o.seed = std::string(seed); return update(o); }
Orb& Orb::setSize(double size) { Options o = options_; o.size = size; return update(o); }
Orb& Orb::update(const Options& o) { apply(o); return *this; }

Orb& Orb::listen(std::shared_ptr<AudioSource> source) {
  unlisten();
  if (!source) return *this;
  ownsSource_ = !source->active();
  if (ownsSource_) source->start();
  source_ = std::move(source);
  return *this;
}

Orb& Orb::unlisten() {
  if (source_ && ownsSource_) source_->stop();
  source_.reset();
  ownsSource_ = false;
  dyn_.level = 0;
  return *this;
}

Orb& Orb::play() { paused_ = false; return *this; }
Orb& Orb::pause() { paused_ = true; return *this; }

void Orb::tick(double now) {
  const double dt = hasLastNow_ ? clampd(now - lastNow_, 0, 0.1) : 0;
  lastNow_ = now;
  hasLastNow_ = true;
  const bool animate = options_.animate && !reduced_ && !paused_;
  if (animate) time_ += dt;
  if (source_) {
    source_->tick(now);
    dyn_.level = source_->level();
  }
  dyn_.advance(time_);
}

bool Orb::needsFrame() const {
  if (paused_) return dyn_.stateSettling;
  return (options_.animate && !reduced_) || dyn_.stateSettling || (source_ && source_->active());
}

int Orb::pixels(double scale) const { return pixelsFor(options_.size, scale); }

FrameSpec Orb::frameSpec(double scale) const {
  FrameSpec s;
  s.bg = options_.background;
  s.anchor = palette_.anchor;
  s.accents[0] = palette_.accents[0];
  s.accents[1] = palette_.accents[1];
  s.accents[2] = palette_.accents[2];
  s.phase = identity_.phase;
  // Unset resolves on the CPU to the hash-derived archetype, exactly as the web does.
  // The shader's own derive-from-phase branch (uArch < 0) would pick a different one.
  s.arch = static_cast<double>(static_cast<int>(options_.archetype ? *options_.archetype : identity_.archetype));
  s.lens = lensFor(options_.lens, options_.size, pixels(scale));
  s.bevel = options_.bevel;
  return s;
}

void Orb::draw(Renderer& r, ID3D11DeviceContext* ctx, ID3D11RenderTargetView* rtv,
               const Viewport& vp, double scale, Composite mode) {
  r.render(ctx, rtv, vp, frameSpec(scale), dyn_, time_, mode);
}

Metrics Orb::metrics(double scale) const {
  Metrics m{};
  m.level = dyn_.level; m.drive = dyn_.drive; m.fast = dyn_.audioFast; m.slow = dyn_.audioSlow;
  m.spin = dyn_.spin; m.spinVel = dyn_.spinVel; m.direction = dyn_.spinDir; m.time = time_;
  m.px = pixels(scale); m.state = state(); m.stateBlend = dyn_.stateBlend;
  for (int i = 0; i < 4; i++) m.stateWeights[i] = dyn_.stateWeights[i];
  return m;
}

} // namespace orb
