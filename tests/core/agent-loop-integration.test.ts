import { TurnError } from "../../src/llm/model-service.js";
import type { SessionRef, SessionStore, SessionStoreHooks } from "../../src/sessions/session-store.js";
import {
  buildContext,
  estimateContextTokens,
  planEffectiveContext,
  wrapConversationSummary,
  CONTEXT_SAFETY_MARGIN_TOKENS,
} from "../../src/core/context-builder.js";
import type { BusEvent } from "../../src/core/events.js";
import { createToolRegistry } from "../../src/tools/registry.js";
import { Type } from "@earendil-works/pi-ai";
import { createDiagnostics } from "../../src/diagnostics.js";
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { fakeShellRun } from "../tools/helpers.js";
import { resumeSession } from "../../src/sessions/recovery.js";
import { afterEach, expect, it } from "vitest";
import { createAgentSession, type AgentSessionOptions } from "../../src/core/agent-loop.js";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import type { StreamTurnOptions, TurnResult } from "../../src/llm/model-service.js";
import { parseSettings, type Settings } from "../../src/llm/settings-store.js";
import {
  makeAssistantMessage,
  makeStore,
  metaPathOf,
  messagesPathOf,
  sessionRef,
  WORKSPACE_ID,
  tempDir,
  cleanupTempDirs,
} from "../sessions/helpers.js";
import type { SessionRecord, StoredAssistantMessage } from "../../src/sessions/records.js";

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
export async function fixture(
  messages: StoredAssistantMessage[],
  maxTurns = 40,
  overrides: Partial<AgentSessionOptions> = {},
  hooks?: SessionStoreHooks,
) {
  const { store } = makeStore({ hooks });
  const ref = sessionRef("loop");
  await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: ref.sessionId });
  const requests: StreamTurnOptions[] = [];
  const workspaceRoot = tempDir();
  const session = await createAgentSession({
    store,
    ref,
    workspaceId: ref.workspaceId,
    workspaceRoot,
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
    ...overrides,
  });
  return { ...session, store, ref, requests, workspaceRoot };
}
afterEach(cleanupTempDirs);

it("closes unknown batches and never executes remaining calls or starts another Turn", async () => {
  const fake = fakeShellRun({ kill: "unconfirmed" });
  const f = await fixture(
    [
      makeAssistantMessage([
        { id: "a", name: "bash", arguments: { command: "sleep", timeout: 1 } },
        { id: "b", name: "write", arguments: { path: "never.txt", content: "bad" } },
      ]),
    ],
    40,
    {
      executorOptions: {
        spawnProcess: fake.spawnProcess,
        terminateTree: fake.terminateTree,
        killConfirmTimeoutMs: 1,
      },
    },
  );
  f.controller.eventBus.subscribe((e) => {
    if (e.type === "permission.requested") f.controller.resolveApproval(e.approvalId, "once");
  });
  await expect(f.controller.submitPrompt("test")).resolves.toBe("failed");
  const results = (await f.store.loadSession(f.ref)).records.filter((r) => r.type === "tool_result");
  expect(results.map((r) => r.status)).toEqual(["unknown", "not_executed"]);
  expect(results[1]!.content).toBe("Error: Previous tool result is unknown. Not executed.");
  expect(fs.existsSync(path.join(f.workspaceRoot, "never.txt"))).toBe(false);
  expect(f.requests).toHaveLength(1);
  f.acknowledgeUnknownSideEffects();
  expect(() => f.controller.submitPrompt("again")).toThrow(/Shell termination/);
});

it.each(["assistant_message", "tool_result", "run_finished"] as const)(
  "handles %s persistence failure without replaying effects",
  async (failureType) => {
    const f = await fixture([
      makeAssistantMessage([{ id: "a", name: "write", arguments: { path: "a.txt", content: "written" } }]),
      makeAssistantMessage([], "done"),
    ]);
    const append = f.store.appendRecord.bind(f.store);
    vi.spyOn(f.store, "appendRecord").mockImplementation(async (ref, record) => {
      if (record.type === failureType) throw new Error("injected persistence failure");
      return append(ref, record);
    });
    let finishes = 0;
    let completions = 0;
    f.controller.eventBus.subscribe((e) => {
      if (e.type === "permission.requested") f.controller.resolveApproval(e.approvalId, "once");
      if (e.type === "run.finished") finishes++;
      if (e.type === "tool.completed") completions++;
    });
    await expect(f.controller.submitPrompt("write")).resolves.toBe("failed");
    expect(finishes).toBe(1);
    expect(fs.existsSync(path.join(f.workspaceRoot, "a.txt"))).toBe(failureType !== "assistant_message");
    if (failureType === "tool_result") expect(completions).toBe(0);
    if (failureType === "run_finished") expect(f.controller.getSnapshot().lastRun?.persisted).toBe(false);
  },
);

it("retains Session grants across models and drops them on real resume", async () => {
  let selected = structuredClone(model);
  const write = () =>
    makeAssistantMessage([{ id: "a", name: "write", arguments: { path: "a.txt", content: "written" } }]);
  const f = await fixture(
    [write(), makeAssistantMessage([], "done"), write(), makeAssistantMessage([], "done")],
    40,
    { getModel: () => selected },
  );
  let approvals = 0;
  f.controller.eventBus.subscribe((e) => {
    if (e.type === "permission.requested") {
      approvals++;
      f.controller.resolveApproval(e.approvalId, "session");
    }
  });
  await f.controller.submitPrompt("first");
  selected = { ...selected, id: "second" };
  await f.controller.submitPrompt("second");
  expect(approvals).toBe(1);
  await f.controller.exit();
  const resumed = await resumeSession(f.store, f.ref);
  const messages = [write(), makeAssistantMessage([], "done")];
  const next = await createAgentSession({
    store: f.store,
    workspaceId: f.ref.workspaceId,
    ref: { ...f.ref, sessionId: resumed.meta.sessionId },
    workspaceRoot: f.workspaceRoot,
    getModel: () => selected,
    getSettings: () => parseSettings({}),
    modelService: { streamTurn: async () => turn(messages.shift()!) },
  });
  next.controller.eventBus.subscribe((e) => {
    if (e.type === "permission.requested") {
      approvals++;
      next.controller.resolveApproval(e.approvalId, "once");
    }
  });
  await next.controller.submitPrompt("third");
  expect(approvals).toBe(2);
});

it.each(["terminated", "unconfirmed", "throws"] as const)(
  "Session exit retries pending Shell cleanup, outcome=%s",
  async (outcome) => {
    const succeeds = outcome === "terminated";
    const fake = fakeShellRun({ kill: "unconfirmed" });
    const unref = vi.fn();
    Object.assign(fake.child, { unref });
    let attempts = 0;
    const warnings: unknown[] = [];
    const terminateTree = vi.fn(async () => {
      attempts++;
      if (attempts === 2 && outcome === "throws") throw new Error("injected cleanup failure");
      if (attempts === 2 && succeeds) {
        fake.child.emit("close", null);
        return "terminated" as const;
      }
      return "unconfirmed" as const;
    });
    const f = await fixture(
      [makeAssistantMessage([{ id: "s", name: "bash", arguments: { command: "sleep", timeout: 1 } }])],
      40,
      {
        executorOptions: { spawnProcess: fake.spawnProcess, terminateTree, killConfirmTimeoutMs: 1 },
        onWarning: (warning) => warnings.push(warning),
      },
    );
    f.controller.eventBus.subscribe((e) => {
      if (e.type === "permission.requested") f.controller.resolveApproval(e.approvalId, "once");
    });
    await f.controller.submitPrompt("run");
    const before = (await f.store.loadSession(f.ref)).records;
    await Promise.all([f.controller.exit(), f.controller.exit()]);
    expect(terminateTree).toHaveBeenCalledTimes(2);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(fake.child.stdout.destroyed).toBe(true);
    expect(fake.child.stderr.destroyed).toBe(true);
    expect(fake.child.listenerCount("close")).toBe(0);
    expect(fake.child.listenerCount("error")).toBe(0);
    expect(fake.child.stdout.listenerCount("data")).toBe(0);
    expect(fake.child.stderr.listenerCount("data")).toBe(0);
    expect(warnings.some((w) => (w as { kind: string }).kind === "shell_cleanup_unconfirmed")).toBe(
      !succeeds,
    );
    expect((await f.store.loadSession(f.ref)).records).toEqual(before);
    expect(() => f.controller.submitPrompt("closed")).toThrow(/closed/);
  },
);

it("exit cancels an active Shell before final Session cleanup", async () => {
  const fake = fakeShellRun();
  const f = await fixture(
    [makeAssistantMessage([{ id: "s", name: "bash", arguments: { command: "sleep" } }])],
    40,
    {
      executorOptions: { spawnProcess: fake.spawnProcess, terminateTree: fake.terminateTree },
    },
  );
  f.controller.eventBus.subscribe((e) => {
    if (e.type === "permission.requested") f.controller.resolveApproval(e.approvalId, "once");
  });
  const run = f.controller.submitPrompt("run");
  await vi.waitFor(() => expect(fake.spawnCalls).toHaveLength(1));
  await f.controller.exit();
  expect(await run).toBe("cancelled");
  expect(fake.terminationCalls).toHaveLength(1);
  expect(fake.child.stdout.destroyed).toBe(true);
});

it("Session exit never retries termination using an already closed parent's identity", async () => {
  const fake = fakeShellRun({ kill: "unconfirmed" });
  const unref = vi.fn();
  Object.assign(fake.child, { unref });
  const warnings: unknown[] = [];
  const f = await fixture(
    [makeAssistantMessage([{ id: "s", name: "bash", arguments: { command: "sleep", timeout: 1 } }])],
    40,
    {
      executorOptions: {
        spawnProcess: fake.spawnProcess,
        terminateTree: fake.terminateTree,
        killConfirmTimeoutMs: 1,
      },
      onWarning: (warning) => warnings.push(warning),
    },
  );
  f.controller.eventBus.subscribe((e) => {
    if (e.type === "permission.requested") f.controller.resolveApproval(e.approvalId, "once");
  });
  await f.controller.submitPrompt("run");
  fake.child.emit("close", 0);
  await f.controller.exit();
  expect(fake.terminationCalls).toHaveLength(1);
  expect(unref).toHaveBeenCalledTimes(1);
  expect(warnings).toContainEqual(expect.objectContaining({ kind: "shell_cleanup_unconfirmed" }));
});

