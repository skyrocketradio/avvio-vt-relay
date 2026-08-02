import Vapor

// Vapor `Content` conformance for the API DTOs. Kept here (not in Contract.swift) so
// the shared contract stays Vapor-free and portable to the desktop/iOS.
extension ProvisionRequest: Content {}
extension LoginRequest: Content {}
extension LoginResponse: Content {}
extension SlotSummary: Content {}
extension ResultSummary: Content {}
extension ResultsPage: Content {}
extension StationStatus: Content {}

struct RefreshResponse: Content { var expiresAtISO: String }
