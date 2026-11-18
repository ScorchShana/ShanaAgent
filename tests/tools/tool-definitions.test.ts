import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateToolCall } from "@earendil-works/pi-ai";
import { DEFAULT_EDIT_MAX_FILE_BYTES, parseSettings } from "../../src/llm/settings-store.js";
import { createToolRegistry, TOOL_NAMES } from "../../src/tools/registry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(HERE, "..", "..", "prompts", "tools");

const registry = createToolRegistry("linux", parseSettings(undefined));
const tools = registry
  .list()
  .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));

function renderedPrompt(name: string): string {
  const raw = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), "utf8");
  return raw.replaceAll("{editMaxFileBytes}", String(DEFAULT_EDIT_MAX_FILE_BYTES));
}

function toolCall(name: string, args: Record<string, unknown>) {
  return { type: "toolCall" as const, id: `call-${name}`, name, arguments: args };
}

const VALID_ARGS: Record<string, Record<string, unknown>> = {
  read: { path: "src/a.txt" },
  glob: { pattern: "**/*.ts" },
  grep: { pattern: "TODO" },
  write: { path: "src/a.txt", content: "hello" },
  edit: { path: "src/a.txt", old_string: "a", new_string: "b" },
  bash: { command: "echo hi" },
};

describe("V4 六工具定义与确认稿一致", () => {
  it("工具集固定为六件且顺序稳定", () => {
    expect(registry.names()).toEqual([...TOOL_NAMES]);
  });

  it("每个工具的 Description 逐字等于 prompts/tools 确认稿（edit 渲染 editMaxFileBytes）", () => {
    for (const name of TOOL_NAMES) {
      expect(registry.get(name)!.description).toBe(renderedPrompt(name));
    }
  });

  it("定义快照（name/access/description/parameters）与确认稿冻结一致", () => {
    const snapshot = registry.list().map((tool) => ({
      name: tool.name,
      access: tool.access,
      description: tool.description,
      parameters: tool.parameters,
    }));
    expect(snapshot).toMatchSnapshot();
  });

  it("参数 Schema 数值边界与默认值正确", () => {
    const read = registry.get("read")!.parameters;
    expect(read.required).toEqual(["path"]);
    expect(read.additionalProperties).toBe(false);
    expect(read.properties.offset).toMatchObject({ type: "integer", minimum: 1, default: 1 });
    expect(read.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 5000, default: 2000 });

    const grep = registry.get("grep")!.parameters;
    expect(grep.required).toEqual(["pattern"]);
    expect(grep.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 500, default: 100 });

    const edit = registry.get("edit")!.parameters;
    expect(edit.required).toEqual(["path", "old_string", "new_string"]);
    expect(edit.properties.replace_all).toMatchObject({ type: "boolean", default: false });

    const write = registry.get("write")!.parameters;
    expect(write.required).toEqual(["path", "content"]);

    const bash = registry.get("bash")!.parameters;
    expect(bash.required).toEqual(["command"]);
    expect(bash.properties.timeout).toMatchObject({ type: "integer", minimum: 1, maximum: 1200, default: 120 });
  });
});

describe("V4 工具 Schema 被 pi-ai validateToolCall 接受", () => {
  it.each(TOOL_NAMES.map((name) => [name]))("%s 合法调用通过校验", (name) => {
    const validated = validateToolCall(tools, toolCall(name, VALID_ARGS[name]!));
    expect(typeof validated).toBe("object");
  });

  it("缺失必填参数被拒绝", () => {
    expect(() => validateToolCall(tools, toolCall("read", {}))).toThrow();
  });

  it("参数类型错误被拒绝", () => {
    expect(() => validateToolCall(tools, toolCall("grep", { pattern: "x", limit: "many" }))).toThrow();
  });

  it("未知工具名被拒绝", () => {
    expect(() => validateToolCall(tools, toolCall("nope", {}))).toThrow();
  });
});
