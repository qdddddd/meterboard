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

    // The short form of resetText for the "↻" tag.
    func countdown(at now: Date) -> String {
        if resetPassed(at: now) { return "Updating" }
        let full = resetText(at: now)
        if full.contains("after first use") { return "First use" }
        return full.replacingOccurrences(of: "Resets in ", with: "")
    }

    func percentText(at now: Date) -> String {
        guard let value = percent(at: now) else { return "—" }
        return value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
    }

    // Claude's extra-usage and spend-cap meters measure money, not a limit
    // window, so while a limit window exists they neither lead the gauge
    // nor take a ring.
    var isCredit: Bool { id == "extra_usage" || id == "spend" }

    // The short name drawn along a gauge ring: the model or surface scope of
    // a scoped limit, the bracketed qualifier of a weekly one, else the
    // window name without its bracket.
    var ringLabel: String {
        var name = label.components(separatedBy: " · ").last ?? label
        if name.hasPrefix("Weekly (") { name.removeFirst(8) }
        return name.prefix(while: { $0 != "(" && $0 != ")" }).trimmingCharacters(in: .whitespaces).uppercased()
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

    // Claude's all-models weekly limit outranks the active one, which is
    // often a model-scoped bucket such as Weekly · Fable.
    var primary: UsageMeter? {
        meters.first(where: { $0.id.hasPrefix("weekly_all") })
            ?? meters.first(where: { $0.isActive == true && !$0.isCredit }) ?? meters.first
    }

    // Concentric gauge rings, outermost first: the primary limit, then the
    // other rate-limit windows in payload order. Credit meters stay in the
    // rows, and three rings is as many as leave room for the centre reading.
    var rings: [UsageMeter] {
        guard let primary else { return [] }
        let others = meters.filter { $0.id != primary.id && !$0.isCredit }
        return Array(([primary] + others).prefix(3))
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
