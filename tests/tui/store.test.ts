import { describe, expect, it, vi } from "vitest";
import { SessionController, type CompactionDriver } from "../../src/core/session-controller.js";
import type { CompactionOutcome } from "../../src/sessions/compaction-store.js";
import { parseSettings } from "../../src/llm/settings-store.js";
import { TuiStore } from "../../src/tui/store.js";
import {
  INTERRUPTED_RESPONSE_ANNOTATION,
  CANCELLED_REQUEST_ANNOTATION,
  FAILED_REQUEST_ANNOTATION,
  UNKNOWN_RESULT_ANNOTATION,
} from "../../src/core/context-builder.js";
import { UnknownSideEffectsError } from "../../src/sessions/recovery.js";
import type { SessionRecord } from "../../src/sessions/records.js";
import { makeAssistantMessage } from "../sessions/helpers.js";

it("isolates result and Diff expansion and resets only the collapsed tool preview", async () => {
  const store = new TuiStore(controller(async () => ({ outcome: "completed" })), parseSettings({}));
  try {
    store.toggle("tool-a"); store.toggle("tool-b");
    store.toggleResult("tool-a"); store.toggleResult("tool-b");
    store.toggleResult("tool-a");
    expect(store.getSnapshot().expandedResults.has("tool-a")).toBe(false);
    store.toggleResult("tool-a");
    store.toggleDiff("diff-a"); store.toggleDiff("diff-b");
    store.toggle("tool-a");
    expect([...store.getSnapshot().expandedResults]).toEqual(["tool-b"]);
    store.toggle("tool-a");
    expect(store.getSnapshot().expandedResults.has("tool-a")).toBe(false);
    store.toggleDiff("diff-a");
    expect([...store.getSnapshot().expandedDiffs]).toEqual(["diff-b"]);
  } finally { await store.dispose(); }
});

it("cycles exactly three approval decisions and resolves only after confirmation", async () => {
  let decision: string | undefined;
  const core = controller(async (handle) => {
    decision = await handle.requestApproval({ toolCallId: "c", toolName: "write" });
    return { outcome: "completed" };
  });
  const store = new TuiStore(core, parseSettings({}));
  store.setDraft("run");
  const run = store.submit();
  try {
    await vi.waitFor(() => expect(store.getSnapshot().modal?.kind).toBe("approval"));
    store.moveModal(-1);
    expect(store.getSnapshot().modal).toMatchObject({ selection: 2 });
    store.moveModal(2);
    expect(store.getSnapshot().modal).toMatchObject({ selection: 1 });
    expect(decision).toBeUndefined();
    await store.confirmModal();
    await run;
    expect(decision).toBe("session");
  } finally {
    store.dismissModal();
    await run;
    await store.dispose();
  }
});

