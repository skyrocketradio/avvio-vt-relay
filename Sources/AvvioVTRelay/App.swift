import Vapor
import Foundation

// MARK: - Entry point

@main
struct Entrypoint {
    static func main() async throws {
        var env = try Environment.detect()
        try LoggingSystem.bootstrap(from: &env)
        let app = try await Application.make(env)
        do {
            try await configure(app)
            try await app.execute()
        } catch {
            app.logger.report(error: error)
            try? await app.asyncShutdown()
            throw error
        }
        try await app.asyncShutdown()
    }
}

// MARK: - Configuration

/// Process-wide services, resolved once from the environment.
struct Relay: Sendable {
    let storage: Storage
    let tokens: Tokens
    let stationKey: String
    let loginTTL: TimeInterval
}

/// Force browsers to revalidate the web app's static assets on every load (cheap: ETag →
/// 304 when unchanged) so a new deploy is never masked by a stale cached `app.js`/HTML.
struct CacheControlMiddleware: AsyncMiddleware {
    func respond(to request: Request, chainingTo next: AsyncResponder) async throws -> Response {
        let response = try await next.respond(to: request)
        let path = request.url.path
        if path == "/" || path.hasSuffix(".html") || path.hasSuffix(".js") || path.hasSuffix(".css") {
            response.headers.replaceOrAdd(name: .cacheControl, value: "no-cache, must-revalidate")
        }
        return response
    }
}

func configure(_ app: Application) async throws {
    let dataDir = URL(fileURLWithPath: Environment.get("AVVIO_VT_DATA") ?? "./data", isDirectory: true)
    let stationKey = Environment.get("AVVIO_VT_STATION_KEY") ?? ""
    let expiryDays = Int(Environment.get("AVVIO_VT_EXPIRY_DAYS") ?? "") ?? 14
    if stationKey.isEmpty { app.logger.warning("AVVIO_VT_STATION_KEY is empty — station endpoints are OPEN. Set it before production.") }

    let relay = Relay(storage: try Storage(root: dataDir, expiryDays: expiryDays),
                      tokens: Tokens(),
                      stationKey: stationKey,
                      loginTTL: 8 * 3600)

    app.routes.defaultMaxBodySize = "25mb"
    if let port = Int(Environment.get("PORT") ?? "") { app.http.server.configuration.port = port }
    app.http.server.configuration.hostname = Environment.get("HOST") ?? "0.0.0.0"

    // Serve the web tracking app (Public/) at the root, same-origin with the API.
    // CacheControl wraps FileMiddleware so its static responses always revalidate.
    app.middleware.use(CacheControlMiddleware())
    app.middleware.use(FileMiddleware(publicDirectory: app.directory.publicDirectory, defaultFile: "index.html"))

    try routes(app, relay)

    // Expiry reaper every hour.
    Task { [storage = relay.storage] in
        while true {
            await storage.reap(now: Date())
            try? await Task.sleep(nanoseconds: 3600 * 1_000_000_000)
        }
    }
}

// MARK: - Multipart upload shapes

struct SlotUpload: Content {
    var session: String        // session.json text
    var outgoing: File?
    var incoming: File?
}
struct ResultUpload: Content {
    var result: String         // result.json text
    var voice: File
}

// MARK: - Auth helpers

private func requireStation(_ req: Request, _ relay: Relay) throws {
    // When a key is configured, require it; empty key = open (dev only, warned above).
    guard relay.stationKey.isEmpty || req.headers.bearerAuthorization?.token == relay.stationKey else {
        throw Abort(.unauthorized, reason: "Bad station key.")
    }
}
private func requireTracker(_ req: Request, _ relay: Relay) async throws -> Tokens.Info {
    guard let token = req.headers.bearerAuthorization?.token,
          let info = await relay.tokens.validate(token) else { throw Abort(.unauthorized, reason: "Sign in again.") }
    return info
}

// MARK: - Routes

