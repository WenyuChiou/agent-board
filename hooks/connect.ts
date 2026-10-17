// The reporter script an agent's hook runs, written beside progress.md by `/progress
// connect`: it saves what the hook hands over into the inbox and clears files older than two
// days. No dependencies: POSIX sh on macOS and Linux, Windows PowerShell 5.1 on Windows.

// Arguments: the agent's name, `turn` or `end`, then optionally the JSON itself (as Codex's
// legacy notify passes it) instead of on stdin.
export const reporterSh = (inbox: string): string => `#!/bin/sh
# Written by the project-progress plugin (/progress connect). An agent's hook runs it at the
# end of a turn or a session; the progress pane reads what it saves.
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

export const reporterPs1 = (inbox: string): string => `# Written by the project-progress plugin (/progress connect). An agent's hook runs it at the
# end of a turn or a session; the progress pane reads what it saves.
param([string]$Agent = 'agent', [string]$Event = 'turn', [string]$Payload = '')
$ErrorActionPreference = 'SilentlyContinue'
$dir = ${psQuote(inbox)}
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

// The command line a hook runs for one agent and event.
export const reportCommand = (script: string, agent: string, event: 'turn' | 'end', isWindows: boolean): string =>
  isWindows
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" ${agent} ${event}`
    : `sh ${shellQuote(script)} ${agent} ${event}`

// A hook command this plugin wrote: it names the reporter script.
const OURS = /progress-report\.(?:sh|ps1)/

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

// A config file read as JSON: `{}` when it is missing or empty, null when it holds
// something that is not a JSON object (comments, a typo), which is then left alone.
export const readConfig = (text: string): Json | null => {
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const writeConfig = (config: Json): string => `${JSON.stringify(config, null, 2)}\n`

// The section setup --agents puts in an agent's instruction file. A hook replaces it, so the
// agent's work does not show twice.
const SECTION = /\n*<!-- claude-progress-pane:start -->[\s\S]*?<!-- claude-progress-pane:end -->\n*/

export const withoutSection = (text: string): string => (SECTION.test(text) ? text.replace(SECTION, '\n').replace(/^\n+/, '') : text)

// Where each agent keeps what `/progress connect` changes, and how. `dir` says the agent is
// installed (its folder under the home directory); `edit` turns the file's text into the
// new text, or null when the file cannot be read as JSON and is left alone.
export type ConnectContext = { home: string; sep: string; isWindows: boolean; script: string; inbox: string; codexHome: string; grokHome: string }

export type AgentHook = {
  agent: string
  label: string
  dir: string
  file: string
  edit: (text: string, remove: boolean) => string | null | typeof DELETE
}

// What `edit` answers for a file of ours that removing takes away whole.
export const DELETE = Symbol('delete')

const join = (ctx: ConnectContext, ...parts: string[]): string => [ctx.home, ...parts].join(ctx.sep)

const jsonEdit =
  (add: (config: Json) => Json) =>
  (text: string, remove: boolean): string | null => {
    const config = readConfig(text)
    if (config === null) return null
    return writeConfig(remove ? withoutOurHooks(config) : add(withoutOurHooks(config)))
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
          withGroupedHook(config, 'AfterAgent', turn('gemini'), { name: 'progress-pane', timeout: 5000 }),
          'SessionEnd',
          end('gemini'),
          { name: 'progress-pane-end', timeout: 5000 },
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
      // A file of its own in ~/.grok/hooks; Stop carries lastAssistantMessage. Timeout in s.
      agent: 'grok',
      label: 'Grok Build',
      dir: ctx.grokHome,
      file: [ctx.grokHome, 'hooks', 'progress-pane.json'].join(ctx.sep),
      edit: (text, remove) =>
        remove
          ? text.trim() === ''
            ? null
            : DELETE
          : writeConfig(withGroupedHook(withGroupedHook({}, 'Stop', turn('grok'), { timeout: 10 }), 'SessionEnd', end('grok'), { timeout: 1 })),
    },
    {
      // Muse wants schema_version 1 and no handler keys beyond type, command, timeout.
      agent: 'muse',
      label: 'Muse Code',
      dir: join(ctx, '.config', 'muse'),
      file: join(ctx, '.config', 'muse', 'settings.json'),
      edit: jsonEdit(config =>
        withGroupedHook(withGroupedHook({ schema_version: 1, ...config }, 'Stop', turn('muse'), { timeout: 10 }), 'SessionEnd', end('muse'), {
          timeout: 1,
        }),
      ),
    },
    {
      agent: 'opencode',
      label: 'OpenCode',
      dir: join(ctx, '.config', 'opencode'),
      file: join(ctx, '.config', 'opencode', 'plugin', 'progress-pane.js'),
      edit: (text, remove) => (remove ? (text.trim() === '' ? null : DELETE) : opencodePlugin(ctx)),
    },
  ]
}

// OpenCode takes plugins, not commands: this one writes the session's last exchange into the
// inbox when the session goes idle (a subagent's session aside), and an end when it is
// deleted. Every export of a plugin file must be a function.
export const opencodePlugin = (ctx: ConnectContext): string => `// Written by the project-progress plugin (/progress connect): reports each finished turn to
// the progress pane.
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

export const ProgressPane = async ({ client, directory }) => ({
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
