import fs from "node:fs";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CheckpointInvalidError,
  createRunStartGate,
  findUnknownSideEffects,
  resumeSession,
  UnknownSideEffectsError,
} from "../../src/sessions/recovery.js";
import type { SessionRecord } from "../../src/sessions/records.js";
import { SessionWriteError, type SessionRef, type SessionStore } from "../../src/sessions/session-store.js";
import {
  cleanupTempDirs,
  fixedNow,
  makeAssistantMessage,
  makeAssistantRecord,
  makeModelSnapshot,
  makeStore,
  makeToolResultRecord,
  makeUserPromptRecord,
  messagesPathOf,
  sessionRef,
  WORKSPACE_ID,
} from "./helpers.js";

const resumeWorkers = new Set<ChildProcess>();

afterEach(async () => {
  await Promise.all(
    [...resumeWorkers].map(
      (worker) =>
        new Promise<void>((resolve) => {
          worker.once("close", () => resolve());
          if (worker.exitCode === null && worker.signalCode === null) {
            worker.kill();
          } else {
            resolve();
          }
        }),
    ),
  );
  resumeWorkers.clear();
  cleanupTempDirs();
});

async function seedSource(store: SessionStore, ref: SessionRef): Promise<void> {
  await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: ref.sessionId });
  await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "hello" });
  await store.appendRecord(ref, {
    type: "run_started",
    runId: "run-1",
    model: makeModelSnapshot(),
    settings: { maxRetries: 10 },
    agentsMd: { path: "/ws/AGENTS.md", present: false },
  });
  await store.appendRecord(ref, {
    type: "assistant_message",
    runId: "run-1",
    message: makeAssistantMessage([{ id: "c1", name: "read" }]),
  });
  await store.appendRecord(ref, {
    type: "tool_result",
    assistantRecordSeq: 3,
    runId: "run-1",
    toolCallId: "c1",
    toolName: "read",
    status: "success",
    content: "body",
  });
  await store.appendRecord(ref, {
    type: "checkpoint",
    summary: "summary of hello",
    coveredUpTo: 4,
    model: { providerId: "deepseek", modelId: "deepseek-flash" },
  });
  await store.appendRecord(ref, {
    type: "run_finished",
    runId: "run-1",
    outcome: "completed",
    persisted: true,
  });
}

