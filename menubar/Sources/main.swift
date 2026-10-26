// Claude Tower: a menu bar mirror of ~/.claude/claude-tower-status.json, which the
// session-tower plugin rewrites from every open Claude Code session. Shows how many
// sessions are working or need you, lists them, and posts a notification when
// one starts needing you or finishes.

import AppKit
import UserNotifications

struct Agent: Decodable {
    let status: String?
    let description: String?
}

struct Shell: Decodable {
    let description: String?
    let command: String?
}

struct Session: Decodable {
    let id: String
    let project: String?
    let branch: String?
    let state: String
    let since: Double?
    let task: String?
    let activity: String?
    let waitingFor: String?
    let tty: String?
    let title: String?
    let agents: [Agent]?
    // Absent in snapshots from a deck older than the "shells" state.
    let shells: [Shell]?
    let beat: Double?
}

func shellCount(_ s: Session) -> String {
    let n = s.shells?.count ?? 0
    return "\(n) shell\(n == 1 ? "" : "s") still running"
}

struct Snapshot: Decodable {
    let version: Int
    let updatedAt: Double
    let sessions: [Session]
}

enum Look {
    static let words: [String: String] = [
        "working": "Working", "waiting": "Needs approval", "asking": "Has a question",
        "done": "Done", "shells": "Done · shells running", "stopped": "Stopped", "error": "Error", "idle": "Idle",
    ]
    static let glyphs: [String: String] = [
        "working": "◐", "waiting": "✻", "asking": "?", "done": "✓", "shells": "◌", "stopped": "■", "error": "✗", "idle": "∙",
    ]
    static let needsYou: Set<String> = ["waiting", "asking", "error"]
    static let busy: Set<String> = ["working", "waiting", "asking"]
}

