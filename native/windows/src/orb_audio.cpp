// orb_audio.cpp — level sources: constant, custom, synthetic, PCM ring buffer, and
// WASAPI capture (microphone) / loopback (whatever the machine is playing).
//
// Reference measurement (SPEC.md §5): RMS over the most recent 512 mono samples,
// level = min(1, gain * rms), gain 3.2 for speech. No smoothing here.

#include "orb/orb.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <ks.h>
#include <ksmedia.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;
#endif

namespace orb {

namespace {
double clamp01(double v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
}

// ---------------------------------------------------------------------------- AudioSource

AudioSource::AudioSource(Kind k, std::function<double(double)> sample) : kind_(k), sample_(std::move(sample)) {}
AudioSource::~AudioSource() = default;

void AudioSource::start() {
  std::lock_guard<std::mutex> g(mu_);
  if (!stopped_) active_ = true;
}

void AudioSource::stop() {
  {
    std::lock_guard<std::mutex> g(mu_);
    if (stopped_) return;
    stopped_ = true;
    active_ = false;
    level_ = 0;
  }
  onDispose();
}

void AudioSource::tick(double t) {
  std::lock_guard<std::mutex> g(mu_);
  if (!active_ || t == lastTick_) return;
  lastTick_ = t;
  const double raw = sampleAt(t);
  level_ = std::isfinite(raw) ? clamp01(raw) : 0;
}

double AudioSource::sampleAt(double t) { return sample_ ? sample_(t) : 0; }

namespace {
struct FnSource : AudioSource {
  FnSource(Kind k, std::function<double(double)> f) : AudioSource(k, std::move(f)) {}
};
}

std::shared_ptr<AudioSource> AudioSource::custom(std::function<double(double)> fn) {
  return std::make_shared<FnSource>(Kind::Custom, std::move(fn));
}

std::shared_ptr<AudioSource> AudioSource::constant(double v) {
  return std::make_shared<FnSource>(Kind::Constant, [v](double) { return v; });
}

std::shared_ptr<AudioSource> AudioSource::synthetic() {
  return std::make_shared<FnSource>(Kind::Synthetic, [](double t) {
    const double phrase = 0.55 + 0.45 * std::sin(0.9 * t + 2 * std::sin(0.37 * t));
    const double syllable = 0.6 + 0.4 * std::sin(6.2 * t + 3 * std::sin(2.3 * t));
    const double breath = std::sin(0.7 * t + 1.7) > -0.6 ? 1 : 0.12;
    return phrase * syllable * breath;
  });
}

// ---------------------------------------------------------------------------- PCMSource

struct WasapiCapture;

struct PCMSource::Impl {
  double gain;
  std::vector<float> ring;
  size_t head = 0, filled = 0;
  std::mutex mu;
  std::unique_ptr<WasapiCapture> capture;   // only for microphone()/loopback()
};

namespace {
struct MakeShared : PCMSource {
  MakeShared(double g, int w, Kind k) : PCMSource(g, w, k) {}
};
}

PCMSource::PCMSource(double gain, int window, Kind kind) : AudioSource(kind), impl_(new Impl) {
  impl_->gain = gain;
  impl_->ring.assign(static_cast<size_t>(window < 64 ? 64 : window), 0.f);
}

void PCMSource::push(const float* samples, size_t count, int channels) {
  if (!samples || channels <= 0 || count < static_cast<size_t>(channels)) return;
  const size_t frames = count / channels;
  const float inv = 1.f / channels;
  std::lock_guard<std::mutex> g(impl_->mu);
  auto& ring = impl_->ring;
  for (size_t i = 0; i < frames; i++) {
    float s = 0;
    for (int c = 0; c < channels; c++) s += samples[i * channels + c];
    ring[impl_->head] = s * inv;
    impl_->head = (impl_->head + 1) % ring.size();
    if (impl_->filled < ring.size()) impl_->filled++;
  }
}

void PCMSource::push(const int16_t* samples, size_t count, int channels) {
  if (!samples || channels <= 0 || count < static_cast<size_t>(channels)) return;
  const size_t frames = count / channels;
  const float inv = 1.f / (channels * 32768.f);
  std::lock_guard<std::mutex> g(impl_->mu);
  auto& ring = impl_->ring;
  for (size_t i = 0; i < frames; i++) {
    float s = 0;
    for (int c = 0; c < channels; c++) s += static_cast<float>(samples[i * channels + c]);
    ring[impl_->head] = s * inv;
    impl_->head = (impl_->head + 1) % ring.size();
    if (impl_->filled < ring.size()) impl_->filled++;
  }
}

double PCMSource::sampleAt(double) {
  std::lock_guard<std::mutex> g(impl_->mu);
  if (!impl_->filled) return 0;
  double sum = 0;
  for (size_t i = 0; i < impl_->filled; i++) { const double x = impl_->ring[i]; sum += x * x; }
  return std::min(1.0, impl_->gain * std::sqrt(sum / static_cast<double>(impl_->filled)));
}

std::shared_ptr<PCMSource> PCMSource::create(double gain, int window) {
  return std::make_shared<MakeShared>(gain, window, Kind::PCM);
}

// ---------------------------------------------------------------------------- WASAPI

#ifdef _WIN32

/// A capture thread on the default endpoint, pushing mono float into a PCMSource.
struct WasapiCapture {
  static std::shared_ptr<PCMSource> open(double gain, bool loopback);