it("freezes model and settings before any run.started listener runs", async () => {
  const selected = structuredClone(model);
  const settings = parseSettings({ maxTurns: 2 });
  const f = await fixture([makeAssistantMessage([], "done")], 40, {
    getModel: () => selected,
    getSettings: () => settings,
  });
  f.controller.eventBus.subscribe((event) => {
    if (event.type === "run.started") {
      selected.id = "later-model";
      settings.maxTurns = 1;
    }
  });
  await f.controller.submitPrompt("test");
  expect(f.requests[0]!.model.id).toBe("m");
  expect((await f.store.loadSession(f.ref)).records.find((r) => r.type === "run_started")).toMatchObject({
    model: { modelId: "m" },
    settings: { maxTurns: 2 },
  });
});

it("rejects missing ID without inventing tool results", async () => {
  const id = "";
  const f = await fixture([makeAssistantMessage([{ id, name: "read" }])]);
  expect(await f.controller.submitPrompt("test")).toBe("failed");
  expect((await f.store.loadSession(f.ref)).records.some((r) => r.type === "tool_result")).toBe(false);
});

it("excludes a truncated plain response from future effective context", async () => {
  const f = await fixture([makeAssistantMessage([], "partial", { stopReason: "length" })]);
  expect(await f.controller.submitPrompt("test")).toBe("failed");
  const plan = planEffectiveContext((await f.store.loadSession(f.ref)).records);
  expect(plan.runs.flatMap((r) => r.turns)).toHaveLength(0);
});

it.each(["stream_error", "context_overflow"] as const)(
  "handles %s without an extra logical request or committed partial response",
  async (kind) => {
    let requests = 0;
    const f = await fixture([], 40, {
      modelService: {
        streamTurn: async () => {
          requests++;
          throw new TurnError(kind, 1, "injected");
        },
      },
    });
    let reported = "";
    f.controller.eventBus.subscribe((e) => {
      if (e.type === "run.finished") reported = e.error ?? "";
    });
    expect(await f.controller.submitPrompt("test")).toBe("failed");
    expect(requests).toBe(1);
    expect((await f.store.loadSession(f.ref)).records.some((r) => r.type === "assistant_message")).toBe(
      false,
    );
    if (kind === "context_overflow") expect(reported).toContain("/compact");
  },
);

for (const recordType of ["assistant_message", "tool_result"] as const) {
  for (const stage of ["afterWrite", "afterSync"] as const) {
    it(`cancels during ${recordType} ${stage} without abandoning the committed batch`, async () => {
      let injected = false;
      const f = await fixture(
        [
          makeAssistantMessage([
            { id: "a", name: "read", arguments: { path: "missing" } },
            { id: "b", name: "read", arguments: { path: "missing" } },
          ]),
        ],
        1,
        {},
        {
          [stage]: (info: { type: string }) => {
            if (info.type === recordType && !injected) {
              injected = true;
              controller.cancel();
            }
          },
        },
      );
      const controller = f.controller;
      let finishes = 0;
      controller.eventBus.subscribe((e) => {
        if (e.type === "run.finished") finishes++;
      });
      expect(await controller.submitPrompt("test")).toBe("cancelled");
      const records = (await f.store.loadSession(f.ref)).records;
      expect(records.filter((r) => r.type === "tool_result").map((r) => r.status)).toEqual(
        recordType === "assistant_message" ? ["not_executed", "not_executed"] : ["error", "not_executed"],
      );
      expect(records.at(-1)).toMatchObject({ type: "run_finished", outcome: "cancelled" });
      expect(finishes).toBe(1);
    });
  }
}

it("SDK retry attempts do not consume logical Turns at the limit", async () => {
  let requests = 0;
  const f = await fixture([], 1, {
    modelService: {
      streamTurn: async () => {
        requests++;
        return {
          ...turn(makeAssistantMessage([{ id: "a", name: "read", arguments: { path: "missing" } }])),
          attempts: 3,
        };
      },
    },
  });
  expect(await f.controller.submitPrompt("test")).toBe("turn_limit");
  expect(requests).toBe(1);
  expect((await f.store.loadSession(f.ref)).records.filter((r) => r.type === "tool_result")).toHaveLength(1);
});

it("restored missing-result acknowledgement survives an unrelated later failure", async () => {
  const f = await fixture([]);
  await f.store.appendRecord(f.ref, { type: "user_prompt", runId: "old", text: "old task" });
  await f.store.appendRecord(f.ref, {
    type: "assistant_message",
    runId: "old",
    message: makeAssistantMessage([{ id: "old-call", name: "read", arguments: { path: "missing" } }]),
  });
  let requests = 0;
  const restored = await createAgentSession({
    store: f.store,
    workspaceId: f.ref.workspaceId,
    ref: f.ref,
    workspaceRoot: f.workspaceRoot,
    getModel: () => model,
    getSettings: () => parseSettings({}),
    modelService: {
      streamTurn: async (options) => {
        requests++;
        // 缺结果 Turn 受控进入：合成 unknown 占位 + 询问标注（门控仍先拦截新 Run）。
        const context = JSON.stringify(options.context.messages);
        expect(context).toContain("old-call");
        expect(context).toContain("Ask the user to verify");
        if (requests === 1) throw new TurnError("stream_error", 1, "temporary failure");
        return turn(makeAssistantMessage([], "done"));
      },
    },
  });
  expect(() => restored.controller.submitPrompt("first")).toThrow();
  expect(requests).toBe(0);
  restored.acknowledgeUnknownSideEffects();
  expect(await restored.controller.submitPrompt("first")).toBe("failed");
  expect(await restored.controller.submitPrompt("second")).toBe("completed");
});

it("isolates retry text and thinking while retaining failed attempts for display", async () => {
  const f = await fixture([], 1, {
    modelService: {
      streamTurn: async (options) => {
        options.onEvent?.({ type: "text_delta", attempt: 1, delta: "FAILED" });
        options.onEvent?.({ type: "thinking_delta", attempt: 1, delta: "FAILED_THINKING" });
        options.onEvent?.({ type: "attempt_failed", attempt: 1, errorMessage: "retry", nextDelayMs: 1 });
        options.onEvent?.({ type: "text_delta", attempt: 2, delta: "SUCCESS" });
        options.onEvent?.({ type: "thinking_delta", attempt: 2, delta: "SUCCESS_THINKING" });
        return { ...turn(makeAssistantMessage([], "SUCCESS")), attempts: 2 };
      },
    },
  });
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  const snapshot = f.controller.getSnapshot();
  expect(snapshot.accumulatedText).toBe("SUCCESS");
  expect(snapshot.accumulatedThinking).toBe("SUCCESS_THINKING");
  expect(
    snapshot.streamingAttempts.map((a) => ({ attempt: a.attempt, status: a.status, text: a.text })),
  ).toEqual([
    { attempt: 1, status: "failed", text: "FAILED" },
    { attempt: 2, status: "completed", text: "SUCCESS" },
  ]);
  expect(JSON.stringify((await f.store.loadSession(f.ref)).records)).not.toContain("FAILED");
});

it("marks a cancelled streaming attempt without persisting or feeding it to the next Run", async () => {
  const requests: string[] = [];
  const f = await fixture([makeAssistantMessage([], "done")], 40, {
    modelService: {
      streamTurn: async (options) => {
        requests.push(JSON.stringify(options.context.messages));
        if (requests.length === 1) {
          options.onEvent?.({ type: "text_delta", attempt: 1, delta: "CANCELLED_FRAGMENT" });
          f.controller.cancel();
          throw new TurnError("cancelled", 1, "Run cancelled");
        }
        return turn(makeAssistantMessage([], "done"));
      },
    },
  });
  expect(await f.controller.submitPrompt("first")).toBe("cancelled");
  expect(f.controller.getSnapshot().streamingAttempts.at(-1)).toMatchObject({
    turn: 1,
    attempt: 1,
    status: "cancelled",
    text: "CANCELLED_FRAGMENT",
  });
  expect(
    (await f.store.loadSession(f.ref)).records.some((record) => record.type === "assistant_message"),
  ).toBe(false);
  expect(await f.controller.submitPrompt("second")).toBe("completed");
  expect(requests).toHaveLength(2);
  expect(requests[1]).not.toContain("CANCELLED_FRAGMENT");
});

it.each(["afterWrite", "afterSync"] as const)("freezes the outcome during terminal %s", async (stage) => {
  let cancelResult: unknown;
  const f = await fixture(
    [makeAssistantMessage([], "done")],
    40,
    {},
    {
      [stage]: (info: { type: string }) => {
        if (info.type === "run_finished") cancelResult = controller.cancel();
      },
    },
  );
  const controller = f.controller;
  expect(await controller.submitPrompt("test")).toBe("completed");
  expect(cancelResult).toBe("已进入收尾");
  expect((await f.store.loadSession(f.ref)).records.at(-1)).toMatchObject({ outcome: "completed" });
});

it("failed attempts of a later Turn do not erase earlier successful Turn text", async () => {
  let requests = 0;
  const f = await fixture([], 40, {
    modelService: {
      streamTurn: async (options) => {
        requests++;
        if (requests === 1) {
          options.onEvent?.({ type: "text_delta", attempt: 1, delta: "EARLIER" });
          return turn(
            makeAssistantMessage([{ id: "a", name: "read", arguments: { path: "missing" } }], "EARLIER"),
          );
        }
        options.onEvent?.({ type: "text_delta", attempt: 1, delta: "FAILED" });
        options.onEvent?.({ type: "attempt_failed", attempt: 1, errorMessage: "retry", nextDelayMs: 1 });
        options.onEvent?.({ type: "text_delta", attempt: 2, delta: "LATER" });
        return { ...turn(makeAssistantMessage([], "LATER")), attempts: 2 };
      },
    },
  });
  await f.controller.submitPrompt("test");
  expect(f.controller.getSnapshot().accumulatedText).toBe("EARLIERLATER");
  expect(f.controller.getSnapshot().streamingAttempts.map((a) => a.turn)).toEqual([1, 2, 2]);
});

