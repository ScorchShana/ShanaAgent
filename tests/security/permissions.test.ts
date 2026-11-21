import fs from "node:fs";
import path from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createPathPolicy } from "../../src/security/path-policy.js";
import {
  emptySessionGrants,
  evaluatePermission,
  withGrant,
  type ApprovalMode,
  type ApprovalRequest,
  type PermissionVerdict,
} from "../../src/security/permissions.js";
import { createToolRegistry, type ToolAction } from "../../src/tools/registry.js";
import { parseSettings } from "../../src/llm/settings-store.js";
import { detectShell } from "../../src/tools/shell.js";
import {
  cleanupTempDirs,
  createDirLink,
  makeWorkspace,
  supportsDirectoryLinks,
  tempDir,
  writeFileAt,
} from "../tools/helpers.js";

afterEach(cleanupTempDirs);

const DIR_LINKS = supportsDirectoryLinks();
const shellName = detectShell(process.platform).kind;
const MODES: readonly ApprovalMode[] = ["readonly", "auto", "full"];

async function prepareAction(
  root: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolAction> {
  const registry = createToolRegistry();
  const tool = registry.get(toolName);
  if (!tool) throw new Error(`tool not registered: ${toolName}`);
  const plan = await tool.prepare(args as JsonObject, {
    workspaceRoot: root,
    pathPolicy: createPathPolicy(root),
    platform: process.platform,
  });
  return plan.action;
}

async function verdictFor(
  root: string,
  toolName: string,
  args: Record<string, unknown>,
  mode: ApprovalMode,
  grants = emptySessionGrants(),
): Promise<PermissionVerdict> {
  const action = await prepareAction(root, toolName, args);
  return evaluatePermission({ toolCallId: "call-1", toolName, action }, grants, mode);
}

function requireAsk(verdict: PermissionVerdict): ApprovalRequest {
  if (verdict.outcome !== "ask") throw new Error(`expected ask, got ${verdict.outcome}`);
  return verdict.request;
}

function outsideLayout(): { root: string; parent: string } {
  const parent = tempDir("shana-parent-");
  const root = path.join(parent, "ws");
  fs.mkdirSync(root);
  return { root, parent };
}

describe("read 类：区内/skills 区放行与模式无关，区外逐次人工（full 除外）", () => {
  it("工作区内 read/glob/grep：readonly/auto workspace_read；full 按 §3.1 顺序 mode_full", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "src/a.ts", "x");
    writeFileAt(root, "src/b.ts", "y");

    // 生产路径上区内读由 executor defaultNeedsApproval 跳过门控（三模式均不触达
    // evaluatePermission）；此处直接验证纯函数在各模式下的判定。
    for (const mode of ["readonly", "auto"] as const) {
      for (const [toolName, args] of [
        ["read", { path: "src/a.ts" }],
        ["glob", { pattern: "src/*.ts" }],
        ["grep", { pattern: "x", path: "src" }],
      ] as const) {
        expect(await verdictFor(root, toolName, args, mode)).toEqual({
          outcome: "allow",
          basis: "workspace_read",
        });
      }
    }
    expect(await verdictFor(root, "read", { path: "src/a.ts" }, "full")).toEqual({
      outcome: "allow",
      basis: "mode_full",
    });
  });

  it("区外 read/glob/grep：readonly/auto 逐次 ask 且无授权键，full 放行 mode_full", async () => {
    const { root, parent } = outsideLayout();
    const outsideFile = path.join(parent, "outside.txt");
    fs.writeFileSync(outsideFile, "secret");
    const cases: Array<[string, Record<string, unknown>]> = [
      ["read", { path: outsideFile }],
      ["glob", { pattern: "*.txt", path: parent }],
      ["grep", { pattern: "x", path: parent }],
    ];

    for (const mode of ["readonly", "auto"] as const) {
      for (const [toolName, args] of cases) {
        const request = requireAsk(await verdictFor(root, toolName, args, mode));
        expect(request.touchesOutsideWorkspace).toBe(true);
        expect(request.grantKey).toBeNull();
      }
    }
    for (const [toolName, args] of cases) {
      expect(await verdictFor(root, toolName, args, "full")).toEqual({
        outcome: "allow",
        basis: "mode_full",
      });
    }
  });
});

