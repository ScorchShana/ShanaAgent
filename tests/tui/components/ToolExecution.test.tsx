import { stripVTControlCharacters } from "node:util";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { parseSettings } from "../../../src/llm/settings-store.js";
import { ToolExecution } from "../../../src/tui/components/ToolExecution.js";
import { Image, setCapabilities, setImageTranscoder } from "../../../src/tui/framework/index.js";
import { onTranscodeReady, transcodeToPng } from "../../../src/tui/image-transcoder.js";
import type { ConversationItem, TuiStore } from "../../../src/tui/store.js";
import { makePngImage } from "../../sessions/helpers.js";
import { defaultMarkdownTheme } from "../framework/test-themes.js";

// kitty 协议序列以 APC _G 开头；image 行含完整 base64 载荷。
const isKittyLine = (row: string): boolean => row.includes("\x1b_G");

function harness(
  item: ConversationItem,
  options: { expanded?: boolean; resultsExpanded?: boolean; previewLines?: number } = {},
) {
  const expanded = new Set(options.expanded === false ? [] : [item.id]);
  const expandedResults = new Set(options.resultsExpanded ? [item.id] : []);
  const store = {
    settings: parseSettings({ toolResultPreviewLines: options.previewLines ?? 5 }),
    getSnapshot: () => ({ expanded, expandedResults }),
    toggle: () => {},
    toggleResult: () => {},
  } as unknown as TuiStore;
  const view = new ToolExecution(item, store, defaultMarkdownTheme);
  return { view, expanded, expandedResults };
}

function imageItem(overrides: Partial<ConversationItem> = {}): ConversationItem {
  return {
    id: "tool-img",
    role: "tool",
    text: "",
    call: { name: "view_image", parse: { status: "parsed", arguments: { path: "a.png" } } },
    result: {
      status: "success",
      content: "(Image attached: image/png, 40x30, 33 bytes.)",
      images: [makePngImage(40, 30)],
    },
    ...overrides,
  } as ConversationItem;
}

const privateImage = (view: ToolExecution): Image | undefined =>
  (view as unknown as { image?: Image }).image;

afterEach(() => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
});

