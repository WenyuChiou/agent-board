# A background sampler for the Windows CI jobs (#1249).
#
# Some Windows runs lose about ten seconds at once in unrelated in-memory tests. This records
# whether the whole VM was paused or another process took the machine: it wakes every 250 ms, and
# when a wake-up comes more than a second late it writes down the busy CPU time the system counted
# over the gap, the processes that gained the most CPU, the free memory and the disk queue.
#
#   ci-sampler.ps1 start <dir>   start it detached, return at once
#   ci-sampler.ps1 run <dir> [-TickMs 250] [-GapMs 1000] [-SnapshotMs 2000]   the loop itself
#   ci-sampler.ps1 stop <dir>    stop it and print a one-line summary
#
# Files in <dir>: gaps.jsonl (one line per gap), alive.json (counters, at the first tick and every
# 10 s), sampler.pid (its process id and start time), stop.
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
# running at the second one. A process that ran and exited in between is in neither: the system's
# own busy time below counts it.
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

function Write-Alive($ticks, $gaps, $maxGap) {
  try {
    $line = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); ticks = $ticks; gaps = $gaps; maxGapMs = $maxGap } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText((Join-Path $Dir 'alive.json'), $line + "`n", $noBom)
  } catch { }
}

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
  # The start time goes with the id, so stop never ends another process that later got the same id.
  $startTicks = 0
  try { $startTicks = $child.StartTime.ToUniversalTime().Ticks } catch { }
  Set-Content -LiteralPath (Join-Path $dirFull 'sampler.pid') -Value "$($child.Id) $startTicks" -Encoding ascii
  Write-Output "sampler started (pid $($child.Id)), recording to $dirFull"
  exit 0
}

if ($Mode -eq 'run') {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  # .NET file calls resolve a relative path against the process folder, not PowerShell's.
  $Dir = (Resolve-Path -LiteralPath $Dir).Path
  $stopFile = Join-Path $Dir 'stop'
  $gapFile = Join-Path $Dir 'gaps.jsonl'
  # The system's CPU time over all cores. A process that exits still counts in it, and a paused VM
  # adds no busy time, since no clock tick reaches the guest to charge one.
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
  $cores = [Environment]::ProcessorCount
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $snapshot = Get-CpuSnapshot
  $snapshotAt = $clock.ElapsedMilliseconds
  $system = Get-SystemTimes
  $last = $clock.ElapsedMilliseconds
  $aliveAt = $last
  $ticks = 0; $gaps = 0; $maxGap = 0
  while (-not (Test-Path -LiteralPath $stopFile)) {
    Start-Sleep -Milliseconds $TickMs
    $now = $clock.ElapsedMilliseconds
    $systemNow = Get-SystemTimes
    $elapsed = $now - $last
    $isGap = $elapsed -gt $GapMs
    $ticks++
    try {
      if ($isGap) {
        $gaps++
        if ($elapsed -gt $maxGap) { $maxGap = $elapsed }
        # Take the snapshot first: whatever it costs is cheaper than reading it a second later.
        $fresh = Get-CpuSnapshot
        $gain = Get-CpuGain $snapshot $fresh
        $busyMs = $null; $idleMs = $null
        if ($null -ne $system -and $null -ne $systemNow) {
          $busyMs = [int]($systemNow.busy - $system.busy)
          $idleMs = [int]($systemNow.idle - $system.idle)
        }
        $freeMb = $null
        try { $freeMb = [int]((Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory).FreePhysicalMemory / 1024) } catch { }
        $queue = $null
        try { $queue = [math]::Round((Get-Counter '\PhysicalDisk(_Total)\Current Disk Queue Length' -MaxSamples 1 -ErrorAction Stop).CounterSamples[0].CookedValue, 2) } catch { }
        $record = [ordered]@{
          at = [DateTime]::UtcNow.ToString('o')
          gapMs = [int]$elapsed
          systemBusyMs = $busyMs
          systemIdleMs = $idleMs
          cores = $cores
          sinceSnapshotMs = [int]($clock.ElapsedMilliseconds - $snapshotAt)
          top = $gain.top
          totalCpuMs = $gain.total
          freeMemoryMB = $freeMb
          diskQueue = $queue
        }
        [System.IO.File]::AppendAllText($gapFile, ($record | ConvertTo-Json -Compress -Depth 4) + "`n", $noBom)
        $snapshot = $fresh
        $snapshotAt = $clock.ElapsedMilliseconds
      } elseif (($now - $snapshotAt) -ge $SnapshotMs) {
        $snapshot = Get-CpuSnapshot
        if ($SnapshotDelayMs -gt 0) { Start-Sleep -Milliseconds $SnapshotDelayMs }
        $snapshotAt = $clock.ElapsedMilliseconds
      }
      if ($ticks -eq 1 -or ($now - $aliveAt) -ge 10000) {
        Write-Alive $ticks $gaps $maxGap
        $aliveAt = $now
      }
    } catch { }
    if ($isGap) {
      # After a gap the next wake-up is timed from here, so the sampler's own reads after it (the
      # first Get-Counter can take over a second) never count as the next gap.
      $last = $clock.ElapsedMilliseconds
      $system = Get-SystemTimes
    } else {
      # After any other tick it is timed from this wake-up, so a pause during the periodic snapshot
      # counts in the next gap.
      $last = $now
      $system = $systemNow
    }
  }
  Write-Alive $ticks $gaps $maxGap
  exit 0
}

