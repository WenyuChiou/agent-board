import { STRINGS } from './strings'
import { HOOK_VERSION, HOOK_WORKER_GRACE, hookGuardSource, hookTimeout } from './hook-safety'

// Native metadata observers only. No conversation grant, transcript read, model call
// or receiving connection is installed by these generated plugins.
const runner = (node: string, script: string, progress: string, agent: string, home: string): string => `import { spawnSync } from 'node:child_process'
${hookGuardSource(home, agent)}
const report = (mode, payload, deadline, session) => {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw Error('HOOK_TIMEOUT')
  const result = spawnSync(${JSON.stringify(node)}, [${JSON.stringify(script)}, '--hook-version', '${HOOK_VERSION}', '--hook-deadline', String(deadline), mode, '--agent', '${agent}', '--progress-file', ${JSON.stringify(progress)}, ...(session ? ['--session', session] : [])], {
    input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: remaining + ${HOOK_WORKER_GRACE}, killSignal: 'SIGKILL',
  })
  if (result.error?.code === 'ETIMEDOUT') throw Error('HOOK_TIMEOUT')
  // A refused report names the board's reason (INVALID_STEP, say), so the model can correct it.
  const reason = result.error ? undefined : /^AGENT_BOARD_REASON ([A-Z][A-Z0-9_]{2,63})$/m.exec(result.stderr ?? '')?.[1]
  if (result.error || result.status !== 0) throw new Error(reason ? 'AGENT_BOARD_REPORT_FAILED: ' + reason : 'AGENT_BOARD_REPORT_FAILED')
}
`

// A session's folder is in no hook context that is free of the conversation: it comes from the tool
// factory's context (which names the session's workspace), else the default agent workspace. No hook that
// receives the prompt or messages is registered. A report from the tool is bound to the session id the
// host gives the tool, never to a folder.
export const openclawLocalPlugin = (node: string, script: string, progress: string, home: string, description = STRINGS.en.openclawProgressTool, stepFormat = STRINGS.en.localAgentStepFormat): string => `${runner(node, script, progress, 'openclaw', home)}
export default {
  id: 'agent-board-local',
  register(api) {
    if (typeof api.agent?.events?.registerAgentEventSubscription !== 'function') throw new Error('AGENT_BOARD_HOST_API_UNSUPPORTED')
    const folders = new Map()
    const remember = (id, dir) => {
      if (typeof id !== 'string' || typeof dir !== 'string' || dir === '') return
      folders.delete(id)
      folders.set(id, dir)
      if (folders.size > 64) folders.delete(folders.keys().next().value)
    }
    const where = id => {
      let dir = folders.get(id)
      if (dir === undefined) { try { dir = api.runtime?.agent?.resolveAgentWorkspaceDir?.(api.config) } catch {} }
      return typeof dir === 'string' && dir !== '' ? { cwd: dir } : {}
    }
    api.on('session_start', event => withHook((_current, deadline) => {
      report('--codex-event', { session_id: event.sessionId, hook_event_name: 'SessionStart', ...where(event.sessionId) }, deadline)
    }))
    api.on('session_end', event => withHook((_current, deadline) => {
      if (['compaction', 'restart'].includes(event.reason)) return
      report('--codex-event', { session_id: event.sessionId, hook_event_name: 'SessionEnd', ...where(event.sessionId) }, deadline)
    }))
    // The plan mirror (#922): the agent's own plan, as a failed call or a call without a plan has none.
    // Only each step's text and status are sent, in the shape of Codex's update_plan.
    api.on('after_tool_call', (event, ctx) => withHook((_current, deadline) => {
      if (event?.error || event?.toolName !== 'update_plan') return
      const plan = event.params?.plan
      if (!ctx?.sessionId || !Array.isArray(plan) || plan.length === 0) return
      report('--plan-event', { session_id: ctx.sessionId, tool_name: 'update_plan', tool_input: { plan: plan.slice(0, 200).map(item => ({ step: item?.step, status: item?.status })) } }, deadline)
    }))
    // OpenClaw has no progress tool of its own: this one reports through the board's report writer,
    // bound to the session id the host gives the tool.
    if (typeof api.registerTool === 'function') api.registerTool(ctx => {
      const session = ctx?.sessionId
      if (typeof session !== 'string' || session === '') return null
      remember(session, ctx.workspaceDir)
      return {
        name: 'progress_card',
        label: 'Progress card',
        description: ${JSON.stringify(description)},
        parameters: {
          type: 'object', additionalProperties: false, required: ['steps'],
          properties: {
            title: { type: 'string' },
            state: { type: 'string', enum: ['working', 'waiting', 'done', 'ended'] },
            steps: { type: 'array', items: { type: 'string', description: ${JSON.stringify(stepFormat)} } },
          },
        },
        execute: async (_id, params) => {
          try {
            if (!Array.isArray(params?.steps) || params.steps.some(step => typeof step !== 'string')) throw new Error('AGENT_BOARD_REPORT_FAILED: INVALID_STEPS')
            const payload = { steps: params.steps }
            if (typeof params.title === 'string') payload.title = params.title
            if (['working', 'waiting', 'done', 'ended'].includes(params.state)) payload.state = params.state
            report('--codex-report', payload, Date.now() + ${hookTimeout('openclaw') - 1000}, session)
            return { content: [{ type: 'text', text: 'OK' }], details: {} }
          } catch (error) {
            hookError(error?.message === 'HOOK_TIMEOUT' ? 'REPORTER_TIMEOUT' : 'REPORTER_FAILED')
            throw error
          }
        },
      }
    }, { names: ['progress_card'] })
    api.agent.events.registerAgentEventSubscription({
      id: 'agent-board-local-status', streams: ['lifecycle'], phases: ['start', 'end', 'error'], payload: 'metadata',
      handle: event => withHook((_current, deadline) => {
        if (event.stream !== 'lifecycle' || !event.sessionId || !event.runId) return
        const phase = event.data?.phase
        if (!['start', 'end', 'error'].includes(phase)) return
        report('--codex-event', { session_id: event.sessionId, turn_id: event.runId, hook_event_name: phase === 'start' ? 'UserPromptSubmit' : 'Stop', prompt_submitted: false, ...where(event.sessionId) }, deadline)
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
  if (old !== null && (!old.startsWith(start) || !old.endsWith(end) || text.includes('agent-board-local') && text.split(old).length !== 2)) return { text, conflict: true }
  const stripped = old === null ? text : text.replace(old, '')
  if (stripped.includes('agent-board-local')) return { text, conflict: true }
  const empty = stripped.trim() === '[]'
  if (!empty && stripped.split(/\r?\n/).some(line => /\S/.test(line) && !/^\s|^#|^- /.test(line))) return { text, conflict: true }
  if (remove) return { text: stripped, conflict: false }
  if (old !== null && text.includes(old)) return { text: text.replace(old, group), group, conflict: false }
  return { text: `${empty ? '' : stripped}${stripped && !stripped.endsWith('\n') && !empty ? '\n' : ''}${group}`, group, conflict: false }
}
