import fs from "node:fs";
import path from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createPathPolicy } from "../../src/security/path-policy.js";
import {
  emptySessionGrants,
  evaluatePermission,
  withGrant,
  type ApprovalRequest,
  type PermissionVerdict,
  type SessionGrants,
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

async function askFor(
  root: string,
  toolName: string,
  args: Record<string, unknown>,
  grants = emptySessionGrants(),
): Promise<PermissionVerdict> {
  const action = await prepareAction(root, toolName, args);
  return evaluatePermission({ toolCallId: "call-1", toolName, action }, grants);
}

function requireAsk(verdict: PermissionVerdict): ApprovalRequest {
  if (verdict.outcome !== "ask") throw new Error(`expected ask, got ${verdict.outcome}`);
  return verdict.request;
}

function grantFor(...toolNames: string[]): SessionGrants {
  return toolNames.reduce<SessionGrants>(
    (grants, toolName) => withGrant(grants, { kind: "file_tool", toolName }),
    emptySessionGrants(),
  );
}

describe("V1 默认策略矩阵（§5.2 逐行）", () => {
  it("工作区内 read/glob/grep 自动允许，不产生审批请求", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "src/a.ts", "x");
    writeFileAt(root, "src/b.ts", "y");

    for (const [toolName, args] of [
      ["read", { path: "src/a.ts" }],
      ["glob", { pattern: "src/*.ts" }],
      ["grep", { pattern: "x", path: "src" }],
    ] as const) {
      const verdict = await askFor(root, toolName, args);
      expect(verdict).toEqual({ outcome: "allow", basis: "workspace_read" });
    }
  });

  it("工作区内 write/edit 一律询问，请求携带工具名、真实路径与本次操作", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "exists.txt", "original");

    const created = requireAsk(await askFor(root, "write", { path: "new.txt", content: "x" }));
    expect(created.toolName).toBe("write");
    expect(created.access).toBe("write");
    expect(created.operation).toBe("create");
    expect(created.paths).toEqual([path.join(fs.realpathSync.native(root), "new.txt")]);
    expect(created.touchesOutsideWorkspace).toBe(false);
    expect(created.grantKey).toEqual({ kind: "file_tool", toolName: "write" });

    const overwritten = requireAsk(await askFor(root, "write", { path: "exists.txt", content: "x" }));
    expect(overwritten.operation).toBe("overwrite");

    const edited = requireAsk(
      await askFor(root, "edit", { path: "exists.txt", old_string: "a", new_string: "b" }),
    );
    expect(edited.operation).toBe("edit");
    expect(edited.grantKey).toEqual({ kind: "file_tool", toolName: "edit" });
  });

  it("Shell 询问，请求携带完全相同的原始命令字符串", async () => {
    const root = makeWorkspace();
    const command = "  echo   hi  ";

    const request = requireAsk(await askFor(root, shellName, { command }));
    expect(request.access).toBe("shell");
    expect(request.command).toBe(command);
    expect(request.paths).toEqual([]);
    expect(request.grantKey).toEqual({ kind: "shell_command", command });
  });

  it("没有明确安全策略的工具默认询问且不产生会话授权键", async () => {
    const action = { type: "delete" } as unknown as ToolAction;

    const verdict = evaluatePermission(
      { toolCallId: "call-1", toolName: "mystery", action },
      emptySessionGrants(),
    );
    const request = requireAsk(verdict);
    expect(request.access).toBe("unknown");
    expect(request.grantKey).toBeNull();
  });
});

describe("V3 会话授权匹配", () => {
  it("文件工具授权按工具名命中区内写入", async () => {
    const root = makeWorkspace();
    const writeGrants = grantFor("write");

    expect(await askFor(root, "write", { path: "a.txt", content: "x" }, writeGrants)).toEqual({
      outcome: "allow",
      basis: "session_grant",
    });
    expect(
      requireAsk(await askFor(root, "edit", { path: "a.txt", old_string: "x", new_string: "y" })),
    ).toBeTruthy();
  });

  it("Shell 授权只在命令字符串完全相同时命中，任一字符不同即重新询问", async () => {
    const command = "git status";
    const grants = withGrant(emptySessionGrants(), { kind: "shell_command", command });

    const same = evaluatePermission(
      { toolCallId: "c1", toolName: shellName, action: { type: "shell", command } },
      grants,
    );
    expect(same).toEqual({ outcome: "allow", basis: "session_grant" });

    for (const variant of ["git  status", "git status ", "Git status", "git statusx", "git status && echo"]) {
      const verdict = evaluatePermission(
        { toolCallId: "c2", toolName: shellName, action: { type: "shell", command: variant } },
        grants,
      );
      expect(verdict.outcome).toBe("ask");
    }
  });

  it("授权不跨类别扩散：命令授权不放行写入，写授权不放行其他命令", async () => {
    const root = makeWorkspace();
    const shellGrants = withGrant(emptySessionGrants(), { kind: "shell_command", command: "ls" });
    const writeGrants = grantFor("write");

    expect(
      requireAsk(await askFor(root, "write", { path: "a.txt", content: "x" }, shellGrants)).toolName,
    ).toBe("write");
    expect(
      evaluatePermission(
        { toolCallId: "c1", toolName: shellName, action: { type: "shell", command: "ls -la" } },
        writeGrants,
      ).outcome,
    ).toBe("ask");
  });
});

