import AppKit
import SwiftUI

final class WidgetPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { orderOut(sender) }
}

@MainActor
final class WidgetDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var panel: WidgetPanel!
    private var statusItem: NSStatusItem!
    private var store: MeterStore!
    private let preferences = UserDefaults.standard
    private var screenObserver: NSObjectProtocol?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var lockObservers: [NSObjectProtocol] = []

    private var fillsDisplay: Bool { preferences.object(forKey: "fillDisplay") as? Bool ?? true }
    private var staysOnTop: Bool { preferences.object(forKey: "alwaysOnTop") as? Bool ?? true }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let arguments = ProcessInfo.processInfo.arguments
        var configured = preferences.string(forKey: "serverURL") ?? WidgetConfiguration.defaultServer
        if let index = arguments.firstIndex(of: "--url"), arguments.indices.contains(index + 1) {
            configured = arguments[index + 1]
        }
        guard let server = WidgetConfiguration.serverURL(configured) else {
            let alert = NSAlert()
            alert.messageText = "Invalid Meterboard server URL"
            alert.informativeText = "Use an http:// or https:// address without credentials or query parameters."
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        MeterStyle.registerFonts()
        store = MeterStore(server: server)
        panel = WidgetPanel(contentRect: NSRect(x: 0, y: 0, width: 960, height: 540),
                            styleMask: [.borderless, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
        panel.title = "Meterboard Widget"
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = NSColor(MeterPalette.paper)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 640, height: 360)
        panel.contentAspectRatio = NSSize(width: 16, height: 9)
        panel.delegate = self
        panel.contentView = NSHostingView(rootView: Dashboard(store: store) { [weak self] in self?.showOptions() })
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "gauge.with.dots.needle.50percent", accessibilityDescription: "Meterboard")
        statusItem.button?.toolTip = "Meterboard Widget"
        statusItem.button?.target = self
        statusItem.button?.action = #selector(showOptions)
        positionPanel()
        panel.orderFrontRegardless()
        observeSessionActivity()
        store.start()
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.positionPanel() }
        }
    }

    private func observeSessionActivity() {
        let workspaceEvents: [(Notification.Name, SessionEvent)] = [
            (NSWorkspace.willSleepNotification, .willSleep),
            (NSWorkspace.didWakeNotification, .didWake),
            (NSWorkspace.sessionDidResignActiveNotification, .resignedActive),
            (NSWorkspace.sessionDidBecomeActiveNotification, .becameActive)
        ]
        for (name, event) in workspaceEvents {
            workspaceObservers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.store.handleSessionEvent(event) }
            })
        }
        for (name, event) in [("com.apple.screenIsLocked", SessionEvent.locked), ("com.apple.screenIsUnlocked", .unlocked)] {
            lockObservers.append(DistributedNotificationCenter.default().addObserver(forName: Notification.Name(name), object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.store.handleSessionEvent(event) }
            })
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        store?.stop()
        for observer in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        for observer in lockObservers { DistributedNotificationCenter.default().removeObserver(observer) }
    }

    private func preferredScreen() -> NSScreen? {
        if let name = preferences.string(forKey: "displayName"), let screen = NSScreen.screens.first(where: { $0.localizedName == name }) { return screen }
        return NSScreen.screens.first(where: { $0.localizedName.localizedCaseInsensitiveContains("Wokyis") }) ?? NSScreen.main ?? NSScreen.screens.first
    }

    private func positionPanel() {
        guard let screen = preferredScreen() else { return }
        panel.hasShadow = !fillsDisplay
        // Avoid unexpectedly covering the main monitor when the Wokyis is unplugged.
        let dedicated = screen.localizedName.localizedCaseInsensitiveContains("Wokyis") || preferences.string(forKey: "displayName") == screen.localizedName
        let fills = fillsDisplay && dedicated
        // Filling a dedicated display sits above its menu bar and Dock, like full screen.
        panel.level = !staysOnTop ? .normal : fills ? NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1) : .floating
        if fills {
            panel.setFrame(screen.frame, display: true)
        } else {
            let bounds = screen.visibleFrame.insetBy(dx: 24, dy: 24)
            let width = min(960, bounds.width, bounds.height * 16 / 9)
            let size = NSSize(width: width, height: width * 9 / 16)
            panel.setFrame(NSRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2, width: size.width, height: size.height), display: true)
        }
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self
        return entry
    }

    @objc func showOptions() {
        let menu = NSMenu()
        menu.addItem(item("Show widget", #selector(showWidget)))
        menu.addItem(item("Refresh meters", #selector(refreshMeters), key: "r"))
        menu.addItem(.separator())
        let displays = NSMenuItem(title: "Move to display", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        for screen in NSScreen.screens {
            let entry = item(screen.localizedName, #selector(selectDisplay(_:)))
            entry.representedObject = screen.localizedName
            entry.state = panel.screen == screen ? .on : .off
            submenu.addItem(entry)
        }
        displays.submenu = submenu
        menu.addItem(displays)
        let fill = item("Fill display", #selector(toggleFill))
        fill.state = fillsDisplay ? .on : .off
        menu.addItem(fill)
        let top = item("Always on top", #selector(toggleTop))
        top.state = staysOnTop ? .on : .off
        menu.addItem(top)
        menu.addItem(.separator())
        menu.addItem(item("Server address…", #selector(changeServer)))
        menu.addItem(item("Hide widget", #selector(hideWidget)))
        menu.addItem(item("Quit Meterboard", #selector(quit), key: "q"))
        menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    }

    @objc func showWidget() { panel.orderFrontRegardless() }
    @objc func hideWidget() { panel.orderOut(nil) }
    @objc func refreshMeters() { store.refreshAll() }
    @objc func quit() { NSApp.terminate(nil) }
    @objc func toggleFill() {
        preferences.set(!fillsDisplay, forKey: "fillDisplay")
        if fillsDisplay, let screen = panel.screen { preferences.set(screen.localizedName, forKey: "displayName") }
        positionPanel()
    }
    @objc func toggleTop() {
        preferences.set(!staysOnTop, forKey: "alwaysOnTop")
        positionPanel()
    }
    @objc func selectDisplay(_ sender: NSMenuItem) {
        preferences.set(sender.representedObject as? String, forKey: "displayName")
        positionPanel()
        panel.orderFrontRegardless()
    }
    @objc func changeServer() {
        let alert = NSAlert()
        alert.messageText = "Meterboard server"
        alert.informativeText = "The widget reads the existing meters from this address. Relaunch the app after changing it."
        let field = NSTextField(string: store.server.absoluteString)
        field.frame = NSRect(x: 0, y: 0, width: 360, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        if let url = WidgetConfiguration.serverURL(field.stringValue) {
            preferences.set(url.absoluteString, forKey: "serverURL")
        } else {
            let error = NSAlert()
            error.messageText = "Enter a valid http:// or https:// server address."
            error.runModal()
        }
    }
}

@main
enum MeterboardWidget {
    @MainActor static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let delegate = WidgetDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
