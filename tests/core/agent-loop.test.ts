import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../../src/core/agent-loop.js";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import type { StreamTurnOptions, TurnResult } from "../../src/llm/model-service.js";
import { TurnError } from "../../src/llm/model-service.js";
import { parseSettings } from "../../src/llm/settings-store.js";
import { SHELL_LIVE_OUTPUT_INTERVAL_MS } from "../../src/tools/shell.js";
import { fakeShellRun } from "../tools/helpers.js";
import {
  makeAssistantMessage,
  makeStore,
  sessionRef,
  WORKSPACE_ID,
  tempDir,
  cleanupTempDirs,
} from "../sessions/helpers.js";
import type { StoredAssistantMessage } from "../../src/sessions/records.js";

export const model: ResolvedModel = {
  providerId: "p",
  providerName: "Test",
  id: "m",
  name: "Test",
  api: "openai-completions",
  baseUrl: "https://fake.test",
  apiKey: "synthetic-key",
  reasoning: false,
  thinking: false,
  reasoningEffort: "high",
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUnknown: true,
};
export function turn(message: StoredAssistantMessage): TurnResult {
  return {
    attempts: 1,
    message,
    stopReason: message.stopReason,
    usage: message.usage,
    text: "",
    thinking: "",
    truncated: message.stopReason === "length",
    toolCalls: message.content.filter((block) => block.type === "toolCall"),
  };
}
export async function fixture(messages: StoredAssistantMessage[], maxTurns = 40) {
  const { store } = makeStore();
  const ref = sessionRef("loop");
  await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: ref.sessionId });
  const requests: StreamTurnOptions[] = [];
  const session = await createAgentSession({
    store,
    ref,
    workspaceId: ref.workspaceId,
    workspaceRoot: tempDir(),
    getModel: () => model,
    getSettings: () => parseSettings({ maxTurns }),
    modelService: {
      streamTurn: async (options) => {
        requests.push(options);
        const msg = messages.shift();
        if (!msg) throw new Error("Unexpected extra model request");
        return turn(msg);
      },
    },
  });
  return { ...session, store, ref, requests };
}
afterEach(cleanupTempDirs);
describe("AgentLoop", () => {
  it("persists a text response and records exactly one prompt", async () => {
    const f = await fixture([makeAssistantMessage([], "done")]);
    await expect(f.controller.submitPrompt("hello")).resolves.toBe("completed");
    const records = (await f.store.loadSession(f.ref)).records;
    expect(records.map((r) => r.type)).toEqual([
      "user_prompt",
      "run_started",
      "assistant_message",
      "run_finished",
    ]);
    expect(f.requests[0]!.context.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(f.requests[0]!.context.tools?.map((t) => t.name)).toEqual([
      "read",
      "glob",
      "grep",
      "write",
      "edit",
      "bash",
    ]);
    expect(JSON.stringify(records)).not.toContain("synthetic-key");
  });
  it("completes the final batch before turn_limit and does not call the model again", async () => {
    const f = await fixture(
      [makeAssistantMessage([{ id: "c", name: "read", arguments: { path: "absent" } }])],
      1,
    );
    await expect(f.controller.submitPrompt("read")).resolves.toBe("turn_limit");
    const records = (await f.store.loadSession(f.ref)).records;
    expect(records.find((r) => r.type === "tool_result")).toMatchObject({ status: "error", toolCallId: "c" });
    expect(records.at(-1)).toMatchObject({ outcome: "turn_limit" });
    expect(f.requests).toHaveLength(1);
  });
  it("continues after denied write, pairs results and replays the prompt only once", async () => {
    const f = await fixture([
      makeAssistantMessage([
        { id: "a", name: "write", arguments: { path: "a.txt", content: "x" } },
        { id: "b", name: "read", arguments: { path: "absent" } },
      ]),
      makeAssistantMessage([], "done"),
    ]);
    f.controller.eventBus.subscribe((e) => {
      if (e.type === "permission.requested") f.controller.resolveApproval(e.approvalId, "deny");
    });
    await expect(f.controller.submitPrompt("task")).resolves.toBe("completed");
    expect(
      (await f.store.loadSession(f.ref)).records.filter((r) => r.type === "tool_result").map((r) => r.status),
    ).toEqual(["denied", "error"]);
    expect(f.requests[1]!.context.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
    ]);
  });
});

it("length batches execute no calls and allow a paired retry", async () => {
  const message = makeAssistantMessage(
    [{ id: "a", name: "write", arguments: { path: "a.txt", content: "x" } }],
    "",
    { stopReason: "length" },
  );
  const f = await fixture([message, makeAssistantMessage([], "done")]);
  await expect(f.controller.submitPrompt("task")).resolves.toBe("completed");
  expect((await f.store.loadSession(f.ref)).records.find((r) => r.type === "tool_result")).toMatchObject({
    status: "not_executed",
    content: "Error: Response truncated. Not executed. Generate the call again.",
  });
  expect(f.requests).toHaveLength(2);
});

