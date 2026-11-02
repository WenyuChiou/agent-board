import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length, 2, 'classifier exit observer anchor must be unique')
  return source.replace(before, () => after)
}

// A PID marker can be cut off or its number reused. Observe the Process instance
// the synthetic reporter owns; write only two booleans after its normal cleanup.
export const observeClassifierExit = (source, file) => {
  source = replaceOnce(source, '      $process.Dispose()', `      $script:classifierExitProof = [ordered]@{ started = [bool]$isStarted; exited = $false }
      try { if ($isStarted) { $script:classifierExitProof.exited = [bool]$process.HasExited } } catch {}
      $process.Dispose()`)
  return replaceOnce(source, "\n}\nif ($Agent -eq 'cursor')", `
  try {
    if ($null -ne $script:classifierExitProof) {
      [IO.File]::WriteAllText('${file.replaceAll("'", "''")}', (ConvertTo-Json -InputObject $script:classifierExitProof -Compress), [Text.Encoding]::UTF8)
    }
  } catch {}
}
if ($Agent -eq 'cursor')`)
}

export const assertClassifierExited = file => {
  let isExited = false
  try {
    const proof = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    isExited = proof !== null && typeof proof === 'object' && !Array.isArray(proof)
      && Object.keys(proof).length === 2 && proof.started === true && proof.exited === true
  } catch {}
  // Do not render untrusted marker contents, paths or numeric process identities.
  try { assert.equal(isExited, true, 'the owned classifier process must be observed started and exited') }
  catch (error) { throw Object.assign(error, { code: 'CLASSIFIER_EXIT_UNPROVEN', keepFixture: true }) }
}
