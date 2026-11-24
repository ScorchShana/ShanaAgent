import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectShell } from "../tools/shell.js";
import fs from "node:fs";
import path from "node:path";
import { analyzeGitQuery } from "./bash-git-policy.js";
import { PathTargetChangedError, type PathPolicy } from "./path-policy.js";
import type { ApprovalMode } from "./permissions.js";

export type BashAnalysis =
  | { decision: "ask" }
  | {
      decision: "allow";
      revalidate: () => Promise<void>;
      commands: string[];
      readPaths: string[];
      writePaths: string[];
    };
export type BashAnalysisContext = { mode: ApprovalMode; shellExecutable?: string; pathPolicy: PathPolicy };
export type BashCommandAnalyzer = (command: string, context: BashAnalysisContext) => Promise<BashAnalysis>;
type Node = {
  startIndex: number;
  endIndex: number;
  type: string;
  text: string;
  children: Node[];
  isMissing: boolean;
  hasError: boolean;
};
type Parser = { setLanguage(language: unknown): void; parse(command: string): { rootNode: Node } };
const require = createRequire(import.meta.url);
let parser: Parser | undefined;
function parse(command: string): Node {
  if (!parser) {
    const NativeParser = require("tree-sitter") as new () => Parser;
    const instance = new NativeParser();
    instance.setLanguage(require("tree-sitter-bash"));
    parser = instance;
  }
  return parser.parse(command).rootNode;
}

class Unsupported extends Error {}
function check(condition: unknown): asserts condition {
  if (!condition) throw new Unsupported();
}