it("length invalid numbers retain their precise error classification", async () => {
  const message = makeAssistantMessage([{ id: "a", name: "read" }], "", { stopReason: "length" });
  const call = message.content.find((b) => b.type === "toolCall")!;
  if (call.type === "toolCall") {
    call.rawArguments = '{"offset":1e400}';
    call.parse = { status: "invalid", error: "non_finite_number" };
  }
  const f = await fixture([message, makeAssistantMessage([], "done")]);
  await f.controller.submitPrompt("task");
  expect((await f.store.loadSession(f.ref)).records.find((r) => r.type === "tool_result")).toMatchObject({
    status: "error",
    content: "Error: Argument number is out of range. Not executed. Use a finite number.",
  });
});

it("invalid identities stop the run without fabricating results", async () => {
  const f = await fixture([
    makeAssistantMessage([
      { id: "same", name: "read" },
      { id: "same", name: "read" },
    ]),
  ]);
  await expect(f.controller.submitPrompt("task")).resolves.toBe("failed");
  expect((await f.store.loadSession(f.ref)).records.some((r) => r.type === "tool_result")).toBe(false);
  expect((await f.controller.listSessions())[0]?.runCount).toBe(1);
});

it("ordinary parsed argument errors permit a next Turn", async () => {
  const f = await fixture([
    makeAssistantMessage([{ id: "a", name: "read", arguments: { wrong: "x" } }]),
    makeAssistantMessage([], "done"),
  ]);
  await expect(f.controller.submitPrompt("task")).resolves.toBe("completed");
  expect(f.requests).toHaveLength(2);
});

it("persists not_executed for the remainder when cancellation arrives on tool completion", async () => {
  const f = await fixture([
    makeAssistantMessage([
      { id: "a", name: "read", arguments: { path: "missing" } },
      { id: "b", name: "read", arguments: { path: "missing" } },
    ]),
  ]);
  f.controller.eventBus.subscribe((event) => {
    if (event.type === "tool.completed" && event.toolCallId === "a") f.controller.cancel();
  });
  await expect(f.controller.submitPrompt("task")).resolves.toBe("cancelled");
  expect(
    (await f.store.loadSession(f.ref)).records.filter((r) => r.type === "tool_result").map((r) => r.status),
  ).toEqual(["error", "not_executed"]);
  expect((await f.controller.listSessions())[0]?.runCount).toBe(1);
});

describe("取消后的上下文落盘（A/B）", () => {
  async function cancelFixture(streamTurn: (cancel: () => void) => Promise<TurnResult>) {
    const { store } = makeStore();
    const ref = sessionRef("cancel-ctx");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: ref.sessionId });
    const session = await createAgentSession({
      store,
      ref,
      workspaceId: ref.workspaceId,
      workspaceRoot: tempDir(),
      getModel: () => model,
      getSettings: () => parseSettings({}),
      modelService: { streamTurn: async () => streamTurn(() => session.controller.cancel()) },
    });
    return { ...session, store, ref };
  }

  it("A：完整生成的响应不因取消竞态丢弃", async () => {
    const f = await cancelFixture(async (cancel) => {
      cancel();
      return turn(makeAssistantMessage([], "done"));
    });
    await expect(f.controller.submitPrompt("q")).resolves.toBe("cancelled");
    const records = (await f.store.loadSession(f.ref)).records;
    expect(records.map((r) => r.type)).toEqual([
      "user_prompt",
      "run_started",
      "assistant_message",
      "run_finished",
    ]);
    expect(records.at(-1)).toMatchObject({ type: "run_finished", outcome: "cancelled" });
  });

  it("B：半截 aborted 响应落盘并为可配对 call 合成 not_executed", async () => {
    const partial = makeAssistantMessage([{ id: "a", name: "read" }], "half", {
      stopReason: "aborted",
    });
    const f = await cancelFixture(async (cancel) => {
      cancel();
      throw new TurnError("cancelled", 1, "Turn aborted", partial);
    });
    await expect(f.controller.submitPrompt("q")).resolves.toBe("cancelled");
    const records = (await f.store.loadSession(f.ref)).records;
    expect(records.map((r) => r.type)).toEqual([
      "user_prompt",
      "run_started",
      "assistant_message",
      "tool_result",
      "run_finished",
    ]);
    const assistant = records.find((r) => r.type === "assistant_message");
    expect(assistant?.type === "assistant_message" && assistant.message.stopReason).toBe("aborted");
    expect(records.find((r) => r.type === "tool_result")).toMatchObject({
      toolCallId: "a",
      status: "not_executed",
      content: "Error: Cancelled by user.",
    });
  });

  it("B：无实质内容的 partial 不落盘 assistant", async () => {
    const partial = makeAssistantMessage([], "", { stopReason: "aborted" });
    const f = await cancelFixture(async (cancel) => {
      cancel();
      throw new TurnError("cancelled", 1, "Turn aborted", partial);
    });
    await expect(f.controller.submitPrompt("q")).resolves.toBe("cancelled");
    const records = (await f.store.loadSession(f.ref)).records;
    expect(records.map((r) => r.type)).toEqual(["user_prompt", "run_started", "run_finished"]);
  });

  it("B：半截 call（空 id）留 History 但不合成结果", async () => {
    const partial = makeAssistantMessage([{ id: "", name: "read" }], "half", {
      stopReason: "aborted",
    });
    const f = await cancelFixture(async (cancel) => {
      cancel();
      throw new TurnError("cancelled", 1, "Turn aborted", partial);
    });
    await expect(f.controller.submitPrompt("q")).resolves.toBe("cancelled");
    const records = (await f.store.loadSession(f.ref)).records;
    expect(records.some((r) => r.type === "assistant_message")).toBe(true);
    expect(records.some((r) => r.type === "tool_result")).toBe(false);
  });
});

