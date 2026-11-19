import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { TuiApp } from "../../src/tui/app.js";
import { SessionController } from "../../src/core/session-controller.js";
import { TuiStore } from "../../src/tui/store.js";
import { parseSettings } from "../../src/llm/settings-store.js";
import { TuiAltScreen, Text, getKeybindings, type Component } from "../../src/tui/framework/index.js";
import { makeModelSnapshot } from "../sessions/helpers.js";
import { VirtualTerminal } from "./framework/virtual-terminal.js";

it.each(["\r", "\x1b[13u", "\x1b[13;1u"])("fills /quit on the first Enter and exits on the second %j", async (enter) => {
  const test = setup();
  const requestExit = vi.spyOn(test.store, "requestExit");
  try {
    for (const key of "/quit") test.terminal.sendInput(key);
    await vi.waitFor(() => expect(test.app.editor.capturesViewportInput).toBe(true));
    test.terminal.sendInput(enter);
    expect(test.app.editor.getText()).toBe("/quit");
    expect(test.app.editor.capturesViewportInput).toBe(false);
    expect(requestExit).not.toHaveBeenCalled();
    test.terminal.sendInput(enter);
    await vi.waitFor(() => expect(requestExit).toHaveBeenCalledTimes(1));
    await test.store.dispose();
    expect(test.store.getSnapshot().modal).toBeNull();
  } finally { await test.close(); }
});

it.each([15, 24, 40])("shows slash command suggestions after typing slash at height %s", async (height) => {
  const test = setup();
  try {
    test.terminal.resize(80, height);
    test.terminal.sendInput("/");
    await vi.waitFor(() => expect(test.app.editor.capturesViewportInput).toBe(true));
    test.tui.requestImmediateRender();
    const rows = await test.terminal.flushAndGetViewport();
    expect(rows.join("\n")).toContain("/model");
  } finally { await test.close(); }
});

it.each(["\r", "\x1b[13u", "\x1b[13;1u"])("fills the selected model command and runs it on the second Enter %j", async (enter) => {
  const test = setup();
  try {
    for (const key of "/mo") test.terminal.sendInput(key);
    await vi.waitFor(() => expect(test.app.editor.capturesViewportInput).toBe(true));
    test.terminal.sendInput(enter);
    expect(test.store.getSnapshot().draft).toBe("/model");
    expect(test.app.editor.getText()).toBe("/model");
    expect(test.store.getSnapshot().notice).toBeNull();
    expect(test.app.editor.capturesViewportInput).toBe(false);
    test.terminal.sendInput(enter);
    expect(test.store.getSnapshot().draft).toBe("");
    expect(test.store.getSnapshot().notice?.text).toContain("model.json");
  } finally { await test.close(); }
});

it("retains the full long paste after a rejected submission", async () => {
  const test = setup();
  const text = "中文 😀 line\n".repeat(100);
  try {
    test.terminal.sendInput(`\x1b[200~${text}\x1b[201~`);
    test.terminal.sendInput("\r");
    expect(test.store.getSnapshot().draft).toBe(text.trim());
    expect(test.app.editor.getText()).toBe(text.trim());
    expect(test.core.getSnapshot().status.kind).toBe("idle");
  } finally { await test.close(); }
});

it("keeps approval keyboard focus when the Editor is clicked", async () => {
  const test = setup(true);
  const resolve = vi.spyOn(test.core, "resolveApproval");
  const run = test.core.submitPrompt("approve");
  try {
    await vi.waitFor(() => expect(test.store.getSnapshot().modal?.kind).toBe("approval"));
    test.tui.requestImmediateRender();
    const rows = await test.terminal.flushAndGetViewport();
    const border = rows.findIndex((row) => row.includes("─"));
    expect(border).toBeGreaterThanOrEqual(0);
    test.terminal.sendInput(`\x1b[<0;3;${border + 2}M`);
    test.terminal.sendInput(`\x1b[<0;3;${border + 2}m`);
    expect(test.app.editor.focused).toBe(false);
    test.terminal.sendInput("\x1b[B");
    test.terminal.sendInput("\r");
    expect(resolve).toHaveBeenCalledWith(expect.any(String), "session");
    await run;
  } finally { await test.close(); }
});

