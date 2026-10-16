# Installs the project-progress plugin and makes the settings it cannot make itself.
# Safe to re-run; it is also how an old zip install moves over.
#   irm https://raw.githubusercontent.com/WenyuChiou/claude-progress-pane/main/scripts/setup.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File setup.ps1 [-KeepRule] [-NoInstall] [-ProfilePath <file>]
#
# 1. With `claude` on PATH (and no -NoInstall): adds the claude-progress-pane marketplace
#    and installs project-progress from it. Both steps are no-ops once done.
# 2. PowerShell profile ($PROFILE.CurrentUserCurrentHost, or -ProfilePath): adds
#    $env:CLAUDE_CODE_ENABLE_TODO_TOOLS = "1" unless a line already sets it. Newer models
#    leave the Task tools out without it, and the pane mirrors them. It goes in the profile,
#    not settings.json: settings.json env also reaches Claude desktop-app sessions, which
#    keep their own task list.
# 3. settings.json env: removes CLAUDE_CODE_ENABLE_TODO_TOOLS="1" that 0.5.0 and 0.5.1 put
#    there, and drops the old zip install (...\mods\project-progress) from
#    CLAUDE_CODE_PLUGIN_DIRS, so the mod does not load twice. Only those pairs change; the
#    rest of the file keeps its bytes. If that cannot be done exactly, the file is left alone.
#    The key stays while the execution policy would keep the profile from running.
# 4. CLAUDE.md: drops the <!-- project-progress:start/end --> block; the plugin now adds
#    the rule itself. With -KeepRule it writes or refreshes that block instead: use it
#    where an organization manages Claude Code, since the plugin's own rule does not run there.
# Each file it changes is copied to <file>.bak first. It deletes nothing on disk.
param([switch]$KeepRule, [switch]$NoInstall, [string]$ProfilePath)