it("creates no Session until the first accepted prompt and resets to blank without creating another", async () => {
  const { store } = makeStore();
  const session = await createAgentSession({
    store,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: tempDir(),
    getModel: () => model,
    getSettings: () => parseSettings({}),
    modelService: { streamTurn: async () => turn(makeAssistantMessage([], "done")) },
  });
  expect(session.controller.getSnapshot().session.ref).toBeNull();
  await session.controller.newSession();
  expect(await store.listSessions(WORKSPACE_ID)).toEqual([]);
  await session.controller.submitPrompt("first");
  const ref = session.controller.getSnapshot().session.ref!;
  expect((await store.loadSession(ref)).records.map((r) => r.type)).toEqual([
    "user_prompt",
    "run_started",
    "assistant_message",
    "run_finished",
  ]);
  await session.controller.newSession();
  expect(session.controller.getSnapshot().session.ref).toBeNull();
  expect(await session.controller.readHistory()).toBeNull();
  expect(await store.listSessions(WORKSPACE_ID)).toHaveLength(1);
  await session.controller.resumeSession(ref);
  expect(session.controller.getSnapshot().session.ref).toEqual(ref);
  expect(await store.listSessions(WORKSPACE_ID)).toHaveLength(1);
  await session.controller.exit();
});

it("derives Session titles and activity, hides valid empty history and reports occupation", async () => {
  const f = await fixture([makeAssistantMessage([], "done")]);
  await f.store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "old-empty" });
  await f.controller.submitPrompt("\n第一条任务\nmore");
  expect(f.controller.getSnapshot().session.title).toBe("第一条任务");
  expect(await f.controller.listSessions()).toEqual([
    expect.objectContaining({
      sessionId: "loop",
      title: "第一条任务",
      preview: "\n第一条任务\nmore",
      occupied: true,
      runCount: 1,
      lastActiveAt: expect.any(String),
    }),
  ]);
  await f.controller.newSession();
  expect(f.controller.getSnapshot().session.title).toBeNull();
  expect((await f.controller.listSessions())[0]?.occupied).toBe(false);
});

it("finishes cancelled initialization before adopting identity and never calls the Provider", async () => {
  let entered!: () => void;
  let finish!: () => void;
  let requests = 0;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pause = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { store } = makeStore({
    hooks: {
      beforeAppend: async (info) => {
        if (info.type === "user_prompt") {
          entered();
          await pause;
        }
      },
    },
  });
  const { controller } = await createAgentSession({
    store,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: tempDir(),
    getModel: () => model,
    getSettings: () => parseSettings({}),
    modelService: {
      streamTurn: async () => {
        requests++;
        return turn(makeAssistantMessage([]));
      },
    },
  });
  const events: string[] = [];
  controller.eventBus.subscribe((event) => {
    events.push(event.type);
  });
  const run = controller.submitPrompt("first");
  await ready;
  expect(controller.getSnapshot().session.ref).toBeNull();
  controller.cancel();
  finish();
  expect(await run).toBe("cancelled");
  expect(requests).toBe(0);
  const ref = controller.getSnapshot().session.ref!;
  expect((await store.loadSession(ref)).records.map((r) => r.type)).toEqual([
    "user_prompt",
    "run_started",
    "run_finished",
  ]);
  expect(events.filter((e) => e === "run.finished")).toHaveLength(1);
  await controller.exit();
});

it("leaves no adopted identity or Provider request after initial record failure", async () => {
  const { store } = makeStore({
    hooks: {
      beforeAppend: () => {
        throw new Error("injected disk failure");
      },
    },
  });
  let requests = 0;
  const { controller } = await createAgentSession({
    store,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: tempDir(),
    getModel: () => model,
    getSettings: () => parseSettings({}),
    modelService: {
      streamTurn: async () => {
        requests++;
        return turn(makeAssistantMessage([]));
      },
    },
  });
  expect(await controller.submitPrompt("first")).toBe("failed");
  expect(controller.getSnapshot().session.ref).toBeNull();
  expect(controller.getSnapshot().lastRun?.persisted).toBe(false);
  expect(requests).toBe(0);
  expect(await store.listSessions(WORKSPACE_ID)).toEqual([]);
  await controller.exit();
});

