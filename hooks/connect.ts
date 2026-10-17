import { BOARD_SCRIPT } from './board-script'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'

// The reporter script an agent's hook runs, written beside progress.md by `/progress
// connect`: it saves what the hook hands over into the inbox and clears files older than two
// days. No dependencies: POSIX sh on macOS and Linux, Windows PowerShell 5.1 on Windows.

// Arguments: the agent's name, `turn` or `end`, then optionally the JSON itself (as Codex's
// legacy notify passes it) instead of on stdin.
export const reporterSh = (inbox: string): string => `#!/bin/sh
# Written by the Agent Board plugin (/progress connect). An agent's hook runs it at the end of
# a turn or a session; the Agent Board pane reads what it saves.
exec 2>/dev/null
agent="\${1:-agent}"
event="\${2:-turn}"
[ $# -gt 0 ] && shift
[ $# -gt 0 ] && shift
dir=${shellQuote(inbox)}
mkdir -p "$dir" 2>/dev/null
file="$dir/$agent-$event-$(date +%s)-$$"
if [ $# -gt 0 ]; then
  printf '%s' "$1" > "$file.tmp"
elif [ ! -t 0 ]; then
  cat > "$file.tmp"
fi
[ -s "$file.tmp" ] && mv "$file.tmp" "$file.json"
rm -f "$file.tmp"
find "$dir" -name '*.json' -mtime +2 -exec rm -f {} +
# Quiet for every agent but Cursor, which expects a JSON answer; Gemini CLI reads stderr
# when stdout is empty, so that stays quiet too. Always exit 0: some agents read exit 2 as
# "keep going".
[ "$agent" = cursor ] && printf '{}\\n'
exit 0
`

// The inbox is found from the script's own folder (both sit beside progress.md), so the
// script holds no path: PowerShell 5.1 reads a file with no byte-order mark in the system's
// code page, which would turn a home folder named in Chinese into a different folder.
export const reporterPs1 = (): string => `# Written by the Agent Board plugin (/progress connect). An agent's hook runs it at the end of
# a turn or a session; the Agent Board pane reads what it saves.
param([string]$Agent = 'agent', [string]$Event = 'turn', [string]$Payload = '')
$ErrorActionPreference = 'SilentlyContinue'
$dir = Join-Path $PSScriptRoot 'progress-inbox'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
if ($Payload -eq '' -and [Console]::IsInputRedirected) {
  [Console]::InputEncoding = [Text.Encoding]::UTF8
  $Payload = [Console]::In.ReadToEnd()
}
if ($Payload.Trim() -ne '') {
  $name = '{0}-{1}-{2}-{3}' -f $Agent, $Event, [DateTimeOffset]::Now.ToUnixTimeMilliseconds(), $PID
  $tmp = Join-Path $dir ($name + '.tmp')
  [IO.File]::WriteAllText($tmp, $Payload, (New-Object Text.UTF8Encoding $false))
  Move-Item -Force $tmp (Join-Path $dir ($name + '.json'))
}
Get-ChildItem -Path $dir -Filter '*.json' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-2) } | Remove-Item -Force
if ($Agent -eq 'cursor') { '{}' }
exit 0
`

export const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

export const psQuote = (text: string): string => `'${text.replace(/'/g, "''")}'`

// The command line a hook runs for one agent and event. When the script is gone (the
// person deleted ~/.claude, or uninstalled without `/progress connect remove`), sh exits 2,
// which Gemini CLI, Codex, Grok Build and Muse Code read as "block" and run the agent
// again, for ever; `|| true` keeps it at 0. PowerShell exits 64 for a missing file, which
// they only warn about.
export const reportCommand = (script: string, agent: string, event: 'turn' | 'end', isWindows: boolean): string =>
  isWindows
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" ${agent} ${event}`
    : `sh ${shellQuote(script)} ${agent} ${event} || true`

