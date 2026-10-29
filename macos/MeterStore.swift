import AppKit
import SwiftUI

enum SessionEvent {
    case locked, unlocked, willSleep, didWake, resignedActive, becameActive
}

enum DesktopSession {
    static func canRefresh() -> Bool {
        guard let state = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        // This WindowServer key and the distributed lock notifications are
        // macOS conventions; NSWorkspace's active-session notifications alone
        // cover user switching, not every screen-lock path.
        return state["CGSSessionScreenIsLocked"] as? Bool != true
            && state[kCGSessionOnConsoleKey as String] as? Bool != false
    }
}

struct ProviderState: Identifiable {
    let id: String
    let name: String
    let color: Color
    var reading: ProviderReading?
    var receivedAt: Date?
    var error: String?
    var loading = false

    var failureTitle: String {
        guard let error else { return "Waiting for a reading" }
        if error.localizedCaseInsensitiveContains("TLS") || error.contains("cookie refresh") {
            return "Sign-in connection failed"
        }
        if error.contains("not enabled") { return "Provider is not enabled" }
        return reading == nil ? "Meter unavailable" : "Offline · showing last reading"
    }

    func freshness(at now: Date) -> String {
        guard let receivedAt else { return loading ? "Connecting…" : "Waiting for server" }
        let capture = reading?.capturedAt
        let stamp = capture ?? receivedAt
        let age = max(0, now.timeIntervalSince(stamp))
        let prefix = capture != nil ? "Snapshot" : "Updated"
        if age >= 3600 { return "\(prefix) \(Int(age / 3600))h ago · \(MeterDates.clock(stamp))" }
        if age >= 180 { return "\(prefix) \(Int(age / 60))m ago" }
        return "\(prefix) \(MeterDates.clock(stamp))"
    }
}

@MainActor
final class MeterStore: ObservableObject {
    typealias FetchProvider = (URL) async throws -> ProviderEnvelope

    @Published var providers = [
        ProviderState(id: "v2free", name: "V2Free", color: MeterPalette.green),
        ProviderState(id: "gpt", name: "Codex", color: MeterPalette.cyan),
        ProviderState(id: "claude", name: "Claude", color: MeterPalette.brown)
    ]
    @Published var now = Date()
    @Published private(set) var isRefreshPaused = true
    let server: URL
    private var timer: Timer?
    private var nextRefresh = Date.distantPast
    private var started = false
    private var locked = false
    private var sleeping = false
    private var activeSession = true
    private var requestGeneration = 0
    private var requests: [String: Task<Void, Never>] = [:]
    private let sessionCanRefresh: () -> Bool
    private let fetchProvider: FetchProvider

    init(server: URL, sessionCanRefresh: @escaping () -> Bool = DesktopSession.canRefresh,
         fetchProvider: FetchProvider? = nil) {
        self.server = server
        self.sessionCanRefresh = sessionCanRefresh
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 55
        configuration.timeoutIntervalForResource = 70
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        let session = URLSession(configuration: configuration)
        self.fetchProvider = fetchProvider ?? { url in
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let failure = try? JSONDecoder().decode(ProviderFailure.self, from: data)
                throw NSError(domain: "Meterboard", code: 1, userInfo: [NSLocalizedDescriptionKey: failure?.error ?? "Server returned an error"])
            }
            return try JSONDecoder().decode(ProviderEnvelope.self, from: data)
        }
    }

    func start() {
        guard !started else { return }
        started = true
        refreshAll()
        // Keep this cheap local state check alive while paused as a fallback
        // for missed notifications. It never polls the server while locked.
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    func stop() {
        started = false
        timer?.invalidate()
        timer = nil
        cancelRequests()
    }

    func tick(at date: Date = Date()) {
        guard started else { return }
        // A fresh WindowServer read also recovers if an unlock notification
        // was missed. Lock notifications themselves pause immediately.
        locked = !sessionCanRefresh()
        let resumed = synchronizePauseState()
        guard !isRefreshPaused else { return }
        now = date
        if resumed || now >= nextRefresh { refreshAll() }
    }

    func handleSessionEvent(_ event: SessionEvent) {
        switch event {
        case .locked: locked = true
        case .unlocked: locked = false
        case .willSleep: sleeping = true
        case .didWake: sleeping = false
        case .resignedActive: activeSession = false
        case .becameActive: activeSession = true
        }
        let resumed = synchronizePauseState()
        if started && !isRefreshPaused && (resumed || event == .didWake) { refreshAll() }
    }

    @discardableResult
    private func synchronizePauseState() -> Bool {
        let paused = locked || sleeping || !activeSession || !sessionCanRefresh()
        let resumed = isRefreshPaused && !paused
        if paused != isRefreshPaused {
            isRefreshPaused = paused
            if paused { cancelRequests() }
        }
        return resumed
    }

    private func cancelRequests() {
        requestGeneration += 1
        for task in requests.values { task.cancel() }
        requests.removeAll()
        for index in providers.indices { providers[index].loading = false }
    }

    func refreshAll() {
        synchronizePauseState()
        guard !isRefreshPaused else { return }
        nextRefresh = Date().addingTimeInterval(WidgetConfiguration.refreshInterval)
        for provider in providers { refresh(provider.id) }
    }

    func refresh(_ id: String) {
        synchronizePauseState()
        guard !isRefreshPaused else { return }
        guard let index = providers.firstIndex(where: { $0.id == id }), !providers[index].loading else { return }
        providers[index].loading = true
        let generation = requestGeneration
        requests[id] = Task {
            defer {
                // A canceled request must not clear the loading state of the
                // replacement request started immediately after unlock.
                if generation == requestGeneration {
                    providers[index].loading = false
                    requests.removeValue(forKey: id)
                }
            }
            do {
                synchronizePauseState()
                guard !isRefreshPaused, generation == requestGeneration else { return }
                try Task.checkCancellation()
                let url = WidgetConfiguration.endpoint(server: server, providerID: id)
                let envelope = try await fetchProvider(url)
                try Task.checkCancellation()
                guard generation == requestGeneration, !isRefreshPaused else { return }
                guard envelope.provider.accepts(providerID: id) else {
                    throw NSError(domain: "Meterboard", code: 2, userInfo: [NSLocalizedDescriptionKey: "Server returned a different provider"])
                }
                providers[index].reading = envelope.provider
                providers[index].receivedAt = MeterDates.parse(envelope.fetchedAt) ?? Date()
                providers[index].error = nil
                now = Date()
            } catch {
                guard !Task.isCancelled, generation == requestGeneration, !isRefreshPaused else { return }
                // Retain the last successful reading, visibly marked offline.
                providers[index].error = error.localizedDescription
            }
        }
    }
}
