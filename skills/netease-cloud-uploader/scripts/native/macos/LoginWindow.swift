// NeteaseWebViewLogin — macOS WKWebView login helper
//
// Mirrors native/windows/WebViewLogin.cs. Opens a WKWebView window loading
// the official NetEase login page, polls for the MUSIC_U cookie, writes the
// cookie header to session.dpapi (base64 on non-Windows), and exits.
//
// Exit codes (identical to the Windows helper):
//   0  = login successful, credential saved
//  10  = WKWebView initialization failed
//  11  = window closed before authentication completed
//  12  = login page failed to load
//  13  = could not read or save the authenticated session
//
// Environment:
//   NCM_STATE_DIR  — absolute path to the state directory (required)
//
// Build: see ../build.sh

import Cocoa
import WebKit
import Foundation

private let loginURL = URL(string: "https://music.163.com/#/login")!

private let cookiePollInterval: TimeInterval = 1.0
private let automaticNavigationRetries = 2

private final class LoginController: NSObject, WKNavigationDelegate {
    private let stateDir: String
    private let credentialPath: String
    private let webView: WKWebView
    private var cookieTimer: Timer?
    private var credentialSaved = false
    private var navigationFailureCount = 0
    private var exitCode: Int32 = 11  // default: window closed before auth

    init(stateDir: String) {
        self.stateDir = stateDir
        self.credentialPath = (stateDir as NSString).appendingPathComponent("session.dpapi")

        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.nonPersistent()
        self.webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
    }

    func run() -> Int32 {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 800),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "网易云音乐登录"
        window.contentView = webView
        window.center()
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.makeKeyAndOrderFront(nil)

        // Start polling cookies
        cookieTimer = Timer.scheduledTimer(
            withTimeInterval: cookiePollInterval,
            repeats: true
        ) { [weak self] _ in
            self?.checkCookies()
        }

        // Load login page
        webView.load(URLRequest(url: loginURL))

        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        NSApp.run()

        return exitCode
    }

    private func checkCookies() {
        guard !credentialSaved else { return }
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self = self, !self.credentialSaved else { return }

            var hasMusicU = false
            var pairs: [String] = []
            for cookie in cookies {
                guard cookie.domain == "music.163.com" || cookie.domain.hasSuffix(".music.163.com") else { continue }
                if cookie.name == "MUSIC_U" && !cookie.value.isEmpty {
                    hasMusicU = true
                }
                pairs.append("\(cookie.name)=\(cookie.value)")
            }

            guard hasMusicU else { return }

            let cookieHeader = pairs.joined(separator: "; ")
            do {
                try self.saveCredential(cookieHeader)
                self.credentialSaved = true
                self.exitCode = 0
                self.cookieTimer?.invalidate()
                DispatchQueue.main.async {
                    NSApp.stopModal()
                    NSApp.terminate(nil)
                }
            } catch {
                self.exitCode = 13
                self.cookieTimer?.invalidate()
                DispatchQueue.main.async {
                    NSApp.terminate(nil)
                }
            }
        }
    }

    private func saveCredential(_ cookieHeader: String) throws {
        try FileManager.default.createDirectory(
            atPath: stateDir,
            withIntermediateDirectories: true
        )
        // macOS has no DPAPI; store base64 and rely on 0o600 file permissions,
        // same as the Electron fallback path.
        let base64 = Data(cookieHeader.utf8).base64EncodedString()
        let url = URL(fileURLWithPath: credentialPath)
        try base64.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: credentialPath)
    }

    // WKNavigationDelegate

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleNavigationFailure(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleNavigationFailure(error)
    }

    private func handleNavigationFailure(_ error: Error) {
        guard !credentialSaved else { return }
        let nsError = error as NSError
        // Client-side route changes can cancel an earlier navigation; ignore those.
        if nsError.code == NSURLErrorCancelled { return }

        navigationFailureCount += 1
        fputs("{\"event\":\"wkwebview_navigation_failed\",\"status\":\"\(nsError.code)\",\"attempt\":\(navigationFailureCount)}\n", stderr)

        if navigationFailureCount <= automaticNavigationRetries {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                guard let self = self, !self.credentialSaved else { return }
                self.webView.load(URLRequest(url: loginURL))
            }
            return
        }

        let alert = NSAlert()
        alert.messageText = "网易云官方登录页加载失败（错误码 \(nsError.code)）"
        alert.informativeText = "将切换到备用登录方式。"
        alert.addButton(withTitle: "重试")
        alert.addButton(withTitle: "取消")
        alert.alertStyle = .warning
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            navigationFailureCount = 0
            webView.load(URLRequest(url: loginURL))
        } else {
            exitCode = 12
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
}

extension LoginController: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        if !credentialSaved && exitCode == 11 {
            cookieTimer?.invalidate()
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
}

// MARK: - Main

guard let stateDir = ProcessInfo.processInfo.environment["NCM_STATE_DIR"] else {
    fputs("NCM_STATE_DIR is required\n", stderr)
    exit(10)
}

// Ensure we have an autorelease pool for the app lifecycle
autoreleasepool {
    _ = NSApplication.shared
    let controller = LoginController(stateDir: stateDir)
    let code = controller.run()
    exit(code)
}
