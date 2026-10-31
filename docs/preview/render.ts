// Draws the README images from the board's own code: drawPane's tree and boardScreen's lines,
// laid out like a terminal (terminal.ts), written as SVG. One set per language.
//   bun docs/preview/render.ts          (run `claude --plugin-dir .` once first, for the JSX setup)
//   bun docs/preview/render.ts cover-en (only the files whose names start with cover-en)
// Writes docs/images/{tour,flow,promo}-<lang>.svg, docs/images/board/<agent>-<lang>-<light|dark>.svg,
// docs/images/cover-<lang>-<light|dark>.svg (the README's animated cover), docs/images/agents/<agent>.svg,
// docs/images/agents/chip-<agent>.svg (the README's Integrations strip; `bun docs/preview/render.ts chip-`),
// and docs/preview/out/dashboard-<lang>.html for
// docs/preview/png.mjs, which takes the progress.html screenshots and the social preview.
import { mkdirSync, readdirSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { upsertAutoBlock } from '../../hooks/blocks'
import { boardItems, boardScreen, emptyBoardState, fit } from '../../hooks/board'
import type { BoardState } from '../../hooks/board'
import { dashboardHtml } from '../../hooks/dashboard'
import { countDay, journalLine } from '../../hooks/journal'
import { applyTaskCreate, applyTaskUpdate, emptyMirror } from '../../hooks/mirror'
import { MARK_PATH } from '../../hooks/page-look'
import { DARK, LIGHT, PAGE_DARK, PAGE_LIGHT } from '../../hooks/palette'
import type { Palette } from '../../hooks/palette'
import { parseProgress } from '../../hooks/parse'
import { emptyQuestions } from '../../hooks/questions'
import { STRINGS, agentLabel } from '../../hooks/strings'
import { buildView } from '../../hooks/view'
import { CLI_FILES, COVER, COVER_AGENTS, COVER_MARKS, COVER_MOMENTS, NOW, SAMPLES, SESSION, MIN, coverFile } from './samples'
import type { CoverAgent, CoverSample } from './samples'
import { AGENT_ICONS, TESTED_ICONS } from './icons'
import type { AgentIcon } from './icons'
import { LOCKUP, lockupBody } from './brand'
import { CELL, LINE, gridSvg, keyBox, layout, rowOf, toNode, widthCells } from './terminal'
import type { Theme } from './terminal'

// The JSX in pane.tsx compiles to h(type, props, ...children).
;(globalThis as Record<string, unknown>).h = (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false && child !== true),
})
const { drawPane } = await import('../../hooks/pane')

const OUT = join(import.meta.dir, '..', 'images')
const PAGES = join(import.meta.dir, 'out')
mkdirSync(OUT, { recursive: true })
mkdirSync(PAGES, { recursive: true })
const LANGS = ['en', 'zh-TW', 'zh-CN'] as const
type Lang = (typeof LANGS)[number]
type Mode = 'light' | 'dark'
const WIDTH = 46

const TERMINAL: Record<Mode, { ground: string; ink: string; edge: string; bar: string; palette: Palette }> = {
  dark: { ground: '#1e2022', ink: '#e6e4dc', edge: '#34373a', bar: '#26292b', palette: DARK },
  light: { ground: '#fbfaf5', ink: '#2b2b2b', edge: '#d9d7cc', bar: '#f1efe7', palette: LIGHT },
}
// The fonts, which fonts.py puts into each SVG (GitHub shows it as an image, and an image may
// not fetch a font): Inter for the words, JetBrains Mono for the terminal, and Noto Sans for
// Chinese, the image's own script first. JetBrains Mono is 0.6 em wide, so at 14 px a letter
// fills one CELL exactly. The system fonts after them catch a sign none of these has, and stand
// in when the fonts inside are blocked (raw.githubusercontent.com's policy blocks them when the
// SVG is opened by itself): the Latin ones come first, since a Chinese font's letters are not
// 0.6 em and would not fit the terminal's cells.
const CJK: Record<Lang, { inside: string; system: string }> = {
  en: { inside: "'Noto Sans TC', 'Noto Sans SC'", system: "'PingFang TC', 'Microsoft JhengHei'" },
  'zh-TW': { inside: "'Noto Sans TC', 'Noto Sans SC'", system: "'PingFang TC', 'Microsoft JhengHei'" },
  'zh-CN': { inside: "'Noto Sans SC', 'Noto Sans TC'", system: "'PingFang SC', 'Microsoft YaHei'" },
}
const sansOf = (lang: Lang): string => `'Inter', ${CJK[lang].inside}, -apple-system, 'Segoe UI', ${CJK[lang].system}, sans-serif`
const monoOf = (lang: Lang): string => `'JetBrains Mono', ${CJK[lang].inside}, ui-monospace, Menlo, Consolas, ${CJK[lang].system}, monospace`
// A big headline is set a little tighter, with Chinese punctuation at half width (the font's
// 'palt'), so a comma or full stop does not leave a hole the size of a letter.
const HEADLINE = `letter-spacing="-0.02em" style="font-feature-settings: 'palt'"`

const WORDS: Record<Lang, {
  flow: { heads: [string, string, string]; sources: Array<[string, string]>; outputs: Array<[string, string]>; into: [string, string, string]; file: string }
  window: string
}> = {
  en: {
    flow: {
      heads: ['Who reports', 'One file', 'Where you see it'],
      sources: [
        ['Claude Code', 'Every turn, by itself'],
        ['Other agents', 'Codex, Gemini, OpenCode…'],
        ['You', 'Add a task by hand'],
      ],
      into: ['on its own', 'through hooks', 'type it in'],
      file: 'One Markdown file, one block per session',
      outputs: [
        ['The pane', 'What needs you comes first'],
        ['progress.html', 'Any browser, even your phone'],
        ['Archive & report', 'Monthly files, weekly report'],
        ['Status line & alerts', 'Even with the pane closed'],
      ],
    },
    window: 'claude  —  acme-web',
  },
  'zh-TW': {
    flow: {
      heads: ['誰在回報', '寫進同一個檔', '在哪裡看'],
      sources: [
        ['Claude Code', '每回合自動回報'],
        ['其他 agent', 'Codex、Gemini、OpenCode…'],
        ['你', '自己加一件事'],
      ],
      into: ['自動', '透過 hook', '自己打'],
      file: '一個 Markdown 檔，每個對話一塊',
      outputs: [
        ['面板', '等你的事排最前面'],
        ['progress.html', '瀏覽器、手機都能看'],
        ['封存與週報', '每月存檔，每週報告'],
        ['狀態列與通知', '面板關著也知道'],
      ],
    },
    window: 'claude  —  acme-web',
  },
  'zh-CN': {
    flow: {
      heads: ['谁在汇报', '写进同一个文件', '在哪里看'],
      sources: [
        ['Claude Code', '每回合自动汇报'],
        ['其他 agent', 'Codex、Gemini、OpenCode…'],
        ['你', '自己加一件事'],
      ],
      into: ['自动', '通过 hook', '自己打'],
      file: '一个 Markdown 文件，每个对话一块',
      outputs: [
        ['面板', '等你的事排最前面'],
        ['progress.html', '浏览器、手机都能看'],
        ['归档与周报', '每月存档，每周报告'],
        ['状态栏与通知', '面板关着也知道'],
      ],
    },
    window: 'claude  —  acme-web',
  },
}

// What the file looks like, in each language's sample.
const FILE_LINES: Record<Lang, string[]> = {
  en: ['## acme-web', '<!-- auto agent=claude -->', '### Add a dark mode', '- [x] Add colour tokens', '- [~] Fix chart contrast', '- [?] Release plan', '', '## api-gateway', '<!-- auto agent=codex -->', '- [?] 100 or 300 a minute?', '', '## Job search', '- [ ] Submit   due 10-31'],
  'zh-TW': ['## acme-web', '<!-- auto agent=claude -->', '### 設定頁加上深色模式', '- [x] 加深色的顏色 token', '- [~] 修圖表對比', '- [?] 上線方式', '', '## api-gateway', '<!-- auto agent=codex -->', '- [?] 每分鐘 100 還是 300？', '', '## 求職', '- [ ] 投遞   截止 10-31'],
  'zh-CN': ['## acme-web', '<!-- auto agent=claude -->', '### 设置页加上深色模式', '- [x] 加深色的颜色 token', '- [~] 修图表对比度', '- [?] 上线方式', '', '## api-gateway', '<!-- auto agent=codex -->', '- [?] 每分钟 100 还是 300？', '', '## 求职', '- [ ] 投递   截止 10-31'],
}

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// This session's mirror, before and after the person answers its question.
const mineOf = (lang: Lang, isAnswered: boolean) => {
  const sample = SAMPLES[lang] as (typeof SAMPLES)[string]
  let mine = emptyMirror(SESSION, sample.project, NOW, '')
  sample.mine.steps.forEach(([subject, , metadata], i) => {
    mine = applyTaskCreate(mine, { subject, activeForm: '', metadata } as never, String(i + 1), NOW)
  })
  sample.mine.steps.forEach(([, status], i) => {
    if (status !== 'pending') mine = applyTaskUpdate(mine, { taskId: String(i + 1), status } as never, NOW)
  })
  if (isAnswered) {
    for (const [id, status] of [['3', 'completed'], ['4', 'completed'], ['5', 'in_progress']] as const) {
      mine = applyTaskUpdate(mine, { taskId: id, status } as never, NOW)
    }
  }
  return {
    ...mine,
    title: sample.mine.title,
    context: sample.mine.context,
    state: 'working' as const,
    branch: sample.mine.branch,
    pr: { number: 128, url: 'https://github.com/acme/acme-web/pull/128', state: 'open' as const, isDraft: false, ci: 'pending' as const, failed: 0, review: 'required' as const },
    updated: NOW,
  }
}

const today = (lang: Lang): number =>
  countDay((SAMPLES[lang] as (typeof SAMPLES)[string]).journal.map(([days, project, task, step]) => journalLine({ project, task, step }, NOW - days * 24 * 60 * MIN)).join('\n'), NOW)

type Frame = { opened: string[]; isAnswered: boolean; expanded?: string }

const paneGrid = (lang: Lang, mode: Mode, frame: Frame) => {
  const s = STRINGS[lang]
  const sample = SAMPLES[lang] as (typeof SAMPLES)[string]
  const mine = mineOf(lang, frame.isAnswered)
  const file = upsertAutoBlock(sample.file, mine, s)
  const view = buildView(parseProgress(file), [sample.project], mine, NOW, today(lang), {}, s)
  const t = TERMINAL[mode]
  const option = sample.mine.steps[3]?.[2]?.options as string[]
  const answer = frame.isAnswered ? { question: sample.mine.steps[3]?.[0] ?? '', text: s.answered(option[0] ?? ''), isAsking: false } : null
  const tree = drawPane(
    { Box: 'Box', Text: 'Text', Button: 'Button', Input: 'Input', Link: 'Link' } as never,
    { view, expanded: frame.expanded ?? '', opened: frame.opened, answer, path: sample.path, width: 26, hasTaskTools: true, isNotifyOn: true, isLegendOpen: false, palette: t.palette, s } as never,
    {} as never,
  )
  const theme: Theme = { ground: t.ground, ink: t.ink, edge: t.edge, muted: t.palette.muted, accent: t.palette.accent, frame: t.palette.frame }
  return { grid: layout(toNode(tree) ?? '', WIDTH, theme), theme, firstOption: option[0] ?? '' }
}

// A terminal window around a grid: a title bar, then the cells.
const PAD = 22
const BAR = 34
const windowWidth = WIDTH * CELL + PAD * 2
const terminal = (mode: Mode, mono: string, title: string, body: string, rows: number, x: number, y: number, cols = WIDTH): string => {
  const t = TERMINAL[mode]
  const w = cols * CELL + PAD * 2
  const h = BAR + PAD + rows * LINE + PAD
  return `<g transform="translate(${x} ${y})">
<rect width="${w}" height="${h}" rx="12" fill="${t.ground}" stroke="${t.edge}"/>
<path d="M12 0.5h${w - 24}a11.5 11.5 0 0 1 11.5 11.5v${BAR - 12}h-${w - 1}v-${BAR - 12}a11.5 11.5 0 0 1 11.5-11.5z" fill="${t.bar}"/>
<line x1="0.5" y1="${BAR}" x2="${w - 0.5}" y2="${BAR}" stroke="${t.edge}"/>
<g fill="${t.palette.frame}"><circle cx="20" cy="17" r="5"/><circle cx="38" cy="17" r="5"/><circle cx="56" cy="17" r="5"/></g>
<text x="${w / 2}" y="22" text-anchor="middle" font-family="${mono}" font-size="12" fill="${t.palette.muted}">${esc(title)}</text>
<g font-family="${mono}" font-size="14" style="white-space:pre" xml:space="preserve">${body}</g>
</g>`
}

// The look the README's pictures share with the promotional card: a deep blue ground with a
// faint dot grid and a teal glow, dark cards, the board mark, and each agent's own tile.
const BRAND = { ground: '#0c1116', card: '#151b21', line: '#29313a', ink: '#f2f1ec', muted: '#9aa0a6', accent: DARK.accent }

const brandDefs = (w: number, h: number, glow: [number, number] = [0.78, 0.35]): string =>
  `<linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f1a24"/><stop offset="0.55" stop-color="#0c1116"/><stop offset="1" stop-color="#090b0d"/></linearGradient>
<radialGradient id="glow" cx="${glow[0]}" cy="${glow[1]}" r="0.55"><stop offset="0" stop-color="${BRAND.accent}" stop-opacity="0.2"/><stop offset="1" stop-color="${BRAND.accent}" stop-opacity="0"/></radialGradient>
<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#fff" fill-opacity="0.05"/></pattern>
<filter id="lift" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.55"/></filter>
<clipPath id="edge"><rect width="${w}" height="${h}" rx="24"/></clipPath>`

const brandGround = (w: number, h: number): string =>
  `<rect width="${w}" height="${h}" fill="url(#sky)"/><rect width="${w}" height="${h}" fill="url(#glow)"/><rect width="${w}" height="${h}" fill="url(#dots)"/>`

