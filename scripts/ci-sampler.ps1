# A background sampler for the Windows CI jobs (#1249).
#
# Some Windows runs lose about ten seconds at once in unrelated in-memory tests. This records what
# the machine did then, and gives no verdict on it: it wakes every 250 ms, and when a wake-up comes
# more than a second late it writes one line with the gap on the monotonic clock and on the wall
# clock, the busy and idle CPU time the system counted over the same gap, the cores, how long its
# own reads took, and as hints the processes that gained the most CPU, free memory and disk queue.
#
#   ci-sampler.ps1 start <dir>   start the loop in the background and return at once
#   ci-sampler.ps1 run <dir> [-TickMs 250] [-GapMs 1000] [-SnapshotMs 2000]   the loop itself
#   ci-sampler.ps1 stop <dir>    ask the loop to stop and wait up to 3 s (it never ends it), then
#                                print a summary and at most 20 gap lines
#
# Files in <dir>: gaps.jsonl (one line per gap), alive.json (the counts, at the first tick, every
# 10 s and on the way out), stop.
param(
  [Parameter(Position = 0)][string]$Mode = '',
  [Parameter(Position = 1)][string]$Dir = '',
  [int]$TickMs = 250,
  [int]$GapMs = 1000,
  [int]$SnapshotMs = 2000,
  # Tests only: an extra wait inside each periodic snapshot, standing in for a VM pause there.
  [int]$SnapshotDelayMs = 0
)
$ErrorActionPreference = 'Continue'

if (-not $Dir -or @('start', 'run', 'stop') -notcontains $Mode) {
  Write-Output 'usage: ci-sampler.ps1 start|run|stop <dir>'
  exit 0
}

# Process id -> @{ name; cpu } (total processor time in ms). A process that exits or denies
# access while we read it is skipped: one bad process must not lose the whole snapshot.
function Get-CpuSnapshot {
  $snap = @{}
  foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
    try { $snap[$p.Id] = @{ name = $p.ProcessName; cpu = [math]::Round($p.TotalProcessorTime.TotalMilliseconds) } } catch { }
    finally { $p.Dispose() }
  }
  return $snap
}

# The ten processes that gained the most CPU between two snapshots, and the sum over those still
# running at the second one. A process that ran and exited in between is in neither.
function Get-CpuGain($before, $after) {
  $rows = @()
  $total = 0
  foreach ($id in $after.Keys) {
    $was = 0
    if ($before.ContainsKey($id) -and $before[$id].name -eq $after[$id].name) { $was = $before[$id].cpu }
    $gain = $after[$id].cpu - $was
    if ($gain -gt 0) {
      $total += $gain
      $rows += [pscustomobject]@{ name = $after[$id].name; id = [int]$id; cpuMs = [int]$gain }
    }
  }
  $top = @($rows | Sort-Object cpuMs -Descending | Select-Object -First 10)
  return @{ top = $top; total = [int]$total }
}

# UTF-8 without a byte order mark, which Windows PowerShell 5.1's -Encoding utf8 would add.
$noBom = New-Object System.Text.UTF8Encoding $false
$aliveFile = Join-Path $Dir 'alive.json'
$gapFile = Join-Path $Dir 'gaps.jsonl'

if ($Mode -eq 'start') {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $dirFull = (Resolve-Path -LiteralPath $Dir).Path
  Remove-Item -LiteralPath (Join-Path $dirFull 'stop') -Force -ErrorAction SilentlyContinue
  # The same PowerShell that runs this script, so it also works where only powershell.exe exists.
  $exe = (Get-Process -Id $PID).Path
  # Start-Process joins the arguments with spaces and quotes none, so the two paths are quoted here.
  $child = Start-Process -FilePath $exe -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-File', "`"$PSCommandPath`"", 'run', "`"$dirFull`"",
    '-TickMs', $TickMs, '-GapMs', $GapMs, '-SnapshotMs', $SnapshotMs)
  Write-Output "sampler started (pid $($child.Id)), recording to $dirFull"
  exit 0
}

