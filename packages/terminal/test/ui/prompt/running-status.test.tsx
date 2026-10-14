/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import {
  renderRunningStatus,
  runningStatusTheme,
} from "../../../src/tui/composer/running-status"

for (const noColor of [false, true]) {
  test(`composer timer renders without a duplicate status (noColor=${noColor})`, async () => {
    const app = await testRender(() => (
      <text>
        {renderRunningStatus({
          elapsedMs: 65_000,
          theme: runningStatusTheme,
          noColor,
          trueColor: true,
        })}
      </text>
    ), { width: 40, height: 3 })
    try {
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("⏱ 01:05")
      expect(app.captureCharFrame()).not.toContain("Running")
    } finally {
      app.renderer.destroy()
    }
  })
}