// The board mark, `size` square at x, y, and beside it the wordmark, both on the dark ground.
const brandMark = (x: number, y: number, size = 34, hasName = true): string => {
  const k = size / LOCKUP.grid.size
  if (!hasName) return `<path transform="translate(${x} ${y}) scale(${num(size / 64)})" fill="${PAGE_DARK.brand}" d="${MARK_PATH}"/>`
  return `<g transform="translate(${num(x - LOCKUP.grid.x * k)} ${num(y - LOCKUP.grid.y * k)}) scale(${num(k)})">${lockupBody(BRAND.ink, PAGE_DARK.brand)}</g>`
}

// docs/images/brand/: the lockup for a light and for a dark ground; the lockup and the mark alone that
// follow the reader's theme through their own style (the README's title is that lockup: GitHub gives
// an SVG picture its page's theme). Paths only, on a transparent ground.
const lockupOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(LOCKUP.width)}" height="${Math.ceil(LOCKUP.height)}" viewBox="${LOCKUP.left} ${LOCKUP.top} ${LOCKUP.width} ${LOCKUP.height}" role="img" aria-label="agent-board"><title>agent-board</title>`
const brandLockup = (mode: 'light' | 'dark'): string => {
  const page = mode === 'light' ? PAGE_LIGHT : PAGE_DARK
  return `${lockupOpen}${lockupBody(page.ink, page.brand)}</svg>\n`
}
const brandLogo = (): string =>
  `${lockupOpen}<style>.ink{fill:${PAGE_LIGHT.ink}}.brand{fill:${PAGE_LIGHT.brand}}@media (prefers-color-scheme:dark){.ink{fill:${PAGE_DARK.ink}}.brand{fill:${PAGE_DARK.brand}}}</style>${lockupBody('.ink', '.brand')}</svg>\n`
const brandMarkFile = (): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="agent-board"><title>agent-board</title><style>path{fill:${PAGE_LIGHT.brand}}@media (prefers-color-scheme:dark){path{fill:${PAGE_DARK.brand}}}</style><path d="${MARK_PATH}"/></svg>\n`

// The logo takes seven tenths of its tile: smaller, a logo with thin lines (OpenAI's) or fine
// detail (Nous Research's) blurs at the table's 24 px.
const GLYPH = 0.7
const num = (value: number): string => String(Math.round(value * 100) / 100)

// An agent's white mark, centred in a tile `size` square at x, y: its logo, else its initial.
const glyph = (icon: AgentIcon, x: number, y: number, size: number): string => {
  if (icon.paths === undefined) {
    return `<text x="${num(x + size / 2)}" y="${num(y + size * 0.66)}" text-anchor="middle" font-size="${Math.round(size * 0.46)}" font-weight="700" fill="#fff">${esc(icon.letter ?? '')}</text>`
  }
  const g = size * GLYPH
  const rule = icon.isEvenOdd === true ? ' fill-rule="evenodd"' : ''
  const ink = icon.ink ?? '#fff'
  if (icon.viewBox !== undefined) return `<svg x="${num(x + (size - g) / 2)}" y="${num(y + (size - g) / 2)}" width="${num(g)}" height="${num(g)}" viewBox="${icon.viewBox}" fill="${ink}"${rule}>${icon.paths.map(d => `<path d="${d}"/>`).join('')}</svg>`
  return `<g transform="translate(${num(x + (size - g) / 2)} ${num(y + (size - g) / 2)}) scale(${Math.round((g / 24) * 10000) / 10000})" fill="${ink}"${rule}>${icon.paths.map(d => `<path d="${d}"/>`).join('')}</g>`
}

// A near-black tile gets a faint rim, or it sinks into a dark page; a coloured one needs none.
const isDark = (tile: string): boolean => parseInt(tile.slice(1, 3), 16) + parseInt(tile.slice(3, 5), 16) + parseInt(tile.slice(5, 7), 16) < 120

// An agent's tile, `size` square, from its name. A name without a tile throws: a renamed agent
// would otherwise drop out of a picture without a word.
const iconTile = (name: string, x: number, y: number, size: number): string => {
  const icon = AGENT_ICONS.find(one => one.name === name)
  if (icon === undefined) throw new Error(`No tile for the agent "${name}" in AGENT_ICONS`)
  const rim = isDark(icon.tile) ? `<rect x="${x + 0.5}" y="${y + 0.5}" width="${size - 1}" height="${size - 1}" rx="${size * 0.23 - 0.5}" fill="none" stroke="#fff" stroke-opacity="0.22"/>` : ''
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${size * 0.23}" fill="${icon.tile}"/>${rim}${glyph(icon, x, y, size)}`
}

