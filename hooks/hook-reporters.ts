import { BOARD_REQUEST_HINTS, boardRequestWords, promptReceiptScript, RECEIPT_FOLDER_KEYS, RECEIPT_KEYS, RECEIPT_SESSION_KEYS } from './board-commands.ts'
import { HOOK_INPUT_TIMEOUT } from './hook-safety.ts'
import { ZH_TW } from './i18n.ts'
import { EN } from './strings-en.ts'
import { ZH_CN } from './strings-zh-cn.ts'

const PROMPT_RECEIPT_SCRIPT = promptReceiptScript(boardRequestWords([EN, ZH_TW, ZH_CN]))

const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`
const psQuote = (text: string): string => `'${text.replace(/'/g, "''")}'`
const windowsQuote = (text: string): string => `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
const PROMPT_FILE_SCRIPT = `process.argv[1] = require('node:fs').readFileSync(process.env.AGENT_BOARD_PROMPT_INPUT, 'utf8')\n${PROMPT_RECEIPT_SCRIPT}`
const SESSION_KEYS = RECEIPT_SESSION_KEYS
// A timed-out prompt is scanned for board words without its folder paths: a project
// folder named agent-board or dashboard is not a board request.
const PATH_KEYS = [...RECEIPT_FOLDER_KEYS, 'transcript_path', 'transcriptPath']
const SH_PATH_STRIP = String.raw`s/"(${PATH_KEYS.join('|')})"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"//g; s/"workspace_roots"[[:space:]]*:[[:space:]]*\[[^]]*]//g`
const PS_PATH_STRIP = String.raw`"(?:${PATH_KEYS.join('|')})"\s*:\s*"(?:[^"\\]|\\.)*"|"workspace_roots"\s*:\s*\[[^\]]*\]`

// Each board word as a case pattern in any letter case, e.g. *[Bb][Oo][Aa][Rr][Dd]*.
const SH_HINT_PATTERNS = BOARD_REQUEST_HINTS.map(hint => `*${[...hint].map(char => /[a-z]/i.test(char) ? `[${char.toUpperCase()}${char.toLowerCase()}]` : char).join('')}*`).join('|')

// The inbox holds at most this many turn files and bytes (#373). A reporter that finds it past
// either removes the oldest turn files, and adds one line to INBOX_DROPPED_FILE for each
// removal, `<UTC time> <count> <reason>` with the reason `age` or `cap`. That file is not
// `*.json`, so no reader takes it for a turn.
export const INBOX_MAX_FILES = 1000
export const INBOX_MAX_BYTES = 1.5 * 1024 * 1024
export const INBOX_DROPPED_FILE = 'dropped.log'
export const INBOX_DROPPED_FOLD_BYTES = 6144
export const INBOX_DROPPED_KEEP_DAYS = 8
// A copy of the count file a stopped writer left behind (`dropped.log.<digits>`), and how old it is
// before another writer claims it: a fold in progress is far younger.
export const INBOX_DROPPED_COPY = '^' + INBOX_DROPPED_FILE.replace(/\./g, '\\.') + '\\.[0-9]+$'
export const INBOX_DROPPED_STALE_MINUTES = 1

