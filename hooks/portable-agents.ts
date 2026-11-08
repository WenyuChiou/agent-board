import { STRINGS } from './strings'
import { HOOK_VERSION, HOOK_WORKER_GRACE, hookGuardSource, hookTimeout } from './hook-safety'
import { deepseekReceiverSource } from './receivers/deepseek'

// Native metadata observers. No conversation grant, transcript read or model call is installed by these
// generated plugins; DeepSeek's alone also receives a board message for its session (hooks/receivers/deepseek.ts).
const runner = (node: string, script: string, progress: string, agent: string, home: string): string => `import { spawnSync } from 'node:child_process'
${hookGuardSource(home, agent)}
const report = (mode, payload, deadline, session, cwd) => {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw Error('HOOK_TIMEOUT')
  const result = spawnSync(${JSON.stringify(node)}, [${JSON.stringify(script)}, '--hook-version', '${HOOK_VERSION}', '--hook-deadline', String(deadline), mode, '--agent', '${agent}', '--progress-file', ${JSON.stringify(progress)}, ...(session ? ['--session', session] : [])], {
    input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: remaining + ${HOOK_WORKER_GRACE}, killSignal: 'SIGKILL', ...(cwd ? { cwd } : {}),
  })
  if (result.error?.code === 'ETIMEDOUT') throw Error('HOOK_TIMEOUT')
  // A refused report names the board's reason (INVALID_STEP, say), so the model can correct it.
  const reason = result.error ? undefined : /^AGENT_BOARD_REASON ([A-Z][A-Z0-9_]{2,63})$/m.exec(result.stderr ?? '')?.[1]
  let detail
  if (reason === 'INVALID_STEP') {
    try { detail = JSON.parse(/^AGENT_BOARD_DETAIL (".*")$/m.exec(result.stderr ?? '')?.[1] ?? 'null') } catch {}
  }
  if (result.error || result.status !== 0) throw new Error(reason ? 'AGENT_BOARD_REPORT_FAILED: ' + reason + (typeof detail === 'string' ? ': ' + detail : '') : 'AGENT_BOARD_REPORT_FAILED')
  return result.stdout
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
            const result = report('--codex-report', payload, Date.now() + ${hookTimeout('openclaw') - 1000}, session)
            return { content: [{ type: 'text', text: payload.steps.length > 40 ? result : 'OK' }], details: {} }
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

// DeepSeek's shell sandbox on Windows writes only inside the workspace, so a board command cannot open
// the board page or write progress.md from there. This plugin runs in the dsh process, outside that
// sandbox, and gives the agent one tool, agent_board, for both. The tool is bound to the session the
// host gives it (its id and folder); no hook that receives the prompt, messages or model is registered.
// A board answer for a root session reaches that session directly, with no Copy (#725).
export const deepseekLocalPlugin = (node: string, script: string, progress: string, home: string, board: string, description = STRINGS.en.deepseekBoardTool, stepFormat = STRINGS.en.localAgentStepFormat): string => `${runner(node, script, progress, 'deepseek', home)}
import { spawn } from 'node:child_process'
${deepseekReceiverSource(node, board, progress, home)}
export const name = 'agent-board-local'
const folderOf = agent => {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? { cwd } : {}
}
// The board's own page start, from this process: detached, so the page outlives the call. The one line it
// prints (the page link, or why there is no page) is the tool's answer and is kept nowhere else.
const openBoard = () => new Promise((resolve, reject) => {
  let child, timer, output = '', done = false
  const finish = (error, text) => {
    if (done) return
    done = true
    clearTimeout(timer)
    try { child?.stdout?.destroy() } catch {}
    if (error) reject(error)
    else resolve(text)
  }
  try {
    child = spawn(${JSON.stringify(node)}, [${JSON.stringify(board)}, '--html'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    child.unref()
  } catch { return reject(new Error('AGENT_BOARD_OPEN_FAILED')) }
  timer = setTimeout(() => finish(new Error('AGENT_BOARD_OPEN_FAILED: TIMEOUT')), 20000)
  child.on('error', () => finish(new Error('AGENT_BOARD_OPEN_FAILED')))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { if (output.length < 4096) output += chunk })
  child.on('close', code => {
    const line = output.trim().split(/\\r?\\n/).filter(Boolean).slice(0, 2).join('\\n')
    if (code !== 0 || line === '') finish(new Error('AGENT_BOARD_OPEN_FAILED' + (line === '' ? '' : ': ' + line)))
    else finish(undefined, line)
  })
})
export const apply = ctx => {
  const save = (agent, state) => withHook((_current, deadline) => report('--agent-status', { session_id: agent.session.header.id, state, ...folderOf(agent) }, deadline))
  const receiver = mailboxReceiver()
  ctx.on('agent/created', ({ agent }) => {
    save(agent, agent.status === 'running' ? 'working' : 'waiting')
    receiver.add(agent)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (!['running', 'idle'].includes(status)) return
    save(agent, status === 'running' ? 'working' : 'waiting')
    if (status === 'idle') receiver.idle(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    save(agent, 'ended')
    receiver.remove(agent)
  })
  // Tools are optional: a host without the service still gets the lifecycle events above.
  if (typeof ctx.inject !== 'function') return
  // The shape that defineTool of @deepseek-ai/dsh-tools returns, built by hand: a plugin loaded by file
  // URL cannot import that package.
  ctx.inject(['tools'], c => c.tools.register({
    name: 'agent_board',
    description: ${JSON.stringify(description)},
    parameters: {
      type: 'object', required: ['action'],
      properties: {
        action: { type: 'string', enum: ['report', 'open'], description: 'open: start the board page. report: send the progress of this task.' },
        title: { type: 'string' },
        state: { type: 'string', enum: ['working', 'waiting', 'done', 'ended'] },
        steps: { type: 'array', items: { type: 'string', description: ${JSON.stringify(stepFormat)} } },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 30000,
    execute: async (args, exec) => {
      try {
        if (args?.action === 'open') return { text: await openBoard() }
        if (args?.action !== 'report') throw new Error('AGENT_BOARD_REPORT_FAILED: INVALID_ACTION')
        const header = exec?.agent?.session?.header
        if (typeof header?.id !== 'string' || header.id === '') throw new Error('AGENT_BOARD_REPORT_FAILED: NO_SESSION')
        if (!Array.isArray(args.steps) || args.steps.some(step => typeof step !== 'string')) throw new Error('AGENT_BOARD_REPORT_FAILED: INVALID_STEPS')
        const payload = { steps: args.steps }
        if (typeof args.title === 'string') payload.title = args.title
        if (['working', 'waiting', 'done', 'ended'].includes(args.state)) payload.state = args.state
        const result = report('--codex-report', payload, Date.now() + 20000, header.id)
        return { text: payload.steps.length > 40 ? result : 'OK' }
      } catch (error) {
        hookError(error?.message === 'HOOK_TIMEOUT' ? 'REPORTER_TIMEOUT' : 'REPORTER_FAILED')
        throw error
      }
    },
  }))
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
