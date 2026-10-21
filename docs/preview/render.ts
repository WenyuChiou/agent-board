// Draws the README images from the board's own code: drawPane's tree and boardScreen's lines,
// laid out like a terminal (terminal.ts), written as SVG. One set per language.
//   bun docs/preview/render.ts          (run `claude --plugin-dir .` once first, for the JSX setup)
// Writes docs/images/{tour,flow,promo}-<lang>.svg, docs/images/board/<agent>-<lang>-<light|dark>.svg,
// docs/images/cover-<lang>-<light|dark>.svg (the README's animated cover), docs/images/agents/<agent>.svg,
// and docs/preview/out/dashboard-<lang>.html for
// docs/preview/png.mjs, which takes the progress.html screenshots and the social preview.
import { mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { upsertAutoBlock } from '../../hooks/blocks'
import { boardItems, boardScreen, emptyBoardState } from '../../hooks/board'
import { dashboardHtml } from '../../hooks/dashboard'
import { countDay, journalLine } from '../../hooks/journal'
import { applyTaskCreate, applyTaskUpdate, emptyMirror } from '../../hooks/mirror'
import { DARK, LIGHT } from '../../hooks/palette'
import type { Palette } from '../../hooks/palette'
import { parseProgress } from '../../hooks/parse'
import { emptyQuestions } from '../../hooks/questions'
import { STRINGS } from '../../hooks/strings'
import { buildView } from '../../hooks/view'
import { CLI_FILES, COVER, COVER_MARKS, NOW, SAMPLES, SESSION, MIN, coverFile } from './samples'
import type { CoverSample } from './samples'
import { AGENT_ICONS, TESTED_ICONS } from './icons'
import type { AgentIcon } from './icons'
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

// The board mark and the name beside it.
const brandMark = (x: number, y: number, size = 34, hasName = true): string => {
  const k = size / 34
  const name = `<text x="${x + size + 12}" y="${y + size * 0.74}" font-size="${Math.round(size * 0.72)}" font-weight="700" fill="${BRAND.ink}">Agent Board</text>`
  return `<g transform="translate(${x} ${y}) scale(${k})"><rect width="34" height="34" rx="9" fill="${BRAND.accent}"/><rect x="8" y="9" width="18" height="3.5" rx="1.75" fill="#0c1116"/><rect x="8" y="15.5" width="12" height="3.5" rx="1.75" fill="#0c1116"/><circle cx="23" cy="22" r="3.6" fill="${DARK.waiting}"/></g>${hasName ? name : ''}`
}

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
  return `<g transform="translate(${num(x + (size - g) / 2)} ${num(y + (size - g) / 2)}) scale(${Math.round((g / 24) * 10000) / 10000})" fill="#fff"${rule}>${icon.paths.map(d => `<path d="${d}"/>`).join('')}</g>`
}

// A near-black tile gets a faint rim, or it sinks into a dark page; a coloured one needs none.
const isDark = (tile: string): boolean => parseInt(tile.slice(1, 3), 16) + parseInt(tile.slice(3, 5), 16) + parseInt(tile.slice(5, 7), 16) < 120

