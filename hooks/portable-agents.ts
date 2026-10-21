import { HOOK_VERSION, HOOK_WORKER_GRACE, hookGuardSource } from './hook-safety'

// Native metadata observers only. No conversation grant, transcript read, model call
// or receiving connection is installed by these generated plugins.
const runner = (node: string, script: string, progress: string, agent: string, home: string): string => `import { spawnSync } from 'node:child_process'
${hookGuardSource(home, agent)}
const report = (mode, payload, deadline) => {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw Error('HOOK_TIMEOUT')
  const result = spawnSync(${JSON.stringify(node)}, [${JSON.stringify(script)}, '--hook-version', '${HOOK_VERSION}', '--hook-deadline', String(deadline), mode, '--agent', '${agent}', '--progress-file', ${JSON.stringify(progress)}], {
    input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: remaining + ${HOOK_WORKER_GRACE}, killSignal: 'SIGKILL',
  })
  if (result.error?.code === 'ETIMEDOUT') throw Error('HOOK_TIMEOUT')
  if (result.error || result.status !== 0) throw new Error('AGENT_BOARD_REPORT_FAILED')
}
`

export const openclawLocalPlugin = (node: string, script: string, progress: string, home: string): string => `${runner(node, script, progress, 'openclaw', home)}
export default {
  id: 'agent-board-local',
  register(api) {
    if (typeof api.agent?.events?.registerAgentEventSubscription !== 'function') throw new Error('AGENT_BOARD_HOST_API_UNSUPPORTED')
    api.on('session_start', event => withHook((_current, deadline) => report('--codex-event', { session_id: event.sessionId, hook_event_name: 'SessionStart' }, deadline)))
    api.on('session_end', event => withHook((_current, deadline) => {
      if (['compaction', 'restart'].includes(event.reason)) return
      report('--codex-event', { session_id: event.sessionId, hook_event_name: 'SessionEnd' }, deadline)
    }))
    api.agent.events.registerAgentEventSubscription({
      id: 'agent-board-local-status', streams: ['lifecycle'], phases: ['start', 'end', 'error'], payload: 'metadata',
      handle: event => withHook((_current, deadline) => {
        if (event.stream !== 'lifecycle' || !event.sessionId || !event.runId) return
        const phase = event.data?.phase
        if (!['start', 'end', 'error'].includes(phase)) return
        report('--codex-event', { session_id: event.sessionId, turn_id: event.runId, hook_event_name: phase === 'start' ? 'UserPromptSubmit' : 'Stop', prompt_submitted: false }, deadline)
      }),
    })
  },
}
`

export const deepseekLocalPlugin = (node: string, script: string, progress: string, home: string): string => `${runner(node, script, progress, 'deepseek', home)}
export const name = 'agent-board-local'
export const apply = ctx => {
  const save = (agent, state) => withHook((_current, deadline) => report('--agent-status', { session_id: agent.session.header.id, state }, deadline))
  ctx.on('agent/created', ({ agent }) => { save(agent, agent.status === 'running' ? 'working' : 'waiting') })
  ctx.on('agent/status', ({ agent, status }) => {
    if (!['running', 'idle'].includes(status)) return
    save(agent, status === 'running' ? 'working' : 'waiting')
  })
  ctx.on('agent/disposed', ({ agent }) => { save(agent, 'ended') })
}
`

// Append only to a plain root YAML sequence. Complex documents are surfaced for
// review rather than parsed or rewritten with an incomplete YAML implementation.
export const deepseekPatch = (text: string, owned: unknown, plugin: string, remove: boolean): { text: string; group?: string; conflict: boolean } => {
  const start = '# agent-board-local:start\n'
  const end = '# agent-board-local:end\n'
  const group = `${start}- insert:\n    - id: agent-board-local\n      name: ${JSON.stringify(plugin)}\n${end}`
  const old = typeof owned === 'string' ? owned : null
  if (old !== null && (text.split(old).length !== 2 || !old.startsWith(start) || !old.endsWith(end))) return { text, conflict: true }
  const stripped = old === null ? text : text.replace(old, '')
  if (stripped.includes('agent-board-local')) return { text, conflict: true }
  const empty = stripped.trim() === '[]'
  if (!empty && stripped.split(/\r?\n/).some(line => /\S/.test(line) && !/^\s|^#|^- /.test(line))) return { text, conflict: true }
  if (remove) return { text: stripped, conflict: false }
  if (old !== null) return { text: text.replace(old, group), group, conflict: false }
  return { text: `${empty ? '' : stripped}${stripped && !stripped.endsWith('\n') && !empty ? '\n' : ''}${group}`, group, conflict: false }
}
