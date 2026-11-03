import { expect, test } from 'claude-code/testing'
import { OTHERS_CAP, othersNote } from '../hooks/others'
import { parseProgress } from '../hooks/parse'
import { STRINGS } from '../hooks/strings'
import { applyTaskCreate, emptyMirror } from '../hooks/mirror'
import { renderAutoBlock, takeTask } from '../hooks/blocks'
import { buildView } from '../hooks/view'

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

test('independent same-prefix peers stay on the current session board across agents and keep their runs', () => {
  for (const agent of ['claude', 'codex']) {
    const mine = applyTaskCreate(emptyMirror('a1b2c3d4-person-a', 'demo', NOW), { subject: 'My step' }, '1', NOW)
    const peer = { ...applyTaskCreate(emptyMirror('a1b2c3d4-person-b', 'demo', NOW, '', agent), { subject: 'Peer step' }, '1', NOW), title: 'Peer work' }
    const run = { ...applyTaskCreate(emptyMirror('eeeeffff-run', 'demo', NOW, '', 'codex'), { subject: 'Run step' }, '1', NOW), isRun: true }
    const text = `## demo\n${renderAutoBlock(mine).join('\n')}\n${renderAutoBlock(peer).join('\n')}\n${renderAutoBlock(run, STRINGS.en, peer.sessionId).join('\n')}\n`
    const view = buildView(parseProgress(text), ['demo'], mine, NOW, 0, {}, STRINGS.en)
    expect(view.active.map(row => row.title)).toEqual(['Peer work'])
    expect(view.active[0]?.agent).toBe(agent === 'claude' ? '' : agent)
    expect(view.active[0]?.runs).toBe('+1 run by Codex, just now')
    expect(view.current?.runs).toBeUndefined()
    expect(view.background).toBeUndefined()
    expect(buildView(parseProgress(text), ['demo'], null, NOW, 0, {}, STRINGS.en).active).toHaveLength(2)
  }
})

test('the others note retains same-prefix peers by canonical identity across agents', () => {
  for (const agent of ['claude', 'codex']) {
    const mine = { ...applyTaskCreate(emptyMirror('a1b2c3d4-person-a', 'demo', NOW), { subject: 'My step' }, '1', NOW), title: 'My work' }
    const peer = { ...applyTaskCreate(emptyMirror('a1b2c3d4-person-b', 'demo', NOW, '', agent), { subject: 'Peer step' }, '1', NOW), title: 'Peer work' }
    const projects = parseProgress(`## demo\n${renderAutoBlock(mine).join('\n')}\n${renderAutoBlock(peer).join('\n')}\n`)
    expect(othersNote(projects, ['demo'], mine, NOW, STRINGS.en)).toContain(STRINGS.en.othersHeld('Peer work', 0, 1))
    expect(othersNote(projects, ['demo'], mine, NOW, STRINGS.en)).not.toContain('My work')
    expect(othersNote(projects, ['demo'], mine.sessionId, NOW, STRINGS.en)).toContain('Peer work')
    expect(othersNote(projects, ['demo'], mine, NOW + 8 * 86400000, STRINGS.en)).toBeNull()
  }
})

test('taking an ended same-prefix peer keeps the current block and refuses a peer that resumed', () => {
  for (const agent of ['claude', 'codex']) {
    const mine = applyTaskCreate(emptyMirror('a1b2c3d4-person-a', 'demo', NOW), { subject: 'My step' }, '1', NOW)
    const peer = { ...applyTaskCreate(emptyMirror('a1b2c3d4-person-b', 'demo', NOW, '', agent), { subject: 'Peer step' }, '1', NOW), title: 'Peer work', state: 'ended' as const }
    const ownBlock = renderAutoBlock(mine).join('\n')
    const text = `## demo\n${ownBlock}\n${renderAutoBlock(peer).join('\n')}\n`
    const view = buildView(parseProgress(text), ['demo'], mine, NOW, 0, {}, STRINGS.en)
    const ref = view.stopped[0]?.archive
    expect(ref).not.toBeNull()
    expect(ref).not.toBeUndefined()
    if (ref == null) throw new Error('The ended peer needs an archive reference')
    const taken = takeTask(text, ref, NOW, STRINGS.en)
    expect(taken?.entries).toHaveLength(1)
    expect(taken?.text).toContain(ownBlock)
    expect(taken?.text).not.toContain('Peer work')
    expect(takeTask(text.replace('state=ended', 'state=working'), ref, NOW, STRINGS.en)).toBeNull()
    const live = buildView(parseProgress(text.replace('state=ended', 'state=working')), ['demo'], mine, NOW, 0, {}, STRINGS.en)
    expect(live.active[0]?.archive).toBeNull()
    expect(takeTask(text, { ...ref, session: 'ffffffff' }, NOW, STRINGS.en)).toBeNull()
  }
})