describe("write/edit：readonly 拒绝、auto 区内放行区外人工、full 全放行", () => {
  it("区内 write/edit：readonly deny，auto workspace_write，full mode_full", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "exists.txt", "original");
    const cases: Array<[string, Record<string, unknown>]> = [
      ["write", { path: "new.txt", content: "x" }],
      ["write", { path: "exists.txt", content: "x" }],
      ["edit", { path: "exists.txt", old_string: "original", new_string: "y" }],
    ];

    for (const [toolName, args] of cases) {
      expect(await verdictFor(root, toolName, args, "readonly")).toEqual({
        outcome: "deny",
        reason: "denied_by_policy",
      });
      expect(await verdictFor(root, toolName, args, "auto")).toEqual({
        outcome: "allow",
        basis: "workspace_write",
      });
      expect(await verdictFor(root, toolName, args, "full")).toEqual({
        outcome: "allow",
        basis: "mode_full",
      });
    }
  });

  it("区外写入：readonly deny，auto 逐次 ask（grantKey null，bash 授权不豁免），full mode_full", async () => {
    const { root, parent } = outsideLayout();
    const outsideFile = path.join(parent, "target.txt");
    const bashGrants = withGrant(emptySessionGrants(), { kind: "shell_command", command: "ls" });
    const cases: Array<[string, Record<string, unknown>]> = [
      ["write", { path: outsideFile, content: "x" }],
      ["edit", { path: outsideFile, old_string: "a", new_string: "b" }],
    ];

    for (const [toolName, args] of cases) {
      expect(await verdictFor(root, toolName, args, "readonly")).toEqual({
        outcome: "deny",
        reason: "denied_by_policy",
      });
      const request = requireAsk(await verdictFor(root, toolName, args, "auto", bashGrants));
      expect(request.touchesOutsideWorkspace).toBe(true);
      expect(request.grantKey).toBeNull();
      expect(await verdictFor(root, toolName, args, "full")).toEqual({
        outcome: "allow",
        basis: "mode_full",
      });
    }
  });

  it("区外写入审批请求携带工具名、规范化路径与本次操作", async () => {
    const { root, parent } = outsideLayout();
    const outsideFile = path.join(parent, "target.txt");

    const created = requireAsk(
      await verdictFor(root, "write", { path: outsideFile, content: "x" }, "auto"),
    );
    expect(created).toMatchObject({
      toolName: "write",
      access: "write",
      operation: "create",
      touchesOutsideWorkspace: true,
      grantKey: null,
      paths: [path.join(fs.realpathSync.native(parent), "target.txt")],
    });

    fs.writeFileSync(outsideFile, "original");
    const overwritten = requireAsk(
      await verdictFor(root, "write", { path: outsideFile, content: "x" }, "auto"),
    );
    expect(overwritten.operation).toBe("overwrite");
    const edited = requireAsk(
      await verdictFor(root, "edit", { path: outsideFile, old_string: "original", new_string: "y" }, "auto"),
    );
    expect(edited.operation).toBe("edit");
  });
});

describe("bash：readonly 整体拒绝、auto 授权/人工、full 全放行", () => {
  it("readonly 即使只读命令也策略拒绝（v1 不做命令级豁免）", async () => {
    const root = makeWorkspace();
    expect(await verdictFor(root, shellName, { command: "ls" }, "readonly")).toEqual({
      outcome: "deny",
      reason: "denied_by_policy",
    });
  });

  it("auto 询问携带完全相同的原始命令字符串与 shell_command 授权键", async () => {
    const root = makeWorkspace();
    const command = "  echo   hi  ";
    const request = requireAsk(await verdictFor(root, shellName, { command }, "auto"));
    expect(request.access).toBe("shell");
    expect(request.command).toBe(command);
    expect(request.paths).toEqual([]);
    expect(request.grantKey).toEqual({ kind: "shell_command", command });
  });

  it("会话授权只在命令字符串完全相同时命中，任一字符不同即重新询问", async () => {
    const command = "git status";
    const grants = withGrant(emptySessionGrants(), { kind: "shell_command", command });

    expect(
      evaluatePermission(
        { toolCallId: "c1", toolName: shellName, action: { type: "shell", command } },
        grants,
        "auto",
      ),
    ).toEqual({ outcome: "allow", basis: "session_grant" });

    for (const variant of ["git  status", "git status ", "Git status", "git statusx", "git status && echo"]) {
      expect(
        evaluatePermission(
          { toolCallId: "c2", toolName: shellName, action: { type: "shell", command: variant } },
          grants,
          "auto",
        ).outcome,
      ).toBe("ask");
    }
  });

  it("full 放行 mode_full；bash 授权不影响 write 判定", async () => {
    const root = makeWorkspace();
    expect(await verdictFor(root, shellName, { command: "rm -rf x" }, "full")).toEqual({
      outcome: "allow",
      basis: "mode_full",
    });
    const shellGrants = withGrant(emptySessionGrants(), { kind: "shell_command", command: "ls" });
    expect(
      requireAsk(await verdictFor(root, "write", { path: "../out.txt", content: "x" }, "auto", shellGrants))
        .toolName,
    ).toBe("write");
  });
});