// Matches the deck's STALE_MS: a session killed without a clean exit stops
// heartbeating, and past this it's gone.
let staleAfter: Double = 15_000
let statusURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/claude-tower-status.json")
let terminalBundleIDs = ["com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "dev.warp.Warp-Stable"]

// Notification delivery fails silently otherwise; this is the only trace.
let diagURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/ClaudeTower.log")
func diag(_ line: String) {
    let text = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
    if let h = try? FileHandle(forWritingTo: diagURL) {
        h.seekToEndOfFile()
        h.write(Data(text.utf8))
        try? h.close()
    } else {
        try? text.write(to: diagURL, atomically: true, encoding: .utf8)
    }
}

func ticket(_ branch: String?) -> String {
    guard let branch, !branch.isEmpty else { return "" }
    if let r = branch.range(of: "[A-Z][A-Za-z]*[-_][0-9]+", options: .regularExpression) {
        return branch[r].replacingOccurrences(of: "_", with: "-")
    }
    return branch.count > 24 ? String(branch.prefix(23)) + "…" : branch
}

func label(_ s: Session) -> String {
    let t = ticket(s.branch)
    return (s.project ?? "session") + (t.isEmpty ? "" : " · " + t)
}

// The mod's generated title says what the session is doing; project · ticket
// is the same for every session on a branch, so it's only the fallback.
func name(_ s: Session) -> String {
    if let t = s.title, !t.isEmpty { return t }
    return label(s)
}

func age(_ since: Double?) -> String {
    guard let since else { return "" }
    let s = max(0, Int((Date().timeIntervalSince1970 * 1000 - since) / 1000))
    if s < 60 { return "\(s)s" }
    if s < 3600 { return "\(s / 60)m" }
    return "\(s / 3600)h\(String(format: "%02d", (s % 3600) / 60))"
}

// A floating card under the menu bar, top-right: over Chrome, over fullscreen
// apps, on every Space, without taking focus. Newer cards stack below older.
@MainActor
final class Banners {
    private var panels: [NSPanel] = []
    private let width: CGFloat = 340
    private let gap: CGFloat = 8

    func show(title: String, body: String, sound: Bool, onClick: @escaping () -> Void) {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: 64),
                            styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false

        let card = NSVisualEffectView()
        card.material = .hudWindow
        card.blendingMode = .behindWindow
        card.state = .active
        card.wantsLayer = true
        card.layer?.cornerRadius = 14
        card.layer?.masksToBounds = true

        let head = NSTextField(labelWithString: title)
        head.font = .boldSystemFont(ofSize: 13)
        head.lineBreakMode = .byTruncatingTail
        let text = NSTextField(wrappingLabelWithString: body)
        text.font = .systemFont(ofSize: 12)
        text.textColor = .secondaryLabelColor
        text.maximumNumberOfLines = 3
        let stack = NSStackView(views: body.isEmpty ? [head] : [head, text])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 10),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -10),
            head.widthAnchor.constraint(equalToConstant: width - 28),
            text.widthAnchor.constraint(equalToConstant: width - 28),
        ])
        let click = ClickView { [weak self, weak panel] in
            onClick()
            if let panel { self?.dismiss(panel) }
        }
        click.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(click)
        NSLayoutConstraint.activate([
            click.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            click.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            click.topAnchor.constraint(equalTo: card.topAnchor),
            click.bottomAnchor.constraint(equalTo: card.bottomAnchor),
        ])
        panel.contentView = card
        card.layoutSubtreeIfNeeded()
        panel.setContentSize(NSSize(width: width, height: max(48, stack.fittingSize.height + 20)))

        panels.append(panel)
        layout()
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { $0.duration = 0.2; panel.animator().alphaValue = 1 }
        if sound { NSSound(named: "Glass")?.play() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self, weak panel] in
            MainActor.assumeIsolated { if let panel { self?.dismiss(panel) } }
        }
    }

    private func dismiss(_ panel: NSPanel) {
        guard let i = panels.firstIndex(of: panel) else { return }
        panels.remove(at: i)
        panel.orderOut(nil)
        layout()
    }

    private func layout() {
        guard let screen = NSScreen.main else { return }
        let area = screen.visibleFrame
        var top = area.maxY - gap
        for p in panels {
            let size = p.frame.size
            p.setFrameOrigin(NSPoint(x: area.maxX - size.width - gap, y: top - size.height))
            top -= size.height + gap
        }
    }
}

