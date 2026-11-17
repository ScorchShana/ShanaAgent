import fs from "node:fs";
import { DEFAULT_EDIT_MAX_FILE_BYTES } from "../llm/settings-store.js";
import type { ResolvedToolPath } from "../security/path-policy.js";
import type { ToolOutcome } from "./registry.js";
import {
  decodeUtf8Strict,
  diagnose,
  failure,
  fileOperationError,
  formatSuccessPath,
  isEditCancelled,
  readFileUpTo,
  validateTextArgument,
  writeFileAtomically,
  type FileOperationContext,
} from "./write.js";

export const EDIT_MAX_ARGUMENT_CHARACTERS = 100_000;
export interface EditArguments {
  path: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}
export interface EditContext extends FileOperationContext {
  editMaxFileBytes?: number;
}

function normalize(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export async function editFileContent(
  args: EditArguments,
  target: ResolvedToolPath,
  context: EditContext = {},
): Promise<ToolOutcome> {
  for (const [name, value] of [
    ["old_string", args.oldString],
    ["new_string", args.newString],
  ] as const) {
    const invalid = validateTextArgument(name, value, EDIT_MAX_ARGUMENT_CHARACTERS);
    if (invalid) return invalid;
  }
  if (!args.oldString) return failure("old_string must not be empty. Not executed.");
  if (context.signal?.aborted) return failure("Cancelled by user.", "cancelled");
  if (target.danglingSymlink) return failure("Broken symbolic link.");
  if (!target.exists) return failure("File not found. Use write to create it.");
  const limit = context.editMaxFileBytes ?? DEFAULT_EDIT_MAX_FILE_BYTES;
  let priorContent: string;
  let stats: fs.Stats;
  try {
    await context.assertPathTarget?.();
    stats = await fs.promises.stat(target.realPath);
    if (stats.isDirectory()) return failure("Path is a directory.");
    if (!stats.isFile()) return failure("Not a regular file.");
    if (stats.size > limit) return failure(`Existing file exceeds the ${limit}-byte limit.`);
    await context.assertPathTarget?.();
    const bytes = await readFileUpTo(target.realPath, limit + 1);
    if (bytes.length > limit) return failure(`Existing file exceeds the ${limit}-byte limit.`);
    priorContent = decodeUtf8Strict(bytes);
  } catch (error) {
    diagnose(context, "read", error);
    return fileOperationError(error);
  }
  const content = normalize(priorContent.replace(/^\uFEFF/, ""));
  const oldString = normalize(args.oldString);
  const newString = normalize(args.newString);
  if (oldString === newString)
    return failure(
      args.oldString === args.newString
        ? "old_string and new_string are identical."
        : "old_string and new_string differ only in line endings. The edit tool normalizes line endings to LF.",
    );
  let count = 0;
  let firstIndex = -1;
  let index = 0;
  let previousEnd = 0;
  let firstResultCharacter: string | undefined;
  while ((index = content.indexOf(oldString, index)) !== -1) {
    if (count === 0) firstIndex = index;
    if (firstResultCharacter === undefined) {
      if (index > previousEnd) firstResultCharacter = content[previousEnd];
      else if (newString.length > 0) firstResultCharacter = newString[0];
    }
    count++;
    index += oldString.length;
    previousEnd = index;
  }
  if (count === 0) return failure("old_string not found.");
  if (count > 1 && !args.replaceAll)
    return failure(`old_string has ${count} non-overlapping matches. Add context or set replace_all=true.`);
  firstResultCharacter ??= content[previousEnd];
  const resultBytes =
    Buffer.byteLength(content, "utf8") +
    count * (Buffer.byteLength(newString, "utf8") - Buffer.byteLength(oldString, "utf8")) -
    (firstResultCharacter === "\uFEFF" ? 3 : 0);
  if (resultBytes > limit) return failure(`Resulting file exceeds the ${limit}-byte limit.`);
  const updated = (
    args.replaceAll
      ? content.replaceAll(oldString, () => newString)
      : content.slice(0, firstIndex) + newString + content.slice(firstIndex + oldString.length)
  ).replace(/^\uFEFF/, "");
  try {
    await writeFileAtomically(target.realPath, updated, stats.mode, context);
  } catch (error) {
    return isEditCancelled(error) ? failure("Cancelled by user.", "cancelled") : fileOperationError(error);
  }
  const replacements = args.replaceAll ? ` (${count} ${count === 1 ? "replacement" : "replacements"})` : "";
  return {
    status: "success",
    content: `Successfully edited ${formatSuccessPath(args.path)}${replacements}.`,
    priorContent,
  };
}
