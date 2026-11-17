import { Text, type Component } from "../framework/index.js";
import { graphemes, cellWidth, sanitizeDisplayText, type ConversationItem } from "../store.js";
import { theme } from "../theme.js";
const displayWidth = (text: string) => graphemes(text).reduce((sum, char) => sum + cellWidth(char), 0);
export class SystemMessage implements Component {
  private item: ConversationItem;
  private text = new Text("", 0, 0);
  constructor(item: ConversationItem) {
    this.item = item;
    this.update(item);
  }
  update(item: ConversationItem) {
    this.item = item;
    const text = sanitizeDisplayText(item.text);
    this.text.setText(
      item.role === "duration" ? theme.dim(text) : item.role === "failure" ? theme.error(text) : text,
    );
  }
  render(width: number) {
    return this.item.role === "compaction"
      ? [compactionSeparatorLine(sanitizeDisplayText(this.item.text), width)]
      : this.text.render(width);
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
