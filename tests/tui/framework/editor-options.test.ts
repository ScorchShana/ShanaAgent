import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "../../../src/tui/framework/components/editor.ts";
import { TuiMainScreen } from "../../../src/tui/framework/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function editor(options: { minVisibleLines?: number; maxVisibleLines?: number; clearOnSubmit?: boolean }) {
  return new Editor(new TuiMainScreen(new VirtualTerminal(40, 24)), defaultEditorTheme, options);
}

test("configured editor limits include empty padding and small-window zero budgets", () => {
  const value = editor({ minVisibleLines: 4, maxVisibleLines: 6 });
  assert.equal(value.render(40).length, 6);
  value.setText("a\nb\nc\nd\ne\nf\ng");
  assert.equal(value.render(40).length, 8);
  value.setVisibleLineLimits(0, 0);
  assert.equal(value.render(40).length, 2);
  value.setVisibleLineLimits(1, 1);
  assert.equal(value.render(40).length, 3);
});

test("submit retention keeps full paste until application accepts it", () => {
  const value = editor({ clearOnSubmit: false });
  const draft = "long paste\n".repeat(100);
  value.handleInput("\x1b[200~" + draft + "\x1b[201~");
  const before = value.getText();
  let submitted = "";
  value.onSubmit = (text) => {
    submitted = text;
  };
  value.handleInput("\r");
  assert.equal(submitted, draft.trim());
  assert.equal(value.getText(), before);
  value.setText("");
  assert.equal(value.getText(), "");
});

test("default submit continues clearing the editor", () => {
  const value = editor({});
  value.setText("hello");
  value.handleInput("\r");
  assert.equal(value.getText(), "");
});
