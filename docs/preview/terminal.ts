// Lays out the tree drawPane returns the way a terminal does, as a grid of character cells, and
// writes the grid as SVG. Only what the pane uses is supported: Box (row and column, gap, margin,
// padding, a round border, a spacer that grows, wrapping rows), Text (wrap, truncate-end,
// truncate-start), Button (plain and boxed), Input and Link.

export type Node = { type: string; props: Record<string, any>; children: Array<Node | string> }
type Style = { fg?: string; bold?: boolean; underline?: boolean }
// A wide (CJK) character fills two cells; the second holds '' so columns stay exact.
type Cell = { ch: string; style: Style; key?: string }
type Block = Cell[][]

export type Theme = { ground: string; ink: string; edge: string; muted: string; accent: string; frame: string }

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u
const cells = (ch: string): number => (WIDE.test(ch) ? 2 : 1)
const widthOf = (text: string): number => [...text].reduce((sum, ch) => sum + cells(ch), 0)
const blockWidth = (block: Block): number => Math.max(0, ...block.map(line => line.length))

const toCells = (text: string, style: Style, key?: string): Cell[] =>
  [...text].flatMap(ch => (cells(ch) === 2 ? [{ ch, style, key }, { ch: '', style, key }] : [{ ch, style, key }]))

const textOf = (node: Node | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

// Breaks at a space when the line is words, anywhere when it is CJK.
const wrap = (text: string, width: number): string[] => {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const ch of [...paragraph]) {
      if (widthOf(line + ch) <= width) {
        line += ch
        continue
      }
      const space = line.lastIndexOf(' ')
      if (ch !== ' ' && space > 0 && widthOf(line) > width / 3) {
        out.push(line.slice(0, space))
        line = line.slice(space + 1) + ch
      } else {
        out.push(line)
        line = ch === ' ' ? '' : ch
      }
    }
    out.push(line)
  }
  return out
}

const cutEnd = (text: string, width: number): string => {
  if (widthOf(text) <= width) return text
  let out = ''
  for (const ch of [...text]) {
    if (widthOf(out + ch) > width - 1) break
    out += ch
  }
  return `${out}…`
}

const cutStart = (text: string, width: number): string => {
  if (widthOf(text) <= width) return text
  let out = ''
  for (const ch of [...text].reverse()) {
    if (widthOf(ch + out) > width - 1) break
    out = ch + out
  }
  return `…${out}`
}

const pad = (line: Cell[], width: number): Cell[] =>
  line.length >= width ? line.slice(0, width) : [...line, ...Array.from({ length: width - line.length }, () => ({ ch: ' ', style: {} }))]

const isFlexible = (node: Node | string): boolean =>
  typeof node !== 'string' && (node.type === 'Button' || (node.type === 'Text' && node.props.wrap !== undefined) || node.type === 'Input')

const isSpacer = (node: Node | string): boolean =>
  typeof node !== 'string' && node.type === 'Box' && node.props.flexGrow !== undefined && node.children.length === 0

// Some JSX runtimes hand back elements with the children inside props (React's shape)
// rather than beside them; bring either into the one shape layout reads.
export const toNode = (value: unknown): Node | string | null => {
  if (value === null || value === undefined || value === false || value === true) return null
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return { type: 'Box', props: {}, children: value.map(toNode).filter((one): one is Node | string => one !== null) }
  const element = value as { type: string; props?: Record<string, any>; children?: unknown }
  const { children: inProps, ...props } = element.props ?? {}
  const raw = element.children ?? inProps
  const list = (Array.isArray(raw) ? raw : [raw]).flat(Infinity)
  return { type: element.type, props, children: list.map(toNode).filter((one): one is Node | string => one !== null) }
}

