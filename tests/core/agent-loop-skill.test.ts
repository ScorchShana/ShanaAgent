import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/agent-loop.js";
import { wrapConversationSummary } from "../../src/core/context-builder.js";
import type { BusEvent } from "../../src/core/events.js";
import { renderSkillMessage, SkillLoadError } from "../../src/core/skills.js";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import type { StreamTurnOptions, TurnResult } from "../../src/llm/model-service.js";
import { parseSettings } from "../../src/llm/settings-store.js";
import type { SkillSnapshot, StoredAssistantMessage } from "../../src/sessions/records.js";
import {
  makeAssistantMessage,
  makeStore,
  sessionRef,
  WORKSPACE_ID,
  tempDir,
  cleanupTempDirs,
} from "../sessions/helpers.js";

// 阈值 10000（20000 × 0.5）：skill Run 的实测 usage 高于阈值而字符估算远低于阈值，
// 下一 Run 只有锚定前缀重建逐字一致（含 skill 展开）才会触发压缩——以此锁死渲染同构。
const SETTINGS = {
  compactionThresholdRatio: 0.5,
  compactionRetainedContextRatio: 1,
  compactionRetainedContextMaxTokens: 10_000_000,
  maxTurns: 40,
};
const MEASURED_PROMPT = 12000;
const SKILL_BODY = "# Review\n\ncheck the diff carefully";

const model: ResolvedModel = {
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
  contextWindow: 20000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUnknown: true,
};

function turn(message: StoredAssistantMessage): TurnResult {
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

function measuredMessage(text: string, input = MEASURED_PROMPT): StoredAssistantMessage {
  const message = makeAssistantMessage([], text);
  message.provider = model.providerId;
  message.model = model.id;
  message.usage = { ...message.usage, input, output: 5, totalTokens: input + 5 };
  return message;
}

function summaryTurn(text: string): TurnResult {
  return { ...turn(makeAssistantMessage([], text)), text };
}

interface FixtureOptions {
  // 缺省预建 Session；false 时首次提交才懒创建（验证加载失败不创建 Session）。
  precreate?: boolean;
}

async function skillFixture(
  script: (call: number, options: StreamTurnOptions) => TurnResult | Promise<TurnResult>,
  options: FixtureOptions = {},
) {
  const { store } = makeStore();
  const ref = sessionRef("skill-loop");
  if (options.precreate !== false) {
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: ref.sessionId });
  }
  const workspaceRoot = tempDir();
  const skillsRoot = tempDir("shana-skills-");
  fs.mkdirSync(path.join(skillsRoot, "review"));
  fs.writeFileSync(path.join(skillsRoot, "review", "SKILL.md"), `---\ndescription: d\n---\n${SKILL_BODY}\n`);
  const requests: StreamTurnOptions[] = [];
  const events: BusEvent[] = [];
  let call = 0;
  const session = await createAgentSession({
    store,
    ...(options.precreate !== false ? { ref } : {}),
    workspaceId: WORKSPACE_ID,
    workspaceRoot,
    skillsRoot,
    getModel: () => model,
    getSettings: () => parseSettings(SETTINGS),
    modelService: {
      streamTurn: async (streamOptions) => {
        requests.push(streamOptions);
        call += 1;
        return script(call, streamOptions);
      },
    },
  });
  session.controller.eventBus.subscribe((event) => events.push(event));
  return { ...session, store, ref, requests, events, workspaceRoot, skillsRoot };
}

function lastUserContent(request: StreamTurnOptions): string {
  const message = request.context.messages.at(-1)!;
  if (message.role !== "user" || typeof message.content !== "string") {
    throw new Error("expected a text user message");
  }
  return message.content;
}

function startedCompactions(events: BusEvent[]) {
  return events.filter((event) => event.type === "compaction.started");
}

afterEach(cleanupTempDirs);

it("skill 提交：记录存完整原文 + 快照，请求展开为权威格式，run.finished 恰一次", async () => {
  const f = await skillFixture(() => turn(makeAssistantMessage([], "done")));
  expect(await f.controller.submitPrompt("/skill:review fix the bug")).toBe("completed");

  const { records } = await f.store.loadSession(f.ref);
  const prompt = records.find((record) => record.type === "user_prompt");
  expect(prompt).toMatchObject({ text: "/skill:review fix the bug" });
  const skill = (prompt as { skill: SkillSnapshot }).skill;
  expect(skill.name).toBe("review");
  expect(skill.content).toBe(SKILL_BODY);
  expect(skill.location).toBe(fs.realpathSync.native(path.join(f.skillsRoot, "review", "SKILL.md")));

  expect(f.requests).toHaveLength(1);
  expect(lastUserContent(f.requests[0]!)).toBe(renderSkillMessage(skill, "fix the bug"));
  expect(f.events.filter((event) => event.type === "run.finished")).toHaveLength(1);
});

