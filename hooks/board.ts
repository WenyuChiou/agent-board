import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { lastQuestionInProse, normalizeReply } from './digest'
import { inboxOrder, isBoardTurn, isTranscriptPath, readTurn, transcriptTail } from './inbox'
import { localDay, parseJournal, progressReport } from './journal'
import { DARK, LIGHT } from './palette'
import type { Tone } from './palette'
import { sha256 } from './sha256'
import { agentLabel } from './strings'
import { isSameName, relativeTime, replyHint } from './view'
import type { StepRef, TaskRef, TaskRow, View, ViewStep, WaitingItem } from './view'
import type { ConfirmRef } from './blocks'

// The board as plain text, for agents other than Claude Code: the standalone script that
// `/progress connect` writes beside progress.md prints it in a terminal (once, or live with
// --watch), and each agent's board command shows it. It reads; it never writes progress.md.

// A turn another agent's hook left that no Claude Code session has summed up yet. The
// board only peeks at it: taking it is a Claude Code session's job, so the two never race.
export type PendingTurn = { id?: string; dir?: string; fullText?: string; sources?: string[]; sourceRevisions?: string[]; isClosed?: boolean; agent: string; project: string; text: string; isQuestion: boolean; at: number; sourceAt?: number; hasSummary?: boolean }

// A reply's last line of prose, its code blocks left out: where a reply usually says what
// came of the turn.
const closing = (answer: string): string | undefined =>
  answer
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .at(-1)

// `readLog` reads an agent's session log, for the request a hook leaves out (Codex's Stop).
// `scrub` runs on a reply before its question is picked and cut to length: a text that is sent
// on as it is hides what it must first, while all of it is still there (a token cut in half,
// or stripped of its underscores, is no longer a shape anything knows).
export const peekInbox = (
  files: ReadonlyArray<{ name: string; body: string; at: number }>,
  readLog: (path: string) => string = () => '',
  scrub: (text: string) => string = text => text,
  s: Strings = ZH_TW,
): PendingTurn[] => {
  const latest = new Map<string, PendingTurn>()
  const questions = new Map<string, PendingTurn>()
  for (const file of [...files].sort((a, b) => a.at - b.at || inboxOrder(a.name, b.name))) {
    const read = readTurn(file.name, file.body)
    if (read === null) continue
    // A preview has neither the owner mirror nor an accepted prompt receipt.
    // Prompt metadata cannot retire an unprocessed report or answer its question.
    if (read.event === 'prompt') continue
    const turn = read.prompt === '' && isTranscriptPath(read.transcript) ? { ...read, prompt: transcriptTail(readLog(read.transcript)).prompt } : read
    if (isBoardTurn(turn)) continue
    const normalized = normalizeReply(turn.answer)
    const prose = normalized === null ? null : scrub(normalized)
    const question = prose === null ? null : lastQuestionInProse(prose, true)
    const summary = prose === null ? s.turnUnreadable : question ?? closing(prose)
    const text = (summary ?? turn.prompt).trim()
    if (question !== null) {
      // Words deduplicate retries, not independent ledger identities. An end or later
      // statement cannot prove a previous question answered before anyone captured it.
      const key = JSON.stringify([turn.id, turn.project, question.replace(/\s+/g, ' ').trim()])
      const previous = questions.get(key)
      questions.set(key, { id: turn.id, fullText: prose!, sources: [...new Set([...(previous?.sources ?? []), file.name])], sourceRevisions: [...new Set([...(previous?.sourceRevisions ?? []), sha256(JSON.stringify([file.name, file.body]))])], agent: turn.agent, project: turn.project, dir: turn.cwd, text, isQuestion: true, at: previous?.at ?? file.at, sourceAt: turn.at ?? file.at, hasSummary: true, ...(turn.event === 'end' ? { isClosed: true } : {}) })
      latest.delete(turn.id)
    } else if (turn.event !== 'end' && text !== '') {
      latest.set(turn.id, { id: turn.id, ...(prose === null ? {} : { fullText: prose }), agent: turn.agent, project: turn.project, dir: turn.cwd, text, isQuestion: false, at: file.at, sourceAt: turn.at ?? file.at, hasSummary: summary !== undefined && summary !== null })
    }
    if (turn.event === 'end') {
      latest.delete(turn.id)
      for (const [key, pending] of questions) if (pending.id === turn.id) questions.set(key, { ...pending, isClosed: true })
    }
  }

  return [...questions.values(), ...latest.values()].sort((a, b) => Number(b.isQuestion) - Number(a.isQuestion) || b.at - a.at)
}

// A cache hit returns the same turns without asking the caller to read the inbox again.
export type TurnCache = { key: string; turns: PendingTurn[] } | null
export const turnsFor = async (
  cache: TurnCache,
  listing: unknown,
  s: Strings,
  fresh: () => Promise<{ files: Array<{ name: string; body: string; at: number }>; scrub: (text: string) => string; isComplete: boolean }>,
): Promise<{ turns: PendingTurn[]; cache: TurnCache }> => {
  const key = JSON.stringify([listing, s.lang])
  if (cache?.key === key) return { turns: cache.turns, cache }
  const { files, scrub, isComplete } = await fresh()
  const turns = peekInbox(files, () => '', scrub, s)
  return { turns, cache: isComplete ? { key, turns } : cache }
}

export type ColorDepth = 'truecolor' | '256'
export type Theme = 'dark' | 'light'

// How a reply to a question reaches its session through the running page (`--serve`): the page
// sends it into a connected session, or into a closed one it may resume. The fields are the ones
// the page's own buttons send back, so the page checks the press as it checks its own.
export type AnswerRoute = { mode: 'connected' | 'send'; agent: string; session: string; asked: string; fp: string; delivery?: { id: string; turn: string; agent: string } }

// `depth` and `theme` pick the page's colours for a terminal; `routes` are the questions the
// running page can answer into their session, by line key; `agents` the agents that reported to
// this board, which an empty board names.
export type BoardOptions = { width: number; isColor: boolean; isIdleOpen?: boolean; depth?: ColorDepth; theme?: Theme; routes?: Readonly<Record<string, AnswerRoute>>; agents?: readonly string[] }

export const remainingInbox = (view: View, pending: readonly PendingTurn[]): readonly PendingTurn[] => view.hasPendingQuestions ? pending.filter(turn => !turn.isQuestion) : pending

// How the board is painted, from what the terminal says of itself. NO_COLOR and --no-color win;
// FORCE_COLOR paints into a pipe (`| less -R`); otherwise only a terminal is painted. 24-bit only
// where COLORTERM says the terminal has it, else the nearest of 256, which terminals draw as
// given, whatever their theme does to the 16 basic colours. A light terminal is told by --theme,
// or by the background COLORFGBG names (7, or 9 to 15).
export const terminalLook = (env: Readonly<Record<string, string | undefined>>, args: readonly string[], isTty: boolean): { isColor: boolean; depth: ColorDepth; theme: Theme } => {
  const force = env.FORCE_COLOR
  const isForced = force !== undefined && force !== '' && force !== '0' && force !== 'false'
  const isColor = (env.NO_COLOR ?? '') === '' && !args.includes('--no-color') && (isForced || isTty)
  const depth = /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '') || force === '3' ? 'truecolor' : '256'
  const at = args.indexOf('--theme')
  const asked = at >= 0 ? args[at + 1] : undefined
  const ground = Number((env.COLORFGBG ?? '').split(';').at(-1))
  const isLightGround = (env.COLORFGBG ?? '') !== '' && Number.isInteger(ground) && (ground === 7 || (ground >= 9 && ground <= 15))

  return { isColor, depth, theme: asked === 'light' || asked === 'dark' ? asked : isLightGround ? 'light' : 'dark' }
}

const rgbOf = (hex: string): number[] => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16))
const LEVELS = [0, 95, 135, 175, 215, 255]