function controller(
  execute: ConstructorParameters<typeof SessionController>[0]["driver"]["execute"],
  compactor?: ConstructorParameters<typeof SessionController>[0]["compactor"],
) {
  return new SessionController({
    driver: { execute },
    compactor,
    commands: {
      readHistory: async () => ({
        meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
        records: [],
        warnings: [],
        fromRecordSeq: 1,
      }),
    },
    hooks: {
      getSessionView: () => ({
        ref: { workspaceId: "ws", sessionId: "s" },
        model: {
          providerId: "p",
          providerName: "p",
          modelId: "m",
          modelName: "m",
          thinking: false,
          reasoningEffort: "high",
          input: ["text"],
          contextWindow: 10000,
          maxTokens: 1000,
        },
        models: [],
        runModel: null,
        contextBaselineTokens: null,
        autoDecision: { enabled: true, availability: "missing" },
      }),
    },
  });
}
describe("TuiStore", () => {
  it("keeps drafts typed during a Run and never submits them automatically", async () => {
    let finish!: (value: { outcome: "completed" }) => void;
    let requests = 0;
    const core = controller(async () => {
      requests++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const store = new TuiStore(core, parseSettings({}));
    store.setDraft("first");
    const run = store.submit();
    store.setDraft("draft during run");
    await store.submit();
    expect(requests).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests).toBe(1);
    finish({ outcome: "completed" });
    await run;
    expect(store.getSnapshot().draft).toBe("draft during run");
    expect(requests).toBe(1);
    await store.dispose();
  });
  it("lists /quit as an /exit alias and confirms exit when idle", async () => {
    const onExit = vi.fn();
    const store = new TuiStore(
      controller(async () => ({ outcome: "completed" })),
      parseSettings({}),
      {
        onExit,
      },
    );
    store.setDraft("/q");
    expect(store.commandOptions()).toMatchObject([{ name: "/quit", enabled: true }]);
    store.setDraft("/quit");
    await store.submit();
    expect(store.getSnapshot().modal).toBeNull();
    store.moveModal(-1);
    await store.confirmModal();
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith());
    await store.dispose();
  });
  it("exits through /quit during a Run without a confirmation dialog", async () => {
    let finish!: (value: { outcome: "completed" }) => void;
    const core = controller(async () => {
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const onExit = vi.fn();
    const store = new TuiStore(core, parseSettings({}), { onExit });
    store.setDraft("run");
    const run = store.submit();
    await vi.waitFor(() => expect(store.getSnapshot().core.status.kind).toBe("running"));
    store.setDraft("/quit");
    await store.submit();
    expect(store.getSnapshot().modal).toBeNull();
    finish({ outcome: "completed" });
    await run;
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith());
    await store.dispose();
  });
});

it("receives a delayed streaming delta before the Run ends without a polling timer", async () => {
  let emit!: () => void;
  let finish!: (value: { outcome: "completed" }) => void;
  const core = controller(async (handle) => {
    emit = () => handle.streamText("live text");
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const store = new TuiStore(core, parseSettings({}));
  store.setDraft("run");
  const run = store.submit();
  await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
  await new Promise((resolve) => setImmediate(resolve));
  emit();
  await vi.waitFor(() => expect(store.getSnapshot().core.accumulatedText).toBe("live text"));
  finish({ outcome: "completed" });
  await run;
  await store.dispose();
});

it("sanitizes CRLF, tabs, control characters and ANSI in drafts and pastes", async () => {
  const store = new TuiStore(
    controller(async () => ({ outcome: "completed" })),
    parseSettings({}),
  );
  try {
    store.setDraft("a\r\nb\tc\u0007\u001b[31mred\u001b[0m");
    expect(store.getSnapshot().draft).toBe("a\nb    cred");
    store.setDraft("x\ty\u2028z");
    expect(store.getSnapshot().draft).toBe("x    y\nz");
  } finally {
    await store.dispose();
  }
});

it("requires explicit unknown-side-effect acknowledgement and never submits on Esc", async () => {
  let acknowledged = false;
  let calls = 0;
  const core = controller(async () => {
    calls++;
    return { outcome: "completed" };
  });
  const original = core.submitPrompt.bind(core);
  vi.spyOn(core, "submitPrompt").mockImplementation((prompt) => {
    if (!acknowledged) throw new UnknownSideEffectsError([]);
    return original(prompt);
  });
  const store = new TuiStore(core, parseSettings({}));
  store.setUnknownAcknowledgement(() => {
    acknowledged = true;
  });
  store.setDraft("continue");
  await store.submit();
  expect(store.getSnapshot().modal?.kind).toBe("confirm");
  store.dismissModal();
  expect(calls).toBe(0);
  await store.submit();
  store.moveModal(-1);
  await store.confirmModal();
  expect(calls).toBe(1);
  expect(acknowledged).toBe(true);
  await store.dispose();
});

it("awaits cleanup on exit and redacts notices without rewriting drafts", async () => {
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const core = new SessionController({
    driver: { execute: async () => ({ outcome: "completed" }) },
    hooks: { closeSession: () => closed },
  });
  const exited = vi.fn();
  const store = new TuiStore(core, parseSettings({}), {
    onExit: exited,
    redact: (text) => text.replaceAll("SECRET", "[REDACTED]"),
  });
  store.notice("failure SECRET", true);
  store.setDraft("SECRET");
  store.requestExit();
  store.moveModal(-1);
  const exit = store.dispose();
  await Promise.resolve();
  expect(exited).not.toHaveBeenCalled();
  finish();
  await exit;
  expect(exited).toHaveBeenCalledOnce();
  expect(store.getSnapshot().notice?.text).toBe("failure [REDACTED]");
  expect(store.getSnapshot().draft).toBe("SECRET");
});

it("restores a failed prompt only on explicit input and requires another submit", async () => {
  const core = controller(async () => ({ outcome: "failed", error: new Error("provider failed") }));
  const store = new TuiStore(core, parseSettings({}));
  store.setDraft("original prompt");
  await store.submit();
  expect(store.getSnapshot().draft).toBe("");
  expect(store.getSnapshot().retryPrompt).toBe("original prompt");
  await store.submit();
  expect(store.getSnapshot().draft).toBe("original prompt");
  expect(core.getSnapshot().status.kind).toBe("idle");
  await store.dispose();
});

it("reports cleanup failure to the host instead of leaving the UI waiting forever", async () => {
  const failure = new Error("cleanup failed");
  const core = new SessionController({
    driver: { execute: async () => ({ outcome: "completed" }) },
    hooks: {
      closeSession: async () => {
        throw failure;
      },
    },
  });
  const exited = vi.fn();
  const store = new TuiStore(core, parseSettings({}), { onExit: exited });
  store.requestExit();
  store.moveModal(-1);
  await store.confirmModal();
  await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(failure));
});

it("suggests continuing after a failed Run with a complete Turn", async () => {
  const records: SessionRecord[] = [];
  const core = controller(async (handle) => {
    records.push(
      { type: "user_prompt", recordSeq: 1, ts: "now", runId: handle.runId, text: handle.prompt },
      {
        type: "assistant_message",
        recordSeq: 2,
        ts: "now",
        runId: handle.runId,
        message: makeAssistantMessage([], "complete Turn"),
      },
    );
    return { outcome: "failed", error: new Error("later Turn failed") };
  });
  vi.spyOn(core, "readHistory").mockImplementation(async () => ({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records: [...records],
    warnings: [],
    fromRecordSeq: 1,
  }));
  const store = new TuiStore(core, parseSettings({}));
  store.setDraft("original");
  await store.submit();
  expect(store.getSnapshot().retryPrompt).toBe("继续完成之前的任务");
  await store.submit();
  expect(store.getSnapshot().draft).toBe("继续完成之前的任务");
  await store.dispose();
});

it("coalesces high frequency updates without awaiting a slow subscriber and can remount from a snapshot", async () => {
  let finishPainting!: () => void;
  const painting = new Promise<void>((resolve) => {
    finishPainting = resolve;
  });
  const jobs: Promise<void>[] = [];
  const core = controller(async (handle) => {
    handle.beginAttempt(1, 1);
    for (let index = 0; index < 1500; index++) handle.streamText("x");
    return { outcome: "completed" };
  });
  const store = new TuiStore(core, parseSettings({}));
  let renders = 0;
  store.subscribe(() => {
    renders++;
    jobs.push(painting);
  });
  store.setDraft("run");
  await store.submit();
  await new Promise((resolve) => setImmediate(resolve));
  expect(core.getSnapshot().lastRun?.outcome).toBe("completed");
  expect(renders).toBeLessThan(10);
  const remounted = new TuiStore(core, parseSettings({}));
  expect(remounted.getSnapshot().core.accumulatedText).toBe("x".repeat(1500));
  finishPainting();
  await Promise.all(jobs);
  await store.dispose();
  await remounted.dispose();
});

it("does not restore a Session when its chooser or confirmation is dismissed", async () => {
  const core = controller(async () => ({ outcome: "completed" }));
  vi.spyOn(core, "listSessions").mockResolvedValue([
    { version: 4, workspaceId: "ws", sessionId: "old", createdAt: "now", runCount: 1 },
  ]);
  const resume = vi.spyOn(core, "resumeSession").mockResolvedValue();
  const store = new TuiStore(core, parseSettings({}));
  store.setDraft("/resume");
  await store.submit();
  store.dismissModal();
  expect(resume).not.toHaveBeenCalled();
  store.setDraft("/resume");
  await store.submit();
  store.dismissModal();
  expect(resume).not.toHaveBeenCalled();
  store.setDraft("/resume");
  await store.submit();
  await store.confirmModal();
  store.moveModal(-1);
  await store.confirmModal();
  expect(resume).toHaveBeenCalledWith({ workspaceId: "ws", sessionId: "old" });
  await store.dispose();
});

it("clears the previous retry suggestion when adopting a new Session", async () => {
  let sessionId = "s";
  const core = controller(async () => ({ outcome: "failed", error: new Error("failure") }));
  const snapshot = core.getSnapshot.bind(core);
  vi.spyOn(core, "getSnapshot").mockImplementation(() => {
    const value = snapshot();
    value.session.ref!.sessionId = sessionId;
    return value;
  });
  vi.spyOn(core, "newSession").mockImplementation(async () => {
    sessionId = "new";
  });
  vi.spyOn(core, "readHistory").mockImplementation(async () => ({
    meta: { version: 4, workspaceId: "ws", sessionId, createdAt: "now" },
    records: [],
    warnings: [],
    fromRecordSeq: 1,
  }));
  const store = new TuiStore(core, parseSettings({}));
  store.setDraft("original");
  await store.submit();
  expect(store.getSnapshot().retryPrompt).toBe("original");
  store.setDraft("/new");
  await store.submit();
  await vi.waitFor(() => expect(store.getSnapshot().history?.meta.sessionId).toBe("new"));
  expect(store.getSnapshot().retryPrompt).toBeNull();
  await store.dispose();
});

it("loads the durable prompt while the first response is still pending", async () => {
  const records: SessionRecord[] = [];
  let finish!: (value: { outcome: "completed" }) => void;
  const core = controller(async (handle) => {
    records.push({ type: "user_prompt", recordSeq: 1, ts: "now", runId: handle.runId, text: handle.prompt });
    handle.beginAttempt(1, 1);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  vi.spyOn(core, "readHistory").mockImplementation(async () => ({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records: [...records],
    warnings: [],
    fromRecordSeq: 1,
  }));
  const store = new TuiStore(core, parseSettings({}));
  await vi.waitFor(() => expect(store.getSnapshot().history).not.toBeNull());
  store.setDraft("durable prompt");
  const run = store.submit();
  try {
    await vi.waitFor(() =>
      expect(store.items().some((item) => item.role === "user" && item.text === "durable prompt")).toBe(true),
    );
  } finally {
    finish({ outcome: "completed" });
    await run;
    await store.dispose();
  }
});

it("replaces temporary notices and keeps the latest until an ordinary Run starts", async () => {
  const core = controller(async () => ({ outcome: "completed" }));
  const store = new TuiStore(core, parseSettings({}));
  store.notice("first error", true);
  store.notice("latest error", true);
  expect(store.getSnapshot().notice?.text).toBe("latest error");
  expect(store.items().some((item) => item.text.includes("latest error"))).toBe(false);
  store.setDraft("/effort");
  await store.submit();
  expect(store.getSnapshot().modal).toMatchObject({ kind: "models", effortOnly: true });
  expect(store.getSnapshot().notice?.text).toBe("latest error");
  store.dismissModal();
  store.setDraft("ordinary");
  await store.submit();
  expect(store.getSnapshot().notice).toBeNull();
  await store.dispose();
});

it("clears the temporary notice after /new resets the Session", async () => {
  const core = controller(async () => ({ outcome: "completed" }));
  vi.spyOn(core, "newSession").mockResolvedValue();
  const store = new TuiStore(core, parseSettings({}));
  store.notice("previous failure", true);
  store.setDraft("/new");
  await store.submit();
  expect(store.getSnapshot().notice).toBeNull();
  await store.dispose();
});

it("clears the temporary notice after /resume restores another Session", async () => {
  const core = controller(async () => ({ outcome: "completed" }));
  vi.spyOn(core, "listSessions").mockResolvedValue([
    { version: 4, workspaceId: "ws", sessionId: "old", createdAt: "now", runCount: 1 },
  ]);
  vi.spyOn(core, "resumeSession").mockResolvedValue();
  const store = new TuiStore(core, parseSettings({}));
  store.notice("previous failure", true);
  store.setDraft("/resume");
  await store.submit();
  await store.confirmModal();
  store.moveModal(-1);
  await store.confirmModal();
  expect(store.getSnapshot().notice).toBeNull();
  await store.dispose();
});
it("permits /effort during a Run without submitting another Prompt", async () => {
  let finish!: (value: { outcome: "completed" }) => void;
  const core = controller(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const save = vi.spyOn(core, "setReasoningEffort").mockResolvedValue();
  const store = new TuiStore(core, parseSettings({}));
  store.setDraft("work");
  const run = store.submit();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  store.setDraft("/effort");
  await store.submit();
  expect(store.getSnapshot().modal).toMatchObject({ kind: "models", effortOnly: true });
  await store.confirmModal();
  expect(save).toHaveBeenCalledWith("high");
  finish({ outcome: "completed" });
  await run;
  await store.dispose();
});

it("does not revive a dismissed history warning on subsequent refreshes", async () => {
  const core = controller(async () => ({ outcome: "completed" }));
  vi.spyOn(core, "readHistory").mockResolvedValue({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records: [],
    warnings: [{ kind: "tail_truncated", line: 1, byteOffset: 1, message: "old warning" }],
    fromRecordSeq: 1,
  });
  const store = new TuiStore(core, parseSettings({}));
  await store.refreshHistory();
  expect(store.getSnapshot().notice?.text).toBe("old warning");
  store.setDraft("ordinary");
  await store.submit();
  await store.refreshHistory();
  expect(store.getSnapshot().notice).toBeNull();
  await store.dispose();
});

it("retains failure audit records while omitting their detailed system error from visible history", async () => {
  const core = controller(async () => ({ outcome: "completed" }));
  const records: SessionRecord[] = [
    {
      type: "run_finished",
      recordSeq: 1,
      ts: "now",
      runId: "r",
      outcome: "failed",
      persisted: true,
      error: "provider detail",
    },
  ];
  vi.spyOn(core, "readHistory").mockResolvedValue({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records,
    warnings: [],
    fromRecordSeq: 1,
  });
  const store = new TuiStore(core, parseSettings({}));
  await store.refreshHistory();
  expect(store.items().some((item) => item.text.includes("provider detail"))).toBe(false);
  expect(store.items().some((item) => item.role === "failure")).toBe(true);
  expect(store.getSnapshot().history?.records[0]).toMatchObject({ error: "provider detail" });
  await store.dispose();
});

it("preserves a notice when an unknown-side-effect gate rejects the next Prompt", async () => {
  const core = controller(async () => ({ outcome: "completed" }));
  vi.spyOn(core, "submitPrompt").mockImplementation(() => {
    throw new UnknownSideEffectsError([]);
  });
  const store = new TuiStore(core, parseSettings({}));
  store.notice("previous issue", true);
  store.setDraft("next");
  await store.submit();
  expect(store.getSnapshot().notice?.text).toBe("previous issue");
  expect(store.getSnapshot().modal).toMatchObject({ purpose: "unknown" });
  store.dismissModal();
  expect(store.getSnapshot().notice?.text).toBe("previous issue");
  await store.dispose();
});

it("keeps /effort out of a pending approval", async () => {
  const core = controller(async (handle) => {
    await handle.requestApproval({ toolCallId: "c", toolName: "bash" });
    return { outcome: "completed" };
  });
  const store = new TuiStore(core, parseSettings({}));

  store.setDraft("run");
  const run = store.submit();
  await vi.waitFor(() => expect(store.getSnapshot().modal?.kind).toBe("approval"));
  store.setDraft("/effort");
  await store.submit();
  expect(store.getSnapshot().modal?.kind).toBe("approval");
  store.dismissModal();
  await run;
  await store.dispose();
});

it("does not reset a replacement approval when an earlier effort save completes", async () => {
  let requestApproval!: () => Promise<void>;
  let decision: string | undefined;
  let releaseSave!: () => void;
  const core = controller(
    async (handle) =>
      new Promise((resolve) => {
        requestApproval = async () => {
          decision = await handle.requestApproval({ toolCallId: "c", toolName: "bash" });
          resolve({ outcome: "completed" });
        };
      }),
  );
  vi.spyOn(core, "setReasoningEffort").mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseSave = resolve;
      }),
  );
  const store = new TuiStore(core, parseSettings({}));
  store.setDraft("run");
  const run = store.submit();
  await vi.waitFor(() => expect(requestApproval).toBeTypeOf("function"));
  store.setDraft("/effort");
  await store.submit();
  const saving = store.confirmModal();
  const approval = requestApproval();
  await vi.waitFor(() => expect(store.getSnapshot().modal?.kind).toBe("approval"));
  store.moveModal(2);
  releaseSave();
  await saving;
  expect(store.getSnapshot().modal).toMatchObject({ kind: "approval", selection: 2 });
  await store.confirmModal();
  await approval;
  await run;
  expect(decision).toBe("deny");
  await store.dispose();
});

it("hands completed thinking state to history and places one duration after failed attempts", async () => {
  const records: SessionRecord[] = [];
  const core = controller(async (handle) => {
    handle.beginAttempt(1, 1);
    handle.streamThinking("failed");
    handle.finishAttempt("failed");
    handle.beginAttempt(1, 2);
    handle.streamThinking("reason");
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    handle.finishAttempt("completed");
    records.push({
      type: "assistant_message",
      recordSeq: 1,
      ts: new Date().toISOString(),
      runId: handle.runId,
      message: makeAssistantMessage([]),
    });
    return { outcome: "completed" };
  });
  let release!: () => void;
  vi.spyOn(core, "readHistory").mockImplementation(async () => ({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records: [...records],
    warnings: [],
    fromRecordSeq: 1,
  }));
  const store = new TuiStore(core, parseSettings({}));
  try {
    const run = core.submitPrompt("hi");
    await vi.waitFor(() => expect(store.items().filter((i) => i.role === "attempt")).toHaveLength(2));
    const id = store.items().find((i) => i.thinking === "reason")!.id;
    expect(id).toBe("attempt-run-1-1-2");
    store.toggle(id);
    release();
    await run;
    await store.refreshHistory();
    await vi.waitFor(() => expect(store.getSnapshot().expanded.has("assistant-1")).toBe(true));
    await vi.waitFor(() => expect(store.getSnapshot().core.status.kind).toBe("idle"));
    let items = store.items();
    expect(items.at(-1)?.role).toBe("duration");
    expect(items.filter((i) => i.role === "duration")).toHaveLength(1);
    const last = core.getSnapshot().lastRun!;
    records.push({
      type: "run_finished",
      recordSeq: 2,
      ts: new Date().toISOString(),
      runId: last.runId,
      outcome: last.outcome,
      persisted: true,
      elapsedMs: last.elapsedMs,
    });
    await store.refreshHistory();
    items = store.items();
    expect(items.at(-1)?.role).toBe("duration");
    expect(items.filter((i) => i.role === "duration")).toHaveLength(1);
    expect(items.findIndex((i) => i.thinking === "failed")).toBeLessThan(items.length - 1);
  } finally {
    release?.();
    await store.dispose();
  }
});

it("does not clear live expansion when initial history arrives late", async () => {
  let finish!: () => void;
  const core = controller(async (handle) => {
    handle.beginAttempt(1, 1);
    handle.streamThinking("reason");
    await new Promise<void>((r) => {
      finish = r;
    });
    return { outcome: "completed" };
  });
  let load!: () => void;
  const first = new Promise<void>((r) => {
    load = r;
  });
  vi.spyOn(core, "readHistory").mockImplementation(async () => {
    await first;
    return {
      meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
      records: [],
      warnings: [],
      fromRecordSeq: 1,
    };
  });
  const store = new TuiStore(core, parseSettings({}));
  const run = core.submitPrompt("hi");
  try {
    await vi.waitFor(() => expect(store.items().some((i) => i.thinking === "reason")).toBe(true));
    const id = store.items().find((i) => i.thinking === "reason")!.id;
    store.toggle(id);
    expect(store.getSnapshot().expanded.has(id)).toBe(true);
    load();
    await store.refreshHistory();
    expect(store.getSnapshot().expanded.has(id)).toBe(true);
  } finally {
    load();
    finish();
    await run;
    await store.dispose();
  }
});

it("hands off the previous Run even if the next Run starts before history arrives", async () => {
  const records: SessionRecord[] = [];
  let finish!: () => void;
  const core = controller(async (handle) => {
    handle.beginAttempt(1, 1);
    handle.streamThinking("reason");
    await new Promise<void>((r) => {
      finish = r;
    });
    handle.finishAttempt("completed");
    records.push({
      type: "assistant_message",
      recordSeq: records.length + 1,
      ts: new Date().toISOString(),
      runId: handle.runId,
      message: makeAssistantMessage([]),
    });
    return { outcome: "completed" };
  });
  let release!: () => void;
  const historyGate = new Promise<void>((r) => {
    release = r;
  });
  vi.spyOn(core, "readHistory").mockImplementation(async () => {
    if (records.length) await historyGate;
    return {
      meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
      records: [...records],
      warnings: [],
      fromRecordSeq: 1,
    };
  });
  const store = new TuiStore(core, parseSettings({}));
  await store.refreshHistory();
  const first = core.submitPrompt("first");
  let second: Promise<unknown> | undefined;
  try {
    await vi.waitFor(() => expect(store.items().some((i) => i.role === "attempt")).toBe(true));
    const id = store.items().find((i) => i.role === "attempt")!.id;
    store.toggle(id);
    finish();
    await first;
    second = core.submitPrompt("second");
    await vi.waitFor(() => expect(store.getSnapshot().core.status).toMatchObject({ runId: "run-2" }));
    release();
    await store.refreshHistory();
    expect(store.getSnapshot().expanded.has("assistant-1")).toBe(true);
    expect(store.getSnapshot().expanded.has("attempt-run-2-1-1")).toBe(false);
  } finally {
    release();
    finish();
    await second;
    await store.dispose();
  }
});

it("clears history and expansion on reset to an unmaterialized Session", async () => {
  let ref: { workspaceId: string; sessionId: string } | null = { workspaceId: "ws", sessionId: "s" };
  const core = new SessionController({
    driver: { execute: async () => ({ outcome: "completed" }) },
    hooks: {
      getSessionView: () => ({
        ref,
        title: ref ? "title" : null,
        model: null,
        models: [],
        runModel: null,
        contextBaselineTokens: null,
        autoDecision: { enabled: true, availability: "missing" },
      }),
    },
    commands: {
      newSession: async () => {
        ref = null;
      },
      readHistory: async () => ({
        meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
        records: [{ type: "user_prompt", recordSeq: 1, ts: "now", runId: "r", text: "old prompt" }],
        warnings: [],
        fromRecordSeq: 1,
      }),
    },
  });
  const store = new TuiStore(core, parseSettings({}));
  await store.refreshHistory();
  store.toggle("prompt-1");
  await core.newSession();
  await new Promise((resolve) => setImmediate(resolve));
  expect(store.items()).toEqual([]);
  expect(store.getSnapshot().expanded.size).toBe(0);
  await store.dispose();
});

it("does not mark the in-flight turn as excluded while its tool awaits a result", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const message = makeAssistantMessage([{ id: "c", name: "read", arguments: { path: "x" } }], "", {
    stopReason: "toolUse",
  });
  message.content.unshift({ type: "thinking", thinking: "read the file first" });
  const core = controller(async () => {
    await gate;
    return { outcome: "completed" };
  });
  vi.spyOn(core, "readHistory").mockImplementation(async () => {
    const snapshot = core.getSnapshot();
    const runId =
      snapshot.status.kind === "running" ? snapshot.status.runId : (snapshot.lastRun?.runId ?? "r");
    return {
      meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
      records: [{ type: "assistant_message", recordSeq: 1, ts: "now", runId, message }],
      warnings: [],
      fromRecordSeq: 1,
    };
  });
  const store = new TuiStore(core, parseSettings({}));
  const run = core.submitPrompt("task");
  try {
    await vi.waitFor(() => expect(store.getSnapshot().core.status.kind).toBe("running"));
    await store.refreshHistory();
    await vi.waitFor(() => expect(store.getSnapshot().history?.records.length).toBe(1));
    const items = store.items();
    expect(items.find((item) => item.role === "assistant")).toMatchObject({ failed: false });
    expect(items.some((item) => item.role === "failure")).toBe(false);
    release();
    await run;
    await vi.waitFor(() => expect(store.getSnapshot().core.status.kind).toBe("idle"));
    // 缺结果 Turn 受控进入上下文（合成 unknown 占位），idle 后也不再标 failure。
    expect(store.items().some((item) => item.role === "failure")).toBe(false);
  } finally {
    release();
    await store.dispose();
  }
});

it("reuses the conversation item list while only the draft and cursor change", async () => {
  const store = new TuiStore(
    controller(async () => ({ outcome: "completed" })),
    parseSettings({}),
  );
  try {
    const before = store.items();
    store.setDraft("hello");
    store.setDraft(store.getSnapshot().draft + "!");
    expect(store.items()).toBe(before);
  } finally {
    await store.dispose();
  }
});

it("places a failed retry before its own Turn rather than after later Turn tools", async () => {
  const records: SessionRecord[] = [];
  let finish!: () => void;
  const core = controller(async (handle) => {
    handle.beginAttempt(1, 1);
    handle.streamThinking("failed first attempt");
    handle.finishAttempt("failed");
    handle.beginAttempt(1, 2);
    handle.finishAttempt("completed");
    records.push({
      type: "assistant_message",
      recordSeq: 1,
      ts: "now",
      runId: handle.runId,
      message: makeAssistantMessage([], "first Turn"),
    });
    handle.beginAttempt(2, 1);
    handle.streamThinking("second Turn");
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { outcome: "completed" };
  });
  vi.spyOn(core, "readHistory").mockImplementation(async () => ({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records,
    warnings: [],
    fromRecordSeq: 1,
  }));
  const store = new TuiStore(core, parseSettings({}));
  const run = core.submitPrompt("task");
  try {
    await vi.waitFor(() => expect(store.items().some((i) => i.thinking === "second Turn")).toBe(true));
    await store.refreshHistory();
    const items = store.items();
    expect(items.findIndex((i) => i.thinking === "failed first attempt")).toBeLessThan(
      items.findIndex((i) => i.text === "first Turn"),
    );
  } finally {
    finish();
    await run;
    await store.dispose();
  }
});

it("keeps cancelled partial as a persisted aborted Turn with retry failures and cancel marker", async () => {
  const records: SessionRecord[] = [];
  const core = controller(async (handle, signal) => {
    handle.beginAttempt(1, 1);
    handle.streamText("retry fragment");
    handle.finishAttempt("failed");
    handle.beginAttempt(1, 2);
    handle.streamText("partial answer");
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    handle.finishAttempt("cancelled");
    return { outcome: "completed" };
  });
  vi.spyOn(core, "readHistory").mockImplementation(async () => ({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records: [...records],
    warnings: [],
    fromRecordSeq: 1,
  }));
  const store = new TuiStore(core, parseSettings({}));
  store.setDraft("task");
  const run = store.submit();
  try {
    await vi.waitFor(() => expect(store.items().some((item) => item.text === "partial answer")).toBe(true));
    store.cancel();
    await run;
    await vi.waitFor(() => expect(store.getSnapshot().core.status.kind).toBe("idle"));
    const last = core.getSnapshot().lastRun!;
    // 真实流程会把半截响应落盘为 aborted Turn；此处模拟该持久化结果。
    records.push({
      type: "assistant_message",
      recordSeq: 1,
      ts: "now",
      runId: last.runId,
      message: makeAssistantMessage([], "partial answer", { stopReason: "aborted" }),
    });
    records.push({
      type: "run_finished",
      recordSeq: 2,
      ts: "now",
      runId: last.runId,
      outcome: last.outcome,
      elapsedMs: last.elapsedMs,
      persisted: true,
    });
    await store.refreshHistory();
    const items = store.items();
    // 半截响应保留为持久化 aborted 项（cancelled streaming attempt 去重，不重复）。
    const partials = items.filter((item) => item.text === "partial answer");
    expect(partials).toHaveLength(1);
    expect(partials[0]).toMatchObject({ role: "assistant", cancelled: true });
    expect(items.some((item) => item.text === INTERRUPTED_RESPONSE_ANNOTATION)).toBe(true);
    expect(items.find((item) => item.text === "retry fragment")).toMatchObject({ failed: true });
    expect(items.filter((item) => item.text === "✗ 已取消")).toHaveLength(1);
    expect(items.find((item) => item.text === "✗ 已取消")).toMatchObject({ cancelled: true });
  } finally {
    await store.dispose();
  }
});

it("hides thinking of a persisted aborted Turn but keeps completed Turn thinking", async () => {
  const core = controller(async () => ({ outcome: "completed" }));
  const aborted = makeAssistantMessage([], "partial answer", { stopReason: "aborted" });
  aborted.content.unshift({ type: "thinking", thinking: "legacy draft" });
  const completed = makeAssistantMessage([], "final answer");
  completed.content.unshift({ type: "thinking", thinking: "kept draft" });
  vi.spyOn(core, "readHistory").mockResolvedValue({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records: [
      { type: "user_prompt", recordSeq: 1, ts: "now", runId: "r1", text: "task" },
      { type: "assistant_message", recordSeq: 2, ts: "now", runId: "r1", message: aborted },
      { type: "run_finished", recordSeq: 3, ts: "now", runId: "r1", outcome: "cancelled", persisted: true },
      { type: "user_prompt", recordSeq: 4, ts: "now", runId: "r2", text: "again" },
      { type: "assistant_message", recordSeq: 5, ts: "now", runId: "r2", message: completed },
      { type: "run_finished", recordSeq: 6, ts: "now", runId: "r2", outcome: "completed", persisted: true },
    ],
    warnings: [],
    fromRecordSeq: 1,
  });
  const store = new TuiStore(core, parseSettings({}));
  try {
    await store.refreshHistory();
    const items = store.items();
    const partial = items.find((i) => i.text === "partial answer");
    expect(partial).toMatchObject({ role: "assistant", cancelled: true });
    expect(partial?.thinking ?? "").toBe("");
    expect(JSON.stringify(items)).not.toContain("legacy draft");
    expect(items.find((i) => i.text === "final answer")?.thinking).toBe("kept draft");
  } finally {
    await store.dispose();
  }
});

it("drops a thinking-only cancelled attempt instead of showing it", async () => {
  const core = controller(async (handle, signal) => {
    handle.beginAttempt(1, 1);
    handle.streamThinking("half thought");
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    handle.finishAttempt("cancelled");
    return { outcome: "completed" };
  });
  const store = new TuiStore(core, parseSettings({}));
  store.setDraft("task");
  const run = store.submit();
  try {
    // 流式进行中实时 Thinking 照常展示。
    await vi.waitFor(() => expect(store.items().some((i) => i.thinking === "half thought")).toBe(true));
    store.cancel();
    await run;
    await vi.waitFor(() => expect(store.getSnapshot().core.status.kind).toBe("idle"));
    expect(store.items().some((i) => i.thinking === "half thought")).toBe(false);
    expect(store.items().some((i) => i.role === "attempt")).toBe(false);
  } finally {
    await store.dispose();
  }
});

it("shows text but hides thinking for a cancelled attempt in the settlement window", async () => {
  const core = controller(async (handle, signal) => {
    handle.beginAttempt(1, 1);
    handle.streamThinking("half thought");
    handle.streamText("partial answer");
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    handle.finishAttempt("cancelled");
    return { outcome: "completed" };
  });
  const store = new TuiStore(core, parseSettings({}));
  store.setDraft("task");
  const run = store.submit();
  try {
    await vi.waitFor(() => expect(store.items().some((i) => i.text === "partial answer")).toBe(true));
    store.cancel();
    await run;
    await vi.waitFor(() => expect(store.getSnapshot().core.status.kind).toBe("idle"));
    const item = store.items().find((i) => i.text === "partial answer");
    expect(item).toMatchObject({ role: "attempt", cancelled: true });
    expect(item?.thinking ?? "").toBe("");
    expect(JSON.stringify(store.items())).not.toContain("half thought");
  } finally {
    await store.dispose();
  }
});

it("shows the cancelled-request annotation for a zero-turn cancelled Run", async () => {
  const core = controller(async () => ({ outcome: "completed" }));
  vi.spyOn(core, "readHistory").mockResolvedValue({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records: [
      { type: "user_prompt", recordSeq: 1, ts: "now", runId: "r1", text: "task" },
      { type: "run_finished", recordSeq: 2, ts: "now", runId: "r1", outcome: "cancelled", persisted: true },
    ],
    warnings: [],
    fromRecordSeq: 1,
  });
  const store = new TuiStore(core, parseSettings({}));
  try {
    await store.refreshHistory();
    const items = store.items();
    expect(items.find((item) => item.text === "task")).toMatchObject({ role: "user" });
    expect(items.some((item) => item.text === CANCELLED_REQUEST_ANNOTATION)).toBe(true);
  } finally {
    await store.dispose();
  }
});

it("shows the failed-request annotation for a zero-turn failed Run", async () => {
  const core = controller(async () => ({ outcome: "completed" }));
  vi.spyOn(core, "readHistory").mockResolvedValue({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records: [
      { type: "user_prompt", recordSeq: 1, ts: "now", runId: "r1", text: "task" },
      { type: "run_finished", recordSeq: 2, ts: "now", runId: "r1", outcome: "failed", persisted: true },
    ],
    warnings: [],
    fromRecordSeq: 1,
  });
  const store = new TuiStore(core, parseSettings({}));
  try {
    await store.refreshHistory();
    const items = store.items();
    expect(items.find((item) => item.text === "task")).toMatchObject({ role: "user" });
    expect(items.some((item) => item.text === FAILED_REQUEST_ANNOTATION)).toBe(true);
    expect(items.some((item) => item.role === "failure" && item.text === "此轮未进入有效上下文")).toBe(false);
  } finally {
    await store.dispose();
  }
});

it("shows unknown annotations and synthetic placeholders isomorphic to the model context", async () => {
  const core = controller(async () => ({ outcome: "completed" }));
  vi.spyOn(core, "readHistory").mockResolvedValue({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records: [
      { type: "user_prompt", recordSeq: 1, ts: "now", runId: "r1", text: "task" },
      {
        type: "assistant_message",
        recordSeq: 2,
        ts: "now",
        runId: "r1",
        message: makeAssistantMessage([{ id: "u", name: "bash", arguments: { command: "x" } }], "", {
          stopReason: "toolUse",
        }),
      },
      {
        type: "tool_result",
        recordSeq: 3,
        ts: "now",
        runId: "r1",
        assistantRecordSeq: 2,
        toolCallId: "u",
        toolName: "bash",
        status: "unknown",
        content: "Error: termination unconfirmed",
      },
      { type: "run_finished", recordSeq: 4, ts: "now", runId: "r1", outcome: "failed", persisted: true },
      { type: "user_prompt", recordSeq: 5, ts: "now", runId: "r2", text: "retry" },
      {
        type: "assistant_message",
        recordSeq: 6,
        ts: "now",
        runId: "r2",
        message: makeAssistantMessage([{ id: "m", name: "bash", arguments: { command: "y" } }], "", {
          stopReason: "toolUse",
        }),
      },
      // 崩溃窗口：m 无结果记录。
    ],
    warnings: [],
    fromRecordSeq: 1,
  });
  const store = new TuiStore(core, parseSettings({}));
  try {
    await store.refreshHistory();
    const items = store.items();
    // 真实 unknown 结果原文展示；缺结果 call 展示合成占位标记。
    expect(items.find((item) => item.id === "tool-2-u")).toMatchObject({
      syntheticUnknown: false,
      result: { status: "unknown" },
    });
    expect(items.find((item) => item.id === "tool-6-m")).toMatchObject({ syntheticUnknown: true });
    expect(items.find((item) => item.id === "tool-6-m")?.result).toBeUndefined();
    expect(items.filter((item) => item.text === UNKNOWN_RESULT_ANNOTATION)).toHaveLength(2);
    // 受控进入的 Turn 不再标"未进入有效上下文"。
    expect(items.some((item) => item.text === "此轮未进入有效上下文")).toBe(false);
  } finally {
    await store.dispose();
  }
});

it("does not mark the in-flight turn as synthetic unknown while the Run is running", async () => {
  let finish!: (value: { outcome: "completed" }) => void;
  let runId = "";
  const core = controller(async (handle) => {
    runId = handle.runId;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  // 在途 Turn：assistant 已落盘、bash call 等待审批/执行，盘上无 tool_result——与崩溃窗口同形。
  vi.spyOn(core, "readHistory").mockImplementation(async () => ({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records: [
      { type: "user_prompt", recordSeq: 1, ts: "now", runId, text: "task" },
      {
        type: "assistant_message",
        recordSeq: 2,
        ts: "now",
        runId,
        message: makeAssistantMessage([{ id: "u", name: "bash", arguments: { command: "x" } }], "", {
          stopReason: "toolUse",
        }),
      },
    ],
    warnings: [],
    fromRecordSeq: 1,
  }));
  const store = new TuiStore(core, parseSettings({}));
  store.setDraft("task");
  const run = store.submit();
  try {
    await vi.waitFor(() => expect(store.getSnapshot().core.status.kind).toBe("running"));
    await vi.waitFor(() => expect(runId).not.toBe(""));
    await store.refreshHistory();
    const items = store.items();
    expect(items.find((item) => item.id === "tool-2-u")).toMatchObject({ syntheticUnknown: false });
    expect(items.some((item) => item.text === UNKNOWN_RESULT_ANNOTATION)).toBe(false);
    finish({ outcome: "completed" });
    await run;
    await vi.waitFor(() => expect(store.getSnapshot().core.status.kind).toBe("idle"));
    // Run 收尾后同一记录形态恢复崩溃窗口语义：合成占位 + unknown 标注。
    const after = store.items();
    expect(after.find((item) => item.id === "tool-2-u")).toMatchObject({ syntheticUnknown: true });
    expect(after.some((item) => item.text === UNKNOWN_RESULT_ANNOTATION)).toBe(true);
  } finally {
    finish?.({ outcome: "completed" });
    await run;
    await store.dispose();
  }
});

it("dims tool cards of excluded turns (G2)", async () => {
  const core = controller(async () => ({ outcome: "completed" }));
  vi.spyOn(core, "readHistory").mockResolvedValue({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records: [
      { type: "user_prompt", recordSeq: 1, ts: "now", runId: "r1", text: "task" },
      {
        type: "assistant_message",
        recordSeq: 2,
        ts: "now",
        runId: "r1",
        message: makeAssistantMessage([{ id: "x", name: "read", arguments: { path: "a" } }], "", {
          stopReason: "error",
        }),
      },
    ],
    warnings: [],
    fromRecordSeq: 1,
  });
  const store = new TuiStore(core, parseSettings({}));
  try {
    await store.refreshHistory();
    const items = store.items();
    expect(items.find((item) => item.id === "tool-2-x")).toMatchObject({ failed: true });
    expect(items.some((item) => item.text === "此轮未进入有效上下文")).toBe(true);
  } finally {
    await store.dispose();
  }
});

it("keeps records covered by the checkpoint summary verbatim without dimming (G3/G9)", async () => {
  const { records, core } = compactionFixture(async () => ({
    status: "noop",
    coveredUpTo: null,
    path: "primary",
  }));
  records.push(
    checkpointRecord(3, 2),
    { type: "user_prompt", recordSeq: 4, ts: "now", runId: "r2", text: "new task" },
    {
      type: "assistant_message",
      recordSeq: 5,
      ts: "now",
      runId: "r2",
      message: makeAssistantMessage([], "retained answer"),
    },
  );
  const store = await loadedStore(core);
  try {
    const items = store.items();
    // 压前记录不淡化、原文保留：compacted 标记已删除，压前/尾部同构。
    const coveredPrompt = items.find((item) => item.id === "prompt-1");
    const coveredAssistant = items.find((item) => item.id === "assistant-2");
    expect(coveredPrompt).toMatchObject({ text: "old task" });
    expect(coveredAssistant).toMatchObject({ text: "covered answer" });
    for (const item of [coveredPrompt!, coveredAssistant!]) {
      expect("compacted" in item).toBe(false);
      expect(item.failed).toBeFalsy();
    }
    const separator = items.find((item) => item.role === "compaction");
    expect(separator).toMatchObject({ id: "compaction-3", text: "compacted", summary: "SUMMARY" });
    expect(items.find((item) => item.id === "prompt-4")).toMatchObject({ text: "new task" });
    expect(items.find((item) => item.id === "assistant-5")).toMatchObject({ text: "retained answer" });
    // 摘要默认折叠，点击分隔线展开/再折叠（复用 expanded 机制）。
    expect(store.getSnapshot().expanded.has("compaction-3")).toBe(false);
    store.toggle("compaction-3");
    expect(store.getSnapshot().expanded.has("compaction-3")).toBe(true);
    store.toggle("compaction-3");
    expect(store.getSnapshot().expanded.has("compaction-3")).toBe(false);
  } finally {
    await store.dispose();
  }
});

it("reuses history item identities when toggling a diff in a long session", async () => {
  const records: SessionRecord[] = [];
  let seq = 0;
  for (let i = 0; i < 20; i++) {
    records.push({ type: "user_prompt", recordSeq: ++seq, ts: "now", runId: `r${i}`, text: `task ${i}` });
    records.push({
      type: "assistant_message",
      recordSeq: ++seq,
      ts: "now",
      runId: `r${i}`,
      message: makeAssistantMessage([], `answer ${i}`),
    });
  }
  const editSeq = ++seq;
  records.push(
    {
      type: "assistant_message",
      recordSeq: editSeq,
      ts: "now",
      runId: "edit-run",
      message: makeAssistantMessage(
        [{ id: "e", name: "edit", arguments: { path: "a.txt", oldText: "old", newText: "new" } }],
        "",
        { stopReason: "toolUse" },
      ),
    },
    {
      type: "tool_result",
      recordSeq: ++seq,
      ts: "now",
      runId: "edit-run",
      assistantRecordSeq: editSeq,
      toolCallId: "e",
      toolName: "edit",
      status: "success",
      content: "Successfully edited.",
      priorContent: "old",
    },
  );
  const core = controller(async () => ({ outcome: "completed" }));
  vi.spyOn(core, "readHistory").mockImplementation(async () => ({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records: [...records],
    warnings: [],
    fromRecordSeq: 1,
  }));
  const store = new TuiStore(core, parseSettings({}));
  try {
    await store.refreshHistory();
    const before = store.items();
    const toolId = `tool-${editSeq}-e`;
    store.toggle(toolId);
    const expandedItems = store.items();
    expect(expandedItems.some((item) => item.role === "diff")).toBe(true);
    for (const item of before) expect(expandedItems).toContain(item);
    store.toggle(toolId);
    const collapsed = store.items();
    expect(collapsed.some((item) => item.role === "diff")).toBe(false);
    for (const item of before) expect(collapsed).toContain(item);
  } finally {
    await store.dispose();
  }
});

function checkpointRecord(recordSeq: number, coveredUpTo: number): SessionRecord {
  return {
    type: "checkpoint",
    recordSeq,
    ts: "now",
    summary: "SUMMARY",
    coveredUpTo,
    model: { providerId: "p", modelId: "m" },
  };
}

function compactionFixture(execute: CompactionDriver["execute"]) {
  const records: SessionRecord[] = [
    { type: "user_prompt", recordSeq: 1, ts: "now", runId: "r", text: "old task" },
    {
      type: "assistant_message",
      recordSeq: 2,
      ts: "now",
      runId: "r",
      message: makeAssistantMessage([], "covered answer"),
    },
  ];
  const core = controller(async () => ({ outcome: "completed" }), { execute });
  vi.spyOn(core, "readHistory").mockImplementation(async () => ({
    meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records: [...records],
    warnings: [],
    fromRecordSeq: 1,
  }));
  return { records, core };
}

async function loadedStore(core: SessionController): Promise<TuiStore> {
  const store = new TuiStore(core, parseSettings({}));
  await store.refreshHistory();
  return store;
}

it("enables /compact when idle and derives the separator after the covered block", async () => {
  const { records, core } = compactionFixture(async () => {
    records.push(checkpointRecord(3, 2));
    return { status: "completed", coveredUpTo: 2, path: "primary" };
  });
  const store = await loadedStore(core);
  try {
    store.setDraft("/comp");
    expect(store.commandOptions().find((option) => option.name === "/compact")).toMatchObject({
      enabled: true,
      description: "压缩上下文",
    });
    store.setDraft("/compact");
    await store.submit();
    expect(store.getSnapshot().notice?.text).toBe("压缩完成");
    await vi.waitFor(() => expect(store.items().some((item) => item.role === "compaction")).toBe(true));
    const items = store.items();
    const separators = items.filter((item) => item.role === "compaction");
    expect(separators).toHaveLength(1);
    expect(separators[0]).toMatchObject({ id: "compaction-3", text: "compacted" });
    expect(separators[0]?.summary).toBeTruthy();
    expect(items[items.indexOf(separators[0]!) - 1]).toMatchObject({ id: "assistant-2" });
    expect(items.some((item) => item.id === "prompt-1")).toBe(true);
    expect(items.some((item) => item.id === "assistant-2")).toBe(true);
    expect(items.some((item) => item.text.includes("SUMMARY"))).toBe(false);
  } finally {
    await store.dispose();
  }
});

it("passes /compact <focus> to the compactor", async () => {
  let captured: string | undefined;
  const { records, core } = compactionFixture(async (_signal, focus) => {
    captured = focus;
    records.push(checkpointRecord(3, 2));
    return { status: "completed", coveredUpTo: 2, path: "primary" };
  });
  const store = await loadedStore(core);
  try {
    store.setDraft("/compact 关注认证流程");
    await store.submit();
    expect(captured).toBe("关注认证流程");
    expect(store.getSnapshot().notice?.text).toBe("压缩完成");
  } finally {
    await store.dispose();
  }
});

it("keeps multi-line /compact focus verbatim", async () => {
  let captured: string | undefined;
  const { core } = compactionFixture(async (_signal, focus) => {
    captured = focus;
    return { status: "noop", coveredUpTo: null, path: "primary" };
  });
  const store = await loadedStore(core);
  try {
    store.setDraft("/compact 第一行\n第二行");
    await store.submit();
    expect(captured).toBe("第一行\n第二行");
  } finally {
    await store.dispose();
  }
});

it("passes no focus for bare /compact and keeps /compactfoo unknown", async () => {
  const focuses: Array<string | undefined> = [];
  const { core } = compactionFixture(async (_signal, focus) => {
    focuses.push(focus);
    return { status: "noop", coveredUpTo: null, path: "primary" };
  });
  const store = await loadedStore(core);
  try {
    store.setDraft("/compact");
    await store.submit();
    expect(focuses).toEqual([undefined]);
    store.setDraft("/compactfoo");
    await store.submit();
    expect(focuses).toHaveLength(1);
    expect(store.getSnapshot().notice?.text).toContain("未知命令");
  } finally {
    await store.dispose();
  }
});

it("hides the command menu once /compact carries an argument", async () => {
  const { core } = compactionFixture(async () => ({
    status: "noop",
    coveredUpTo: null,
    path: "primary",
  }));
  const store = await loadedStore(core);
  try {
    store.setDraft("/compact 关注");
    expect(store.commandOptions()).toEqual([]);
  } finally {
    await store.dispose();
  }
});

it("anchors the compacted line after a cancelled run's outcome and duration lines", async () => {
  const { records, core } = compactionFixture(async () => ({
    status: "noop",
    coveredUpTo: null,
    path: "primary",
  }));
  records.push(
    {
      type: "run_finished",
      recordSeq: 3,
      ts: "now",
      runId: "r",
      outcome: "cancelled",
      persisted: true,
      elapsedMs: 5000,
    },
    checkpointRecord(4, 2),
  );
  const store = new TuiStore(core, parseSettings({}));
  try {
    await store.refreshHistory();
    const items = store.items();
    const separator = items.findIndex((item) => item.role === "compaction");
    expect(separator).toBeGreaterThan(2);
    expect(items[separator - 1]).toMatchObject({ id: "duration-r" });
    expect(items[separator - 2]).toMatchObject({ id: "outcome-3", text: "✗ 已取消" });
    expect(items[separator - 3]).toMatchObject({ id: "assistant-2" });
    expect(items.slice(separator + 1)).toHaveLength(0);
  } finally {
    await store.dispose();
  }
});

it("anchors the compacted line after a completed run's duration line", async () => {
  const { records, core } = compactionFixture(async () => ({
    status: "noop",
    coveredUpTo: null,
    path: "primary",
  }));
  records.push(
    {
      type: "run_finished",
      recordSeq: 3,
      ts: "now",
      runId: "r",
      outcome: "completed",
      persisted: true,
      elapsedMs: 5000,
    },
    checkpointRecord(4, 2),
  );
  const store = new TuiStore(core, parseSettings({}));
  try {
    await store.refreshHistory();
    const items = store.items();
    const separator = items.findIndex((item) => item.role === "compaction");
    expect(separator).toBeGreaterThan(1);
    expect(items[separator - 1]).toMatchObject({ id: "duration-r" });
    expect(items[separator - 2]).toMatchObject({ id: "assistant-2" });
    expect(items.slice(separator + 1)).toHaveLength(0);
  } finally {
    await store.dispose();
  }
});

it("keeps the retained latest turn and the run's closing lines before the compacted line", async () => {
  const { records, core } = compactionFixture(async () => ({
    status: "noop",
    coveredUpTo: null,
    path: "primary",
  }));
  records.push(
    {
      type: "assistant_message",
      recordSeq: 3,
      ts: "now",
      runId: "r",
      message: makeAssistantMessage([], "retained answer"),
    },
    {
      type: "run_finished",
      recordSeq: 4,
      ts: "now",
      runId: "r",
      outcome: "completed",
      persisted: true,
      elapsedMs: 5000,
    },
    checkpointRecord(5, 2),
  );
  const store = new TuiStore(core, parseSettings({}));
  try {
    await store.refreshHistory();
    const items = store.items();
    const separator = items.findIndex((item) => item.role === "compaction");
    expect(items[separator - 1]).toMatchObject({ id: "duration-r" });
    expect(items[separator - 2]).toMatchObject({ id: "assistant-3" });
    expect(items[separator - 3]).toMatchObject({ id: "assistant-2" });
    expect(items.slice(separator + 1)).toHaveLength(0);
  } finally {
    await store.dispose();
  }
});

it("disables /compact and prompt submission while running or compacting", async () => {
  let finishRun!: () => void;
  let finishCompact!: (outcome: CompactionOutcome) => void;
  let compactions = 0;
  const core = controller(
    async () => {
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      return { outcome: "completed" };
    },
    {
      execute: () => {
        compactions++;
        return new Promise((resolve) => {
          finishCompact = resolve;
        });
      },
    },
  );
  const store = await loadedStore(core);
  try {
    store.setDraft("task");
    const run = store.submit();
    await vi.waitFor(() => expect(store.getSnapshot().core.status.kind).toBe("running"));
    store.setDraft("/comp");
    expect(store.commandOptions().find((option) => option.name === "/compact")?.enabled).toBe(false);
    finishRun();
    await run;
    store.setDraft("/compact");
    const compact = store.submit();
    await vi.waitFor(() => expect(store.getSnapshot().core.status.kind).toBe("compacting"));
    store.setDraft("/comp");
    expect(store.commandOptions().find((option) => option.name === "/compact")?.enabled).toBe(false);
    store.setDraft("/compact");
    await store.submit();
    expect(compactions).toBe(1);
    store.setDraft("queued prompt");
    await store.submit();
    expect(store.getSnapshot().draft).toBe("queued prompt");
    expect(store.getSnapshot().core.status.kind).toBe("compacting");
    finishCompact({ status: "noop", coveredUpTo: null, path: "primary" });
    await compact;
    expect(store.getSnapshot().draft).toBe("queued prompt");
  } finally {
    await store.dispose();
  }
});

it("shows a live compacting separator and replaces it with the checkpoint-derived line", async () => {
  let finish!: (outcome: CompactionOutcome) => void;
  const { records, core } = compactionFixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const store = await loadedStore(core);
  try {
    store.setDraft("/compact");
    const pending = store.submit();
    await vi.waitFor(() =>
      expect(store.items().some((item) => item.role === "compaction" && item.text === "compacting")).toBe(
        true,
      ),
    );
    expect(store.items().at(-1)).toMatchObject({ role: "compaction", text: "compacting" });
    records.push(checkpointRecord(3, 2));
    finish({ status: "completed", coveredUpTo: 2, path: "primary" });
    await pending;
    await vi.waitFor(() =>
      expect(store.items().some((item) => item.text === "compacted")).toBe(true),
    );
    expect(store.items().some((item) => item.text === "compacting")).toBe(false);
    expect(store.items().filter((item) => item.role === "compaction")).toHaveLength(1);
  } finally {
    await store.dispose();
  }
});

it("reports noop without leaving a separator", async () => {
  const { core } = compactionFixture(async () => ({
    status: "noop",
    coveredUpTo: null,
    path: "primary",
  }));
  const store = await loadedStore(core);
  try {
    store.setDraft("/compact");
    await store.submit();
    expect(store.getSnapshot().notice?.text).toBe("No context to compact");
    expect(store.items().some((item) => item.role === "compaction")).toBe(false);
  } finally {
    await store.dispose();
  }
});

it("keeps a cancelled separator in place while later content renders after it", async () => {
  const { records, core } = compactionFixture(async () => ({
    status: "cancelled",
    coveredUpTo: null,
    path: "primary",
  }));
  const store = await loadedStore(core);
  try {
    store.setDraft("/compact");
    await store.submit();
    expect(store.getSnapshot().notice?.text).toBe("压缩已取消");
    expect(store.items().at(-1)).toMatchObject({ role: "compaction", text: "compaction cancelled" });
    records.push({ type: "user_prompt", recordSeq: 3, ts: "now", runId: "r2", text: "later prompt" });
    await store.refreshHistory();
    const items = store.items();
    const index = items.findIndex((item) => item.role === "compaction");
    expect(index).toBeGreaterThan(0);
    expect(items[index + 1]).toMatchObject({ id: "prompt-3" });
  } finally {
    await store.dispose();
  }
});

it("keeps a failed separator and reports the redacted error", async () => {
  const { core } = compactionFixture(async () => {
    throw new Error("summary boom");
  });
  const store = await loadedStore(core);
  try {
    store.setDraft("/compact");
    await store.submit();
    expect(store.getSnapshot().notice).toMatchObject({ text: "summary boom", error: true });
    expect(store.items().at(-1)).toMatchObject({ role: "compaction", text: "compaction failed" });
  } finally {
    await store.dispose();
  }
});

it("re-derives separators from records after a resume-like reload and keeps every checkpoint line", async () => {
  const { records, core } = compactionFixture(async () => ({
    status: "noop",
    coveredUpTo: null,
    path: "primary",
  }));
  records.push(
    checkpointRecord(3, 2),
    { type: "user_prompt", recordSeq: 4, ts: "now", runId: "r2", text: "second task" },
    {
      type: "assistant_message",
      recordSeq: 5,
      ts: "now",
      runId: "r2",
      message: makeAssistantMessage([], "second answer"),
    },
    checkpointRecord(6, 5),
  );
  const store = new TuiStore(core, parseSettings({}));
  try {
    await store.refreshHistory();
    const items = store.items();
    const separators = items.filter((item) => item.role === "compaction");
    expect(separators.map((item) => item.id)).toEqual(["compaction-3", "compaction-6"]);
    expect(items[items.indexOf(separators[0]!) - 1]).toMatchObject({ id: "assistant-2" });
    expect(items[items.indexOf(separators[1]!) - 1]).toMatchObject({ id: "assistant-5" });
    expect(items.some((item) => item.id === "assistant-2")).toBe(true);
  } finally {
    await store.dispose();
  }
});

it("clears transient separators when adopting a new Session", async () => {
  let sessionId = "s";
  const { core } = compactionFixture(async () => ({
    status: "cancelled",
    coveredUpTo: null,
    path: "primary",
  }));
  const snapshot = core.getSnapshot.bind(core);
  vi.spyOn(core, "getSnapshot").mockImplementation(() => {
    const value = snapshot();
    value.session.ref!.sessionId = sessionId;
    return value;
  });
  vi.spyOn(core, "newSession").mockImplementation(async () => {
    sessionId = "new";
  });
  vi.spyOn(core, "readHistory").mockImplementation(async () => ({
    meta: { version: 4, workspaceId: "ws", sessionId, createdAt: "now" },
    records: [],
    warnings: [],
    fromRecordSeq: 1,
  }));
  const store = await loadedStore(core);
  try {
    store.setDraft("/compact");
    await store.submit();
    expect(store.items().some((item) => item.role === "compaction")).toBe(true);
    store.setDraft("/new");
    await store.submit();
    await vi.waitFor(() => expect(store.getSnapshot().history?.meta.sessionId).toBe("new"));
    expect(store.items().some((item) => item.role === "compaction")).toBe(false);
  } finally {
    await store.dispose();
  }
});

describe("stream state delivery", () => {
  it("delivers the complete high-frequency delta tail", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const core = controller(async (handle) => {
      handle.beginAttempt(1, 1);
      for (let index = 0; index < 8; index++) {
        handle.streamText("x");
        await new Promise((resolve) => setImmediate(resolve));
      }
      await gate;
      handle.finishAttempt("completed");
      return { outcome: "completed" };
    });
    const store = new TuiStore(core, parseSettings({ streamRefreshMs: 200 }));
    let notifications = 0;
    store.subscribe(() => notifications++);
    store.setDraft("run");
    const run = store.submit();
    try {
      await vi.waitFor(() => expect(store.getSnapshot().core.streamingAttempts.length).toBe(1));
      await vi.waitFor(() => expect(core.getSnapshot().accumulatedText).toBe("xxxxxxxx"));
      expect(notifications).toBeGreaterThan(0);
      await vi.waitFor(() => expect(store.getSnapshot().core.streamingAttempts[0]?.text).toBe("xxxxxxxx"));
    } finally {
      release();
      await run;
      await store.dispose();
    }
  });

  it("renders formal events immediately and cancels the pending coalesced flush", async () => {
    let stepped!: () => void;
    const steppedGate = new Promise<void>((resolve) => (stepped = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const core = controller(async (handle) => {
      handle.beginAttempt(1, 1);
      handle.streamText("partial");
      await new Promise((resolve) => setImmediate(resolve));
      handle.streamText(" more");
      await new Promise((resolve) => setImmediate(resolve));
      handle.reportPhase("executing_tool");
      stepped();
      await gate;
      handle.finishAttempt("completed");
      return { outcome: "completed" };
    });
    const store = new TuiStore(core, parseSettings({ streamRefreshMs: 200 }));
    let notifications = 0;
    store.subscribe(() => notifications++);
    store.setDraft("run");
    const run = store.submit();
    try {
      await steppedGate;
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.getSnapshot().core.streamingAttempts[0]?.text).toBe("partial more");
      const settled = notifications;
      await new Promise((resolve) => setTimeout(resolve, 260));
      expect(notifications).toBe(settled);
    } finally {
      release();
      await run;
      await store.dispose();
    }
  });

  it("renders user input immediately during a pending stream window", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const core = controller(async (handle) => {
      handle.beginAttempt(1, 1);
      handle.streamText("a");
      await new Promise((resolve) => setImmediate(resolve));
      handle.streamText("b");
      await new Promise((resolve) => setImmediate(resolve));
      await gate;
      handle.finishAttempt("completed");
      return { outcome: "completed" };
    });
    const store = new TuiStore(core, parseSettings({ streamRefreshMs: 200 }));
    let notifications = 0;
    store.subscribe(() => notifications++);
    store.setDraft("run");
    const run = store.submit();
    try {
      await vi.waitFor(() => expect(core.getSnapshot().accumulatedText).toBe("ab"));
      store.setDraft("typed");
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.getSnapshot().draft).toBe("typed");
      const settled = notifications;
      await new Promise((resolve) => setTimeout(resolve, 260));
      expect(notifications).toBe(settled);
    } finally {
      release();
      await run;
      await store.dispose();
    }
  });

  it("clears the pending coalesced flush on dispose", async () => {
    const core = controller(async (handle, signal) => {
      handle.beginAttempt(1, 1);
      handle.streamText("a");
      await new Promise((resolve) => setImmediate(resolve));
      handle.streamText("b");
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { outcome: "completed" };
    });
    const store = new TuiStore(core, parseSettings({ streamRefreshMs: 200 }));
    let notifications = 0;
    store.subscribe(() => notifications++);
    store.setDraft("run");
    const run = store.submit();
    await vi.waitFor(() => expect(core.getSnapshot().accumulatedText).toBe("ab"));
    await store.dispose();
    const settled = notifications;
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(notifications).toBe(settled);
    await run;
  });
});

it("offers autodecision completion and rejects invalid arguments without a Run", async () => {
  const core = controller(async () => {
    throw new Error("must not run");
  });
  const store = new TuiStore(core, parseSettings({}));
  try {
    store.setDraft("/auto");
    expect(store.commandOptions().map((option) => option.name)).toContain("/autodecision");
    store.setDraft("/autodecision maybe");
    await store.submit();
    expect(store.getSnapshot().notice?.text).toContain("/autodecision [on|off]");
  } finally {
    await store.dispose();
  }
});

it("reports busy autodecision commands during a Run", async () => {
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const core = controller(async () => {
    await waiting;
    return { outcome: "completed" };
  });
  const store = new TuiStore(core, parseSettings({}));
  store.setDraft("hello");
  const run = store.submit();
  try {
    store.setDraft("/autodecision on");
    await store.submit();
    expect(store.getSnapshot().notice?.error).toBe(true);
  } finally {
    finish();
    await run;
    await store.dispose();
  }
});

it("refreshes the auto decision snapshot when a probe notice arrives", async () => {
  let availability: "ready" | "unavailable" = "ready";
  let message: string | undefined;
  const core = new SessionController({
    driver: { execute: async () => ({ outcome: "completed" }) },
    hooks: {
      getSessionView: () => ({
        ref: { workspaceId: "ws", sessionId: "s" },
        model: null,
        models: [],
        runModel: null,
        contextBaselineTokens: null,
        autoDecision: { enabled: true, availability, ...(message ? { message } : {}) },
      }),
    },
  });
  const store = new TuiStore(core, parseSettings({}));
  try {
    expect(store.getSnapshot().core.session.autoDecision.availability).toBe("ready");
    availability = "unavailable";
    message = "决策模型名称与服务不符";
    store.notice("自动决策已关闭：决策模型名称与服务不符");
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getSnapshot().core.session.autoDecision.availability).toBe("unavailable");
  } finally {
    await store.dispose();
  }
});

