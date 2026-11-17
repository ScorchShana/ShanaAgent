Replace exact text in an existing UTF-8 text file. Use write to create a file or replace its entire contents.

- Stay inside the workspace unless the user asks for a specific outside path; each outside path needs user approval.
- Read the file before editing. Use file text without read-output line numbers, wrappers, or truncation markers.
- Include enough context to identify one match. Multiple matches require replace_all.
- CRLF and standalone CR are normalized to LF before matching. Other whitespace remains significant.
- The file's leading BOM is removed. BOM characters in arguments and within the file are preserved, except at the beginning of the final file.
- Successful edits produce LF line endings and no leading BOM. No trailing newline is added.
- old_string and new_string must differ after line-ending normalization. Failed matching does not modify the file.
- Files must contain valid UTF-8 without NUL. Both the original file and final UTF-8 result must fit within the {editMaxFileBytes}-byte limit.