final class ClickView: NSView {
    private let action: () -> Void
    init(_ action: @escaping () -> Void) {
        self.action = action
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func mouseDown(with event: NSEvent) { action() }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var sessions: [Session] = []
    private var lastStates: [String: String] = [:]
    private var seeded = false
    private var lastModified: Date?
    private var timer: Timer?
    private let banners = Banners()

    private var notifyDone: Bool {
        get { UserDefaults.standard.object(forKey: "notifyDone") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "notifyDone") }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            diag("requestAuthorization granted=\(granted) error=\(String(describing: error))")
        }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            diag("settings auth=\(settings.authorizationStatus.rawValue) alert=\(settings.alertSetting.rawValue) style=\(settings.alertStyle.rawValue)")
        }
        refresh(force: true)
        // Polling rather than a file watch: the mod replaces the file on every
        // write, which orphans a watched descriptor. One stat a second is free.
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            MainActor.assumeIsolated { self.refresh(force: false) }
        }
    }

    private func refresh(force: Bool) {
        let modified = (try? FileManager.default.attributesOfItem(atPath: statusURL.path))?[.modificationDate] as? Date
        if force || modified != lastModified {
            lastModified = modified
            // A read mid-write fails to parse; the last good snapshot stands.
            if let data = try? Data(contentsOf: statusURL),
               let snap = try? JSONDecoder().decode(Snapshot.self, from: data) {
                sessions = snap.sessions
            } else if modified == nil {
                sessions = []
            }
        }
        let nowMs = Date().timeIntervalSince1970 * 1000
        let live = sessions.filter { nowMs - ($0.beat ?? 0) <= staleAfter }
        announce(live)
        drawTitle(live)
    }

    private func announce(_ live: [Session]) {
        var next: [String: String] = [:]
        for s in live {
            next[s.id] = s.state
            guard seeded, let prev = lastStates[s.id], prev != s.state else { continue }
            if Look.needsYou.contains(s.state) {
                let body = s.state == "waiting" ? (s.waitingFor ?? "Waiting for your approval")
                    : s.state == "asking" ? "Has a question for you" : "Stopped with an error"
                post(title: "\(name(s)): \(Look.words[s.state, default: s.state])", body: body, sound: true, tty: s.tty)
            } else if s.state == "shells", notifyDone, Look.busy.contains(prev) {
                post(title: "\(name(s)) finished · \(shellCount(s))", body: s.task ?? "", sound: false, tty: s.tty)
            } else if s.state == "done", notifyDone, Look.busy.contains(prev) || prev == "shells" {
                post(title: "\(name(s)) finished", body: s.task ?? "", sound: false, tty: s.tty)
            }
        }
        lastStates = next
        seeded = true
    }

    // Notification Center refuses ad-hoc signed apps outright (UNErrorDomain 1,
    // no prompt), so without a Developer ID the app's own banner is the path
    // that actually reaches you. Should the system ever allow it, it's used.
    private func post(title: String, body: String, sound: Bool, tty: String? = nil) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let allowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if allowed { self.postSystem(title: title, body: body, sound: sound, tty: tty) }
                    else { self.banners.show(title: title, body: body, sound: sound) { self.focus(tty: tty) } }
                }
            }
        }
    }

    private func postSystem(title: String, body: String, sound: Bool, tty: String?) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if sound { content.sound = .default }
        if let tty { content.userInfo = ["tty": tty] }
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                diag("add failed: \(error)")
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self.banners.show(title: title, body: body, sound: sound) { self.focus(tty: tty) } }
                }
            }
        }
    }

    private func drawTitle(_ live: [Session]) {
        guard let button = item.button else { return }
        let needs = live.filter { Look.needsYou.contains($0.state) }.count
        let working = live.filter { $0.state == "working" }.count
        let shelled = live.filter { $0.state == "shells" }.count
        let font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        let title = NSMutableAttributedString()
        func add(_ text: String, _ color: NSColor, bold: Bool = false) {
            let f = bold ? NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .bold) : font
            title.append(NSAttributedString(string: text, attributes: [.foregroundColor: color, .font: f]))
        }
        if live.isEmpty {
            add("✳", .secondaryLabelColor)
        } else {
            add(working > 0 ? "✳ \(working)" : "✳", working > 0 ? .labelColor : .secondaryLabelColor)
            if shelled > 0 { add("  ◌ \(shelled)", .systemBlue) }
            if needs > 0 { add("  ✻ \(needs)", .systemOrange, bold: true) }
        }
        button.attributedTitle = title
        button.toolTip = live.isEmpty ? "No Claude sessions" : "\(live.count) Claude session\(live.count == 1 ? "" : "s")"
    }

    // Built when opened, so the list and ages are current.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let nowMs = Date().timeIntervalSince1970 * 1000
        let live = sessions.filter { nowMs - ($0.beat ?? 0) <= staleAfter }
        if live.isEmpty {
            let none = NSMenuItem(title: "No Claude sessions running", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        }
        // Whatever needs you first, then the busy ones.
        let order: [String: Int] = ["waiting": 0, "asking": 0, "error": 1, "working": 2, "shells": 3]
        for s in live.sorted(by: { order[$0.state, default: 4] < order[$1.state, default: 4] }) {
            let word = Look.words[s.state, default: s.state]
            let row = NSMenuItem(title: "", action: #selector(openSession(_:)), keyEquivalent: "")
            row.target = self
            row.representedObject = s.tty
            let color: NSColor = Look.needsYou.contains(s.state) ? .systemOrange : s.state == "working" ? .systemTeal
                : s.state == "shells" ? .systemBlue : s.state == "done" ? .systemGreen : .secondaryLabelColor
            let text = NSMutableAttributedString(string: "\(Look.glyphs[s.state, default: "∙"]) ", attributes: [.foregroundColor: color])
            text.append(NSAttributedString(string: name(s), attributes: [.font: NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)]))
            text.append(NSAttributedString(string: "  \(word) · \(age(s.since))", attributes: [.foregroundColor: color]))
            row.attributedTitle = text
            var lines: [String] = [label(s)]
            if let task = s.task, !task.isEmpty { lines.append(task) }
            let now = s.state == "waiting" ? s.waitingFor : s.activity
            if s.state == "shells" {
                let n = s.shells?.count ?? 0
                lines.append("→ Waiting on \(n) background shell\(n == 1 ? "" : "s")")
                for sh in (s.shells ?? []).prefix(3) {
                    lines.append("   ◌ " + (sh.description ?? sh.command ?? "shell"))
                }
            } else if let now, !now.isEmpty { lines.append("→ " + now) }
            let agents = s.agents ?? []
            if !agents.isEmpty {
                let done = agents.filter { $0.status == "completed" }.count
                let running = agents.filter { ["pending", "running", "waiting"].contains($0.status ?? "") }.count
                lines.append("Subagents: \(done)/\(agents.count) done" + (running > 0 ? " · \(running) running" : ""))
            }
            row.subtitle = lines.joined(separator: "\n")
            menu.addItem(row)
        }
        menu.addItem(.separator())
        let done = NSMenuItem(title: "Notify when a session finishes", action: #selector(toggleNotifyDone), keyEquivalent: "")
        done.target = self
        done.state = notifyDone ? .on : .off
        menu.addItem(done)
        let quit = NSMenuItem(title: "Quit Claude Tower", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    @objc private func toggleNotifyDone() { notifyDone.toggle() }


    @objc private func openSession(_ sender: NSMenuItem) {
        focus(tty: sender.representedObject as? String)
    }

    // Selects the tab whose tty is the session's, in Terminal or iTerm2 (the two
    // that expose a tab's tty to AppleScript). Needs the one-time Automation
    // approval per terminal; without it, without a tty, or in any other terminal
    // it just raises whichever terminal is running.
    func focus(tty: String?) {
        guard let tty, tty.range(of: "^/dev/ttys[0-9]+$", options: .regularExpression) != nil else {
            openTerminal()
            return
        }
        // Scripting a terminal that isn't running would launch it.
        for (bundleID, script) in focusScripts(tty: tty)
        where !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty {
            var error: NSDictionary?
            let found = NSAppleScript(source: script)?.executeAndReturnError(&error).booleanValue ?? false
            if let error { diag("focus \(tty) in \(bundleID) failed: \(error)") }
            if found { return }
        }
        openTerminal()
    }

    private func focusScripts(tty: String) -> [(String, String)] {
        [
            ("com.apple.Terminal", """
            tell application id "com.apple.Terminal"
              repeat with w in windows
                repeat with t in tabs of w
                  if tty of t is "\(tty)" then
                    if miniaturized of w then set miniaturized of w to false
                    set selected tab of w to t
                    set index of w to 1
                    activate
                    return true
                  end if
                end repeat
              end repeat
            end tell
            return false
            """),
            ("com.googlecode.iterm2", """
            tell application id "com.googlecode.iterm2"
              repeat with w in windows
                repeat with t in tabs of w
                  repeat with s in sessions of t
                    if tty of s is "\(tty)" then
                      tell w to select
                      tell t to select
                      tell s to select
                      activate
                      return true
                    end if
                  end repeat
                end repeat
              end repeat
            end tell
            return false
            """),
        ]
    }

    @objc private func openTerminal() {
        for id in terminalBundleIDs {
            if let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first {
                app.activate()
                return
            }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let tty = response.notification.request.content.userInfo["tty"] as? String
        await MainActor.run { self.focus(tty: tty) }
    }
}

let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