it("cleans the application timer when layout initialization throws", async () => {
  vi.useFakeTimers();
  const core = new SessionController({ driver: { execute: async () => ({ outcome: "completed" }) } });
  const store = new TuiStore(core, parseSettings({}));
  const tui = new TuiAltScreen(new VirtualTerminal());
  const failure = new Error("layout initialization failed");
  vi.spyOn(tui, "setLayoutRoot").mockImplementation(() => { throw failure; });
  const timers = vi.getTimerCount();
  try {
    expect(() => new TuiApp(store, tui)).toThrow(failure);
    expect(vi.getTimerCount()).toBe(timers);
  } finally { await store.dispose(); tui.stop({ preserveScreen: true }); vi.useRealTimers(); }
});

it("resumes following when Core accepts a new prompt", async () => {
  const test = setup();
  try {
    test.app.conversation.addChild(new Text("line\n".repeat(80), 0, 0));
    test.tui.requestImmediateRender();
    await test.terminal.flushAndGetViewport();
    test.app.scroll.scrollBy(-10);
    expect(test.app.scroll.isFollowingEnd).toBe(false);
    await test.core.submitPrompt("accepted");
    await vi.waitFor(() => expect(test.app.scroll.isFollowingEnd).toBe(true));
  } finally { await test.close(); }
});

it("keeps editing focus and follow state through Tab and selector dismissal", async () => {
  const test = setup();
  try {
    test.terminal.sendInput("draft");
    const cursor = test.app.editor.getCursor();
    for (const key of ["\t", "\x1b[Z"]) {
      test.terminal.sendInput(key);
      expect(test.app.editor.focused).toBe(true);
      expect(test.app.scroll.isFollowingEnd).toBe(true);
      expect(test.app.editor.getText()).toBe("draft");
      expect(test.app.editor.getCursor()).toEqual(cursor);
    }
    vi.spyOn(test.core, "listSessions").mockResolvedValue([]);
    test.store.setDraft("/resume"); await test.store.submit();
    test.store.dismissModal();
    expect(test.app.editor.focused).toBe(true);
    expect(test.store.getSnapshot()).not.toHaveProperty("focus");
  } finally { await test.close(); }
});

it("keeps Editor editing after mouse placement", async () => {
  const test = setup();
  try {
    test.terminal.sendInput("\t");
    test.tui.requestImmediateRender();
    const rows = await test.terminal.flushAndGetViewport();
    const border = rows.findIndex((row) => row.includes("─"));
    expect(border).toBeGreaterThanOrEqual(0);
    test.terminal.sendInput(`\x1b[<0;3;${border + 2}M`);
    test.terminal.sendInput(`\x1b[<0;3;${border + 2}m`);
    expect(test.app.editor.focused).toBe(true);
    test.terminal.sendInput("x");
    expect(test.app.editor.getText()).toContain("x");
  } finally { await test.close(); }
});

