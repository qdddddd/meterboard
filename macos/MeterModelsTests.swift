import Foundation

@main
enum MeterModelsTests {
    static func main() throws {
        var count = 0
        func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
            guard condition() else { fatalError("FAIL: \(label)") }
            count += 1
        }
        let now = MeterDates.parse("2026-10-19T14:00:00Z")!
        let input = #"{"provider":{"provider":"renamed-claude","account":{"planLabel":"Max 20x"},"meters":[{"id":"session","label":"Session (5h)","usedPercent":2,"resetsAt":"2026-10-19T18:09:59.982421+00:00","isActive":false},{"id":"weekly","label":"Weekly","usedPercent":59,"resetsAt":"2026-10-22T02:59:59.982444+00:00","isActive":true}],"meta":{"sourceProviderId":"claude","snapshotAt":"2026-10-19T13:54:36.212Z"}},"fetchedAt":"2026-10-19T13:55:44.464Z"}"#
        let envelope = try JSONDecoder().decode(ProviderEnvelope.self, from: Data(input.utf8))
        expect(envelope.provider.accepts(providerID: "claude"), "respect provider aliases")
        expect(!envelope.provider.accepts(providerID: "gpt"), "reject wrong provider")
        expect(envelope.provider.primary?.id == "weekly", "select active limit")
        let scoped = #"{"provider":"claude","meters":[{"id":"session-0","label":"Session (5h)","usedPercent":2,"isActive":false},{"id":"weekly_all-1","label":"Weekly (all models)","usedPercent":29,"isActive":false},{"id":"weekly_scoped-2","label":"Weekly · Fable","usedPercent":46,"isActive":true}]}"#
        let scopedReading = try JSONDecoder().decode(ProviderReading.self, from: Data(scoped.utf8))
        expect(scopedReading.primary?.id == "weekly_all-1", "all-models weekly outranks an active scoped limit")
        expect(envelope.provider.capturedAt != nil, "retain snapshot time")
        expect(envelope.provider.meters[0].resetText(at: now) == "Resets in 4h 10m", "fractional ISO timestamps and countdown")
        func meter(_ fragment: String) throws -> UsageMeter {
            try JSONDecoder().decode(UsageMeter.self, from: Data((#"{"id":"test","label":"Test","# + fragment + "}").utf8))
        }
        let expired = try meter(#""usedPercent":59,"resetsAt":"2026-10-19T13:00:00Z""#)
        expect(expired.percent(at: now) == nil, "expired window must not show old usage")
        let resetSnapshot = try meter(#""usedPercent":0,"detail":"window reset since Oct 19 13:00""#)
        expect(resetSnapshot.percent(at: now) == nil, "a rolled snapshot is not a fresh zero")
        let unknown = try meter(#""usedPercent":null"#)
        expect(unknown.percentText(at: now) == "—", "unknown is not zero")
        let unused = try meter(#""usedPercent":0,"detail":"resets 7d after first use""#)
        expect(unused.percent(at: now) == 0 && unused.resetText(at: now).contains("after first use"), "unused window has no invented countdown")
        let over = try meter(#""usedPercent":150"#)
        expect(over.percent(at: now) == 100, "clamp oversized progress")
        expect(WidgetConfiguration.serverURL("file:///etc/passwd") == nil, "reject non-HTTP endpoints")
        expect(WidgetConfiguration.serverURL("http://user:password@example.com") == nil, "reject credentials in server URLs")
        let endpoint = WidgetConfiguration.endpoint(server: URL(string: "http://example.com/meterboard")!, providerID: "gpt")
        expect(endpoint.absoluteString == "http://example.com/meterboard/api/provider?provider=gpt", "preserve server base path")
        print("Passed \(count) widget model checks")
    }
}