describe("V4 工作区外访问", () => {
  it("区外 read/glob/grep/write/edit 每次都询问，已有工具名会话授权也不豁免", async () => {
    const parent = tempDir("shana-parent-");
    const root = path.join(parent, "ws");
    fs.mkdirSync(root);
    const outsideFile = path.join(parent, "outside.txt");
    fs.writeFileSync(outsideFile, "secret");
    const outsideDir = path.join(parent, "outdir");
    fs.mkdirSync(outsideDir);
    const grants = grantFor("write", "edit", "read", "glob", "grep");

    const cases: Array<[string, Record<string, unknown>]> = [
      ["read", { path: outsideFile }],
      ["grep", { pattern: "x", path: outsideDir }],
      ["write", { path: outsideFile, content: "x" }],
      ["edit", { path: outsideFile, old_string: "a", new_string: "b" }],
    ];

    for (const [toolName, args] of cases) {
      const request = requireAsk(await askFor(root, toolName, args, grants));
      expect(request.touchesOutsideWorkspace).toBe(true);
    }

    const outsideGlob = "*.txt";
    const globRequest = requireAsk(
      await askFor(root, "glob", { pattern: outsideGlob, path: outsideDir }, grants),
    );
    expect(globRequest.touchesOutsideWorkspace).toBe(true);
  });

  it("区外写入合并为一次综合审批，内容含工具名、规范化路径与本次操作", async () => {
    const parent = tempDir("shana-parent-");
    const root = path.join(parent, "ws");
    fs.mkdirSync(root);
    const outsideFile = path.join(parent, "target.txt");

    const requests: ApprovalRequest[] = [];
    const verdict = await askFor(root, "write", { path: outsideFile, content: "x" });
    if (verdict.outcome === "ask") requests.push(verdict.request);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      toolName: "write",
      operation: "create",
      touchesOutsideWorkspace: true,
      paths: [path.join(fs.realpathSync.native(parent), "target.txt")],
    });
    expect(requests[0].grantKey).toEqual({ kind: "file_tool", toolName: "write" });
  });

  it("区外访问选“本会话允许”产生的工具名授权只放行区内同名工具", async () => {
    const parent = tempDir("shana-parent-");
    const root = path.join(parent, "ws");
    fs.mkdirSync(root);
    const outsideFile = path.join(parent, "target.txt");
    const grants = grantFor("write");

    expect(
      requireAsk(await askFor(root, "write", { path: outsideFile, content: "x" }, grants))
        .touchesOutsideWorkspace,
    ).toBe(true);
    expect(await askFor(root, "write", { path: "inside.txt", content: "x" }, grants)).toEqual({
      outcome: "allow",
      basis: "session_grant",
    });
  });

  it("区外读取不产生任何会话授权键", async () => {
    const parent = tempDir("shana-parent-");
    const root = path.join(parent, "ws");
    fs.mkdirSync(root);
    const outsideFile = path.join(parent, "target.txt");
    fs.writeFileSync(outsideFile, "x");
    const outsideGlob = "other/*.txt";

    expect(requireAsk(await askFor(root, "read", { path: outsideFile })).grantKey).toBeNull();
    expect(
      requireAsk(await askFor(root, "glob", { pattern: outsideGlob, path: parent })).grantKey,
    ).toBeNull();
    expect(requireAsk(await askFor(root, "grep", { pattern: "x", path: parent })).grantKey).toBeNull();
  });
});

describe("V8 判定依据是解析后的真实路径", () => {
  it("区内符号链接逃逸到区外按区外处理，工具名授权不生效", async () => {
    if (!DIR_LINKS) return;
    const root = makeWorkspace();
    const outside = tempDir("shana-outside-");
    fs.mkdirSync(path.join(outside, "target"));
    createDirLink(path.join(outside, "target"), path.join(root, "link"));

    const request = requireAsk(
      await askFor(root, "write", { path: path.join("link", "a.txt"), content: "x" }, grantFor("write")),
    );
    expect(request.touchesOutsideWorkspace).toBe(true);
    expect(request.paths).toEqual([path.join(fs.realpathSync.native(path.join(outside, "target")), "a.txt")]);
  });

  it("真实目标不同则判定不同：链接目录走审批，区内普通文件自动允许", async () => {
    if (!DIR_LINKS) return;
    const root = makeWorkspace();
    const outside = tempDir("shana-outside-");
    fs.mkdirSync(path.join(outside, "target"));
    createDirLink(path.join(outside, "target"), path.join(root, "escape"));

    const viaLink = requireAsk(
      await askFor(root, "grep", { pattern: "x", path: "escape" }, grantFor("grep")),
    );
    expect(viaLink.access).toBe("read");
    expect(viaLink.touchesOutsideWorkspace).toBe(true);
    expect(viaLink.grantKey).toBeNull();

    writeFileAt(root, "plain.txt", "x");
    expect(await askFor(root, "grep", { pattern: "x", path: "plain.txt" })).toEqual({
      outcome: "allow",
      basis: "workspace_read",
    });
  });
});