function Install-ProgressPane {
  param([bool]$KeepRule, [bool]$NoInstall, [string]$Here, [string]$ProfilePath)
  $ErrorActionPreference = 'Stop'
  $marketplace = 'WenyuChiou/claude-progress-pane'
  $plugin = 'project-progress@claude-progress-pane'

  if ($env:CLAUDE_CONFIG_DIR) { $claude = $env:CLAUDE_CONFIG_DIR }
  else { $claude = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude' }
  $utf8 = New-Object System.Text.UTF8Encoding $false   # no BOM: Claude Code parses these files
  $done = @()

  # The plugin itself
  if (-not $NoInstall) {
    if (Get-Command claude -ErrorAction SilentlyContinue) {
      & claude plugin marketplace add $marketplace
      if ($LASTEXITCODE -ne 0) {
        Write-Warning ("Could not add $marketplace. For a private repository run 'gh auth login' and " +
          "'gh auth setup-git' once; without a GitHub SSH key also set CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1. Then run this again.")
        return
      }
      & claude plugin install $plugin
      if ($LASTEXITCODE -ne 0) { Write-Warning "Could not install $plugin."; return }
    }
    else {
      Write-Warning "claude is not on PATH: run 'claude plugin marketplace add $marketplace' and 'claude plugin install $plugin' yourself."
    }
  }

  # PowerShell profile. settings.json gives up its copy of the key only when $profileReady:
  # the profile sets it and PowerShell will run the profile.
  $line = '$env:CLAUDE_CODE_ENABLE_TODO_TOOLS = "1"'
  $profileReady = $false
  if (-not $ProfilePath) { $ProfilePath = $PROFILE.CurrentUserCurrentHost }
  if (-not $ProfilePath) { Write-Warning "No PowerShell profile here: add $line to the one you start claude from." }
  else {
    $old = ''
    $encoding = $utf8
    if (Test-Path -LiteralPath $ProfilePath) {
      # Appends in the profile's own encoding (a UTF-16 profile stays UTF-16).
      $reader = New-Object IO.StreamReader($ProfilePath, $utf8, $true)
      try { $old = $reader.ReadToEnd(); $encoding = $reader.CurrentEncoding } finally { $reader.Close() }
    }
    if ($old -notmatch '(?m)^\s*\$env:CLAUDE_CODE_ENABLE_TODO_TOOLS\s*=') {
      $add = "# claude-progress-pane: Task tools for claude started from PowerShell. Not in`r`n" +
        "# ~/.claude/settings.json, whose env also reaches desktop-app sessions.`r`n$line`r`n"
      if (Test-Path -LiteralPath $ProfilePath) {
        Copy-Item -LiteralPath $ProfilePath "$ProfilePath.bak" -Force
        if ($old) { $add = "`r`n" + $add }
      }
      elseif (Split-Path $ProfilePath) { New-Item -ItemType Directory -Force -Path (Split-Path $ProfilePath) | Out-Null }
      $bytes = $encoding.GetBytes($add)
      $stream = [IO.File]::Open($ProfilePath, [IO.FileMode]::Append, [IO.FileAccess]::Write)
      try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Close() }
      $done += "added CLAUDE_CODE_ENABLE_TODO_TOOLS=1 to $ProfilePath"
      $other = 'pwsh'
      if ($PSVersionTable.PSEdition -eq 'Core') { $other = 'powershell' }
      if (Get-Command $other -ErrorAction SilentlyContinue) {
        $self = $claude
        foreach ($part in 'plugins', 'marketplaces', 'claude-progress-pane', 'scripts', 'setup.ps1') { $self = Join-Path $self $part }
        if ($Here -and (Test-Path -LiteralPath (Join-Path $Here 'setup.ps1'))) { $self = Join-Path $Here 'setup.ps1' }
        $done += "$other keeps its own profile. If you start claude from $other, also run: " +
          "$other -ExecutionPolicy Bypass -File `"$self`" -NoInstall"
      }
    }
    # The profile only runs where the execution policy lets scripts run. Process scope is
    # skipped: it is this run's -ExecutionPolicy Bypass, not what a new window gets.
    $policy = 'Undefined'
    try {
      foreach ($scope in 'MachinePolicy', 'UserPolicy', 'CurrentUser', 'LocalMachine') {
        $one = [string](Get-ExecutionPolicy -Scope $scope)
        if ($one -ne 'Undefined') { $policy = $one; break }
      }
    }
    catch { $policy = 'Unknown' }
    if ($policy -eq 'Restricted' -or $policy -eq 'AllSigned' -or $policy -eq 'Unknown' -or
        ($policy -eq 'Undefined' -and $PSVersionTable.PSEdition -ne 'Core')) {
      Write-Warning ("PowerShell's execution policy ($policy) may keep your profile from running, so " +
        'settings.json keeps CLAUDE_CODE_ENABLE_TODO_TOOLS for now. To move it: ' +
        'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned, then run this script again.')
    }
    else { $profileReady = $true }
  }

  # settings.json: edits the text of the pairs below and nothing else, so the file keeps
  # its indent and key order. Each edit is checked against the parsed file.
  function Edit-JsonPair([string]$json, [string]$key, $value) {
    # Changes one "key": value pair, or removes it when $value is $null. $null when the
    # key is not there exactly once.
    $val = '(?:"(?:[^"\\]|\\.)*"|-?[0-9][0-9.eE+-]*)'
    $pair = '"' + [regex]::Escape($key) + '"\s*:\s*' + $val
    if ([regex]::Matches($json, $pair).Count -ne 1) { return $null }
    if ($null -ne $value) {
      $quoted = '"' + ($value -replace '\\', '\\' -replace '"', '\"') + '"'
      return [regex]::Replace($json, '("' + [regex]::Escape($key) + '"\s*:\s*)' + $val,
        [Text.RegularExpressions.MatchEvaluator] { param($m) $m.Groups[1].Value + $quoted })
    }
    # A pair before a comma takes its comma and its own line along; the last pair takes the
    # comma before it; the only pair leaves {}.
    $forms = @(
      @{ re = '(?:(?<=\n)[ \t]*)?' + $pair + '[ \t]*,[ \t]*(?:\r?\n)?'; to = '' },
      @{ re = ',\s*' + $pair; to = '' },
      @{ re = '\{\s*' + $pair + '\s*\}'; to = '{}' })
    foreach ($form in $forms) {
      $re = [regex]$form.re
      if ($re.Matches($json).Count -eq 1) { return $re.Replace($json, $form.to) }
    }
    return $null
  }
  $settingsPath = Join-Path $claude 'settings.json'
  $text = ''
  $bom = $false
  $settings = $null
  if (Test-Path -LiteralPath $settingsPath) {
    # Strict UTF-8, BOM noted: a file this cannot read back byte for byte is left alone.
    $raw = [IO.File]::ReadAllBytes($settingsPath)
    $bom = $raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF
    $skip = 0
    if ($bom) { $skip = 3 }
    try {
      $text = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($raw, $skip, $raw.Length - $skip)
      if ($text.Trim()) { $settings = $text | ConvertFrom-Json }
    }
    catch { Write-Warning "settings.json is not UTF-8 JSON this script can read; left as it is." }
  }
  if ($null -ne $settings) {
    $next = $text
    $edits = @()
    if ($settings.PSObject.Properties['env'] -and $null -ne $settings.env) {
      $vars = $settings.env
      if ($vars.PSObject.Properties['CLAUDE_CODE_ENABLE_TODO_TOOLS'] -and
          [string]$vars.CLAUDE_CODE_ENABLE_TODO_TOOLS -eq '1') {
        if ($profileReady) {
          $vars.PSObject.Properties.Remove('CLAUDE_CODE_ENABLE_TODO_TOOLS')
          $next = Edit-JsonPair $next 'CLAUDE_CODE_ENABLE_TODO_TOOLS' $null
          $edits += 'removed CLAUDE_CODE_ENABLE_TODO_TOOLS from settings.json env (the profile sets it now)'
        }
        else { $done += 'kept CLAUDE_CODE_ENABLE_TODO_TOOLS in settings.json until the profile can set it' }
      }
      $oldMod = '[\\/]mods[\\/]project-progress[\\/]?$'
      if ($vars.PSObject.Properties['CLAUDE_CODE_PLUGIN_DIRS']) {
        $sep = [IO.Path]::PathSeparator
        $dirs = @([string]$vars.CLAUDE_CODE_PLUGIN_DIRS -split $sep | Where-Object { $_ })
        $keep = @($dirs | Where-Object { $_ -notmatch $oldMod })
        if ($keep.Count -ne $dirs.Count) {
          if ($keep.Count -eq 0) {
            $vars.PSObject.Properties.Remove('CLAUDE_CODE_PLUGIN_DIRS')
            if ($null -ne $next) { $next = Edit-JsonPair $next 'CLAUDE_CODE_PLUGIN_DIRS' $null }
          }
          else {
            $vars.CLAUDE_CODE_PLUGIN_DIRS = $keep -join $sep
            if ($null -ne $next) { $next = Edit-JsonPair $next 'CLAUDE_CODE_PLUGIN_DIRS' ($keep -join $sep) }
          }
          $dirs | Where-Object { $_ -match $oldMod } | ForEach-Object { $edits += "removed $_ from CLAUDE_CODE_PLUGIN_DIRS" }
        }
      }
    }
    if ($edits.Count -gt 0) {
      $same = $false
      if ($null -ne $next) {
        try {
          $want = $settings | ConvertTo-Json -Depth 64 -Compress
          $same = (($next | ConvertFrom-Json) | ConvertTo-Json -Depth 64 -Compress) -eq $want
        }
        catch { $same = $false }
      }
      if ($same) {
        Copy-Item -LiteralPath $settingsPath "$settingsPath.bak" -Force
        [IO.File]::WriteAllText($settingsPath, $next, (New-Object System.Text.UTF8Encoding $bom))
        $done += $edits
      }
      else {
        Write-Warning ("settings.json was left as it is; make these changes in its env by hand: " +
          ($edits -join '; '))
      }
    }
  }

  # CLAUDE.md
  $mdPath = Join-Path $claude 'CLAUDE.md'
  $md = ''
  if (Test-Path $mdPath) { $md = [IO.File]::ReadAllText($mdPath) }
  $pattern = '(?s)<!-- project-progress:start -->.*?<!-- project-progress:end -->'
  $next = $md
  if ($KeepRule) {
    # Beside this script, or in the marketplace's clone when the script came through iex.
    $ruleFile = ''
    if ($Here) { $ruleFile = Join-Path $Here 'claude-md-rule.md' }
    if (-not $ruleFile -or -not (Test-Path $ruleFile)) {
      $ruleFile = $claude
      foreach ($part in 'plugins', 'marketplaces', 'claude-progress-pane', 'scripts', 'claude-md-rule.md') {
        $ruleFile = Join-Path $ruleFile $part
      }
    }
    if (-not (Test-Path $ruleFile)) { Write-Warning "Rule file not found: $ruleFile"; return }
    $block = [IO.File]::ReadAllText($ruleFile).Trim()
    if ([regex]::IsMatch($md, $pattern)) {
      $next = [regex]::Replace($md, $pattern, [Text.RegularExpressions.MatchEvaluator] { param($m) $block })
    }
    else { $next = ($md.TrimEnd() + "`n`n" + $block).TrimStart() }
    $next = $next.TrimEnd() + "`n"
    $what = 'wrote the project-progress rule block'
  }
  elseif ([regex]::IsMatch($md, $pattern)) {
    $next = [regex]::Replace($md, "(\r?\n)*$pattern(\r?\n)*", "`n`n")
    if ($next.Trim()) { $next = $next.TrimStart("`r", "`n").TrimEnd() + "`n" } else { $next = '' }
    $what = 'removed the project-progress rule block (the plugin adds it now)'
  }
  if ($next -ne $md) {
    if (Test-Path $mdPath) { Copy-Item $mdPath "$mdPath.bak" -Force }
    [IO.File]::WriteAllText($mdPath, $next, $utf8)
    $done += "CLAUDE.md: $what"
  }

  if ($done.Count -eq 0) { Write-Host 'Settings: nothing to change.' }
  else { $done | ForEach-Object { Write-Host "- $_" } }
  $oldDir = Join-Path (Join-Path $claude 'mods') 'project-progress'
  if (Test-Path $oldDir) { Write-Host "The old install is still at $oldDir; delete it once the plugin works." }
  Write-Host 'Start claude again from a new PowerShell window. The pane opens by itself; /progress reopens it.'
  Write-Host 'Desktop-app sessions keep their own task list; note their work in progress.md by hand.'
}

Install-ProgressPane -KeepRule:$KeepRule -NoInstall:$NoInstall -Here $PSScriptRoot -ProfilePath $ProfilePath
