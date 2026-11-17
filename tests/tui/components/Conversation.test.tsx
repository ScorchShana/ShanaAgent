import { theme } from "../../../src/tui/theme.js";
import { expect, it, vi } from "vitest";
import { MessageView } from "../../../src/tui/components/Conversation.js";
import { Markdown } from "../../../src/tui/framework/index.js";
import { visibleWidth } from "../../../src/tui/framework/index.js";
import { parseSettings } from "../../../src/llm/settings-store.js";
import type { ConversationItem, TuiStore } from "../../../src/tui/store.js";
import { defaultMarkdownTheme } from "../framework/test-themes.js";
import {
  bashResultDisplay,
  compactionSeparatorLine,
  globResultDisplayLines,
  grepResultDisplayLines,
  readResultDisplayLines,
} from "../../../src/tui/components/Conversation.js";
const readOutput = (body: readonly string[], status = "(Showing lines 1-3; end of file.)"): string =>
  ["<path>src/a.ts</path>", "<content>", ...body, "</content>", status].join("\n");

const stripAnsi = (text: string): string =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

it("styles historical Diff line numbers separately from changed content", () => {
  const h = message({ id: "diff-a", role: "diff", text: "Diff", call: {
    name: "write", parse: { status: "parsed", arguments: { content: "new" } },
  }, result: { status: "success", priorContent: "old", content: "ok" } } as ConversationItem);
  const frame = h.view.render(80).join("\n");
  expect(frame).toContain(theme.muted("1"));
  expect(frame).toContain(theme.error("- old"));
  expect(frame).toContain(theme.success("+ new"));
  expect(h.frame()).toContain("1 - old");
});
function message(item: ConversationItem) {
  const expanded = new Set<string>();
  const settings = parseSettings({ thinkingPreviewLines: 2 });
  const store = {
    settings,
    getSnapshot: () => ({ expanded }),
    toggle: (id: string) => (expanded.has(id) ? expanded.delete(id) : expanded.add(id)),
  } as unknown as TuiStore;
  const view = new MessageView(item, store, defaultMarkdownTheme);
  return { view, expanded, frame: (width = 80) => stripAnsi(view.render(width).join("\n")) };
}

it("refreshes a completed tool result even when its text is unchanged", () => {
  const item = { id: "tool-a", role: "tool" as const, text: "", activity: "running" as const };
  const h = message(item);
  h.expanded.add(item.id);
  h.view.update({ ...item, result: { status: "success", content: "finished" } } as ConversationItem);
  expect(h.frame()).toContain("Success");
  expect(h.frame()).toContain("finished");
});

it("shows bash commands before results exist", () => {
  const h = message({ id: "tool-a", role: "tool", text: "", call: {
    name: "bash", parse: { status: "parsed", arguments: { command: "echo first\necho second" } },
  } } as ConversationItem);
  expect(h.frame()).toContain("echo first");
  h.expanded.add("tool-a");
  h.view.update({ id: "tool-a", role: "tool", text: "", call: {
    name: "bash", parse: { status: "parsed", arguments: { command: "echo first\necho second" } },
  } } as ConversationItem);
  expect(h.frame()).toContain("echo second");
});

it("routes tool header and result clicks to separate actions", () => {
  const toggle = vi.fn(), toggleResult = vi.fn();
  const store = { settings: parseSettings({ toolResultPreviewLines: 1 }),
    getSnapshot: () => ({ expanded: new Set(["tool-a"]), expandedResults: new Set() }),
    toggle, toggleResult } as unknown as TuiStore;
  const view = new MessageView({ id: "tool-a", role: "tool", text: "", result: {
    status: "success", content: "first\nsecond" } } as ConversationItem, store, defaultMarkdownTheme);
  view.render(80);
  const click = (y: number) => (view as unknown as { handleMouse: (e: unknown) => unknown }).handleMouse({ type: "click", x: 1, y, width: 80, height: 6, button: "left" });
  click(2);
  expect(toggleResult).toHaveBeenCalledWith("tool-a");
  expect(toggle).not.toHaveBeenCalled();
  click(1);
  expect(toggle).toHaveBeenCalledWith("tool-a");
});

