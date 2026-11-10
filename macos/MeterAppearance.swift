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

// The time left until a meter resets, as a "↻ 1d 15h" tag; the full reset
// text shows on hover.
struct ResetTag: View {
    let meter: UsageMeter
    let now: Date

    var body: some View {
        let countdown = meter.countdown(at: now)
        if !countdown.isEmpty {
            HStack(spacing: 4) {
                Image(systemName: "arrow.clockwise").font(.system(size: 9))
                Text(countdown).font(MeterStyle.font(11))
            }.foregroundStyle(MeterPalette.soft).fixedSize().help(meter.resetText(at: now))
        }
    }
}

struct MeterRow: View {
    let meter: UsageMeter
    let color: Color
    let now: Date
    let showsReset: Bool

    // No bar: the gauge above is the chart, so a row is text only — name,
    // time to reset, percentage.
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(meter.label).font(MeterStyle.font(14, "Medium"))
                .lineLimit(1).minimumScaleFactor(0.8)
            Spacer(minLength: 4)
            if showsReset { ResetTag(meter: meter, now: now) }
            Text(meter.percentText(at: now) + (meter.percent(at: now) == nil ? "" : "%"))
                .font(MeterStyle.font(15, "SemiBold")).foregroundStyle(MeterStyle.tint(meter, accent: color, at: now))
        }.frame(height: 20)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(meter.percent(at: now) == nil ? "\(meter.label): reading unavailable. \(meter.resetText(at: now))" : "\(meter.label): \(meter.percentText(at: now)) percent used. \(meter.resetText(at: now))")
        .help([meter.detail, meter.resetsAt.map { "Reset: \($0)" }].compactMap { $0 }.joined(separator: "\n"))
    }
}

// A name set along a ring's band, ending just before 12 o'clock, where the
// track is last to fill. Plex Mono's fixed advance makes the arc exact.
struct RingLabel: View {
    let text: String
    let radius: CGFloat
    let clearance: CGFloat
    let size: CGFloat
    // Plex Mono's 0.6em advance plus a little letter spacing.
    private var advance: CGFloat { size * 0.67 }

    var body: some View {
        let budget = Int((radius * .pi / 2 - clearance) / advance)
        let characters = Array(text.count > budget ? String(text.prefix(max(budget - 1, 0))) + "…" : text)
        ZStack {
            ForEach(characters.indices, id: \.self) { index in
                let angle = -(clearance + (CGFloat(characters.count - index) - 0.5) * advance) / radius
                Text(String(characters[index])).font(MeterStyle.font(size, "SemiBold")).fixedSize()
                    .rotationEffect(.radians(angle))
                    .offset(x: radius * sin(angle), y: -radius * cos(angle))
            }
        }
        .frame(width: radius * 2, height: radius * 2)
        .accessibilityHidden(true)
    }
}

// One full ring per meter around a shared centre, outermost first, with the
// first ring's reading in the middle. Claude's rings are named in their
// bands; the other cards draw one unnamed ring.
struct MeterGauge: View {
    let rings: [UsageMeter]
    let caption: String
    let accent: Color
    let labeled: Bool
    let now: Date
    // Every size here was tuned on a 160pt gauge and scales with it.
    private let diameter: CGFloat = 192
    private var unit: CGFloat { diameter / 160 }
    private var band: CGFloat { 12 * unit }

