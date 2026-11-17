import { theme } from "../theme.js";
import type { ConversationItem } from "../store.js";
import { Text } from "../framework/index.js";
import { highlightCode, languageForPath } from "../syntax-highlight.js";
import { graphemes, cellWidth, sanitizeDisplayText } from "../store.js";
import { wrapDisplay } from "./DiffView.js";
const TOOL_SUMMARY_FIELDS: Record<string, readonly string[]> = {
  read: ["path", "offset", "limit"],
  glob: ["pattern", "path"],
  grep: ["pattern", "path", "glob", "limit"],
  write: ["path"],
  edit: ["path"],
};
const TOOL_ARGUMENT_DEFAULTS: Record<string, Record<string, unknown>> = {
  read: { offset: 1, limit: 2000 },
  grep: { limit: 100 },
};
const formatArgumentValue = (value: unknown): string => {
  const text = sanitizeDisplayText(typeof value === "string" ? value : String(value));
  return /[\s"]/u.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text;
};
export function toolSummary(name: string, args: Record<string, unknown>): string {
  if (name === "bash") return "";
  const fields = TOOL_SUMMARY_FIELDS[name] ?? Object.keys(args);
  const defaults = TOOL_ARGUMENT_DEFAULTS[name] ?? {};
  const parts: string[] = [];
  for (const field of fields) {
    let value = args[field] ?? defaults[field];
    if (field === "path") value ??= ".";
    if (value === undefined) continue;
    parts.push(`${field}=${formatArgumentValue(value)}`);
  }
  return parts.join(" ");
}
const displayWidth = (text: string): number =>
  graphemes(text).reduce((sum, char) => sum + cellWidth(char), 0);
interface DisplayLine {
  text: string;
  soft: boolean;
  indent?: number;
}
const wrapDisplayLines = (text: string, width?: number): DisplayLine[] =>
  text.split("\n").flatMap((line) => {
    const parts = wrapDisplay(line, width);
    return parts.map((part, index) => ({ text: part, soft: index < parts.length - 1 }));
  });
const READ_RESULT_LINE = /^(\d+): ?(.*)$/u;
const GREP_RESULT_LINE = /^(.*):(\d+): (.*)$/u;
const GLOB_HINT = /^\((?:No files found|Results truncated:)/u;
const GLOB_CONTINUATION_INDENT = 2;
const BASH_EXIT_LINE = /^Exit code: (-?\d+)$/u;
const BASH_NO_OUTPUT = "(no output)";
interface BashResultDisplay {
  exitCode: string | null;
  lines: DisplayLine[];
}
export function readResultDisplayLines(
  content: string,
  width?: number,
  highlighted?: string[],
): DisplayLine[] {
  const source = sanitizeDisplayText(content).split("\n");
  const wrapped =
    source.length >= 4 &&
    source[0]!.startsWith("<path>") &&
    source[1] === "<content>" &&
    source.at(-2) === "</content>";
  const lines = wrapped ? [...source.slice(2, -2), source.at(-1)!] : source;
  const numberWidth = lines.reduce((max, line) => {
    const match = READ_RESULT_LINE.exec(line);
    return match ? Math.max(max, displayWidth(match[1]!)) : max;
  }, 0);
  const output: DisplayLine[] = [];
  let codeIndex = 0;
  for (const line of lines) {
    const match = READ_RESULT_LINE.exec(line);
    if (!match) {
      output.push(...wrapDisplayLines(line, width));
      continue;
    }
    const padding = numberWidth - displayWidth(match[1]!);
    const prefix = `${" ".repeat(padding)}${match[1]}: `;
    const indent = displayWidth(prefix);
    const body = highlighted?.[codeIndex++] ?? match[2] ?? "";
    if (width !== undefined && indent >= width) {
      output.push(...wrapDisplayLines(prefix + body, width));
      continue;
    }
    const parts = width === undefined ? [body] : wrapDisplay(body, Math.max(1, width - indent));
    parts.forEach((part, index) =>
      output.push({
        text: index === 0 ? (highlighted ? theme.muted(prefix) : prefix) + part : " ".repeat(indent) + part,
        soft: index < parts.length - 1,
        indent: index === 0 ? padding : indent,
      }),
    );
  }
  return output;
}
export function grepResultDisplayLines(content: string, width?: number): DisplayLine[] {
  const output: DisplayLine[] = [];
  for (const line of sanitizeDisplayText(content).split("\n")) {
    const match = GREP_RESULT_LINE.exec(line);
    if (!match) {
      output.push(...wrapDisplayLines(line, width));
      continue;
    }
    const prefix = `${match[1]}:${match[2]}: `;
    const indent = displayWidth(prefix);
    if (width !== undefined && indent >= width) {
      output.push(...wrapDisplayLines(line, width));
      continue;
    }
    const body = match[3] ?? "";
    const parts = width === undefined ? [body] : wrapDisplay(body, Math.max(1, width - indent));
    parts.forEach((part, index) =>
      output.push({
        text: index === 0 ? prefix + part : " ".repeat(indent) + part,
        soft: index < parts.length - 1,
        indent: index === 0 ? 0 : indent,
      }),
    );
  }
  return output;
}
export function globResultDisplayLines(content: string, width?: number): DisplayLine[] {
  const source = sanitizeDisplayText(content).split("\n");
  const output: DisplayLine[] = [];
  for (let index = 0; index < source.length; index++) {
    const line = source[index]!;
    if (line === "" && GLOB_HINT.test(source[index + 1] ?? "")) continue;
    if (line === "" || GLOB_HINT.test(line) || line.startsWith("Error:") || width === undefined) {
      output.push(...wrapDisplayLines(line, width));
      continue;
    }
    const parts = wrapDisplay(line, Math.max(1, width - GLOB_CONTINUATION_INDENT));
    parts.forEach((part, partIndex) =>
      output.push({
        text: partIndex === 0 ? part : " ".repeat(GLOB_CONTINUATION_INDENT) + part,
        soft: partIndex < parts.length - 1,
        indent: partIndex === 0 ? 0 : GLOB_CONTINUATION_INDENT,
      }),
    );
  }
  return output;
}
const trimTrailingEmpty = (lines: string[]): string[] => {
  const output = [...lines];
  while (output.length > 0 && output.at(-1) === "") output.pop();
  return output;
};
const isEmptyBashStream = (lines: string[]): boolean => {
  const body = trimTrailingEmpty(lines);
  return body.length === 0 || (body.length === 1 && body[0] === BASH_NO_OUTPUT);
};
export function bashResultDisplay(content: string, width?: number): BashResultDisplay {
  const text = sanitizeDisplayText(content);
  const source = text.split("\n");
  const exit = BASH_EXIT_LINE.exec(source[0] ?? "");
  const stdoutIndex = source.indexOf("Stdout:");
  const stderrIndex = source.indexOf("Stderr:", stdoutIndex + 1);
  if (stdoutIndex !== 1 || stderrIndex <= stdoutIndex)
    return { exitCode: null, lines: wrapDisplayLines(text, width) };
  const kept: string[] = [];
  if (exit) kept.push("Output:");
  else kept.push(source[0]!);
  const stdout = trimTrailingEmpty(source.slice(stdoutIndex + 1, stderrIndex));
  const stderr = trimTrailingEmpty(source.slice(stderrIndex + 1));
  if (!isEmptyBashStream(stdout)) kept.push("Stdout:", ...stdout);
  if (!isEmptyBashStream(stderr)) kept.push("Stderr:", ...stderr);
  if (exit) kept.push(`Exit code: ${exit[1]}`);
  return {
    exitCode: exit?.[1] ?? null,
    lines: wrapDisplayLines(kept.join("\n"), width),
  };
}

export function highlightedReadContent(item: ConversationItem): string[] {
  if (item.call?.name !== "read" || !item.result) return [];
  const args = item.call.parse.status === "parsed" ? item.call.parse.arguments : {};
  const lines = sanitizeDisplayText(item.result.content).split("\n");
  const wrapped = lines[0]?.startsWith("<path>") && lines[1] === "<content>" && lines.at(-2) === "</content>";
  const body = (wrapped ? lines.slice(2, -2) : lines)
    .filter((line) => READ_RESULT_LINE.test(line))
    .map((line) => READ_RESULT_LINE.exec(line)![2] ?? "")
    .join("\n");
  return highlightCode(body, languageForPath(String(args.path ?? "")));
}
type ResultRenderer = (content: string, width: number, highlighted?: string[]) => DisplayLine[];
const renderers: Record<string, ResultRenderer> = {
  read: readResultDisplayLines,
  grep: grepResultDisplayLines,
  glob: globResultDisplayLines,
  bash: (content, width) => bashResultDisplay(content, width).lines,
  write: (content, width) => plainResult(content, width),
  edit: (content, width) => plainResult(content, width),
};
const plainResult: ResultRenderer = (content, width) =>
  new Text(sanitizeDisplayText(content), 0, 0).render(width).map((text) => ({ text, soft: false }));
export function resultRenderer(name: string): ResultRenderer {
  return renderers[name] ?? plainResult;
}