function setup(approval = false, command = "echo approved", toolName = "bash") {
  const core = new SessionController({ driver: { execute: async (handle) => {
    if (approval) await handle.requestApproval({ toolCallId: "call", toolName, summary: {
      paths: toolName === "write" ? ["preview-fixture.txt"] : [],
      command: toolName === "bash" ? command : undefined,
      parameters: toolName === "write" ? { content: command } : undefined,
    } });
    return { outcome: "completed" };
  } } });
  const store = new TuiStore(core, parseSettings({}));
  if(approval) vi.spyOn(store,"items").mockImplementation(()=> {
    const pending = core.getSnapshot().pendingApproval;
    return pending ? [{id:"fixture-tool",role:"tool",text:toolName,pendingApprovalId:pending.id,
      call:{id:"call",name:toolName,parse:{status:"parsed",arguments:toolName === "bash" ? {command} : {path:"preview-fixture.txt",content:command}}}}] as ReturnType<TuiStore["items"]> : [];
  });
  const terminal = new VirtualTerminal();
  const tui = new TuiAltScreen(terminal);
  const app = new TuiApp(store, tui);
  tui.start();
  return {
    core,
    store,
    terminal,
    tui,
    app,
    async close() {
      app.dispose();
      await store.dispose();
      tui.stop({ preserveScreen: true });
    },
  };
}
it("keeps the Editor draft when no model accepts a prompt", async () => {
  const test = setup();
  try {
    test.app.editor.setText("draft");
    test.app.editor.onSubmit?.("draft");
    expect(test.store.getSnapshot().draft).toBe("draft");
    expect(test.app.editor.getText()).toBe("draft");
    expect(test.core.getSnapshot().status.kind).toBe("idle");
  } finally {
    await test.close();
  }
});
it("does not pick a different command when there are no completions", async () => {
  const test = setup();
  const submit = vi.spyOn(test.store, "submit");
  try {
    for (const key of "/nonexistent") test.terminal.sendInput(key);
    await vi.waitFor(() => expect(test.app.editor.capturesViewportInput).toBe(false));
    test.terminal.sendInput("\r");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(test.store.getSnapshot().modal).toBeNull();
    expect(test.core.getSnapshot().status.kind).toBe("idle");
  } finally { await test.close(); }
});
it("fills the selected completion without executing it", async () => {
  const test = setup();
  try {
    test.terminal.sendInput("/");
    await vi.waitFor(() => expect(test.app.editor.capturesViewportInput).toBe(true));
    // 下移到 /exit：次数按菜单中的实际位置派生，新增命令不再使本用例过期。
    const downs = test.store.commandOptions().findIndex((option) => option.name === "/exit");
    for (let i = 0; i < downs; i++) test.terminal.sendInput("\x1b[B");
    test.terminal.sendInput("\r");
    expect(test.app.editor.getText()).toBe("/exit");
    expect(test.store.getSnapshot().draft).toBe("/exit");
    expect(test.app.editor.capturesViewportInput).toBe(false);
    expect(test.store.getSnapshot().modal).toBeNull();
    expect(test.core.getSnapshot().status.kind).toBe("idle");
  } finally {
    await test.close();
  }
});
it("uses native Tab completion and Escape without cancelling a Run", async () => {
  const test = setup();
  const cancel = vi.spyOn(test.store, "cancel");
  try {
    for (const key of "/ex") test.terminal.sendInput(key);
    await vi.waitFor(() => expect(test.app.editor.capturesViewportInput).toBe(true));
    test.terminal.sendInput("\t");
    expect(test.app.editor.getText()).toBe("/exit");
    expect(test.store.getSnapshot().modal).toBeNull();
    test.app.editor.setText("");
    test.terminal.sendInput("/");
    await vi.waitFor(() => expect(test.app.editor.capturesViewportInput).toBe(true));
    test.terminal.sendInput("\x1b");
    expect(test.app.editor.getText()).toBe("/");
    expect(cancel).not.toHaveBeenCalled();
  } finally { await test.close(); }
});
it("disables search for confirmation and restores keys without reopening search", async () => {
  const test = setup();
  const search = vi.spyOn(test.tui, "setSearchEnabled");
  try {
    vi.spyOn(test.core, "listSessions").mockResolvedValue([]);
    test.store.setDraft("/resume"); await test.store.submit();
    test.app.update();
    expect(search).toHaveBeenLastCalledWith(false);
    test.store.dismissModal();
    test.app.update();
    expect(search).toHaveBeenLastCalledWith(true);
  } finally {
    await test.close();
  }
});
it("uses lightweight timer updates without asking Store for history items", async () => {
  vi.useFakeTimers();
  const test = setup();
  try {
    await vi.advanceTimersByTimeAsync(1);
    const items = vi.spyOn(test.store, "items");
    items.mockClear();
    await vi.advanceTimersByTimeAsync(test.store.settings.runTimerRefreshMs * 2);
    expect(items).not.toHaveBeenCalled();
  } finally {
    await test.close();
    vi.useRealTimers();
  }
});

it("mounts the application as the full-screen layout root", async () => {
  const mount = vi.spyOn(TuiAltScreen.prototype, "setLayoutRoot");
  const test = setup();
  try {
    expect(mount).toHaveBeenCalledWith(test.app.root);
  } finally {
    await test.close();
    mount.mockRestore();
  }
});

it("updates retained message instances when expansion changes without new history", async () => {
  const test = setup();
  const item = { id: "tool", role: "tool" as const, text: "", result: { content: "visible output", status: "success" } };
  vi.spyOn(test.store, "items").mockReturnValue([item] as never);
  try {
    test.app.update();
    expect(test.app.conversation.render(80).join("\n")).not.toContain("visible output");
    test.store.toggle("tool");
    test.app.update();
    expect(test.app.conversation.render(80).join("\n")).toContain("visible output");
  } finally {
    await test.close();
  }
});

