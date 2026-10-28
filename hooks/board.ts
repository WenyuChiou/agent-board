import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { lastQuestion } from './digest'
import { inboxOrder, isBoardTurn, isTranscriptPath, readTurn, transcriptTail } from './inbox'
import { localDay, parseJournal, progressReport } from './journal'
import { sha256 } from './sha256'
import { relativeTime, replyHint } from './view'
import type { StepRef, TaskRef, TaskRow, View, ViewStep, WaitingItem } from './view'
import type { ConfirmRef } from './blocks'

// The board as plain text, for agents other than Claude Code: the standalone script that
// `/progress connect` writes beside progress.md prints it in a terminal (once, or live with
// --watch), and each agent's board command shows it. It reads; it never writes progress.md.

// A turn another agent's hook left that no Claude Code session has summed up yet. The
// board only peeks at it: taking it is a Claude Code session's job, so the two never race.
export type PendingTurn = { id?: string; fullText?: string; sources?: string[]; sourceRevisions?: string[]; isClosed?: boolean; agent: string; project: string; text: string; isQuestion: boolean; at: number; sourceAt?: number; hasSummary?: boolean }

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
    const answer = scrub(turn.answer)
    const question = lastQuestion(answer, true)
    const summary = question ?? closing(answer)
    const text = (summary ?? turn.prompt).trim()
    if (question !== null) {
      // Words deduplicate retries, not independent ledger identities. An end or later
      // statement cannot prove a previous question answered before anyone captured it.
      const key = JSON.stringify([turn.id, turn.project, question.replace(/\s+/g, ' ').trim()])
      const previous = questions.get(key)
      questions.set(key, { id: turn.id, fullText: answer, sources: [...new Set([...(previous?.sources ?? []), file.name])], sourceRevisions: [...new Set([...(previous?.sourceRevisions ?? []), sha256(JSON.stringify([file.name, file.body]))])], agent: turn.agent, project: turn.project, text, isQuestion: true, at: previous?.at ?? file.at, sourceAt: turn.at ?? file.at, hasSummary: true, ...(turn.event === 'end' ? { isClosed: true } : {}) })
      latest.delete(turn.id)
    } else if (turn.event !== 'end' && text !== '') {
      latest.set(turn.id, { id: turn.id, fullText: answer, agent: turn.agent, project: turn.project, text, isQuestion: false, at: file.at, sourceAt: turn.at ?? file.at, hasSummary: summary !== undefined && summary !== null })
    }
    if (turn.event === 'end') {
      latest.delete(turn.id)
      for (const [key, pending] of questions) if (pending.id === turn.id) questions.set(key, { ...pending, isClosed: true })
    }
  }

  return [...questions.values(), ...latest.values()].sort((a, b) => Number(b.isQuestion) - Number(a.isQuestion) || b.at - a.at)
}

export type BoardOptions = { width: number; isColor: boolean; isIdleOpen?: boolean }

export const remainingInbox = (view: View, pending: readonly PendingTurn[]): readonly PendingTurn[] => view.hasPendingQuestions ? pending.filter(turn => !turn.isQuestion) : pending

const CODES = { waiting: '33', accent: '36', done: '32', alert: '31', quiet: '2', bold: '1', project: '35' } as const

const paint = (isColor: boolean) => (code: keyof typeof CODES, text: string): string => (isColor && text !== '' ? `\u001b[${CODES[code]}m${text}\u001b[0m` : text)

// Chat keeps its existing budget; terminals also draw emoji and supplementary CJK wide.
const chatColumns = (char: string): number => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1)
const columns = (char: string): number => (chatColumns(char) === 2 || /[\u{20000}-\u{3fffd}\p{Emoji_Presentation}]/u.test(char) ? 2 : 1)
const displayColumns = (text: string): number => [...text].reduce((sum, char) => sum + columns(char), 0)

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
    if (used + columnOf(char) > width - 1) break
    used += columnOf(char)
    out += char
  }

  return `${out}…`
}

export const fit = (raw: string, width: number): string => fitted(raw, width, columns)

const MARK: Record<string, string> = { done: '✓', doing: '▸', todo: '○', waiting: '●', running: '◐', blocked: '!', cancelled: '–' }

