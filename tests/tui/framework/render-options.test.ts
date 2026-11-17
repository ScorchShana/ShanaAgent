import assert from "node:assert/strict";
import { test } from "node:test";
import { TuiAltScreen } from "../../../src/tui/framework/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

test("immediate requests preempt refresh throttle while retaining the diff cache", async () => {
  const terminal = new VirtualTerminal(40, 10);
  const tui = new TuiAltScreen(terminal, false, undefined, { refreshIntervalMs: 60000 });
  let count = 0;
  let text = "initial";
  tui.addChild({
    render: () => {
      count++;
      return [text];
    },
    invalidate: () => {},
  });
  tui.start();
  tui.renderNow();
  const first = count;
  const redraws = tui.fullRedraws;
  try {
    text = "changed";
    tui.requestRender();
    await new Promise((resolve) => process.nextTick(resolve));
    assert.equal(count, first);
    tui.requestImmediateRender();
    await new Promise((resolve) => process.nextTick(resolve));
    assert.equal(count, first + 1);
    assert.equal(tui.fullRedraws, redraws);
  } finally {
    tui.stop({ preserveScreen: true });
  }
});
