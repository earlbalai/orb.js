// orb_identity.cpp — seed -> identity, palette math, options validation.
// A straight port of sections 3 and 4 of src/orb.js. SPEC.md §2, §4, §6.

#include "orb/orb.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <stdexcept>

namespace orb {

const char* const version = "1.0.0";

const Color Color::Black{0, 0, 0};
const Color Color::White{1, 1, 1};

namespace {

double clamp01(double v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
double clampd(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }

/// JS Math.round for non-negative values: half rounds up.
int q8(double v) { return static_cast<int>(std::floor(255.0 * clamp01(v) + 0.5)); }

/// HSL to RGB, 0..1, the CSS algorithm.
Color hsl(double h, double s, double l) {
  const double a = s * std::min(l, 1 - l);
  auto f = [&](double n) {
    const double k = std::fmod(n + h / 30.0, 12.0);
    return l - a * std::max(-1.0, std::min({k - 3, 9 - k, 1.0}));
  };
  return Color(f(0), f(8), f(4));
}

/// Rec.601 luma of a fully saturated hue.
double hueLuma(double h) {
  const Color c = hsl(h, 1, 0.5);
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

/// The colour after the 8-bit round trip the palette goes through in the reference.
Color quantise(const Color& c) { return Color(q8(c.r) / 255.0, q8(c.g) / 255.0, q8(c.b) / 255.0); }

} // namespace

const char* name(Archetype a) {
  static const char* const n[] = {"spiral", "nebula", "core", "deep"};
  return n[static_cast<int>(a) & 3];
}
const char* name(State s) {
  static const char* const n[] = {"idle", "listening", "thinking", "speaking"};
  return n[static_cast<int>(s) & 3];
}

Color::Color(double r_, double g_, double b_) : r(clamp01(r_)), g(clamp01(g_)), b(clamp01(b_)) {
  if (!std::isfinite(r_) || !std::isfinite(g_) || !std::isfinite(b_)) {
    throw std::invalid_argument("[Orb] colour channel is not finite");
  }
}

std::optional<Color> Color::fromHex(std::string_view hex) {
  if (!hex.empty() && hex.front() == '#') hex.remove_prefix(1);
  if (hex.size() != 3 && hex.size() != 6) return std::nullopt;
  std::string s;
  for (char ch : hex) {
    if (!std::isxdigit(static_cast<unsigned char>(ch))) return std::nullopt;
    s.push_back(ch);
    if (hex.size() == 3) s.push_back(ch);
  }
  const uint32_t v = static_cast<uint32_t>(std::strtoul(s.c_str(), nullptr, 16));
  return fromRGB(v);
}

Color Color::fromRGB(uint32_t v) {
  return Color(((v >> 16) & 0xff) / 255.0, ((v >> 8) & 0xff) / 255.0, (v & 0xff) / 255.0);
}

std::string Color::hex() const {
  char buf[8];
  std::snprintf(buf, sizeof buf, "#%02x%02x%02x", q8(r), q8(g), q8(b));
  return buf;
}

bool Palette::operator==(const Palette& o) const {
  return hue == o.hue && anchor == o.anchor && accents[0] == o.accents[0] &&
         accents[1] == o.accents[1] && accents[2] == o.accents[2];
}

Palette Palette::ofHue(double degrees) {
  const double hin = std::isfinite(degrees) ? degrees : 0.0;
  const double h = std::fmod(std::fmod(hin, 360.0) + 360.0, 360.0);
  const double k = 0.2 * (1 - hueLuma(h));
  Palette p;
  p.hue = h;
  p.anchor = quantise(hsl(h, 0.85, 0.42 + k));
  p.accents[0] = quantise(hsl(h, 0.95, std::min(0.72, 0.6 + k)));
  p.accents[1] = quantise(hsl(std::fmod(h + 16, 360.0), 0.8, std::min(0.82, 0.7 + k)));
  p.accents[2] = quantise(hsl(std::fmod(h + 34, 360.0), 0.9, std::min(0.9, 0.8 + k)));
  return p;
}

Palette Palette::custom(Color anchor, Color a0, Color a1, Color a2) {
  Palette p;
  p.anchor = anchor;
  p.accents[0] = a0; p.accents[1] = a1; p.accents[2] = a2;
  return p;
}

const std::vector<double>& Identity::hues() {
  static const std::vector<double> h = {13, 34, 125, 146, 166, 187, 208, 228, 249, 270, 290, 311, 332, 353};
  return h;
}

const std::vector<Palette>& Identity::palettes() {
  static const std::vector<Palette> p = [] {
    std::vector<Palette> v;
    for (double h : hues()) v.push_back(Palette::ofHue(h));
    return v;
  }();
  return p;
}

uint32_t Identity::hashSeedUtf16(std::u16string_view units) {
  uint32_t h = 0x811c9dc5u;
  for (char16_t u : units) {
    h ^= static_cast<uint32_t>(u);
    h *= 0x01000193u;
  }
  return h;
}

uint32_t Identity::hashSeed(std::string_view utf8) {
  // UTF-8 -> UTF-16 code units, then FNV-1a over the units, matching JS charCodeAt.
  // Malformed sequences hash as U+FFFD, which is what a browser would have given us.
  std::u16string out;
  out.reserve(utf8.size());
  size_t i = 0;
  const auto n = utf8.size();
  while (i < n) {
    const unsigned char c = static_cast<unsigned char>(utf8[i]);
    uint32_t cp;
    size_t len;
    if (c < 0x80) { cp = c; len = 1; }
    else if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; len = 2; }
    else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; len = 3; }
    else if ((c & 0xF8) == 0xF0) { cp = c & 0x07; len = 4; }
    else { cp = 0xFFFD; len = 1; }
    if (len > 1) {
      if (i + len > n) { cp = 0xFFFD; len = 1; }
      else {
        for (size_t k = 1; k < len; k++) {
          const unsigned char cc = static_cast<unsigned char>(utf8[i + k]);
          if ((cc & 0xC0) != 0x80) { cp = 0xFFFD; len = 1; break; }
          cp = (cp << 6) | (cc & 0x3F);
        }
      }
    }
    i += len;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out.push_back(static_cast<char16_t>(0xD800 + (cp >> 10)));
      out.push_back(static_cast<char16_t>(0xDC00 + (cp & 0x3FF)));
    } else {
      out.push_back(static_cast<char16_t>(cp));
    }
  }
  return hashSeedUtf16(out);
}

