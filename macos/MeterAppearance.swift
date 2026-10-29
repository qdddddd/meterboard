import AppKit
import CoreText
import SwiftUI

enum MeterStyle {
    static func registerFonts() {
        for weight in ["Regular", "Medium", "SemiBold"] {
            guard let url = Bundle.main.url(forResource: "IBMPlexMono-\(weight)", withExtension: "ttf", subdirectory: "fonts") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    static func font(_ size: CGFloat, _ weight: String = "Regular") -> Font {
        // The TTF PostScript names differ from their filenames. Using the
        // filenames silently substitutes Helvetica in SwiftUI.
        let name: String
        switch weight {
        case "Medium": name = "IBMPlexMono-Medm"
        case "SemiBold": name = "IBMPlexMono-SmBld"
        default: name = "IBMPlexMono"
        }
        return .custom(name, fixedSize: size)
    }

    static func tint(_ meter: UsageMeter?, accent: Color, at now: Date) -> Color {
        let percent = meter?.percent(at: now) ?? 0
        if meter?.severity == "critical" || percent >= 90 { return MeterPalette.red }
        if meter?.severity == "warning" || percent >= 75 { return MeterPalette.amber }
        return accent
    }
}

struct MeterRow: View {
    let meter: UsageMeter
    let color: Color
    let now: Date

    private var countdown: String {
        let full = meter.resetText(at: now)
        if meter.resetPassed(at: now) { return "Updating" }
        if full.contains("after first use") { return "First use" }
        return full.replacingOccurrences(of: "Resets in ", with: "")
    }

    var body: some View {
        let tint = MeterStyle.tint(meter, accent: color, at: now)
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(meter.label).font(MeterStyle.font(14, "Medium"))
                    .lineLimit(1).minimumScaleFactor(0.8)
                Spacer(minLength: 4)
                Text(meter.percentText(at: now) + (meter.percent(at: now) == nil ? "" : "%"))
                    .font(MeterStyle.font(15, "SemiBold")).foregroundStyle(tint)
            }.frame(height: 20)
            HStack(spacing: 10) {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule().fill(MeterPalette.track)
                        Capsule().fill(tint).frame(width: geometry.size.width * CGFloat(meter.percent(at: now) ?? 0) / 100)
                    }
                }.frame(height: 7)
                if !countdown.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.clockwise").font(.system(size: 9))
                        Text(countdown).font(MeterStyle.font(11))
                    }.foregroundStyle(MeterPalette.soft).fixedSize().help(meter.resetText(at: now))
                }
            }.frame(height: 14)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(meter.percent(at: now) == nil ? "\(meter.label): reading unavailable. \(meter.resetText(at: now))" : "\(meter.label): \(meter.percentText(at: now)) percent used. \(meter.resetText(at: now))")
        .help([meter.detail, meter.resetsAt.map { "Reset: \($0)" }].compactMap { $0 }.joined(separator: "\n"))
    }
}

struct ProviderCard: View {
    let state: ProviderState
    let now: Date
    let refresh: () -> Void

