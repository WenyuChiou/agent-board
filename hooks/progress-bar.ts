import type { ProgressStepStatus } from '../types'

// Progress as a bar of one cell per step (#1085), the same rule on the page, the pane, the
// terminal board and the line under the prompt. Nothing here reads a file or the clock: the
// steps and the settings file's text come in.

// What one cell shows. `current` is the step being worked on; the rest follow the step's mark.
export type Cell = 'done' | 'current' | 'waiting' | 'blocked' | 'running' | 'todo' | 'cancelled'

// Up to this many steps each get a cell; above it the bar is one continuous fill.
export const MAX_CELLS = 12

// The presets the person picks from (no free colour picker). Only the done and current cells
// change with the style: amber, red and the hollow todo cell carry news and stay the same.
export const BAR_STYLES = ['ink', 'blue', 'green'] as const
export type BarStyle = (typeof BAR_STYLES)[number]
export const DEFAULT_BAR_STYLE: BarStyle = 'ink'

export const isBarStyle = (value: unknown): value is BarStyle => typeof value === 'string' && (BAR_STYLES as readonly string[]).includes(value)

export const nextBarStyle = (style: BarStyle): BarStyle => BAR_STYLES[(BAR_STYLES.indexOf(style) + 1) % BAR_STYLES.length] ?? DEFAULT_BAR_STYLE

// One character per cell, so a model can carry the whole bar as a short string.
const CODE: Record<Cell, string> = { done: 'x', current: '~', waiting: '?', blocked: '!', running: '>', todo: ' ', cancelled: '-' }
const FROM_CODE: Record<string, Cell> = Object.fromEntries(Object.entries(CODE).map(([cell, code]) => [code, cell as Cell]))

export const cellCode = (cells: readonly Cell[]): string => cells.map(cell => CODE[cell]).join('')
export const cellsOfCode = (code: string): Cell[] => [...code].map(char => FROM_CODE[char] ?? 'todo')

// A step's cell. The current step is the `[~]` one, or the first open step when it is still a
// plain todo; a first open step that waits on the person or is blocked keeps its own colour.
export const cellOf = (status: ProgressStepStatus, isCurrent: boolean): Cell => {
  if (status === 'doing') return 'current'
  if (status === 'todo') return isCurrent ? 'current' : 'todo'
  return status
}

export const cellsOf = (steps: ReadonlyArray<{ status: ProgressStepStatus; isCurrent: boolean }>): Cell[] =>
  steps.map(step => cellOf(step.status, step.isCurrent))

// How the bar is drawn. One step or none: text only. Up to MAX_CELLS: a cell each. Above it:
// one fill (`share` done, 0..1) with a mark at the current step (`at`, 0..1, null when none)
// in that step's colour.
export type BarShape =
  | { kind: 'none' }
  | { kind: 'cells'; cells: Cell[] }
  | { kind: 'continuous'; share: number; at: number | null; mark: Cell }

export const barShape = (cells: readonly Cell[]): BarShape => {
  if (cells.length <= 1) return { kind: 'none' }
  if (cells.length <= MAX_CELLS) return { kind: 'cells', cells: [...cells] }
  const counted = cells.filter(cell => cell !== 'cancelled')
  const done = counted.filter(cell => cell === 'done').length
  const open = counted.findIndex(cell => cell !== 'done')
  const mark = open < 0 ? 'done' : counted[open] ?? 'todo'

  return {
    kind: 'continuous',
    share: counted.length === 0 ? 0 : done / counted.length,
    at: open < 0 || counted.length === 0 ? null : open / counted.length,
    mark,
  }
}

// The bar in text, for the pane and the terminal board: `━` done, `╸` current, `─` todo, a
// coloured `━` for a step that waits on the person, is blocked or runs. Each piece names its
// cell so the caller colours it. A continuous bar is `room` characters wide.
export type BarPiece = { text: string; cell: Cell }

const GLYPH: Record<Cell, string> = { done: '━', current: '╸', waiting: '━', blocked: '━', running: '━', todo: '─', cancelled: '─' }

const joined = (cells: readonly Cell[]): BarPiece[] =>
  cells.reduce<BarPiece[]>((pieces, cell) => {
    const last = pieces[pieces.length - 1]
    if (last !== undefined && last.cell === cell) last.text += GLYPH[cell]
    else pieces.push({ text: GLYPH[cell], cell })
    return pieces
  }, [])

export const barPieces = (cells: readonly Cell[], room = MAX_CELLS): BarPiece[] => {
  const shape = barShape(cells)
  if (shape.kind === 'none') return []
  if (shape.kind === 'cells') return joined(shape.cells)
  const width = Math.max(4, room)
  const filled = Math.round(shape.share * width)
  const line: Cell[] = Array.from({ length: width }, (_, index) => (index < filled ? 'done' : 'todo'))
  if (shape.at !== null) {
    const index = Math.min(width - 1, Math.max(filled === width ? width - 1 : filled, Math.floor(shape.at * width)))
    line[index] = shape.mark === 'todo' ? 'current' : shape.mark
  }

  return joined(line)
}

export const plainBar = (cells: readonly Cell[], room = 8): string => barPieces(cells, room).map(piece => piece.text).join('')

// The colour role each cell takes in a style, as the pane and the terminal board name them
// (`palette.ts`); `ink` is the terminal's own text colour. Ink's done cells are `muted`, the ink
// at 60 %. Waiting is amber and blocked red in every style, as the flags and badges are; a step
// that runs (CI, handed over) takes the page's alive colour, which is `done`.
export type BarRole = 'muted' | 'accent' | 'done' | 'ink' | 'waiting' | 'alert' | 'frame'

const STYLE_ROLE: Record<BarStyle, BarRole> = { ink: 'muted', blue: 'accent', green: 'done' }

export const barRole = (cell: Cell, style: BarStyle): BarRole => {
  switch (cell) {
    case 'done':
      return STYLE_ROLE[style]
    case 'current':
      return style === 'ink' ? 'ink' : STYLE_ROLE[style]
    case 'waiting':
      return 'waiting'
    case 'blocked':
      return 'alert'
    case 'running':
      return 'done'
    case 'todo':
    case 'cancelled':
      return 'frame'
  }
}

// The style from the board's settings file (`hooks/history.ts` settingsPath). A file that is
// missing, is not JSON or holds anything else means the default.
export const barStyleOf = (text: string | null): BarStyle => {
  if (text === null || text.trim() === '') return DEFAULT_BAR_STYLE
  try {
    const data: unknown = JSON.parse(text)
    const style = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).style : undefined
    return isBarStyle(style) ? style : DEFAULT_BAR_STYLE
  } catch {
    return DEFAULT_BAR_STYLE
  }
}

// The settings file's text with the style set; every other key is kept. A file that is not a
// JSON object is replaced by one holding only the style.
export const withBarStyle = (text: string | null, style: BarStyle): string => {
  let data: Record<string, unknown> = {}
  try {
    const read: unknown = text === null || text.trim() === '' ? {} : JSON.parse(text)
    if (read !== null && typeof read === 'object' && !Array.isArray(read)) data = read as Record<string, unknown>
  } catch {}

  return `${JSON.stringify({ ...data, style }, null, 2)}\n`
}
