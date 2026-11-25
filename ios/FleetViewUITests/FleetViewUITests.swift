import XCTest

/// Smoke test against a real machine. Run with the machine address in
/// FLEET_TEST_MACHINE (e.g. http://127.0.0.1:4280 for this Mac's own server).
final class FleetViewUITests: XCTestCase {
    func testSwitcherOpensFromBrand() throws {
        let app = XCUIApplication()
        let machine = ProcessInfo.processInfo.environment["FLEET_TEST_MACHINE"] ?? "http://127.0.0.1:4280"
        app.launchArguments = ["-FLEET_RESET", "YES", "-FLEET_ADD_MACHINE", machine]
        addUIInterruptionMonitor(withDescription: "notifications") { alert in
            if alert.buttons["Allow"].exists { alert.buttons["Allow"].tap(); return true }
            return false
        }
        app.launch()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["Allow"].waitForExistence(timeout: 6) { springboard.buttons["Allow"].tap() }

        let brand = app.webViews.buttons["Switch machine"]
        XCTAssertTrue(brand.waitForExistence(timeout: 20), "FleetView's top bar (in-app brand) never appeared")
        attach(app, "1-loaded")
        brand.tap()
        XCTAssertTrue(app.navigationBars["Machines"].waitForExistence(timeout: 5), "switcher didn't open")
        attach(app, "2-switcher")
        XCTAssertTrue(app.staticTexts["Notifications"].exists)
        app.buttons["Add a machine"].tap()
        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 5))
        attach(app, "3-add")
    }

    func testQuickSwitchButtons() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-FLEET_RESET", "YES", "-FLEET_ADD_MACHINE", "http://127.0.0.1:4280,http://localhost:4280"]
        app.launch()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["Allow"].waitForExistence(timeout: 6) { springboard.buttons["Allow"].tap() }

        // aria-pressed makes these toggles to accessibility, not plain buttons.
        let any = app.webViews.descendants(matching: .any)
        let other = any["Switch to did2200"]
        XCTAssertTrue(other.waitForExistence(timeout: 20), "quick-switch buttons never appeared")
        XCTAssertTrue(any["did2200 (current)"].exists)
        attach(app, "q1-two-machines")
        // Icons arrive as embedded images (not a bare-letter fallback): give the
        // native fetch a moment, then no two-letter fallback chip should exist.
        sleep(3)
        XCTAssertFalse(any.staticTexts["DI"].exists, "an icon fell back to its letters")
        XCTAssertFalse(any["Switch machine"].isHittable, "the machine name should be hidden when quick switch shows")
        any["All machines"].tap()
        XCTAssertTrue(app.navigationBars["Machines"].waitForExistence(timeout: 5), "'more' didn't open the switcher")
        app.buttons["Done"].tap()
        other.tap()
        // The other machine's page loads and shows ITS button as current.
        let pred = NSPredicate(format: "count >= 1")
        expectation(for: pred, evaluatedWith: app.webViews.descendants(matching: .any).matching(identifier: "did2200 (current)"))
        waitForExpectations(timeout: 20)
        sleep(2)
        attach(app, "q2-switched")
    }

    /// Needs two mock machines: alpha on :4413, beta on :4414 (/tmp/fvtest
    /// mock.mjs with MNAME). /__dark makes one stop answering — the way an
    /// offline tailnet peer behaves (no refusal, just silence).
    func testOfflineMachine() throws {
        let alpha = "http://127.0.0.1:4413", beta = "http://127.0.0.1:4414"
        mock(beta, "__light")
        let app = XCUIApplication()
        app.launchArguments = ["-FLEET_RESET", "YES", "-FLEET_ADD_MACHINE", "\(beta),\(alpha)"]
        app.launch()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["Allow"].waitForExistence(timeout: 6) { springboard.buttons["Allow"].tap() }
        let web = app.webViews.descendants(matching: .any)
        XCTAssertTrue(web["beta (current)"].waitForExistence(timeout: 20), "beta never loaded")

        // The laptop goes away. Relaunch: the app should start on alpha, not hang on beta.
        mock(beta, "__dark")
        app.terminate()
        app.launchArguments = []
        let t0 = Date()
        app.launch()
        XCTAssertTrue(web["alpha (current)"].waitForExistence(timeout: 15), "launch didn't fall back to the machine that answers")
        print("fallback after \(Date().timeIntervalSince(t0))s")
        let betaBtn = web["Switch to beta (offline)"]
        XCTAssertTrue(betaBtn.waitForExistence(timeout: 10), "beta's quick-switch button isn't marked offline")
        attach(app, "o1-fallback")

        // Tapping it shows the offline screen quickly, with a way back.
        betaBtn.tap()
        let t1 = Date()
        XCTAssertTrue(app.staticTexts["beta is offline"].waitForExistence(timeout: 8), "no offline screen")
        print("offline screen after \(Date().timeIntervalSince(t1))s")
        attach(app, "o2-offline")
        app.buttons["Open alpha"].tap()
        XCTAssertTrue(web["alpha (current)"].waitForExistence(timeout: 5), "couldn't get back to alpha")

        // beta comes back: switching to it loads it.
        mock(beta, "__light")
        web["Switch to beta (offline)"].firstMatch.tap()
        XCTAssertTrue(web["beta (current)"].waitForExistence(timeout: 20), "beta didn't come back")
        attach(app, "o3-back")
    }

    /// Leaving the app and coming back must rebuild the page's connections at
    /// once (iOS kills them in the background but leaves them looking open).
    /// Needs the alpha mock on :4413.
    func testResumeReconnects() throws {
        let alpha = "http://127.0.0.1:4413"
        mock(alpha, "__light")
        let app = XCUIApplication()
        app.launchArguments = ["-FLEET_RESET", "YES", "-FLEET_ADD_MACHINE", alpha]
        app.launch()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["Allow"].waitForExistence(timeout: 6) { springboard.buttons["Allow"].tap() }
        XCTAssertTrue(app.webViews.buttons["Switch machine"].waitForExistence(timeout: 20), "page never loaded")
        sleep(2)
        let before = conns(alpha)
        XCUIDevice.shared.press(.home)
        sleep(5)
        let t0 = Date()
        app.activate()
        sleep(3)
        let fresh = conns(alpha).dropFirst(before.count)
        let control = fresh.first { ($0["url"] as? String ?? "").hasPrefix("/control") }
        let ms = (control?["at"] as? Double).map { $0 - t0.timeIntervalSince1970 * 1000 }
        print("after resume: \(fresh.count) new sockets; control after \(ms.map { Int($0) } ?? -1)ms")
        XCTAssertNotNil(control, "the control socket wasn't rebuilt on return")
        attach(app, "r1-resumed")
    }

    private func conns(_ base: String) -> [[String: Any]] {
        var out: [[String: Any]] = []
        let done = expectation(description: "conns")
        URLSession.shared.dataTask(with: URL(string: "\(base)/__conns")!) { d, _, _ in
            out = (d.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]]) ?? []
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 5)
        return out
    }

    /// Real machines over the tailnet: the reachability check must not call
    /// them offline. (Sign-in can't complete in a test; we only check the
    /// offline screen never appears.)
    func testRealMachinesNotOffline() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-FLEET_RESET", "YES", "-FLEET_ADD_MACHINE",
                               "did2200.tail5df669.ts.net,docholliday.tail5df669.ts.net"]
        app.launch()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["Allow"].waitForExistence(timeout: 6) { springboard.buttons["Allow"].tap() }
        sleep(12)
        attach(app, "real-1")
        let offline = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'is offline'")).firstMatch
        print("offline screen shown: \(offline.exists) \(offline.exists ? offline.label : "")")
        XCTAssertFalse(offline.exists)
    }

    private func mock(_ base: String, _ path: String) {
        let done = expectation(description: path)
        URLSession.shared.dataTask(with: URL(string: "\(base)/\(path)")!) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 5)
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
