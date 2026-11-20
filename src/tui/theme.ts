import {
  styleText,
  parseColor,
  getTerminalColorMode,
  type TextAttributes,
  type MarkdownTheme,
} from "./framework/index.js";
import { highlightCode } from "./syntax-highlight.js";
const style =
  (color?: string, attributes: TextAttributes = {}) =>
  (text: string) =>
    styleText(text, { ...attributes, ...(color ? { fg: parseColor(color) } : {}) }, getTerminalColorMode());
export const theme = {
  blue: style("#82AAFF"),
  brand: style("#82AAFF", { bold: true }),
  muted: style("#98A5B8"),
  user: style("#E2E8F0"),
  success: style("#8CCF9B"),
  error: style("#F08080"),
  warning: style("#E6C07B"),
  cyan: style("#89DCEB"),
  failed: style("#F08080", { strikethrough: true }),
  dim: style(undefined, { dim: true }),
  bold: style(undefined, { bold: true }),
  italic: style(undefined, { italic: true }),
  underline: style(undefined, { underline: true }),
  strike: style(undefined, { strikethrough: true }),
};
export const background = (color: string) => (text: string) =>
  styleText(text, { bg: parseColor(color) }, getTerminalColorMode());
export const userBackground = background("#202C40");
// skill 快照卡片：蓝色系深底，与用户气泡/工具卡片同族但可区分。
export const skillBackground = background("#1E2A4A");
export function toolBackground(status: string) {
  return background(
    status === "success"
      ? "#20352C"
      : status === "error"
        ? "#3B252B"
        : ["denied", "timeout", "unknown"].includes(status)
          ? "#3B3322"
          : "#252A33",
  );
}
export const selectTheme = {
  selectedPrefix: theme.blue,
  selectedText: theme.blue,
  description: theme.muted,
  scrollInfo: theme.muted,
  noMatch: theme.muted,
};
export const editorTheme = { borderColor: theme.blue, selectList: selectTheme };
export const markdownTheme: MarkdownTheme = {
  heading: theme.brand,
  link: theme.blue,
  linkUrl: theme.muted,
  code: theme.cyan,
  codeBlock: (t) => t,
  codeBlockBorder: theme.muted,
  quote: (t) => t,
  quoteBorder: theme.muted,
  hr: theme.muted,
  listBullet: theme.blue,
  bold: theme.bold,
  italic: theme.italic,
  strikethrough: theme.strike,
  underline: theme.underline,
  highlightCode,
};
export function syntaxStyle(scope: string, text: string): string {
  return (
    /comment/.test(scope)
      ? theme.muted
      : /keyword|literal/.test(scope)
        ? theme.blue
        : /string|number|regexp/.test(scope)
          ? theme.success
          : /title|function/.test(scope)
            ? theme.warning
            : /type|built_in/.test(scope)
              ? theme.cyan
              : (t: string) => t
  )(text);
}
export const MESSAGE_GAP = 1,
  MESSAGE_PADDING_X = 1,
  MESSAGE_PADDING_Y = 1;
