param(
  [ValidateSet('start', 'run', 'stop')][string]$Action = 'run',
  [string]$Dir = '',
  [string]$JobName = 'windows-job',
  [int]$TickMs = 250,
  [int]$GapMs = 1000,
  [int]$BaselineMs = 2000,
  [int]$MaxDurationSec = 1800,
  [int]$MaxTicks = 0,
  [int]$StopTimeoutMs = 5000
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Utf8([string]$Path, [string]$Text) { [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom) }
function Append-Utf8([string]$Path, [string]$Text) { [System.IO.File]::AppendAllText($Path, $Text, $Utf8NoBom) }
function Read-Utf8([string]$Path) { return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF) }
function Clean-Line([string]$Text) { if ($null -eq $Text) { return '' }; return ($Text -replace '[\0\r\n]+', ' ').Trim() }
function Parse-UtcTime($Val) {
  if ($Val -is [DateTime]) { return $Val.ToUniversalTime() }
  if ($Val) { return [DateTime]::Parse([string]$Val, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }
  return $null
}
function Get-SafeArtifactName([string]$Job) {
  $raw = if ($null -eq $Job) { '' } else { [string]$Job }
  $slug = (($raw -replace '/', '-of-').ToLowerInvariant() -replace '[^a-z0-9._]+', '-').Trim('.', '-')
  if ([string]::IsNullOrEmpty($slug)) { $slug = 'job' }
  $name = 'windows-sampler-' + $slug
  if ($name.Length -gt 100) { $name = $name.Substring(0, 100).TrimEnd('.', '-') }
  return $name
}

$safeJob = (($JobName -replace '["\0\r\n]', ' ').Trim())
if (-not $safeJob) { $safeJob = 'windows-job' }
$artifact = Get-SafeArtifactName $safeJob
if ([string]::IsNullOrWhiteSpace($Dir)) {
  $baseTemp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
  $Dir = Join-Path $baseTemp $artifact
}
$stopFile = Join-Path $Dir 'stop.flag'
$ndjsonFile = Join-Path $Dir 'gaps.ndjson'
$recordFile = Join-Path $Dir 'sampler.json'

if ($Action -eq 'start') {
  $null = New-Item -ItemType Directory -Path $Dir -Force
  $psExe = Join-Path $PSHOME 'powershell.exe'
  if (-not (Test-Path $psExe)) { $psExe = 'powershell.exe' }
  $argParts = @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + $PSCommandPath + '"'), '-Action', 'run',
    '-Dir', ('"' + $Dir + '"'), '-JobName', ('"' + $safeJob + '"'),
    '-TickMs', [string]$TickMs, '-GapMs', [string]$GapMs,
    '-BaselineMs', [string]$BaselineMs, '-MaxDurationSec', [string]$MaxDurationSec
  )
  if ($MaxTicks -gt 0) { $argParts += @('-MaxTicks', [string]$MaxTicks) }
  $proc = Start-Process -FilePath $psExe -ArgumentList ($argParts -join ' ') -WindowStyle Hidden -PassThru
  $startTimeUtc = [DateTime]::UtcNow.ToString('o')
  try { $startTimeUtc = $proc.StartTime.ToUniversalTime().ToString('o') } catch {}
  $pidObj = [pscustomobject]@{ pid = $proc.Id; startTimeUtc = $startTimeUtc; dir = $Dir; job = $safeJob; artifact = $artifact }
  Write-Utf8 (Join-Path $Dir 'sampler.pid.json') (($pidObj | ConvertTo-Json -Depth 4) + "`n")
  if ($env:GITHUB_OUTPUT) {
    Append-Utf8 $env:GITHUB_OUTPUT ("dir=" + (Clean-Line $Dir) + "`nartifact=" + (Clean-Line $artifact) + "`n")
  }
  Write-Output "windows-runner-sampler: started pid=$($proc.Id) artifact=$artifact"
  exit 0
}