// A hook command this plugin wrote: it runs the reporter script by its path, so a person's
// own `my-progress-report.sh` is not taken for ours.
const OURS = /(?:^|[\\/'"\s])progress-report\.(?:sh|ps1)(?:\\?['"])?(?:\s|$)/

// Whether a config already runs our reporter, whatever else taking our hooks out would tidy.
export const hasOurHook = (text: string): boolean => OURS.test(text)

// Whether the computer is Windows: Windows sets OS=Windows_NT in every shell (Git Bash too),
// and a path on a drive letter says so even when written with forward slashes
// (`C:/Users/me/progress.md`). Backslashes alone are no sign either way.
export const isWindowsHost = (os: string | undefined, path: string): boolean => os === 'Windows_NT' || /^[A-Za-z]:[\\/]/.test(path)

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)

const commandOf = (entry: unknown): string => {
  if (!isRecord(entry)) return ''
  if (typeof entry.command === 'string') return entry.command
  if (Array.isArray(entry.command)) return entry.command.join(' ')

  return ''
}

// Hooks grouped the way Claude Code writes them (Codex, Gemini CLI, Grok Build and Muse
// Code take the same shape): `hooks.<Event>` is a list of `{ matcher?, hooks: [{ type,
// command }] }`. Ours replaces any earlier one of ours; everything else stays.
export const withGroupedHook = (config: Json, event: string, command: string, extra: Json = {}): Json => {
  const hooks = isRecord(config.hooks) ? config.hooks : {}
  const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
  const kept = groups.filter(group => !(isRecord(group) && Array.isArray(group.hooks) && group.hooks.some(one => OURS.test(commandOf(one)))))
  const ours = { hooks: [{ ...(typeof extra.name === 'string' ? { name: extra.name } : {}), type: 'command', command, ...extra }] }

  return { ...config, hooks: { ...hooks, [event]: [...kept, ours] } }
}

// Cursor's shape: `{ version: 1, hooks: { <event>: [{ command }] } }`.
export const withFlatHook = (config: Json, event: string, command: string): Json => {
  const hooks = isRecord(config.hooks) ? config.hooks : {}
  const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
  const kept = list.filter(one => !OURS.test(commandOf(one)))

  return { version: 1, ...config, hooks: { ...hooks, [event]: [...kept, { command }] } }
}

// Every hook of ours taken out, in either shape; an event left empty goes too.
export const withoutOurHooks = (config: Json): Json => {
  if (!isRecord(config.hooks)) return config
  const hooks: Json = {}
  for (const [event, value] of Object.entries(config.hooks)) {
    if (!Array.isArray(value)) {
      hooks[event] = value
      continue
    }
    const kept = value
      .map(entry => {
        if (isRecord(entry) && Array.isArray(entry.hooks)) {
          const inner = entry.hooks.filter(one => !OURS.test(commandOf(one)))
          return inner.length === 0 ? null : { ...entry, hooks: inner }
        }
        return OURS.test(commandOf(entry)) ? null : entry
      })
      .filter(entry => entry !== null)
    if (kept.length > 0) hooks[event] = kept
  }

  return { ...config, hooks }
}

// A number's significant digits, without sign, point, exponent or the zeros around them.
const digitsOf = (number: string): string => number.replace(/[eE].*$/, '').replace(/[-.]/g, '').replace(/^0+/, '').replace(/0+$/, '')

// A number JSON.parse cannot hold as written: an integer past 2^53 (a Discord or Telegram
// id), one past a double's range (1e400, 1e-400), or more digits than a double keeps.
// Written back, it would come out as a different number: the digits a double prints for
// itself are not the ones written.
const losesNumbers = (text: string): boolean =>
  (text.replace(/"(?:[^"\\]|\\.)*"/g, '""').match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? []).some(literal => {
    const value = Number(literal)
    return !Number.isFinite(value) || digitsOf(value.toExponential()) !== digitsOf(literal)
  })

// A config file read as JSON: `{}` when it is missing or empty, null when it holds
// something that is not a JSON object (comments, a typo) or a number it would change, which
// is then left alone.
export const readConfig = (text: string): Json | null => {
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) && !losesNumbers(text) ? parsed : null
  } catch {
    return null
  }
}

// The config written back, or the text as it was when nothing in it changed, so a file the
// person or the agent formats its own way is not rewritten (and announced) at every start.
const writeChanged = (text: string, before: Json, after: Json): string =>
  JSON.stringify(after) === JSON.stringify(before) ? text : writeConfig(after)

export const writeConfig = (config: Json): string => `${JSON.stringify(config, null, 2)}\n`

