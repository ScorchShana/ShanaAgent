import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import powershell from "highlight.js/lib/languages/powershell";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import java from "highlight.js/lib/languages/java";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import { syntaxStyle } from "./theme.js";
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("java", java);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };
export function highlightCode(code: string, language?: string): string[] {
  if (!language || !hljs.getLanguage(language)) return code.split("\n");
  try {
    const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    const stack: string[] = [];
    let output = "";
    for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
      if (token.startsWith("<span")) {
        stack.push(/class="([^"]*)"/.exec(token)?.[1] ?? "");
        continue;
      }
      if (token === "</span>") {
        stack.pop();
        continue;
      }
      const text = token.replace(/&([^;]+);/g, (all, key: string) => entities[key] ?? all);
      output += text
        .split("\n")
        .map((part) => syntaxStyle(stack.join(" "), part))
        .join("\n");
    }
    return output.split("\n");
  } catch {
    return code.split("\n");
  }
}
const extensions: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  py: "python",
  sh: "bash",
  bash: "bash",
  ps1: "powershell",
  xml: "xml",
  html: "xml",
  svg: "xml",
  css: "css",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  java: "java",
  go: "go",
  rs: "rust",
};
export function languageForPath(path: string): string | undefined {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 || dot === name.length - 1 ? undefined : extensions[name.slice(dot + 1).toLowerCase()];
}