it("reports probe unavailable status and reason in the /autodecision query", async () => {
  const status = {
    enabled: true,
    availability: "unavailable",
    message: "决策模型名称与服务不符（配置：a，服务：b）",
  };
  const core = new SessionController({
    driver: { execute: async () => ({ outcome: "completed" }) },
    commands: { getAutoDecisionStatus: async () => status },
    hooks: {
      getSessionView: () => ({
        ref: { workspaceId: "ws", sessionId: "s" },
        model: null,
        models: [],
        runModel: null,
        contextBaselineTokens: null,
        autoDecision: status,
      }),
    },
  });
  const store = new TuiStore(core, parseSettings({}));
  try {
    store.setDraft("/autodecision");
    await store.submit();
    const text = store.getSnapshot().notice?.text ?? "";
    expect(text).toContain("unavailable");
    expect(text).toContain("决策模型名称与服务不符（配置：a，服务：b）");
  } finally {
    await store.dispose();
  }
});

it("routes a typed cancel command to managed cancellation during a Run", async () => {
  const core = controller(
    async (_handle, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ outcome: "completed" }), { once: true });
      }),
  );
  const store = new TuiStore(core, parseSettings({}));
  store.setDraft("work");
  const run = store.submit();
  await new Promise((resolve) => setImmediate(resolve));
  store.setDraft("/cancel");
  await store.submit();
  expect(await run).toBeUndefined();
  expect(core.getSnapshot().lastRun?.outcome).toBe("cancelled");
  await store.dispose();
});

