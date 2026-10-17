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
