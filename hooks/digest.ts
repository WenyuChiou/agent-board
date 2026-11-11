import type { ProgressMirror, ProgressMirrorTask } from '../types'
import { cleanContext, cleanTitle, clip, markAnswered, renewQuestion, waitsOnYou, withoutMarks } from './mirror'
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
    .replace(/[*#]+/g, '')
    .replace(/^\s*>+\s?/, '')
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

// A web link, without the punctuation or closing quote that follows it in a sentence
// (`… at https://x.dev/a?`, `“Review https://x.dev/a?”`).
const LINK = /https?:\/\/[^\s<>"'`“”‘’「」『』，。！？、；：（）]*[^\s<>"'`“”‘’「」『』.,;:!?？。！，、；：（)\]）]/g

// A question whose choices follow as a list (#1243) counts only under every guard below, since
// a false question under Needs you costs more trust than a missed one. A summary's heading
// (`What changed?`), a recap (`What did you ask for?`) and an answered FAQ (`**Should I make
// any changes?**`) all sit over a list too, and none of them waits on the person.
const LIST_ITEM = /^( {0,3})(?:(?:[-*+•]|\d+[.)]|[A-Za-z][.)])\s+|\d+、\s*)(.*)$/
// A choice is a short label. An item that is a sentence, or asks, explains or answers instead.
// One word may still end on a period (`1. PostgreSQL.`); a share (`Docker — 70%`) is a result.
const isChoice = (item: string): boolean => {
  const label = /^[^\s.]+\.$/.test(item) ? item.slice(0, -1) : item

  return label !== '' && label.length <= 60 && !/[?？。！]|[.!]\s/.test(label) && !/[.!;；:：]$/.test(label) && !/\d\s*[%％]/.test(label)
}
// Words only the agent says to the person. With them an open `what` asks to pick too; a yes or
// no (`Do you want the details?`) over a list does not.
const ASKS_YOU = /\b(?:do you (?:want|prefer|need)|would you (?:like|prefer|rather)|want me to)\b|要我|[你您](?:要|想|希望|偏好|需要)/i
// `Should I …?` is also how an FAQ heading words the person's own question. It counts only with
// a word that asks to pick, on a line that is not set as a heading.
const ASKS_ME = /\b(?:should|shall|can|could|may) (?:I|we)\b|我該|我應該|我应该|該用|该用|要用|要選|要选/i
const PICKS = /\b(?:which|or)\b|哪|還是|还是|或是/i
const PICKS_OPEN = /\bwhat\b|什麼|什么/i
// A question about what already happened is a recap, whoever it names.
const IS_PAST = /\b(?:did|was|were|had|have|has)\b|了|過|过|剛|刚|之前|先前|原先|上次/i
// A bare `Which database first?` (`先用哪個資料庫？`, the #1243 report's own shape) asks for one
// thing to do next. Only that exact shape counts: with a verb (`Which jobs ran first?`) or for
// several (`先做哪些工作？`) it is a timeline's heading, answered by its list.
// The one word must not be a verb in the past (`Which finished first?`, `Which ran first?`).
const ASKS_ORDER = /^which (?:one|(?!(?:ran|went|came|began|broke|built|won|got|made|took|wrote|did|was|were|had|left|lost|fell|sent|spent|ate|saw|ended)\b)(?![\p{L}-]*ed\b)[\p{L}-]+) (?:first|next)[?？]$|^(?:先|下一步|接下來|接下来)[^，,。.]{0,4}哪(?:個|个|一)[^，,。.？?]{0,8}[？?]$/iu
const asksToPick = (question: string, isHeading: boolean): boolean => {
  // A heading, bold line or `Q:` over a list is a section the list answers (an FAQ, a survey's
  // results), whoever its words name.
  if (isHeading || IS_PAST.test(question)) return false
  if (ASKS_YOU.test(question)) return PICKS.test(question) || PICKS_OPEN.test(question)

  return PICKS.test(question) && ASKS_ME.test(question) || ASKS_ORDER.test(question)
}
const IS_HEADING = /^\s*(?:#|>|(?:Q|問|问)\s*[:：.])|^\s*([*_]{1,3})\S.*\1\s*$/i

// The question line over a list of choices that ends the reply, or null. Blank lines may sit
// between the question and the list and between the choices; any other line ends the list.
// A question introduced by a label (`Survey results:`, `The CI timeline:`) or a caption with no
// end mark (`Completed intake form with the customer's answers`) heads a section of a report,
// so it is null too. A sentence the agent ends before it (`Done.`) leaves the question its own.
const lineOverChoices = (prose: string): string | null => {
  const lines = prose.split(/\r?\n/)
  let at = lines.length
  let count = 0
  // Every choice sits at one indent: an item nested under another explains it.
  let indent: string | undefined
  while (at > 0) {
    const line = lines[at - 1] ?? ''
    const item = LIST_ITEM.exec(line)
    if (line.trim() !== '' && (item === null || item[1] !== (indent ??= item[1]) || !isChoice(withoutEmphasis(item[2] ?? '').trim()))) break
    if (item !== null) count += 1
    at -= 1
  }
  const line = lines[at - 1] ?? ''
  const lead = lines.slice(0, Math.max(at - 1, 0)).filter(one => one.trim() !== '').at(-1) ?? ''

  const isCaption = lead.trim() !== '' && !/[.。!！?？)）」』"”'…]\s*$/.test(withoutEmphasis(lead).trim())

  return count < 2 || LIST_ITEM.test(line) || isCaption ? null : line
}

const OPENERS: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』' }
const CLOSERS = new Set(Object.values(OPENERS))
// A question mark inside a quote that follows other words is a question told about, not one
// put to the person: `… and asked "Blue or green?"` (#1273). Two shapes do ask: a quote that
// wraps the whole question, and a quoted last option after `or` (`"red" row or "blue row?"`),
// unless the sentence reports what was asked or said (`The test asked either "x" or "Ready?"`).
const REPORTS = /\b(?:ask(?:ed|s)?|sa(?:id|ys)|wr(?:ote|ites)|repl(?:ied|ies)|typed|prompt(?:ed|s)?)\b|問|问|說|说|寫|写|回覆|回复/i
const isLoneQuote = (line: string, at: number): boolean => {
  const before = line[at - 1] ?? ' '
  return /\d/.test(before) || /\S/.test(before) && /^(?:\s|$)/.test(line.slice(at + 1))
}
const isQuoted = (line: string, mark: number): boolean => {
  const open: number[] = []
  let straight = -1
  for (let i = 0; i < mark; i += 1) {
    const char = line[i] ?? ''
    if (char === '\\') i += 1
    // A straight quote closes the open one. With none open, it also stands alone as an inch mark
    // (`a 12" shelf`) or after a word with nothing after it (`fast" is`), and then opens nothing.
    else if (char === '"') straight = straight >= 0 || isLoneQuote(line, i) ? -1 : i
    else if (char in OPENERS) open.push(i)
    else if (CLOSERS.has(char)) open.pop()
  }
  // A quote the reply talks about (`escape " here?`) has no partner after the mark. A partner with
  // a space before it and a character right after it opens a later quotation instead (`stray " here?
  // "Yes" is fine`, #1290). Any other partner closes: right after a character, as Chinese writes
  // it (`他問"要不要？我可以幫忙"然後`), or before a space (`asked "Blue or green? " and`).
  const partner = line.indexOf('"', mark + 1)
  const isCloser = partner !== -1 && !(/\s/.test(line[partner - 1] ?? '') && /\S/.test(line[partner + 1] ?? ''))
  if (straight >= 0 && isCloser) open.push(straight)
  // An apostrophe also sits inside words, so a single quote counts only when it closes right
  // after the mark and opens at the start of a word.
  if (/^[?？]["”」』)）]*'/.test(line.slice(mark))) {
    for (let i = mark - 1; i >= 0; i -= 1) {
      if (line[i] === "'" && !/[\p{L}\p{N}]/u.test(line[i - 1] ?? '')) { open.push(i); break }
    }
  }

  return open.some(from => {
    const before = line.slice(0, from).replace(/^.*[.。!！?？]/, '')
    const lead = before.replace(/["'“‘「『(（\s]/g, '')
    return lead !== '' && (REPORTS.test(before) || !/(?:\bor|還是|还是|或是|或)$/i.test(line.slice(0, from).trim()))
  })
}

// For callers that already normalized the reply: do not parse it a second time.
export const lastQuestionInProse = (answer: string, isFull = false): string | null => {
  // A straight quote in code (`name"`) is a character the reply shows, not a quotation: it stands
  // in as another mark until the question is put back together.
  const prose = answer.replace(/```[\s\S]*?```/g, '\n\n').replace(/`([^`]*)`/g, (_, code: string) => code.replace(/"/g, '\u0001'))
  const paragraphs = prose.split(/\n\s*\n/).map(one => one.trim()).filter(one => one !== '')
  const last = paragraphs.at(-1)
  if (last === undefined) return null
  const lines = last
    .split(/\r?\n/)
    .map(line => withoutEmphasis(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')).trim())
    .filter(line => line !== '')
  // A link's own `?` and `.` (`http://127.0.0.1:5173/?t=…`) neither ask nor end a sentence
  // (#1108): each link stands in as a mark with neither, and is put back in the question.
  const links: string[] = []
  const hidden = (line: string): string => line.replace(LINK, link => `\u0000${links.push(link) - 1}\u0000`)
  let tail = hidden(lines.at(-1) ?? '')
  const isOverList = !/[?？]/.test(tail)
  let isHeading = false
  if (isOverList) {
    const line = lineOverChoices(prose)
    if (line === null) return null
    isHeading = IS_HEADING.test(line)
    tail = hidden(withoutEmphasis(line).trim())
    // The line must end on its question mark: a question the same line goes on to answer
    // (`Why did it fail? The cache was stale.`) asks nothing.
    if (!/[?？]$/.test(tail)) return null
  }
  // Keep closing wrappers after the question mark so choice parsing can distinguish
  // a wrapped question from a word's own leading apostrophe, such as '90s.
  const sentence = [...tail.matchAll(/[^.。!！?？]*[?？]["'”」』)]*/g)].at(-1)
  if (sentence === undefined) return null
  if (isQuoted(tail, (sentence.index ?? 0) + sentence[0].search(/[?？]/))) return null
  const question = sentence[0].replace(/\u0000(\d+)\u0000/g, (_, at: string) => links[Number(at)] ?? '').replace(/\u0001/g, '"').trim()
  // The question itself must be put to the person, not the line it ends: `You asked for a
  // summary. What changed?` over a list asks nothing.
  if (isOverList && !asksToPick(question, isHeading)) return null

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

// A summary of an earlier report can add finished work without replacing the
// original question or introducing an ask from before the person's reply.
export const applyLateDigest = (mirror: ProgressMirror, digest: Digest, now: number, s: Strings, hasRunningTurnBackgroundJob = false): ProgressMirror => {
  const next = applyDigest(mirror, { ...digest, ask: '', why: '' }, now, s, hasRunningTurnBackgroundJob)
  return { ...next, updated: mirror.updated, autoAsk: mirror.autoAsk, tasks: [...next.tasks, ...mirror.tasks.filter(one => waitsOnYou(mirror, one))] }
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
  // Finished work stays finished when the closing reply asks a new question.
  const target = mirror.tasks.find(one => one.status === 'in_progress') ?? mirror.tasks.find(one => one.status === 'pending') ?? task('auto-question', question, 'pending', null)
  const renewed = renewQuestion({ ...target, waiting: 'you', why: target.id === 'auto-question' ? null : question, ask: null, options: [], command: null, link: null }, mirror.questionSequence)

  return {
    ...mirror,
    autoAsk: target.id,
    questionSequence: renewed.questionRevision,
    // Asked again, even in the words the person answered: it waits on them again, as a plain
    // question. The kind, options, command and link Claude set were for the one they answered.
    answered: withoutMarks(mirror, [target.id]),
    tasks: mirror.tasks.some(one => one.id === target.id) ? mirror.tasks.map(one => (one.id === target.id ? renewed : one)) : [...mirror.tasks, renewed],
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
    tasks: mirror.tasks.map(one => one.id !== id || one.waiting !== 'you' ? one : id === 'auto-question' ? { ...one, status: 'completed' as const, waiting: null, why: null } : { ...one, waiting: null, why: null }),
  }
}

// Only the explicit question fields enter the mirror; tool results and answers stay in the host.
export const toolQuestions = (mirror: ProgressMirror, questions: unknown, call: string, now: number): ProgressMirror => {
  if (!Array.isArray(questions)) return mirror
  const added = questions.flatMap((given: unknown, index) => {
    if (given === null || typeof given !== 'object' || !('question' in given) || typeof given.question !== 'string' || given.question.trim() === '') return []
    const options = 'options' in given && Array.isArray(given.options) ? given.options.flatMap((option: unknown) => option !== null && typeof option === 'object' && 'label' in option && typeof option.label === 'string' ? [clip(option.label, 120)] : []) : []
    // The question is written once, as the step itself; the native line says it is answered in Claude's own window.
    return [{ ...task(`ask:${call}:${index}`, clip(given.question, 120), 'pending', null), waiting: 'you' as const, ask: 'choose' as const, options, native: { agent: 'claude', options } }]
  })
  return added.reduce((current, one) => {
    const renewed = renewQuestion(one, current.questionSequence)
    return { ...current, source: mirror.tasks.length === 0 ? 'turns' : mirror.source, tasks: [...current.tasks.filter(task => task.id !== one.id), renewed], questionSequence: renewed.questionRevision, updated: now }
  }, added.length === 0 ? mirror : settleChatReply(mirror))
}

// The id of the step a tool approval puts into a Task list (#1048): one at a time, in the dialog's own window.
const APPROVAL = 'approval'

// A tool is waiting for the person's yes in Claude's own dialog: the list gets one step that waits on
// them, with the native line, so the board says where to answer. A list that already asks something
// keeps its question, and a session without a Task list has nothing to hang the step on.
export const markApproval = (mirror: ProgressMirror, step: string): ProgressMirror => {
  if (mirror.source !== 'tasks' || mirror.tasks.length === 0) return mirror
  const reported = settleChatReply(mirror)
  if (reported.tasks.some(one => one.id !== APPROVAL && waitsOnYou(reported, one))) return mirror
  const renewed = renewQuestion({ ...task(APPROVAL, step, 'pending', null), waiting: 'you', native: { agent: 'claude', options: [] } }, reported.questionSequence)

  return { ...reported, questionSequence: renewed.questionRevision, tasks: [...reported.tasks.filter(one => one.id !== APPROVAL), renewed] }
}

// An approval that waited behind another question goes up once nothing else waits (#1106); a step
// already there stays as it is, so its question token does not change on every save.
export const raiseApproval = (mirror: ProgressMirror, step: string): ProgressMirror =>
  mirror.tasks.some(one => one.id === APPROVAL) ? mirror : markApproval(mirror, step)

// The dialog is over (answered, declined, or the turn ended): the step goes, it was never the model's.
export const clearApproval = (mirror: ProgressMirror): ProgressMirror =>
  mirror.tasks.some(one => one.id === APPROVAL) ? { ...mirror, tasks: mirror.tasks.filter(one => one.id !== APPROVAL) } : mirror

// A TaskList refresh must not remove the only closure evidence before the ledger saves it.
export const retainApproval = (previous: ProgressMirror, next: ProgressMirror): ProgressMirror => {
  const approval = previous.tasks.find(one => one.id === APPROVAL)
  return approval === undefined || next.tasks.some(one => one.id === APPROVAL)
    ? next : { ...next, tasks: [...next.tasks, approval] }
}

// The ledger needs to see the approval closed before its temporary step goes away.
export const closeApproval = (mirror: ProgressMirror): ProgressMirror =>
  mirror.tasks.some(one => one.id === APPROVAL) ? {
    ...mirror,
    tasks: mirror.tasks.map(one => one.id === APPROVAL ? { ...one, status: 'completed' as const, waiting: null, why: null } : one),
  } : mirror

// The native prompt for these questions ended: their steps are finished, so no list keeps one open.
export const closeToolQuestions = (mirror: ProgressMirror, call: string): ProgressMirror => ({
  ...mirror,
  tasks: mirror.tasks.map(one => one.id.startsWith(`ask:${call}:`) ? { ...one, status: 'completed' as const, waiting: null, why: null } : one),
})

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

// A real agent report can keep an older summed-up question as a closed line.
export const answerTurns = (mirror: ProgressMirror): ProgressMirror =>
  mirror.source !== 'turns'
    ? mirror
    : {
        ...mirror,
        tasks: mirror.tasks.map(one => (one.waiting === 'you' ? answeredStep(one) : one)),
      }

// Chat replies do not answer native permission or selection dialogs.
const isChatQuestion = (mirror: ProgressMirror, one: ProgressMirrorTask): boolean => one.native === undefined && waitsOnYou(mirror, one)

export const noteChatReply = (mirror: ProgressMirror, at: number): ProgressMirror =>
  Number.isFinite(at) && at > (mirror.updated ?? 0) && mirror.tasks.some(one => isChatQuestion(mirror, one))
    ? { ...mirror, replied: at } : mirror

// Only the agent's next report settles a chat reply. Keep the previous words
// so the question ledger has proof even when the report asks another question.
export const settleChatReply = (mirror: ProgressMirror): ProgressMirror => {
  if (mirror.replied === undefined) return mirror
  const ids = mirror.tasks.filter(one => isChatQuestion(mirror, one)).map(one => one.id)
  const next = mirror.source === 'turns'
    ? { ...mirror, tasks: mirror.tasks.map(one => ids.includes(one.id) ? answeredStep(one) : one) }
    : markAnswered(mirror, ids)
  return { ...next, autoAsk: null, replied: undefined }
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
