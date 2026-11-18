import { describe, expect, it } from "vitest";
import { resultRenderer, toolSummary } from "../../../src/tui/components/ToolRenderers.js";

describe("view_image 渲染器", () => {
  it("summary 只展示 path 字段", () => {
    expect(toolSummary("view_image", { path: "shots/a.png" })).toBe("path=shots/a.png");
    expect(toolSummary("view_image", {})).toBe("path=.");
  });

  it("结果文本走 plainResult：逐行输出、不折叠", () => {
    const lines = resultRenderer("view_image")("(Image attached: image/png, 4x3, 33 bytes.)", 80);
    expect(lines.map((line) => ({ ...line, text: line.text.trimEnd() }))).toEqual([
      { text: "(Image attached: image/png, 4x3, 33 bytes.)", soft: false },
    ]);
  });
});