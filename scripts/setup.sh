#!/usr/bin/env bash
# Installs the Agent Board plugin and makes the settings it cannot make itself.
# Safe to re-run; it is also how an install under the old name (project-progress from the
# claude-progress-pane marketplace) or an old zip install moves over.
#   curl -fsSL https://raw.githubusercontent.com/WenyuChiou/agent-board/main/scripts/setup.sh | bash
#   bash setup.sh [--keep-rule] [--no-install] [--agents[=codex,gemini,opencode]] [--remove-agents]
# What each step does, and why: see the comment at the top of setup.ps1. Needs python3.
# Step 2 here writes `export CLAUDE_CODE_ENABLE_TODO_TOOLS=1` to your shell's startup file
# instead of a PowerShell profile: ~/.zshrc for zsh, ~/.bashrc for bash (~/.bash_profile on
# macOS), ~/.profile otherwise; fish gets a line to add by hand, and settings.json keeps the
# key until a line sets it.
# It also turns on auto-update for the marketplace (extraKnownMarketplaces.agent-board.autoUpdate),
# unless you turned it off: Claude Code updates only the official marketplace on its own.
# --agents puts the "Report your progress" section of AGENTS.md into the global instructions of
# the other agents installed here (Codex: $CODEX_HOME/AGENTS.md, Gemini CLI: ~/.gemini/GEMINI.md,
# OpenCode: ~/.config/opencode/AGENTS.md), between markers, so their work shows on the pane
# too; --agents=codex,gemini names them; --remove-agents takes the section out again. An agent
# that /progress connect hooked into the pane is skipped: its hook already reports.
set -euo pipefail

marketplace='WenyuChiou/agent-board'
plugin='agent-board@agent-board'
# The names it had before 0.10.
old_market='claude-progress-pane'
old_plugin="project-progress@$old_market"
claude="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
keep_rule=0
install=1
agents=''
remove_agents=0
for arg in "$@"; do
  case "$arg" in
    --keep-rule) keep_rule=1 ;;
    --no-install) install=0 ;;
    --agents) agents=auto ;;
    --agents=*) agents="${arg#--agents=}" ;;
    --remove-agents) remove_agents=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Read before `marketplace add`, which writes its entry anew without autoUpdate: an
# auto-update you turned off stays off.
# One turned off under the old name stays off under the new one.
auto_off="$(python3 -c '
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8-sig") as f:
        known = json.load(f)["extraKnownMarketplaces"]
    print(1 if any(isinstance(known.get(name), dict) and known[name].get("autoUpdate") is False
                   for name in ("agent-board", "claude-progress-pane")) else 0)
except Exception:
    print(0)
' "$claude/settings.json" 2>/dev/null || echo 0)"

if [ "$install" = 1 ]; then
  if command -v claude >/dev/null 2>&1; then
    # Under its old name the plugin would load a second pane beside the new one.
    if grep -qs "\"$old_market\"" "$claude/plugins/known_marketplaces.json" "$claude/settings.json"; then
      claude plugin uninstall "$old_plugin" >/dev/null 2>&1 || true
      claude plugin marketplace remove "$old_market" >/dev/null 2>&1 || true
      echo "Removed $old_plugin, the plugin's old name; $plugin takes its place."
    fi
    if ! claude plugin marketplace add "$marketplace"; then
      echo "Could not add $marketplace. For a private repository run 'gh auth login' and 'gh auth setup-git' once;" >&2
      echo "without a GitHub SSH key also set CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1. Then run this again." >&2
      exit 1
    fi
    claude plugin install "$plugin"
    # A fresh install leaves the language option unset and Claude Code says so; auto is what
    # it means anyway. A language someone picked stays.
    if claude plugin configure "$plugin" --json 2>/dev/null |
      python3 -c 'import json, sys; sys.exit(0 if "language" in json.load(sys.stdin).get("unconfigured", []) else 1)' 2>/dev/null; then
      printf '{"language":"auto"}' | claude plugin configure "$plugin" --values-stdin >/dev/null 2>&1 || true
    fi
  else
    echo "claude is not on PATH: run 'claude plugin marketplace add $marketplace' and 'claude plugin install $plugin' yourself." >&2
  fi
fi

# Beside this script, or in the marketplace's clone when the script came through a pipe.
rule_file="$here/claude-md-rule.md"
[ -f "$rule_file" ] || rule_file="$claude/plugins/marketplaces/agent-board/scripts/claude-md-rule.md"
agents_file="$here/../AGENTS.md"
[ -f "$agents_file" ] || agents_file="$claude/plugins/marketplaces/agent-board/AGENTS.md"