// An agent's tile, `size` square, from its name; nothing for a name without one.
const iconTile = (name: string, x: number, y: number, size: number): string => {
  const icon = AGENT_ICONS.find(one => one.name === name)
  if (icon === undefined) return ''
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
  return dashboardHtml(view, s, sample.path, s.dashStamp('2026-10-16 09:40'))
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
  // above it): the notification under the pane would run off the card.
  const hide = whole.findIndex(row => row.map(cell => cell.ch).join('').includes(STRINGS[lang].answeredHide))
  const isBlankAbove = hide > 0 && (whole[hide - 1] ?? []).every(cell => cell.ch === ' ')
  const grid = isBlankAbove ? [...whole.slice(0, hide - 1), ...whole.slice(hide + 1)] : whole
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
// boardScreen's colour codes (CODES in hooks/board.ts) and the palette colour each one takes;
// 0 ends a run and 1 is bold. A code missing here stops the render rather than drawing it plain.
const ANSI: Record<string, keyof Palette> = { '31': 'alert', '32': 'done', '33': 'waiting', '35': 'project', '36': 'accent', '2': 'muted' }
type Grid = Parameters<typeof gridSvg>[0]
const ansiGrid = (text: string, palette: Palette): Grid =>
  text.replace(/\n$/, '').split('\n').map(line => {
    const cells: Grid[number] = []
    let style: Grid[number][number]['style'] = {}
    for (const part of line.split(/(\u001b\[\d+m)/)) {
      const code = /^\u001b\[(\d+)m$/.exec(part)?.[1]
      if (code !== undefined) {
        const tone = ANSI[code]
        if (tone === undefined && code !== '0' && code !== '1') throw new Error(`boardScreen paints with ANSI code ${code}, which render.ts has no colour for`)
        style = code === '1' ? { bold: true } : tone === undefined ? {} : { fg: palette[tone] }
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
  const whole = boardScreen(view, [], state, s, { width: 400, isColor: false })
  let cols = Math.max(...whole.split('\n').map(widthCells))
  while (boardScreen(view, [], state, s, { width: cols, isColor: false }) !== whole) cols++
  const grid = ansiGrid(boardScreen(view, [], state, s, { width: cols, isColor: true }), t.palette)
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

// The README's cover, a 45 s loop in three acts, each opened by a caption above the picture.
// Act 1: Claude Code, Codex and Antigravity each tick a step and the pane shows it. Act 2: Claude
// asks which way to release, the person presses an answer in the pane, and Claude gets it as its
// next prompt (submitOwn in register.tsx, worded by s.answerText). Act 3, a preview: the person
// writes to the Codex session, the board shows the message on its way and then its receipts, and
// Codex goes on and ticks a step. The pane cannot message another agent, so the box and the
// receipts sit on Codex's card, where the board page puts them, in the page's own words
// (serveSend, serveSending and messages* in hooks/strings-en.ts). Left, a card per agent; right,
// the pane as drawPane draws it at each moment (COVER in samples.ts). CSS keyframes only, so
// GitHub plays it in an <img>; with reduced motion only the end of act 3 shows.
const COVER_LOOP = 45
const COVER_ACT = { one: 0, two: 14, three: 29 }
// When each thing happens, in seconds, paced to be read. A report takes TRAVEL to reach the pane,
// and a moment fades in over FADE. The last moment holds until `veil`, when the picture fades
// through its own ground; by `back` it is hidden, the last frame gives way to the first, and the
// veil lifts from the start of the next loop.
const COVER_T = {
  codex: 2.8, antigravity: 6.4, claude: 10,
  ask: 15.2, point: 18.2, press: 21, answer: 21.4,
  type: 30.8, aim: 33, tap: 35, send: 35.4, queued: 36.4, accepted: 37.8, replied: 39.6, tick: 40.8,
  veil: 44, back: 44.5,
}
const TRAVEL = 0.5
const FADE = 0.3
// How long the pointer takes to reach its target.
const POINT_IN = 1.2
// The pane shows this many rows; the answer's moment scrolls just far enough to show the answer.
const COVER_ROWS = 28
const CARD_W = 360
const GAP = 76
// Around the pane, the board page's own look: its pale ground, and white cards with a light line
// and a soft shadow. The pane keeps the terminal's.
const PAGE: Record<Mode, { ground: string; surface: string; line: string; shadow: string; depth: number }> = {
  light: { ground: '#f1f2ee', surface: '#ffffff', line: '#e3e4de', shadow: '#1f2324', depth: 0.1 },
  dark: { ground: '#141617', surface: '#1e2022', line: '#2e3134', shadow: '#000000', depth: 0.5 },
}
const MARGIN = 16
// The caption above the picture: its baseline, and where the picture starts.
const CAPTION_Y = 38
const PICTURE_Y = 84
// `soon` marks act 3 as a preview and says in which release it ships (the label goes after the
// picture's own); delete it, here only, when sending is on by default.
const COVER_WORDS: Record<Lang, { label: string; acts: [string, string, string]; soon?: { chip: string; label: string } }> = {
  en: {
    label: 'Claude Code, Codex and Antigravity report their steps to one board; Claude asks which way to release and the answer pressed in the pane goes back to it; then a message written on the board goes to the Codex session and its receipts show',
    acts: ['Every agent on one board', 'Answer from the board', 'Sessions message each other'],
    soon: { chip: 'Coming in 0.24.3', label: ', a preview of sending between sessions, coming in 0.24.3' },
  },
  'zh-TW': {
    label: 'Claude Code、Codex、Antigravity 把每一步回報到同一塊看板；Claude 問要怎麼上線，在面板按下的答案直接回給它；接著在看板寫的訊息傳給 Codex session，並顯示傳送狀態',
    acts: ['每個 agent 都在同一塊看板上', '在看板上直接回答', 'Session 之間互傳訊息'],
    soon: { chip: '0.24.3 推出', label: '，預覽 session 之間互傳訊息，0.24.3 推出' },
  },
  'zh-CN': {
    label: 'Claude Code、Codex、Antigravity 把每一步汇报到同一块看板；Claude 问要怎么上线，在面板点下的答案直接回给它；接着在看板写的消息发给 Codex session，并显示发送状态',
    acts: ['每个 agent 都在同一块看板上', '在看板上直接回答', 'Session 之间互发消息'],
    soon: { chip: '0.24.3 推出', label: '，预览 session 之间互发消息，0.24.3 推出' },
  },
}
const COVER_STATUS: Record<string, 'completed' | 'in_progress'> = { x: 'completed', '~': 'in_progress' }
type Row = Grid[number]

// A rough width of a line at `size`, to fit a box round it: the fonts are not measured here.
const textW = (text: string, size: number): number => [...text].reduce((n, ch) => n + size * (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.55), 0)

// The pane at moment `m` (0 to 6, as COVER_MARKS), with "Other open work" open so Codex's and
// Antigravity's steps show.
const coverPane = (lang: Lang, mode: Mode, m: number) => {
  const s = STRINGS[lang]
  const c = COVER[lang] as CoverSample
  const marks = COVER_MARKS.claude[m] ?? []
  let mine = emptyMirror(SESSION, c.claude.project, NOW, '')
  c.claude.steps.forEach((subject, i) => {
    const metadata = marks[i] === '?' ? { waiting: 'you', ask: 'choose', options: c.claude.options, why: c.claude.why } : undefined
    mine = applyTaskCreate(mine, { subject, activeForm: '', metadata } as never, String(i + 1), NOW)
  })
  marks.forEach((mark, i) => {
    const status = COVER_STATUS[mark]
    if (status !== undefined) mine = applyTaskUpdate(mine, { taskId: String(i + 1), status } as never, NOW)
  })
  const own = { ...mine, title: c.claude.title, context: '', state: 'working' as const, branch: c.claude.branch, updated: NOW }
  const file = upsertAutoBlock(coverFile(c, m), own, s)
  // Every step the sample ticks was ticked this morning.
  const view = buildView(parseProgress(file), [c.claude.project], own, NOW, (file.match(/^- \[x\] /gm) ?? []).length, {}, s, [], {}, emptyQuestions())
  const t = TERMINAL[mode]
  const answer = marks[2] === 'x' ? { question: c.claude.steps[2], text: s.answered(c.claude.options[0]), isAsking: false } : null
  const tree = drawPane(
    { Box: 'Box', Text: 'Text', Button: 'Button', Input: 'Input', Link: 'Link' } as never,
    { view, expanded: '', opened: ['others'], answer, path: '', width: 26, hasTaskTools: true, isNotifyOn: true, isLegendOpen: false, palette: t.palette, s } as never,
    {} as never,
  )
  const theme: Theme = { ground: t.ground, ink: t.ink, edge: t.edge, muted: t.palette.muted, accent: t.palette.accent, frame: t.palette.frame }
  const grid = layout(toNode(tree) ?? '', WIDTH, theme)
  // The answer's note sits above its Clear button; scroll so it is the last row shown.
  const clear = keyBox(grid, 'clear-answer')
  const top = answer === null || clear === null ? 0 : Math.max(0, clear.row - COVER_ROWS)
  return { grid, theme, top, rows: Array.from({ length: COVER_ROWS }, (_, i): Row | undefined => grid[top + i]) }
}

const rowKey = (row: Row | undefined): string =>
  (row ?? []).map(cell => `${cell.ch}|${cell.style.fg ?? ''}|${cell.style.bold === true ? 1 : 0}|${cell.style.underline === true ? 1 : 0}`).join('/')

const cover = (lang: Lang, mode: Mode): string => {
  const s = STRINGS[lang]
  const c = COVER[lang] as CoverSample
  const w = COVER_WORDS[lang]
  const t = TERMINAL[mode]
  const page = PAGE[mode]
  const pal = t.palette
  const mono = monoOf(lang)
  const T = COVER_T
  const panes = COVER_MARKS.claude.map((_, m) => coverPane(lang, mode, m))
  const winX = CARD_W + GAP
  const W = winX + windowWidth + 1
  const H = BAR + PAD + COVER_ROWS * LINE + PAD + 1
  const p = (sec: number): string => `${((Math.max(0, Math.min(COVER_LOOP, sec)) / COVER_LOOP) * 100).toFixed(2)}%`
  const keyframes: string[] = []
  const frames = (body: string): string => {
    const name = `c${keyframes.length}`
    keyframes.push(`@keyframes ${name} { ${body} }`)
    return name
  }
  // On from `start`, fading in, until `end`, when the one laid over it has fully come in; the
  // last one stays until the loop turns back, and fades out over the first.
  const shown = (start: number, end: number | null): string =>
    frames(`0%, ${p(start)} { opacity: 0 } ${p(start + FADE)} { opacity: 1 } ${end === null ? `${p(T.back)} { opacity: 1 } 100% { opacity: 0 }` : `${p(end)} { opacity: 1 } ${p(end + 0.02)}, 100% { opacity: 0 }`}`)
  // A brief glow, on and off.
  const glow = (start: number, length: number, peak: number): string =>
    frames(`0%, ${p(start)} { opacity: 0 } ${p(start + 0.12)} { opacity: ${peak} } ${p(start + length)}, 100% { opacity: 0 }`)

  // One surface's moments: the first drawn plainly, and each later one laid over it from its time,
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
        const name = shown(moment.at, next === undefined ? null : next.at + FADE)
        const rows = [...drawn].sort((a, b) => a - b).map(i => `${ground(i)}${moment.rows[i]?.svg ?? ''}`).join('')
        return `<g class="a ${name}${next === undefined ? ' last' : ''}">${rows}</g>`
      }),
    ].join('\n')
  }

  // The pane: each moment as it reaches the board. A report takes TRAVEL to arrive; the answer is
  // pressed in the pane itself.
  const paneAt = [0, T.codex + TRAVEL, T.antigravity + TRAVEL, T.claude + TRAVEL, T.ask + TRAVEL, T.answer, T.tick + TRAVEL]
  if (paneAt.length !== panes.length) throw new Error(`The cover has ${paneAt.length} pane times for ${panes.length} moments`)
  const rowY = (i: number): number => BAR + PAD + i * LINE
  const paneBody = layered(
    panes.map((pane, m) => ({ at: paneAt[m] ?? 0, rows: pane.rows.map((row, i) => ({ key: rowKey(row), svg: row === undefined ? '' : gridSvg([row], PAD, rowY(i), pane.theme) })) })),
    i => `<rect x="1" y="${rowY(i)}" width="${num(windowWidth - 2)}" height="${LINE}" fill="${t.ground}"/>`,
  )
  // A soft band over the rows a report changed, as it lands.
  const band = (m: number, from: number, to: number): string => {
    const pane = panes[m]
    if (from < 0 || pane === undefined) return ''
    return `<rect class="a ${glow(paneAt[m] ?? 0, 1.1, 0.16)}" x="1" y="${rowY(from - pane.top) - 1}" width="${num(windowWidth - 2)}" height="${(to - from + 1) * LINE + 2}" fill="${pal.accent}"/>`
  }
  const rowIn = (m: number, text: string): number => rowOf(panes[m]?.grid ?? [], text)
  const waitingRow = rowIn(4, s.mostNeeded)
  const option = keyBox(panes[4]?.grid ?? [], `mine::3::${c.claude.options[0]}`)
  const answerRow = rowIn(5, s.answered(c.claude.options[0]))
  const bands = [
    band(1, rowIn(1, c.codex.title), rowIn(1, c.codex.title) + 1),
    band(2, rowIn(2, c.antigravity.title), rowIn(2, c.antigravity.title) + 1),
    band(3, rowIn(3, c.claude.branch), rowIn(3, c.claude.branch) + 3),
    band(4, waitingRow, waitingRow + 3),
    band(5, answerRow - 1, answerRow),
    band(6, rowIn(6, c.codex.title), rowIn(6, c.codex.title) + 1),
  ].join('')
  // The press: a ring round the first answer, then the button lighting up.
  const press = option === null
    ? ''
    : `<rect class="a ${frames(`0%, ${p(T.point + POINT_IN - 0.2)} { opacity: 0 } ${p(T.point + POINT_IN + 0.1)} { opacity: 1 } ${p(T.answer)} { opacity: 1 } ${p(T.answer + 0.2)}, 100% { opacity: 0 }`)}" x="${num(PAD + option.col * CELL - 6)}" y="${rowY(option.row) - 3}" width="${num(option.span * CELL + 12)}" height="${LINE + 5}" rx="6" fill="none" stroke="${pal.accent}" stroke-width="2.4"/>` +
      `<rect class="a ${glow(T.press, 0.45, 0.3)}" x="${num(PAD + option.col * CELL - 6)}" y="${rowY(option.row) - 3}" width="${num(option.span * CELL + 12)}" height="${LINE + 5}" rx="6" fill="${pal.accent}"/>`
  const body = `<g clip-path="url(#pane)">${paneBody}\n${bands}${press}</g>`

  // The agents, one card each: its tile, name and project, its task, its steps and what it is
  // doing. A step's mark is the board's own: ✓ done, ▸ doing, ? waiting on you, a ring for to do.
  const cardH = (steps: number): number => 86 + steps * 24 + 22
  // In act 3 Codex's card opens for the message: the box, then a line for the receipts.
  const EXTRA = 76
  const BOX_H = 44
  const gap = (H - 1 - cardH(4) * 2 - cardH(3)) / 2
  type CardKey = 'claude' | 'codex' | 'antigravity'
  type Card = { key: CardKey; name: string; project: string; title: string; steps: string[]; y: number }
  const claude: Card = { key: 'claude', name: 'Claude Code', project: c.claude.project, title: c.claude.title, steps: c.claude.steps, y: 0.5 }
  const codex: Card = { key: 'codex', name: 'Codex', project: c.codex.project, title: c.codex.title, steps: c.codex.steps, y: 0.5 + cardH(4) + gap }
  const antigravity: Card = { key: 'antigravity', name: 'Antigravity', project: c.antigravity.project, title: c.antigravity.title, steps: c.antigravity.steps, y: 0.5 + cardH(4) * 2 + gap * 2 }
  const cards = [claude, codex, antigravity]
  const x0 = 0.5
  const stepLine = (x: number, y: number, mark: string, text: string): string => {
    const tone = mark === 'x' ? pal.muted : mark === '?' ? pal.waiting : t.ink
    const weight = mark === '~' || mark === '?' ? ' font-weight="600"' : ''
    const sign = mark === 'x'
      ? `<text x="${x}" y="${y}" font-size="15" font-weight="700" fill="${pal.done}">✓</text>`
      : mark === '~'
        ? `<text x="${x + 1}" y="${y}" font-size="14" fill="${pal.accent}">▸</text>`
        : mark === '?'
          ? `<text x="${x + 1}" y="${y}" font-size="15" font-weight="700" fill="${pal.waiting}">?</text>`
          : `<circle cx="${x + 5}" cy="${y - 5}" r="3.6" fill="none" stroke="${pal.muted}" stroke-width="1.3"/>`
    return `${sign}<text x="${x + 22}" y="${y}" font-size="14.5"${weight} fill="${tone}">${esc(text)}</text>`
  }
  // The line under the steps: at work, Claude's question, the answer as Claude's next prompt, or
  // the message as Codex's.
  type Doing = 'working' | 'why' | 'answer' | 'message'
  const doingLine = (y: number, kind: Doing): string => {
    const x = x0 + 18
    if (kind === 'why') return `<text x="${x}" y="${y}" font-size="14" font-weight="600" fill="${pal.waiting}">${esc(c.claude.why)}</text>`
    if (kind === 'answer') return `<text x="${x}" y="${y}" font-family="${mono}" font-size="13" fill="${pal.accent}">› ${esc(s.answerText(c.claude.steps[2], c.claude.options[0]))}</text>`
    if (kind === 'message') return `<text x="${x}" y="${y}" font-family="${mono}" font-size="12" fill="${pal.accent}">› ${esc(c.message.text)}</text>`
    return `<text x="${x}" y="${y}" font-size="14" fill="${pal.muted}">${esc(TOUR[lang].working)}</text>`
  }
  // A card's rows at moment `m`, each with the ground it needs when laid over another: below its
  // letters' tails, and the line under the steps sits 4 lower.
  const cardMoments = (card: Card, list: Array<{ at: number; m: number; kind: Doing }>): string =>
    layered(
      list.map(({ at, m, kind }) => {
        const marks = COVER_MARKS[card.key][m] ?? []
        const rows = [...card.steps.map((step, i) => stepLine(x0 + 18, card.y + 86 + i * 24, marks[i] ?? ' ', step)), doingLine(card.y + 86 + card.steps.length * 24 + 4, kind)]
        return { at, rows: rows.map(svg => ({ key: svg, svg })) }
      }),
      i => `<rect x="${x0 + 1}" y="${num(card.y + 86 + i * 24 - 18 + (i === card.steps.length ? 4 : 0))}" width="${CARD_W - 2}" height="24" fill="${page.surface}"/>`,
    )
  const frame = (card: Card, height: number): string =>
    `<rect x="${x0}" y="${num(card.y)}" width="${CARD_W}" height="${height}" rx="12" fill="${page.surface}" stroke="${page.line}" filter="url(#lift)"/>
${iconTile(card.name, x0 + 16, card.y + 10, 32)}
<text x="${x0 + 58}" y="${num(card.y + 32)}" font-size="16" font-weight="600" fill="${t.ink}">${esc(card.name)}</text>
<text x="${x0 + 18}" y="${num(card.y + 58)}" font-size="14"><tspan font-weight="600" fill="${pal.project}">${esc(card.project)}</tspan><tspan fill="${pal.muted}"> › ${esc(card.title)}</tspan></text>`

  // While Claude waits on you, its card wears the board's own kind-of-question chip.
  const chipLabel = s.ask.choose
  const chipW = 30 + [...chipLabel].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 12 : 7), 0)
  const chipX = x0 + CARD_W - 16 - chipW
  const chip = `<g class="a ${shown(T.ask, T.answer + TRAVEL + FADE)}"><rect x="${num(chipX)}" y="${num(claude.y + 15)}" width="${chipW}" height="22" rx="11" fill="${pal.waiting}" fill-opacity="0.08" stroke="${pal.waiting}" stroke-opacity="0.45"/><circle cx="${num(chipX + 12)}" cy="${num(claude.y + 26)}" r="3" fill="${pal.waiting}"/><text x="${num(chipX + 21)}" y="${num(claude.y + 30.5)}" font-size="12" font-weight="600" fill="${pal.waiting}">${esc(chipLabel)}</text></g>`
  // Claude ticks (act 1), asks, and has the answer once it has come back from the pane.
  const claudeSvg = `${frame(claude, cardH(4))}
${chip}
${cardMoments(claude, [{ at: 0, m: 0, kind: 'working' }, { at: T.claude, m: 3, kind: 'working' }, { at: T.ask, m: 4, kind: 'why' }, { at: T.answer + TRAVEL, m: 5, kind: 'answer' }])}`

  // Codex and Antigravity as acts 1 and 2 show them; act 3 keeps only Claude's and Codex's, the
  // two the message is about, and Codex's opens. Antigravity's goes just before act 3, so the
  // opened card does not cross it; Codex's stays until the opened one, which covers it, is in.
  const leavesFirst = frames(`0% { opacity: 1 } ${p(COVER_ACT.three - 0.3)} { opacity: 1 } ${p(COVER_ACT.three)}, ${p(T.back)} { opacity: 0 } 100% { opacity: 1 }`)
  const leavesNext = frames(`0% { opacity: 1 } ${p(COVER_ACT.three + FADE)} { opacity: 1 } ${p(COVER_ACT.three + FADE + 0.02)}, ${p(T.back)} { opacity: 0 } 100% { opacity: 1 }`)
  const codexSvg = `<g class="a ${leavesNext}">${frame(codex, cardH(4))}
${cardMoments(codex, [{ at: 0, m: 0, kind: 'working' }, { at: T.codex, m: 1, kind: 'working' }])}</g>`
  const antigravitySvg = `<g class="a ${leavesFirst}">${frame(antigravity, cardH(3))}
${cardMoments(antigravity, [{ at: 0, m: 0, kind: 'working' }, { at: T.antigravity, m: 2, kind: 'working' }])}</g>`

  // Codex's card in act 3: the board page's reply box with its Send button, and under it the
  // receipt line. The person's text is typed in, sent (the box empties, as the page's does), and
  // the receipt reads Queued, Waiting for a reply, then Replied.
  const expandedH = cardH(4) + EXTRA
  const boxX = x0 + 18
  const boxY = codex.y + cardH(4) - 2
  const sendLabel = s.serveSend('Codex')
  const sendW = Math.round(textW(sendLabel, 13.5) + 28)
  const boxW = CARD_W - 36 - sendW - 8
  const sendX = boxX + boxW + 8
  const sendH = 34
  const sendY = boxY + BOX_H - sendH
  const receiptY = boxY + BOX_H + 20
  const composer = `<rect x="${boxX}" y="${num(boxY)}" width="${boxW}" height="${BOX_H}" rx="8" fill="${page.ground}" stroke="${pal.frame}" stroke-opacity="0.6"/>
<text x="${boxX + 10}" y="${num(boxY + 21)}" font-size="13" fill="${pal.muted}">${esc(s.serveMessagePlaceholder('Codex'))}</text>
<rect x="${num(sendX)}" y="${num(sendY)}" width="${sendW}" height="${sendH}" rx="8" fill="${pal.accent}"/>
<text x="${num(sendX + sendW / 2)}" y="${num(sendY + 22)}" text-anchor="middle" font-size="13.5" font-weight="600" fill="${page.ground}">${esc(sendLabel)}</text>`
  // Typed a line at a time, each uncovered from the left a letter at a time by a rect in the
  // box's colour that shrinks to its right edge; the group covers the placeholder while it shows.
  let typedAt = T.type
  const lines = c.message.lines.map((line, j) => {
    const letters = [...line].length
    const start = typedAt
    const length = Math.max(0.8, letters * 0.06)
    typedAt += length
    const x = boxX + 10
    const y = boxY + 21 + j * 18
    const mask = frames(`0%, ${p(start)} { opacity: 1; transform: scaleX(1); animation-timing-function: steps(${letters}, end) } ${p(start + length)}, 100% { opacity: 1; transform: scaleX(0) }`)
    return `<text x="${x}" y="${num(y)}" font-size="13" fill="${t.ink}">${esc(line)}</text><rect class="a m ${mask}" x="${x - 2}" y="${num(y - 14)}" width="${num(textW(line, 13) + 6)}" height="18" fill="${page.ground}"/>`
  })
  const typed = `<g class="a ${frames(`0%, ${p(T.type)} { opacity: 0 } ${p(T.type + 0.05)} { opacity: 1 } ${p(T.send)} { opacity: 1 } ${p(T.send + 0.05)}, 100% { opacity: 0 }`)}"><rect x="${boxX + 1}" y="${num(boxY + 1)}" width="${boxW - 2}" height="${BOX_H - 2}" rx="7" fill="${page.ground}"/>${lines.join('')}</g>`
  const tapped = `<rect class="a ${glow(T.tap, 0.5, 0.35)}" x="${num(sendX)}" y="${num(sendY)}" width="${sendW}" height="${sendH}" rx="8" fill="#ffffff"/>`
  const receipt = (text: string, colour: string): string => `<text x="${x0 + 18}" y="${num(receiptY)}" font-size="13" fill="${colour}">${esc(text)}</text>`
  const receipts = layered(
    [
      { at: 0, rows: [{ key: '', svg: '' }] },
      { at: T.send, rows: [{ key: 'sending', svg: receipt(s.serveSending('Codex'), pal.accent) }] },
      { at: T.queued, rows: [{ key: 'queued', svg: receipt(s.messagesQueued, pal.muted) }] },
      { at: T.accepted, rows: [{ key: 'accepted', svg: receipt(s.messagesAccepted, pal.waiting) }] },
      { at: T.replied, rows: [{ key: 'replied', svg: receipt(s.messagesAcknowledged, pal.done) }] },
    ],
    () => `<rect x="${x0 + 1}" y="${num(receiptY - 17)}" width="${CARD_W - 2}" height="24" fill="${page.surface}"/>`,
  )
  // Codex gets the message as its next prompt, answers, and ticks its third step.
  const expandedSvg = `<g class="a ${shown(COVER_ACT.three, null)} last">${frame(codex, expandedH)}
${cardMoments(codex, [{ at: COVER_ACT.three, m: 5, kind: 'working' }, { at: T.accepted, m: 5, kind: 'message' }, { at: T.tick, m: 6, kind: 'working' }])}
${composer}
${typed}${tapped}
${receipts}</g>`
  const cardSvg = [claudeSvg, codexSvg, antigravitySvg, expandedSvg].join('\n')

  // The wires: from each card to the row it is on in the pane, which moves as the pane does. They
  // are cut at act 3, where Antigravity's goes and Codex's starts from its opened card.
  const anchor = (card: Card, sec: number): number => card.y + (card.key === 'codex' && sec >= COVER_ACT.three ? expandedH : cardH(card.steps.length)) / 2
  type Piece = { key: CardKey; from: number; to: number; d: string }
  const pieces: Piece[] = cards.flatMap(card => {
    const found: Piece[] = []
    panes.forEach((pane, m) => {
      const text = card.key === 'claude' ? m >= 5 ? s.answered(c.claude.options[0]) : m === 4 ? s.mostNeeded : c.claude.branch : card.title
      const at = rowOf(pane.grid, text)
      const row = at < 0 || at - pane.top < 0 || at - pane.top >= COVER_ROWS ? null : at - pane.top
      // The moments a wire must have: the rest may push its row out of the pane.
      const isRequired = card.key === 'claude' || (card.key === 'codex' ? [0, 1, 5, 6] : [0, 2]).includes(m)
      if (row === null) {
        if (isRequired) throw new Error(`Missing wire row for ${card.key}, moment ${m}, language ${lang}`)
        return
      }
      const from = paneAt[m] ?? 0
      const to = paneAt[m + 1] ?? COVER_LOOP
      const spans = from < COVER_ACT.three && COVER_ACT.three < to ? [[from, COVER_ACT.three], [COVER_ACT.three, to]] : [[from, to]]
      for (const [a = 0, b = 0] of spans) {
        if (card.key === 'antigravity' && a >= COVER_ACT.three) continue
        const x1 = CARD_W + 0.5
        const y1 = anchor(card, a)
        const x2 = winX + 0.5
        const y2 = 0.5 + rowY(row) + LINE / 2
        const d = `M${num(x1)} ${num(y1)}C${num(x1 + GAP * 0.55)} ${num(y1)} ${num(x2 - GAP * 0.55)} ${num(y2)} ${num(x2)} ${num(y2)}`
        const previous = found[found.length - 1]
        if (previous !== undefined && previous.d === d && previous.to === a) previous.to = b
        else found.push({ key: card.key, from: a, to: b, d })
      }
    })
    return found
  })
  // A bright dash along the wire that is there at `at`: out to the pane for a report, back to the
  // card for a reply to it.
  const dash = (key: CardKey, at: number, start: number, colour: string, isBack = false): string => {
    const piece = pieces.find(one => one.key === key && one.from <= at + 0.001 && at < one.to)
    if (piece === undefined) throw new Error(`Missing wire path for ${key} at ${at} s, language ${lang}`)
    const [from, to] = isBack ? [-100, 16] : [16, -100]
    return `<path class="a ${frames(`0%, ${p(start)} { opacity: 0; stroke-dashoffset: ${from} } ${p(start + 0.02)} { opacity: 1; stroke-dashoffset: ${from} } ${p(start + TRAVEL)} { opacity: 1; stroke-dashoffset: ${to} } ${p(start + TRAVEL + 0.02)}, 100% { opacity: 0; stroke-dashoffset: ${to} }`)}" d="${piece.d}" pathLength="100" fill="none" stroke="${colour}" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="16 200"/>`
  }
  const wires = `<g fill="none" stroke="${pal.frame}" stroke-width="1.4" stroke-dasharray="1.5 4.5" stroke-linecap="round">
${pieces.map(piece => {
    const isFirst = piece.from === 0
    const isLast = piece.to >= COVER_LOOP
    if (isFirst && isLast) return `<path d="${piece.d}"/>`
    const fadeIn = isFirst ? '0% { opacity: 1 }' : `0%, ${p(piece.from)} { opacity: 0 } ${p(piece.from + FADE)} { opacity: 1 }`
    const fadeOut = isLast
      ? `${p(T.back)} { opacity: 1 } 100% { opacity: 0 }`
      : `${p(piece.to)} { opacity: 1 } ${p(piece.to + FADE)}, ${isFirst ? `${p(T.back)} { opacity: 0 } 100% { opacity: 1 }` : '100% { opacity: 0 }'}`
    return `<path class="a ${frames(`${fadeIn} ${fadeOut}`)}${isLast ? ' last' : ''}" d="${piece.d}"/>`
  }).join('\n')}
</g>
${dash('codex', T.codex + TRAVEL, T.codex, pal.accent)}
${dash('antigravity', T.antigravity + TRAVEL, T.antigravity, pal.accent)}
${dash('claude', T.claude + TRAVEL, T.claude, pal.accent)}
${dash('claude', T.ask + TRAVEL, T.ask, pal.waiting)}
${dash('claude', T.answer, T.answer, pal.done, true)}
${dash('codex', T.send, T.send, pal.done, true)}
${dash('codex', T.tick + TRAVEL, T.tick, pal.accent)}`

  // The pointer: in from below onto its target, a press, and away once it has gone through.
  const pointer = (tipX: number, tipY: number, start: number, arrive: number, pressAt: number, end: number): string => {
    const at = (x: number, y: number, k = 1): string => `transform: translate(${num(x)}px, ${num(y)}px) scale(${k})`
    const move = 'animation-timing-function: cubic-bezier(0.3, 0.7, 0.2, 1)'
    const name = frames(`0%, ${p(start)} { opacity: 0; ${at(tipX + 120, tipY + 150)}; ${move} } ${p(start + 0.25)} { opacity: 1 } ${p(arrive)} { ${at(tipX, tipY)} } ${p(pressAt)} { ${at(tipX, tipY)} } ${p(pressAt + 0.1)} { ${at(tipX, tipY, 0.86)} } ${p(pressAt + 0.25)} { ${at(tipX, tipY)} } ${p(end)} { opacity: 1 } ${p(end + 0.3)}, 100% { opacity: 0; ${at(tipX, tipY)} }`)
    const [fill, line] = mode === 'light' ? ['#1b1b1b', '#ffffff'] : ['#ffffff', '#1b1b1b']
    return `<g class="a ${name}"><path d="M0 0V18.5L4.6 14.2L7.7 21.2L10.9 19.8L7.9 13H14Z" fill="${fill}" stroke="${line}" stroke-width="1.3" stroke-linejoin="round"/></g>`
  }
  const pointers = [
    option === null ? '' : pointer(winX + 0.5 + PAD + (option.col + option.span * 0.45) * CELL, 0.5 + rowY(option.row) + LINE * 0.62, T.point, T.point + POINT_IN, T.press, T.answer + 0.5),
    pointer(sendX + sendW / 2, sendY + sendH * 0.62, T.aim, T.aim + POINT_IN, T.tap, T.send + 0.6),
  ].join('')

  // The captions: each fades in once its act has begun and out just before the next, so two never
  // overlap; the last holds until the veil comes down. Beside each, a pip lights. The first is
  // already on when the loop starts, under the veil.
  const starts = [COVER_ACT.one, COVER_ACT.two, COVER_ACT.three]
  const lit = starts.map((start, k) => {
    const end = starts[k + 1] ?? COVER_LOOP
    if (k === 0) return frames(`0% { opacity: 1 } ${p(end - 0.4)} { opacity: 1 } ${p(end)}, 100% { opacity: 0 }`)
    if (end >= COVER_LOOP) return frames(`0%, ${p(start)} { opacity: 0 } ${p(start + 0.4)} { opacity: 1 } ${p(T.back)} { opacity: 1 } 100% { opacity: 0 }`)
    return frames(`0%, ${p(start)} { opacity: 0 } ${p(start + 0.4)} { opacity: 1 } ${p(end - 0.4)} { opacity: 1 } ${p(end)}, 100% { opacity: 0 }`)
  })
  // At the loop's turn the picture goes through its own ground, so words of the last frame and the
  // first never show mixed: the veil comes down, the frames change behind it, and it lifts.
  const veil = `<rect class="a ${frames(`0% { opacity: 1 } ${p(0.4)}, ${p(T.veil)} { opacity: 0 } ${p(T.back)}, 100% { opacity: 1 }`)}" width="${num(W + MARGIN * 2)}" height="${PICTURE_Y + H + MARGIN}" rx="16" fill="${page.ground}"/>`
  const outW = W + MARGIN * 2
  const outH = PICTURE_Y + H + MARGIN
  const isLastAct = (k: number): string => (k === starts.length - 1 ? ' last' : '')
  const captions = w.acts.map((text, k) => `<text class="a ${lit[k]}${isLastAct(k)}" x="${MARGIN + 4}" y="${CAPTION_Y}" font-size="26" font-weight="800" ${HEADLINE} fill="${t.ink}">${esc(text)}</text>`).join('\n')
  const pipX = (k: number): number => outW - MARGIN - 4 - 22 * 3 - 8 * 2 + k * 30
  const pips = starts.map((_, k) => `<rect x="${pipX(k)}" y="${CAPTION_Y - 14}" width="22" height="6" rx="3" fill="${pal.frame}" fill-opacity="0.45"/>`).join('') +
    starts.map((_, k) => `<rect class="a ${lit[k]}${isLastAct(k)}" x="${pipX(k)}" y="${CAPTION_Y - 14}" width="22" height="6" rx="3" fill="${pal.accent}"/>`).join('')
  // The preview mark under act 3's caption, in the colour of the board's own chips.
  const soonW = w.soon === undefined ? 0 : 30 + [...w.soon.chip].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 12 : 7), 0)
  const soon = w.soon === undefined
    ? ''
    : `<g class="a ${lit[2]} last"><rect x="${MARGIN + 4}" y="${CAPTION_Y + 9}" width="${soonW}" height="22" rx="11" fill="${pal.waiting}" fill-opacity="0.08" stroke="${pal.waiting}" stroke-opacity="0.45"/><circle cx="${MARGIN + 16}" cy="${CAPTION_Y + 20}" r="3" fill="${pal.waiting}"/><text x="${MARGIN + 25}" y="${CAPTION_Y + 24.5}" font-size="12" font-weight="600" fill="${pal.waiting}">${esc(w.soon.chip)}</text></g>`
  const label = `${w.label}${w.soon?.label ?? ''}`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(outW)}" height="${outH}" viewBox="0 0 ${num(outW)} ${outH}" role="img" aria-label="${esc(label)}" font-family="${sansOf(lang)}">
