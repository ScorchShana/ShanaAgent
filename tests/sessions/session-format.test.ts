import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, planEffectiveContext } from "../../src/core/context-builder.js";
import { isTurnContextComplete, parseSessionRecord } from "../../src/sessions/records.js";
import { resumeSession } from "../../src/sessions/recovery.js";
import {
  cleanupTempDirs,
  makeAssistantRecord,
  makeCheckpointRecord,
  makeToolResultRecord,
  makeUserPromptRecord,
  makeStore,
  metaPathOf,
  messagesPathOf,
  sessionRef,
  WORKSPACE_ID,
  tempDir,
} from "./helpers.js";

afterEach(cleanupTempDirs);
describe("Session v5", () => {
  it("rejects nonfinite parsed objects at the storage boundary", () => {
    const a = makeAssistantRecord(2, "r", [{ id: "x", name: "read", arguments: { nested: [Infinity] } }]);
    expect(() => parseSessionRecord(a, { expectVersion: false })).toThrow();
  });
  it.each(["api", "provider", "model"])("rejects missing SDK source %s", (key) => {
    const a = makeAssistantRecord(2, "r", []);
    Reflect.deleteProperty(a.message, key);
    expect(() => parseSessionRecord(a, { expectVersion: false })).toThrow();
  });
  it("pairs repeated IDs by assistant record; rejects duplicate/mismatched results, accepts unknown/missing", () => {
    const a = makeAssistantRecord(2, "r", [{ id: "same", name: "read" }]);
    const first = makeToolResultRecord(3, "r", "same", "success", { assistantRecordSeq: 2 });
    const b = makeAssistantRecord(4, "r", [{ id: "same", name: "read" }]);
    const second = makeToolResultRecord(5, "r", "same", "error", { assistantRecordSeq: 4 });
    // first 归属 a：b 的 call 缺结果 → 受控完整（合成 unknown 占位）。
    expect(isTurnContextComplete(b, [first])).toBe(true);
    expect(isTurnContextComplete(b, [first, second])).toBe(true);
    expect(isTurnContextComplete(b, [second, second])).toBe(false);
    expect(isTurnContextComplete(a, [{ ...first, toolName: "write" }])).toBe(false);
    expect(isTurnContextComplete(a, [{ ...first, status: "unknown" }])).toBe(true);
  });
  it("accepts paired invalid arguments and length tool turns but excludes truncated text", () => {
    const a = makeAssistantRecord(2, "r", [{ id: "x", name: "read" }], { stopReason: "length" });
    const call = a.message.content.find((b) => b.type === "toolCall")!;
    if (call.type === "toolCall") call.parse = { status: "invalid", error: "incomplete" };
    const result = makeToolResultRecord(3, "r", "x", "error");
    expect(isTurnContextComplete(a, [result])).toBe(true);
    expect(isTurnContextComplete(makeAssistantRecord(4, "r", [], { stopReason: "length" }), [])).toBe(false);
    expect(
      planEffectiveContext([makeUserPromptRecord(1, "r", "hi"), a, result, makeCheckpointRecord(4, "S", 3)])
        .checkpoint?.summary,
    ).toBe("S");
  });
  it("rejects malformed parse unions without reinterpreting stored arguments", () => {
    const a = makeAssistantRecord(2, "r", [{ id: "x", name: "read" }]);
    const call = a.message.content.find((b) => b.type === "toolCall")!;
    if (call.type !== "toolCall") throw new Error("fixture");
    call.rawArguments = '{"secret":"synthetic-credential"';
    call.parse = { status: "invalid", error: "incomplete" };
    expect(parseSessionRecord(a, { expectVersion: false })).toEqual(a);
    Object.assign(call.parse, { arguments: {} });
    expect(() => parseSessionRecord(a, { expectVersion: false })).toThrow();
  });
  it("round trips original credentials and resume context without copying snapshots into messages", async () => {
    const { store } = makeStore();
    const ref = sessionRef("v2");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: ref.sessionId });
    await store.appendRecord(ref, { type: "user_prompt", runId: "r", text: "hi" });
    const a = makeAssistantRecord(2, "r", [{ id: "x", name: "write" }]);
    const call = a.message.content.find((b) => b.type === "toolCall")!;
    if (call.type !== "toolCall") throw new Error("fixture");
    call.rawArguments = '{ "apiKey": "synthetic-key",';
    call.parse = { status: "invalid", error: "incomplete" };
    await store.appendRecord(ref, { type: "assistant_message", runId: "r", message: a.message });
    await store.appendRecord(ref, {
      type: "tool_result",
      runId: "r",
      assistantRecordSeq: 2,
      toolCallId: "x",
      toolName: "write",
      status: "error",
      content: "Error: Invalid arguments JSON. Not executed.",
      priorContent: "snapshot-only",
    });
    await store.appendRecord(ref, {
      type: "run_finished",
      runId: "r",
      outcome: "completed",
      persisted: true,
      elapsedMs: 62234,
    });
    const before = await store.loadSession(ref);
    await store.releaseSession(ref);
    const copy = await resumeSession(store, ref);
    expect(copy.records.at(-1)).toMatchObject({ type: "run_finished", elapsedMs: 62234 });
    const workspacePath = tempDir();
    const context = (records: typeof before.records) =>
      buildContext({ records, currentPrompt: "next", now: () => new Date(0), workspacePath });
    expect((await context(before.records)).context).toEqual((await context(copy.records)).context);
    expect(JSON.stringify((await context(copy.records)).context)).not.toContain("snapshot-only");
    expect(JSON.stringify(copy.records)).toContain("synthetic-key");
    // v5 硬切：旧 v4 meta 拒载、不迁移、文件不修改。
    const bytes = fs.readFileSync(metaPathOf(store.sessionsDir, ref), "utf8");
    fs.writeFileSync(metaPathOf(store.sessionsDir, ref), bytes.replace('"version":5', '"version":4'));
    await expect(store.loadSession(ref)).rejects.toThrow(/版本 4/);
    expect(fs.readFileSync(metaPathOf(store.sessionsDir, ref), "utf8")).toContain('"version":4');
    expect(fs.readFileSync(messagesPathOf(store.sessionsDir, ref), "utf8")).toContain("synthetic-key");
  });
  it("does not admit later turns in the same run through a checkpoint after an incomplete turn", () => {
    const records = [
      makeUserPromptRecord(1, "r", "hi"),
      makeAssistantRecord(2, "r", [], { stopReason: "error" }),
      makeAssistantRecord(3, "r", []),
      makeCheckpointRecord(4, "bad", 3),
    ];
    expect(() => planEffectiveContext(records)).toThrow();
  });
});