it("freezes AGENTS.md for the whole Session", async () => {
  const workspaceRoot = tempDir();
  const file = path.join(workspaceRoot, "AGENTS.md");
  fs.writeFileSync(file, "RULE_ONE");
  let requests = 0;
  const f = await fixture([], 40, {
    workspaceRoot,
    modelService: {
      streamTurn: async (options) => {
        requests++;
        expect(options.context.systemPrompt).toContain("RULE_ONE");
        expect(options.context.systemPrompt).not.toContain("RULE_TWO");
        if (requests === 1) {
          fs.writeFileSync(file, "RULE_TWO");
          return turn(makeAssistantMessage([{ id: "a", name: "read", arguments: { path: "missing" } }]));
        }
        return turn(makeAssistantMessage([], "done"));
      },
    },
  });
  await f.controller.submitPrompt("first");
  await f.controller.submitPrompt("second");
  expect(requests).toBe(3);
});

it("exposes the fixed-overhead baseline before the first Run", async () => {
  const f = await fixture([]);
  const settings = parseSettings({ maxTurns: 40 });
  const built = await buildContext({ records: [], workspacePath: f.workspaceRoot });
  const expected = estimateContextTokens(
    {
      ...built.context,
      messages: [],
      tools: createToolRegistry(undefined, settings)
        .list()
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: Type.Unsafe(tool.parameters),
        })),
    },
    settings.tokenEstimate,
  );
  expect(f.controller.getSnapshot().session.contextBaselineTokens).toBe(expected);
  expect(expected).toBeGreaterThan(0);
});

it("keeps the baseline stable when AGENTS.md changes within the Session", async () => {
  const f = await fixture([makeAssistantMessage([], "done")]);
  const initial = f.controller.getSnapshot().session.contextBaselineTokens;
  fs.writeFileSync(path.join(f.workspaceRoot, "AGENTS.md"), "x".repeat(4000));
  expect(await f.controller.submitPrompt("work")).toBe("completed");
  const updated = f.controller.getSnapshot().session.contextBaselineTokens;
  expect(initial).not.toBeNull();
  expect(updated).toBe(initial);
});

it("reloads AGENTS.md after starting a new Session", async () => {
  const workspaceRoot = tempDir();
  const file = path.join(workspaceRoot, "AGENTS.md");
  fs.writeFileSync(file, "RULE_ONE");
  const prompts: string[] = [];
  const f = await fixture([], 40, {
    workspaceRoot,
    modelService: {
      streamTurn: async (options) => {
        prompts.push(options.context.systemPrompt ?? "");
        return turn(makeAssistantMessage([], "done"));
      },
    },
  });
  await f.controller.submitPrompt("first");
  fs.writeFileSync(file, "RULE_TWO");
  await f.controller.submitPrompt("second");
  expect(prompts[1]).toContain("RULE_ONE");
  expect(prompts[1]).not.toContain("RULE_TWO");
  await f.controller.newSession();
  expect(f.controller.getSnapshot().session.contextBaselineTokens).not.toBeNull();
  await f.controller.submitPrompt("third");
  expect(prompts[2]).toContain("RULE_TWO");
});

it("reloads AGENTS.md when resuming a Session", async () => {
  const workspaceRoot = tempDir();
  const file = path.join(workspaceRoot, "AGENTS.md");
  fs.writeFileSync(file, "RULE_ONE");
  const prompts: string[] = [];
  const f = await fixture([], 40, {
    workspaceRoot,
    modelService: {
      streamTurn: async (options) => {
        prompts.push(options.context.systemPrompt ?? "");
        return turn(makeAssistantMessage([], "done"));
      },
    },
  });
  await f.controller.submitPrompt("first");
  const original = f.ref;
  fs.writeFileSync(file, "RULE_TWO");
  await f.controller.newSession();
  await f.controller.resumeSession(original);
  await f.controller.submitPrompt("second");
  expect(prompts[1]).toContain("RULE_TWO");
});

it("records the AGENTS.md reference without a hash", async () => {
  const f = await fixture([makeAssistantMessage([], "done")]);
  expect(await f.controller.submitPrompt("work")).toBe("completed");
  const records = (await f.store.loadSession(f.ref)).records;
  const started = records.find((record) => record.type === "run_started");
  expect(started).toMatchObject({
    type: "run_started",
    agentsMd: { path: path.join(f.workspaceRoot, "AGENTS.md"), present: false },
  });
  expect(started?.type === "run_started" ? started.agentsMd : {}).not.toHaveProperty("sha256");
});

it("leaves the baseline unavailable without a startup warning when estimation fails", async () => {
  const warnings: unknown[] = [];
  const f = await fixture([], 40, {
    systemPrompt: "",
    onWarning: (warning) => warnings.push(warning),
  });
  expect(f.controller.getSnapshot().session.contextBaselineTokens).toBeNull();
  expect(warnings).toEqual([]);
});

it("a result persistence failure leaves effects intact and requires confirmation on restore", async () => {
  const f = await fixture([
    makeAssistantMessage([
      { id: "effect", name: "write", arguments: { path: "once.txt", content: "written" } },
    ]),
  ]);
  const append = f.store.appendRecord.bind(f.store);
  const spy = vi.spyOn(f.store, "appendRecord").mockImplementation(async (ref, record) => {
    if (record.type === "tool_result") throw new Error("injected failure after effect");
    return append(ref, record);
  });
  f.controller.eventBus.subscribe((e) => {
    if (e.type === "permission.requested") f.controller.resolveApproval(e.approvalId, "once");
  });
  expect(await f.controller.submitPrompt("write")).toBe("failed");
  spy.mockRestore();
  expect(fs.readFileSync(path.join(f.workspaceRoot, "once.txt"), "utf8")).toBe("written");
  let calls = 0;
  const restored = await createAgentSession({
    store: f.store,
    workspaceId: f.ref.workspaceId,
    ref: f.ref,
    workspaceRoot: f.workspaceRoot,
    getModel: () => model,
    getSettings: () => parseSettings({}),
    modelService: {
      streamTurn: async (options) => {
        calls++;
        // 结果落盘失败（效果已发生）：Turn 受控进入，占位明说"是否执行过未知"。
        const context = JSON.stringify(options.context.messages);
        expect(context).toContain("effect");
        expect(context).toContain("was not recorded");
        return turn(makeAssistantMessage([], "done"));
      },
    },
  });
  expect(() => restored.controller.submitPrompt("continue")).toThrow();
  expect(calls).toBe(0);
  restored.acknowledgeUnknownSideEffects();
  expect(await restored.controller.submitPrompt("continue")).toBe("completed");
  expect(calls).toBe(1);
  expect(fs.readFileSync(path.join(f.workspaceRoot, "once.txt"), "utf8")).toBe("written");
});

it("restores explicit unknown history, asks again for new missing results, and includes both Turns", async () => {
  const f = await fixture([]);
  await f.store.appendRecord(f.ref, { type: "user_prompt", runId: "old", text: "old task" });
  const owner = await f.store.appendRecord(f.ref, {
    type: "assistant_message",
    runId: "old",
    message: makeAssistantMessage([
      { id: "old-unknown", name: "write", arguments: { path: "old.txt", content: "x" } },
    ]),
  });
  await f.store.appendRecord(f.ref, {
    type: "tool_result",
    runId: "old",
    assistantRecordSeq: owner.recordSeq,
    toolCallId: "old-unknown",
    toolName: "write",
    status: "unknown",
    content: "unknown",
  });
  let requests = 0;
  const restored = await createAgentSession({
    store: f.store,
    workspaceId: f.ref.workspaceId,
    ref: f.ref,
    workspaceRoot: f.workspaceRoot,
    getModel: () => model,
    getSettings: () => parseSettings({}),
    modelService: {
      streamTurn: async (options) => {
        requests++;
        const context = JSON.stringify(options.context.messages);
        // 显式 unknown 与缺结果 Turn 均受控进入，附询问标注；新缺结果仍触发门控。
        expect(context).toContain("old-unknown");
        expect(context).toContain("Ask the user to verify");
        if (requests === 1) expect(context).not.toContain("new-missing");
        else expect(context).toContain("new-missing");
        return requests === 1
          ? turn(makeAssistantMessage([{ id: "new-missing", name: "read", arguments: { path: "missing" } }]))
          : turn(makeAssistantMessage([], "done"));
      },
    },
  });
  expect(() => restored.controller.submitPrompt("first")).toThrow();
  restored.acknowledgeUnknownSideEffects();
  const append = f.store.appendRecord.bind(f.store);
  const spy = vi.spyOn(f.store, "appendRecord").mockImplementation(async (ref, record) => {
    if (record.type === "tool_result") throw new Error("new result commit failure");
    return append(ref, record);
  });
  expect(await restored.controller.submitPrompt("first")).toBe("failed");
  spy.mockRestore();
  expect(() => restored.controller.submitPrompt("second")).toThrow();
  expect(requests).toBe(1);
  restored.acknowledgeUnknownSideEffects();
  expect(await restored.controller.submitPrompt("second")).toBe("completed");
});

it("cancel during the model response excludes uncommitted fragments and finishes once", async () => {
  const f = await fixture([], 40, {
    modelService: {
      streamTurn: async (options) => {
        options.onEvent?.({ type: "text_delta", attempt: 1, delta: "UNCOMMITTED" });
        cancel();
        throw new TurnError("stream_error", 1, "late transport failure");
      },
    },
  });
  const cancel = () => {
    f.controller.cancel();
  };
  let finishes = 0;
  f.controller.eventBus.subscribe((event) => {
    if (event.type === "run.finished") finishes++;
  });
  expect(await f.controller.submitPrompt("test")).toBe("cancelled");
  const records = (await f.store.loadSession(f.ref)).records;
  expect(records.some((r) => r.type === "assistant_message")).toBe(false);
  expect(planEffectiveContext(records).runs.flatMap((r) => r.turns)).toHaveLength(0);
  expect(finishes).toBe(1);
});

