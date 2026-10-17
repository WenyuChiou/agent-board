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
import { CELL, LINE, MONO, gridSvg, keyBox, layout, rowOf } from './terminal'
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

// The banner, for GitHub's social preview: what it is on the left, the pane on the right.
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

// How it works: who writes progress.md, and what reads it.
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

// The 30-second tour at the top of the README: why (0–10.4 s), what it does (10.4–21 s),
// where it runs and how it looks (21–30 s). One SVG, CSS keyframes only, so GitHub plays it.
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
    answerSub: 'A plugin for Claude Code',
    press: ['Answer right here.', 'No window hunting.'],
    pressSub: ['One click and the agent', 'gets back to work.'],
    hooks: ['Your other agents', 'report in on their own.'],
    hooksSub: ['One command connects them.'],
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
    answerSub: 'Claude Code 外掛',
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
    answerSub: 'Claude Code 插件',
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
  ['Cursor', 'docs-site'],
  ['Grok Build', 'mobile-app'],
]
const HOOKED = ['Claude Code', 'Codex', 'Gemini CLI', 'Cursor', 'OpenCode', 'Grok Build', 'Muse Code']

const ENDED_TITLE: Record<Lang, string> = { en: 'Upgrade to React 19', 'zh-TW': '升級到 React 19', 'zh-CN': '升级到 React 19' }

