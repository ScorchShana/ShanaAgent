import { describe, expect, it } from "vitest";
import { diffViewRows, buildDiff, reconstructEdit } from "../../../src/tui/components/DiffView.js";

describe("DiffView", () => {
  it("renders separate old/new line numbers and the changed content", () => {
    const rows = buildDiff("same\nold\ntail\n", "same\nnew\ntail\n");
    expect(rows).toEqual([
      { kind: "remove", oldLine: 2, text: "old" },
      { kind: "add", newLine: 2, text: "new" },
    ]);
    const view = diffViewRows("old\n", "new\n", 200, 10000, false);
    expect(view.rows.map((row) => row.text).join("\n")).toContain("- old");
    expect(view.rows.map((row) => row.text).join("\n")).toContain("+ new");
  });
  it("reconstructs edit using normalization and non-overlapping replacement", () => {
    expect(
      reconstructEdit("\ufeffa\r\na\r\n", { old_string: "a\n", new_string: "b\r\n", replace_all: true }),
    ).toBe("b\nb\n");
    expect(reconstructEdit("aaa", { old_string: "aa", new_string: "b", replace_all: true })).toBe("ba");
  });
  it("folds by logical lines and counts wrapping separately", () => {
    const view = diffViewRows("", "one\ntwo\nthree\n", 1, 10000, false, 8);
    expect(view.folded).toBe(true);
    expect(view.rows.map((row) => row.text).join("\n")).not.toContain("three");
  });
  it("rejects oversized edit previews before constructing repeated replacements", () => {
    expect(() =>
      reconstructEdit("aaaa", { old_string: "a", new_string: "12345", replace_all: true }, 10),
    ).toThrow("超限");
    expect(reconstructEdit("a\ufeffaX", { old_string: "a", new_string: "", replace_all: true }, 1)).toBe("X");
  });
});

it("wraps at framework word boundaries and preserves code indentation", async () => {
  const { wrapDisplay } = await import("../../../src/tui/components/DiffView.js");
  expect(wrapDisplay("hello world", 8)).toEqual(["hello", "world"]);
  expect(wrapDisplay("    code", 20)).toEqual(["    code"]);
  expect(wrapDisplay("abcdefghij", 5)).toEqual(["abcde", "fghij"]);
});

it("normalizes tabs and carriage returns in diff rows", async () => {
  const { diffDisplayRows } = await import("../../../src/tui/components/DiffView.js");
  const rows = diffDisplayRows("a\tb\r\nc", "a\tb\r\nc\td", 200, 10000, true).rows;
  expect(rows.some((row) => row.text.includes("c    d"))).toBe(true);
  expect(rows.map((row) => row.text).join("\n")).not.toMatch(/[\r\t]/);
});
