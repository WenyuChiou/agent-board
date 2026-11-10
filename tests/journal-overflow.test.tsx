import { countDay, parseJournal } from '../hooks/journal'
import { EN, FILE, JOURNAL, SESSION, TIDY, emptyMirror, engineBeneath, expect, start, test, type World } from './pane-helpers'

for (const kind of ['pending step', 'in-progress step', 'title'] as const) {
  test(`native overflow evidence for a ${kind} adds no completion until a task actually finishes`, async ($, on) => {
    const long = `Synthetic ${kind} ${'full words '.repeat(15)}`.trim()
    const subject = kind === 'title' ? 'Complete the real step' : long
    const at = Date.parse('2026-10-16T12:00:00.000Z')
    const world: World = {
      files: new Map([[FILE, '# Synthetic progress\n']]), mtime: 1, hasTasks: true,
      named: kind === 'title' ? long : 'Preserved words', store: { lang: 'en' },
    }
    // A persisted mirror can retain a full title even though fresh model naming is bounded.
    if (kind === 'title') world.store![`mirror:${SESSION}`] = { ...emptyMirror(SESSION, 'persona_framework', at), title: long }
    engineBeneath(on, world)
    if (kind === 'title') await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
    else await start($, 'Synthetic overflow request')
    await $.tool.call({ tool: 'TaskCreate', subject, description: '' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Keep working', description: '' })
    if (kind === 'in-progress step') await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })

    const saved = world.files.get(JOURNAL) ?? ''
    expect(saved.split('\n').filter(line => line.endsWith(` · ${long}`))).toHaveLength(1)
    expect(countDay(saved, at)).toBe(0)
    expect(parseJournal(saved)).toEqual([])
    for (const args of ['today', 'report']) {
      const report = await $.command.run({ ...TIDY, args })
      expect(report.text).toContain(`${EN.reportDone}\n${EN.reportNone}`)
      expect(report.text).toContain(EN.reportOpen)
    }

    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    const completed = world.files.get(JOURNAL) ?? ''
    expect(countDay(completed, at)).toBe(1)
    expect(parseJournal(completed).map(entry => entry.step)).toEqual([subject])
    expect(completed.split('\n').filter(line => line.startsWith('> ') && line.endsWith(` · ${long}`))).toHaveLength(1)
    for (const args of ['today', 'report']) {
      const report = await $.command.run({ ...TIDY, args })
      const done = report.text?.split(`${EN.reportDone}\n`)[1]?.split('\n\n')[0] ?? ''
      expect(done.split(subject).length - 1).toBe(1)
    }
  })
}
