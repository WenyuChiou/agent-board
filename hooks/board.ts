import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { lastQuestion } from './digest'
import { isBoardTurn, isTranscriptPath, readTurn, transcriptTail } from './inbox'
import type { TaskRow, View, ViewStep } from './view'

// The board as plain text, for agents other than Claude Code: the standalone script that
// `/progress connect` writes beside progress.md prints it in a terminal (once, or live with
// --watch), and each agent's board command shows it. It reads; it never writes progress.md.

// A turn another agent's hook left that no Claude Code session has summed up yet. The
// board only peeks at it: taking it is a Claude Code session's job, so the two never race.
export type PendingTurn = { agent: string; project: string; text: string; isQuestion: boolean; at: number }

// A reply's last line of prose, its code blocks left out: where a reply usually says what
// came of the turn.
const closing = (answer: string): string | undefined =>
  answer
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .at(-1)

// `readLog` reads an agent's session log, for the request a hook leaves out (Codex's Stop).
export const peekInbox = (files: ReadonlyArray<{ name: string; body: string; at: number }>, readLog: (path: string) => string = () => ''): PendingTurn[] => {
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
    latest.set(turn.id, { agent: turn.agent, project: turn.project, text, isQuestion: question !== null, at: file.at })
  }

  return [...latest.values()].sort((a, b) => Number(b.isQuestion) - Number(a.isQuestion) || b.at - a.at)
}

export type BoardOptions = { width: number; isColor: boolean }

const CODES = { waiting: '33', accent: '36', done: '32', alert: '31', quiet: '2', bold: '1', project: '35' } as const

const paint = (isColor: boolean) => (code: keyof typeof CODES, text: string): string => (isColor && text !== '' ? `\u001b[${CODES[code]}m${text}\u001b[0m` : text)

// Cut to the terminal's width, counting a CJK character as two columns.
const columns = (char: string): number => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1)

export const fit = (text: string, width: number): string => {
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
  if (asks.length === 0) {
    lines.push(c('done', s.nothingForYou), '')
  } else {
    lines.push(c('waiting', `● ${s.sectionWaiting}`))
    for (const ask of asks) {
      lines.push(`  ${c('project', fit(ask.where + (ask.task ? ` › ${ask.task}` : ''), o.width - 4))}`, `    ${fit(ask.text, o.width - 6)}`)
    }
    lines.push('')
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
