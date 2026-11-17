import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SessionCorruptionError, SessionWriteError } from "../../src/sessions/session-store.js";
import { cleanupTempDirs, makeStore, messagesPathOf, sessionRef, WORKSPACE_ID } from "./helpers.js";

afterEach(cleanupTempDirs);

async function seedSession() {
  const { store, sessionsDir } = makeStore();
  const ref = sessionRef("s1");
  await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });
  await store.appendRecord(ref, { type: "user_prompt", runId: "run-1", text: "one" });
  await store.appendRecord(ref, { type: "interruption", runId: "run-1", reason: "x" });
  await store.appendRecord(ref, {
    type: "run_finished",
    runId: "run-1",
    outcome: "completed",
    persisted: true,
  });
  return { store, sessionsDir, ref, path: messagesPathOf(sessionsDir, ref) };
}

describe("V7 损坏区分", () => {
  it("中间行损坏：停止加载并报告行号与字节偏移，文件不变", async () => {
    const { store, path, ref } = await seedSession();
    const raw = fs.readFileSync(path, "utf8");
    const lines = raw.trimEnd().split("\n");
    const damaged = `${lines[0]}\n{ broken json\n${lines.slice(1).join("\n")}\n`;
    fs.writeFileSync(path, damaged);

    const error = await store.loadSession(ref).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionCorruptionError);
    const corruption = error as SessionCorruptionError;
    expect(corruption.line).toBe(2);
    expect(corruption.byteOffset).toBe(Buffer.byteLength(`${lines[0]}\n`));
    expect(fs.readFileSync(path, "utf8")).toBe(damaged);
  });

  it("末尾完整行的 JSON 损坏按中间损坏处理，不当作截断恢复", async () => {
    const { store, path, ref } = await seedSession();
    fs.appendFileSync(path, "{ broken }\n");

    const error = await store.loadSession(ref).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionCorruptionError);
    expect((error as SessionCorruptionError).line).toBe(4);
  });

  it("合法 JSON 但非法 status 的加载按损坏处理", async () => {
    const { store, path, ref } = await seedSession();
    const lines = fs.readFileSync(path, "utf8").trimEnd().split("\n");
    lines[1] = JSON.stringify({
      recordSeq: 2,
      ts: "2026-10-27T10:00:00.000Z",
      type: "tool_result",
      assistantRecordSeq: 1,
      runId: "run-1",
      toolCallId: "c1",
      toolName: "read",
      status: "ok",
      content: "",
    });
    fs.writeFileSync(path, `${lines.join("\n")}\n`);

    const error = await store.loadSession(ref).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionCorruptionError);
    expect((error as SessionCorruptionError).line).toBe(2);
    expect((error as Error).message).toMatch(/"status"/);
  });

  it("recordSeq 不连续按损坏处理", async () => {
    const { store, path, ref } = await seedSession();
    const lines = fs.readFileSync(path, "utf8").trimEnd().split("\n");
    const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    lines[1] = JSON.stringify({ ...second, recordSeq: 5 });
    const damaged = `${lines.join("\n")}\n`;
    fs.writeFileSync(path, damaged);

    const error = await store.loadSession(ref).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionCorruptionError);
    expect((error as SessionCorruptionError).line).toBe(2);
    expect((error as Error).message).toMatch(/recordSeq 不连续/);
  });

  it("末尾半行截断：按完整前缀恢复并报告，原始文件不被覆盖", async () => {
    const { store, sessionsDir, path, ref } = await seedSession();
    const raw = fs.readFileSync(path, "utf8");
    const truncated = raw.slice(0, raw.length - 5);
    expect(truncated.endsWith("\n")).toBe(false);
    fs.writeFileSync(path, truncated);
    const before = fs.readFileSync(path);

    const loaded = await store.loadSession(ref);
    expect(loaded.records.map((record) => record.recordSeq)).toEqual([1, 2]);
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]?.kind).toBe("tail_truncated");
    expect(loaded.warnings[0]?.line).toBe(3);
    expect(loaded.warnings[0]?.byteOffset).toBe(
      Buffer.byteLength(truncated.slice(0, truncated.lastIndexOf("\n") + 1)),
    );
    expect(fs.readFileSync(path)).toEqual(before);

    const { store: freshStore } = makeStore({ sessionsDir });
    await expect(
      freshStore.appendRecord(ref, { type: "interruption", runId: "run-1", reason: "y" }),
    ).rejects.toBeInstanceOf(SessionWriteError);
    expect(fs.readFileSync(path)).toEqual(before);
  });

  it("末尾截断后重新加载仍只返回完整前缀", async () => {
    const { store, path, ref } = await seedSession();
    const raw = fs.readFileSync(path, "utf8");
    fs.writeFileSync(path, raw.slice(0, raw.length - 12));

    const first = await store.loadSession(ref);
    const second = await store.loadSession(ref);
    expect(first.records).toEqual(second.records);
    expect(first.warnings).toEqual(second.warnings);
  });
});
