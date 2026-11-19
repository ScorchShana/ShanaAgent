Find files by glob pattern. Returns one path per line, newest first.

- Stay inside the workspace unless the user asks for a specific outside path; each outside path needs user approval. Read-only access to `~/.shana/skills` is always allowed without approval.
- Directory patterns recursively find files beneath them. Directory symlinks are not followed; file symlinks are returned.
- Respects .gitignore, includes non-ignored hidden files, and excludes .git/. Explicit patterns also respect .gitignore.
- Paths are workspace-relative unless the search path is absolute.
- Paths use visible escapes for backslashes and control characters. Decode display escapes before using a path in another tool call.
- Returns at most 200 files within a 24000-character output budget. Narrow the search when results are truncated.
- "(No files found)" indicates a completed search with no matches.
- Failures return an Error without partial results.