it("keeps historical Diff computation out of layout and unrelated updates", () => {
  const item = { id: "diff-a", role: "diff", text: "Diff", call: {
    name: "write", parse: { status: "parsed", arguments: { content: "new\nline" } },
  }, result: { status: "success", priorContent: "old", content: "success" } } as ConversationItem;
  const h = message(item);
  const before = h.frame();
  expect(before).toContain("1 - old");
  expect(before).toContain("1 + new");
  h.view.update({ ...item });
  expect(h.frame()).toBe(before);
  expect(h.frame(12)).toContain("old");
  expect(h.frame()).toBe(before);
});

it.each(["read", "glob", "grep", "write", "edit", "bash"])("renders %s with authoritative result status", name => {
  for (const [status, label] of Object.entries({ success: "Success", error: "Failed", denied: "Denied", timeout: "Timeout", not_executed: "Not executed", unknown: "Unknown" })) {
    const item = { id: "tool-a", role: "tool", text: "", activity: "running", call: {
      name, parse: { status: "parsed", arguments: { path: "a", command: "echo test" } },
    }, result: { status, content: "Error: this text does not determine status" } } as ConversationItem;
    const h = message(item);
    expect(h.frame()).toContain(label);
    expect(h.frame()).not.toContain("Running");
    expect(h.frame()).not.toContain("Error:");
    h.expanded.add(item.id); h.view.update(item);
    if (status !== "success" || !["write", "edit"].includes(name)) expect(h.frame()).toContain("Error:");
  }
});

it("hides raw arguments and results when parameter parsing failed", () => {
  const h = message({ id: "tool-a", role: "tool", text: "", call: {
    name: "read", parse: { status: "invalid", raw: "secret" },
  }, result: { status: "error", content: "secret result" } } as unknown as ConversationItem);
  h.expanded.add("tool-a");
  expect(h.frame()).toContain("参数解析失败");
  expect(h.frame()).not.toContain("secret");
});

it("keeps bash title, command and output inside narrow windows", () => {
  const item = { id: "tool-a", role: "tool", text: "", call: {
    name: "bash", parse: { status: "parsed", arguments: { command: "echo hello world" } },
  }, result: { status: "success", content: "long output" } } as ConversationItem;
  const h = message(item); h.expanded.add(item.id); h.view.update(item);
  for (const width of [1, 4, 8, 12]) {
    expect(h.view.render(width).every(row => visibleWidth(row) <= width)).toBe(true);
  }
});

it("colors the tool status without coloring its parameters", () => {
  const h = message({ id: "tool-a", role: "tool", text: "", call: {
    name: "read", parse: { status: "parsed", arguments: { path: "a" } },
  }, result: { status: "success", content: "" } } as ConversationItem);
  const row = h.view.render(80)[1]!;
  expect(row).toContain(theme.success("Success"));
  expect(row.startsWith("\x1b[32m")).toBe(false);
});

it("keeps thinking before the answer and uses the streaming tail followed by the completed head", () => {
  const item: ConversationItem = {
    id: "a",
    role: "assistant",
    text: "",
    thinking: "first\nsecond\nlast",
    dim: true,
  };
  const h = message(item);
  expect(h.frame()).toContain("last");
  expect(h.frame()).not.toContain("first");
  h.view.update({ ...item, text: "answer", dim: false });
  expect(h.frame().indexOf("first")).toBeLessThan(h.frame().indexOf("answer"));
  expect(h.frame()).not.toContain("last");
  h.expanded.add("a");
  h.view.update({ ...item, text: "answer", dim: false });
  expect(h.frame()).toContain("last");
});

