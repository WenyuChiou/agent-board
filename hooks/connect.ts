// The reporter script an agent's hook runs, written beside progress.md by `/progress
// connect`: it saves what the hook hands over into the inbox, clears files older than two
// days and prints {} for hooks that read their command's output. No dependencies: POSIX sh
// on macOS and Linux, Windows PowerShell 5.1 on Windows.

// Arguments: the agent's name, `turn` or `end`, then (Codex's notify) the JSON itself.
export const reporterSh = (inbox: string): string => `#!/bin/sh
# Written by the project-progress plugin (/progress connect). An agent's hook runs it at the
# end of a turn or a session; the progress pane reads what it saves.
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
find "$dir" -name '*.json' -mtime +2 -exec rm -f {} + 2>/dev/null
printf '{}\\n'
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
'{}'
exit 0
`

export const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

export const psQuote = (text: string): string => `'${text.replace(/'/g, "''")}'`

// The command line a hook runs for one agent and event.
export const reportCommand = (script: string, agent: string, event: 'turn' | 'end', isWindows: boolean): string =>
  isWindows
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" ${agent} ${event}`
    : `sh ${shellQuote(script)} ${agent} ${event}`

// The same as an argv list, for config that takes one (Codex's notify).
export const reportArgv = (script: string, agent: string, event: 'turn' | 'end', isWindows: boolean): string[] =>
  isWindows
    ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, agent, event]
    : ['sh', script, agent, event]

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
export const withGroupedHook = (config: Json, event: string, command: string, matcher?: string): Json => {
  const hooks = isRecord(config.hooks) ? config.hooks : {}
  const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
  const kept = groups.filter(group => !(isRecord(group) && Array.isArray(group.hooks) && group.hooks.some(one => OURS.test(commandOf(one)))))
  const ours = { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command }] }

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

export const hasOurHook = (config: Json): boolean => JSON.stringify(config.hooks ?? {}).match(OURS) !== null

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
