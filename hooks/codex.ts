import { LANGS } from './i18n'
import type { Strings } from './i18n'
import { STRINGS } from './strings'
import type { LocalAgent } from './local-agents'
import { baseName, parseAttrs, parseProgress, RESUME } from './parse'
import { scanBlocks, sectionOfProject } from './blocks'
import { cutLine } from './step-words'
import type { BlockSpan } from './blocks'
import { sha256 } from './sha256'
import type { Origin } from './runs'
import type { JournalEntry } from './journal'

// `origin`, `parent` and `isWeak` say who started the session (#399): a run an agent started for
// itself keeps only a session record; weak hints retain the legacy block mark and parent.
export type CodexReport = Origin & {
  session: string
  folder?: string
  folderDigest?: string
  folderCanonicalDigest?: string
  turn: string | null
  state: 'working' | 'waiting' | 'done' | 'ended'
  title: string
  project: string
  steps: string[]
  // The index of the step a PermissionRequest added (#1048): while it waits, the block carries a native line after it.
  // The hook closes and reuses the line so the question ledger can see the change.
  approval?: number
  // The index of the step a Stop added for the question the last message closed on (#1045).
  // Like `approval`, it belongs to the hook and stays available to close or reuse.
  asked?: number
  // Separate durable incarnations: a reused approval must not retire a closing question.
  approvalRevision?: string
  askedRevision?: string
  updated: string
  events?: string[]
  retiredTurns?: string[]
  agent?: LocalAgent
  activity?: { event: string; state: string; updated: string }[]
}

const nextRevision = (revision: string | undefined): string =>
  String(BigInt(/^[1-9]\d*$/.test(revision ?? '') ? revision! : '0') + 1n)

export const codexEvents = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd'] as const

// The plan a tool call carries, as a report input (#922). Codex's update_plan sends
// `plan: [{step, status}]` and Gemini's write_todos `todos: [{description, status}]`; nothing else of
// the call is read. Grok Build's todo_write may carry only the changed items, so its list is read from
// the result, which holds the whole list after the merge (camelCase payload). Hermes' todo tool puts
// that list in extra.result as JSON. Null when it is another tool, no session id, or no usable step.
const PLAN_MARKS: Record<string, string> = { completed: 'x', in_progress: '~', pending: ' ', cancelled: '-', blocked: '!' }
const asRecord = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const planReport = (raw: Record<string, unknown>): { session: string; input: { state: 'working'; steps: string[]; planTitle: string } } | null => {
  const isGrok = raw.toolName === 'todo_write'
  const isCodex = raw.tool_name === 'update_plan'
  const isHermes = raw.tool_name === 'todo' && raw.hook_event_name === 'post_tool_call'
  const hermesList = (): unknown => {
    const input = asRecord(raw.tool_input)
    const result = asRecord(raw.extra).result
    if (result === undefined) return input.merge === true ? undefined : input.todos
    if (typeof result !== 'string') return undefined
    try { return asRecord(JSON.parse(result)).todos } catch { return undefined }
  }
  // A truncated result is half a list, and a DuplicateId or InvalidArgument result has none.
  const list = isGrok ? (raw.toolResultTruncated === true ? undefined : asRecord(asRecord(raw.toolResult).TodosUpdated).todos)
    : isCodex ? asRecord(raw.tool_input).plan : raw.tool_name === 'write_todos' ? asRecord(raw.tool_input).todos : isHermes ? hermesList() : undefined
  const session = isGrok ? raw.sessionId : raw.session_id
  if (typeof session !== 'string' || !Array.isArray(list)) return null
  const items: { mark: string; text: string }[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const one = item as Record<string, unknown>
    const words = one[isGrok || isHermes ? 'content' : isCodex ? 'step' : 'description']
    if (typeof words !== 'string') continue
    let text = words.replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim()
    // The report check refuses a step line over 500 characters, its `- [m] ` marker included: a longer
    // step keeps its first 494, which the writer then cuts to 120 and journals.
    if (text.length > 494) text = text.slice(0, text.charCodeAt(493) >= 0xd800 && text.charCodeAt(493) < 0xdc00 ? 493 : 494)
    if (text === '') continue
    const status = typeof one.status === 'string' && Object.hasOwn(PLAN_MARKS, one.status) ? one.status : 'pending'
    items.push({ mark: PLAN_MARKS[status]!, text })
    if (items.length === 40) break
  }
  if (items.length === 0) return null
  return {
    session,
    input: { state: 'working', steps: items.map(one => `- [${one.mark}] ${one.text}`), planTitle: (items.find(one => one.mark === '~') ?? items[0]!).text },
  }
}