it("shows persisted session identity above history and clears it on reset", async () => {
  const test = setup();
  const original = test.store.getSnapshot();
  const snapshot = vi.spyOn(test.store, "getSnapshot");
  try {
    snapshot.mockReturnValue({ ...original, core: { ...original.core, session: {
      ...original.core.session, title: "Session title", ref: { workspaceId: "workspace", sessionId: "12345678-rest" },
    } } });
    test.app.update();
    let frame = (await test.terminal.flushAndGetViewport()).join("\n");
    expect(frame).toContain("Session title");
    expect(frame).toContain("12345678");
    expect(test.app.sessionInfo.render(20)[1]).toBe("─".repeat(20));
    snapshot.mockReturnValue(original);
    test.app.update();
    frame = (await test.terminal.flushAndGetViewport()).join("\n");
    expect(frame).not.toContain("Session title");
  } finally {
    snapshot.mockRestore();
    await test.close();
  }
});

it("keeps the draft visible during approval and restores after a single-row resize", async () => {
  const test = setup(true);
  test.terminal.resize(80, 40);
  const run = test.core.submitPrompt("approval");
  try {
    await vi.waitFor(() => expect(test.core.getSnapshot().pendingApproval).not.toBeNull());
    test.app.editor.setText("preserved draft");
    test.app.update();
    let rows = await test.terminal.flushAndGetViewport();
    expect(rows.join("\n")).toContain("preserved draft");
    expect(rows.join("\n")).toContain("echo approved");
    test.terminal.resize(80, 1);
    test.tui.requestImmediateRender();
    rows = await test.terminal.flushAndGetViewport();
    expect(rows.join("").trim()).toBe("");
    test.terminal.resize(80, 40);
    test.tui.requestImmediateRender();
    rows = await test.terminal.flushAndGetViewport();
    expect(rows.join("\n")).toContain("preserved draft");
    expect(rows.join("\n")).toContain("echo approved");
  } finally { await test.close(); await run; }
});

it("keeps approval actions and draft visible when long content must scroll", async () => {
  const test = setup(true, Array.from({ length: 80 }, (_, i) => `echo line ${i}`).join("\n"));
  test.terminal.resize(31, 15);
  const run = test.core.submitPrompt("approval");
  try {
    await vi.waitFor(() => expect(test.core.getSnapshot().pendingApproval).not.toBeNull());
    test.app.editor.setText("draft marker");
    test.app.update();
    const frame = (await test.terminal.flushAndGetViewport()).join("\n");
    expect(frame).toContain("draft marker");
    expect(frame).toContain("\u5141\u8bb8\u4e00\u6b21");
    expect(frame).toContain("\u672c\u4f1a\u8bdd\u5141\u8bb8");
    expect(frame).toContain("\u62d2\u7edd");
  } finally { await test.close(); await run; }
});

it.each([24, 40])("replaces the Editor at the bottom and restores its draft at height %s", async height => {
  const test = setup();
  vi.spyOn(test.core, "listSessions").mockResolvedValue([sessionEntry("Bottom session")]);
  try {
    test.terminal.resize(80, height);
    test.app.conversation.addChild(new Text("history\n".repeat(80), 0, 0));
    test.store.setDraft("/resume"); await test.store.submit();
    test.app.editor.setText("one\ntwo\nthree\nfour\nfive\nsix");
    test.app.update();
    const frame = await test.terminal.flushAndGetViewport();
    const index = frame.findIndex(row => row.includes("Bottom session"));
    expect(index).toBeGreaterThan(height / 2);
    expect(frame.join("\n")).not.toContain("six");
    test.terminal.sendInput("\x1b"); test.app.update();
    expect(test.app.editor.getText()).toContain("six");
    expect(test.app.editor.focused).toBe(true);
  } finally { await test.close(); }
});

