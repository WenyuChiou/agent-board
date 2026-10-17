import { expect, test } from 'claude-code/testing'
import { chatDigest, chatText, reportMode } from '../hooks/chat'
import type { ChatSnapshot } from '../hooks/chat'
import { peekInbox } from '../hooks/board'
import { blockId } from '../hooks/inbox'
import { localDay, parseJournal } from '../hooks/journal'
import { parseProgress } from '../hooks/parse'
import { STRINGS } from '../hooks/strings'

const NOW = Date.parse('2026-10-16T12:00:00Z')
const EN = STRINGS.en
const stamp = (hours = 1): string => new Date(NOW - hours * 3600000).toISOString()
const block = (title: string, steps: string, id = 'aabbccdd', hours = 1, state = 'waiting'): string =>
  `## Example project\n<!-- auto session=${id} agent=codex state=${state} updated=${stamp(hours)} -->\n### ${title}\n${steps}\n<!-- /auto session=${id} -->\n`
const snapshot = (text = '', extra: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  projects: parseProgress(text), answered: [], pending: [], journal: [], now: NOW,
  sources: { board: { state: 'read', at: NOW }, answered: { state: 'read' }, inbox: { state: 'read' }, journal: { state: 'read' } },
  ...extra,
})

test('chat is an explicit message surface with a safe unknown-host fallback and no brand routing', () => {
  expect(reportMode()).toBe('chat')
  expect(reportMode({ terminal: false, interactive: false })).toBe('chat')
  expect(reportMode({ terminal: true })).toBe('terminal')
  expect(reportMode({ interactive: true })).toBe('interactive')
})

test('a chat digest orders decisions blockers recorded completions and other work without repeating a task', () => {
  const text = block('Choose a colour', '- [?] Blue or green?\n- [ ] Paint a sample')
    + block('Retrieve sample', '- [!] Sample unavailable — Ask the supplier for a replacement', 'bbccddee')
    + block('Review layout', '- [~] Compare the mockups', 'ccddeeff', 1, 'working')
  const digest = chatDigest(snapshot(text, { journal: [
    { at: localDay(NOW), project: 'Example project', task: 'Draft the label', step: 'Proofread the text' },
    { at: localDay(NOW), project: 'Example project', task: 'Draft the label', step: 'Proofread the text' },
  ] }), EN)
  expect(digest.indexOf('Decisions needed')).toBeLessThan(digest.indexOf('Blockers\n'))
  expect(digest.indexOf('Blockers\n')).toBeLessThan(digest.indexOf('Completed steps recorded in the window'))
  expect(digest.indexOf('Completed steps recorded in the window')).toBeLessThan(digest.indexOf('Other work and unmerged reports'))
  expect(digest.split('Choose a colour').length).toBe(2)
  expect(digest.split('Proofread the text').length).toBe(2)
  expect(digest).toContain('Ask the supplier for a replacement')
  expect(digest).toContain('Progress snapshot · 2026-10-16T12:00:00.000Z')
  expect(digest).toContain('precise completion time and changes since the last message are unknown')
  expect(digest).not.toContain('%')
})

test('chat shares answered and stale semantics and never resurfaces a hidden question from pending reports', () => {
  const id = blockId('codex', 'synthetic-session')
  const data = snapshot(block('Pick a colour', '- [?] Blue or green?', id), {
    answered: [`${id} 1 Blue or green?`],
    pending: [{ session: id, agent: 'codex', project: 'Example project', text: 'Blue or green?', isQuestion: true, at: NOW }],
  })
  const hidden = chatDigest(data, EN)
  expect(hidden).toContain('1 answered, hidden')
  expect(hidden).not.toContain('Blue or green?')
  const stale = chatDigest(snapshot(block('Old report', '- [?] A stale question?', '11223344', 25)), EN)
  expect(stale).toContain('session ended or report stale')
  expect(stale).not.toContain('A stale question?')
  // No independent 3/7-day question aging policy is invented here.
  expect(chatDigest(snapshot(block('Recent report', '- [?] A recent question?', '11223344', 11)), EN)).toContain('A recent question?')
})

test('chat preserves blockers beyond folded view steps and does not turn a contradictory done marker into completion', () => {
  const text = block('Recover a sample', '- [ ] One\n- [ ] Two\n- [ ] Three\n- [ ] Four\n- [ ] Five\n- [ ] Six\n- [!] Missing sample', '11223344', 1, 'done')
  const digest = chatDigest(snapshot(text), EN)
  expect(digest).toContain('Blocked: Missing sample')
  expect(digest).toContain('What unblocks this: not recorded.')
  expect(digest).not.toContain('Reported complete;')
})