describe("resume original Session", () => {
  it.each([false, true])("validates a run_finished checkpoint on disk (has Turn = %s)", async (hasTurn) => {
    const { store } = makeStore();
    const ref = sessionRef("finished-boundary");
    await store.createSession(ref);
    await store.appendRecord(ref, { type: "user_prompt", runId: "r", text: "request" });
    if (hasTurn) {
      await store.appendRecord(ref, {
        type: "assistant_message", runId: "r", message: makeAssistantMessage([], "answer"),
      });
    }
    const end = await store.appendRecord(ref, {
      type: "run_finished", runId: "r", outcome: "cancelled", persisted: true,
    });
    await store.appendRecord(ref, {
      type: "checkpoint", coveredUpTo: end.recordSeq, summary: "summary", model: { providerId: "p", modelId: "m" },
    });
    await store.releaseSession(ref);
    if (hasTurn) await expect(resumeSession(store, ref)).rejects.toBeInstanceOf(CheckpointInvalidError);
    else expect((await resumeSession(store, ref)).checkpoint?.coveredUpTo).toBe(end.recordSeq);
  });

  it("keeps identity, checkpoint, audit prefix and appends from the actual tail", async () => {
    const { store, sessionsDir } = makeStore({ now: fixedNow() });
    const source = sessionRef("source");
    await seedSource(store, source);
    const before = fs.readFileSync(messagesPathOf(sessionsDir, source), "utf8");
    await store.releaseSession(source);
    const restored = await resumeSession(store, source);
    expect(restored.meta).toMatchObject({ sessionId: "source", createdAt: "2026-10-27T10:00:00.000Z" });
    expect(restored.meta.sourceSessionId).toBeUndefined();
    expect(restored.checkpoint?.summary).toBe("summary of hello");
    expect(restored.records).toHaveLength(6);
    expect(fs.readFileSync(messagesPathOf(sessionsDir, source), "utf8")).toBe(before);
    expect(
      (await store.appendRecord(source, { type: "user_prompt", runId: "r2", text: "continue" })).recordSeq,
    ).toBe(7);
    expect((await store.listSessions(WORKSPACE_ID)).map((m) => m.sessionId)).toEqual(["source"]);
  });

  it("rejects truncated and empty Sessions without changing the history or retaining a lock", async () => {
    const { store, sessionsDir } = makeStore();
    const source = sessionRef("source");
    await seedSource(store, source);
    await store.releaseSession(source);
    const file = messagesPathOf(sessionsDir, source);
    fs.appendFileSync(file, '{"recordSeq":7');
    const before = fs.readFileSync(file);
    await expect(resumeSession(store, source)).rejects.toBeInstanceOf(SessionWriteError);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(path.join(path.dirname(file), "source.session.lock"))).toBe(false);
    const empty = sessionRef("empty");
    await store.createSession(empty);
    await store.releaseSession(empty);
    await expect(resumeSession(store, empty)).rejects.toThrow("会话为空");
  });

  it("releases acquired ownership when checkpoint validation fails", async () => {
    const { store, sessionsDir } = makeStore();
    const source = sessionRef("source");
    await seedSource(store, source);
    await store.appendRecord(source, {
      type: "checkpoint",
      coveredUpTo: 1,
      summary: "invalid",
      model: { providerId: "p", modelId: "m" },
    });
    await store.releaseSession(source);
    await expect(resumeSession(store, source)).rejects.toBeInstanceOf(CheckpointInvalidError);
    expect(fs.existsSync(path.join(sessionsDir, WORKSPACE_ID, "source", "source.session.lock"))).toBe(false);
  });
});