const line = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('INVALID_TEXT')
  const clean = value.replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean || clean.length > 500) throw new Error('INVALID_TEXT')
  return clean
}

// The same heading the board reads for a project (hooks/parse.ts).
const PROJECT_HEADING = /^##\s+(.+?)\s*#*\s*$/

const OPENCLAW_WORKSPACE = /[\\/]\.openclaw[\\/]workspace(?:-[^\\/]*)?[\\/]*$/

// A local session's project from its working folder (#246). `readTurn` in inbox.ts and
// blocks.ts clean a folder with the same rule, so every agent in one folder shares one heading;
// only this copy also drops a name too long for a block title.
export const folderProject = (cwd: unknown): string => {
  if (typeof cwd !== 'string' || !cwd) return ''
  const name = OPENCLAW_WORKSPACE.test(cwd) ? 'OpenClaw' : baseName(cwd).replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim()
  // A name too long for a block title falls back to the agent's name instead of failing the hook.
  return name.length > 500 ? '' : name
}

// This is the one place a new local session title comes from (#246). A session the
// hook cannot file by folder still needs a title a person can tell from another
// session's before either reports (#814): the fallback plus a human-readable
// distinction the caller supplies (a start time), when the caller supplies one.
export const sessionTitle = (folder: string, fallback: string, distinct = ''): string =>
  line(folder || (distinct === '' ? fallback : `${fallback} · ${distinct}`))

// The step a hook writes for a session that has reported none of its own (`codexLifecycle` here,
// `localAgentLifecycle` in codex-local.ts). The view tells it from an agent's step by these words:
// every language's, and those earlier releases wrote, which stay in old blocks (#612).
const EARLIER_LIFECYCLE_STEPS = [
  'Local session activity; Codex explicitly reports task steps',
  '本機 session 活動狀態；任務步驟由 Codex 明確回報',
  '本地 session 活动状态；任务步骤由 Codex 明确报告',
  'Native session activity; the current agent explicitly reports task steps',
  '原生 session 活動狀態；任務步驟由目前 agent 明確回報',
  '原生 session 活动状态；任务步骤由当前 agent 明确报告',
]
export const LIFECYCLE_STEPS: ReadonlySet<string> = new Set([
  ...LANGS.flatMap(lang => [STRINGS[lang].codexLifecycle, STRINGS[lang].localAgentLifecycle]),
  ...EARLIER_LIFECYCLE_STEPS,
])
export const isLifecycleStep = (text: string): boolean => LIFECYCLE_STEPS.has(text.trim())

// The hook keeps one line so the ledger sees the same words when a prompt answers it.
export const questionSteps = (held: readonly string[], previousAsked: number | undefined, state: unknown, value: unknown, isBoardPrompt = false, previousRevision?: string): { steps: string[]; asked: number | undefined; askedRevision: string | undefined } => {
  const steps = [...held]
  let asked = previousAsked !== undefined && Number.isInteger(previousAsked) && previousAsked >= 0 && previousAsked < steps.length ? previousAsked : undefined
  let askedRevision = previousRevision
  if (isBoardPrompt) return { steps, asked, askedRevision }
  if (state === 'working' && asked !== undefined) steps[asked] = steps[asked]!.replace(/^- \[\?\] /, '- [x] ')
  const question = state === 'waiting' && typeof value === 'string' ? cutLine(value.replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim()).text : ''
  if (question !== '' && (asked !== undefined || steps.length < 40)) {
    // Hosts may deliver the same closing question again after Stop or an idle status.
    // Only a changed question or a slot closed by a real prompt begins a new incarnation.
    if (asked === undefined || steps[asked] !== `- [?] ${question}`) askedRevision = nextRevision(askedRevision)
    // A model that already reported the question as its own [?] step keeps that one line.
    if (asked === undefined) asked = steps.includes(`- [?] ${question}`) ? steps.indexOf(`- [?] ${question}`) : steps.length
    steps[asked] = `- [?] ${question}`
  }
  return { steps, asked, askedRevision }
}

