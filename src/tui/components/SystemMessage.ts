import { stripVTControlCharacters } from "node:util";
import { Text, type Component, type TuiMouseEvent } from "../framework/index.js";
import { graphemes, cellWidth, sanitizeDisplayText, type ConversationItem, type TuiStore } from "../store.js";
import { theme } from "../theme.js";
import { wrapDisplay } from "./DiffView.js";
const displayWidth = (text: string) => graphemes(text).reduce((sum, char) => sum + cellWidth(char), 0);
export class SystemMessage implements Component {
  private item: ConversationItem;
  private text = new Text("", 0, 0);
  constructor(
    item: ConversationItem,
    private store?: TuiStore,
  ) {
    this.item = item;
    this.update(item);
  }
  update(item: ConversationItem) {
    this.item = item;
    const text = sanitizeDisplayText(item.text);
    const styled =
      item.role === "duration" ? theme.dim(text) : item.role === "failure" ? theme.error(text) : text;
    // 被摘要替代的记录统一淡化，保留审计可见性但明示不再是上下文原文。
    this.text.setText(item.compacted ? theme.muted(stripVTControlCharacters(styled)) : styled);
  }
  render(width: number) {
    if (this.item.role !== "compaction") return this.text.render(width);
    const lines = [compactionSeparatorLine(sanitizeDisplayText(this.item.text), width)];
    // 摘要正文在模型上下文里（<conversation_summary>），默认折叠、点击展开即模型所见。
    if (this.item.summary !== undefined && this.store) {
      const expanded = this.store.getSnapshot().expanded.has(this.item.id);
      if (expanded) {
        const wrapped = `<conversation_summary>\n${sanitizeDisplayText(this.item.summary)}\n</conversation_summary>`;
        lines.push(
          ...wrapped
            .split("\n")
            .flatMap((line) => wrapDisplay(line, width))
            .map((line) => theme.muted(line)),
        );
        lines.push(theme.muted("点击折叠摘要"));
      } else {
        lines.push(theme.muted("点击展开摘要（模型上下文中的版本）"));
      }
    }
    return lines;
  }
  handleMouse(event: TuiMouseEvent) {
    if (
      this.item.role === "compaction" &&
      this.item.summary !== undefined &&
      this.store &&
      event.type === "click"
    ) {
      this.store.toggle(this.item.id);
      return { handled: true };
    }
    return undefined;
  }
  invalidate() {
    this.text.invalidate();
  }
}
const COMPACTION_SEPARATOR = "━";
export function compactionSeparatorLine(label: string, width?: number): string {
  const labelWidth = displayWidth(label);
  if (width === undefined)
    return `${COMPACTION_SEPARATOR.repeat(4)} ${label} ${COMPACTION_SEPARATOR.repeat(4)}`;
  if (labelWidth + 2 > width) {
    let text = "";
    let used = 0;
    for (const part of graphemes(label)) {
      const size = cellWidth(part);
      if (used + size > width) break;
      text += part;
      used += size;
    }
    return text;
  }
  const dashes = width - labelWidth - 2;
  const left = Math.floor(dashes / 2);
  return `${COMPACTION_SEPARATOR.repeat(left)} ${label} ${COMPACTION_SEPARATOR.repeat(dashes - left)}`;
}