it("a length batch remains paired after loading and is eligible for replay", async () => {
  const f = await fixture([
    makeAssistantMessage(
      [{ id: "truncated", name: "write", arguments: { path: "never.txt", content: "x" } }],
      "",
      { stopReason: "length" },
    ),
    makeAssistantMessage([], "done"),
  ]);
  await f.controller.submitPrompt("test");
  const plan = planEffectiveContext((await f.store.loadSession(f.ref)).records);
  expect(plan.runs[0]!.turns[0]!.results[0]).toMatchObject({
    status: "not_executed",
    toolCallId: "truncated",
  });
  expect(fs.existsSync(path.join(f.workspaceRoot, "never.txt"))).toBe(false);
});

it("routes tool diagnostics to the configured logger without copying private error messages", async () => {
  const logsDir = tempDir();
  const diagnostics = createDiagnostics({ logsDir, minLevel: "debug", redact: (text) => text });
  const f = await fixture(
    [
      makeAssistantMessage([{ id: "a", name: "read", arguments: { path: "data.txt" } }]),
      makeAssistantMessage([], "done"),
    ],
    40,
    { diagnostics },
  );
  fs.writeFileSync(path.join(f.workspaceRoot, "data.txt"), "PRIVATE_FILE_CONTENT");
  const cause = Object.assign(new Error("PRIVATE_ARGUMENT_TEXT PRIVATE_FILE_CONTENT"), { code: "EACCES" });
  const spy = vi.spyOn(fs.promises, "stat").mockRejectedValueOnce(cause);
  try {
    expect(await f.controller.submitPrompt("read")).toBe("completed");
  } finally {
    spy.mockRestore();
  }
  const logs = fs
    .readdirSync(logsDir)
    .map((file) => fs.readFileSync(path.join(logsDir, file), "utf8"))
    .join("");
  expect(logs).toContain("read.stat");
  expect(logs).toContain("EACCES");
  expect(logs).not.toContain("PRIVATE_ARGUMENT_TEXT");
  expect(logs).not.toContain("PRIVATE_FILE_CONTENT");
  const history = JSON.stringify((await f.store.loadSession(f.ref)).records);
  expect(history).not.toContain("read.stat");
  expect(history).not.toContain("PRIVATE_ARGUMENT_TEXT");
});

it("commits a completed response even when cancellation arrives at the completed-attempt notification", async () => {
  const f = await fixture([makeAssistantMessage([], "committed despite cancel")]);
  f.controller.eventBus.subscribe((event) => {
    if (
      event.type === "run.state_changed" &&
      f.controller.getSnapshot().streamingAttempts.at(-1)?.status === "completed"
    )
      f.controller.cancel();
  });
  expect(await f.controller.submitPrompt("test")).toBe("cancelled");
  // A：完整生成的响应不因取消竞态丢弃，照常落盘。
  expect((await f.store.loadSession(f.ref)).records.some((r) => r.type === "assistant_message")).toBe(true);
});

it("rejects an empty tool name without fabricating results", async () => {
  const f = await fixture([makeAssistantMessage([{ id: "a", name: "" }])]);
  expect(await f.controller.submitPrompt("test")).toBe("failed");
  expect((await f.store.loadSession(f.ref)).records.some((r) => r.type === "tool_result")).toBe(false);
});

it("cancels an active unconfirmed Shell, records interruption, and includes the Turn with unknown annotation", async () => {
  const fake = fakeShellRun({ kill: "unconfirmed" });
  Object.assign(fake.child, { unref: vi.fn() });
  const f = await fixture(
    [
      makeAssistantMessage([
        { id: "s", name: "bash", arguments: { command: "sleep" } },
        { id: "later", name: "write", arguments: { path: "never.txt", content: "bad" } },
      ]),
    ],
    40,
    {
      executorOptions: {
        spawnProcess: fake.spawnProcess,
        terminateTree: fake.terminateTree,
        killConfirmTimeoutMs: 1,
      },
    },
  );
  f.controller.eventBus.subscribe((event) => {
    if (event.type === "permission.requested") f.controller.resolveApproval(event.approvalId, "once");
  });
  const run = f.controller.submitPrompt("test");
  await vi.waitFor(() => expect(fake.spawnCalls).toHaveLength(1));
  f.controller.cancel();
  expect(await run).toBe("cancelled");
  const records = (await f.store.loadSession(f.ref)).records;
  expect(records.filter((r) => r.type === "tool_result").map((r) => r.status)).toEqual([
    "unknown",
    "not_executed",
  ]);
  expect(records).toContainEqual(
    expect.objectContaining({ type: "interruption", toolCallId: "s", reason: "unknown_side_effect" }),
  );
  const turns = planEffectiveContext(records).runs.flatMap((r) => r.turns);
  expect(turns).toHaveLength(1);
  expect(turns[0]?.hasUnknown).toBe(true);
  expect(fs.existsSync(path.join(f.workspaceRoot, "never.txt"))).toBe(false);
  f.acknowledgeUnknownSideEffects();
  expect(() => f.controller.submitPrompt("again")).toThrow(/Shell termination/);
  await f.controller.exit();
});

it("T9 new/resume commands replace Session identity and reset grants", async () => {
  const write = () =>
    makeAssistantMessage([{ id: "a", name: "write", arguments: { path: "data.txt", content: "x" } }]);
  const f = await fixture([
    write(),
    makeAssistantMessage([], "done"),
    write(),
    makeAssistantMessage([], "done"),
  ]);
  let approvals = 0;
  f.controller.eventBus.subscribe((e) => {
    if (e.type === "permission.requested") {
      approvals++;
      f.controller.resolveApproval(e.approvalId, "session");
    }
  });
  await f.controller.submitPrompt("first");
  await f.controller.newSession();
  const fresh = f.controller.getSnapshot().session.ref!;
  expect(fresh).toBeNull();
  expect(await f.controller.readHistory()).toBeNull();
  await f.controller.submitPrompt("second");
  expect(approvals).toBe(2);
  await f.controller.resumeSession(f.ref);
  const resumed = f.controller.getSnapshot().session.ref!;
  expect(resumed.sessionId).toBe(f.ref.sessionId);
  expect((await f.store.loadSession(resumed)).meta.sourceSessionId).toBeUndefined();
  const sessions = await f.controller.listSessions();
  expect(sessions).toHaveLength(2);
  expect(sessions.find((session) => session.sessionId === f.ref.sessionId)).toMatchObject({
    runCount: 1,
  });
});