it("retains failed and cancelled markers for assistant and attempt bodies", () => {
  for (const role of ["assistant", "attempt"] as const) {
    const failed = message({ id: "a", role, text: "answer", failed: true }).frame();
    expect(failed).toContain("answer");
    expect(failed).toMatch(/failed|Failed/);
    expect(message({ id: "a", role, text: "answer", cancelled: true }).frame()).toMatch(
      /cancelled|Cancelled/,
    );
  }
});

it("sanitizes model escape sequences in both Markdown and literal messages", () => {
  for (const role of ["assistant", "user", "notice"] as const) {
    const h = message({ id: "a", role, text: "safe\x1b[2J\x07end" });
    expect(h.view.render(80).join("\n")).not.toContain("\x1b[2J");
    expect(h.frame()).toContain("safeend");
  }
});

it("renders compaction as the full-width separator", () => {
  expect(message({ id: "c", role: "compaction", text: "compacted" }).frame(40)).toBe(
    compactionSeparatorLine("compacted", 40),
  );
});

it("finishes streaming with an exact parse when text does not change", () => {
  const item: ConversationItem = {
    id: "a",
    role: "assistant",
    text: "[docs][r]\n\n[r]: https://example.com",
    dim: true,
  };
  const h = message(item);
  h.view.render(60);
  const completed = vi.spyOn(Markdown.prototype, "setStreaming");
  try {
    h.view.update({ ...item, dim: false });
    expect(completed).toHaveBeenCalledWith(false);
    expect(h.view.render(60)).toEqual(message({ ...item, dim: false }).view.render(60));
  } finally {
    completed.mockRestore();
  }
});

it("uses effective tool arguments and hides results until expanded", () => {
  const item: ConversationItem = {
    id: "t",
    role: "tool",
    text: "",
    call: {
      type: "toolCall",
      id: "call",
      name: "read",
      rawArguments: '{"path":"src/a.ts"}',
      parse: { status: "parsed", arguments: { path: "src/a.ts" } },
    },
    result: {
      type: "tool_result",
      recordSeq: 2,
      ts: "now",
      runId: "r",
      assistantRecordSeq: 1,
      toolCallId: "call",
      toolName: "read",
      status: "success",
      content: readOutput(["1: value"]),
    },
  };
  const h = message(item);
  expect(h.frame()).toContain("path=src/a.ts");
  expect(h.frame()).toContain("offset=1");
  expect(h.frame()).not.toContain(item.call!.rawArguments);
  expect(h.frame()).not.toContain("1: value");
  h.expanded.add("t");
  h.view.update(item);
  expect(h.frame()).toContain("1: value");
  expect(h.frame()).not.toContain("<content>");
});

it("reconstructs historical write Diff from priorContent without raw arguments", () => {
  const item: ConversationItem = {
    id: "d",
    role: "diff",
    text: "",
    call: {
      type: "toolCall",
      id: "call",
      name: "write",
      rawArguments: '{"content":"new"}',
      parse: { status: "parsed", arguments: { content: "new" } },
    },
    result: {
      type: "tool_result",
      recordSeq: 2,
      ts: "now",
      runId: "r",
      assistantRecordSeq: 1,
      toolCallId: "call",
      toolName: "write",
      status: "success",
      content: "written",
      priorContent: "old",
    },
  };
  const frame = message(item).frame();
  expect(frame).toContain("- old");
  expect(frame).toContain("+ new");
  expect(frame).not.toContain(item.call!.rawArguments);
  expect(message({ ...item, result: { ...item.result!, priorContent: undefined } }).frame()).toContain(
    "Diff unavailable",
  );
});
it("shows read content without the repeated path or wrapper tags", () => {
  const lines = readResultDisplayLines(readOutput(["1: first", "2:", "3: third"]), 60);
  expect(lines.map((line) => line.text)).toEqual([
    "1: first",
    "2: ",
    "3: third",
    "(Showing lines 1-3; end of file.)",
  ]);
  expect(lines.some((line) => /<\/?(?:path|content)>/.test(line.text))).toBe(false);
});