python3 - "$claude" "$rule_file" "$keep_rule" "$HOME" "${SHELL:-}" "${ZDOTDIR:-}" "$auto_off" \
  "$agents" "$remove_agents" "$agents_file" "${CODEX_HOME:-}" "${XDG_CONFIG_HOME:-}" <<'PY'
import json, os, re, shutil, sys

claude, rule_file, keep_rule = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
home, shell, zdotdir = sys.argv[4], os.path.basename(sys.argv[5]), sys.argv[6]
auto_off = sys.argv[7] == '1'
agents, remove_agents, agents_file = sys.argv[8], sys.argv[9] == '1', sys.argv[10]
codex_home = sys.argv[11] or os.path.join(home, '.codex')
config_home = sys.argv[12] or os.path.join(home, '.config')
done = []

def save(path, text):
    if os.path.exists(path):
        shutil.copyfile(path, path + '.bak')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if isinstance(text, bytes):
        with open(path, 'wb') as f:
            f.write(text)
    else:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(text)

# Shell startup file. settings.json gives up its copy of the key only when rc_ready.
line = 'export CLAUDE_CODE_ENABLE_TODO_TOOLS=1'
rc_ready = False
if shell == 'zsh':
    rc = os.path.join(zdotdir or home, '.zshrc')
elif shell == 'bash':
    rc = os.path.join(home, '.bash_profile' if sys.platform == 'darwin' else '.bashrc')
elif shell == 'fish':
    rc = None
    done.append('fish: add `set -gx CLAUDE_CODE_ENABLE_TODO_TOOLS 1` to ~/.config/fish/config.fish')
else:
    rc = os.path.join(home, '.profile')
if rc:
    old = b''
    if os.path.exists(rc):
        with open(rc, 'rb') as f:
            old = f.read()
    if not re.search(rb'(?m)^[ \t]*(?:export[ \t]+)?CLAUDE_CODE_ENABLE_TODO_TOOLS=', old):
        add = ('# Agent Board: Task tools for claude started from this shell. Not in\n'
               '# ~/.claude/settings.json, whose env also reaches desktop-app sessions.\n' + line + '\n')
        if old:
            shutil.copyfile(rc, rc + '.bak')
            add = '\n' + add
        with open(rc, 'ab') as f:  # appended as bytes: the rest of the file is not decoded
            f.write(add.encode('ascii'))
        done.append('added %s to %s' % (line, rc))
    rc_ready = True

# settings.json: edits the text of the pairs below and nothing else, so the file keeps its
# indent and key order. Each edit is checked against the parsed file.
VALUE = r'(?:"(?:[^"\\]|\\.)*"|-?[0-9][0-9.eE+-]*)'

def edit_pair(text, key, value):
    """Changes one "key": value pair, or removes it when value is None. None when the key
    is not there exactly once."""
    if text is None:
        return None
    pair = '"' + re.escape(key) + r'"\s*:\s*' + VALUE
    if len(re.findall(pair, text)) != 1:
        return None
    if value is not None:
        return re.sub('("' + re.escape(key) + r'"\s*:\s*)' + VALUE,
                      lambda m: m.group(1) + json.dumps(value, ensure_ascii=False), text)
    # A pair before a comma takes its comma and its own line along; the last pair takes the
    # comma before it; the only pair leaves {}.
    for form, to in ((r'(?:(?<=\n)[ \t]*)?' + pair + r'[ \t]*,[ \t]*(?:\r?\n)?', ''),
                     (r',\s*' + pair, ''),
                     (r'\{\s*' + pair + r'\s*\}', '{}')):
        if len(re.findall(form, text)) == 1:
            return re.sub(form, to, text)
    return None

def add_first(text, key, member):
    """Puts member first in the object under "key", laid out like that object's other members.
    None when the key is not there exactly once."""
    if text is None:
        return None
    found = list(re.finditer('"' + re.escape(key) + r'"\s*:\s*\{', text))
    if len(found) != 1:
        return None
    at = found[0].end()
    rest = text[at:]
    line = re.match(r'[ \t]*(\r?\n)([ \t]*)(?=\S)', rest)
    if re.match(r'\s*\}', rest):
        add = member
    elif line:
        add = line.group(1) + line.group(2) + member + ','
    else:
        add = member + ', '
    return text[:at] + add + rest

