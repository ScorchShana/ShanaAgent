import {
  Markdown,
  truncateToWidth,
  type Component,
  type MarkdownTheme,
  type TuiMouseEvent,
} from "../framework/index.js";
import { sanitizeDisplayText, type ConversationItem, type TuiStore } from "../store.js";
import { theme } from "../theme.js";

// skill 快照块：蓝色标题默认折叠、点击展开 Markdown 正文（与 Thinking header 同一 toggle 机制）。
// 正文走 Markdown 管线（SKILL.md 是 Markdown），不复用 SystemMessage 的纯文本摘要模式。
export class SkillMessage implements Component {
  private item: ConversationItem;
  private content: Markdown;
  constructor(
    item: ConversationItem,
    private store: TuiStore,
    md: MarkdownTheme,
  ) {
    this.item = item;
    this.content = new Markdown("", 0, 0, md);
    this.update(item);
  }
  private header(): string {
    const expanded = this.store.getSnapshot().expanded.has(this.item.id);
    return `${this.item.text} (${expanded ? "expanded" : "collapsed"})`;
  }
  update(item: ConversationItem) {
    this.item = item;
    this.content.setText(sanitizeDisplayText(item.skillContent ?? ""));
  }
  render(width: number) {
    const expanded = this.store.getSnapshot().expanded.has(this.item.id);
    return [
      theme.blue(truncateToWidth(this.header(), width)),
      ...(expanded ? this.content.render(width) : []),
    ];
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type === "click" && event.y === 0 && event.x < Math.min(event.width, this.header().length)) {
      this.store.toggle(this.item.id);
      return { handled: true };
    }
    return undefined;
  }
  invalidate() {
    this.content.invalidate();
  }
}