export const layout = (node: Node | string, width: number, theme: Theme): Block => {
  if (typeof node === 'string') return wrap(node, width).map(line => toCells(line, {}))
  const p = node.props
  if (node.type === 'Text') {
    const style: Style = { fg: p.color, bold: p.bold === true }
    const text = textOf(node)
    const lines =
      p.wrap === 'truncate-end' ? [cutEnd(text, width)] : p.wrap === 'truncate-start' ? [cutStart(text, width)] : wrap(text, width)
    return lines.map(line => toCells(line, style))
  }
  if (node.type === 'Button') {
    const label = textOf(node) || p.label || ''
    const isPrimary = p.variant === 'primary'
    const style: Style = { fg: isPrimary ? theme.accent : undefined, bold: isPrimary }
    if (p.plain === true) return [toCells(cutEnd(label, width), style, p.key)]
    return [[...toCells('[ ', { fg: theme.frame }, p.key), ...toCells(cutEnd(label, width - 4), style, p.key), ...toCells(' ]', { fg: theme.frame }, p.key)]]
  }
  if (node.type === 'Link') return [toCells(cutEnd(p.label ?? p.href, width), { fg: theme.accent, underline: true })]
  if (node.type === 'Input') {
    const send = ` ${p.submitLabel ?? ''} `
    const room = Math.max(4, width - widthOf(send) - 3)
    const frame: Style = { fg: theme.frame }
    return [
      toCells(`╭${'─'.repeat(room)}┬${'─'.repeat(widthOf(send))}╮`, frame),
      [...toCells('│', frame), ...pad(toCells(cutEnd(` ${p.placeholder ?? ''}`, room), { fg: theme.muted }), room), ...toCells('│', frame), ...toCells(send, {}), ...toCells('│', frame)],
      toCells(`╰${'─'.repeat(room)}┴${'─'.repeat(widthOf(send))}╯`, frame),
    ]
  }

  // Box
  const isColumn = (p.flexDirection ?? 'row').startsWith('column')
  const border = p.borderStyle === 'round'
  const padX = (p.paddingX ?? 0) + (border ? 1 : 0)
  const padLeft = (p.paddingLeft ?? 0) + padX
  const inner = Math.max(1, width - padLeft - padX)
  const kids = node.children.filter(child => child !== '' && child !== null && child !== undefined)
  let body: Block = []

  if (isColumn) {
    const gap = p.gap ?? p.rowGap ?? 0
    kids.forEach((child, index) => {
      if (index > 0) for (let i = 0; i < gap; i++) body.push([])
      body.push(...layout(child, inner, theme))
    })
  } else {
    const gap = p.gap ?? p.columnGap ?? 0
    const natural = kids.map(child => (isSpacer(child) ? 0 : blockWidth(layout(child, inner, theme))))
    if (p.flexWrap === 'wrap') {
      // Items run left to right and start a new line when the next would not fit.
      let line: Block = []
      let used = 0
      const flush = () => {
        body.push(...line)
        line = []
        used = 0
      }
      kids.forEach((child, index) => {
        const w = Math.min(natural[index] ?? 0, inner)
        const room = used === 0 ? 0 : gap
        if (used > 0 && used + room + w > inner) flush()
        const block = layout(child, w, theme)
        const at = used === 0 ? 0 : used + gap
        block.forEach((row, r) => {
          const target = line[r] ?? (line[r] = [])
          line[r] = [...pad(target, at), ...row]
        })
        used = at + w
      })
      flush()
    } else {
      const fixed = kids.map((child, index) => (isFlexible(child) || isSpacer(child) ? 0 : natural[index] ?? 0))
      let left = inner - fixed.reduce((a, b) => a + b, 0) - gap * Math.max(0, kids.length - 1)
      const widths = kids.map((child, index) => {
        if (isSpacer(child)) return 0
        if (!isFlexible(child)) return natural[index] ?? 0
        const w = Math.max(1, Math.min(natural[index] ?? 0, left))
        left -= w
        return w
      })
      const spare = Math.max(0, left)
      const spacers = kids.filter(isSpacer).length
      kids.forEach((child, index) => {
        if (isSpacer(child)) widths[index] = Math.floor(spare / spacers)
      })
      const blocks = kids.map((child, index) => (isSpacer(child) ? [[]] : layout(child, widths[index] ?? 1, theme)))
      const height = Math.max(0, ...blocks.map(block => block.length))
      for (let r = 0; r < height; r++) {
        let row: Cell[] = []
        blocks.forEach((block, index) => {
          if (index > 0) row = [...row, ...pad([], gap)]
          row = [...row, ...pad(block[r] ?? [], widths[index] ?? 0)]
        })
        body.push(row)
      }
    }
  }

  body = body.map(line => [...pad([], padLeft), ...line])
  if (border) {
    const frame: Style = { fg: p.borderColor ?? theme.frame }
    const edge = width - 2
    body = [
      toCells(`╭${'─'.repeat(edge)}╮`, frame),
      ...body.map(line => [...toCells('│', frame), ...pad(line.slice(1), edge), ...toCells('│', frame)]),
      toCells(`╰${'─'.repeat(edge)}╯`, frame),
    ]
  }
  const top: Block = Array.from({ length: p.marginTop ?? 0 }, () => [])
  return [...top, ...body]
}

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const CELL = 8.4
export const LINE = 20
export const MONO =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'Noto Sans Mono CJK TC', 'Noto Sans CJK TC', 'PingFang TC', 'Microsoft JhengHei', monospace"