it("keeps the selected approval action reachable in two rows and restores the draft", async () => {
  const test = setup(true);
  const resolve = vi.spyOn(test.core, "resolveApproval");
  const run = test.core.submitPrompt("approval");
  try {
    await vi.waitFor(() => expect(test.core.getSnapshot().pendingApproval).not.toBeNull());
    test.app.editor.setText("tiny draft");
    test.terminal.resize(20, 2);
    test.tui.requestImmediateRender();
    let frame = (await test.terminal.flushAndGetViewport()).join("\n");
    expect(frame).toContain("\u5141\u8bb8\u4e00\u6b21");
    expect(frame).not.toContain("echo approved");
    test.terminal.sendInput("\x1b[B");
    test.tui.requestImmediateRender();
    frame = (await test.terminal.flushAndGetViewport()).join("\n");
    expect(frame).toContain("\u672c\u4f1a\u8bdd\u5141\u8bb8");
    test.terminal.resize(80, 40);
    test.tui.requestImmediateRender();
    frame = (await test.terminal.flushAndGetViewport()).join("\n");
    expect(frame).toContain("tiny draft");
    expect(frame).toContain("echo approved");
    test.terminal.resize(20, 2);
    test.tui.requestImmediateRender();
    await test.terminal.flushAndGetViewport();
    test.terminal.sendInput("\r");
    expect(resolve).toHaveBeenCalledWith(expect.any(String), "session");

  } finally { await test.close(); await run; }
});

it.each(["missing", "failure"])("keeps approval controls reachable after delayed preview %s", async (outcome) => {
  let release!: (error: NodeJS.ErrnoException) => void;
  const stat = vi.spyOn(fs, "stat").mockImplementation(() => new Promise((_resolve, reject) => { release = reject; }));
  const test = setup(true, Array.from({ length: 40 }, (_, index) => `preview line ${index}`).join("\n"), "write");
  test.terminal.resize(80, 40);
  const run = test.core.submitPrompt("preview");
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    test.app.editor.setText("loading draft");
    test.app.update();
    let frame = (await test.terminal.flushAndGetViewport()).join("\n");
    expect(frame).toContain("loading draft");
    expect(frame).toContain("\u5141\u8bb8\u4e00\u6b21");
    release(Object.assign(new Error("preview probe"), { code: outcome === "missing" ? "ENOENT" : "EACCES" }));
    await vi.waitFor(async () => {
      frame = (await test.terminal.flushAndGetViewport()).join("\n");
      expect(frame).toContain(outcome === "missing" ? "preview line" : "\u9884\u89c8\u4e0d\u53ef\u7528");
    });
    for (const rows of [15, 2, 40]) {
      test.terminal.resize(31, rows);
      test.tui.requestImmediateRender();
      test.terminal.sendInput("\x1b[6~");
      frame = (await test.terminal.flushAndGetViewport()).join("\n");
      expect(frame).toContain("\u5141\u8bb8\u4e00\u6b21");
      if (rows > 2) expect(frame).toContain("loading draft");
    }
  } finally {
    stat.mockRestore();
    await test.close();
    await run;
  }
});

function sessionEntry(title: string) {
  return { version: 1, workspaceId: "ws", sessionId: "12345678-source", createdAt: "2026-01-01", title,
    preview: "recent user request", lastActiveAt: "2026-11-15", runCount: 2, occupied: true };
}
it("shows session details and refreshes a replacement chooser of the same kind", async () => {
  const test = setup();
  const sessions = vi.spyOn(test.core, "listSessions").mockResolvedValueOnce([sessionEntry("First title"), { ...sessionEntry("Other title"), sessionId: "other-session", preview: "next request", runCount: 5, occupied: false }]).mockResolvedValueOnce([sessionEntry("New title")]);
  try {
    test.store.setDraft("/resume"); await test.store.submit(); test.app.update();
    let frame = (await test.terminal.flushAndGetViewport()).join("\n");
    expect(frame).toContain("First title");
    expect(frame).toContain("recent user request");
    expect(frame).toContain("2026-11-15");
    expect(frame).toContain("2 \u6b21 Run");
    expect(frame).toContain("\u5df2\u5360\u7528");
    test.terminal.sendInput("\x1b[B");
    frame = (await test.terminal.flushAndGetViewport()).join("\n");
    expect(frame).toContain("next request");
    expect(frame).not.toContain("recent user request");
    expect(frame).toContain("5 \u6b21 Run");

    test.store.setDraft("/resume"); await test.store.submit(); test.app.update();
    frame = (await test.terminal.flushAndGetViewport()).join("\n");
    expect(frame).toContain("New title");
    expect(frame).not.toContain("First title");
    expect(sessions).toHaveBeenCalledTimes(2);
  } finally { await test.close(); }
});
it("describes direct resume and restores with one selection", async () => {
  const test = setup();
  vi.spyOn(test.core, "listSessions").mockResolvedValue([sessionEntry("Resume title")]);
  const resume = vi.spyOn(test.core, "resumeSession").mockResolvedValue();
  try {
    test.store.setDraft("/resume"); await test.store.submit(); test.app.update();
    const frame = (await test.terminal.flushAndGetViewport()).join("\n");
    expect(frame).toContain("选择后继续原会话");
    test.terminal.sendInput("\r"); test.app.update();
    await vi.waitFor(() => expect(test.store.getSnapshot().modal).toBeNull());
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
  } finally { await test.close(); }
});