// Hooks describe lifecycle, not task completion. Only an explicit report can say done.
export const codexEvent = (previous: CodexReport | null, input: Record<string, unknown>, now: string, s: Strings): CodexReport => {
  const session = line(input.session_id)
  const event = input.hook_event_name
  if (!codexEvents.some(one => one === event)) throw new Error('INVALID_EVENT')
  if (previous !== null && previous.session !== session) throw new Error('SESSION_CONFLICT')
  if (previous === null && event !== 'SessionStart' && event !== 'UserPromptSubmit') throw new Error('UNBOUND_SESSION')
  const turn = typeof input.turn_id === 'string' ? line(input.turn_id) : null
  if (event !== 'SessionStart' && event !== 'SessionEnd' && turn === null) throw new Error('MISSING_TURN')
  const key = `${String(event)}:${turn ?? ''}`
  if (turn && previous?.retiredTurns?.includes(turn)) throw new Error('STALE_TURN')
  const isClosingQuestion = event === 'Stop' && typeof input.question === 'string' && input.question.trim() !== ''
  // Cursor can send its reply after Stop with the same generation id.
  if (turn && previous?.events?.includes(key) && event !== 'PermissionRequest' && !isClosingQuestion) return previous
  if (previous?.turn && turn && previous.turn !== turn && event !== 'UserPromptSubmit') throw new Error('STALE_TURN')
  const working = event === 'UserPromptSubmit'
  // A reply that ends on a question waits for the person, even after the model reported its own steps done.
  const state = event === 'SessionStart' ? previous?.state === 'ended' ? 'waiting' : previous?.state ?? 'waiting' : event === 'SessionEnd' ? previous?.state === 'done' ? 'done' : 'ended' : working ? 'working' : previous?.state === 'done' && !isClosingQuestion ? 'done' : 'waiting'
  // Keep the hook's own steps in place: the ledger needs to see their original words closed.
  // A session ending does not answer its last question, but it does end an approval.
  const held = previous?.steps ?? [`- [ ] ${s.codexLifecycle}`]
  const earlier = previous?.approval !== undefined && previous.approval < held.length ? previous.approval : undefined
  const approvalSteps = held.map((step, index) => event !== 'SessionStart' && index === earlier ? step.replace(/^- \[\?\] /, '- [x] ') : step)
  const { steps, asked, askedRevision } = questionSteps(approvalSteps, previous?.asked, working ? 'working' : event === 'Stop' ? state : 'ended', event === 'Stop' ? input.question : undefined, working && input.prompt_submitted === false, previous?.askedRevision)
  let approval = earlier
  let approvalRevision = previous?.approvalRevision
  if (event === 'PermissionRequest') {
    approvalRevision = nextRevision(approvalRevision)
    if (approval === undefined) approval = steps.length
    steps[approval] = `- [?] ${s.codexApprovalStep}`
  }

  return {
    session, turn: turn ?? previous?.turn ?? null, state,
    title: previous?.title ?? s.codexTask,
    project: previous?.project ?? s.codexProject,
    // The hook never reads the prompt, so reported steps remain unchanged here (#243).
    steps,
    ...(approval === undefined ? {} : { approval }),
    ...(asked === undefined ? {} : { asked }),
    ...(approvalRevision === undefined ? {} : { approvalRevision }),
    ...(askedRevision === undefined ? {} : { askedRevision }),
    updated: now,
    // A replayed event keeps the list as it was, so the replay changes no bytes.
    events: previous?.events?.includes(key) ? previous.events : [...(previous?.events ?? []), key].slice(-256),
    retiredTurns: [...(previous?.retiredTurns ?? []), ...(working && previous?.turn && previous.turn !== turn ? [previous.turn] : [])].slice(-128),
  }
}

// Explicit input remains limited to forty user steps. Internal lifecycle updates may
// additionally retain their separately owned lines, without dropping cache validation.
const reportSteps = (state: unknown, given: unknown, maximum: number): string[] => {
  if (!['working', 'waiting', 'done', 'ended'].includes(String(state))) throw new Error('INVALID_STATE')
  if (!Array.isArray(given) || given.length === 0) throw new Error('INVALID_STEPS')
  const invalid = (step: unknown): never => {
    let text: string
    try { text = typeof step === 'string' ? step : JSON.stringify(step) ?? String(step) } catch { text = '<unreadable>' }
    throw Object.assign(new Error('INVALID_STEP'), { code: 'INVALID_STEP', step: Array.from(text).slice(0, 60).join('') })
  }
  const steps = given.map(step => {
    let text: string
    try { text = line(step) } catch { return invalid(step) }
    const item = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(text)?.[1]
    if (item === undefined) return invalid(step)
    if (!item.startsWith('[')) return `- [ ] ${item}`
    const marked = /^\[([ xX~?>!\-])\]\s+(.+)$/.exec(item)
    if (marked === null) return invalid(step)
    return `- [${marked[1]!.toLowerCase()}] ${marked[2]}`
  })
  if (state === 'done' && steps.some(step => !/^- \[[x\-]\]/.test(step))) throw new Error('UNFINISHED_STEPS')
  if (steps.length <= maximum) return steps
  // Over the limit, a question for the user is never the step left out.
  let room = maximum - Math.min(maximum, steps.filter(step => step.startsWith('- [?]')).length)
  return steps.filter(step => step.startsWith('- [?]') || room-- > 0).slice(0, maximum)
}

