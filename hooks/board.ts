import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { lastQuestion } from './digest'
import { isBoardTurn, isTranscriptPath, readTurn, transcriptTail } from './inbox'
import { replyHint } from './view'
import type { StepRef, TaskRef, TaskRow, View, ViewStep, WaitingItem } from './view'

// The board as plain text, for agents other than Claude Code: the standalone script that
// `/progress connect` writes beside progress.md prints it in a terminal (once, or live with
// --watch), and each agent's board command shows it. It reads; it never writes progress.md.

// A turn another agent's hook left that no Claude Code session has summed up yet. The
// board only peeks at it: taking it is a Claude Code session's job, so the two never race.
export type PendingTurn = { agent: string; project: string; text: string; isQuestion: boolean; at: number; session?: string }

// A reply's last line of prose, its code blocks left out: where a reply usually says what
// came of the turn.
const closing = (answer: string): string | undefined =>
  answer
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .at(-1)

// `readLog` reads an agent's session log, for the request a hook leaves out (Codex's Stop).
export const peekInbox = (files: ReadonlyArray<{ name: string; body: string; at: number }>, readLog: (path: string) => string = () => '', withSession = false): PendingTurn[] => {
  const latest = new Map<string, PendingTurn>()
  for (const file of [...files].sort((a, b) => a.at - b.at)) {
    const read = readTurn(file.name, file.body)
    if (read === null) continue
    const turn = read.prompt === '' && isTranscriptPath(read.transcript) ? { ...read, prompt: transcriptTail(readLog(read.transcript)).prompt } : read
    if (isBoardTurn(turn)) continue
    if (turn.event === 'end') {
      latest.delete(turn.id)
      continue
    }
    const question = lastQuestion(turn.answer)
    const text = (question ?? closing(turn.answer) ?? turn.prompt).trim()
    if (text === '') continue
    latest.set(turn.id, { agent: turn.agent, project: turn.project, text, isQuestion: question !== null, at: file.at, ...(withSession ? { session: turn.id } : {}) })
  }

  return [...latest.values()].sort((a, b) => Number(b.isQuestion) - Number(a.isQuestion) || b.at - a.at)
}

export type BoardOptions = { width: number; isColor: boolean }

const CODES = { waiting: '33', accent: '36', done: '32', alert: '31', quiet: '2', bold: '1', project: '35' } as const

const paint = (isColor: boolean) => (code: keyof typeof CODES, text: string): string => (isColor && text !== '' ? `\u001b[${CODES[code]}m${text}\u001b[0m` : text)

// Cut to the terminal's width, counting a CJK character as two columns.
const columns = (char: string): number => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1)