it("counts one Run per submitPrompt across multiple turns", async () => {
  const f = await fixture([makeAssistantMessage([], "a"), makeAssistantMessage([], "b")]);
  await f.controller.submitPrompt("first");
  await f.controller.submitPrompt("second");
  const entries = await f.controller.listSessions();
  expect(entries).toHaveLength(1);
  expect(entries[0]?.runCount).toBe(2);
  expect(
    (await f.store.loadSession(f.ref)).records.filter((record) => record.type === "run_started"),
  ).toHaveLength(2);
});

it("counts a tool-heavy Run once", async () => {
  const f = await fixture([
    makeAssistantMessage([{ id: "a", name: "read", arguments: { path: "missing.txt" } }]),
    makeAssistantMessage([], "done"),
  ]);
  await f.controller.submitPrompt("task");
  expect((await f.controller.listSessions())[0]?.runCount).toBe(1);
  const records = (await f.store.loadSession(f.ref)).records;
  expect(records.filter((record) => record.type === "tool_result")).toHaveLength(1);
  expect(records.filter((record) => record.type === "assistant_message")).toHaveLength(2);
});

it("counts a turn-limited Run once", async () => {
  const f = await fixture([makeAssistantMessage([], "never")], 1);
  await f.controller.submitPrompt("task");
  expect((await f.controller.listSessions())[0]?.runCount).toBe(1);
});

it("counts an unfinished Run and ignores browsing or resume", async () => {
  const f = await fixture([makeAssistantMessage([], "done")]);
  await f.controller.submitPrompt("first");
  const records = (await f.store.loadSession(f.ref)).records;
  const started = records.find((record) => record.type === "run_started");
  if (!started || started.type !== "run_started") throw new Error("missing run_started");
  const { recordSeq: _seq, ts: _ts, ...shape } = started;
  await f.store.appendRecord(f.ref, { ...shape, runId: "unfinished" } as never);
  expect((await f.controller.listSessions())[0]?.runCount).toBe(2);
  await f.controller.readHistory();
  await f.controller.newSession();
  await f.controller.resumeSession(f.ref);
  await f.controller.readHistory();
  expect((await f.controller.listSessions())[0]?.runCount).toBe(2);
});

it("counts a prompt-only history as one started Run", async () => {
  const f = await fixture([]);
  await f.store.appendRecord(f.ref, { type: "user_prompt", runId: "lost-start", text: "hello" } as never);
  expect((await f.controller.listSessions())[0]?.runCount).toBe(1);
});

it("counts prompts without a runId one by one", async () => {
  const f = await fixture([]);
  await f.store.appendRecord(f.ref, { type: "user_prompt", text: "a" } as never);
  await f.store.appendRecord(f.ref, { type: "user_prompt", text: "b" } as never);
  expect((await f.controller.listSessions())[0]?.runCount).toBe(2);
});

it("takes the larger of started and prompted run ids", async () => {
  const f = await fixture([makeAssistantMessage([], "done")]);
  await f.controller.submitPrompt("first");
  const records = (await f.store.loadSession(f.ref)).records;
  const started = records.find((record) => record.type === "run_started");
  if (!started || started.type !== "run_started") throw new Error("missing run_started");
  const { recordSeq: _seq, ts: _ts, ...shape } = started;
  // 孤立 run_started：started=2 > prompted=1
  await f.store.appendRecord(f.ref, { ...shape, runId: "orphan-start" } as never);
  expect((await f.controller.listSessions())[0]?.runCount).toBe(2);
  // 同 runId 的 prompt 不叠加：started=2 = prompted=2
  await f.store.appendRecord(f.ref, { type: "user_prompt", runId: "orphan-start", text: "second" } as never);
  expect((await f.controller.listSessions())[0]?.runCount).toBe(2);
  // 两条缺启动快照的 prompt：prompted=4 > started=2
  await f.store.appendRecord(f.ref, { type: "user_prompt", runId: "lost-3", text: "c" } as never);
  await f.store.appendRecord(f.ref, { type: "user_prompt", runId: "lost-4", text: "d" } as never);
  expect((await f.controller.listSessions())[0]?.runCount).toBe(4);
});

it("keeps blank session auto decision changes in memory and resets on new", async () => {
  const { store } = makeStore();
  const { controller } = await createAgentSession({
    store,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: tempDir(),
    decisionPrompt: { status: "ok", text: "decide" },
    getModel: () => model,
    getSettings: () => parseSettings({}),
    modelService: { streamTurn: async () => turn(makeAssistantMessage([], "done")) },
  });
  try {
    expect(await controller.getAutoDecisionStatus()).toEqual({ enabled: true, availability: "missing" });
    await controller.setAutoDecisionEnabled(false);
    expect(controller.getSnapshot().session.autoDecision.enabled).toBe(false);
    const snapshot = controller.getSnapshot();
    snapshot.session.autoDecision.enabled = true;
    expect(controller.getSnapshot().session.autoDecision.enabled).toBe(false);
    expect(await store.listSessions(WORKSPACE_ID)).toEqual([]);
    await controller.submitPrompt("hello");
    const ref = controller.getSnapshot().session.ref!;
    expect((await store.readSessionMeta(ref)).autoDecisionEnabled).toBe(false);
    await controller.newSession();
    expect((await controller.getAutoDecisionStatus()).enabled).toBe(true);
    await controller.resumeSession(ref);
    expect((await controller.getAutoDecisionStatus()).enabled).toBe(false);
  } finally {
    await controller.exit();
  }
});

