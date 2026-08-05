import Foundation

// MARK: - Shared exchange contract (mirror of the desktop's RemoteVTContract.swift)
//
// Kept byte-compatible with AvvioOne/Models/RemoteVT/RemoteVTContract.swift. In
// Phase 3 this becomes a shared Swift package (AvvioVTKit) both sides depend on.

enum RemoteVTContract {
    static let version = 1
    static func neighborKey(mediaItemID: Int64?, externalName: String?) -> String? {
        if let id = mediaItemID { return "media:\(id)" }
        if let name = externalName, !name.isEmpty { return "ext:\(name)" }
        return nil
    }
}

struct VTAudioRef: Codable, Sendable, Equatable {
    var filename: String
    var container: String
    var sampleRate: Double
    var channels: Int
    var durationMs: Int
}

struct VTElementCues: Codable, Sendable, Equatable {
    var startMs: Int
    var introEndMs: Int?
    var segueMs: Int?
    var fadeStartMs: Int?
    var endMs: Int
    var occurrenceSegueMs: Int?
}

struct VTContextElement: Codable, Sendable, Equatable {
    enum Role: String, Codable, Sendable { case outgoing, incoming }
    var role: Role
    var mediaItemID: Int64?
    var externalName: String?
    var title: String
    var artist: String?
    var category: String
    var fullPlayableMs: Int
    var snippetStartMs: Int
    var snippetDurationMs: Int
    var audio: VTAudioRef
    var waveform: [Float]
    var cues: VTElementCues
}

struct VTSlotFingerprint: Codable, Sendable, Equatable {
    var logDate: String
    var placeholderEntryID: Int64
    var scheduledHour: Int?
    var position: Int
    var outgoingKey: String?
    var incomingKey: String?
}

struct VTResultCues: Codable, Sendable, Equatable {
    var outgoingSegueMs: Int?
    var vtSegueMs: Int
    var fadeEndMs: Int?
    var fadeTargetGain: Float?
}

struct VTSession: Codable, Sendable, Equatable {
    var version: Int = RemoteVTContract.version
    var fingerprint: VTSlotFingerprint
    var label: String
    var airTimeISO: String?
    var assignedUserID: Int64?
    var outgoing: VTContextElement?
    var incoming: VTContextElement?
    var duckGain: Float
    var leadMs: Int
    var existing: VTResultCues?
    var createdAtISO: String?
    var expiresAtISO: String?
}

struct VTResult: Codable, Sendable, Equatable {
    var version: Int = RemoteVTContract.version
    var fingerprint: VTSlotFingerprint
    var voice: VTAudioRef
    var voiceDurationMs: Int
    var cues: VTResultCues
    var recordedByUserID: Int64?
    var recordedByName: String?
    var recordedAtISO: String?
}

// MARK: - Full log view (read-only context for the tracker)

struct VTLogEntryView: Codable, Sendable {
    var entryID: Int64
    var airTimeISO: String?
    var kind: String
    var category: String?
    var title: String
    var artist: String?
    var durationMs: Int
    var status: String
    var isVoiceTrack: Bool
    var isEmptyVoiceTrack: Bool
    var isRemark: Bool
    var markerLabel: String?
    var assignedUserID: Int64?
    var slotId: String?
}

struct VTLogView: Codable, Sendable {
    var version: Int = RemoteVTContract.version
    var logDate: String
    var nowISO: String?
    var entries: [VTLogEntryView]
}

// MARK: - Relay HTTP DTOs (mirrored on the desktop's RemoteVTSyncService)

/// One tracker the station authorizes, with the PBKDF2 verifier the desktop pushes.
struct TrackerRecord: Codable, Sendable {
    var userID: Int64
    var username: String
    var displayName: String
    var salt: String
    var hash: String
    var iterations: Int
    var expiresAtISO: String?
}

struct ProvisionRequest: Codable, Sendable {
    var trackers: [TrackerRecord]
    var revoke: [Int64]?
}

struct LoginRequest: Codable, Sendable { var username: String; var password: String }
struct LoginResponse: Codable, Sendable { var token: String; var expiresAtISO: String; var displayName: String; var userID: Int64 }

/// A slot as a tracker sees it in their list.
struct SlotSummary: Codable, Sendable {
    var slotId: String
    var label: String
    var airTimeISO: String?
    var status: String
    var hasResult: Bool
}

/// A completed result the station pulls (manifest + where to fetch the audio).
struct ResultSummary: Codable, Sendable {
    var resultId: String
    var slotId: String
    var result: VTResult
    var uploadedAtISO: String
}

struct ResultsPage: Codable, Sendable {
    var results: [ResultSummary]
    var cursor: String
}

struct StationStatus: Codable, Sendable {
    var ok: Bool
    var pendingSlots: Int
    var unackedResults: Int
    var trackers: Int
}
