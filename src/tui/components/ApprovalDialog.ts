import {
  Text,
  VStack,
  SelectList,
  MouseRegion,
  matchesKey,
  type SelectListTheme,
} from "../framework/index.js";
import type { PendingApproval } from "../../core/state.js";
import { approvalChoices, sanitizeDisplayText, type TuiStore } from "../store.js";
import { wrapDisplay } from "./DiffView.js";
export function approvalSummaryLines(approval: PendingApproval, width?: number, includeCommand = true): string[] {
  return [
    approval.summary?.operation,
    ...(approval.summary?.paths ?? []),
    includeCommand ? approval.summary?.command : undefined,
    approval.summary?.touchesOutsideWorkspace ? "工作区外路径" : undefined,
    ["write", "edit"].includes(approval.toolName) ? "预览非写入时刻快照" : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .flatMap((line) =>
      sanitizeDisplayText(line)
        .split("\n")
        .flatMap((part) => wrapDisplay(part, width)),
    );
}
export class ApprovalPanel extends VStack {
  readonly capturesViewportInput = true;
  private actions: SelectList;
  constructor(
    approval: PendingApproval,
    store: TuiStore,
    theme: SelectListTheme,
    changed: () => void,
    private compact: () => boolean = () => false,
    private navigate: (key: string) => void = () => {},
    private hint: () => string = () => "查看待批工具 · Ctrl+L",
  ) {
    super();
    const items = approvalChoices(approval).map(({ label }, index) => ({ label, value: String(index) }));
    this.actions = new SelectList(items, items.length, theme);
    const small = new SelectList(items, 1, theme);
    this.actions.onSelectionChange = (item) => {
      small.setSelectedIndex(Number(item.value));
      changed();
    };
    this.actions.onSelect = small.onSelect = (item) => {
      const modal = store.getSnapshot().modal;
      if (modal?.kind !== "approval") return;
      store.moveModal(Number(item.value) - modal.selection);
      void store.confirmModal();
      changed();
    };
    this.actions.onCancel = small.onCancel = () => {
      store.dismissModal();
      changed();
    };
    this.addChild(
      new MouseRegion(
        { render: (width) => new Text(this.hint(), 0, 0).render(width), invalidate: () => {} },
        (event) => {
          if (event.type !== "click") return undefined;
          this.navigate("reveal");
          return { handled: true };
        },
      ),
      { visible: () => !this.compact() },
    );
    this.addChild(this.actions, { visible: () => !this.compact(), shrink: 0, minSize: items.length });
    this.addChild(small, { visible: () => this.compact(), basis: 1, shrink: 0, minSize: 1 });
  }
  handleInput(data: string) {
    if (matchesKey(data, "ctrl+l")) this.navigate("reveal");
    else if (matchesKey(data, "pageUp")) this.navigate("up");
    else if (matchesKey(data, "pageDown")) this.navigate("down");
    else if (data === " ") this.navigate("diff");
    else this.actions.handleInput(data);
  }
}