it("keeps a newer approval and its selected action when an effort save finishes", async () => {
  let requestApproval!: () => Promise<void>;
  let releaseSave!: () => void;
  const model = makeModelSnapshot();
  const core = new SessionController({
    driver: { execute: async (handle) => new Promise(resolve => {
      requestApproval = async () => {
        await handle.requestApproval({ toolCallId: "new", toolName: "bash", summary: { paths: [], command: "echo pending" } });
        resolve({ outcome: "completed" });
      };
    }) },
    hooks: { getSessionView: () => ({ title: null, ref: null, model, models: [model], runModel: null,
      contextBaselineTokens: null, autoDecision: { enabled: false, availability: "missing" } }) },
  });
  vi.spyOn(core, "setReasoningEffort").mockImplementation(() => new Promise(resolve => { releaseSave = resolve; }));
  const decision = vi.spyOn(core, "resolveApproval");
  const store = new TuiStore(core, parseSettings({}));
  const terminal = new VirtualTerminal();
  const tui = new TuiAltScreen(terminal);
  const app = new TuiApp(store, tui);
  tui.start();
  const run = core.submitPrompt("run");
  try {
    await vi.waitFor(() => expect(requestApproval).toBeTypeOf("function"));
    store.setDraft("/effort"); await store.submit(); app.update();
    terminal.sendInput("\r");
    expect(releaseSave).toBeTypeOf("function");
    const approval = requestApproval();
    await vi.waitFor(() => expect(store.getSnapshot().modal?.kind).toBe("approval"));
    app.update();
    terminal.sendInput("\x1b[B"); terminal.sendInput("\x1b[B");
    releaseSave();
    await new Promise(resolve => setImmediate(resolve));
    app.update();
    expect(store.getSnapshot().modal?.kind).toBe("approval");
    expect((await terminal.flushAndGetViewport()).join("\n")).toContain("\u2192 \u62d2\u7edd");
    terminal.sendInput("\r");
    expect(decision).toHaveBeenCalledWith(expect.any(String), "deny");
    await approval;
  } finally {
    releaseSave?.(); app.dispose(); await store.dispose(); await run; tui.stop({ preserveScreen: true });
  }
});

it.each([24,40])("auto-expands an approval once and lets clicking take over without changing authorization at height %s", async height => {
 const test=setup(true); const run=test.core.submitPrompt("approve");
 try {
   test.terminal.resize(80,height);
   await vi.waitFor(()=>expect(test.store.getSnapshot().modal?.kind).toBe("approval"));
   await vi.waitFor(()=>expect(test.store.getSnapshot().expanded.has("fixture-tool")).toBe(true));
   const reveal=vi.spyOn(test.app.scroll,"reveal");
   let frame=await test.terminal.flushAndGetViewport();
   const row=frame.findIndex(line=>line.includes("Waiting for permission")); expect(row).toBeGreaterThanOrEqual(0);
   test.terminal.sendInput(`\x1b[<0;3;${row+1}M`); test.terminal.sendInput(`\x1b[<0;3;${row+1}m`);
   await vi.waitFor(()=>expect(test.store.getSnapshot().expanded.has("fixture-tool")).toBe(false));
   expect(test.store.getSnapshot().modal).toMatchObject({kind:"approval",selection:0});
   test.app.update();
   expect(test.store.getSnapshot().expanded.has("fixture-tool")).toBe(false);
   test.terminal.sendInput("\x1b[B");
   test.terminal.sendInput("\x0c");
   expect(reveal).toHaveBeenCalledOnce();
   expect(test.store.getSnapshot().modal).toMatchObject({kind:"approval",selection:0});
   test.app.update(); await test.terminal.flushAndGetViewport(); expect(reveal).toHaveBeenCalledOnce();
   frame=await test.terminal.flushAndGetViewport(); expect(frame.join("\n").match(/echo approved/g)).toHaveLength(1);
 } finally {await test.close(); await run;}
});
it("drops a delayed approval preview after cancellation", async()=>{
 let release!: (error: Error)=>void;
 const stat=vi.spyOn(fs,"stat").mockImplementation(()=>new Promise((_resolve,reject)=>{release=reject;}));
 const test=setup(true,"new content","write"); const run=test.core.submitPrompt("approve");
 try {
  await vi.waitFor(()=>expect(release).toBeTypeOf("function")); test.store.dismissModal(); await run;
  release(new Error("late failure")); await new Promise(resolve=>setImmediate(resolve));
  expect((await test.terminal.flushAndGetViewport()).join("\n")).not.toContain("预览不可用");
 } finally {stat.mockRestore(); await test.close();}
});

