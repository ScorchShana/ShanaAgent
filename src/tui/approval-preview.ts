import fs from "node:fs/promises";
import type { PendingApproval } from "../core/state.js";
import type { Settings } from "../llm/settings-store.js";
import { decodeUtf8Strict, readFileUpTo, WRITE_MAX_EXISTING_FILE_BYTES } from "../tools/write.js";
import { reconstructEdit } from "./components/DiffView.js";
export type ApprovalPreview =
  { status: "loading" | "unavailable" } | { status: "ready"; before: string; after: string };
export async function loadApprovalPreview(
  approval: PendingApproval,
  settings: Settings,
): Promise<ApprovalPreview> {
  if (!["write", "edit"].includes(approval.toolName)) return { status: "unavailable" };
  try {
    const file = approval.summary?.paths[0],
      args = approval.summary?.parameters;
    if (!file || !args) return { status: "unavailable" };
    const limit = approval.toolName === "edit" ? settings.editMaxFileBytes : WRITE_MAX_EXISTING_FILE_BYTES;
    let before = "";
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > limit) throw new Error("preview unavailable");
      const bytes = await readFileUpTo(file, limit + 1);
      if (bytes.length > limit) throw new Error("preview unavailable");
      before = decodeUtf8Strict(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const after = approval.toolName === "edit" ? reconstructEdit(before, args, limit) : args.content;
    if (typeof after === "string") return { status: "ready", before, after };
  } catch {
    return { status: "unavailable" };
  }

  return { status: "unavailable" };
}
