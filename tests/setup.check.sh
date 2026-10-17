#!/usr/bin/env bash
# Runs scripts/setup.sh --no-install against throwaway folders and checks what it wrote.
# Never touches the real ~/.claude or shell startup files: HOME and CLAUDE_CONFIG_DIR point
# into a temp folder. `claude plugin test` does not run it:
#   bash tests/setup.check.sh
set -uo pipefail
setup="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/setup.sh"
root="$(mktemp -d "${TMPDIR:-/tmp}/progress-setup-XXXXXX")"
trap 'rm -rf "$root"' EXIT
sep="$(python3 -c 'import os; print(os.pathsep)')"
fails=0
n=0

check() {  # check NAME COMMAND...
  if "${@:2}"; then echo "(pass) $1"; else echo "(fail) $1"; fails=$((fails + 1)); fi
}

new_case() {  # new_case [SETTINGS]: a fresh HOME with .claude/, settings.json when given
  n=$((n + 1))
  dir="$root/$n"
  mkdir -p "$dir/.claude"
  if [ $# -gt 0 ]; then printf '%s' "$1" > "$dir/.claude/settings.json"; fi
}

run() {  # run SHELL [ARGS...]: setup.sh for the current case; stdout+stderr in $dir/out
  local sh="$1"
  shift
  HOME="$dir" SHELL="$sh" ZDOTDIR="" CODEX_HOME="" XDG_CONFIG_HOME="" CLAUDE_CONFIG_DIR="$dir/.claude" \
    bash "$setup" --no-install "$@" > "$dir/out" 2>&1
}

same() { [ "$(cat "$1"; echo x)" = "$(printf '%s' "$2"; echo x)" ]; }
lines() { grep -c '^export CLAUDE_CODE_ENABLE_TODO_TOOLS=1$' "$1" 2>/dev/null || true; }

# 1. A key in the middle goes with its line; the old zip dir leaves the list; nothing else moves.
new_case "$(printf '{\n  "env": {\n    "A": "x",\n    "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",\n    "CLAUDE_CODE_PLUGIN_DIRS": "/home/me/.claude/mods/project-progress%s/opt/kit"\n  },\n  "zeta": [1, 2],\n  "alpha": {"b": true}\n}' "$sep")"$'\n'
run /bin/bash
check 'settings.json: the key and the old zip dir leave; indent, key order and the rest stay' \
  same "$dir/.claude/settings.json" "$(printf '{\n  "env": {\n    "A": "x",\n    "CLAUDE_CODE_PLUGIN_DIRS": "/opt/kit"\n  },\n  "zeta": [1, 2],\n  "alpha": {"b": true}\n}')"$'\n'
check 'settings.json: the old file is kept as settings.json.bak' test -f "$dir/.claude/settings.json.bak"

# 2. The last key takes the comma before it; CRLF stays CRLF.
new_case $'{\r\n  "env": {\r\n    "A": "x",\r\n    "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"\r\n  }\r\n}\r\n'
run /bin/bash
check 'settings.json: the last key takes the comma before it, CRLF kept' \
  same "$dir/.claude/settings.json" $'{\r\n  "env": {\r\n    "A": "x"\r\n  }\r\n}\r\n'

# 3. The only key leaves {}.
new_case '{"env": {"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"}, "model": "opus"}'
run /bin/bash
check 'settings.json: the only key leaves an empty env' same "$dir/.claude/settings.json" '{"env": {}, "model": "opus"}'

# 4. A value other than "1" is the person's own.
new_case $'{\n  "env": {\n    "CLAUDE_CODE_ENABLE_TODO_TOOLS": "0"\n  }\n}\n'
run /bin/bash
check 'settings.json: CLAUDE_CODE_ENABLE_TODO_TOOLS=0 is left alone' \
  same "$dir/.claude/settings.json" $'{\n  "env": {\n    "CLAUDE_CODE_ENABLE_TODO_TOOLS": "0"\n  }\n}\n'

# 5. The key twice: no exact edit, so the file stays and a message says what to do.
twice='{"env": {"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"}, "x": {"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"}}'
new_case "$twice"
run /bin/bash
check 'settings.json: an edit that cannot be exact leaves the file and says so' \
  bash -c '[ "$(cat "$1")" = "$2" ] && grep -q "by hand" "$3"' _ "$dir/.claude/settings.json" "$twice" "$dir/out"

# 6. No settings.json: none is made. bash gets the line in .bashrc (.bash_profile on macOS), once.
new_case
run /bin/bash
run /bin/bash
rc="$dir/.bashrc"
[ "$(uname -s)" = Darwin ] && rc="$dir/.bash_profile"
check 'no settings.json: none is created' test ! -e "$dir/.claude/settings.json"
check 'bash: the startup file gets the line, and a re-run does not add it twice' test "$(lines "$rc")" = 1

# 7. zsh gets .zshrc; a file that already sets the key is left alone.
new_case
printf 'alias ll="ls -l"\nexport CLAUDE_CODE_ENABLE_TODO_TOOLS=1\n' > "$dir/.zshrc"
run /usr/bin/zsh
check 'zsh: a .zshrc that already sets the key is left alone' \
  bash -c '[ "$(cat "$1")" = "$(printf "alias ll=\"ls -l\"\nexport CLAUDE_CODE_ENABLE_TODO_TOOLS=1")" ] && [ ! -e "$1.bak" ]' _ "$dir/.zshrc"
new_case
printf 'alias ll="ls -l"' > "$dir/.zshrc"
run /bin/zsh
check 'zsh: .zshrc keeps its text and gets the line on a line of its own' \
  bash -c 'head -1 "$1" | grep -qx "alias ll=\"ls -l\"" && grep -qx "export CLAUDE_CODE_ENABLE_TODO_TOOLS=1" "$1" && [ -f "$1.bak" ]' _ "$dir/.zshrc"

# 8. fish: nothing written, a line to add by hand.
new_case
run /usr/bin/fish
check 'fish: no file is written, and it says what to add' \
  bash -c '[ -z "$(ls -A "$1" | grep -v "^\.claude$" | grep -v "^out$")" ] && grep -q "set -gx CLAUDE_CODE_ENABLE_TODO_TOOLS 1" "$1/out"' _ "$dir"
fishkey=$'{\n  "env": {\n    "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"\n  }\n}\n'
new_case "$fishkey"
run /usr/bin/fish
check 'fish: settings.json keeps the key, since no startup file sets it' same "$dir/.claude/settings.json" "$fishkey"

# 9. A UTF-8 BOM stays.
new_case $'\xef\xbb\xbf{\n  "env": {\n    "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",\n    "A": "x"\n  }\n}\n'
run /bin/bash
check 'settings.json: a UTF-8 BOM stays' same "$dir/.claude/settings.json" $'\xef\xbb\xbf{\n  "env": {\n    "A": "x"\n  }\n}\n'

# 10. Bytes that are not UTF-8 (cp950 text in a hook command): left alone, with a message.
new_case $'{"statusLine": "echo \xa4\xa4\xa4\xe5", "env": {"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"}}'
cp "$dir/.claude/settings.json" "$dir/before.json"
run /bin/bash
check 'settings.json: bytes that are not UTF-8 are left alone, with a message' \
  bash -c 'cmp -s "$1/.claude/settings.json" "$1/before.json" && grep -q "left as it is" "$1/out"' _ "$dir"

# 11. The marketplace entry gets autoUpdate first, in its own indent; nothing else moves.
new_case $'{\n  "extraKnownMarketplaces": {\n    "claude-progress-pane": {\n      "source": {\n        "source": "github",\n        "repo": "WenyuChiou/claude-progress-pane"\n      }\n    }\n  },\n  "enabledPlugins": {\n    "project-progress@claude-progress-pane": true\n  }\n}\n'
run /bin/bash
check 'auto-update: the marketplace entry gets "autoUpdate": true, the rest stays' \
  same "$dir/.claude/settings.json" $'{\n  "extraKnownMarketplaces": {\n    "claude-progress-pane": {\n      "autoUpdate": true,\n      "source": {\n        "source": "github",\n        "repo": "WenyuChiou/claude-progress-pane"\n      }\n    }\n  },\n  "enabledPlugins": {\n    "project-progress@claude-progress-pane": true\n  }\n}\n'

# 12. On one line it stays on one line.
new_case '{"extraKnownMarketplaces": {"claude-progress-pane": {"source": {"source": "github", "repo": "WenyuChiou/claude-progress-pane"}}}}'
run /bin/bash
check 'auto-update: an entry on one line stays on one line' \
  same "$dir/.claude/settings.json" '{"extraKnownMarketplaces": {"claude-progress-pane": {"autoUpdate": true, "source": {"source": "github", "repo": "WenyuChiou/claude-progress-pane"}}}}'

# 13. Turned off by hand: stays off, and the file is not touched.
off=$'{\n  "extraKnownMarketplaces": {\n    "claude-progress-pane": {\n      "source": {\n        "source": "github",\n        "repo": "WenyuChiou/claude-progress-pane"\n      },\n      "autoUpdate": false\n    }\n  }\n}\n'
new_case "$off"
run /bin/bash
check 'auto-update: "autoUpdate": false is left alone' \
  bash -c '[ "$(cat "$1"; echo x)" = "$(printf "%s" "$2"; echo x)" ] && [ ! -e "$1.bak" ]' _ "$dir/.claude/settings.json" "$off"

# 14. No marketplace entry (the plugin not installed yet): nothing is added.
bare='{"model": "opus"}'
new_case "$bare"
run /bin/bash
check 'auto-update: no marketplace entry, nothing added' same "$dir/.claude/settings.json" "$bare"

# 15. --agents writes the section into the agents installed here, between markers, and only them.
new_case
mkdir -p "$dir/.codex" "$dir/.gemini"
printf '# My rules\n\nUse tabs.\n' > "$dir/.codex/AGENTS.md"
run /bin/bash --agents
check 'agents: Codex keeps its own text and gets the section after it' \
  bash -c 'head -1 "$1" | grep -qx "# My rules" && grep -qx "Use tabs." "$1" && grep -q "^## Report your progress to the progress pane" "$1" && grep -q "claude-progress-pane:end" "$1" && [ -f "$1.bak" ]' _ "$dir/.codex/AGENTS.md"
check 'agents: Gemini CLI gets GEMINI.md with the section' grep -q "agent=NAME" "$dir/.gemini/GEMINI.md"
check 'agents: OpenCode, not installed here, gets nothing' test ! -e "$dir/.config/opencode/AGENTS.md"
cp "$dir/.codex/AGENTS.md" "$dir/codex-first"
run /bin/bash --agents
check 'agents: a second run changes nothing' cmp -s "$dir/.codex/AGENTS.md" "$dir/codex-first"
run /bin/bash --remove-agents
check 'agents: --remove-agents takes the section out and leaves the rest' \
  bash -c '[ "$(cat "$1")" = "$(printf "# My rules\n\nUse tabs.")" ] && ! grep -q "progress pane" "$2"' _ "$dir/.codex/AGENTS.md" "$dir/.gemini/GEMINI.md"

# 16. Named agents, Codex's override file, and the hint when --agents is not given.
new_case
mkdir -p "$dir/.codex"
printf 'Override rules\n' > "$dir/.codex/AGENTS.override.md"
run /bin/bash
check 'agents: without --agents it only says which agents it found' \
  bash -c 'grep -q "codex installed here too" "$1/out" && [ "$(cat "$1/.codex/AGENTS.override.md")" = "Override rules" ]' _ "$dir"
run /bin/bash --agents=codex,opencode
check 'agents: Codex reads AGENTS.override.md when it has text, so the section goes there' \
  bash -c 'grep -q "claude-progress-pane:start" "$1/.codex/AGENTS.override.md" && [ ! -e "$1/.codex/AGENTS.md" ]' _ "$dir"
check 'agents: a named agent gets the section even before it has a folder' grep -q "claude-progress-pane:start" "$dir/.config/opencode/AGENTS.md"
run /bin/bash --agents=copilot
check 'agents: an unknown name is refused' grep -q "unknown agent: copilot" "$dir/out"
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"sh progress-report.sh codex turn"}]}]}}' > "$dir/.codex/hooks.json"
rm -f "$dir/.codex/AGENTS.override.md"
run /bin/bash --agents=codex
check 'agents: an agent hooked by /progress connect gets no section' \
  bash -c 'grep -q "codex: reports through its hook" "$1/out" && ! grep -q "claude-progress-pane:start" "$1/.codex/AGENTS.md" 2>/dev/null' _ "$dir"

echo
if [ "$fails" -gt 0 ]; then echo "$fails fail"; exit 1; fi
echo 'all pass'
