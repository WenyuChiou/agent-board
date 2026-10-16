#!/usr/bin/env bash
# Installs the project-progress plugin and makes the settings it cannot make itself.
# Safe to re-run; it is also how an old zip install moves over.
#   curl -fsSL https://raw.githubusercontent.com/WenyuChiou/claude-progress-pane/main/scripts/setup.sh | bash
#   bash setup.sh [--keep-rule] [--no-install]
# What each step does, and why: see the comment at the top of setup.ps1. Needs python3.
# Step 2 here writes `export CLAUDE_CODE_ENABLE_TODO_TOOLS=1` to your shell's startup file
# instead of a PowerShell profile: ~/.zshrc for zsh, ~/.bashrc for bash (~/.bash_profile on
# macOS), ~/.profile otherwise; fish gets a line to add by hand, and settings.json keeps the
# key until a line sets it.
# It also turns on auto-update for the marketplace (extraKnownMarketplaces.claude-progress-pane
# .autoUpdate), unless you turned it off: Claude Code updates only the official marketplace on
# its own.
set -euo pipefail

marketplace='WenyuChiou/claude-progress-pane'
plugin='project-progress@claude-progress-pane'
claude="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
keep_rule=0
install=1
for arg in "$@"; do
  case "$arg" in
    --keep-rule) keep_rule=1 ;;
    --no-install) install=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Read before `marketplace add`, which writes its entry anew without autoUpdate: an
# auto-update you turned off stays off.
auto_off="$(python3 -c '
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8-sig") as f:
        entry = json.load(f)["extraKnownMarketplaces"]["claude-progress-pane"]
    print(1 if entry.get("autoUpdate") is False else 0)
except Exception:
    print(0)
' "$claude/settings.json" 2>/dev/null || echo 0)"

if [ "$install" = 1 ]; then
  if command -v claude >/dev/null 2>&1; then
    if ! claude plugin marketplace add "$marketplace"; then
      echo "Could not add $marketplace. For a private repository run 'gh auth login' and 'gh auth setup-git' once;" >&2
      echo "without a GitHub SSH key also set CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1. Then run this again." >&2
      exit 1
    fi
    claude plugin install "$plugin"
  else
    echo "claude is not on PATH: run 'claude plugin marketplace add $marketplace' and 'claude plugin install $plugin' yourself." >&2
  fi
fi

# Beside this script, or in the marketplace's clone when the script came through a pipe.
rule_file="$here/claude-md-rule.md"
[ -f "$rule_file" ] || rule_file="$claude/plugins/marketplaces/claude-progress-pane/scripts/claude-md-rule.md"

python3 - "$claude" "$rule_file" "$keep_rule" "$HOME" "${SHELL:-}" "${ZDOTDIR:-}" "$auto_off" <<'PY'
import json, os, re, shutil, sys

claude, rule_file, keep_rule = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
home, shell, zdotdir = sys.argv[4], os.path.basename(sys.argv[5]), sys.argv[6]
auto_off = sys.argv[7] == '1'
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
        add = ('# claude-progress-pane: Task tools for claude started from this shell. Not in\n'
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
    entry = known.get('claude-progress-pane') if isinstance(known, dict) else None
    if isinstance(entry, dict) and 'autoUpdate' not in entry and not auto_off:
        entry['autoUpdate'] = True
        nxt = add_first(nxt, 'claude-progress-pane', '"autoUpdate": true')
        edits.append('turned on auto-update for the claude-progress-pane marketplace')
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
block_re = r'<!-- project-progress:start -->.*?<!-- project-progress:end -->'
has_block = re.search(block_re, md, re.S) is not None
nxt = md
if keep_rule:
    if not os.path.isfile(rule_file):
        sys.exit('Rule file not found: ' + rule_file)
    with open(rule_file, encoding='utf-8') as f:
        block = f.read().strip()
    nxt = re.sub(block_re, lambda _: block, md, flags=re.S) if has_block else (md.rstrip() + '\n\n' + block).lstrip()
    nxt = nxt.rstrip() + '\n'
    what = 'wrote the project-progress rule block'
elif has_block:
    nxt = re.sub(r'(\r?\n)*' + block_re + r'(\r?\n)*', '\n\n', md, flags=re.S)
    nxt = nxt.lstrip('\r\n').rstrip() + '\n' if nxt.strip() else ''
    what = 'removed the project-progress rule block (the plugin adds it now)'
if nxt != md:
    save(md_path, nxt)
    done.append('CLAUDE.md: ' + what)

print('\n'.join('- ' + one for one in done) if done else 'Settings: nothing to change.')
old_dir = os.path.join(claude, 'mods', 'project-progress')
if os.path.isdir(old_dir):
    print('The old install is still at %s; delete it once the plugin works.' % old_dir)
print('Start claude again from a new terminal. The pane opens by itself; /progress reopens it.')
print('Desktop-app sessions keep their own task list; note their work in progress.md by hand.')
PY
