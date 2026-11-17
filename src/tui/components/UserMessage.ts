import { Text } from "../framework/index.js";
import { sanitizeDisplayText, type ConversationItem } from "../store.js";
import { theme, userBackground, MESSAGE_PADDING_X, MESSAGE_PADDING_Y } from "../theme.js";
export class UserMessage extends Text {
  constructor(item: ConversationItem) {
    super("", MESSAGE_PADDING_X, MESSAGE_PADDING_Y, userBackground);
    this.update(item);
  }
  update(item: ConversationItem) {
    // 被摘要替代的 Prompt 淡化：仍在审计历史中，但不再是上下文原文。
    this.setText((item.compacted ? theme.muted : theme.user)(sanitizeDisplayText(item.text)));
  }
}