// POSIX hosts need only sh. MSYS uses the existing bounded Windows reporter:
// forking a watchdog after a native-pipe reader can itself stall before it runs.
// An interrupted read is never promoted from a temporary file.
export const reporterSh = (inbox: string): string => `#!/bin/sh
umask 077
exec 2>/dev/null
agent="\${1:-agent}"; event="\${2:-turn}"
[ $# -gt 0 ] && shift
[ $# -gt 0 ] && shift
case "$agent" in codex|cursor|gemini|grok|muse|hermes|openclaw|opencode|antigravity|deepseek) ;; *) agent=unknown ;; esac
case "$event" in prompt|turn|end) ;; *) event=unknown ;; esac
dir=${shellQuote(inbox)}
file="$dir/$agent-$event-$(date +%s)-$$"
reader=''; watcher=''; owned=''; timeout_owned=''; completion_owned=''; receipt_owned=''; fallback_owned=''; phase=INPUT_TIMEOUT
log_error() {
  logdir="$HOME/.agent-board"; log="$logdir/hook-errors.log"; temp="$log.$$.tmp"
  if mkdir -p "$logdir" && [ ! -L "$log" ] && { [ ! -e "$log" ] || [ -f "$log" ]; }; then
    if (set -C; : > "$temp"); then
      [ ! -f "$log" ] || tail -n 199 "$log" >> "$temp"
      printf '%s %s %s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$agent" "$event" "$1" >> "$temp"
      mv -f "$temp" "$log" || rm -f "$temp"
    fi
  fi
}
cleanup() {
  trap '' ALRM
  [ -z "$reader" ] || { kill -KILL "$reader"; wait "$reader"; }
  [ -z "$watcher" ] || { kill "$watcher"; wait "$watcher"; }
  [ -z "$owned" ] || rm -f "$file.tmp"
  [ -z "$timeout_owned" ] || rm -f "$file.timeout"
  [ -z "$completion_owned" ] || rm -f "$file.complete"
  [ -z "$receipt_owned" ] || rm -f "$file.receipt"
  [ -z "$fallback_owned" ] || rm -f "$file.fallback"
}
finish() { [ "$agent" != cursor ] || printf '{}\\n'; exit 0; }
write_fallback() {
  receipt='{'; separator=''; has_session=''
  # Escaped and non-ASCII values are omitted here; PowerShell preserves them. The first match
  # in the text is taken wherever it sits, so a key under extra can win over a top-level one.
  matches=$(LC_ALL=C grep -oE ${shellQuote(String.raw`"(${RECEIPT_KEYS.join('|')})"[[:space:]]*:[[:space:]]*"([][ !#-Z^-~]*")?`)} "$file.tmp")
  saved_ifs=$IFS; IFS='
'
  case $- in *f*) had_globbing_off=yes ;; *) had_globbing_off='' ;; esac
  set -f
  for receipt_key in ${RECEIPT_KEYS.join(' ')}; do
    value=''; has_key=''
    for pair in $matches; do
      case "$pair" in \\"$receipt_key\\"*) ;; *) continue ;; esac
      has_key=yes
      candidate=\${pair#*:}
      candidate=\${candidate#"\${candidate%%[![:space:]]*}"}
      case "$candidate" in \\"*\\")
        if [ "\${#candidate}" -ge 2 ]; then value=$candidate; break; fi ;;
      esac
    done
    if [ -n "$value" ]; then
      receipt="$receipt$separator\\"$receipt_key\\":$value"; separator=','
      case "$receipt_key" in ${SESSION_KEYS.join('|')}) has_session=yes ;; esac
    elif [ "$receipt_key" = workspaceRoot ] && [ -n "$has_key" ]; then
      # The inbox tells Grok from Cursor by a workspaceRoot field, so keep the field without its value.
      receipt="$receipt$separator\\"workspaceRoot\\":\\"\\""; separator=','
    fi
  done
  IFS=$saved_ifs
  [ -n "$had_globbing_off" ] || set +f
  [ -n "$has_session" ] || return
  scan=$(LC_ALL=C sed -E ${shellQuote(SH_PATH_STRIP)} "$file.tmp") || scan=$(cat "$file.tmp")
  # An empty scan (sed and cat both failed) counts as a board request: a wrong mark only leaves a question waiting.
  case "$scan" in ''|${SH_HINT_PATTERNS}) receipt="$receipt$separator\\"board_request\\":true" ;; esac
  if (set -C; : > "$file.fallback"); then
    fallback_owned=yes
    printf '%s}' "$receipt" > "$file.fallback" && mv "$file.fallback" "$file.json" || log_error REPORTER_FAILED
  else log_error REPORTER_FAILED
  fi
}
timed_out() {
  trap '' ALRM
  if [ "$phase" = REPORTER_TIMEOUT ]; then write_fallback; fi
  log_error "$phase"; finish
}
trap cleanup 0
trap 'log_error REPORTER_INTERRUPTED; finish' 1 2 15
trap timed_out ALRM
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    AGENT_BOARD_SH_AGENT="$agent" AGENT_BOARD_SH_EVENT="$event" AGENT_BOARD_SH_PAYLOAD="\${1-}" AGENT_BOARD_SH_INBOX="$dir" powershell.exe -NoLogo -NoProfile -NonInteractive -Command ${shellQuote(powershellReporter(true))}
    [ "$?" = 0 ] && exit 0
    log_error REPORTER_FAILED; finish ;;
esac
if ! mkdir -p "$dir" || ! (set -C; : > "$file.tmp"); then log_error REPORTER_FAILED; finish; fi
owned=yes
if ! (set -C; : > "$file.timeout"); then log_error REPORTER_FAILED; finish; fi
timeout_owned=yes
if ! (set -C; : > "$file.complete"); then log_error REPORTER_FAILED; finish; fi
completion_owned=yes
# One watchdog owns the whole read/classify budget. A completion marker also
# covers a stop signal lost before the watchdog's trap is installed. Only this
# shell's children are killed, never a process group.
(
  sleeper=''; stopped=''
  trap 'stopped=yes; [ -z "$sleeper" ] || { kill -KILL "$sleeper"; wait "$sleeper"; exit 0; }' 1 2 15
  sleep ${HOOK_INPUT_TIMEOUT / 1000} &
  sleeper=$!
  if [ -n "$stopped" ] || [ -s "$file.complete" ]; then kill -KILL "$sleeper"; wait "$sleeper"; exit 0; fi
  wait "$sleeper" || exit 0
  sleeper=''
  [ ! -s "$file.complete" ] || exit 0
  printf '1' > "$file.timeout"
  kill -ALRM "$$"
) &
watcher=$!
if [ $# -gt 0 ]; then
  printf '%s' "$1" > "$file.tmp" || { log_error REPORTER_FAILED; finish; }
elif [ ! -t 0 ]; then
  # A non-interactive shell gives background jobs /dev/null on fd 0.
  exec 3<&0
  cat <&3 3<&- > "$file.tmp" &
  reader=$!
  exec 3<&-
  wait "$reader"; status=$?; reader=''
  if [ -s "$file.timeout" ]; then timed_out; fi
  if [ "$status" != 0 ]; then log_error REPORTER_FAILED; finish; fi
fi
ready="$file.tmp"
if [ -s "$file.tmp" ] && [ "$event" = prompt ]; then
  phase=REPORTER_TIMEOUT
  if ! (set -C; : > "$file.receipt"); then log_error REPORTER_FAILED; finish; fi
  receipt_owned=yes
  node -e ${shellQuote(PROMPT_RECEIPT_SCRIPT)} < "$file.tmp" > "$file.receipt" &
  reader=$!
  wait "$reader"; status=$?; reader=''
  if [ -s "$file.timeout" ]; then timed_out; fi
  # Missing, failed or empty classifiers keep the compatibility receipt. A
  # timed-out classifier must never turn its unfinished input into a receipt.
  if [ "$status" = 0 ] && [ -n "$(cat "$file.receipt")" ]; then ready="$file.receipt"; fi
fi
if [ -s "$file.timeout" ]; then timed_out; fi
printf '1' > "$file.complete" || { log_error REPORTER_FAILED; finish; }
kill "$watcher"; wait "$watcher"; watcher=''
if [ -s "$file.timeout" ]; then timed_out; fi
if [ -s "$ready" ]; then
  mv "$ready" "$file.json" || { log_error REPORTER_FAILED; finish; }
else log_error INCOMPLETE_INPUT
fi
# Names first, so GNU find need not look at a taken file that another session renames mid-scan.
# One that still goes between the listing and find's look at it (BSD find looks at every entry)
# gives "No such file or directory", which is no failure. Any other complaint is logged, and so is
# a failure with none. A reporter's scratch files go a minute after they were last written.
sweep_errors=$(LC_ALL=C find "$dir/." ! -name . -prune \\( -name '*.tmp' -o -name '*.receipt' -o -name '*.fallback' -o -name '*.timeout' -o -name '*.complete' \\) -type f -mmin +1 -exec rm -f {} + 2>&1 >/dev/null)
sweep_status=$?
if [ "$sweep_status" -ne 0 ] && { [ -z "$sweep_errors" ] || printf '%s\\n' "$sweep_errors" | grep -qv 'No such file or directory'; }; then log_error CLEANUP_FAILED; fi
# A turn file over 2 days old goes, and so do the oldest past ${INBOX_MAX_FILES} files or ${INBOX_MAX_BYTES} bytes.
# Only *.json turn files, each removal counted in ${INBOX_DROPPED_FILE}: a taken or failed file stays.
drop_turns() {
  drop_n=0
  drop_failed=''
  while read -r drop_entry; do
    if drop_error=$(LC_ALL=C rm "$drop_entry" 2>&1); then
      drop_n=$((drop_n + 1))
    else
      case "$drop_error" in *'No such file or directory'*) ;; *) drop_failed=1 ;; esac
    fi
  done
  [ -z "$drop_failed" ] || log_error CLEANUP_FAILED
  [ "$drop_n" -gt 0 ] || return 0
  drop_log="$dir/${INBOX_DROPPED_FILE}"; drop_aside="$drop_log.$$"
  printf '%s %s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$drop_n" "$1" >> "$drop_log"
  # Claim only old, unclaimed copies left by a stopped writer. One that cannot be added back goes
  # back under its own name, for the next writer to claim.
  for drop_copy in "$dir"/${INBOX_DROPPED_FILE}.*; do
    [ -f "$drop_copy" ] && [ "$drop_copy" != "$drop_aside" ] || continue
    drop_suffix=\${drop_copy##*/${INBOX_DROPPED_FILE}.}
    case "$drop_suffix" in ''|*[!0-9]*) continue ;; esac
    [ -n "$(find "$drop_copy" -mmin +${INBOX_DROPPED_STALE_MINUTES})" ] || continue
    mv "$drop_copy" "$drop_copy.$$" || continue
    { cat "$drop_copy.$$" >> "$drop_log" && rm -f "$drop_copy.$$"; } || mv "$drop_copy.$$" "$drop_copy"
  done
  # Fold counts by UTC day and reason, keeping ${INBOX_DROPPED_KEEP_DAYS} days back.
  # A copy left under this process id by an earlier one waits to be claimed; this fold waits too.
  if [ -n "$(find "$drop_log" -size +${INBOX_DROPPED_FOLD_BYTES}c)" ] && [ ! -e "$drop_aside" ] && mv "$drop_log" "$drop_aside"; then
    drop_secs=$(($(date -u +%s) - ${INBOX_DROPPED_KEEP_DAYS * 86400}))
    drop_day=$(date -u -d "@$drop_secs" +%Y-%m-%d 2>/dev/null) || drop_day=$(date -u -r "$drop_secs" +%Y-%m-%d 2>/dev/null) || drop_day=''
    LC_ALL=C awk -v cutoff="$drop_day" '
      { sub(/\\r$/, "") }
      /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z [0-9]+ (age|cap)$/ {
        day = substr($1, 1, 10)
        if (cutoff == "" || day >= cutoff) sums[day " " $3] += $2
      }
      END { for (key in sums) { split(key, parts, " "); printf "%sT00:00:00Z %.0f %s\\n", parts[1], sums[key], parts[2] } }
    ' "$drop_aside" > "$drop_aside.sum" && LC_ALL=C sort -k1,1 -k3,3 "$drop_aside.sum" >> "$drop_log" && rm -f "$drop_aside" "$drop_aside.sum" || rm -f "$drop_aside.sum"
  fi
}
saved=$(basename "$file.json")
LC_ALL=C find "$dir/." ! -name . -prune -name '*.json' ! -name "$saved" -type f -mtime +2 | drop_turns age
LC_ALL=C ls -ltr "$dir" | awk -v dir="$dir" -v saved="$saved" -v files=${INBOX_MAX_FILES} -v bytes=${INBOX_MAX_BYTES} '
  substr($1, 1, 1) == "-" && $NF ~ /^[a-z][a-z0-9]*-(prompt|turn|end)-[A-Za-z0-9_.-]+[.]json$/ { n++; name[n] = $NF; size[n] = $5; total++; sum += $5 }
  END { for (i = 1; i <= n && (total > files || sum > bytes); i++) { if (name[i] == saved) continue; print dir "/" name[i]; total--; sum -= size[i] } }' | drop_turns cap
finish
`

