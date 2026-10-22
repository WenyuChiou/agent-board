import { expect, test } from 'claude-code/testing'
import { claimAction, CLAIM_MS, inboxOrder, isInboxFile, isQuestionHold, isQuestionStale, MAX_TRIES, normalizeTurnOrder, QUESTION_HOLD, QUESTION_KEEP_MS, readClaim, readTurn, RETAKE_TRY, retakenFailedName, setAsideOf, takenName, turnOrder } from '../hooks/inbox'
import { EN } from '../hooks/strings-en'
import { ZH_TW } from '../hooks/i18n'
import { ZH_CN } from '../hooks/strings-zh-cn'

test('only an exact set-aside name of an inbox file is read as set aside', () => {
  const name = 'codex-turn-1792216380-1.json'
  expect(setAsideOf(`${name}.failed`)).toBe(name)
  expect(setAsideOf('opencode-end-1792216380-2.json.failed')).toBe('opencode-end-1792216380-2.json')
  for (const file of [name, `${name}.failed.1`, `${name}.failed.2`, `${name}.FAILED`, 'other.json.failed', takenName(name, 'deadbeef', 1792216380000), `${takenName(name, 'deadbeef', 1792216380000)}.failed`]) {
    expect(setAsideOf(file)).toBeNull()
  }
})

test('only a note naming the question hold exactly counts as the hold', () => {
  expect(isQuestionHold(`8:1792216380000:${QUESTION_HOLD}`)).toBe(true)
  expect(isQuestionHold(`9:1792216380000:${QUESTION_HOLD}`)).toBe(false)
  for (const note of [undefined, '', QUESTION_HOLD, `8:${QUESTION_HOLD}`, '1:1792216380000:INVALID_INPUT', `8:1792216380000:${QUESTION_HOLD}:extra`, `8:1792216380000: ${QUESTION_HOLD}`, `8:1792216380000:${QUESTION_HOLD} `, `:1792216380000:${QUESTION_HOLD}`, `8::${QUESTION_HOLD}`, `8.5:1792216380000:${QUESTION_HOLD}`, `eight:1792216380000:${QUESTION_HOLD}`, `8:NaN:${QUESTION_HOLD}`, `8:1e12:${QUESTION_HOLD}`]) {
    expect(isQuestionHold(note)).toBe(false)
  }
})

test('a question is stale only past three days from its file\'s time', () => {
  const at = 1792216380000
  expect(QUESTION_KEEP_MS).toBe(3 * 24 * 60 * 60 * 1000)
  for (const name of ['codex-turn-1792216380-1.json', 'codex-turn-1792216380000-1.json']) {
    expect(isQuestionStale(name, at + QUESTION_KEEP_MS - 1)).toBe(false)
    expect(isQuestionStale(name, at + QUESTION_KEEP_MS)).toBe(false)
    expect(isQuestionStale(name, at + QUESTION_KEEP_MS + 1)).toBe(true)
    expect(isQuestionStale(name, at - 1)).toBe(false)
  }
  expect(isQuestionStale('codex-turn-unknown.json', at + QUESTION_KEEP_MS + 1)).toBe(false)
})

test('a turn set aside again after its one retake gets a name no look takes again', () => {
  const name = 'codex-turn-1792216380-1.json'
  const at = 1792216380000
  const claim = readClaim(takenName(name, 'deadbeef', at, RETAKE_TRY))!
  expect(RETAKE_TRY).toBe(MAX_TRIES + 1)
  expect(claim.attempt).toBe(9)
  expect(claimAction(claim, at, at + CLAIM_MS + 1)).toBe('setAside')
  expect(retakenFailedName(name)).toBe(`${name}.retaken.failed`)
  for (const file of [retakenFailedName(name), `${retakenFailedName(name)}.1`, `${retakenFailedName(name)}.2`]) {
    expect(setAsideOf(file)).toBeNull()
    expect(isInboxFile(file)).toBe(false)
    expect(readClaim(file)).toBeNull()
  }
})

test('reporter seconds and milliseconds share a chronological order', () => {
  const earlier = 'codex-turn-1792216380000-1.json'
  const later = 'codex-turn-1792216400-2.json'
  expect(inboxOrder(earlier, later)).toBeLessThan(0)
  const body = JSON.stringify({ session_id: 'synthetic', last_assistant_message: 'Fixture.' })
  expect(turnOrder(readTurn(earlier, body)!)).toBeLessThan(turnOrder(readTurn(later, body)!)!)
})

test('legacy stored order migrates seconds while preserving its end-event bit', () => {
  expect(normalizeTurnOrder(1792216380 * 2)).toBe(1792216380000 * 2)
  expect(normalizeTurnOrder(1792216380 * 2 + 1)).toBe(1792216380000 * 2 + 1)
  expect(normalizeTurnOrder(1792216380000 * 2 + 1)).toBe(1792216380000 * 2 + 1)
  expect(normalizeTurnOrder(undefined)).toBeUndefined()
  expect(normalizeTurnOrder(NaN)).toBeUndefined()
  expect(normalizeTurnOrder(-1)).toBeUndefined()
})

test('retained inbox notices name the file and reason in every language', () => {
  for (const s of [EN, ZH_TW, ZH_CN]) {
    expect(s.inboxTitle.length).toBeGreaterThan(0)
    expect(s.inboxHeld('fixture.failed', 'INVALID_INPUT')).toContain('fixture.failed')
    expect(s.inboxHeld('fixture.failed', 'INVALID_INPUT')).toContain('INVALID_INPUT')
  }
})

test('the same reporter instant orders a turn before its end across timestamp units', () => {
  expect(inboxOrder('codex-turn-1792216380000-1.json', 'codex-end-1792216380-2.json')).toBeLessThan(0)
  expect(inboxOrder('codex-end-1792216380-1.json', 'codex-turn-1792216380000-2.json')).toBeGreaterThan(0)
})