export const validateCodexReport = (report: CodexReport, session: string): CodexReport => {
  if (report.session !== session) throw new Error('SESSION_CONFLICT')
  const owned = new Set([report.approval, report.asked].filter((index): index is number =>
    index !== undefined && Number.isInteger(index) && index >= 0 && Array.isArray(report.steps) && index < report.steps.length))
  if (Array.isArray(report.steps) && report.steps.length > 40 + owned.size) throw new Error('INVALID_STEPS')
  return { ...report, session: line(session), title: line(report.title), project: line(report.project),
    steps: reportSteps(report.state, report.steps, 40 + owned.size) }
}

export const codexReport = (previous: CodexReport | null, session: string, input: Record<string, unknown>, now: string, s: Strings): CodexReport => {
  if (previous !== null && previous.session !== session) throw new Error('SESSION_CONFLICT')
  const steps = reportSteps(input.state, input.steps, 40)
  let approval: number | undefined
  let asked: number | undefined
  for (const kind of ['approval', 'asked'] as const) {
    const index = previous?.[kind]
    const held = index === undefined ? undefined : previous?.steps[index]
    if (held === undefined || !/^- \[[?x]\] /.test(held)) continue
    const carried = steps.push(`- [x] ${held.slice(6)}`) - 1
    if (kind === 'approval') approval = carried
    else asked = carried
  }
  return {
    session: line(session), turn: previous?.turn ?? null,
    state: input.state as CodexReport['state'],
    title: line(input.title), project: input.project === undefined ? previous?.project ?? s.codexProject : line(input.project),
    steps, updated: now,
    ...(approval === undefined ? {} : { approval }),
    ...(asked === undefined ? {} : { asked }),
    ...(previous?.approvalRevision === undefined ? {} : { approvalRevision: previous.approvalRevision }),
    ...(previous?.askedRevision === undefined ? {} : { askedRevision: previous.askedRevision }),
    events: previous?.events ?? [], retiredTurns: previous?.retiredTurns ?? [],
    ...(previous?.activity === undefined ? {} : { activity: previous.activity }),
  }
}

// Keep the full words available until the caller has saved them in the journal.
export const limitReport = <T extends CodexReport>(report: T): { report: T; entries: Omit<JournalEntry, 'at'>[]; cut: number } => {
  const short = (text: string): string => cutLine(text).text
  const title = short(report.title)
  const steps = report.steps.map(step => `${step.slice(0, 6)}${short(step.slice(6))}`)
  // Only a field that was shortened is journaled: the title once, and each cut step with
  // its task. Journaling every step of a cut title would flood the journal on each resend.
  const entries: Omit<JournalEntry, 'at'>[] = [
    ...(title !== report.title ? [{ project: report.project, task: report.title, step: report.title }] : []),
    ...report.steps.flatMap((step, index) => steps[index] !== step ? [{ project: report.project, task: report.title, step: step.slice(6) }] : []),
  ]
  return {
    report: { ...report, title, steps }, entries,
    cut: Number(title !== report.title) + steps.filter((step, index) => step !== report.steps[index]).length,
  }
}

// A short alias is not ownership. Leave a peer alone only when its full native
// binding and digest agree; an unowned or contradictory alias still blocks writes.
const localBlockSpans = (lines: readonly string[], owner: string, agent: string, session?: string): BlockSpan[] | null => {
  const id = owner.slice(0, 8)
  const owned: BlockSpan[] = []
  for (const span of scanBlocks(lines).filter(span => span.session === id)) {
    const attrs = parseAttrs(lines[span.start] ?? '')
    // A withdrawal has no session to compare, so the owner digest itself must prove the marker's resume.
    if (attrs.owner === owner && attrs.agent === agent && (attrs.resume === undefined || (session === undefined ? sha256(`${agent}:${attrs.resume}`) === owner : attrs.resume === session))) {
      owned.push(span)
      continue
    }
    const isPeer = attrs.agent !== undefined && attrs.resume !== undefined && RESUME.test(attrs.resume)
      && attrs.owner !== owner && attrs.owner?.startsWith(id) === true
      && attrs.owner === sha256(`${attrs.agent}:${attrs.resume}`)
      && (session === undefined || attrs.agent !== agent || attrs.resume !== session)
    if (!isPeer) return null
  }
  return owned
}