# stop
$pidFile = Join-Path $Dir 'sampler.pid'
try {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  Set-Content -LiteralPath (Join-Path $Dir 'stop') -Value 'stop' -Encoding ascii
  if (Test-Path -LiteralPath $pidFile) {
    $fields = @((Get-Content -LiteralPath $pidFile -Raw).Trim() -split '\s+')
    if ($fields.Count -eq 2) {
      $samplerId = [int]$fields[0]
      $startTicks = [long]$fields[1]
      $proc = Get-Process -Id $samplerId -ErrorAction SilentlyContinue
      # Only the process that start began: one that later got the same id is left alone.
      $isSampler = $false
      if ($proc -and $startTicks -gt 0) { try { $isSampler = $proc.StartTime.ToUniversalTime().Ticks -eq $startTicks } catch { } }
      if ($isSampler -and -not $proc.WaitForExit(3000)) { Stop-Process -Id $samplerId -Force -ErrorAction SilentlyContinue }
    }
  }
} catch { }

$ticks = '?'
try { $ticks = (Get-Content -LiteralPath (Join-Path $Dir 'alive.json') -Raw | ConvertFrom-Json).ticks } catch { }
$records = @()
try {
  $records = @(Get-Content -LiteralPath (Join-Path $Dir 'gaps.jsonl') -ErrorAction Stop |
    Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
} catch { }
$over = @($records | Where-Object { $_.gapMs -gt $GapMs })
$summary = "windows sampler: $ticks ticks, $($over.Count) gaps over $GapMs ms"
if ($over.Count -gt 0) {
  $worst = $over | Sort-Object gapMs -Descending | Select-Object -First 1
  $names = (@($worst.top) | Select-Object -First 3 | ForEach-Object { "$($_.name) $($_.cpuMs) ms" }) -join ', '
  if (-not $names) { $names = 'none' }
  $summary += "; largest $($worst.gapMs) ms at $($worst.at), top: $names"
  if ($null -ne $worst.systemBusyMs) {
    # Busy time is summed over all cores, so one core busy for the whole gap would be gapMs.
    $summary += "; busy CPU over it $($worst.systemBusyMs) ms on $($worst.cores) cores"
    if ($worst.systemBusyMs -lt ($worst.gapMs / 4)) {
      $summary += ', under a quarter of one core: nothing ran, so the VM was likely paused'
    }
  } else {
    # Without the system's own count, the processes still running are all there is, over the time
    # since the last snapshot, which includes the gap.
    $window = [math]::Max($worst.gapMs, $worst.sinceSnapshotMs)
    if ($worst.totalCpuMs -lt ($window / 4)) {
      $summary += '; the processes still running gained under a quarter of one core over it (the system CPU time could not be read)'
    }
  }
}
Write-Output $summary
exit 0