// How it works: who writes progress.md, and what reads it. Three numbered columns, big
// type and few words, so it reads at the width GitHub shows it.
const flow = (lang: Lang): string => {
  const mono = monoOf(lang)
  const w = WORDS[lang].flow
  const page = BRAND
  const pal = DARK
  const W = 1280
  const H = 620
  const card = (x: number, y: number, cw: number, ch: number, title: string, sub: string, dot: string, big: number): string =>
    `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="14" fill="${page.card}" stroke="${page.line}" stroke-width="1.4"/>
<circle cx="${x + 28}" cy="${y + ch / 2 - 15}" r="7" fill="${dot}"/>
<text x="${x + 48}" y="${y + ch / 2 - 6}" font-size="${big}" font-weight="700" fill="${page.ink}">${esc(title)}</text>
<text x="${x + 48}" y="${y + ch / 2 + 26}" font-size="19" fill="${page.muted}">${esc(sub)}</text>`
  const dots = [pal.accent, pal.running, pal.waiting]
  const outDots = [pal.accent, pal.project, pal.done, pal.soon]
  const top = 120
  const left = { x: 40, w: 316, h: 116, gap: 152 }
  const right = { x: 904, w: 336, h: 94, gap: 112 }
  const doc = { x: 508, y: top, w: 316, h: 430 }
  // Every source card has a dot and a name, then one more line: Claude Code's tile and its
  // words, the other agents' tiles in place of a list of names, or your words.
  const others = TESTED_ICONS.filter(icon => icon.name !== 'Claude Code')
  const sources = w.sources
    .map(([title, sub], i) => {
      const x = left.x
      const y = top + i * left.gap
      const head = `<rect x="${x}" y="${y}" width="${left.w}" height="${left.h}" rx="14" fill="${page.card}" stroke="${page.line}" stroke-width="1.4"/>
<circle cx="${x + 28}" cy="${y + 37}" r="7" fill="${dots[i] ?? pal.accent}"/>
<text x="${x + 48}" y="${y + 47}" font-size="28" font-weight="700" fill="${page.ink}">${esc(title)}</text>`
      const words = (at: number): string => `<text x="${at}" y="${y + 86}" font-size="19" fill="${page.muted}">${esc(sub)}</text>`
      if (i === 0) return `${head}${iconTile('Claude Code', x + 48, y + 62, 32)}${words(x + 92)}`
      if (i === 1) return `${head}${others.map((icon, k) => iconTile(icon.name, x + 48 + k * 38, y + 62, 32)).join('')}`
      return `${head}${words(x + 48)}`
    })
    .join('\n')
  const outputs = w.outputs.map(([title, sub], i) => card(right.x, top + i * right.gap, right.w, right.h, title, sub, outDots[i] ?? pal.accent, 24)).join('\n')
  const colors = [pal.project, page.muted, page.ink, pal.done, pal.accent, pal.waiting, page.ink, pal.project, page.muted, pal.waiting, page.ink, pal.project, pal.soon]
  const fileText = FILE_LINES[lang]
    .map((line, i) => (line === '' ? '' : `<text x="${doc.x + 24}" y="${doc.y + 84 + i * 25}" fill="${colors[i] ?? page.ink}">${esc(line)}</text>`))
    .join('\n')
  const arrow = (x1: number, y1: number, x2: number, y2: number) => {
    const mid = (x1 + x2) / 2
    return `<path d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2 - 8} ${y2}" fill="none" stroke="${pal.accent}" stroke-opacity="0.55" stroke-width="2.6" marker-end="url(#head)"/>`
  }
  // Each source's arrow lands on the block it writes in the file (the first and last line of
  // it in FILE_LINES), which a bar in the source's colour marks. No arrow climbs, so every
  // label sits above its arrow.
  const lineY = (i: number): number => doc.y + 84 + i * 25
  const blocks: Array<[number, number]> = [[1, 5], [8, 9], [11, 12]]
  const bars = blocks
    .map(([a, b], i) => `<rect x="${doc.x + 11}" y="${lineY(a) - 16}" width="3" height="${lineY(b) - lineY(a) + 22}" rx="1.5" fill="${dots[i] ?? pal.accent}"/>`)
    .join('\n')
  const ins = blocks.map(([a, b], i) => arrow(left.x + left.w, top + i * left.gap + left.h / 2, doc.x, (lineY(a) + lineY(b)) / 2 - 5)).join('\n')
  const labels = w.into
    .map((text, i) => `<text x="${left.x + left.w + 14}" y="${top + i * left.gap + left.h / 2 - 14}" font-size="17" font-weight="600" fill="${page.muted}">${esc(text)}</text>`)
    .join('\n')
  const outs = w.outputs.map((_, i) => arrow(doc.x + doc.w, doc.y + 90 + i * 84, right.x, top + i * right.gap + right.h / 2)).join('\n')
  // The column heads, numbered in reading order, over the middle of each column.
  const heads = w.heads
    .map((text, i) => {
      const cx = [left.x + left.w / 2, doc.x + doc.w / 2, right.x + right.w / 2][i] ?? 0
      // Roughly how wide the heading sets, so the number and the words centre as one.
      const textW = [...text].reduce((sum, ch) => sum + (/[\u2E80-\uFFFF]/.test(ch) ? 24 : 13.5), 0)
      const x0 = cx - (32 + 12 + textW) / 2
      return `<circle cx="${x0 + 16}" cy="68" r="16" fill="${pal.accent}"/><text x="${x0 + 16}" y="75" text-anchor="middle" font-size="19" font-weight="700" fill="${page.card}">${i + 1}</text>` +
        `<text x="${x0 + 44}" y="76" font-size="24" font-weight="700" fill="${page.ink}">${esc(text)}</text>`
    })
    .join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="progress.md: ${esc(w.file)}" font-family="${sansOf(lang)}">
<title>progress.md</title>
<defs>${brandDefs(W, H, [0.5, 0.45])}<marker id="head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${pal.accent}"/></marker></defs>
<g clip-path="url(#edge)">
${brandGround(W, H)}
${heads}
${sources}
${ins}
${labels}
<rect x="${doc.x}" y="${doc.y}" width="${doc.w}" height="${doc.h}" rx="16" fill="${page.card}" stroke="${pal.accent}" stroke-width="2.6"/>
<text x="${doc.x + 24}" y="${doc.y + 44}" font-family="${mono}" font-size="22" font-weight="700" fill="${page.ink}">progress.md</text>
${bars}
<g font-family="${mono}" font-size="16">${fileText}</g>
<text x="${doc.x + doc.w / 2}" y="${doc.y + doc.h + 40}" text-anchor="middle" font-size="19" fill="${page.muted}">${esc(w.file)}</text>
${outs}
${outputs}
</g>
</svg>
`
}

// The tour at the top of the README, about 48 s: why you need it, what it does,
// where it runs and how it looks. One SVG, CSS keyframes only, so GitHub plays it.
type TourWords = {
  why: string[]
  waiting: string[]
  waitingSub: string[]
  answer: string[]
  answerSub: string
  press: string[]
  pressSub: string[]
  hooks: string[]
  hooksSub: string[]
  lost: string[]
  lostLines: string[]
  runs: string[]
  surfaces: string[]
  systems: string
  colours: string[]
  coloursSub: string
  names: Array<[string, string]>
  end: string
  timeline: [string, string, string]
  working: string
  waitsOnYou: string
}

const TOUR: Record<Lang, TourWords> = {
  en: {
    why: ['Running a few', 'AI agents at once?'],
    waiting: ['One has been waiting', 'on you for 20 minutes.'],
    waitingSub: ["And you didn't notice."],
    answer: ['Not anymore.', 'Whatever needs you', 'shows up first.'],
    answerSub: 'Agent Board, a plugin for Claude Code',
    press: ['Answer right here.', 'No window hunting.'],
    pressSub: ['One click and the agent', 'gets back to work.'],
    hooks: ['Your other agents', 'report in on their own.'],
    hooksSub: ['Installing connects them.'],
    lost: ['Close it.', 'Come back tomorrow.'],
    lostLines: ["What's done, what's stuck, what's next", 'Take over a session left halfway', 'Finished work clears itself away'],
    runs: ['Wherever you use', 'Claude Code.'],
    surfaces: ['Terminal', 'Desktop app', 'VS Code', 'Browser and phone'],
    systems: 'macOS · Linux · Windows  ·  English · 繁體中文 · 简体中文',
    colours: ['Easy on the eyes,', 'light or dark.'],
    coloursSub: 'Traditional Japanese colours, and every word stays readable',
    names: [['藍 Ai', '浅葱 Asagi'], ['常磐 Tokiwa', '若竹 Wakatake'], ['鶯茶 Uguisucha', '山吹 Yamabuki'], ['江戸紫 Edomurasaki', '藤紫 Fujimurasaki'], ['代赭 Taisha', '柿 Kaki'], ['茜 Akane', '薔薇 Bara']],
    end: 'Stop checking on your agents. Let them tell you.',
    timeline: ['Why you need it', 'What it does', 'Where it runs'],
    working: 'working…',
    waitsOnYou: '● waiting on you · 20 min',
  },
  'zh-TW': {
    why: ['同時開好幾個', 'AI agent 嗎？'],
    waiting: ['有一個已經', '等你 20 分鐘了。'],
    waitingSub: ['你完全沒發現。'],
    answer: ['現在不會了。', '誰在等你，', '一眼就看到。'],
    answerSub: 'Agent Board，Claude Code 外掛',
    press: ['直接在這裡回，', '不用到處找視窗。'],
    pressSub: ['按一下，agent 就繼續做。'],
    hooks: ['其他 agent', '也會自己回報。'],
    hooksSub: ['一行指令接上，之後不用管。'],
    lost: ['關掉、壓縮、', '隔天再開都沒差。'],
    lostLines: ['做到哪、卡在哪、下一步，都還在', '別人做到一半的，可以直接接手', '做完的會自己收走'],
    runs: ['Claude Code 在哪，', '它就在哪。'],
    surfaces: ['終端機', '桌面版', 'VS Code', '瀏覽器、手機'],
    systems: 'macOS · Linux · Windows  ·  English · 繁體中文 · 简体中文',
    colours: ['淺色深色', '都看得舒服。'],
    coloursSub: '用日本傳統色，每個字都清楚好讀',
    names: [['藍', '浅葱'], ['常磐', '若竹'], ['鶯茶', '山吹'], ['江戸紫', '藤紫'], ['代赭', '柿'], ['茜', '薔薇']],
    end: '別再一直盯著 agent 了，讓它們來告訴你。',
    timeline: ['為什麼需要', '它幫你做什麼', '在哪用、長怎樣'],
    working: '工作中…',
    waitsOnYou: '● 等你 20 分鐘',
  },
  'zh-CN': {
    why: ['同时开好几个', 'AI agent 吗？'],
    waiting: ['有一个已经', '等你 20 分钟了。'],
    waitingSub: ['你完全没发现。'],
    answer: ['现在不会了。', '谁在等你，', '一眼就看到。'],
    answerSub: 'Agent Board，Claude Code 插件',
    press: ['直接在这里回，', '不用到处找窗口。'],
    pressSub: ['点一下，agent 就接着干活。'],
    hooks: ['其他 agent', '也会自己汇报。'],
    hooksSub: ['一行命令接上，之后不用管。'],
    lost: ['关掉、压缩、', '第二天再开都没事。'],
    lostLines: ['做到哪、卡在哪、下一步，都还在', '别人做到一半的，可以直接接手', '做完的会自己收走'],
    runs: ['Claude Code 在哪，', '它就在哪。'],
    surfaces: ['终端', '桌面版', 'VS Code', '浏览器、手机'],
    systems: 'macOS · Linux · Windows  ·  English · 繁體中文 · 简体中文',
    colours: ['浅色深色', '都看着舒服。'],
    coloursSub: '用日本传统色，每个字都清楚好读',
    names: [['蓝', '浅葱'], ['常磐', '若竹'], ['莺茶', '山吹'], ['江户紫', '藤紫'], ['代赭', '柿'], ['茜', '蔷薇']],
    end: '别再一直盯着 agent 了，让它们来告诉你。',
    timeline: ['为什么需要', '它帮你做什么', '在哪用、长怎样'],
    working: '工作中…',
    waitsOnYou: '● 等你 20 分钟',
  },
}

const AGENTS: Array<[string, string]> = [
  ['Claude Code', 'acme-web'],
  ['Codex', 'api-gateway'],
  ['Gemini CLI', 'data-pipeline'],
  ['OpenCode', 'docs-site'],
  ['Grok Build', 'mobile-app'],
]
const HOOKED = TESTED_ICONS.map(icon => icon.name)

const ENDED_TITLE: Record<Lang, string> = { en: 'Upgrade to React 19', 'zh-TW': '升級到 React 19', 'zh-CN': '升级到 React 19' }

// Lines of at most `max` characters, broken between words; text with no spaces stays whole.
const wrapWords = (text: string, max: number): string[] =>
  text.split(' ').reduce<string[]>((lines, word) => {
    const last = lines[lines.length - 1]
    if (last !== undefined && last.length + 1 + word.length <= max) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
    return lines
  }, [])

const tour = (lang: Lang): string => {
  const mono = monoOf(lang)
  const mode: Mode = 'dark'
  const W = 1200
  const H = 675
  // How long each moment stays on screen, in seconds; each starts where the one before ends.
  const HOLD = { why: 5.4, waiting: 5.4, answer: 5.6, press: 5.6, hooks: 5.5, lost: 5.5, runs: 5.6, colours: 5, end: 4.4 }
  const at = {} as Record<keyof typeof HOLD, [number, number]>
  let clock = 0
  for (const key of Object.keys(HOLD) as Array<keyof typeof HOLD>) {
    at[key] = [clock, clock + HOLD[key]]
    clock += HOLD[key]
  }
  const LOOP = clock
  // Within the press moment: the button lights up, then the pane after the answer.
  const answered = at.press[0] + 3
  // A moment comes in over IN seconds and leaves over OUT, so the next one starts on a clear
  // stage rather than on top of the last.
  const IN = 0.7
  const OUT = 0.4
  const w = TOUR[lang]
  const s = STRINGS[lang]
  const page = BRAND
  const term = TERMINAL[mode]
  const pal = term.palette
  const other: Mode = mode === 'light' ? 'dark' : 'light'
  const isCjk = lang !== 'en'
  const keyframes: string[] = []
  // Visible from `start` to `end` seconds. `rise` slides up into place and on out the top,
  // `zoom` grows into place, `fade` only fades, `swap` stays until the frame drawn over it
  // has come in (for what changes inside the pane window, so it is never empty).
  // Each step eases on its own, since the loop as a whole runs linear.
  const MOTION = {
    rise: { from: 'translate: 0 28px', on: 'translate: 0 0', to: 'translate: 0 -18px' },
    zoom: { from: 'scale: 0.94', on: 'scale: 1', to: 'scale: 1.03' },
    fade: { from: '', on: '', to: '' },
    swap: { from: '', on: '', to: '' },
  }
  const EASE_IN = 'animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1)'
  const EASE_OUT = 'animation-timing-function: cubic-bezier(0.7, 0, 0.84, 0)'
  const timed = (start: number, end: number, motion: keyof typeof MOTION = 'rise'): string => {
    const name = `k${keyframes.length}`
    const p = (sec: number): string => `${Math.max(0, Math.min(100, (sec / LOOP) * 100)).toFixed(2)}%`
    const m = MOTION[motion]
    const [from, to] = motion === 'swap' ? [end + IN, end + IN + 0.05] : [end - OUT, end]
    const leave = `${p(from)} { opacity: 1; ${m.on}; ${EASE_OUT} } ${p(to)}, 100% { opacity: 0; ${m.to} }`
    keyframes.push(
      start <= 0
        ? `@keyframes ${name} { 0% { opacity: 1; ${m.on} } ${leave} }`
        : `@keyframes ${name} { 0%, ${p(start)} { opacity: 0; ${m.from}; ${EASE_IN} } ${p(start + IN)} { opacity: 1; ${m.on} } ${leave} }`,
    )
    return `sc ${motion}" style="animation-name:${name}`
  }

  // Left column: the headline of each moment.
  const head = (lines: string[], sub: string[], start: number, end: number, still = false): string => {
    const size = isCjk ? 40 : 42
    const top = 230 - (lines.length - 2) * 26
    const big = lines.map((line, i) => `<text x="64" y="${top + i * 56}" font-size="${size}" font-weight="800" ${HEADLINE} fill="${i === lines.length - 1 ? page.accent : page.ink}">${esc(line)}</text>`).join('')
    const small = sub
      .map((line, i) => `<text x="64" y="${top + lines.length * 56 + 22 + i * 34}" font-size="25" fill="${page.muted}">${esc(line)}</text>`)
      .join('')
    // The line under the headline follows it in a beat later.
    const after = small === '' ? '' : `<g class="${timed(start + 0.25, end)}"${still ? ' data-still="1"' : ''}>${small}</g>`
    return `<g class="${timed(start, end)}"${still ? ' data-still="1"' : ''}>${big}</g>${after}`
  }

  // The pane: a terminal window at the right, scaled up a little; the body switches with the
  // moment, scrolled to the part it is about.
  const VIS = 15
  const SCALE = 1.3
  const winX = W - windowWidth * SCALE - 56
  const winY = 82
  const bodyH = PAD + VIS * LINE + PAD
  const frame1 = paneGrid(lang, mode, { opened: [], isAnswered: false })
  const frame2 = paneGrid(lang, mode, { opened: ['waiting'], isAnswered: false })
  const frame3 = paneGrid(lang, mode, { opened: [], isAnswered: true })
  const endedKey = `acme-web::${ENDED_TITLE[lang]}`
  const frameH = paneGrid(lang, mode, { opened: ['others'], isAnswered: false, expanded: endedKey })
  const frameDark = paneGrid(lang, other, { opened: [], isAnswered: false })
  // Each frame has its own ground, so the one coming in covers the one going out.
  const body = (grid: typeof frame1, offset: number, start: number, end: number, still = false): string =>
    `<g class="${timed(start, end, 'swap')}"${still ? ' data-still="1"' : ''}><rect x="0" y="${BAR}" width="${windowWidth}" height="${bodyH}" fill="${grid.theme.ground}"/>${gridSvg(grid.grid.slice(offset, offset + VIS + 1), PAD, BAR + PAD, grid.theme)}</g>`
  // A ring round some rows of the pane, with room above for the tops of Chinese letters.
  const ring = (row: number, col: number, span: number, rows: number, start: number, end: number): string =>
    `<rect class="${timed(start, end, 'fade')}" x="${PAD + col * CELL - 6}" y="${BAR + PAD + row * LINE - 3}" width="${span * CELL + 12}" height="${rows * LINE + 5}" rx="6" fill="none" stroke="${pal.accent}" stroke-width="2.4"/>`
  const windowFrame = (m: Mode, inner: string, cls: string, still = false): string => {
    const t = TERMINAL[m]
    const h = BAR + bodyH
    // The class sits on an outer group: its CSS motion would replace a transform on the same element.
    return `<g class="${cls}"${still ? ' data-still="1"' : ''}><g filter="url(#lift)" transform="translate(${winX.toFixed(1)} ${winY}) scale(${SCALE})">
<rect width="${windowWidth}" height="${h}" rx="12" fill="${t.ground}" stroke="${t.edge}"/>
<path d="M12 0.5h${windowWidth - 24}a11.5 11.5 0 0 1 11.5 11.5v${BAR - 12}h-${windowWidth - 1}v-${BAR - 12}a11.5 11.5 0 0 1 11.5-11.5z" fill="${t.bar}"/>
<line x1="0.5" y1="${BAR}" x2="${windowWidth - 0.5}" y2="${BAR}" stroke="${t.edge}"/>
<g fill="${t.palette.frame}"><circle cx="20" cy="17" r="5"/><circle cx="38" cy="17" r="5"/><circle cx="56" cy="17" r="5"/></g>
<text x="${windowWidth / 2}" y="22" text-anchor="middle" font-family="${mono}" font-size="12" fill="${t.palette.muted}">${esc(WORDS[lang].window)}</text>
<g clip-path="url(#body)" font-family="${mono}" font-size="14" style="white-space:pre" xml:space="preserve">${inner}</g>
</g></g>`
  }

  const focusTop = Math.max(0, rowOf(frame1.grid, s.mostNeeded))
  const more = keyBox(frame1.grid, 'focus::more')
  const option = keyBox(frame1.grid, `mine::4::${frame1.firstOption}`)
  const waitingAt = Math.max(0, rowOf(frame2.grid, s.sectionWaiting) - 1)
  const endedAt = Math.max(0, rowOf(frameH.grid, ENDED_TITLE[lang]) - 2)
  const take = keyBox(frameH.grid, `${endedKey}::take`)
  const handoffRow = rowOf(frameH.grid, s.handoffLine('').trim().replace(/[:：]$/, ''))
  // Lines of the handoff note, which wraps: up to the first numbered step.
  let handoffRows = 1
  while (handoffRow >= 0 && handoffRows < 4 && !/^\s*\d+ /.test((frameH.grid[handoffRow + handoffRows] ?? []).map(cell => cell.ch).join(''))) handoffRows++
  // What the press did, as a band along the bottom of the window.
  const bandY = BAR + PAD + (VIS - 2) * LINE - 4
  const toast = `<g class="${timed(answered + 0.1, at.press[1], 'fade')}"><rect x="0.5" y="${bandY}" width="${windowWidth - 1}" height="${BAR + bodyH - bandY - 0.5}" fill="${term.ground}"/><line x1="0.5" y1="${bandY}" x2="${windowWidth - 0.5}" y2="${bandY}" stroke="${pal.done}" stroke-width="1.6"/><text x="${PAD}" y="${bandY + 30}" font-weight="700" fill="${pal.done}">✓ ${esc(s.answered(frame1.firstOption))}</text></g>`
  const inner = [
    body(frame1, 0, at.answer[0], answered, true),
    focusTop >= 0 && more !== null ? ring(focusTop, 0, WIDTH, more.row - focusTop - 1, at.answer[0] + 0.6, at.answer[1]) : '',
    option !== null ? ring(option.row, option.col, option.span, 1, at.press[0] + 0.4, answered) : '',
    body(frame3, 0, answered, at.press[1]),
    toast,
    body(frame2, waitingAt, ...at.hooks),
    body(frameH, endedAt, ...at.lost),
    handoffRow >= 0 ? ring(handoffRow - endedAt, 0, WIDTH, handoffRows, at.lost[0] + 0.7, at.lost[1]) : '',
    take !== null ? ring(take.row - endedAt, take.col, take.span, 1, at.lost[0] + 2.2, at.lost[1]) : '',
    body(frame1, 0, at.runs[0], at.runs[1] + 0.2),
  ].join('\n')
  const darkInner = gridSvg(frameDark.grid.slice(0, VIS + 1), PAD, BAR + PAD, frameDark.theme)

  // five agents, each in its own window; two of them are waiting on you.
  const cards = AGENTS.map(([name, project], i) => {
    const y = 112 + i * 96
    const x = winX + 40
    const isWaiting = i === 1
    return `<g class="${timed(0.3 + i * 0.35, at.waiting[1])}">
<rect x="${x}" y="${y}" width="480" height="78" rx="12" fill="${page.card}" stroke="${page.line}"/>
${iconTile(name, x + 16, y + 9, 30)}
<text x="${x + 58}" y="${y + 30}" font-family="${mono}" font-size="18" font-weight="700" fill="${page.ink}">${esc(name)}</text>
<text x="${x + 58 + (name.length + 1) * 18 * 0.6}" y="${y + 30}" font-family="${mono}" font-size="17" fill="${pal.project}">${esc(project)}</text>
<text x="${x + 18}" y="${y + 62}" font-family="${mono}" font-size="17" fill="${pal.accent}">▸ ${esc(w.working)}</text>
${isWaiting ? `<g class="${timed(at.waiting[0] + 0.4, at.waiting[1], 'zoom')}"> <text class="blink" x="${x + 462}" y="${y + 62}" text-anchor="end" font-size="19" font-weight="700" fill="${pal.waiting}">${esc(w.waitsOnYou)}</text></g>` : ''}
</g>`
  }).join('\n')

  // the agents that report through their hooks.
  const chips = HOOKED.map((name, i) => {
    const col = i % 2
    const row = Math.floor(i / 2)
    const x = 64 + col * 248
    const y = 396 + row * 48
    return `<g class="${timed(at.hooks[0] + 0.5 + i * 0.15, at.hooks[1], 'zoom')}"><rect x="${x}" y="${y}" width="232" height="40" rx="20" fill="${page.card}" stroke="${page.line}"/>${iconTile(name, x + 7, y + 7, 26)}<text x="${x + 44}" y="${y + 27}" font-size="20" fill="${page.ink}">${esc(name)}</text></g>`
  }).join('\n')

  // nothing lost.
  const lost = `<g class="${timed(...at.lost)}">${w.lost
    .map((line, i) => `<text x="64" y="${200 + i * 56}" font-size="${isCjk ? 40 : 42}" font-weight="800" ${HEADLINE} fill="${i === w.lost.length - 1 ? page.accent : page.ink}">${esc(line)}</text>`)
    .join('')}</g>${w.lostLines
    .map((line, i) => `<g class="${timed(at.lost[0] + 0.4 + i * 0.2, at.lost[1])}"><text x="64" y="${336 + i * 52}" font-size="24" fill="${pal.done}">✓</text><text x="100" y="${336 + i * 52}" font-size="24" fill="${page.ink}">${esc(line)}</text></g>`)
    .join('')}`

  // where it runs.
  const surfaces = `<g class="${timed(at.runs[0] + 0.3, at.runs[1])}">${w.surfaces
    .map((name, i) => {
      const x = 64 + (i % 2) * 248
      const y = 352 + Math.floor(i / 2) * 64
      return `<rect x="${x}" y="${y}" width="232" height="50" rx="10" fill="${page.card}" stroke="${page.line}"/><text x="${x + 116}" y="${y + 32}" text-anchor="middle" font-size="21" fill="${page.ink}">${esc(name)}</text>`
    })
    .join('')}<text x="64" y="512" font-size="19" fill="${page.muted}">${esc(w.systems)}</text></g>`

  // the colours, light and dark, with their names; the pane turns to the other set.
  const roles = ['accent', 'done', 'waiting', 'running', 'soon', 'alert'] as const
  const swatches = `<g class="${timed(at.colours[0] + 0.2, at.colours[1])}">${roles
    .map((role, i) => {
      const x = 64 + (i % 3) * 172
      const y = 350 + Math.floor(i / 3) * 100
      const [lightName, darkName] = w.names[i] ?? ['', '']
      return `<circle cx="${x + 14}" cy="${y}" r="14" fill="${LIGHT[role]}"/><circle cx="${x + 44}" cy="${y}" r="14" fill="${DARK[role]}" stroke="${page.line}"/>` +
        `<text x="${x}" y="${y + 40}" font-size="17" fill="${page.ink}">${esc(lightName)}</text><text x="${x}" y="${y + 63}" font-size="17" fill="${page.muted}">${esc(darkName)}</text>`
    })
    .join('')}${wrapWords(w.coloursSub, 40)
    .map((line, i) => `<text x="64" y="${350 + 2 * 100 + 4 + i * 26}" font-size="19" fill="${page.muted}">${esc(line)}</text>`)
    .join('')}</g>`

  // the end card.
  const command = 'claude plugin install agent-board@agent-board'
  const tiles = TESTED_ICONS.map((icon, i) => iconTile(icon.name, W / 2 - (TESTED_ICONS.length * 52 - 12) / 2 + i * 52, 452, 40)).join('')
  const endCard = `<g class="${timed(at.end[0], LOOP + 0.2, 'zoom')}">
${brandMark(W / 2 - 30, 128, 60, false)}
<text x="${W / 2}" y="262" text-anchor="middle" font-size="64" font-weight="800" ${HEADLINE} fill="${page.ink}">Agent Board</text>
<text x="${W / 2}" y="314" text-anchor="middle" font-size="28" fill="${page.accent}">${esc(w.end)}</text>
</g>
<g class="${timed(at.end[0] + 0.35, LOOP + 0.2)}">
<rect x="${W / 2 - 330}" y="350" width="660" height="60" rx="12" fill="${page.card}" stroke="${pal.accent}" stroke-width="1.8"/>
<text x="${W / 2}" y="388" text-anchor="middle" font-family="${mono}" font-size="21" fill="${page.ink}">${esc(command)}</text>
</g>
<g class="${timed(at.end[0] + 0.6, LOOP + 0.2)}">${tiles}</g>`

  // The timeline along the bottom: the three parts, and how far the tour has come.
  const track = { x: 64, y: 626, w: W - 128 }
  const marks: Array<[number, string]> = [
    [0, w.timeline[0]],
    [at.press[0], w.timeline[1]],
    [at.runs[0], w.timeline[2]],
  ]
  const timeline = `<g>
<rect x="${track.x}" y="${track.y}" width="${track.w}" height="4" rx="2" fill="${page.line}"/>
<rect class="bar" x="${track.x}" y="${track.y}" width="${track.w}" height="4" rx="2" fill="${pal.accent}"/>
${marks.map(([at, label]) => `<text x="${track.x + (at / LOOP) * track.w}" y="${track.y - 12}" font-size="17" fill="${page.muted}">${esc(label)}</text>`).join('')}
</g>`

  const scenes = [
    head(w.why, [], ...at.why),
    head(w.waiting, w.waitingSub, ...at.waiting),
    cards,
    head(w.answer, [w.answerSub], ...at.answer, true),
    head(w.press, w.pressSub, ...at.press),
    head(w.hooks, w.hooksSub, ...at.hooks),
    chips,
    lost,
    head(w.runs, [], ...at.runs),
    surfaces,
    head(w.colours, [], ...at.colours),
    swatches,
    windowFrame(mode, inner, `win ${timed(at.answer[0], at.runs[1] + 0.2, 'zoom')}`, true),
    windowFrame(other, darkInner, `win ${timed(at.colours[0], at.colours[1] + 0.2, 'zoom')}`),
    endCard,
  ]
  const label = [w.why, w.answer, w.hooks, w.runs, w.colours].map(lines => lines.join(' ')).join(' / ')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" font-family="${sansOf(lang)}">
<title>Agent Board: ${esc(w.end)}</title>
<defs>${brandDefs(W, H)}<clipPath id="body"><path d="M1 ${BAR}h${windowWidth - 2}v${bodyH - 12}a11 11 0 0 1 -11 11h-${windowWidth - 24}a11 11 0 0 1 -11 -11z"/></clipPath></defs>
<style>
.sc { opacity: 0; animation-duration: ${LOOP}s; animation-iteration-count: infinite; animation-timing-function: linear; }
.zoom { transform-box: fill-box; transform-origin: center; }
.bar { transform-box: fill-box; transform-origin: 0 50%; animation: grow ${LOOP}s linear infinite; }
.blink { animation: blink 0.9s steps(2, jump-none) infinite; }
@keyframes grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
@keyframes blink { from { opacity: 1 } to { opacity: 0.25 } }
${keyframes.join('\n')}
@media (prefers-reduced-motion: reduce) {
  .sc, .bar, .blink { animation: none; translate: none; scale: none; }
  .sc { opacity: 0; }
  [data-still] { opacity: 1; }
  .bar { transform: none; }
}
</style>
<g clip-path="url(#edge)">
${brandGround(W, H)}
${brandMark(64, 36, 30)}
${scenes.join('\n')}
${timeline}
</g>
</svg>
`
}