settings_path = os.path.join(claude, 'settings.json')
text, bom, settings = '', False, None
if os.path.exists(settings_path):
    # Strict UTF-8, BOM noted: a file this cannot read back byte for byte is left alone.
    with open(settings_path, 'rb') as f:
        raw = f.read()
    bom = raw.startswith(b'\xef\xbb\xbf')
    try:
        text = raw[3 if bom else 0:].decode('utf-8')
        if text.strip():
            settings = json.loads(text)
    except ValueError:  # UnicodeDecodeError and JSONDecodeError both are
        print('settings.json is not UTF-8 JSON this script can read; left as it is.', file=sys.stderr)
if settings is not None:
    nxt = text
    edits = []
    env = settings.get('env') if isinstance(settings, dict) else None
    if isinstance(env, dict):
        if str(env.get('CLAUDE_CODE_ENABLE_TODO_TOOLS')) == '1':
            if rc_ready:
                del env['CLAUDE_CODE_ENABLE_TODO_TOOLS']
                nxt = edit_pair(nxt, 'CLAUDE_CODE_ENABLE_TODO_TOOLS', None)
                edits.append('removed CLAUDE_CODE_ENABLE_TODO_TOOLS from settings.json env (%s sets it now)'
                             % os.path.basename(rc))
            else:
                done.append('kept CLAUDE_CODE_ENABLE_TODO_TOOLS in settings.json until your shell sets it')
        old_mod = re.compile(r'[\\/]mods[\\/]project-progress[\\/]?$')
        if isinstance(env.get('CLAUDE_CODE_PLUGIN_DIRS'), str):
            dirs = [d for d in env['CLAUDE_CODE_PLUGIN_DIRS'].split(os.pathsep) if d]
            keep = [d for d in dirs if not old_mod.search(d)]
            if len(keep) != len(dirs):
                if keep:
                    env['CLAUDE_CODE_PLUGIN_DIRS'] = os.pathsep.join(keep)
                    nxt = edit_pair(nxt, 'CLAUDE_CODE_PLUGIN_DIRS', os.pathsep.join(keep))
                else:
                    del env['CLAUDE_CODE_PLUGIN_DIRS']
                    nxt = edit_pair(nxt, 'CLAUDE_CODE_PLUGIN_DIRS', None)
                edits += ['removed %s from CLAUDE_CODE_PLUGIN_DIRS' % d for d in dirs if old_mod.search(d)]
    known = settings.get('extraKnownMarketplaces') if isinstance(settings, dict) else None
    entry = known.get('agent-board') if isinstance(known, dict) else None
    if isinstance(entry, dict) and 'autoUpdate' not in entry and not auto_off:
        entry['autoUpdate'] = True
        nxt = add_first(nxt, 'agent-board', '"autoUpdate": true')
        edits.append('turned on auto-update for the agent-board marketplace')
    if edits:
        try:
            same = nxt is not None and json.loads(nxt) == settings
        except ValueError:
            same = False
        if same:
            save(settings_path, (b'\xef\xbb\xbf' if bom else b'') + nxt.encode('utf-8'))
            done += edits
        else:
            print('settings.json was left as it is; make these changes by hand: '
                  + '; '.join(edits), file=sys.stderr)

md_path = os.path.join(claude, 'CLAUDE.md')
md = ''
if os.path.exists(md_path):
    with open(md_path, encoding='utf-8') as f:
        md = f.read()
# Written as project-progress before 0.10.
block_re = r'<!-- (?P<rule>agent-board|project-progress):start -->.*?<!-- (?P=rule):end -->'
has_block = re.search(block_re, md, re.S) is not None
nxt = md
if keep_rule:
    if not os.path.isfile(rule_file):
        sys.exit('Rule file not found: ' + rule_file)
    with open(rule_file, encoding='utf-8') as f:
        block = f.read().strip()
    nxt = re.sub(block_re, lambda _: block, md, flags=re.S) if has_block else (md.rstrip() + '\n\n' + block).lstrip()
    nxt = nxt.rstrip() + '\n'
    what = 'wrote the Agent Board rule block'
elif has_block:
    nxt = re.sub(r'(\r?\n)*' + block_re + r'(\r?\n)*', '\n\n', md, flags=re.S)
    nxt = nxt.lstrip('\r\n').rstrip() + '\n' if nxt.strip() else ''
    what = 'removed the Agent Board rule block (the plugin adds it now)'
if nxt != md:
    save(md_path, nxt)
    done.append('CLAUDE.md: ' + what)

# Other agents: the AGENTS.md section they follow, in their own global instructions.
# A section written under the old name, claude-progress-pane, is found and replaced too.
START, END = '<!-- agent-board:start -->', '<!-- agent-board:end -->'
section_re = r'<!-- (?P<name>agent-board|claude-progress-pane):start -->.*?<!-- (?P=name):end -->'