it("scrolls history without losing draft input or changing follow on Tab", async () => {
  const test = setup();
  try {
    test.terminal.sendInput("draft");
    test.app.conversation.addChild(new Text("line\n".repeat(80), 0, 0));
    test.tui.requestImmediateRender();
    await test.terminal.flushAndGetViewport();
    test.terminal.sendInput("\x1b[5~");
    expect(test.app.scroll.isFollowingEnd).toBe(false);
    test.terminal.sendInput("\x1b[1;5H");
    expect(test.app.scroll.scrollTop).toBe(0);
    const bindings = getKeybindings();
    const original = bindings.getUserBindings();
    try {
      bindings.setUserBindings({ ...original, "tui.altScreen.lineUp": "ctrl+up", "tui.altScreen.lineDown": "ctrl+down" });
      test.terminal.sendInput("\x1b[1;5B");
      expect(test.app.scroll.scrollTop).toBe(1);
      test.terminal.sendInput("\x1b[1;5A");
      expect(test.app.scroll.scrollTop).toBe(0);
    } finally { bindings.setUserBindings(original); }
    const top = test.app.scroll.scrollTop;
    test.terminal.sendInput("\t");
    expect(test.app.scroll.scrollTop).toBe(top);
    expect(test.app.scroll.isFollowingEnd).toBe(false);
    test.terminal.sendInput("x");
    expect(test.app.editor.getText()).toBe("draftx");
    expect(test.app.editor.focused).toBe(true);
    test.terminal.sendInput("\x1b[1;5F");
    expect(test.app.scroll.isFollowingEnd).toBe(true);
  } finally { await test.close(); }
});

it("keeps search input separate from draft through refresh and restores Editor on Escape", async () => {
  const test = setup();
  try {
    test.terminal.sendInput("draft");
    test.app.conversation.addChild(new Text("searchable history\n".repeat(80), 0, 0));
    test.tui.requestImmediateRender();
    await test.terminal.flushAndGetViewport();
    test.terminal.sendInput("\x1b[102;6u");
    test.terminal.sendInput("history");
    test.app.update();
    expect(test.app.editor.getText()).toBe("draft");
    test.terminal.sendInput("\x1b");
    test.terminal.sendInput("x");
    expect(test.app.editor.getText()).toBe("draftx");
    expect(test.app.editor.focused).toBe(true);
  } finally { await test.close(); }
});

it("does not reserve an empty notice row when a model is configured", async () => {
  const test = setup();
  try {
    const state = test.store.getSnapshot();
    vi.spyOn(test.store, "getSnapshot").mockReturnValue({ ...state, core: { ...state.core, session: { ...state.core.session, model: makeModelSnapshot() } } });
    test.app.update();
    expect(test.app.notice.render(80)).toEqual([]);
    expect(test.app.header.render(200).join(" ")).not.toContain("Auto Decision:");
    expect(test.app.status.render(80)).toHaveLength(2);
  } finally { await test.close(); }
});

