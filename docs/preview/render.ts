// Draws the README images from the pane's own code: drawPane's tree, laid out like a terminal
// (terminal.ts), written as SVG. One set per language and per light / dark theme.
//   bun docs/preview/render.ts          (run `claude --plugin-dir .` once first, for the JSX setup)
// Writes docs/images/{hero,demo,flow}-<lang>-<theme>.svg, and docs/preview/out/dashboard-<lang>.html
// for docs/preview/png.mjs, which takes the progress.html screenshots and the social preview.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { upsertAutoBlock } from '../../hooks/blocks'
import { dashboardHtml } from '../../hooks/dashboard'
import { countDay, journalLine } from '../../hooks/journal'
import { applyTaskCreate, applyTaskUpdate, emptyMirror } from '../../hooks/mirror'
import { DARK, LIGHT } from '../../hooks/palette'
import type { Palette } from '../../hooks/palette'
import { parseProgress } from '../../hooks/parse'
import { STRINGS } from '../../hooks/strings'
import { buildView } from '../../hooks/view'
import { NOW, SAMPLES, SESSION, MIN } from './samples'
import { CELL, LINE, MONO, gridSvg, keyBox, layout } from './terminal'
import type { Node, Theme } from './terminal'

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
const PAGE: Record<Mode, { ground: string; card: string; line: string; ink: string; muted: string; accent: string }> = {
  light: { ground: '#f6f5f0', card: '#ffffff', line: '#dcdcd2', ink: '#2b2b2b', muted: '#595857', accent: '#165e83' },
  dark: { ground: '#15171a', card: '#1c1e21', line: '#2f3236', ink: '#e6e4dc', muted: '#afafb0', accent: '#4fb3bf' },
}
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', 'Noto Sans SC', 'PingFang TC', 'Microsoft JhengHei', 'Microsoft YaHei', sans-serif"

