// orb_renderer.cpp — Direct3D 11 pipeline: runtime HLSL compile, one constant buffer,
// one four-vertex strip, three composite modes. Plus the HWND convenience host.

#include "orb/orb.h"
#include "orb_shaders.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>

using Microsoft::WRL::ComPtr;

namespace orb {

namespace {

/// Mirrors `cbuffer Uniforms` in orb_shaders.h. 128 bytes, 16-byte aligned rows.
struct alignas(16) Uniforms {
  float res[4];
  float bg[4];
  float anchor[4];
  float c0[4], c1[4], c2[4];
  float time, phase, audio, spin;
  float arch, lens, state, bevel;
};
static_assert(sizeof(Uniforms) == 128, "cbuffer layout drifted");

void put(float* dst, const Color& c) {
  dst[0] = static_cast<float>(c.r); dst[1] = static_cast<float>(c.g); dst[2] = static_cast<float>(c.b); dst[3] = 0;
}

ComPtr<ID3DBlob> compile(const char* src, const char* entry, const char* target) {
  ComPtr<ID3DBlob> code, errors;
  // Precise math, deliberately: h1() is fract(sin(x * 127.1) * 43758.5453) and a fast
  // sin loses the low bits at large arguments, which turns the star hash into noise.
  UINT flags = D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3 | D3DCOMPILE_IEEE_STRICTNESS;
  HRESULT hr = D3DCompile(src, std::strlen(src), "orb.hlsl", nullptr, nullptr, entry, target, flags, 0, &code, &errors);
  if (FAILED(hr)) {
    std::string msg = "[Orb] shader compile failed (";
    msg += entry;
    msg += "): ";
    if (errors) msg.append(static_cast<const char*>(errors->GetBufferPointer()), errors->GetBufferSize());
    throw std::runtime_error(msg);
  }
  return code;
}

void check(HRESULT hr, const char* what) {
  if (FAILED(hr)) {
    char buf[160];
    std::snprintf(buf, sizeof buf, "[Orb] %s failed: 0x%08lx", what, static_cast<unsigned long>(hr));
    throw std::runtime_error(buf);
  }
}

} // namespace

// ---------------------------------------------------------------------------- Renderer

struct Renderer::Impl {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11VertexShader> vs;
  ComPtr<ID3D11PixelShader> ps;
  ComPtr<ID3D11Buffer> cb;
  ComPtr<ID3D11BlendState> blendOver;      // premultiplied source-over
  ComPtr<ID3D11RasterizerState> raster;
};

const char* Renderer::hlsl() { return kOrbHlsl; }

Renderer::Renderer(ID3D11Device* device) : impl_(new Impl) {
  if (!device) throw std::invalid_argument("[Orb] Renderer needs a device");
  impl_->device = device;

  const ComPtr<ID3DBlob> vsb = compile(kOrbHlsl, "orb_vs", "vs_4_0");
  const ComPtr<ID3DBlob> psb = compile(kOrbHlsl, "orb_ps", "ps_4_0");
  check(device->CreateVertexShader(vsb->GetBufferPointer(), vsb->GetBufferSize(), nullptr, &impl_->vs), "CreateVertexShader");
  check(device->CreatePixelShader(psb->GetBufferPointer(), psb->GetBufferSize(), nullptr, &impl_->ps), "CreatePixelShader");

  D3D11_BUFFER_DESC bd{};
  bd.ByteWidth = sizeof(Uniforms);
  bd.Usage = D3D11_USAGE_DYNAMIC;
  bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  bd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
  check(device->CreateBuffer(&bd, nullptr, &impl_->cb), "CreateBuffer(cbuffer)");

  D3D11_BLEND_DESC bl{};
  bl.RenderTarget[0].BlendEnable = TRUE;
  bl.RenderTarget[0].SrcBlend = D3D11_BLEND_ONE;                // premultiplied
  bl.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
  bl.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
  bl.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE;
  bl.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
  bl.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
  bl.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
  check(device->CreateBlendState(&bl, &impl_->blendOver), "CreateBlendState");

  D3D11_RASTERIZER_DESC rs{};
  rs.FillMode = D3D11_FILL_SOLID;
  rs.CullMode = D3D11_CULL_NONE;
  rs.ScissorEnable = FALSE;
  rs.DepthClipEnable = TRUE;
  check(device->CreateRasterizerState(&rs, &impl_->raster), "CreateRasterizerState");
}

Renderer::~Renderer() = default;

void Renderer::render(ID3D11DeviceContext* ctx, ID3D11RenderTargetView* rtv, const Viewport& vp,
                      const FrameSpec& spec, const Dynamics& dyn, double time, Composite mode) {
  if (!ctx || !rtv || vp.px <= 0) return;

  Uniforms u{};
  u.res[0] = u.res[1] = static_cast<float>(vp.px);
  put(u.bg, spec.bg); put(u.anchor, spec.anchor);
  put(u.c0, spec.accents[0]); put(u.c1, spec.accents[1]); put(u.c2, spec.accents[2]);
  u.time = static_cast<float>(time);
  u.phase = static_cast<float>(spec.phase);
  u.audio = static_cast<float>(dyn.audioSlow);     // slow envelope drives colour
  u.spin = static_cast<float>(dyn.spin);
  u.arch = static_cast<float>(spec.arch);
  u.lens = static_cast<float>(spec.lens);
  u.state = static_cast<float>(dyn.stateBlend);    // eased, never the target
  u.bevel = spec.bevel ? 1.f : 0.f;

  D3D11_MAPPED_SUBRESOURCE map{};
  if (SUCCEEDED(ctx->Map(impl_->cb.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &map))) {
    std::memcpy(map.pData, &u, sizeof u);
    ctx->Unmap(impl_->cb.Get(), 0);
  }

  // The clearing modes clear the whole target, which is what they mean when the orb
  // owns it (an offscreen texture, a window). With an offset viewport the target is
  // somebody else's frame, so nothing is cleared and the caller has already painted
  // whatever should sit behind the glass.
  const bool fullTarget = vp.x == 0 && vp.y == 0;
  if (mode == Composite::Transparent) {
    if (fullTarget) { const float z[4] = {0, 0, 0, 0}; ctx->ClearRenderTargetView(rtv, z); }
  } else if (mode == Composite::OverBackground) {
    const float bg[4] = {static_cast<float>(spec.bg.r), static_cast<float>(spec.bg.g), static_cast<float>(spec.bg.b), 1.f};
    if (fullTarget) ctx->ClearRenderTargetView(rtv, bg);
  }

  D3D11_VIEWPORT v{};
  v.TopLeftX = static_cast<float>(vp.x);
  v.TopLeftY = static_cast<float>(vp.y);
  v.Width = v.Height = static_cast<float>(vp.px);
  v.MinDepth = 0; v.MaxDepth = 1;

  ctx->OMSetRenderTargets(1, &rtv, nullptr);
  ctx->RSSetViewports(1, &v);
  ctx->RSSetState(impl_->raster.Get());
  ctx->IASetInputLayout(nullptr);
  ctx->IASetVertexBuffers(0, 0, nullptr, nullptr, nullptr);
  ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
  ctx->VSSetShader(impl_->vs.Get(), nullptr, 0);
  ctx->PSSetShader(impl_->ps.Get(), nullptr, 0);
  ctx->PSSetConstantBuffers(0, 1, impl_->cb.GetAddressOf());
  ID3D11ShaderResourceView* none = nullptr;
  ctx->PSSetShaderResources(0, 1, &none);

  const float blendFactor[4] = {0, 0, 0, 0};
  ctx->OMSetBlendState(mode == Composite::Transparent ? nullptr : impl_->blendOver.Get(), blendFactor, 0xffffffff);
  ctx->OMSetDepthStencilState(nullptr, 0);

  ctx->Draw(4, 0);
  drawCalls_++;
}

// ---------------------------------------------------------------------------- Window

struct Window::Impl {
  HWND hwnd = nullptr;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> ctx;
  ComPtr<IDXGISwapChain1> swap;
  ComPtr<ID3D11RenderTargetView> rtv;
  UINT width = 0, height = 0;
  LARGE_INTEGER freq{};

