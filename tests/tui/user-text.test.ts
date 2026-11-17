import { expect, it } from "vitest";
import { TuiApp } from "../../src/tui/app.js";
import { SessionController } from "../../src/core/session-controller.js";
import { parseSettings } from "../../src/llm/settings-store.js";
import { TuiStore } from "../../src/tui/store.js";
import { TuiAltScreen } from "../../src/tui/framework/index.js";
import { VirtualTerminal } from "./framework/virtual-terminal.js";

it("keeps Unicode graphemes intact across paste, cursor movement and deletion", async () => {
  const core = new SessionController({ driver: { execute: async () => ({ outcome: "completed" }) } });
  const store = new TuiStore(core, parseSettings({}));
  const tui = new TuiAltScreen(new VirtualTerminal());
  const app = new TuiApp(store, tui);
  try {
    app.editor.handleInput("\x1b[200~\u4e2d\u6587\u{1f469}\u200d\u{1f4bb}e\u0301\x1b[201~");
    expect(store.getSnapshot().draft).toBe("\u4e2d\u6587\u{1f469}\u200d\u{1f4bb}e\u0301");
    app.editor.handleInput("\x1b[D");
    app.editor.handleInput("\x7f");
    expect(app.editor.getText()).toBe("\u4e2d\u6587e\u0301");
    expect(store.getSnapshot().draft).toBe("\u4e2d\u6587e\u0301");
  } finally {
    app.dispose();
    await store.dispose();
  }
});
