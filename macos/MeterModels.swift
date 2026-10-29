import Foundation

enum MeterDates {
    static func parse(_ text: String?) -> Date? {
        guard let text else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    static func clock(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }
}

struct UsageMeter: Decodable, Identifiable {
    let id: String
    let label: String
    let usedPercent: Double?
    let resetsAt: String?
    let severity: String?
    let detail: String?
    let isActive: Bool?

    func resetPassed(at now: Date) -> Bool {
        if detail?.localizedCaseInsensitiveContains("window reset since") == true { return true }
        return MeterDates.parse(resetsAt).map { $0 <= now } ?? false
    }

    func percent(at now: Date) -> Double? {
        guard !resetPassed(at: now), let usedPercent, usedPercent.isFinite else { return nil }
        return min(100, max(0, usedPercent))
    }

    func resetText(at now: Date) -> String {
        if resetPassed(at: now) { return "Reset passed · awaiting update" }
        guard let reset = MeterDates.parse(resetsAt) else {
            if let detail, detail.contains("after first use") { return detail }
            return ""
        }
        let minutes = max(1, Int(ceil(reset.timeIntervalSince(now) / 60)))
        if minutes < 60 { return "Resets in \(minutes)m" }
        if minutes < 1440 { return "Resets in \(minutes / 60)h \(minutes % 60)m" }
        return "Resets in \(minutes / 1440)d \((minutes % 1440) / 60)h"
    }

    func percentText(at now: Date) -> String {
        guard let value = percent(at: now) else { return "—" }
        return value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
    }
}

struct ProviderReading: Decodable {
    struct Account: Decodable { let planLabel: String? }
    struct Stat: Decodable { let label: String; let value: String }
    struct Metadata: Decodable {
        let sourceProviderId: String?
        let source: String?
        let snapshotAt: String?
        let stats: [Stat]?
    }
    let provider: String
    let account: Account?
    let meters: [UsageMeter]
    let meta: Metadata?

    var primary: UsageMeter? {
        meters.first(where: { $0.isActive == true }) ?? meters.first
    }

    var capturedAt: Date? { MeterDates.parse(meta?.snapshotAt) }

    func accepts(providerID: String) -> Bool {
        (meta?.sourceProviderId ?? provider) == providerID
    }
}

struct ProviderEnvelope: Decodable {
    let provider: ProviderReading
    let fetchedAt: String
}

struct ProviderFailure: Decodable { let error: String }

enum WidgetConfiguration {
    static let defaultServer = "http://localhost:8088"
    static let refreshInterval: TimeInterval = 120

    static func serverURL(_ value: String) -> URL? {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme, ["http", "https"].contains(scheme),
              url.host != nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else { return nil }
        return url
    }

    static func endpoint(server: URL, providerID: String) -> URL {
        var parts = URLComponents(url: server.appendingPathComponent("api/provider"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "provider", value: providerID)]
        return parts.url!
    }
}
