import assert from 'node:assert/strict'
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

const codes = ['INPUT_TIMEOUT', 'REPORTER_TIMEOUT', 'INPUT_TOO_LARGE', 'INCOMPLETE_INPUT', 'REPORTER_FAILED', 'REPORTER_INTERRUPTED', 'CLEANUP_FAILED']
const choice = (value, known) => value == null ? null : known.includes(value) ? value : 'OTHER'
const number = value => Number.isFinite(value) ? Math.min(999999999, Math.max(0, Math.round(value))) : null

// Read only a bounded tail from this synthetic fixture, never an ambient log.
const hookEvidence = home => {
  let fd
  try {
    const file = join(home, '.agent-board', 'hook-errors.log')
    const entry = lstatSync(file)
    if (!entry.isFile() || entry.isSymbolicLink()) return { logState: 'unavailable', fixtureHistoryCodes: [] }
    fd = openSync(file, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { logState: 'unavailable', fixtureHistoryCodes: [] }
    const bytes = Buffer.alloc(Math.min(stat.size, 4096))
    const length = readSync(fd, bytes, 0, bytes.length, Math.max(0, stat.size - bytes.length))
    const found = bytes.subarray(0, length).toString('utf8').split(/\r?\n/).flatMap(line => {
      const match = /^\d{4}-\d\d-\d\dT[\d:.]+Z (?:gemini|codex) prompt ([A-Z_]+)$/.exec(line)
      return match && codes.includes(match[1]) ? [match[1]] : []
    }).slice(-4)
    return { logState: found.length ? 'codes' : length ? 'unrecognized' : 'empty', fixtureHistoryCodes: found }
  } catch (error) {
    return { logState: error.code === 'ENOENT' ? 'absent' : 'unavailable', fixtureHistoryCodes: [] }
  } finally { if (fd !== undefined) { try { closeSync(fd) } catch {} } }
}

export const promptReceiptDiagnostic = (result, context, home) => `prompt receipt ${JSON.stringify({
  program: choice(context.program, ['sh', 'powershell']),
  mode: choice(context.mode, ['stdin', 'argument']),
  classifier: choice(context.classifier, ['missing', 'failed', 'empty']),
  isBoardCommand: typeof context.isBoardCommand === 'boolean' ? context.isBoardCommand : null,
  launchToReturnMs: number(context.elapsedMs), reporterBudgetMs: number(context.budgetMs),
  expectedReceipts: number(context.expectedReceipts), actualReceipts: number(context.actualReceipts),
  status: Number.isInteger(result.status) && Math.abs(result.status) <= 255 ? result.status : null,
  signal: choice(result.signal, ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGINT']),
  errorCode: choice(result.error?.code, ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EIO', 'ENOBUFS']),
  stdoutChars: typeof result.stdout === 'string' ? number(result.stdout.length) : null,
  stderrChars: typeof result.stderr === 'string' ? number(result.stderr.length) : null,
  ...hookEvidence(home),
})}`

export const assertPromptReceiptCount = (result, context, home) => {
  assert.equal(context.actualReceipts, context.expectedReceipts,
    context.actualReceipts === context.expectedReceipts ? undefined : promptReceiptDiagnostic(result, context, home))
}