it("aligns wrapped read content after the colon and marks the indent as decorative", () => {
  const lines = readResultDisplayLines(readOutput(["12: " + "abcdefghij".repeat(3)]), 14);
  expect(lines.length).toBeGreaterThan(2);
  expect(lines[0]!.text.startsWith("12: ")).toBe(true);
  const continuations = lines.filter((line) => (line.indent ?? 0) > 0);
  expect(continuations.length).toBeGreaterThan(0);
  expect(continuations.every((line) => line.indent === 4 && line.text.startsWith("    "))).toBe(true);
});

it("keeps wrapper-like text that is part of the file content", () => {
  const lines = readResultDisplayLines(
    readOutput(["1: <content>", "2: </content>", "3: <path>x</path>"]),
    60,
  );
  const texts = lines.map((line) => line.text);
  expect(texts).toContain("1: <content>");
  expect(texts).toContain("2: </content>");
  expect(texts).toContain("3: <path>x</path>");
});

it("keeps status hints for empty results and leaves errors untouched", () => {
  expect(readResultDisplayLines(readOutput([], "(Empty file.)"), 60).map((line) => line.text)).toEqual([
    "(Empty file.)",
  ]);
  expect(readResultDisplayLines("Error: File not found.", 60).map((line) => line.text)).toEqual([
    "Error: File not found.",
  ]);
});

it("right-aligns read line numbers within one result block", () => {
  const lines = readResultDisplayLines(readOutput(["1: first", "12: second", "123: third"]), 60);
  expect(lines.map((line) => line.text)).toEqual([
    "  1: first",
    " 12: second",
    "123: third",
    "(Showing lines 1-3; end of file.)",
  ]);
  expect(lines.slice(0, 3).map((line) => line.indent ?? 0)).toEqual([2, 1, 0]);
});

it("leaves read status hints and truncation markers outside the aligned block", () => {
  const lines = readResultDisplayLines(
    readOutput(
      ["1: " + "a".repeat(2000) + "…[truncated]"],
      "(Showing lines 1-1; end of file. 1 line truncated.)",
    ),
    200,
  );
  expect(lines.some((line) => line.text.includes("…[truncated]"))).toBe(true);
  expect(lines.at(-1)!.text).toBe("(Showing lines 1-1; end of file. 1 line truncated.)");
  expect(lines.at(-1)!.indent ?? 0).toBe(0);
});

it("exposes pure formatters that keep decorative columns out of the text", () => {
  const grep = grepResultDisplayLines("src/a.ts:42: " + "x".repeat(40), 20);
  expect(grep[0]!.text.startsWith("src/a.ts:42: ")).toBe(true);
  expect(grep[0]!.indent ?? 0).toBe(0);
  expect(grep.slice(1).every((line) => line.indent === 13)).toBe(true);

  const glob = globResultDisplayLines("src/a.ts\n\n(Results truncated: char limit reached.)", 60);
  expect(glob.map((line) => line.text)).toEqual(["src/a.ts", "(Results truncated: char limit reached.)"]);

  const bash = bashResultDisplay("Exit code: 2\nStdout:\n(no output)\nStderr:\nfailed", 60);
  expect(bash.exitCode).toBe("2");
  expect(bash.lines.map((line) => line.text)).toEqual(["Output:", "Stderr:", "failed", "Exit code: 2"]);
});

it("builds a full-width centered compaction line, shrinking dashes before truncating the label", () => {
  const line = compactionSeparatorLine("compacted", 20);
  expect(line).toHaveLength(20);
  expect(line).toContain(" compacted ");
  const leading = line.length - line.replace(/^━+/u, "").length;
  const trailing = line.length - line.replace(/━+$/u, "").length;
  expect(Math.abs(leading - trailing)).toBeLessThanOrEqual(1);
  expect(leading + trailing).toBe(20 - "compacted".length - 2);
  expect(compactionSeparatorLine("compacted", 11)).toBe(" compacted ");
  expect(compactionSeparatorLine("compaction cancelled", 10)).toBe("compaction");
  expect(compactionSeparatorLine("compacted", 4)).toBe("comp");
  expect(compactionSeparatorLine("compacted")).toBe("━━━━ compacted ━━━━");
  for (const label of ["compacting", "compacted", "compaction cancelled", "compaction failed"])
    expect(compactionSeparatorLine(label, 80)).not.toContain("\n");
});