  PCMSource* target = nullptr;
  bool loopback = false;
  std::atomic<bool> running{true};
  std::thread thread;
  std::string error;   // set if the device could not be opened
  HANDLE ready = nullptr;

  ~WasapiCapture() {
    running = false;
    if (thread.joinable()) thread.join();
    if (ready) CloseHandle(ready);
  }

  void run() {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool uninit = SUCCEEDED(hr);
    ComPtr<IMMDeviceEnumerator> en;
    ComPtr<IMMDevice> dev;
    ComPtr<IAudioClient> client;
    ComPtr<IAudioCaptureClient> cap;
    WAVEFORMATEX* fmt = nullptr;

    auto fail = [&](const char* what, HRESULT code) {
      char buf[160];
      std::snprintf(buf, sizeof buf, "[Orb] %s failed: 0x%08lx", what, static_cast<unsigned long>(code));
      error = buf;
      SetEvent(ready);
    };

    do {
      hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
      if (FAILED(hr)) { fail("MMDeviceEnumerator", hr); break; }
      hr = en->GetDefaultAudioEndpoint(loopback ? eRender : eCapture, eConsole, &dev);
      if (FAILED(hr)) { fail(loopback ? "no render device" : "no capture device", hr); break; }
      hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &client);
      if (FAILED(hr)) { fail("IAudioClient", hr); break; }
      hr = client->GetMixFormat(&fmt);
      if (FAILED(hr)) { fail("GetMixFormat", hr); break; }
      const DWORD flags = loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
      // 20 ms buffer, shared mode, polled. Event-driven loopback is unreliable on
      // older Windows builds, so the thread polls at ~5 ms instead.
      hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200000, 0, fmt, nullptr);
      if (FAILED(hr)) { fail("IAudioClient::Initialize", hr); break; }
      hr = client->GetService(IID_PPV_ARGS(&cap));
      if (FAILED(hr)) { fail("IAudioCaptureClient", hr); break; }
      hr = client->Start();
      if (FAILED(hr)) { fail("IAudioClient::Start", hr); break; }
      SetEvent(ready);

      // Format: shared-mode mix formats are float32 or PCM16/24/32, mono or more.
      const int channels = fmt->nChannels;
      bool isFloat = fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
      int bits = fmt->wBitsPerSample;
      if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        const auto* ex = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt);
        isFloat = IsEqualGUID(ex->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
      }
      std::vector<float> mono;

