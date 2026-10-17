import type { ProgressMirror, ProgressMirrorTask } from '../types'
import { cleanContext, cleanTitle, clip } from './mirror'

// A session's progress without its Task list: what each turn finished, the next step and
// the question it ended on, as the model sums the turn up. Also the question a turn ends
// on when the session does keep a list, and the handoff line a compaction leaves.

export type Digest = { title: string; context: string; done: string; next: string; ask: string; why: string }

const EMPTY = /^(?:-+|—+|–+|none|n\/a|無|无|沒有|没有)$/i

const field = (lines: readonly string[], key: string): string => {
  const pattern = new RegExp(`^\\s*\\**${key}\\**\\s*[:：]\\s*(.*)$`, 'i')
  for (const line of lines) {
    const found = pattern.exec(line)
    if (found !== null) {
      const value = (found[1] ?? '').trim()
      return EMPTY.test(value) ? '' : value
    }
  }

  return ''
}

// The model's five lines; null when none of them came back.
export const parseDigest = (answer: string): Digest | null => {
  const lines = answer.split(/\r?\n/)
  const title = field(lines, 'TITLE')
  const context = field(lines, 'CONTEXT')
  const done = field(lines, 'DONE')
  const next = field(lines, 'NEXT')
  const ask = field(lines, 'ASK')
  if ([title, context, done, next, ask].every(value => value === '')) return null
  const split = ask.search(/\s[—–-]{1,2}\s/)
  const label = split < 0 ? ask : ask.slice(0, split)
  const why = split < 0 ? '' : ask.slice(split).replace(/^\s[—–-]{1,2}\s/, '')

  return {
    title: title === '' ? '' : cleanTitle(title),
    context: context === '' ? '' : cleanContext(context),
    done: clip(done, 60),
    next: clip(next, 60),
    ask: clip(label.trim(), 48),
    why: clip(why.trim(), 120),
  }
}

// A reply as the digest prompt quotes it: its end, with no tag that could close the
// <reply> fence it sits in early.
export const replyData = (answer: string): string => answer.slice(-3000).replace(/<\/?\s*reply\b[^>]*>/gi, '')

