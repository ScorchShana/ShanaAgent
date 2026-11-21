import { homedir } from "node:os";
import { loadApprovalPreview, type ApprovalPreview } from "./approval-preview.js";
import {
  Editor,
  Text,
  truncateToWidth,
  VStack,
  ScrollView,
  isKeyRelease,
  matchesKey,
  type Component,
  type TuiAltScreen,
} from "./framework/index.js";
import { ApprovalPanel } from "./components/ApprovalDialog.js";
import { MessageView } from "./components/Conversation.js";
import { StatusBar, FOOTER_ROWS } from "./components/StatusBar.js";
import { REASONING_EFFORTS } from "../llm/model-config-store.js";
import { TuiStore, approvalChoices, formatDuration, sanitizeDisplayText } from "./store.js";
import { theme, markdownTheme, selectTheme, editorTheme, MESSAGE_GAP } from "./theme.js";
import { BottomSelector } from "./components/BottomSelector.js";
const EDITOR_MIN_SIZE = 3;

class SingleLineText extends Text {
  private label = "";
  override setText(text: string): void {
    this.label = text;
  }
  override render(width: number): string[] {
    return [truncateToWidth(this.label, width)];
  }
}

export class TuiApp {
  readonly editor: Editor;
  readonly conversation = new VStack();
  readonly scroll = new ScrollView(this.conversation, { follow: "end", primary: true, scrollbar: "auto" });
  readonly header = new SingleLineText();
  readonly sessionInfo: Component = {
    render: (width) => {
      const session = this.store.getSnapshot().core.session;
      if (!session.ref) return [];
      const title = this.store.redact(sanitizeDisplayText(session.title ?? ""));
      return [
        truncateToWidth(`${title} · ${session.ref.sessionId.slice(0, 8)}`, width),
        "─".repeat(Math.max(0, width)),
      ];
    },
    invalidate: () => undefined,
  };
  readonly notice = new Text("", 0, 0);
  readonly status: StatusBar;
  readonly root: VStack;
  private messages = new Map<string, MessageView>();
  private itemsRef: unknown;
  private expandedRef: unknown;
  private resultsRef: unknown;
  private diffsRef: unknown;
  private order = "";
  private modalKey = "uninitialized";
  private menuRef: unknown;
  private modelOptionsRef: unknown;
  private selector?: BottomSelector;
  private unsubscribe: () => void;
  private removeInput: () => void;
  private timer: NodeJS.Timeout;
  private disposed = false;
  private previewId?: string;
  private approvalPreview?: ApprovalPreview;
  private revealedId?: string;
  private pendingView?: MessageView;
  private pendingItemId?: string;
  private autoExpandApprovalId?: string;
  private postApproval?: { approvalId: string; itemId?: string };
  private runId: string | undefined;
  constructor(
    readonly store: TuiStore,
    readonly tui: TuiAltScreen,
  ) {
    this.status = new StatusBar(store.getSnapshot(), { workspacePath: store.workspace, homeDirectory: homedir(), redact: (text) => store.redact(text) });
    this.editor = new Editor(tui, editorTheme, {
      clearOnSubmit: false,
      minVisibleLines: store.settings.promptVisibleRows,
      maxVisibleLines: store.settings.promptMaxRows,
    });
    this.root = new VStack();
    const handleEditorMouse = this.editor.handleMouse.bind(this.editor);
    this.editor.handleMouse = (event) => {
      if (store.getSnapshot().modal) return { handled: true };
      return handleEditorMouse(event);
    };
    this.editor.setAutocompleteProvider({
      getSuggestions: async (lines, line, column) => {
        const draft = lines[line]?.slice(0, column) ?? "";
        if (!/^\/\S*$/.test(draft)) return null;
        const options = store.commandOptions();
        return options.length
          ? {
              prefix: draft,
              items: options.map((option) => ({
                value: option.name,
                label: option.name,
                description: option.description + (option.enabled ? "" : " (disabled)"),
              })),
            }
          : null;
      },
      applyCompletion: (lines, line, column, item, prefix) => {
        const result = [...lines];
        result[line] =
          (result[line] ?? "").slice(0, column - prefix.length) +
          item.value +
          (result[line] ?? "").slice(column);
        return { lines: result, cursorLine: line, cursorCol: column - prefix.length + item.value.length };
      },
    });
    this.editor.onChange = (text) => {
      if (store.getSnapshot().draft !== text) store.setDraft(text);
    };
    this.editor.onSubmit = (text) => {
      if (store.getSnapshot().draft !== text) store.setDraft(text);
      void store.submit();
      this.update();
    };
    this.removeInput = tui.addInputListener((data) => {
      if (isKeyRelease(data)) return undefined;
      if (matchesKey(data, "ctrl+c")) {
        store.interrupt();
        this.update();
        return { consume: true };
      }
      const mouse = new RegExp(`${String.fromCharCode(27)}\\[<(\\d+);`).exec(data);
      if (!mouse || (Number(mouse[1]) & 32) === 0) store.clearInterrupt();
      if (!store.getSnapshot().modal && !this.editor.capturesViewportInput && matchesKey(data, "escape")) {
        if (store.getSnapshot().core.status.kind !== "idle") store.cancel();
        return { consume: true };
      }
      return undefined;
    });
    this.unsubscribe = store.subscribe((immediate) => this.update(immediate));
    this.timer = setInterval(() => {
      this.updateHeader();
      tui.requestRender();
    }, store.settings.runTimerRefreshMs);
    try {
      this.update();
      tui.setLayoutRoot(this.root);
      tui.setFocus(this.editor);
    } catch (error) {
      try {
        this.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Application initialization failed");
      }
      throw error;
    }
  }
  private updateHeader() {
    const state = this.store.getSnapshot();
    const model = state.core.session.runModel ?? state.core.session.model;
    const timing = this.store.getRunTiming();
    this.header.setText(
      `${theme.brand("Shana")} · ${model ? `${theme.muted(model.providerName + "/")}${theme.cyan(model.modelName)}${theme.muted(` · ${model.thinking ? model.reasoningEffort : "thinking off"}`)}` : theme.warning("无有效模型")} · ${state.closing ? "Finalizing exit" : state.core.status.kind === "idle" ? "Slacking off" : state.core.status.kind === "compacting" ? "Compacting" : `Working hard for ${formatDuration(timing?.elapsedMs ?? 0)}${state.core.status.phase === "streaming" ? "" : ` · ${state.core.status.phase}`}`}`,
    );
  }
  update(immediate = true) {
    if (this.disposed) return;
    const state = this.store.getSnapshot();
    const runId = state.core.status.kind === "running" ? state.core.status.runId : state.core.lastRun?.runId;
    if (runId && runId !== this.runId) this.scroll.scrollToEnd();
    this.runId = runId;
    this.updateHeader();
    if (this.editor.getText() !== state.draft) this.editor.setText(state.draft);
    const notice = state.notice?.text ?? (state.closing ? "正在退出，等待受管理清理…" : !state.core.session.model
      ? "请手动编辑 model.json 配置模型" : state.retryPrompt
      ? "失败重试：输入区空白时按 Enter 恢复建议，再次 Enter 发送" : "");
    this.notice.setText(notice ? (state.notice?.error ? theme.error : theme.warning)(notice) : "");
    const pending = state.core.pendingApproval;
    if (this.previewId !== pending?.id) {
      if (this.previewId !== undefined) {
        // 审批结束：折叠自动展开的卡片，随后按决议追踪下一个工具或追底。
        this.postApproval = { approvalId: this.previewId, itemId: this.pendingItemId };
        this.store.releaseAutoExpanded();
      }
      this.autoExpandApprovalId = undefined;
      this.pendingItemId = undefined;
      this.scroll.cancelReveal();
      this.revealedId = undefined;
      this.approvalPreview = undefined;
      this.previewId = pending?.id;
      if (pending && ["write", "edit"].includes(pending.toolName)) {
        this.approvalPreview = { status: "loading" };
        void loadApprovalPreview(pending, this.store.settings).then((preview) => {
          if (this.disposed || this.store.getSnapshot().core.pendingApproval?.id !== pending.id) return;
          this.approvalPreview = preview;
          this.update();
        });
      }
    }
    const items = this.store.items();
    if (
      items !== this.itemsRef ||
      state.expanded !== this.expandedRef ||
      state.expandedResults !== this.resultsRef ||
      state.expandedDiffs !== this.diffsRef
    ) {
      this.itemsRef = items;
      this.expandedRef = state.expanded;
      this.resultsRef = state.expandedResults;
      this.diffsRef = state.expandedDiffs;
      const ids = items.map((item) => item.id).join("\0");
      const components: Component[] = [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!;
        if (item.role === "diff") continue;
        let view = this.messages.get(item.id);
        if (!view) {
          view = new MessageView(item, this.store, markdownTheme);
          this.messages.set(item.id, view);
        } else view.update(item);
        const next = items[index + 1];
        view.setDiff(
          next?.role === "diff" &&
            next.call === item.call &&
            next.result === item.result &&
            next.runId === item.runId &&
            next.turn === item.turn
            ? next
            : undefined,
        );
        if (components.length)
          components.push({ render: () => Array<string>(MESSAGE_GAP).fill(""), invalidate: () => undefined });
        components.push(view);
      }
      if (ids !== this.order) {
        this.conversation.clear();
        for (const component of components) this.conversation.addChild(component);
        this.order = ids;
        const active = new Set(items.map((item) => item.id));
        for (const id of this.messages.keys()) if (!active.has(id)) this.messages.delete(id);
      }
    }
    this.pendingView = undefined;
    for (const item of items) {
      const view = this.messages.get(item.id);
      const approval = pending && item.pendingApprovalId === pending.id ? pending : undefined;
      view?.setApproval(approval, approval ? this.approvalPreview : undefined);
      if (approval && view) {
        this.pendingView = view;
        this.pendingItemId = item.id;
        // 每个审批只自动展开一次；用户手动折叠后不在后续 update 里强行再展开。
        if (this.autoExpandApprovalId !== approval.id) {
          this.autoExpandApprovalId = approval.id;
          this.store.autoExpand(item.id);
        }
      }
    }
    if (this.postApproval) {
      const { approvalId, itemId } = this.postApproval;
      this.postApproval = undefined;
      const resolved = state.lastResolvedApproval;
      const index = itemId === undefined ? -1 : items.findIndex((item) => item.id === itemId);
      // deny/cancel 后剩余工具是 not_executed，追踪无意义；只有放行才定位下一个工具。
      const next =
        resolved?.id === approvalId &&
        (resolved.decision === "once" || resolved.decision === "session") &&
        index >= 0
          ? items
              .slice(index + 1)
              .find((item) => item.role === "tool" && item.runId === items[index]!.runId)
          : undefined;
      const view = next ? this.messages.get(next.id) : undefined;
      if (view) this.scroll.reveal(view);
      else {
        this.scroll.cancelReveal();
        this.scroll.scrollToEnd();
      }
    }
    if (pending && this.pendingView && this.revealedId !== pending.id) {
      this.scroll.reveal(this.pendingView);
      this.revealedId = pending.id;
    }
    this.status.update(state);
    this.updateModal();
    if (immediate) this.tui.requestImmediateRender();
    else this.tui.requestRender();
  }
  private isCompactApproval(height = this.tui.terminal.rows): boolean {
    const { core, modal } = this.store.getSnapshot();
    if (modal?.kind !== "approval") return false;
    const headerRows = 1 + (core.session.ref ? 2 : 0);
    const editorRows = this.store.settings.promptVisibleRows + 2;
    const statusRows = FOOTER_ROWS;
    const chatRows = 1;
    const actionRows = approvalChoices(core.pendingApproval).length;
    const hintRows = 1;
    return height < headerRows + editorRows + statusRows + chatRows + actionRows + hintRows;
  }
  private updateModal() {
    const state = this.store.getSnapshot(),
      modal = state.modal;
    this.tui.setSearchEnabled(!modal);
    const key = modal
      ? `${modal.kind}:${modal.kind === "approval" ? state.core.pendingApproval?.id : modal.kind === "models" ? modal.effortOnly : modal.kind === "confirm" ? modal.purpose : ""}`
      : "";
    const modelOptions = modal?.kind === "models" ? state.core.session.models : undefined;
    if (
      key === this.modalKey &&
      (modal?.kind === "approval" ||
        (!modal && modal === this.menuRef && modelOptions === this.modelOptionsRef))
    )
      return;
    this.menuRef = modal;
    this.modelOptionsRef = modelOptions;
    this.editor.setVisibleLineLimits(
      this.store.settings.promptVisibleRows,
      modal ? this.store.settings.promptVisibleRows : this.store.settings.promptMaxRows,
    );
    if (key !== this.modalKey) this.selector = undefined;
    this.modalKey = key;
    this.root.clear();
    const visible = ({ height }: { height: number }) => height > 1;
    const regular = ({ height }: { height: number }) => height > 1 && !this.isCompactApproval(height);
    this.root.addChild(this.header, { visible: regular, shrink: 0 });
    this.root.addChild(this.sessionInfo, { visible: regular, shrink: 0 });
    this.root.addChild(this.scroll, { visible, basis: 0, grow: 1, shrink: 1, minSize: 1 });
    if (!modal || modal.kind !== "approval") {
      const dock = new VStack();
      dock.addChild(this.notice);
      if (!modal) dock.addChild(this.editor, { shrink: 1, minSize: EDITOR_MIN_SIZE });
      else {
        this.selector ??= new BottomSelector(
          (index) => {
            const current = this.store.getSnapshot().modal;
            if (current) this.store.moveModal(index - current.selection);
            this.update();
          },
          () => {
            void this.store.confirmModal();
            this.update();
          },
          () => {
            this.store.dismissModal();
            this.update();
          },
        );
        dock.addChild(this.selector);
      }
      dock.addChild(this.status, { shrink: 0 });
      this.root.addChild(dock, { visible: regular, basis: "auto", shrink: 1 });
    } else {
      this.root.addChild(this.notice, { visible: regular });
      this.root.addChild(this.editor, { visible: regular, shrink: 0 });
      this.root.addChild(this.status, { visible: regular, shrink: 0 });
    }
    if (!modal) {
      this.tui.setFocus(this.editor);
      return;
    }
    if (modal.kind === "approval" && state.core.pendingApproval) {
      const panel = new ApprovalPanel(
        state.core.pendingApproval,
        this.store,
        selectTheme,
        () => this.update(),
        () => this.isCompactApproval(),
        (key) => {
          if (key === "reveal" && this.pendingView) this.scroll.reveal(this.pendingView);
          else if (key === "diff") this.pendingView?.toggleApprovalDiff();
          else if (key === "up" || key === "down")
            this.scroll.scrollBy((key === "up" ? -1 : 1) * Math.max(1, this.scroll.viewportHeight));
          this.tui.requestRender();
        },
        () => (this.pendingView ? "查看待批工具 · Ctrl+L" : "待批工具加载中"),
      );
      this.root.removeChild(this.status);
      this.root.addChild(panel, {
        visible,
        basis: "auto",
        grow: 0,
        shrink: 1,
        minSize: 0,
      });
      this.root.addChild(this.status, { visible: regular, shrink: 0 });
      this.tui.setFocus(panel);
      return;
    }
    const labels =
      modal.kind === "approval"
        ? ["仅本次允许", "本会话允许", "拒绝"]
        : modal.kind === "models"
          ? modal.effortOnly
            ? [...REASONING_EFFORTS]
            : [
                ...state.core.session.models.map((model) => `${model.providerName}/${model.modelName}`),
                "调整思考强度",
              ]
          : modal.kind === "sessions"
            ? modal.sessions.map((session) => `${session.title} · ${session.sessionId.slice(0, 8)}`)
            : ["确认", "取消"];
    const safe = (text: string) => this.store.redact(sanitizeDisplayText(text)).replaceAll("\n", " ");
    const selected = modal.kind === "sessions" ? modal.sessions[modal.selection] : undefined;
    const details =
      modal.kind === "sessions"
        ? [
            "选择后继续原会话，后续消息追加到原历史",
            ...(selected
              ? [
                  `${selected.sessionId.slice(0, 8)} · ${selected.lastActiveAt}`,
                  `${selected.runCount} 次 Run · ${selected.occupied ? "已占用" : "空闲"}`,
                  selected.preview,
                ]
              : []),
          ]
        : [];
    const title =
      modal.kind === "sessions"
        ? "恢复会话"
        : modal.kind === "models"
          ? modal.effortOnly
            ? "思考强度"
            : "选择模型"
          : `继续前须确认未知副作用${modal.kind === "confirm" && modal.shellMayBeRunning ? "；Shell 可能仍在运行" : ""}`;
    this.selector!.update(safe(title), labels.map(safe), modal.selection, details.map(safe));
    this.tui.setFocus(this.selector!);
  }

  dispose() {
    this.disposed = true;
    this.scroll.cancelReveal();
    clearInterval(this.timer);
    this.unsubscribe();
    this.removeInput();
  }
}
