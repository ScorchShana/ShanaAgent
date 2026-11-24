import fs from "node:fs";

export const PROMPT_TOOL_NAMES = ["read", "glob", "grep", "write", "edit", "bash", "view_image"] as const;
export interface PromptBundle {
  system: string;
  tools: Record<string, string>;
}

function readPrompt(url: URL): string {
  // autocrlf=true 的 checkout 会使提示词为 CRLF；归一保证模型可见字节与逐字锚定稳定。
  // 只归一 CRLF，孤立 CR 不动（read 工具与 AGENTS.md 的逐字契约不在此列）。
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(fs.readFileSync(url))
    .replaceAll("\r\n", "\n");
  if (text.trim().length === 0 || text.includes("\0")) {
    throw new Error(`Invalid prompt file: ${url.pathname}`);
  }
  return text;
}

export function loadPrompts(root = new URL("../../prompts/", import.meta.url)): PromptBundle {
  const system = readPrompt(new URL("constitution.md", root));
  const tools: Record<string, string> = {};
  for (const name of PROMPT_TOOL_NAMES) {
    tools[name] = readPrompt(new URL(`tools/${name}.md`, root));
  }
  return { system, tools };
}
