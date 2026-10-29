import Foundation

@MainActor
private final class ControlledProvider {
    struct Request {
        let provider: String
        var continuation: CheckedContinuation<ProviderEnvelope, Error>?
    }
    var requests: [Request] = []
    var canceled: Set<Int> = []

    func fetch(_ url: URL) async throws -> ProviderEnvelope {
        let id = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first!.value!
        let index = requests.count
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                requests.append(Request(provider: id, continuation: continuation))
            }
        } onCancel: {
            Task { @MainActor in self.canceled.insert(index) }
        }
    }

    func complete(_ range: Range<Int>, percent: Int) throws {
        for index in range {
            let request = requests[index]
            let data = try JSONSerialization.data(withJSONObject: [
                "provider": [
                    "provider": request.provider,
                    "meters": [["id": "weekly", "label": "Weekly", "usedPercent": percent]]
                ],
                "fetchedAt": "2026-10-19T14:00:00Z"
            ])
            let result = try JSONDecoder().decode(ProviderEnvelope.self, from: data)
            requests[index].continuation = nil
            request.continuation?.resume(returning: result)
        }
    }
}

@main
enum MeterRefreshTests {
    @MainActor static func main() async throws {
        var checks = 0
        func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
            guard condition() else { fatalError("FAIL: \(label)") }
            checks += 1
        }
        func settle() async { try? await Task.sleep(nanoseconds: 30_000_000) }
        func waitFor(_ condition: () -> Bool) async {
            for _ in 0..<200 {
                if condition() { return }
                try? await Task.sleep(nanoseconds: 5_000_000)
            }
            fatalError("Timed out waiting for refresh tasks")
        }

        var sessionAvailable = false
        let network = ControlledProvider()
        let store = MeterStore(server: URL(string: "http://meterboard.test")!,
                               sessionCanRefresh: { sessionAvailable },
                               fetchProvider: { try await network.fetch($0) })
        defer { store.stop() }
        store.start()
        store.tick(at: Date().addingTimeInterval(600))
        store.handleSessionEvent(.didWake)
        store.handleSessionEvent(.becameActive)
        await settle()
        expect(network.requests.isEmpty && store.isRefreshPaused, "launching or waking while locked sends no requests")

        sessionAvailable = true
        store.handleSessionEvent(.unlocked)
        await waitFor { network.requests.count == 3 }
        expect(Set(network.requests.map(\.provider)) == Set(["v2free", "gpt", "claude"]), "unlock immediately refreshes all three meters")
        store.handleSessionEvent(.unlocked)
        store.handleSessionEvent(.becameActive)
        await settle()
        expect(network.requests.count == 3, "duplicate resume notifications do not duplicate requests")
        try network.complete(0..<3, percent: 10)
        await waitFor { store.providers.allSatisfy { !$0.loading } }

        store.refreshAll()
        await waitFor { network.requests.count == 6 }
        sessionAvailable = false
        store.handleSessionEvent(.locked)
        await waitFor { network.canceled.count == 3 }
        expect(store.isRefreshPaused && store.providers.allSatisfy { !$0.loading }, "locking cancels in-flight requests and clears busy indicators")
        expect(store.providers.allSatisfy { $0.reading?.primary?.usedPercent == 10 }, "locking retains the last successful readings")
        store.tick(at: Date().addingTimeInterval(600))
        store.refreshAll()
        store.refresh("gpt")
        store.handleSessionEvent(.didWake)
        store.handleSessionEvent(.becameActive)
        await settle()
        expect(network.requests.count == 6, "timer, wake and explicit refresh paths stay blocked while locked")

        sessionAvailable = true
        store.handleSessionEvent(.unlocked)
        await waitFor { network.requests.count == 9 }
        try network.complete(3..<6, percent: 99)
        await settle()
        expect(store.providers.allSatisfy { $0.loading && $0.reading?.primary?.usedPercent == 10 }, "late canceled responses cannot replace readings or clear replacement requests")
        try network.complete(6..<9, percent: 20)
        await waitFor { store.providers.allSatisfy { !$0.loading } }
        expect(store.providers.allSatisfy { $0.error == nil && $0.reading?.primary?.usedPercent == 20 }, "unlock updates readings without reporting cancellation as an error")

        store.handleSessionEvent(.resignedActive)
        store.tick(at: Date().addingTimeInterval(600))
        await settle()
        expect(network.requests.count == 9 && store.isRefreshPaused, "switching away from the user session pauses polling")
        store.handleSessionEvent(.becameActive)
        await waitFor { network.requests.count == 12 }
        try network.complete(9..<12, percent: 30)
        await waitFor { store.providers.allSatisfy { !$0.loading } }

        store.handleSessionEvent(.willSleep)
        sessionAvailable = false
        store.handleSessionEvent(.locked)
        store.handleSessionEvent(.didWake)
        await settle()
        expect(network.requests.count == 12 && store.isRefreshPaused, "waking before unlock stays paused")
        sessionAvailable = true
        store.handleSessionEvent(.unlocked)
        await waitFor { network.requests.count == 15 }
        try network.complete(12..<15, percent: 40)
        await waitFor { store.providers.allSatisfy { !$0.loading } }

        sessionAvailable = false
        store.tick(at: Date().addingTimeInterval(600))
        await settle()
        expect(network.requests.count == 15 && store.isRefreshPaused, "snapshot guard catches a missed lock notification")
        sessionAvailable = true
        store.tick()
        await waitFor { network.requests.count == 18 }
        expect(!store.isRefreshPaused, "snapshot guard recovers from a missed unlock notification")
        try network.complete(15..<18, percent: 50)
        await waitFor { store.providers.allSatisfy { !$0.loading } }
        store.tick()
        await settle()
        expect(network.requests.count == 18, "the two-minute schedule restarts from unlock")
        store.tick(at: Date().addingTimeInterval(180))
        await waitFor { network.requests.count == 21 }
        try network.complete(18..<21, percent: 60)
        await waitFor { store.providers.allSatisfy { !$0.loading } }
        expect(store.providers.allSatisfy { $0.reading?.primary?.usedPercent == 60 }, "normal periodic refresh resumes after unlock")
        store.refreshAll()
        sessionAvailable = false
        await settle()
        expect(network.requests.count == 21 && store.isRefreshPaused, "locking between scheduling and sending still prevents network requests")
        print("Passed \(checks) lock/unlock refresh checks (no live network requests)")
    }
}
