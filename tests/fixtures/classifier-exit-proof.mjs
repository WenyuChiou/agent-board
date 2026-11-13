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

// What the proof says, as one of four fixed words: 'exited'; 'running' (started, not seen exited); 'never-started'
// (no proof, or started false: the reporter's 2 s ran out before Start(), so no process exists to check); 'unreadable'.
export const classifierExitState = file => {
  let text
  try { text = readFileSync(file, 'utf8') } catch { return 'never-started' }
  let proof
  try { proof = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { return 'unreadable' }
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof) || Object.keys(proof).length !== 2
    || typeof proof.started !== 'boolean' || typeof proof.exited !== 'boolean') return 'unreadable'
  if (!proof.started) return proof.exited ? 'unreadable' : 'never-started'
  return proof.exited ? 'exited' : 'running'
}

export const assertClassifierExited = file => {
  const state = classifierExitState(file)
  // Name only the state, never the marker's contents, paths or process identities.
  try { assert.equal(state, 'exited', `the owned classifier process must be observed started and exited (seen: ${state})`) }
  catch (error) { throw Object.assign(error, { code: 'CLASSIFIER_EXIT_UNPROVEN', keepFixture: true }) }
}
