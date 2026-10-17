// Draws the README images from the pane's own code: drawPane's tree, laid out like a terminal
// (terminal.ts), written as SVG. One set per language and per light / dark theme.
//   bun docs/preview/render.ts          (run `claude --plugin-dir .` once first, for the JSX setup)
// Writes docs/images/{tour,hero,flow}-<lang>-<theme>.svg, and docs/preview/out/dashboard-<lang>.html
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
import { AGENT_ICONS, TESTED_ICONS } from './icons'
import type { AgentIcon } from './icons'
import { CELL, LINE, MONO, gridSvg, keyBox, layout, rowOf, toNode } from './terminal'
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
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', 'Noto Sans SC', 'PingFang TC', 'Microsoft JhengHei', 'Microsoft YaHei', sans-serif"

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
  const name = `<text x="${x + size + 12}" y="${y + size * 0.74}" font-family="${SANS}" font-size="${Math.round(size * 0.72)}" font-weight="700" fill="${BRAND.ink}" letter-spacing="0.3">Agent Board</text>`
  return `<g transform="translate(${x} ${y}) scale(${k})"><rect width="34" height="34" rx="9" fill="${BRAND.accent}"/><rect x="8" y="9" width="18" height="3.5" rx="1.75" fill="#0c1116"/><rect x="8" y="15.5" width="12" height="3.5" rx="1.75" fill="#0c1116"/><circle cx="23" cy="22" r="3.6" fill="${DARK.waiting}"/></g>${hasName ? name : ''}`
}

// The logo takes about three fifths of its tile: at half, a logo with thin lines (OpenAI's)
// blurs at the table's 24 px.
const GLYPH = 0.62
const num = (value: number): string => String(Math.round(value * 100) / 100)

// An agent's white mark, centred in a tile `size` square at x, y: its logo, else its initial.
const glyph = (icon: AgentIcon, x: number, y: number, size: number): string => {
  if (icon.paths === undefined) {
    return `<text x="${num(x + size / 2)}" y="${num(y + size * 0.66)}" text-anchor="middle" font-family="${SANS}" font-size="${Math.round(size * 0.46)}" font-weight="700" fill="#fff">${esc(icon.letter ?? '')}</text>`
  }
  const g = size * GLYPH
  const rule = icon.isEvenOdd === true ? ' fill-rule="evenodd"' : ''
  return `<g transform="translate(${num(x + (size - g) / 2)} ${num(y + (size - g) / 2)}) scale(${Math.round((g / 24) * 10000) / 10000})" fill="#fff"${rule}>${icon.paths.map(d => `<path d="${d}"/>`).join('')}</g>`
}

// An agent's tile, `size` square, from its name; nothing for a name without one.
const iconTile = (name: string, x: number, y: number, size: number): string => {
  const icon = AGENT_ICONS.find(one => one.name === name)
  if (icon === undefined) return ''
  return `<rect x="${x + 0.5}" y="${y + 0.5}" width="${size - 1}" height="${size - 1}" rx="${size * 0.23}" fill="${icon.tile}" stroke="#fff" stroke-opacity="0.2"/>${glyph(icon, x, y, size)}`
}

