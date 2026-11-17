Create or fully overwrite a UTF-8 text file. Use edit for partial changes.

- Stay inside the workspace unless the user asks for a specific outside path; each outside path needs user approval.
- The parent directory must exist.
- Existing files must contain valid UTF-8 without NUL and fit within the 16777216-byte limit.
- Writes preserve the supplied content, including line endings. No BOM or trailing newline is added.
- Follow any instruction to stop and ask the user after a failure.
