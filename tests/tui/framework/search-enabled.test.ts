import assert from "node:assert/strict";
import { test } from "node:test";
import { TuiAltScreen } from "../../../src/tui/framework/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const searchKey = "\x1b[102;6u";

for (const kind of ["approval", "confirmation", "model", "session"]) {
  test(`${kind} keeps focus while search is disabled and restores search without reopening it`, async () => {
    const terminal = new VirtualTerminal(80, 24);
    const tui = new TuiAltScreen(terminal);
    const editor = { focused: false, render: () => ["editor"], invalidate() {}, handleInput() {} };
    const inputs: string[] = [];
    const panel = {
      focused: false,
      render: () => [kind],
      invalidate() {},
      handleInput(data: string) {
        inputs.push(data);
      },
    };
    try {
      tui.start();
      tui.setFocus(editor);
      terminal.sendInput(searchKey);
      assert.notEqual(tui.getFocusedComponent(), editor);
      assert.equal(tui.hasOverlay(), true);
      tui.setSearchEnabled(false);
      assert.equal(tui.hasOverlay(), false);
      assert.equal(tui.getFocusedComponent(), editor);
      tui.setFocus(panel);
      tui.setSearchEnabled(false);
      terminal.sendInput(searchKey);
      terminal.sendInput("\r");
      terminal.sendInput("\x1b");
      assert.equal(tui.getFocusedComponent(), panel);
      assert.equal(tui.hasOverlay(), false);
      assert.deepEqual(inputs, ["\r", "\x1b"]);
      tui.setFocus(editor);
      tui.setSearchEnabled(true);
      tui.setSearchEnabled(true);
      assert.equal(tui.hasOverlay(), false);
      assert.equal(tui.getFocusedComponent(), editor);
      terminal.sendInput(searchKey);
      assert.equal(tui.hasOverlay(), true);
      terminal.sendInput("\x1b");
      assert.equal(tui.hasOverlay(), false);
      assert.equal(tui.getFocusedComponent(), editor);
      await terminal.waitForRender();
    } finally {
      tui.clear();
      tui.stop({ preserveScreen: true });
    }
  });
}

test("disabling unopened search preserves the focused overlay", () => {
  const tui = new TuiAltScreen(new VirtualTerminal(80, 24));
  const panel = { focused: false, render: () => ["panel"], invalidate() {}, handleInput() {} };
  try {
    tui.start();
    const overlay = tui.showOverlay(panel);
    tui.setSearchEnabled(false);
    assert.equal(overlay.isFocused(), true);
    assert.equal(tui.hasOverlay(), true);
  } finally {
    tui.clear();
    tui.stop({ preserveScreen: true });
  }
});