    private var primary: UsageMeter? { state.reading?.primary }
    private var percent: Double? { primary?.percent(at: now) }
    private var cardShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
    }
    private var symbol: String {
        switch state.id {
        case "v2free": return "network"
        case "gpt": return "terminal"
        default: return "sparkle"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Image(systemName: symbol).font(.system(size: 20, weight: .medium)).foregroundStyle(state.color)
                Text(state.name).font(MeterStyle.font(24, "Medium"))
                Spacer()
                Button(action: refresh) {
                    Image(systemName: "arrow.clockwise").font(.system(size: 14, weight: .medium))
                        .foregroundStyle(state.loading ? state.color : MeterPalette.soft)
                }.buttonStyle(.plain).disabled(state.loading).help("Refresh \(state.name)")
                    .accessibilityLabel("Refresh \(state.name)")
            }
            Text((state.reading?.account?.planLabel ?? (state.loading ? "Connecting…" : "Usage meter")).uppercased())
                .font(MeterStyle.font(12, "SemiBold")).tracking(0.55)
                .foregroundStyle(state.color).lineLimit(1).minimumScaleFactor(0.8)
                .padding(.horizontal, 6).padding(.vertical, 3)
                .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(state.color, lineWidth: 1)).padding(.top, 7)

            ZStack {
                Circle().stroke(MeterPalette.track, lineWidth: 11)
                Circle().trim(from: 0, to: CGFloat(percent ?? 0) / 100)
                    .stroke(MeterStyle.tint(primary, accent: state.color, at: now), style: StrokeStyle(lineWidth: 11, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                VStack(spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 1) {
                        Text(primary?.percentText(at: now) ?? "—").font(MeterStyle.font(48, "Medium"))
                        if percent != nil { Text("%").font(MeterStyle.font(18)).foregroundStyle(MeterPalette.soft) }
                    }
                    Text(percent == nil ? (state.loading ? "CONNECTING" : "NO READING") : "USED")
                        .font(MeterStyle.font(11, "Medium")).tracking(2).foregroundStyle(MeterPalette.soft)
                }
            }.frame(width: 160, height: 160).frame(maxWidth: .infinity).padding(.vertical, 10)
                .opacity(state.error == nil ? 1 : 0.55)

            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 0) {
                    if let reading = state.reading, !reading.meters.isEmpty {
                        VStack(spacing: 8) {
                            ForEach(Array(reading.meters.enumerated()), id: \.offset) { _, meter in
                                MeterRow(meter: meter, color: state.color, now: now)
                            }
                        }.opacity(state.error == nil ? 1 : 0.55)
                        if state.id == "v2free", let detail = primary?.detail {
                            Text(detail).font(MeterStyle.font(12)).foregroundStyle(MeterPalette.soft)
                                .fixedSize(horizontal: false, vertical: true).padding(.top, 14)
                        }
                        if state.id == "gpt", let stat = reading.meta?.stats?.first(where: { $0.label == "Last 7 days" }) {
                            HStack {
                                Text(stat.label).foregroundStyle(MeterPalette.soft)
                                Spacer()
                                Text(stat.value).foregroundStyle(MeterPalette.ink)
                            }.font(MeterStyle.font(12)).padding(.top, 20)
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(state.loading ? "Reading your meter…" : state.failureTitle)
                                .font(MeterStyle.font(14, "Medium"))
                            Text(state.loading ? "The other meters update independently." : "Will retry automatically. Click ↻ to try now.")
                                .font(MeterStyle.font(12)).foregroundStyle(MeterPalette.soft)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .topLeading)
            }.scrollIndicators(.hidden)
            HStack(spacing: 6) {
                Circle().fill(state.error != nil ? MeterPalette.red : (state.receivedAt == nil ? MeterPalette.soft : state.color))
                    .frame(width: 5, height: 5)
                Text(state.error != nil ? (state.reading == nil ? "Unavailable · retrying" : "Offline · \(state.freshness(at: now))") : state.freshness(at: now))
                    .font(MeterStyle.font(11)).foregroundStyle(MeterPalette.soft).lineLimit(1).minimumScaleFactor(0.8)
            }.padding(.top, 12).help(state.error ?? state.freshness(at: now))
        }
        .padding(16).padding(.top, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(cardShape.fill(MeterPalette.card.opacity(0.94)))
        .overlay(cardShape.strokeBorder(MeterPalette.ink, lineWidth: 2))
        .overlay(alignment: .top) { state.color.frame(height: 8) }
        .clipShape(cardShape)
        .background(cardShape.fill(MeterPalette.shadow).offset(x: 5, y: 5))
    }
}

struct Dashboard: View {
    @ObservedObject var store: MeterStore
    let showMenu: () -> Void

    var body: some View {
        GeometryReader { geometry in
            // Keep the three-card instrument layout at every display resolution.
            let scale = min(geometry.size.width / 960, geometry.size.height / 540)
            VStack(spacing: 14) {
                HStack(alignment: .center) {
                    HStack(spacing: 8) {
                        Image(systemName: "gauge.with.dots.needle.50percent").foregroundStyle(MeterPalette.soft)
                        Text("METERBOARD").tracking(3).font(MeterStyle.font(14, "SemiBold"))
                    }
                    Spacer()
                    Text((store.server.host ?? "Meterboard").uppercased()).font(MeterStyle.font(12)).tracking(2).foregroundStyle(MeterPalette.soft)
                    Text(store.now, style: .time).font(MeterStyle.font(14, "Medium")).padding(.leading, 10)
                    Button(action: showMenu) { Image(systemName: "ellipsis").frame(width: 26, height: 22) }
                        .buttonStyle(.plain).foregroundStyle(MeterPalette.soft).help("Widget options")
                        .accessibilityLabel("Widget options")
                }.frame(height: 24)
                HStack(spacing: 14) {
                    ForEach(store.providers) { provider in
                        ProviderCard(state: provider, now: store.now) { store.refresh(provider.id) }
                    }
                }.frame(height: 434)
                HStack {
                    Text("USAGE / LIMITS / RESETS").tracking(1.8)
                    Spacer()
                    Text(store.isRefreshPaused ? "AUTO REFRESH · PAUSED" : "AUTO REFRESH · 2 MIN").tracking(1.4)
                }.font(MeterStyle.font(10, "Medium")).foregroundStyle(MeterPalette.soft).frame(height: 14)
            }
            .padding(20).frame(width: 960, height: 540)
            .scaleEffect(scale, anchor: .center)
            .frame(width: geometry.size.width, height: geometry.size.height)
            .background(MeterPalette.paper).foregroundStyle(MeterPalette.ink)
        }
        .preferredColorScheme(.light)
    }
}