it.each([false, true])(
  "reconciles failed auto decision saves (committed=%s) without false success",
  async (committed) => {
    const f = await fixture([]);
    const save = f.store.setAutoDecisionEnabled.bind(f.store);
    vi.spyOn(f.store, "setAutoDecisionEnabled").mockImplementation(async (ref, enabled) => {
      if (committed) await save(ref, enabled);
      throw new Error("save failed");
    });
    try {
      await expect(f.controller.setAutoDecisionEnabled(false)).rejects.toThrow("save failed");
      expect(f.controller.getSnapshot().session.autoDecision.enabled).toBe(!committed);
      await expect(f.controller.submitPrompt("run")).resolves.toBe("failed");
    } finally {
      await f.controller.exit();
    }
  },
);
it("blocks new Runs only while failed save reconciliation remains unresolved", async () => {
  const f = await fixture([]);
  vi.spyOn(f.store, "setAutoDecisionEnabled").mockRejectedValue(new Error("save failed"));
  const read = vi.spyOn(f.store, "readSessionMeta").mockRejectedValue(new Error("read failed"));
  try {
    await expect(f.controller.setAutoDecisionEnabled(false)).rejects.toThrow("save failed");
    expect(() => f.controller.submitPrompt("run")).toThrow("reload Session metadata");
    await expect(f.controller.getAutoDecisionStatus()).rejects.toThrow("read failed");
    read.mockRestore();
    expect((await f.controller.getAutoDecisionStatus()).enabled).toBe(true);
  } finally {
    await f.controller.exit();
  }
});
it("sends only the current Turn full text and write path to the decision service", async () => {
  const { store } = makeStore();
  const root = tempDir();
  const message = makeAssistantMessage([
    { id: "w", name: "write", arguments: { path: "a.txt", content: "secret content" } },
  ]);
  message.content.unshift(
    { type: "text", text: "first" },
    { type: "thinking", thinking: "private" },
    { type: "text", text: "second" },
  );
  const bodies: unknown[] = [];
  const { controller } = await createAgentSession({
    store,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: root,
    getModel: () => model,
    getSettings: () => parseSettings({ maxTurns: 1 }),
    decisionConfig: { status: "ok", config: { base_url: "http://localhost:1" }, secrets: [] },
    decisionPrompt: { status: "ok", text: "decide" },
    decisionFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (typeof body.state === "string")
        return new Response(
          JSON.stringify({ answers: { approval: { type: "choice", choice: "allow_once" } } }),
        );
      bodies.push(body);
      return new Response(
        JSON.stringify({ answers: { approval: { type: "choice", choice: "allow_once" } } }),
      );
    },
    modelService: { streamTurn: async () => turn(message) },
  });
  try {
    await expect(controller.submitPrompt("original task")).resolves.toBe("turn_limit");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      state: {
        user_task: "original task",
        agent_intent: "first\nsecond\nok",
        tool: "write",
        arguments: { path: "a.txt" },
        project_root: root,
      },
    });
    expect(JSON.stringify(bodies)).not.toContain("secret content");
    expect(JSON.stringify(bodies)).not.toContain("private");
  } finally {
    await controller.exit();
  }
});

it.each([false, true])(
  "keeps full bash input and never spawns after denial/cancellation (cancel=%s)",
  async (cancel) => {
    const { store } = makeStore();
    const command = "echo one\necho two | cat > result.txt && echo $(pwd)";
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    let body: { state: Record<string, unknown> } | undefined;
    const spawnProcess = vi.fn();
    const { controller } = await createAgentSession({
      store,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: tempDir(),
      getModel: () => model,
      getSettings: () => parseSettings({ maxTurns: 1 }),
      decisionConfig: { status: "ok", config: { base_url: "http://localhost:1" }, secrets: [] },
      decisionPrompt: { status: "ok", text: "decide" },
      executorOptions: { spawnProcess },
      decisionFetch: async (_url, init) => {
        const parsed = JSON.parse(String(init?.body));
        if (typeof parsed.state === "string")
          return new Response(
            JSON.stringify({ answers: { approval: { type: "choice", choice: "allow_once" } } }),
          );
        body = parsed;
        started();
        if (cancel) return new Promise<Response>(() => {});
        return new Response(
          JSON.stringify({ answers: { approval: { type: "choice", choice: "ask_user" } } }),
        );
      },
      modelService: {
        streamTurn: async () =>
          turn(
            makeAssistantMessage([{ id: "b", name: "bash", arguments: { command, timeout: 123 } }], "intent"),
          ),
      },
    });
    const subscription = controller.subscribe((event) => {
      if (event.type === "permission.requested") controller.resolveApproval(event.approvalId, "deny");
    });
    try {
      const run = controller.submitPrompt("task");
      await requested;
      if (cancel) controller.cancel();
      await expect(run).resolves.toBe(cancel ? "cancelled" : "turn_limit");
      expect(body?.state.arguments).toEqual({ command, timeout: 123 });
      expect(body?.state).not.toHaveProperty("resolved_paths");
      expect(body?.state).not.toHaveProperty("touches_outside_workspace");
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(controller.getSnapshot().pendingApproval).toBeNull();
    } finally {
      subscription.unsubscribe();
      await controller.exit();
    }
  },
);

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const approvalAnswer = { answers: { approval: { type: "choice", choice: "allow_once" } } };

