import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { bindExitSignals, createApplication, renderTui } from "../src/main.js";
import { bootstrap } from "../src/bootstrap.js";
import { SessionController } from "../src/core/session-controller.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { TuiStore } from "../src/tui/store.js";
import { parseSettings } from "../src/llm/settings-store.js";
import { VirtualTerminal } from "./tui/framework/virtual-terminal.js";
import { Text, ScrollView } from "../src/tui/framework/index.js";
import * as framework from "../src/tui/framework/index.js";

it("copies selected Unicode text through the native clipboard callback", async () => {
  const setText = vi.fn().mockResolvedValue(undefined);
  const clipboard = vi.spyOn(framework, "getNativeClipboard").mockReturnValue({
    getText: async () => null, getImage: async () => null, setText,
  });
  const core = new SessionController({ driver: { execute: async () => ({ outcome: "completed" }) } });
  const store = new TuiStore(core, parseSettings({}));
  const terminal = new VirtualTerminal();
  const view = renderTui(store, { terminal });
  try {
    view.tui.setLayoutRoot(new Text("中文 emoji 😀", 0, 0));
    view.tui.requestImmediateRender();
    await terminal.flushAndGetViewport();
    terminal.sendInput("\x1b[<0;1;1M");
    terminal.sendInput("\x1b[<32;5;1M");
    terminal.sendInput("\x1b[<0;5;1m");
    await vi.waitFor(() => expect(setText).toHaveBeenCalledWith("中文"));
  } finally { clipboard.mockRestore(); view.unmount(); await view.waitUntilExit(); }
});