const WORDS: Record<Lang, {
  kicker: string
  tagline: [string, string]
  features: Array<[string, keyof Palette, string]>
  agents: string
  captions: [string, string, string]
  flow: { sources: Array<[string, string]>; outputs: Array<[string, string]>; into: [string, string, string]; file: string }
  window: string
}> = {
  en: {
    kicker: 'CLAUDE CODE PLUGIN  ·  MIT',
    tagline: ['A progress dashboard for coding agents.', 'What needs you first, every project at a glance.'],
    features: [
      ['●', 'waiting', 'One question at a time, with a button per answer'],
      ['▸', 'accent', 'Every agent reports through its own hooks'],
      ['⚑', 'soon', 'Background, deadline and handoff on every task'],
      ['✓', 'done', 'Cleans itself up; nothing piles up'],
    ],
    agents: 'English  ·  繁體中文  ·  简体中文',
    captions: ['1  The one thing that needs you', '2  Everything waiting on you, by kind', '3  Answered from the pane; Claude moves on'],
    flow: {
      sources: [
        ['Claude Code sessions', 'Every turn, with or without a Task list'],
        ['Other agents', 'Codex, Gemini, Cursor, Grok and more'],
        ['You', 'Tasks kept by hand, + quick add'],
      ],
      into: ['automatically', 'their hooks', 'type or edit'],
      file: 'one Markdown file, one block per session',
      outputs: [
        ['The pane', 'Needs you first, in Claude Code'],
        ['progress.html', 'Browser and phone, refreshes itself'],
        ['Archive and journal', 'Monthly files, weekly report'],
        ['Status line, notifications', 'When the pane is closed'],
      ],
    },
    window: 'claude  —  acme-web',
  },
  'zh-TW': {
    kicker: 'CLAUDE CODE 外掛  ·  MIT',
    tagline: ['給 coding agent 用的進度看板。', '需要你的事放最前面，每個專案一眼看完。'],
    features: [
      ['●', 'waiting', '一次一個問題，每個答案一個按鈕'],
      ['▸', 'accent', '各家 agent 用自己的 hook 回報，不用記得'],
      ['⚑', 'soon', '每件事都有背景、截止日和交接'],
      ['✓', 'done', '自己收拾，不會越積越多'],
    ],
    agents: 'English  ·  繁體中文  ·  简体中文',
    captions: ['1  最需要你的那一件事', '2  所有等你的事，依種類列好', '3  在面板上回答，Claude 接著做'],
    flow: {
      sources: [
        ['Claude Code 對話', '每回合自動整理，有沒有 Task 清單都行'],
        ['其他 agent', 'Codex、Gemini、Cursor、Grok 等'],
        ['你', '手記的事、用 + 快速新增'],
      ],
      into: ['自動', '各自的 hook', '打字或編輯'],
      file: '一個 Markdown 檔，每個對話一塊',
      outputs: [
        ['面板', '在 Claude Code 裡，需要你的放最前'],
        ['progress.html', '瀏覽器和手機，自己更新'],
        ['封存與日誌', '每月檔案、週報'],
        ['狀態列、通知', '面板關著時也知道'],
      ],
    },
    window: 'claude  —  acme-web',
  },
  'zh-CN': {
    kicker: 'CLAUDE CODE 插件  ·  MIT',
    tagline: ['给 coding agent 用的进度看板。', '需要你的事放最前面，每个项目一眼看完。'],
    features: [
      ['●', 'waiting', '一次一个问题，每个答案一个按钮'],
      ['▸', 'accent', '各家 agent 用自己的 hook 汇报，不用记得'],
      ['⚑', 'soon', '每件事都有背景、截止日期和交接'],
      ['✓', 'done', '自己清理，不会越积越多'],
    ],
    agents: 'English  ·  繁體中文  ·  简体中文',
    captions: ['1  最需要你的那一件事', '2  所有等你的事，按种类列好', '3  在面板上回答，Claude 接着做'],
    flow: {
      sources: [
        ['Claude Code 对话', '每回合自动整理，有没有 Task 清单都行'],
        ['其他 agent', 'Codex、Gemini、Cursor、Grok 等'],
        ['你', '手记的事、用 + 快速添加'],
      ],
      into: ['自动', '各自的 hook', '打字或编辑'],
      file: '一个 Markdown 文件，每个对话一块',
      outputs: [
        ['面板', '在 Claude Code 里，需要你的放最前'],
        ['progress.html', '浏览器和手机，自己刷新'],
        ['归档与日志', '每月文件、周报'],
        ['状态栏、通知', '面板关着时也知道'],
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

type Frame = { opened: string[]; isAnswered: boolean }

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
    { view, expanded: '', opened: frame.opened, answer, path: sample.path, width: 26, hasTaskTools: true, isNotifyOn: true, isLegendOpen: false, palette: t.palette, s } as never,
    {} as never,
  ) as unknown as Node
  const theme: Theme = { ground: t.ground, ink: t.ink, edge: t.edge, muted: t.palette.muted, accent: t.palette.accent, frame: t.palette.frame }
  return { grid: layout(tree, WIDTH, theme), theme, firstOption: option[0] ?? '' }
}

// A terminal window around a grid: a title bar, then the cells.
const PAD = 22
const BAR = 34
const windowWidth = WIDTH * CELL + PAD * 2
const terminal = (mode: Mode, title: string, body: string, rows: number, x: number, y: number): string => {
  const t = TERMINAL[mode]
  const h = BAR + PAD + rows * LINE + PAD
  return `<g transform="translate(${x} ${y})">
<rect width="${windowWidth}" height="${h}" rx="12" fill="${t.ground}" stroke="${t.edge}"/>
<path d="M12 0.5h${windowWidth - 24}a11.5 11.5 0 0 1 11.5 11.5v${BAR - 12}h-${windowWidth - 1}v-${BAR - 12}a11.5 11.5 0 0 1 11.5-11.5z" fill="${t.bar}"/>
<line x1="0.5" y1="${BAR}" x2="${windowWidth - 0.5}" y2="${BAR}" stroke="${t.edge}"/>
<g fill="${t.palette.frame}"><circle cx="20" cy="17" r="5"/><circle cx="38" cy="17" r="5"/><circle cx="56" cy="17" r="5"/></g>
<text x="${windowWidth / 2}" y="22" text-anchor="middle" font-family="${MONO}" font-size="12" fill="${t.palette.muted}">${esc(title)}</text>
<g font-family="${MONO}" font-size="14" style="white-space:pre" xml:space="preserve">${body}</g>
</g>`
}

// 1. The animated demo: three states of the pane, each with the button that leads to the next.
const demo = (lang: Lang, mode: Mode): string => {
  const w = WORDS[lang]
  const page = PAGE[mode]
  const frames: Frame[] = [
    { opened: [], isAnswered: false },
    { opened: ['waiting'], isAnswered: false },
    { opened: [], isAnswered: true },
  ]
  const grids = frames.map(frame => paneGrid(lang, mode, frame))
  // Every frame as tall as the shortest, so none leaves an empty window below it; a taller
  // frame fades out at the bottom edge instead of stopping mid-line.
  const rows = Math.min(...grids.map(one => one.grid.length))
  const top = 58
  const width = windowWidth + 48
  const height = top + BAR + PAD + rows * LINE + PAD + 24
  const press = [keyBox(grids[0]!.grid, 'focus::more'), keyBox(grids[1]!.grid, `mine::4::${grids[1]!.firstOption}`), null]
  const accent = TERMINAL[mode].palette.accent
  const ground = TERMINAL[mode].ground
  const fadeTop = top + BAR + PAD + (rows - 2) * LINE
  const groups = grids.map((one, i) => {
    const body = gridSvg(one.grid.slice(0, rows), PAD, BAR + PAD, one.theme)
    const fade =
      one.grid.length > rows ? `<rect x="25" y="${fadeTop}" width="${windowWidth - 2}" height="${2 * LINE + PAD - 1}" fill="url(#fade)"/>` : ''
    const box = press[i]
    const ring = box
      ? `<rect class="p${i + 1}" x="${24 + PAD + box.col * CELL - 5}" y="${top + BAR + PAD + box.row * LINE - 3}" width="${box.span * CELL + 10}" height="${LINE + 6}" rx="6" fill="none" stroke="${accent}" stroke-width="2"/>`
      : ''
    return `<g class="f f${i + 1}">
<text x="24" y="36" font-family="${SANS}" font-size="17" font-weight="600" fill="${page.ink}">${esc(w.captions[i] ?? '')}</text>
${terminal(mode, w.window, body, rows, 24, top)}
${fade}
${ring}
</g>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * 1.25)}" height="${Math.round(height * 1.25)}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(w.captions.join(' / '))}">
<title>${esc(w.captions.join(' / '))}</title>
<style>
.f { opacity: 0; animation: 12s infinite; }
.f1 { animation-name: a1; } .f2 { animation-name: a2; } .f3 { animation-name: a3; }
.p1, .p2 { opacity: 0; animation: 12s infinite; } .p1 { animation-name: p1; } .p2 { animation-name: p2; }
@keyframes a1 { 0%, 32% { opacity: 1 } 34%, 98% { opacity: 0 } 100% { opacity: 1 } }
@keyframes a2 { 0%, 32% { opacity: 0 } 34%, 65% { opacity: 1 } 67%, 100% { opacity: 0 } }
@keyframes a3 { 0%, 65% { opacity: 0 } 67%, 98% { opacity: 1 } 100% { opacity: 0 } }
@keyframes p1 { 0%, 17% { opacity: 0 } 19%, 31% { opacity: 1 } 33%, 100% { opacity: 0 } }
@keyframes p2 { 0%, 49% { opacity: 0 } 51%, 64% { opacity: 1 } 66%, 100% { opacity: 0 } }
@media (prefers-reduced-motion: reduce) { .f, .p1, .p2 { animation: none; } .f1 { opacity: 1; } }
</style>
<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ground}" stop-opacity="0"/><stop offset="0.7" stop-color="${ground}" stop-opacity="1"/></linearGradient></defs>
<rect width="${width}" height="${height}" rx="16" fill="${page.ground}"/>
${groups.join('\n')}
</svg>
`
}

// 2. The banner: what it is on the left, the pane on the right, rising from the bottom edge.
const hero = (lang: Lang, mode: Mode): string => {
  const w = WORDS[lang]
  const page = PAGE[mode]
  const pal = TERMINAL[mode].palette
  const { grid, theme } = paneGrid(lang, mode, { opened: [], isAnswered: false })
  const rows = Math.min(grid.length, 27)
  const body = gridSvg(grid.slice(0, rows), PAD, BAR + PAD, theme)
  const isCjk = lang !== 'en'
  const features = w.features
    .map(([glyph, role, text], i) => {
      const y = 392 + i * 44
      return `<text x="72" y="${y}" font-family="${MONO}" font-size="20" fill="${pal[role]}">${glyph}</text>` +
        `<text x="104" y="${y}" font-family="${SANS}" font-size="${isCjk ? 20 : 19}" fill="${page.ink}">${esc(text)}</text>`
    })
    .join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img" aria-label="claude-progress-pane: ${esc(w.tagline.join(' '))}">
<title>claude-progress-pane</title>
<defs><clipPath id="edge"><rect width="1280" height="640" rx="20"/></clipPath></defs>
<g clip-path="url(#edge)">
<rect width="1280" height="640" fill="${page.ground}"/>
<text x="72" y="128" font-family="${SANS}" font-size="15" font-weight="600" letter-spacing="3" fill="${page.muted}">${esc(w.kicker)}</text>
<text x="70" y="196" font-family="${SANS}" font-size="50" font-weight="700" fill="${page.ink}">claude-progress-pane</text>
<text x="72" y="256" font-family="${SANS}" font-size="${isCjk ? 25 : 24}" fill="${page.ink}">${esc(w.tagline[0])}</text>
<text x="72" y="294" font-family="${SANS}" font-size="${isCjk ? 25 : 24}" fill="${page.muted}">${esc(w.tagline[1])}</text>
${features}
<text x="72" y="594" font-family="${SANS}" font-size="15" fill="${page.muted}">${esc(w.agents)}</text>
${terminal(mode, w.window, body, rows + 6, 1280 - windowWidth - 64, 64)}
</g>
</svg>
`
}

// 3. How it works: who writes progress.md, and what reads it.
const flow = (lang: Lang, mode: Mode): string => {
  const w = WORDS[lang].flow
  const page = PAGE[mode]
  const pal = TERMINAL[mode].palette
  const card = (x: number, y: number, cw: number, ch: number, title: string, sub: string, dot: string) =>
    `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="12" fill="${page.card}" stroke="${page.line}"/>
<circle cx="${x + 22}" cy="${y + 30}" r="5" fill="${dot}"/>
<text x="${x + 38}" y="${y + 36}" font-family="${SANS}" font-size="18" font-weight="600" fill="${page.ink}">${esc(title)}</text>
<text x="${x + 38}" y="${y + 62}" font-family="${SANS}" font-size="14" fill="${page.muted}">${esc(sub)}</text>`
  const dots = [pal.accent, pal.running, pal.waiting]
  const outDots = [pal.accent, pal.project, pal.done, pal.soon]
  const left = w.sources.map(([title, sub], i) => card(40, 78 + i * 140, 330, 88, title, sub, dots[i] ?? pal.accent)).join('\n')
  const right = w.outputs.map(([title, sub], i) => card(910, 52 + i * 112, 330, 88, title, sub, outDots[i] ?? pal.accent)).join('\n')
  const doc = { x: 500, y: 110, w: 280, h: 330 }
  const text = FILE_LINES[lang]
  const colors = [pal.project, page.muted, page.ink, pal.done, pal.accent, pal.waiting, page.ink, pal.project, page.muted, pal.waiting, page.ink, pal.project, pal.soon]
  const lines: Array<[string, string]> = text.map((one, i) => [one, colors[i] ?? page.ink])
  const fileText = lines
    .map(([text, color], i) => (text === '' ? '' : `<text x="${doc.x + 22}" y="${doc.y + 72 + i * 19}" fill="${color}">${esc(text)}</text>`))
    .join('\n')
  const arrow = (x1: number, y1: number, x2: number, y2: number) => {
    const mid = (x1 + x2) / 2
    return `<path d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2 - 6} ${y2}" fill="none" stroke="${pal.frame}" stroke-width="1.6" marker-end="url(#head)"/>`
  }
  const ins = w.sources.map((_, i) => arrow(370, 122 + i * 140, doc.x, doc.y + 90 + i * 70)).join('\n')
  const labels = w.into
    .map((text, i) => `<text x="382" y="${112 + i * 140}" font-family="${SANS}" font-size="13" fill="${page.muted}">${esc(text)}</text>`)
    .join('\n')
  const outs = w.outputs.map((_, i) => arrow(doc.x + doc.w, doc.y + 70 + i * 62, 910, 96 + i * 112)).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="520" viewBox="0 0 1280 520" role="img" aria-label="progress.md: ${esc(w.file)}">
<title>progress.md</title>
<defs><marker id="head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${pal.frame}"/></marker></defs>
<rect width="1280" height="520" rx="20" fill="${page.ground}"/>
${left}
${ins}
${labels}
<rect x="${doc.x}" y="${doc.y}" width="${doc.w}" height="${doc.h}" rx="14" fill="${page.card}" stroke="${pal.accent}" stroke-width="2"/>
<text x="${doc.x + 22}" y="${doc.y + 36}" font-family="${MONO}" font-size="17" font-weight="700" fill="${page.ink}">progress.md</text>
<g font-family="${MONO}" font-size="13">${fileText}</g>
<text x="${doc.x + doc.w / 2}" y="${doc.y + doc.h + 34}" text-anchor="middle" font-family="${SANS}" font-size="14" fill="${page.muted}">${esc(w.file)}</text>
${outs}
${right}
</svg>
`
}

const dashboard = (lang: Lang): string => {
  const s = STRINGS[lang]
  const sample = SAMPLES[lang] as (typeof SAMPLES)[string]
  const file = upsertAutoBlock(sample.file, mineOf(lang, false), s)
  const view = buildView(parseProgress(file), [], null, NOW, today(lang), {}, s)
  return dashboardHtml(view, s, sample.path, s.dashStamp('2026-10-16 09:40'))
}

for (const lang of LANGS) {
  for (const mode of ['light', 'dark'] as const) {
    writeFileSync(join(OUT, `hero-${lang}-${mode}.svg`), hero(lang, mode))
    writeFileSync(join(OUT, `demo-${lang}-${mode}.svg`), demo(lang, mode))
    writeFileSync(join(OUT, `flow-${lang}-${mode}.svg`), flow(lang, mode))
  }
  writeFileSync(join(PAGES, `dashboard-${lang}.html`), dashboard(lang))
}
console.log(`wrote ${LANGS.length * 6} SVGs to ${OUT} and ${LANGS.length} progress.html pages to ${PAGES}`)