// A report's step lines. The step a PermissionRequest added, while it still waits, is followed by the native line.
const NATIVE_CODEX = '<!-- native=codex -->'
const stepLines = (report: CodexReport, owner: string, isAsking: boolean, nativeApproval = report.approval): string[] =>
  report.steps.flatMap((step, index) => {
    const kind = index === report.approval ? 'approval' : index === report.asked ? 'asked' : undefined
    const revision = kind === 'approval' ? report.approvalRevision : kind === 'asked' ? report.askedRevision : undefined
    // Old caches remain tokenless until a genuinely new ask. Never invent closure evidence.
    const token = kind !== undefined && /^[1-9]\d*$/.test(revision ?? '')
      ? [`<!-- question=${sha256(`${owner}:${kind}`)}:${revision} -->`] : []
    return [step, ...(index === nativeApproval && (!isAsking || step.startsWith('- [?]')) ? [NATIVE_CODEX] : []), ...token]
  })

// A board completion is authoritative only for this exact owned task. Lifecycle
// metadata reads it under the existing board lock before reusing its session cache.
// Explicit task reports carry fresh intent and deliberately supersede this projection.
export const boardConfirmedReport = (text: string, previous: CodexReport, owner: string): CodexReport => {
  const lines = text.split(/\r?\n/)
  const spans = localBlockSpans(lines, owner, previous.agent ?? 'codex', previous.session)
  const span = spans?.[0]
  if (spans?.length !== 1 || span === undefined || !span.isClosed || span.state !== 'done') return previous
  const attrs = parseAttrs(lines[span.start] ?? '')
  if (attrs.owner !== owner || attrs.agent !== (previous.agent ?? 'codex')) return previous
  const at = Date.parse(attrs.updated ?? '')
  if (!Number.isFinite(at) || at < Date.parse(previous.updated)) return previous
  const steps = previous.steps.map(step => step.replace(/^(- \[)[ ~?>!](\] .*)$/, '$1x$2'))
  const expected = [`### ${previous.title}`, ...stepLines({ ...previous, steps }, owner, false, previous.approval !== undefined && previous.steps[previous.approval]?.startsWith('- [?]') ? previous.approval : -1)].join('\n')
  if (lines.slice(span.start + 1, span.end).join('\n') !== expected) return previous
  if (previous.state === 'done' && at === Date.parse(previous.updated) && JSON.stringify(steps) === JSON.stringify(previous.steps)) return previous
  return { ...previous, state: 'done', steps, updated: new Date(at).toISOString() }
}

