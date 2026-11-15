import { expect, test } from 'claude-code/testing'
import { setManualStep } from '../hooks/blocks'
import { historyDaysOf, historyLineOf, sweepHistory } from '../hooks/history'
import { ZH_TW } from '../hooks/i18n'
import { localDay } from '../hooks/journal'
import { parseProgress } from '../hooks/parse'
import { EN } from '../hooks/strings-en'
import { ZH_CN } from '../hooks/strings-zh-cn'
import { taskFingerprint } from '../hooks/view'
import { engineBeneath, FILE, makeWorld } from './fixtures/pane-world'

// Seven days of history in an open hand-kept task (#922 items 2 and 6), through the pure sweep
// and the pane's own sweep against the mock engine. All data is made up.
const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const TODAY = localDay(NOW)
const DIR = '/home/me/.claude'
const ARCHIVE = `${DIR}/progress-archive-${TODAY.slice(0, 7)}.md`
const english = { HOME: '/home/me', LANG: 'en_US.UTF-8' }
const START = { cwd: '/work/synthetic', surface: 'terminal' as const, isInteractive: true }

const OPEN_TASK = [
  '## synthetic-project',
  '### Synthetic long task',
  '- [x] Old one <!-- done 2026-10-01 -->',
  '- [-] Old cancelled <!-- done 2026-10-05 -->',
  '- [x] Recent one <!-- done 2026-10-14 -->',
  '- [ ] Still open',
  '',
].join('\n')