  double now() const {
    LARGE_INTEGER c; QueryPerformanceCounter(&c);
    return static_cast<double>(c.QuadPart) / static_cast<double>(freq.QuadPart);
  }

  double scale() const {
    const UINT dpi = GetDpiForWindow(hwnd);
    return dpi ? dpi / 96.0 : 1.0;
  }

  void createTargets() {
    rtv.Reset();
    RECT rc{}; GetClientRect(hwnd, &rc);
    width = static_cast<UINT>(std::max<LONG>(1, rc.right - rc.left));
    height = static_cast<UINT>(std::max<LONG>(1, rc.bottom - rc.top));
    check(swap->ResizeBuffers(0, width, height, DXGI_FORMAT_UNKNOWN, 0), "ResizeBuffers");
    ComPtr<ID3D11Texture2D> back;
    check(swap->GetBuffer(0, IID_PPV_ARGS(&back)), "GetBuffer");
    check(device->CreateRenderTargetView(back.Get(), nullptr, &rtv), "CreateRenderTargetView");
  }
};

Window::Window(void* hwnd, Options options) : impl_(new Impl) {
  impl_->hwnd = static_cast<HWND>(hwnd);
  if (!impl_->hwnd) throw std::invalid_argument("[Orb] Window needs an HWND");
  QueryPerformanceFrequency(&impl_->freq);

  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
#ifdef _DEBUG
  flags |= D3D11_CREATE_DEVICE_DEBUG;
#endif
  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0};
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, levels, 3,
                                 D3D11_SDK_VERSION, &impl_->device, nullptr, &impl_->ctx);
  if (FAILED(hr)) {
    // No GPU driver (a VM, a headless box): WARP keeps the orb alive at reduced speed.
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags & ~D3D11_CREATE_DEVICE_DEBUG, levels, 3,
                           D3D11_SDK_VERSION, &impl_->device, nullptr, &impl_->ctx);
  }
  check(hr, "D3D11CreateDevice");

  ComPtr<IDXGIDevice> dxgiDev;
  check(impl_->device.As(&dxgiDev), "QueryInterface(IDXGIDevice)");
  ComPtr<IDXGIAdapter> adapter;
  check(dxgiDev->GetAdapter(&adapter), "GetAdapter");
  ComPtr<IDXGIFactory2> factory;
  check(adapter->GetParent(IID_PPV_ARGS(&factory)), "GetParent(IDXGIFactory2)");

  DXGI_SWAP_CHAIN_DESC1 sd{};
  sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  sd.SampleDesc.Count = 1;
  sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  sd.BufferCount = 2;
  sd.Scaling = DXGI_SCALING_STRETCH;
  sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
  sd.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
  check(factory->CreateSwapChainForHwnd(impl_->device.Get(), impl_->hwnd, &sd, nullptr, nullptr, &impl_->swap),
        "CreateSwapChainForHwnd");
  factory->MakeWindowAssociation(impl_->hwnd, DXGI_MWA_NO_ALT_ENTER);

  impl_->createTargets();
  renderer_.reset(new Renderer(impl_->device.Get()));
  orb_.reset(new Orb(std::move(options)));
}

Window::~Window() = default;

ID3D11Device* Window::device() const { return impl_->device.Get(); }

void Window::resize() { impl_->createTargets(); }

bool Window::frame() {
  const double now = impl_->now();
  orb_->tick(now);
  const bool needed = orb_->needsFrame();

  // Clear the whole client area to the background, then draw the orb centred.
  const Color& bg = orb_->options().background;
  const float clear[4] = {static_cast<float>(bg.r), static_cast<float>(bg.g), static_cast<float>(bg.b), 1.f};
  impl_->ctx->ClearRenderTargetView(impl_->rtv.Get(), clear);

  const double scale = impl_->scale();
  const int px = orb_->pixels(scale);
  Viewport vp;
  vp.px = px;
  vp.x = (static_cast<int>(impl_->width) - px) / 2;
  vp.y = (static_cast<int>(impl_->height) - px) / 2;
  orb_->draw(*renderer_, impl_->ctx.Get(), impl_->rtv.Get(), vp, scale, Composite::OverExisting);

  impl_->swap->Present(1, 0);
  return needed;
}

} // namespace orb
