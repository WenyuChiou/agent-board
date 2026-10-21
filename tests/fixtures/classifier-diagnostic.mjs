import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const phases = ['budget', 'resolve', 'arguments', 'redirect', 'environment', 'construct', 'start', 'stdin', 'stdout', 'stderr', 'wait', 'output', 'errors', 'complete']
const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length, 2, 'classifier diagnostic anchor must be unique')
  return source.replace(before, () => after)
}

// Only synthetic test copies are instrumented. No messages, paths, arguments,
// environment values or stream contents are saved. File I/O is in the outer
// finally, after the final budget check, receipt operation and owned cleanup.
// Phase assignments still add small observer overhead within that deadline.
export const observeClassifier = (source, file) => {
  source = replaceOnce(source, '  $process = $null; $isStarted = $false', `  $process = $null; $isStarted = $false
  $probe = [ordered]@{ phase = 'budget'; started = $false; errorType = ''; hresult = 0; innerType = ''; innerHresult = 0; nativeCode = 0; exitCode = -1; outputLength = -1; errorLength = -1; elapsedMs = 0 }
  $output = $null; $errors = $null`)
  for (const [phase, line] of [
    ['resolve', '    $start.FileName ='], ['arguments', '    $start.Arguments ='],
    ['redirect', '    $start.UseShellExecute ='], ['environment', '    $start.EnvironmentVariables['],
    ['construct', '    $process = New-Object'], ['start', '    $isStarted = $process.Start()'],
    ['stdin', '    $process.StandardInput.Close()'], ['stdout', '    $output ='], ['stderr', '    $errors ='],
    ['wait', '    if ($remaining -le 0 -or -not $process.WaitForExit'],
    ['output', '    if ($remaining -le 0 -or -not $output.Wait'],
    ['errors', '    if ($remaining -le 0 -or -not $errors.Wait'],
    ['complete', '    if ($process.ExitCode -eq 0)'],
  ]) source = replaceOnce(source, line, `    $probe.phase = '${phase}'\n${line}`)
  source = replaceOnce(source, "    if ($_.Exception.Message -eq 'REPORTER_TIMEOUT') { throw }", `    $probe.errorType = $_.Exception.GetType().Name
    $probe.hresult = $_.Exception.HResult
    if ($null -ne $_.Exception.InnerException) {
      $probe.innerType = $_.Exception.InnerException.GetType().Name
      $probe.innerHresult = $_.Exception.InnerException.HResult
      if ($_.Exception.InnerException -is [ComponentModel.Win32Exception]) { $probe.nativeCode = $_.Exception.InnerException.NativeErrorCode }
    }
    if ($_.Exception.Message -eq 'REPORTER_TIMEOUT') { throw }`)
  source = replaceOnce(source, '      $process.Dispose()', `      try { if ($isStarted -and $process.HasExited) { $probe.exitCode = $process.ExitCode } } catch {}
      $process.Dispose()`)
  source = replaceOnce(source, "\n  }\n}\n$tmp = ''", `
    try {
      $probe.started = $isStarted
      if ($null -ne $output -and $output.Status -eq 'RanToCompletion') { $probe.outputLength = $output.Result.Length }
      if ($null -ne $errors -and $errors.Status -eq 'RanToCompletion') { $probe.errorLength = $errors.Result.Length }
      $probe.elapsedMs = $Clock.ElapsedMilliseconds
      $script:classifierProbe = $probe
    } catch {}
  }
}
$tmp = ''`)
  return replaceOnce(source, "\n}\nif ($Agent -eq 'cursor')", `
  try {
    if ($null -ne $script:classifierProbe) {
      $p = $script:classifierProbe
      $text = @($p.phase, [int]$p.started, $p.errorType, $p.hresult, $p.innerType, $p.innerHresult, $p.nativeCode, $p.exitCode, $p.outputLength, $p.errorLength, $p.elapsedMs) -join '|'
      [IO.File]::WriteAllText('${file.replaceAll("'", "''")}', $text, [Text.Encoding]::UTF8)
    }
  } catch {}
}
if ($Agent -eq 'cursor')`)
}

// Validate again on the Node side before exposing any diagnostic in TAP.
export const classifierDiagnostic = file => {
  let fields
  try { fields = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split('|') } catch { return 'classifier diagnostic unavailable' }
  if (fields.length !== 11 || !phases.includes(fields[0]) || !/^[01]$/.test(fields[1]) ||
      ![fields[2], fields[4]].every(value => /^[A-Za-z0-9_]{0,80}$/.test(value)) ||
      ![3, 5, 6, 7, 8, 9, 10].every(index => /^-?\d{1,12}$/.test(fields[index]))) return 'classifier diagnostic invalid'
  return `classifier phase=${fields[0]} started=${fields[1]} type=${fields[2]} hresult=${fields[3]} innerType=${fields[4]} innerHresult=${fields[5]} nativeCode=${fields[6]} exit=${fields[7]} stdoutChars=${fields[8]} stderrChars=${fields[9]} elapsedMs=${fields[10]}`
}