describe("unknown 工具防御分支：任何模式都人工", () => {
  it("没有明确安全策略的工具默认询问且不产生会话授权键", () => {
    const action = { type: "delete" } as unknown as ToolAction;
    for (const mode of MODES) {
      const verdict = evaluatePermission(
        { toolCallId: "call-1", toolName: "mystery", action },
        emptySessionGrants(),
        mode,
      );
      const request = requireAsk(verdict);
      expect(request.access).toBe("unknown");
      expect(request.grantKey).toBeNull();
    }
  });
});

describe("判定依据是解析后的真实路径", () => {
  it("区内符号链接逃逸到区外按区外处理：auto 写入仍 ask", async () => {
    if (!DIR_LINKS) return;
    const root = makeWorkspace();
    const outside = tempDir("shana-outside-");
    fs.mkdirSync(path.join(outside, "target"));
    createDirLink(path.join(outside, "target"), path.join(root, "link"));

    const request = requireAsk(
      await verdictFor(root, "write", { path: path.join("link", "a.txt"), content: "x" }, "auto"),
    );
    expect(request.touchesOutsideWorkspace).toBe(true);
    expect(request.paths).toEqual([
      path.join(fs.realpathSync.native(path.join(outside, "target")), "a.txt"),
    ]);
  });

  it("真实目标不同则判定不同：链接目录走审批，区内普通文件自动允许", async () => {
    if (!DIR_LINKS) return;
    const root = makeWorkspace();
    const outside = tempDir("shana-outside-");
    fs.mkdirSync(path.join(outside, "target"));
    createDirLink(path.join(outside, "target"), path.join(root, "escape"));

    const viaLink = requireAsk(await verdictFor(root, "grep", { pattern: "x", path: "escape" }, "auto"));
    expect(viaLink.access).toBe("read");
    expect(viaLink.touchesOutsideWorkspace).toBe(true);
    expect(viaLink.grantKey).toBeNull();

    writeFileAt(root, "plain.txt", "x");
    expect(await verdictFor(root, "grep", { pattern: "x", path: "plain.txt" }, "auto")).toEqual({
      outcome: "allow",
      basis: "workspace_read",
    });
  });
});

