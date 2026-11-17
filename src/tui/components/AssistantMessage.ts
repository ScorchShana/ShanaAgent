import { stripVTControlCharacters } from "node:util";
import {
  Markdown,
  truncateToWidth,
  VStack,
  MouseRegion,
  Text,
  type Component,
  type MarkdownTheme,
  type TuiMouseEvent,
} from "../framework/index.js";
import { sanitizeDisplayText, type ConversationItem, type TuiStore } from "../store.js";
import { theme } from "../theme.js";
export class AssistantMessage implements Component {
  private item: ConversationItem;
  private content: Markdown;
  private thinking: Markdown;
  private tree: VStack;
  constructor(
    item: ConversationItem,
    private store: TuiStore,
    md: MarkdownTheme,
  ) {
    this.item = item;
    this.content = new Markdown("", 0, 0, md);
    this.thinking = new Markdown("", 0, 0, md);
    const thoughts: Component = {
      render: (width) => {
        if (!this.item.thinking) return [];
        const expanded = this.store.getSnapshot().expanded.has(this.item.id),
          rows = this.thinking.render(width);
        return [
          theme.muted(truncateToWidth(`Thinking (${expanded ? "expanded" : "collapsed"})`, width)),
          ...(expanded
            ? rows
            : this.item.dim && !this.item.text
              ? rows.slice(-store.settings.thinkingPreviewLines)
              : rows.slice(0, store.settings.thinkingPreviewLines)
          ).map(theme.muted),
        ];
      },
      invalidate: () => this.thinking.invalidate(),
    };
    this.tree = new VStack([
      new MouseRegion(thoughts, (event) => {
        if (
          event.type === "click" &&
          event.y === 0 &&
          event.x <
            Math.min(
              event.width,
              `Thinking (${this.store.getSnapshot().expanded.has(this.item.id) ? "expanded" : "collapsed"})`
                .length,
            )
        ) {
          store.toggle(this.item.id);
          return { handled: true };
        }
        return undefined;
      }),
      {
        render: (width) => {
          const rows = this.item.text ? this.content.render(width) : [];
          return [
            ...(rows.length && this.item.thinking ? [""] : []),
            ...rows.map((row) =>
              this.item.failed
                ? theme.failed(stripVTControlCharacters(row))
                : this.item.compacted
                  ? theme.muted(stripVTControlCharacters(row))
                  : row,
            ),
            ...(this.item.failed ? new Text(theme.error("[failed]"), 0, 0).render(width) : []),
            ...(this.item.cancelled ? new Text(theme.muted("[cancelled]"), 0, 0).render(width) : []),
          ];
        },
        invalidate: () => this.content.invalidate(),
      },
    ]);
    this.update(item);
  }
  update(item: ConversationItem) {
    this.item = item;
    this.content.setText(sanitizeDisplayText(item.text));
    this.content.setStreaming(!!item.dim && !item.failed && !item.cancelled);
    this.thinking.setText(sanitizeDisplayText(item.thinking ?? ""));
    this.thinking.setStreaming(!!item.dim && !item.text && !item.failed && !item.cancelled);
  }
  render(width: number) {
    return this.tree.render(width);
  }
  handleMouse(event: TuiMouseEvent) {
    return this.tree.handleMouse(event);
  }
  invalidate() {
    this.tree.invalidate();
  }
}