if ($Mode -eq 'run') {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  # .NET file calls resolve a relative path against the process folder, not PowerShell's.
  $Dir = (Resolve-Path -LiteralPath $Dir).Path
  $aliveFile = Join-Path $Dir 'alive.json'
  $gapFile = Join-Path $Dir 'gaps.jsonl'
  $stopFile = Join-Path $Dir 'stop'
  # The system's CPU time summed over all cores. If it cannot be read, the two fields stay null.
  $hasSystemTimes = $false
  try {
    Add-Type -Namespace AgentBoardSampler -Name Native -ErrorAction Stop -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool GetSystemTimes(out long idle, out long kernel, out long user);'
    $hasSystemTimes = $true
  } catch { }
  function Get-SystemTimes {
    if (-not $hasSystemTimes) { return $null }
    [long]$idle = 0; [long]$kernel = 0; [long]$user = 0
    try { if (-not [AgentBoardSampler.Native]::GetSystemTimes([ref]$idle, [ref]$kernel, [ref]$user)) { return $null } } catch { return $null }
    # Kernel time includes idle time; the values are in 100 ns units.
    return @{ busy = ($kernel + $user - $idle) / 10000; idle = $idle / 10000 }
  }
  $state = [ordered]@{ ticks = 0; gaps = 0; saved = 0; gapMs = $GapMs; maxGapMs = 0; ended = $false }
  function Write-Alive {
    try { [System.IO.File]::WriteAllText($aliveFile, ($state | ConvertTo-Json -Compress) + "`n", $noBom) } catch { }
  }
  $cores = [Environment]::ProcessorCount
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $snapshot = Get-CpuSnapshot
  $snapshotAt = $clock.ElapsedMilliseconds
  # The three readings a gap is measured between, taken together at each end.
  $last = $clock.ElapsedMilliseconds; $lastWall = [DateTime]::UtcNow; $system = Get-SystemTimes
  $aliveAt = $last
  while (-not (Test-Path -LiteralPath $stopFile)) {
    Start-Sleep -Milliseconds $TickMs
    $now = $clock.ElapsedMilliseconds; $wallNow = [DateTime]::UtcNow; $systemNow = Get-SystemTimes
    $elapsed = $now - $last
    $isGap = $elapsed -gt $GapMs
    $state.ticks++
    try {
      if ($isGap) {
        $state.gaps++
        if ($elapsed -gt $state.maxGapMs) { $state.maxGapMs = [int]$elapsed }
        $busyMs = $null; $idleMs = $null
        if ($null -ne $system -and $null -ne $systemNow) {
          $busyMs = [int]($systemNow.busy - $system.busy)
          $idleMs = [int]($systemNow.idle - $system.idle)
        }
        $fresh = Get-CpuSnapshot
        $gain = Get-CpuGain $snapshot $fresh
        $freeMb = $null
        # A read that fails, even without stopping, stays unknown: 0 would read as no free memory.
        try {
          $os = Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory -ErrorAction Stop
          if ($null -ne $os -and $null -ne $os.FreePhysicalMemory) { $freeMb = [int]($os.FreePhysicalMemory / 1024) }
        } catch { }
        $queue = $null
        try { $queue = [math]::Round((Get-Counter '\PhysicalDisk(_Total)\Current Disk Queue Length' -MaxSamples 1 -ErrorAction Stop).CounterSamples[0].CookedValue, 2) } catch { }
        $record = [ordered]@{
          at = $wallNow.ToString('o')
          gapMs = [int]$elapsed
          wallMs = [int]($wallNow - $lastWall).TotalMilliseconds
          systemBusyMs = $busyMs
          systemIdleMs = $idleMs
          cores = $cores
          readMs = [int]($clock.ElapsedMilliseconds - $now)
          sinceSnapshotMs = [int]($now - $snapshotAt)
          top = $gain.top
          totalCpuMs = $gain.total
          freeMemoryMB = $freeMb
          diskQueue = $queue
        }
        $snapshot = $fresh
        $snapshotAt = $clock.ElapsedMilliseconds
        [System.IO.File]::AppendAllText($gapFile, ($record | ConvertTo-Json -Compress -Depth 4) + "`n", $noBom)
        $state.saved++
      } elseif (($now - $snapshotAt) -ge $SnapshotMs) {
        $snapshot = Get-CpuSnapshot
        if ($SnapshotDelayMs -gt 0) { Start-Sleep -Milliseconds $SnapshotDelayMs }
        $snapshotAt = $clock.ElapsedMilliseconds
      }
    } catch { }
    if ($state.ticks -eq 1 -or ($now - $aliveAt) -ge 10000) {
      Write-Alive
      $aliveAt = $now
    }
    if ($isGap) {
      # After a gap the next one is measured from here, so this tick's own reads (the first
      # Get-Counter can take over a second) are never counted as part of a gap.
      $last = $clock.ElapsedMilliseconds; $lastWall = [DateTime]::UtcNow; $system = Get-SystemTimes
    } else {
      # After any other tick it is measured from this wake-up, so a pause during the periodic
      # snapshot counts in the next gap.
      $last = $now; $lastWall = $wallNow; $system = $systemNow
    }
  }
  $state.ended = $true
  Write-Alive
  exit 0
}

