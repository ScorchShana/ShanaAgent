import type { PendingApproval } from "../../core/state.js";
import type { ApprovalPreview } from "../approval-preview.js";
import { Text, type Component, type MarkdownTheme, type TuiMouseEvent } from "../framework/index.js";
import { type ConversationItem, type TuiStore } from "../store.js";
import { UserMessage } from "./UserMessage.js";
import { AssistantMessage } from "./AssistantMessage.js";
import { SystemMessage } from "./SystemMessage.js";
import { ToolExecution } from "./ToolExecution.js";
import { toolBackground, MESSAGE_PADDING_X, MESSAGE_PADDING_Y } from "../theme.js";
export { compactionSeparatorLine } from "./SystemMessage.js";
export {
  bashResultDisplay,
  globResultDisplayLines,
  grepResultDisplayLines,
  readResultDisplayLines,
} from "./ToolRenderers.js";
type MessageComponent = Component & { update(item: ConversationItem): void };
export class MessageView implements Component {
  private component: MessageComponent;
  private item: ConversationItem;
  private lastWidth = 80;
  private padding = 0;
  constructor(item: ConversationItem, store: TuiStore, theme: MarkdownTheme) {
    this.item = item;
    this.component =
      item.role === "user"
        ? new UserMessage(item)
        : item.role === "assistant" || item.role === "attempt"
          ? new AssistantMessage(item, store, theme)
          : item.role === "tool" || item.role === "diff"
            ? new ToolExecution(item, store, theme)
            : new SystemMessage(item, store);
  }
  setApproval(approval?: PendingApproval, preview?: ApprovalPreview) {
    if (this.component instanceof ToolExecution) this.component.setApproval(approval, preview);
  }
  toggleApprovalDiff() {
    if (this.component instanceof ToolExecution) this.component.toggleApprovalDiff();
  }
  setDiff(item?: ConversationItem) {
    if (this.component instanceof ToolExecution) this.component.setDiff(item);
  }
  update(item: ConversationItem) {
    this.item = item;
    this.component.update(item);
  }
  render(width: number) {
    this.lastWidth = width;
    if (this.item.role === "user" || !["assistant", "attempt", "tool", "diff"].includes(this.item.role))
      return this.component.render(width);
    this.padding = width > MESSAGE_PADDING_X * 2 ? MESSAGE_PADDING_X : 0;
    const inner = Math.max(1, width - this.padding * 2),
      rows = this.component
        .render(inner)
        .map((row) => " ".repeat(this.padding) + row + " ".repeat(this.padding));
    if (this.item.role === "assistant" || this.item.role === "attempt") return rows;
    // 被排除的卡片用中性背景；合成 unknown 占位与真实 unknown 结果同色。
    const status =
      this.item.failed
        ? "queued"
        : this.item.syntheticUnknown
          ? "unknown"
          : (this.item.result?.status ?? this.item.activity ?? "queued");
    const bg = toolBackground(status);
    return [
      ...Array<string>(MESSAGE_PADDING_Y).fill(" ".repeat(width)),
      ...rows,
      ...Array<string>(MESSAGE_PADDING_Y).fill(" ".repeat(width)),
    ].map((row) => new Text(row, 0, 0, bg).render(width)[0] ?? bg(" ".repeat(width)));
  }
  handleMouse(event: TuiMouseEvent) {
    const tool = this.item.role === "tool" || this.item.role === "diff";
    if (
      event.x < this.padding ||
      event.x >= this.lastWidth - this.padding ||
      (tool && (event.y === 0 || event.y === this.render(this.lastWidth).length - 1))
    )
      return undefined;
    return this.component.handleMouse?.({
      ...event,
      x: event.x - this.padding,
      y: event.y - (tool ? 1 : 0),
      width: Math.max(1, this.lastWidth - this.padding * 2),
    });
  }
  invalidate() {
    this.component.invalidate();
  }
}
