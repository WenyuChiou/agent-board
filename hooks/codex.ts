import type { Strings } from './i18n'
import type { LocalAgent } from './local-agents'
import { RESUME } from './parse'

export type CodexReport = {
  session: string
  turn: string | null
  state: 'working' | 'waiting' | 'done' | 'ended'
  title: string
  project: string
  steps: string[]
  updated: string
  events?: string[]
  retiredTurns?: string[]
  agent?: LocalAgent
}

export const codexEvents = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd'] as const

const line = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('INVALID_TEXT')
  const clean = value.replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean || clean.length > 500) throw new Error('INVALID_TEXT')
  return clean
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
  if (turn && previous?.events?.includes(key)) return previous
  if (previous?.turn && turn && previous.turn !== turn && event !== 'UserPromptSubmit') throw new Error('STALE_TURN')
  const working = event === 'UserPromptSubmit'
  const state = event === 'SessionStart' ? previous?.state === 'ended' ? 'waiting' : previous?.state ?? 'waiting' : event === 'SessionEnd' ? 'ended' : working ? 'working' : previous?.state === 'done' ? 'done' : 'waiting'
  return {
    session, turn: turn ?? previous?.turn ?? null, state,
    title: previous?.title ?? s.codexTask,
    project: previous?.project ?? s.codexProject,
    steps: previous?.steps ?? [`- [>] ${s.codexLifecycle}`],
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
  }
}

// The full digest prevents an eight-character collision or a pasted block from acquiring ownership.
export const putCodexBlock = (text: string, report: CodexReport, owner: string): string => {
  if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error('INVALID_OWNER')
  const id = owner.slice(0, 8)
  const agent = report.agent ?? 'codex'
  // The block id is a hash prefix; only the host's full id can match a live receiver.
  const resume = RESUME.test(report.session) ? ` resume=${report.session}` : ''
  const marker = `<!-- auto session=${id} agent=${agent} source=${agent}-local owner=${owner} state=${report.state} updated=${report.updated}${resume} -->`
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const block = [marker, `### ${report.title}`, ...report.steps, `<!-- /auto session=${id} -->`].join(eol)
  const start = new RegExp(`^<!-- auto [^\\r\\n]*\\bsession=${id}(?: | -->)[^\\r\\n]*`, 'gm')
  const found = [...text.matchAll(start)]
  if (found.length > 1) throw new Error('BLOCK_CONFLICT')
  const existing = found[0]
  if (existing) {
    if (!existing[0].includes(` owner=${owner} `) || !existing[0].includes(` agent=${agent} `)) throw new Error('BLOCK_CONFLICT')
    const end = new RegExp(`^<!-- /auto session=${id} -->`, 'm').exec(text.slice(existing.index))
    if (!end) throw new Error('BLOCK_CONFLICT')
    return text.slice(0, existing.index) + block + text.slice(existing.index + end.index + end[0].length)
  }
  // Append a section rather than reformat another writer's bytes.
  return `${text}${text && !text.endsWith('\n') ? eol : ''}${eol}## ${report.project}${eol}${block}${eol}`
}
