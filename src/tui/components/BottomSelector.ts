import { VStack, Text, SelectList, truncateToWidth, type Component } from "../framework/index.js";
import { selectTheme, theme } from "../theme.js";

export const SELECTOR_VISIBLE_ITEMS = 5;
export class BottomSelector implements Component {
  readonly capturesViewportInput = true;
  private panel = new VStack();
  private list?: SelectList;
  private signature = "";
  constructor(private readonly onMove: (index: number) => void,
    private readonly onSelect: () => void, private readonly onCancel: () => void) {}
  update(title: string, labels: string[], selection: number, details: string[]): void {
    const signature = JSON.stringify([title, labels]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.list = new SelectList(labels.map((label, index) => ({ label, value: String(index) })), SELECTOR_VISIBLE_ITEMS, selectTheme);
      this.list.onSelectionChange = item => this.onMove(Number(item.value));
      this.list.onSelect = () => this.onSelect();
      this.list.onCancel = () => this.onCancel();
    }
    this.list!.setSelectedIndex(selection);
    this.panel.clear();
    this.panel.addChild({ render: width => [theme.muted("─".repeat(Math.max(0, width)))], invalidate() {} });
    this.panel.addChild(new Text(title, 0, 0));
    this.panel.addChild(labels.length ? this.list! : new Text("暂无可选项 · Esc 返回", 0, 0));
    for (const detail of details) this.panel.addChild({ render: width => [truncateToWidth(detail, width)], invalidate() {} });
  }
  render(width: number): string[] { return this.panel.render(width); }
  invalidate(): void { this.panel.invalidate(); }
  handleInput(data: string): void { this.list?.handleInput(data); }
  handleMouse: Component["handleMouse"] = event => this.panel.handleMouse(event);
}