describe("V6 知情确认门控", () => {
  it.each(["length"] as const)(
    "未具备执行条件的 %s 响应不因缺少工具结果而要求确认",
    (stopReason) => {
      const records: SessionRecord[] = [
        makeUserPromptRecord(1, "run-1", "write file"),
        makeAssistantRecord(2, "run-1", [{ id: "c1", name: "write" }], { stopReason }),
      ];

      expect(findUnknownSideEffects(records)).toEqual([]);
      expect(() => createRunStartGate(records).assertCanStartRun()).not.toThrow();
    },
  );

  it("aborted 响应的可配对 call 缺合成结果时要求知情确认", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "write file"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "write" }], { stopReason: "aborted" }),
    ];
    expect(findUnknownSideEffects(records).map((item) => item.toolCallId)).toEqual(["c1"]);
    expect(() => createRunStartGate(records).assertCanStartRun()).toThrow();
  });

  it("aborted 响应已合成 not_executed 结果时不要求确认", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "write file"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "write" }], { stopReason: "aborted" }),
      makeToolResultRecord(3, "run-1", "c1", "not_executed", { toolName: "write" }),
    ];
    expect(findUnknownSideEffects(records)).toEqual([]);
    expect(() => createRunStartGate(records).assertCanStartRun()).not.toThrow();
  });

  it("aborted 响应的半截 call（空 id）缺结果不要求确认", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "write file"),
      makeAssistantRecord(2, "run-1", [{ id: "", name: "write" }], { stopReason: "aborted" }),
    ];
    expect(findUnknownSideEffects(records)).toEqual([]);
    expect(() => createRunStartGate(records).assertCanStartRun()).not.toThrow();
  });

  it("混合批次只对有效且缺结果的调用报告副作用未知", () => {
    const assistant = makeAssistantRecord(2, "run-1", [
      { id: "c1", name: "write" },
      { id: "c2", name: "write" },
    ]);
    for (const block of assistant.message.content) {
      if (block.type === "toolCall" && block.id === "c2")
        block.parse = { status: "invalid", error: "incomplete" };
    }
    const records: SessionRecord[] = [makeUserPromptRecord(1, "run-1", "write files"), assistant];

    expect(findUnknownSideEffects(records).map((item) => item.toolCallId)).toEqual(["c1"]);
    expect(() => createRunStartGate(records).assertCanStartRun()).toThrow(UnknownSideEffectsError);
  });

  it.each([false, true])(
    "工具调用缺少结果时要求确认，interruption=%s 不补齐结果或改变历史",
    (withInterruption) => {
      const records: SessionRecord[] = [
        makeUserPromptRecord(1, "run-1", "write file"),
        makeAssistantRecord(2, "run-1", [{ id: "c1", name: "write" }]),
      ];
      if (withInterruption) {
        records.push({
          recordSeq: 3,
          ts: "2026-10-27T10:00:00.000Z",
          type: "interruption",
          runId: "run-1",
          toolCallId: "c1",
          reason: "tool result unavailable after interruption",
        });
      }
      const before = JSON.stringify(records);
      const gate = createRunStartGate(records);

      expect.soft(gate.requiresAcknowledgement).toBe(true);
      expect.soft(() => gate.assertCanStartRun()).toThrow(UnknownSideEffectsError);
      expect
        .soft(findUnknownSideEffects(records))
        .toEqual([expect.objectContaining({ runId: "run-1", toolCallId: "c1", toolName: "write" })]);

      gate.acknowledge();
      expect(() => gate.assertCanStartRun()).not.toThrow();
      expect(JSON.stringify(records)).toBe(before);
      expect(records.some((record) => record.type === "tool_result")).toBe(false);
    },
  );

  it("另一 Run 的同名 toolCallId 确定结果不能解除当前调用的确认要求", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first write"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "write" }]),
      makeToolResultRecord(3, "run-1", "c1", "success", { toolName: "write" }),
      makeUserPromptRecord(4, "run-2", "second write"),
      makeAssistantRecord(5, "run-2", [{ id: "c1", name: "write" }]),
    ];

    expect(() => createRunStartGate(records).assertCanStartRun()).toThrow(UnknownSideEffectsError);
    expect(findUnknownSideEffects(records)).toEqual([
      expect.objectContaining({ runId: "run-2", toolCallId: "c1", toolName: "write" }),
    ]);
  });

  it.each(["success", "error", "denied", "timeout", "not_executed"] as const)(
    "确定结果 %s 不要求未知副作用确认",
    (status) => {
      const records: SessionRecord[] = [
        makeUserPromptRecord(1, "run-1", "write file"),
        makeAssistantRecord(2, "run-1", [{ id: "c1", name: "write" }]),
        makeToolResultRecord(3, "run-1", "c1", status, { toolName: "write" }),
      ];

      const gate = createRunStartGate(records);
      expect(gate.requiresAcknowledgement).toBe(false);
      expect(() => gate.assertCanStartRun()).not.toThrow();
      expect(findUnknownSideEffects(records)).toEqual([]);
    },
  );

  it("resume 保留缺失结果的审计历史，并对原会话提供知情确认门控", async () => {
    const { store, sessionsDir } = makeStore();
    const source = sessionRef("source-missing-result");
    await seedSource(store, source);
    await store.appendRecord(source, { type: "user_prompt", runId: "run-2", text: "write file" });
    await store.appendRecord(source, {
      type: "assistant_message",
      runId: "run-2",
      message: makeAssistantMessage([{ id: "c2", name: "write" }]),
    });
    const sourcePath = messagesPathOf(sessionsDir, source);
    const before = fs.readFileSync(sourcePath);
    const sourceRecords = (await store.loadSession(source)).records;

    await store.releaseSession(source);
    const result = await resumeSession(store, source);
    const copy = await store.loadSession(source);
    expect
      .soft(result.unknownSideEffects)
      .toEqual([expect.objectContaining({ runId: "run-2", toolCallId: "c2", toolName: "write" })]);
    expect.soft(() => createRunStartGate(copy.records).assertCanStartRun()).toThrow(UnknownSideEffectsError);
    expect(copy.records).toEqual(sourceRecords);
    expect(copy.records).toHaveLength(8);
    expect(fs.readFileSync(sourcePath)).toEqual(before);
  });

  it("存在未知副作用时拦截新 Run；确认后不改写记录，仍可识别未知结果", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "do it"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "write" }]),
      makeToolResultRecord(3, "run-1", "c1", "unknown"),
    ];
    const snapshot = JSON.stringify(records);

    const gate = createRunStartGate(records);
    expect(gate.unknownResults).toHaveLength(1);
    expect(gate.requiresAcknowledgement).toBe(true);
    expect(() => gate.assertCanStartRun()).toThrow(UnknownSideEffectsError);

    gate.acknowledge();
    expect(gate.requiresAcknowledgement).toBe(false);
    expect(() => gate.assertCanStartRun()).not.toThrow();

    expect(JSON.stringify(records)).toBe(snapshot);
    expect(findUnknownSideEffects(records)).toHaveLength(1);
  });
});

