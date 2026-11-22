import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "../../src/security/approval-manager.js";
import type { ApprovalMode } from "../../src/security/permissions.js";
import type { ToolPermissionRequest } from "../../src/tools/executor.js";
import { createPathPolicy } from "../../src/security/path-policy.js";
import {
  call,
  cleanupTempDirs,
  createDirLink,
  makeExecutor,
  makeWorkspace,
  recordingGate,
  supportsDirectoryLinks,
  tempDir,
  writeFileAt,
} from "./helpers.js";

afterEach(cleanupTempDirs);

const DIR_LINKS = supportsDirectoryLinks();

// 分别记录权限判定和人工审批，以覆盖自动放行的生产路径。
function fixture(mode: ApprovalMode = "confirm") {
  const ws = makeWorkspace();
  const skills = tempDir("shana-skills-");
  const prompt = vi.fn(async () => "deny" as const);
  const manager = new ApprovalManager({ approver: prompt });
  const gate = vi.fn((request: ToolPermissionRequest) => manager.requestPermission(request, { mode }));
  const executor = makeExecutor(ws, {
    pathPolicy: createPathPolicy(ws, process.platform, skills),
    permissionGate: gate,
    imageInput: true,
  });
  return { ws, skills, executor, gate, prompt };
}

function pngBytes(width = 4, height = 3): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("skills 只读区端到端（D3）", () => {
  it("read/glob/grep/view_image 命中 skills 区：成功且零审批请求", async () => {
    const f = fixture();
    const skillFile = writeFileAt(f.skills, "review/SKILL.md", "needle body");
    writeFileAt(f.skills, "review/ref.md", "reference");
    writeFileAt(f.skills, "review/img.png", pngBytes());

    const read = await f.executor.execute(call("c1", "read", { path: skillFile }));
    expect(read.status).toBe("success");
    expect(read.content).toContain("needle body");

    const glob = await f.executor.execute(call("c2", "glob", { pattern: "**/*.md", path: f.skills }));
    expect(glob.status).toBe("success");
    expect(glob.content).toContain("SKILL.md");
    expect(glob.content).toContain("ref.md");

    const grep = await f.executor.execute(call("c3", "grep", { pattern: "needle", path: f.skills }));
    expect(grep.status).toBe("success");
    expect(grep.content).toContain("needle body");

    const image = await f.executor.execute(
      call("c4", "view_image", { path: path.join(f.skills, "review", "img.png") }),
    );
    expect(image.status).toBe("success");
    expect(image.images).toHaveLength(1);

    expect(f.gate).toHaveBeenCalledTimes(4);
    expect(f.prompt).not.toHaveBeenCalled();
  });

  it("skills 内未授权 write 和 Bash 均经过权限入口", async () => {
    const f = fixture();
    const target = writeFileAt(f.skills, "review/SKILL.md", "x");
    const denied = recordingGate("deny");
    const executor = makeExecutor(f.ws, {
      pathPolicy: createPathPolicy(f.ws, process.platform, f.skills),
      permissionGate: denied.gate,
    });
    const write = await executor.execute(call("c1", "write", { path: target, content: "y" }));
    expect(write.status).toBe("denied");
    expect(denied.requests).toHaveLength(1);
    const action = denied.requests[0]!.action;
    if (action.type !== "write") throw new Error("expected write action");
    expect(action.path.insideWorkspace).toBe(false);
    expect(action.path.insideSkills).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("x");

    const bash = await executor.execute(call("c2", "bash", { command: "echo hi" }));
    expect(bash.status).toBe("denied");
    expect(denied.requests).toHaveLength(2);
  });

  it("skills 内目录链接逃逸不豁免，仍走审批", async () => {
    if (!DIR_LINKS) return;
    const f = fixture();
    const outside = tempDir("shana-out-");
    writeFileAt(outside, "secret.txt", "secret");
    createDirLink(outside, path.join(f.skills, "escape"));
    const denied = recordingGate("deny");
    const executor = makeExecutor(f.ws, {
      pathPolicy: createPathPolicy(f.ws, process.platform, f.skills),
      permissionGate: denied.gate,
    });
    const result = await executor.execute(
      call("c1", "read", { path: path.join(f.skills, "escape", "secret.txt") }),
    );
    expect(result.status).toBe("denied");
    expect(denied.requests).toHaveLength(1);
  });

  it.each(["confirm", "auto", "full"] as const)("%s 工作区读取经统一入口自动放行", async (mode) => {
    const f = fixture(mode);
    writeFileAt(f.ws, "a.txt", "workspace");
    const result = await f.executor.execute(call("c1", "read", { path: "a.txt" }));
    expect(result.status).toBe("success");
    expect(f.gate).toHaveBeenCalledOnce();
    await expect(f.gate.mock.results[0]!.value).resolves.toMatchObject({ basis: mode === "full" ? "mode_full" : "workspace_read" });
    expect(f.prompt).not.toHaveBeenCalled();
  });
});