func routes(_ app: Application, _ relay: Relay) throws {
    app.get("v1", "health") { _ in "ok" }

    // Public station info for the web/iOS header.
    app.get("v1", "info") { _ in InfoResponse(stationName: Environment.get("AVVIO_VT_STATION_NAME") ?? "Skyrocket Radio") }

    // ---- Station (desktop) endpoints ----
    let station = app.grouped("v1", "station")

    station.post("provision") { req async throws -> StationStatus in
        try requireStation(req, relay)
        let body = try req.content.decode(ProvisionRequest.self)
        try await relay.storage.provision(body)
        for id in body.revoke ?? [] { await relay.tokens.revokeUser(id) }
        return await relay.storage.status()
    }

    station.on(.PUT, "slots", ":slotId", body: .collect(maxSize: "25mb")) { req async throws -> Response in
        try requireStation(req, relay)
        let upload = try req.content.decode(SlotUpload.self)
        let sessionData = Data(upload.session.utf8)
        try await relay.storage.putSlot(sessionJSON: sessionData,
                                        outgoing: upload.outgoing.map { Data(buffer: $0.data) },
                                        incoming: upload.incoming.map { Data(buffer: $0.data) },
                                        now: Date())
        return Response(status: .ok)
    }

    station.delete("slots", ":slotId") { req async throws -> Response in
        try requireStation(req, relay)
        await relay.storage.deleteSlot(req.parameters.get("slotId") ?? "")
        return Response(status: .ok)
    }

    station.get("results") { req async throws -> ResultsPage in
        try requireStation(req, relay)
        let since: String? = req.query["since"]
        return try await relay.storage.unackedResults(since: since)
    }

    station.get("results", ":id", "audio") { req async throws -> Response in
        try requireStation(req, relay)
        guard let url = await relay.storage.resultVoiceURL(req.parameters.get("id") ?? "") else { throw Abort(.notFound) }
        return req.fileio.streamFile(at: url.path)
    }

    station.post("results", ":id", "ack") { req async throws -> Response in
        try requireStation(req, relay)
        await relay.storage.ackResult(req.parameters.get("id") ?? "", now: Date())
        return Response(status: .ok)
    }

    station.get("status") { req async throws -> StationStatus in
        try requireStation(req, relay)
        return await relay.storage.status()
    }

    // Push the full day's log (read-only context for trackers).
    station.on(.PUT, "log", ":date", body: .collect(maxSize: "10mb")) { req async throws -> Response in
        try requireStation(req, relay)
        guard let buf = req.body.data else { throw Abort(.badRequest) }
        try await relay.storage.putLog(date: req.parameters.get("date") ?? "", json: Data(buffer: buf))
        return Response(status: .ok)
    }

    // ---- Tracker (web/iOS) endpoints ----
    app.post("v1", "auth", "login") { req async throws -> LoginResponse in
        let body = try req.content.decode(LoginRequest.self)
        guard let t = await relay.storage.tracker(username: body.username),
              PasswordHasher.verify(password: body.password, salt: t.salt, iterations: t.iterations, expectedHash: t.hash)
        else { throw Abort(.unauthorized, reason: "Wrong username or password.") }
        let (token, expiry) = await relay.tokens.issue(userID: t.userID, displayName: t.displayName, ttl: relay.loginTTL)
        return LoginResponse(token: token, expiresAtISO: ISO8601DateFormatter().string(from: expiry),
                             displayName: t.displayName, userID: t.userID)
    }

    app.post("v1", "auth", "refresh") { req async throws -> RefreshResponse in
        _ = try await requireTracker(req, relay)
        let token = req.headers.bearerAuthorization!.token
        guard let expiry = await relay.tokens.refresh(token, ttl: relay.loginTTL) else { throw Abort(.unauthorized) }
        return RefreshResponse(expiresAtISO: ISO8601DateFormatter().string(from: expiry))
    }

    let me = app.grouped("v1", "me")

    me.get("slots") { req async throws -> [SlotSummary] in
        let info = try await requireTracker(req, relay)
        return await relay.storage.slotsForUser(info.userID)
    }

    // The tracker's own user id (so the client knows which VT rows it may edit).
    me.get("whoami") { req async throws -> WhoAmI in
        let info = try await requireTracker(req, relay)
        return WhoAmI(userID: info.userID, displayName: info.displayName)
    }

    // Available log dates + the full read-only log for a date.
    me.get("logdates") { req async throws -> [String] in
        _ = try await requireTracker(req, relay)
        return await relay.storage.logDates()
    }
    me.get("log", ":date") { req async throws -> Response in
        _ = try await requireTracker(req, relay)
        guard let json = await relay.storage.logJSON(date: req.parameters.get("date") ?? "") else { throw Abort(.notFound) }
        var headers = HTTPHeaders(); headers.contentType = .json
        return Response(status: .ok, headers: headers, body: .init(data: json))
    }

    me.get("slots", ":slotId") { req async throws -> Response in
        let info = try await requireTracker(req, relay)
        let slotId = req.parameters.get("slotId") ?? ""
        guard let meta = await relay.storage.slotMeta(slotId), meta.assignedUserID == info.userID else { throw Abort(.notFound) }
        guard let json = await relay.storage.slotSessionJSON(slotId) else { throw Abort(.gone) }
        await relay.storage.claimSlot(slotId, by: info.userID)
        var headers = HTTPHeaders(); headers.contentType = .json
        return Response(status: .ok, headers: headers, body: .init(data: json))
    }

    me.get("slots", ":slotId", "audio", ":role") { req async throws -> Response in
        let info = try await requireTracker(req, relay)
        let slotId = req.parameters.get("slotId") ?? ""
        let role = req.parameters.get("role") ?? ""
        guard let meta = await relay.storage.slotMeta(slotId), meta.assignedUserID == info.userID else { throw Abort(.notFound) }
        guard let url = await relay.storage.slotAudioURL(slotId, role: role) else { throw Abort(.notFound) }
        return req.fileio.streamFile(at: url.path)
    }

    me.post("slots", ":slotId", "claim") { req async throws -> Response in
        let info = try await requireTracker(req, relay)
        let slotId = req.parameters.get("slotId") ?? ""
        guard let meta = await relay.storage.slotMeta(slotId), meta.assignedUserID == info.userID else { throw Abort(.notFound) }
        await relay.storage.claimSlot(slotId, by: info.userID)
        return Response(status: .ok)
    }

    me.on(.POST, "slots", ":slotId", "result", body: .collect(maxSize: "25mb")) { req async throws -> Response in
        let info = try await requireTracker(req, relay)
        let slotId = req.parameters.get("slotId") ?? ""
        guard let meta = await relay.storage.slotMeta(slotId), meta.assignedUserID == info.userID else { throw Abort(.notFound) }
        let upload = try req.content.decode(ResultUpload.self)
        _ = try await relay.storage.saveResult(slotId: slotId, resultJSON: Data(upload.result.utf8),
                                               voice: Data(buffer: upload.voice.data), now: Date())
        return Response(status: .created)
    }
}
