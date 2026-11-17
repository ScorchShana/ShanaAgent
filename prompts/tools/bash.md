Run a Bash command in the workspace root and return its exit code, stdout, and stderr.

- Uses Git Bash on Windows and system Bash on Linux/WSL.
- The full command is shown when approval is required. Use non-interactive commands.
- Normal exit returns the actual exit code, including nonzero codes.
- Stdout and stderr are limited to 16000 and 4000 characters respectively, preserving the beginning and end of each stream.
- Execution errors return an Error with captured output.
- Termination is reported as confirmed only when verified. Follow any instruction to stop and ask the user.