// The section setup --agents puts in an agent's instruction file, under the plugin's name or
// the one it had before (claude-progress-pane). A hook replaces it, so the agent's work does
// not show twice.
const SECTION = /\n*<!-- (agent-board|claude-progress-pane):start -->[\s\S]*?<!-- \1:end -->\n*/g

export const withoutSection = (text: string): string => {
  const after = text.replace(SECTION, '\n')

  return after === text ? text : after.replace(/^\n+/, '')
}

// Where each agent keeps what `/progress connect` changes, and how. `dir` says the agent is
// installed (its folder under the home directory); `edit` turns the file's text into the
// new text, or null when the file cannot be read as JSON and is left alone.
export type ConnectContext = { home: string; sep: string; isWindows: boolean; script: string; inbox: string; codexHome: string; grokHome: string; hermesHome: string; openclawHome: string; board?: string; s?: Strings }

export type AgentHook = {
  agent: string
  // '' for a file that only shows the board (a board command, the shared skill): it is
  // written, but connecting an agent means its turns reach the board, so it is never named.
  label: string
  dir: string
  // Any of these says the agent is installed, when there is more than one place to look.
  dirs?: string[]
  file: string
  // The file an earlier name of the plugin wrote instead, taken away when connecting or removing.
  old?: string
  edit: (text: string, remove: boolean) => string | null | typeof DELETE
}

// What `edit` answers for a file of ours that removing takes away whole.
export const DELETE = Symbol('delete')

const join = (ctx: ConnectContext, ...parts: string[]): string => [ctx.home, ...parts].join(ctx.sep)

// Other tools (Orca among them) put hooks in ~/.grok/hooks for a Grok Build that may never
// be installed, so the folder alone is no sign of it: Grok's own config or sessions are.
const grokSigns = (ctx: ConnectContext): string[] => ['config.toml', 'sessions', '.metadata_version', 'agent_id'].map(name => [ctx.grokHome, name].join(ctx.sep))

const jsonEdit =
  (add: (config: Json) => Json) =>
  (text: string, remove: boolean): string | null => {
    const config = readConfig(text)
    if (config === null) return null
    return writeChanged(text, config, remove ? withoutOurHooks(config) : add(withoutOurHooks(config)))
  }

