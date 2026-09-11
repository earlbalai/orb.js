// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "OrbKit",
  platforms: [
    .iOS(.v15),
    .macOS(.v12),
  ],
  products: [
    .library(name: "OrbKit", targets: ["OrbKit"]),
  ],
  targets: [
    .target(
      name: "OrbKit",
      path: "Sources/OrbKit",
      linkerSettings: [
        .linkedFramework("Metal"),
        .linkedFramework("MetalKit"),
        .linkedFramework("QuartzCore"),
        .linkedFramework("AVFoundation"),
      ]
    ),
    .testTarget(
      name: "OrbKitTests",
      dependencies: ["OrbKit"],
      path: "Tests/OrbKitTests"
    ),
  ]
)