Identity::Identity(std::string_view utf8Seed) : seed(utf8Seed) {
  hash = hashSeed(utf8Seed);
  phase = (hash % 6283u) / 1000.0;
  palette = palettes()[hash % palettes().size()];
  archetype = static_cast<Archetype>((hash >> 16) % 4u);
  spin = phase * 3.7;
  timeOffset = ((hash >> 8) % 40009u) / 100.0;
}

// ---------------------------------------------------------------------------- options

void Options::validate() const {
  if (!std::isfinite(size) || size < 8) throw std::invalid_argument("[Orb] size must be a finite number >= 8");
  if (!std::isfinite(state) || state < 0 || state > 3) throw std::invalid_argument("[Orb] state must be within 0..3");
  if (lens.kind == LensChoice::Amplitude && !(std::isfinite(lens.amplitude) && lens.amplitude >= 0)) {
    throw std::invalid_argument("[Orb] lens amplitude must be a finite number >= 0");
  }
  if (palette.kind == PaletteChoice::Hue && !std::isfinite(palette.hue)) {
    throw std::invalid_argument("[Orb] palette hue must be finite");
  }
}

int pixelsFor(double size, double scale) {
  const double dpr = size >= 48.0 ? std::min(2.0, std::max(scale, 1.0)) : 1.0;
  const double px = std::floor(size * dpr + 0.5);
  return static_cast<int>(clampd(px, 8, 1280));
}

double lensFor(const LensChoice& c, double size, int px) {
  switch (c.kind) {
    case LensChoice::Amplitude: return c.amplitude;
    case LensChoice::Off: return 0;
    case LensChoice::On: return 0.4 * clampd(420.0 / px, 0.55, 1.0);
    case LensChoice::Auto:
    default: return size >= 48.0 ? 0.4 * clampd(420.0 / px, 0.55, 1.0) : 0.0;
  }
}

} // namespace orb
