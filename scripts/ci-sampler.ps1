# A background sampler for the Windows CI jobs (#1249).
#
# Some Windows runs lose about ten seconds at once in unrelated in-memory tests. This records
# whether the whole VM was paused or another process took the machine: it wakes every 250 ms, and
# when a wake-up comes more than a second late it writes down the CPU each process gained, the
# free memory and the disk queue.
#
#   ci-sampler.ps1 start <dir>   start it detached, return at once
#   ci-sampler.ps1 run <dir> [-TickMs 250] [-GapMs 1000] [-SnapshotMs 2000]   the loop itself
#   ci-sampler.ps1 stop <dir>    stop it and print a one-line summary
#
# Files in <dir>: gaps.jsonl (one line per gap), alive.json (counters, every 10 s), sampler.pid, stop.
param(
  [Parameter(Position = 0)][string]$Mode = '',
  [Parameter(Position = 1)][string]$Dir = '',
  [int]$TickMs = 250,
  [int]$GapMs = 1000,
  [int]$SnapshotMs = 2000
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

# The ten processes that gained the most CPU between two snapshots, and the sum over all of them.
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
  Set-Content -LiteralPath (Join-Path $dirFull 'sampler.pid') -Value $child.Id -Encoding ascii
  Write-Output "sampler started (pid $($child.Id)), recording to $dirFull"
  exit 0
}

if ($Mode -eq 'run') {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  # .NET file calls resolve a relative path against the process folder, not PowerShell's.
  $Dir = (Resolve-Path -LiteralPath $Dir).Path
  $stopFile = Join-Path $Dir 'stop'
  $gapFile = Join-Path $Dir 'gaps.jsonl'
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $snapshot = Get-CpuSnapshot
  $snapshotAt = $clock.ElapsedMilliseconds
  $last = $clock.ElapsedMilliseconds
  $aliveAt = $last
  $ticks = 0; $gaps = 0; $maxGap = 0
  while (-not (Test-Path -LiteralPath $stopFile)) {
    Start-Sleep -Milliseconds $TickMs
    $now = $clock.ElapsedMilliseconds
    $elapsed = $now - $last
    $ticks++
    try {
      if ($elapsed -gt $GapMs) {
        $gaps++
        if ($elapsed -gt $maxGap) { $maxGap = $elapsed }
        # Take the snapshot first: whatever it costs is cheaper than reading it a second later.
        $fresh = Get-CpuSnapshot
        $gain = Get-CpuGain $snapshot $fresh
        $freeMb = $null
        try { $freeMb = [int]((Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory).FreePhysicalMemory / 1024) } catch { }
        $queue = $null
        try { $queue = [math]::Round((Get-Counter '\PhysicalDisk(_Total)\Current Disk Queue Length' -MaxSamples 1 -ErrorAction Stop).CounterSamples[0].CookedValue, 2) } catch { }
        $record = [ordered]@{
          at = [DateTime]::UtcNow.ToString('o')
          gapMs = [int]$elapsed
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
        $snapshotAt = $clock.ElapsedMilliseconds
      }
      if (($now - $aliveAt) -ge 10000) {
        Write-Alive $ticks $gaps $maxGap
        $aliveAt = $now
      }
    } catch { }
    # The next wake-up is timed from here, so the sampler's own reads after a gap (the first
    # Get-Counter can take over a second) never count as the next gap.
    $last = $clock.ElapsedMilliseconds
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
    $samplerId = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
    $proc = Get-Process -Id $samplerId -ErrorAction SilentlyContinue
    if ($proc) {
      if (-not $proc.WaitForExit(3000)) { Stop-Process -Id $samplerId -Force -ErrorAction SilentlyContinue }
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
  # The CPU figure covers the time since the last snapshot, which includes the gap. One core busy
  # for that whole time would be that many ms; under a quarter of it means nothing ran, so the VM
  # itself stood still.
  $window = [math]::Max($worst.gapMs, $worst.sinceSnapshotMs)
  if ($worst.totalCpuMs -lt ($window / 4)) {
    $summary += '; no process gained CPU during the gap: the VM was likely paused'
  }
}
Write-Output $summary
exit 0
