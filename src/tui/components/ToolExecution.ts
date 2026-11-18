import type { PendingApproval } from "../../core/state.js";
import type { ApprovalPreview } from "../approval-preview.js";
import { approvalSummaryLines } from "./ApprovalDialog.js";
import { diffDisplayRows, styleDiffRow } from "./DiffView.js";
import { stripVTControlCharacters } from "node:util";
import {
  Image,
  VStack,
  visibleWidth,
  MouseRegion,
  truncateToWidth,
  type Component,
  type MarkdownTheme,
  type TuiMouseEvent,
} from "../framework/index.js";
import { sanitizeDisplayText, type ConversationItem, type TuiStore } from "../store.js";
import { MISSING_TOOL_RESULT_TEXT } from "../../core/context-builder.js";
import { wrapDisplay, HistoricalDiff } from "./DiffView.js";
import { toolSummary, resultRenderer, highlightedReadContent } from "./ToolRenderers.js";
import { theme } from "../theme.js";
import { highlightCode } from "../syntax-highlight.js";
const LIVE_OUTPUT_TAIL_LINES = 5;
export class ToolExecution implements Component {
  private item: ConversationItem;
  private approval?: PendingApproval;
  private preview?: ApprovalPreview;
  private previewExpanded = false;
  private previewHeight = 0;
  private previewRows: string[] = [];
  private previewPrompt = "";
  private rebuildPreview() {
    this.previewRows = [];
    this.previewPrompt = "";
    if (this.preview?.status !== "ready") return;
    const diff = diffDisplayRows(
      this.preview.before,
      this.preview.after,
      this.store.settings.diffFoldLines,
      this.store.settings.diffFoldChars,
      this.previewExpanded,
    );
    this.previewRows = diff.rows.map(styleDiffRow);
    if (diff.folded || this.previewExpanded)
      this.previewPrompt = this.previewExpanded ? "点击折叠 Diff" : "点击展开全部 Diff";
  }
  setApproval(approval?: PendingApproval, preview?: ApprovalPreview) {
    const changed = this.approval?.id !== approval?.id || this.preview !== preview;
    if (this.approval?.id !== approval?.id) this.previewExpanded = false;
    this.approval = approval;
    this.preview = preview;
    if (changed) this.rebuildPreview();
  }
  toggleApprovalDiff() {
    if (this.expanded && this.preview?.status === "ready") {
      this.previewExpanded = !this.previewExpanded;
      this.rebuildPreview();
    }
  }

