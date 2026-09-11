cmake_minimum_required(VERSION 3.16)
project(orb VERSION 1.0.0 LANGUAGES CXX)

# Orb for Windows: C++17, Direct3D 11, zero third-party dependencies.
#
#   cmake -S native/windows -B build && cmake --build build --config Release
#   build/Release/orb_conformance.exe        identity + dynamics vectors, HLSL compile
#   build/Release/orb_example.exe            a window with an orb; 1-4 states, M mic, L loopback

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(ORB_BUILD_EXAMPLES "Build the Win32 example" ON)
option(ORB_BUILD_TESTS "Build the conformance test" ON)

add_library(orb STATIC
  src/orb_identity.cpp
  src/orb_dynamics.cpp
  src/orb_audio.cpp
  src/orb_renderer.cpp
)
add_library(orb::orb ALIAS orb)
target_include_directories(orb PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>
)
target_compile_definitions(orb PUBLIC UNICODE _UNICODE NOMINMAX _WIN32_WINNT=0x0A00)
if(MSVC)
  target_compile_options(orb PUBLIC /utf-8 /W4 /permissive- /EHsc)
endif()
target_link_libraries(orb PUBLIC d3d11 d3dcompiler dxgi ole32 uuid user32)

if(ORB_BUILD_TESTS)
  enable_testing()
  add_executable(orb_conformance tests/conformance.cpp)
  target_link_libraries(orb_conformance PRIVATE orb)
  add_test(NAME conformance COMMAND orb_conformance)
endif()

if(ORB_BUILD_EXAMPLES)
  add_executable(orb_example WIN32 examples/win32/main.cpp)
  target_link_libraries(orb_example PRIVATE orb)
endif()

include(GNUInstallDirs)
install(TARGETS orb EXPORT orbTargets
  ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
  INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
install(EXPORT orbTargets NAMESPACE orb:: DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/orb)