const dashboard = (lang: Lang): string => {
  const s = STRINGS[lang]
  const sample = SAMPLES[lang] as (typeof SAMPLES)[string]
  const file = upsertAutoBlock(sample.file, mineOf(lang, false), s)
  const view = buildView(parseProgress(file), [], null, NOW, today(lang), {}, s)
  return dashboardHtml(view, s, sample.path, s.dashStamp('2026-10-16 09:40'), [], NOW)
}

// The promotional card, for GitHub's social preview and for sharing: a headline, the agents
// it works with, and the pane itself with a question that has just come in.
const PROMO: Record<Lang, { headline: string[]; sub: string[]; works: string; note: [string, string, string]; answers: [string, string] }> = {
  en: {
    headline: ['Stop checking', 'on your agents.', 'Let them tell you.'],
    sub: ['One board for Claude Code, Codex, Gemini CLI and more.', 'Whatever needs you comes first.'],
    works: 'WORKS WITH',
    note: ['Codex', 'api-gateway · waiting on you', 'Per-key limit: 100 or 300 a minute?'],
    answers: ['100', '300'],
  },
  'zh-TW': {
    headline: ['別再一直盯著 agent，', '讓它們來告訴你。'],
    sub: ['所有 AI coding agent 一個面板看完，', '等你的事排第一個。'],
    works: '支援',
    note: ['Codex', 'api-gateway · 在等你', '每把金鑰一分鐘上限：100 還是 300？'],
    answers: ['100', '300'],
  },
  'zh-CN': {
    headline: ['别再一直盯着 agent，', '让它们来告诉你。'],
    sub: ['所有 AI coding agent 一个面板看完，', '等你的事排第一个。'],
    works: '支持',
    note: ['Codex', 'api-gateway · 在等你', '每个密钥一分钟上限：100 还是 300？'],
    answers: ['100', '300'],
  },
}

