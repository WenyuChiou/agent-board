- **Plugin / Windows** · The plugin loads again from a Windows git checkout: the board bundle keeps LF line endings, so it stays under the 1 MiB that Claude Code reads from one module (#582).
  Tests: `the board bundle keeps LF on every checkout and stays under the Claude Code module limit`.