// The question a reply ends on, if its last paragraph asks one: the last sentence there
// with a question mark, without code or markdown. A reply that ends on a statement asks
// nothing, even if it asked something earlier.
export const lastQuestion = (answer: string): string | null => {
  const prose = answer.replace(/```[\s\S]*?```/g, '\n\n').replace(/`([^`]*)`/g, '$1')
  const paragraphs = prose.split(/\n\s*\n/).map(one => one.trim()).filter(one => one !== '')
  const last = paragraphs.at(-1)
  if (last === undefined) return null
  const lines = last
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[*_#>]+/g, '').trim())
    .filter(line => line !== '')
  const tail = lines.at(-1) ?? ''
  if (!/[?？]/.test(tail)) return null
  const sentences = tail.match(/[^.。!！?？]*[?？]/g) ?? []
  const question = (sentences.at(-1) ?? '').trim()

  return question === '' ? null : clip(question, 120)
}

const task = (id: string, subject: string, status: ProgressMirrorTask['status'], why: string | null): ProgressMirrorTask => ({
  id,
  subject,
  status,
  activeForm: '',
  waiting: why === null ? null : 'you',
  why,
  ask: null,
  options: [],
  command: null,
  link: null,
  blocked: null,
  blockedBy: [],
})

// How many finished turns a summed-up list keeps; older ones fall off the top.
const KEEP_DONE = 6

// A turn summed up, folded into a session that keeps no Task list: what it finished joins
// the done steps, and the open steps become this turn's next step and question.
export const applyDigest = (mirror: ProgressMirror, given: Digest, now: number): ProgressMirror => {
  // The question may come straight from a reply rather than through parseDigest: kept to the
  // same size either way.
  const digest = { ...given, ask: clip(given.ask, 48), why: clip(given.why, 120) }
  const done = mirror.source === 'turns' ? mirror.tasks.filter(one => one.status === 'completed') : []
  let seq = Math.max(0, ...mirror.tasks.map(one => Number(one.id.replace(/^t/, '')) || 0))
  const id = (): string => {
    seq += 1
    return `t${seq}`
  }
  const finished = digest.done === '' ? done : [...done, task(id(), digest.done, 'completed', null)]
  const open = [
    ...(digest.ask === '' ? [] : [task(id(), digest.ask, 'in_progress', digest.why || digest.ask)]),
    ...(digest.next === '' || digest.next === digest.ask ? [] : [task(id(), digest.next, 'pending', null)]),
  ]

  return {
    ...mirror,
    source: 'turns',
    title: digest.title || mirror.title,
    context: digest.context || mirror.context,
    isTitleFinal: mirror.isTitleFinal || digest.title !== '',
    tasks: [...finished.slice(-KEEP_DONE), ...open],
    autoAsk: null,
    updated: now,
  }
}

// A turn that ended on a question, in a session whose list says nothing waits on the
// person: the step in progress (else the next one) waits on them, with the question as its
// note, until they answer.
export const markAsked = (mirror: ProgressMirror, question: string): ProgressMirror => {
  if (mirror.tasks.some(one => one.status !== 'completed' && one.waiting === 'you')) return mirror
  const target = mirror.tasks.find(one => one.status === 'in_progress') ?? mirror.tasks.find(one => one.status === 'pending')
  if (target === undefined) return mirror

  return {
    ...mirror,
    autoAsk: target.id,
    tasks: mirror.tasks.map(one => (one.id === target.id ? { ...one, waiting: 'you', why: question } : one)),
  }
}

// The person answered: the step marked from the question stops waiting, unless Claude has
// since marked it itself.
export const clearAsked = (mirror: ProgressMirror): ProgressMirror => {
  const id = mirror.autoAsk
  if (id === null) return mirror

  return {
    ...mirror,
    autoAsk: null,
    tasks: mirror.tasks.map(one => (one.id === id && one.waiting === 'you' ? { ...one, waiting: null, why: null } : one)),
  }
}

// Summed-up questions are answered by the next prompt: the waiting step counts as done.
export const answerTurns = (mirror: ProgressMirror): ProgressMirror =>
  mirror.source !== 'turns'
    ? mirror
    : {
        ...mirror,
        tasks: mirror.tasks.map(one => (one.waiting === 'you' ? { ...one, status: 'completed', waiting: null, why: null } : one)),
      }

// Whether the list grew enough since the title and background were written to look again.
export const needsRefresh = (mirror: ProgressMirror): boolean =>
  mirror.source === 'tasks' && mirror.isTitleFinal && mirror.tasks.length >= mirror.namedSteps + 3

// The model's handoff line, kept to one line.
export const cleanHandoff = (answer: string): string =>
  clip(
    answer
      .replace(/^["'「『\s]+|["'」』\s]+$/g, '')
      .replace(/^(交接|Handoff)\s*[:：]\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim(),
    160,
  )

type TurnMessage = { role: 'user' | 'assistant'; text: string; toolUses: ReadonlyArray<{ tool: string }>; toolResults?: readonly unknown[] }

// The tools the last turn called: assistant messages back to the person's prompt.
export const turnTools = (messages: readonly TurnMessage[]): string[] => {
  const tools: string[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role === 'user' && message.text.trim() !== '' && (message.toolResults ?? []).length === 0) break
    for (const use of message.toolUses) tools.push(use.tool)
  }

  return tools
}

// A turn that changed something: edited a file or ran a command. A turn that only read or
// answered is not work to track.
export const isWork = (tools: readonly string[]): boolean => tools.some(tool => /^(?:Edit|MultiEdit|Write|NotebookEdit|Bash)$/.test(tool))