      while (running) {
        UINT32 packet = 0;
        if (FAILED(cap->GetNextPacketSize(&packet))) break;
        if (packet == 0) { Sleep(5); continue; }
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD pflags = 0;
        if (FAILED(cap->GetBuffer(&data, &frames, &pflags, nullptr, nullptr))) break;
        if (frames) {
          mono.resize(frames);
          if (pflags & AUDCLNT_BUFFERFLAGS_SILENT) {
            std::fill(mono.begin(), mono.end(), 0.f);
          } else if (isFloat && bits == 32) {
            const float* f = reinterpret_cast<const float*>(data);
            for (UINT32 i = 0; i < frames; i++) {
              float s = 0;
              for (int c = 0; c < channels; c++) s += f[i * channels + c];
              mono[i] = s / channels;
            }
          } else if (bits == 16) {
            const int16_t* p = reinterpret_cast<const int16_t*>(data);
            for (UINT32 i = 0; i < frames; i++) {
              float s = 0;
              for (int c = 0; c < channels; c++) s += p[i * channels + c] / 32768.f;
              mono[i] = s / channels;
            }
          } else if (bits == 32) {
            const int32_t* p = reinterpret_cast<const int32_t*>(data);
            for (UINT32 i = 0; i < frames; i++) {
              float s = 0;
              for (int c = 0; c < channels; c++) s += p[i * channels + c] / 2147483648.f;
              mono[i] = s / channels;
            }
          } else if (bits == 24) {
            const BYTE* p = data;
            for (UINT32 i = 0; i < frames; i++) {
              float s = 0;
              for (int c = 0; c < channels; c++) {
                const BYTE* b = p + (i * channels + c) * 3;
                const int32_t v = (static_cast<int32_t>(b[2]) << 24 | b[1] << 16 | b[0] << 8) >> 8;
                s += v / 8388608.f;
              }
              mono[i] = s / channels;
            }
          } else {
            std::fill(mono.begin(), mono.end(), 0.f);
          }
          target->push(mono.data(), mono.size(), 1);
        }
        cap->ReleaseBuffer(frames);
      }
      client->Stop();
    } while (false);

    if (fmt) CoTaskMemFree(fmt);
    cap.Reset(); client.Reset(); dev.Reset(); en.Reset();
    if (uninit) CoUninitialize();
  }
};

std::shared_ptr<PCMSource> WasapiCapture::open(double gain, bool loopback) {
  auto src = std::make_shared<MakeShared>(gain, 512, loopback ? AudioSource::Kind::Loopback : AudioSource::Kind::Microphone);
  auto cap = std::make_unique<WasapiCapture>();
  cap->target = src.get();
  cap->loopback = loopback;
  cap->ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  WasapiCapture* raw = cap.get();
  cap->thread = std::thread([raw] { raw->run(); });
  WaitForSingleObject(raw->ready, 5000);
  if (!raw->error.empty()) {
    const std::string err = raw->error;
    cap.reset();   // joins the thread
    throw std::runtime_error(err);
  }
  src->impl_->capture = std::move(cap);
  return src;
}

std::shared_ptr<PCMSource> PCMSource::microphone(double gain) { return WasapiCapture::open(gain, false); }
std::shared_ptr<PCMSource> PCMSource::loopback(double gain) { return WasapiCapture::open(gain, true); }

#else

struct WasapiCapture {};

std::shared_ptr<PCMSource> PCMSource::microphone(double) { throw std::runtime_error("[Orb] WASAPI is Windows-only"); }
std::shared_ptr<PCMSource> PCMSource::loopback(double) { throw std::runtime_error("[Orb] WASAPI is Windows-only"); }

#endif

void PCMSource::onDispose() {
  std::unique_ptr<WasapiCapture> cap;
  {
    std::lock_guard<std::mutex> g(impl_->mu);
    cap = std::move(impl_->capture);
  }
  cap.reset();   // joins the capture thread outside the ring lock
}

PCMSource::~PCMSource() { onDispose(); }

} // namespace orb
