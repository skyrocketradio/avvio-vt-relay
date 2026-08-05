import Foundation

/// File-backed store: JSON metadata + local-disk audio blobs under one data dir, so
/// deployment is just a mounted volume (the locked "local disk + expiry" choice).
/// Serialized behind an actor. Holds only transition snippets, results, and pushed
/// verifiers — never the station's library or logs.
actor Storage {
    private let root: URL
    private let fm = FileManager.default
    private let expiryDays: Int

    struct SlotMeta: Codable {
        var slotId: String
        var assignedUserID: Int64?
        var label: String
        var airTimeISO: String?
        var status: String              // pending | claimed | completed
        var claimedBy: Int64?
        var createdAtISO: String
        var expiresAtISO: String
        var resultId: String?
    }
    struct ResultMeta: Codable {
        var resultId: String            // zero-padded sequence, sortable
        var slotId: String
        var uploadedByUserID: Int64?
        var uploadedByName: String?
        var uploadedAtISO: String
        var ackedAtISO: String?
        var expiresAtISO: String
    }

    init(root: URL, expiryDays: Int) throws {
        self.root = root
        self.expiryDays = expiryDays
        for sub in ["slots", "results"] {
            try fm.createDirectory(at: root.appendingPathComponent(sub), withIntermediateDirectories: true)
        }
    }

    // MARK: Trackers

    private var trackersURL: URL { root.appendingPathComponent("trackers.json") }

    func loadTrackers() -> [TrackerRecord] {
        guard let data = try? Data(contentsOf: trackersURL),
              let list = try? JSONDecoder().decode([TrackerRecord].self, from: data) else { return [] }
        return list
    }

    func provision(_ req: ProvisionRequest) throws {
        var byID = Dictionary(uniqueKeysWithValues: loadTrackers().map { ($0.userID, $0) })
        for t in req.trackers { byID[t.userID] = t }
        for id in req.revoke ?? [] { byID.removeValue(forKey: id) }
        let data = try JSONEncoder().encode(Array(byID.values))
        try data.write(to: trackersURL, options: .atomic)
    }

    func tracker(username: String) -> TrackerRecord? {
        loadTrackers().first { $0.username.caseInsensitiveCompare(username) == .orderedSame }
    }

    // MARK: Slots

    private func slotDir(_ slotId: String) -> URL { root.appendingPathComponent("slots/\(safe(slotId))", isDirectory: true) }

    /// Create/replace a slot from an uploaded session + optional context audio.
    func putSlot(sessionJSON: Data, outgoing: Data?, incoming: Data?, now: Date) throws {
        let session = try JSONDecoder().decode(VTSession.self, from: sessionJSON)
        let slotId = Self.slotId(for: session.fingerprint)
        let dir = slotDir(slotId)
        try? fm.removeItem(at: dir)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try sessionJSON.write(to: dir.appendingPathComponent("session.json"), options: .atomic)
        if let outgoing { try outgoing.write(to: dir.appendingPathComponent("outgoing.m4a"), options: .atomic) }
        if let incoming { try incoming.write(to: dir.appendingPathComponent("incoming.m4a"), options: .atomic) }
        let meta = SlotMeta(slotId: slotId, assignedUserID: session.assignedUserID, label: session.label,
                            airTimeISO: session.airTimeISO, status: "pending", claimedBy: nil,
                            createdAtISO: iso(now), expiresAtISO: iso(now.addingTimeInterval(Double(expiryDays) * 86_400)),
                            resultId: nil)
        try writeMeta(meta, in: dir)
    }

    func deleteSlot(_ slotId: String) { try? fm.removeItem(at: slotDir(slotId)) }

    func slotSessionJSON(_ slotId: String) -> Data? { try? Data(contentsOf: slotDir(slotId).appendingPathComponent("session.json")) }
    func slotAudioURL(_ slotId: String, role: String) -> URL? {
        let name = role == "outgoing" ? "outgoing.m4a" : "incoming.m4a"
        let url = slotDir(slotId).appendingPathComponent(name)
        return fm.fileExists(atPath: url.path) ? url : nil
    }
    func slotMeta(_ slotId: String) -> SlotMeta? { readMeta(SlotMeta.self, in: slotDir(slotId)) }

    func slotsForUser(_ userID: Int64) -> [SlotSummary] {
        allSlotMetas()
            .filter { $0.assignedUserID == userID }
            .sorted { ($0.airTimeISO ?? "") < ($1.airTimeISO ?? "") }
            .map { SlotSummary(slotId: $0.slotId, label: $0.label, airTimeISO: $0.airTimeISO,
                               status: $0.status, hasResult: $0.resultId != nil) }
    }

    func claimSlot(_ slotId: String, by userID: Int64) {
        guard var meta = slotMeta(slotId) else { return }
        meta.claimedBy = userID
        if meta.status == "pending" { meta.status = "claimed" }
        try? writeMeta(meta, in: slotDir(slotId))
    }

    // MARK: Results

    private func resultDir(_ resultId: String) -> URL { root.appendingPathComponent("results/\(safe(resultId))", isDirectory: true) }

    func saveResult(slotId: String, resultJSON: Data, voice: Data, now: Date) throws -> String {
        let result = try JSONDecoder().decode(VTResult.self, from: resultJSON)
        let resultId = nextResultId()
        let dir = resultDir(resultId)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try resultJSON.write(to: dir.appendingPathComponent("result.json"), options: .atomic)
        try voice.write(to: dir.appendingPathComponent("voice.m4a"), options: .atomic)
        let meta = ResultMeta(resultId: resultId, slotId: slotId, uploadedByUserID: result.recordedByUserID,
                              uploadedByName: result.recordedByName, uploadedAtISO: iso(now), ackedAtISO: nil,
                              expiresAtISO: iso(now.addingTimeInterval(Double(expiryDays) * 86_400)))
        try writeMeta(meta, in: dir)
        // Mark the slot completed.
        if var s = slotMeta(slotId) { s.status = "completed"; s.resultId = resultId; try? writeMeta(s, in: slotDir(slotId)) }
        return resultId
    }

    func unackedResults(since cursor: String?) throws -> ResultsPage {
        let metas = allResultMetas()
            .filter { $0.ackedAtISO == nil && (cursor == nil || $0.resultId > cursor!) }
            .sorted { $0.resultId < $1.resultId }
        var out: [ResultSummary] = []
        for m in metas {
            guard let data = try? Data(contentsOf: resultDir(m.resultId).appendingPathComponent("result.json")),
                  let result = try? JSONDecoder().decode(VTResult.self, from: data) else { continue }
            out.append(ResultSummary(resultId: m.resultId, slotId: m.slotId, result: result, uploadedAtISO: m.uploadedAtISO))
        }
        return ResultsPage(results: out, cursor: out.last?.resultId ?? (cursor ?? ""))
    }

    func resultVoiceURL(_ resultId: String) -> URL? {
        let url = resultDir(resultId).appendingPathComponent("voice.m4a")
        return fm.fileExists(atPath: url.path) ? url : nil
    }

    func ackResult(_ resultId: String, now: Date) {
        guard var meta = readMeta(ResultMeta.self, in: resultDir(resultId)) else { return }
        meta.ackedAtISO = iso(now)
        try? writeMeta(meta, in: resultDir(resultId))
    }

    // MARK: Full log view (read-only context)

    private var logsDir: URL { root.appendingPathComponent("logs", isDirectory: true) }

    func putLog(date: String, json: Data) throws {
        try fm.createDirectory(at: logsDir, withIntermediateDirectories: true)
        try json.write(to: logsDir.appendingPathComponent("\(safe(date)).json"), options: .atomic)
    }
    func logJSON(date: String) -> Data? {
        try? Data(contentsOf: logsDir.appendingPathComponent("\(safe(date)).json"))
    }
    func logDates() -> [String] {
        let urls = (try? fm.contentsOfDirectory(at: logsDir, includingPropertiesForKeys: nil)) ?? []
        return urls.filter { $0.pathExtension == "json" }.map { $0.deletingPathExtension().lastPathComponent }.sorted()
    }

    // MARK: Status & reaper

    func status() -> StationStatus {
        let slots = allSlotMetas()
        let results = allResultMetas()
        return StationStatus(ok: true,
                             pendingSlots: slots.filter { $0.status != "completed" }.count,
                             unackedResults: results.filter { $0.ackedAtISO == nil }.count,
                             trackers: loadTrackers().count)
    }

    func reap(now: Date) {
        let cutoff = iso(now)
        for m in allSlotMetas() where m.expiresAtISO < cutoff { deleteSlot(m.slotId) }
        for m in allResultMetas() where m.expiresAtISO < cutoff || (m.ackedAtISO != nil) {
            // Acked results can be pruned immediately; expired ones too.
            if m.ackedAtISO != nil || m.expiresAtISO < cutoff { try? fm.removeItem(at: resultDir(m.resultId)) }
        }
    }

    // MARK: Helpers

    static func slotId(for fp: VTSlotFingerprint) -> String { "\(fp.logDate)_\(fp.placeholderEntryID)" }

    private func allSlotMetas() -> [SlotMeta] {
        childDirs("slots").compactMap { readMeta(SlotMeta.self, in: $0) }
    }
    private func allResultMetas() -> [ResultMeta] {
        childDirs("results").compactMap { readMeta(ResultMeta.self, in: $0) }
    }
    private func childDirs(_ sub: String) -> [URL] {
        (try? fm.contentsOfDirectory(at: root.appendingPathComponent(sub), includingPropertiesForKeys: nil)) ?? []
    }
    private func nextResultId() -> String {
        let maxSeq = allResultMetas().compactMap { Int($0.resultId) }.max() ?? 0
        return String(format: "%012d", maxSeq + 1)
    }
    private func writeMeta<T: Encodable>(_ meta: T, in dir: URL) throws {
        try JSONEncoder().encode(meta).write(to: dir.appendingPathComponent("meta.json"), options: .atomic)
    }
    private func readMeta<T: Decodable>(_ type: T.Type, in dir: URL) -> T? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("meta.json")) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
    private func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
    /// Strip anything that could escape the data dir.
    private func safe(_ id: String) -> String {
        String(id.unicodeScalars.map { CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-").contains($0) ? Character($0) : "_" })
    }
}
