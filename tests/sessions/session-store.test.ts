import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_FORMAT_VERSION,
  RecordValidationError,
  type NewSessionRecord,
} from "../../src/sessions/records.js";
import { SessionStoreError, SessionVersionError } from "../../src/sessions/session-store.js";
import {
  cleanupTempDirs,
  fixedNow,
  makeAssistantMessage,
  makeModelSnapshot,
  makeStore,
  messagesPathOf,
  metaPathOf,
  sessionRef,
  WORKSPACE_ID,
} from "./helpers.js";

afterEach(cleanupTempDirs);

describe("V1 记录追加与读回", () => {
  it("7 类记录可追加/读回，公共字段齐全且 recordSeq 单调", async () => {
    const { store } = makeStore({ now: fixedNow() });
    const ref = sessionRef("s1");
    const meta = await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });
    expect(meta).toEqual({
      version: SESSION_FORMAT_VERSION,
      sessionId: "s1",
      workspaceId: WORKSPACE_ID,
      createdAt: "2026-10-27T10:00:00.000Z",
      autoDecisionEnabled: true,
    });

    const appended = [
      await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "hello" }),
      await store.appendRecord(ref, {
        type: "run_started",
        runId: "run-1",
        model: makeModelSnapshot(),
        settings: { maxRetries: 10, logLevel: "info" },
        agentsMd: { path: "/ws/AGENTS.md", present: true, sha256: "abc123" },
      }),
      await store.appendRecord(ref, {
        type: "assistant_message",
        runId: "run-1",
        message: makeAssistantMessage([{ id: "c1", name: "read" }]),
      }),
      await store.appendRecord(ref, {
        type: "tool_result",
        assistantRecordSeq: 3,
        runId: "run-1",
        toolCallId: "c1",
        toolName: "read",
        status: "success",
        content: "file body",
      }),
      await store.appendRecord(ref, {
        type: "interruption",
        runId: "run-1",
        toolCallId: "c2",
        reason: "result unknown",
      }),
      await store.appendRecord(ref, {
        type: "checkpoint",
        summary: "summary",
        coveredUpTo: 3,
        model: { providerId: "deepseek", modelId: "deepseek-flash" },
        promptVersion: "compaction-v1",
        usage: { input: 1200, cacheRead: 800, output: 300, durationMs: 4321.5 },
      }),
      await store.appendRecord(ref, {
        type: "run_finished",
        runId: "run-1",
        outcome: "completed",
        persisted: true,
      }),
    ];

    expect(appended.map((record) => record.recordSeq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(appended[0]?.version).toBe(SESSION_FORMAT_VERSION);
    expect(appended[1]?.version).toBeUndefined();
    for (const record of appended) {
      expect(record.ts).toBe("2026-10-27T10:00:00.000Z");
    }

    const loaded = await store.loadSession(ref);
    expect(loaded.records).toEqual(appended);
    expect(loaded.warnings).toEqual([]);

    const raw = fs.readFileSync(messagesPathOf(store.sessionsDir, ref), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    for (const line of raw.trimEnd().split("\n")) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.recordSeq).toBeTypeOf("number");
      expect(parsed.ts).toBeTypeOf("string");
      expect(parsed.type).toBeTypeOf("string");
    }
  });

  it("非法 type/status/outcome 被拒绝且不消耗 recordSeq、不写盘", async () => {
    const { store } = makeStore();
    const ref = sessionRef("s1");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });
    await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "hello" });
    const before = fs.readFileSync(messagesPathOf(store.sessionsDir, ref), "utf8");

    await expect(
      store.appendRecord(ref, { type: "bogus", text: "x" } as unknown as NewSessionRecord),
    ).rejects.toBeInstanceOf(RecordValidationError);
    await expect(
      store.appendRecord(ref, {
        type: "tool_result",
        assistantRecordSeq: 1,
        runId: "run-1",
        toolCallId: "c1",
        toolName: "read",
        status: "ok",
        content: "",
      } as unknown as NewSessionRecord),
    ).rejects.toBeInstanceOf(RecordValidationError);
    await expect(
      store.appendRecord(ref, {
        type: "run_finished",
        runId: "run-1",
        outcome: "done",
        persisted: true,
      } as unknown as NewSessionRecord),
    ).rejects.toBeInstanceOf(RecordValidationError);

    expect(fs.readFileSync(messagesPathOf(store.sessionsDir, ref), "utf8")).toBe(before);
    const next = await store.appendRecord(ref, {
      type: "interruption",
      runId: "run-1",
      reason: "cancelled",
    });
    expect(next.recordSeq).toBe(2);
  });

  it("重复创建同一 Session 被拒绝", async () => {
    const { store } = makeStore();
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });
    await expect(store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" })).rejects.toBeInstanceOf(
      SessionStoreError,
    );
  });
});

