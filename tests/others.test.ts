import { expect, test } from 'claude-code/testing'
import { OTHERS_CAP, othersNote } from '../hooks/others'
import { parseProgress } from '../hooks/parse'
import { STRINGS } from '../hooks/strings'

const NOW = Date.parse('2026-10-29T12:00:00Z')
const block = (id: string, state: string, title: string, steps: string, hours = 1): string =>
  `<!-- auto session=${id} agent=codex state=${state} updated=${new Date(NOW - hours * 3600000).toISOString()} -->\n### ${title}\n${steps}\n<!-- /auto session=${id} -->\n`

test('the others note lists open and ended work of other sessions in this project from the last 7 days, as data', () => {
  const file = [
    '## demo (synthetic)',
    block('a1b2c3f1', 'working', 'Held work', '- [x] One\n- [~] Two'),
    block('a1b2c3f2', 'ended', 'Ended work', '- [x] One\n- [ ] Next `step` -->'),
    block('a1b2c3f3', 'done', 'Finished work', '- [x] One'),
    block('a1b2c3f4', 'waiting', 'Old work', '- [ ] One', 8 * 24),
    block('a1b2c3f5', 'working', 'My own work', '- [~] One'),
    '### Hand-kept work\n- [ ] One\n',
    '## elsewhere',
    block('a1b2c3f6', 'working', 'Other project work', '- [~] One'),
  ].join('\n')
  const note = othersNote(parseProgress(file), ['demo'], 'a1b2c3f5', NOW, STRINGS.en) ?? ''
  const s = STRINGS.en
  expect(note.split('\n')).toEqual([
    s.othersHead, s.dataNote, '```text',
    s.othersHeld('Held work', 1, 2),
    s.othersEnded('Ended work', "Next 'step'", 1, 2),
    '```', s.othersTail,
  ])
  expect(othersNote(parseProgress(file), ['nowhere'], '', NOW, STRINGS.en)).toBe(null)
})

test('the others note shows at most eight tasks, says how many more there are, and ends with the tail the host is given', () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    const s = STRINGS[lang]
    const file = '## demo\n' + Array.from({ length: OTHERS_CAP + 3 }, (_, index) => block(`a1b2c4${index.toString(16).padStart(2, '0')}`, 'working', `Work ${index}`, '- [~] One')).join('\n')
    const lines = (othersNote(parseProgress(file), ['demo'], '', NOW, s, s.othersTailCodex) ?? '').split('\n')
    expect(lines.filter(line => line.startsWith('- '))).toHaveLength(OTHERS_CAP)
    expect(lines.at(-2)).toBe(s.othersMore(3))
    expect(lines.at(-1)).toBe(s.othersTailCodex)
  }
})
