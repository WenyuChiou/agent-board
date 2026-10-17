# Runs scripts/setup.ps1 -NoInstall against throwaway folders and checks what it wrote.
# Never touches the real ~/.claude or PowerShell profile: CLAUDE_CONFIG_DIR and -ProfilePath
# point into a temp folder. `claude plugin test` does not run it:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/setup.check.ps1
# The execution policy setup.ps1 sees is faked (a Get-ExecutionPolicy function shadows the
# cmdlet), so the result does not depend on this machine's policy.
$ErrorActionPreference = 'Stop'
$setup = Join-Path $PSScriptRoot '..\scripts\setup.ps1'
$utf8 = New-Object System.Text.UTF8Encoding $false
$script:fails = 0
$script:dirs = @()

function Check([string]$name, [bool]$ok) {
  if ($ok) { Write-Host "(pass) $name" } else { Write-Host "(fail) $name"; $script:fails++ }
}

# A temp folder with .claude/settings.json holding $settings ($null: no file).
function New-Case($settings) {
  $dir = Join-Path ([IO.Path]::GetTempPath()) ('progress-setup-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path (Join-Path $dir '.claude') | Out-Null
  if ($null -ne $settings) { [IO.File]::WriteAllText((Join-Path $dir '.claude\settings.json'), $settings, $utf8) }
  $script:dirs += $dir
  $dir
}

# Runs setup.ps1 for the case, with Get-ExecutionPolicy answering $policy (PowerShell code:
# a quoted name, or a throw); returns what it printed.
function Invoke-Setup([string]$dir, [string]$policy = "'RemoteSigned'", [string]$extra = '') {
  $saved = @{ config = $env:CLAUDE_CONFIG_DIR; user = $env:USERPROFILE; codex = $env:CODEX_HOME; xdg = $env:XDG_CONFIG_HOME }
  $env:CLAUDE_CONFIG_DIR = Join-Path $dir '.claude'
  $env:USERPROFILE = $dir   # where -Agents looks for ~\.codex, ~\.gemini, ~\.config
  $env:CODEX_HOME = $null
  $env:XDG_CONFIG_HOME = $null
  $ErrorActionPreference = 'Continue'   # a warning on stderr is output to check, not a stop
  try {
    $cmd = "function Get-ExecutionPolicy { param(`$Scope) $policy }; " +
      "& '$setup' -NoInstall -ProfilePath '$(Join-Path $dir 'profile.ps1')' $extra"
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -Command $cmd 2>&1
    ($out | Out-String)
  }
  finally {
    $env:CLAUDE_CONFIG_DIR = $saved.config
    $env:USERPROFILE = $saved.user
    $env:CODEX_HOME = $saved.codex
    $env:XDG_CONFIG_HOME = $saved.xdg
  }
}

function Read-Settings([string]$dir) { [IO.File]::ReadAllText((Join-Path $dir '.claude\settings.json')) }
function Count-Line([string]$text) { ([regex]::Matches($text, '(?m)^\$env:CLAUDE_CODE_ENABLE_TODO_TOOLS = "1"')).Count }

try {
  # 1. A key in the middle goes with its line; the old zip dir leaves the list; nothing else moves.
  $dir = New-Case (@(
      '{',
      '  "env": {',
      '    "A": "x",',
      '    "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",',
      '    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\me\\.claude\\mods\\project-progress;D:\\kit\\mods\\other"',
      '  },',
      '  "zeta": [1, 2],',
      '  "alpha": {"b": true}',
      '}',
      '') -join "`n")
  Invoke-Setup $dir | Out-Null
  $want = @(
    '{',
    '  "env": {',
    '    "A": "x",',
    '    "CLAUDE_CODE_PLUGIN_DIRS": "D:\\kit\\mods\\other"',
    '  },',
    '  "zeta": [1, 2],',
    '  "alpha": {"b": true}',
    '}',
    '') -join "`n"
  Check 'settings.json: the key and the old zip dir leave; indent, key order and the rest stay' ((Read-Settings $dir) -ceq $want)
  Check 'settings.json: the old file is kept as settings.json.bak' (Test-Path (Join-Path $dir '.claude\settings.json.bak'))

  # 2. The last key takes the comma before it; CRLF stays CRLF.
  $dir = New-Case "{`r`n  `"env`": {`r`n    `"A`": `"x`",`r`n    `"CLAUDE_CODE_ENABLE_TODO_TOOLS`": `"1`"`r`n  }`r`n}`r`n"
  Invoke-Setup $dir | Out-Null
  Check 'settings.json: the last key takes the comma before it, CRLF kept' `
    ((Read-Settings $dir) -ceq "{`r`n  `"env`": {`r`n    `"A`": `"x`"`r`n  }`r`n}`r`n")

  # 3. The only key leaves {}; one-line JSON stays one line.
  $dir = New-Case '{"env": {"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"}, "model": "opus"}'
  Invoke-Setup $dir | Out-Null
  Check 'settings.json: the only key leaves an empty env' ((Read-Settings $dir) -ceq '{"env": {}, "model": "opus"}')

  # 4. A value other than "1" is the person's own: untouched, no backup.
  $text = "{`n  `"env`": {`n    `"CLAUDE_CODE_ENABLE_TODO_TOOLS`": `"0`"`n  }`n}`n"
  $dir = New-Case $text
  Invoke-Setup $dir | Out-Null
  Check 'settings.json: CLAUDE_CODE_ENABLE_TODO_TOOLS=0 is left alone' `
    ((Read-Settings $dir) -ceq $text -and -not (Test-Path (Join-Path $dir '.claude\settings.json.bak')))

  # 5. The key twice in the text: no exact edit, so the file stays and a warning says what to do.
  $text = '{"env": {"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"}, "x": {"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"}}'
  $dir = New-Case $text
  $out = Invoke-Setup $dir
  Check 'settings.json: an edit that cannot be exact leaves the file and warns' `
    ((Read-Settings $dir) -ceq $text -and $out -match 'by hand')

  # 6. No settings.json: none is made. The profile is made with the line, once.
  $dir = New-Case $null
  Invoke-Setup $dir | Out-Null
  Invoke-Setup $dir | Out-Null
  $profileText = ''
  if (Test-Path (Join-Path $dir 'profile.ps1')) { $profileText = [IO.File]::ReadAllText((Join-Path $dir 'profile.ps1')) }
  Check 'no settings.json: none is created' (-not (Test-Path (Join-Path $dir '.claude\settings.json')))
  Check 'profile: created with the line, and a re-run does not add it twice' ((Count-Line $profileText) -eq 1)
  Check 'profile: the added text is ASCII' (-not ($profileText -match '[^\x00-\x7F]'))
  Check 'no CLAUDE.md: none is created' (-not (Test-Path (Join-Path $dir '.claude\CLAUDE.md')))

  # 7. An existing UTF-16 profile keeps its text and its encoding.
  $dir = New-Case $null
  $profile16 = Join-Path $dir 'profile.ps1'
  $mine = "# " + [char]0x6211 + [char]0x7684 + " profile`r`nSet-Alias ll Get-ChildItem`r`n"   # CJK: not ANSI-safe
  [IO.File]::WriteAllText($profile16, $mine, [Text.Encoding]::Unicode)
  Invoke-Setup $dir | Out-Null
  $bytes = [IO.File]::ReadAllBytes($profile16)
  $back = [IO.File]::ReadAllText($profile16, [Text.Encoding]::Unicode)
  Check 'profile: a UTF-16 profile keeps its BOM, its text, and gets the line in UTF-16' `
    ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE -and
     $back.TrimStart([char]0xFEFF).StartsWith($mine) -and (Count-Line $back) -eq 1)
  Check 'profile: the old one is kept as profile.ps1.bak' (Test-Path (Join-Path $dir 'profile.ps1.bak'))

  # 8. A profile that already sets the key, in any form, is left alone.
  $dir = New-Case $null
  $own = "`$env:CLAUDE_CODE_ENABLE_TODO_TOOLS='1'`r`n"
  [IO.File]::WriteAllText((Join-Path $dir 'profile.ps1'), $own, $utf8)
  Invoke-Setup $dir | Out-Null
  Check 'profile: one that already sets the key is left alone' `
    (([IO.File]::ReadAllText((Join-Path $dir 'profile.ps1'))) -ceq $own -and -not (Test-Path (Join-Path $dir 'profile.ps1.bak')))

  # 9. A UTF-8 BOM stays.
  $dir = New-Case $null
  $bomText = "{`n  `"env`": {`n    `"CLAUDE_CODE_ENABLE_TODO_TOOLS`": `"1`",`n    `"A`": `"x`"`n  }`n}`n"
  [IO.File]::WriteAllText((Join-Path $dir '.claude\settings.json'), $bomText, (New-Object System.Text.UTF8Encoding $true))
  Invoke-Setup $dir | Out-Null
  $raw = [IO.File]::ReadAllBytes((Join-Path $dir '.claude\settings.json'))
  Check 'settings.json: a UTF-8 BOM stays' `
    ($raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF -and
     $utf8.GetString($raw, 3, $raw.Length - 3) -ceq "{`n  `"env`": {`n    `"A`": `"x`"`n  }`n}`n")

  # 10. Bytes that are not UTF-8 (cp950 text in a hook command): left alone, with a warning.
  $dir = New-Case $null
  $ansi = [byte[]](@([Text.Encoding]::ASCII.GetBytes('{"statusLine": "echo ')) + @(0xA4, 0xA4, 0xA4, 0xE5) +
    @([Text.Encoding]::ASCII.GetBytes('", "env": {"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"}}')))
  [IO.File]::WriteAllBytes((Join-Path $dir '.claude\settings.json'), $ansi)
  $out = Invoke-Setup $dir
  $after = [IO.File]::ReadAllBytes((Join-Path $dir '.claude\settings.json'))
  Check 'settings.json: bytes that are not UTF-8 are left alone, with a warning' `
    ([Convert]::ToBase64String($after) -ceq [Convert]::ToBase64String($ansi) -and $out -match 'left as it is')

  # 11. Only the zip dir to drop, beside a dir with $ and a quote in its name.
  $dir = New-Case ('{"env": {"CLAUDE_CODE_PLUGIN_DIRS": "C:\\a\\mods\\project-progress;D:\\$x\\o\"q"}}')
  Invoke-Setup $dir | Out-Null
  Check 'settings.json: the zip dir leaves CLAUDE_CODE_PLUGIN_DIRS; $ and a quote survive' `
    ((Read-Settings $dir) -ceq '{"env": {"CLAUDE_CODE_PLUGIN_DIRS": "D:\\$x\\o\"q"}}')

  # 12. A policy that keeps the profile from running, or one that cannot be read: the key
  # stays in settings.json (else terminal sessions lose the Task tools too); the zip dir
  # still leaves; the profile still gets its line for later.
  foreach ($policy in "'Restricted'", "throw 'no policy'") {
    $dir = New-Case "{`n  `"env`": {`n    `"CLAUDE_CODE_ENABLE_TODO_TOOLS`": `"1`",`n    `"CLAUDE_CODE_PLUGIN_DIRS`": `"C:\\a\\mods\\project-progress`"`n  }`n}`n"
    $out = Invoke-Setup $dir $policy
    Check "policy $policy`: settings.json keeps the key, the zip dir leaves, and it says why" `
      ((Read-Settings $dir) -ceq "{`n  `"env`": {`n    `"CLAUDE_CODE_ENABLE_TODO_TOOLS`": `"1`"`n  }`n}`n" -and
       $out -match 'Set-ExecutionPolicy' -and
       (Count-Line ([IO.File]::ReadAllText((Join-Path $dir 'profile.ps1')))) -eq 1)
  }

  # 13. The marketplace entry gets autoUpdate first, in its own indent; nothing else moves.
  $entry = @(
    '{',
    '  "extraKnownMarketplaces": {',
    '    "agent-board": {',
    '      "source": {',
    '        "source": "github",',
    '        "repo": "WenyuChiou/agent-board"',
    '      }',
    '    }',
    '  },',
    '  "enabledPlugins": {',
    '    "agent-board@agent-board": true',
    '  }',
    '}',
    '')
  $dir = New-Case ($entry -join "`n")
  Invoke-Setup $dir | Out-Null
  $want = @($entry[0..2]) + @('      "autoUpdate": true,') + @($entry[3..($entry.Count - 1)])
  Check 'auto-update: the marketplace entry gets "autoUpdate": true, the rest stays' ((Read-Settings $dir) -ceq ($want -join "`n"))

  # 14. On one line it stays on one line.
  $dir = New-Case '{"extraKnownMarketplaces": {"agent-board": {"source": {"source": "github", "repo": "WenyuChiou/agent-board"}}}}'
  Invoke-Setup $dir | Out-Null
  Check 'auto-update: an entry on one line stays on one line' `
    ((Read-Settings $dir) -ceq '{"extraKnownMarketplaces": {"agent-board": {"autoUpdate": true, "source": {"source": "github", "repo": "WenyuChiou/agent-board"}}}}')

  # 15. Turned off by hand: stays off, and the file is not touched.
  $text = "{`n  `"extraKnownMarketplaces`": {`n    `"agent-board`": {`n      `"source`": {`"source`": `"github`", `"repo`": `"WenyuChiou/agent-board`"},`n      `"autoUpdate`": false`n    }`n  }`n}`n"
  $dir = New-Case $text
  Invoke-Setup $dir | Out-Null
  Check 'auto-update: "autoUpdate": false is left alone' `
    ((Read-Settings $dir) -ceq $text -and -not (Test-Path (Join-Path $dir '.claude\settings.json.bak')))

  # 16. No marketplace entry (the plugin not installed yet): nothing is added.
  $dir = New-Case '{"model": "opus"}'
  Invoke-Setup $dir | Out-Null
  Check 'auto-update: no marketplace entry, nothing added' ((Read-Settings $dir) -ceq '{"model": "opus"}')

  # 17. -Agents auto writes the section into the agents installed here, between markers.
  $dir = New-Case $null
  New-Item -ItemType Directory -Path (Join-Path $dir '.codex'), (Join-Path $dir '.gemini') | Out-Null
  $codexPath = Join-Path $dir '.codex\AGENTS.md'
  [IO.File]::WriteAllText($codexPath, "# My rules`n`nUse tabs.`n", $utf8)
  Invoke-Setup $dir "'RemoteSigned'" '-Agents auto' | Out-Null
  $codexText = [IO.File]::ReadAllText($codexPath)
  Check 'agents: Codex keeps its own text and gets the section after it' `
    ($codexText.StartsWith("# My rules`n`nUse tabs.`n") -and $codexText.Contains('## Report your progress to the progress pane') -and
     $codexText.Contains('agent-board:end') -and (Test-Path "$codexPath.bak"))
  Check 'agents: Gemini CLI gets GEMINI.md with the section' `
    ([IO.File]::ReadAllText((Join-Path $dir '.gemini\GEMINI.md')).Contains('agent=NAME'))
  Check 'agents: OpenCode, not installed here, gets nothing' (-not (Test-Path (Join-Path $dir '.config\opencode\AGENTS.md')))
  Invoke-Setup $dir "'RemoteSigned'" '-Agents auto' | Out-Null
  Check 'agents: a second run changes nothing' ([IO.File]::ReadAllText($codexPath) -ceq $codexText)
  Invoke-Setup $dir "'RemoteSigned'" '-RemoveAgents' | Out-Null
  Check 'agents: -RemoveAgents takes the section out and leaves the rest' `
    ([IO.File]::ReadAllText($codexPath) -ceq "# My rules`n`nUse tabs.`n" -and
     -not ([IO.File]::ReadAllText((Join-Path $dir '.gemini\GEMINI.md')).Contains('progress pane')))

  # 18. Without -Agents it only says what it found; Codex's override file; an unknown name.
  $dir = New-Case $null
  New-Item -ItemType Directory -Path (Join-Path $dir '.codex') | Out-Null
  [IO.File]::WriteAllText((Join-Path $dir '.codex\AGENTS.override.md'), "Override rules`n", $utf8)
  $out = Invoke-Setup $dir
  Check 'agents: without -Agents it only says which agents it found' ($out -match 'codex installed here too')
  Invoke-Setup $dir "'RemoteSigned'" '-Agents codex,opencode' | Out-Null
  Check 'agents: Codex reads AGENTS.override.md when it has text, so the section goes there' `
    ([IO.File]::ReadAllText((Join-Path $dir '.codex\AGENTS.override.md')).Contains('agent-board:start') -and
     -not (Test-Path (Join-Path $dir '.codex\AGENTS.md')))
  Check 'agents: a named agent gets the section even before it has a folder' `
    ([IO.File]::ReadAllText((Join-Path $dir '.config\opencode\AGENTS.md')).Contains('agent-board:start'))
  $out = Invoke-Setup $dir "'RemoteSigned'" '-Agents copilot'
  Check 'agents: an unknown name is refused' ($out -match 'unknown agent: copilot')
  [IO.File]::WriteAllText((Join-Path $dir '.codex\hooks.json'), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"powershell -File progress-report.ps1 codex turn"}]}]}}', $utf8)
  Remove-Item -LiteralPath (Join-Path $dir '.codex\AGENTS.override.md') -Force
  $out = Invoke-Setup $dir "'RemoteSigned'" '-Agents codex'
  Check 'agents: an agent hooked by /progress connect gets no section' `
    (($out -match 'codex: reports through its hook') -and -not (Test-Path (Join-Path $dir '.codex\AGENTS.md')))

  # 19. Written under the old name: the agent section is replaced, not doubled; an auto-update
  # turned off then stays off; the old CLAUDE.md block goes.
  $text = "{`n  `"extraKnownMarketplaces`": {`n    `"claude-progress-pane`": {`n      `"autoUpdate`": false`n    },`n    `"agent-board`": {`n      `"source`": {`"source`": `"github`", `"repo`": `"WenyuChiou/agent-board`"}`n    }`n  }`n}`n"
  $dir = New-Case $text
  New-Item -ItemType Directory -Path (Join-Path $dir '.codex') | Out-Null
  $codexPath = Join-Path $dir '.codex\AGENTS.md'
  [IO.File]::WriteAllText($codexPath, "# My rules`n`n<!-- claude-progress-pane:start -->`n## Report your progress to the progress pane`nold text`n<!-- claude-progress-pane:end -->`n", $utf8)
  [IO.File]::WriteAllText((Join-Path $dir '.claude\CLAUDE.md'), "# Mine`n`n<!-- project-progress:start -->`n## old rule`n<!-- project-progress:end -->`n", $utf8)
  Invoke-Setup $dir "'RemoteSigned'" '-Agents codex' | Out-Null
  $codexText = [IO.File]::ReadAllText($codexPath)
  Check 'old name: the Codex section is replaced by one under the new markers' `
    ($codexText.StartsWith("# My rules`n") -and ([regex]::Matches($codexText, 'agent-board:start')).Count -eq 1 -and
     -not $codexText.Contains('claude-progress-pane:') -and -not $codexText.Contains('old text'))
  Check 'old name: an auto-update turned off under it stays off' ((Read-Settings $dir) -ceq $text)
  Check 'old name: the old CLAUDE.md block goes' ([IO.File]::ReadAllText((Join-Path $dir '.claude\CLAUDE.md')) -ceq "# Mine`n")
  Invoke-Setup $dir "'RemoteSigned'" '-RemoveAgents' | Out-Null
  Check 'old name: -RemoveAgents takes the new section out' ([IO.File]::ReadAllText($codexPath) -ceq "# My rules`n")
}
finally {
  foreach ($one in $script:dirs) { if (Test-Path $one) { Remove-Item -LiteralPath $one -Recurse -Force } }
}

Write-Host ''
if ($script:fails -gt 0) { Write-Host "$($script:fails) fail"; exit 1 }
Write-Host 'all pass'