# stop
function Read-Alive {
  try { return (Get-Content -LiteralPath $aliveFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop) } catch { return $null }
}
if (-not (Test-Path -LiteralPath $Dir -PathType Container)) {
  Write-Output 'windows sampler: no record (the sampler did not start)'
  exit 0
}
$alive = $null
try {
  Set-Content -LiteralPath (Join-Path $Dir 'stop') -Value 'stop' -Encoding ascii
  # The loop writes alive.json with ended on its way out. It is never ended from here: whatever is
  # left when the job finishes, the runner ends.
  for ($waited = 0; $waited -lt 3000; $waited += 100) {
    $alive = Read-Alive
    if ($alive -and $alive.ended) { break }
    Start-Sleep -Milliseconds 100
  }
} catch { }

$records = @()
$unreadable = 0
if (Test-Path -LiteralPath $gapFile -PathType Leaf) {
  # Each line is kept as written: PowerShell 7 would turn `at` into a local date when read.
  $index = 0
  foreach ($line in @(Get-Content -LiteralPath $gapFile -ErrorAction SilentlyContinue)) {
    if (-not "$line".Trim()) { continue }
    try { $records += [pscustomobject]@{ gap = ($line | ConvertFrom-Json -ErrorAction Stop); line = "$line"; index = $index++ } } catch { $unreadable++ }
  }
}
if ($alive) {
  $summary = "windows sampler: $($alive.ticks) ticks, $($alive.gaps) gaps over $($alive.gapMs) ms"
  if (-not $alive.ended) { $summary += ', the loop had not ended after 3 s' }
  if ($alive.gaps -gt $alive.saved) { $summary += ", $($alive.gaps - $alive.saved) not saved (the record is incomplete)" }
} else {
  $summary = "windows sampler: ? ticks, $($records.Count + $unreadable) gaps over $GapMs ms, no readable alive.json"
}
if ($unreadable) { $summary += ", $unreadable unreadable lines in gaps.jsonl" }
Write-Output $summary

# The largest 20 gaps, in the order they were written. accounted = (busy + idle) / (gap x cores): the share of the
# gap the system's CPU counters moved through. No rule reads it yet (#1249).
$shown = @($records | Sort-Object { [int]$_.gap.gapMs } -Descending | Select-Object -First 20 | Sort-Object index)
foreach ($r in $shown) {
  $g = $r.gap
  $accounted = 'unknown'
  try {
    if ($null -ne $g.systemBusyMs -and $null -ne $g.systemIdleMs -and [int]$g.gapMs -gt 0 -and [int]$g.cores -gt 0) {
      $accounted = [math]::Round(([double]$g.systemBusyMs + [double]$g.systemIdleMs) / ([double]$g.gapMs * [double]$g.cores), 2)
    }
  } catch { }
  Write-Output "gap $($g.gapMs) ms, accounted $($accounted): $($r.line)"
}
if ($records.Count -gt 20) { Write-Output "$($records.Count - 20) smaller gaps not shown" }
exit 0
