Read a UTF-8 text file with line numbers.

- Stay inside the workspace unless the user asks for a specific outside path; each outside path needs user approval. Read-only access to `~/.shana/skills` is always allowed without approval.
- Output is limited to 24000 characters. Lines longer than 2000 characters are truncated.
- Use the returned continuation offset when more lines are available. Increasing offset cannot recover the omitted part of a truncated line.
- Empty files and offsets beyond EOF return informational results.
- Files must contain valid UTF-8 without NUL. Validation covers the content actually read.
- Failures return an Error without partial content.