// The full digest prevents an eight-character collision or a pasted block from acquiring ownership.
export const putCodexBlock = (text: string, report: CodexReport, owner: string, isProjectChanged = false): string => {
  if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error('INVALID_OWNER')
  const id = owner.slice(0, 8)
  const agent = report.agent ?? 'codex'
  // The block id is a hash prefix; only the host's full id can match a live receiver.
  const resume = RESUME.test(report.session) ? ` resume=${report.session}` : ''
  // Only a run is marked: a person's session is the default, so its block stays as it was.
  const run = report.origin === 'run' ? ` origin=run${report.parent !== undefined && RESUME.test(report.parent) ? ` parent=${report.parent}` : ''}` : ''
  const marker = `<!-- auto session=${id} agent=${agent} source=${agent}-local owner=${owner} state=${report.state} updated=${report.updated}${resume}${run} -->`
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const block = [marker, `### ${report.title}`, ...stepLines(report, owner, true), `<!-- /auto session=${id} -->`].join(eol)
  // Use the board's scanner: Markdown examples are not task ownership, and a
  // missing close must never reach past the next project or another agent's block.
  // Keep raw CR bytes in these lines so offsets preserve even mixed line endings.
  const lines = text.split('\n')
  const found = localBlockSpans(lines, owner, agent, report.session)
  if (found === null || found.length > 1) throw new Error('BLOCK_CONFLICT')
  const existing = found[0]
  // Append a section rather than reformat another writer's bytes.
  // A project already headed in the file gets the block at the end of that section, found the way
  // placeUnder finds it; only a project with no section gets a new heading at the end.
  const append = (text: string): string => {
    const all = text.split('\n')
    const section = sectionOfProject(all, report.project)
    // A section holding a block cut off before its closing marker would swallow a block put after it,
    // so such a project gets a section of its own at the end, as before.
    const inside = section === null ? [] : all.slice(section.heading + 1, section.end)
    const isCut = inside.filter(one => /^\s*<!-- auto\b/.test(one)).length !== inside.filter(one => /^\s*<!-- \/auto\b/.test(one)).length
    if (section === null || isCut) return `${text}${text && !text.endsWith('\n') ? eol : ''}${eol}## ${report.project}${eol}${block}${eol}`
    let at = section.end
    while (at > section.heading + 1 && all[at - 1]?.trim() === '') at -= 1
    const pos = Math.min(all.slice(0, at).reduce((total, one) => total + one.length + 1, 0), text.length)
    const before = text.slice(0, pos)
    // What follows is a blank line, the next heading or the end, so the one blank line put before the
    // block is all it adds besides itself, and dropCodexBlock takes that line back with it.
    return `${before}${before.endsWith('\n') ? '' : eol}${eol}${block}${eol}${text.slice(pos)}`
  }
  let next: string
  if (existing) {
    const attrs = parseAttrs(lines[existing.start] ?? '')
    if (attrs.owner !== owner || attrs.agent !== agent) throw new Error('BLOCK_CONFLICT')
    const last = existing.isClosed ? existing.end : existing.start
    const offset = (index: number): number => lines.slice(0, index).reduce((total, line) => total + line.length + 1, 0)
    const end = offset(last) + (lines[last] ?? '').replace(/\r$/, '').length
    // Only a report that changes the project moves the block (#246). Any other write keeps
    // its place, so a block someone moved, or a heading the parser reads differently, stays.
    const project = isProjectChanged ? parseProgress(`## ${existing.project}`)[0] : undefined
    // Compare names as the parser reads them: it drops a heading's trailing `#`.
    next = isProjectChanged && project?.name !== (parseProgress(`## ${report.project}`)[0]?.name ?? report.project)
      ? append(text.slice(0, offset(existing.start)) + text.slice(offset(last + 1)))
      : text.slice(0, offset(existing.start)) + block + text.slice(end)
  } else {
    next = append(text)
  }
  const visible = parseProgress(next).flatMap(project => project.tasks).filter(task => task.auto?.session === id && task.auto.agent === agent && (task.auto.resume ?? null) === (resume === '' ? null : report.session))
  if (visible.length !== 1) throw new Error('BLOCK_NOT_VISIBLE')
  return next
}

export const dropCodexBlock = (text: string, owner: string): string => {
  if (!/^[a-f0-9]{64}$/.test(owner)) return text
  const lines = text.split('\n')
  const spans = localBlockSpans(lines, owner, 'codex')
  const span = spans?.[0]
  if (spans?.length !== 1 || span === undefined) return text
  const attrs = parseAttrs(lines[span.start] ?? '')
  if (attrs.owner !== owner || attrs.agent !== 'codex') return text
  // Like removeAutoBlock, an unfinished block loses only its marker. Slice the
  // raw span so mixed line endings and every other writer's bytes stay intact.
  const last = span.isClosed ? span.end : span.start
  const offset = (index: number): number => lines.slice(0, index).reduce((total, line) => total + line.length + 1, 0)
  // putCodexBlock opens a section of its own for a new block: when this block is all that section
  // holds, its heading and the blank line before it go too, so nothing of the withdrawn run is left.
  let first = span.start
  const next = lines.slice(last + 1).find(line => line.trim() !== '')
  if (first > 0 && PROJECT_HEADING.test(lines[first - 1] ?? '') && (next === undefined || PROJECT_HEADING.test(next))) {
    first -= 1
    if (first > 0 && (lines[first - 1] ?? '').trim() === '') first -= 1
  } else if (span.isClosed && first > 0 && (lines[first - 1] ?? '').trim() === '') {
    // A block put into a section that was already there came with one blank line before it. When a
    // blank line, a heading or the end follows the block, that line goes too, and the section is left
    // as it was.
    const following = lines[last + 1]
    if (following === undefined || following.trim() === '' || PROJECT_HEADING.test(following)) first -= 1
  }
  return text.slice(0, offset(first)) + text.slice(offset(last + 1))
}
