import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../../src/core/session-controller.js";
import type { SessionRecord, SkillSnapshot } from "../../src/sessions/records.js";
import { parseSettings } from "../../src/llm/settings-store.js";
import { TuiStore } from "../../src/tui/store.js";
import { cleanupTempDirs, tempDir, writeFileAt } from "../tools/helpers.js";

afterEach(cleanupTempDirs);

const SNAPSHOT: SkillSnapshot = {
  name: "review",
  location: "/skills/review/SKILL.md",
  content: "# Review\n\ncheck the diff",
};

function skillController(options: {
  skillsRoot?: string;
  execute?: ConstructorParameters<typeof SessionController>[0]["driver"]["execute"];
  persistRunStart?: (runId: string, prompt: string, skill?: SkillSnapshot) => Promise<void>;
}) {
  return new SessionController({
    driver: { execute: options.execute ?? (async () => ({ outcome: "completed" })) },
    skillsRoot: options.skillsRoot,
    commands: {
      readHistory: async () => ({
        meta: { version: 5, workspaceId: "ws", sessionId: "s", createdAt: "now" },
        records: [],
        warnings: [],
        fromRecordSeq: 1,
      }),
    },
    hooks: {
      persistRunStart: options.persistRunStart,
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

function seedHistory(core: SessionController, records: SessionRecord[]): void {
  vi.spyOn(core, "readHistory").mockResolvedValue({
    meta: { version: 5, workspaceId: "ws", sessionId: "s", createdAt: "now" },
    records,
    warnings: [],
    fromRecordSeq: 1,
  });
}

function prompt(seq: number, runId: string, text: string, skill?: SkillSnapshot): SessionRecord {
  return { recordSeq: seq, ts: "now", type: "user_prompt", runId, text, ...(skill ? { skill } : {}) };
}

function finished(seq: number, runId: string, outcome: "completed" | "cancelled"): SessionRecord {
  return { recordSeq: seq, ts: "now", type: "run_finished", runId, outcome, persisted: true };
}

describe("TUI skill 块（D8/D9/D10）", () => {
  it("skill 块在气泡之前、气泡只含请求原文；取消收尾行仍在气泡后；折叠/展开复用 toggle", async () => {
    const core = skillController({});
    seedHistory(core, [
      prompt(1, "r1", "/skill:review fix the bug", SNAPSHOT),
      finished(2, "r1", "cancelled"),
    ]);
    const store = new TuiStore(core, parseSettings({}));
    try {
      await store.refreshHistory();
      const items = store.items();
      const skillIndex = items.findIndex((item) => item.id === "skill-1");
      const promptIndex = items.findIndex((item) => item.id === "prompt-1");
      const outcomeIndex = items.findIndex((item) => item.text === "✗ 已取消");
      expect(skillIndex).toBeGreaterThanOrEqual(0);
      expect(skillIndex).toBeLessThan(promptIndex);
      expect(promptIndex).toBeLessThan(outcomeIndex);
      expect(items[skillIndex]).toMatchObject({
        role: "skill",
        text: "skill:review",
        skillContent: SNAPSHOT.content,
      });
      expect(items[promptIndex]).toMatchObject({ role: "user", text: "fix the bug" });
      expect(store.getSnapshot().expanded.has("skill-1")).toBe(false);
      store.toggle("skill-1");
      expect(store.getSnapshot().expanded.has("skill-1")).toBe(true);
      store.toggle("skill-1");
      expect(store.getSnapshot().expanded.has("skill-1")).toBe(false);
    } finally {
      await store.dispose();
    }
  });

  it("interrupted notice → skill 块 → 气泡顺序与模型侧叠加同构", async () => {
    const core = skillController({});
    seedHistory(core, [
      prompt(1, "r1", "cancelled task"),
      finished(2, "r1", "cancelled"),
      prompt(3, "r2", "/skill:review fix the bug", SNAPSHOT),
      finished(4, "r2", "cancelled"),
    ]);
    const store = new TuiStore(core, parseSettings({}));
    try {
      await store.refreshHistory();
      const ids = store.items().map((item) => item.id);
      expect(ids.indexOf("interrupted-prompt-3")).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf("interrupted-prompt-3")).toBeLessThan(ids.indexOf("skill-3"));
      expect(ids.indexOf("skill-3")).toBeLessThan(ids.indexOf("prompt-3"));
      expect(ids.indexOf("prompt-3")).toBeLessThan(ids.indexOf("outcome-4"));
    } finally {
      await store.dispose();
    }
  });

  it("空请求：只有 skill 块，不渲染空气泡", async () => {
    const core = skillController({});
    seedHistory(core, [prompt(1, "r1", "/skill:review", SNAPSHOT), finished(2, "r1", "completed")]);
    const store = new TuiStore(core, parseSettings({}));
    try {
      await store.refreshHistory();
      const items = store.items();
      expect(items.some((item) => item.id === "skill-1")).toBe(true);
      expect(items.some((item) => item.id === "prompt-1")).toBe(false);
    } finally {
      await store.dispose();
    }
  });

  it("live 提交：快照经 persistRunStart 落盘派生，streaming 阶段即可见（resume 回放同路径）", async () => {
    const records: SessionRecord[] = [];
    let finish!: (value: { outcome: "completed" }) => void;
    const skillsRoot = tempDir("shana-skills-");
    writeFileAt(skillsRoot, "review/SKILL.md", SNAPSHOT.content);
    const core = skillController({
      skillsRoot,
      execute: async (handle) => {
        handle.beginAttempt(1, 1);
        handle.streamText("ok");
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      persistRunStart: async (runId, text, skill) => {
        records.push(prompt(records.length + 1, runId, text, skill));
      },
    });
    vi.spyOn(core, "readHistory").mockImplementation(async () => ({
      meta: { version: 5, workspaceId: "ws", sessionId: "s", createdAt: "now" },
      records: [...records],
      warnings: [],
      fromRecordSeq: 1,
    }));
    const store = new TuiStore(core, parseSettings({}), { skillsRoot });
    store.setDraft("/skill:review fix the bug");
    const run = store.submit();
    try {
      await vi.waitFor(() => {
        const items = store.items();
        expect(items.some((item) => item.role === "skill" && item.text === "skill:review")).toBe(true);
        expect(items.some((item) => item.role === "user" && item.text === "fix the bug")).toBe(true);
      });
      // 记录恒存完整原文（审计不变）。
      expect(records[0]).toMatchObject({ text: "/skill:review fix the bug" });
      expect((records[0] as { skill: SkillSnapshot }).skill.content).toBe(SNAPSHOT.content);
    } finally {
      finish({ outcome: "completed" });
      await run;
      await store.dispose();
    }
  });
});

describe("TUI /skill: 菜单与路由（D5/D11）", () => {
  it("菜单按需读目录：过滤字符集、排序、前缀过滤；缺目录空列表；/ 菜单含提示项", async () => {
    const skillsRoot = tempDir("shana-skills-");
    fs.mkdirSync(path.join(skillsRoot, "review"));
    fs.mkdirSync(path.join(skillsRoot, "commit-helper"));
    fs.mkdirSync(path.join(skillsRoot, "Bad"));
    writeFileAt(skillsRoot, "plain.txt", "x");
    const core = skillController({});
    const store = new TuiStore(core, parseSettings({}), { skillsRoot });
    try {
      store.setDraft("/skill:");
      expect(store.commandOptions().map((option) => option.name)).toEqual([
        "/skill:commit-helper",
        "/skill:review",
      ]);
      store.setDraft("/skill:re");
      expect(store.commandOptions().map((option) => option.name)).toEqual(["/skill:review"]);
      // 运行期间新增 skill 立即可补全（无缓存）。
      fs.mkdirSync(path.join(skillsRoot, "deploy"));
      store.setDraft("/skill:");
      expect(store.commandOptions().map((option) => option.name)).toContain("/skill:deploy");
      store.setDraft("/");
      expect(store.commandOptions().map((option) => option.name)).toContain("/skill:");
      const missing = new TuiStore(skillController({}), parseSettings({}), {
        skillsRoot: path.join(skillsRoot, "missing"),
      });
      missing.setDraft("/skill:");
      expect(missing.commandOptions()).toEqual([]);
      await missing.dispose();
    } finally {
      await store.dispose();
    }
  });

  it("运行中 skill 补全项 disabled", async () => {
    let finish!: (value: { outcome: "completed" }) => void;
    const skillsRoot = tempDir("shana-skills-");
    fs.mkdirSync(path.join(skillsRoot, "review"));
    const core = skillController({
      execute: async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const store = new TuiStore(core, parseSettings({}), { skillsRoot });
    store.setDraft("plain");
    const run = store.submit();
    try {
      await vi.waitFor(() => expect(core.getSnapshot().status.kind).toBe("running"));
      store.setDraft("/skill:");
      expect(store.commandOptions().every((option) => !option.enabled)).toBe(true);
    } finally {
      finish({ outcome: "completed" });
      await run;
      await store.dispose();
    }
  });

  it("/skill: 路由进 submitPrompt；加载失败 notice 报错且草稿保留可重提", async () => {
    const skillsRoot = tempDir("shana-skills-");
    writeFileAt(skillsRoot, "review/SKILL.md", "body");
    let calls = 0;
    const core = skillController({
      skillsRoot,
      execute: async () => {
        calls++;
        return { outcome: "completed" };
      },
    });
    const store = new TuiStore(core, parseSettings({}), { skillsRoot });
    try {
      store.setDraft("/skill:ghost fix");
      await store.submit();
      const notice = store.getSnapshot().notice;
      expect(notice?.error).toBe(true);
      expect(notice?.text).toContain('Skill "ghost"');
      expect(store.getSnapshot().draft).toBe("/skill:ghost fix");
      expect(calls).toBe(0);
      expect(store.getSnapshot().core.status.kind).toBe("idle");

      store.setDraft("/skill:review ok");
      await store.submit();
      expect(calls).toBe(1);
      expect(store.getSnapshot().draft).toBe("");
    } finally {
      await store.dispose();
    }
  });

  it("未知命令提示文案包含 /skill:", async () => {
    const core = skillController({});
    const store = new TuiStore(core, parseSettings({}));
    try {
      store.setDraft("/bogus");
      await store.submit();
      expect(store.getSnapshot().notice?.text).toContain("/skill:");
      expect(store.getSnapshot().notice?.error).toBe(true);
    } finally {
      await store.dispose();
    }
  });
});
