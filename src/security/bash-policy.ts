/**
 * auto 模式 bash 第一道闸：纯函数、零 IO、保守判定（判不了 → ask，永不兜底放行）。
 * 接口即函数类型 seam：ApprovalManager 经 analyzeBash 注入，后续解析包替换实现即可。
 * 残余风险（已声明）：区内 symlink 指向区外可被 cat 跟随读取；glob 展开可能命中此类
 * symlink。白名单命令读区内文件与 read 工具既有暴露面等价，无新增。
 */
export type BashCommandVerdict = "allow" | "ask";
export type BashCommandAnalyzer = (command: string) => BashCommandVerdict;

// v1 白名单：固有无写副作用。显式排除：git（子命令可写）、find（-delete/-exec）、
// date（-s 设时间）、env/printenv/set（可能输出凭据）、sed/awk（-i/重定向写）、
// sort（-o 写）、tee/xargs/dd、一切解释器与包管理器（node/python/npm/…）。
// tail -f 只读但长驻，由既有 timeout 机制兜底，允许。
const ALLOWED_FIRST_COMMANDS = new Set([
  "ls",
  "pwd",
  "echo",
  "cat",
  "head",
  "tail",
  "wc",
  "which",
  "whoami",
  "hostname",
  "uname",
  "true",
  "false",
]);

// shell 控制/替换/重定向元字符一律 ask：$ 含变量/命令替换/$HOME 均不可静态判定；
// ~ 展开指向区外；换行（含 CR）意味着多命令。* ? [ ] glob 允许（纯展开无写副作用，
// 仍受参数路径守卫约束）。
const SHELL_META_CHARS = /[;&|><`$(){}\n\r~]/;

// Windows 盘符（C:…）开头 → 区外路径。
const WINDOWS_DRIVE = /^[A-Za-z]:/;

export const matchFirstCommand: BashCommandAnalyzer = (command) => {
  const trimmed = command.trim();
  if (trimmed === "") return "ask";
  if (SHELL_META_CHARS.test(trimmed)) return "ask";

  const tokens = trimmed.split(/\s+/);
  const first = tokens[0]!;
  // 首 token 必须是裸命令名：路径形式（/ \）与环境赋值前缀（FOO=bar cmd）不可静态判定。
  if (first.includes("/") || first.includes("\\") || first.includes("=")) return "ask";
  if (!ALLOWED_FIRST_COMMANDS.has(first)) return "ask";

  // 隐私守卫：cwd 固定工作区根，相对路径天然区内；绝对/上跳路径可能把凭据泄入上下文。
  // ~ 已被元字符规则整体拒绝，此处不再重复；单反斜杠开头是 Windows 盘根路径，同样拒绝。
  for (const token of tokens.slice(1)) {
    if (token.startsWith("/") || token.startsWith("\\") || token.startsWith("..")) return "ask";
    if (token.split(/[\\/]/).includes("..")) return "ask";
    if (WINDOWS_DRIVE.test(token)) return "ask";
  }
  return "allow";
};