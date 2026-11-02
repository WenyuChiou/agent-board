- **Common setup accepts a UTF-8 BOM in existing Codex hook JSON (#451).** Preview, install, reinstall and removal preserve foreign hook data and the selected progress file, while malformed JSON remains untouched and refused.
  Tests: `setup accepts a UTF-8 BOM in existing Codex hooks without losing foreign data`, `setup preserves malformed BOM-prefixed Codex hooks when it refuses installation`.
