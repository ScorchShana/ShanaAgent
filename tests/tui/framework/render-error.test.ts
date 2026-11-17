import assert from "node:assert/strict";
import { test } from "node:test";
import { TuiAltScreen } from "../../../src/tui/framework/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

for (const scheduled of [false, true]) {
  test(`reports ${scheduled ? "scheduled" : "synchronous"} rendering failure once and leaves cleanup to host`, async () => {
    const terminal = new VirtualTerminal(40, 10);
    const failure = new Error("fixture render failure");
    const failures: unknown[] = [];
    let attempts = 0;
    let stops = 0;
    const originalStop = terminal.stop.bind(terminal);
    terminal.stop = () => {
      stops++;
      originalStop();
    };
    const tui = new TuiAltScreen(terminal, false, undefined, {
      onRenderError: (error) => failures.push(error),
    });
    try {
      tui.start();
      tui.addChild({
        render() {
          attempts++;
          throw failure;
        },
        invalidate() {},
      });
      if (scheduled) tui.requestRender();
      else assert.doesNotThrow(() => tui.renderNow());
      await terminal.waitForRender();
      tui.requestRender();
      tui.renderNow();
      await terminal.waitForRender();
      assert.deepEqual(failures, [failure]);
      assert.equal(attempts, 1);
      assert.equal(stops, 0);
    } finally {
      tui.clear();
      tui.stop();
    }
    assert.equal(stops, 1);
  });
}