describe("V12 priorContent 快照", () => {
  it("write/edit 的 tool_result 携带全量旧内容快照、追加后可原样读回", async () => {
    const { store } = makeStore({ now: fixedNow() });
    const ref = sessionRef("s-prior");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s-prior" });
    await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "hi" });
    await store.appendRecord(ref, {
      type: "assistant_message",
      runId: "run-1",
      message: makeAssistantMessage([{ id: "c1", name: "write" }]),
    });
    const snapshot = "old line\n".repeat(2000);
    const appended = await store.appendRecord(ref, {
      type: "tool_result",
      assistantRecordSeq: 2,
      runId: "run-1",
      toolCallId: "c1",
      toolName: "write",
      status: "success",
      content: "ok",
      priorContent: snapshot,
    });
    expect(appended.priorContent).toBe(snapshot);
    const loaded = await store.loadSession(ref);
    expect(loaded.records[2]).toEqual(appended);
  });

  it("新建文件的空串快照追加后可原样读回", async () => {
    const { store } = makeStore({ now: fixedNow() });
    const ref = sessionRef("s-prior-empty");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s-prior-empty" });
    await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "hi" });
    await store.appendRecord(ref, {
      type: "assistant_message",
      runId: "run-1",
      message: makeAssistantMessage([{ id: "c1", name: "write" }]),
    });
    const appended = await store.appendRecord(ref, {
      type: "tool_result",
      assistantRecordSeq: 2,
      runId: "run-1",
      toolCallId: "c1",
      toolName: "write",
      status: "success",
      content: "ok",
      priorContent: "",
    });
    expect(appended.priorContent).toBe("");
    const loaded = await store.loadSession(ref);
    expect(loaded.records[2]).toEqual(appended);
  });

  it("持锁重新打开原 Session 保留 priorContent", async () => {
    const { store } = makeStore({ now: fixedNow() });
    const source = sessionRef("s-prior-src");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s-prior-src" });
    await store.appendRecord(source, { type: "user_prompt", runId: "run-1", text: "hi" });
    await store.appendRecord(source, {
      type: "assistant_message",
      runId: "run-1",
      message: makeAssistantMessage([{ id: "c1", name: "edit" }]),
    });
    await store.appendRecord(source, {
      type: "tool_result",
      assistantRecordSeq: 2,
      runId: "run-1",
      toolCallId: "c1",
      toolName: "edit",
      status: "success",
      content: "ok",
      priorContent: "before",
    });
    const loaded = await store.loadSession(source);
    await store.releaseSession(source);
    const copied = await store.openSession(source);
    expect(copied.records).toEqual(loaded.records);
    expect(copied.records[2]).toMatchObject({
      type: "tool_result",
      assistantRecordSeq: 2,
      priorContent: "before",
    });
  });

  it("非字符串 priorContent 的记录视为损坏，拒绝加载且不改文件", async () => {
    const { store } = makeStore({ now: fixedNow() });
    const ref = sessionRef("s-prior-bad");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s-prior-bad" });
    await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "hi" });
    const messagesPath = messagesPathOf(store.sessionsDir, ref);
    fs.appendFileSync(
      messagesPath,
      `${JSON.stringify({
        recordSeq: 2,
        ts: "2026-10-27T10:00:00.000Z",
        type: "tool_result",
        assistantRecordSeq: 1,
        runId: "run-1",
        toolCallId: "c1",
        toolName: "write",
        status: "success",
        content: "ok",
        priorContent: 42,
      })}\n`,
    );
    await expect(store.loadSession(ref)).rejects.toThrow(/"priorContent"/);
    const after = fs.readFileSync(messagesPath, "utf8");
    expect(after.trimEnd().split("\n")).toHaveLength(2);
  });
});