// Hermes Agent keeps its hooks in YAML: `hooks.<event>` is a list of `{ command, timeout }`.
// With no YAML parser here, ours go in as one flow-style line each, found again by the
// reporter script's name, and a `hooks:` written in a shape this cannot follow (flow style)
// is left alone. The empty map `hooks: {}` is the one flow-style value it can follow: Hermes
// writes that into a new config.yaml, and it holds nothing to keep.
// A comment runs to the line end, a Windows `\r` included.
const HERMES_KEY = /^\s+(?:post_llm_call|on_session_finalize)\s*:\s*(?:#[^\n]*)?$/
const TOP_HOOKS = /^hooks\s*:\s*(?:#[^\n]*)?$/
const EMPTY_HOOKS = /^hooks\s*:\s*\{\s*\}\s*(?:#[^\n]*)?$/

const indentOf = (line: string): number => line.length - line.trimStart().length

const isContent = (line: string): boolean => line.trim() !== '' && !line.trimStart().startsWith('#')

// Whether the key on line `at` has anything under it (YAML lets a list sit at the key's own
// indent).
const hasChildren = (lines: string[], at: number): boolean => {
  const indent = indentOf(lines[at] ?? '')
  const next = lines.slice(at + 1).find(isContent)
  if (next === undefined) return false

  return indentOf(next) > indent || (indentOf(next) === indent && next.trimStart().startsWith('- '))
}

// Adding ours again keeps a `hooks:` that only held ours, so they go back where they were
// rather than to the end of the file.
// Our list items, each with the lines that continue it: a YAML dumper (Hermes' own setup,
// or a person tidying the file) writes our flow-style item in block style, its timeout on a
// line of its own. A comment or another line that names the script is no item of ours.
const hermesItems = (lines: readonly string[]): Array<[number, number]> => {
  const items: Array<[number, number]> = []
  lines.forEach((line, at) => {
    if (!line.trimStart().startsWith('- ')) return
    const indent = indentOf(line)
    let end = at + 1
    while (end < lines.length && isContent(lines[end] ?? '') && indentOf(lines[end] ?? '') > indent) end += 1
    if (lines.slice(at, end).some(one => isContent(one) && OURS.test(one))) items.push([at, end])
  })

  return items
}

const stripHermesHooks = (text: string, isKeepingTop: boolean): string => {
  const lines = text.split('\n')
  const drop = new Set<number>()
  for (const [start, end] of hermesItems(lines)) for (let index = start; index < end; index += 1) drop.add(index)
  const kept = lines.filter((_, at) => !drop.has(at))
  if (kept.length === lines.length) return text
  const keys = kept.filter((line, at) => !(HERMES_KEY.test(line) && !hasChildren(kept, at)))
  const rest = isKeepingTop ? keys : keys.filter((line, at) => !(TOP_HOOKS.test(line) && !hasChildren(keys, at)))

  return `${rest.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '')}\n`.replace(/^\n$/, '')
}

export const withoutHermesHooks = (text: string): string => stripHermesHooks(text, false)

export const withHermesHooks = (text: string, events: Array<[string, string]>): string | null => {
  // Ours all there already, in whatever style Hermes last wrote them: nothing to change, so
  // a session start neither rewrites the file nor says it connected Hermes again.
  const lines0 = text.split('\n')
  const items = hermesItems(lines0).map(([start, end]) => lines0.slice(start, end).join('\n'))
  const isItemOf = (item: string, command: string): boolean => item.includes(command) || item.includes(JSON.stringify(command)) || item.includes(`'${command.replace(/'/g, "''")}'`)
  if (items.length === events.length && events.every(([, command]) => items.some(item => isItemOf(item, command)))) return text
  const base = stripHermesHooks(text, true)
  const item = (command: string): string => `- {command: ${JSON.stringify(command)}, timeout: 10}`
  // Lines of ours end the way the file's own lines do.
  const eol = text.includes('\r\n') ? '\r' : ''
  // An empty `hooks: {}` becomes a bare `hooks:` that ours go under.
  const lines = base
    .replace(/\n+$/, '')
    .split('\n')
    .map(line => (EMPTY_HOOKS.test(line) ? `${line.replace(/\{\s*\}\s*/, '').replace(/\s+(#|\r|$)/, ' $1').trimEnd()}${line.endsWith('\r') ? '\r' : ''}` : line))
  const at = lines.findIndex(line => /^hooks\s*:/.test(line))
  if (at === -1) {
    const added = ['hooks:', ...events.flatMap(([event, command]) => [`  ${event}:`, `    ${item(command)}`])].join(`${eol}\n`)
    return base.trim() === '' ? `${added}${eol}\n` : `${base.replace(/(?:\r?\n)+$/, '')}${eol}\n${eol}\n${added}${eol}\n`
  }
  if (!TOP_HOOKS.test(lines[at] ?? '')) return null
  let end = lines.findIndex((line, index) => index > at && isContent(line) && indentOf(line) === 0)
  if (end === -1) end = lines.length
  let insert = end
  while (insert - 1 > at && !isContent(lines[insert - 1] ?? '')) insert -= 1
  const firstChild = lines.slice(at + 1, end).find(isContent)
  const indent = firstChild === undefined ? 2 : indentOf(firstChild)
  for (const [event, command] of events) {
    const key = lines.findIndex((line, index) => index > at && index < end && indentOf(line) === indent && new RegExp(`^\\s*${event}\\s*:`).test(line))
    if (key === -1) {
      lines.splice(insert, 0, `${' '.repeat(indent)}${event}:${eol}`, `${' '.repeat(indent + 2)}${item(command)}${eol}`)
      insert += 2
      end += 2
      continue
    }
    const after = (lines[key] ?? '').replace(/^[^:]*:/, '').trim()
    if (after !== '' && !after.startsWith('#')) return null
    const next = lines.slice(key + 1, end).find(isContent)
    const nested = next !== undefined && (indentOf(next) > indent || (indentOf(next) === indent && next.trimStart().startsWith('- ')))
    lines.splice(key + 1, 0, `${' '.repeat(nested && next !== undefined ? indentOf(next) : indent + 2)}${item(command)}${eol}`)
    if (key < insert) insert += 1
    end += 1
  }

  return `${lines.join('\n')}\n`
}

export const agentHooks = (ctx: ConnectContext): AgentHook[] => {
  const turn = (agent: string): string => reportCommand(ctx.script, agent, 'turn', ctx.isWindows)
  const end = (agent: string): string => reportCommand(ctx.script, agent, 'end', ctx.isWindows)

  return [
    {
      // Stop carries last_assistant_message; Codex asks the person to approve a new hook in
      // its /hooks before it runs.
      agent: 'codex',
      label: 'Codex',
      dir: ctx.codexHome,
      file: [ctx.codexHome, 'hooks.json'].join(ctx.sep),
      edit: jsonEdit(config =>
        withGroupedHook(withGroupedHook(config, 'Stop', turn('codex'), { timeout: 10 }), 'SessionEnd', end('codex'), { timeout: 3 }),
      ),
    },
    {
      // AfterAgent carries prompt and prompt_response. Hooks are on by default; timeout is in ms.
      agent: 'gemini',
      label: 'Gemini CLI',
      dir: join(ctx, '.gemini'),
      file: join(ctx, '.gemini', 'settings.json'),
      edit: jsonEdit(config =>
        withGroupedHook(
          withGroupedHook(config, 'AfterAgent', turn('gemini'), { name: 'agent-board', timeout: 5000 }),
          'SessionEnd',
          end('gemini'),
          { name: 'agent-board-end', timeout: 5000 },
        ),
      ),
    },
    {
      // afterAgentResponse carries the reply's text; stop carries none, but fires where the
      // CLI skips the other; sessionEnd ends the block.
      agent: 'cursor',
      label: 'Cursor',
      dir: join(ctx, '.cursor'),
      file: join(ctx, '.cursor', 'hooks.json'),
      edit: jsonEdit(config =>
        withFlatHook(withFlatHook(withFlatHook(config, 'afterAgentResponse', turn('cursor')), 'stop', turn('cursor')), 'sessionEnd', end('cursor')),
      ),
    },
    {
      // A file of its own in ~/.grok/hooks; Stop carries lastAssistantMessage. Timeout in s: on
      // Windows PowerShell alone takes most of a second to start, so the end hook gets 5.
      agent: 'grok',
      label: 'Grok Build',
      dir: ctx.grokHome,
      dirs: grokSigns(ctx),
      file: [ctx.grokHome, 'hooks', 'agent-board.json'].join(ctx.sep),
      old: [ctx.grokHome, 'hooks', 'progress-pane.json'].join(ctx.sep),
      edit: (text, remove) =>
        remove
          ? text.trim() === ''
            ? null
            : DELETE
          : writeConfig(withGroupedHook(withGroupedHook({}, 'Stop', turn('grok'), { timeout: 10 }), 'SessionEnd', end('grok'), { timeout: 5 })),
    },
    {
      // Muse wants schema_version 1 and no handler keys beyond type, command, timeout. The end
      // hook gets 5 s for the same reason as Grok's.
      agent: 'muse',
      label: 'Muse Code',
      dir: join(ctx, '.config', 'muse'),
      file: join(ctx, '.config', 'muse', 'settings.json'),
      edit: jsonEdit(config =>
        withGroupedHook(withGroupedHook({ schema_version: 1, ...config }, 'Stop', turn('muse'), { timeout: 10 }), 'SessionEnd', end('muse'), { timeout: 5 }),
      ),
    },
    {
      // post_llm_call carries the turn's words under `extra`. Its on_session_end fires after
      // every turn, so the end is on_session_finalize. Hermes asks once before it runs a new
      // hook (or takes --accept-hooks). Timeout in s.
      agent: 'hermes',
      label: 'Hermes Agent',
      dir: ctx.hermesHome,
      file: [ctx.hermesHome, 'config.yaml'].join(ctx.sep),
      edit: (text, remove) =>
        remove
          ? withoutHermesHooks(text)
          : withHermesHooks(text, [
              ['post_llm_call', turn('hermes')],
              ['on_session_finalize', end('hermes')],
            ]),
    },
    {
      // OpenClaw takes plugins, not commands. A standalone file goes in plugins.load.paths and
      // takes its file name as its id; it must come before the config entry that loads it.
      agent: 'openclaw',
      label: 'OpenClaw',
      dir: ctx.openclawHome,
      file: [ctx.openclawHome, OPENCLAW_FILE].join(ctx.sep),
      edit: (text, remove) => (remove ? (text.trim() === '' ? null : DELETE) : openclawPlugin(ctx)),
    },
    {
      agent: 'openclaw',
      label: 'OpenClaw',
      dir: ctx.openclawHome,
      file: [ctx.openclawHome, 'openclaw.json'].join(ctx.sep),
      edit: (text, remove) => {
        const config = readConfig(text)
        if (config === null) return null
        const file = [ctx.openclawHome, OPENCLAW_FILE].join(ctx.sep)
        // Nothing of ours to take out: the person's file stays byte for byte.
        if (remove && !hasOpenclawPlugin(config, file)) return text
        return writeChanged(text, config, remove ? withoutOpenclawPlugin(config, file) : withOpenclawPlugin(config, file))
      },
    },
    {
      agent: 'opencode',
      label: 'OpenCode',
      dir: join(ctx, '.config', 'opencode'),
      file: join(ctx, '.config', 'opencode', 'plugin', 'agent-board.js'),
      old: join(ctx, '.config', 'opencode', 'plugin', 'progress-pane.js'),
      edit: (text, remove) => (remove ? (text.trim() === '' ? null : DELETE) : opencodePlugin(ctx)),
    },
    ...boardCommands(ctx),
  ]
}

// OpenCode takes plugins, not commands: this one writes the session's last exchange into the
// inbox when the session goes idle (a subagent's session aside), and an end when it is
// deleted. Every export of a plugin file must be a function.
export const opencodePlugin = (ctx: ConnectContext): string => `// Written by the Agent Board plugin (/progress connect): reports each finished turn to the Agent Board
// pane.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const INBOX = ${JSON.stringify(ctx.inbox)}

const save = (event, payload) => {
  try {
    mkdirSync(INBOX, { recursive: true })
    const name = \`opencode-\${event}-\${Date.now()}-\${process.pid}\`
    writeFileSync(join(INBOX, name + '.tmp'), JSON.stringify(payload))
    renameSync(join(INBOX, name + '.tmp'), join(INBOX, name + '.json'))
  } catch {}
}

const textOf = message =>
  (message?.parts ?? [])
    .filter(part => part.type === 'text' && !part.synthetic && !part.ignored)
    .map(part => part.text)
    .join('\\n')

export const AgentBoard = async ({ client, directory }) => ({
  event: async ({ event }) => {
    try {
      if (event.type === 'session.idle') {
        const id = event.properties.sessionID
        const session = await client.session.get({ path: { id } })
        if (session.data?.parentID) return
        const listed = await client.session.messages({ path: { id } })
        const messages = listed.data ?? []
        const last = role => [...messages].reverse().find(message => message.info?.role === role)
        save('turn', { session_id: id, cwd: directory, prompt: textOf(last('user')), last_assistant_message: textOf(last('assistant')) })
      } else if (event.type === 'session.deleted') {
        const id = event.properties.info?.id
        if (id) save('end', { session_id: id, cwd: directory })
      }
    } catch {}
  },
})
`

const OPENCLAW_ID = 'agent-board'
const OPENCLAW_FILE = `${OPENCLAW_ID}.mjs`

// The first OpenClaw whose config check takes plugins.entries.<id>.hooks.allowConversationAccess
// (its changelog, #71221). An older one will not start with our entry in its config. Seen live
// on 2026.3.8, which also wants a manifest beside a plugin file; by that changelog, 2026.4.23
// asks for the grant before agent_end but still refuses the key.
export const OPENCLAW_MIN = '2026.4.24'

// A version the way OpenClaw reads one (2026.4.24, v2026.4.24, 2026.4.24-beta.1) as one number
// to compare; null when it is not one.
const calver = (version: string): number | null => {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())

  return parts === null ? null : Number(parts[1]) * 10000 + Number(parts[2]) * 100 + Number(parts[3])
}

// The version, when it is older than OPENCLAW_MIN; null when it is that or newer, or is not a
// version at all.
export const openclawTooOld = (version: string): string | null => {
  const at = calver(version)
  const min = calver(OPENCLAW_MIN)

  return at !== null && min !== null && at < min ? version.trim() : null
}

// The version that last saved an OpenClaw config (meta.lastTouchedVersion). Updating OpenClaw
// leaves it as it was until OpenClaw saves the file again.
export const openclawSavedBy = (text: string): string | null => {
  const config = readConfig(text)
  const version = config !== null && isRecord(config.meta) ? config.meta.lastTouchedVersion : undefined

  return typeof version === 'string' ? version : null
}

// The version `openclaw --version` prints: `OpenClaw 2026.3.8 (3caab92)`.
export const openclawPrinted = (stdout: string): string | null => /\bv?(\d+\.\d+\.\d+\S*)/.exec(stdout)?.[1] ?? null

const hasOpenclawPlugin = (config: Json, file: string): boolean => {
  const plugins = isRecord(config.plugins) ? config.plugins : {}
  const load = isRecord(plugins.load) ? plugins.load : {}
  const entries = isRecord(plugins.entries) ? plugins.entries : {}

  return (Array.isArray(load.paths) && load.paths.includes(file)) || OPENCLAW_ID in entries || (Array.isArray(plugins.allow) && plugins.allow.includes(OPENCLAW_ID))
}

// OpenClaw loads a plugin that is not bundled only when enabled, and passes it a turn's
// words (agent_end) only with allowConversationAccess. A restrictive plugins.allow list
// still wins, so ours joins it when there is one. OpenClaw writes this file as plain JSON;
// one hand-written as JSON5 is left alone.
export const withOpenclawPlugin = (config: Json, file: string): Json => {
  const plugins = isRecord(config.plugins) ? config.plugins : {}
  const load = isRecord(plugins.load) ? plugins.load : {}
  const paths = Array.isArray(load.paths) ? (load.paths as unknown[]) : []
  const entries = isRecord(plugins.entries) ? plugins.entries : {}
  const entry = isRecord(entries[OPENCLAW_ID]) ? (entries[OPENCLAW_ID] as Json) : {}
  const hooks = isRecord(entry.hooks) ? entry.hooks : {}
  const allow = Array.isArray(plugins.allow) && plugins.allow.length > 0 && !plugins.allow.includes(OPENCLAW_ID) ? { allow: [...plugins.allow, OPENCLAW_ID] } : {}

  return {
    ...config,
    plugins: {
      ...plugins,
      ...allow,
      load: { ...load, paths: paths.includes(file) ? paths : [...paths, file] },
      entries: { ...entries, [OPENCLAW_ID]: { ...entry, enabled: true, hooks: { ...hooks, allowConversationAccess: true } } },
    },
  }
}

export const withoutOpenclawPlugin = (config: Json, file: string): Json => {
  if (!isRecord(config.plugins)) return config
  const { load, entries, allow, ...rest } = config.plugins
  const plugins: Json = { ...rest }
  if (isRecord(load)) {
    const paths = Array.isArray(load.paths) ? (load.paths as unknown[]).filter(path => path !== file) : undefined
    const { paths: _, ...other } = load
    const kept = paths === undefined || paths.length === 0 ? other : { ...other, paths }
    if (Object.keys(kept).length > 0) plugins.load = kept
  } else if (load !== undefined) {
    plugins.load = load
  }
  if (isRecord(entries)) {
    const { [OPENCLAW_ID]: _, ...other } = entries
    if (Object.keys(other).length > 0) plugins.entries = other
  } else if (entries !== undefined) {
    plugins.entries = entries
  }
  if (Array.isArray(allow)) {
    const kept = allow.filter(id => id !== OPENCLAW_ID)
    if (kept.length > 0) plugins.allow = kept
  } else if (allow !== undefined) {
    plugins.allow = allow
  }

  return { ...config, plugins }
}

// Writes each finished turn into the inbox itself, as the OpenCode plugin does, so it needs
// no shell. Heartbeat and memory runs are OpenClaw talking to itself, not the person's work;
// a compaction or a restart does not end the session.
export const openclawPlugin = (ctx: ConnectContext): string => `// Written by the Agent Board plugin (/progress connect): reports each finished turn to the Agent Board
// pane.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const INBOX = ${JSON.stringify(ctx.inbox)}

const save = (event, payload) => {
  try {
    mkdirSync(INBOX, { recursive: true })
    const name = \`openclaw-\${event}-\${Date.now()}-\${process.pid}\`
    writeFileSync(join(INBOX, name + '.tmp'), JSON.stringify(payload))
    renameSync(join(INBOX, name + '.tmp'), join(INBOX, name + '.json'))
  } catch {}
}

const textOf = message =>
  typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.filter(part => part?.type === 'text').map(part => part.text).join('\\n')
      : ''

export default {
  id: '${OPENCLAW_ID}',
  name: 'Agent Board',
  register(api) {
    api.on('agent_end', (event, ctx) => {
      try {
        if (!ctx?.sessionId || ctx.trigger === 'heartbeat' || ctx.trigger === 'memory') return
        const messages = Array.isArray(event?.messages) ? event.messages : []
        const last = role => [...messages].reverse().find(message => message?.role === role)
        const answer = textOf(last('assistant'))
        if (answer.trim() === '') return
        save('turn', { session_id: ctx.sessionId, cwd: ctx.workspaceDir ?? '', prompt: textOf(last('user')), last_assistant_message: answer })
      } catch {}
    })
    api.on('session_end', (event, ctx) => {
      try {
        if (event?.reason === 'compaction' || event?.reason === 'restart') return
        const id = ctx?.sessionId ?? event?.sessionId
        if (id) save('end', { session_id: id, cwd: ctx?.workspaceDir ?? '' })
      } catch {}
    })
  },
}
`

// The standalone board, with the progress file and language of the session that wrote it
// set on its first line (an ES module's imports run first either way).
export const boardScript = (path: string, lang: string): string => `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang })}\n${BOARD_SCRIPT}`

// Each agent's way to show the board, so the person sees every agent's work from whichever
// one they are in. Gemini CLI and OpenCode paste a command's output into the prompt before
// the model reads it; the others read skills, whose model runs the command. Most of them
// read ~/.agents/skills, so one skill there reaches Codex, Cursor, Grok Build, OpenClaw,
// Gemini CLI and OpenCode; Hermes Agent and Antigravity keep their own folder.
const SKILL = 'agent-board'

export const boardCommands = (ctx: ConnectContext): AgentHook[] => {
  if (ctx.board === undefined) return []
  const s = ctx.s ?? ZH_TW
  const run = `node "${ctx.board}"`
  const file =
    (content: string) =>
    (text: string, remove: boolean): string | null | typeof DELETE =>
      remove ? (text.trim() === '' ? null : DELETE) : content
  // JSON is YAML too, so a description with a colon in it stays one value.
  const description = JSON.stringify(s.boardCommandDescription)
  const skill = `---\nname: ${SKILL}\ndescription: ${description}\n---\n\n${s.boardSkillPrompt(run)}\n`
  const gemini = `# Written by the Agent Board plugin (/progress connect).\ndescription = ${description}\nprompt = '''${s.boardCommandPrompt}\n\n!{${run}}\n'''\n`
  const opencode = `---\ndescription: ${description}\n---\n\n${s.boardCommandPrompt}\n\n!\`${run}\`\n`

  return [
    {
      agent: 'skills',
      label: '',
      dir: ctx.codexHome,
      dirs: [ctx.codexHome, join(ctx, '.cursor'), ...grokSigns(ctx), ctx.openclawHome, join(ctx, '.gemini'), join(ctx, '.config', 'opencode')],
      file: join(ctx, '.agents', 'skills', SKILL, 'SKILL.md'),
      edit: file(skill),
    },
    { agent: 'gemini', label: '', dir: join(ctx, '.gemini'), file: join(ctx, '.gemini', 'commands', 'board.toml'), edit: file(gemini) },
    { agent: 'opencode', label: '', dir: join(ctx, '.config', 'opencode'), file: join(ctx, '.config', 'opencode', 'commands', 'board.md'), edit: file(opencode) },
    { agent: 'hermes', label: '', dir: ctx.hermesHome, file: [ctx.hermesHome, 'skills', SKILL, 'SKILL.md'].join(ctx.sep), edit: file(skill) },
    {
      // Antigravity reads its skills here; it has no turn-end hook of its own, so it only shows
      // the board.
      agent: 'antigravity',
      label: '',
      dir: join(ctx, '.gemini', 'antigravity'),
      file: join(ctx, '.gemini', 'config', 'skills', SKILL, 'SKILL.md'),
      edit: file(skill),
    },
  ]
}
