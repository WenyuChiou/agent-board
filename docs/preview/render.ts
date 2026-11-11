// Draws the README images from the board's own code: drawPane's tree and boardScreen's lines,
// laid out like a terminal (terminal.ts), written as SVG. One set per language.
//   bun docs/preview/render.ts          (run `claude --plugin-dir .` once first, for the JSX setup)
//   bun docs/preview/render.ts cover-en (only the files whose names start with cover-en)
// Writes docs/images/{tour,flow,promo,answer,places}-<lang>.svg, docs/images/board/<agent>-<lang>-<light|dark>.svg,
// docs/images/cover-<lang>-dark.svg (the README's animated cover), docs/images/agents/<agent>.svg,
// docs/images/agents/chip-<agent>.svg (the README's Integrations strip; `bun docs/preview/render.ts chip-`),
import { mkdirSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { upsertAutoBlock } from '../../hooks/blocks'
import { boardItems, boardScreen, emptyBoardState } from '../../hooks/board'
import { countDay, journalLine } from '../../hooks/journal'
import { applyTaskCreate, applyTaskUpdate, emptyMirror } from '../../hooks/mirror'
import { BOARD_PATH, CORNER_LIGHT } from '../../hooks/page-look'
import { DARK, LIGHT, PAGE_DARK, PAGE_LIGHT } from '../../hooks/palette'
import type { Palette } from '../../hooks/palette'
import { parseProgress } from '../../hooks/parse'
import { emptyQuestions } from '../../hooks/questions'
import { STRINGS } from '../../hooks/strings'
import type { Strings } from '../../hooks/i18n'
import { buildView } from '../../hooks/view'
import { CLI_FILES, NOW, PAGE, SAMPLES, SESSION, MIN } from './samples'
import type { PageAgent, PageSample, PageTask } from './samples'
import { AGENT_ICONS, TESTED_ICONS } from './icons'
import type { AgentIcon } from './icons'
import { LOCKUP, WORDMARK, lockupBody } from './brand'
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
mkdirSync(OUT, { recursive: true })
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

// The title of the terminal window the tour shows the pane in.
const WORDS: Record<Lang, { window: string }> = {
  en: { window: 'claude  —  acme-web' },
  'zh-TW': { window: 'claude  —  acme-web' },
  'zh-CN': { window: 'claude  —  acme-web' },
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

// The tour's own look (it is not in a README): a deep blue ground with a faint dot grid and a teal
// glow, dark cards, the board mark, and each agent's own tile. The README's pictures use LOOK below.
const BRAND = { ground: '#0c1116', card: '#151b21', line: '#29313a', ink: '#f2f1ec', muted: '#9aa0a6', accent: DARK.accent }

const brandDefs = (w: number, h: number, glow: [number, number] = [0.78, 0.35]): string =>
  `<linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f1a24"/><stop offset="0.55" stop-color="#0c1116"/><stop offset="1" stop-color="#090b0d"/></linearGradient>
<radialGradient id="glow" cx="${glow[0]}" cy="${glow[1]}" r="0.55"><stop offset="0" stop-color="${BRAND.accent}" stop-opacity="0.2"/><stop offset="1" stop-color="${BRAND.accent}" stop-opacity="0"/></radialGradient>
<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#fff" fill-opacity="0.05"/></pattern>
<filter id="lift" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.55"/></filter>
<clipPath id="edge"><rect width="${w}" height="${h}" rx="24"/></clipPath>`

const brandGround = (w: number, h: number): string =>
  `<rect width="${w}" height="${h}" fill="url(#sky)"/><rect width="${w}" height="${h}" fill="url(#glow)"/><rect width="${w}" height="${h}" fill="url(#dots)"/>`

// The Corner Light, `size` square at x, y, in the dark ground's ink with its light amber; or, with a name,
// the name "Agent Board" with the light between its words, `size` tall from its top to the foot of its g.
const brandMark = (x: number, y: number, size = 34, hasName = true): string => {
  if (!hasName) return `<g transform="translate(${x} ${y}) scale(${num(size / 64)})"><path fill="${BRAND.ink}" d="${BOARD_PATH}"/><circle fill="${PAGE_DARK.brand}" cx="${CORNER_LIGHT.cx}" cy="${CORNER_LIGHT.cy}" r="${CORNER_LIGHT.r}"/></g>`
  const k = size / LOCKUP.height
  return `<g transform="translate(${num(x - LOCKUP.left * k)} ${num(y - LOCKUP.top * k)}) scale(${num(k)})">${lockupBody(BRAND.ink, PAGE_DARK.brand)}</g>`
}

// docs/images/brand/: the lockup for a light and for a dark ground; the lockup and the mark alone that
// follow the reader's theme through their own style (the README's title is that lockup: GitHub gives
// an SVG picture its page's theme). Paths and circles only, on a transparent ground.
const lockupOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(LOCKUP.width)}" height="${Math.ceil(LOCKUP.height)}" viewBox="${LOCKUP.left} ${LOCKUP.top} ${LOCKUP.width} ${LOCKUP.height}" role="img" aria-label="Agent Board"><title>Agent Board</title>`
const brandLockup = (mode: 'light' | 'dark'): string => {
  const page = mode === 'light' ? PAGE_LIGHT : PAGE_DARK
  return `${lockupOpen}${lockupBody(page.ink, page.brand)}</svg>\n`
}
const brandLogo = (): string =>
  `${lockupOpen}<style>.ink{fill:${PAGE_LIGHT.ink}}.brand{fill:${PAGE_LIGHT.brand}}@media (prefers-color-scheme:dark){.ink{fill:${PAGE_DARK.ink}}.brand{fill:${PAGE_DARK.brand}}}</style>${lockupBody('.ink', '.brand')}</svg>\n`
const brandMarkFile = (): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="Agent Board"><title>Agent Board</title><style>.ink{fill:${PAGE_LIGHT.ink}}.brand{fill:${PAGE_LIGHT.brand}}@media (prefers-color-scheme:dark){.ink{fill:${PAGE_DARK.ink}}.brand{fill:${PAGE_DARK.brand}}}</style><path class="ink" d="${BOARD_PATH}"/><circle class="brand" cx="${CORNER_LIGHT.cx}" cy="${CORNER_LIGHT.cy}" r="${CORNER_LIGHT.r}"/></svg>\n`

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
// A picture that shows the same tile many times (the cover) sets `tileSink`: each tile is then drawn
// once in the picture's defs and used where it is wanted, which keeps the file small.
let tileSink: Set<string> | null = null
const tileId = (name: string): string => `tile-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
const iconTile = (name: string, x: number, y: number, size: number): string => {
  const icon = AGENT_ICONS.find(one => one.name === name)
  if (icon === undefined) throw new Error(`No tile for the agent "${name}" in AGENT_ICONS`)
  if (tileSink !== null) {
    tileSink.add(name)
    return `<use href="#${tileId(name)}" transform="translate(${num(Number(x))} ${num(Number(y))}) scale(${num(size / 48)})"/>`
  }
  return tileDrawn(name, x, y, size)
}
const tileDrawn = (name: string, x: number, y: number, size: number): string => {
  const icon = AGENT_ICONS.find(one => one.name === name)
  if (icon === undefined) throw new Error(`No tile for the agent "${name}" in AGENT_ICONS`)
  const rim = isDark(icon.tile) ? `<rect x="${x + 0.5}" y="${y + 0.5}" width="${size - 1}" height="${size - 1}" rx="${size * 0.23 - 0.5}" fill="none" stroke="#fff" stroke-opacity="0.22"/>` : ''
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${size * 0.23}" fill="${icon.tile}"/>${rim}${glyph(icon, x, y, size)}`
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

// The terminal board as it runs beside a CLI agent, with that agent's question
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
  const file = CLI_FILES[lang]?.(agent)
  if (file === undefined) throw new Error(`there is no CLI sample for ${lang}`)
  // Every step the sample ticks was ticked this morning, so they are what "done today" counts.
  const view = buildView(parseProgress(file), [], null, NOW, (file.match(/^- \[x\] /gm) ?? []).length, {}, s)
  const items = boardItems(view, [], false, false)
  const at = items.findIndex(item => item.type === 'ask' && item.ask.agent === agent)
  if (at < 0) throw new Error(`the CLI sample for ${lang} has no question from ${agent}`)
  // Show the queue with the question visible; the page example shows how to send a reply.
  const row = items.findIndex(item => item.type === 'row')
  if (row < 0) throw new Error(`the CLI sample for ${lang} has no task row`)
  const state = { ...emptyBoardState, selected: row, key: items[row]?.key ?? null }
  // The window is as narrow as it can be while every line still shows whole: the board cuts an
  // indented line a little before the window's edge, so the widest line alone is not enough.
  // The ages sit at the right edge, so lines are compared with the gap before them closed.
  const whole = shapeOf(boardScreen(view, [], state, s, { width: 400, isColor: false }))
  let cols = Math.max(...whole.split('\n').map(widthCells))
  while (shapeOf(boardScreen(view, [], state, s, { width: cols, isColor: false })) !== whole) cols++
  const grid = ansiGrid(boardScreen(view, [], state, s, { width: cols, isColor: true, depth: 'truecolor', theme: mode }), t.palette, mode)
  const theme: Theme = { ground: t.ground, ink: t.ink, edge: t.edge, muted: t.palette.muted, accent: t.palette.accent, frame: t.palette.frame }
  const title = 'agent-board'
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

// The README's pictures share the board page's own dark look (PAGE_DARK in hooks/palette.ts): its
// near-black ground, its surfaces and lines, and its ink, with a soft light from above and a fine
// dot grid that fades out round it. Amber, the page's brand colour, means one thing only: something
// needs you. Everything calm is ink and greys; green says only that a message arrived.
const LOOK = {
  ground: PAGE_DARK.ground, surface: PAGE_DARK.surface, inset: PAGE_DARK.inset, line: PAGE_DARK.line, strong: PAGE_DARK['line-strong'],
  ink: PAGE_DARK.ink, muted: DARK.muted, amber: PAGE_DARK.brand, onAmber: PAGE_DARK['on-accent'], alive: DARK.done,
}

// A rough width of a line at `size`, to fit a box round it or set the next thing after it. The
// fonts are not measured here; each picture is checked by eye in every language.
const isWide = (ch: string): boolean => ch.charCodeAt(0) > 0x2e80
const textW = (text: string, size: number, weight = 400): number =>
  [...text].reduce((n, ch) => n + size * (isWide(ch) ? 1 : /[A-Z0-9]/.test(ch) ? 0.66 : /[iljtfr.,:;'’ |!()]/.test(ch) ? 0.32 : weight >= 600 ? 0.58 : 0.55), 0)

const lookDefs = (w: number, h: number, lamp: [number, number] = [0.7, 0.24]): string =>
  `<radialGradient id="lamp" cx="${lamp[0]}" cy="${lamp[1]}" r="0.8"><stop offset="0" stop-color="${LOOK.ink}" stop-opacity="0.085"/><stop offset="0.45" stop-color="${LOOK.ink}" stop-opacity="0.025"/><stop offset="1" stop-color="${LOOK.ink}" stop-opacity="0"/></radialGradient>
<radialGradient id="shade" cx="0.5" cy="0.4" r="0.85"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></radialGradient>
<radialGradient id="reach" cx="${lamp[0]}" cy="${lamp[1]}" r="0.7"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
<mask id="near"><rect width="${w}" height="${h}" fill="url(#reach)"/></mask>
<pattern id="grid" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="${LOOK.ink}" fill-opacity="0.1"/></pattern>
<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${LOOK.ink}" stop-opacity="0.22"/><stop offset="1" stop-color="${LOOK.ink}" stop-opacity="0.06"/></linearGradient>
<filter id="drop" x="-15%" y="-15%" width="130%" height="140%"><feDropShadow dx="0" dy="22" stdDeviation="26" flood-color="#000" flood-opacity="0.6"/></filter>
<filter id="soft" x="-15%" y="-20%" width="130%" height="160%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000" flood-opacity="0.4"/></filter>
<clipPath id="edge"><rect width="${w}" height="${h}" rx="20"/></clipPath>`

const lookGround = (w: number, h: number): string =>
  `<rect width="${w}" height="${h}" fill="${LOOK.ground}"/><rect width="${w}" height="${h}" fill="url(#lamp)"/><rect width="${w}" height="${h}" fill="url(#grid)" mask="url(#near)"/><rect width="${w}" height="${h}" fill="url(#shade)"/>`

// The name with the board's light between its words (brand.ts), `height` tall from its top, its light
// in `light`; `over` is drawn in the name's own units, on the light (WORDMARK.light).
const lockupAt = (x: number, y: number, height: number, light: string = LOOK.ink, over = ''): string => {
  const k = height / LOCKUP.height
  return `<g transform="translate(${num(x - LOCKUP.left * k)} ${num(y - LOCKUP.top * k)}) scale(${Math.round(k * 10000) / 10000})">${lockupBody(LOOK.ink, light)}${over}</g>`
}

// The Corner Light alone, `size` square: the board in ink and its light in `light`.
const cornerMark = (x: number, y: number, size: number, light: string = LOOK.ink): string =>
  `<g transform="translate(${num(x)} ${num(y)}) scale(${num(size / 64)})"><path fill="${LOOK.ink}" d="${BOARD_PATH}"/><circle fill="${light}" cx="${CORNER_LIGHT.cx}" cy="${CORNER_LIGHT.cy}" r="${CORNER_LIGHT.r}"/></g>`

// A small label over a picture: the mark, then the words in spaced capitals (Chinese is not spaced
// out as far, and has no capitals).
const eyebrow = (x: number, y: number, text: string, lang: Lang): string =>
  `${cornerMark(x, y - 13, 16)}<text x="${x + 26}" y="${y}" font-size="13" font-weight="600" letter-spacing="${lang === 'en' ? '0.16em' : '0.1em'}" fill="${LOOK.muted}">${esc(lang === 'en' ? text.toUpperCase() : text)}</text>`

// A browser window `w` by `h` at x, y, its one tab named `tab` with the page's icon, and `page` drawn
// under the bar (40 high) and clipped to the window. `id` names its clip.
const BAR_H = 40
const browser = (id: string, x: number, y: number, w: number, h: number, tab: string, page: string, isShadow = true): string =>
  `<g transform="translate(${num(x)} ${num(y)})">
<rect width="${w}" height="${h}" rx="14" fill="${LOOK.ground}"${isShadow ? ' filter="url(#drop)"' : ''}/>
<clipPath id="${id}"><rect width="${w}" height="${h}" rx="14"/></clipPath>
<g clip-path="url(#${id})">
<rect width="${w}" height="${BAR_H}" fill="${LOOK.surface}"/>
<g fill="${LOOK.strong}"><circle cx="20" cy="20" r="5"/><circle cx="37" cy="20" r="5"/><circle cx="54" cy="20" r="5"/></g>
<path d="M76 ${BAR_H}v-24a8 8 0 0 1 8-8h${Math.min(260, w - 120)}a8 8 0 0 1 8 8v24z" fill="${LOOK.ground}"/>
${tab}
<g transform="translate(0 ${BAR_H})">${page}</g>
</g>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="13.5" fill="none" stroke="url(#rim)"/>
</g>`
// The tab's icon and title: the page's own (`faviconLink`, `pgTabTitle`), lit while something needs you.
const tabFace = (title: string, isLit: boolean): string =>
  `${cornerMark(90, 17, 14, isLit ? LOOK.amber : LOOK.ink)}<text x="112" y="29" font-size="12.5" fill="${LOOK.ink}">${esc(title)}</text>`

// The page drawn in SVG, in its own sizes (hooks/page-look.ts and the page's stylesheet): the head
// with its logo, the row of agent icons, then Needs you and Working now. `PG` holds the heights.
const PG = { head: 48, chips: 46, top: 22, heading: 30, row: 54, rowGap: 8, flag: 30, card: 132, sectionGap: 22, side: 24 }
const PAGE_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode' }
const pageHead = (pw: number, light = LOOK.ink, over = ''): string =>
  `${lockupAt(PG.side, 16, 17, light, over)}<line x1="0" y1="${PG.head - 0.5}" x2="${pw}" y2="${PG.head - 0.5}" stroke="${LOOK.line}"/>`
// One agent's icon in the row, with the page's presence dot (green: connected) at its corner.
const chipAt = (agent: PageAgent, i: number): string => {
  const x = PG.side + i * 42
  const y = PG.head + 9
  return `${iconTile(PAGE_NAMES[agent], x, y, 28)}<circle cx="${x + 26}" cy="${y + 26}" r="5.5" fill="${LOOK.alive}" stroke="${LOOK.ground}" stroke-width="2.5"/>`
}
// The page's count badge on an icon: how many questions wait on you from that agent.
const badgeAt = (i: number, n: number): string => {
  const x = PG.side + i * 42 + 22
  const y = PG.head + 3
  return `<rect x="${x}" y="${y}" width="18" height="18" rx="9" fill="${LOOK.amber}" stroke="${LOOK.ground}" stroke-width="2"/><text x="${x + 9}" y="${y + 13}" text-anchor="middle" font-size="11" font-weight="700" fill="${LOOK.onAmber}">${n}</text>`
}
const chipsLine = (pw: number): string => `<line x1="0" y1="${PG.head + PG.chips - 0.5}" x2="${pw}" y2="${PG.head + PG.chips - 0.5}" stroke="${LOOK.line}"/>`
const contentTop = PG.head + PG.chips + PG.top
const sectionHead = (text: string, y: number): string => `<text x="${PG.side}" y="${y + 18}" font-size="15" font-weight="600" fill="${LOOK.ink}">${esc(text)}</text>`

// A task row: the agent's icon, the title, who and when at the right, then the step it is on (or
// `note`, a line the page wrote) and a bar of its steps.
const rowFrame = (s: Strings, agent: string, task: { title: string }, x: number, y: number, w: number): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${PG.row}" rx="10" fill="${LOOK.surface}" stroke="${LOOK.line}"/>
${iconTile(PAGE_NAMES[agent] ?? agent, x + 14, y + 13, 28)}
<text x="${x + 54}" y="${y + 23}" font-size="15" font-weight="600" fill="${LOOK.ink}">${esc(task.title)}</text>
<text x="${x + w - 16}" y="${y + 22}" text-anchor="end" font-size="12.5" fill="${LOOK.muted}">${esc(PAGE_NAMES[agent] ?? agent)} · ${esc(s.justNow)}</text>`
const rowState = (task: { steps: string[] }, done: number, x: number, y: number, w: number, note?: string): string => {
  const total = task.steps.length
  const barW = total * 18 - 4
  const barX = x + w - 16 - barW
  const bar = task.steps.map((_, i) => `<rect x="${barX + i * 18}" y="${y + 36}" width="14" height="4" rx="2" fill="${LOOK.ink}" fill-opacity="${i < done ? 0.6 : i === done ? 1 : 0.14}"/>`).join('')
  const line = note !== undefined
    ? `<text x="${x + 54}" y="${y + 43}" font-size="13"><tspan font-weight="700" fill="${LOOK.alive}">✓</tspan><tspan dx="6" fill="${LOOK.ink}">${esc(note)}</tspan></text>`
    : `<path d="M${x + 55} ${y + 34}l5.5 4l-5.5 4z" fill="${LOOK.ink}"/><text x="${x + 66}" y="${y + 43}" font-size="13" fill="${LOOK.muted}">${esc(task.steps[done] ?? '')}</text>`
  return `<rect x="${x + 50}" y="${y + 29}" width="${w - 64}" height="19" fill="${LOOK.surface}"/>${line}${bar}<text x="${barX - 8}" y="${y + 42}" text-anchor="end" font-size="12" fill="${LOOK.muted}">${done}/${total}</text>`
}

// Needs you: the amber flag with its count, then the raised sheet with the agent's card.
const needsFlag = (s: Strings, x: number, y: number, n: number, k = 1): string => {
  if (k !== 1) return `<g transform="translate(${num(x)} ${num(y)}) scale(${k})">${needsFlag(s, 0, 0, n)}</g>`
  const words = textW(s.pgNeeds, 14, 600)
  const fw = 12 + words + 10 + 10 + 14
  return `<path d="M${x} ${y + 6}a6 6 0 0 1 6 -6h${fw - 6}l-8 ${PG.flag / 2}l8 ${PG.flag / 2}h-${fw}z" fill="${LOOK.amber}"/><text x="${x + 12}" y="${y + 20}" font-size="14" font-weight="600" fill="${LOOK.onAmber}">${esc(s.pgNeeds)}<tspan dx="8" font-weight="700">${n}</tspan></text>`
}
type CardParts = { sheet: string; answers: string; picked: string; receipt: string; pick: [number, number]; send: [number, number] }
const needsCard = (s: Strings, sample: PageSample, x: number, y: number, w: number, question = 20): CardParts => {
  const top = y + PG.flag
  const h = PG.card
  const sheet = `<path d="M${x} ${top}h${w - 10}a10 10 0 0 1 10 10v${h - 20}a10 10 0 0 1 -10 10h-${w - 20}a10 10 0 0 1 -10 -10z" fill="${LOOK.surface}" stroke="${LOOK.strong}"/>
${iconTile('Claude Code', x + 16, top + 18, 24)}
<text x="${x + 52}" y="${top + 34}" font-size="13"><tspan font-weight="600" fill="${LOOK.ink}">Claude Code</tspan><tspan fill="${LOOK.muted}"> · ${esc(sample.tasks.claude.project)} · ${esc(s.justNow)}</tspan></text>
<text x="${x + 52}" y="${top + 66}" font-size="${num(question)}" font-weight="600" fill="${LOOK.ink}">${esc(sample.question)}</text>`
  const by = top + 82
  const widths = sample.options.map(option => Math.round(textW(option, 14) + 30))
  const xs = [x + 52, x + 52 + (widths[0] ?? 0) + 8]
  const button = (option: string, i: number, isPicked: boolean): string =>
    `<rect x="${xs[i]}" y="${by}" width="${widths[i]}" height="36" rx="10" fill="${isPicked ? LOOK.inset : LOOK.surface}" stroke="${LOOK.ink}" stroke-opacity="${isPicked ? 1 : 0.5}"${isPicked ? ' stroke-width="1.5"' : ''}/><text x="${num((xs[i] ?? 0) + (widths[i] ?? 0) / 2)}" y="${by + 23}" text-anchor="middle" font-size="14" fill="${LOOK.ink}">${esc(option)}</text>`
  const sendX = x + w - 16 - 36
  const sendButton = (isReady: boolean): string => `<rect x="${sendX}" y="${by}" width="36" height="36" rx="10" fill="${LOOK.ink}" fill-opacity="${isReady ? 1 : 0.35}"/><path d="M${sendX + 18} ${by + 26}v-15m-6 6l6 -6l6 6" fill="none" stroke="${LOOK.surface}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
  const answers = `${sample.options.map((option, i) => button(option, i, false)).join('')}${sendButton(false)}`
  const picked = `${button(sample.options[0] ?? '', 0, true)}${sendButton(true)}`
  const receipt = `<rect x="${x + 40}" y="${by - 2}" width="${w - 52}" height="40" fill="${LOOK.surface}"/><text x="${x + 52}" y="${by + 23}" font-size="14"><tspan font-weight="700" fill="${LOOK.alive}">✓</tspan><tspan dx="7" fill="${LOOK.ink}">${esc(s.claudeDelivered)}</tspan></text>`
  return { sheet, answers, picked, receipt, pick: [(xs[0] ?? 0) + (widths[0] ?? 0) / 2, by + 22], send: [sendX + 18, by + 22] }
}

// Where Working now's rows sit while all is calm (A: Codex, Antigravity, Claude Code, OpenCode) and
// while Claude Code asks (B: its card above, the other three under Working now).
const ORDER_A: PageAgent[] = ['codex', 'antigravity', 'claude', 'opencode']
const ORDER_B: PageAgent[] = ['codex', 'antigravity', 'opencode']
const rowYA = (agent: PageAgent): number => contentTop + PG.heading + ORDER_A.indexOf(agent) * (PG.row + PG.rowGap)
const headYB = contentTop + PG.flag + PG.card + PG.sectionGap
const rowYB = (agent: PageAgent): number => headYB + PG.heading + ORDER_B.indexOf(agent) * (PG.row + PG.rowGap)

// The page still, `pw` wide, while Claude Code's question waits (for the promotional card and the
// places picture): the head lit, the icons with Claude Code's badge, its card, and the others working.
const DONE_ASKING: Record<PageAgent, number> = { claude: 2, codex: 3, antigravity: 2, opencode: 1 }
const pageAsking = (lang: Lang, pw: number): string => {
  const s = STRINGS[lang]
  const sample = PAGE[lang] as PageSample
  const card = needsCard(s, sample, PG.side, contentTop, pw - PG.side * 2)
  const rows = ORDER_B.map(agent => `${rowFrame(s, agent, sample.tasks[agent], PG.side, rowYB(agent), pw - PG.side * 2)}${rowState(sample.tasks[agent], DONE_ASKING[agent], PG.side, rowYB(agent), pw - PG.side * 2)}`).join('\n')
  return `${pageHead(pw, LOOK.amber)}
${(['claude', 'codex', 'antigravity', 'opencode'] as PageAgent[]).map((agent, i) => chipAt(agent, i)).join('')}${badgeAt(0, 1)}${chipsLine(pw)}
${needsFlag(s, PG.side, contentTop, 1)}
<g filter="url(#soft)">${card.sheet}</g>${card.answers}
${sectionHead(s.pgWorking, headYB)}
${rows}`
}

// The board while Claude Code's question waits, as the cover shows it in scene 4 and the still and
// the social card hold it: the flag a size up, the card at 1.2 with its question at 28 px, and the
// other agents' rows under Working now.
const ASKING = { card: 1.2, flag: 1.15, question: 28 / 1.2 }
const ASK_CARD_TOP = contentTop + PG.flag * ASKING.flag
const ASK_CARD_H = Math.round(PG.card * ASKING.card)
const ASK_HEAD_Y = ASK_CARD_TOP + ASK_CARD_H + PG.sectionGap
const askRowY = (n: number): number => ASK_HEAD_Y + PG.heading + n * (PG.row + PG.rowGap)
const askingPage = (lang: Lang, pw: number, chipOf: (name: string, i: number) => string): string => {
  const s = STRINGS[lang]
  const sample = PAGE[lang] as PageSample
  const rowW = pw - PG.side * 2
  const card = needsCard(s, sample, 0, -PG.flag, rowW / ASKING.card, ASKING.question)
  const rows = coverRows(lang).filter(row => row.name !== 'Claude Code').map((row, i) => {
    const y = askRowY(i)
    return `${rowFrame(s, row.name, row.task, PG.side, y, rowW)}${rowState(row.task, row.start, PG.side, y, rowW)}`
  }).join('\n')
  return `${pageHead(pw, LOOK.amber)}
${LIVE_AGENTS.map(chipOf).join('')}${badgeAt(0, 1)}${chipsLine(pw)}
${needsFlag(s, PG.side, contentTop, 1, ASKING.flag)}
<g transform="translate(${PG.side} ${num(ASK_CARD_TOP)}) scale(${ASKING.card})"><g filter="url(#soft)">${card.sheet}</g>${card.answers}</g>
${sectionHead(s.pgWorking, ASK_HEAD_Y)}
${rows}`
}

// The README's cover, a 40 s loop in seven captioned scenes (1280 x 720). The words sit at the left,
// the picture at the right. 1 asks the question every person who runs several agents has: which
// one is waiting on you? 2 shows one agent stopped on a question while you were in another window.
// 3 names the product in one sentence, and the three windows become rows of the board's page. 4 a
// question jumps to the top. 5 it is answered from the page. 6 one command starts it. 7 closes on
// the sentence again, with the calm board. The screen is the board's page, drawn from the page's
// look and words (pgNeeds, pgWorking, pgTabTitle, claudeDelivered). The logo at the top left is
// ink while all is calm, turns amber while Claude Code asks, as the page's logo does (is-waiting),
// and goes back to ink once the answer is sent. Amber means one thing in the whole picture:
// something is waiting on you. CSS keyframes only, so GitHub plays it in an <img>; with reduced
// motion, or a viewer that plays no animation, scene 7 shows still (`.last`). The loop turns by a
// cross-fade from scene 7 back to scene 1, which is already fully drawn at 0 s.
const COVER_LOOP = 40
const COVER_SCENES = [0, 4, 9, 15, 22, 28, 33]
// Seconds: the three windows turn into rows, the question arrives, the pointer's way to an answer
// and to Send, the answer delivered, Needs you folding away, and the command typed in scene 6.
// The question arrives in order: the waiting row goes (ask), the other rows move down (ask + 0.2), then
// the flag, the card and the heading fade into the space that is empty (show). The fold goes back in
// the same order: flag and card leave together, the rows move up, the answered row comes back.
const COVER_T = { morph: 9, ask: 15, show: 15.6, aim: 23.6, pick: 24.4, send: 25.3, sent: 25.5, fold: 27.0, type: 28.7, typed: 29.9, close: 33 }
// The sentence of scenes 3 and 7 and of the social card (the owner's pick, Set 1 of the tagline
// proposal). {…} marks the words in amber. The Chinese headline is the product's name for what it
// is, since a word-for-word translation of the English reads oddly (owner 2026-11-11, Fable's
// Set 1 name with its round-2 sub line A).
const SET1: Record<Lang, { caption: string[]; sub: string[]; size: number }> = {
  en: { caption: ['A board that shows', 'which AI agent is', '{waiting on you}.'], sub: ['Claude Code, Codex, Cursor and more,', 'on your own computer.', 'Questions show up in seconds.'], size: 48 },
  'zh-TW': { caption: ['AI agent 進度看板'], sub: ['agent 一停下來{等你回答}，', '幾秒內就排到看板最上面，', '不用再一個個視窗找。'], size: 60 },
  'zh-CN': { caption: ['AI agent 进度看板'], sub: ['agent 一停下来{等你回复}，', '几秒内就排到看板最上面，', '不用再挨个窗口找。'], size: 60 },
}
type CoverScene = { caption: string[]; sub?: string[]; size?: number; subSize?: number }
type CoverTerm = { project: string; steps: [string, string, string] }
const COVER_WORDS: Record<Lang, { label: string; scenes: CoverScene[]; works: string; synthetic: string; terms: Record<'codex' | 'antigravity' | 'claude', CoverTerm> }> = {
  en: {
    label: 'Synthetic demo: Which AI agent is waiting on you? Three AI agents work side by side and one has stopped to ask “Blue or green?”. Agent Board puts that question first on one local page; an answer pressed there is delivered to Claude Code. Synthetic data.',
    scenes: [
      { caption: ['Which AI agent is', '{waiting on you}?'] },
      { caption: ['One stopped to ask.', 'You were in', 'another window.'] },
      SET1.en,
      { caption: ['Its question goes', 'to the top.'], sub: ['On the board within seconds.'] },
      { caption: ['Answer it', 'on the board.'], sub: ['Claude Code gets it directly;', 'Codex and Antigravity on their', 'next turn; copy for the rest.'] },
      { caption: ['One command', 'to start.'], sub: ['On your computer.', 'One Markdown file. No account.'] },
      SET1.en,
    ],
    works: 'Works with',
    synthetic: 'Synthetic data',
    terms: {
      codex: { project: 'api-gateway', steps: ['Token bucket', 'Load test', 'API docs'] },
      antigravity: { project: 'docs-site', steps: ['English text', 'Japanese page', 'Check links'] },
      claude: { project: 'acme-web', steps: ['Colour tokens', 'Chart contrast', ''] },
    },
  },
  'zh-TW': {
    label: '合成示範：現在哪個 AI agent 在等你？三個 AI agent 並排工作，其中一個停下來問「藍色還是綠色？」。Agent Board 把這個問題排在本機網頁的最上面，在那裡按下答案，就送到 Claude Code。合成資料。',
    scenes: [
      { caption: ['現在哪個 AI agent', '{在等你}？'] },
      { caption: ['有一個停下來問你', '你人在別的視窗'] },
      SET1['zh-TW'],
      { caption: ['它的問題', '排到最上面'], sub: ['幾秒內就上看板。'] },
      { caption: ['在看板上回答'], sub: ['不用切視窗：Claude Code 直接收到，', 'Codex、Antigravity 下一輪收到，', '其他 agent 一鍵複製。'] },
      { caption: ['一行指令', '就能開始'], sub: ['在你的電腦上跑，', '一個 Markdown 檔，不用帳號。'] },
      SET1['zh-TW'],
    ],
    works: '支援',
    synthetic: '合成資料',
    terms: {
      codex: { project: 'api-gateway', steps: ['token bucket', 'staging 壓測', 'API 文件'] },
      antigravity: { project: 'docs-site', steps: ['寫英文內容', '做日文頁面', '檢查連結'] },
      claude: { project: 'acme-web', steps: ['配色 token', '圖表對比度', ''] },
    },
  },
  'zh-CN': {
    label: '合成演示：现在哪个 AI agent 在等你？三个 AI agent 并排工作，其中一个停下来问“蓝色还是绿色？”。Agent Board 把这个问题排在本机网页的最上面，在那里按下答案，就发给 Claude Code。合成数据。',
    scenes: [
      { caption: ['现在哪个 AI agent', '{在等你}？'] },
      { caption: ['有一个停下来问你', '你在别的窗口'] },
      SET1['zh-CN'],
      { caption: ['它的提问', '排到最上面'], sub: ['几秒内就出现在看板上。'] },
      { caption: ['在看板上回复'], sub: ['不用切窗口：Claude Code 直接收到，', 'Codex、Antigravity 下一轮收到，', '其他 agent 一键复制。'] },
      { caption: ['一行命令', '就能开始'], sub: ['在你的电脑上运行，', '一个 Markdown 文件，不用账号。'] },
      SET1['zh-CN'],
    ],
    works: '支持',
    synthetic: '合成数据',
    terms: {
      codex: { project: 'api-gateway', steps: ['token bucket', 'staging 压测', 'API 文档'] },
      antigravity: { project: 'docs-site', steps: ['写英文内容', '做日文页面', '检查链接'] },
      claude: { project: 'acme-web', steps: ['配色 token', '图表对比度', ''] },
    },
  },
}
// The setup command scene 6 types, and the bottom of the left column shows in every scene.
const COVER_COMMAND = 'npx @wenyuchiou/agent-board'
// Every new picture's row of agents: the seven with a live record at 0.24.3, in the owner's
// order, and no agent that was not run live.
const LIVE_AGENTS = ['Claude Code', 'Codex', 'Antigravity', 'Cursor', 'OpenCode', 'Grok Build', 'Hermes Agent']
// The fifth agent on the board, which the page sample does not hold (made up, like the others).
const COVER_CURSOR: Record<Lang, PageTask> = {
  en: { project: 'web-client', title: 'Refactor the settings page', steps: ['Split the form', 'Add field checks', 'Update snapshots', 'Open the pull request'] },
  'zh-TW': { project: 'web-client', title: '重構設定頁', steps: ['拆開表單', '加上欄位檢查', '更新快照', '開 PR'] },
  'zh-CN': { project: 'web-client', title: '重构设置页', steps: ['拆开表单', '加上字段检查', '更新快照', '提 PR'] },
}
// The board's rows while all is calm, top to bottom, with the steps each has done when it first
// shows and each later tick: [time, done]. Claude Code's row is the one that asks, and it has done
// the steps before the question when it does.
type CoverRow = { name: string; task: PageTask; start: number; ticks: Array<[number, number]> }
const coverRows = (lang: Lang): CoverRow[] => {
  const sample = PAGE[lang] as PageSample
  return [
    { name: 'Codex', task: sample.tasks.codex, start: 2, ticks: [[17.0, 3]] },
    { name: 'Antigravity', task: sample.tasks.antigravity, start: 2, ticks: [[19.8, 3]] },
    { name: 'Claude Code', task: sample.tasks.claude, start: sample.asks, ticks: [] },
    { name: 'Cursor', task: COVER_CURSOR[lang], start: 1, ticks: [[18.4, 2]] },
    { name: 'OpenCode', task: sample.tasks.opencode, start: 0, ticks: [[21.0, 1], [26.2, 2]] },
  ]
}
// A caption's line with {…} in amber.
const marked = (line: string): string =>
  line.split(/(\{[^}]*\})/).filter(part => part !== '').map(part => (part.startsWith('{') ? `<tspan fill="${LOOK.amber}">${esc(part.slice(1, -1))}</tspan>` : esc(part))).join('')
const plain = (line: string): string => line.replace(/[{}]/g, '')

// The board's chip for an agent in the page's head row, with the presence dot (green: connected).
const chipTile = (name: string, i: number): string => {
  const x = PG.side + i * 42
  const y = PG.head + 9
  return `${iconTile(name, x, y, 28)}<circle cx="${x + 26}" cy="${y + 26}" r="5.5" fill="${LOOK.alive}" stroke="${LOOK.ground}" stroke-width="2.5"/>`
}

const cover = (lang: Lang): string => {
  const s = STRINGS[lang]
  const sample = PAGE[lang] as PageSample
  const w = COVER_WORDS[lang]
  const mono = monoOf(lang)
  const T = COVER_T
  const LOOP = COVER_LOOP
  const isCjk = lang !== 'en'
  if (w.scenes.length !== COVER_SCENES.length) throw new Error(`The ${lang} cover has ${w.scenes.length} captions for ${COVER_SCENES.length} scenes`)
  tileSink = new Set()
  const rowsData = coverRows(lang)
  const askRow = rowsData.findIndex(row => row.name === 'Claude Code')
  if ((rowsData[askRow]?.start ?? -1) !== sample.asks) throw new Error(`Claude Code has done ${rowsData[askRow]?.start} steps when it asks, but its question is step ${sample.asks + 1}`)
  const W = 1280
  const H = 720
  const L = 56
  const win = { x: 582, y: 28, w: 658, h: 664 }
  const pw = win.w
  const rowW = pw - PG.side * 2
  const keyframes: string[] = []
  const p = (sec: number): string => `${((Math.max(0, Math.min(LOOP, sec)) / LOOP) * 100).toFixed(2)}%`
  // Two stops at the same point let the later one win, and stops out of order go wrong the same way.
  const frames = (body: string): string => {
    const stops = [...body.matchAll(/(\d+(?:\.\d+)?)%(?=[^{}]*\{)/g)].map(stop => Number(stop[1]))
    if (!stops.every((stop, i) => i === 0 || stop > (stops[i - 1] ?? 0))) throw new Error(`The cover has a keyframe whose stops do not rise: ${body}`)
    const name = `c${keyframes.length}`
    keyframes.push(`@keyframes ${name} { ${body} }`)
    return name
  }
  // Stops at seconds: the first holds from the loop's start, the last to its end.
  const track = (stops: Array<[number, string]>): string => frames(stops.map(([sec, css], i) => {
    const at = i === 0 ? (sec <= 0 ? '0%' : `0%, ${p(sec)}`) : i === stops.length - 1 ? (sec >= LOOP ? '100%' : `${p(sec)}, 100%`) : p(sec)
    return `${at} { ${css} }`
  }).join(' '))
  const EASE = 'animation-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1)'
  const MOVE = 'animation-timing-function: cubic-bezier(0.65, 0, 0.35, 1)'
  const TAIL = 0.5
  // On screen during each of `spans` (rising `rise` px into place), and gone between. A span that
  // starts at 0 is already there at the loop's start, and one that ends at the loop's end leaves
  // over the first half of the last TAIL seconds; scene 1 comes back in the second half, so the
  // loop turns in order and no two captions share the same pixels.
  const appear = (spans: Array<[number, number]>, rise = 0, fin = 0.4, fout = 0.3): string => {
    const y = (v: number): string => (rise === 0 ? '' : `; transform: translateY(${v}px)`)
    const on = `opacity: 1${y(0)}`
    const gone = `opacity: 0${y(0)}`
    const stops: Array<[number, string]> = []
    for (const [start, end] of spans) {
      if (start <= 0) stops.push([0, on])
      else stops.push([start, `opacity: 0${y(rise)}; ${EASE}`], [start + fin, on])
      if (end >= LOOP) stops.push([LOOP - TAIL, on], [LOOP - TAIL / 2, gone])
      else stops.push([end - fout, on], [end, gone])
    }
    if ((spans[0]?.[0] ?? 1) <= 0) stops.push([LOOP - TAIL / 2, gone], [LOOP, on])
    return track(stops)
  }
  const endsLoop = (spans: Array<[number, number]>): boolean => spans.some(([, end]) => end >= LOOP)
  // An animated group: `a`, its keyframes' class, and `last` when it stays to the loop's end.
  const g = (spans: Array<[number, number]>, body: string, rise = 0, fin = 0.4, fout = 0.3): string =>
    `<g class="a ${appear(spans, rise, fin, fout)}${endsLoop(spans) ? ' last' : ''}">${body}</g>`
  // A layer drawn over another inside a row (a step done, the receipt): it stays fully on until the
  // row itself has faded out at the loop's end, so the layer under it never shows through.
  const cover = (at: number, fin: number): string => track([[at, `opacity: 0; ${EASE}`], [at + fin, 'opacity: 1'], [LOOP - TAIL / 2, 'opacity: 1'], [LOOP - TAIL / 2 + 0.01, 'opacity: 0']])
  const swap = (on: number, body: string): string => `<g class="a ${cover(on, 0.18)} cover last">${body}</g>`
  const glow = (at: number, peak: number, length = 1): string => track([[at, 'opacity: 0'], [at + 0.15, `opacity: ${peak}`], [at + length, 'opacity: 0']])

  // ---- The board's page, in its own units (0, 0 under the browser's bar) ----
  const CK = ASKING.card
  const cardTop = ASK_CARD_TOP
  const rowYA = (i: number): number => contentTop + PG.heading + i * (PG.row + PG.rowGap)
  const others = rowsData.map((_, i) => i).filter(i => i !== askRow)
  const rowYB = (i: number): number => askRowY(others.indexOf(i))
  const dyOf = (i: number): number => rowYB(i) - rowYA(i)
  const headDy = ASK_HEAD_Y - contentTop
  const card = needsCard(s, sample, 0, -PG.flag, rowW / CK, ASKING.question)
  const toPage = ([x, y]: [number, number]): [number, number] => [PG.side + x * CK, cardTop + y * CK]
  const toCanvas = (at: [number, number]): [number, number] => {
    const [x, y] = toPage(at)
    return [win.x + x, win.y + BAR_H + y]
  }
  const ARRIVE = T.morph + 0.5
  const rowBody = (row: CoverRow, i: number): string => {
    const y = rowYA(i)
    const isAsking = i === askRow
    const overlays = row.ticks.map(([at, done], k) => {
      const isLast = k === row.ticks.length - 1 && !isAsking
      const body = rowState(row.task, done, PG.side, y, rowW)
      return `<g class="a ${cover(at, 0.18)} cover${isLast ? ' last' : ''}">${body}</g>`
    })
    const flashes = row.ticks.map(([at]) => `<rect class="a ${glow(at, 0.08)}" x="${PG.side}" y="${y}" width="${rowW}" height="${PG.row}" rx="10" fill="${LOOK.ink}"/>`).join('')
    const note = isAsking ? swap(T.fold + 0.3, rowState(row.task, sample.asks, PG.side, y, rowW, s.claudeDelivered)) : ''
    // A thin amber outline marks the row that waits, until its question takes over the top.
    const outline = isAsking ? `<rect class="a ${appear([[T.morph + 1.3, T.ask + 0.2]], 0, 0.5, 0.2)}" x="${PG.side - 1}" y="${y - 1}" width="${rowW + 2}" height="${PG.row + 2}" rx="11" fill="none" stroke="${LOOK.amber}" stroke-width="2"/>` : ''
    return `${rowFrame(s, row.name, row.task, PG.side, y, rowW)}${rowState(row.task, row.start, PG.side, y, rowW)}${overlays.join('')}${note}${flashes}${outline}`
  }
  // Entrance (ask to show): the waiting row fades out, the rows move down to their places, and only
  // then do the flag, the card and the heading fade in, in the space that is empty. The fold (27 s)
  // is the same in reverse: flag and card leave, the rows move up, the answered row comes back.
  const SLIDE = 0.4
  const FOLD_OUT = 0.25
  const FOLD_SLIDE = 0.3
  const T_UP = T.fold + FOLD_OUT
  const T_BACK = T_UP + FOLD_SLIDE
  const rowTrack = (i: number): string => {
    const at = ARRIVE + i * 0.12
    if (i === askRow) {
      return track([
        [0, 'opacity: 0; transform: translateY(0px)'],
        [at, `opacity: 0; transform: translateY(12px); ${EASE}`],
        [at + 0.45, 'opacity: 1; transform: translateY(0px)'],
        [T.ask, 'opacity: 1; transform: translateY(0px)'],
        [T.ask + 0.2, 'opacity: 0; transform: translateY(0px)'],
        [T_BACK, 'opacity: 0; transform: translateY(0px)'],
        [T_BACK + 0.3, 'opacity: 1; transform: translateY(0px)'],
        [LOOP - TAIL, 'opacity: 1; transform: translateY(0px)'],
        [LOOP - TAIL / 2, 'opacity: 0; transform: translateY(0px)'],
      ])
    }
    const dy = dyOf(i)
    const isNew = i >= 3
    const first: Array<[number, string]> = isNew
      ? [[0, `opacity: 0; transform: translateY(${dy}px)`], [T.show + (i - 3) * 0.15, `opacity: 0; transform: translateY(${dy}px); ${EASE}`], [T.show + 0.4 + (i - 3) * 0.15, `opacity: 1; transform: translateY(${dy}px)`]]
      : [[0, 'opacity: 0; transform: translateY(0px)'], [at, `opacity: 0; transform: translateY(12px); ${EASE}`], [at + 0.45, 'opacity: 1; transform: translateY(0px)'], [T.ask + 0.2, `opacity: 1; transform: translateY(0px); ${MOVE}`], [T.ask + 0.2 + SLIDE, `opacity: 1; transform: translateY(${dy}px)`]]
    return track([
      ...first,
      [T_UP, `opacity: 1; transform: translateY(${dy}px); ${MOVE}`],
      [T_BACK, 'opacity: 1; transform: translateY(0px)'],
      [LOOP - TAIL, 'opacity: 1; transform: translateY(0px)'],
      [LOOP - TAIL / 2, 'opacity: 0; transform: translateY(0px)'],
    ])
  }
  const rows = rowsData.map((row, i) => `<g class="a ${rowTrack(i)} last">${rowBody(row, i)}</g>`).join('\n')
  // Working now is left out of scene 3 (the waiting window is not "working"); it arrives with the flag.
  const heading = `<g class="a ${track([
    [0, `opacity: 0; transform: translateY(${headDy}px)`],
    [T.show, `opacity: 0; transform: translateY(${headDy}px); ${EASE}`],
    [T.show + 0.4, `opacity: 1; transform: translateY(${headDy}px)`],
    [T_UP, `opacity: 1; transform: translateY(${headDy}px); ${MOVE}`],
    [T_BACK, 'opacity: 1; transform: translateY(0px)'],
    [LOOP - TAIL, 'opacity: 1; transform: translateY(0px)'],
    [LOOP - TAIL / 2, 'opacity: 0; transform: translateY(0px)'],
  ])} last">${sectionHead(s.pgWorking, contentTop)}</g>`
  // Claude Code's card fades in beneath the flag, is answered, and leaves with the flag at the fold.
  const cardMove = track([
    [T.show, `opacity: 0; transform: translateY(8px); ${EASE}`],
    [T.show + 0.4, 'opacity: 1; transform: translateY(0px)'],
    [T.fold, 'opacity: 1; transform: translateY(0px)'],
    [T_UP, 'opacity: 0; transform: translateY(0px)'],
  ])
  const cardSvg = `<g class="a ${cardMove}"><g transform="translate(${PG.side} ${num(cardTop)}) scale(${CK})"><g filter="url(#soft)">${card.sheet}</g><g class="a ${track([[0, 'opacity: 1'], [T.sent, 'opacity: 1'], [T.sent + 0.18, 'opacity: 0']])}">${card.answers}</g>${g([[T.pick + 0.05, T.sent + 0.18]], card.picked, 0, 0.18, 0.01)}${g([[T.sent, T_UP]], card.receipt, 0, 0.18, 0.1)}</g></g>`
  const flag = g([[T.show, T_UP]], needsFlag(s, PG.side, contentTop, 1, ASKING.flag), 6, 0.4, 0.25)
  const chips = LIVE_AGENTS.map((name, i) => (i < 3 ? chipTile(name, i) : g([[T.show + (i - 3) * 0.12, LOOP]], chipTile(name, i), 6, 0.35))).join('')
  const badge = g([[T.show + 0.1, T.sent]], badgeAt(0, 1), 0, 0.25)
  // The page's own logo lights with the cover's.
  const headLight = `<circle class="a ${appear([[T.show, T.sent]], 0, 0.3)}" fill="${LOOK.amber}" cx="${WORDMARK.light.cx}" cy="${WORDMARK.light.cy}" r="${WORDMARK.light.r}"/>`
  const page = `${pageHead(pw, LOOK.ink, headLight)}${chips}${badge}${chipsLine(pw)}
${heading}
${rows}
${flag}
${cardSvg}`
  const tab = `${tabFace('Agent Board', false)}${g([[T.show, T.sent]], `<rect x="84" y="12" width="250" height="24" fill="${LOOK.ground}"/>${tabFace(s.pgTabTitle(1), true)}`, 0, 0.1, 0.05)}`
  const board = `<g class="a ${appear([[T.morph, 28], [T.close, LOOP]], 0, 0.6, 0.25)} last calm">${browser('page', win.x, win.y, win.w, win.h, tab, page)}</g>`

  // The pointer: in from below to the first answer, a press, on to Send, a press, and away.
  const pointer = (() => {
    const [ax, ay] = toCanvas(card.pick)
    const [sx, sy] = toCanvas(card.send)
    const at = (x: number, y: number, k = 1): string => `transform: translate(${num(x)}px, ${num(y)}px) scale(${k})`
    const move = 'animation-timing-function: cubic-bezier(0.3, 0.7, 0.2, 1)'
    const name = track([
      [T.aim, `opacity: 0; ${at(ax + 120, ay + 150)}; ${move}`],
      [T.aim + 0.25, 'opacity: 1'],
      [T.pick - 0.1, `${at(ax, ay)}`],
      [T.pick, `${at(ax, ay, 0.86)}`],
      [T.pick + 0.15, `${at(ax, ay)}; ${move}`],
      [T.send - 0.1, `${at(sx, sy)}`],
      [T.send, `${at(sx, sy, 0.86)}`],
      [T.send + 0.15, `opacity: 1; ${at(sx, sy)}`],
      [T.sent + 0.7, `opacity: 1; ${at(sx, sy)}`],
      [T.sent + 1, `opacity: 0; ${at(sx, sy)}`],
    ])
    return `<g class="a ${name}"><path d="M0 0V18.5L4.6 14.2L7.7 21.2L10.9 19.8L7.9 13H14Z" fill="#fff" stroke="#1b1b1b" stroke-width="1.3" stroke-linejoin="round"/></g>`
  })()
  const presses = [[card.pick, T.pick], [card.send, T.send]].map(([at, time]) => {
    const [x, y] = toCanvas(at as [number, number])
    return `<circle class="a ${glow(time as number, 0.35, 0.45)}" cx="${num(x)}" cy="${num(y)}" r="22" fill="${LOOK.ink}"/>`
  }).join('')

  // ---- Scenes 1 to 3: three terminal windows side by side, then the board's rows ----
  const WIN_COLS = 20
  const WIN_ROWS = 9
  const winW = WIN_COLS * CELL + PAD * 2
  const winH = BAR + PAD + WIN_ROWS * LINE + PAD
  const winGap = 10
  const winY = 224
  const winX = (i: number): number => win.x + 2 + i * (winW + winGap)
  const dark = TERMINAL.dark
  const y0 = (row: number): number => BAR + PAD + row * LINE + 14
  const plainLine = (row: number, text: string, fill: string, bold = false): string => `<text x="${PAD}" y="${y0(row)}" fill="${fill}"${bold ? ' font-weight="700"' : ''}>${esc(text)}</text>`
  const doneLine = (row: number, text: string): string => `<text x="${PAD}" y="${y0(row)}" fill="${dark.palette.done}">✓ <tspan fill="${dark.ink}">${esc(text)}</tspan></text>`
  const runLine = (row: number, text: string): string => `<text x="${PAD}" y="${y0(row)}" fill="${dark.palette.muted}">▸ ${esc(text)}</text>`
  const cover1 = (row: number): string => `<rect x="1" y="${y0(row) - 14}" width="${winW - 2}" height="${LINE}" fill="${dark.ground}"/>`
  // The window's tick: the step turns into a tick and the next one starts.
  const ticking = (term: CoverTerm, at: number): string =>
    g([[at, 9.9]], `${cover1(2)}${doneLine(2, term.steps[1])}`, 0, 0.2) + g([[at + 0.3, 9.9]], runLine(3, term.steps[2]), 0, 0.3)
  const workingBody = (name: string, term: CoverTerm, at: number): string =>
    `${iconTile(name, winW - 34, 6, 22)}${plainLine(0, term.project, dark.palette.project)}${doneLine(1, term.steps[0])}${runLine(2, term.steps[1])}${ticking(term, at)}`
  const blinkStops: Array<[number, string]> = [[0, 'opacity: 1']]
  for (let k = 1; k * 0.55 < 9.4; k++) blinkStops.push([Math.round((k * 0.55 - 0.02) * 100) / 100, `opacity: ${k % 2 === 1 ? 1 : 0}`], [Math.round(k * 0.55 * 100) / 100, `opacity: ${k % 2 === 1 ? 0 : 1}`])
  blinkStops.push([9.9, 'opacity: 0'])
  const stoppedBody = (name: string, term: CoverTerm): string =>
    `${iconTile(name, winW - 34, 6, 22)}${plainLine(0, term.project, dark.palette.project)}${doneLine(1, term.steps[0])}${doneLine(2, term.steps[1])}${plainLine(4, sample.question, dark.ink, true)}${plainLine(6, '>', dark.palette.muted)}<rect class="a ${track(blinkStops)}" x="${num(PAD + 2 * CELL)}" y="${y0(6) - 13}" width="${num(CELL * 0.9)}" height="16" fill="${dark.ink}"/>`
  const windows = [
    { name: 'Codex', body: workingBody('Codex', w.terms.codex, 1.3), dim: 0.4 },
    { name: 'Antigravity', body: workingBody('Antigravity', w.terms.antigravity, 2.5), dim: 0.4 },
    { name: 'Claude Code', body: `${stoppedBody('Claude Code', w.terms.claude)}<rect class="a ${appear([[4, 10]], 0, 0.6, 0.3)}" x="-4" y="-4" width="${num(winW + 8)}" height="${num(winH + 8)}" rx="15" fill="none" stroke="${LOOK.amber}" stroke-width="2.5"/>`, dim: 1 },
  ].map(({ name, body, dim }, i) => {
    const at = (x: number, y: number, k = 1): string => `transform: translate(${num(x)}px, ${num(y)}px) scale(${k})`
    const spot = at(winX(i), winY)
    const k = PG.row / winH
    const row = at(win.x + PG.side + 4, win.y + BAR_H + rowYA(i), k)
    const name1 = track([
      [0, `opacity: 1; ${spot}`],
      [4, `opacity: 1; ${spot}`],
      [4.6, `opacity: ${dim}; ${spot}`],
      [T.morph, `opacity: ${dim}; ${spot}; ${MOVE}`],
      [T.morph + 0.8, `opacity: 0; ${row}`],
      [LOOP - TAIL / 2 - 0.01, `opacity: 0; ${row}`],
      [LOOP - TAIL / 2, `opacity: 0; ${spot}`],
      [LOOP, `opacity: 1; ${spot}`],
    ])
    return `<g class="a ${name1}">${terminal('dark', mono, name, body, WIN_ROWS, 0, 0, WIN_COLS)}</g>`
  }).join('\n')

  // ---- Scene 6: the command typed in a terminal, then the seven agents it connects ----
  const TERM_K = 1.3
  const termCols = 48
  const termW = (termCols * CELL + PAD * 2) * TERM_K
  const termX = win.x + (win.w - termW) / 2
  const termY = 176
  const cmdX = PAD + textW('$ ', 14) + 3
  const letters = COVER_COMMAND.length
  const cmdLetterW = COVER_COMMAND.length * CELL
  const mask = track([[T.type, `opacity: 1; transform: scaleX(1); animation-timing-function: steps(${letters}, end)`], [T.typed, 'opacity: 1; transform: scaleX(0)'], [T.typed + 0.05, 'opacity: 0; transform: scaleX(0)']])
  const typed = `<text x="${PAD}" y="${y0(0)}" fill="${dark.ink}"><tspan fill="${dark.palette.muted}">$ </tspan>${esc(COVER_COMMAND)}</text><rect class="a m ${mask}" x="${num(cmdX - 1)}" y="${y0(0) - 14}" width="${num(cmdLetterW + 6)}" height="${LINE}" fill="${dark.ground}"/>`
  const terminalSvg = `<g transform="translate(${num(termX)} ${termY}) scale(${TERM_K})">${terminal('dark', mono, 'agent-board', typed, 2, 0, 0, termCols)}</g>`
  const pill = (name: string, x: number, y: number): { svg: string; w: number } => {
    const width = Math.ceil(52 + textW(name, 20, 600) + 20)
    return { w: width, svg: `<rect x="${num(x)}" y="${y}" width="${width}" height="46" rx="23" fill="${LOOK.surface}" stroke="${LOOK.strong}"/>${iconTile(name, x + 7, y + 7, 32)}<text x="${num(x + 52)}" y="${y + 30}" font-size="20" font-weight="600" fill="${LOOK.ink}">${esc(name)}</text>` }
  }
  const perRow = [3, 3, 1]
  let pillIndex = 0
  const pills: string[] = []
  perRow.forEach((count, r) => {
    let x = termX
    for (let c = 0; c < count; c++) {
      const name = LIVE_AGENTS[pillIndex] ?? ''
      const one = pill(name, x, 410 + r * 62)
      pills.push(g([[30.1 + pillIndex * 0.15, T.close - 0.1]], one.svg, 8, 0.35, 0.3))
      x += one.w + 14
      pillIndex++
    }
  })
  const scene6 = `${g([[28, T.close - 0.1]], terminalSvg, 0, 0.4, 0.3)}\n${pills.join('\n')}`

  // ---- The left column ----
  const capY = 190
  const sizeOf = (scene: CoverScene): number => scene.size ?? (isCjk ? 50 : 48)
  const gapOf = (scene: CoverScene): number => Math.round(sizeOf(scene) * (isCjk ? 1.24 : 1.2))
  const ends = COVER_SCENES.map((_, k) => COVER_SCENES[k + 1] ?? LOOP)
  const captions = w.scenes.map((scene, k) => {
    const span: Array<[number, number]> = [[COVER_SCENES[k] ?? 0, ends[k] ?? LOOP]]
    const start = span[0]?.[0] ?? 0
    const size = sizeOf(scene)
    const gap = gapOf(scene)
    const lines = scene.caption.map((line, i) => `<tspan x="${L}" y="${capY + i * gap}">${marked(line)}</tspan>`).join('')
    const head = `<g class="a cap ${appear(span, 16, 0.5)}${endsLoop(span) ? ' last' : ''}"><text font-size="${size}" font-weight="800" ${HEADLINE} fill="${LOOK.ink}">${lines}</text></g>`
    if (scene.sub === undefined) return head
    const subTop = capY + (scene.caption.length - 1) * gap + (scene.caption.length === 1 ? 54 : 56)
    const sub = scene.sub.map((line, i) => `<tspan x="${L}" y="${subTop + i * 38}">${marked(line)}</tspan>`).join('')
    const subSpan: Array<[number, number]> = [[start + 0.15, ends[k] ?? LOOP]]
    return `${head}\n<g class="a sub ${appear(subSpan, 10, 0.5)}${endsLoop(subSpan) ? ' last' : ''}"><text font-size="${scene.subSize ?? 28}" fill="${LOOK.muted}">${sub}</text></g>`
  }).join('\n')
  // The closing scene also names where it works.
  const worksY = 478
  const tile = 36
  const works = g([[T.close + 0.4, LOOP]], `<text x="${L}" y="${worksY}" font-size="12" font-weight="600" letter-spacing="${isCjk ? '0.1em' : '0.16em'}" fill="${LOOK.muted}">${esc(isCjk ? w.works : w.works.toUpperCase())}</text>${LIVE_AGENTS.map((name, i) => iconTile(name, L + i * 60, worksY + 14, tile)).join('')}<text font-size="14" fill="${LOOK.muted}"><tspan x="${L}" y="${worksY + 14 + tile + 26}">${esc(LIVE_AGENTS.slice(0, 4).join(' · '))}</tspan><tspan x="${L}" y="${worksY + 14 + tile + 48}">${esc(LIVE_AGENTS.slice(4).join(' · '))}</tspan></text>`, 8, 0.5)
  // The command, whole and in every scene.
  const boxY = 604
  const boxW = 440
  const size = 17
  const commandBox = `<rect x="${L}" y="${boxY}" width="${boxW}" height="52" rx="12" fill="${LOOK.surface}"/><rect x="${L + 0.5}" y="${boxY + 0.5}" width="${boxW - 1}" height="51" rx="11.5" fill="none" stroke="url(#rim)"/>
<text x="${L + 20}" y="${boxY + 32}" font-family="${mono}" font-size="${size}" fill="${LOOK.ink}"><tspan fill="${LOOK.muted}">$ </tspan>${esc(COVER_COMMAND)}</text>`
  // The terminal types the same command in scene 6, so the box dims while it does.
  const command = `<g class="a ${track([[0, 'opacity: 1'], [T.type - 0.9, 'opacity: 1'], [T.type - 0.5, 'opacity: 0.25'], [T.close - 0.1, 'opacity: 0.25'], [T.close + 0.3, 'opacity: 1']])} last">${commandBox}</g>`
  // The scene markers under the left column, one lit for each scene; reduced motion hides them.
  const pipY = H - 36
  const pips = `<g class="pips">${COVER_SCENES.map((_, k) => `<rect x="${L + k * 36}" y="${pipY}" width="28" height="4" rx="2" fill="${LOOK.ink}" fill-opacity="0.16"/>`).join('')}${COVER_SCENES.map((start, k) => `<rect class="a ${appear([[start, ends[k] ?? LOOP]], 0, 0.3)}" x="${L + k * 36}" y="${pipY}" width="28" height="4" rx="2" fill="${LOOK.ink}"/>`).join('')}</g>`
  const synthetic = `<text x="${L + boxW}" y="${pipY + 5}" text-anchor="end" font-size="12" fill="${LOOK.muted}" fill-opacity="0.7">${esc(w.synthetic)}</text>`
  // The logo's light: amber while Claude Code asks, and off once the answer is sent (amber means waiting).
  const lit = `<circle class="a s ${track([
    [0, 'opacity: 0; transform: scale(0.86)'],
    [T.show, 'opacity: 0; transform: scale(0.86)'],
    [T.show + 0.45, 'opacity: 1; transform: scale(1.18)'],
    [T.show + 1.1, 'opacity: 1; transform: scale(1)'],
    [T.sent - 0.05, 'opacity: 1; transform: scale(1)'],
    [T.sent + 0.4, 'opacity: 0; transform: scale(1)'],
  ])}" fill="${LOOK.amber}" cx="${WORDMARK.light.cx}" cy="${WORDMARK.light.cy}" r="${WORDMARK.light.r}"/>`
  const halo = `<circle class="a s ${track([
    [0, 'opacity: 0; transform: scale(1)'],
    [T.show, 'opacity: 0; transform: scale(1)'],
    [T.show + 0.05, 'opacity: 0.6; transform: scale(1)'],
    [T.show + 1.6, 'opacity: 0; transform: scale(1.9)'],
    [T.show + 2.6, 'opacity: 0.3; transform: scale(1.6)'],
    [T.show + 3.8, 'opacity: 0.05; transform: scale(1.1)'],
    [T.show + 5, 'opacity: 0.3; transform: scale(1.6)'],
    [T.sent, 'opacity: 0; transform: scale(1.05)'],
  ])}" fill="${LOOK.amber}" cx="${WORDMARK.light.cx}" cy="${WORDMARK.light.cy}" r="${WORDMARK.light.r}"/>`
  const logo = lockupAt(L, 40, 30, LOOK.ink, `${halo}${lit}<circle class="still" fill="${LOOK.amber}" cx="${WORDMARK.light.cx}" cy="${WORDMARK.light.cy}" r="${WORDMARK.light.r}"/>`)
  // With reduced motion the board shows scene 4: Claude Code's question on top, the others working under it.
  const still = `<g class="still">${browser('still', win.x, win.y, win.w, win.h, `${tabFace('Agent Board', false)}<rect x="84" y="12" width="250" height="24" fill="${LOOK.ground}"/>${tabFace(s.pgTabTitle(1), true)}`, askingPage(lang, pw, chipTile))}</g>`

  const tiles = [...(tileSink as Set<string>)].map(name => `<g id="${tileId(name)}">${tileDrawn(name, 0, 0, 48)}</g>`).join('')
  tileSink = null
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(w.label)}" font-family="${sansOf(lang)}">
<title>Agent Board: ${esc(w.label)}</title>
<defs>${lookDefs(W, H, [0.68, 0.2])}${tiles}</defs>
<style>
.a { animation-duration: ${LOOP}s; animation-iteration-count: infinite; animation-timing-function: linear; }
.a { opacity: 0; }
/* A viewer that does not play CSS animation shows the closing scene still; a playing one follows its keyframes. */
.a.last { opacity: 1; }
.still { display: none; }
.m { transform-box: fill-box; transform-origin: 100% 50%; }
.s { transform-box: fill-box; transform-origin: center; }
${keyframes.join('\n')}
${keyframes.map((_, i) => `.c${i} { animation-name: c${i} }`).join('\n')}
@media (prefers-reduced-motion: reduce) {
  .a { animation: none; opacity: 0; }
  .pips { display: none; }
  .last { opacity: 1; }
  .calm { opacity: 0; }
  .still { display: inline; }
}
</style>
<g clip-path="url(#edge)">
${lookGround(W, H)}
${logo}
${captions}
${works}
${command}
${pips}
${synthetic}
${board}
${still}
${windows}
${scene6}
${presses}
${pointer}
</g>
</svg>
`
}

// How your answer reaches the agent: one card, three lanes, each with its agents' icons, the page's
// own button and what that agent was seen to do with it. Amber marks the one lane that sends now.
const ANSWER_WORDS: Record<Lang, { title: string; heads: [string, string, string]; notes: [[string, string], [string, string], [string, string]]; label: string }> = {
  en: {
    title: 'How your answer gets there',
    heads: ['Sent directly', 'Queued for the next turn', 'Copied for one paste'],
    notes: [
      ['Claude Code CLI received it', 'and confirmed it.'],
      ['Antigravity CLI received it.', 'Codex CLI queues it; delivery not yet tested.'],
      ['Cursor, OpenCode, Grok Build, Hermes:', 'paste it into the chat once.'],
    ],
    label: 'Three ways an answer from the board reaches its agent: Send to Claude Code, queue for the next turn of Antigravity or Codex, or copy for Cursor, OpenCode, Grok Build and Hermes. Synthetic data.',
  },
  'zh-TW': {
    title: '你的回覆怎麼送到',
    heads: ['直接送到', '排進下一回合', '複製，貼一次'],
    notes: [
      ['Claude Code CLI 收到了，', '也回了確認。'],
      ['Antigravity CLI 已收到。', 'Codex CLI 也會排入，送達還沒實測。'],
      ['Cursor、OpenCode、Grok Build、Hermes：', '在對話裡貼上一次就好。'],
    ],
    label: '看板上的回覆有三種送法：傳給 Claude Code；排進 Antigravity 或 Codex 的下一回合；或複製給 Cursor、OpenCode、Grok Build、Hermes。合成資料。',
  },
  'zh-CN': {
    title: '你的回复怎么送到',
    heads: ['直接送到', '排进下一回合', '复制，粘贴一次'],
    notes: [
      ['Claude Code CLI 收到了，', '也回了确认。'],
      ['Antigravity CLI 已收到。', 'Codex CLI 也会排入，送达还没实测。'],
      ['Cursor、OpenCode、Grok Build、Hermes：', '在对话里粘贴一次就好。'],
    ],
    label: '看板上的回复有三种送法：发给 Claude Code；排进 Antigravity 或 Codex 的下一回合；或复制给 Cursor、OpenCode、Grok Build、Hermes。合成数据。',
  },
}
const ANSWER_AGENTS: [string[], string[], string[]] = [['Claude Code'], ['Antigravity', 'Codex'], ['Cursor', 'OpenCode', 'Grok Build', 'Hermes Agent']]

const answer = (lang: Lang): string => {
  const s = STRINGS[lang]
  const w = ANSWER_WORDS[lang]
  const W = 1280
  const H = 360
  const card = { x: 48, y: 82, w: 1184, h: 238 }
  const laneW = card.w / 3
  const buttons = [s.serveSend('Claude Code'), s.serveQueueNextTurn('Antigravity'), s.serveCopy]
  const lanes = ANSWER_AGENTS.map((agents, i) => {
    const x = card.x + i * laneW + 32
    const y = card.y
    const isSend = i === 0
    const tiles = agents.map((name, k) => iconTile(name, x + k * 38, y + 30, 30)).join('')
    const label = buttons[i] ?? ''
    const bw = Math.round(textW(label, 15, isSend ? 600 : 400) + 36)
    const by = y + 112
    const button = isSend
      ? `<rect x="${x}" y="${by}" width="${bw}" height="40" rx="10" fill="${LOOK.ink}"/><text x="${num(x + bw / 2)}" y="${by + 26}" text-anchor="middle" font-size="15" font-weight="600" fill="${LOOK.surface}">${esc(label)}</text>`
      : `<rect x="${x}" y="${by}" width="${bw}" height="40" rx="10" fill="${LOOK.surface}" stroke="${LOOK.ink}" stroke-opacity="0.5"/><text x="${num(x + bw / 2)}" y="${by + 26}" text-anchor="middle" font-size="15" fill="${LOOK.ink}">${esc(label)}</text>`
    const [one, two] = w.notes[i] ?? ['', '']
    const notes = `<text x="${x}" y="${y + 186}" font-size="14" fill="${LOOK.ink}">${isSend ? `<tspan font-weight="700" fill="${LOOK.alive}">✓ </tspan>` : ''}${esc(one)}</text><text x="${x}" y="${y + 208}" font-size="14" fill="${LOOK.muted}">${esc(two)}</text>`
    const head = `<text x="${x}" y="${y + 92}" font-size="18" font-weight="600" fill="${LOOK.ink}">${esc(w.heads[i] ?? '')}</text>`
    return `${tiles}${head}${button}${notes}`
  }).join('\n')
  const rules = [1, 2].map(i => `<line x1="${card.x + i * laneW}" y1="${card.y + 24}" x2="${card.x + i * laneW}" y2="${card.y + card.h - 24}" stroke="${LOOK.line}"/>`).join('')
  // The Send lane's top edge, lit: the one lane that delivers while the agent waits.
  const lit = `<path d="M${card.x + 16} ${card.y + 0.75}h${laneW - 16}" stroke="${LOOK.amber}" stroke-width="2.5" stroke-linecap="round"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(w.label)}" font-family="${sansOf(lang)}">
<title>${esc(w.title)}</title>
<defs>${lookDefs(W, H, [0.3, 0.1])}</defs>
<g clip-path="url(#edge)">
${lookGround(W, H)}
${eyebrow(card.x, 52, w.title, lang)}
<g filter="url(#soft)"><rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="18" fill="${LOOK.surface}"/></g>
<rect x="${card.x + 0.5}" y="${card.y + 0.5}" width="${card.w - 1}" height="${card.h - 1}" rx="17.5" fill="none" stroke="url(#rim)"/>
${lit}
${rules}
${lanes}
</g>
</svg>
`
}

// The same board in three places, side by side: the page in a browser, the terminal board, and the
// pane beside Claude Code's chat; and a phone, which on the local network only views.
const PLACES_WORDS: Record<Lang, { title: string; names: [string, string, string, string]; phone: string; label: string }> = {
  en: {
    title: 'Same board, three places',
    names: ['Browser', 'Terminal', 'Beside Claude Code’s chat', 'Phone'],
    phone: 'View only on Wi-Fi',
    label: 'The same board in a browser, in a terminal and in the pane beside Claude Code’s chat; a phone on the same Wi-Fi can view it but not send. Synthetic data.',
  },
  'zh-TW': {
    title: '同一塊看板，三個地方',
    names: ['瀏覽器', '終端機', 'Claude Code 對話旁', '手機'],
    phone: '同一個 Wi-Fi 下只能看',
    label: '同一塊看板，可以在瀏覽器、終端機，或 Claude Code 對話旁的面板打開；同一個 Wi-Fi 的手機可以看，但不能傳送。合成資料。',
  },
  'zh-CN': {
    title: '同一块看板，三个地方',
    names: ['浏览器', '终端', 'Claude Code 对话旁', '手机'],
    phone: '同一个 Wi-Fi 下只能看',
    label: '同一块看板，可以在浏览器、终端，或 Claude Code 对话旁的面板打开；同一个 Wi-Fi 的手机可以看，但不能发送。合成数据。',
  },
}

// A whole SVG picture placed inside another at x, y, `scale` times its size.
const placed = (svg: string, x: number, y: number, scale: number): { svg: string; w: number; h: number } => {
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
  if (box === null) throw new Error('A picture to place has no viewBox')
  const w = Number(box[1]) * scale
  const h = Number(box[2]) * scale
  const inner = svg.trim().replace(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="[^"]*" height="[^"]*"/, `<svg x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"`)
  return { svg: inner, w, h }
}

const places = (lang: Lang): string => {
  const s = STRINGS[lang]
  const sample = PAGE[lang] as PageSample
  const w = PLACES_WORDS[lang]
  const W = 1280
  const H = 520
  const floor = 424
  const gap = 44
  const term = cliBoard(lang, 'dark', 'codex')
  const side = pane(lang, 'dark')
  const k = 0.6
  const termBox = placed(term, 0, 0, k)
  const sideBox = placed(side, 0, 0, k)
  const pageW = 300
  const pageK = pageW / 740
  const pageH = 576 * pageK
  const phone = { w: 132, h: 266 }
  const total = pageW + termBox.w + sideBox.w + phone.w + gap * 3
  const x0 = (W - total) / 2
  const xs = [x0, x0 + pageW + gap, x0 + pageW + gap + termBox.w + gap, x0 + pageW + gap + termBox.w + gap + sideBox.w + gap]
  const [px, tx, sx, fx] = xs as [number, number, number, number]
  const pageSvg = `<g transform="translate(${num(px)} ${num(floor - pageH)}) scale(${Math.round(pageK * 10000) / 10000})">${browser('mini', 0, 0, 740, 576, tabFace(s.pgTabTitle(1), true), pageAsking(lang, 740), false)}</g>`
  const termSvg = placed(term, tx, floor - termBox.h, k).svg
  const sideSvg = placed(side, sx, floor - sideBox.h, k).svg
  // The phone: the page narrowed, with Claude Code's question and Copy, since the network page cannot send.
  const fy = floor - phone.h
  const q = sample.question
  const sx2 = fx + 12
  const sw = phone.w - 24
  const copyW = Math.round(textW(s.serveCopy, 11) + 22)
  const phoneSvg = `<g filter="url(#soft)"><rect x="${fx}" y="${fy}" width="${phone.w}" height="${phone.h}" rx="22" fill="${LOOK.ground}"/></g>
<rect x="${fx + 0.75}" y="${fy + 0.75}" width="${phone.w - 1.5}" height="${phone.h - 1.5}" rx="21.25" fill="none" stroke="${LOOK.strong}" stroke-width="1.5"/>
<rect x="${fx + phone.w / 2 - 18}" y="${fy + 9}" width="36" height="8" rx="4" fill="${LOOK.surface}"/>
${lockupAt(sx2, fy + 30, 9, LOOK.amber)}
<line x1="${fx + 1}" y1="${fy + 48}" x2="${fx + phone.w - 1}" y2="${fy + 48}" stroke="${LOOK.line}"/>
<path d="M${sx2} ${fy + 62}h${textW(s.pgNeeds, 10, 600) + 30}l-5 8l5 8h-${textW(s.pgNeeds, 10, 600) + 30}z" fill="${LOOK.amber}"/><text x="${sx2 + 6}" y="${fy + 74}" font-size="10" font-weight="600" fill="${LOOK.onAmber}">${esc(s.pgNeeds)}<tspan dx="5" font-weight="700">1</tspan></text>
<rect x="${sx2}" y="${fy + 78}" width="${sw}" height="96" rx="8" fill="${LOOK.surface}" stroke="${LOOK.strong}"/>
${iconTile('Claude Code', sx2 + 9, fy + 88, 16)}
<text x="${sx2 + 31}" y="${fy + 100}" font-size="9" font-weight="600" fill="${LOOK.ink}">Claude Code</text>
<text x="${sx2 + 9}" y="${fy + 127}" font-size="13" font-weight="600" fill="${LOOK.ink}">${esc(q)}</text>
<rect x="${sx2 + 9}" y="${fy + 140}" width="${copyW}" height="24" rx="7" fill="${LOOK.surface}" stroke="${LOOK.ink}" stroke-opacity="0.5"/><text x="${num(sx2 + 9 + copyW / 2)}" y="${fy + 156}" text-anchor="middle" font-size="11" fill="${LOOK.ink}">${esc(s.serveCopy)}</text>
${[0, 1].map(i => `<rect x="${sx2}" y="${fy + 186 + i * 34}" width="${sw}" height="26" rx="7" fill="${LOOK.surface}" stroke="${LOOK.line}"/><rect x="${sx2 + 8}" y="${fy + 194 + i * 34}" width="${i === 0 ? 58 : 44}" height="4" rx="2" fill="${LOOK.ink}" fill-opacity="0.5"/><rect x="${sx2 + 8}" y="${fy + 202 + i * 34}" width="${i === 0 ? 36 : 52}" height="3" rx="1.5" fill="${LOOK.ink}" fill-opacity="0.2"/>`).join('')}
<rect x="${fx + phone.w / 2 - 22}" y="${fy + phone.h - 10}" width="44" height="3" rx="1.5" fill="${LOOK.ink}" fill-opacity="0.35"/>`
  const centres = [px + pageW / 2, tx + termBox.w / 2, sx + sideBox.w / 2, fx + phone.w / 2]
  const names = w.names.map((name, i) => `<text x="${num(centres[i] ?? 0)}" y="${floor + 40}" text-anchor="middle" font-size="16" font-weight="600" fill="${LOOK.ink}">${esc(name)}</text>`).join('')
  const phoneNote = `<text x="${num(centres[3] ?? 0)}" y="${floor + 62}" text-anchor="middle" font-size="13" fill="${LOOK.muted}">${esc(w.phone)}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(w.label)}" font-family="${sansOf(lang)}">
<title>${esc(w.title)}</title>
<defs>${lookDefs(W, H, [0.5, 0.3])}<radialGradient id="floor"><stop offset="0" stop-color="#000" stop-opacity="0.45"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs>
<g clip-path="url(#edge)">
${lookGround(W, H)}
${eyebrow(48, 52, w.title, lang)}
<text x="${W - 48}" y="52" text-anchor="end" font-size="12" fill="${LOOK.muted}" fill-opacity="0.7">${esc(COVER_WORDS[lang].synthetic)}</text>
<ellipse cx="${W / 2}" cy="${floor + 2}" rx="${total / 2 + 60}" ry="16" fill="url(#floor)"/>
${pageSvg}
<g filter="url(#soft)">${termSvg}</g>
<g filter="url(#soft)">${sideSvg}</g>
${phoneSvg}
${names}
${phoneNote}
</g>
</svg>
`
}

// How it works: agents' hooks report into one file on your computer; the page, the terminal and the
// pane read it. No account, and the board calls no model.
const FLOW_WORDS: Record<Lang, { title: string; hooks: [string, string]; file: [string, string]; outputs: [string, string, string]; footer: string; label: string }> = {
  en: {
    title: 'How it works',
    hooks: ['Hooks report', 'Each agent’s own hooks write its progress.'],
    file: ['One file on your computer', 'Yours to read and edit.'],
    outputs: ['Page', 'Terminal', 'Pane'],
    footer: 'No account. No model call by the board.',
    label: 'Agents’ hooks report into progress.md, one file on your computer that you can read and edit; the page, the terminal board and the pane read it. No account, no model call by the board.',
  },
  'zh-TW': {
    title: '運作方式',
    hooks: ['hook 自動回報', '每個 agent 用自己的 hook 寫進度。'],
    file: ['你電腦上的一個檔案', '你可以自己看、自己改。'],
    outputs: ['網頁', '終端機', '面板'],
    footer: '不用註冊帳號。看板本身不呼叫任何模型。',
    label: '各個 agent 的 hook 把進度寫進 progress.md，這是你電腦上的一個檔案，你可以自己看、自己改；網頁、終端機看板和面板都讀它。不用帳號，看板本身不呼叫模型。',
  },
  'zh-CN': {
    title: '运作方式',
    hooks: ['hook 自动汇报', '每个 agent 用自己的 hook 写进度。'],
    file: ['你电脑上的一个文件', '你可以自己看、自己改。'],
    outputs: ['网页', '终端', '面板'],
    footer: '不用注册账号。看板本身不调用任何模型。',
    label: '各个 agent 的 hook 把进度写进 progress.md，这是你电脑上的一个文件，你可以自己看、自己改；网页、终端看板和面板都读它。不用账号，看板本身不调用模型。',
  },
}

const flow = (lang: Lang): string => {
  const w = FLOW_WORDS[lang]
  const mono = monoOf(lang)
  const sample = PAGE[lang] as PageSample
  const W = 1280
  const H = 360
  const mid = 182
  // Left: the agents' tiles, four in the first row and three centred under them.
  const tiles = LIVE_AGENTS.map((name, i) => iconTile(name, 64 + (i % 4) * 52 + (i >= 4 ? 26 : 0), mid - 74 + Math.floor(i / 4) * 52, 40)).join('')
  const left = `${tiles}<text x="64" y="${mid + 82}" font-size="18" font-weight="600" fill="${LOOK.ink}">${esc(w.hooks[0])}</text><text x="64" y="${mid + 106}" font-size="14" fill="${LOOK.muted}">${esc(w.hooks[1])}</text>`
  // Centre: progress.md, a few of its lines.
  const doc = { x: 480, y: mid - 96, w: 320, h: 150 }
  const claude = sample.tasks.claude
  const lines: Array<[string, string]> = [
    [`## ${claude.project}`, LOOK.ink],
    [`### ${claude.title}`, LOOK.ink],
    [`- [x] ${claude.steps[0] ?? ''}`, LOOK.muted],
    [`- [~] ${claude.steps[1] ?? ''}`, LOOK.muted],
    [`- [?] ${sample.question}`, LOOK.amber],
  ]
  const file = `<g filter="url(#soft)"><rect x="${doc.x}" y="${doc.y}" width="${doc.w}" height="${doc.h}" rx="14" fill="${LOOK.surface}"/></g><rect x="${doc.x + 0.5}" y="${doc.y + 0.5}" width="${doc.w - 1}" height="${doc.h - 1}" rx="13.5" fill="none" stroke="url(#rim)"/>
<text x="${doc.x + 20}" y="${doc.y + 30}" font-family="${mono}" font-size="15" font-weight="700" fill="${LOOK.ink}">progress.md</text>
<line x1="${doc.x}" y1="${doc.y + 44}" x2="${doc.x + doc.w}" y2="${doc.y + 44}" stroke="${LOOK.line}"/>
<g font-family="${mono}" font-size="12.5">${lines.map(([text, colour], i) => `<text x="${doc.x + 20}" y="${doc.y + 66 + i * 18}" fill="${colour}">${esc(text)}</text>`).join('')}</g>
<text x="${doc.x}" y="${mid + 82}" font-size="18" font-weight="600" fill="${LOOK.ink}">${esc(w.file[0])}</text><text x="${doc.x}" y="${mid + 106}" font-size="14" fill="${LOOK.muted}">${esc(w.file[1])}</text>`
  // Right: the three places that read it, each a small frame with its name.
  const outX = 920
  const outs = w.outputs.map((name, i) => {
    const y = mid - 96 + i * 66
    const glyphs = [
      `<rect x="${outX + 14}" y="${y + 14}" width="30" height="24" rx="4" fill="none" stroke="${LOOK.ink}" stroke-width="1.6"/><line x1="${outX + 14}" y1="${y + 20}" x2="${outX + 44}" y2="${y + 20}" stroke="${LOOK.ink}" stroke-width="1.6"/>`,
      `<rect x="${outX + 14}" y="${y + 14}" width="30" height="24" rx="4" fill="none" stroke="${LOOK.ink}" stroke-width="1.6"/><path d="M${outX + 20} ${y + 22}l4 4l-4 4M${outX + 28} ${y + 31}h8" fill="none" stroke="${LOOK.ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
      `<rect x="${outX + 14}" y="${y + 14}" width="30" height="24" rx="4" fill="none" stroke="${LOOK.ink}" stroke-width="1.6"/><line x1="${outX + 33}" y1="${y + 14}" x2="${outX + 33}" y2="${y + 38}" stroke="${LOOK.ink}" stroke-width="1.6"/>`,
    ]
    return `<rect x="${outX}" y="${y}" width="296" height="52" rx="12" fill="${LOOK.surface}" stroke="${LOOK.line}"/>${glyphs[i] ?? ''}<text x="${outX + 60}" y="${y + 32}" font-size="16" font-weight="600" fill="${LOOK.ink}">${esc(name)}</text>`
  }).join('')
  const arrow = (x1: number, y1: number, x2: number, y2: number): string => {
    const m = (x1 + x2) / 2
    return `<path d="M${x1} ${y1}C${m} ${y1} ${m} ${y2} ${x2 - 7} ${y2}" fill="none" stroke="${LOOK.ink}" stroke-opacity="0.35" stroke-width="1.6" marker-end="url(#head)"/>`
  }
  const ins = [arrow(64 + 4 * 52 + 12, mid - 28, doc.x, doc.y + doc.h / 2 - 10)]
  const outsArrows = [0, 1, 2].map(i => arrow(doc.x + doc.w, doc.y + doc.h / 2 - 10, outX, mid - 96 + i * 66 + 26)).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(w.label)}" font-family="${sansOf(lang)}">
<title>progress.md</title>
<defs>${lookDefs(W, H, [0.5, 0.2])}<marker id="head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z" fill="${LOOK.ink}" fill-opacity="0.5"/></marker></defs>
<g clip-path="url(#edge)">
${lookGround(W, H)}
${eyebrow(64, 52, w.title, lang)}
${left}
${ins.join('')}
${file}
${outsArrows}
${outs}
<line x1="64" y1="${H - 52}" x2="${W - 64}" y2="${H - 52}" stroke="${LOOK.line}"/>
<text x="${W / 2}" y="${H - 22}" text-anchor="middle" font-size="15" fill="${LOOK.muted}">${esc(w.footer)}</text>
</g>
</svg>
`
}

// The promotional card, for GitHub's social preview and for sharing, at 1280 x 640: the sentence of
// scenes 3 and 7 (SET1) with amber on the words that name what the board is for, the agents it works
// with, the repository, and the board of scene 4 with Claude Code's question on top (a link preview
// is one picture, so it shows who is waiting).
const PROMO_WORDS: Record<Lang, { works: string }> = {
  en: { works: 'Works with' },
  'zh-TW': { works: '支援' },
  'zh-CN': { works: '支持' },
}

const promo = (lang: Lang): string => {
  const mono = monoOf(lang)
  const set = SET1[lang]
  const w = PROMO_WORDS[lang]
  const W = 1280
  const H = 640
  const isCjk = lang !== 'en'
  const size = isCjk ? 64 : 52
  const gap = Math.round(size * 1.16)
  const top = 172
  const head = set.caption.map((line, i) => `<tspan x="72" y="${top + i * gap}">${marked(line)}</tspan>`).join('')
  const subTop = top + (set.caption.length - 1) * gap + (set.caption.length === 1 ? 54 : 56)
  const sub = set.sub.map((line, i) => `<tspan x="72" y="${subTop + i * 38}">${marked(line)}</tspan>`).join('')
  const worksY = 478
  const icons = LIVE_AGENTS.map((name, i) => iconTile(name, 72 + i * 52, worksY + 16, 38)).join('\n')
  const k = 0.88
  const pw = 658
  const ph = 664
  const wx = 650
  const wy = (H - ph * k) / 2
  const s = STRINGS[lang]
  const tab = `${tabFace('Agent Board', false)}<rect x="84" y="12" width="250" height="24" fill="${LOOK.ground}"/>${tabFace(s.pgTabTitle(1), true)}`
  const window = `<g transform="translate(${wx} ${num(wy)}) scale(${k})">${browser('promo', 0, 0, pw, ph, tab, askingPage(lang, pw, chipTile))}</g>`
  const label = `${set.caption.map(plain).join(' ')} ${set.sub.map(plain).join(' ')}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Agent Board: ${esc(label)}" font-family="${sansOf(lang)}">
<title>Agent Board</title>
<defs>${lookDefs(W, H, [0.75, 0.3])}</defs>
<g clip-path="url(#edge)">
${lookGround(W, H)}
${lockupAt(72, 64, 34, LOOK.amber)}
<text font-size="${size}" font-weight="800" ${HEADLINE} fill="${LOOK.ink}">${head}</text>
<text font-size="28" fill="${LOOK.muted}">${sub}</text>
<text x="72" y="${worksY}" font-size="13" font-weight="600" letter-spacing="${isCjk ? '0.1em' : '0.16em'}" fill="${LOOK.muted}">${esc(isCjk ? w.works : w.works.toUpperCase())}</text>
${icons}
<text x="72" y="590" font-family="${mono}" font-size="18" fill="${LOOK.muted}">github.com/<tspan fill="${LOOK.ink}" font-weight="700">WenyuChiou/agent-board</tspan></text>
${window}
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
// by side part at the end of a line. The chips take the page's dark surface and ink; the names
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
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${num(tile * 0.23 + pad - 0.5)}" fill="${LOOK.surface}" stroke="${LOOK.strong}"/>
${iconTile(icon.name, pad, pad, tile)}
<text x="${left}" y="${num(height / 2 + size * 0.36)}" font-size="${size}" font-weight="${weight}" fill="${LOOK.ink}">${esc(icon.name)}</text>
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
  // The cover is drawn dark only now; the light ones stay until the next npm release removes them.
  write(join(OUT, `cover-${lang}-dark.svg`), () => cover(lang))
  write(join(OUT, `tour-${lang}.svg`), () => tour(lang))
  write(join(OUT, `flow-${lang}.svg`), () => flow(lang))
  write(join(OUT, `answer-${lang}.svg`), () => answer(lang))
  write(join(OUT, `places-${lang}.svg`), () => places(lang))
}

// Each SVG written here then gets the letters it draws from its fonts (fonts.py, which needs fontTools).
// Pictures no longer drawn (the light covers) are left as they are.
const svgs = written
if (svgs.length === 0) throw new Error(`No image's name starts with ${only}`)
const fonts = Bun.spawnSync([python, join(import.meta.dir, 'fonts.py'), ...svgs], { stdout: 'inherit', stderr: 'inherit' })
if (fonts.exitCode !== 0) throw new Error(`fonts.py stopped with exit code ${fonts.exitCode}`)
if (only !== undefined) console.log(`wrote ${written.length} image(s) starting with ${only} to ${OUT}`)
else console.log(`wrote the pane top, tour, flow, answer lanes, places, promotional card, the README cover and CLI boards in ${LANGS.length} languages and ${AGENT_ICONS.length} agent icons and chips to ${OUT}`)