it("a typed exit cancels and waits for the Run without reporting a closed-history refresh as an error", async () => {
  const core = controller(
    async (_handle, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ outcome: "completed" }), { once: true });
      }),
  );
  const exited = vi.fn();
  const store = new TuiStore(core, parseSettings({}), { onExit: exited });
  store.setDraft("run");
  const run = store.submit();
  await new Promise((resolve) => setImmediate(resolve));
  store.setDraft("/exit");
  await store.submit();
  await vi.waitFor(() => expect(exited).toHaveBeenCalledOnce());
  await run;
  expect(store.getExitNotices()).toEqual([]);
  await store.dispose();
});

it("requires a second idle interrupt within the configured window and keeps the draft", async () => {
  vi.useFakeTimers();
  const core = controller(async () => ({ outcome: "completed" }));
  const exit = vi.spyOn(core, "exit");
  const store = new TuiStore(core, parseSettings({}));
  try {
    store.setDraft("draft");
    store.interrupt();
    expect(exit).not.toHaveBeenCalled();
    expect(store.getSnapshot().notice?.text).toContain("3 秒");
    vi.advanceTimersByTime(2999);
    store.interrupt();
    await store.dispose();
    expect(exit).toHaveBeenCalledOnce();
    expect(store.getSnapshot().draft).toBe("draft");
  } finally { await store.dispose(); vi.useRealTimers(); }
});