describe("view_image images 大行持久化", () => {
  it("~5 MiB base64 单行 append/load 原样读回；尾撕裂按完整前缀恢复", async () => {
    const { store } = makeStore({ now: fixedNow() });
    const ref = sessionRef("s-image");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s-image" });
    await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "hi" });
    await store.appendRecord(ref, {
      type: "assistant_message",
      runId: "run-1",
      message: makeAssistantMessage([{ id: "c1", name: "view_image" }]),
    });
    const data = "A".repeat(6_990_508);
    const appended = await store.appendRecord(ref, {
      type: "tool_result",
      assistantRecordSeq: 2,
      runId: "run-1",
      toolCallId: "c1",
      toolName: "view_image",
      status: "success",
      content: "(Image attached: image/png, 1920x1080.)",
      images: [{ data, mimeType: "image/png", width: 1920, height: 1080 }],
    });
    const loaded = await store.loadSession(ref);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.records[2]).toEqual(appended);

    // 模拟崩溃窗口的半截尾行：完整前缀原样恢复，原文件不被修改。
    const messagesPath = messagesPathOf(store.sessionsDir, ref);
    fs.appendFileSync(messagesPath, '{"recordSeq":4,"ts":"2026-10-27T10:00:00.000Z","type":"user_pr');
    const torn = await store.loadSession(ref);
    expect(torn.warnings).toHaveLength(1);
    expect(torn.warnings[0]?.kind).toBe("tail_truncated");
    expect(torn.records).toEqual(loaded.records);
  });
});

describe("V2 版本门", () => {
  it("meta.json 版本不识别时拒绝加载并报告版本，文件不变", async () => {
    const { store } = makeStore();
    const ref = sessionRef("s1");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });
    await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "hi" });

    const metaPath = metaPathOf(store.sessionsDir, ref);
    const tampered = fs.readFileSync(metaPath, "utf8").replace('"version":5', '"version":99');
    fs.writeFileSync(metaPath, tampered);

    const error = await store.loadSession(ref).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionVersionError);
    expect((error as SessionVersionError).foundVersion).toBe(99);
    expect(fs.readFileSync(metaPath, "utf8")).toBe(tampered);
  });

  it("messages.jsonl 首条记录版本不识别时拒绝加载，文件不变", async () => {
    const { store } = makeStore();
    const ref = sessionRef("s1");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });
    await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "hi" });

    const messagesPath = messagesPathOf(store.sessionsDir, ref);
    const tampered = fs.readFileSync(messagesPath, "utf8").replace('"version":5', '"version":99');
    fs.writeFileSync(messagesPath, tampered);

    const error = await store.loadSession(ref).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionVersionError);
    expect((error as SessionVersionError).foundVersion).toBe(99);
    expect(fs.readFileSync(messagesPath, "utf8")).toBe(tampered);
  });

  it("空 messages.jsonl 可由 meta 版本正常加载为空历史", async () => {
    const { store } = makeStore();
    const ref = sessionRef("s1");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });
    const loaded = await store.loadSession(ref);
    expect(loaded.records).toEqual([]);
    expect(loaded.warnings).toEqual([]);
  });

  it("不存在的 Session 报 not_found，不自动创建", async () => {
    const { store, sessionsDir } = makeStore();
    const ref = sessionRef("missing");
    const error = await store.loadSession(ref).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionStoreError);
    expect((error as SessionStoreError).code).toBe("not_found");
    expect(fs.existsSync(`${sessionsDir}/${WORKSPACE_ID}/missing`)).toBe(false);
  });
});