it("T9 model commands persist preferences but keep the active Run model frozen", async () => {
  const configPath = path.join(tempDir(), "model.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      current: { provider: "p", model: "first" },
      providers: {
        p: {
          api: "openai-completions",
          baseUrl: "https://fake.test",
          apiKey: "PRIVATE_KEY",
          models: ["first", "second"].map((id) => ({
            id,
            reasoning: true,
            thinking: true,
            compat: { thinkingFormat: "deepseek" },
            contextWindow: 10000,
            maxTokens: 1000,
          })),
        },
      },
    }),
  );
  let finish!: (value: TurnResult) => void;
  const f = await fixture([], 40, {
    modelConfigPath: configPath,
    modelService: {
      streamTurn: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  expect(JSON.stringify(f.controller.getSnapshot())).not.toContain("PRIVATE_KEY");
  await f.controller.switchModel("p", "second");
  expect(f.controller.getSnapshot().session.model?.modelId).toBe("second");
  const run = f.controller.submitPrompt("test");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await f.controller.setReasoningEffort("low");
  expect(f.controller.getSnapshot().session.runModel?.reasoningEffort).toBe("high");
  expect(f.controller.getSnapshot().session.model?.reasoningEffort).toBe("low");
  finish(turn(makeAssistantMessage([], "done")));
  await run;
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  expect(saved.current.model).toBe("second");
  expect(saved.providers.p.models[1].reasoningEffort).toBe("low");
  const before = fs.readFileSync(configPath, "utf8");
  await expect(f.controller.switchModel("p", "missing")).rejects.toThrow();
  expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  expect(f.controller.getSnapshot().session.model?.modelId).toBe("second");
});

it("reports truncated source warnings when listing and resuming a Session", async () => {
  const warnings: unknown[] = [];
  const f = await fixture([makeAssistantMessage([], "done"), makeAssistantMessage([], "next done")], 40, {
    onWarning: (warning) => {
      warnings.push(warning);
    },
  });
  await f.controller.submitPrompt("first");
  fs.appendFileSync(
    path.join(f.store.sessionsDir, f.ref.workspaceId, f.ref.sessionId, "messages.jsonl"),
    '{"type":',
  );
  const sourcePath = path.join(f.store.sessionsDir, f.ref.workspaceId, f.ref.sessionId, "messages.jsonl");
  const original = fs.readFileSync(sourcePath, "utf8");
  await f.controller.newSession();
  await f.controller.listSessions();
  expect(warnings).toContainEqual(expect.objectContaining({ kind: "tail_truncated" }));
  expect(fs.readFileSync(sourcePath, "utf8")).toBe(original);
  warnings.length = 0;
  await expect(f.controller.resumeSession(f.ref)).rejects.toThrow("拒绝续写");
  expect(f.controller.getSnapshot().session.ref).toBeNull();
  expect(fs.readFileSync(sourcePath, "utf8")).toBe(original);
  await f.controller.submitPrompt("continue");
  for (const warning of warnings) {
    const message = (warning as { message: string }).message;
    expect(JSON.stringify(f.requests.at(-1)?.context)).not.toContain(message);
  }
});

it("persists exactly the Core duration used for completed audit display", async () => {
  const f = await fixture([makeAssistantMessage([])]);
  await f.controller.submitPrompt("duration");
  const records = (await f.store.loadSession(f.ref)).records;
  expect(records.at(-1)).toMatchObject({
    type: "run_finished",
    elapsedMs: f.controller.getSnapshot().lastRun!.elapsedMs,
  });
});

it("serves TUI history from the committed memory snapshot without rereading disk", async () => {
  const f = await fixture([makeAssistantMessage([], "done")]);
  const read = vi.spyOn(f.store, "readHistory");
  const load = vi.spyOn(f.store, "loadSession");
  await f.controller.submitPrompt("hello");
  const history = await f.controller.readHistory();
  expect(history?.meta.sessionId).toBe(f.ref.sessionId);
  expect(read).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  const disk = fs
    .readFileSync(messagesPathOf(f.store.sessionsDir, f.ref), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  expect(history?.records).toEqual(disk);
});

it("returns an independent record array that later appends do not mutate", async () => {
  const f = await fixture([makeAssistantMessage([], "done"), makeAssistantMessage([], "again")]);
  await f.controller.submitPrompt("first");
  const first = await f.controller.readHistory();
  const second = await f.controller.readHistory();
  expect(first?.records).not.toBe(second?.records);
  expect(first?.records[0]).toBe(second?.records[0]);
  const length = first!.records.length;
  await f.controller.submitPrompt("second");
  expect(first?.records).toHaveLength(length);
  expect((await f.controller.readHistory())!.records.length).toBeGreaterThan(length);
});

it("resyncs from disk after an uncertain append before serving history", async () => {
  let fail = false;
  const f = await fixture(
    [makeAssistantMessage([], "done")],
    40,
    {},
    {
      afterSync: (info) => {
        if (fail && info.type === "assistant_message") throw new Error("injected sync failure");
      },
    },
  );
  fail = true;
  await expect(f.controller.submitPrompt("first")).resolves.toBe("failed");
  fail = false;
  const load = vi.spyOn(f.store, "loadSession");
  const history = await f.controller.readHistory();
  expect(load).toHaveBeenCalledTimes(1);
  expect(history!.records.filter((record) => record.type === "assistant_message")).toHaveLength(1);
  expect(history!.records.at(-1)?.type).toBe("run_finished");
});

it("recovers when the post-create verification load fails", async () => {
  const { store } = makeStore();
  const workspaceRoot = tempDir();
  const messages = [makeAssistantMessage([], "done")];
  const session = await createAgentSession({
    store,
    workspaceId: WORKSPACE_ID,
    workspaceRoot,
    getModel: () => model,
    getSettings: () => parseSettings({ maxTurns: 40 }),
    modelService: {
      streamTurn: async () => turn(messages.shift()!),
    },
  });
  const load = vi.spyOn(store, "loadSession").mockRejectedValueOnce(new Error("verification failed"));
  await expect(session.controller.submitPrompt("first")).resolves.toBe("failed");
  expect(load).toHaveBeenCalledTimes(1);
  expect(session.controller.getSnapshot().session.ref).not.toBeNull();
  const history = await session.controller.readHistory();
  expect(history?.records.map((record) => record.type)).toEqual(["user_prompt", "run_started"]);
  expect(load).toHaveBeenCalledTimes(2);
  await expect(session.controller.submitPrompt("second")).resolves.toBe("completed");
  expect((await session.controller.readHistory())?.records.at(-1)?.type).toBe("run_finished");
});

it("keeps restored Session meta in the memory snapshot after resume", async () => {
  const f = await fixture([makeAssistantMessage([], "done")]);
  await f.controller.submitPrompt("first");
  const metaPath = metaPathOf(f.store.sessionsDir, f.ref);
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  fs.writeFileSync(metaPath, JSON.stringify({ ...meta, sourceSessionId: "origin-session" }));
  await f.controller.newSession();
  await f.controller.resumeSession(f.ref);
  expect((await f.controller.readHistory())?.meta.sourceSessionId).toBe("origin-session");
});

function summaryTurn(text: string): TurnResult {
  return { ...turn(makeAssistantMessage([], text)), text };
}

async function compactionFixture(overrides: Partial<AgentSessionOptions> = {}) {
  const { store } = makeStore();
  const ref = sessionRef("compact-loop");
  await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: ref.sessionId });
  await store.appendRecord(ref, { type: "user_prompt", runId: "old", text: "old task" });
  const a1 = await store.appendRecord(ref, {
    type: "assistant_message",
    runId: "old",
    message: makeAssistantMessage([{ id: "c1", name: "read", arguments: { path: "a" } }]),
  });
  await store.appendRecord(ref, {
    type: "tool_result",
    runId: "old",
    assistantRecordSeq: a1.recordSeq,
    toolCallId: "c1",
    toolName: "read",
    status: "success",
    content: "first result",
  });
  const a2 = await store.appendRecord(ref, {
    type: "assistant_message",
    runId: "old",
    message: makeAssistantMessage([{ id: "c2", name: "read", arguments: { path: "b" } }]),
  });
  const r2 = await store.appendRecord(ref, {
    type: "tool_result",
    runId: "old",
    assistantRecordSeq: a2.recordSeq,
    toolCallId: "c2",
    toolName: "read",
    status: "success",
    content: "second result",
  });
  const requests: StreamTurnOptions[] = [];
  const session = await createAgentSession({
    store,
    ref,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: tempDir(),
    getModel: () => model,
    getSettings: () => parseSettings({}),
    modelService: {
      streamTurn: async (options) => {
        requests.push(options);
        return summaryTurn("SUMMARY");
      },
    },
    ...overrides,
  });
  return { ...session, store, ref, requests, lastSeq: r2.recordSeq };
}

it("manual compact without an open Session fails without creating one", async () => {
  const { store } = makeStore();
  const session = await createAgentSession({
    store,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: tempDir(),
    getModel: () => model,
    getSettings: () => parseSettings({}),
    modelService: {
      streamTurn: async () => {
        throw new Error("unexpected model request");
      },
    },
  });
  await expect(session.controller.compact()).rejects.toThrow("没有打开的 Session");
  expect(await store.listSessions(WORKSPACE_ID)).toEqual([]);
  expect(session.controller.getSnapshot().status).toEqual({ kind: "idle" });
});

it("manual compact covers all eligible turns without retaining a tail", async () => {
  const f = await compactionFixture();
  const outcome = await f.controller.compact();
  expect(outcome).toMatchObject({ status: "completed", coveredUpTo: f.lastSeq, path: "primary" });
  // 压后估算写入快照，供状态栏在实测过期时立即更新。
  expect(f.controller.getSnapshot().session.contextEstimateTokens).toBeGreaterThan(0);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]!.maxTokens).toBeUndefined();
  expect(f.requests[0]!.maxRetries).toBe(2);
  const instruction = f.requests[0]!.context.messages.at(-1)!;
  expect(instruction.role).toBe("user");
  expect((instruction as { content: string }).content).toContain("4096");
  const records = (await f.store.loadSession(f.ref)).records;
  const checkpoints = records.filter((r) => r.type === "checkpoint");
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0]).toMatchObject({ summary: "SUMMARY", coveredUpTo: f.lastSeq });
  expect(records.filter((r) => r.type === "user_prompt")).toHaveLength(1);
  expect(f.controller.getSnapshot().status).toEqual({ kind: "idle" });
});

it("manual compact freezes the default model at command start", async () => {
  let current = model;
  let captured: StreamTurnOptions | undefined;
  const f = await compactionFixture({
    getModel: () => current,
    modelService: {
      streamTurn: async (options) => {
        captured = options;
        current = { ...model, id: "switched", contextWindow: 64000 };
        return summaryTurn("SUMMARY");
      },
    },
  });
  await expect(f.controller.compact()).resolves.toMatchObject({ status: "completed" });
  expect(captured?.model.id).toBe("m");
  const records = (await f.store.loadSession(f.ref)).records;
  expect(records.find((r) => r.type === "checkpoint")).toMatchObject({
    model: { providerId: "p", modelId: "m" },
  });
});

it("cancelling during the summary request returns cancelled without a checkpoint", async () => {
  let started = false;
  let resolveTurn!: (result: TurnResult) => void;
  const f = await compactionFixture({
    modelService: {
      streamTurn: () =>
        new Promise<TurnResult>((resolve) => {
          started = true;
          resolveTurn = resolve;
        }),
    },
  });
  const compacting = f.controller.compact();
  await vi.waitFor(() => expect(started).toBe(true));
  f.controller.cancel();
  resolveTurn(summaryTurn("SUMMARY"));
  await expect(compacting).resolves.toMatchObject({ status: "cancelled", coveredUpTo: null });
  const records = (await f.store.loadSession(f.ref)).records;
  expect(records.some((r) => r.type === "checkpoint")).toBe(false);
  expect(f.controller.getSnapshot().status).toEqual({ kind: "idle" });
});

it("manual compact on an empty Session is a noop without a model request", async () => {
  const f = await fixture([]);
  await expect(f.controller.compact()).resolves.toMatchObject({ status: "noop", coveredUpTo: null });
  expect(f.requests).toHaveLength(0);
  expect((await f.store.loadSession(f.ref)).records).toHaveLength(0);
});

it("manual compact after a Run reuses the frozen system prompt and tool schemas byte-identically", async () => {
  const requests: StreamTurnOptions[] = [];
  let call = 0;
  const f = await fixture([], 40, {
    modelService: {
      streamTurn: async (options) => {
        requests.push(options);
        call += 1;
        return call === 1 ? turn(makeAssistantMessage([], "done")) : summaryTurn("SUMMARY");
      },
    },
  });
  expect(await f.controller.submitPrompt("work")).toBe("completed");
  fs.writeFileSync(path.join(f.workspaceRoot, "AGENTS.md"), "changed rules after the Run");
  await expect(f.controller.compact()).resolves.toMatchObject({ status: "completed" });
  expect(requests).toHaveLength(2);
  expect(requests[1]!.context.systemPrompt).toBe(requests[0]!.context.systemPrompt);
  expect(JSON.stringify(requests[1]!.context.tools)).toBe(JSON.stringify(requests[0]!.context.tools));
});