    var body: some View {
        let count = max(rings.count, 1)
        let step = band + 3 * unit
        let inner = diameter - 2 * step * CGFloat(count - 1) - band
        let number = rings.first?.percentText(at: now) ?? "—"
        let percent = rings.first?.percent(at: now)
        // Fit the reading inside the innermost ring: the width budget covers
        // decimals and 100, the height budget a stack of three rings.
        let digits = CGFloat(number.count) * 0.6 + (percent == nil ? 0 : 0.225)
        let numberSize = min(48 * unit, inner * 0.42, (inner * 0.86 - 1) / digits)
        ZStack {
            ForEach(0..<count, id: \.self) { index in
                ring(index < rings.count ? rings[index] : nil, width: diameter - 2 * step * CGFloat(index))
            }
            VStack(spacing: 3 * unit) {
                HStack(alignment: .firstTextBaseline, spacing: unit) {
                    Text(number).font(MeterStyle.font(numberSize, "Medium"))
                    if percent != nil { Text("%").font(MeterStyle.font(numberSize * 0.375)).foregroundStyle(MeterPalette.soft) }
                }
                // Inside three rings a widely spaced "NO READING" would run
                // onto the innermost band.
                Text(caption).font(MeterStyle.font((count > 2 ? 9 : 11) * unit, "Medium"))
                    .tracking((count > 2 ? 0.5 : 2) * unit).foregroundStyle(MeterPalette.soft)
            }
        }
        .frame(width: diameter + band, height: diameter + band)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(rings.isEmpty ? caption.capitalized : rings.map { meter in
            meter.percent(at: now) == nil ? "\(meter.label): no reading" : "\(meter.label): \(meter.percentText(at: now)) percent used"
        }.joined(separator: ". "))
    }

    private func ring(_ meter: UsageMeter?, width: CGFloat) -> some View {
        let fill = Circle().trim(from: 0, to: CGFloat(meter?.percent(at: now) ?? 0) / 100).rotation(.degrees(-90))
        let stroke = StrokeStyle(lineWidth: band, lineCap: .round)
        let tint = MeterStyle.tint(meter, accent: accent, at: now)
        return ZStack {
            Circle().stroke(MeterPalette.track, lineWidth: band)
            fill.stroke(tint, style: stroke)
            if labeled, let meter {
                // Clear the fill's round start cap, then recolour the letters
                // wherever the fill runs underneath them: paper reads on the
                // brown and red fills, ink on amber.
                let label = RingLabel(text: meter.ringLabel, radius: width / 2, clearance: band / 2 + 3 * unit, size: 8.5 * unit)
                label.foregroundStyle(MeterPalette.ink.opacity(0.72))
                label.foregroundStyle(tint == MeterPalette.amber ? MeterPalette.ink : MeterPalette.paper)
                    .mask(fill.stroke(style: stroke))
            }
        }.frame(width: width, height: width)
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

            // The centre reading needs no row of its own; only its reset
            // time, under the gauge.
            VStack(spacing: 10) {
                MeterGauge(rings: state.id == "claude" ? state.reading?.rings ?? [] : [primary].compactMap { $0 },
                           caption: percent == nil ? (state.loading ? "CONNECTING" : "NO READING") : "USED",
                           accent: state.color, labeled: state.id == "claude", now: now)
                if let primary { ResetTag(meter: primary, now: now) }
            }
            .frame(maxWidth: .infinity).padding(.top, 16).padding(.bottom, 14)
            .opacity(state.error == nil ? 1 : 0.55)

            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 14) {
                    if let reading = state.reading, !reading.meters.isEmpty {
                        let others = reading.meters.filter { $0.id != primary?.id }
                        if !others.isEmpty {
                            VStack(spacing: 8) {
                                // A reset time the gauge already shows is not repeated.
                                ForEach(Array(others.enumerated()), id: \.offset) { _, meter in
                                    MeterRow(meter: meter, color: state.color, now: now,
                                             showsReset: meter.countdown(at: now) != primary?.countdown(at: now))
                                }
                            }.opacity(state.error == nil ? 1 : 0.55)
                        }
                        if state.id == "v2free", let detail = primary?.detail {
                            Text(detail).font(MeterStyle.font(12)).foregroundStyle(MeterPalette.soft)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if state.id == "gpt", let stat = reading.meta?.stats?.first(where: { $0.label == "Last 7 days" }) {
                            HStack {
                                Text(stat.label).foregroundStyle(MeterPalette.soft)
                                Spacer()
                                Text(stat.value).foregroundStyle(MeterPalette.ink)
                            }.font(MeterStyle.font(12))
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
