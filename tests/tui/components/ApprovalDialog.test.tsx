import { loadApprovalPreview } from "../../../src/tui/approval-preview.js";
import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { ApprovalPanel, approvalSummaryLines } from "../../../src/tui/components/ApprovalDialog.js";
import type { PendingApproval } from "../../../src/core/state.js";
import { parseSettings } from "../../../src/llm/settings-store.js";
import type { TuiStore } from "../../../src/tui/store.js";
import { defaultSelectListTheme } from "../framework/test-themes.js";

it("keeps the outside-workspace and preview snapshot warnings in the approval summary", () => {
  const approval: PendingApproval = {
    id: "a",
    toolCallId: "c",
    toolName: "write",
    summary: { paths: ["/outside/file"], touchesOutsideWorkspace: true, operation: "overwrite" },
  };
  const lines = approvalSummaryLines(approval, 80);
  expect(lines).toContain("/outside/file");
  expect(lines).toContain("工作区外路径");
  expect(lines).toContain("预览非写入时刻快照");
});
it("reports preview read failure without inventing an empty file, and preserves the three actions", async () => {
  const approval: PendingApproval = {
    id: "a",
    toolCallId: "c",
    toolName: "write",
    summary: { paths: ["/outside/file"], touchesOutsideWorkspace: true, parameters: { content: "new" } },
  };
  const changed = vi.fn(),
    dismissModal = vi.fn(),
    confirmModal = vi.fn(),
    moveModal = vi.fn();
  const store = {
    settings: parseSettings({}),
    getSnapshot: () => ({ core: { pendingApproval: approval }, modal: { kind: "approval", selection: 0 } }),
    dismissModal,
    confirmModal,
    moveModal,
  } as unknown as TuiStore;
  const stat = vi.spyOn(fs, "stat").mockRejectedValue(new Error("read failed"));
  try {
    const panel = new ApprovalPanel(approval, store, defaultSelectListTheme, changed);
    panel.handleInput(" ");
    const frame = panel.render(80).join("\n");
    expect(await loadApprovalPreview(approval, store.settings)).toEqual({status:"unavailable"});
    expect(frame).not.toContain("预览不可用");
    expect(frame).not.toContain("+ new");
    for (const label of ["允许一次", "本会话允许", "拒绝"]) expect(frame).toContain(label);
    expect(confirmModal).not.toHaveBeenCalled();
    panel.handleInput("\x1b");
    expect(dismissModal).toHaveBeenCalledOnce();
  } finally {
    stat.mockRestore();
  }
});

it("keeps bash Space inert and uses the vertical list with down and Enter", async () => {
  const approval: PendingApproval = { id: "bash", toolCallId: "b", toolName: "bash", summary: { paths: [], command: "echo first\necho second" } };
  const changed = vi.fn(), moveModal = vi.fn(), confirmModal = vi.fn();
  const store = {
    settings: parseSettings({}),
    getSnapshot: () => ({ core: { pendingApproval: approval }, modal: { kind: "approval", selection: 0 } }),
    moveModal, confirmModal, dismissModal: vi.fn(),
  } as unknown as TuiStore;
  const panel = new ApprovalPanel(approval, store, defaultSelectListTheme, changed);
  changed.mockClear();
  panel.handleInput(" ");
  expect(changed).not.toHaveBeenCalled();
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  expect(moveModal).toHaveBeenCalledWith(1);
  expect(confirmModal).toHaveBeenCalledOnce();
});

it("keeps content out of the authorization panel and forwards navigation", () => {
 const approval: PendingApproval = {id:"a",toolCallId:"c",toolName:"bash",summary:{paths:[],command:"secret command"}};
 const navigate = vi.fn();
 const store = {getSnapshot:()=>({modal:{kind:"approval",selection:0}})} as unknown as TuiStore;
 const panel = new ApprovalPanel(approval,store,defaultSelectListTheme,vi.fn(),()=>false,navigate);
 expect(panel.render(80).join("\n")).not.toContain("secret command");
 panel.handleInput("\x0c"); panel.handleInput("\x1b[6~");
 expect(navigate.mock.calls.map(call=>call[0])).toEqual(["reveal","down"]);
});