describe("V9 权限与隔离", () => {
  it.skipIf(process.platform === "win32")("POSIX 目录 0700、文件 0600", async () => {
    const { store, sessionsDir } = makeStore();
    const ref = sessionRef("s1");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });
    await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "hi" });

    const dir = `${sessionsDir}/${WORKSPACE_ID}/s1`;
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(metaPathOf(sessionsDir, ref)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(messagesPathOf(sessionsDir, ref)).mode & 0o777).toBe(0o600);
  });

  it("Session JSONL 与 meta 不混入诊断信息或凭据字段", async () => {
    const { store } = makeStore();
    const ref = sessionRef("s1");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });
    await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "hi" });
    await store.appendRecord(ref, {
      type: "run_finished",
      runId: "run-1",
      outcome: "cancelled",
      persisted: true,
    });

    const raw = fs.readFileSync(messagesPathOf(store.sessionsDir, ref), "utf8");
    expect(raw).not.toMatch(/\b(DEBUG|INFO|WARN|ERROR)\b/);
    expect(raw).not.toContain("apiKey");
    expect(fs.readFileSync(metaPathOf(store.sessionsDir, ref), "utf8")).not.toContain("apiKey");
    for (const line of raw.trimEnd().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("V11 查询接口", () => {
  it("listSessions 只列指定 workspace，按创建时间倒序，不读取其他 workspace", async () => {
    let tick = 0;
    const { store } = makeStore({
      now: () => new Date(Date.UTC(2026, 9, 27, 10, 0, tick++)),
    });
    const otherWorkspace = "other-workspace-abcdef012345";
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s2" });
    await store.createSession({ workspaceId: otherWorkspace, sessionId: "s3" });

    const otherRef = sessionRef("s3", otherWorkspace);
    const otherMetaPath = metaPathOf(store.sessionsDir, otherRef);
    fs.writeFileSync(
      otherMetaPath,
      fs.readFileSync(otherMetaPath, "utf8").replace('"version":5', '"version":99'),
    );

    const listed = await store.listSessions(WORKSPACE_ID);
    expect(listed.map((meta) => meta.sessionId)).toEqual(["s2", "s1"]);
    expect(listed.every((meta) => meta.workspaceId === WORKSPACE_ID)).toBe(true);

    // 不支持版本的 Session 跳过而非抛穿整个列表（v5 硬切后目录里可能残留 v2/v3/v4）。
    expect(await store.listSessions(otherWorkspace)).toEqual([]);
    expect(await store.listSessions("nonexistent-workspace-0000")).toEqual([]);
  });

  it("混版目录只列 v5；v4 Session 拒载但文件保留", async () => {
    const { store } = makeStore();
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "new" });
    const oldRef = sessionRef("old");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "old" });
    await store.appendRecord(oldRef, { type: "user_prompt", runId: "r", text: "legacy" });
    const oldMetaPath = metaPathOf(store.sessionsDir, oldRef);
    const oldMessagesPath = messagesPathOf(store.sessionsDir, oldRef);
    const oldMeta = fs.readFileSync(oldMetaPath, "utf8").replace('"version":5', '"version":4');
    const oldMessages = fs.readFileSync(oldMessagesPath, "utf8").replace('"version":5', '"version":4');
    fs.writeFileSync(oldMetaPath, oldMeta);
    fs.writeFileSync(oldMessagesPath, oldMessages);

    expect((await store.listSessions(WORKSPACE_ID)).map((meta) => meta.sessionId)).toEqual(["new"]);
    const error = await store.loadSession(oldRef).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionVersionError);
    expect((error as SessionVersionError).foundVersion).toBe(4);
    expect(fs.readFileSync(oldMetaPath, "utf8")).toBe(oldMeta);
    expect(fs.readFileSync(oldMessagesPath, "utf8")).toBe(oldMessages);
  });

  it("readHistory 按 recordSeq 顺序返回并支持增量读取，不改文件", async () => {
    const { store } = makeStore();
    const ref = sessionRef("s1");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });
    await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "one" });
    await store.appendRecord(ref, { type: "interruption", runId: "run-1", reason: "x" });
    await store.appendRecord(ref, {
      type: "run_finished",
      runId: "run-1",
      outcome: "failed",
      persisted: true,
    });

    const path = messagesPathOf(store.sessionsDir, ref);
    const before = fs.readFileSync(path);
    const history = await store.readHistory(ref, { fromRecordSeq: 2 });
    expect(history.fromRecordSeq).toBe(2);
    expect(history.records.map((record) => record.recordSeq)).toEqual([2, 3]);
    expect(history.warnings).toEqual([]);
    expect(fs.readFileSync(path)).toEqual(before);

    const all = await store.readHistory(ref);
    expect(all.records.map((record) => record.recordSeq)).toEqual([1, 2, 3]);
    await expect(store.readHistory(ref, { fromRecordSeq: 0 })).rejects.toBeInstanceOf(SessionStoreError);
  });
});

