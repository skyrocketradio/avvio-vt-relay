import Foundation

/// In-memory tracker session tokens. Lost on restart (trackers just log in again),
/// which is fine — nothing durable should live only in a session.
actor Tokens {
    struct Info: Sendable { let userID: Int64; let displayName: String; var expiry: Date }
    private var map: [String: Info] = [:]

    func issue(userID: Int64, displayName: String, ttl: TimeInterval) -> (token: String, expiry: Date) {
        let token = TokenGen.random()
        let expiry = Date().addingTimeInterval(ttl)
        map[token] = Info(userID: userID, displayName: displayName, expiry: expiry)
        return (token, expiry)
    }

    func validate(_ token: String) -> Info? {
        guard let info = map[token] else { return nil }
        guard info.expiry > Date() else { map[token] = nil; return nil }
        return info
    }

    func refresh(_ token: String, ttl: TimeInterval) -> Date? {
        guard var info = map[token], info.expiry > Date() else { return nil }
        info.expiry = Date().addingTimeInterval(ttl)
        map[token] = info
        return info.expiry
    }

    func revokeUser(_ userID: Int64) {
        for (t, i) in map where i.userID == userID { map[t] = nil }
    }
}
