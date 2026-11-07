import { test, expect } from 'claude-code/testing'
import type { ProgressStepStatus } from '../types'
import { barPieces, barRole, barShape, barStyleOf, BAR_STYLES, cellCode, cellsOf, cellsOfCode, nextBarStyle, plainBar, withBarStyle } from '../hooks/progress-bar'
import type { BarStyle, Cell } from '../hooks/progress-bar'
import { boardItems, boardKey, boardScreen, emptyBoardState, nearest256 } from '../hooks/board'
import { DARK } from '../hooks/palette'
import { parseProgress } from '../hooks/parse'
import { serveModel } from '../hooks/serve'
import { EN } from '../hooks/strings-en'
import { buildView } from '../hooks/view'

const steps = (marks: string, current = -1): Array<{ status: ProgressStepStatus; isCurrent: boolean }> => {
  const status: Record<string, ProgressStepStatus> = { x: 'done', '~': 'doing', '?': 'waiting', '!': 'blocked', '>': 'running', ' ': 'todo', '-': 'cancelled' }
  return [...marks].map((mark, index) => ({ status: status[mark] ?? 'todo', isCurrent: index === current }))
}

test('#1085: every step state has its own cell, and the first open todo is the current one', () => {
  expect(cellsOf(steps('x~?!> -'))).toEqual(['done', 'current', 'waiting', 'blocked', 'running', 'todo', 'cancelled'])
  expect(cellsOf(steps('xx  ', 2))).toEqual(['done', 'done', 'current', 'todo'])
  // A first open step that waits on the person keeps its amber, not the current ink.
  expect(cellsOf(steps('x? ', 1))).toEqual(['done', 'waiting', 'todo'])
  const cells: Cell[] = ['done', 'current', 'waiting', 'blocked', 'running', 'todo', 'cancelled']
  expect(cellsOfCode(cellCode(cells))).toEqual(cells)
})

test('#1085: one step draws no bar, 7 steps a cell each, 30 steps one fill with the current mark', () => {
  expect(barShape(cellsOf(steps('~')))).toEqual({ kind: 'none' })
  expect(plainBar(cellsOf(steps('~')))).toBe('')
  const seven = cellsOf(steps('xxxx~  '))
  expect(barShape(seven)).toEqual({ kind: 'cells', cells: seven })
  expect(plainBar(seven)).toBe('━━━━╸──')
  expect(barPieces(cellsOf(steps('x?!> -')))).toEqual([
    { text: '━', cell: 'done' },
    { text: '━', cell: 'waiting' },
    { text: '━', cell: 'blocked' },
    { text: '━', cell: 'running' },
    { text: '─', cell: 'todo' },
    { text: '─', cell: 'cancelled' },
  ])
  const thirty = cellsOf(steps(`${'x'.repeat(15)}~${' '.repeat(14)}`))
  const shape = barShape(thirty)
  expect(shape.kind).toBe('continuous')
  if (shape.kind === 'continuous') {
    expect(shape.share).toBe(0.5)
    expect(shape.at).toBe(0.5)
    expect(shape.mark).toBe('current')
  }
  expect(plainBar(thirty, 8)).toBe('━━━━╸───')
  expect([...plainBar(thirty, 12)].length).toBe(12)
  // Cancelled steps are not counted in a continuous fill; a finished long task is all fill.
  expect(plainBar(cellsOf(steps(`${'x'.repeat(13)}-`)), 8)).toBe('━━━━━━━━')
})

test('#1085: only done and current change with the style; amber, red and todo stay', () => {
  expect(BAR_STYLES.map(style => barRole('done', style))).toEqual(['muted', 'accent', 'done'])
  expect(BAR_STYLES.map(style => barRole('current', style))).toEqual(['ink', 'accent', 'done'])
  for (const style of BAR_STYLES) {
    expect(barRole('waiting', style)).toBe('waiting')
    expect(barRole('blocked', style)).toBe('alert')
    expect(barRole('todo', style)).toBe('frame')
  }
  expect(nextBarStyle('ink')).toBe('blue')
  expect(nextBarStyle('green')).toBe('ink')
})

test('#1085: the style is one key of the settings file, and writing it keeps the other keys', () => {
  expect(barStyleOf(null)).toBe('ink')
  expect(barStyleOf('not json')).toBe('ink')
  expect(barStyleOf('{"style":"pink"}')).toBe('ink')
  expect(barStyleOf('{"style":"blue","historyDays":3}')).toBe('blue')
  const written = withBarStyle('{"historyDays":3}', 'green')
  expect(JSON.parse(written)).toEqual({ historyDays: 3, style: 'green' })
  expect(barStyleOf(written)).toBe('green')
  expect(JSON.parse(withBarStyle('[1,2]', 'blue'))).toEqual({ style: 'blue' })
})

// The same bar on the terminal board and in the page's model, from one progress file.
const NOW = Date.parse('2026-10-16T12:00:00Z')
const file = (steps: string): string =>
  `# Progress\n\n## Demo\n<!-- auto session=10000001 agent=codex state=waiting updated=2026-10-16T11:59:00Z -->\n### Synthetic plan\n${steps}<!-- /auto session=10000001 -->\n`
const SEVEN = '- [x] One\n- [x] Two\n- [x] Three\n- [x] Four\n- [~] Five\n- [ ] Six\n- [-] Seven\n'
const THIRTY = `${'- [x] Done step\n'.repeat(15)}- [~] Current step\n${'- [ ] Open step\n'.repeat(14)}`
const viewOf = (text: string) => buildView(parseProgress(text), [], null, NOW, 0, {}, EN)
const GROUP = { now: NOW, repoOf: () => null, unreadable: [], versions: { board: 'synthetic', package: null } }

test('#1085: the terminal board and the page model carry one cell per step, up to 12, and one fill above', () => {
  for (const [steps, bar, code] of [[SEVEN, '━━━━╸──', 'xxxx~ -'], [THIRTY, '━━━━━━╸─────', `${'x'.repeat(15)}~${' '.repeat(14)}`], ['- [~] Only step\n', '', '~']] as const) {
    const view = viewOf(file(steps))
    const screen = boardScreen(view, [], emptyBoardState, EN, { width: 100, isColor: false })
    const row = [...view.groups.flatMap(group => group.rows), ...view.idle, ...view.stopped][0]!
    if (bar === '') expect(screen).not.toMatch(/[━╸]/)
    else expect(screen).toContain(`${bar} `)
    const model = serveModel(view, [], EN, new Set(), false, undefined, false, GROUP)
    const shown = [...model.groups.flatMap(group => group.rows), ...model.idle, ...model.stopped].find(one => one.title === 'Synthetic plan')
    expect(shown?.cells).toBe(code)
    expect(cellCode(row.cells)).toBe(code)
  }
})

test('#1085: the terminal board paints done cells in the picked style and the s key asks for the next style', () => {
  const view = viewOf(file(SEVEN))
  const painted = (barStyle: BarStyle) => boardScreen(view, [], emptyBoardState, EN, { width: 100, isColor: true, depth: '256', theme: 'dark', barStyle })
  const sgr = (hex: string): string => `\u001b[38;5;${nearest256(hex)}m━━━━\u001b[0m`
  expect(painted('ink')).toContain(sgr(DARK.muted))
  expect(painted('blue')).toContain(sgr(DARK.accent))
  expect(painted('green')).toContain(sgr(DARK.done))
  const items = boardItems(view, [], false, false)
  expect(boardKey(emptyBoardState, 's', items, EN).action).toEqual({ type: 'style' })
})