const tour = (lang: Lang, mode: Mode): string => {
  const W = 1200
  const H = 675
  const LOOP = 30
  const FADE = 0.45
  const w = TOUR[lang]
  const s = STRINGS[lang]
  const page = PAGE[mode]
  const term = TERMINAL[mode]
  const pal = term.palette
  const other: Mode = mode === 'light' ? 'dark' : 'light'
  const isCjk = lang !== 'en'
  const keyframes: string[] = []
  // Visible from `start` to `end` seconds, fading in and out.
  const timed = (start: number, end: number): string => {
    const name = `k${keyframes.length}`
    const p = (sec: number): string => `${Math.max(0, Math.min(100, (sec / LOOP) * 100)).toFixed(2)}%`
    keyframes.push(
      start <= 0
        ? `@keyframes ${name} { 0%, ${p(end - FADE)} { opacity: 1 } ${p(end)}, 100% { opacity: 0 } }`
        : `@keyframes ${name} { 0%, ${p(start)} { opacity: 0 } ${p(start + FADE)}, ${p(end - FADE)} { opacity: 1 } ${p(end)}, 100% { opacity: 0 } }`,
    )
    return `sc" style="animation-name:${name}`
  }

  // Left column: the headline of each moment.
  const head = (lines: string[], sub: string[], start: number, end: number, still = false): string => {
    const size = isCjk ? 40 : 42
    const top = 230 - (lines.length - 2) * 26
    const big = lines.map((line, i) => `<text x="64" y="${top + i * 56}" font-size="${size}" font-weight="700" fill="${page.ink}">${esc(line)}</text>`).join('')
    const small = sub
      .map((line, i) => `<text x="64" y="${top + lines.length * 56 + 18 + i * 30}" font-size="21" fill="${page.muted}">${esc(line)}</text>`)
      .join('')
    return `<g class="${timed(start, end)}"${still ? ' data-still="1"' : ''}>${big}${small}</g>`
  }

  // The pane: a terminal window at the right, scaled up a little; the body switches with the
  // moment, scrolled to the part it is about.
  const VIS = 18
  const SCALE = 1.12
  const winX = W - windowWidth * SCALE - 56
  const winY = 92
  const bodyH = PAD + VIS * LINE + PAD
  const frame1 = paneGrid(lang, mode, { opened: [], isAnswered: false })
  const frame2 = paneGrid(lang, mode, { opened: ['waiting'], isAnswered: false })
  const frame3 = paneGrid(lang, mode, { opened: [], isAnswered: true })
  const endedKey = `acme-web::${ENDED_TITLE[lang]}`
  const frameH = paneGrid(lang, mode, { opened: ['others'], isAnswered: false, expanded: endedKey })
  const frameDark = paneGrid(lang, other, { opened: [], isAnswered: false })
  const body = (grid: typeof frame1, offset: number, start: number, end: number, still = false): string =>
    `<g class="${timed(start, end)}"${still ? ' data-still="1"' : ''}>${gridSvg(grid.grid.slice(offset, offset + VIS + 1), PAD, BAR + PAD, grid.theme)}</g>`
  const ring = (row: number, col: number, span: number, rows: number, start: number, end: number): string =>
    `<rect class="${timed(start, end)}" x="${PAD + col * CELL - 6}" y="${BAR + PAD + row * LINE - 4}" width="${span * CELL + 12}" height="${rows * LINE + 8}" rx="7" fill="none" stroke="${pal.accent}" stroke-width="2.4"/>`
  const windowFrame = (m: Mode, inner: string, cls: string, still = false): string => {
    const t = TERMINAL[m]
    const h = BAR + bodyH
    return `<g class="${cls}"${still ? ' data-still="1"' : ''} transform="translate(${winX.toFixed(1)} ${winY}) scale(${SCALE})">
<rect width="${windowWidth}" height="${h}" rx="12" fill="${t.ground}" stroke="${t.edge}"/>
<path d="M12 0.5h${windowWidth - 24}a11.5 11.5 0 0 1 11.5 11.5v${BAR - 12}h-${windowWidth - 1}v-${BAR - 12}a11.5 11.5 0 0 1 11.5-11.5z" fill="${t.bar}"/>
<line x1="0.5" y1="${BAR}" x2="${windowWidth - 0.5}" y2="${BAR}" stroke="${t.edge}"/>
<g fill="${t.palette.frame}"><circle cx="20" cy="17" r="5"/><circle cx="38" cy="17" r="5"/><circle cx="56" cy="17" r="5"/></g>
<text x="${windowWidth / 2}" y="22" text-anchor="middle" font-family="${MONO}" font-size="12" fill="${t.palette.muted}">${esc(WORDS[lang].window)}</text>
<g clip-path="url(#body)" font-family="${MONO}" font-size="14" style="white-space:pre" xml:space="preserve">${inner}</g>
</g>`
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
  const toast = `<g class="${timed(12.5, 14)}"><rect x="0.5" y="${bandY}" width="${windowWidth - 1}" height="${BAR + bodyH - bandY - 0.5}" fill="${term.ground}"/><line x1="0.5" y1="${bandY}" x2="${windowWidth - 0.5}" y2="${bandY}" stroke="${pal.done}" stroke-width="1.6"/><text x="${PAD}" y="${bandY + 30}" font-weight="700" fill="${pal.done}">✓ ${esc(s.answered(frame1.firstOption))}</text></g>`
  const inner = [
    body(frame1, 0, 6.8, 12.4, true),
    focusTop >= 0 && more !== null ? ring(focusTop, 0, WIDTH, more.row - focusTop - 1, 7.4, 10.4) : '',
    option !== null ? ring(option.row, option.col, option.span, 1, 10.8, 12.4) : '',
    body(frame3, 0, 12.4, 14),
    toast,
    body(frame2, waitingAt, 14, 17.5),
    body(frameH, endedAt, 17.5, 21),
    handoffRow >= 0 ? ring(handoffRow - endedAt, 0, WIDTH, handoffRows, 18.2, 21) : '',
    take !== null ? ring(take.row - endedAt, take.col, take.span, 1, 19.2, 21) : '',
    body(frame1, 0, 21, 24.8),
  ].join('\n')
  const darkInner = gridSvg(frameDark.grid.slice(0, VIS + 1), PAD, BAR + PAD, frameDark.theme)

  // 0–6.8 s: five agents, each in its own window; two of them are waiting on you.
  const cards = AGENTS.map(([name, project], i) => {
    const y = 108 + i * 90
    const x = winX + 24
    const isWaiting = i === 1
    return `<g class="${timed(0.3 + i * 0.35, 6.8)}">
<rect x="${x}" y="${y}" width="420" height="70" rx="12" fill="${page.card}" stroke="${page.line}"/>
<g fill="${pal.frame}"><circle cx="${x + 18}" cy="${y + 18}" r="4"/><circle cx="${x + 32}" cy="${y + 18}" r="4"/><circle cx="${x + 46}" cy="${y + 18}" r="4"/></g>
<text x="${x + 64}" y="${y + 23}" font-family="${MONO}" font-size="15" font-weight="700" fill="${page.ink}">${esc(name)}</text>
<text x="${x + 64 + (name.length + 1) * 9.2}" y="${y + 23}" font-family="${MONO}" font-size="14" fill="${pal.project}">${esc(project)}</text>
<text x="${x + 18}" y="${y + 52}" font-family="${MONO}" font-size="14" fill="${pal.accent}">▸ ${esc(w.working)}</text>
${isWaiting ? `<g class="${timed(3.8, 6.8)}"><text class="blink" x="${x + 404}" y="${y + 52}" text-anchor="end" font-family="${SANS}" font-size="15" font-weight="700" fill="${pal.waiting}">${esc(w.waitsOnYou)}</text></g>` : ''}
</g>`
  }).join('\n')

  // 14–17.5 s: the agents that report through their hooks.
  const chips = HOOKED.map((name, i) => {
    const col = i % 2
    const row = Math.floor(i / 2)
    const x = 64 + col * 230
    const y = 418 + row * 44
    return `<g class="${timed(14.3 + i * 0.18, 17.5)}"><rect x="${x}" y="${y}" width="214" height="34" rx="17" fill="${page.card}" stroke="${page.line}"/><text x="${x + 16}" y="${y + 23}" font-size="16" fill="${pal.done}">✓</text><text x="${x + 38}" y="${y + 23}" font-size="16" fill="${page.ink}">${esc(name)}</text></g>`
  }).join('\n')

  // 17.5–21 s: nothing lost.
  const lost = `<g class="${timed(17.5, 21)}">${w.lost
    .map((line, i) => `<text x="64" y="${200 + i * 56}" font-size="${isCjk ? 40 : 42}" font-weight="700" fill="${page.ink}">${esc(line)}</text>`)
    .join('')}${w.lostLines
    .map((line, i) => `<text x="64" y="${330 + i * 46}" font-size="21" fill="${pal.done}">✓</text><text x="96" y="${330 + i * 46}" font-size="21" fill="${page.ink}">${esc(line)}</text>`)
    .join('')}</g>`

  // 21–24.6 s: where it runs.
  const surfaces = `<g class="${timed(21.3, 24.6)}">${w.surfaces
    .map((name, i) => {
      const x = 64 + (i % 2) * 250
      const y = 368 + Math.floor(i / 2) * 56
      return `<rect x="${x}" y="${y}" width="234" height="42" rx="10" fill="${page.card}" stroke="${page.line}"/><text x="${x + 117}" y="${y + 27}" text-anchor="middle" font-size="18" fill="${page.ink}">${esc(name)}</text>`
    })
    .join('')}<text x="64" y="512" font-size="16" fill="${page.muted}">${esc(w.systems)}</text></g>`

  // 24.6–27.6 s: the colours, light and dark, with their names; the pane turns to the other set.
  const roles = ['accent', 'done', 'waiting', 'running', 'soon', 'alert'] as const
  const swatches = `<g class="${timed(24.8, 27.6)}">${roles
    .map((role, i) => {
      const x = 64 + (i % 3) * 186
      const y = 352 + Math.floor(i / 3) * 94
      const [lightName, darkName] = w.names[i] ?? ['', '']
      return `<circle cx="${x + 14}" cy="${y}" r="14" fill="${LIGHT[role]}"/><circle cx="${x + 44}" cy="${y}" r="14" fill="${DARK[role]}" stroke="${page.line}"/>` +
        `<text x="${x}" y="${y + 36}" font-size="14" fill="${page.ink}">${esc(lightName)}</text><text x="${x}" y="${y + 56}" font-size="14" fill="${page.muted}">${esc(darkName)}</text>`
    })
    .join('')}<text x="64" y="${352 + 2 * 94 - 4}" font-size="16" fill="${page.muted}">${esc(w.coloursSub)}</text></g>`

  // 27.6–30 s: the end card.
  const command = 'claude plugin install project-progress@claude-progress-pane'
  const endCard = `<g class="${timed(27.6, 30.2)}">
<text x="${W / 2}" y="268" text-anchor="middle" font-size="54" font-weight="700" fill="${page.ink}">claude-progress-pane</text>
<text x="${W / 2}" y="318" text-anchor="middle" font-size="24" fill="${page.muted}">${esc(w.end)}</text>
<rect x="${W / 2 - 330}" y="356" width="660" height="52" rx="10" fill="${page.card}" stroke="${pal.accent}" stroke-width="1.6"/>
<text x="${W / 2}" y="389" text-anchor="middle" font-family="${MONO}" font-size="18" fill="${page.ink}">${esc(command)}</text>
</g>`

  // The timeline along the bottom: the three parts, and how far the tour has come.
  const track = { x: 64, y: 626, w: W - 128 }
  const marks: Array<[number, string]> = [
    [0, w.timeline[0]],
    [10.4, w.timeline[1]],
    [21, w.timeline[2]],
  ]
  const timeline = `<g>
<rect x="${track.x}" y="${track.y}" width="${track.w}" height="4" rx="2" fill="${page.line}"/>
<rect class="bar" x="${track.x}" y="${track.y}" width="${track.w}" height="4" rx="2" fill="${pal.accent}"/>
${marks.map(([at, label]) => `<text x="${track.x + (at / LOOP) * track.w}" y="${track.y - 12}" font-size="14" fill="${page.muted}">${esc(label)}</text>`).join('')}
</g>`

  const scenes = [
    head(w.why, [], 0, 3.4),
    head(w.waiting, w.waitingSub, 3.4, 6.8),
    cards,
    head(w.answer, [w.answerSub], 6.8, 10.4, true),
    head(w.press, w.pressSub, 10.4, 14),
    head(w.hooks, w.hooksSub, 14, 17.5),
    chips,
    lost,
    head(w.runs, [], 21, 24.6),
    surfaces,
    head(w.colours, [], 24.6, 27.6),
    swatches,
    windowFrame(mode, inner, `win ${timed(6.8, 24.8)}`, true),
    windowFrame(other, darkInner, `win ${timed(24.6, 27.8)}`),
    endCard,
  ]
  const label = [w.why, w.answer, w.hooks, w.runs, w.colours].map(lines => lines.join(' ')).join(' / ')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
<title>claude-progress-pane: ${esc(w.end)}</title>
<defs><clipPath id="body"><rect x="0" y="${BAR}" width="${windowWidth}" height="${bodyH}"/></clipPath></defs>
<style>
.sc { opacity: 0; animation-duration: ${LOOP}s; animation-iteration-count: infinite; animation-timing-function: linear; }
.bar { transform-box: fill-box; transform-origin: 0 50%; animation: grow ${LOOP}s linear infinite; }
.blink { animation: blink 0.9s steps(2, jump-none) infinite; }
@keyframes grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
@keyframes blink { from { opacity: 1 } to { opacity: 0.25 } }
${keyframes.join('\n')}
@media (prefers-reduced-motion: reduce) {
  .sc, .bar, .blink { animation: none; }
  .sc { opacity: 0; }
  [data-still] { opacity: 1; }
  .bar { transform: none; }
}
</style>
<rect width="${W}" height="${H}" rx="18" fill="${page.ground}"/>
<text x="64" y="70" font-family="${SANS}" font-size="15" font-weight="600" letter-spacing="2.5" fill="${page.muted}">CLAUDE-PROGRESS-PANE</text>
<g font-family="${SANS}">
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

for (const lang of LANGS) {
  for (const mode of ['light', 'dark'] as const) {
    writeFileSync(join(OUT, `tour-${lang}-${mode}.svg`), tour(lang, mode))
    writeFileSync(join(OUT, `hero-${lang}-${mode}.svg`), hero(lang, mode))
    writeFileSync(join(OUT, `flow-${lang}-${mode}.svg`), flow(lang, mode))
  }
  writeFileSync(join(PAGES, `dashboard-${lang}.html`), dashboard(lang))
}
console.log(`wrote ${LANGS.length * 6} SVGs to ${OUT} and ${LANGS.length} progress.html pages to ${PAGES}`)