test('chat keeps retained answered questions hidden when their board block is absent', () => {
  const data = snapshot('', {
    answered: ['aabbccdd 1 Blue or green?'],
    pending: [
      { session: 'aabbccdd', agent: 'codex', project: 'Example project', text: 'Blue or green?', isQuestion: true, at: NOW },
      { session: 'bbccddee', agent: 'codex', project: 'Example project', text: 'Blue or green?', isQuestion: true, at: NOW },
    ],
  })
  // The other session's identical words remain its own unanswered question.
  expect(chatDigest(data, EN).split('Blue or green?').length).toBe(2)
  data.pending = data.pending.slice(0, 1)
  expect(chatDigest(data, EN)).not.toContain('Blue or green?')
})

test('chat withholds namespaced and quoted credential assignments completely', () => {
  for (const assignment of [
    'OPENAI_API_KEY=synthetic-openai-secret',
    'AWS_SECRET_ACCESS_KEY=synthetic-aws-secret',
    'DATABASE_PASSWORD=synthetic-password',
    'service-access-token="synthetic token with spaces"',
    '"OPENAI_API_KEY": "synthetic-json-secret"',
  ]) {
    const cleaned = chatText(assignment, EN)
    expect(cleaned).toContain('[withheld]')
    expect(cleaned).not.toContain('synthetic')
  }
})

test('chat exposes missing and unavailable sources without inventing empty live state or completion times', () => {
  const data = snapshot('', { sources: { board: { state: 'missing' }, answered: { state: 'unavailable' }, inbox: { state: 'unavailable' }, journal: { state: 'missing' } } })
  const digest = chatDigest(data, EN)
  expect(digest).toContain('Board: missing')
  expect(digest).toContain('Inbox: unavailable or incomplete')
  expect(digest).toContain('No matching accessible records.')
  const manual = chatDigest(snapshot('## Example project\n### Prepare sample\n- [ ] Draw it'), EN)
  expect(manual).toContain('time unknown')
  const unknownDone = chatDigest(snapshot(block('An older result', '- [x] Prepared', '11223344', 100, 'done')), EN)
  expect(unknownDone).toContain('Reported complete; no completion date established')
  const future = chatDigest(snapshot(block('Future clock', '- [ ] Check clock', '11223344', -1)), EN)
  expect(future).toContain('time unknown')
})

test('chat uses only the local journal date and distinguishes pending reports from recorded completion', () => {
  const entries = parseJournal(`- ${localDay(NOW)} 23:59 · Example project · Draft label · Proofread\n- 2000-01-01 10:00 · Example project · Old task · Old result`)
  const pending = peekInbox([{ name: 'codex-turn-1.json', body: JSON.stringify({ session_id: 'synthetic', cwd: '/synthetic/example', last_assistant_message: 'Everything is done.' }), at: NOW }], () => '', true)
  const digest = chatDigest(snapshot('', { journal: entries, pending }), EN)
  expect(digest).toContain('Recorded completed step: Proofread')
  expect(digest).not.toContain('Old result')
  expect(digest).toContain('unmerged report; received 2026-10-16T12:00:00.000Z')
  expect(digest.indexOf('Everything is done.')).toBeGreaterThan(digest.indexOf('Other work and unmerged reports'))
})

test('chat deduplicates session copies and older merged pending records while keeping the newest report', () => {
  const text = block('Older copy', '- [ ] An old step', 'aabbccdd', 2) + block('Newest copy', '- [ ] The current step', 'aabbccdd', 1)
  const digest = chatDigest(snapshot(text, { pending: [
    { session: 'aabbccdd', project: 'Example project', agent: 'codex', text: 'Merged old report', isQuestion: false, at: NOW - 7200000 },
    { session: 'aabbccdd', project: 'Example project', agent: 'codex', text: 'A newer unmerged report', isQuestion: false, at: NOW },
    { session: 'aabbccdd', project: 'Example project', agent: 'codex', text: 'A newer unmerged report', isQuestion: false, at: NOW },
  ] }), EN)
  expect(digest).not.toContain('Older copy')
  expect(digest).not.toContain('Merged old report')
  expect(digest.split('A newer unmerged report').length).toBe(2)
})

test('chat withholds paths credentials control sequences and HTML without terminal-width clipping multilingual work', () => {
  const privateText = '\u001b[31mTask\u001b[0m <!-- auto secret --> C:\\private\\notes /home/example/private ~/notes ./private/file https://example.test/?token=synthetic Bearer synthetic-bearer token=synthetic-token sk-syntheticcredential123 ghp_syntheticcredential123 <b>safe</b>'
  const cleaned = chatText(privateText, EN)
  for (const unwanted of ['\u001b', 'auto secret', 'C:', '/home', '~/notes', './private', 'https:', 'synthetic-bearer', 'synthetic-token', 'sk-synthetic', 'ghp_', '<b>']) expect(cleaned).not.toContain(unwanted)
  expect(cleaned).toContain('safe')
  const long = '合成資料：確認多語言需求與下一步。'.repeat(40) + 'the complete ending'
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    const digest = chatDigest(snapshot(block(long, '- [ ] A synthetic next step')), STRINGS[lang])
    expect(digest).toContain(long)
    expect(digest).not.toContain('\u001b')
  }
})