// Control characters out: the text comes from other agents' blocks and turns, and an escape
// sequence in it would move the cursor or clear the screen of the terminal it is printed in.
export const plain = (text: string): string => text.replace(/\t/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

export const fit = (raw: string, width: number): string => {
  const text = plain(raw)
  const chars = [...text]
  if (chars.reduce((sum, char) => sum + columns(char), 0) <= width) return text
  let used = 0
  let out = ''
  for (const char of chars) {
    if (used + columns(char) > width - 1) break
    used += columns(char)
    out += char
  }

  return `${out}…`
}

const MARK: Record<string, string> = { done: '✓', doing: '▸', todo: '○', waiting: '●', running: '◐', blocked: '!', cancelled: '–' }

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

export const boardText = (view: View, pending: readonly PendingTurn[], s: Strings = ZH_TW, o: BoardOptions = { width: 80, isColor: false }): string => {
  const c = paint(o.isColor)
  const { active, due, today } = view.overview
  const waiting = view.overview.waiting + pending.filter(turn => turn.isQuestion).length
  const lines: string[] = [
    `${c('bold', s.paneTitle)}  ${c('waiting', `● ${waiting} ${s.countWaiting}`)}  ${c('accent', `▸ ${active} ${s.countActive}`)}  ${c('alert', `⚑ ${due} ${s.countDue}`)}  ${c('done', `✓ ${today} ${s.countToday}`)}`,
    '',
  ]

  const asks = [
    ...view.waiting.map(item => ({
      where: [item.project, item.agent].filter(part => part !== '').join(' · '),
      text: `${s.chip(s.ask[item.kind])}${item.text}${item.note ? ` — ${item.note}` : ''}`,
      task: item.task,
    })),
    ...pending.filter(turn => turn.isQuestion).map(turn => ({ where: [turn.project, turn.agent].filter(part => part !== '').join(' · '), text: turn.text, task: '' })),
  ]
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

  if (view.due.length > 0) {
    lines.push(c('alert', `⚑ ${s.sectionDue}`))
    for (const row of view.due) lines.push(`  ${fit(`${row.project} › ${row.title}${row.due ? ` · ${row.due.left}` : ''}`, o.width - 4)}`)
    lines.push('')
  }

  for (const group of view.groups) {
    if (group.rows.length === 0) continue
    lines.push(c('project', `▸ ${group.project}`) + c('quiet', `  ${group.summary}`))
    for (const row of group.rows) lines.push(...rowLines(row, s, o))
    lines.push('')
  }

  const news = pending.filter(turn => !turn.isQuestion)
  if (news.length > 0) {
    lines.push(c('accent', `◐ ${s.boardInbox}`))
    for (const turn of news) lines.push(`  ${fit(`${[turn.project, turn.agent].filter(part => part !== '').join(' · ')}: ${turn.text}`, o.width - 4)}`)
    lines.push('')
  }

  if (view.groups.every(group => group.rows.length === 0) && asks.length === 0 && news.length === 0) lines.push(c('quiet', s.empty), '')

  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

// The board you can work in, for a terminal beside another agent (`--watch` on a terminal):
// pick a line with the arrows, open it, tick its next step, archive it, or copy what to say
// to the agent that asked. What it can do is what the pane does; the writes themselves are
// the script's, through the same pure functions the pane uses (setManualStep, takeTask).

export type BoardItem =
  | { type: 'ask'; key: string; ask: WaitingItem }
  | { type: 'row'; key: string; row: TaskRow }
  | { type: 'turn'; key: string; turn: PendingTurn }

// `key` is the chosen line's, so the choice stays on it when lines above it come or go.
export type BoardState = { selected: number; key: string | null; open: string | null; note: string }

export type BoardAction =
  | { type: 'tick'; ref: StepRef }
  | { type: 'archive'; ref: TaskRef; title: string }
  | { type: 'copy'; text: string }
  // Kept off Waiting on you until the question changes (`hideKey`); null shows every hidden one
  // again. Only the hidden list beside progress.md is written: nothing goes to the agent.
  | { type: 'hide'; key: string; text: string }
  | { type: 'unhide'; key: string | null }
  | { type: 'html' }
  | { type: 'quit' }

export const emptyBoardState: BoardState = { selected: 0, key: null, open: null, note: '' }

// The line on screen that the keys act on. A line whose key is gone was replaced under the
// cursor since the screen was drawn; isGone stops a key from acting on a line not yet seen.
const chosen = (state: BoardState, items: readonly BoardItem[]): number => {
  const byKey = state.key === null ? -1 : items.findIndex(item => item.key === state.key)
  return byKey >= 0 ? byKey : Math.min(state.selected, Math.max(0, items.length - 1))
}

// In the order the screen shows them: what waits on you, each project's work, then turns
// no Claude Code session has taken in.
export const boardItems = (view: View, pending: readonly PendingTurn[]): BoardItem[] => {
  // Work due soon first, then each project's; a row is listed once.
  const rows = [...view.due, ...view.groups.flatMap(group => group.rows)].filter((row, index, all) => all.findIndex(one => one.key === row.key) === index)

  return [
    // A question's key holds its words, so a press made while it showed one question is refused
    // once the same step asks another, rather than taken as the answer to the new one.
    ...view.waiting.map(ask => ({ type: 'ask' as const, key: ask.hideKey === '' ? `ask:${ask.key}` : `ask:${ask.key}@${ask.hideKey}`, ask })),
    ...rows.map(row => ({ type: 'row' as const, key: `row:${row.key}`, row })),
    ...pending.map((turn, index) => ({ type: 'turn' as const, key: `turn:${turn.agent}:${turn.project}:${index}`, turn })),
  ]
}

// What each key does on the selected line, so the footer lists only keys that do something.
export const answersOf = (ask: WaitingItem, s: Strings): string[] =>
  ask.kind === 'confirm' ? [s.yesAnswer, s.noAnswer] : ask.kind === 'choose' ? ask.options.slice(0, 9) : []

// The state with the chosen line's key set, so a key pressed later acts on the line that was
// on screen, or on nothing if that line has gone. The script calls it each time it draws.
export const pinned = (state: BoardState, items: readonly BoardItem[]): BoardState => {
  const at = chosen(state, items)
  return state.key !== null && items[at]?.key !== state.key ? state : { ...state, selected: at, key: items[at]?.key ?? null }
}

export const boardKey = (state: BoardState, key: string, items: readonly BoardItem[], s: Strings = ZH_TW): { state: BoardState; action: BoardAction | null } => {
  const last = Math.max(0, items.length - 1)
  const at = chosen(state, items)
  const item = items[at]
  const isGone = state.key !== null && item?.key !== state.key
  const moved = (selected: number): { state: BoardState; action: null } => ({ state: { ...state, selected, key: items[selected]?.key ?? null, note: '' }, action: null })
  if (key === 'q' || key === '\u0003') return { state, action: { type: 'quit' } }
  if (key === 'up' || key === 'k') return moved(Math.max(0, at - 1))
  if (key === 'down' || key === 'j') return moved(Math.min(last, at + 1))
  if (key === 'o') return { state, action: { type: 'html' } }
  if (key === 'u') return { state, action: { type: 'unhide', key: null } }
  if (item === undefined) return { state, action: null }
  // The line under the cursor changed since the screen was drawn: choose what is there now and
  // let the person look before a key acts on it.
  if (isGone) return { state: { ...state, selected: at, key: item.key, note: s.boardLineChanged }, action: null }
  if (key === 'enter' || key === ' ') return { state: { ...state, selected: at, key: item.key, open: state.open === item.key ? null : item.key, note: '' }, action: null }
  if (item.type === 'ask') {
    const { ask } = item
    if (key === 'x' && ask.step !== null) return { state, action: { type: 'tick', ref: ask.step } }
    if (key === 'h' && ask.hideKey !== '') return { state, action: { type: 'hide', key: ask.hideKey, text: ask.text } }
    if (key === 'c' && (ask.command ?? ask.link) !== null) return { state, action: { type: 'copy', text: plain((ask.command ?? ask.link) as string) } }
    // Another session's question has nothing else to copy: the command that reopens that
    // session where there is one (its line is cut to the terminal's width), else its id, which
    // finds the session in its agent's list.
    const back = replyHint(ask, s).reopen ?? ask.sessionId
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
    if (key === 'c' && row.resume !== null) return { state, action: { type: 'copy', text: plain(row.resume) } }
  }

  return { state, action: null }
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
          : ask.sessionId !== null
            ? [s.boardKeyCopyId]
            : []),
      ...(ask.hideKey !== '' ? [s.boardKeyHide] : []),
    ]
  }
  if (item.type === 'row') {
    const { row } = item
    return [...(row.next !== null ? [s.boardKeyTick] : []), ...(row.archive !== null ? [s.boardKeyArchive] : []), ...(row.resume !== null ? [s.boardKeyCopyResume] : [])]
  }

  return []
}

