// macOS ActivityWatch module. Only Orca and VS Code produce window events.
// Other apps and idle/locked sessions produce only an anonymous "afk" state,
// so the dashboard cannot count a gap between editor sessions as coding time.
import AppKit
import CoreGraphics
import Foundation

let allowedApps = [
    "com.stablyai.orca": "Orca",
    "com.microsoft.VSCode": "Code",
]

func codingApp(bundleID: String?, idleSeconds: Double, locked: Bool) -> String? {
    guard !locked, idleSeconds.isFinite, idleSeconds < 180,
          let bundleID = bundleID else { return nil }
    return allowedApps[bundleID]
}

func sampleApp() -> String? {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let locked = session == nil || session?["CGSSessionScreenIsLocked"] as? Bool == true
    return codingApp(
        bundleID: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
        idleSeconds: CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!),
        locked: locked
    )
}

// Do not log responses: the API's other buckets can contain private metadata.
func request(_ route: String, body: [String: Any]? = nil) -> Data? {
    var req = URLRequest(url: URL(string: "http://127.0.0.1:5600/api/0/\(route)")!)
    req.timeoutInterval = 3
    if let body = body {
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    let semaphore = DispatchSemaphore(value: 0)
    var result: Data?
    let task = URLSession.shared.dataTask(with: req) { data, response, _ in
        if let status = (response as? HTTPURLResponse)?.statusCode,
           (200..<300).contains(status) || status == 304 { result = data ?? Data() }
        semaphore.signal()
    }
    task.resume()
    if semaphore.wait(timeout: .now() + 4) == .timedOut { task.cancel() }
    return result
}

final class CodingWatcher {
    private var windowBucket: String?
    private var afkBucket: String?
    private var previousApp: String?
    private var activitySession = UUID().uuidString
    private let formatter = ISO8601DateFormatter()

    init() { formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds] }

    private func connect() -> Bool {
        guard let data = request("info"),
              let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let hostname = info["hostname"] as? String else { return false }
        // Reuse the standard buckets so existing ActivityWatch views and the
        // VS Code dashboard automatically use the restricted activity stream.
        let window = "aw-watcher-window_\(hostname)"
        let afk = "aw-watcher-afk_\(hostname)"
        for (id, type) in [(window, "currentwindow"), (afk, "afkstatus")] {
            guard request("buckets/\(id)", body: [
                "client": "aw-watcher-coding", "type": type, "hostname": hostname,
            ]) != nil else { return false }
        }
        windowBucket = window
        afkBucket = afk
        return true
    }

    func poll() {
        guard getppid() != 1 else { exit(0) } // Stop with the ActivityWatch tray app.
        if windowBucket == nil && !connect() { return }
        guard let window = windowBucket, let afk = afkBucket else { return }
        let app = sampleApp()
        if app != previousApp { activitySession = UUID().uuidString }
        previousApp = app
        let timestamp = formatter.string(from: Date())
        let status: [String: Any] = [
            "timestamp": timestamp, "duration": 0,
            "data": ["status": app == nil ? "afk" : "not-afk"],
        ]
        guard request("buckets/\(afk)/heartbeat?pulsetime=2", body: status) != nil else {
            windowBucket = nil
            activitySession = UUID().uuidString
            return
        }
        guard let app = app else { return }
        let event: [String: Any] = [
            "timestamp": timestamp, "duration": 0,
            "data": ["app": app, "title": "", "activity_session": activitySession],
        ]
        if request("buckets/\(window)/heartbeat?pulsetime=2", body: event) == nil {
            windowBucket = nil
            activitySession = UUID().uuidString
        }
    }
}

if CommandLine.arguments.contains("--self-test") {
    precondition(codingApp(bundleID: "com.stablyai.orca", idleSeconds: 0, locked: false) == "Orca")
    precondition(codingApp(bundleID: "com.microsoft.VSCode", idleSeconds: 20, locked: false) == "Code")
    for bundle in ["com.apple.Safari", "com.google.Chrome", "com.apple.Terminal", "com.microsoft.VSCode.fake", "", nil] {
        precondition(codingApp(bundleID: bundle, idleSeconds: 0, locked: false) == nil)
    }
    precondition(codingApp(bundleID: "com.stablyai.orca", idleSeconds: 180, locked: false) == nil)
    precondition(codingApp(bundleID: "com.microsoft.VSCode", idleSeconds: 0, locked: true) == nil)
    precondition(codingApp(bundleID: "com.microsoft.VSCode", idleSeconds: .infinity, locked: false) == nil)
    print("Passed: Orca/VS Code allowlist, unknown apps, idle and lock filtering")
} else if CommandLine.arguments.contains("--check") {
    print(sampleApp() ?? "not coding")
} else if CommandLine.arguments.contains("--testing") {
    fputs("This module only supports the local production server on port 5600.\n", stderr)
    exit(1)
} else {
    let watcher = CodingWatcher()
    watcher.poll()
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in watcher.poll() }
    RunLoop.main.run()
}
