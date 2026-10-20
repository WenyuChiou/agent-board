import { boardRequestWords, promptReceiptScript } from './board-commands.ts'
import { HOOK_INPUT_TIMEOUT } from './hook-safety.ts'
import { ZH_TW } from './i18n.ts'
import { EN } from './strings-en.ts'
import { ZH_CN } from './strings-zh-cn.ts'

const PROMPT_RECEIPT_SCRIPT = promptReceiptScript(boardRequestWords([EN, ZH_TW, ZH_CN]))

const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`
const psQuote = (text: string): string => `'${text.replace(/'/g, "''")}'`
const windowsQuote = (text: string): string => `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
const PROMPT_FILE_SCRIPT = `process.argv[1] = require('node:fs').readFileSync(process.env.AGENT_BOARD_PROMPT_INPUT, 'utf8')\n${PROMPT_RECEIPT_SCRIPT}`

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
reader=''; watcher=''; owned=''; timeout_owned=''; completion_owned=''; receipt_owned=''; phase=INPUT_TIMEOUT
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
}
finish() { [ "$agent" != cursor ] || printf '{}\\n'; exit 0; }
trap cleanup 0
trap 'log_error REPORTER_INTERRUPTED; finish' 1 2 15
trap 'log_error "$phase"; finish' ALRM
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
  if [ -s "$file.timeout" ]; then log_error INPUT_TIMEOUT; finish; fi
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
  if [ -s "$file.timeout" ]; then log_error REPORTER_TIMEOUT; finish; fi
  # Missing, failed or empty classifiers keep the compatibility receipt. A
  # timed-out classifier must never turn its unfinished input into a receipt.
  if [ "$status" = 0 ] && [ -n "$(cat "$file.receipt")" ]; then ready="$file.receipt"; fi
fi
if [ -s "$file.timeout" ]; then log_error "$phase"; finish; fi
printf '1' > "$file.complete" || { log_error REPORTER_FAILED; finish; }
kill "$watcher"; wait "$watcher"; watcher=''
if [ -s "$file.timeout" ]; then log_error "$phase"; finish; fi
if [ -s "$ready" ]; then
  mv "$ready" "$file.json" || { log_error REPORTER_FAILED; finish; }
else log_error INCOMPLETE_INPUT
fi
find "$dir" -name '*.json' -mtime +2 -exec rm -f {} + || log_error CLEANUP_FAILED
finish
`

// Keep paths out of the source: Windows PowerShell5.1 can read a BOM-free script
// using the system code page. The actual inbox is beside this installed script.
const powershellReporter = (fromShell: boolean): string => `# Written by the Agent Board plugin (/progress connect).
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
    $start.FileName = (Get-Command node -CommandType Application -ErrorAction Stop).Source
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
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
  if ($Payload -eq '' -and [Console]::IsInputRedirected) {
    $inputStream = [Console]::OpenStandardInput()
    $memory = New-Object IO.MemoryStream
    $buffer = New-Object byte[] 65536
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
  try { $null = ConvertFrom-Json -InputObject $Payload } catch { throw 'INCOMPLETE_INPUT' }
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
  Get-ChildItem -LiteralPath $dir -Filter '*.json' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-2) } | Remove-Item -Force
} catch {
  $code = switch ($_.Exception.Message) { 'INPUT_TIMEOUT' { 'INPUT_TIMEOUT' }; 'REPORTER_TIMEOUT' { 'REPORTER_TIMEOUT' }; 'INPUT_TOO_LARGE' { 'INPUT_TOO_LARGE' }; 'INCOMPLETE_INPUT' { 'INCOMPLETE_INPUT' }; default { 'REPORTER_FAILED' } }
  Write-HookError $code
} finally {
  if ($ownsTemp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  if ($ownsReceipt) { Remove-Item -LiteralPath $receiptTmp -Force -ErrorAction SilentlyContinue }
}
if ($Agent -eq 'cursor') { '{}' }
exit 0
`

export const reporterPs1 = (): string => powershellReporter(false)