if ($Action -eq 'stop') {
  $null = New-Item -ItemType Directory -Path $Dir -Force
  Write-Utf8 $stopFile ([DateTime]::UtcNow.ToString('o') + "`n")
  $pidFile = Join-Path $Dir 'sampler.pid.json'
  $pidInfo = $null
  $forcedStop = $false
  if (Test-Path $pidFile) {
    try {
      $pidInfo = (Read-Utf8 $pidFile) | ConvertFrom-Json
      if ($pidInfo -and $pidInfo.pid) {
        $targetPid = [int]$pidInfo.pid
        $recordedStart = Parse-UtcTime $pidInfo.startTimeUtc
        $waitSw = [Diagnostics.Stopwatch]::StartNew()
        $stillRunning = $true
        while ($stillRunning -and $waitSw.ElapsedMilliseconds -lt $StopTimeoutMs) {
          $proc = $null
          try {
            $proc = [System.Diagnostics.Process]::GetProcessById($targetPid)
            if ($recordedStart) {
              $actualStart = $null
              try { $actualStart = $proc.StartTime.ToUniversalTime() } catch {}
              if ($actualStart -and [math]::Abs(($actualStart - $recordedStart).TotalSeconds) -gt 5) { $stillRunning = $false; break }
            }
            if ($proc.WaitForExit(200)) { $stillRunning = $false; break }
          } catch { $stillRunning = $false; break }
          finally { if ($proc) { $proc.Dispose() } }
        }
        if ($stillRunning) {
          $proc = $null
          try {
            $proc = [System.Diagnostics.Process]::GetProcessById($targetPid)
            $matchesStart = $true
            if ($recordedStart) {
              try { if ([math]::Abs(($proc.StartTime.ToUniversalTime() - $recordedStart).TotalSeconds) -gt 5) { $matchesStart = $false } } catch {}
            }
            if ($matchesStart) {
              try { $proc.Kill(); $null = $proc.WaitForExit(2000) } catch {}
              $forcedStop = $true
            }
          } catch {}
          finally { if ($proc) { $proc.Dispose() } }
        }
      }
    } catch {}
  }
  for ($i = 0; $i -lt 5 -and -not (Test-Path $recordFile); $i++) { [Threading.Thread]::Sleep(60) }
  $record = $null
  if (Test-Path $recordFile) { try { $record = (Read-Utf8 $recordFile) | ConvertFrom-Json } catch {} }
  if (-not $record) {
    $fallbackGaps = [System.Collections.ArrayList]::new()
    if (Test-Path $ndjsonFile) {
      foreach ($l in ((Read-Utf8 $ndjsonFile) -split "\r?\n")) {
        if (-not [string]::IsNullOrWhiteSpace($l)) { try { $null = $fallbackGaps.Add(($l | ConvertFrom-Json)) } catch {} }
      }
    }
    $maxSeen = 0
    foreach ($g in $fallbackGaps) { if ($g.gapMs -gt $maxSeen) { $maxSeen = [int64]$g.gapMs } }
    $fbJob = if ($pidInfo -and $pidInfo.job) { [string]$pidInfo.job } else { $safeJob }
    $fbArtifact = if ($pidInfo -and $pidInfo.artifact) { [string]$pidInfo.artifact } else { $artifact }
    $record = [pscustomobject]@{
      version = 1; job = $fbJob; artifact = $fbArtifact; cpuCount = [Environment]::ProcessorCount
      tickMs = $TickMs; gapThresholdMs = $GapMs; baselineMs = $BaselineMs; tickCount = 0
      totalGaps = $fallbackGaps.Count; maxGapMs = $maxSeen; forcedStop = $true
      gaps = [object[]]@($fallbackGaps.ToArray()); errors = [object[]]@()
    }
    Write-Utf8 $recordFile (($record | ConvertTo-Json -Depth 6) + "`n")
  } elseif ($forcedStop) {
    $record | Add-Member -NotePropertyName forcedStop -NotePropertyValue $true -Force
    Write-Utf8 $recordFile (($record | ConvertTo-Json -Depth 6) + "`n")
  }
  $rawJob = if ($record.job) { [string]$record.job } else { $safeJob }
  $summaryJob = Clean-Line $rawJob
  $line = "Windows runner sampler ($summaryJob): $($record.totalGaps) gaps > $($record.gapThresholdMs) ms ($($record.tickCount) ticks, max gap $($record.maxGapMs) ms)"
  Write-Output $line
  if ($env:GITHUB_STEP_SUMMARY) { try { Append-Utf8 $env:GITHUB_STEP_SUMMARY ("- $line`n") } catch {} }
  exit 0
}

$null = New-Item -ItemType Directory -Path $Dir -Force
$errors = [System.Collections.ArrayList]::new()
$gaps = [System.Collections.ArrayList]::new()
$procCat = $null; $diskCat = $null; $memCat = $null
try { $procCat = New-Object System.Diagnostics.PerformanceCounterCategory('Process') } catch { $null = $errors.Add("Process: $($_.Exception.Message)") }
try { $diskCat = New-Object System.Diagnostics.PerformanceCounterCategory('PhysicalDisk') } catch { $null = $errors.Add("PhysicalDisk: $($_.Exception.Message)") }
try { $memCat = New-Object System.Diagnostics.PerformanceCounterCategory('Memory') } catch { $null = $errors.Add("Memory: $($_.Exception.Message)") }