// The xterm colour nearest a page colour: one of the 6×6×6 cube or of the 24 greys.
export const nearest256 = (hex: string): number => {
  const [r = 0, g = 0, b = 0] = rgbOf(hex)
  const distance = (x: number, y: number, z: number): number => (r - x) ** 2 + (g - y) ** 2 + (b - z) ** 2
  const level = (value: number): number => LEVELS.reduce((best, one, index) => (Math.abs(one - value) < Math.abs((LEVELS[best] ?? 0) - value) ? index : best), 0)
  const [i, j, k] = [level(r), level(g), level(b)]
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)))
  const shade = 8 + 10 * grey

  return distance(shade, shade, shade) < distance(LEVELS[i] ?? 0, LEVELS[j] ?? 0, LEVELS[k] ?? 0) ? 232 + grey : 16 + 36 * i + 6 * j + k
}

// Each ink is a role of the page's palette. Secondary text is `muted`, never the terminal's own
// dim, which turns faint grey on a light background.
const ROLE = { waiting: 'waiting', accent: 'accent', done: 'done', alert: 'alert', quiet: 'muted', project: 'project', running: 'running', soon: 'soon' } as const
type Ink = keyof typeof ROLE | 'bold'

const paint = (o: { isColor: boolean; depth?: ColorDepth; theme?: Theme }) => (ink: Ink, text: string, isBold = false): string => {
  if (!o.isColor || text === '') return text
  const hex = ink === 'bold' ? null : (o.theme === 'light' ? LIGHT : DARK)[ROLE[ink]]
  const [r = 0, g = 0, b = 0] = hex === null ? [] : rgbOf(hex)
  const codes = [...(ink === 'bold' || isBold ? ['1'] : []), ...(hex === null ? [] : [o.depth === 'truecolor' ? `38;2;${r};${g};${b}` : `38;5;${nearest256(hex)}`])]

  return `\u001b[${codes.join(';')}m${text}\u001b[0m`
}

// Secondary text in the board's muted colour, for a line the script adds below the board.
export const mutedLine = (text: string, o: { isColor: boolean; depth?: ColorDepth; theme?: Theme }): string => paint(o)('quiet', text)

// The ink of a row's status: what it waits on, or its current step in the accent colour.
const toneInk = (tone: Tone, hasStep: boolean): Ink =>
  tone === 'warn' ? 'waiting' : tone === 'alert' ? 'alert' : tone === 'running' ? 'running' : tone === 'soon' ? 'soon' : tone === 'done' ? 'done' : hasStep || tone === 'accent' ? 'accent' : 'quiet'

// Chat keeps its existing budget; terminals also draw emoji and supplementary CJK wide.
const chatColumns = (char: string): number => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1)
const columns = (char: string): number => (chatColumns(char) === 2 || /[\u{20000}-\u{3fffd}\p{Emoji_Presentation}]/u.test(char) ? 2 : 1)
// Symbols of East Asian ambiguous width the board draws (● ◐ ✓ ⚑ ○ … — · ↑↓): one column in most
// terminals, two in many set up for Chinese. The Chinese board counts them as two, so its lines
// never run over; where they are drawn narrow a line only ends a little short.
const AMBIGUOUS = /[§¨°±·×÷–-‖‘’“”†-•‥-‧‰※←-⇿①-⓿─-◿☀-➿]/
const wideColumns = (char: string): number => (columns(char) === 2 || AMBIGUOUS.test(char) ? 2 : 1)
const columnsOf = (isWide: boolean): ((char: string) => number) => (isWide ? wideColumns : columns)
const isWideLang = (s: Strings): boolean => s.lang !== 'en'
export const displayColumns = (text: string, isWide = false): number => [...text].reduce((sum, char) => sum + columnsOf(isWide)(char), 0)