<title>Agent Board: ${esc(label)}</title>
<defs><clipPath id="pane"><rect x="1" y="${BAR + 1}" width="${num(windowWidth - 2)}" height="${PAD + COVER_ROWS * LINE + PAD - 13}"/></clipPath>
<filter id="lift" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="${page.shadow}" flood-opacity="${page.depth}"/></filter></defs>
<style>
.a { opacity: 0; animation-duration: ${COVER_LOOP}s; animation-iteration-count: infinite; animation-timing-function: linear; }
.m { transform-box: fill-box; transform-origin: 100% 50%; }
${keyframes.join('\n')}
${keyframes.map((_, i) => `.c${i} { animation-name: c${i} }`).join('\n')}
@media (prefers-reduced-motion: reduce) {
  .a { animation: none; opacity: 0; }
  .last { opacity: 1; }
}
</style>
<rect width="${num(outW)}" height="${outH}" rx="16" fill="${page.ground}"/>
${captions}
${pips}
${soon}
<g transform="translate(${MARGIN} ${PICTURE_Y})">
${wires}
${cardSvg}
${terminal(mode, mono, WORDS[lang].window, body, COVER_ROWS, winX + 0.5, 0.5)}
${pointers}
</g>
${veil}
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

mkdirSync(join(OUT, 'agents'), { recursive: true })
for (const icon of AGENT_ICONS) writeFileSync(join(OUT, 'agents', `${icon.file}.svg`), agentIcon(icon))
for (const lang of LANGS) writeFileSync(join(OUT, `promo-${lang}.svg`), promo(lang))