// Box-drawing characters become vector strokes: fonts draw them with gaps between lines, and
// a terminal's own cells have none.
const STROKES: Record<string, (x: number, y: number) => string> = {
  '─': (x, y) => `M${x} ${y + LINE / 2}h${CELL}`,
  '━': (x, y) => `M${x} ${y + LINE / 2}h${CELL}`,
  '│': (x, y) => `M${x + CELL / 2} ${y}v${LINE}`,
  '╭': (x, y) => `M${x + CELL / 2} ${y + LINE}V${y + LINE / 2 + 4}q0 -4 4 -4H${x + CELL}`,
  '╮': (x, y) => `M${x} ${y + LINE / 2}H${x + CELL / 2 - 4}q4 0 4 4V${y + LINE}`,
  '╰': (x, y) => `M${x + CELL / 2} ${y}V${y + LINE / 2 - 4}q0 4 4 4H${x + CELL}`,
  '╯': (x, y) => `M${x} ${y + LINE / 2}H${x + CELL / 2 - 4}q4 0 4 -4V${y}`,
  '┬': (x, y) => `M${x} ${y + LINE / 2}h${CELL}M${x + CELL / 2} ${y + LINE / 2}V${y + LINE}`,
  '┴': (x, y) => `M${x} ${y + LINE / 2}h${CELL}M${x + CELL / 2} ${y + LINE / 2}V${y}`,
}

// The grid as SVG text runs. Each run is one style and one cell width (narrow or wide), and is
// stretched to its exact cell count, so columns line up whatever font the viewer has.
export const gridSvg = (block: Block, x0: number, y0: number, theme: Theme): string => {
  const out: string[] = []
  const strokes = new Map<string, string[]>()
  block.forEach((line, r) => {
    const top = y0 + r * LINE
    const y = top + 14
    let c = 0
    while (c < line.length) {
      const cell = line[c] as Cell
      const draw = STROKES[cell.ch]
      if (draw !== undefined) {
        const key = `${cell.style.fg ?? theme.frame}|${cell.ch === '━' ? 3 : 1.2}`
        const list = strokes.get(key) ?? []
        // A run of one horizontal line is one stroke, so it shows no seams between cells.
        let end = c + 1
        if (cell.ch === '─' || cell.ch === '━') {
          while (line[end]?.ch === cell.ch && line[end]?.style.fg === cell.style.fg) end++
          list.push(`M${x0 + c * CELL} ${top + LINE / 2}h${(end - c) * CELL}`)
        } else {
          list.push(draw(x0 + c * CELL, top))
        }
        strokes.set(key, list)
        c = end
        continue
      }
      const wide = line[c + 1]?.ch === '' && cell.ch !== ''
      let text = ''
      let span = 0
      let k = c
      while (k < line.length) {
        const one = line[k] as Cell
        const oneWide = line[k + 1]?.ch === '' && one.ch !== ''
        if (STROKES[one.ch] !== undefined) break
        if (one.style !== cell.style && JSON.stringify(one.style) !== JSON.stringify(cell.style)) break
        if (oneWide !== wide) break
        text += one.ch
        span += oneWide ? 2 : 1
        k += oneWide ? 2 : 1
      }
      // Spaces at either end of a run are just room: the run starts and ends on its letters.
      const lead = text.length - text.trimStart().length
      const trimmed = text.trim()
      if (trimmed !== '') {
        const trail = text.length - text.trimEnd().length
        const s = cell.style
        const cellsOf = wide ? 2 : 1
        out.push(
          `<text x="${(x0 + (c + lead * cellsOf) * CELL).toFixed(1)}" y="${y}" textLength="${((span - (lead + trail) * cellsOf) * CELL).toFixed(1)}" lengthAdjust="spacingAndGlyphs"` +
            ` fill="${s.fg ?? theme.ink}"${s.bold ? ' font-weight="700"' : ''}${s.underline ? ' text-decoration="underline"' : ''}>${esc(trimmed)}</text>`,
        )
      }
      c = k
    }
  })
  for (const [key, paths] of strokes) {
    const [color, width] = key.split('|')
    out.unshift(`<path d="${paths.join('')}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="${width === '3' ? 'round' : 'butt'}"/>`)
  }
  return out.join('\n')
}

// Where the cells drawn for a key are, to point at a button.
export const keyBox = (block: Block, key: string): { row: number; col: number; span: number } | null => {
  for (let r = 0; r < block.length; r++) {
    const line = block[r] as Cell[]
    const first = line.findIndex(cell => cell.key === key)
    if (first < 0) continue
    let last = first
    while (line[last + 1]?.key === key) last++
    return { row: r, col: first, span: last - first + 1 }
  }
  return null
}

// The first row whose text contains `text`, or -1.
export const rowOf = (block: Block, text: string): number => block.findIndex(line => line.map(cell => cell.ch).join('').includes(text))

export const widthCells = widthOf