// Control characters out: the text comes from other agents' blocks and turns, and an escape
// sequence in it would move the cursor or clear the screen of the terminal it is printed in.
export const plain = (text: string): string => text.replace(/\t/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

const fitted = (raw: string, width: number, columnOf: (char: string) => number): string => {
  if (width <= 0) return ''
  const text = plain(raw)
  const chars = [...text]
  if (chars.reduce((sum, char) => sum + columnOf(char), 0) <= width) return text
  let used = 0
  let out = ''
  for (const char of chars) {
    if (used + columnOf(char) > width - columnOf('…')) break
    used += columnOf(char)
    out += char
  }

  return `${out}…`
}

export const fit = (raw: string, width: number, isWide = false): string => fitted(raw, width, columnsOf(isWide))

const MARK: Record<string, string> = { done: '✓', doing: '▸', todo: '○', waiting: '●', running: '◐', blocked: '!', cancelled: '–' }

// Recovery advice must stay readable even when it is longer than one terminal row.
const wrapNote = (raw: string, width: number, isWide = false): string[] => {
  const columns = columnsOf(isWide)
  const lines: string[] = []
  const limit = Math.max(2, width)
  let line = ''
  let used = 0
  for (const char of plain(raw)) {
    if (used + columns(char) > limit) {
      const space = line.lastIndexOf(' ')
      lines.push(space > 0 ? line.slice(0, space) : line)
      line = space > 0 ? line.slice(space + 1) : ''
      used = [...line].reduce((sum, one) => sum + columns(one), 0)
    }
    if (char === ' ' && line === '') continue
    line += char
    used += columns(char)
  }
  if (line !== '') lines.push(line)
  return lines
}

const stepLine = (step: ViewStep): string => `${MARK[step.status] ?? '○'} ${step.number === null ? '' : `${step.number} `}${step.text}${step.note ? ` — ${step.note}` : ''}`

// The agent a line belongs to, by the name it goes by: a hand-kept task has none, and a block
// with no agent is Claude Code's.
const agentOf = (agent: string, isAgent: boolean, s: Strings): string => (agent !== '' ? agentLabel(agent, s) : isAgent ? agentLabel('claude', s) : '')

const rowLines = (row: TaskRow, s: Strings, o: BoardOptions): string[] => {
  const c = paint(o)
  const isWide = isWideLang(s)
  const cut = (raw: string, width: number): string => fit(raw, width, isWide)
  const name = agentOf(row.agent, row.auto !== null, s)
  const who = name === '' ? '' : ` · ${name}`
  const count = row.total > 0 ? `${row.done}/${row.total} ` : ''
  const lines = [`  ${c('bold', cut(row.title, o.width - 4))}`, `    ${c('quiet', cut(`${count}${row.status}${who}${row.when ? ` · ${row.when}` : ''}`, o.width - 6))}`]
  if (row.runs) lines.push(`    ${c('quiet', cut(row.runs, o.width - 6))}`)
  if (row.context) lines.push(`    ${c('quiet', cut(row.context, o.width - 6))}`)
  for (const step of row.steps) {
    const tone = step.status === 'waiting' ? 'waiting' : step.status === 'blocked' ? 'alert' : step.isCurrent ? 'accent' : step.status === 'done' ? 'quiet' : null
    const line = cut(stepLine(step), o.width - 6)
    lines.push(`    ${tone === null ? line : c(tone, line)}`)
  }

  return lines
}

// The line of counts at the top of the board.
// It is bold throughout, as the page's is.
const countLine = (view: View, pending: readonly PendingTurn[], s: Strings, c: ReturnType<typeof paint>): string => {
  const { active, due, today } = view.overview
  const waiting = view.overview.waiting + remainingInbox(view, pending).filter(turn => turn.isQuestion).length

  return `${c('bold', s.paneTitle)}  ${c('waiting', `● ${waiting} ${s.countWaiting}`, true)}  ${c('accent', `▸ ${active} ${s.countActive}`, true)}  ${c('alert', `⚑ ${due} ${s.countDue}`, true)}  ${c('done', `✓ ${today} ${s.countToday}`, true)}`
}

// What waits on the person: the questions of the work on the board, then those in turns no
// session has taken in yet. Questions marked answered are not in `view.waiting`. `named` says
// how a project is told (the chat shows the home folder's name as `~`).
const asksOf = (view: View, pending: readonly PendingTurn[], s: Strings, named: (project: string) => string = project => project, label: (agent: string) => string = agent => agent): Array<{ where: string; text: string; task: string }> => [
  ...view.waiting.map(item => ({
    where: [named(item.project), label(item.agent)].filter(part => part !== '').join(' · '),
    text: `${s.chip(s.ask[item.kind])}${item.text}${item.note ? ` — ${item.note}` : ''}`,
    task: item.task,
  })),
  ...remainingInbox(view, pending).filter(turn => turn.isQuestion).map(turn => ({ where: [named(turn.project), label(turn.agent)].filter(part => part !== '').join(' · '), text: turn.text, task: '' })),
]

export const boardText = (view: View, pending: readonly PendingTurn[], s: Strings = ZH_TW, o: BoardOptions = { width: 80, isColor: false }): string => {
  const c = paint(o)
  const isWide = isWideLang(s)
  const cut = (raw: string, width: number): string => fit(raw, width, isWide)
  const lines: string[] = [countLine(view, pending, s, c), '']
  if (view.warning) lines.push(c('alert', view.warning), '')
  if (view.details) lines.push(c('quiet', view.details), '')

  const asks = asksOf(view, pending, s, project => project, agent => agentLabel(agent, s))
  const recentQuestions = view.recent.filter(item => (item.questions?.length ?? 0) > 0)
  for (const [title, items] of [[s.sectionQuestionReminders, view.reminder ?? []], [s.sectionOlderQuestions, view.older ?? []]] as const) {
    if (items.length === 0) continue
    lines.push(`${title} (${items.length}) · --all`)
    if (o.isIdleOpen) for (const item of items) lines.push(`  ${cut(`${item.project} › ${item.task} · ${item.when}`, o.width - 4)}`, `    ${cut(`${item.text}${item.note ? ` — ${item.note}` : ''}`, o.width - 6)}`)
  }
  // Questions marked answered in a pane are left out, and counted so they are not lost.
  const hidden = view.hidden.length === 0 ? [] : [c('quiet', s.hiddenCount(view.hidden.length))]
  if (asks.length === 0) {
    lines.push(c('done', s.nothingForYou), ...hidden, '')
  } else {
    lines.push(c('waiting', `● ${s.sectionWaiting}`, true))
    for (const ask of asks) {
      lines.push(`  ${c('project', cut(ask.where + (ask.task ? ` › ${ask.task}` : ''), o.width - 4))}`, `    ${cut(ask.text, o.width - 6)}`)
    }
    lines.push(...hidden.map(line => `  ${line}`), '')
  }

  if ((view.stoppedAsking ?? 0) > 0) lines.push(c('quiet', s.stoppedAsking(view.stoppedAsking!)), '')

  if (view.due.length > 0) {
    lines.push(c('alert', `⚑ ${s.sectionDue}`))
    for (const row of view.due) lines.push(`  ${cut(`${row.project} › ${row.title}${row.due ? ` · ${row.due.left}` : ''}`, o.width - 4)}`)
    lines.push('')
  }

  for (const group of view.groups) {
    if (group.rows.length === 0) continue
    const summary = cut(`  ${group.summary}`, Math.max(0, o.width - 3))
    lines.push(c('project', cut(`▸ ${group.project}`, o.width - displayColumns(summary, isWide)), true) + c('quiet', summary))
    for (const row of group.rows) lines.push(...rowLines(row, s, o))
    lines.push('')
  }

  for (const [rows, count] of [[view.idle, s.idleCount], [view.stopped, s.stoppedCount]] as const) {
    if (rows.length === 0) continue
    lines.push(c('quiet', o.isIdleOpen ? count(rows.length) : `${count(rows.length)} · --all`))
    if (o.isIdleOpen) {
      for (const row of rows) {
        lines.push(`  ${c('project', cut(row.project, o.width - 4), true)}`, ...rowLines(row, s, o))
      }
    }
    lines.push('')
  }

  if (recentQuestions.length > 0) {
    lines.push(c('done', s.sectionRecent))
    for (const item of recentQuestions) {
      lines.push(`  ${cut(`${item.project} › ${item.title} · ${item.when}`, o.width - 4)}`)
      for (const question of item.questions ?? []) lines.push(`    ${cut(`${question.text}${question.note ? ` — ${question.note}` : ''}`, o.width - 6)}`)
    }
    lines.push('')
  }
  const news = pending.filter(turn => !turn.isQuestion)
  if (news.length > 0) {
    lines.push(c('accent', `◐ ${s.boardInbox}`))
    for (const turn of news) lines.push(`  ${cut(`${[turn.project, agentLabel(turn.agent, s)].filter(part => part !== '').join(' · ')}: ${turn.text}`, o.width - 4)}`)
    lines.push('')
  }

  if (view.groups.every(group => group.rows.length === 0) && asks.length === 0 && news.length === 0 && view.idle.length === 0 && view.stopped.length === 0 && view.due.length === 0 && recentQuestions.length === 0) lines.push(c('quiet', s.empty), '')
  // Runs agents started for themselves, with no session known: one folded line, never in the counts (#399).
  if (view.background) lines.push(c('quiet', cut(view.background, o.width)), '')
  for (const line of view.health ?? []) lines.push(...wrapNote(line, o.width - 2, isWide).map(part => c('quiet', part)))

  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

// The board for a phone, in a chat app (`--chat`): its reply is sent as it is, so nothing in
// it may be a link that only opens on this computer, a path that names the person's account,
// or a credential. Every line goes through `redact`. It names the credential forms below, not
// every secret there could be.
const MASK = '•••'

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Every way the home folder is written: both slashes, the doubled backslashes that JSON and
// Python error messages print, and on Windows the form Git Bash gives (/c/Users/me). A folder
// name may hold spaces.
const homeForms = (home: string): string[] => {
  const folder = home.replace(/[\\/]+$/, '')
  if (folder === '') return []
  const slashed = folder.replace(/\\/g, '/')
  const drive = /^([A-Za-z]):\//.exec(slashed)
  const forms = new Set([folder, slashed, slashed.replace(/\//g, '\\'), slashed.replace(/\//g, '\\\\'), ...(drive === null ? [] : [`/${drive[1]}${slashed.slice(2)}`])])

  return [...forms].sort((a, b) => b.length - a.length)
}

// Another account's folder, or this one written as this computer does not report it (WSL's
// /mnt/c/Users/me). A name here may hold spaces ("Jane Doe"), up to three words: where it ends
// is the slash after it, and more words than that is a sentence, not a name. A path in a link
// (`https://site/home/x`) is not one: a word comes before its slash.
const NAME_WORD = '[^\\\\/\\s:*?"<>|`\'()]+'
const OTHER_HOMES = new RegExp(`(?<![\\w.-])(?:[A-Za-z]:[\\\\/]Users|\\/mnt\\/[A-Za-z]\\/Users|\\/Users|\\/home)[\\\\/]${NAME_WORD}(?: ${NAME_WORD}){0,2}(?=[\\\\/])`, 'gi')

// A secret's name, then its value: quoted (it may hold spaces) or up to the next space. A quote
// that is never closed hides the rest of the line: where the value ends is not known. The name
// before the keyword is kept short, so a long unbroken word is not tried from every letter.
const VALUE = `"[^"\\n]*(?:"|$)|'[^'\\n]*(?:'|$)|\\S+`
const ASSIGNED = new RegExp(`([\\w-]{0,40}(?:key|secret|token|pass(?:word|wd)?|pwd|credentials?)["']?[ \\t]*[:=][ \\t]*)(${VALUE})`, 'gim')
const FLAG = new RegExp(`(--(?:password|token|secret|api-key)[= ])(?:${VALUE})`, 'gim')
const BEARER = /\b(Bearer)\s+\S+/gi
// "Basic" is also a plain word ("Basic setup"): what follows must look like an encoded
// value, four letters or more with a capital, a digit, + / or = after its first letter.
const BASIC = /\b([Bb]asic)\s+(?=\S[A-Za-z0-9+/_-]*[A-Z0-9+/=])[A-Za-z0-9+/_-]{4,}={0,2}/g
const PREFIXED = /(?<![A-Za-z0-9])(?:(?:sk-|sk_(?:live|test)_|rk_|xox[abprs]-|glpat-|AIza|hf_|npm_|gh[pousr]_|github_pat_)[\w-]+|A(?:KIA|SIA)[0-9A-Z]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g
// A user may be empty (`redis://:secret@host`) and a password may hold an @ or a / (an access
// key does): it runs to the last @ before a space, and the host follows. That also hides the @
// of a link's own query (`http://host:3000/a?mail=a@b.com`): the safe side. `ssh://git@host`,
// `https://a@b.com` and `mailto:` have no password.
const USER_PASS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]*:\S*@/gi
// The board's own address carries its key as ?t=; other links carry theirs under these names.
const KEYED = 't|token|access_token|id_token|auth|key|api_key|apikey|secret|sig|signature'
const KEYED_LATER = new RegExp(`&(?:${KEYED})=[^&\\s#]*`, 'gi')
const KEYED_FIRST_MORE = new RegExp(`\\?(?:${KEYED})=[^&\\s#]*&`, 'gi')
const KEYED_FIRST = new RegExp(`\\?(?:${KEYED})=[^&\\s#]*`, 'gi')

// `home` is the person's home folder (`os.homedir()`); on Windows a folder's letters may be
// written in any case.
export const redact = (text: string, home: string, isWindows = false): string => {
  const forms = homeForms(home)
  const own = forms.length === 0 ? null : new RegExp(`(?<![\\w.-])(?:${forms.map(escapeRegExp).join('|')})(?![\\w-]|\\.\\w)`, isWindows ? 'gi' : 'g')

  return (own === null ? text : text.replace(own, '~'))
    .replace(OTHER_HOMES, '~')
    .replace(USER_PASS, `$1${MASK}@`)
    .replace(KEYED_LATER, '')
    .replace(KEYED_FIRST_MORE, '?')
    .replace(KEYED_FIRST, '')
    .replace(FLAG, `$1${MASK}`)
    .replace(BEARER, `$1 ${MASK}`)
    .replace(BASIC, `$1 ${MASK}`)
    .replace(ASSIGNED, (assignment, head: string, value: string, at: number, whole: string) => {
      // A bare key/token label can describe a quota or other ordinary work ("key: 100",
      // "token: budget"). Only a number of up to five digits or one plain word stays, and only
      // when the label stands alone ("api.key:", "$key:" are names). A one-time code, a value
      // mixing letters and digits ("hunter2"), a code in capitals, an assignment, a quoted
      // value or a long token is masked.
      const isDescription = /^(?:key|token)[ \t]*:[ \t]*$/i.test(head) && (at === 0 || /\s/.test(whole[at - 1] ?? '')) && /^(?:\d{1,5}|[A-Za-z][a-z]{0,18})$/.test(value)
      return isDescription ? assignment : `${head}${MASK}`
    })
    .replace(PREFIXED, MASK)
}

// A message in a chat app is cut off a little past this (Telegram's is 4,096).
export const CHAT_MAX = 3500
const CHAT_LINE = 200

// Control characters out first (they could split a secret into a shape the patterns miss),
// then the secrets and the home folder, then cut to length: the last cut is after the patterns,
// so a secret is never half cut into something they no longer know. The text is clipped before
// them too, since another agent writes it and it can be any length; that clip drops the word it
// falls in, so a secret is never half cut there either (a half of one is not a shape the
// patterns know). A text that fits is left whole.
const CHAT_CLIP = 600

// The start of a folder left at the end of a clipped line is no whole folder for `redact` to
// know, and shows part of a name ("C:\Users\Jane" of "C:\Users\Jane Doe"): it goes too, for
// this home folder in each way it is written, and for another account's.
const OTHER_HOME_START = /(?<![\w.-])(?:[A-Za-z]:[\\/]Users|\/mnt\/[A-Za-z]\/Users|\/Users|\/home)(?:[\\/][^\\/]*)?$/i
const withoutHomeStart = (text: string, home: string, isWindows: boolean): string => {
  const fold = (value: string): string => (isWindows ? value.toLowerCase() : value)
  const tail = fold(text)
  let cut = text.length
  for (const form of homeForms(home)) {
    for (let length = form.length - 1; length >= 1; length -= 1) {
      const start = text.length - length
      if (start < cut && tail.endsWith(fold(form.slice(0, length))) && !/[\w.-]/.test(text[start - 1] ?? '')) cut = start
    }
  }

  return text.slice(0, cut).replace(OTHER_HOME_START, '').trimEnd()
}

const clipped = (text: string, home: string, isWindows: boolean): string =>
  text.length <= CHAT_CLIP ? text : withoutHomeStart(text.slice(0, CHAT_CLIP).replace(/\s*\S*$/, ''), home, isWindows)

const chatLine = (text: string, indent: number, home: string, isWindows: boolean): string =>
  `${' '.repeat(indent)}${fitted(redact(clipped(plain(text), home, isWindows), home, isWindows), CHAT_LINE - indent, chatColumns)}`

// What finished today, by the local calendar day, from the journal and in the weekly report's
// own words (`project · task: step, step`).
export const doneToday = (journal: string, now: number, s: Strings = ZH_TW): string[] => {
  const day = localDay(now)
  const entries = parseJournal(journal).filter(entry => entry.at === day)

  return entries.length === 0 ? [] : progressReport(entries, [], null, now, 1, s).split('\n').slice(3).map(line => line.replace(/^- /, ''))
}

// Plain text with no link and no colour: the counts, what waits on the person (each with its
// project and agent), one line for each task with its next step, then what was done today.
// Cut at `max` characters, with how many items were left out. The questions come first, so
// they are the last to go.
export const chatText = (
  view: View,
  pending: readonly PendingTurn[],
  done: readonly string[],
  s: Strings,
  home: string,
  isWindows = false,
  max = CHAT_MAX,
  now?: number,
): string => {
  const line = (text: string, indent = 0): string => chatLine(text, indent, home, isWindows)
  // A session started in the home folder is named after it, and the folder's name is the person's.
  const folder = home.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? ''
  const isHome = (name: string): boolean => folder !== '' && (isWindows ? name.toLowerCase() === folder.toLowerCase() : name === folder)
  const named = (project: string): string => (isHome(project) ? '~' : project)
  const asks = asksOf(view, pending, s, named)
  const rows = [...view.due.map(row => ({ row, mark: '⚑' })), ...view.groups.flatMap(group => group.rows.map(row => ({ row, mark: '▸' })))]
  // Each item is cut whole, never in the middle. A heading belongs to its first item.
  const items: string[] = [chatLine(countLine(view, pending, s, paint({ isColor: false })), 0, home, isWindows)]
  if (view.warning) items[0] += `\n${view.warning}`
  if (view.details) items[0] += `\n${view.details}`
  // Questions marked answered are left out and counted, as on the terminal board.
  const hidden = view.hidden.length === 0 ? null : s.hiddenCount(view.hidden.length)
  if (asks.length === 0) items.push(`\n${s.nothingForYou}${hidden === null ? '' : `\n${hidden}`}`)
  asks.forEach((ask, index) => {
    items.push([...(index === 0 ? ['', `● ${s.sectionWaiting}`] : []), line(ask.where + (ask.task ? ` › ${ask.task}` : ''), 2), line(ask.text, 4)].join('\n'))
  })
  if (asks.length > 0 && hidden !== null) items.push(`  ${hidden}`)
  if ((view.stoppedAsking ?? 0) > 0) items.push(line(s.stoppedAsking(view.stoppedAsking!)))
  const news = pending.filter(turn => !turn.isQuestion)
  news.forEach((turn, index) => {
    const at = turn.sourceAt ?? turn.at
    const when = now !== undefined && Number.isFinite(at) && at > 0 && at <= now ? relativeTime(at, now, s) : ''
    items.push([...(index === 0 ? ['', `◐ ${s.chatPendingReports}`] : []), line(`${[named(turn.project), turn.agent].filter(part => part !== '').join(' · ')} · ${s.chatReportTime(when)}`, 2), line(turn.hasSummary === false ? s.chatNoSummary : turn.text, 4)].join('\n'))
  })
  // The copies of a stopped row's questions (`older::`) are told once below, under their row.
  for (const [title, shelf] of [[s.sectionQuestionReminders, view.reminder ?? []], [s.sectionOlderQuestions, (view.older ?? []).filter(item => !item.key.startsWith('older::'))]] as const) {
    if (shelf.length === 0) continue
    items.push(`\n${title} (${shelf.length})`)
    for (const item of shelf) items.push(line(`${named(item.project)} › ${item.task} · ${item.when}`, 2), line(`${item.text}${item.note ? ` — ${item.note}` : ''}`, 4))
  }
  if (view.idle.length > 0) items.push(line(s.idleCount(view.idle.length)))
  if (view.stopped.length > 0) items.push(line(s.stoppedCount(view.stopped.length)))
  if (view.background) items.push(line(view.background))
  for (const row of view.stopped.filter(row => (row.questions?.length ?? 0) > 0)) {
    items.push(line(`${named(row.project)} › ${row.title} · ${row.when}`, 2))
    for (const question of row.questions ?? []) items.push(line(`${question.text}${question.note ? ` — ${question.note}` : ''}`, 4))
  }
  const recentQuestions = view.recent.filter(item => (item.questions?.length ?? 0) > 0)
  if (recentQuestions.length > 0) {
    items.push(`\n${s.sectionRecent}`)
    for (const item of recentQuestions) {
      items.push(line(`${named(item.project)} › ${item.title} · ${item.when}`, 2))
      for (const question of item.questions ?? []) items.push(line(`${question.text}${question.note ? ` — ${question.note}` : ''}`, 4))
    }
  }
  // A question is told above, answered or not: it is never the "next step" of its task.
  const isNext = (step: ViewStep): boolean => step.number !== null && !['done', 'cancelled', 'waiting'].includes(step.status)
  rows.forEach(({ row, mark }, index) => {
    const next = (row.steps.find(step => step.isCurrent && isNext(step)) ?? row.steps.find(isNext))?.text
    const words = `${mark} ${isSameName(row.project, row.title) ? named(row.project) : `${named(row.project)} › ${row.title}`}${row.hasFutureTime ? ` · ${row.when}` : ''}${row.due === null ? '' : ` · ${row.due.left}`}${next === undefined ? '' : ` — ${s.reportNext(next)}`}${row.runs ? ` · ${row.runs}` : ''}`
    items.push(`${index === 0 ? '\n' : ''}${line(words)}`)
  })
  if (asks.length === 0 && rows.length === 0 && news.length === 0 && view.idle.length === 0 && view.stopped.length === 0 && recentQuestions.length === 0) items.push(s.empty)
  // Each starts with its project (`project · task: step`).
  const doneWords = (words: string): string => {
    const [project = '', ...rest] = words.split(' · ')

    return rest.length > 0 && isHome(project) ? ['~', ...rest].join(' · ') : words
  }
  done.forEach((words, index) => items.push(`${index === 0 ? '\n' : ''}${line(`✓ ${doneWords(words)}`, 2)}`))

  const length = (list: readonly string[]): number => list.reduce((sum, item) => sum + item.length + 1, 0)
  let shown = items.length
  if (length(items) > max) {
    // The "+N more" line is part of the message, so room is kept for it.
    const room = max - s.chatMore(items.length).length - 2
    shown = 1
    while (shown < items.length && length(items.slice(0, shown + 1)) <= room) shown += 1
  }
  const text = items.slice(0, shown).join('\n')

  return `${shown < items.length ? `${text}\n\n${s.chatMore(items.length - shown)}` : text}\n`
}

// The board you can work in, for a terminal beside another agent (`--watch` on a terminal):
// pick a line with the arrows, open it, tick its next step, archive it, or copy what to say
// to the agent that asked. What it can do is what the pane does; the writes themselves are
// the script's, through the same pure functions the pane uses (setManualStep, takeTask).

export type BoardItem =
  | { type: 'ask'; key: string; ask: WaitingItem }
  | { type: 'row'; key: string; row: TaskRow }
  | { type: 'turn'; key: string; turn: PendingTurn }

// `key` is the chosen line's, so the choice stays on it when lines above it come or go. `seen`
// holds each line's fingerprint as the last draw showed it (null before the first draw).
export type BoardState = { selected: number; key: string | null; open: string | null; note: string; tone?: 'done' | 'alert' | 'quiet'; copyText?: string; result?: { key: string; revision: string | null; label: string }; seen: Record<string, string> | null; isIdleOpen?: boolean; isOlderOpen?: boolean }

export type BoardAction =
  | { type: 'tick'; ref: StepRef }
  | { type: 'archive'; ref: TaskRef; title: string }
  | { type: 'done'; ref: ConfirmRef; title: string }
  | { type: 'copy'; text: string }
  // Kept off Waiting on you until the question changes (`hideKey`); null shows every hidden one
  // again. Only the hidden list beside progress.md is written: nothing goes to the agent.
  | { type: 'hide'; key: string; text: string }
  | { type: 'unhide'; key: string | null }
  | { type: 'html' }
  | { type: 'quit' }
  // An answer the running page sends into the question's session, as its own button would.
  | { type: 'send'; key: string; text: string; route: AnswerRoute }
  // Archive now: every finished task, as the page's button under Done recently.
  | { type: 'tidy' }

export const emptyBoardState: BoardState = { selected: 0, key: null, open: null, note: '', seen: null }

// The line on screen that the keys act on. A line whose key is gone was replaced under the
// cursor since the screen was drawn; isGone stops a key from acting on a line not yet seen.
const chosen = (state: BoardState, items: readonly BoardItem[]): number => {
  const byKey = state.key === null ? -1 : items.findIndex(item => item.key === state.key)
  return byKey >= 0 ? byKey : Math.min(state.selected, Math.max(0, items.length - 1))
}

// In the order the screen shows them: what waits on you, each project's work, then turns
// no Claude Code session has taken in.
// The key of a question on the reminder or Older shelf: the page names the line it drew by it. It
// holds the key a Hide would write (`hideKey`), which changes when another copy of the question
// arrives, so a press made before that is refused rather than taken for the new copy.
export const olderKey = (ask: WaitingItem): string => `older:${ask.key}@${ask.questionId}@${ask.hideKey}`

// The full action catalog includes idle rows for the page server. Terminal callers pass
// their shelf state so only rows the person can see are selectable.
export const boardItems = (view: View, pending: readonly PendingTurn[], isIdleOpen = true, isOlderOpen = false): BoardItem[] => {
  // The page's order: what is working now, then the rest by project, work due soon first; a row
  // is listed once.
  const shelved = new Set([...view.idle, ...view.stopped].map(row => row.key))
  const listed = [...view.due, ...view.groups.flatMap(group => group.rows), ...(isIdleOpen ? [...view.idle, ...view.stopped] : [])].filter((row, index, all) => all.findIndex(one => one.key === row.key) === index)
  const isWorking = (row: TaskRow): boolean => row.auto === 'working' && !shelved.has(row.key)
  const rest = listed.filter(row => !isWorking(row))
  const rows = [...listed.filter(isWorking), ...[...new Set(rest.map(row => row.project))].flatMap(project => rest.filter(row => row.project === project))]

  return [
    // A question's key holds its words, so a press made while it showed one question is refused
    // once the same step asks another, rather than taken as the answer to the new one.
    ...view.waiting.map(ask => ({ type: 'ask' as const, key: ask.hideKey === '' ? `ask:${ask.key}` : `ask:${ask.key}@${ask.hideKey}`, ask })),
    ...(isOlderOpen ? [...(view.reminder ?? []), ...(view.older ?? [])].map(ask => ({ type: 'ask' as const, key: olderKey(ask), ask })) : []),
    ...rows.map(row => ({ type: 'row' as const, key: `row:${row.key}`, row })),
    ...remainingInbox(view, pending).map((turn, index) => ({ type: 'turn' as const, key: `turn:${turn.agent}:${turn.project}:${index}`, turn })),
  ]
}

// How many hand-kept tasks and questions of `items` share this one's project and title. Two
// such tasks have no block id to tell them apart and the second one is keyed `#2`; once the
// first is gone the second takes the first's key with the same words. The count is what
// changes when a twin comes or goes.
const twinsOf = (item: BoardItem, items: readonly BoardItem[]): number => {
  const [project, title] = item.type === 'ask' ? [item.ask.project, item.ask.task] : item.type === 'row' ? [item.row.project, item.row.title] : ['', '']
  const tasks = new Set<string>()
  for (const one of items) {
    if (one.type === 'row' && one.row.project === project && one.row.title === title) tasks.add(one.row.key)
    // A question's key is its task's key and the step's number.
    if (one.type === 'ask' && one.ask.project === project && one.ask.task === title) tasks.add(one.ask.key.replace(/::\d+$/, ''))
  }

  return tasks.size
}

// Which block a line is and the words it shows, as a short hash. A key is only a project and a
// title (and a question's step number), which another session's block, or the same step
// reworded, can take over between a draw and a press. Whoever draws a line keeps its
// fingerprint, and a tick, an archive, a reply or a copy acts only while the line still has it.
// `items` are the lines drawn together with it: a hand-kept task has no block id, so its
// fingerprint also holds how many tasks share its project and title.
export const fingerprint = (item: BoardItem, items: readonly BoardItem[]): string => {
  const session = item.type === 'ask' ? (item.ask.target?.session ?? item.ask.session) : item.type === 'row' ? (item.row.archive?.session ?? item.row.target?.session ?? '') : ''
  const parts =
    item.type === 'ask'
      ? [session, item.ask.target?.resume ?? '', item.ask.project, item.ask.task, item.ask.text, item.ask.note]
      : item.type === 'row'
        ? [session, item.row.target?.resume ?? '', item.row.project, item.row.title, item.row.next?.step ?? '', item.row.question ?? '', item.row.resume ?? '']
        : [item.turn.agent, item.turn.project, item.turn.text]
  if (item.type === 'row') parts.push(item.row.confirm?.expected ?? '', JSON.stringify(item.row.steps))
  if (item.type !== 'turn' && session === '') parts.push(String(twinsOf(item, items)))

  return sha256(parts.join('\u0000')).slice(0, 12)
}

// What each key does on the selected line, so the footer lists only keys that do something.
export const answersOf = (ask: WaitingItem, s: Strings): string[] =>
  ask.kind === 'confirm' ? [s.yesAnswer, s.noAnswer] : ask.kind === 'choose' ? ask.options.slice(0, 9) : []

// The state with the chosen line's key set, so a key pressed later acts on the line that was
// on screen, or on nothing if that line has gone, and with every line's fingerprint as drawn.
// The script calls it each time it draws, and only then.
export const pinned = (state: BoardState, items: readonly BoardItem[]): BoardState => {
  if (state.result !== undefined) {
    const item = items.find(item => item.key === state.result?.key)
    const revision = item === undefined ? '' : fingerprint(item, items)
    if (state.result.revision === null) state = { ...state, result: { ...state.result, revision } }
    else if (state.result.revision !== revision) state = { ...state, result: undefined, note: '', copyText: undefined }
  }
  const at = chosen(state, items)
  if (state.key !== null && items[at]?.key !== state.key) return state

  return { ...state, selected: at, key: items[at]?.key ?? null, seen: Object.fromEntries(items.map(item => [item.key, fingerprint(item, items)])) }
}

export const boardKey = (state: BoardState, key: string, items: readonly BoardItem[], s: Strings = ZH_TW, routes: Readonly<Record<string, AnswerRoute>> = {}): { state: BoardState; action: BoardAction | null } => {
  if (key === 'q' || key === '\u0003') return { state, action: { type: 'quit' } }
  state = { ...state, note: '', tone: 'alert', copyText: undefined, result: undefined }
  const last = Math.max(0, items.length - 1)
  const at = chosen(state, items)
  const item = items[at]
  const isGone = state.key !== null && item?.key !== state.key
  const moved = (selected: number): { state: BoardState; action: null } => ({ state: { ...state, selected, key: items[selected]?.key ?? null, note: '' }, action: null })
  if (key === 'up' || key === 'k') return moved(Math.max(0, at - 1))
  if (key === 'down' || key === 'j') return moved(Math.min(last, at + 1))
  if (key === 'o') return { state, action: { type: 'html' } }
  if (key === 'i') return { state: { ...state, isIdleOpen: !state.isIdleOpen, selected: 0, key: null, open: null, note: state.isIdleOpen ? s.pressClosed : s.pressOpened, tone: 'done', seen: {} }, action: null }
  if (key === 'l') return { state: { ...state, isOlderOpen: !state.isOlderOpen, selected: 0, key: null, open: null, note: state.isOlderOpen ? s.pressClosed : s.pressOpened, tone: 'done', seen: {} }, action: null }
  if (key === 'u') return { state, action: { type: 'unhide', key: null } }
  // Archive now, as the page's button under Done recently does: every finished task goes at once.
  if (key === 't') return { state, action: { type: 'tidy' } }
  if (item === undefined) return { state: { ...state, note: s.pressNothing }, action: null }
  state = { ...state, result: { key: item.key, revision: fingerprint(item, items), label: item.type === 'ask' ? item.ask.task : item.type === 'row' ? item.row.title : item.turn.project } }
  // The line under the cursor changed since the screen was drawn: choose what is there now and
  // let the person look before a key acts on it.
  const changed = { state: { ...state, selected: at, key: item.key, note: s.boardLineChanged }, action: null }
  if (isGone) return changed
  // A tick, an archive or a copy of what to say acts on the line as the last draw showed it: the
  // same key can now be another session's block, or the same step reworded.
  const isSeen = state.seen === null || state.seen[item.key] === fingerprint(item, items)
  if ((key === 'x' || key === 'a' || key === 'd' || key === 'c' || key === 'h') && !isSeen) return changed
  if (key === 'enter' || key === ' ') return { state: { ...state, selected: at, key: item.key, open: state.open === item.key ? null : item.key, note: state.open === item.key ? s.pressClosed : s.pressOpened, tone: 'done' }, action: null }
  if (item.type === 'ask') {
    const { ask } = item
    if (key === 'x' && ask.step !== null) return { state, action: { type: 'tick', ref: ask.step } }
    if (key === 'h' && ask.hideKey !== '' && ask.canHide !== false) return { state, action: { type: 'hide', key: ask.hideKey, text: ask.text } }
    if (key === 'c' && (ask.command ?? ask.link) !== null) return { state, action: { type: 'copy', text: plain((ask.command ?? ask.link) as string) } }
    // Copy an actionable command on demand; a raw session id is not a clipboard action.
    const back = replyHint(ask, s).reopen
    if (key === 'c' && back !== null) return { state, action: { type: 'copy', text: plain(back) } }
    const answers = answersOf(ask, s)
    const pick = ask.kind === 'confirm' ? ['y', 'n'].indexOf(key) : /^[1-9]$/.test(key) ? Number(key) - 1 : -1
    const answer = pick >= 0 ? answers[pick] : undefined
    // Where the running page can answer into the session, the key sends the answer, as the
    // page's button does; elsewhere it copies it to paste into the agent.
    const route = routes[item.key]
    if (answer !== undefined && route !== undefined) return isSeen ? { state, action: { type: 'send', key: item.key, text: plain(answer), route } } : changed
    if (answer !== undefined) return { state, action: { type: 'copy', text: plain(answer) } }
    // Said only when asked: a live session's question is that session's to take off the board.
    if (key === 'a' && ask.where !== 'manual' && ask.isKept !== true && ask.canHide !== false) return { state: { ...state, note: s.archiveLive, tone: 'quiet' }, action: null }
  }
  if (item.type === 'row') {
    const { row } = item
    if (key === 'x' && row.next !== null) return { state, action: { type: 'tick', ref: row.next } }
    if (key === 'a' && row.archive !== null) return { state, action: { type: 'archive', ref: row.archive, title: row.title } }
    if (key === 'a' && (row.auto === 'working' || row.auto === 'waiting')) return { state: { ...state, note: s.archiveLive, tone: 'quiet' }, action: null }
    if (key === 'd' && row.confirm != null) return { state, action: { type: 'done', ref: row.confirm, title: row.title } }
    if (key === 'c' && row.resume !== null) return { state, action: { type: 'copy', text: plain(row.resume) } }
  }

  return { state: { ...state, note: s.pressNothing }, action: null }
}

const keysFor = (item: BoardItem | undefined, s: Strings, routes: Readonly<Record<string, AnswerRoute>>): string[] => {
  if (item === undefined) return []
  if (item.type === 'ask') {
    const { ask } = item
    const answers = answersOf(ask, s)
    const isSent = routes[item.key] !== undefined
    return [
      ...(ask.step !== null ? [s.boardKeyTick] : []),
      ...(ask.kind === 'confirm' ? [isSent ? s.boardKeyConfirmSend : s.boardKeyConfirm] : answers.length > 0 ? [isSent ? s.boardKeyOptionsSend(answers.length) : s.boardKeyOptions(answers.length)] : []),
      ...((ask.command ?? ask.link) !== null
        ? [s.boardKeyCopyCommand]
        : replyHint(ask, s).reopen !== null
          ? [s.boardKeyCopyResume]
          : []),
      ...(ask.hideKey !== '' && ask.canHide !== false ? [s.boardKeyHide] : []),
    ]
  }
  if (item.type === 'row') {
    const { row } = item
    return [...(row.next !== null ? [s.boardKeyTick] : []), ...(row.confirm != null ? [s.boardKeyDone] : []), ...(row.archive !== null ? [s.boardKeyArchive] : []), ...(row.resume !== null ? [s.boardKeyCopyResume] : [])]
  }

  return []
}

// Nothing on the board at all, not even something finished: the screen says how work comes.
export const isEmptyBoard = (view: View, pending: readonly PendingTurn[]): boolean =>
  boardItems(view, pending, true, true).length === 0 && view.recent.length === 0

// The agents that reported to this board: from the names of their turns in progress-inbox
// (`codex-turn-…`), and from the blocks it shows. A block with no agent is Claude Code's.
const INBOX_AGENT = /^([a-z0-9]+)-(?:prompt|turn|end)-/
export const boardAgents = (inbox: readonly string[], view: View, pending: readonly PendingTurn[]): string[] => [
  ...new Set([
    ...inbox.map(name => INBOX_AGENT.exec(name)?.[1] ?? ''),
    ...[...view.groups.flatMap(group => group.rows), ...view.idle, ...view.stopped].map(row => row.agent || (row.auto === null ? '' : 'claude')),
    ...(view.finished ?? []).map(item => item.agent || 'claude'),
    ...pending.map(turn => turn.agent),
  ].filter(agent => agent !== '')),
]

// The questions the running page answers into their session, from the board it serves
// (`/api/board`): the same fields its buttons send back.
export const routesOf = (model: unknown): Record<string, AnswerRoute> => {
  const asks = (model as { asks?: unknown } | null)?.asks
  const routes: Record<string, AnswerRoute> = {}
  if (!Array.isArray(asks)) return routes
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  for (const one of asks as unknown[]) {
    if (one === null || typeof one !== 'object') continue
    const ask = one as Record<string, unknown>
    const key = text(ask.key)
    if (key === '') continue
    const fields = { agent: text(ask.agent), session: text(ask.session), asked: text(ask.text), fp: text(ask.fp) }
    const delivery = ask.delivery as Record<string, unknown> | null | undefined
    if (ask.send === 'connected' && delivery != null && typeof delivery === 'object' && text(delivery.id) !== '' && text(delivery.turn) !== '') routes[key] = { mode: 'connected', ...fields, delivery: { id: text(delivery.id), turn: text(delivery.turn), agent: text(delivery.agent) } }
    else if (ask.send === 'send') routes[key] = { mode: 'send', ...fields }
  }

  return routes
}

// The terminal board is drawn on the terminal's second screen, which leaving gives back as it was.
export const SCREEN_ENTER = '\u001b[?1049h\u001b[?25l'
export const SCREEN_LEAVE = '\u001b[?25h\u001b[?1049l'

// One write per change, with no clearing of the whole screen, so nothing flickers: the cursor
// home, each line cleared to its end, and everything below the last cleared. Null when the screen
// is what was drawn last, so nothing is written. With the terminal's height known, a board longer
// than the screen keeps its last line and drops what does not fit, so the terminal never scrolls.
// `focus` is the selected line's first and last screen line: the window moves to show it, since
// the keys act on that line and the second screen has no scrollback to find it in.
export const frame = (previous: string | null, screen: string, rows = 0, focus: readonly [number, number] | null = null): string | null => {
  if (screen === previous) return null
  const all = screen.replace(/\n+$/, '').split('\n')
  const room = rows - 1
  const body = all.slice(0, -1)
  const from = focus === null ? 0 : Math.max(0, Math.min(focus[0], focus[1] - room + 1, body.length - room))
  const shown = rows > 1 && all.length > rows ? [...body.slice(from, from + room), all.at(-1) ?? ''] : all

  return `\u001b[H${shown.map(line => `${line}\u001b[K`).join('\n')}\u001b[J`
}

export const boardScreen = (view: View, pending: readonly PendingTurn[], state: BoardState, s: Strings = ZH_TW, o: BoardOptions = { width: 80, isColor: false }): string =>
  boardLayout(view, pending, state, s, o).screen

// The screen and where on it the selected line is (its heading, row and open lines), for `frame`.
export const boardLayout = (view: View, pending: readonly PendingTurn[], state: BoardState, s: Strings = ZH_TW, o: BoardOptions = { width: 80, isColor: false }): { screen: string, focus: readonly [number, number] | null } => {
  const c = paint(o)
  const isWide = isWideLang(s)
  const cut = (raw: string, width: number): string => fit(raw, width, isWide)
  const cols = (text: string): number => displayColumns(text, isWide)
  const wrap = (text: string, width: number): string[] => wrapNote(text, width, isWide)
  const routes = o.routes ?? {}
  const items = boardItems(view, pending, state.isIdleOpen ?? false, state.isOlderOpen ?? false)
  const shelved = new Set([...view.idle, ...view.stopped].map(row => row.key))
  const at = chosen(state, items)
  const lines: string[] = [
    countLine(view, pending, s, c),
    ...(view.warning ? [c('alert', view.warning)] : []),
    ...(view.details ? [c('quiet', view.details)] : []),
    ...((view.stoppedAsking ?? 0) > 0 ? [c('quiet', `${s.stoppedAsking(view.stoppedAsking!)} · ${s.boardKeyOlder}`)] : []),
    ...(view.hidden.length === 0 ? [] : [c('quiet', `${s.hiddenCount(view.hidden.length)} · ${s.boardKeyShowHidden}`)]),
    ...((view.reminder?.length ?? 0) + (view.older?.length ?? 0) === 0 ? [] : [c('quiet', `${s.sectionQuestionReminders}: ${view.reminder?.length ?? 0} · ${s.sectionOlderQuestions}: ${view.older?.length ?? 0} · ${s.boardKeyOlder}`)]),
    ...(view.idle.length + view.stopped.length === 0 ? [] : [c('quiet', [
      view.idle.length === 0 ? '' : s.idleCount(view.idle.length),
      view.stopped.length === 0 ? '' : s.stoppedCount(view.stopped.length),
      s.boardKeyIdle,
    ].filter(part => part !== '').join(' · '))]),
    ...(view.background ? [c('quiet', cut(view.background, o.width))] : []),
    '',
  ]
  // A title on the left and its agent and age on the right, so the ages end in one column.
  const titled = (indent: number, title: string, meta: string, isHere: boolean, ink?: Ink): string => {
    const room = o.width - indent - 2
    const right = meta === '' ? '' : cut(meta, Math.max(0, Math.min(30, room - 14)))
    const left = cut(title, room - (right === '' ? 0 : cols(right) + 2))
    const gap = right === '' ? '' : ' '.repeat(Math.max(2, room - cols(left) - cols(right)))
    return `${isHere ? c(ink ?? 'bold', left, true) : ink === undefined ? left : c(ink, left)}${gap}${c('quiet', right)}`
  }
  const muted = (text: string, indent: string): string[] => wrap(text, o.width - indent.length - 2).map(part => `${indent}${c('quiet', part)}`)
  const result = state.result
  const resultItem = result === undefined ? undefined : items.find(item => item.key === result.key)
  const hasResult = result === undefined || result.revision === null || result.revision === (resultItem === undefined ? '' : fingerprint(resultItem, items))
  const resultLines = (indent: string): void => {
    if (!hasResult) return
    if (state.copyText !== undefined) lines.push(`${indent}${c('alert', cut(s.boardCopyFailed(''), o.width - indent.length))}`, plain(state.copyText))
    else if (state.note !== '') {
      const notes = wrap(state.note, o.width - indent.length)
      lines.push(...notes.map(line => `${indent}${c(state.tone ?? 'done', line)}`))
    }
  }
  // A line that went with the press (a question hidden with h) leaves its note under its task's
  // row when that still shows, so the task's title is not told twice.
  const isOrphan = result !== undefined && resultItem === undefined && hasResult && state.note !== ''
  const host = isOrphan ? items.find(item => item.type === 'row' && item.row.title === result.label)?.key ?? null : null
  let section = ''
  let focus: readonly [number, number] | null = null
  const drawItem = (item: BoardItem, index: number): void => {
    const isHere = index === at
    const isOpen = state.open === item.key
    const mark = isHere ? c('accent', '›', true) : ' '
    const isWorking = item.type === 'row' && item.row.auto === 'working' && !shelved.has(item.row.key)
    const head =
      item.type === 'ask' ? `● ${item.ask.ageStage === 'older' ? s.sectionOlderQuestions : item.ask.ageStage === 'reminder' ? s.sectionQuestionReminders : s.sectionWaiting}` : item.type === 'row' ? (isWorking ? `▸ ${s.sectionActive}` : item.row.project) : `◐ ${s.boardInbox}`
    const headKey = item.type === 'row' && !isWorking ? `project:${head}` : head
    if (headKey !== section) {
      if (section !== '') lines.push('')
      lines.push(c(item.type === 'ask' ? 'waiting' : item.type === 'row' && !isWorking ? 'project' : 'accent', cut(head, o.width), true))
      section = headKey
    }
    if (item.type === 'ask') {
      const { ask } = item
      const name = ask.where === 'manual' ? '' : agentOf(ask.agent, true, s)
      // An age the board does not know is left out of the column rather than said there.
      lines.push(`${mark} ${titled(2, `${s.chip(s.ask[ask.kind])}${ask.text}`, [name, ask.when === s.questionAgeUnknown ? '' : ask.when].filter(part => part !== '').join(' · '), isHere)}`)
      if (result?.key === item.key) resultLines('    ')
      lines.push(`    ${c('project', cut(ask.project + (ask.task ? ` › ${ask.task}` : ''), o.width - 6))}`)
      if (isOpen || isHere) {
        if (ask.canHide === false) lines.push(`    ${c('quiet', cut(s.questionReviewOnly, o.width - 6))}`)
        if (ask.note) lines.push(`    ${cut(ask.note, o.width - 6)}`)
        const answers = answersOf(ask, s)
        answers.forEach((answer, n) => lines.push(`    ${c('accent', ask.kind === 'confirm' ? (n === 0 ? 'y' : 'n') : String(n + 1), true)} ${cut(answer, o.width - 8)}`))
        // Whether the key answers or only copies, said on the line: without a session that takes
        // it, the question stays until the person answers in the agent and hides it here.
        if (answers.length > 0) {
          const keys = ask.kind === 'confirm' ? 'y/n' : `1–${answers.length}`
          const route = routes[item.key]
          lines.push(...muted(route !== undefined ? s.boardAnswerSends(keys, agentOf(route.agent, true, s)) : name === '' ? s.boardAnswerCopies(keys) : s.boardAnswerCopiesTo(keys, name), '    '))
        }
        if (ask.command !== null) lines.push(`    ${c('accent', cut(`$ ${ask.command}`, o.width - 6))}`)
        // The way back to the session, never cut, with which command c copies.
        if (ask.where === 'other') {
          // Its folder and session id stay off the screen, as everywhere on the board; c copies
          // the whole command.
          const back = (ask.command ?? ask.link) === null ? replyHint(ask, s).reopen : null
          lines.push(...muted(back === null || ask.resumeVia === null ? s.boardAnswerIn(name) : s.boardAnswerInCopy(name, `${plain(ask.resumeVia)} …`), '    '))
        }
      }
      return
    }
    if (item.type === 'row') {
      const { row } = item
      const name = agentOf(row.agent, row.auto !== null, s)
      lines.push(`${mark} ${titled(2, row.title, [name, row.when].filter(part => part !== '').join(' · '), isHere)}`)
      if (result?.key === item.key || host === item.key) resultLines('    ')
      const badge = row.due ? `⚑ ${row.due.left}` : ''
      const reserve = badge === '' ? 0 : cols(badge) + 2
      // Under In progress a row also names its project, which has no heading there.
      const lead = [isWorking && !isSameName(row.project, row.title) ? row.project : '', row.total > 0 ? `${row.done}/${row.total}` : ''].filter(part => part !== '').map(part => `${part} · `).join('')
      // The step it is on, in the accent colour, where its status only says that it works.
      const step = row.tone === 'quiet' || row.tone === 'accent' ? row.steps.find(one => one.isCurrent && (one.status === 'doing' || one.status === 'todo')) : undefined
      const status = cut(`${lead}${step === undefined ? row.status : `${MARK[step.status] ?? '○'} ${step.text}`}`, o.width - 6 - reserve)
      const quiet = status.startsWith(lead) ? lead : ''
      lines.push(`    ${c('quiet', quiet)}${c(toneInk(row.tone, step !== undefined), status.slice(quiet.length))}${badge === '' ? '' : `  ${c('alert', badge)}`}`)
      if (row.runs) lines.push(`    ${c('quiet', cut(row.runs, o.width - 6))}`)
      if (isOpen) {
        if (row.question) lines.push(`    ${cut(row.question, o.width - 6)}`)
        if (row.context) lines.push(`    ${c('quiet', cut(row.context, o.width - 6))}`)
        for (const step of row.steps) {
          const tone = step.status === 'waiting' ? 'waiting' : step.status === 'blocked' ? 'alert' : step.isCurrent ? 'accent' : step.status === 'done' ? 'quiet' : null
          const line = cut(stepLine(step), o.width - 6)
          lines.push(`    ${tone === null ? line : c(tone, line)}`)
        }
        if (row.handoff) lines.push(`    ${c('quiet', cut(row.handoff, o.width - 6))}`)
      }
      return
    }
    const { turn } = item
    lines.push(`${mark} ${titled(2, `${[turn.project, agentLabel(turn.agent, s)].filter(part => part !== '').join(' · ')}: ${turn.text}`, '', isHere)}`)
    if (result?.key === item.key) resultLines('    ')
  }
  items.forEach((item, index) => {
    const from = lines.length
    drawItem(item, index)
    if (index === at) focus = [from, lines.length - 1]
  })
  if (isOrphan && host === null) {
    lines.push('', `  ${cut(result.label, o.width - 4)}`)
    resultLines('    ')
  }
  // What finished, as on the page, with its Archive now: t moves all of it at once.
  if (view.recent.length > 0) {
    const heading = `✓ ${s.sectionRecent}`
    if (lines.at(-1) !== '') lines.push('')
    lines.push(`${c('done', cut(heading, o.width), true)}${c('quiet', cut(`  ${s.boardKeyArchiveDone}`, o.width - cols(heading)))}`)
    for (const item of view.recent) {
      lines.push(`  ${c('done', '✓')} ${titled(4, `${item.project} › ${item.title}`, item.when, false, 'quiet')}`)
      for (const question of item.questions ?? []) lines.push(`    ${cut(`${question.text}${question.note ? ` — ${question.note}` : ''}`, o.width - 6)}`)
    }
  }
  if (isEmptyBoard(view, pending)) {
    // As the page's first screen: which agents report here, and how their work comes.
    const agents = [...new Set((o.agents ?? []).map(agent => agentLabel(agent, s)))]
    lines.push(c('quiet', s.empty), ...muted(agents.length === 0 ? s.boardNoAgents : s.boardAgentsHere(agents.join(', ')), ''), ...muted(s.boardEmptyHow, ''))
  }
  // The line's own keys give way first, so the keys that move and quit always show.
  const own = keysFor(items[at], s, routes).join(' · ')
  lines.push('', c('quiet', own === '' ? cut(s.boardKeysMove, o.width) : `${cut(own, o.width - cols(s.boardKeysMove) - cols(' · ') - 1)} · ${s.boardKeysMove}`))
  if (result === undefined) resultLines('')
  for (const line of view.health ?? []) lines.push(...wrap(line, o.width - 2).map(part => c('quiet', part)))

  return { screen: `${lines.join('\n')}\n`, focus }
}