function Read-ProcessSnapshot {
  if (-not $procCat) { return $null }
  try {
    $data = $procCat.ReadCategory()
    $cpuCol = $data['% Processor Time']; $idCol = $data['ID Process']; $elapsedCol = $data['Elapsed Time']
    if (-not $cpuCol -or -not $idCol) { return $null }
    $snap = @{}
    foreach ($key in $cpuCol.Keys) {
      if ($key -eq '_total' -or -not $idCol.Contains($key)) { continue }
      $procId = [int64]$idCol[$key].RawValue
      $cpuMs = [int64][math]::Floor([double]$cpuCol[$key].RawValue / 10000.0)
      $createdRaw = if ($elapsedCol -and $elapsedCol.Contains($key)) { [int64]$elapsedCol[$key].RawValue } else { [int64]0 }
      $name = ([string]$key -replace '#\d+$', '').ToLowerInvariant()
      $snap["$($procId):$createdRaw"] = [pscustomobject]@{ pid = $procId; name = $name; cpuMs = $cpuMs; createdRaw = $createdRaw }
    }
    return $snap
  } catch { if ($errors.Count -lt 20) { $null = $errors.Add("ReadCategory(Process): $($_.Exception.Message)") }; return $null }
}

function Read-MemoryBytes {
  if (-not $memCat) { return $null }
  try { $col = $memCat.ReadCategory()['Available Bytes']; if ($col) { foreach ($v in $col.Values) { return [int64]$v.RawValue } } }
  catch { if ($errors.Count -lt 20) { $null = $errors.Add("ReadCategory(Memory): $($_.Exception.Message)") } }
  return $null
}

function Read-DiskQueue {
  if (-not $diskCat) { return $null }
  try {
    $col = $diskCat.ReadCategory()['Current Disk Queue Length']
    if ($col) {
      foreach ($k in $col.Keys) { if (([string]$k).ToLowerInvariant() -eq '_total') { return [double]$col[$k].RawValue } }
      $sum = 0.0; foreach ($v in $col.Values) { $sum += [double]$v.RawValue }; return $sum
    }
  } catch { if ($errors.Count -lt 20) { $null = $errors.Add("ReadCategory(PhysicalDisk): $($_.Exception.Message)") } }
  return $null
}

function Compute-Deltas($Before, $After) {
  if (-not $After) { return [pscustomobject]@{ totalCpuGainedMs = 0; idleCpuGainedMs = $null; topProcesses = [object[]]@(); processCount = 0 } }
  $idle = 0; $hasIdle = $false; $total = 0; $list = [System.Collections.ArrayList]::new()
  foreach ($k in $After.Keys) {
    $cur = $After[$k]
    $prevCpu = if ($Before -and $Before.ContainsKey($k)) { $Before[$k].cpuMs } else { 0 }
    $delta = [int64]($cur.cpuMs - $prevCpu)
    if ($delta -lt 0) { $delta = [int64]0 }
    if ($cur.pid -eq 0 -or $cur.name -eq 'idle') { $idle += $delta; $hasIdle = $true }
    elseif ($delta -gt 0) { $total += $delta; $null = $list.Add([pscustomobject]@{ pid = $cur.pid; name = $cur.name; cpuGainedMs = $delta }) }
  }
  $top = [object[]]@($list | Sort-Object -Property cpuGainedMs -Descending | Select-Object -First 25)
  $idleVal = if ($hasIdle) { [int64]$idle } else { $null }
  return [pscustomobject]@{ totalCpuGainedMs = [int64]$total; idleCpuGainedMs = $idleVal; topProcesses = $top; processCount = $After.Count }
}

