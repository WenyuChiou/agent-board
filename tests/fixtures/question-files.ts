import { captureJson, parseCapture } from '../../hooks/questions'
import type { HeldCapture, HeldProof, QuestionCapture, QuestionLedger, QuestionRecord } from '../../hooks/questions'
import { sha256 } from '../../hooks/sha256'

// The question files a folder piles up (#156), all made up. Question `n` is a ledger record the
// way the plugin writes it; a capture is the file kept of that record in one state.
const AT = Date.parse('2026-10-16T12:00:00Z')

export const question = (n: number, over: Partial<QuestionRecord> = {}): QuestionRecord => {
  const scope = JSON.stringify(['demo', 'codex', `syn${n}`])
  const words = `Synthetic question ${n}?`
  const binding = sha256(JSON.stringify([scope, words, 1, 1, `seed:${n}`]))

  return {
    id: `question:${binding}:${n}`, scope, words, occurrence: 1, copies: 1, isWaiting: true, isPresent: true, firstObserved: AT - 3_600_000, incarnation: `seed:${n}`, producer: '',
    source: { kind: 'block', project: 'demo', task: `Plan ${n}`, context: '', text: words, agent: 'codex', session: `syn${n}`, data: JSON.stringify({ n }) },
    isUnresolved: true, ...over,
  }
}
export const finished = (n: number): QuestionRecord => question(n, { isUnresolved: false, isWaiting: false, isPresent: false, resolvedAt: AT - 1000 })
// The question as it was while still open, which is what its first capture holds.
export const reopened = (record: QuestionRecord): QuestionRecord => ({ ...record, isUnresolved: true, isWaiting: true, isPresent: true, resolvedAt: undefined })
// The same question as its block changes: the id stays, the copy of the block differs.
export const edited = (n: number, version: number): QuestionRecord => ({ ...question(n), source: { ...question(n).source!, data: JSON.stringify({ n, version }) } })
export const held = (record: QuestionRecord, disposition: QuestionCapture['disposition'], mtimeMs: number): HeldCapture => {
  const body = captureJson(record, disposition)
  const hash = sha256(body)

  return { hash, mtimeMs, capture: parseCapture(body, hash)! }
}
export const ledgerOf = (...records: QuestionRecord[]): QuestionLedger => ({ version: 1, next: 1000, records, legacy: {} })
export const proof = (kind: HeldProof['kind'], key: string, mtimeMs: number): HeldProof => ({ kind, hash: sha256(key), mtimeMs })
export const named = (files: readonly { hash: string }[]): Set<string> => new Set(files.map(one => one.hash))
