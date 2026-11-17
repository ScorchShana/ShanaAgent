import { Text } from "../framework/index.js";
import { sanitizeDisplayText, type ConversationItem } from "../store.js";
import { theme, userBackground, MESSAGE_PADDING_X, MESSAGE_PADDING_Y } from "../theme.js";
export class UserMessage extends Text {
  constructor(item: ConversationItem) {
    super("", MESSAGE_PADDING_X, MESSAGE_PADDING_Y, userBackground);
    this.update(item);
  }
  update(item: ConversationItem) {
    this.setText(theme.user(sanitizeDisplayText(item.text)));
  }
}
