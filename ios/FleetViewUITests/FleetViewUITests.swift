import XCTest

/// Smoke test against a real machine. Run with the machine address in
/// FLEET_TEST_MACHINE (e.g. http://127.0.0.1:4280 for this Mac's own server).
final class FleetViewUITests: XCTestCase {
    func testSwitcherOpensFromBrand() throws {
        let app = XCUIApplication()
        let machine = ProcessInfo.processInfo.environment["FLEET_TEST_MACHINE"] ?? "http://127.0.0.1:4280"
        app.launchArguments = ["-FLEET_ADD_MACHINE", machine]
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

    private func attach(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