it.each([3000, 3001])("starts a fresh interrupt window at %s ms", async elapsed => {
  vi.useFakeTimers();
  const core = controller(async () => ({ outcome: "completed" }));
  const exit = vi.spyOn(core, "exit");
  const store = new TuiStore(core, parseSettings({}));
  try {
    store.interrupt(); vi.advanceTimersByTime(elapsed); store.interrupt();
    expect(exit).not.toHaveBeenCalled();
    expect(store.getSnapshot().notice?.text).toContain("3 秒");
    store.notice("new error", true); vi.advanceTimersByTime(3000);
    expect(store.getSnapshot().notice?.text).toBe("new error");
  } finally { await store.dispose(); vi.useRealTimers(); }
});
it("clears interrupt state when editing and disposes its timer", async () => {
  vi.useFakeTimers();
  const core = controller(async () => ({ outcome: "completed" }));
  const exit = vi.spyOn(core, "exit");
  const store = new TuiStore(core, parseSettings({}));
  try {
    store.interrupt(); store.setDraft("edit"); store.interrupt();
    expect(exit).not.toHaveBeenCalled();
    await store.dispose(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it("retains the session chooser on failure and retries directly", async () => {
  const core = controller(async () => ({ outcome: "completed" }));
  vi.spyOn(core, "listSessions").mockResolvedValue([{ version: 4, workspaceId: "ws", sessionId: "old", createdAt: "now", runCount: 1 }]);
  const resume = vi.spyOn(core, "resumeSession").mockRejectedValueOnce(new Error("occupied")).mockResolvedValueOnce();
  const store = new TuiStore(core, parseSettings({}));
  try {
    store.setDraft("/resume"); await store.submit();
    await store.confirmModal();
    expect(store.getSnapshot().modal?.kind).toBe("sessions");
    expect(store.getSnapshot().notice?.text).toBe("occupied");
    await store.confirmModal();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().modal).toBeNull();
  } finally { await store.dispose(); }
});

it("closes the originating chooser after delayed resume despite navigation", async () => {
  const core = controller(async () => ({ outcome: "completed" }));
  vi.spyOn(core, "listSessions").mockResolvedValue([{ version: 4, workspaceId: "ws", sessionId: "old", createdAt: "now", runCount: 1 }]);
  let finish!: () => void;
  vi.spyOn(core, "resumeSession").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const store = new TuiStore(core, parseSettings({}));
  try {
    store.setDraft("/resume"); await store.submit();
    const pending = store.confirmModal(); store.moveModal(1); finish(); await pending;
    expect(store.getSnapshot().modal).toBeNull();
  } finally { await store.dispose(); }
});
it("publishes closing state while managed cleanup is pending", async () => {
  let finish!: () => void;
  const core = new SessionController({ driver: { execute: async () => ({ outcome: "completed" }) }, hooks: { closeSession: () => new Promise<void>(resolve => { finish = resolve; }) } });
  const store = new TuiStore(core, parseSettings({}));
  store.requestExit();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  try { expect(store.getSnapshot().closing).toBe(true); }
  finally { finish(); await store.dispose(); }
});

it("associates approval with the latest execution occurrence and clears it after resolution", async () => {
 let phase=0;
 const core=controller(async handle=>{
   handle.notifyToolStarted("same","bash"); await handle.notifyToolCompleted("same"); phase=1;
   handle.notifyToolStarted("same","bash");
   await handle.requestApproval({toolCallId:"same",toolName:"bash"});
   return {outcome:"completed"};
 });
 vi.spyOn(core,"readHistory").mockImplementation(async()=>{
   const snapshot=core.getSnapshot(); const runId=snapshot.status.kind === "running" ? snapshot.status.runId : snapshot.lastRun!.runId;
   return {meta:{version:4,workspaceId:"ws",sessionId:"s",createdAt:"now"},warnings:[],fromRecordSeq:1,
    records:[1,2].slice(0,phase+1).map(recordSeq=>({type:"assistant_message" as const,recordSeq,ts:"now",runId,message:makeAssistantMessage([{id:"same",name:"bash",arguments:{command:"echo test"}}],"",{stopReason:"toolUse"})}))};
 });
 const store=new TuiStore(core,parseSettings({})); const run=core.submitPrompt("task");
 try {
   await vi.waitFor(()=>expect(store.getSnapshot().modal?.kind).toBe("approval")); await store.refreshHistory();
   expect(store.items().filter(item=>item.pendingApprovalId).map(item=>item.id)).toEqual(["tool-2-same"]);
   store.dismissModal(); await run;
   await vi.waitFor(()=>expect(store.items().some(item=>item.pendingApprovalId)).toBe(false));
 } finally {await store.dispose();}
});

describe("bash 实时输出展示态", () => {
  function bashHistory(core: SessionController) {
    vi.spyOn(core, "readHistory").mockImplementation(async () => {
      const snapshot = core.getSnapshot();
      const runId = snapshot.status.kind === "running" ? snapshot.status.runId : snapshot.lastRun!.runId;
      return {
        meta: { version: 4, workspaceId: "ws", sessionId: "s", createdAt: "now" },
        warnings: [],
        fromRecordSeq: 1,
        records: [
          {
            type: "assistant_message" as const,
            recordSeq: 1,
            ts: "now",
            runId,
            message: makeAssistantMessage([{ id: "c1", name: "bash", arguments: { command: "echo test" } }], "", {
              stopReason: "toolUse",
            }),
          },
        ],
      };
    });
  }

  it("挂到运行中工具行，替换语义，完成后清除", async () => {
    let openFirst!: () => void;
    let openSecond!: () => void;
    const first = new Promise<void>((resolve) => { openFirst = resolve; });
    const second = new Promise<void>((resolve) => { openSecond = resolve; });
    const core = controller(async (handle) => {
      handle.notifyToolStarted("c1", "bash");
      handle.streamToolOutput("c1", "line1\n");
      await first;
      handle.streamToolOutput("c1", "line1\nline2\n");
      await second;
      await handle.notifyToolCompleted("c1");
      return { outcome: "completed" };
    });
    bashHistory(core);
    const store = new TuiStore(core, parseSettings({}));
    const run = core.submitPrompt("task");
    try {
      const live = () => store.items().find((item) => item.id === "tool-1-c1")?.liveOutput;
      await vi.waitFor(() => expect(live()).toBe("line1\n"));
      openFirst();
      await vi.waitFor(() => expect(live()).toBe("line1\nline2\n"));
      openSecond();
      await run;
      await vi.waitFor(() => expect(live()).toBeUndefined());
    } finally { await store.dispose(); }
  });

  it("取消时清除实时输出", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const core = controller(async (handle) => {
      handle.notifyToolStarted("c1", "bash");
      handle.streamToolOutput("c1", "partial");
      await gate;
      return { outcome: "cancelled" };
    });
    bashHistory(core);
    const store = new TuiStore(core, parseSettings({}));
    const run = core.submitPrompt("task");
    try {
      await vi.waitFor(() =>
        expect(store.items().find((item) => item.id === "tool-1-c1")?.liveOutput).toBe("partial"),
      );
      core.cancel();
      open();
      await run;
      await vi.waitFor(() =>
        expect(store.items().find((item) => item.id === "tool-1-c1")?.liveOutput).toBeUndefined(),
      );
    } finally { await store.dispose(); }
  });

  it("忽略未启动调用的实时输出", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const core = controller(async (handle) => {
      handle.streamToolOutput("ghost", "x");
      await gate;
      return { outcome: "completed" };
    });
    bashHistory(core);
    const store = new TuiStore(core, parseSettings({}));
    const run = core.submitPrompt("task");
    try {
      await vi.waitFor(() => expect(store.items().length).toBeGreaterThan(0));
      expect(store.items().every((item) => item.liveOutput === undefined)).toBe(true);
      open();
      await run;
    } finally { await store.dispose(); }
  });
});

function idleStore(): TuiStore {
  return new TuiStore(
    new SessionController({ driver: { execute: async () => ({ outcome: "completed" }) } }),
    parseSettings({}),
  );
}

it("collapses only auto-expanded cards and leaves pre-expanded ones alone", async () => {
  const store = idleStore();
  try {
    store.toggle("manual");
    store.autoExpand("auto");
    store.autoExpand("manual");
    expect(store.getSnapshot().expanded.has("auto")).toBe(true);
    expect(store.getSnapshot().expanded.has("manual")).toBe(true);
    store.releaseAutoExpanded();
    expect(store.getSnapshot().expanded.has("auto")).toBe(false);
    expect(store.getSnapshot().expanded.has("manual")).toBe(true);
  } finally {
    await store.dispose();
  }
});

it("treats a manual toggle as ownership so release never collapses it again", async () => {
  const store = idleStore();
  try {
    store.autoExpand("tool");
    store.toggle("tool");
    expect(store.getSnapshot().expanded.has("tool")).toBe(false);
    store.toggle("tool");
    store.releaseAutoExpanded();
    expect(store.getSnapshot().expanded.has("tool")).toBe(true);
  } finally {
    await store.dispose();
  }
});

it("records the latest approval decision for post-approval tracking", async () => {
  const core = new SessionController({
    driver: {
      execute: async (handle) => {
        await handle.requestApproval({ toolCallId: "c", toolName: "bash" });
        return { outcome: "completed" };
      },
    },
  });
  const store = new TuiStore(core, parseSettings({}));
  const run = core.submitPrompt("run");
  try {
    expect(store.getSnapshot().lastResolvedApproval).toBeNull();
    await vi.waitFor(() => expect(store.getSnapshot().core.pendingApproval).not.toBeNull());
    const id = store.getSnapshot().core.pendingApproval!.id;
    core.resolveApproval(id, "deny");
    await run;
    await vi.waitFor(() =>
      expect(store.getSnapshot().lastResolvedApproval).toEqual({ id, decision: "deny" }),
    );
  } finally {
    await store.dispose();
  }
});
