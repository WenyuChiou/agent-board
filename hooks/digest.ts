import type { ProgressMirror, ProgressMirrorTask } from '../types'
import { cleanContext, cleanTitle, clip, renewQuestion, waitsOnYou, withoutMarks } from './mirror'
import { answeredStep, oneLine } from './step-words'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'

// A session's progress without its Task list: what each turn finished, the next step and
// the question it ended on, as the model sums the turn up. Also the question a turn ends
// on when the session does keep a list, and the handoff line a compaction leaves.

export type Digest = { title: string; context: string; done: string; next: string; ask: string; why: string; handoffTo?: string }

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
  const normalized = normalizeReplyValue(field(lines, 'ASK'))
  const ask = normalized.text === null ? '' : normalized.isStructured ? lastQuestionInProse(normalized.text, true) ?? '' : normalized.text
  const handoffTo = field(lines, 'HANDOFF').replace(/\s+/g, ' ').trim()
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
    ...(handoffTo === '' ? {} : { handoffTo: clip(handoffTo, 120) }),
  }
}

// The fences the digest prompt quotes a turn in. No quoted text keeps a tag that could close
// its own fence early or open another.
const FENCE_TAG = /<\/?\s*(?:reply|request)\b[^>]*>/gi

// A reply as the digest prompt quotes it: its end, between <reply> tags.
export const replyData = (answer: string): string => answer.slice(-3000).replace(FENCE_TAG, '')

// What the user asked, first or this turn, as the digest, name and rename prompts quote it: its
// start, between <request> tags. Another agent's turn brings it, so it is data as much as the
// reply is.
export const requestData = (text: string): string => text.slice(0, 1200).replace(FENCE_TAG, '')

// Markdown's `_` marks emphasis at the edge of a word; inside one (`snake_case`, `ghp_16C7`,
// `sk_live_abc`) it is part of the word and stays. Dropping it changed the word, and left a
// token in a shape no pattern for tokens knows.
const withoutEmphasis = (line: string): string =>
  line
    .replace(/[*#>]+/g, '')
    .replace(/_+/g, (run, at: number, whole: string) => (/[A-Za-z0-9]/.test(whole[at - 1] ?? '') && /[A-Za-z0-9]/.test(whole[at + run.length] ?? '') ? run : ''))

// JSON objects and arrays are data, not prose. Only a top-level, nonempty string can
// say what an object means; arrays have no usable field. Scalars stay as written.
const normalizeReplyValue = (answer: string): { text: string | null; isStructured: boolean } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(answer.trim().replace(/^\uFEFF/, '').trim()) as unknown
  } catch {
    return { text: answer, isStructured: false }
  }
  if (parsed === null || typeof parsed !== 'object') return { text: answer, isStructured: false }
  if (Array.isArray(parsed)) return { text: null, isStructured: true }
  const fields = parsed as Record<string, unknown>
  for (const key of ['question', 'ask', 'text', 'message', 'reply', 'answer']) {
    const value = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined
    if (typeof value === 'string' && value.trim() !== '') return { text: value.trim(), isStructured: true }
  }
  return { text: null, isStructured: true }
}

export const normalizeReply = (answer: string): string | null => normalizeReplyValue(answer).text

// An agent can write a whole JSON record into a step (a hook's payload, a turn log). It starts
// with a brace and a quoted key, or a bracket and an object or string, so `{choose one}` and
// `[WIP] fix` stay as written. Such a step has no words of its own: the record's own text field
// stands in when it has one, else a line that says so, and the braces, ids and paths inside are
// never drawn. A record cut off before its closing brace reads the same way. Null for any other
// step. The same text fields are read as in a reply.
const RECORD_STEP = /^\s*(?:\{\s*"|\[\s*[{"])/
export const recordStepWords = (text: string, s: Strings): string | null => {
  if (!RECORD_STEP.test(text)) return null
  const { text: words, isStructured } = normalizeReplyValue(text)

  return oneLine(isStructured && words !== null ? words : s.stepIsRecord) || s.stepIsRecord
}

// The question a reply ends on, if its last paragraph asks one: the last sentence there
// with a question mark, without code or markdown. A reply that ends on a statement asks
// nothing, even if it asked something earlier.
export const lastQuestion = (answer: string, isFull = false): string | null => {
  const prose = normalizeReply(answer)
  return prose === null ? null : lastQuestionInProse(prose, isFull)
}

