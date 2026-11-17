import { theme } from "../theme.js";
import type { ConversationItem, TuiStore } from "../store.js";
import { wrapTextWithAnsi, visibleWidth, type Component, type TuiMouseEvent } from "../framework/index.js";
import { graphemes, sanitizeDisplayText } from "../store.js";

export { cellWidth } from "../store.js";

export interface DiffRow {
  kind: "add" | "remove";
  text: string;
  oldLine?: number;
  newLine?: number;
}
export function buildDiff(before: string, after: string): DiffRow[] {
  const lines = (text: string): string[] => text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
  const oldLines = lines(before);
  const newLines = lines(after);
  let prefix = 0;
  let suffix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix])
    prefix++;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  )
    suffix++;
  const text = (line: string): string => line.replace(/\r\n$|[\r\n]$/g, "");
  return [
    ...oldLines
      .slice(prefix, oldLines.length - suffix)
      .map((line, index) => ({ kind: "remove" as const, oldLine: prefix + index + 1, text: text(line) })),
    ...newLines
      .slice(prefix, newLines.length - suffix)
      .map((line, index) => ({ kind: "add" as const, newLine: prefix + index + 1, text: text(line) })),
  ];
}
export function reconstructEdit(before: string, args: Record<string, unknown>, maxBytes?: number): string {
  if (typeof args.old_string !== "string" || !args.old_string || typeof args.new_string !== "string")
    throw new Error("缺少有效的替换参数");
  const normalize = (text: string): string => text.replace(/\r\n?/g, "\n");
  const content = normalize(before.replace(/^\uFEFF/, ""));
  const oldText = normalize(args.old_string);
  const newText = normalize(args.new_string);
  if (oldText === newText) throw new Error("替换内容相同");
  let count = 0;
  let position = 0;
  let previousEnd = 0;
  let firstCharacter: string | undefined;
  while ((position = content.indexOf(oldText, position)) !== -1) {
    if (firstCharacter === undefined) {
      if (position > previousEnd) firstCharacter = content[previousEnd];
      else if (newText.length > 0) firstCharacter = newText[0];
    }
    count++;
    position += oldText.length;
    previousEnd = position;
    if (count > 1 && !args.replace_all) throw new Error("替换内容存在多处匹配");
  }
  if (count === 0) throw new Error("未找到替换内容");
  firstCharacter ??= content[previousEnd];
  const resultBytes =
    Buffer.byteLength(content) +
    count * (Buffer.byteLength(newText) - Buffer.byteLength(oldText)) -
    (firstCharacter === "\uFEFF" ? 3 : 0);
  if (maxBytes !== undefined && resultBytes > maxBytes) throw new Error("结果内容超限");
  return (
    args.replace_all ? content.replaceAll(oldText, () => newText) : content.replace(oldText, () => newText)
  ).replace(/^\uFEFF/, "");
}
export function wrapDisplay(text: string, width?: number): string[] {
  if (!width || width < 1) return [text];
  return wrapTextWithAnsi(text, width);
}
export function diffDisplayRows(
  before: string,
  after: string,
  foldLines: number,
  foldChars: number,
  expanded: boolean,
): { rows: { text: string; color: string }[]; folded: boolean } {
  const source = buildDiff(before, after);
  const rows: { text: string; color: string }[] = [];
  let size = 0;
  for (const row of source) {
    const text = sanitizeDisplayText(
      `${row.oldLine ?? row.newLine} ${row.kind === "add" ? "+" : "-"} ${row.text}`,
    );
    if (!expanded && rows.length >= foldLines) break;
    let shown = text;
    if (!expanded) {
      let remaining = foldChars - size;
      shown = "";
      for (const point of graphemes(text)) {
        const count = Array.from(point).length;
        if (count > remaining) break;
        shown += point;
        remaining -= count;
      }
    }
    if (!shown && text) break;
    rows.push({ text: shown, color: row.kind === "add" ? "green" : "red" });
    size += Array.from(shown).length + 1;
    if (shown !== text) break;
  }
  return {
    rows,
    folded:
      rows.length !== source.length ||
      rows.some(
        (row, index) =>
          row.text !==
          `${source[index]!.oldLine ?? source[index]!.newLine} ${source[index]!.kind === "add" ? "+" : "-"} ${source[index]!.text}`,
      ),
  };
}
export function diffViewRows(
  before: string,
  after: string,
  foldLines: number,
  foldChars: number,
  expanded: boolean,
  width?: number,
): { rows: { text: string; color: string }[]; folded: boolean } {
  const display = diffDisplayRows(before, after, foldLines, foldChars, expanded);
  return {
    rows: display.rows.flatMap((row) => wrapDisplay(row.text, width).map((text) => ({ ...row, text }))),
    folded: display.folded,
  };
}

export function styleDiffRow(row: { text: string; color: string }): string {
  const match = /^(\d+)( ?)(.*)$/u.exec(row.text);
  const color = row.color === "green" ? theme.success : theme.error;
  return match ? theme.muted(match[1]!) + match[2] + color(match[3]!) : color(row.text);
}
export class HistoricalDiff implements Component {
  private item?: ConversationItem;
  private rows: { text: string; color: string }[] = [];
  private folded = false;
  private available = false;
  private expanded = false;
  private width = 80;
  private height = 0;
  constructor(private store: TuiStore) {}
  update(item: ConversationItem) {
    const expanded = this.store.getSnapshot().expandedDiffs?.has(item.id) ?? false;
    if (this.item?.call === item.call && this.item?.result === item.result && expanded === this.expanded) {
      this.item = item;
      return;
    }
    this.item = item;
    this.expanded = expanded;
    this.available = false;
    const before = item.result?.priorContent,
      args = item.call?.parse.status === "parsed" ? item.call.parse.arguments : undefined;
    if (before === undefined || !args) return;
    try {
      const after =
        item.call?.name === "edit"
          ? reconstructEdit(before, args)
          : typeof args.content === "string"
            ? args.content
            : undefined;
      if (after === undefined) return;
      const diff = diffDisplayRows(
        before,
        after,
        this.store.settings.diffFoldLines,
        this.store.settings.diffFoldChars,
        expanded,
      );
      this.rows = diff.rows;
      this.folded = diff.folded;
      this.available = true;
    } catch {
      this.available = false;
    }
  }
  render(width: number) {
    this.width = width;
    const rows = !this.available
      ? wrapDisplay("Diff unavailable", width)
      : [
          ...this.rows.flatMap((row) => wrapDisplay(styleDiffRow(row), width)),
          ...(this.folded || this.expanded
            ? wrapDisplay(theme.dim(this.expanded ? "点击折叠 Diff" : "点击展开全部 Diff"), width)
            : []),
        ];
    this.height = rows.length;
    return rows;
  }
  handleMouse(event: TuiMouseEvent) {
    if (
      event.type === "click" &&
      this.available &&
      (this.folded || this.expanded) &&
      event.y === this.height - 1 &&
      event.x < Math.min(this.width, visibleWidth(this.expanded ? "点击折叠 Diff" : "点击展开全部 Diff")) &&
      this.item
    ) {
      this.store.toggleDiff(this.item.id);
      return { handled: true };
    }
    return undefined;
  }
  invalidate() {}
}