async function probeFixture(options: {
  probe: (init: RequestInit | undefined) => Promise<Response>;
  streamTurn?: (options: StreamTurnOptions) => Promise<TurnResult>;
  maxTurns?: number;
  ref?: ReturnType<typeof sessionRef>;
  decision?: (init: RequestInit | undefined) => Promise<Response>;
}) {
  const { store } = makeStore();
  const root = tempDir();
  const warnings: Array<Record<string, unknown>> = [];
  const probeBodies: Array<Record<string, unknown>> = [];
  const decisionBodies: Array<Record<string, unknown>> = [];
  const { controller } = await createAgentSession({
    store,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: root,
    ref: options.ref,
    getModel: () => model,
    getSettings: () => parseSettings({ maxTurns: options.maxTurns ?? 1 }),
    decisionConfig: {
      status: "ok",
      config: { base_url: "http://localhost:1", model: "configured" },
      secrets: [],
    },
    decisionPrompt: { status: "ok", text: "decide" },
    decisionFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (typeof body.state === "string") {
        probeBodies.push(body);
        return options.probe(init);
      }
      decisionBodies.push(body);
      return options.decision ? options.decision(init) : Response.json(approvalAnswer);
    },
    modelService: {
      streamTurn: options.streamTurn ?? (async () => turn(makeAssistantMessage([], "done"))),
    },
    onWarning: (warning) => warnings.push(warning as Record<string, unknown>),
  });
  return { store, root, controller, warnings, probeBodies, decisionBodies };
}

function deferredProbes() {
  const probes: Array<{
    resolve: (response: Response) => void;
    promise: Promise<Response>;
    signal: AbortSignal | undefined;
  }> = [];
  const probe = (init: RequestInit | undefined) => {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((r) => (resolve = r));
    probes.push({ resolve, promise, signal: init?.signal ?? undefined });
    return promise;
  };
  return { probes, probe };
}

it("disables auto decision on a confirmed name mismatch and falls back to manual approval", async () => {
  const f = await probeFixture({
    probe: async () => Response.json({ ...approvalAnswer, model: "served" }),
    streamTurn: async () =>
      turn(makeAssistantMessage([{ id: "w", name: "write", arguments: { path: "a.txt", content: "x" } }])),
  });
  try {
    await vi.waitFor(() =>
      expect(f.controller.getSnapshot().session.autoDecision.availability).toBe("unavailable"),
    );
    const status = f.controller.getSnapshot().session.autoDecision;
    expect(status.enabled).toBe(true);
    expect(status.message).toContain("configured");
    expect(status.message).toContain("served");
    expect(f.warnings).toContainEqual(
      expect.objectContaining({ kind: "decision_probe", category: "unavailable" }),
    );
    f.controller.subscribe((e) => {
      if (e.type === "permission.requested") f.controller.resolveApproval(e.approvalId, "deny");
    });
    await expect(f.controller.submitPrompt("task")).resolves.toBe("turn_limit");
    expect(f.decisionBodies).toHaveLength(0);
    const ref = f.controller.getSnapshot().session.ref!;
    expect((await f.store.readSessionMeta(ref)).autoDecisionEnabled).toBe(true);
    const records = (await f.store.loadSession(ref)).records;
    expect(records.find((r) => r.type === "tool_result")).toMatchObject({ status: "denied" });
    expect(JSON.stringify(records)).not.toContain("ShanaAgent decision probe");
  } finally {
    await f.controller.exit();
  }
});

it("disables auto decision when the service is not a decision model (501)", async () => {
  const f = await probeFixture({
    probe: async () => new Response(JSON.stringify(approvalAnswer), { status: 501 }),
  });
  try {
    await vi.waitFor(() =>
      expect(f.controller.getSnapshot().session.autoDecision.availability).toBe("unavailable"),
    );
    expect(f.controller.getSnapshot().session.autoDecision.message).toBeTruthy();
    expect(f.warnings).toContainEqual(
      expect.objectContaining({ kind: "decision_probe", category: "unavailable" }),
    );
  } finally {
    await f.controller.exit();
  }
});