describe("skills 只读区权限", () => {
  async function verdictWithSkills(
    root: string,
    skillsRoot: string,
    toolName: string,
    args: Record<string, unknown>,
    mode: ApprovalMode,
    options: { imageInput?: boolean } = {},
  ): Promise<PermissionVerdict> {
    const registry = createToolRegistry(
      process.platform,
      parseSettings(undefined),
      undefined,
      options.imageInput ?? false,
    );
    const tool = registry.get(toolName);
    if (!tool) throw new Error(`tool not registered: ${toolName}`);
    const plan = await tool.prepare(args as JsonObject, {
      workspaceRoot: root,
      pathPolicy: createPathPolicy(root, process.platform, skillsRoot),
      platform: process.platform,
    });
    return evaluatePermission({ toolCallId: "call-1", toolName, action: plan.action }, emptySessionGrants(), mode);
  }

  function makeSkillsLayout(): { root: string; skills: string } {
    const parent = tempDir("shana-home-");
    const root = path.join(parent, "ws");
    fs.mkdirSync(root);
    const skills = path.join(parent, ".shana", "skills");
    fs.mkdirSync(skills, { recursive: true });
    return { root, skills };
  }

  it("read/glob/grep/view_image 命中 skills 区：readonly/auto skills_read，full mode_full", async () => {
    const { root, skills } = makeSkillsLayout();
    writeFileAt(skills, "review/SKILL.md", "needle");
    writeFileAt(skills, "review/img.png", "x");
    const cases = [
      ["read", { path: path.join(skills, "review", "SKILL.md") }, false],
      ["glob", { pattern: "**/*.md", path: skills }, false],
      ["grep", { pattern: "needle", path: skills }, false],
      ["view_image", { path: path.join(skills, "review", "img.png") }, true],
    ] as const;
    // 生产路径上 skills 读同样由 executor 跳过门控；full 的 mode_full 是 §3.1 顺序。
    for (const mode of ["readonly", "auto"] as const) {
      for (const [toolName, args, imageInput] of cases) {
        expect(await verdictWithSkills(root, skills, toolName, args, mode, { imageInput })).toEqual({
          outcome: "allow",
          basis: "skills_read",
        });
      }
    }
    for (const [toolName, args, imageInput] of cases) {
      expect(await verdictWithSkills(root, skills, toolName, args, "full", { imageInput })).toEqual({
        outcome: "allow",
        basis: "mode_full",
      });
    }
  });

  it("纯区内读取 basis 仍 workspace_read；混合路径（区内 + skills）allow skills_read", () => {
    const { root, skills } = makeSkillsLayout();
    writeFileAt(root, "a.txt", "x");
    const skillFile = writeFileAt(skills, "review/SKILL.md", "x");
    const policy = createPathPolicy(root, process.platform, skills);
    const mixed: ToolAction = {
      type: "read",
      paths: [policy.resolve("a.txt"), policy.resolve(skillFile)],
    };
    expect(
      evaluatePermission({ toolCallId: "c", toolName: "read", action: mixed }, emptySessionGrants(), "auto"),
    ).toEqual({ outcome: "allow", basis: "skills_read" });
    const pure: ToolAction = { type: "read", paths: [policy.resolve("a.txt")] };
    expect(
      evaluatePermission({ toolCallId: "c", toolName: "read", action: pure }, emptySessionGrants(), "auto"),
    ).toEqual({ outcome: "allow", basis: "workspace_read" });
  });

  it("skills 内 write/edit：readonly deny、auto ask（区外写入）、full mode_full（D1 全豁免）", async () => {
    const { root, skills } = makeSkillsLayout();
    const target = writeFileAt(skills, "review/SKILL.md", "x");
    for (const toolName of ["write", "edit"] as const) {
      const args =
        toolName === "write"
          ? { path: target, content: "y" }
          : { path: target, old_string: "x", new_string: "y" };
      expect(await verdictWithSkills(root, skills, toolName, args, "readonly")).toEqual({
        outcome: "deny",
        reason: "denied_by_policy",
      });
      const request = requireAsk(await verdictWithSkills(root, skills, toolName, args, "auto"));
      expect(request.touchesOutsideWorkspace).toBe(true);
      expect(request.grantKey).toBeNull();
      expect(await verdictWithSkills(root, skills, toolName, args, "full")).toEqual({
        outcome: "allow",
        basis: "mode_full",
      });
    }
  });

  it("bash 不豁免 skills；~/.shana 其他子目录读取不放行", async () => {
    const { root, skills } = makeSkillsLayout();
    expect((await verdictWithSkills(root, skills, "bash", { command: "echo hi" }, "auto")).outcome).toBe("ask");
    const sessionsFile = writeFileAt(path.dirname(skills), "sessions/s.jsonl", "{}");
    const verdict = await verdictWithSkills(root, skills, "read", { path: sessionsFile }, "auto");
    expect(requireAsk(verdict).touchesOutsideWorkspace).toBe(true);
  });

  it("skills 内目录链接逃逸不豁免", async () => {
    if (!DIR_LINKS) return;
    const { root, skills } = makeSkillsLayout();
    const outside = tempDir("shana-out-");
    writeFileAt(outside, "secret.txt", "secret");
    createDirLink(outside, path.join(skills, "escape"));
    const verdict = await verdictWithSkills(
      root,
      skills,
      "read",
      { path: path.join(skills, "escape", "secret.txt") },
      "auto",
    );
    expect(requireAsk(verdict).touchesOutsideWorkspace).toBe(true);
  });
});