// How it works: who writes progress.md, and what reads it. Three numbered columns, big
// type and few words, so it reads at the width GitHub shows it.
const flow = (lang: Lang): string => {
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="progress.md: ${esc(w.file)}">
<title>progress.md</title>
<defs>${brandDefs(W, H, [0.5, 0.45])}<marker id="head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${pal.accent}"/></marker></defs>
<g clip-path="url(#edge)" font-family="${SANS}">
${brandGround(W, H)}
${heads}
${sources}
${ins}
${labels}
<rect x="${doc.x}" y="${doc.y}" width="${doc.w}" height="${doc.h}" rx="16" fill="${page.card}" stroke="${pal.accent}" stroke-width="2.6"/>
<text x="${doc.x + 24}" y="${doc.y + 44}" font-family="${MONO}" font-size="22" font-weight="700" fill="${page.ink}">progress.md</text>
${bars}
<g font-family="${MONO}" font-size="16">${fileText}</g>
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
    const big = lines.map((line, i) => `<text x="64" y="${top + i * 56}" font-size="${size}" font-weight="800" fill="${i === lines.length - 1 ? page.accent : page.ink}">${esc(line)}</text>`).join('')
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
  const ring = (row: number, col: number, span: number, rows: number, start: number, end: number): string =>
    `<rect class="${timed(start, end, 'fade')}" x="${PAD + col * CELL - 6}" y="${BAR + PAD + row * LINE - 1}" width="${span * CELL + 12}" height="${rows * LINE + 2}" rx="6" fill="none" stroke="${pal.accent}" stroke-width="2.4"/>`
  const windowFrame = (m: Mode, inner: string, cls: string, still = false): string => {
    const t = TERMINAL[m]
    const h = BAR + bodyH
    // The class sits on an outer group: its CSS motion would replace a transform on the same element.
    return `<g class="${cls}"${still ? ' data-still="1"' : ''}><g filter="url(#lift)" transform="translate(${winX.toFixed(1)} ${winY}) scale(${SCALE})">
<rect width="${windowWidth}" height="${h}" rx="12" fill="${t.ground}" stroke="${t.edge}"/>
<path d="M12 0.5h${windowWidth - 24}a11.5 11.5 0 0 1 11.5 11.5v${BAR - 12}h-${windowWidth - 1}v-${BAR - 12}a11.5 11.5 0 0 1 11.5-11.5z" fill="${t.bar}"/>
<line x1="0.5" y1="${BAR}" x2="${windowWidth - 0.5}" y2="${BAR}" stroke="${t.edge}"/>
<g fill="${t.palette.frame}"><circle cx="20" cy="17" r="5"/><circle cx="38" cy="17" r="5"/><circle cx="56" cy="17" r="5"/></g>
<text x="${windowWidth / 2}" y="22" text-anchor="middle" font-family="${MONO}" font-size="12" fill="${t.palette.muted}">${esc(WORDS[lang].window)}</text>
<g clip-path="url(#body)" font-family="${MONO}" font-size="14" style="white-space:pre" xml:space="preserve">${inner}</g>
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
<text x="${x + 58}" y="${y + 30}" font-family="${MONO}" font-size="18" font-weight="700" fill="${page.ink}">${esc(name)}</text>
<text x="${x + 58 + (name.length + 1) * 10.9}" y="${y + 30}" font-family="${MONO}" font-size="17" fill="${pal.project}">${esc(project)}</text>
<text x="${x + 18}" y="${y + 62}" font-family="${MONO}" font-size="17" fill="${pal.accent}">▸ ${esc(w.working)}</text>
${isWaiting ? `<g class="${timed(at.waiting[0] + 0.4, at.waiting[1], 'zoom')}"> <text class="blink" x="${x + 462}" y="${y + 62}" text-anchor="end" font-family="${SANS}" font-size="19" font-weight="700" fill="${pal.waiting}">${esc(w.waitsOnYou)}</text></g>` : ''}
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
    .map((line, i) => `<text x="64" y="${200 + i * 56}" font-size="${isCjk ? 40 : 42}" font-weight="800" fill="${i === w.lost.length - 1 ? page.accent : page.ink}">${esc(line)}</text>`)
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
<text x="${W / 2}" y="262" text-anchor="middle" font-size="64" font-weight="800" fill="${page.ink}">Agent Board</text>
<text x="${W / 2}" y="314" text-anchor="middle" font-size="28" fill="${page.accent}">${esc(w.end)}</text>
</g>
<g class="${timed(at.end[0] + 0.35, LOOP + 0.2)}">
<rect x="${W / 2 - 330}" y="350" width="660" height="60" rx="12" fill="${page.card}" stroke="${pal.accent}" stroke-width="1.8"/>
<text x="${W / 2}" y="388" text-anchor="middle" font-family="${MONO}" font-size="21" fill="${page.ink}">${esc(command)}</text>
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

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
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
<g font-family="${SANS}">
${scenes.join('\n')}
${timeline}
</g>
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
  const w = PROMO[lang]
  const pal = DARK
  const { grid, theme } = paneGrid(lang, 'dark', { opened: [], isAnswered: false })
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
    .map((line, i) => `<text x="72" y="${top + i * lineGap}" font-size="${size}" font-weight="800" fill="${i === w.headline.length - 1 ? pal.accent : '#f7f6f2'}">${esc(line)}</text>`)
    .join('\n')
  const subY = top + (w.headline.length - 1) * lineGap + 26
  const icons = TESTED_ICONS.map((icon, i) => iconTile(icon.name, 72 + i * 58, 459, 44)).join('\n')
  // The pane, and under it the notification that has just come in; neither covers the other.
  const wx = 760
  const wy = 44
  const nx = wx
  const ny = wy + BAR + PAD * 2 + rows * LINE + 18
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img" aria-label="Agent Board: ${esc(w.headline.join(' '))}">
<title>Agent Board</title>
<defs>${brandDefs(1280, 640)}</defs>
<g clip-path="url(#edge)" font-family="${SANS}">
${brandGround(1280, 640)}
${brandMark(72, 70)}
${headline}
${w.sub.map((line, i) => `<text x="72" y="${subY + 24 + i * 33}" font-size="${isCjk ? 23 : 22}" fill="#b9bcc0">${esc(line)}</text>`).join('')}
<text x="72" y="444" font-size="14" font-weight="700" letter-spacing="${isCjk ? 2 : 2.5}" fill="#8b9096">${esc(w.works)}</text>
${icons}
<text x="72" y="572" font-family="${MONO}" font-size="19" fill="#d7d9dc">github.com/<tspan fill="#f7f6f2" font-weight="700">WenyuChiou/agent-board</tspan></text>
<g filter="url(#lift)">${terminal('dark', WORDS[lang].window, body, rows, wx, wy)}</g>
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
// agent's own colour.
const agentIcon = (icon: AgentIcon): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" role="img" aria-label="${esc(icon.name)}">
<title>${esc(icon.name)}</title>
<rect x="0.5" y="0.5" width="47" height="47" rx="10.5" fill="${icon.tile}" stroke="#fff" stroke-opacity="0.22"/>
${glyph(icon, 0, 0, 48)}
</svg>
`

mkdirSync(join(OUT, 'agents'), { recursive: true })
for (const icon of AGENT_ICONS) writeFileSync(join(OUT, 'agents', `${icon.file}.svg`), agentIcon(icon))
for (const lang of LANGS) writeFileSync(join(OUT, `promo-${lang}.svg`), promo(lang))

for (const lang of LANGS) {
  writeFileSync(join(OUT, `tour-${lang}.svg`), tour(lang))
  writeFileSync(join(OUT, `flow-${lang}.svg`), flow(lang))
  writeFileSync(join(PAGES, `dashboard-${lang}.html`), dashboard(lang))
}
console.log(`wrote the tour, flow and promotional card in ${LANGS.length} languages and ${AGENT_ICONS.length} agent icons to ${OUT}, and ${LANGS.length} progress.html pages to ${PAGES}`)