it("shows literal user text in a background block without a border", () => {
 const h = message({id:"u", role:"user", text:"**literal** 中文😀"});
 expect(h.frame()).toContain("**literal** 中文😀");
 expect(h.frame()).not.toContain("╭");
 expect(h.view.render(80).join("\n")).toContain("\x1b[48;");
});

it("keeps numbered read results within very narrow widths",()=>{
 const item={id:"t",role:"tool",text:"",call:{name:"read",parse:{status:"parsed",arguments:{path:"a.ts"}}},result:{status:"success",content:readOutput(["100: const x = 1;"])}} as ConversationItem;
 const h=message(item);h.expanded.add("t");h.view.update(item);
 for(const width of [1,2,8,10,20,80])expect(h.view.render(width).every(row=>visibleWidth(row)<=width)).toBe(true);
});

it("keeps tool padding inert and embeds Diff under the tool title",()=>{
 const toggle=vi.fn(),toggleResult=vi.fn(),toggleDiff=vi.fn();
 const store={settings:parseSettings({diffFoldLines:1}),getSnapshot:()=>({expanded:new Set(["t"]),expandedDiffs:new Set(),expandedResults:new Set()}),toggle,toggleResult,toggleDiff} as unknown as TuiStore;
 const item={id:"t",role:"tool",text:"",call:{name:"write",parse:{status:"parsed",arguments:{path:"a",content:"new\nline"}}},result:{status:"success",priorContent:"old",content:"written"}} as ConversationItem;
 const view=new MessageView(item,store,defaultMarkdownTheme);view.setDiff({...item,id:"d",role:"diff"});
 const rows=view.render(80);expect(stripAnsi(rows.join("\n"))).toContain("- old");expect(stripAnsi(rows.join("\n"))).not.toContain("written");
 const click=(x:number,y:number)=>view.handleMouse({type:"click",x,y,width:80,height:rows.length,button:"left"});
 click(0,1);click(1,0);click(1,rows.length-1);
 expect(toggle).not.toHaveBeenCalled();expect(toggleDiff).not.toHaveBeenCalled();expect(toggleResult).not.toHaveBeenCalled();
 click(1,rows.length-2);expect(toggleDiff).toHaveBeenCalledWith("d");expect(toggle).not.toHaveBeenCalled();expect(toggleResult).not.toHaveBeenCalled();
});

it("keeps Thinking headings within narrow windows",()=>{
 const h=message({id:"a",role:"assistant",text:"answer",thinking:"thought"});
 for(const width of [1,2,8,10,20,80])expect(h.view.render(width).every(row=>visibleWidth(row)<=width)).toBe(true);
});
it("ignores trailing background after tool text",()=>{
 const toggle=vi.fn();const store={settings:parseSettings({}),getSnapshot:()=>({expanded:new Set()}),toggle} as unknown as TuiStore;
 const view=new MessageView({id:"t",role:"tool",text:"",call:{name:"read",parse:{status:"parsed",arguments:{path:"a"}}}} as ConversationItem,store,defaultMarkdownTheme);
 view.render(80);view.handleMouse({type:"click",x:70,y:1,width:80,height:4,button:"left"});expect(toggle).not.toHaveBeenCalled();
});

