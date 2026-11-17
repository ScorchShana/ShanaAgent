import { it, expect, vi } from "vitest";
import { highlightCode, languageForPath } from "../../src/tui/syntax-highlight.js";
import { stripVTControlCharacters } from "node:util";
it("preserves code across nested scopes, multiline comments and entities", () => {
  const code = '/* first\nsecond */\nconst x = "<>&";';
  const lines = highlightCode(code, "js");
  expect(stripVTControlCharacters(lines.join("\n"))).toBe(code);
  expect(lines.join("")).toContain("\x1b[");
});
it("keeps unknown and absent languages monochrome", () => {
  expect(highlightCode("const x = 1", "unknown")).toEqual(["const x = 1"]);
  expect(highlightCode("const x = 1")).toEqual(["const x = 1"]);
});

it("falls back to complete code when highlighting fails", async () => {
  const { default: hljs } = await import("highlight.js/lib/core");
  const spy = vi.spyOn(hljs, "highlight").mockImplementation(() => {
    throw new Error("failure");
  });
  try {
    expect(highlightCode("const x = 1;\n// end", "js")).toEqual(["const x = 1;", "// end"]);
  } finally {
    spy.mockRestore();
  }
});
it.each([
  "js",
  "ts",
  "json",
  "py",
  "sh",
  "powershell",
  "html",
  "css",
  "md",
  "yml",
  "sql",
  "c",
  "cpp",
  "java",
  "go",
  "rs",
])("accepts registered language alias %s", (language) => {
  const code = 'hello <world> & "value"';
  expect(stripVTControlCharacters(highlightCode(code, language).join("\n"))).toBe(code);
});

it("requires an explicit filename extension", () => {
  for (const path of ["go", "c", "sh", "dir.ts/file", "C:\\dir.ts\\go"])
    expect(languageForPath(path)).toBeUndefined();
  expect(languageForPath("dir/file.ts")).toBe("typescript");
});