// Keep paths out of the source: Windows PowerShell5.1 can read a BOM-free script
// using the system code page. The actual inbox is beside this installed script.
export const powershellReporter = (fromShell: boolean): string => `# Written by the Agent Board plugin (/progress connect).
${fromShell ? "$Agent = [string]$env:AGENT_BOARD_SH_AGENT; $Event = [string]$env:AGENT_BOARD_SH_EVENT; $Payload = [string]$env:AGENT_BOARD_SH_PAYLOAD" : "param([string]$Agent = 'agent', [string]$Event = 'turn', [string]$Payload = '')"}
$ErrorActionPreference = 'Stop'
if ($Agent -notin @('codex','cursor','gemini','grok','muse','hermes','openclaw','opencode','antigravity','deepseek')) { $Agent = 'unknown' }
if ($Event -notin @('prompt','turn','end')) { $Event = 'unknown' }
$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
function Write-Exclusive([string]$File, [string]$Text) {
  $stream = [IO.File]::Open($File, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $complete = $false
  try { $bytes = [Text.Encoding]::UTF8.GetBytes($Text); $stream.Write($bytes, 0, $bytes.Length); $complete = $true }
  finally { $stream.Dispose(); if (-not $complete) { Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue } }
}
function Write-HookError([string]$Code) {
  $temp = ''; $ownsTemp = $false
  try {
    $logDir = Join-Path $homeDir '.agent-board'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $log = Join-Path $logDir 'hook-errors.log'
    $lines = @()
    if (Test-Path -LiteralPath $log) {
      $item = Get-Item -LiteralPath $log -Force
      if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'UNSAFE_LOG' }
      $lines = @(Get-Content -LiteralPath $log -Encoding UTF8 -Tail 199)
    }
    $lines += ('{0} {1} {2} {3}' -f [DateTime]::UtcNow.ToString('o'), $Agent, $Event, $Code)
    $temp = $log + '.' + $PID + '.tmp'
    Write-Exclusive $temp (($lines -join [char]10) + [char]10)
    $ownsTemp = $true
    Move-Item -LiteralPath $temp -Destination $log -Force
    $ownsTemp = $false
    try {
      $cutoff = (Get-Date).AddSeconds(-60)
      Get-ChildItem -LiteralPath $logDir -Filter 'hook-errors.log.*.tmp' | Where-Object {
        $_.Name -match '^hook-errors\\.log\\.\\d+\\.tmp$' -and -not $_.PSIsContainer -and
        -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $_.LastWriteTime -lt $cutoff
      } | Remove-Item -Force
    } catch {}
  } catch { [Console]::Error.WriteLine('AGENT_BOARD_HOOK_LOG_FAILED') }
  finally { if ($ownsTemp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue } }
}
# The classifier gets only a completed file. Redirected streams are drained
# asynchronously so a full pipe or a hung executable cannot escape the budget.
function Read-PromptReceipt([string]$File, [Diagnostics.Stopwatch]$Clock) {
  $process = $null; $isStarted = $false
  try {
    if ($Clock.ElapsedMilliseconds -ge ${HOOK_INPUT_TIMEOUT}) { throw 'REPORTER_TIMEOUT' }
    $start = New-Object Diagnostics.ProcessStartInfo
    # Get-Command searches every module before it reports a missing command, which can
    # take more than a second of the budget; a plain walk of PATH and PATHEXT finds the
    # same file. Only absolute folders count, so an empty or relative entry never makes
    # the walk look in the project folder. FileName needs one path, never an array.
    $node = $null
    $extensions = ([string]$env:PATHEXT).Split([char]59) | Where-Object { $_ -ne '' }
    if (-not $extensions) { $extensions = @('.COM', '.EXE', '.BAT', '.CMD') }
    foreach ($folder in ([string]$env:PATH).Split([char]59)) {
      if ($Clock.ElapsedMilliseconds -ge ${HOOK_INPUT_TIMEOUT}) { throw 'REPORTER_TIMEOUT' }
      $folderPath = $folder.Trim().Trim([char]34)
      if ($folderPath -eq '') { continue }
      try { if (-not [IO.Path]::IsPathRooted($folderPath) -or -not [IO.Directory]::Exists($folderPath)) { continue } } catch { continue }
      foreach ($extension in $extensions) {
        try { $candidate = [IO.Path]::Combine($folderPath, 'node' + $extension) } catch { continue }
        if ([IO.File]::Exists($candidate)) { $node = $candidate; break }
      }
      if ($null -ne $node) { break }
    }
    if ($null -eq $node) { return '' }
    $start.FileName = $node
    $start.Arguments = ${psQuote('-e ' + windowsQuote(PROMPT_FILE_SCRIPT))}
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['AGENT_BOARD_PROMPT_INPUT'] = $File
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    $isStarted = $process.Start()
    if (-not $isStarted) { return '' }
    $process.StandardInput.Close()
    $output = $process.StandardOutput.ReadToEndAsync()
    $errors = $process.StandardError.ReadToEndAsync()
    $remaining = ${HOOK_INPUT_TIMEOUT} - [int]$Clock.ElapsedMilliseconds
    if ($remaining -le 0 -or -not $process.WaitForExit($remaining)) { throw 'REPORTER_TIMEOUT' }
    $remaining = ${HOOK_INPUT_TIMEOUT} - [int]$Clock.ElapsedMilliseconds
    if ($remaining -le 0 -or -not $output.Wait($remaining)) { throw 'REPORTER_TIMEOUT' }
    $remaining = ${HOOK_INPUT_TIMEOUT} - [int]$Clock.ElapsedMilliseconds
    if ($remaining -le 0 -or -not $errors.Wait($remaining)) { throw 'REPORTER_TIMEOUT' }
    if ($process.ExitCode -eq 0) { return $output.Result.Trim() }
    return ''
  } catch {
    if ($_.Exception.Message -eq 'REPORTER_TIMEOUT') { throw }
    return ''
  } finally {
    if ($null -ne $process) {
      if ($isStarted) {
        try { if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(100) } } catch {}
      }
      $process.Dispose()
    }
  }
}
$tmp = ''; $ownsTemp = $false; $receiptTmp = ''; $ownsReceipt = $false
$fallback = ''; $fallbackTmp = ''; $ownsFallback = $false; $hasFallbackFailure = $false
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
  if ($Payload -eq '' -and [Console]::IsInputRedirected) {
    $inputStream = [Console]::OpenStandardInput()
    $memory = [IO.MemoryStream]::new()
    $buffer = [byte[]]::new(65536)
    while ($true) {
      $remaining = ${HOOK_INPUT_TIMEOUT} - [int]$clock.ElapsedMilliseconds
      if ($remaining -le 0) { throw 'INPUT_TIMEOUT' }
      $read = $inputStream.ReadAsync($buffer, 0, $buffer.Length)
      if (-not $read.Wait($remaining)) { throw 'INPUT_TIMEOUT' }
      if ($read.Result -eq 0) { break }
      $memory.Write($buffer, 0, $read.Result)
      if ($memory.Length -gt 1048576) { throw 'INPUT_TOO_LARGE' }
    }
    $Payload = [Text.Encoding]::UTF8.GetString($memory.ToArray()).TrimStart([char]0xFEFF)
    $memory.Dispose()
  }
  if ($Payload.Trim() -eq '') { throw 'INCOMPLETE_INPUT' }
  if ([Text.Encoding]::UTF8.GetByteCount($Payload) -gt 1048576) { throw 'INPUT_TOO_LARGE' }
  try { $raw = ConvertFrom-Json -InputObject $Payload } catch { throw 'INCOMPLETE_INPUT' }
  if ($Event -eq 'prompt') {
    # Only the timeout fallback reads this; a failure here must not lose a prompt the classifier would handle.
    try {
      $metadata = New-Object Collections.Specialized.OrderedDictionary ([StringComparer]::Ordinal)
      $extra = $raw.PSObject.Properties['extra']
      if ($null -ne $extra -and -not ($extra.Name -ceq 'extra')) { $extra = $null }
      foreach ($key in @(${RECEIPT_KEYS.map(psQuote).join(',')},'workspace_roots')) {
        $property = $raw.PSObject.Properties[$key]
        if ($null -ne $property -and -not ($property.Name -ceq $key)) { $property = $null }
        if ($null -eq $property -and $null -ne $extra -and $null -ne $extra.Value) {
          $property = $extra.Value.PSObject.Properties[$key]
          if ($null -ne $property -and -not ($property.Name -ceq $key)) { $property = $null }
        }
        if ($null -eq $property) { continue }
        $value = $property.Value
        if ($key -ceq 'workspace_roots') {
          if ($value -is [array]) { $metadata[$key] = @($value | Where-Object { $_ -is [string] }) }
        } elseif ($value -is [string]) { $metadata[$key] = $value }
      }
      $hasSession = $false
      foreach ($key in @(${SESSION_KEYS.map(psQuote).join(',')})) { if ($metadata.Contains($key)) { $hasSession = $true } }
      if ($hasSession) {
        $scan = [regex]::Replace($Payload, ${psQuote(PS_PATH_STRIP)}, '')
        if (${BOARD_REQUEST_HINTS.map(hint => `$scan.IndexOf(${psQuote(hint)}, [StringComparison]::OrdinalIgnoreCase) -ge 0`).join(' -or ')}) { $metadata['board_request'] = $true }
        $json = ConvertTo-Json -InputObject $metadata -Compress -Depth 4
        $fallback = [regex]::Replace($json, '[^\\x20-\\x7e]', { param($match) '\\u' + ([int][char]$match.Value).ToString('x4') })
      }
    } catch { $fallback = ''; $hasFallbackFailure = $raw -is [Management.Automation.PSCustomObject] }
  }
  $dir = ${fromShell ? '$env:AGENT_BOARD_SH_INBOX' : "Join-Path $PSScriptRoot 'progress-inbox'"}
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $name = '{0}-{1}-{2}-{3}' -f $Agent, $Event, [DateTimeOffset]::Now.ToUnixTimeMilliseconds(), $PID
  $tmp = Join-Path $dir ($name + '.tmp')
  Write-Exclusive $tmp $Payload
  $ownsTemp = $true
  $ready = $tmp
  if ($Event -eq 'prompt') {
    $receipt = Read-PromptReceipt $tmp $clock
    if ($clock.ElapsedMilliseconds -ge ${HOOK_INPUT_TIMEOUT}) { throw 'REPORTER_TIMEOUT' }
    if ($receipt -ne '') {
      $receiptTmp = Join-Path $dir ($name + '.receipt')
      Write-Exclusive $receiptTmp $receipt
      $ownsReceipt = $true
      $ready = $receiptTmp
    }
  }
  Move-Item -LiteralPath $ready -Destination (Join-Path $dir ($name + '.json'))
  if ($ready -eq $tmp) { $ownsTemp = $false } else { $ownsReceipt = $false }
  # The receipt is saved: a file that cannot be removed is only a cleanup failure, and one another reporter removed first is none.
  try {
    $scratchCutoff = (Get-Date).AddMinutes(-1)
    Get-ChildItem -LiteralPath $dir -File | Where-Object {
      $_.Extension -in @('.tmp', '.receipt', '.fallback', '.timeout', '.complete') -and $_.LastWriteTime -lt $scratchCutoff
    } | Remove-Item -Force -ErrorAction SilentlyContinue -ErrorVariable cleanupErrors
    if (@($cleanupErrors | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' }).Count -gt 0) { Write-HookError 'CLEANUP_FAILED' }
    # A turn file over 2 days old goes, and so do the oldest past ${INBOX_MAX_FILES} files or ${INBOX_MAX_BYTES} bytes.
    # Only *.json turn files, each removal counted in ${INBOX_DROPPED_FILE}: a taken or failed file stays.
    $droppedLog = Join-Path $dir '${INBOX_DROPPED_FILE}'
    function Remove-Turns([object[]]$Old, [string]$Reason) {
      $count = 0
      $cleanupFailed = $false
      foreach ($turn in $Old) {
        try { Remove-Item -LiteralPath $turn.FullName -Force -ErrorAction Stop; $count++ }
        catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound' -and $_.Exception -isnot [System.Management.Automation.ItemNotFoundException]) { $cleanupFailed = $true } }
      }
      if ($cleanupFailed) { Write-HookError 'CLEANUP_FAILED' }
      if ($count -eq 0) { return }
      $line = ('{0} {1} {2}' -f [DateTime]::UtcNow.ToString('yyyy-MM-dd\\THH:mm:ss\\Z', [Globalization.CultureInfo]::InvariantCulture), $count, $Reason) + [char]10
      # Another reporter adding its line holds the file for a moment: try again.
      for ($try = 0; $try -lt 20; $try++) { try { [IO.File]::AppendAllText($droppedLog, $line); break } catch { Start-Sleep -Milliseconds 25 } }
      $aside = $droppedLog + '.' + $PID
      # Claim only old, unclaimed copies left by a stopped writer. One that cannot be added back goes
      # back under its own name, for the next writer to claim.
      foreach ($copy in @(Get-ChildItem -LiteralPath $dir -File -Filter '${INBOX_DROPPED_FILE}.*')) {
        try {
          if ($copy.FullName -eq $aside -or $copy.Name -cnotmatch '${INBOX_DROPPED_COPY}' -or $copy.LastWriteTimeUtc -ge [DateTime]::UtcNow.AddMinutes(-${INBOX_DROPPED_STALE_MINUTES})) { continue }
          $claimed = $copy.FullName + '.' + $PID
          Move-Item -LiteralPath $copy.FullName -Destination $claimed
          $isAdded = $false
          for ($try = 0; $try -lt 20; $try++) { try { [IO.File]::AppendAllText($droppedLog, [IO.File]::ReadAllText($claimed)); $isAdded = $true; break } catch { Start-Sleep -Milliseconds 25 } }
          if ($isAdded) { Remove-Item -LiteralPath $claimed -Force } else { Move-Item -LiteralPath $claimed -Destination $copy.FullName }
        } catch {}
      }
      # Fold counts by UTC day and reason, keeping ${INBOX_DROPPED_KEEP_DAYS} days back.
      try {
        if ((Get-Item -LiteralPath $droppedLog).Length -gt ${INBOX_DROPPED_FOLD_BYTES}) {
          Move-Item -LiteralPath $droppedLog -Destination $aside
          $cutoff = [DateTime]::UtcNow.AddDays(-${INBOX_DROPPED_KEEP_DAYS}).ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
          $counts = @{}
          foreach ($entry in @(Get-Content -LiteralPath $aside -Encoding UTF8)) {
            if ($entry -cmatch '^([0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z ([0-9]+) (age|cap)\\r?$' -and [string]::CompareOrdinal($Matches[1], $cutoff) -ge 0) {
              $key = $Matches[1] + ' ' + $Matches[3]
              $counts[$key] = [long]$counts[$key] + [long]$Matches[2]
            }
          }
          $folded = foreach ($key in @($counts.Keys | Sort-Object)) { '{0}T00:00:00Z {1} {2}' -f $key.Substring(0, 10), $counts[$key], $key.Substring(11) }
          $isAppended = @($folded).Count -eq 0
          if (!$isAppended) {
            for ($try = 0; $try -lt 20; $try++) { try { [IO.File]::AppendAllText($droppedLog, (@($folded) -join [char]10) + [char]10); $isAppended = $true; break } catch { Start-Sleep -Milliseconds 25 } }
          }
          if ($isAppended) { Remove-Item -LiteralPath $aside -Force }
        }
      } catch {}
    }
    Remove-Turns @(Get-ChildItem -LiteralPath $dir -File -Filter '*.json' | Where-Object { $_.Name -cne ($name + '.json') -and $_.LastWriteTime -lt (Get-Date).AddDays(-2) }) 'age'
    $turns = @(Get-ChildItem -LiteralPath $dir -File -Filter '*.json' | Where-Object { $_.Name -cmatch '^[a-z][a-z0-9]*-(prompt|turn|end)-[A-Za-z0-9_.-]+\\.json$' } | Sort-Object LastWriteTimeUtc)
    $turnCount = $turns.Count; $turnBytes = [long](($turns | Measure-Object -Property Length -Sum).Sum)
    $over = @()
    foreach ($turn in $turns) {
      if ($turnCount -le ${INBOX_MAX_FILES} -and $turnBytes -le ${INBOX_MAX_BYTES}) { break }
      if ($turn.Name -ceq ($name + '.json')) { continue }
      $over += $turn; $turnCount--; $turnBytes -= $turn.Length
    }
    Remove-Turns $over 'cap'
  } catch { Write-HookError 'CLEANUP_FAILED' }
} catch {
  $code = switch ($_.Exception.Message) { 'INPUT_TIMEOUT' { 'INPUT_TIMEOUT' }; 'REPORTER_TIMEOUT' { 'REPORTER_TIMEOUT' }; 'INPUT_TOO_LARGE' { 'INPUT_TOO_LARGE' }; 'INCOMPLETE_INPUT' { 'INCOMPLETE_INPUT' }; default { 'REPORTER_FAILED' } }
  if ($code -eq 'REPORTER_TIMEOUT' -and $hasFallbackFailure) { Write-HookError 'REPORTER_FAILED' }
  if ($code -eq 'REPORTER_TIMEOUT' -and $fallback -ne '') {
    try {
      $fallbackTmp = Join-Path $dir ($name + '.fallback')
      Write-Exclusive $fallbackTmp $fallback
      $ownsFallback = $true
      Move-Item -LiteralPath $fallbackTmp -Destination (Join-Path $dir ($name + '.json'))
      $ownsFallback = $false
    } catch {
      if ($ownsFallback) { Remove-Item -LiteralPath $fallbackTmp -Force -ErrorAction SilentlyContinue; $ownsFallback = $false }
      Write-HookError 'REPORTER_FAILED'
    }
  }
  Write-HookError $code
} finally {
  if ($ownsTemp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  if ($ownsReceipt) { Remove-Item -LiteralPath $receiptTmp -Force -ErrorAction SilentlyContinue }
  if ($ownsFallback) { Remove-Item -LiteralPath $fallbackTmp -Force -ErrorAction SilentlyContinue }
}
if ($Agent -eq 'cursor') { '{}' }
exit 0
`

export const reporterPs1 = (): string => powershellReporter(false)