it("wires wheel step, native return hint and Ctrl arrow line scrolling", async () => {
  const core = new SessionController({ driver: { execute: async () => ({ outcome: "completed" }) } });
  const store = new TuiStore(core, parseSettings({ mouseScrollLines: 4 }));
  const terminal = new VirtualTerminal();
  const view = renderTui(store, { terminal });
  try {
    const scroll = new ScrollView(new Text(Array.from({ length: 80 }, (_, i) => `row ${i}`).join("\n"), 0, 0), { follow: "end", primary: true });
    view.tui.setLayoutRoot(scroll);
    view.tui.requestImmediateRender();
    await terminal.flushAndGetViewport();
    const bottom = scroll.scrollTop;
    terminal.sendInput("\x1b[<64;2;3M");
    expect(scroll.scrollTop).toBe(bottom - 4);
    view.tui.requestImmediateRender();
    expect((await terminal.flushAndGetViewport()).join("\n")).toContain("Move to bottom");
    terminal.sendInput("\x1b[1;5A");
    expect(scroll.scrollTop).toBe(bottom - 5);
    terminal.sendInput("\x1b[1;5B");
    expect(scroll.scrollTop).toBe(bottom - 4);
  } finally { view.unmount(); await view.waitUntilExit(); }
});
describe("main application", () => {
  it("starts with no persisted Session and starts without a configured model or network call", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "shana-main-"));
    const result = bootstrap({ homeDir: root, cwd: root });
    const store = await createApplication(result);
    const terminal = new VirtualTerminal();
    const view = renderTui(store, { terminal });
    try {
      expect(store.getSnapshot().core.session.ref).toBeNull();
      expect(store.getSnapshot().core.session.model).toBeNull();
      view.tui.requestImmediateRender();
      expect((await terminal.flushAndGetViewport()).join("\n")).toContain("Shana");
      expect((await terminal.flushAndGetViewport()).join("\n")).toContain("model.json");
      store.setDraft("do something");
      await store.submit();
      expect(store.getSnapshot().core.status.kind).toBe("idle");
      expect(store.getSnapshot().draft).toBe("do something");
    } finally {
      view.unmount();
      await store.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("replays startup warnings to notice verbatim and in order (Task 0 baseline)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "shana-main-warn-"));
    // 触发 collectSettingsWarnings 的唯一告警：retained >= threshold。
    await fs.mkdir(path.join(root, ".shana"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".shana", "settings.json"),
      JSON.stringify({ compactionRetainedContextRatio: 0.9, compactionThresholdRatio: 0.8 }),
    );
    const result = bootstrap({ homeDir: root, cwd: root });
    // 种一个尾部半行截断的 Session：接管后经 listSessions 触发 tail_truncated。
    const sessions = new SessionStore({ sessionsDir: result.sessionsDir });
    const ref = { workspaceId: result.workspace.id, sessionId: "baseline-s1" };
    await sessions.createSession(ref);
    await sessions.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "one" });
    await sessions.appendRecord(ref, {
      type: "run_finished",
      runId: "run-1",
      outcome: "completed",
      persisted: true,
    });
    const messagesPath = path.join(result.sessionsDir, ref.workspaceId, ref.sessionId, "messages.jsonl");
    const raw = await fs.readFile(messagesPath, "utf8");
    await fs.writeFile(messagesPath, raw.slice(0, raw.length - 5));
    // 逐字捕获自重构前旧 createApplication() 路径的启动 notice（Task 0 基线）。
    const baseline =
      'settings.json: "compactionRetainedContextRatio" (0.9) >= "compactionThresholdRatio" (0.8)，尾部保留 cap 松于压缩阈值、几乎不生效';
    const truncatedNotice = `Session 尾部记录不完整，已读取完整前缀：末尾记录不完整（无换行终止符），已按前 1 条完整记录恢复；原始文件未修改: ${messagesPath}`;
    const notices: Array<{ text: string; error: boolean }> = [];
    const originalNotice = TuiStore.prototype.notice;
    const spy = vi.spyOn(TuiStore.prototype, "notice").mockImplementation(function (
      this: TuiStore,
      text: string,
      error = false,
    ) {
      notices.push({ text, error });
      return originalNotice.call(this, text, error);
    });
    let store: TuiStore | undefined;
    try {
      store = await createApplication(result);
      expect(notices).toEqual([{ text: baseline, error: false }]);
      expect(store.getSnapshot().notice?.text).toBe(baseline);
      // 接管后新告警直达 notice，文案映射（D3）逐字不变。
      notices.length = 0;
      await store.controller.listSessions();
      expect(notices).toEqual([{ text: truncatedNotice, error: false }]);
    } finally {
      spy.mockRestore();
      await store?.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

it("awaits managed signal cancellation and cleanup before notifying the host", async () => {
  let release!: () => void;
  let cleaning = false;
  const core = new SessionController({
    driver: {
      execute: async (handle) => {
        await handle.requestApproval({ toolCallId: "c", toolName: "bash" });
        return { outcome: "completed" };
      },
    },
    hooks: {
      closeSession: async () => {
        cleaning = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    },
  });
  const store = new TuiStore(core, parseSettings({}));
  const host = new EventEmitter();
  const closed = vi.fn();
  const unbind = bindExitSignals(store, closed, host);
  const run = core.submitPrompt("run");
  await vi.waitFor(() => expect(core.getSnapshot().pendingApproval).not.toBeNull());
  host.emit("SIGTERM");
  host.emit("SIGHUP");
  await vi.waitFor(() => expect(cleaning).toBe(true));
  expect(core.getSnapshot().pendingApproval).toBeNull();
  expect(closed).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  expect(await run).toBe("cancelled");
  unbind();
  expect(host.listenerCount("SIGTERM")).toBe(0);
  await store.dispose();
});

it("awaits controller cleanup before stopping the terminal and closes only once", async () => {
  let release!: () => void;
  const controller = new SessionController({
    driver: { execute: async () => ({ outcome: "completed" }) },
    hooks: {
      closeSession: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    },
  });
  const store = new TuiStore(controller, parseSettings({}));
  const terminal = new VirtualTerminal();
  const stop = vi.spyOn(terminal, "stop");
  const runtime = renderTui(store, { terminal });
  const closing = runtime.unmount();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(stop).not.toHaveBeenCalled();
  expect(runtime.unmount()).toBe(closing);
  release();
  await closing;
  await runtime.waitUntilExit();
  expect(stop).toHaveBeenCalledOnce();
});
it("routes a render failure through controller cleanup without dumping content", async () => {
  const controller = new SessionController({ driver: { execute: async () => ({ outcome: "completed" }) } });
  const store = new TuiStore(controller, parseSettings({}));
  const terminal = new VirtualTerminal();
  const runtime = renderTui(store, { terminal });
  const failure = new Error("render failed");
  const outcome = runtime.waitUntilExit();
  runtime.tui.setLayoutRoot({render:()=>{throw failure;},invalidate:()=>{}});
  runtime.tui.requestImmediateRender();
  await expect(outcome).rejects.toBe(failure);
  expect(controller.getSnapshot().status.kind).toBe("idle");
});

it("settles exit when terminal stop throws", async () => {
  const core = new SessionController({ driver: { execute: async () => ({ outcome: "completed" }) } });
  const store = new TuiStore(core, parseSettings({}));
  const terminal = new VirtualTerminal();
  const runtime = renderTui(store, { terminal });
  const failure = new Error("terminal stop failed");
  vi.spyOn(terminal, "stop").mockImplementation(() => { throw failure; });
  const outcome = runtime.waitUntilExit().catch(error => error);
  await expect(runtime.unmount()).resolves.toBeUndefined();
  expect(await outcome).toBe(failure);
});