// For callers that already normalized the reply: do not parse it a second time.
export const lastQuestionInProse = (answer: string, isFull = false): string | null => {
  const prose = answer.replace(/```[\s\S]*?```/g, '\n\n').replace(/`([^`]*)`/g, '$1')
  const paragraphs = prose.split(/\n\s*\n/).map(one => one.trim()).filter(one => one !== '')
  const last = paragraphs.at(-1)
  if (last === undefined) return null
  const lines = last
    .split(/\r?\n/)
    .map(line => withoutEmphasis(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')).trim())
    .filter(line => line !== '')
  const tail = lines.at(-1) ?? ''
  if (!/[?？]/.test(tail)) return null
  // Keep closing wrappers after the question mark so choice parsing can distinguish
  // a wrapped question from a word's own leading apostrophe, such as '90s.
  const sentences = tail.match(/[^.。!！?？]*[?？]["'”」』)]*/g) ?? []
  const question = (sentences.at(-1) ?? '').trim()

  return question === '' ? null : isFull ? question : clip(question, 120)
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
export const applyDigest = (mirror: ProgressMirror, given: Digest, now: number, s: Strings = ZH_TW, hasRunningTurnBackgroundJob = false): ProgressMirror => {
  // The question may come straight from a reply rather than through parseDigest: kept to the
  // same size either way.
  const hasBackgroundJob = (mirror.backgroundJobs ?? 0) > 0
  const digest = {
    ...given,
    next: given.next || (hasBackgroundJob ? s.backgroundRunning : ''),
    ask: hasRunningTurnBackgroundJob ? '' : clip(given.ask, 48),
    why: hasRunningTurnBackgroundJob ? '' : clip(given.why, 120),
  }
  const done = mirror.source === 'turns' ? mirror.tasks.filter(one => one.status === 'completed') : []
  let seq = Math.max(0, ...mirror.tasks.map(one => Number(one.id.replace(/^t/, '')) || 0))
  const id = (): string => {
    seq += 1
    return `t${seq}`
  }
  const finished = digest.done === '' ? done : [...done, task(id(), digest.done, 'completed', null)]
  const open = [
    ...(digest.ask === '' ? [] : [task(id(), digest.ask, 'in_progress', digest.why || digest.ask)]),
    ...(digest.next === '' || digest.next === digest.ask ? [] : [{ ...task(hasBackgroundJob && given.next === '' ? 'background' : id(), digest.next, digest.handoffTo ? 'completed' : 'pending', null), ...(digest.handoffTo ? { handoffTo: digest.handoffTo } : {}) }]),
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
export const markAsked = (mirror: ProgressMirror, question: string, hasRunningTurnBackgroundJob = false): ProgressMirror => {
  if (hasRunningTurnBackgroundJob) return mirror
  const waiting = mirror.tasks.filter(one => waitsOnYou(mirror, one))
  if (waiting.length > 0) {
    const words = question.replace(/\s+/g, ' ').trim()
    const matching = waiting.filter(one => [one.subject, one.why ?? ''].some(text => text.replace(/\s+/g, ' ').trim() === words))
    if (matching.length !== 1) return mirror
    const target = matching[0]
    if (target === undefined) return mirror
    const renewed = renewQuestion(target, mirror.questionSequence)
    return { ...mirror, questionSequence: renewed.questionRevision, tasks: mirror.tasks.map(one => one.id === target.id ? renewed : one) }
  }
  const target = mirror.tasks.find(one => one.status === 'in_progress') ?? mirror.tasks.find(one => one.status === 'pending')
  if (target === undefined) return mirror
  const renewed = renewQuestion({ ...target, waiting: 'you', why: question, ask: null, options: [], command: null, link: null }, mirror.questionSequence)

  return {
    ...mirror,
    autoAsk: target.id,
    questionSequence: renewed.questionRevision,
    // Asked again, even in the words the person answered: it waits on them again, as a plain
    // question. The kind, options, command and link Claude set were for the one they answered.
    answered: withoutMarks(mirror, [target.id]),
    tasks: mirror.tasks.map(one => (one.id === target.id ? renewed : one)),
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

// Whether a session that keeps a Task list has a step waiting on the person.
export const isAskingYou = (mirror: ProgressMirror): boolean => mirror.source === 'tasks' && mirror.tasks.some(one => waitsOnYou(mirror, one))

// The origins of a prompt that are the person writing: typed, from their phone (bridge), a
// ping from Slack, or an app that hosts Claude Code through the SDK. Notifications, schedules,
// other sessions and prompts no one stamped are not.
const PERSON: readonly string[] = ['composer', 'bridge', 'slack-ping', 'sdk']

// An app that hosts Claude Code sends its own events down the same path as the person's
// messages, and can put <system-reminder> blocks before either. Its events open with a tag
// of hyphenated words (<task-notification>, <side-sessions-event>, …); any such tag counts,
// so a new kind of event is not taken for the person. A person who opens with one is missed.
const REMINDER = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>/
const APP_EVENT = /^(?:<[a-z]+(?:-[a-z]+)+\b|\[SYSTEM NOTIFICATION)/

type Submitted = { text: string; isMeta?: true; command?: object; origin: { kind: string; asUser?: true } }

// Whether a prompt is the person's own message, which marks every step of this session that
// waits on them answered. Another plugin's counts only when it sends the person's own words.
export const isPersonsAnswer = (e: Submitted): boolean => {
  if (e.isMeta === true || e.command !== undefined) return false
  if (!PERSON.includes(e.origin.kind) && !(e.origin.kind === 'plugin' && e.origin.asUser === true)) return false
  let text = e.text
  while (REMINDER.test(text)) text = text.replace(REMINDER, '')
  text = text.trim()

  return text !== '' && !APP_EVENT.test(text)
}

// Summed-up questions are answered by the next prompt: the waiting step counts as done.
export const answerTurns = (mirror: ProgressMirror): ProgressMirror =>
  mirror.source !== 'turns'
    ? mirror
    : {
        ...mirror,
        tasks: mirror.tasks.map(one => (one.waiting === 'you' ? answeredStep(one) : one)),
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

const taskNotifications = (prompt: string, isNotification = false): string[] => {
  let text = prompt
  while (REMINDER.test(text)) text = text.replace(REMINDER, '')
  if (!isNotification && !/^\s*<task-notification>/.test(text)) return []
  return [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].map(match => match[1] ?? '')
}

// A restart cannot keep jobs from the old host or the step generated for them.
export const clearBackgroundJobs = (mirror: ProgressMirror): ProgressMirror => ({
  ...mirror,
  backgroundJobs: 0,
  backgroundJobIds: [],
  backgroundReleases: [],
  backgroundReleaseCount: 0,
  tasks: mirror.source === 'turns' ? mirror.tasks.filter(one => one.id !== 'background') : mirror.tasks,
})

// A notification can reach the running turn before the launching call returns.
// Match that release when the call succeeds, falling back only when an id is absent.
export const startBackgroundJob = (mirror: ProgressMirror, id?: string): ProgressMirror => {
  if (mirror.state === 'ended') return mirror
  const ids = mirror.backgroundJobIds ?? []
  if (id !== undefined && ids.includes(id)) return mirror
  const releases = mirror.backgroundReleases ?? []
  const index = id === undefined ? (releases.length > 0 ? 0 : -1) : releases.indexOf(id)
  if (index >= 0) return { ...mirror, backgroundReleases: releases.filter((_, at) => at !== index) }
  if ((mirror.backgroundReleaseCount ?? 0) > 0) return { ...mirror, backgroundReleaseCount: (mirror.backgroundReleaseCount ?? 0) - 1 }
  return { ...mirror, backgroundJobs: (mirror.backgroundJobs ?? 0) + 1, backgroundJobIds: id === undefined ? ids : [...ids, id] }
}

// The structured origin establishes that a task ended, regardless of its status word.
// Text establishes it only on hosts/events without an origin; callers enforce that boundary.
export const finishBackgroundJob = (mirror: ProgressMirror, prompt: string, isNotification = false, isDuringTurn = false): ProgressMirror => {
  const notifications = taskNotifications(prompt, isNotification)
  if (mirror.state === 'ended' || (!isNotification && notifications.length === 0)) return mirror
  return (notifications.length === 0 ? [''] : notifications).reduce((current, notification) => releaseBackgroundJob(current, notification, isDuringTurn), mirror)
}

const releaseBackgroundJob = (mirror: ProgressMirror, notification: string, isDuringTurn: boolean): ProgressMirror => {
  const id = /<tool-use-id>\s*([^<>\s]+)\s*<\/tool-use-id>/.exec(notification)?.[1]
  const ids = mirror.backgroundJobIds ?? []
  const count = mirror.backgroundJobs ?? 0
  if (id === undefined && ids.length > 0) return mirror
  const index = id === undefined ? -1 : ids.indexOf(id)
  if (count > 0 && (index >= 0 || count > ids.length)) {
    return {
      ...mirror,
      backgroundJobs: count - 1,
      backgroundJobIds: ids.filter((_, at) => at !== index),
      // Only the generated placeholder goes away; a real next step keeps its words.
      tasks: count === 1 && mirror.source === 'turns' ? mirror.tasks.filter(one => one.id !== 'background') : mirror.tasks,
    }
  }
  if (!isDuringTurn) return mirror
  if (id === undefined) return { ...mirror, backgroundReleaseCount: (mirror.backgroundReleaseCount ?? 0) + 1 }
  const releases = mirror.backgroundReleases ?? []
  return releases.includes(id) ? mirror : { ...mirror, backgroundReleases: [...releases, id] }
}

// The tools the last turn called: assistant messages back to the person's prompt.
export const turnTools = (messages: readonly TurnMessage[]): string[] => {
  const tools: string[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role === 'user' && message.text.trim() !== '' && (message.toolResults ?? []).length === 0 && taskNotifications(message.text).length === 0) break
    for (const use of message.toolUses) tools.push(use.tool)
  }

  return tools
}

// A turn that changed something: edited a file or ran a command. A turn that only read or
// answered is not work to track.
export const isWork = (tools: readonly string[]): boolean => tools.some(tool => /^(?:Edit|MultiEdit|Write|NotebookEdit|Bash)$/.test(tool))