const promo = (lang: Lang): string => {
  const mono = monoOf(lang)
  const w = PROMO[lang]
  const pal = DARK
  const { grid: whole, theme } = paneGrid(lang, 'dark', { opened: [], isAnswered: false })
  // The card has no room for the Already answered line under the reply box (nor the blank line
  // above it), nor for the question's age and archive notes: the notification under the pane
  // would run off the card.
  const hide = whole.findIndex(row => row.map(cell => cell.ch).join('').includes(STRINGS[lang].answeredHide))
  const isBlankAbove = hide > 0 && (whole[hide - 1] ?? []).every(cell => cell.ch === ' ')
  const notes = [STRINGS[lang].questionAgeUnknown, STRINGS[lang].archiveLive]
  const grid = (isBlankAbove ? [...whole.slice(0, hide - 1), ...whole.slice(hide + 1)] : whole)
    .filter(row => !notes.some(note => row.map(cell => cell.ch).join('').includes(note)))
  // The pane whole, down to the line before its second box (the first is the reply box), so
  // no line is cut off.
  const boxes = grid.flatMap((row, i) => ((row[0]?.ch ?? '') === '╭' ? [i] : []))
  const rows = Math.max(1, (boxes[1] ?? Math.min(grid.length, 18)) - 1)
  const body = gridSvg(grid.slice(0, rows), PAD, BAR + PAD, theme)
  const isCjk = lang !== 'en'
  const size = isCjk ? 50 : 52
  // The headline's last line is the promise, in the accent colour.
  const lineGap = size + 10
  const top = isCjk ? 200 : 180
  const headline = w.headline
    .map((line, i) => `<text x="72" y="${top + i * lineGap}" font-size="${size}" font-weight="800" ${HEADLINE} fill="${i === w.headline.length - 1 ? pal.accent : '#f7f6f2'}">${esc(line)}</text>`)
    .join('\n')
  const subY = top + (w.headline.length - 1) * lineGap + 26
  const icons = TESTED_ICONS.map((icon, i) => iconTile(icon.name, 72 + i * 58, 459, 44)).join('\n')
  // The pane, and under it the notification that has just come in; neither covers the other.
  const wx = 760
  const wy = 44
  const nx = wx
  const ny = wy + BAR + PAD * 2 + rows * LINE + 18
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img" aria-label="Agent Board: ${esc(w.headline.join(' '))}" font-family="${sansOf(lang)}">
<title>Agent Board</title>
<defs>${brandDefs(1280, 640)}</defs>
<g clip-path="url(#edge)">
${brandGround(1280, 640)}
${brandMark(72, 70)}
${headline}
${w.sub.map((line, i) => `<text x="72" y="${subY + 24 + i * 33}" font-size="${isCjk ? 23 : 22}" fill="#b9bcc0">${esc(line)}</text>`).join('')}
<text x="72" y="444" font-size="14" font-weight="700" letter-spacing="${isCjk ? 2 : 2.5}" fill="#8b9096">${esc(w.works)}</text>
${icons}
<text x="72" y="572" font-family="${mono}" font-size="19" fill="#d7d9dc">github.com/<tspan fill="#f7f6f2" font-weight="700">WenyuChiou/agent-board</tspan></text>
<g filter="url(#lift)">${terminal('dark', mono, WORDS[lang].window, body, rows, wx, wy)}</g>
<g filter="url(#lift)">
<rect x="${nx}" y="${ny}" width="${windowWidth}" height="132" rx="14" fill="#23272b" stroke="${pal.waiting}" stroke-opacity="0.85" stroke-width="1.6"/>
${iconTile(w.note[0], nx + 20, ny + 20, 34)}
<text x="${nx + 68}" y="${ny + 34}" font-size="17" font-weight="700" fill="#f2f1ec">${esc(w.note[0])}</text>
<text x="${nx + 68}" y="${ny + 54}" font-size="14" fill="${pal.waiting}">● ${esc(w.note[1])}</text>
<text x="${nx + 20}" y="${ny + 84}" font-size="17" fill="#e6e4dc">${esc(w.note[2])}</text>
<rect x="${nx + 20}" y="${ny + 96}" width="80" height="26" rx="7" fill="${pal.accent}"/><text x="${nx + 60}" y="${ny + 114}" text-anchor="middle" font-size="14" font-weight="700" fill="#0c1116">${esc(w.answers[0])}</text>
<rect x="${nx + 110}" y="${ny + 96}" width="80" height="26" rx="7" fill="none" stroke="#5b6168"/><text x="${nx + 150}" y="${ny + 114}" text-anchor="middle" font-size="14" font-weight="600" fill="#e6e4dc">${esc(w.answers[1])}</text>
</g>
</g>
</svg>
`
}

// One tile per supported agent, the same in a light and a dark README: a white mark on the
// agent's own colour. The README shows it at 24 px, half its size, so its edges sit on whole
// units of 2: the tile fills the square, and a dark tile's rim is 2 units wide, one pixel, inside it.
const agentIcon = (icon: AgentIcon): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" role="img" aria-label="${esc(icon.name)}" font-family="'Inter', sans-serif">
<title>${esc(icon.name)}</title>
<rect width="48" height="48" rx="11" fill="${icon.tile}"/>${isDark(icon.tile) ? '<rect x="1" y="1" width="46" height="46" rx="10" fill="none" stroke="#fff" stroke-opacity="0.18" stroke-width="2"/>' : ''}
${glyph(icon, 0, 0, 48)}
</svg>
`

// The terminal board (`--watch`) as it runs beside a CLI agent, with that agent's question
// open: boardScreen's own lines, coloured as a terminal shows its ANSI codes, so the picture
// is the board the person gets, not a drawing of it. One per CLI, language and theme.
const CLI_AGENTS = ['codex', 'antigravity'] as const
type CliAgent = (typeof CLI_AGENTS)[number]
// boardScreen paints with the palette's own colours, 24-bit here (hooks/palette.ts), bold or not;
// each is drawn in the picture's palette by its role. A colour that is no role stops the render
// rather than drawing it plain.
type Grid = Parameters<typeof gridSvg>[0]
// A board's lines with the gap before each right-aligned age closed, to tell whether a narrower
// board cuts anything.
const shapeOf = (text: string): string => text.split('\n').map(line => line.replace(/ {3,}/g, '  ').trimEnd()).join('\n')
const ansiGrid =(text: string, palette: Palette, mode: Mode): Grid =>
  text.replace(/\n$/, '').split('\n').map(line => {
    const source = mode === 'light' ? LIGHT : DARK
    const cells: Grid[number] = []
    let style: Grid[number][number]['style'] = {}
    for (const part of line.split(/(\u001b\[[\d;]*m)/)) {
      const codes = /^\u001b\[([\d;]*)m$/.exec(part)?.[1]?.split(';')
      if (codes !== undefined) {
        const at = codes.indexOf('38')
        const hex = at < 0 ? null : `#${codes.slice(at + 2, at + 5).map(n => Number(n).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
        const role = hex === null ? undefined : (Object.keys(source) as Array<keyof Palette>).find(one => source[one].toUpperCase() === hex)
        if (hex !== null && (codes[at + 1] !== '2' || role === undefined)) throw new Error(`boardScreen paints with ${codes.join(';')}, which render.ts has no colour for`)
        style = { ...(codes[0] === '1' ? { bold: true } : {}), ...(role === undefined ? {} : { fg: palette[role] }) }
        continue
      }
      for (const ch of [...part]) cells.push(...(widthCells(ch) === 2 ? [{ ch, style }, { ch: '', style }] : [{ ch, style }]))
    }
    return cells
  })

const cliBoard = (lang: Lang, mode: Mode, agent: CliAgent): string => {
  const s = STRINGS[lang]
  const t = TERMINAL[mode]
  const mono = monoOf(lang)
  const file = CLI_FILES[lang]
  if (file === undefined) throw new Error(`there is no CLI sample for ${lang}`)
  // Every step the sample ticks was ticked this morning, so they are what "done today" counts.
  const view = buildView(parseProgress(file), [], null, NOW, (file.match(/^- \[x\] /gm) ?? []).length, {}, s)
  const items = boardItems(view, [], false, false)
  const at = items.findIndex(item => item.type === 'ask' && item.ask.agent === agent)
  if (at < 0) throw new Error(`the CLI sample for ${lang} has no question from ${agent}`)
  const key = items[at]?.key ?? null
  const state = { ...emptyBoardState, selected: at, key, open: key }
  // The window is as narrow as it can be while every line still shows whole: the board cuts an
  // indented line a little before the window's edge, so the widest line alone is not enough.
  // The ages sit at the right edge, so lines are compared with the gap before them closed.
  const whole = shapeOf(boardScreen(view, [], state, s, { width: 400, isColor: false }))
  let cols = Math.max(...whole.split('\n').map(widthCells))
  while (shapeOf(boardScreen(view, [], state, s, { width: cols, isColor: false })) !== whole) cols++
  const grid = ansiGrid(boardScreen(view, [], state, s, { width: cols, isColor: true, depth: 'truecolor', theme: mode }), t.palette, mode)
  const theme: Theme = { ground: t.ground, ink: t.ink, edge: t.edge, muted: t.palette.muted, accent: t.palette.accent, frame: t.palette.frame }
  const title = 'agent-board --watch'
  // Half a unit in from the edge, so the window's outline is not cut by the picture's own edge.
  const W = cols * CELL + PAD * 2 + 1
  const H = BAR + PAD + grid.length * LINE + PAD + 1
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" font-family="${sansOf(lang)}">
<title>${esc(title)}</title>
${terminal(mode, mono, title, gridSvg(grid, PAD, BAR + PAD, theme), grid.length, 0.5, 0.5, cols)}
</svg>
`
}

// The top of the pane as it first opens, for the top of the README: the same sample and
// drawPane as the tour, without the motion, in a light and a dark version so GitHub can show the
// one that matches its theme. It stops at the line that counts the other questions waiting, so
// the first screen of the README shows what needs you rather than the whole pane.
const pane = (lang: Lang, mode: Mode): string => {
  const whole = paneGrid(lang, mode, { opened: [], isAnswered: false })
  const more = keyBox(whole.grid, 'focus::more')
  if (more === null) throw new Error(`the ${lang} pane sample has no "more waiting" line to stop at`)
  const grid = whole.grid.slice(0, more.row + 1)
  const theme = whole.theme
  const title = WORDS[lang].window
  const W = windowWidth + 1
  const H = BAR + PAD + grid.length * LINE + PAD + 1
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" font-family="${sansOf(lang)}">
<title>${esc(title)}</title>
${terminal(mode, monoOf(lang), title, gridSvg(grid, PAD, BAR + PAD, theme), grid.length, 0.5, 0.5)}
</svg>
`
}

// The README's cover, a 29 s loop in six scenes, each named by a caption at the left: what Agent
// Board is (four agents come onto one board), steps ticking live, a question jumping to the top,
// answering it with one key, messaging an agent from the board (a preview of Send to Codex, #318,
// targeted for 0.24.2 in the release handover) and connecting every agent with one command. The screen is the terminal board
// (`--watch`) as boardScreen draws it at each moment (COVER and COVER_MARKS in samples.ts), each
// agent's tile on the window's edge beside its line. The page's reply box in scene 5 is drawn in
// the page's own words (serveSend, serveSending and messagesAcknowledged in hooks/strings-en.ts),
// since the terminal board has none. CSS keyframes only, so GitHub plays it in an <img>; with
// reduced motion only the last scene shows, and it alone says what the board is for.
const COVER_LOOP = 29
// Where each scene starts, in seconds; each ends where the next starts. Scene 5 has the most to
// follow, so it is the longest.
const COVER_SCENES = [0, 4.5, 9, 13.5, 18, 24]
// When each moment of COVER_MARKS reaches the board. Claude's task closes (moment 8) half a second
// before Codex's question comes (moment 9), so the question is the one change the eye sees.
const COVER_AT = [0, 0.8, 1.6, 2.4, 4.9, 6, 7, 8, 9.1, 9.8, 14.5, 15.6, 16.6, 22.6, 25.6]
// The moments the left column follows.
const MOMENT = { asks: 9, copied: 11, opened: 12 }
// The person's presses and the message's way to Codex: typed, sent, then Codex's reply. Each
// receipt stays long enough to read. The veil comes down at `veil`, before the loop turns.
const COVER_T = { up: 14.2, y: 15.3, type: 18.6, aim: 20.1, tap: 21.2, send: 21.4, arrive: 21.8, replied: 22.6, veil: 28.5 }
const FADE = 0.3
// A terminal redraws at once, so the board's lines and the tiles beside them change in a blink
// rather than fading through each other.
const REDRAW = 0.08
// How long the pointer takes to reach the Send button.
const POINT_IN = 0.9
// Where the cursor is at each moment: on an agent's line or on the question at the top, whether
// that line is open, and whether y has just copied its answer.
type CoverCursor = { on: CoverAgent | 'ask'; isOpen?: boolean; isCopied?: boolean }
const COVER_CURSOR: CoverCursor[] = [
  { on: 'claude' }, { on: 'claude' }, { on: 'claude' }, { on: 'claude' },
  { on: 'claude', isOpen: true }, { on: 'claude', isOpen: true }, { on: 'claude', isOpen: true }, { on: 'claude', isOpen: true },
  { on: 'claude' }, { on: 'claude' }, { on: 'ask' }, { on: 'ask', isCopied: true },
  { on: 'codex' }, { on: 'codex' }, { on: 'ask', isOpen: true },
]
// The left column, the gap the tiles sit in, and the margin round the picture.
const COVER_LEFT = 40
const COVER_COL = 362
const COVER_GAP = 24
const COVER_EDGE = 24
const TILE = 24
// The look round the window: the README's brand ground (the tour's and the promotional card's)
// for a dark README, and the same in paper tones for a light one. Both use the brand's teal, the
// light one a deeper shade so text in it still reads on paper; the board inside keeps its own
// palette.
const COVER_LOOK: Record<Mode, { sky: [string, string, string]; dot: string; dots: number; glow: number; ink: string; muted: string; accent: string; card: string; line: string; shadow: string; depth: number }> = {
  dark: { sky: ['#0f1a24', '#0c1116', '#090b0d'], dot: '#ffffff', dots: 0.05, glow: 0.2, ink: BRAND.ink, muted: BRAND.muted, accent: DARK.accent, card: BRAND.card, line: BRAND.line, shadow: '#000000', depth: 0.55 },
  light: { sky: ['#fdfcf8', '#f6f5f0', '#eceee8'], dot: '#1f2324', dots: 0.06, glow: 0.12, ink: '#1f2324', muted: LIGHT.muted, accent: '#00757e', card: '#ffffff', line: '#e3e4de', shadow: '#1f2324', depth: 0.16 },
}
type CoverScene = { caption: [string, string]; sub: string[] }
// Each scene's caption (its second line in the accent colour) and the line under it. The chips say
// from which release a thing is there: scene 5 uses the release handover's approved preview
// target; delete it once Send to Codex has shipped. Scene 6's row is the
// agents the command sets up, not a claim that each was checked: the README says how each was.
const COVER_WORDS: Record<Lang, { label: string; scenes: CoverScene[]; legend: [string, string, string]; pick: string; works: string; soon: { send: string; npm: string } }> = {
  en: {
    label: 'Claude Code, Codex, Antigravity and OpenCode report to one board and their steps tick live; Codex asks whether to open its pull request and one key copies the answer; a message written on the board’s page reaches Codex and its reply shows, a preview coming in 0.24.2; one npx command connects every agent, on npm from 0.24.0',
    scenes: [
      { caption: ['Every agent,', 'one board.'], sub: ['Each one reports in by itself,', 'so you stop checking each window.'] },
      { caption: ['Watch steps', 'tick off live.'], sub: ['Each step shows up the moment', 'the agent finishes it.'] },
      { caption: ['Questions jump', 'to the top.'], sub: ['The agent that needs you comes first,', 'its question in plain words.'] },
      { caption: ['Answer with', 'one key.'], sub: ['Pick the question and press y:', 'the answer is copied for Codex.'] },
      { caption: ['Message agents', 'from the board.'], sub: ['Write to Codex from the board', 'in your browser, and see it reply.'] },
      { caption: ['One command,', 'every agent.'], sub: ['One board for every coding agent:', 'what waits on you comes first.'] },
    ],
    legend: ['done', 'doing', 'to do'],
    pick: 'Pick it',
    works: 'SET UP BY THE SAME COMMAND',
    soon: { send: 'Coming in 0.24.2', npm: 'On npm from 0.24.0' },
  },
  // Chinese headlines leave out the punctuation at the end of a line, as Chinese display type does.
  'zh-TW': {
    label: 'Claude Code、Codex、Antigravity、OpenCode 都回報到同一塊看板，每一步即時打勾；Codex 問能不能開 pull request，按一個鍵就複製好答案；在看板網頁寫給 Codex 的訊息，看得到它送達和回覆（0.24.2 起提供的預覽）；一行 npx 指令接上每個 agent（0.24.0 起上架 npm）',
    scenes: [
      { caption: ['每個 agent', '同一塊看板'], sub: ['每個 agent 都會自動回報，', '不用一個個視窗切過去。'] },
      { caption: ['每一步', '即時打勾'], sub: ['agent 做完一步，', '看板馬上就顯示。'] },
      { caption: ['等你回答的', '排在最上面'], sub: ['需要你的 agent 排第一，', '問題用白話寫清楚。'] },
      { caption: ['按一個鍵', '就能回答'], sub: ['選到問題，按 y：', '答案複製好了，貼給 Codex 就好。'] },
      { caption: ['從看板直接', '傳訊息給 agent'], sub: ['在看板網頁上寫訊息給 Codex，', '看著它送達、回覆。'] },
      { caption: ['一行指令', '接上每個 agent'], sub: ['所有 coding agent 共用一塊看板，', '等你回答的排第一。'] },
    ],
    legend: ['完成', '進行中', '待辦'],
    pick: '選它',
    works: '同一行指令就能設定',
    soon: { send: '0.24.2 起提供', npm: '0.24.0 起上架 npm' },
  },
  'zh-CN': {
    label: 'Claude Code、Codex、Antigravity、OpenCode 都汇报到同一块看板，每一步实时打勾；Codex 问能不能开 pull request，按一个键就复制好答案；在看板网页上给 Codex 发的消息，能看到它送达和回复（0.24.2 起提供的预览）；一行 npx 命令接上每个 agent（0.24.0 起上架 npm）',
    scenes: [
      { caption: ['每个 agent', '同一块看板'], sub: ['每个 agent 都会自动汇报，', '不用一个个窗口切过去。'] },
      { caption: ['每一步', '实时打勾'], sub: ['agent 做完一步，', '看板马上就显示。'] },
      { caption: ['等你回答的', '排在最上面'], sub: ['需要你的 agent 排第一，', '问题用大白话写清楚。'] },
      { caption: ['按一个键', '就能回答'], sub: ['选中问题，按 y：', '答案已经复制好，粘贴给 Codex 就行。'] },
      { caption: ['从看板直接', '发消息给 agent'], sub: ['在看板网页上给 Codex 发消息，', '看着它送达、回复。'] },
      { caption: ['一行命令', '接上每个 agent'], sub: ['所有 coding agent 共用一块看板，', '等你回答的排第一。'] },
    ],
    legend: ['完成', '进行中', '待办'],
    pick: '选中它',
    works: '同一行命令就能设置',
    soon: { send: '0.24.2 起提供', npm: '0.24.0 起上架 npm' },
  },
}
// The setup command scene 6 shows, and the agents it shows under it: the README's supported list.
const COVER_COMMAND = 'npx @wenyuchiou/agent-board setup --apply'
const COVER_WORKS = ['Claude Code', 'Codex', 'Antigravity', 'OpenCode', 'Cursor', 'Grok Build', 'Muse Code', 'Hermes Agent', 'OpenClaw', 'DeepSeek Harness']
const COVER_NAMES: Record<CoverAgent, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode' }
// The board's colours on the cover. In light, the board's own navy accent and olive waiting colour
// would sit beside the cover's teal as a second accent, so the cover gives the light board the
// brand's deep teal and a warmer amber; both read at about 5:1 on the board's ground.
const coverPalette = (mode: Mode): Palette => (mode === 'light' ? { ...TERMINAL.light.palette, accent: '#00757e', waiting: '#946200' } : TERMINAL[mode].palette)

// A rough width of a line at `size`, to fit a box round it: the fonts are not measured here.
const textW = (text: string, size: number): number => [...text].reduce((n, ch) => n + size * (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.55), 0)
const lineText = (row: Grid[number] | undefined): string => (row ?? []).map(cell => cell.ch).join('')
const rowKey = (row: Grid[number] | undefined): string =>
  (row ?? []).map(cell => `${cell.ch}|${cell.style.fg ?? ''}|${cell.style.bold === true ? 1 : 0}`).join('/')

// The board at moment `m`, as boardScreen prints it `cols` wide, in the terminal's colours, without
// its last line, the keys: that line grows with the selected line's keys and would be cut short,
// and the cover shows the keys that matter beside the window. It also leaves out two hints a
// stranger cannot place: the one under an open question to reply in the agent's own session
// (scene 4's words say the answer is copied for Codex, and "can't reply from here" would read as
// the opposite at a glance), and the one under a live session's line to archive it once it stops.
// And it names each agent once, as its tile does: the board today says "Codex is working · codex".
const coverBoard = (lang: Lang, mode: Mode, m: number, cols: number): Grid => {
  const s = STRINGS[lang]
  const c = COVER[lang] as CoverSample
  const file = coverFile(c, m)
  // Every step the sample ticks was ticked this morning, so they are what "done today" counts.
  const view = buildView(parseProgress(file), [], null, NOW, (file.match(/^- \[x\] /gm) ?? []).length, {}, s)
  const items = boardItems(view, [], false, false)
  const cursor = COVER_CURSOR[m]
  if (cursor === undefined) throw new Error(`The cover has no cursor for moment ${m}`)
  const at = items.findIndex(item => (cursor.on === 'ask' ? item.type === 'ask' : item.type === 'row' && item.row.project === c.tasks[cursor.on].project))
  const item = items[at]
  if (item === undefined) throw new Error(`The cover's moment ${m} has no line for the cursor (${cursor.on}), language ${lang}`)
  const label = item.type === 'ask' ? item.ask.task : item.type === 'row' ? item.row.title : ''
  const copied = cursor.isCopied === true ? { note: s.copied, tone: 'done' as const, result: { key: item.key, revision: null, label } } : {}
  const state: BoardState = { ...emptyBoardState, selected: at, key: item.key, open: cursor.isOpen === true ? item.key : null, ...copied }
  const lines = boardScreen(view, [], state, s, { width: cols, isColor: true, depth: 'truecolor', theme: mode }).replace(/\n$/, '').split('\n')
  if (lines.length < 3 || lines[lines.length - 2] !== '') throw new Error(`The cover's moment ${m} does not end with the board's key line, language ${lang}`)
  const plain = boardScreen(view, [], state, s, { width: cols, isColor: false }).replace(/\n$/, '').split('\n')
  // The hints as boardScreen prints them, so only those exact lines go.
  const hints = new Set(items.flatMap(one => (one.type === 'ask' && one.ask.where === 'other' ? [s.boardAnswerIn(agentLabel(one.ask.agent || 'claude', s))] : [])).map(hint => `    ${fit(hint, cols - 6)}`.trimEnd()))
  const isHint = (i: number): boolean => hints.has((plain[i] ?? '').trimEnd())
  const withNames = (line: string): string =>
    COVER_AGENTS.reduce((text, agent) => text.replace(`${s.agentWorking(agentLabel(agent, s))} · ${agent}`, s.agentWorking(COVER_NAMES[agent])).replace(` · ${agent} › `, ` · ${COVER_NAMES[agent]} › `), line)
  return ansiGrid(`${lines.slice(0, -2).filter((_, i) => !isHint(i)).map(withNames).join('\n')}\n`, coverPalette(mode), mode)
}

// The board's width on the cover for a theme: as wide as its widest line in any language, so the
// three covers keep one shape, and then wider until no moment prints a line cut short, since the
// board cuts a line a little inside the width it is given. Worked out once per theme.
const coverColsByMode = new Map<Mode, number>()
const coverCols = (mode: Mode): number => {
  const known = coverColsByMode.get(mode)
  if (known !== undefined) return known
  const whole = LANGS.flatMap(one => Array.from({ length: COVER_MOMENTS }, (_, m) => coverBoard(one, mode, m, 400).map(row => shapeOf(lineText(row)))))
  const isWhole = (n: number): boolean => LANGS.every((one, l) => Array.from({ length: COVER_MOMENTS }, (_, m) => m).every(m => coverBoard(one, mode, m, n).map(row => shapeOf(lineText(row))).join('\n') === (whole[l * COVER_MOMENTS + m] ?? []).join('\n')))
  let cols = Math.max(...whole.flatMap(rows => rows.map(widthCells)))
  while (!isWhole(cols)) {
    cols++
    if (cols > 200) throw new Error(`The cover's board still cuts a line at 200 columns, ${mode}`)
  }
  coverColsByMode.set(mode, cols)
  return cols
}

const cover = (lang: Lang, mode: Mode): string => {
  const s = STRINGS[lang]
  const c = COVER[lang] as CoverSample
  const w = COVER_WORDS[lang]
  const t = TERMINAL[mode]
  const look = COVER_LOOK[mode]
  const pal = coverPalette(mode)
  const mono = monoOf(lang)
  const T = COVER_T
  const isCjk = lang !== 'en'
  if (COVER_AT.length !== COVER_MOMENTS || COVER_CURSOR.length !== COVER_MOMENTS) throw new Error(`The cover has ${COVER_AT.length} times and ${COVER_CURSOR.length} cursors for ${COVER_MOMENTS} moments`)
  // A short list of marks would leave an agent off the board from that moment on, without a word.
  const short = COVER_AGENTS.find(agent => COVER_MARKS[agent].length !== COVER_MOMENTS)
  if (short !== undefined) throw new Error(`The cover has ${COVER_MARKS[short].length} marks for ${short} and ${COVER_MOMENTS} moments`)
  if (w.scenes.length !== COVER_SCENES.length) throw new Error(`The ${lang} cover has ${w.scenes.length} captions for ${COVER_SCENES.length} scenes`)
  const cols = coverCols(mode)
  const boards = Array.from({ length: COVER_MOMENTS }, (_, m) => coverBoard(lang, mode, m, cols))
  // At least 22 rows, so the left column keeps its room above the scene markers, under scene 5's
  // card and scene 6's logos, however short the longest board is.
  const rows = Math.max(22, ...boards.map(grid => grid.length))
  const winX = COVER_LEFT + COVER_COL + COVER_GAP
  const winY = COVER_EDGE
  const winW = cols * CELL + PAD * 2
  const W = Math.round(winX + winW + COVER_EDGE)
  const H = Math.round(winY + BAR + PAD + rows * LINE + PAD + COVER_EDGE)
  const p = (sec: number): string => `${((Math.max(0, Math.min(COVER_LOOP, sec)) / COVER_LOOP) * 100).toFixed(2)}%`
  const keyframes: string[] = []
  // Two stops at the same point (p(COVER_LOOP) is 100.00%, the same as 100%) let the later one win,
  // which once faded the last scene out over the whole loop; stops out of order go wrong the same way.
  const frames = (body: string): string => {
    const stops = [...body.matchAll(/(\d+(?:\.\d+)?)%(?=[^{}]*\{)/g)].map(stop => Number(stop[1]))
    if (!stops.every((stop, i) => i === 0 || stop > (stops[i - 1] ?? 0))) throw new Error(`The cover has a keyframe whose stops do not rise: ${body}`)
    const name = `c${keyframes.length}`
    keyframes.push(`@keyframes ${name} { ${body} }`)
    return name
  }
  const EASE = 'animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1)'
  // On from `start`, rising a little into place, until `end`, when it fades out; from 0 it is
  // already on, and to the loop's end it stays: the veil hides the turn, where 0% takes it off
  // again. `rise` is how far it rises.
  const STAY = '100% { opacity: 1 }'
  const span = (start: number, end: number, rise = 0): string => {
    const from = rise === 0 ? '' : `; transform: translateY(${rise}px)`
    const on = rise === 0 ? '' : '; transform: translateY(0)'
    const into = start <= 0 ? `0% { opacity: 1${on} }` : `0%, ${p(start)} { opacity: 0${from}; ${EASE} } ${p(start + 0.45)} { opacity: 1${on} }`
    const out = end >= COVER_LOOP ? STAY : `${p(end - FADE)} { opacity: 1 } ${p(end)}, 100% { opacity: 0 }`
    return frames(`${into} ${out}`)
  }
  const lastClass = (end: number): string => (end >= COVER_LOOP ? ' last' : '')
  // A brief glow, on and off.
  const glow = (start: number, length: number, peak: number): string =>
    frames(`0%, ${p(start)} { opacity: 0 } ${p(start + 0.12)} { opacity: ${peak} } ${p(start + length)}, 100% { opacity: 0 }`)
  // A surface's moments: the first drawn plainly, and each later one laid over it from its time,
  // as the rows that differ from the first plus every row the one before drew, so nothing shows
  // through when that one goes. Each row brings its own ground.
  type Moment = { at: number; rows: Array<{ key: string; svg: string }> }
  const layered = (moments: Moment[], ground: (i: number) => string): string => {
    const base = moments[0]?.rows ?? []
    const drawn = new Set<number>()
    return [
      base.map(row => row.svg).join(''),
      ...moments.slice(1).map((moment, k) => {
        moment.rows.forEach((row, i) => {
          if (row.key !== base[i]?.key) drawn.add(i)
        })
        const next = moments[k + 2]
        const end = next === undefined ? null : next.at + REDRAW
        const name = frames(`0%, ${p(moment.at)} { opacity: 0 } ${p(moment.at + REDRAW)} { opacity: 1 } ${end === null ? STAY : `${p(end)} { opacity: 1 } ${p(end + 0.02)}, 100% { opacity: 0 }`}`)
        const lines = [...drawn].sort((a, b) => a - b).map(i => `${ground(i)}${moment.rows[i]?.svg ?? ''}`).join('')
        return `<g class="a ${name}${end === null ? ' last' : ''}">${lines}</g>`
      }),
    ].join('\n')
  }

  // The window: the board at each moment, a row at a time.
  const theme: Theme = { ground: t.ground, ink: t.ink, edge: t.edge, muted: pal.muted, accent: pal.accent, frame: pal.frame }
  const rowY = (i: number): number => BAR + PAD + i * LINE
  const boardSvg = layered(
    boards.map((grid, m) => ({ at: COVER_AT[m] ?? 0, rows: Array.from({ length: rows }, (_, i) => ({ key: rowKey(grid[i]), svg: grid[i] === undefined ? '' : gridSvg([grid[i] as Grid[number]], PAD, rowY(i), theme) })) })),
    i => `<rect x="1" y="${rowY(i)}" width="${num(winW - 2)}" height="${LINE}" fill="${t.ground}"/>`,
  )
  // A soft band over the lines a moment brings that the one before did not show, as they land; in
  // the waiting colour when a question comes.
  // A line's words without the cursor's mark, so a line that only gains or loses the cursor does
  // not glow as new: when Antigravity asks, the line the cursor leaves would light up as well.
  const calm = (row: Grid[number] | undefined): string => lineText(row).replace(/^(\s*)›/, '$1 ').trimEnd()
  const bands = boards.slice(1).map((grid, k) => {
    const m = k + 1
    const before = new Set(boards[k]?.map(calm) ?? [])
    const isAsking = COVER_AGENTS.some(agent => (COVER_MARKS[agent][m] ?? '').includes('?') && !(COVER_MARKS[agent][m - 1] ?? '').includes('?'))
    const fresh = grid.map((row, i) => i > 0 && lineText(row).trim() !== '' && !before.has(calm(row)))
    const runs: Array<[number, number]> = []
    fresh.forEach((isFresh, i) => {
      if (!isFresh) return
      const last = runs[runs.length - 1]
      if (last !== undefined && last[1] === i - 1) last[1] = i
      else runs.push([i, i])
    })
    return runs.map(([a, b]) => `<rect class="a ${glow(COVER_AT[m] ?? 0, 0.8, isAsking ? (mode === 'dark' ? 0.12 : 0.2) : 0.15)}" x="1" y="${rowY(a) - 1}" width="${num(winW - 2)}" height="${(b - a + 1) * LINE + 2}" fill="${isAsking ? pal.waiting : pal.accent}"/>`).join('')
  }).join('')
  // Scene 5: Codex's line lights up when the person's message reaches it, and again when it replies.
  // A title line ends where the gap before its agent and age starts.
  const codexAt = boards[MOMENT.opened]?.findIndex(row => lineText(row).replace(/^[›\s]+/, '').replace(/ {2,}.*$/, '').trimEnd() === c.tasks.codex.title) ?? -1
  if (codexAt < 0) throw new Error(`Codex has no line on the board when the message is sent, language ${lang}`)
  const reached = [[T.arrive, pal.accent], [T.replied, pal.done]].map(([at, colour]) => `<rect class="a ${glow(at as number, 1, 0.22)}" x="1" y="${rowY(codexAt) - 1}" width="${num(winW - 2)}" height="${2 * LINE + 2}" fill="${colour}"/>`).join('')
  // The shadow is cast by a still rect the window's size under it, not by the window, so a change
  // on the board does not make the viewer work the shadow out again.
  const winH = BAR + PAD + rows * LINE + PAD
  const windowSvg = `<rect x="${winX}" y="${winY}" width="${num(winW)}" height="${winH}" rx="12" fill="${t.ground}" filter="url(#lift)"/>${terminal(mode, mono, 'agent-board --watch', `<g clip-path="url(#board)">${boardSvg}${bands}${reached}</g>`, rows, winX, winY, cols)}`

  // Each agent's tile on the window's left edge, beside its line, and the asking agent's beside
  // its question too. A tile stays while its line does, and moves with it.
  const tileY = (line: number): number => winY + rowY(line) + 9.5 - TILE / 2
  type Slot = { key: string; name: string; line: number }
  const slots = boards.map((grid, m) => COVER_AGENTS.flatMap((agent): Slot[] => {
    const marks = COVER_MARKS[agent][m]
    if (marks === null || marks === undefined) return []
    const task = c.tasks[agent]
    const own = grid.findIndex(row => lineText(row).replace(/^[›\s]+/, '').trimEnd() === task.title)
    const asking = marks.includes('?') ? grid.findIndex(row => lineText(row).trimEnd() === `● ${s.sectionWaiting}`) + 1 : -1
    return [
      ...(own > 0 ? [{ key: `${agent}:row`, name: COVER_NAMES[agent], line: own }] : []),
      ...(asking > 0 ? [{ key: `${agent}:ask`, name: COVER_NAMES[agent], line: asking }] : []),
    ]
  }))
  type Segment = { name: string; line: number; from: number; to: number }
  const segments: Segment[] = []
  const open = new Map<string, Segment>()
  slots.forEach((list, m) => {
    const at = COVER_AT[m] ?? 0
    for (const [key, segment] of open) {
      if (list.some(slot => slot.key === key && slot.line === segment.line)) continue
      segment.to = at
      open.delete(key)
    }
    for (const slot of list) {
      if (open.has(slot.key)) continue
      const segment = { name: slot.name, line: slot.line, from: at, to: COVER_LOOP }
      segments.push(segment)
      open.set(slot.key, segment)
    }
  })
  const tiles = segments.map(one => {
    const tile = iconTile(one.name, winX - TILE / 2, Math.round(tileY(one.line) * 100) / 100, TILE)
    if (one.from <= 0 && one.to >= COVER_LOOP) return tile
    const on = one.from <= 0 ? '0% { opacity: 1 }' : `0%, ${p(one.from)} { opacity: 0 } ${p(one.from + REDRAW)} { opacity: 1 }`
    const off = one.to >= COVER_LOOP ? STAY : `${p(one.to)} { opacity: 1 } ${p(one.to + REDRAW)}, 100% { opacity: 0 }`
    return `<g class="a ${frames(`${on} ${off}`)}${lastClass(one.to)}">${tile}</g>`
  }).join('\n')

  // The left column: the board's mark, then each scene's caption, the line under it, and what the
  // scene shows beside the board.
  const mark = `<g transform="translate(${COVER_LEFT} 34)"><rect width="30" height="30" rx="8" fill="${BRAND.accent}"/><rect x="7" y="8" width="16" height="3.1" rx="1.55" fill="#0c1116"/><rect x="7" y="13.7" width="10.6" height="3.1" rx="1.55" fill="#0c1116"/><circle cx="20.3" cy="19.4" r="3.2" fill="${DARK.waiting}"/></g><text x="${COVER_LEFT + 42}" y="56" font-size="22" font-weight="700" fill="${look.ink}">Agent Board</text>`
  const capY = 150
  const capSize = isCjk ? 40 : 42
  const subY = capY + 54 + 46
  const subSize = isCjk ? 18 : 17
  const propY = (k: number): number => subY + ((w.scenes[k]?.sub.length ?? 0) - 1) * 26 + 34
  const ends = COVER_SCENES.map((_, k) => COVER_SCENES[k + 1] ?? COVER_LOOP)
  const chip = (x: number, y: number, text: string): string => {
    const cw = 30 + [...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 12 : 7), 0)
    // In light, the amber is too pale for 12 px words on its own tint; a darker one reads at 6:1.
    const ink = mode === 'light' ? '#7a5100' : pal.waiting
    return `<rect x="${x}" y="${y}" width="${cw}" height="22" rx="11" fill="${pal.waiting}" fill-opacity="0.1" stroke="${pal.waiting}" stroke-opacity="0.55"/><circle cx="${x + 12}" cy="${y + 11}" r="3" fill="${pal.waiting}"/><text x="${x + 21}" y="${y + 15.5}" font-size="12" font-weight="600" fill="${ink}">${esc(text)}</text>`
  }
  const captions = w.scenes.map((scene, k) => {
    const start = COVER_SCENES[k] ?? 0
    const end = ends[k] ?? COVER_LOOP
    const lines = scene.caption.map((line, i) => `<tspan x="${COVER_LEFT}" y="${capY + i * 54}"${i === 1 ? ` fill="${look.accent}"` : ''}>${esc(line)}</tspan>`).join('')
    const sub = scene.sub.map((line, i) => `<text x="${COVER_LEFT}" y="${subY + i * 26}" font-size="${subSize}" fill="${look.muted}">${esc(line)}</text>`).join('')
    return `<g class="a ${span(start, end, 14)}${lastClass(end)}"><text font-size="${capSize}" font-weight="800" ${HEADLINE} fill="${look.ink}">${lines}</text></g>
<g class="a ${span(start + 0.15, end, 10)}${lastClass(end)}">${sub}</g>`
  }).join('\n')

  // Scene 1: the agents themselves, each named, as each one reaches the board, so "every agent"
  // still reads where the board's own lines are too small to.
  const crew = COVER_AGENTS.map((agent, k) => {
    const x = COVER_LEFT + (k % 2) * 180
    const y = propY(0) + Math.floor(k / 2) * 52
    return `<g class="a ${span(COVER_AT[k] ?? 0, ends[0] ?? 0, 8)}">${iconTile(COVER_NAMES[agent], x, y, 36)}<text x="${x + 48}" y="${y + 24}" font-size="16" font-weight="600" fill="${look.ink}">${esc(COVER_NAMES[agent])}</text></g>`
  }).join('\n')

  // Scene 2: what the board's marks mean. The ▸ glyph is small in every font, so it is drawn larger
  // to sit level with the other two.
  const legend = (() => {
    const y = propY(1) + 20
    const signs: Array<[string, string, number]> = [['✓', pal.done, 17], ['▸', pal.accent, 25], ['○', pal.muted, 17]]
    return `<g class="a ${span((COVER_SCENES[1] ?? 0) + 0.4, ends[1] ?? 0)}" font-size="17">${signs.map(([sign, colour, size], i) => `<text x="${COVER_LEFT + i * 116}" y="${y}"><tspan font-family="${mono}" font-weight="700" font-size="${size}" dy="${size > 17 ? 2 : 0}" fill="${colour}">${sign}</tspan><tspan dx="8" dy="${size > 17 ? -2 : 0}" fill="${look.ink}">${esc(w.legend[i] ?? '')}</tspan></text>`).join('')}</g>`
  })()

  // Scene 3: the question as it comes, larger, in a card like the promotional card's note.
  const ask = (() => {
    const y = propY(2)
    const question = c.tasks.codex.asks?.[2] ?? ''
    const cw = COVER_COL - 2
    return `<g class="a ${span(COVER_AT[MOMENT.asks] ?? 0, ends[2] ?? 0, 10)}"><rect x="${COVER_LEFT}" y="${y}" width="${cw}" height="92" rx="14" fill="${look.card}" stroke="${pal.waiting}" stroke-opacity="0.85" stroke-width="1.6" filter="url(#soft)"/>
${iconTile('Codex', COVER_LEFT + 16, y + 16, 30)}
<text x="${COVER_LEFT + 58}" y="${y + 30}" font-size="16" font-weight="700" fill="${look.ink}">Codex</text>
<text x="${COVER_LEFT + 58}" y="${y + 48}" font-size="13" fill="${pal.waiting}">● ${esc(c.tasks.codex.project)} · ${esc(s.sectionWaiting)}</text>
<text x="${COVER_LEFT + 16}" y="${y + 76}" font-size="17" font-weight="600" fill="${look.ink}">${esc(question)}</text></g>`
  })()

  // Scene 4: the two keys, each pressed in turn, and what the second did. Under y, the board's own
  // words for that answer, so the keycap and the board's line read the same.
  const keys = (() => {
    const y = propY(3)
    const key = (x: number, label: string, at: number, words: string): string => {
      const press = frames(`0%, ${p(at)} { transform: translateY(0) } ${p(at + 0.08)} { transform: translateY(3px) } ${p(at + 0.3)}, 100% { transform: translateY(0) }`)
      return `<g class="k ${press}"><rect x="${x}" y="${y + 4}" width="54" height="54" rx="10" fill="${look.line}"/><rect x="${x}" y="${y}" width="54" height="54" rx="10" fill="${look.card}" stroke="${look.line}" stroke-width="1.5"/><text x="${x + 27}" y="${y + 36}" text-anchor="middle" font-family="${mono}" font-size="24" font-weight="700" fill="${look.ink}">${esc(label)}</text></g>
<rect class="a ${glow(at, 0.6, 0.35)}" x="${x}" y="${y}" width="54" height="54" rx="10" fill="none" stroke="${pal.accent}" stroke-width="2.5"/>
<text x="${x + 27}" y="${y + 82}" text-anchor="middle" font-size="14" fill="${look.muted}">${esc(words)}</text>`
    }
    const copied = `<g class="a ${span(COVER_AT[MOMENT.copied] ?? 0, ends[3] ?? 0)}"><text x="${COVER_LEFT}" y="${y + 122}" font-size="17" font-weight="600" fill="${pal.done}">✓ ${esc(s.copied)}</text></g>`
    return `<g class="a ${span((COVER_SCENES[3] ?? 0) + 0.2, ends[3] ?? 0)}">${key(COVER_LEFT, '↑', T.up, w.pick)}${key(COVER_LEFT + 150, 'y', T.y, s.yesAnswer)}</g>${copied}`
  })()

  // Scene 5: Codex's card on the board's page, with its reply box and Send button. The person's
  // words are typed in, sent (the box empties, as the page's does), and the receipt line reads
  // Sending, then Replied: the page's steps between those pass too fast to read at this pace.
  const sendStart = COVER_SCENES[4] ?? 0
  const sendEnd = ends[4] ?? 0
  const cardY = propY(4) + 30
  const cardH = 156
  const boxX = COVER_LEFT + 16
  const boxY = cardY + 74
  const BOX_H = 46
  const sendLabel = s.serveSend('Codex')
  const sendW = Math.round(textW(sendLabel, 13.5) + 26)
  const boxW = COVER_COL - 2 - 32 - sendW - 8
  const sendX = boxX + boxW + 8
  const sendH = 34
  const sendY = boxY + (BOX_H - sendH) / 2
  const receiptY = boxY + BOX_H + 26
  const composer = `<rect x="${COVER_LEFT}" y="${cardY}" width="${COVER_COL - 2}" height="${cardH}" rx="14" fill="${look.card}" stroke="${look.line}" filter="url(#soft)"/>
${iconTile('Codex', COVER_LEFT + 16, cardY + 14, 28)}
<text x="${COVER_LEFT + 54}" y="${cardY + 33}" font-size="16" font-weight="700" fill="${look.ink}">Codex</text>
<text x="${COVER_LEFT + 16}" y="${cardY + 60}" font-size="13.5"><tspan font-weight="600" fill="${pal.project}">${esc(c.tasks.codex.project)}</tspan><tspan fill="${look.muted}"> › ${esc(c.tasks.codex.title)}</tspan></text>
<rect x="${boxX}" y="${boxY}" width="${boxW}" height="${BOX_H}" rx="8" fill="${t.ground}" stroke="${pal.frame}" stroke-opacity="0.6"/>
<text x="${boxX + 10}" y="${boxY + 21}" font-size="13" fill="${pal.muted}">${esc(s.serveMessagePlaceholder('Codex'))}</text>
<rect x="${num(sendX)}" y="${sendY}" width="${sendW}" height="${sendH}" rx="8" fill="${look.accent}"/>
<text x="${num(sendX + sendW / 2)}" y="${sendY + 22}" text-anchor="middle" font-size="13.5" font-weight="600" fill="${t.ground}">${esc(sendLabel)}</text>`
  // Typed a line at a time, each uncovered from the left a letter at a time by a rect in the box's
  // colour that shrinks to its right edge; the group covers the placeholder while it shows.
  let typedAt = T.type
  const typedLines = c.message.map((line, j) => {
    const letters = [...line].length
    const start = typedAt
    const length = Math.max(0.6, letters * 0.035)
    typedAt += length
    const x = boxX + 10
    const y = boxY + 20 + j * 18
    const mask = frames(`0%, ${p(start)} { opacity: 1; transform: scaleX(1); animation-timing-function: steps(${letters}, end) } ${p(start + length)}, 100% { opacity: 1; transform: scaleX(0) }`)
    return `<text x="${x}" y="${y}" font-size="13" fill="${t.ink}">${esc(line)}</text><rect class="a m ${mask}" x="${x - 2}" y="${y - 14}" width="${num(textW(line, 13) + 6)}" height="18" fill="${t.ground}"/>`
  })
  const typed = `<g class="a ${frames(`0%, ${p(T.type)} { opacity: 0 } ${p(T.type + 0.05)} { opacity: 1 } ${p(T.send)} { opacity: 1 } ${p(T.send + 0.05)}, 100% { opacity: 0 }`)}"><rect x="${boxX + 1}" y="${boxY + 1}" width="${boxW - 2}" height="${BOX_H - 2}" rx="7" fill="${t.ground}"/>${typedLines.join('')}</g>`
  const tapped = `<rect class="a ${glow(T.tap, 0.5, 0.35)}" x="${num(sendX)}" y="${sendY}" width="${sendW}" height="${sendH}" rx="8" fill="#ffffff"/>`
  const receipt = (text: string, colour: string): string => `<text x="${boxX}" y="${receiptY}" font-size="15" font-weight="600" fill="${colour}">${esc(text)}</text>`
  // Inside the card's rounded corners, so covering one receipt with the next never clips the card.
  const receiptGround = `<rect x="${boxX - 2}" y="${receiptY - 18}" width="${COVER_COL - 2 - 28}" height="24" fill="${look.card}"/>`
  const receipts = [
    [T.send, T.replied, receipt(s.serveSending('Codex'), look.accent)],
    [T.replied, sendEnd, receipt(`✓ ${s.messagesAcknowledged}`, pal.done)],
  ].map(([from, to, svg]) => `<g class="a ${frames(`0%, ${p(from as number)} { opacity: 0 } ${p((from as number) + 0.1)} { opacity: 1 } ${p(to as number)} { opacity: 1 } ${p((to as number) + 0.02)}, 100% { opacity: 0 }`)}">${receiptGround}${svg}</g>`).join('')
  // The pointer: in from below onto the Send button, a press, and away once it has gone through.
  const pointer = (() => {
    const tipX = sendX + sendW / 2
    const tipY = sendY + sendH * 0.62
    const at = (x: number, y: number, k = 1): string => `transform: translate(${num(x)}px, ${num(y)}px) scale(${k})`
    const move = 'animation-timing-function: cubic-bezier(0.3, 0.7, 0.2, 1)'
    const name = frames(`0%, ${p(T.aim)} { opacity: 0; ${at(tipX + 90, tipY + 110)}; ${move} } ${p(T.aim + 0.2)} { opacity: 1 } ${p(T.aim + POINT_IN)} { ${at(tipX, tipY)} } ${p(T.tap)} { ${at(tipX, tipY)} } ${p(T.tap + 0.1)} { ${at(tipX, tipY, 0.86)} } ${p(T.tap + 0.25)} { ${at(tipX, tipY)} } ${p(T.send + 0.5)} { opacity: 1 } ${p(T.send + 0.8)}, 100% { opacity: 0; ${at(tipX, tipY)} }`)
    const [fill, line] = mode === 'light' ? ['#1b1b1b', '#ffffff'] : ['#ffffff', '#1b1b1b']
    return `<g class="a ${name}"><path d="M0 0V18.5L4.6 14.2L7.7 21.2L10.9 19.8L7.9 13H14Z" fill="${fill}" stroke="${line}" stroke-width="1.3" stroke-linejoin="round"/></g>`
  })()
  const send = `<g class="a ${span(sendStart + 0.2, sendEnd, 12)}">${composer}
${typed}${tapped}
${receipts}</g>
${pointer}`
  // The preview marks: sending between sessions in scene 5, the npm package in scene 6.
  const sendChip = `<g class="a ${span(sendStart + 0.3, sendEnd)}">${chip(COVER_LEFT, propY(4) - 8, w.soon.send)}</g>`

  // Scene 6: the command, large enough to read and copy, broken where a terminal would wrap it,
  // the npm mark, and the agents it works with.
  const setup = (() => {
    const y = propY(5)
    const end = COVER_LOOP
    const size = 16
    const boxW = COVER_COL - 2
    const boxH = 76
    // The ten agents in one row across the column, so they end well above the scene markers.
    const tileSize = 28
    const tileGap = (COVER_COL - 2 - COVER_WORKS.length * tileSize) / (COVER_WORKS.length - 1)
    const tilesY = y + boxH + 52
    const [program, ...rest] = COVER_COMMAND.split(' setup')
    const works = COVER_WORKS.map((name, i) => iconTile(name, Math.round(COVER_LEFT + i * (tileSize + tileGap)), tilesY + 24, tileSize)).join('')
    return `<g class="a ${span((COVER_SCENES[5] ?? 0) + 0.25, end, 10)} last"><rect x="${COVER_LEFT}" y="${y}" width="${boxW}" height="${boxH}" rx="12" fill="${look.card}" stroke="${look.accent}" stroke-width="1.6"/>
<text font-family="${mono}" font-size="${size}" fill="${look.ink}"><tspan x="${COVER_LEFT + 18}" y="${y + 32}"><tspan fill="${look.muted}">$ </tspan>${esc(program ?? '')}</tspan><tspan x="${COVER_LEFT + 18 + 2 * size * 0.6}" y="${y + 56}">setup${esc(rest.join(' setup'))}</tspan></text>
${chip(COVER_LEFT, y + boxH + 12, w.soon.npm)}</g>
<g class="a ${span((COVER_SCENES[5] ?? 0) + 0.6, end)} last"><text x="${COVER_LEFT}" y="${tilesY + 12}" font-size="12" font-weight="700" letter-spacing="${isCjk ? 2 : 2.2}" fill="${look.muted}">${esc(w.works)}</text>${works}</g>`
  })()

  // The scene markers along the bottom of the left column: one lights for each scene. Reduced
  // motion hides them, since the still is not one of six.
  const pipY = H - COVER_EDGE - 10
  const pips = `<g class="pips">${COVER_SCENES.map((_, k) => `<rect x="${COVER_LEFT + k * 34}" y="${pipY}" width="26" height="5" rx="2.5" fill="${look.muted}" fill-opacity="0.5"/>`).join('')}${COVER_SCENES.map((start, k) => `<rect class="a ${span(start, ends[k] ?? COVER_LOOP)}" x="${COVER_LEFT + k * 34}" y="${pipY}" width="26" height="5" rx="2.5" fill="${look.accent}"/>`).join('')}</g>`

  // At the loop's turn the picture goes through its own ground, so the last scene's words and the
  // first's never show mixed: the veil comes down, the frames change behind it, and it lifts.
  const veil = `<rect class="a ${frames(`0% { opacity: 1 } ${p(0.4)}, ${p(T.veil)} { opacity: 0 } 100% { opacity: 1 }`)}" width="${W}" height="${H}" rx="18" fill="${look.sky[1]}"/>`
  const label = w.label

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" font-family="${sansOf(lang)}">
<title>Agent Board: ${esc(label)}</title>
<defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${look.sky[0]}"/><stop offset="0.55" stop-color="${look.sky[1]}"/><stop offset="1" stop-color="${look.sky[2]}"/></linearGradient>
<radialGradient id="glow" cx="0.72" cy="0.3" r="0.6"><stop offset="0" stop-color="${look.accent}" stop-opacity="${look.glow}"/><stop offset="1" stop-color="${look.accent}" stop-opacity="0"/></radialGradient>
<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="${look.dot}" fill-opacity="${look.dots}"/></pattern>
<clipPath id="edge"><rect width="${W}" height="${H}" rx="18"/></clipPath>
<clipPath id="board"><rect x="1" y="${BAR + 1}" width="${num(winW - 2)}" height="${PAD + rows * LINE + PAD - 13}"/></clipPath>
<filter id="lift" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="${look.shadow}" flood-opacity="${look.depth}"/></filter>
<filter id="soft" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="${look.shadow}" flood-opacity="${look.depth * 0.7}"/></filter></defs>
<style>
.a, .k { animation-duration: ${COVER_LOOP}s; animation-iteration-count: infinite; animation-timing-function: linear; }
.a { opacity: 0; }
/* A viewer that does not play CSS animation shows the last scene still; a playing one follows its keyframes. */
.a.last { opacity: 1; }
.m { transform-box: fill-box; transform-origin: 100% 50%; }
${keyframes.join('\n')}
${keyframes.map((_, i) => `.c${i} { animation-name: c${i} }`).join('\n')}
@media (prefers-reduced-motion: reduce) {
  .a { animation: none; opacity: 0; }
  .k { animation: none; }
  .pips { display: none; }
  .last { opacity: 1; }
}
</style>
<g clip-path="url(#edge)">
<rect width="${W}" height="${H}" fill="url(#sky)"/><rect width="${W}" height="${H}" fill="url(#glow)"/><rect width="${W}" height="${H}" fill="url(#dots)"/>
${mark}
${captions}
${crew}
${legend}
${ask}
${keys}
${sendChip}
${send}
${setup}
${pips}
${windowSvg}
${tiles}
${veil}
</g>
</svg>
`
}

// fonts.py, run at the end, needs Python with fontTools 4.60 or newer and brotli; it is found
// before anything is written, so without it the images stay as they were. Another fontTools
// version cuts the fonts into slightly different bytes, so every image would show as changed.
// A name that is not installed throws rather than failing, and Windows may answer `python3`
// with a stub, so each is tried with what fonts.py needs.
const FONT_TOOLS = "import fontTools, brotli; assert tuple(int(n) for n in fontTools.version.split('.')[:2]) >= (4, 60)"
const hasFontTools = (name: string): boolean => {
  try {
    return Bun.spawnSync([name, '-c', FONT_TOOLS]).exitCode === 0
  } catch {
    return false
  }
}
const named = process.env.PYTHON
if (named !== undefined && !hasFontTools(named)) throw new Error(`PYTHON is ${named}, which has no fontTools 4.60 or newer with brotli: pip install "fonttools>=4.60" brotli`)
const python = named ?? ['python3', 'python'].find(hasFontTools)
if (python === undefined) throw new Error('docs/preview/fonts.py needs Python 3 with fontTools 4.60 or newer: pip install "fonttools>=4.60" brotli (or set PYTHON)')

// The README's Integrations strip: one chip per agent, its tile and its name in one picture.
// GitHub breaks a line between an image and the text beside it, so a tile and a name set side
// by side part at the end of a line. The chips take the cover's dark card and ink; the names
// are product names, so one set serves every README. Every chip has the same height and
// padding: its width is its name's width in Inter, which fonts.py measures for all of them at once.
const CHIP = { height: 28, pad: 4, tile: 20, gap: 8, end: 10, size: 14, weight: 600 }
const chipWidths = new Map<string, number>()
const nameWidth = (name: string): number => {
  if (chipWidths.size === 0) {
    const names = AGENT_ICONS.map(icon => icon.name)
    const run = Bun.spawnSync([python, join(import.meta.dir, 'fonts.py'), '--width', String(CHIP.weight), String(CHIP.size), ...names], { stderr: 'inherit' })
    if (run.exitCode !== 0) throw new Error(`fonts.py --width stopped with exit code ${run.exitCode}`)
    const widths = JSON.parse(run.stdout.toString()) as number[]
    names.forEach((one, i) => chipWidths.set(one, widths[i] ?? 0))
  }
  const width = chipWidths.get(name)
  if (width === undefined || width <= 0) throw new Error(`fonts.py measured no width for "${name}"`)
  return width
}
const chip = (icon: AgentIcon): string => {
  const { height, pad, tile, gap, end, size, weight } = CHIP
  const left = pad + tile + gap
  const width = Math.ceil(left + nameWidth(icon.name) + end)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(icon.name)}" font-family="'Inter', sans-serif">
<title>${esc(icon.name)}</title>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${num(tile * 0.23 + pad - 0.5)}" fill="${BRAND.card}" stroke="${BRAND.line}"/>
${iconTile(icon.name, pad, pad, tile)}
<text x="${left}" y="${num(height / 2 + size * 0.36)}" font-size="${size}" font-weight="${weight}" fill="${BRAND.ink}">${esc(icon.name)}</text>
</svg>
`
}

// `bun docs/preview/render.ts cover-en` writes only the files whose names start with `cover-en`,
// and gives only those their fonts: to try one picture out without redrawing the others.
const only = process.argv[2]
const written: string[] = []
const write = (path: string, make: () => string): void => {
  if (only !== undefined && !basename(path).startsWith(only)) return
  writeFileSync(path, make())
  if (path.endsWith('.svg')) written.push(path)
}

mkdirSync(join(OUT, 'agents'), { recursive: true })
for (const icon of AGENT_ICONS) write(join(OUT, 'agents', `${icon.file}.svg`), () => agentIcon(icon))
for (const icon of AGENT_ICONS) write(join(OUT, 'agents', `chip-${icon.file}.svg`), () => chip(icon))
for (const lang of LANGS) write(join(OUT, `promo-${lang}.svg`), () => promo(lang))

mkdirSync(join(OUT, 'brand'), { recursive: true })
for (const mode of ['light', 'dark'] as const) write(join(OUT, 'brand', `agent-board-lockup-${mode}.svg`), () => brandLockup(mode))
write(join(OUT, 'brand', 'agent-board-logo.svg'), brandLogo)
write(join(OUT, 'brand', 'agent-board-mark.svg'), brandMarkFile)

mkdirSync(join(OUT, 'board'), { recursive: true })
for (const lang of LANGS) {
  for (const agent of CLI_AGENTS) for (const mode of ['light', 'dark'] as const) write(join(OUT, 'board', `${agent}-${lang}-${mode}.svg`), () => cliBoard(lang, mode, agent))
  for (const mode of ['light', 'dark'] as const) write(join(OUT, `pane-${lang}-${mode}.svg`), () => pane(lang, mode))
  for (const mode of ['light', 'dark'] as const) write(join(OUT, `cover-${lang}-${mode}.svg`), () => cover(lang, mode))
  write(join(OUT, `tour-${lang}.svg`), () => tour(lang))
  write(join(OUT, `flow-${lang}.svg`), () => flow(lang))
  write(join(PAGES, `dashboard-${lang}.html`), () => dashboard(lang))
}

// Each SVG then gets the letters it draws from its fonts (fonts.py, which needs fontTools).
const svgs = only !== undefined ? written : [
  ...readdirSync(OUT).filter(name => name.endsWith('.svg')).map(name => join(OUT, name)),
  ...AGENT_ICONS.flatMap(icon => [join(OUT, 'agents', `${icon.file}.svg`), join(OUT, 'agents', `chip-${icon.file}.svg`)]),
  ...readdirSync(join(OUT, 'board')).filter(name => name.endsWith('.svg')).map(name => join(OUT, 'board', name)),
]
if (svgs.length === 0) throw new Error(`No image's name starts with ${only}`)
const fonts = Bun.spawnSync([python, join(import.meta.dir, 'fonts.py'), ...svgs], { stdout: 'inherit', stderr: 'inherit' })
if (fonts.exitCode !== 0) throw new Error(`fonts.py stopped with exit code ${fonts.exitCode}`)
if (only !== undefined) console.log(`wrote ${written.length} image(s) starting with ${only} to ${OUT}`)
else console.log(`wrote the pane top, tour, flow, promotional card, the README cover and CLI boards in ${LANGS.length} languages and ${AGENT_ICONS.length} agent icons and chips to ${OUT}, and ${LANGS.length} progress.html pages to ${PAGES}`)
