import type { ProgressMirrorTask } from '../types'

// Explicit producer asks advance only this task. Heartbeats, list reloads and unrelated
// metadata keep its revision; decimal strings do not wrap a numeric counter.
export const renewQuestion = (task: ProgressMirrorTask, floor = '0'): ProgressMirrorTask => ({
  ...task,
  questionRevision: ([task.questionRevision ?? '0', floor].filter(value => /^\d+$/.test(value)).reduce((latest, value) => BigInt(value) > latest ? BigInt(value) : latest, 0n) + 1n).toString(),
})

// Every line the mod writes into a block. A comment opening in a title or step (the model's
// summing up, a first request) would hide every line up to the next `-->`, the next block's
// markers with them, so it is left out; an arrow that would close one is written `->`.
export const plain = (text: string): string => text.replace(/<!--/g, ' ').replace(/--+>/g, '->').replace(/\s+/g, ' ').trim()
export const oneLine = (text: string): string => plain(text).replace(/^#+\s*/, '').trim()

// A question the person answered finishes in the words it asked in. A finished step shows no
// note, and the question ledger knows a question by the words its step showed (questions.ts),
// so dropping the note would leave its record unresolved and the question listed as waiting.
// The native reporters' `[?]` → `[x]` keeps the words the same way. The note is folded in as
// `stepWords` (blocks.ts) showed it while the step waited: a blocked note wins over `why`.
export const answeredStep = (task: ProgressMirrorTask): ProgressMirrorTask => {
  const isBlocked = task.blocked !== null && task.blocked !== ''
  const why = task.why ?? ''
  return { ...task, subject: isBlocked || why === '' ? task.subject : `${task.subject} — ${oneLine(why)}`, status: 'completed', waiting: null, why: null }
}