it.each([
  ["a name match", async () => Response.json({ ...approvalAnswer, model: "configured" })],
  ["missing response model", async () => Response.json(approvalAnswer)],
  ["HTTP 500", async () => new Response("err", { status: 500 })],
  [
    "a transport error",
    async () => {
      throw new Error("down");
    },
  ],
] as const)("keeps ready and stays silent when the probe sees %s", async (_label, probe) => {
  const f = await probeFixture({ probe });
  try {
    await vi.waitFor(() => expect(f.probeBodies).toHaveLength(1));
    await flush();
    expect(f.controller.getSnapshot().session.autoDecision.availability).toBe("ready");
    expect(f.warnings.filter((w) => w.kind === "decision_probe")).toHaveLength(0);
  } finally {
    await f.controller.exit();
  }
});

it.each(["missing config", "invalid config", "invalid prompt", "switch off"])(
  "skips the probe when %s",
  async (scenario) => {
    const { store } = makeStore();
    const decisionFetch = vi.fn<typeof fetch>();
    const ref = sessionRef("skip");
    if (scenario === "switch off")
      await store.createSession({
        workspaceId: WORKSPACE_ID,
        sessionId: ref.sessionId,
        autoDecisionEnabled: false,
      });
    const { controller } = await createAgentSession({
      store,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: tempDir(),
      ref: scenario === "switch off" ? ref : undefined,
      getModel: () => model,
      getSettings: () => parseSettings({}),
      decisionConfig:
        scenario === "missing config"
          ? undefined
          : scenario === "invalid config"
            ? { status: "invalid", message: "bad" }
            : { status: "ok", config: { base_url: "http://localhost:1" }, secrets: [] },
      decisionPrompt:
        scenario === "invalid prompt"
          ? { status: "invalid", message: "bad" }
          : { status: "ok", text: "decide" },
      decisionFetch,
      modelService: { streamTurn: async () => turn(makeAssistantMessage([], "done")) },
    });
    try {
      await flush();
      expect(decisionFetch).not.toHaveBeenCalled();
      expect(controller.getSnapshot().session.autoDecision.availability).not.toBe("unavailable");
    } finally {
      await controller.exit();
    }
  },
);

it("re-probes on /new and /resume, resetting availability optimistically", async () => {
  const { probes, probe } = deferredProbes();
  const f = await probeFixture({ probe });
  try {
    await vi.waitFor(() => expect(probes).toHaveLength(1));
    probes[0]!.resolve(Response.json({ ...approvalAnswer, model: "served" }));
    await vi.waitFor(() =>
      expect(f.controller.getSnapshot().session.autoDecision.availability).toBe("unavailable"),
    );
    await f.controller.newSession();
    expect(f.controller.getSnapshot().session.autoDecision.availability).toBe("ready");
    await vi.waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[0]!.signal?.aborted).toBe(true);
    probes[1]!.resolve(Response.json({ ...approvalAnswer, model: "configured" }));
    await flush();
    expect(f.controller.getSnapshot().session.autoDecision.availability).toBe("ready");
    expect(f.warnings.filter((w) => w.kind === "decision_probe")).toHaveLength(1);
    const target = sessionRef("resume-target");
    await f.store.createSession({ workspaceId: WORKSPACE_ID, sessionId: target.sessionId });
    await f.store.appendRecord(target, { type: "user_prompt", runId: "r", text: "hello" });
    await f.controller.resumeSession(target);
    expect(f.controller.getSnapshot().session.autoDecision.availability).toBe("ready");
    await vi.waitFor(() => expect(probes).toHaveLength(3));
    probes[2]!.resolve(Response.json({ ...approvalAnswer, model: "served" }));
    await vi.waitFor(() =>
      expect(f.controller.getSnapshot().session.autoDecision.availability).toBe("unavailable"),
    );
    expect(f.warnings.filter((w) => w.kind === "decision_probe")).toHaveLength(2);
  } finally {
    await f.controller.exit();
  }
});

it("recovers auto decision via /autodecision on and notifies", async () => {
  let probeModel = "served";
  const f = await probeFixture({
    probe: async () => Response.json({ ...approvalAnswer, model: probeModel }),
  });
  try {
    await vi.waitFor(() =>
      expect(f.controller.getSnapshot().session.autoDecision.availability).toBe("unavailable"),
    );
    await f.controller.setAutoDecisionEnabled(false);
    expect(f.controller.getSnapshot().session.autoDecision.enabled).toBe(false);
    const probesAfterOff = f.probeBodies.length;
    probeModel = "configured";
    await f.controller.setAutoDecisionEnabled(true);
    await vi.waitFor(() =>
      expect(f.controller.getSnapshot().session.autoDecision.availability).toBe("ready"),
    );
    expect(f.probeBodies.length).toBeGreaterThan(probesAfterOff);
    expect(f.warnings).toContainEqual(
      expect.objectContaining({ kind: "decision_probe", category: "recovered" }),
    );
  } finally {
    await f.controller.exit();
  }
});

