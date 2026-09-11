// Orb for Windows — Win32 example.
//
// A window with one orb. Keys:
//   1 2 3 4   idle / listening / thinking / speaking
//   S         seed: re-roll a random identity
//   M         microphone (the human speaking)
//   L         system loopback (whatever is playing: the agent's TTS)
//   V         synthetic voice envelope (silent)
//   0         detach audio
//   B         toggle bevel
//   Esc       quit

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include "orb/orb.h"

#include <cstdio>
#include <memory>
#include <random>
#include <string>

namespace {

std::unique_ptr<orb::Window> g_window;

void setTitle(HWND hwnd, const std::string& extra) {
  const orb::Orb& o = g_window->orb();
  std::string t = "Orb  -  seed \"" + o.options().seed + "\"  -  " + orb::name(o.state()) +
                  "  -  " + orb::name(o.identity().archetype) + "  -  hue " +
                  std::to_string(static_cast<int>(*o.palette().hue)) + (extra.empty() ? "" : "  -  " + extra);
  SetWindowTextA(hwnd, t.c_str());
}

void bindAudio(HWND hwnd, char key) {
  auto& o = g_window->orb();
  try {
    switch (key) {
      case 'M': o.listen(orb::PCMSource::microphone()); setTitle(hwnd, "microphone"); break;
      case 'L': o.listen(orb::PCMSource::loopback()); setTitle(hwnd, "loopback"); break;
      case 'V': o.listen(orb::AudioSource::synthetic()); setTitle(hwnd, "synthetic"); break;
      case '0': o.unlisten(); setTitle(hwnd, ""); break;
    }
  } catch (const std::exception& e) {
    MessageBoxA(hwnd, e.what(), "Orb", MB_ICONWARNING);
  }
}

LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_SIZE:
      if (g_window && wp != SIZE_MINIMIZED) g_window->resize();
      return 0;
    case WM_DPICHANGED: {
      const RECT* r = reinterpret_cast<const RECT*>(lp);
      SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      if (g_window) g_window->resize();
      return 0;
    }
    case WM_KEYDOWN:
      if (!g_window) break;
      switch (wp) {
        case VK_ESCAPE: PostQuitMessage(0); return 0;
        case '1': g_window->orb().setState(orb::State::Idle); setTitle(hwnd, ""); return 0;
        case '2': g_window->orb().setState(orb::State::Listening); setTitle(hwnd, ""); return 0;
        case '3': g_window->orb().setState(orb::State::Thinking); setTitle(hwnd, ""); return 0;
        case '4': g_window->orb().setState(orb::State::Speaking); setTitle(hwnd, ""); return 0;
        case 'S': {
          static std::mt19937 rng{std::random_device{}()};
          g_window->orb().setSeed("agent-" + std::to_string(rng() % 100000));
          setTitle(hwnd, "");
          return 0;
        }
        case 'B': {
          orb::Options o = g_window->orb().options();
          o.bevel = !o.bevel;
          g_window->orb().update(o);
          return 0;
        }
        case 'M': case 'L': case 'V': case '0': bindAudio(hwnd, static_cast<char>(wp)); return 0;
      }
      break;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

} // namespace

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  WNDCLASSW wc{};
  wc.lpfnWndProc = wndProc;
  wc.hInstance = inst;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.lpszClassName = L"OrbExample";
  RegisterClassW(&wc);

  HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"Orb", WS_OVERLAPPEDWINDOW,
                              CW_USEDEFAULT, CW_USEDEFAULT, 560, 560, nullptr, nullptr, inst, nullptr);
  if (!hwnd) return 1;

  try {
    orb::Options o;
    o.seed = "agent-42";
    o.size = 320;
    o.state = static_cast<double>(static_cast<int>(orb::State::Idle));
    o.background = orb::Color::fromRGB(0x0b0b10);
    g_window = std::make_unique<orb::Window>(hwnd, o);
  } catch (const std::exception& e) {
    MessageBoxA(hwnd, e.what(), "Orb", MB_ICONERROR);
    return 1;
  }

  ShowWindow(hwnd, SW_SHOW);
  setTitle(hwnd, "1-4 state, S seed, M mic, L loopback, V synthetic, 0 detach");

  // Frame loop: present at vsync; when nothing is changing, wait for input instead of
  // spinning, and repaint once so the window stays valid.
  MSG msg{};
  bool running = true;
  while (running) {
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      if (msg.message == WM_QUIT) { running = false; break; }
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    if (!running) break;
    const bool busy = g_window->frame();
    if (!busy) MsgWaitForMultipleObjects(0, nullptr, FALSE, 250, QS_ALLINPUT);
  }
  g_window.reset();
  return 0;
}