export const boardScreen = (view: View, pending: readonly PendingTurn[], state: BoardState, s: Strings = ZH_TW, o: BoardOptions = { width: 80, isColor: false }): string => {
  const c = paint(o.isColor)
  const items = boardItems(view, pending)
  const at = chosen(state, items)
  const { active, due, today } = view.overview
  const waiting = view.overview.waiting + pending.filter(turn => turn.isQuestion).length
  const lines: string[] = [
    `${c('bold', s.paneTitle)}  ${c('waiting', `● ${waiting} ${s.countWaiting}`)}  ${c('accent', `▸ ${active} ${s.countActive}`)}  ${c('alert', `⚑ ${due} ${s.countDue}`)}  ${c('done', `✓ ${today} ${s.countToday}`)}`,
    ...(view.hidden.length === 0 ? [] : [c('quiet', `${s.hiddenCount(view.hidden.length)} · ${s.boardKeyShowHidden}`)]),
    '',
  ]
  let section = ''
  items.forEach((item, index) => {
    const isHere = index === at
    const isOpen = state.open === item.key
    const mark = isHere ? c('accent', '›') : ' '
    const head =
      item.type === 'ask' ? `● ${s.sectionWaiting}` : item.type === 'row' ? `▸ ${item.row.project}` : `◐ ${s.boardInbox}`
    if (head !== section) {
      if (section !== '') lines.push('')
      lines.push(item.type === 'ask' ? c('waiting', head) : item.type === 'row' ? c('project', head) : c('accent', head))
      section = head
    }
    const line = (text: string): string => (isHere ? c('bold', text) : text)
    if (item.type === 'ask') {
      const { ask } = item
      const where = [ask.project, ask.agent].filter(part => part !== '').join(' · ')
      lines.push(`${mark} ${line(fit(`${s.chip(s.ask[ask.kind])}${ask.text}`, o.width - 4))}`)
      lines.push(`    ${c('project', fit(where + (ask.task ? ` › ${ask.task}` : ''), o.width - 6))}`)
      if (isOpen || isHere) {
        if (ask.note) lines.push(`    ${fit(ask.note, o.width - 6)}`)
        answersOf(ask, s).forEach((answer, n) => lines.push(`    ${c('accent', ask.kind === 'confirm' ? (n === 0 ? 'y' : 'n') : String(n + 1))} ${fit(answer, o.width - 8)}`))
        if (ask.command !== null) lines.push(`    ${c('accent', fit(`$ ${ask.command}`, o.width - 6))}`)
        if (ask.where === 'other') {
          const hint = replyHint(ask, s)
          lines.push(`    ${c('quiet', fit(hint.where, o.width - 6))}`)
          lines.push(`    ${c('quiet', fit(hint.back, o.width - 6))}`)
          if (hint.reopen !== null) {
            lines.push(`    ${c('quiet', fit(hint.note, o.width - 6))}`)
            lines.push(`    ${c('accent', fit(`$ ${hint.reopen}`, o.width - 6))}`)
          }
        }
      }
      return
    }
    if (item.type === 'row') {
      const { row } = item
      const who = row.agent === '' ? '' : ` · ${row.agent}`
      const count = row.total > 0 ? `${row.done}/${row.total} ` : ''
      lines.push(`${mark} ${line(fit(row.title, o.width - 4))}`)
      lines.push(`    ${c('quiet', fit(`${count}${row.status}${who}${row.when ? ` · ${row.when}` : ''}`, o.width - 6))}${row.due ? `  ${c('alert', `⚑ ${row.due.left}`)}` : ''}`)
      if (isOpen) {
        if (row.context) lines.push(`    ${c('quiet', fit(row.context, o.width - 6))}`)
        for (const step of row.steps) lines.push(`    ${fit(stepLine(step), o.width - 6)}`)
        if (row.handoff) lines.push(`    ${c('quiet', fit(row.handoff, o.width - 6))}`)
      }
      return
    }
    const { turn } = item
    lines.push(`${mark} ${line(fit(`${[turn.project, turn.agent].filter(part => part !== '').join(' · ')}: ${turn.text}`, o.width - 4))}`)
  })
  if (items.length === 0) lines.push(c('quiet', s.empty))
  lines.push('', c('quiet', fit([...keysFor(items[at], s), s.boardKeysMove].join(' · '), o.width)))
  if (state.note !== '') lines.push(c('done', fit(state.note, o.width)))

  return `${lines.join('\n')}\n`
}
