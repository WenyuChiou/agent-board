import type { Strings } from './i18n'
import type { LocalAgent } from './local-agents'
import { baseName, parseAttrs, parseProgress, RESUME } from './parse'
import { scanBlocks } from './blocks'
import type { Origin } from './runs'

// `origin`, `parent` and `isWeak` say who started the session (#399): a run an agent started for
// itself keeps only a session record; weak hints retain the legacy block mark and parent.
export type CodexReport = Origin & {
  session: string
  folder?: string
  turn: string | null
  state: 'working' | 'waiting' | 'done' | 'ended'
  title: string
  project: string
  steps: string[]
  updated: string
  events?: string[]
  retiredTurns?: string[]
  agent?: LocalAgent
  activity?: { event: string; state: string; updated: string }[]
}

export const codexEvents = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd'] as const

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

// This is the one place a new local session title comes from (#246).
export const sessionTitle = (folder: string, fallback: string): string => line(folder || fallback)

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
  if (turn && previous?.events?.includes(key)) return previous
  if (previous?.turn && turn && previous.turn !== turn && event !== 'UserPromptSubmit') throw new Error('STALE_TURN')
  const working = event === 'UserPromptSubmit'
  const state = event === 'SessionStart' ? previous?.state === 'ended' ? 'waiting' : previous?.state ?? 'waiting' : event === 'SessionEnd' ? previous?.state === 'done' ? 'done' : 'ended' : working ? 'working' : previous?.state === 'done' ? 'done' : 'waiting'
  return {
    session, turn: turn ?? previous?.turn ?? null, state,
    title: previous?.title ?? s.codexTask,
    project: previous?.project ?? s.codexProject,
    // The hook never reads the prompt, so only a report or the board can confirm an answer (#243).
    steps: previous?.steps ?? [`- [ ] ${s.codexLifecycle}`],
    updated: now,
    events: [...(previous?.events ?? []), key].slice(-256),
    retiredTurns: [...(previous?.retiredTurns ?? []), ...(working && previous?.turn && previous.turn !== turn ? [previous.turn] : [])].slice(-128),
  }
}

export const codexReport = (previous: CodexReport | null, session: string, input: Record<string, unknown>, now: string, s: Strings): CodexReport => {
  if (previous !== null && previous.session !== session) throw new Error('SESSION_CONFLICT')
  if (!['working', 'waiting', 'done', 'ended'].includes(String(input.state))) throw new Error('INVALID_STATE')
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 40) throw new Error('INVALID_STEPS')
  const steps = input.steps.map(step => {
    const text = line(step)
    if (!/^- \[[ x~?>!\-]\] .+/.test(text)) throw new Error('INVALID_STEP')
    return text
  })
  if (input.state === 'done' && steps.some(step => !/^- \[[x\-]\]/.test(step))) throw new Error('UNFINISHED_STEPS')
  return {
    session: line(session), turn: previous?.turn ?? null,
    state: input.state as CodexReport['state'],
    title: line(input.title), project: input.project === undefined ? previous?.project ?? s.codexProject : line(input.project),
    steps, updated: now,
    events: previous?.events ?? [], retiredTurns: previous?.retiredTurns ?? [],
    ...(previous?.activity === undefined ? {} : { activity: previous.activity }),
  }
}

// A board completion is authoritative only for this exact owned task. Lifecycle
// metadata reads it under the existing board lock before reusing its session cache.
// Explicit task reports carry fresh intent and deliberately supersede this projection.
export const boardConfirmedReport = (text: string, previous: CodexReport, owner: string): CodexReport => {
  const lines = text.split(/\r?\n/)
  const spans = scanBlocks(lines).filter(span => span.session === owner.slice(0, 8))
  const span = spans[0]
  if (spans.length !== 1 || span === undefined || !span.isClosed || span.state !== 'done') return previous
  const attrs = parseAttrs(lines[span.start] ?? '')
  if (attrs.owner !== owner || attrs.agent !== (previous.agent ?? 'codex')) return previous
  const at = Date.parse(attrs.updated ?? '')
  if (!Number.isFinite(at) || at < Date.parse(previous.updated)) return previous
  const steps = previous.steps.map(step => step.replace(/^(- \[)[ ~?>!](\] .*)$/, '$1x$2'))
  const expected = [`### ${previous.title}`, ...steps].join('\n')
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
  const block = [marker, `### ${report.title}`, ...report.steps, `<!-- /auto session=${id} -->`].join(eol)
  // Use the board's scanner: Markdown examples are not task ownership, and a
  // missing close must never reach past the next project or another agent's block.
  // Keep raw CR bytes in these lines so offsets preserve even mixed line endings.
  const lines = text.split('\n')
  const found = scanBlocks(lines).filter(span => span.session === id)
  if (found.length > 1) throw new Error('BLOCK_CONFLICT')
  const existing = found[0]
  // Append a section rather than reformat another writer's bytes.
  const append = (text: string): string => `${text}${text && !text.endsWith('\n') ? eol : ''}${eol}## ${report.project}${eol}${block}${eol}`
  let next: string
  if (existing) {
    const attrs = parseAttrs(lines[existing.start] ?? '')
    if (attrs.owner !== owner || attrs.agent !== agent) throw new Error('BLOCK_CONFLICT')
    const last = existing.isClosed ? existing.end : existing.start
    const offset = (index: number): number => lines.slice(0, index).reduce((total, line) => total + line.length + 1, 0)
    const end = offset(last) + (lines[last] ?? '').replace(/\r$/, '').length
    // Only a report that changes the project moves the block (#246). Any other write keeps
    // its place, so a block someone moved, or a heading the parser reads differently, stays.
    const project = isProjectChanged ? parseProgress(text).find(project => project.tasks.some(task => task.auto?.session === id)) : undefined
    // Compare names as the parser reads them: it drops a heading's trailing `#`.
    next = isProjectChanged && project?.name !== (parseProgress(`## ${report.project}`)[0]?.name ?? report.project)
      ? append(text.slice(0, offset(existing.start)) + text.slice(offset(last + 1)))
      : text.slice(0, offset(existing.start)) + block + text.slice(end)
  } else {
    next = append(text)
  }
  const visible = parseProgress(next).flatMap(project => project.tasks).filter(task => task.auto?.session === id && task.auto.agent === agent)
  if (visible.length !== 1) throw new Error('BLOCK_NOT_VISIBLE')
  return next
}

export const dropCodexBlock = (text: string, owner: string): string => {
  if (!/^[a-f0-9]{64}$/.test(owner)) return text
  const lines = text.split('\n')
  const spans = scanBlocks(lines).filter(span => span.session === owner.slice(0, 8))
  const span = spans[0]
  if (spans.length !== 1 || span === undefined) return text
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
  }
  return text.slice(0, offset(first)) + text.slice(offset(last + 1))
}