it("manual compact after resume without a new Run reloads the Session snapshot", async () => {
  const requests: StreamTurnOptions[] = [];
  let call = 0;
  const f = await fixture([], 40, {
    modelService: {
      streamTurn: async (options) => {
        requests.push(options);
        call += 1;
        return call === 1 ? turn(makeAssistantMessage([], "done")) : summaryTurn("SUMMARY");
      },
    },
  });
  expect(await f.controller.submitPrompt("work")).toBe("completed");
  fs.writeFileSync(path.join(f.workspaceRoot, "AGENTS.md"), "fresh rules for compaction");
  await f.controller.newSession();
  await f.controller.resumeSession(f.ref);
  await expect(f.controller.compact()).resolves.toMatchObject({ status: "completed" });
  expect(requests).toHaveLength(2);
  expect(requests[1]!.context.systemPrompt).toContain("fresh rules for compaction");
});

type AgentWarning = Parameters<NonNullable<AgentSessionOptions["onWarning"]>>[0];

// 尾部保留 cap 在本组行为用例中放开（ratio=1、绝对上限极大），使保留预算等于可行性预算；
// cap 本身的收紧行为由下方专门的 cap 用例覆盖。
const AUTO_SETTINGS = {
  compactionThresholdRatio: 0.5,
  compactionRetainedContextRatio: 1,
  compactionRetainedContextMaxTokens: 10_000_000,
};
const autoModel = (contextWindow = 20000): ResolvedModel => ({ ...model, contextWindow });
const textOfTokens = (tokens: number, char = "x") => char.repeat(tokens * 4);
const readCall = (id: string) => ({ id, name: "read", arguments: { path: "a.txt" } });

async function autoFixedTokens(workspaceRoot: string, settings: Settings): Promise<number> {
  const built = await buildContext({ records: [], workspacePath: workspaceRoot });
  const tools = createToolRegistry(undefined, settings)
    .list()
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: Type.Unsafe(tool.parameters),
    }));
  return estimateContextTokens({ ...built.context, tools }, settings.tokenEstimate);
}

async function seedToolTurn(
  store: SessionStore,
  ref: SessionRef,
  runId: string,
  callId: string,
  text: string,
) {
  const assistant = await store.appendRecord(ref, {
    type: "assistant_message",
    runId,
    message: makeAssistantMessage([readCall(callId)], text),
  });
  return store.appendRecord(ref, {
    type: "tool_result",
    runId,
    assistantRecordSeq: assistant.recordSeq,
    toolCallId: callId,
    toolName: "read",
    status: "success",
    content: text,
  });
}

async function seedOldRun(store: SessionStore, ref: SessionRef, sizes: number[], char = "a") {
  await store.appendRecord(ref, { type: "user_prompt", runId: "old", text: "old task" });
  let last: SessionRecord | undefined;
  for (const [index, size] of sizes.entries()) {
    last = await seedToolTurn(store, ref, "old", `s${index + 1}`, textOfTokens(size, char));
  }
  return last!;
}

interface AutoOverrides {
  getModel?: () => ResolvedModel;
  settings?: Record<string, unknown>;
  maxTurns?: number;
  seed?: (store: SessionStore, ref: SessionRef, fixed: number) => Promise<void>;
  hooks?: SessionStoreHooks;
}

async function autoFixture(
  script: (call: number, options: StreamTurnOptions) => TurnResult | Promise<TurnResult>,
  overrides: AutoOverrides = {},
) {
  const { store } = makeStore({ hooks: overrides.hooks });
  const ref = sessionRef("auto-loop");
  await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: ref.sessionId });
  const workspaceRoot = tempDir();
  fs.writeFileSync(path.join(workspaceRoot, "a.txt"), "seed");
  const rawSettings = { ...AUTO_SETTINGS, maxTurns: overrides.maxTurns ?? 40, ...overrides.settings };
  const fixed = await autoFixedTokens(workspaceRoot, parseSettings(rawSettings));
  if (overrides.seed) await overrides.seed(store, ref, fixed);
  const requests: StreamTurnOptions[] = [];
  const warnings: AgentWarning[] = [];
  const events: BusEvent[] = [];
  let call = 0;
  const session = await createAgentSession({
    store,
    ref,
    workspaceId: WORKSPACE_ID,
    workspaceRoot,
    getModel: overrides.getModel ?? (() => autoModel()),
    getSettings: () => parseSettings(rawSettings),
    modelService: {
      streamTurn: async (options) => {
        requests.push(options);
        call += 1;
        return script(call, options);
      },
    },
    onWarning: (warning) => warnings.push(warning),
  });
  session.controller.eventBus.subscribe((event) => events.push(event));
  return { ...session, store, ref, requests, warnings, events, workspaceRoot, fixed };
}

function phasesOf(events: BusEvent[]) {
  return events
    .filter((e): e is Extract<BusEvent, { type: "run.state_changed" }> => e.type === "run.state_changed")
    .map((e) => e.phase);
}

function startedCompactions(events: BusEvent[]) {
  return events.filter(
    (e): e is Extract<BusEvent, { type: "compaction.started" }> => e.type === "compaction.started",
  );
}

function finishedCompactions(events: BusEvent[]) {
  return events.filter(
    (e): e is Extract<BusEvent, { type: "compaction.finished" }> => e.type === "compaction.finished",
  );
}

function runFinishedError(events: BusEvent[]) {
  return events.find((e): e is Extract<BusEvent, { type: "run.finished" }> => e.type === "run.finished")!
    .error;
}

