Search text files using regular expressions. Returns matching lines as path:line: content.

- Stay inside the workspace unless the user asks for a specific outside path; each outside path needs user approval. Read-only access to `~/.shana/skills` is always allowed without approval.
- Uses the default ripgrep regex engine without PCRE2.
- Paths use visible escapes for backslashes and control characters. Decode display escapes before using a path in another tool call.
- Directory searches respect ignore files, skip hidden and binary files, and do not follow directory symlinks. Explicit file paths and glob filters follow ripgrep's filtering precedence.
- Total output is limited to 24000 characters, including paths, line numbers, separators, and notices. Each matching line's content is limited to 500 characters including truncation markers, keeping text around the first match.
- Matches that do not fit the remaining total budget are omitted as whole entries. Unicode characters and escape sequences are never split.
- Narrow the pattern or search scope when results are truncated.
- "No matches found." indicates a completed search with no matches.
- Failures return an Error without partial matches.
