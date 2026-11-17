import fs from "node:fs";

export const PROMPT_TOOL_NAMES = ["read", "glob", "grep", "write", "edit", "bash"] as const;
export interface PromptBundle {
  system: string;
  tools: Record<string, string>;
}

function readPrompt(url: URL): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(url));
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

export type LoadedDecisionPrompt = { status: "ok"; text: string } | { status: "invalid"; message: string };

export function loadDecisionPrompt(root = new URL("../../prompts/", import.meta.url)): LoadedDecisionPrompt {
  try {
    return { status: "ok", text: readPrompt(new URL("decision.md", root)) };
  } catch {
    return { status: "invalid", message: "decision.md: 提示词缺失、读取失败或内容无效" };
  }
}