describe("skills 只读区权限（D3）", () => {
  async function verdictWithSkills(
    root: string,
    skillsRoot: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { imageInput?: boolean; grants?: SessionGrants } = {},
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
    return evaluatePermission(
      { toolCallId: "call-1", toolName, action: plan.action },
      options.grants ?? emptySessionGrants(),
    );
  }

  function makeSkillsLayout(): { root: string; skills: string } {
    const parent = tempDir("shana-home-");
    const root = path.join(parent, "ws");
    fs.mkdirSync(root);
    const skills = path.join(parent, ".shana", "skills");
    fs.mkdirSync(skills, { recursive: true });
    return { root, skills };
  }

  it("read/glob/grep/view_image 命中 skills 区免审批，basis 为 skills_read", async () => {
    const { root, skills } = makeSkillsLayout();
    writeFileAt(skills, "review/SKILL.md", "needle");
    writeFileAt(skills, "review/img.png", "x");
    for (const [toolName, args, imageInput] of [
      ["read", { path: path.join(skills, "review", "SKILL.md") }, false],
      ["glob", { pattern: "**/*.md", path: skills }, false],
      ["grep", { pattern: "needle", path: skills }, false],
      ["view_image", { path: path.join(skills, "review", "img.png") }, true],
    ] as const) {
      const verdict = await verdictWithSkills(root, skills, toolName, args, { imageInput });
      expect(verdict).toEqual({ outcome: "allow", basis: "skills_read" });
    }
  });

  it("纯区内读取 basis 仍 workspace_read；混合路径（区内 + skills）allow skills_read", async () => {
    const { root, skills } = makeSkillsLayout();
    writeFileAt(root, "a.txt", "x");
    const skillFile = writeFileAt(skills, "review/SKILL.md", "x");
    const policy = createPathPolicy(root, process.platform, skills);
    const mixed: ToolAction = {
      type: "read",
      paths: [policy.resolve("a.txt"), policy.resolve(skillFile)],
    };
    expect(evaluatePermission({ toolCallId: "c", toolName: "read", action: mixed }, emptySessionGrants())).toEqual({
      outcome: "allow",
      basis: "skills_read",
    });
    const pure: ToolAction = { type: "read", paths: [policy.resolve("a.txt")] };
    expect(evaluatePermission({ toolCallId: "c", toolName: "read", action: pure }, emptySessionGrants())).toEqual({
      outcome: "allow",
      basis: "workspace_read",
    });
  });

  it("skills 内 write/edit 仍 ask，且会话授权不豁免（区外写入）", async () => {
    const { root, skills } = makeSkillsLayout();
    const target = writeFileAt(skills, "review/SKILL.md", "x");
    for (const toolName of ["write", "edit"] as const) {
      const args =
        toolName === "write"
          ? { path: target, content: "y" }
          : { path: target, old_string: "x", new_string: "y" };
      const verdict = await verdictWithSkills(root, skills, toolName, args, {
        grants: grantFor(toolName),
      });
      const request = requireAsk(verdict);
      expect(request.touchesOutsideWorkspace).toBe(true);
    }
  });

  it("bash 不豁免；~/.shana 其他子目录读取不放行", async () => {
    const { root, skills } = makeSkillsLayout();
    const bash = await verdictWithSkills(root, skills, "bash", { command: "echo hi" });
    expect(bash.outcome).toBe("ask");
    const sessionsFile = writeFileAt(path.dirname(skills), "sessions/s.jsonl", "{}");
    const verdict = await verdictWithSkills(root, skills, "read", { path: sessionsFile });
    expect(requireAsk(verdict).touchesOutsideWorkspace).toBe(true);
  });

  it("skills 内目录链接逃逸不豁免", async () => {
    if (!DIR_LINKS) return;
    const { root, skills } = makeSkillsLayout();
    const outside = tempDir("shana-out-");
    writeFileAt(outside, "secret.txt", "secret");
    createDirLink(outside, path.join(skills, "escape"));
    const verdict = await verdictWithSkills(root, skills, "read", {
      path: path.join(skills, "escape", "secret.txt"),
    });
    expect(requireAsk(verdict).touchesOutsideWorkspace).toBe(true);
  });
});
