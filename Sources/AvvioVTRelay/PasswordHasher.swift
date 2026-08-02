import Foundation
import Crypto

/// Byte-for-byte replica of the desktop's `PasswordHasher` (AvvioOne/Models/User.swift):
/// iterated HMAC-SHA256, so a password typed into the web/iOS client validates against
/// the verifier the desktop pushed. Uses swift-crypto (same API as CryptoKit).
enum PasswordHasher {
    static func hash(password: String, salt: String, iterations: Int) -> String {
        let key = SymmetricKey(data: Data(salt.utf8))
        var block = Data(password.utf8)
        for _ in 0..<iterations {
            block = Data(HMAC<SHA256>.authenticationCode(for: block, using: key))
        }
        return block.hexString
    }

    /// Constant-time verify against the stored hash.
    static func verify(password: String, salt: String, iterations: Int, expectedHash: String) -> Bool {
        let computed = hash(password: password, salt: salt, iterations: iterations)
        guard computed.count == expectedHash.count else { return false }
        return zip(computed.utf8, expectedHash.utf8).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
    }
}

extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}

/// A random URL-safe token.
enum TokenGen {
    static func random(_ bytes: Int = 32) -> String {
        Data((0..<bytes).map { _ in UInt8.random(in: .min ... .max) }).hexString
    }
}
