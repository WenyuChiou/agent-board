import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HOOK_INPUT_TIMEOUT } from '../../hooks/hook-safety.ts'

const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length, 2, 'classifier exit observer anchor must be unique')
  return source.replace(before, () => after)
}

// The classifier's first budget check, at the top of Read-PromptReceipt.
const FIRST_CHECK = '  try {\n    if ($Clock.ElapsedMilliseconds -ge '

// A started and hung classifier: the clock starts again where the classifier's work begins, so the
// cold first cmdlets of a fresh runner, which run before it, cannot spend the budget before Start();
// only the node lookup still counts. The 2 s wait, the kill and the receipt path stay the shipped code.
export const restartBudgetAtClassifier = source => replaceOnce(source, FIRST_CHECK, FIRST_CHECK.replace('  try {\n', '  try {\n    $Clock.Restart()\n'))

// The budget already spent when the classifier's work begins: the first check always throws.
export const spendBudgetBeforeClassifier = source => replaceOnce(source, `${FIRST_CHECK}${HOOK_INPUT_TIMEOUT})`, `${FIRST_CHECK}0)`)

// A PID marker can be cut off or its number reused. Observe the Process instance the synthetic
// reporter owns, and write only two booleans. The proof is set on every exit of Read-PromptReceipt,
// so a run that never started the classifier says so; a missing proof means it was never reached.
// The wait before HasExited is the observer's alone: an event wait for the exit the shipped Kill()
// asked for, so a slow exit is not read as running. It sets no limit for the reporter or the test.
export const observeClassifierExit = (source, file) => {
  source = replaceOnce(source, '  } finally {\n    if ($null -ne $process) {', `  } finally {
    $script:classifierExitProof = [ordered]@{ started = [bool]$isStarted; exited = $false }
    if ($null -ne $process) {`)
  source = replaceOnce(source, '      $process.Dispose()', `      try { if ($isStarted) { $null = $process.WaitForExit(30000); $script:classifierExitProof.exited = [bool]$process.HasExited } } catch {}
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

// What the proof says, as one fixed word, for the failure message only: 'exited'; 'running' (started,
// not seen exited); 'never-started' (the budget ran out before Start()); 'no-proof' (no file: the
// reporter never reached the classifier); 'unreadable'.
export const classifierExitState = file => {
  let text
  try { text = readFileSync(file, 'utf8') } catch { return 'no-proof' }
  let proof
  try { proof = JSON.parse(text.replace(/^﻿/, '')) } catch { return 'unreadable' }
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