function literal(node: Node, glob = false): string {
  if (node.type === "command_name" && node.children.length === 1) return literal(node.children[0]!);
  // 引号阻止 bash 展开：含通配符的引号操作数不按 glob 分析，保持询问（仅 ls 提取会传 glob）。
  if (node.type === "raw_string" && /^'[^']*'$/.test(node.text)) {
    check(!glob || !/[*?]/.test(node.text));
    return node.text.slice(1, -1);
  }
  if (node.type === "string" && /^"[^"$`\\]*"$/.test(node.text)) {
    check(!glob || !/[*?]/.test(node.text));
    return node.text.slice(1, -1);
  }
  // glob 仅对 ls 的操作数放宽 *?（bash 展开未引号通配符）；其余命令保持严格字面量。
  check(
    ["word", "number"].includes(node.type) &&
      (glob ? /^[a-zA-Z0-9_./,:+%@=*?-]+$/ : /^[a-zA-Z0-9_./,:+%@=-]+$/).test(node.text),
  );
  return node.text;
}

function checkEnvironment() {
  check(
    !Object.keys(process.env).some(
      (k) =>
        /^(BASH_ENV$|ENV$|BASH_FUNC_|SHELLOPTS$|BASHOPTS$|CDPATH$|LD_|DYLD_|GCONV_PATH$|LOCPATH$|SSH_CLIENT$|SSH_CONNECTION$|POSIXLY_CORRECT$|BASH_XTRACEFD$|GLOBIGNORE$|GREP_OPTIONS$|SIMPLE_BACKUP_SUFFIX$|VERSION_CONTROL$)/i.test(
          k,
        ) && process.env[k],
    ),
  );
}

type Kind = "file" | "dir" | "missing";
export const analyzeBash: BashCommandAnalyzer = async (
  command,
  { mode, pathPolicy: policy, shellExecutable },
) => {
  const checks: (() => Promise<void>)[] = [];
  const readPaths = new Set<string>();
  const writePaths = new Set<string>();
  const matched: string[] = [];
  const gitQueries: { args: string[]; cwd: string }[] = [];
  const executables = new Map<string, string>();
  const windowsPaths = new Map<string, string>();
  const commands = new Map<string, Set<string>>();
  try {
    checkEnvironment();
    check(
      command.length > 0 && command.length <= 65536 && !command.includes("\0") && !/[\r\n]/.test(command),
    );
    const root = parse(command);
    check(!root.hasError);
    // The grammar accepts more whitespace and escapes between tokens than Bash does.
    // An uninspected gap could change the executable or join two operands.
    function validateGaps(node: Node) {
      if (!node.children.length || ["raw_string", "string"].includes(node.type)) return;
      let offset = node.startIndex;
      for (const child of node.children) {
        check(/^[ \t]*$/.test(command.slice(offset, child.startIndex)));
        validateGaps(child);
        offset = child.endIndex;
      }
      check(/^[ \t]*$/.test(command.slice(offset, node.endIndex)));
    }
    check(
      /^[ \t]*$/.test(command.slice(0, root.startIndex)) && /^[ \t]*$/.test(command.slice(root.endIndex)),
    );
    validateGaps(root);
    let cwd = policy.workspaceRoot;
    function inspect(raw: string, kinds: Kind[], write = false): { absolute: string; kind: Kind } {
      check(raw && raw !== "-" && !raw.includes("\\") && !raw.split("/").includes(".."));
      if (policy.platform === "win32")
        check(
          !/[:*?"<>|]|^\/|(?:^|\/)(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|\/|$)/i.test(raw) &&
            raw.split("/").every((part) => part === "." || !/[ .]$/.test(part)),
        );
      const absolute = path.resolve(cwd, raw);
      const snapshot = () => {
        const target = policy.resolve(absolute);
        check(target.insideWorkspace && !target.danglingSymlink);
        const stat = target.exists ? fs.statSync(target.realPath) : undefined;
        check(!stat || stat.isFile() || stat.isDirectory());
        const kind: Kind = !stat ? "missing" : stat.isFile() ? "file" : "dir";
        check(kinds.includes(kind));
        if (write) {
          check(mode === "auto" && !target.realPath.split(path.sep).some((p) => p.toLowerCase() === ".git"));
          if (kind === "file") check(stat?.nlink === 1);
        }
        return { real: target.realPath, kind };
      };
      const initial = snapshot();
      (write ? writePaths : readPaths).add(initial.real);
      if (policy.platform === "win32") windowsPaths.set(absolute, initial.real);
      checks.push(async () => {
        try {
          const next = snapshot();
          check(next.real === initial.real && next.kind === initial.kind);
        } catch {
          throw new PathTargetChangedError();
        }
      });
      return { absolute, kind: initial.kind };
    }
    // ls 通配符操作数：不逐匹配展开（避免匹配项竞态），只校验字面前缀目录。
    // 匹配项是指向区外的符号链接时也放行：ls 无 -L/-H 只 lstat/readlink 链接本体。
    function inspectGlob(raw: string): void {
      check(!/[{}~$[\]\\]/.test(raw) && !raw.split("/").includes(".."));
      const first = raw.search(/[*?]/);
      // 首个通配符之后不得再出现 /：否则匹配深度不可控（如 */x 递归进子目录）。
      check(first >= 0 && !raw.slice(first).includes("/"));
      if (policy.platform === "win32")
        check(
          !/[:"<>|]|^\//.test(raw) &&
            !/(?:^|\/)(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|\/|$)/i.test(raw) &&
            raw.split("/").every((part) => part === "." || !/[ .]$/.test(part)),
        );
      const prefixPart = raw.slice(0, first);
      const slash = prefixPart.lastIndexOf("/");
      const dir = inspect(slash >= 0 ? prefixPart.slice(0, slash) : ".", ["dir"]);
      // 选项注入缓解：名为 -R/-L 的目录项被裸 * 匹配后会成为 ls 选项（-R -L 可递归跟随链接读区外）。
      // 存在任何 - 开头目录项即询问；revalidate 同款检查。残余 TOCTOU 窗口与 cat symlink 声明同级。
      const real = policy.resolve(dir.absolute).realPath;
      const noDashEntries = () => check(!fs.readdirSync(real).some((entry) => entry.startsWith("-")));
      noDashEntries();
      checks.push(async () => {
        try {
          noDashEntries();
        } catch {
          throw new PathTargetChangedError();
        }
      });
    }
    function operands(args: string[], options: RegExp) {
      const files: string[] = [];
      let explicit = false;
      for (const arg of args) {
        if (!explicit && arg === "--") {
          explicit = true;
          continue;
        }
        if (!explicit && arg.startsWith("-")) {
          check(options.test(arg));
          continue;
        }
        files.push(arg);
      }
      return files;
    }
    const neverOption = /^(?!)$/;
    async function visit(node: Node, canCd: boolean): Promise<void> {
      check(!node.hasError && !node.isMissing);
      const c = node.children;
      switch (node.type) {
        case "program": {
          // tree-sitter 把 `;` 分隔的语句挂在 program 层（list 节点只含 | && ||）。
          check(c.length >= 1 && c.length % 2 === 1);
          check(c.filter((_, i) => i % 2 === 1).every((n) => n.type === ";"));
          // `;` 不保证前段成功：cd 失败时后段 cwd 不可信（与拒绝 `cd docs || …` 同理），
          // 因此多段链一律禁用 cd 跟踪，含 cd 的 `;` 链整体询问。
          const trackable = canCd && c.length === 1;
          for (let i = 0; i < c.length; i += 2) await visit(c[i]!, trackable);
          return;
        }
        case "pipeline":
        case "list": {
          check(c.length >= 3 && c.length % 2 === 1);
          const ops = c.filter((_, i) => i % 2 === 1).map((n) => n.type);
          check(ops.every((op) => ["|", "&&", "||"].includes(op)));
          // Only an uninterrupted && chain guarantees the next command's cwd.
          for (let i = 0; i < c.length; i += 2) await visit(c[i]!, canCd && ops.every((op) => op === "&&"));
          return;
        }
        case "redirected_statement":
          check(c.length >= 2 && c[0]!.type === "command");
          for (const red of c.slice(1)) {
            const [op, dest] = red.children;
            check(red.type === "file_redirect" && red.children.length === 2 && op && dest);
            check(["<", ">", ">>"].includes(op.type));
            inspect(literal(dest), op.type === "<" ? ["file"] : ["file", "missing"], op.type !== "<");
          }
          await visit(c[0]!, canCd);
          return;
        case "command":
          break;
        default:
          throw new Unsupported();
      }
      check(c[0]?.type === "command_name");
      const name = literal(c[0]);
      // 先取命令名再提取操作数：只有 ls 放宽通配符，其余命令的 glob 词在此即拒。
      const args = c.slice(1).map((n) => literal(n, name === "ls"));
      matched.push(node.text);
      const names = commands.get(cwd) ?? new Set<string>();
      names.add(name);
      commands.set(cwd, names);
      const paths = (files: string[], kinds: Kind[] = ["file"], write = false) =>
        files.forEach((f) => inspect(f, kinds, write));
      const positional = () => operands(args, neverOption);
      switch (name) {
        case "true":
        case "false":
        case "pwd":
        case "whoami":
          check(!args.length);
          return;
        case "echo":
          return;
        case "printf":
          check(args[0] === "%s" || args[0] === "%s\\n");
          return;
        case "cat":
          paths(operands(args, /^-[nb]+$/));
          return;
        case "wc":
          paths(operands(args, /^-[lcwm]+$/));
          return;
        case "head":
        case "tail": {
          // 显式位置解析（cut 先例）：operands() 的选项正则只认无值选项，-n N 的值会被误当文件。
          // 白名单式天然排除 -f/--follow 族、合并 -n5 与 legacy -5；零文件读 stdin（EOF 安全）。
          const files: string[] = [];
          for (let i = 0; i < args.length; i++) {
            const arg = args[i]!;
            if (arg === "-n" || arg === "-c") {
              const value = args[++i];
              check(value !== undefined && /^\+?\d+$/.test(value));
              continue;
            }
            check(!arg.startsWith("-"));
            files.push(arg);
          }
          paths(files);
          return;
        }
        case "ls": {
          const files = operands(args, /^-[la]+$/);
          for (const f of files.length ? files : ["."]) {
            if (/[*?]/.test(f)) inspectGlob(f);
            else inspect(f, ["dir", "file"]);
          }
          return;
        }
        case "grep": {
          const files = operands(args, /^-[nFi]+$/);
          // files[0] 恒为模式；无文件操作数时读 stdin（执行器 stdin ignore → EOF，无副作用）。
          check(files.length >= 1);
          paths(files.slice(1));
          return;
        }
        case "diff":
        case "cmp": {
          const files = operands(args, name === "diff" ? /^-u$/ : neverOption);
          check(files.length === 2);
          paths(files);
          return;
        }
        case "sha256sum":
          paths(positional());
          return;
        case "test":
          check(args.length === 2 && args[0] === "-f");
          inspect(args[1]!, ["file", "missing"]);
          return;
        case "cut":
          check(
            args.length >= 5 &&
              args[0] === "-d" &&
              args[1]?.length === 1 &&
              args[2] === "-f" &&
              /^\d+$/.test(args[3]!),
          );
          paths(operands(args.slice(4), neverOption));
          return;
        case "tr":
          check(args.length === 2 && args[0] === "-d" && !args[1]?.startsWith("-"));
          return;
        case "uniq": {
          const files = positional();
          check(files.length <= 2);
          if (files[0]) inspect(files[0], ["file"]);
          if (files[1]) inspect(files[1], ["file", "missing"], true);
          return;
        }
        case "touch":
        case "tee":
          paths(operands(args, name === "tee" ? /^-a$/ : neverOption), ["file", "missing"], true);
          return;
        case "mkdir":
          paths(operands(args, /^-p$/), ["missing", "dir"], true);
          return;
        case "truncate":
          check(args[0] === "-s" && args[1] === "0");
          paths(operands(args.slice(2), neverOption), ["file", "missing"], true);
          return;
        case "cp": {
          const files = positional();
          check(files.length === 2);
          inspect(files[0]!, ["file"]);
          const dest = inspect(files[1]!, ["dir", "file", "missing"], true);
          if (dest.kind === "dir")
            inspect(
              path.join(files[1]!, path.basename(files[0]!)).split(path.sep).join("/"),
              ["file", "missing"],
              true,
            );
          return;
        }
        case "cd": {
          const files = positional();
          check(canCd && files.length === 1 && files[0] !== "-");
          cwd = inspect(files[0]!, ["dir"]).absolute;
          return;
        }
        case "git": {
          check(
            args.length === 2 &&
              (args.join(" ") === "rev-parse --show-toplevel" || args.join(" ") === "ls-files --cached"),
          );
          gitQueries.push({ args, cwd });
          return;
        }
        default:
          throw new Unsupported();
      }
    }
    await visit(root, true);
    const shell = shellExecutable ?? detectShell(policy.platform).executable;
    async function checkCommands() {
      const windows = policy.platform === "win32";
      let probeShell = shell;
      if (windows) {
        // The executor selects Git for Windows from its installation layout.
        check(path.isAbsolute(shell) && path.basename(shell).toLowerCase() === "bash.exe");
        const installation = path.resolve(path.dirname(shell), "..");
        check(
          !policy.isInside(fs.realpathSync(shell)) &&
            fs.existsSync(path.join(installation, "usr/bin/bash.exe")),
        );
      } else {
        const found = shell.includes("/")
          ? shell
          : (process.env.PATH ?? "")
              .split(":")
              .map((dir) => path.resolve(policy.workspaceRoot, dir, shell))
              .find((file) => {
                try {
                  fs.accessSync(file, fs.constants.X_OK);
                  return true;
                } catch {
                  return false;
                }
              });
        check(found && fs.realpathSync(found) === fs.realpathSync("/bin/bash"));
        probeShell = fs.realpathSync(found);
      }
      if (windowsPaths.size) {
        // MSYS also recognizes links that native Windows realpath treats as ordinary files.
        const bin = path.resolve(path.dirname(shell), "../usr/bin");
        const paths = [...windowsPaths.keys()].map((value) => value.replaceAll("\\", "/"));
        const options = { cwd: policy.workspaceRoot, timeout: 3000, windowsHide: true };
        const resolved = await promisify(execFile)(
          path.join(bin, "realpath.exe"),
          ["-mz", "--", ...paths],
          options,
        );
        const posix = resolved.stdout.split("\0");
        check(posix.pop() === "" && posix.length === paths.length);
        const converted = await promisify(execFile)(
          path.join(bin, "cygpath.exe"),
          ["-am", "--", ...posix],
          options,
        );
        const native = converted.stdout.trimEnd().split(/\r?\n/);
        check(native.length === paths.length);
        let index = 0;
        for (const expected of windowsPaths.values())
          check(path.normalize(native[index++]!).toLowerCase() === path.normalize(expected).toLowerCase());
      }
      for (const [directory, names] of commands) {
        // Query Bash builtins only, using names from the validated AST.
        const result = await promisify(execFile)(
          probeShell,
          ["-c", 'for n do type -t "$n" && command -v "$n" || exit 1; done', "bash", ...names],
          { cwd: directory, timeout: 3000, windowsHide: true },
        );
        const lines = result.stdout.trimEnd().split(/\r?\n/);
        check(lines.length === names.size * 2);
        let i = 0;
        for (const name of names) {
          const kind = lines[i++],
            resolved = lines[i++];
          if (kind === "builtin") check(resolved === name);
          else
            check(
              kind === "file" &&
                ["/bin/", "/usr/bin/", ...(windows ? ["/mingw64/bin/", "/ucrt64/bin/"] : [])].some(
                  (dir) => resolved === dir + name || (windows && resolved === dir + name + ".exe"),
                ),
            );
          if (name === "git" && resolved) {
            const native = windows ? path.join(path.dirname(shell), "..", resolved + ".exe") : resolved;
            check(!policy.isInside(fs.realpathSync(native)));
            const previous = executables.get(directory);
            check(!previous || previous === native);
            executables.set(directory, native);
          }
        }
      }
    }
    // A preceding write could replace repository metadata consulted by a later Git query.
    check(!writePaths.size || !gitQueries.length);
    // A write earlier in the same pipeline or list can change PATH lookup.
    if (matched.length > 1 && writePaths.size) {
      for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        if (!dir && policy.platform === "win32") continue;
        check(path.isAbsolute(dir) && !policy.resolve(dir).insideWorkspace);
      }
    }
    await checkCommands();
    for (const query of gitQueries) {
      const result = await analyzeGitQuery(query.args, query.cwd, policy, mode, executables.get(query.cwd));
      check(result.decision === "allow");
      for (const target of result.readPaths) readPaths.add(target);
      for (const target of result.writePaths) writePaths.add(target);
      checks.push(result.revalidate);
    }
    checks.push(async () => {
      try {
        await checkCommands();
      } catch {
        throw new PathTargetChangedError();
      }
    });
    return {
      decision: "allow",
      commands: matched,
      readPaths: [...readPaths],
      writePaths: [...writePaths],
      revalidate: async () => {
        try {
          checkEnvironment();
        } catch {
          throw new PathTargetChangedError();
        }
        for (const verify of checks) await verify();
      },
    };
  } catch {
    return { decision: "ask" };
  }
};