it("auto compacts at Run start (A) keeping the primary request prefix byte-identical", async () => {
  let lastSeq = 0;
  const f = await autoFixture(
    (call) => (call === 1 ? summaryTurn("SUMMARY") : turn(makeAssistantMessage([], "done"))),
    {
      seed: async (store, ref, fixed) => {
        // 高于阈值 10000，且留足主路径守卫（指令 + 摘要目标 + 余量）。
        const size = Math.floor((11000 - fixed) / 4);
        lastSeq = (await seedOldRun(store, ref, [size, size])).recordSeq;
      },
    },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(2);
  expect(f.requests[0]!.maxTokens).toBeUndefined();
  expect(f.requests[0]!.context.messages).toHaveLength(7);
  const instruction = f.requests[0]!.context.messages.at(-1)!;
  expect(instruction.role).toBe("user");
  expect((instruction as { content: string }).content).toContain("4096");
  expect(f.requests[0]!.context.messages.at(-2)).toMatchObject({ role: "user", content: "test" });
  expect(f.requests[0]!.context.systemPrompt).toBe(f.requests[1]!.context.systemPrompt);
  expect(JSON.stringify(f.requests[0]!.context.tools)).toBe(JSON.stringify(f.requests[1]!.context.tools));
  expect(f.requests[1]!.context.messages).toHaveLength(2);
  expect(f.requests[1]!.context.messages[0]).toMatchObject({
    role: "user",
    content: wrapConversationSummary("SUMMARY"),
  });
  expect(f.requests[1]!.context.messages[1]).toMatchObject({ role: "user", content: "test" });
  expect(phasesOf(f.events)[0]).toBe("compacting");
  const started = startedCompactions(f.events);
  expect(started).toHaveLength(1);
  expect(started[0]!.runId).toBeDefined();
  expect(finishedCompactions(f.events)[0]).toMatchObject({
    status: "completed",
    path: "primary",
    coveredUpTo: lastSeq,
    runId: started[0]!.runId,
  });
  const finished = finishedCompactions(f.events)[0]!;
  expect(finished.contextTokens).toBeGreaterThan(0);
  expect(f.controller.getSnapshot().session.contextEstimateTokens).toBe(finished.contextTokens);
  const records = (await f.store.loadSession(f.ref)).records;
  expect(records.filter((r) => r.type === "checkpoint")).toHaveLength(1);
});

it("stays quiet below the compaction threshold", async () => {
  const f = await autoFixture(() => turn(makeAssistantMessage([], "done")), {
    seed: async (store, ref) => {
      await seedOldRun(store, ref, [10]);
    },
  });
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(1);
  expect(startedCompactions(f.events)).toHaveLength(0);
  expect((await f.store.loadSession(f.ref)).records.some((r) => r.type === "checkpoint")).toBe(false);
});

it("keeps the incremental estimate equal to full estimates and triggers (B) at the exact Turn", async () => {
  const phaseAtCall: string[] = [];
  const sentEstimates: number[] = [];
  const f = await autoFixture(
    (call) => {
      const status = f.controller.getSnapshot().status;
      phaseAtCall.push(status.kind === "running" ? status.phase : status.kind);
      sentEstimates.push(
        estimateContextTokens(
          { ...f.requests[call - 1]!.context, messages: [...f.requests[call - 1]!.context.messages] },
          parseSettings(AUTO_SETTINGS).tokenEstimate,
        ),
      );
      if (call <= 2) return turn(makeAssistantMessage([readCall(`t${call}`)], textOfTokens(1800, "b")));
      if (call === 3) return summaryTurn("SUMMARY");
      return turn(makeAssistantMessage([], "done"));
    },
    {
      // cap 收紧到 4000：触发点保留最新两个 Turn，种子 Run 被覆盖，避免尾部全保留导致 noop。
      settings: { compactionRetainedContextMaxTokens: 4000 },
      seed: async (store, ref, fixed) => {
        await seedOldRun(store, ref, [Math.floor((7000 - fixed) / 2)]);
      },
    },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(4);
  expect(phaseAtCall).toEqual(["streaming", "streaming", "compacting", "streaming"]);
  expect(startedCompactions(f.events)).toHaveLength(1);
  expect(finishedCompactions(f.events)[0]).toMatchObject({ status: "completed" });

  const settings = parseSettings(AUTO_SETTINGS);
  const records = (await f.store.loadSession(f.ref)).records;
  const fullEstimateAfterTurn = async (turn: number): Promise<number> => {
    const last = records.find((r) => r.type === "tool_result" && r.toolCallId === `t${turn}`)!;
    const rebuilt = await buildContext({
      records: records.filter((r) => r.recordSeq <= last.recordSeq || r.type === "user_prompt"),
      workspacePath: f.workspaceRoot,
      systemPrompt: f.requests[0]!.context.systemPrompt,
    });
    rebuilt.context.tools = f.requests[0]!.context.tools;
    return estimateContextTokens(rebuilt.context, settings.tokenEstimate);
  };
  const threshold = 20000 * AUTO_SETTINGS.compactionThresholdRatio;
  const afterTurn1 = await fullEstimateAfterTurn(1);
  const afterTurn2 = await fullEstimateAfterTurn(2);
  expect(afterTurn1).toBeLessThan(threshold);
  expect(afterTurn2).toBeGreaterThanOrEqual(threshold);
  expect(sentEstimates[1]).toBe(afterTurn1);
  expect((await f.store.loadSession(f.ref)).records.filter((r) => r.type === "checkpoint")).toHaveLength(1);
});

it("auto compaction at (B) retains the latest Turn verbatim and covers older Turns", async () => {
  let lastSeq = 0;
  let oldChars = 0;
  const f = await autoFixture(
    (call) => {
      if (call === 1) return turn(makeAssistantMessage([readCall("t1")], textOfTokens(8000, "b")));
      if (call === 2) return summaryTurn("SUMMARY");
      return turn(makeAssistantMessage([], "done"));
    },
    {
      seed: async (store, ref, fixed) => {
        const size = Math.floor((9000 - fixed) / 2);
        oldChars = size * 4;
        lastSeq = (await seedOldRun(store, ref, [size])).recordSeq;
      },
    },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(3);
  expect(f.requests[1]!.context.tools).toEqual([]);
  expect(f.requests[1]!.context.systemPrompt).toBe(f.requests[0]!.context.systemPrompt);
  expect(f.requests[2]!.context.messages[0]).toMatchObject({
    role: "user",
    content: wrapConversationSummary("SUMMARY"),
  });
  const rebuilt = JSON.stringify(f.requests[2]!.context.messages);
  expect(rebuilt).toContain(textOfTokens(8000, "b"));
  expect(rebuilt).not.toContain("a".repeat(oldChars));
  const phases = phasesOf(f.events);
  expect(phases.indexOf("compacting")).toBeGreaterThan(phases.indexOf("executing_tool"));
  expect(finishedCompactions(f.events)[0]).toMatchObject({
    status: "completed",
    path: "fallback",
    coveredUpTo: lastSeq,
  });
  expect(finishedCompactions(f.events)[0]!.runId).toBeDefined();
});

it("does not trigger auto compaction when the final response ends the Run", async () => {
  const f = await autoFixture(
    (call) => {
      if (call === 1) return turn(makeAssistantMessage([readCall("t1")], textOfTokens(8000, "b")));
      if (call === 2) return summaryTurn("SUMMARY");
      return turn(makeAssistantMessage([], "done"));
    },
    {
      seed: async (store, ref, fixed) => {
        await seedOldRun(store, ref, [Math.floor((9000 - fixed) / 2)]);
      },
    },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(3);
  expect(startedCompactions(f.events)).toHaveLength(1);
  expect((await f.store.loadSession(f.ref)).records.filter((r) => r.type === "checkpoint")).toHaveLength(1);
});

it("only compacts at (B) after the whole Turn batch is persisted and fsynced", async () => {
  const synced: string[] = [];
  let oldSeq = 0;
  const f = await autoFixture(
    (call) => {
      if (call === 1) return turn(makeAssistantMessage([readCall("t1")], textOfTokens(8000, "b")));
      if (call === 2) {
        expect(synced).toContain("assistant_message");
        expect(synced).toContain("tool_result");
        return summaryTurn("SUMMARY");
      }
      return turn(makeAssistantMessage([], "done"));
    },
    {
      seed: async (store, ref, fixed) => {
        oldSeq = (await seedOldRun(store, ref, [Math.floor((9000 - fixed) / 2)])).recordSeq;
      },
      hooks: {
        afterSync: (info) => {
          synced.push(info.type);
        },
      },
    },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  const records = (await f.store.loadSession(f.ref)).records;
  const checkpoint = records.find((r) => r.type === "checkpoint")!;
  const turnResult = records.find((r) => r.type === "tool_result" && r.toolCallId === "t1")!;
  expect(checkpoint.recordSeq).toBeGreaterThan(turnResult.recordSeq);
  expect(checkpoint).toMatchObject({ coveredUpTo: oldSeq });
  expect(turnResult.recordSeq).toBeGreaterThan(checkpoint.coveredUpTo as number);
});

it("allows multiple compactions in one Run separated by a new Turn", async () => {
  const f = await autoFixture(
    (call) => {
      if (call === 1) return turn(makeAssistantMessage([readCall("t1")], textOfTokens(8000, "b")));
      if (call === 2) return summaryTurn("SUMMARY1");
      if (call === 3) return turn(makeAssistantMessage([readCall("t2")], textOfTokens(8000, "c")));
      if (call === 4) return summaryTurn("SUMMARY2");
      return turn(makeAssistantMessage([], "done"));
    },
    {
      seed: async (store, ref, fixed) => {
        await seedOldRun(store, ref, [Math.floor((9000 - fixed) / 2)]);
      },
    },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(5);
  const transcript = (f.requests[3]!.context.messages[0] as { content: string }).content;
  expect(transcript.match(/SUMMARY1/g)).toHaveLength(1);
  const records = (await f.store.loadSession(f.ref)).records;
  const checkpoints = records.filter((r) => r.type === "checkpoint");
  expect(checkpoints).toHaveLength(2);
  expect((checkpoints[1] as { coveredUpTo: number }).coveredUpTo).toBeGreaterThan(
    (checkpoints[0] as { coveredUpTo: number }).coveredUpTo,
  );
  const turnResult = records.find((r) => r.type === "tool_result" && r.toolCallId === "t1")!;
  expect(checkpoints[1]).toMatchObject({ coveredUpTo: turnResult.recordSeq, summary: "SUMMARY2" });
  expect(finishedCompactions(f.events).map((e) => e.status)).toEqual(["completed", "completed"]);
});

it("treats noop as non-failure and still compacts later in the same Run", async () => {
  const f = await autoFixture((call) => {
    if (call === 1) return turn(makeAssistantMessage([readCall("t1")], textOfTokens(8000, "b")));
    if (call === 2) return turn(makeAssistantMessage([readCall("t2")], textOfTokens(8000, "c")));
    if (call === 3) return summaryTurn("SUMMARY");
    return turn(makeAssistantMessage([], "done"));
  });
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(4);
  expect(finishedCompactions(f.events).map((e) => e.status)).toEqual(["noop", "completed"]);
  expect((await f.store.loadSession(f.ref)).records.filter((r) => r.type === "checkpoint")).toHaveLength(1);
  expect(f.warnings).toEqual([]);
});

it("warns and continues on auto failure, suppresses the rest of the Run, recovers next Run", async () => {
  const f = await autoFixture(
    (call) => {
      if (call === 1) throw new Error("summary boom");
      if (call === 2) return turn(makeAssistantMessage([readCall("t1")], "working"));
      if (call === 4) return summaryTurn("SUMMARY");
      return turn(makeAssistantMessage([], "done"));
    },
    {
      seed: async (store, ref, fixed) => {
        const size = Math.floor((12000 - fixed) / 4);
        await seedOldRun(store, ref, [size, size]);
      },
    },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.warnings).toEqual([{ kind: "compaction_failed", message: "summary boom" }]);
  expect(await f.controller.submitPrompt("again")).toBe("completed");
  expect(f.requests).toHaveLength(5);
  expect(startedCompactions(f.events)).toHaveLength(2);
  expect(finishedCompactions(f.events).map((e) => e.status)).toEqual(["failed", "completed"]);
  expect((await f.store.loadSession(f.ref)).records.filter((r) => r.type === "checkpoint")).toHaveLength(1);
});

it("fails without a summary request when the retained lower bound already exceeds the window", async () => {
  const f = await autoFixture(
    () => turn(makeAssistantMessage([readCall("t1")], textOfTokens(17000, "b"))),
    {
      seed: async (store, ref) => {
        await seedOldRun(store, ref, [10]);
      },
    },
  );
  expect(await f.controller.submitPrompt("test")).toBe("failed");
  expect(f.requests).toHaveLength(1);
  expect(runFinishedError(f.events)).toContain("保留尾部与摘要预算");
  expect(finishedCompactions(f.events)[0]).toMatchObject({ status: "failed" });
  expect((await f.store.loadSession(f.ref)).records.some((r) => r.type === "checkpoint")).toBe(false);
});

it("does not commit a checkpoint when the summary leaves the next request infeasible", async () => {
  let fixed = 0;
  const f = await autoFixture(
    (call) => {
      if (call === 1)
        return turn(makeAssistantMessage([readCall("t1")], textOfTokens(18500 - fixed, "b")));
      return summaryTurn("SUMMARY");
    },
    {
      settings: { compactionSummaryTargetTokens: 100 },
      seed: async (store, ref) => {
        await seedOldRun(store, ref, [10]);
      },
    },
  );
  fixed = f.fixed;
  expect(await f.controller.submitPrompt("test")).toBe("failed");
  expect(f.requests).toHaveLength(2);
  expect(runFinishedError(f.events)).toContain("压缩后上下文仍超出请求预算");
  expect(finishedCompactions(f.events)[0]).toMatchObject({ status: "failed" });
  expect((await f.store.loadSession(f.ref)).records.some((r) => r.type === "checkpoint")).toBe(false);
});

it("cancels the Run when the user cancels during threshold compaction", async () => {
  let started = false;
  let resolveTurn!: (result: TurnResult) => void;
  const f = await autoFixture(
    () =>
      new Promise<TurnResult>((resolve) => {
        started = true;
        resolveTurn = resolve;
      }),
    {
      seed: async (store, ref, fixed) => {
        const size = Math.floor((12000 - fixed) / 4);
        await seedOldRun(store, ref, [size, size]);
      },
    },
  );
  const running = f.controller.submitPrompt("test");
  await vi.waitFor(() => expect(started).toBe(true));
  f.controller.cancel();
  resolveTurn(summaryTurn("SUMMARY"));
  expect(await running).toBe("cancelled");
  expect(f.requests).toHaveLength(1);
  expect(finishedCompactions(f.events)[0]).toMatchObject({ status: "cancelled" });
  expect(finishedCompactions(f.events)[0]!.runId).toBeDefined();
  expect((await f.store.loadSession(f.ref)).records.some((r) => r.type === "checkpoint")).toBe(false);
});

// 种子总量贴近可行性上限：估算须先通过 §7.1 判据，才能模拟 Provider 侧报溢出。
const OVERFLOW_SEED_TOKENS = 20_000 - CONTEXT_SAFETY_MARGIN_TOKENS - 100;

const overflowSeed = async (store: SessionStore, ref: SessionRef, fixed: number) => {
  await store.appendRecord(ref, { type: "user_prompt", runId: "old", text: "old task" });
  const size = Math.floor((OVERFLOW_SEED_TOKENS - fixed) / 4);
  await seedToolTurn(store, ref, "old", "s1", textOfTokens(size, "a"));
  await seedToolTurn(store, ref, "old", "s2", textOfTokens(size, "b"));
};

it("remediates context overflow once and resends the same Turn without consuming maxTurns", async () => {
  let oldChars = 0;
  const f = await autoFixture(
    (call) => {
      if (call === 1) throw new TurnError("context_overflow", 1, "overflow");
      if (call === 2) return summaryTurn("SUMMARY");
      return turn(makeAssistantMessage([], "done"));
    },
    {
      settings: { compactionThresholdRatio: 1 },
      maxTurns: 1,
      seed: async (store, ref, fixed) => {
        oldChars = Math.floor((OVERFLOW_SEED_TOKENS - fixed) / 4) * 4;
        await overflowSeed(store, ref, fixed);
      },
    },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(3);
  expect(f.requests[2]!.context.messages[0]).toMatchObject({
    role: "user",
    content: wrapConversationSummary("SUMMARY"),
  });
  const rebuilt = JSON.stringify(f.requests[2]!.context.messages);
  expect(rebuilt).toContain("b".repeat(oldChars));
  expect(rebuilt).not.toContain("a".repeat(oldChars));
  expect(
    f.controller.getSnapshot().streamingAttempts.map((a) => ({
      turn: a.turn,
      attempt: a.attempt,
      status: a.status,
    })),
  ).toEqual([
    { turn: 1, attempt: 1, status: "failed" },
    { turn: 1, attempt: 1, status: "completed" },
  ]);
  const records = (await f.store.loadSession(f.ref)).records;
  const first = records.find((r) => r.type === "tool_result" && r.toolCallId === "s1")!;
  expect(records.find((r) => r.type === "checkpoint")).toMatchObject({ coveredUpTo: first.recordSeq });
  expect(finishedCompactions(f.events)[0]).toMatchObject({ status: "completed", path: "fallback" });
});

it("fails on a second context overflow in the same Run", async () => {
  const f = await autoFixture(
    (call) => {
      if (call === 1) throw new TurnError("context_overflow", 1, "overflow");
      if (call === 2) return summaryTurn("SUMMARY");
      throw new TurnError("context_overflow", 1, "overflow again");
    },
    { settings: { compactionThresholdRatio: 1 }, seed: overflowSeed },
  );
  expect(await f.controller.submitPrompt("test")).toBe("failed");
  expect(f.requests).toHaveLength(3);
  expect(runFinishedError(f.events)).toContain("/compact");
  expect(startedCompactions(f.events)).toHaveLength(1);
});

it("fails the overflow remediation when there is nothing to compact", async () => {
  const f = await autoFixture(
    () => {
      throw new TurnError("context_overflow", 1, "overflow");
    },
    {
      settings: { compactionThresholdRatio: 1 },
      seed: async (store, ref) => {
        await seedOldRun(store, ref, [10]);
      },
    },
  );
  expect(await f.controller.submitPrompt("test")).toBe("failed");
  expect(f.requests).toHaveLength(1);
  expect(runFinishedError(f.events)).toContain("/compact");
  expect(finishedCompactions(f.events)[0]).toMatchObject({ status: "noop" });
  expect((await f.store.loadSession(f.ref)).records.some((r) => r.type === "checkpoint")).toBe(false);
});

it("fails the Run when the overflow remediation itself fails", async () => {
  const f = await autoFixture(
    (call) => {
      if (call === 1) throw new TurnError("context_overflow", 1, "overflow");
      throw new Error("summary boom");
    },
    { settings: { compactionThresholdRatio: 1 }, seed: overflowSeed },
  );
  expect(await f.controller.submitPrompt("test")).toBe("failed");
  expect(f.requests).toHaveLength(2);
  expect(runFinishedError(f.events)).toContain("/compact");
  expect(finishedCompactions(f.events)[0]).toMatchObject({ status: "failed" });
  expect((await f.store.loadSession(f.ref)).records.some((r) => r.type === "checkpoint")).toBe(false);
});

it("cancels the Run when the user cancels during overflow remediation", async () => {
  let started = false;
  let resolveTurn!: (result: TurnResult) => void;
  const f = await autoFixture(
    (call) => {
      if (call === 1) throw new TurnError("context_overflow", 1, "overflow");
      return new Promise<TurnResult>((resolve) => {
        started = true;
        resolveTurn = resolve;
      });
    },
    { settings: { compactionThresholdRatio: 1 }, seed: overflowSeed },
  );
  const running = f.controller.submitPrompt("test");
  await vi.waitFor(() => expect(started).toBe(true));
  f.controller.cancel();
  resolveTurn(summaryTurn("SUMMARY"));
  expect(await running).toBe("cancelled");
  expect(f.requests).toHaveLength(2);
  expect(finishedCompactions(f.events)[0]).toMatchObject({ status: "cancelled" });
  expect((await f.store.loadSession(f.ref)).records.some((r) => r.type === "checkpoint")).toBe(false);
});

it("keeps overflow remediation available after an auto compaction failure in the same Run", async () => {
  const f = await autoFixture(
    (call) => {
      if (call === 1) throw new Error("summary boom");
      if (call === 2) throw new TurnError("context_overflow", 1, "overflow");
      if (call === 3) return summaryTurn("SUMMARY");
      return turn(makeAssistantMessage([], "done"));
    },
    { seed: overflowSeed },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(4);
  expect(f.warnings).toEqual([{ kind: "compaction_failed", message: "summary boom" }]);
  expect(finishedCompactions(f.events).map((e) => e.status)).toEqual(["failed", "completed"]);
  expect((await f.store.loadSession(f.ref)).records.filter((r) => r.type === "checkpoint")).toHaveLength(1);
});

it("freezes the Run model for compaction even if the default model switches mid-Run", async () => {
  let current = autoModel();
  const f = await autoFixture(
    (call) => {
      if (call === 1) {
        current = { ...autoModel(), id: "switched", contextWindow: 64000 };
        return summaryTurn("SUMMARY");
      }
      return turn(makeAssistantMessage([], "done"));
    },
    {
      getModel: () => current,
      seed: async (store, ref, fixed) => {
        const size = Math.floor((12000 - fixed) / 4);
        await seedOldRun(store, ref, [size, size]);
      },
    },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests[0]!.model.id).toBe("m");
  expect(f.requests[1]!.model.id).toBe("m");
  const records = (await f.store.loadSession(f.ref)).records;
  expect(records.find((r) => r.type === "checkpoint")).toMatchObject({
    model: { providerId: "p", modelId: "m" },
  });
});

it("re-budgets at Run start (A) after the model context window changes", async () => {
  let current = autoModel(30000);
  const f = await autoFixture(
    (call) => (call === 2 ? summaryTurn("SUMMARY") : turn(makeAssistantMessage([], "done"))),
    {
      getModel: () => current,
      seed: async (store, ref, fixed) => {
        const size = Math.floor((12000 - fixed) / 4);
        await seedOldRun(store, ref, [size, size]);
      },
    },
  );
  expect(await f.controller.submitPrompt("first")).toBe("completed");
  expect(startedCompactions(f.events)).toHaveLength(0);
  current = autoModel(20000);
  expect(await f.controller.submitPrompt("second")).toBe("completed");
  expect(f.requests).toHaveLength(3);
  expect(f.requests[1]!.model.contextWindow).toBe(20000);
  expect(startedCompactions(f.events)).toHaveLength(1);
  expect((await f.store.loadSession(f.ref)).records.filter((r) => r.type === "checkpoint")).toHaveLength(1);
});

it("caps the retained tail at (B) when compactionRetainedContextMaxTokens binds", async () => {
  let oldSeq = 0;
  const f = await autoFixture(
    (call) => {
      // 最新 Turn 单独超过 9000 的 cap：无条件保留，walk-back 立即停止，covered 恒为两个 old Turn。
      if (call === 1) return turn(makeAssistantMessage([readCall("t1")], textOfTokens(12000, "b")));
      if (call === 2) return summaryTurn("SUMMARY");
      return turn(makeAssistantMessage([], "done"));
    },
    {
      getModel: () => autoModel(40000),
      // 大窗口下可行性预算极宽，绝对上限 9000 成为生效 cap。
      settings: { compactionThresholdRatio: 0.3, compactionRetainedContextMaxTokens: 9000 },
      seed: async (store, ref) => {
        oldSeq = (await seedOldRun(store, ref, [1000, 1000])).recordSeq;
      },
    },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  const records = (await f.store.loadSession(f.ref)).records;
  const checkpoints = records.filter((r) => r.type === "checkpoint");
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0]).toMatchObject({ coveredUpTo: oldSeq, summary: "SUMMARY" });
});

it("retains the whole tail (noop) at (B) when the cap is loose", async () => {
  const f = await autoFixture(
    (call) => {
      if (call === 1) return turn(makeAssistantMessage([readCall("t1")], textOfTokens(12000, "b")));
      return turn(makeAssistantMessage([], "done"));
    },
    {
      getModel: () => autoModel(40000),
      // 同样的种子与窗口，但 cap 放开（继承 AUTO_SETTINGS 的 ratio=1、绝对上限极大）：尾部全部保留 -> noop。
      settings: { compactionThresholdRatio: 0.3 },
      seed: async (store, ref) => {
        await seedOldRun(store, ref, [1000, 1000]);
      },
    },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(2);
  expect((await f.store.loadSession(f.ref)).records.some((r) => r.type === "checkpoint")).toBe(false);
});
