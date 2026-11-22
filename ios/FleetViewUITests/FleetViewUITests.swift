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
        other.tap()
        // The other machine's page loads and shows ITS button as current.
        let pred = NSPredicate(format: "count >= 1")
        expectation(for: pred, evaluatedWith: app.webViews.descendants(matching: .any).matching(identifier: "did2200 (current)"))
        waitForExpectations(timeout: 20)
        sleep(2)
        attach(app, "q2-switched")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
