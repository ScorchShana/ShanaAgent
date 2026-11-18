import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPathPolicy, PathTargetChangedError } from "../../src/security/path-policy.js";
import { viewImageFile } from "../../src/tools/view-image.js";
import {
  call,
  cleanupTempDirs,
  makeExecutor,
  makeWorkspace,
  recordingGate,
  supportsFileSymlinks,
  tempDir,
  writeFileAt,
} from "./helpers.js";

afterEach(cleanupTempDirs);

const FILE_LINKS = supportsFileSymlinks();

function pngBytes(width = 4, height = 3): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpegBytes(width = 8, height = 6): Buffer {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

function webpBytes(width = 16, height = 9): Buffer {
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  data.writeUInt32LE((((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)) >>> 0, 1);
  const header = Buffer.alloc(20);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(12 + data.length, 4);
  header.write("WEBP", 8, "ascii");
  header.write("VP8L", 12, "ascii");
  header.writeUInt32LE(data.length, 16);
  return Buffer.concat([header, data]);
}

function visionExecutor(root: string, options: Parameters<typeof makeExecutor>[1] = {}) {
  return makeExecutor(root, { imageInput: true, ...options });
}

describe("view_image 参数校验", () => {
  it("缺 path / 空串 / 未知键 / NUL 均拒绝且不执行", async () => {
    const root = makeWorkspace();
    const executor = visionExecutor(root);
    const missing = await executor.execute(call("c1", "view_image", {}));
    expect(missing.content).toBe('Error: Missing required argument "path". Not executed.');
    expect(missing.errorCategory).toBe("arguments");
    const empty = await executor.execute(call("c2", "view_image", { path: "" }));
    expect(empty.content).toBe("Error: path must not be empty. Not executed.");
    const unknown = await executor.execute(call("c3", "view_image", { path: "a.png", extra: 1 }));
    expect(unknown.content).toBe('Error: Unknown argument "extra". Not executed.');
    const nul = await executor.execute(call("c4", "view_image", { path: "a\0.png" }));
    expect(nul.content).toBe("Error: path contains NUL characters. Not executed.");
    for (const result of [missing, empty, unknown, nul]) expect(result.images).toBeUndefined();
  });
});

describe("view_image 格式与内容校验", () => {
  it("白名单外后缀拒绝（大小写不敏感白名单内放行）", async () => {
    const root = makeWorkspace();
    const executor = visionExecutor(root);
    for (const name of ["a.gif", "a.svg", "a.bmp", "a.txt", "noext"]) {
      writeFileAt(root, name, pngBytes());
      const result = await executor.execute(call("c1", "view_image", { path: name }));
      expect(result.status).toBe("error");
      expect(result.content).toBe("Error: Unsupported image format. Supported: png, jpg, jpeg, webp.");
      expect(result.images).toBeUndefined();
    }
    writeFileAt(root, "UPPER.PNG", pngBytes());
    const upper = await executor.execute(call("c2", "view_image", { path: "UPPER.PNG" }));
    expect(upper.status).toBe("success");
  });

  it("内容不符任何支持格式时报错；mimeType 以实际内容为准", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "fake.png", "this is plain text, not an image");
    writeFileAt(root, "actually-jpeg.png", jpegBytes());
    const executor = visionExecutor(root);
    const fake = await executor.execute(call("c1", "view_image", { path: "fake.png" }));
    expect(fake.status).toBe("error");
    expect(fake.content).toBe("Error: File content does not match a supported image format.");
    expect(fake.images).toBeUndefined();
    const jpeg = await executor.execute(call("c2", "view_image", { path: "actually-jpeg.png" }));
    expect(jpeg.status).toBe("success");
    expect(jpeg.images?.[0]?.mimeType).toBe("image/jpeg");
  });

  it("三格式成功：content 元信息 + 单图 images + 宽高 + base64 原文", async () => {
    const root = makeWorkspace();
    const fixtures = [
      { name: "a.png", bytes: pngBytes(4, 3), mimeType: "image/png", width: 4, height: 3 },
      { name: "b.jpg", bytes: jpegBytes(8, 6), mimeType: "image/jpeg", width: 8, height: 6 },
      { name: "c.webp", bytes: webpBytes(16, 9), mimeType: "image/webp", width: 16, height: 9 },
    ] as const;
    const executor = visionExecutor(root);
    for (const fixture of fixtures) {
      writeFileAt(root, fixture.name, fixture.bytes);
      const result = await executor.execute(call("c1", "view_image", { path: fixture.name }));
      expect(result.status).toBe("success");
      expect(result.content).toBe(
        `<path>${fixture.name}</path>\n(Image attached: ${fixture.mimeType}, ${fixture.width}x${fixture.height}, ${fixture.bytes.length} bytes.)`,
      );
      expect(result.images).toEqual([
        {
          data: fixture.bytes.toString("base64"),
          mimeType: fixture.mimeType,
          width: fixture.width,
          height: fixture.height,
        },
      ]);
    }
  });

  it("KB 级尺寸文案保留一位小数", async () => {
    const root = makeWorkspace();
    const bytes = Buffer.concat([pngBytes(), Buffer.alloc(2048 - 33)]);
    writeFileAt(root, "big.png", bytes);
    const result = await visionExecutor(root).execute(call("c1", "view_image", { path: "big.png" }));
    expect(result.content).toContain("(Image attached: image/png, 4x3, 2.0 KB.)");
  });
});