mkdirSync(join(OUT, 'board'), { recursive: true })
for (const lang of LANGS) {
  for (const agent of CLI_AGENTS) for (const mode of ['light', 'dark'] as const) writeFileSync(join(OUT, 'board', `${agent}-${lang}-${mode}.svg`), cliBoard(lang, mode, agent))
  for (const mode of ['light', 'dark'] as const) writeFileSync(join(OUT, `pane-${lang}-${mode}.svg`), pane(lang, mode))
  for (const mode of ['light', 'dark'] as const) writeFileSync(join(OUT, `cover-${lang}-${mode}.svg`), cover(lang, mode))
  writeFileSync(join(OUT, `tour-${lang}.svg`), tour(lang))
  writeFileSync(join(OUT, `flow-${lang}.svg`), flow(lang))
  writeFileSync(join(PAGES, `dashboard-${lang}.html`), dashboard(lang))
}

// Each SVG then gets the letters it draws from its fonts (fonts.py, which needs fontTools).
const svgs = [
  ...readdirSync(OUT).filter(name => name.endsWith('.svg')).map(name => join(OUT, name)),
  ...AGENT_ICONS.map(icon => join(OUT, 'agents', `${icon.file}.svg`)),
  ...readdirSync(join(OUT, 'board')).filter(name => name.endsWith('.svg')).map(name => join(OUT, 'board', name)),
]
const fonts = Bun.spawnSync([python, join(import.meta.dir, 'fonts.py'), ...svgs], { stdout: 'inherit', stderr: 'inherit' })
if (fonts.exitCode !== 0) throw new Error(`fonts.py stopped with exit code ${fonts.exitCode}`)
console.log(`wrote the pane top, tour, flow, promotional card, the README cover and CLI boards in ${LANGS.length} languages and ${AGENT_ICONS.length} agent icons to ${OUT}, and ${LANGS.length} progress.html pages to ${PAGES}`)
