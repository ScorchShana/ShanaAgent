import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SKILLS_ROOT, isPathInside } from "../security/path-policy.js";
import { SKILL_NAME_PATTERN, type SkillSnapshot } from "../sessions/records.js";

// Schema 归属 sessions/records（记录校验与加载器共用同一字符集与快照形态）；
// 根路径常量归属 security/path-policy（只读放行边界与加载器共用同一根）。
export type { SkillSnapshot } from "../sessions/records.js";
export { DEFAULT_SKILLS_ROOT } from "../security/path-policy.js";

export type SkillLoadErrorCode = "invalid_name" | "not_found" | "io" | "escape";

// 面向用户（TUI notice），不进模型上下文，故无需 Error: 前缀。
export class SkillLoadError extends Error {
  constructor(
    message: string,
    readonly code: SkillLoadErrorCode,
    readonly skillName: string,
  ) {
    super(message);
    this.name = "SkillLoadError";
  }
}

export interface SkillCommand {
  name: string;
  /** 去掉命令 token 及其后空白的请求原文，其余逐字保留 */
  request: string;
}

/** `/skill:name` 解析的唯一事实源：Controller / 渲染 / TUI / 标题预览共用。 */
export function splitSkillCommand(text: string): SkillCommand | null {
  if (!text.startsWith("/skill:")) return null;
  const match = /^\/skill:(\S*)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return null;
  return { name: match[1] ?? "", request: match[2] ?? "" };
}

export function listSkillNames(root: string = DEFAULT_SKILLS_ROOT): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // 目录不存在/不可读 → 空列表，菜单不报错；SKILL.md 存在性留到调用时校验。
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && SKILL_NAME_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

// 只剥不解析：仅文件开头恰为 --- 行且存在闭合 --- 行才剥；无闭合视同无 frontmatter。
function stripFrontmatter(text: string): string {
  const open = /^---\r?\n/.exec(text);
  if (!open) return text;
  const body = text.slice(open[0].length);
  const close = /(^|\r?\n)---\r?(\r?\n|$)/.exec(body);
  if (!close) return text;
  return body.slice(close.index + close[0].length);
}

function canonicalRoot(root: string): string {
  const absolute = path.resolve(root);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function loadSkill(name: string, root: string = DEFAULT_SKILLS_ROOT): SkillSnapshot {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillLoadError(`无效的 skill 名称："${name}"`, "invalid_name", name);
  }
  const skillsRoot = canonicalRoot(root);
  const requested = path.join(skillsRoot, name, "SKILL.md");
  let location: string;
  try {
    location = fs.realpathSync.native(requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SkillLoadError(`Skill "${name}" 不存在：${requested}`, "not_found", name);
    }
    throw new SkillLoadError(`读取 Skill "${name}" 失败：${(error as Error).message}`, "io", name);
  }
  // symlink 逃逸：realpath 必须仍在 skills 根内（根已 realpath 规范化）。
  if (!isPathInside(skillsRoot, location)) {
    throw new SkillLoadError(`Skill "${name}" 的 SKILL.md 指向 skills 目录之外`, "escape", name);
  }
  let raw: string;
  try {
    // CRLF checkout 归一（readPrompt 同款）：新快照恒存 LF，旧 CRLF 快照按原文渲染不迁移。
    raw = new TextDecoder("utf-8", { fatal: true })
      .decode(fs.readFileSync(location))
      .replaceAll("\r\n", "\n");
  } catch (error) {
    throw new SkillLoadError(`读取 Skill "${name}" 失败：${(error as Error).message}`, "io", name);
  }
  return { name, location, content: stripFrontmatter(raw).trim() };
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let invocationTemplate: string | undefined;

function loadInvocationTemplate(): string {
  if (invocationTemplate === undefined) {
    // prompts/ 不进 dist，相对源码/编译产物同深度加载（tools/prompts.ts 同款）。
    const url = new URL("../../prompts/skill-invocation.md", import.meta.url);
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(fs.readFileSync(url))
      .replaceAll("\r\n", "\n"); // CRLF checkout 归一（readPrompt 同款）
    if (text.trim().length === 0 || text.includes("\0")) {
      throw new Error(`Invalid prompt file: ${url.pathname}`);
    }
    invocationTemplate = text.trimEnd();
  }
  return invocationTemplate;
}

/** §2.1 唯一权威展开格式：skill 块 + 空行 + 请求原文逐字；空请求以 </skill> 结束。 */
export function renderSkillMessage(skill: SkillSnapshot, request: string): string {
  const header = loadInvocationTemplate().replaceAll(
    "{{SKILL_DIR}}",
    escapeXmlAttr(path.dirname(skill.location)),
  );
  const content = skill.content.replace(/<\/skill>/g, "&lt;/skill&gt;");
  const block =
    `<skill name="${escapeXmlAttr(skill.name)}" location="${escapeXmlAttr(skill.location)}">\n` +
    `${header}\n\n${content}\n</skill>`;
  return request.length === 0 ? block : `${block}\n\n${request}`;
}