it("freezes probe availability per Run so a mid-run mismatch only affects the next Run", async () => {
  let resolveProbe!: (response: Response) => void;
  const probePromise = new Promise<Response>((r) => (resolveProbe = r));
  let turns = 0;
  const approvals: string[] = [];
  const f = await probeFixture({
    probe: () => probePromise,
    streamTurn: async () => {
      turns += 1;
      if (turns === 1) {
        resolveProbe(Response.json({ ...approvalAnswer, model: "served" }));
        await flush();
      }
      return turn(
        makeAssistantMessage([{ id: `w${turns}`, name: "write", arguments: { path: "a.txt", content: "x" } }]),
      );
    },
  });
  try {
    f.controller.subscribe((e) => {
      if (e.type === "permission.requested") {
        approvals.push(e.approvalId);
        f.controller.resolveApproval(e.approvalId, "deny");
      }
    });
    await expect(f.controller.submitPrompt("one")).resolves.toBe("turn_limit");
    expect(approvals).toHaveLength(0);
    expect(f.decisionBodies).toHaveLength(1);
    expect(f.controller.getSnapshot().session.autoDecision.availability).toBe("unavailable");
    await expect(f.controller.submitPrompt("two")).resolves.toBe("turn_limit");
    expect(approvals).toHaveLength(1);
    expect(f.decisionBodies).toHaveLength(1);
  } finally {
    await f.controller.exit();
  }
});

it("discards a stale probe result superseded by /new", async () => {
  const { probes, probe } = deferredProbes();
  const f = await probeFixture({ probe });
  try {
    await vi.waitFor(() => expect(probes).toHaveLength(1));
    await f.controller.newSession();
    await vi.waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[0]!.signal?.aborted).toBe(true);
    probes[0]!.resolve(Response.json({ ...approvalAnswer, model: "served" }));
    await flush();
    expect(f.controller.getSnapshot().session.autoDecision.availability).toBe("ready");
    probes[1]!.resolve(Response.json({ ...approvalAnswer, model: "configured" }));
    await flush();
    expect(f.controller.getSnapshot().session.autoDecision.availability).toBe("ready");
    expect(f.warnings.filter((w) => w.kind === "decision_probe")).toHaveLength(0);
  } finally {
    await f.controller.exit();
  }
});

it("cancels an in-flight probe on exit without hanging", async () => {
  const probes: Array<{ signal: AbortSignal | undefined }> = [];
  const f = await probeFixture({
    probe: (init) => {
      probes.push({ signal: init?.signal ?? undefined });
      return new Promise<Response>(() => {});
    },
  });
  await vi.waitFor(() => expect(probes).toHaveLength(1));
  await f.controller.exit();
  expect(probes[0]!.signal?.aborted).toBe(true);
});

it("bash 实时输出经 tool.output.delta 上总线，持久化仍为最终裁剪结果", async () => {
  const { store } = makeStore();
  const fake = fakeShellRun();
  const { controller } = await createAgentSession({
    store,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: tempDir(),
    getModel: () => model,
    getSettings: () => parseSettings({ maxTurns: 1 }),
    executorOptions: { spawnProcess: fake.spawnProcess, terminateTree: fake.terminateTree },
    modelService: {
      streamTurn: async () =>
        turn(makeAssistantMessage([{ id: "b", name: "bash", arguments: { command: "long" } }], "intent")),
    },
  });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const deltas: Array<{ toolCallId: string; delta: string }> = [];
  const subscription = controller.subscribe((event) => {
    if (event.type === "permission.requested") controller.resolveApproval(event.approvalId, "once");
    if (event.type === "tool.output.delta")
      deltas.push({ toolCallId: event.toolCallId, delta: event.delta });
  });
  try {
    const run = controller.submitPrompt("task");
    const deadline = Date.now() + 5000;
    while (fake.spawnCalls.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.spawnCalls).toHaveLength(1);
    fake.child.stdout.write("live line\n");
    await flush();
    vi.advanceTimersByTime(SHELL_LIVE_OUTPUT_INTERVAL_MS);
    expect(deltas).toEqual([{ toolCallId: "b", delta: "live line\n" }]);
    fake.child.emit("close", 0);
    await expect(run).resolves.toBe("turn_limit");
    vi.advanceTimersByTime(SHELL_LIVE_OUTPUT_INTERVAL_MS * 3);
    expect(deltas).toHaveLength(1);
    const history = await controller.readHistory();
    expect(history?.records.map((record) => record.type)).toEqual([
      "user_prompt",
      "run_started",
      "assistant_message",
      "tool_result",
      "run_finished",
    ]);
    expect(history?.records.find((record) => record.type === "tool_result")).toMatchObject({
      toolCallId: "b",
      status: "success",
      content: "Exit code: 0\nStdout:\nlive line\nStderr:\n(no output)",
    });
  } finally {
    subscription.unsubscribe();
    vi.useRealTimers();
    await controller.exit();
  }
});