// Recovery advice must stay readable even when it is longer than one terminal row.
const wrapNote = (raw: string, width: number): string[] => {
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

const rowLines = (row: TaskRow, s: Strings, o: BoardOptions): string[] => {
  const c = paint(o.isColor)
  const who = row.agent === '' ? '' : ` · ${row.agent}`
  const count = row.total > 0 ? `${row.done}/${row.total} ` : ''
  const lines = [`  ${c('bold', fit(row.title, o.width - 4))}`, `    ${c('quiet', fit(`${count}${row.status}${who}${row.when ? ` · ${row.when}` : ''}`, o.width - 6))}`]
  if (row.context) lines.push(`    ${c('quiet', fit(row.context, o.width - 6))}`)
  for (const step of row.steps) {
    const tone = step.status === 'waiting' ? 'waiting' : step.status === 'blocked' ? 'alert' : step.isCurrent ? 'accent' : step.status === 'done' ? 'quiet' : null
    const line = fit(stepLine(step), o.width - 6)
    lines.push(`    ${tone === null ? line : c(tone, line)}`)
  }

  return lines
}

// The line of counts at the top of the board.
const countLine = (view: View, pending: readonly PendingTurn[], s: Strings, c: ReturnType<typeof paint>): string => {
  const { active, due, today } = view.overview
  const waiting = view.overview.waiting + remainingInbox(view, pending).filter(turn => turn.isQuestion).length

  return `${c('bold', s.paneTitle)}  ${c('waiting', `● ${waiting} ${s.countWaiting}`)}  ${c('accent', `▸ ${active} ${s.countActive}`)}  ${c('alert', `⚑ ${due} ${s.countDue}`)}  ${c('done', `✓ ${today} ${s.countToday}`)}`
}

// What waits on the person: the questions of the work on the board, then those in turns no
// session has taken in yet. Questions marked answered are not in `view.waiting`. `named` says
// how a project is told (the chat shows the home folder's name as `~`).
const asksOf = (view: View, pending: readonly PendingTurn[], s: Strings, named: (project: string) => string = project => project): Array<{ where: string; text: string; task: string }> => [
  ...view.waiting.map(item => ({
    where: [named(item.project), item.agent].filter(part => part !== '').join(' · '),
    text: `${s.chip(s.ask[item.kind])}${item.text}${item.note ? ` — ${item.note}` : ''}`,
    task: item.task,
  })),
  ...remainingInbox(view, pending).filter(turn => turn.isQuestion).map(turn => ({ where: [named(turn.project), turn.agent].filter(part => part !== '').join(' · '), text: turn.text, task: '' })),
]

export const boardText = (view: View, pending: readonly PendingTurn[], s: Strings = ZH_TW, o: BoardOptions = { width: 80, isColor: false }): string => {
  const c = paint(o.isColor)
  const lines: string[] = [countLine(view, pending, s, c), '']
  if (view.warning) lines.push(c('alert', view.warning), '')
  if (view.details) lines.push(c('quiet', view.details), '')

  const asks = asksOf(view, pending, s)
  const recentQuestions = view.recent.filter(item => (item.questions?.length ?? 0) > 0)
  for (const [title, items] of [[s.sectionQuestionReminders, view.reminder ?? []], [s.sectionOlderQuestions, view.older ?? []]] as const) {
    if (items.length === 0) continue
    lines.push(`${title} (${items.length}) · --all`)
    if (o.isIdleOpen) for (const item of items) lines.push(`  ${fit(`${item.project} › ${item.task} · ${item.when}`, o.width - 4)}`, `    ${fit(`${item.text}${item.note ? ` — ${item.note}` : ''}`, o.width - 6)}`)
  }
  // Questions marked answered in a pane are left out, and counted so they are not lost.
  const hidden = view.hidden.length === 0 ? [] : [c('quiet', s.hiddenCount(view.hidden.length))]
  if (asks.length === 0) {
    lines.push(c('done', s.nothingForYou), ...hidden, '')
  } else {
    lines.push(c('waiting', `● ${s.sectionWaiting}`))
    for (const ask of asks) {
      lines.push(`  ${c('project', fit(ask.where + (ask.task ? ` › ${ask.task}` : ''), o.width - 4))}`, `    ${fit(ask.text, o.width - 6)}`)
    }
    lines.push(...hidden.map(line => `  ${line}`), '')
  }

  if ((view.stoppedAsking ?? 0) > 0) lines.push(c('quiet', s.stoppedAsking(view.stoppedAsking!)), '')

  if (view.due.length > 0) {
    lines.push(c('alert', `⚑ ${s.sectionDue}`))
    for (const row of view.due) lines.push(`  ${fit(`${row.project} › ${row.title}${row.due ? ` · ${row.due.left}` : ''}`, o.width - 4)}`)
    lines.push('')
  }

  for (const group of view.groups) {
    if (group.rows.length === 0) continue
    const summary = fit(`  ${group.summary}`, Math.max(0, o.width - 3))
    lines.push(c('project', fit(`▸ ${group.project}`, o.width - displayColumns(summary))) + c('quiet', summary))
    for (const row of group.rows) lines.push(...rowLines(row, s, o))
    lines.push('')
  }

  for (const [rows, count] of [[view.idle, s.idleCount], [view.stopped, s.stoppedCount]] as const) {
    if (rows.length === 0) continue
    lines.push(c('quiet', o.isIdleOpen ? count(rows.length) : `${count(rows.length)} · --all`))
    if (o.isIdleOpen) {
      for (const row of rows) {
        lines.push(`  ${c('project', fit(row.project, o.width - 4))}`, ...rowLines(row, s, o))
      }
    }
    lines.push('')
  }

  if (recentQuestions.length > 0) {
    lines.push(c('done', s.sectionRecent))
    for (const item of recentQuestions) {
      lines.push(`  ${fit(`${item.project} › ${item.title} · ${item.when}`, o.width - 4)}`)
      for (const question of item.questions ?? []) lines.push(`    ${fit(`${question.text}${question.note ? ` — ${question.note}` : ''}`, o.width - 6)}`)
    }
    lines.push('')
  }
  const news = pending.filter(turn => !turn.isQuestion)
  if (news.length > 0) {
    lines.push(c('accent', `◐ ${s.boardInbox}`))
    for (const turn of news) lines.push(`  ${fit(`${[turn.project, turn.agent].filter(part => part !== '').join(' · ')}: ${turn.text}`, o.width - 4)}`)
    lines.push('')
  }

  if (view.groups.every(group => group.rows.length === 0) && asks.length === 0 && news.length === 0 && view.idle.length === 0 && view.stopped.length === 0 && view.due.length === 0 && recentQuestions.length === 0) lines.push(c('quiet', s.empty), '')
  for (const line of view.health ?? []) lines.push(...wrapNote(line, o.width - 2).map(part => c('quiet', part)))

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
  const items: string[] = [chatLine(countLine(view, pending, s, paint(false)), 0, home, isWindows)]
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
    const words = `${mark} ${named(row.project)} › ${row.title}${row.hasFutureTime ? ` · ${row.when}` : ''}${row.due === null ? '' : ` · ${row.due.left}`}${next === undefined ? '' : ` — ${s.reportNext(next)}`}`
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

export const emptyBoardState: BoardState = { selected: 0, key: null, open: null, note: '', seen: null }

// The line on screen that the keys act on. A line whose key is gone was replaced under the
// cursor since the screen was drawn; isGone stops a key from acting on a line not yet seen.
const chosen = (state: BoardState, items: readonly BoardItem[]): number => {
  const byKey = state.key === null ? -1 : items.findIndex(item => item.key === state.key)
  return byKey >= 0 ? byKey : Math.min(state.selected, Math.max(0, items.length - 1))
}

// In the order the screen shows them: what waits on you, each project's work, then turns
// no Claude Code session has taken in.
// The full action catalog includes idle rows for the page server. Terminal callers pass
// their shelf state so only rows the person can see are selectable.
export const boardItems = (view: View, pending: readonly PendingTurn[], isIdleOpen = true, isOlderOpen = false): BoardItem[] => {
  // Work due soon first, then each project's; a row is listed once.
  const rows = [...view.due, ...view.groups.flatMap(group => group.rows), ...(isIdleOpen ? [...view.idle, ...view.stopped] : [])].filter((row, index, all) => all.findIndex(one => one.key === row.key) === index)

  return [
    // A question's key holds its words, so a press made while it showed one question is refused
    // once the same step asks another, rather than taken as the answer to the new one.
    ...view.waiting.map(ask => ({ type: 'ask' as const, key: ask.hideKey === '' ? `ask:${ask.key}` : `ask:${ask.key}@${ask.hideKey}`, ask })),
    ...(isOlderOpen ? [...(view.reminder ?? []), ...(view.older ?? [])].map(ask => ({ type: 'ask' as const, key: `older:${ask.key}@${ask.questionId}`, ask })) : []),
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

export const boardKey = (state: BoardState, key: string, items: readonly BoardItem[], s: Strings = ZH_TW): { state: BoardState; action: BoardAction | null } => {
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
  if (item === undefined) return { state: { ...state, note: s.pressNothing }, action: null }
  state = { ...state, result: { key: item.key, revision: fingerprint(item, items), label: item.type === 'ask' ? item.ask.task : item.type === 'row' ? item.row.title : item.turn.project } }
  // The line under the cursor changed since the screen was drawn: choose what is there now and
  // let the person look before a key acts on it.
  const changed = { state: { ...state, selected: at, key: item.key, note: s.boardLineChanged }, action: null }
  if (isGone) return changed
  // A tick, an archive or a copy of what to say acts on the line as the last draw showed it: the
  // same key can now be another session's block, or the same step reworded.
  if ((key === 'x' || key === 'a' || key === 'd' || key === 'c' || key === 'h') && state.seen !== null && state.seen[item.key] !== fingerprint(item, items)) return changed
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
    if (answer !== undefined) return { state, action: { type: 'copy', text: plain(answer) } }
  }
  if (item.type === 'row') {
    const { row } = item
    if (key === 'x' && row.next !== null) return { state, action: { type: 'tick', ref: row.next } }
    if (key === 'a' && row.archive !== null) return { state, action: { type: 'archive', ref: row.archive, title: row.title } }
    if (key === 'd' && row.confirm != null) return { state, action: { type: 'done', ref: row.confirm, title: row.title } }
    if (key === 'c' && row.resume !== null) return { state, action: { type: 'copy', text: plain(row.resume) } }
  }

  return { state: { ...state, note: s.pressNothing }, action: null }
}

const keysFor = (item: BoardItem | undefined, s: Strings): string[] => {
  if (item === undefined) return []
  if (item.type === 'ask') {
    const { ask } = item
    const answers = answersOf(ask, s)
    return [
      ...(ask.step !== null ? [s.boardKeyTick] : []),
      ...(ask.kind === 'confirm' ? [s.boardKeyConfirm] : answers.length > 0 ? [s.boardKeyOptions(answers.length)] : []),
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

export const boardScreen = (view: View, pending: readonly PendingTurn[], state: BoardState, s: Strings = ZH_TW, o: BoardOptions = { width: 80, isColor: false }): string => {
  const c = paint(o.isColor)
  const items = boardItems(view, pending, state.isIdleOpen ?? false, state.isOlderOpen ?? false)
  const at = chosen(state, items)
  const { active, due, today } = view.overview
  const waiting = view.overview.waiting + remainingInbox(view, pending).filter(turn => turn.isQuestion).length
  const lines: string[] = [
    `${c('bold', s.paneTitle)}  ${c('waiting', `● ${waiting} ${s.countWaiting}`)}  ${c('accent', `▸ ${active} ${s.countActive}`)}  ${c('alert', `⚑ ${due} ${s.countDue}`)}  ${c('done', `✓ ${today} ${s.countToday}`)}`,
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
    '',
  ]
  const result = state.result
  const resultItem = result === undefined ? undefined : items.find(item => item.key === result.key)
  const hasResult = result === undefined || result.revision === null || result.revision === (resultItem === undefined ? '' : fingerprint(resultItem, items))
  const resultLines = (indent: string): void => {
    if (!hasResult) return
    if (state.copyText !== undefined) lines.push(`${indent}${c('alert', fit(s.boardCopyFailed(''), o.width - indent.length))}`, plain(state.copyText))
    else if (state.note !== '') {
      const notes = wrapNote(state.note, o.width - indent.length)
      lines.push(...notes.map(line => `${indent}${c(state.tone ?? 'done', line)}`))
    }
  }
  let section = ''
  items.forEach((item, index) => {
    const isHere = index === at
    const isOpen = state.open === item.key
    const mark = isHere ? c('accent', '›') : ' '
    const head =
      item.type === 'ask' ? `● ${item.ask.ageStage === 'older' ? s.sectionOlderQuestions : item.ask.ageStage === 'reminder' ? s.sectionQuestionReminders : s.sectionWaiting}` : item.type === 'row' ? `▸ ${item.row.project}` : `◐ ${s.boardInbox}`
    if (head !== section) {
      if (section !== '') lines.push('')
      lines.push(item.type === 'ask' ? c('waiting', fit(head, o.width)) : item.type === 'row' ? c('project', fit(head, o.width)) : c('accent', fit(head, o.width)))
      section = head
    }
    const line = (text: string): string => (isHere ? c('bold', text) : text)
    if (item.type === 'ask') {
      const { ask } = item
      const where = [ask.project, ask.agent].filter(part => part !== '').join(' · ')
      lines.push(`${mark} ${line(fit(`${s.chip(s.ask[ask.kind])}${ask.text}`, o.width - 4))}`)
      if (result?.key === item.key) resultLines('    ')
      lines.push(`    ${c('project', fit(where + (ask.task ? ` › ${ask.task}` : ''), o.width - 6))}`)
      if (isOpen || isHere) {
        if (ask.canHide === false) lines.push(`    ${c('quiet', fit(s.questionReviewOnly, o.width - 6))}`)
        else if (ask.where !== 'manual') lines.push(`    ${c('quiet', fit(s.archiveLive, o.width - 6))}`)
        if (ask.note) lines.push(`    ${fit(ask.note, o.width - 6)}`)
        answersOf(ask, s).forEach((answer, n) => lines.push(`    ${c('accent', ask.kind === 'confirm' ? (n === 0 ? 'y' : 'n') : String(n + 1))} ${fit(answer, o.width - 8)}`))
        if (ask.command !== null) lines.push(`    ${c('accent', fit(`$ ${ask.command}`, o.width - 6))}`)
        if (ask.where === 'other') {
          const hint = replyHint(ask, s)
          lines.push(`    ${c('quiet', fit(hint.where, o.width - 6))}`)
        }
      }
      return
    }
    if (item.type === 'row') {
      const { row } = item
      const who = row.agent === '' ? '' : ` · ${row.agent}`
      const count = row.total > 0 ? `${row.done}/${row.total} ` : ''
      lines.push(`${mark} ${line(fit(row.title, o.width - 4))}`)
      if (result?.key === item.key) resultLines('    ')
      const badge = row.due ? `⚑ ${row.due.left}` : ''
      const reserve = badge === '' ? 0 : displayColumns(badge) + 2
      lines.push(`    ${c('quiet', fit(`${count}${row.status}${who}${row.when ? ` · ${row.when}` : ''}`, o.width - 6 - reserve))}${badge === '' ? '' : `  ${c('alert', badge)}`}`)
      if ((isOpen || isHere) && (row.auto === 'working' || row.auto === 'waiting')) lines.push(`    ${c('quiet', fit(s.archiveLive, o.width - 6))}`)
      if (isOpen) {
        if (row.question) lines.push(`    ${fit(row.question, o.width - 6)}`)
        if (row.context) lines.push(`    ${c('quiet', fit(row.context, o.width - 6))}`)
        for (const step of row.steps) lines.push(`    ${fit(stepLine(step), o.width - 6)}`)
        if (row.handoff) lines.push(`    ${c('quiet', fit(row.handoff, o.width - 6))}`)
      }
      return
    }
    const { turn } = item
    lines.push(`${mark} ${line(fit(`${[turn.project, turn.agent].filter(part => part !== '').join(' · ')}: ${turn.text}`, o.width - 4))}`)
    if (result?.key === item.key) resultLines('    ')
  })
  if (result !== undefined && resultItem === undefined && hasResult && state.note !== '') {
    lines.push('', `  ${fit(result.label, o.width - 4)}`)
    resultLines('    ')
  }
  const recentQuestions = view.recent.filter(item => (item.questions?.length ?? 0) > 0)
  if (recentQuestions.length > 0) {
    lines.push('', c('done', s.sectionRecent))
    for (const item of recentQuestions) {
      lines.push(`  ${fit(`${item.project} › ${item.title} · ${item.when}`, o.width - 4)}`)
      for (const question of item.questions ?? []) lines.push(`    ${fit(`${question.text}${question.note ? ` — ${question.note}` : ''}`, o.width - 6)}`)
    }
  }
  if (items.length === 0 && view.idle.length === 0 && view.stopped.length === 0 && recentQuestions.length === 0) lines.push(c('quiet', s.empty))
  lines.push('', c('quiet', fit([...keysFor(items[at], s), s.boardKeysMove].join(' · '), o.width)))
  if (result === undefined) resultLines('')
  for (const line of view.health ?? []) lines.push(...wrapNote(line, o.width - 2).map(part => c('quiet', part)))

  return `${lines.join('\n')}\n`
}