it("标题与 /resume 预览剥命令前缀；空请求回退 skill:<name>", async () => {
  const f = await skillFixture(() => turn(makeAssistantMessage([], "done")));
  await f.controller.submitPrompt("/skill:review fix the bug\nsecond line");
  expect(f.controller.getSnapshot().session.title).toBe("fix the bug");
  const entries = await f.controller.listSessions();
  expect(entries[0]).toMatchObject({ title: "fix the bug", preview: "fix the bug\nsecond line" });

  const empty = await skillFixture(() => turn(makeAssistantMessage([], "done")));
  await empty.controller.submitPrompt("/skill:review");
  expect(empty.controller.getSnapshot().session.title).toBe("skill:review");
  expect((await empty.controller.listSessions())[0]).toMatchObject({
    title: "skill:review",
    preview: "skill:review",
  });
  expect(lastUserContent(empty.requests[0]!).endsWith("</skill>")).toBe(true);
});

it("加载失败同步抛 SkillLoadError：不创建 Session、无事件、状态 idle，普通提交不受影响", async () => {
  const f = await skillFixture(() => turn(makeAssistantMessage([], "done")), { precreate: false });
  expect(() => f.controller.submitPrompt("/skill:ghost fix")).toThrow(SkillLoadError);
  expect(await f.store.listSessions(WORKSPACE_ID)).toEqual([]);
  expect(f.events).toHaveLength(0);
  expect(f.controller.getSnapshot().status).toEqual({ kind: "idle" });

  expect(await f.controller.submitPrompt("plain prompt")).toBe("completed");
  expect(f.requests).toHaveLength(1);
  expect(lastUserContent(f.requests[0]!)).toBe("plain prompt");
  const listed = await f.store.listSessions(WORKSPACE_ID);
  expect(listed).toHaveLength(1);
});

it("锚定：skill Run 的实测锚定下一 Run（展开前缀重建逐字一致），摘要输入同源展开", async () => {
  const f = await skillFixture((call) => {
    if (call === 1) return turn(measuredMessage("done"));
    if (call === 2) return summaryTurn("SUMMARY");
    return turn(makeAssistantMessage([], "next done"));
  });
  expect(await f.controller.submitPrompt("/skill:review fix the bug")).toBe("completed");
  expect(startedCompactions(f.events)).toHaveLength(0);

  // 第二 Run：纯估算远低于阈值，触发压缩只能来自锚定——要求含 skill 展开的前缀重建一致。
  expect(await f.controller.submitPrompt("next task")).toBe("completed");
  expect(f.requests).toHaveLength(3);
  expect(startedCompactions(f.events)).toHaveLength(1);
  const summaryInput = f.requests[1]!.context.messages;
  expect(summaryInput[0]).toMatchObject({
    role: "user",
    content: renderSkillMessage(
      {
        name: "review",
        location: fs.realpathSync.native(path.join(f.skillsRoot, "review", "SKILL.md")),
        content: SKILL_BODY,
      },
      "fix the bug",
    ),
  });
  expect(f.requests[2]!.context.messages[0]).toMatchObject({
    role: "user",
    content: wrapConversationSummary("SUMMARY"),
  });
  expect(f.events.filter((event) => event.type === "run.finished")).toHaveLength(2);
});

it("resume 回放：快照记录驱动重建，与新 Run 起点发送逐字一致", async () => {
  const f = await skillFixture(() => turn(makeAssistantMessage([], "done")));
  await f.controller.submitPrompt("/skill:review fix the bug");
  const sentContent = lastUserContent(f.requests[0]!);
  // 释放占用后以同一 store/ref 重建会话，模拟重启后 resume。
  await f.controller.newSession();

  const requests: StreamTurnOptions[] = [];
  const session = await createAgentSession({
    store: f.store,
    ref: f.ref,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: f.workspaceRoot,
    skillsRoot: f.skillsRoot,
    getModel: () => model,
    getSettings: () => parseSettings(SETTINGS),
    modelService: {
      streamTurn: async (options) => {
        requests.push(options);
        return turn(makeAssistantMessage([], "next done"));
      },
    },
  });
  expect(await session.controller.submitPrompt("next task")).toBe("completed");
  expect(requests).toHaveLength(1);
  const replayed = requests[0]!.context.messages.find(
    (message) =>
      message.role === "user" && typeof message.content === "string" && message.content.startsWith("<skill "),
  );
  expect(replayed).toMatchObject({ content: sentContent });
});