function Add-GapSample([string]$Source, $StartWall, $EndWall, [int64]$GapDurationMs, [int64]$EndMono, $AfterSnap) {
  $script:totalGaps++
  $freeMem = Read-MemoryBytes; $diskQ = Read-DiskQueue; $deltas = Compute-Deltas $script:baseline $AfterSnap
  $freeMb = if ($null -ne $freeMem) { [math]::Round($freeMem / 1MB, 1) } else { $null }
  $gapObj = [pscustomobject]@{
    startedAt = $StartWall.ToString('o'); endedAt = $EndWall.ToString('o'); source = $Source
    gapMs = $GapDurationMs; wallGapMs = [int64][math]::Round(($EndWall - $StartWall).TotalMilliseconds)
    windowMs = [int64]($EndMono - $script:baselineAtMono); baselineAgeMs = [int64]($EndMono - $GapDurationMs - $script:baselineAtMono)
    freeMemoryBytes = $freeMem; freeMemoryMb = $freeMb; diskQueueLength = $diskQ
    totalCpuGainedMs = $deltas.totalCpuGainedMs; idleCpuGainedMs = $deltas.idleCpuGainedMs
    topProcesses = [object[]]@($deltas.topProcesses); processCount = $deltas.processCount
  }
  if ($gaps.Count -lt 500) {
    $null = $gaps.Add($gapObj)
    Append-Utf8 $ndjsonFile (($gapObj | ConvertTo-Json -Depth 6 -Compress) + "`n")
  }
}

$startedAtUtc = [DateTime]::UtcNow.ToString('o')
$warmupSw = [Diagnostics.Stopwatch]::StartNew()
$script:baseline = Read-ProcessSnapshot
$null = Read-MemoryBytes; $null = Read-DiskQueue
$warmupMs = [int64]$warmupSw.ElapsedMilliseconds
$tickCount = 0; $baselineCount = 0; $script:totalGaps = 0; $maxGapMs = 0
$runSw = [Diagnostics.Stopwatch]::StartNew(); $tickSw = [Diagnostics.Stopwatch]::StartNew(); $baselineSw = [Diagnostics.Stopwatch]::StartNew()
$script:baselineAtMono = $tickSw.ElapsedMilliseconds

try {
  while (-not (Test-Path $stopFile) -and $runSw.Elapsed.TotalSeconds -lt $MaxDurationSec -and ($MaxTicks -le 0 -or $tickCount -lt $MaxTicks)) {
    $beforeWall = [DateTime]::UtcNow; $beforeMono = $tickSw.ElapsedMilliseconds
    [Threading.Thread]::Sleep($TickMs)
    $afterMono = $tickSw.ElapsedMilliseconds; $afterWall = [DateTime]::UtcNow
    $tickCount++; $monoGapMs = [int64]($afterMono - $beforeMono)
    if ($monoGapMs -gt $maxGapMs) { $maxGapMs = $monoGapMs }
    if ($monoGapMs -gt $GapMs) {
      $afterSnap = Read-ProcessSnapshot
      Add-GapSample 'sleep' $beforeWall $afterWall $monoGapMs $afterMono $afterSnap
      if ($afterSnap) { $script:baseline = $afterSnap; $script:baselineAtMono = $tickSw.ElapsedMilliseconds; $baselineSw.Restart() }
    } elseif ($baselineSw.ElapsedMilliseconds -ge $BaselineMs) {
      $snapStartMono = $tickSw.ElapsedMilliseconds; $snapStartWall = [DateTime]::UtcNow
      $nextSnap = Read-ProcessSnapshot
      $snapEndMono = $tickSw.ElapsedMilliseconds; $snapEndWall = [DateTime]::UtcNow
      $snapMs = [int64]($snapEndMono - $snapStartMono); $baselineCount++
      if ($snapMs -gt $maxGapMs) { $maxGapMs = $snapMs }
      if ($snapMs -gt $GapMs) { Add-GapSample 'baseline' $snapStartWall $snapEndWall $snapMs $snapEndMono $nextSnap }
      if ($nextSnap) { $script:baseline = $nextSnap; $script:baselineAtMono = $tickSw.ElapsedMilliseconds; $baselineSw.Restart() }
    }
  }
} catch { if ($errors.Count -lt 20) { $null = $errors.Add("Sampler loop: $($_.Exception.Message)") } }
finally {
  $recordObj = [pscustomobject]@{
    version = 1; job = $safeJob; artifact = $artifact; startedAt = $startedAtUtc; endedAt = [DateTime]::UtcNow.ToString('o')
    durationMs = [int64]$runSw.ElapsedMilliseconds; warmupMs = $warmupMs; cpuCount = [Environment]::ProcessorCount
    tickMs = $TickMs; gapThresholdMs = $GapMs; baselineMs = $BaselineMs; tickCount = $tickCount
    baselineCount = $baselineCount; totalGaps = $script:totalGaps; maxGapMs = $maxGapMs
    gaps = [object[]]@($gaps.ToArray()); errors = [object[]]@($errors.ToArray())
  }
  $tmpFile = $recordFile + '.tmp'
  Write-Utf8 $tmpFile (($recordObj | ConvertTo-Json -Depth 6) + "`n")
  Move-Item -LiteralPath $tmpFile -Destination $recordFile -Force
}