describe("view_image 大小上限", () => {
  it("stat 阶段超限报实际字节与上限", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "a.png", Buffer.concat([pngBytes(), Buffer.alloc(2048)]));
    const executor = visionExecutor(root, {
      settings: {
        editMaxFileBytes: 16_777_216,
        viewImageMaxBytes: 1024,
        globTimeoutMs: 30_000,
        grepStderrMaxChars: 4000,
      },
    });
    const result = await executor.execute(call("c1", "view_image", { path: "a.png" }));
    expect(result.status).toBe("error");
    expect(result.content).toBe("Error: Image exceeds the size limit (2081 bytes; max 1024 bytes).");
    expect(result.images).toBeUndefined();
  });

  it("stat 后竞态增长由限量读兜住（读后双路径）", async () => {
    const root = makeWorkspace();
    const target = writeFileAt(root, "a.png", pngBytes());
    const policy = createPathPolicy(root);
    let checks = 0;
    const result = await viewImageFile({ path: "a.png" }, policy.resolve("a.png"), {
      viewImageMaxBytes: 40,
      assertPathTarget: async () => {
        checks += 1;
        // 第二次复验（读取前）注入增长：stat 时 33<=40 通过，读取时文件已 97 字节。
        if (checks === 2) fs.appendFileSync(target, Buffer.alloc(64));
      },
    });
    expect(result.status).toBe("error");
    expect(result.content).toBe("Error: Image exceeds the size limit (41 bytes; max 40 bytes).");
  });
});

describe("view_image IO 错误与取消", () => {
  it("不存在 / 目录 / 断链分别可区分", async () => {
    const root = makeWorkspace();
    fs.mkdirSync(path.join(root, "dir.png"));
    const executor = visionExecutor(root);
    const missing = await executor.execute(call("c1", "view_image", { path: "nope.png" }));
    expect(missing.content).toBe("Error: File not found.");
    expect(missing.errorCategory).toBe("io");
    const directory = await executor.execute(call("c2", "view_image", { path: "dir.png" }));
    expect(directory.content).toBe("Error: Path is a directory.");
    if (FILE_LINKS) {
      fs.symlinkSync(path.join(root, "gone.png"), path.join(root, "dangling.png"), "file");
      const dangling = await executor.execute(call("c3", "view_image", { path: "dangling.png" }));
      expect(dangling.content).toBe("Error: Broken symbolic link.");
    }
  });

  it("stat 故障注入 EACCES → Permission denied + 诊断 stage", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "a.png", pngBytes());
    const policy = createPathPolicy(root);
    const stages: string[] = [];
    const result = await viewImageFile({ path: "a.png" }, policy.resolve("a.png"), {
      assertPathTarget: async () => {
        throw Object.assign(new Error("injected"), { code: "EACCES" });
      },
      onDiagnostic: (event) => stages.push(event.stage),
    });
    expect(result.content).toBe("Error: Permission denied.");
    expect(stages).toEqual(["view_image.stat"]);
    expect(result.images).toBeUndefined();
  });

  it("路径复验变化 → Path target changed（path 类别）", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "a.png", pngBytes());
    const policy = createPathPolicy(root);
    const result = await viewImageFile({ path: "a.png" }, policy.resolve("a.png"), {
      assertPathTarget: async () => {
        throw new PathTargetChangedError();
      },
    });
    expect(result.status).toBe("error");
    expect(result.category).toBe("path");
    expect(result.content).toBe("Error: Path target changed. Stop and ask user.");
  });

  it("执行前取消（executor 前置检查 → not_executed）", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "a.png", pngBytes());
    const controller = new AbortController();
    controller.abort();
    const result = await visionExecutor(root).execute(call("c1", "view_image", { path: "a.png" }), {
      signal: controller.signal,
    });
    expect(result.status).toBe("not_executed");
    expect(result.errorCategory).toBe("cancelled");
    expect(result.images).toBeUndefined();
  });

  it("读取后取消边界检查 → cancelled 且不带 images", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "a.png", pngBytes());
    const policy = createPathPolicy(root);
    const controller = new AbortController();
    let checks = 0;
    const result = await viewImageFile({ path: "a.png" }, policy.resolve("a.png"), {
      signal: controller.signal,
      assertPathTarget: async () => {
        checks += 1;
        if (checks === 2) controller.abort();
      },
    });
    expect(result.status).toBe("error");
    expect(result.category).toBe("cancelled");
    expect(result.content).toBe("Error: Cancelled by user.");
    expect(result.images).toBeUndefined();
  });
});

describe("view_image 权限与条件注册", () => {
  it("区内免审批；区外逐次审批（allow 成功 / deny 拒绝且无 images）", async () => {
    const root = makeWorkspace();
    const outside = tempDir("shana-view-outside-");
    const outsidePath = path.join(outside, "o.png");
    fs.writeFileSync(outsidePath, pngBytes());
    const allow = recordingGate("allow");
    const allowed = await visionExecutor(root, { permissionGate: allow.gate }).execute(
      call("c1", "view_image", { path: outsidePath }),
    );
    expect(allowed.status).toBe("success");
    expect(allow.requests).toHaveLength(1);
    expect(allow.requests[0]?.action.type).toBe("read");
    const deny = recordingGate("deny");
    const denied = await visionExecutor(root, { permissionGate: deny.gate }).execute(
      call("c2", "view_image", { path: outsidePath }),
    );
    expect(denied.status).toBe("denied");
    expect(denied.images).toBeUndefined();
  });

  it("无 imageInput 时工具不存在，调用报 Unknown tool", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "a.png", pngBytes());
    const result = await makeExecutor(root).execute(call("c1", "view_image", { path: "a.png" }));
    expect(result.status).toBe("error");
    expect(result.errorCategory).toBe("unknown_tool");
    expect(result.content).toBe('Error: Unknown tool "view_image". Not executed.');
  });
});