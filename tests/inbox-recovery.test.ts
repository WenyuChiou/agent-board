import { expect, test } from 'claude-code/testing'
import { inboxOrder, normalizeTurnOrder, readTurn, turnOrder } from '../hooks/inbox'
import { EN } from '../hooks/strings-en'
import { ZH_TW } from '../hooks/i18n'
import { ZH_CN } from '../hooks/strings-zh-cn'

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