describe("V11 tool_result 引用索引", () => {
  it("validates references from the in-memory index without rereading the Session", async () => {
    const { store } = makeStore();
    const ref = sessionRef("s1");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });
    await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "hello" });
    await store.appendRecord(ref, {
      type: "assistant_message",
      runId: "run-1",
      message: makeAssistantMessage([
        { id: "c1", name: "read" },
        { id: "c2", name: "glob" },
      ]),
    });
    const load = vi.spyOn(store, "loadSession");

    await store.appendRecord(ref, {
      type: "tool_result",
      assistantRecordSeq: 2,
      runId: "run-1",
      toolCallId: "c1",
      toolName: "read",
      status: "success",
      content: "ok",
    });
    await store.appendRecord(ref, {
      type: "tool_result",
      assistantRecordSeq: 2,
      runId: "run-1",
      toolCallId: "c2",
      toolName: "glob",
      status: "success",
      content: "ok",
    });

    expect(load).not.toHaveBeenCalled();
    load.mockRestore();
  });

  it("falls back to one disk load on an index miss and keeps the existing error", async () => {
    const { store } = makeStore();
    const ref = sessionRef("s1");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });
    await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "hello" });
    await store.appendRecord(ref, {
      type: "assistant_message",
      runId: "run-1",
      message: makeAssistantMessage([{ id: "c1", name: "read" }]),
    });
    const writers = (
      store as unknown as {
        writers: Map<string, { assistants: Map<number, unknown> }>;
      }
    ).writers;
    const state = writers.get(`${WORKSPACE_ID}/s1`)!;
    const load = vi.spyOn(store, "loadSession");

    state.assistants.clear();
    await store.appendRecord(ref, {
      type: "tool_result",
      assistantRecordSeq: 2,
      runId: "run-1",
      toolCallId: "c1",
      toolName: "read",
      status: "success",
      content: "ok",
    });
    expect(load).toHaveBeenCalledTimes(1);

    state.assistants.clear();
    load.mockClear();
    await expect(
      store.appendRecord(ref, {
        type: "tool_result",
        assistantRecordSeq: 2,
        runId: "run-1",
        toolCallId: "c1",
        toolName: "glob",
        status: "success",
        content: "ok",
      }),
    ).rejects.toThrow("tool_result: 无效的 Assistant 调用引用");
    expect(load).toHaveBeenCalledTimes(1);
    load.mockRestore();
  });
});

it("loads persisted elapsedMs in a fresh Node process", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { pathToFileURL } = await import("node:url");
  const { store, sessionsDir } = makeStore();
  const ref = sessionRef("duration-process");
  await store.createSession(ref);
  await store.appendRecord(ref, {
    type: "run_finished",
    runId: "r",
    outcome: "completed",
    persisted: true,
    elapsedMs: 3723000,
  });
  const { resolve } = await import("node:path");
  const moduleUrl = pathToFileURL(resolve("src/sessions/session-store.ts")).href;
  const code = `import {SessionStore} from ${JSON.stringify(moduleUrl)}; const store=new SessionStore({sessionsDir:process.argv[1]}); console.log(JSON.stringify((await store.loadSession(JSON.parse(process.argv[2]))).records));`;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    code,
    sessionsDir,
    JSON.stringify(ref),
  ]);
  expect(JSON.parse(stdout)).toEqual([expect.objectContaining({ type: "run_finished", elapsedMs: 3723000 })]);
});

describe("exclusive Session ownership", () => {
  it("rejects another Store even in the same PID, then reloads sequence after release", async () => {
    const { store, sessionsDir } = makeStore();
    const other = makeStore({ sessionsDir }).store;
    const ref = sessionRef("ownership");
    await store.createSession({ ...ref });
    await store.appendRecord(ref, { type: "user_prompt", runId: "r1", text: "first" });
    await expect(
      other.appendRecord(ref, { type: "user_prompt", runId: "bad", text: "bad" }),
    ).rejects.toMatchObject({ code: "not_owned" });
    await expect(other.openSession(ref)).rejects.toMatchObject({ code: "occupied" });
    await store.releaseSession(ref);
    await other.openSession(ref);
    const record = await other.appendRecord(ref, { type: "user_prompt", runId: "r2", text: "second" });
    expect(record.recordSeq).toBe(2);
    await expect(
      store.appendRecord(ref, { type: "user_prompt", runId: "bad", text: "bad" }),
    ).rejects.toMatchObject({ code: "not_owned" });
    await other.releaseSession(ref);
  });

  it("waits for admitted writes and rejects new writes as soon as release begins", async () => {
    let entered!: () => void;
    let proceed!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const { store, sessionsDir } = makeStore({
      hooks: {
        beforeAppend: async () => {
          entered();
          await blocked;
        },
      },
    });
    const ref = sessionRef("release");
    await store.createSession(ref);
    const writing = store.appendRecord(ref, { type: "user_prompt", runId: "r", text: "hello" });
    await ready;
    const releasing = store.releaseSession(ref);
    await expect(
      store.appendRecord(ref, { type: "user_prompt", runId: "late", text: "late" }),
    ).rejects.toMatchObject({ code: "not_owned" });
    await expect(makeStore({ sessionsDir }).store.openSession(ref)).rejects.toMatchObject({
      code: "occupied",
    });
    proceed();
    await writing;
    await releasing;
    const other = makeStore({ sessionsDir }).store;
    expect((await other.openSession(ref)).records).toHaveLength(1);
    await other.releaseSession(ref);
  });
});