it("reuses tool highlighting across updates and resize",async()=>{
 const {default:hljs}=await import("highlight.js/lib/core");const spy=vi.spyOn(hljs,"highlight");
 try {
 const item={id:"t",role:"tool",text:"",call:{name:"read",parse:{status:"parsed",arguments:{path:"a.ts"}}},result:{status:"success",content:readOutput(["1: const x=1;"])}} as ConversationItem;
 const h=message(item);const count=spy.mock.calls.length;h.view.render(80);h.view.render(8);h.view.update({...item});h.view.render(20);expect(spy.mock.calls.length).toBe(count);
 }finally{spy.mockRestore();}
});

it("keeps approval Diff collapsed until clicked without changing the authorization state", () => {
 const item = {id:"pending",role:"tool",text:"write",call:{name:"write",parse:{status:"parsed",arguments:{path:"file",content:"new"}}}} as ConversationItem;
 const h=message(item);
 h.view.setApproval({id:"approval",toolCallId:"call",toolName:"write",summary:{paths:["file"],parameters:{content:"new"}}},{status:"ready",before:"old",after:"new"});
 expect(h.frame()).toContain("Waiting for permission");
 expect(h.frame()).not.toContain("- old");
 h.expanded.add(item.id); h.view.update(item);
 expect(h.frame()).toContain("- old"); expect(h.frame()).toContain("+ new");
 h.view.setApproval();
 expect(h.frame()).not.toContain("- old");
});
it("separates bash result with an empty row and dim styles", () => {
 const item={id:"bash-dim",role:"tool",text:"",call:{name:"bash",parse:{status:"parsed",arguments:{command:"echo hello"}}},result:{status:"success",content:"hello output"}} as ConversationItem;
 const h=message(item); h.expanded.add(item.id); h.view.update(item);
 expect(h.frame()).toMatch(/echo hello[^\n]*\n[^\n]*\n[^\n]*hello output/);
 expect(h.view.render(80).join("\n")).toContain(theme.dim("hello output"));
});

it("running bash auto-shows the last five live output lines dimmed", () => {
  const item = { id: "tool-live", role: "tool", text: "", activity: "running", liveOutput: "l1\nl2\nl3\nl4\nl5\nl6\n", call: { name: "bash", parse: { status: "parsed", arguments: { command: "echo test" } } } } as ConversationItem;
  const h = message(item);
  const frame = h.frame();
  expect(frame).toContain("Running");
  expect(frame).not.toContain("l1");
  for (const line of ["l2", "l3", "l4", "l5", "l6"]) expect(frame).toContain(line);
  expect(h.view.render(80).join("\n")).toContain(theme.dim("l6"));
});

it("sanitizes live output control characters and truncates long lines to width", () => {
  const item = { id: "tool-live", role: "tool", text: "", activity: "running", liveOutput: "\u001b[31mred\u001b[0m\n" + "x".repeat(200), call: { name: "bash", parse: { status: "parsed", arguments: { command: "echo test" } } } } as ConversationItem;
  const h = message(item);
  const frame = h.frame(20);
  expect(frame).toContain("red");
  expect(frame).not.toContain("[31m");
  for (const row of h.view.render(20)) expect(visibleWidth(row)).toBeLessThanOrEqual(20);
});

it("completed bash hides live output and empty live output adds no rows", () => {
  const base = { id: "tool-live", role: "tool", text: "", activity: "running", call: { name: "bash", parse: { status: "parsed", arguments: { command: "echo test" } } } };
  const completed = message({ ...base, liveOutput: "stale", result: { status: "success", content: "done" } } as ConversationItem);
  expect(completed.frame()).not.toContain("stale");
  const withEmpty = message({ ...base, liveOutput: "" } as ConversationItem);
  const without = message({ ...base } as ConversationItem);
  expect(withEmpty.frame()).toBe(without.frame());
});

it("non-bash tools never show live output", () => {
  const item = { id: "tool-live", role: "tool", text: "", activity: "running", liveOutput: "private output", call: { name: "read", parse: { status: "parsed", arguments: { path: "a" } } } } as ConversationItem;
  expect(message(item).frame()).not.toContain("private output");
});
