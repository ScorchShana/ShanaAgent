import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createPathPolicy } from "../../src/security/path-policy.js";
import { editFileContent } from "../../src/tools/edit.js";
import { cleanupTempDirs, makeWorkspace, writeFileAt } from "./helpers.js";

const execute = promisify(execFile);
afterEach(cleanupTempDirs);

async function powershell(script: string, file: string): Promise<string> {
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, SHANA_EDIT_PROBE_PATH: file },
    windowsHide: true,
  });
  return stdout.trim();
}

function probe() {
  const root = makeWorkspace();
  const file = writeFileAt(root, "target.txt", "old");
  return {
    root,
    file,
    target: createPathPolicy(root).resolve("target.txt"),
    args: { path: "target.txt", oldString: "old", newString: "new", replaceAll: false },
  };
}

async function withSharedHandle(
  file: string,
  allowDelete: boolean,
  action: () => Promise<void>,
): Promise<void> {
  const script = `$ErrorActionPreference='Stop'; $stream=$null; try { $share=[System.IO.FileShare]::ReadWrite; ${allowDelete ? "$share=$share -bor [System.IO.FileShare]::Delete;" : ""} $stream=[System.IO.File]::Open($env:SHANA_EDIT_PROBE_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,$share); [Console]::WriteLine('READY'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { if ($null -ne $stream) { $stream.Dispose() } }`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, SHANA_EDIT_PROBE_PATH: file },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const closed = once(child, "close");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Shared-handle probe did not become ready: ${stderr}`)),
        10_000,
      );
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("READY")) resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Shared-handle probe exited ${code}: ${stderr}`)));
    });
    clearTimeout(timer);
    await action();
  } finally {
    clearTimeout(timer);
    child.stdin.end("close\n");
    const [code] = await closed;
    expect(code, stderr).toBe(0);
  }
}

describe.runIf(process.platform === "win32")("Windows local NTFS edit probes (no capability skips)", () => {
  it("records local filesystem and performs normal replacement", async () => {
    const { root, file, target, args } = probe();
    const filesystem = await powershell(
      "$ErrorActionPreference='Stop'; ([System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($env:SHANA_EDIT_PROBE_PATH))).DriveFormat",
      file,
    );
    expect(filesystem).toBe("NTFS");
    const result = await editFileContent(args, target);
    expect(result.status).toBe("success");
    expect(await fs.promises.readFile(file, "utf8")).toBe("new");
    expect(await fs.promises.readdir(root)).toEqual(["target.txt"]);
  });

  it("rejects readonly target without changing it or retaining a temporary file", async () => {
    const { root, file, target, args } = probe();
    await fs.promises.chmod(file, 0o444);
    try {
      const result = await editFileContent(args, target);
      expect(result.content).toBe("Error: Permission denied.");
      expect(await fs.promises.readFile(file, "utf8")).toBe("old");
      expect(await fs.promises.readdir(root)).toEqual(["target.txt"]);
    } finally {
      await fs.promises.chmod(file, 0o666);
    }
  });

  it("replaces one hardlink while retaining the other link's original content", async () => {
    const { root, file, target, args } = probe();
    const alias = path.join(root, "alias.txt");
    await fs.promises.link(file, alias);
    expect((await fs.promises.stat(file)).nlink).toBe(2);
    expect((await editFileContent(args, target)).status).toBe("success");
    expect(await fs.promises.readFile(file, "utf8")).toBe("new");
    expect(await fs.promises.readFile(alias, "utf8")).toBe("old");
    expect((await fs.promises.stat(file)).nlink).toBe(1);
    expect((await fs.promises.stat(alias)).nlink).toBe(1);
  });

  it("records a custom ACL before and after replacement without promising ACL preservation", async () => {
    const { file, target, args } = probe();
    await powershell(
      "$ErrorActionPreference='Stop'; $acl=[System.IO.File]::GetAccessControl($env:SHANA_EDIT_PROBE_PATH); $acl.SetAccessRuleProtection($true,$false); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow'); $acl.AddAccessRule($rule); [System.IO.File]::SetAccessControl($env:SHANA_EDIT_PROBE_PATH,$acl)",
      file,
    );
    const before = await powershell(
      "$ErrorActionPreference='Stop'; [System.IO.File]::GetAccessControl($env:SHANA_EDIT_PROBE_PATH).Sddl",
      file,
    );
    expect(before).toContain("D:P");
    const result = await editFileContent(args, target);
    expect(result.status).toBe("success");
    const after = await powershell(
      "$ErrorActionPreference='Stop'; [System.IO.File]::GetAccessControl($env:SHANA_EDIT_PROBE_PATH).Sddl",
      file,
    );
    console.info(JSON.stringify({ probe: "custom-acl", before, after, preserved: before === after }));
    expect(await fs.promises.readFile(file, "utf8")).toBe("new");
  }, 20_000);

  it.each([false, true])(
    "shared handle with FILE_SHARE_DELETE=%s reports actual commit outcome",
    async (allowDelete) => {
      const { root, file, target, args } = probe();
      await withSharedHandle(file, allowDelete, async () => {
        const diagnostics: unknown[] = [];
        const result = await editFileContent(args, target, {
          onDiagnostic: (event) => diagnostics.push(event),
        });
        expect(await fs.promises.readFile(file, "utf8")).toBe(result.status === "success" ? "new" : "old");
        expect(await fs.promises.readdir(root)).toEqual(["target.txt"]);
        console.log(JSON.stringify({ probe: "shared-handle", allowDelete, result, diagnostics }));
        if (!allowDelete) expect(result.status).toBe("error");
        if (result.status === "error") expect(result.content).toBe("Error: Permission denied.");
        else expect(result.status).toBe("success");
        expect(result.content).toBe(
          result.status === "success" ? "Successfully edited target.txt." : "Error: Permission denied.",
        );
      });
    },
    20_000,
  );
});