describe("cross-process Session ownership", () => {
  it(
    "allows only one writer, then another process resumes the same ID after release",
    { timeout: 15000 },
    async () => {
      const { store, sessionsDir } = makeStore();
      const ref = sessionRef("source");
      await seedSource(store, ref);
      const before = fs.readFileSync(messagesPathOf(sessionsDir, ref), "utf8");
      await store.releaseSession(ref);
      const workerPath = fileURLToPath(new URL("./fixtures/resume-worker.ts", import.meta.url));
      const workers = ["a", "b"].map((id) => {
        const worker = fork(workerPath, [sessionsDir, WORKSPACE_ID, ref.sessionId, id], {
          execArgv: ["--import", "tsx"],
          silent: true,
          windowsHide: true,
        });
        resumeWorkers.add(worker);
        return worker;
      });
      const receive = (worker: ChildProcess) =>
        new Promise<string>((resolve, reject) => {
          worker.once("message", (message) => resolve(String(message)));
          worker.once("error", reject);
        });
      await Promise.all(workers.map(receive));
      const acquired = workers.map(receive);
      for (const worker of workers) worker.send("resume");
      const outcomes = await Promise.all(acquired);
      expect(outcomes.slice().sort()).toEqual(["acquired", "occupied"]);
      expect(workers[0]!.pid).not.toBe(workers[1]!.pid);
      const winner = workers[outcomes.indexOf("acquired")]!;
      const loser = workers[outcomes.indexOf("occupied")]!;
      const released = receive(winner);
      winner.send("release");
      await released;
      const retry = receive(loser);
      loser.send("resume");
      expect(await retry).toBe("acquired");
      const done = receive(loser);
      loser.send("release");
      await done;
      const history = await store.loadSession(ref);
      expect(history.records.map((r) => r.recordSeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(fs.readFileSync(messagesPathOf(sessionsDir, ref), "utf8").startsWith(before)).toBe(true);
      expect(await store.listSessions(WORKSPACE_ID)).toHaveLength(1);
    },
  );
});

describe("autoDecisionEnabled recovery", () => {
  it.each([undefined, false, true])("restores %s without rewriting metadata", async (enabled) => {
    const { store } = makeStore();
    const ref = sessionRef("metadata-resume");
    await seedSource(store, ref);
    const target = path.join(store.sessionsDir, ref.workspaceId, ref.sessionId, "meta.json");
    const meta = JSON.parse(fs.readFileSync(target, "utf8"));
    delete meta.autoDecisionEnabled;
    if (enabled !== undefined) meta.autoDecisionEnabled = enabled;
    const raw = JSON.stringify(meta);
    fs.writeFileSync(target, raw);
    await store.releaseSession(ref);
    const next = makeStore({ sessionsDir: store.sessionsDir }).store;
    const resumed = await resumeSession(next, ref);
    expect(resumed.meta.autoDecisionEnabled ?? true).toBe(enabled ?? true);
    expect(Object.hasOwn(resumed.meta, "autoDecisionEnabled")).toBe(enabled !== undefined);
    expect(fs.readFileSync(target, "utf8")).toBe(raw);
    await next.releaseSession(ref);
  });
});