// describe 回调作用域内的 setup 遮蔽外层同名助手：本组固定两工具夹具，与外层审批夹具签名不同。
describe("审批 UX：到达自动展开，结束自动折叠，按决议追踪下一个工具或追底", () => {
  function setup(secondTool: boolean) {
    const core = new SessionController({
      driver: {
        execute: async (handle) => {
          await handle.requestApproval({
            toolCallId: "call-1",
            toolName: "bash",
            summary: { paths: [], command: "echo first" },
          });
          return { outcome: "completed" };
        },
      },
    });
    const store = new TuiStore(core, parseSettings({}));
    vi.spyOn(store, "items").mockImplementation(() => {
      const pending = core.getSnapshot().pendingApproval;
      const items = [
        {
          id: "fixture-tool-1",
          role: "tool",
          text: "bash",
          runId: "run-fixture",
          call: { id: "call-1", name: "bash", parse: { status: "parsed", arguments: { command: "echo first" } } },
          ...(pending ? { pendingApprovalId: pending.id } : {}),
        },
        ...(secondTool
          ? [
              {
                id: "fixture-tool-2",
                role: "tool",
                text: "bash",
                runId: "run-fixture",
                call: {
                  id: "call-2",
                  name: "bash",
                  parse: { status: "parsed", arguments: { command: "echo second" } },
                },
              },
            ]
          : []),
      ];
      return items as ReturnType<TuiStore["items"]>;
    });
    const terminal = new VirtualTerminal();
    const tui = new TuiAltScreen(terminal);
    const app = new TuiApp(store, tui);
    tui.start();
    return {
      core,
      store,
      terminal,
      tui,
      app,
      async close() {
        app.dispose();
        await store.dispose();
        tui.stop({ preserveScreen: true });
      },
    };
  }

  async function awaitApproval(test: ReturnType<typeof setup>) {
    await vi.waitFor(() => expect(test.store.getSnapshot().core.pendingApproval).not.toBeNull());
    await vi.waitFor(() => expect(test.store.getSnapshot().expanded.has("fixture-tool-1")).toBe(true));
    return test.store.getSnapshot().core.pendingApproval!.id;
  }

  it("collapses the approved card and reveals the next tool", async () => {
    const test = setup(true);
    const run = test.core.submitPrompt("approve");
    try {
      const id = await awaitApproval(test);
      const reveal = vi.spyOn(test.app.scroll, "reveal");
      test.core.resolveApproval(id, "once");
      await vi.waitFor(() => expect(reveal).toHaveBeenCalled());
      const target = reveal.mock.calls.at(-1)![0] as Component;
      expect(stripVTControlCharacters(target.render(80).join("\n"))).toContain("echo second");
      expect(test.store.getSnapshot().expanded.has("fixture-tool-1")).toBe(false);
    } finally {
      await test.close();
      await run;
    }
  });

  it("collapses a denied card and follows the end instead of tracking not-executed tools", async () => {
    const test = setup(true);
    const run = test.core.submitPrompt("approve");
    try {
      const id = await awaitApproval(test);
      test.core.resolveApproval(id, "deny");
      await vi.waitFor(() => expect(test.app.scroll.isFollowingEnd).toBe(true));
      expect(test.store.getSnapshot().expanded.has("fixture-tool-1")).toBe(false);
    } finally {
      await test.close();
      await run;
    }
  });

  it("follows the end when the approved tool was the last one", async () => {
    const test = setup(false);
    const run = test.core.submitPrompt("approve");
    try {
      const id = await awaitApproval(test);
      test.core.resolveApproval(id, "session");
      await vi.waitFor(() => expect(test.app.scroll.isFollowingEnd).toBe(true));
      expect(test.store.getSnapshot().expanded.has("fixture-tool-1")).toBe(false);
    } finally {
      await test.close();
      await run;
    }
  });

  it("keeps a card the user expanded before the approval arrived", async () => {
    const test = setup(true);
    test.store.toggle("fixture-tool-1");
    const run = test.core.submitPrompt("approve");
    try {
      const id = await awaitApproval(test);
      test.core.resolveApproval(id, "once");
      await vi.waitFor(() => expect(test.store.getSnapshot().core.pendingApproval).toBeNull());
      await vi.waitFor(() => expect(test.store.getSnapshot().lastResolvedApproval?.id).toBe(id));
      test.app.update();
      expect(test.store.getSnapshot().expanded.has("fixture-tool-1")).toBe(true);
    } finally {
      await test.close();
      await run;
    }
  });
});