it("refuses partial and stale locks, and never removes a replacement owner's lock", async () => {
  const { store, sessionsDir } = makeStore();
  const ref = sessionRef("stale");
  await store.createSession(ref);
  const file = messagesPathOf(sessionsDir, ref).replace("messages.jsonl", "stale.session.lock");
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, "{");
  const other = makeStore({ sessionsDir }).store;
  await expect(other.openSession(ref)).rejects.toMatchObject({ code: "occupied" });
  await expect(store.releaseSession(ref)).rejects.toMatchObject({ code: "not_owned" });
  expect(fs.readFileSync(file, "utf8")).toBe("{");
  const replacement = JSON.stringify({
    ...JSON.parse(original),
    ownerToken: "replacement",
    pid: 999999999,
    acquiredAt: "1970-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(file, replacement);
  await expect(other.openSession(ref)).rejects.toMatchObject({ code: "occupied" });
  await expect(store.releaseSession(ref)).rejects.toMatchObject({ code: "not_owned" });
  expect(fs.readFileSync(file, "utf8")).toBe(replacement);
});

it("does not acquire an unpublished initialization directory", async () => {
  let entered!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pause = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { store, sessionsDir } = makeStore({
    hooks: {
      beforeAppend: async () => {
        entered();
        await pause;
      },
    },
  });
  const ref = sessionRef("initializing");
  const creating = store.createSession({
    ...ref,
    initialRecords: [{ type: "user_prompt", runId: "r", text: "hello" }],
  });
  await ready;
  const other = makeStore({ sessionsDir }).store;
  try {
    await expect(other.openSession(ref)).rejects.toMatchObject({ code: "not_found" });
  } finally {
    finish();
    await creating;
  }
});

it("reports lock diagnostics on contention without dumping arbitrary lock fields", async () => {
  const { store, sessionsDir } = makeStore();
  const ref = sessionRef("diagnostics");
  await store.createSession(ref);
  const lockPath = messagesPathOf(sessionsDir, ref).replace("messages.jsonl", "diagnostics.session.lock");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  fs.writeFileSync(lockPath, JSON.stringify({ ...lock, secret: "do-not-echo" }));
  const error = await makeStore({ sessionsDir })
    .store.openSession(ref)
    .catch((error: unknown) => error);
  expect((error as Error).message).toContain(`pid=${process.pid}`);
  expect((error as Error).message).toContain(lock.ownerToken);
  expect((error as Error).message).not.toContain("do-not-echo");
});

it("serializes an owned reopen behind admitted appends without resetting record sequence", async () => {
  let entered!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pause = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { store } = makeStore({
    hooks: {
      beforeAppend: async (info) => {
        if (info.recordSeq === 1) {
          entered();
          await pause;
        }
      },
    },
  });
  const ref = sessionRef("reopen");
  await store.createSession(ref);
  const first = store.appendRecord(ref, { type: "user_prompt", runId: "r1", text: "one" });
  await ready;
  const reopening = store.openSession(ref);
  await new Promise((resolve) => setTimeout(resolve, 30));
  finish();
  await first;
  await reopening;
  await store.appendRecord(ref, { type: "user_prompt", runId: "r2", text: "two" });
  expect((await store.loadSession(ref)).records.map((r) => r.recordSeq)).toEqual([1, 2]);
});

it.each(["beforeLockWrite", "beforeLockSync"] as const)(
  "cleans its own failed acquisition at %s without retaining a writer",
  async (stage) => {
    const { store, sessionsDir } = makeStore();
    const ref = sessionRef("lock-io");
    await store.createSession(ref);
    await store.releaseSession(ref);
    const other = makeStore({
      sessionsDir,
      hooks: {
        [stage]: () => {
          throw new Error("injected lock I/O failure");
        },
      },
    }).store;
    await expect(other.openSession(ref)).rejects.toThrow(/injected lock|占用初始化失败/);
    expect(await store.isSessionOccupied(ref)).toBe(false);
    await expect(
      other.appendRecord(ref, { type: "user_prompt", runId: "r", text: "x" }),
    ).rejects.toMatchObject({ code: "not_owned" });
    await store.openSession(ref);
    await store.releaseSession(ref);
  },
);

describe("autoDecisionEnabled persistence", () => {
  it.each([undefined, true, false])("saves %s in both creation paths", async (enabled) => {
    const { store } = makeStore();
    for (const initialRecords of [undefined, []]) {
      const meta = await store.createSession({
        workspaceId: WORKSPACE_ID,
        autoDecisionEnabled: enabled,
        initialRecords,
      });
      const ref = sessionRef(meta.sessionId);
      expect(meta.autoDecisionEnabled).toBe(enabled ?? true);
      expect((await store.readSessionMeta(ref)).autoDecisionEnabled).toBe(enabled ?? true);
    }
  });
  it("preserves other fields and JSONL and serializes concurrent updates", async () => {
    const { store } = makeStore();
    const ref = sessionRef("toggle");
    await store.createSession(ref);
    const target = metaPathOf(store.sessionsDir, ref);
    const prior = JSON.parse(fs.readFileSync(target, "utf8"));
    prior.sourceSessionId = "legacy-source";
    fs.writeFileSync(target, JSON.stringify(prior));
    const messages = fs.readFileSync(messagesPathOf(store.sessionsDir, ref), "utf8");
    const [off, on] = await Promise.all([
      store.setAutoDecisionEnabled(ref, false),
      store.setAutoDecisionEnabled(ref, true),
    ]);
    expect(off).toEqual({ ...prior, autoDecisionEnabled: false });
    expect(on).toEqual(prior);
    expect(await store.readSessionMeta(ref)).toEqual(on);
    expect(fs.readFileSync(messagesPathOf(store.sessionsDir, ref), "utf8")).toBe(messages);
  });
  it.each(["beforeMetaWrite", "beforeMetaSync", "beforeMetaReplace", "afterMetaReplace"] as const)(
    "resynchronizes after %s failure",
    async (stage) => {
      let fail = false;
      const fault = new Error("metadata fault");
      const { store } = makeStore({
        hooks: {
          [stage]: () => {
            if (fail) throw fault;
          },
        },
      });
      const ref = sessionRef("fault");
      const prior = await store.createSession(ref);
      fail = true;
      await expect(store.setAutoDecisionEnabled(ref, false)).rejects.toMatchObject({
        code: "write_failed",
        cause: fault,
      });
      expect(await store.readSessionMeta(ref)).toEqual({
        ...prior,
        autoDecisionEnabled: stage !== "afterMetaReplace",
      });
      expect(
        fs
          .readdirSync(metaPathOf(store.sessionsDir, ref).replace(/meta\.json$/, ""))
          .filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
      fail = false;
      await expect(store.setAutoDecisionEnabled(ref, false)).resolves.toMatchObject({
        autoDecisionEnabled: false,
      });
    },
  );
  it("rejects reads and updates without ownership or while releasing", async () => {
    const { store } = makeStore();
    const ref = sessionRef("ownership");
    await store.createSession(ref);
    const other = makeStore({ sessionsDir: store.sessionsDir }).store;
    await expect(other.readSessionMeta(ref)).rejects.toMatchObject({ code: "not_owned" });
    await expect(other.setAutoDecisionEnabled(ref, false)).rejects.toMatchObject({ code: "not_owned" });
    const release = store.releaseSession(ref);
    await expect(store.readSessionMeta(ref)).rejects.toMatchObject({ code: "not_owned" });
    await expect(store.setAutoDecisionEnabled(ref, false)).rejects.toMatchObject({ code: "not_owned" });
    await release;
  });
  it("verifies the on-disk owner token for reads and updates", async () => {
    const { store } = makeStore();
    const ref = sessionRef("changed-lock");
    await store.createSession(ref);
    const lockPath = metaPathOf(store.sessionsDir, ref).replace(
      /meta\.json$/,
      `${ref.sessionId}.session.lock`,
    );
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    fs.writeFileSync(lockPath, JSON.stringify({ ...lock, ownerToken: "other" }));
    await expect(store.readSessionMeta(ref)).rejects.toMatchObject({ code: "not_owned" });
    await expect(store.setAutoDecisionEnabled(ref, false)).rejects.toMatchObject({ code: "not_owned" });
  });
});