  private expanded = false;
  private resultsExpanded = false;
  private toolTitle = "";
  private command = "";
  private commandSource?: string;
  private commandPreview = "";
  private readCode?: string[];
  private image?: Image;
  private tree: VStack;
  private diff: HistoricalDiff;
  private diffItem?: ConversationItem;
  constructor(
    item: ConversationItem,
    private store: TuiStore,
    _theme: MarkdownTheme,
  ) {
    this.item = item;
    this.diff = new HistoricalDiff(store);
    this.tree = new VStack([
      new MouseRegion(
        {
          render: (width) => (this.item.role === "tool" ? this.toolHeaderRows(width) : []),
          invalidate: () => undefined,
        },
        (event) => {
          if (event.type !== "click" || !this.hits(this.toolHeaderRows(event.width)[event.y], event.x))
            return undefined;
          store.toggle(this.item.id);
          return { handled: true };
        },
      ),
      new MouseRegion(
        {
          render: (width) => (this.item.role === "tool" ? this.toolRows(width) : []),
          invalidate: () => undefined,
        },
        (event) => {
          if (
            event.type !== "click" ||
            (this.item.call && this.item.call.parse.status !== "parsed") ||
            !this.hits(this.toolRows(event.width)[event.y], event.x)
          )
            return undefined;
          store.toggleResult(this.item.id);
          return { handled: true };
        },
      ),
      new MouseRegion({ render: (width) => this.approvalRows(width), invalidate: () => {} }, (event) => {
        if (
          event.type !== "click" ||
          event.y !== this.previewHeight - 1 ||
          !this.previewPrompt ||
          event.x >= visibleWidth(this.previewPrompt)
        )
          return undefined;
        this.toggleApprovalDiff();
        return { handled: true };
      }),
      {
        render: (width) =>
          this.item.role === "diff" || (this.expanded && this.diffItem) ? this.diff.render(width) : [],
        invalidate: () => undefined,
        handleMouse: (event) => this.diff.handleMouse(event),
      },
    ]);
    this.update(item);
  }
  setDiff(item?: ConversationItem) {
    this.diffItem = item;
    if (item) this.diff.update(item);
  }
  update(item: ConversationItem) {
    const old = this.item;
    this.item = item;
    const state = this.store.getSnapshot();
    this.expanded = state.expanded.has(item.id);
    this.resultsExpanded = state.expandedResults?.has(item.id) ?? false;
    const args = item.call?.parse.status === "parsed" ? item.call.parse.arguments : undefined;
    // 缺结果 call 与模型所见同构：按 unknown 展示（合成占位，非真实记录）。
    const status = item.syntheticUnknown ? "unknown" : (item.result?.status ?? item.activity ?? "queued");
    const labels: Record<string, string> = {
      success: "Success",
      error: "Failed",
      denied: "Denied",
      timeout: "Timeout",
      not_executed: "Not executed",
      unknown: "Unknown",
      running: "Running ⠋",
      queued: "Queued",
    };
    this.toolTitle = sanitizeDisplayText(
      `${item.call?.name ?? ""}${args ? " " + toolSummary(item.call!.name, args) : ""} · ${labels[status] ?? "Unknown"}`,
    );
    if (
      item.call?.name === "bash" &&
      this.commandSource !== sanitizeDisplayText(String(args?.command ?? ""))
    ) {
      const command = sanitizeDisplayText(String(args?.command ?? ""));
      this.commandSource = command;
      this.command = highlightCode(command, "bash").join("\n");
      this.commandPreview = highlightCode(command.replaceAll("\n", " "), "bash").join("");
    }
    if (old.result !== item.result || old.call !== item.call || this.readCode === undefined)
      this.readCode = highlightedReadContent(item);
    if (old.result !== item.result) this.image = undefined;
    if (item.role === "diff") this.diff.update(item);
    else if (this.diffItem) this.diff.update(this.diffItem);
  }
  render(width: number) {
    const rows = this.tree.render(width);
    // 被排除的卡片整体淡化：保留审计可见性，明示不再是上下文原文。
    if (this.item.failed)
      return rows.map((row) => theme.muted(stripVTControlCharacters(row)));
    return rows;
  }
  handleMouse(event: TuiMouseEvent) {
    return this.tree.handleMouse(event);
  }
  invalidate() {
    this.tree.invalidate();
    this.image?.invalidate();
  }
  private hits(row: string | undefined, x: number) {
    return row !== undefined && x >= 0 && x < visibleWidth(stripVTControlCharacters(row).trimEnd());
  }
  private bodyWidth(width: number) {
    return Math.max(1, width);
  }
  private rail(text: string, _width: number) {
    return text;
  }
  private statusColor(text: string) {
    const status = this.item.result?.status ?? this.item.activity ?? "queued";
    return (
      status === "success"
        ? theme.success
        : status === "error"
          ? theme.error
          : status === "running"
            ? theme.cyan
            : ["denied", "timeout", "unknown"].includes(status)
              ? theme.warning
              : theme.muted
    )(text);
  }
  private approvalRows(width: number): string[] {
    if (!this.approval || !this.expanded) return [];
    const lines = approvalSummaryLines(this.approval, undefined, this.approval.toolName !== "bash");
    if (["write", "edit"].includes(this.approval.toolName)) {
      if (this.preview?.status === "ready") {
        lines.push(...this.previewRows);
        if (this.previewPrompt) lines.push(theme.dim(this.previewPrompt));
      } else lines.push(this.preview?.status === "unavailable" ? "预览不可用" : "预览加载中");
    }
    const rows = lines.flatMap((line) => wrapDisplay(line, width));
    this.previewHeight = rows.length;
    return rows;
  }
  private toolHeaderRows(width: number): string[] {
    const displayTitle = this.approval
      ? this.toolTitle.replace(/ · [^·]*$/, " · Waiting for permission") +
        (this.approval.summary?.touchesOutsideWorkspace ? " · 工作区外路径" : "")
      : this.toolTitle;
    const split = displayTitle.lastIndexOf("\u00b7 ");
    const rawTitle =
      split >= 0
        ? displayTitle.slice(0, split + 2) +
          (this.approval ? theme.warning : this.statusColor.bind(this))(displayTitle.slice(split + 2))
        : displayTitle;
    const title = wrapDisplay(
      rawTitle
        .replace(/^> /, "\x1b[90m>\x1b[39m ")
        .replace(this.item.call?.name ?? "", (name) => `\x1b[1m${name}\x1b[22m`),
      width,
    );
    const args = this.item.call?.parse.status === "parsed" ? this.item.call.parse.arguments : undefined;
    if (this.item.call?.name !== "bash" || !args) return title;
    const command = this.command;
    return [
      ...title,
      ...(this.expanded
        ? command.split("\n").flatMap((line) => wrapDisplay(line, this.bodyWidth(width)))
        : [truncateToWidth(this.commandPreview, this.bodyWidth(width))]
      ).map((row) => row),
      ...this.liveOutputRows(width),
    ];
  }
  private liveOutputRows(width: number): string[] {
    const live = this.item.liveOutput;
    if (this.item.call?.name !== "bash" || this.item.activity !== "running" || this.item.result || !live)
      return [];
    const cleaned = sanitizeDisplayText(live).replace(/\n+$/, "");
    if (cleaned.length === 0) return [];
    return cleaned
      .split("\n")
      .slice(-LIVE_OUTPUT_TAIL_LINES)
      .map((line) => theme.dim(truncateToWidth(line, this.bodyWidth(width))));
  }
  private toolRows(width: number): string[] {
    const title: string[] = [];
    if (this.item.call && this.item.call.parse.status !== "parsed")
      return wrapDisplay("参数解析失败", this.bodyWidth(width)).map((row) => this.rail(row, width));
    if (this.item.syntheticUnknown) {
      if (!this.expanded) return title;
      return [
        ...title,
        "",
        ...wrapDisplay(MISSING_TOOL_RESULT_TEXT, this.bodyWidth(width)).map((row) =>
          this.rail(theme.warning(row), width),
        ),
        this.rail(theme.muted("结果缺失（进程中断），上下文按未知处理"), width),
      ];
    }
    if (!this.expanded || !this.item.result) return title;
    if (["write", "edit"].includes(this.item.call?.name ?? "") && this.item.result.status === "success")
      return title;
    const content = this.item.result.content;
    const available = this.bodyWidth(width);
    const rows = resultRenderer(this.item.call?.name ?? "")(content, available, this.readCode);
    const limit = this.store.settings.toolResultPreviewLines;
    const output = [
      ...title,
      ...(this.item.call?.name === "bash" ? [""] : []),
      ...(this.resultsExpanded ? rows : rows.slice(0, limit)).map((row) =>
        this.rail(this.item.call?.name === "bash" ? theme.dim(row.text) : row.text, width),
      ),
      ...(!this.resultsExpanded && rows.length > limit
        ? [this.rail(truncateToWidth("点击结果展开全部", this.bodyWidth(width)), width)]
        : []),
    ];
    const img = this.item.result.images?.[0];
    // failed 卡片不渲染 image：render() 的 dim 会 stripVT 撕掉 kitty 序列。
    if (
      this.item.call?.name === "view_image" &&
      this.item.result.status === "success" &&
      img &&
      !this.item.failed
    ) {
      const args = this.item.call.parse.status === "parsed" ? this.item.call.parse.arguments : undefined;
      this.image ??= new Image(
        img.data,
        img.mimeType,
        { fallbackColor: theme.muted },
        // 不传 maxWidthCells：render(width) 自适应；记录宽高免 TUI 重解析。
        { maxHeightCells: 14, filename: String(args?.path ?? "") },
        { widthPx: img.width, heightPx: img.height },
      );
      // 原子追加原始行：不 rail/不 wrap/不 sanitize/不切片，展开即显示。
      output.push(...this.image.render(available));
    }
    return output;
  }
}