test('an open hand-kept task moves steps done more than 7 days ago to the archive and keeps one summary line', async ($, on) => {
  const world = makeWorld([[FILE, OPEN_TASK]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(1)
  const board = world.files.get(FILE) ?? ''
  expect(board).toBe([
    '## synthetic-project',
    '### Synthetic long task',
    '2 earlier steps archived (from 10-01 to 10-05)',
    '- [x] Recent one <!-- done 2026-10-14 -->',
    '- [ ] Still open',
    '',
  ].join('\n'))
  const archive = world.files.get(ARCHIVE) ?? ''
  expect(archive).toContain(`## synthetic-project · ${TODAY}\n### Synthetic long task\n- [x] Old one <!-- done 2026-10-01 -->\n- [-] Old cancelled <!-- done 2026-10-05 -->`)
  expect(archive).not.toContain('Recent one')
  // The line is no step, no note and no owner line.
  const task = parseProgress(board)[0]?.tasks[0]
  expect(task?.steps.map(step => step.text)).toEqual(['Recent one', 'Still open'])
  expect(task?.notes).toEqual([])
})

test('open, waiting and blocked steps and owner lines never move, however old', async ($, on) => {
  const kept = [
    '## synthetic-project',
    '### Synthetic old task',
    '> Owner words <!-- done 2020-01-01 -->',
    '- [ ] Todo <!-- done 2020-01-01 -->',
    '- [~] Doing <!-- done 2020-01-01 -->',
    '- [?] Waiting, OK? <!-- done 2020-01-01 -->',
    '- [>] Running <!-- done 2020-01-01 -->',
    '- [!] Blocked — why <!-- done 2020-01-01 -->',
    '- [x] Fresh <!-- done 2026-10-16 -->',
    '',
  ].join('\n')
  // A second task shows the sweep did run: its old finished step moves while the first is untouched.
  const text = `${kept}### Synthetic other task
- [x] Long gone <!-- done 2020-01-01 -->
- [ ] Open
`
  const expected = `${kept}### Synthetic other task
1 earlier step archived (from 01-01 to 01-01)
- [ ] Open
`
  expect(sweepHistory(text, NOW, 7, EN).text).toBe(expected)
  const world = makeWorld([[FILE, text]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(1)
  expect(world.files.get(FILE)).toBe(expected)
  expect(world.files.get(ARCHIVE)).toContain('- [x] Long gone')
  for (const word of ['Todo', 'Doing', 'Waiting', 'Running', 'Blocked', 'Owner words']) expect(world.files.get(ARCHIVE)).not.toContain(word)
})

test('a done step with no date is stamped with today and is not archived on the first pass', async ($, on) => {
  const text = '## synthetic-project\n### Synthetic task\n- [x] Undated done\n- [-] Undated cancelled\n- [ ] Still open\n'
  const before = parseProgress(text)[0]?.tasks[0]
  const world = makeWorld([[FILE, text]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(1)
  const board = world.files.get(FILE) ?? ''
  expect(board).toBe(`## synthetic-project\n### Synthetic task\n- [x] Undated done <!-- done ${TODAY} -->\n- [-] Undated cancelled <!-- done ${TODAY} -->\n- [ ] Still open\n`)
  expect(world.files.has(ARCHIVE)).toBe(false)
  // The stamp changes no word and no fingerprint.
  const after = parseProgress(board)[0]?.tasks[0]
  expect(after?.steps.map(step => step.text)).toEqual(before?.steps.map(step => step.text))
  expect(after !== undefined && before !== undefined && taskFingerprint('synthetic-project', after) === taskFingerprint('synthetic-project', before)).toBe(true)
})

test('a second pass adds to the summary line instead of writing another', () => {
  const first = sweepHistory(OPEN_TASK, NOW, 7, EN)
  expect(first.moved).toBe(2)
  const later = first.text.replace('- [ ] Still open', '- [x] Older still <!-- done 2026-09-28 -->\n- [x] Another <!-- done 2026-10-07 -->\n- [ ] Still open')
  const second = sweepHistory(later, NOW, 7, EN)
  expect(second.text.split('\n').filter(line => line.includes('earlier step')))
    .toEqual(['4 earlier steps archived (from 09-28 to 10-07)'])
  expect(second.text).not.toContain('Older still')
  expect(second.entries).toHaveLength(1)
  // A line another language wrote is found and updated in place, in the language of the sweep.
  const zh = first.text.replace('2 earlier steps archived (from 10-01 to 10-05)', ZH_TW.historyLine(2, '10-01', '10-05'))
  const again = sweepHistory(zh.replace('- [ ] Still open', '- [x] Another <!-- done 2026-10-07 -->\n- [ ] Still open'), NOW, 7, EN)
  expect(again.text.split('\n').filter(line => line.includes('archived') || line.includes('封存'))).toEqual(['3 earlier steps archived (from 10-01 to 10-07)'])
  for (const words of [EN, ZH_TW, ZH_CN]) {
    expect(historyLineOf(words.historyLine(1, '01-02', '03-04'))).toEqual({ count: 1, from: '01-02', to: '03-04' })
    expect(historyLineOf(words.historyLine(12, '01-02', '03-04'))).toEqual({ count: 12, from: '01-02', to: '03-04' })
  }
  expect(historyLineOf('3 earlier steps')).toBeNull()
})

test('a step ticked on the board is stamped that day, and a press on a stamped line still finds it', () => {
  const text = '## p\n### t\n- [?] Pick one, OK?\n- [x] Drafted <!-- done 2026-10-01 -->\n'
  const ticked = setManualStep(text, { project: 'p', title: 't', step: 'Pick one, OK?', line: 2, raw: '- [?] Pick one, OK?' }, 'x', NOW)
  expect(ticked).toBe(`## p\n### t\n- [x] Pick one, OK? <!-- done ${TODAY} -->\n- [x] Drafted <!-- done 2026-10-01 -->\n`)
  // The pane drew the line before the board stamped it; the press still finds it, and the date stays.
  const cancelled = setManualStep(ticked, { project: 'p', title: 't', step: 'Pick one, OK?', line: 2, raw: '- [x] Pick one, OK?' }, '-', NOW + 3 * 86_400_000)
  expect(cancelled).toBe(`## p\n### t\n- [-] Pick one, OK? <!-- done ${TODAY} -->\n- [x] Drafted <!-- done 2026-10-01 -->\n`)
  // Without a clock the line is changed as it always was; a mark that is not a finish carries no stamp.
  expect(setManualStep(text, { project: 'p', title: 't', step: 'Pick one, OK?', line: 2, raw: '- [?] Pick one, OK?' }, 'x')).toBe('## p\n### t\n- [x] Pick one, OK?\n- [x] Drafted <!-- done 2026-10-01 -->\n')
  expect(setManualStep(cancelled, { project: 'p', title: 't', step: 'Drafted', line: 3, raw: '- [x] Drafted' }, '~', NOW)).toContain('- [~] Drafted\n')
})

test('historyDays in progress-settings.json changes the 7 days, and a missing file means 7', async ($, on) => {
  const text = '## synthetic-project\n### Synthetic task\n- [x] Four days old <!-- done 2026-10-12 -->\n- [ ] Still open\n'
  expect(historyDaysOf(null)).toBe(7)
  expect(historyDaysOf('')).toBe(7)
  expect(historyDaysOf('not json')).toBe(7)
  expect(historyDaysOf('{"historyDays": 0}')).toBe(7)
  expect(historyDaysOf('{"historyDays": "3"}')).toBe(7)
  expect(historyDaysOf('{"historyDays": 3}')).toBe(3)
  expect(sweepHistory(text, NOW, 7).moved).toBe(0)
  const world = makeWorld([[FILE, text], [`${DIR}/progress-settings.json`, '{"historyDays": 3}']])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(1)
  expect(world.files.get(FILE)).toBe('## synthetic-project\n### Synthetic task\n1 earlier step archived (from 10-12 to 10-12)\n- [ ] Still open\n')
  expect(world.files.get(ARCHIVE)).toContain('- [x] Four days old <!-- done 2026-10-12 -->')
})

test('a missing progress-settings.json keeps the 7 days in the pane', async ($, on) => {
  const text = '## synthetic-project\n### Synthetic task\n- [x] Four days old <!-- done 2026-10-12 -->\n- [x] Nine days old <!-- done 2026-10-07 -->\n- [ ] Still open\n'
  const world = makeWorld([[FILE, text]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(1)
  expect(world.files.get(FILE)).toBe('## synthetic-project\n### Synthetic task\n- [x] Four days old <!-- done 2026-10-12 -->\n1 earlier step archived (from 10-07 to 10-07)\n- [ ] Still open\n')
})

// Review of #1339: the sweep reads historyDays through the guarded script. A settings path that is a link or a FIFO
// reads as nothing, so the target's `historyDays` is not honoured and the host's read (which follows a link and
// waits on a FIFO) is never made. Before the guard the host read the file and archived the 4-day-old step at 3 days.
test('a settings file that is a link or a FIFO keeps the 7 days in the sweep and is not read by the host', async ($, on) => {
  const text = '## synthetic-project\n### Synthetic task\n- [x] Four days old <!-- done 2026-10-12 -->\n- [ ] Still open\n'
  const settings = `${DIR}/progress-settings.json`
  const world = makeWorld([[FILE, text], [settings, '{"historyDays": 3}']])
  world.unsafeFiles = new Set([settings])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(1)
  expect(world.files.get(FILE)).toBe(text)
})
