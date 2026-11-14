import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length, 2, 'classifier exit observer anchor must be unique')
  return source.replace(before, () => after)
}

// A PID marker can be cut off or its number reused. Observe the Process instance
// the synthetic reporter owns; write only two booleans after its normal cleanup.
export const observeClassifierExit = (source, file) => {
  // The shared clock's milliseconds at Start(): how long the reporter spent before the classifier existed.
  source = replaceOnce(source, '    $isStarted = $process.Start()', `    $script:classifierStartMs = [int]$Clock.ElapsedMilliseconds
    $isStarted = $process.Start()`)
  source = replaceOnce(source, '      $process.Dispose()', `      $script:classifierExitProof = [ordered]@{ started = [bool]$isStarted; exited = $false; startMs = $script:classifierStartMs }
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
      && Object.keys(proof).every(key => ['started', 'exited', 'startMs'].includes(key))
      && proof.started === true && proof.exited === true
      && (proof.startMs === undefined || proof.startMs === null || Number.isInteger(proof.startMs))
  } catch {}
  // Do not render untrusted marker contents, paths or numeric process identities.
  try { assert.equal(isExited, true, 'the owned classifier process must be observed started and exited') }
  catch (error) { throw Object.assign(error, { code: 'CLASSIFIER_EXIT_UNPROVEN', keepFixture: true }) }
}

// The clock's milliseconds at Start(), for t.diagnostic: a number, or null when the proof has none.
export const classifierStartMs = file => {
  try {
    const { startMs } = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
    return Number.isInteger(startMs) && startMs >= 0 && startMs < 1e9 ? startMs : null
  } catch { return null }
}