def codex_file():
    # Codex reads AGENTS.override.md instead of AGENTS.md when the override has text.
    override = os.path.join(codex_home, 'AGENTS.override.md')
    try:
        with open(override, encoding='utf-8') as f:
            if f.read().strip():
                return override
    except (OSError, ValueError):
        pass
    return os.path.join(codex_home, 'AGENTS.md')

AGENT_FILES = {
    'codex': (codex_home, codex_file),
    'gemini': (os.path.join(home, '.gemini'), lambda: os.path.join(home, '.gemini', 'GEMINI.md')),
    'opencode': (os.path.join(config_home, 'opencode'), lambda: os.path.join(config_home, 'opencode', 'AGENTS.md')),
}

def read_text(path):
    # None for a file that is not UTF-8, which is left alone.
    if not os.path.exists(path):
        return ''
    try:
        with open(path, encoding='utf-8', newline='') as f:
            return f.read()
    except ValueError:
        return None

# An agent /progress connect hooked into the pane reports through its hook; the section
# would show its work twice.
HOOK_FILES = {
    'codex': [os.path.join(codex_home, 'hooks.json')],
    'gemini': [os.path.join(home, '.gemini', 'settings.json')],
    'opencode': [os.path.join(config_home, 'opencode', 'plugin', one) for one in ('agent-board.js', 'progress-pane.js')],
}

def hooked(name):
    texts = [read_text(path) or '' for path in HOOK_FILES[name]]
    return any('progress-report' in text or (name == 'opencode' and text != '') for text in texts)

found = [name for name, (base, _) in AGENT_FILES.items() if os.path.isdir(base)]
if remove_agents:
    targets = list(AGENT_FILES)
elif agents == 'auto':
    targets = found
elif agents:
    targets = [one.strip().lower() for one in agents.split(',') if one.strip()]
    unknown = [one for one in targets if one not in AGENT_FILES]
    if unknown:
        sys.exit('unknown agent: %s (known: %s)' % (', '.join(unknown), ', '.join(AGENT_FILES)))
else:
    targets = []
if targets and not remove_agents:
    try:
        with open(agents_file, encoding='utf-8') as f:
            source = f.read()
    except OSError:
        sys.exit('AGENTS.md not found: ' + agents_file)
    at = source.find('## Report your progress to the progress pane')
    if at < 0:
        sys.exit('AGENTS.md has no "Report your progress" section: ' + agents_file)
    section = START + '\n' + source[at:].strip() + '\n' + END
for name in targets:
    if not remove_agents and hooked(name):
        done.append('%s: reports through its hook (/progress connect); no section needed' % name)
        continue
    path = AGENT_FILES[name][1]()
    old = read_text(path)
    if old is None:
        print('%s is not UTF-8; left as it is.' % path, file=sys.stderr)
        continue
    has = re.search(section_re, old, re.S) is not None
    nl = '\r\n' if '\r\n' in old else '\n'
    if remove_agents:
        if not has:
            continue
        nxt = re.sub(r'(\r?\n)*' + section_re + r'(\r?\n)*', nl + nl, old, flags=re.S).strip()
        nxt = nxt + nl if nxt else ''
        what = 'removed the Agent Board section from'
    else:
        block = section.replace('\n', nl)
        nxt = re.sub(section_re, lambda _: block, old, flags=re.S) if has else (old.rstrip() + nl + nl + block).lstrip()
        nxt = nxt.rstrip() + nl
        what = 'wrote the Agent Board section to'
    if nxt != old:
        save(path, nxt.encode('utf-8'))
        done.append('%s: %s %s' % (name, what, path))
if not agents and not remove_agents:
    texts = {name: read_text(AGENT_FILES[name][1]()) for name in found}
    bare = [name for name in found if texts[name] is not None and not re.search(section_re, texts[name], re.S)
            and not hooked(name)]
    if bare:
        done.append('%s installed here too: run /progress connect in Claude Code to show their work on the pane'
                    % ' and '.join(bare))

print('\n'.join('- ' + one for one in done) if done else 'Settings: nothing to change.')
old_dir = os.path.join(claude, 'mods', 'project-progress')
if os.path.isdir(old_dir):
    print('The old install is still at %s; delete it once the plugin works.' % old_dir)
print('Start claude again from a new terminal. The pane opens by itself; /progress reopens it.')
print('Desktop-app sessions keep their own task list; note their work in progress.md by hand.')
PY
