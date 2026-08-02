// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AvvioVTRelay",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/vapor/vapor.git", from: "4.106.0"),
    ],
    targets: [
        .executableTarget(
            name: "AvvioVTRelay",
            dependencies: [
                .product(name: "Vapor", package: "vapor"),
            ],
            path: "Sources/AvvioVTRelay"
        )
    ]
)