describe("ToolExecution view_image 内联图片", () => {
  it("kitty+PNG：原子追加 image 序列行，行数等于图像占位行数", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const item = imageItem();
    const h = harness(item);
    const rows = h.view.render(80);
    expect(rows.some(isKittyLine)).toBe(true);
    const img = item.result!.images![0]!;
    const reference = new Image(
      img.data,
      img.mimeType,
      { fallbackColor: (text) => text },
      { maxHeightCells: 14, filename: "a.png" },
      { widthPx: img.width, heightPx: img.height },
    );
    // 标题行 + 文本行（content 单行）+ 图像占位行数；image 行不被 rail/wrap 改写。
    expect(rows.length).toBe(2 + reference.render(80).length);
    expect(rows.some((row) => row.includes("(Image attached: image/png, 40x30, 33 bytes.)"))).toBe(true);
  });

  it("image 行不受 preview 切片截断，展开即显示", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const item = imageItem();
    item.result!.content = "line1\nline2\nline3";
    const h = harness(item, { previewLines: 1 });
    const rows = h.view.render(80);
    const plain = rows.map((row) => stripVTControlCharacters(row).trimEnd());
    expect(plain).toContain("line1");
    expect(plain).not.toContain("line2");
    expect(plain.some((row) => row.includes("点击结果展开全部"))).toBe(true);
    // 切片只作用于文本行：image 序列仍完整追加。
    expect(rows.some(isKittyLine)).toBe(true);
  });

  it("无协议终端：输出回退行，无 image 序列", () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const h = harness(imageItem());
    const rows = h.view.render(80).map((row) => stripVTControlCharacters(row));
    expect(rows.some(isKittyLine)).toBe(false);
    expect(rows.some((row) => row.includes("[Image: a.png [image/png] 40x30]"))).toBe(true);
  });

  it("failed 卡片不渲染 image 块，元信息文本照常", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const h = harness(imageItem({ failed: true }));
    const rows = h.view.render(80);
    expect(rows.some(isKittyLine)).toBe(false);
    expect(rows.map((row) => stripVTControlCharacters(row)).join("\n")).toContain("(Image attached:");
    expect(privateImage(h.view)).toBeUndefined();
  });

  it("压缩覆盖的卡片（不再淡化）正常渲染 image 块", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    // compacted 标记已删除：压前 view_image 卡即普通成功卡，image 序列完整保留。
    const h = harness(imageItem());
    const rows = h.view.render(80);
    expect(rows.some(isKittyLine)).toBe(true);
    expect(privateImage(h.view)).toBeDefined();
  });

  it("非 success 状态不渲染 image 块", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const item = imageItem();
    item.result!.status = "error";
    const h = harness(item);
    expect(h.view.render(80).some(isKittyLine)).toBe(false);
  });

  it("result 变更重建 Image 实例；宽度变化复用实例", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const item = imageItem();
    const h = harness(item);
    h.view.render(80);
    const first = privateImage(h.view)!;
    const firstId = first.getImageId();
    expect(firstId).toBeDefined();
    // 宽度变化：同一实例（内部按宽度缓存）。
    h.view.render(40);
    expect(privateImage(h.view)).toBe(first);
    // result 对象变更：清缓存重建，kitty id 重新分配。
    const next = imageItem();
    next.result = { ...item.result!, images: [makePngImage(80, 60)] };
    h.view.update(next);
    expect(privateImage(h.view)).toBeUndefined();
    h.view.render(80);
    const second = privateImage(h.view)!;
    expect(second).not.toBe(first);
    expect(second.getImageId()).not.toBe(firstId);
  });

  it("invalidate 透传清除 Image 行缓存", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const h = harness(imageItem());
    h.view.render(80);
    const image = privateImage(h.view)!;
    h.view.invalidate();
    expect((image as unknown as { cachedLines?: string[] }).cachedLines).toBeUndefined();
  });

  it("折叠卡片不渲染结果与 image", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const h = harness(imageItem(), { expanded: false });
    const rows = h.view.render(80);
    expect(rows.some(isKittyLine)).toBe(false);
    expect(rows.join("\n")).not.toContain("(Image attached:");
  });
});

describe("ToolExecution view_image jpeg 异步转码", () => {
  it("kitty+jpeg：首帧文本回退，转码就绪 invalidate 重渲染出真图", async () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const jpegData = (
      await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 120, g: 60, b: 30 } } })
        .jpeg()
        .toBuffer()
    ).toString("base64");
    const item = imageItem({
      call: { name: "view_image", parse: { status: "parsed", arguments: { path: "photo.jpg" } } },
      result: {
        status: "success",
        content: "(Image attached: image/jpeg, 40x30, 999 bytes.)",
        images: [{ data: jpegData, mimeType: "image/jpeg", width: 40, height: 30 }],
      },
    });
    const h = harness(item);
    setImageTranscoder(transcodeToPng);
    // 模拟 main.ts 接线：就绪回调失效组件（真实接线为 tui.invalidate 全树）。
    let off!: () => void;
    const ready = new Promise<void>((resolve) => {
      off = onTranscodeReady(() => {
        off();
        h.view.invalidate();
        resolve();
      });
    });
    try {
      const first = h.view.render(80);
      expect(first.some(isKittyLine)).toBe(false);
      expect(first.map((row) => stripVTControlCharacters(row)).join("\n")).toContain(
        "[Image: photo.jpg [image/jpeg] 40x30]",
      );
      await ready;
      const second = h.view.render(80);
      const kittyRow = second.find(isKittyLine);
      expect(kittyRow).toBeDefined();
      expect(kittyRow).toContain("f=100");
      // 载荷是转码后的 PNG（base64 以 PNG 签名开头），不是原始 jpeg。
      expect(kittyRow).toContain("iVBORw0KGgo");
    } finally {
      off();
      setImageTranscoder(undefined);
    }
  });
});