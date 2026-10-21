import { boardPromptHelper, boardRequestWords } from './board-commands'
import { STRINGS } from './strings'
import { HOOK_VERSION, HOOK_WORKER_GRACE, hookGuardSource, hookTimeout, hostHookTimeout } from './hook-safety'

const BOARD_PROMPT_HELPER = boardPromptHelper(boardRequestWords(Object.values(STRINGS)))

export type LocalAgent = 'codex' | 'cursor' | 'opencode' | 'gemini' | 'grok' | 'muse' | 'hermes' | 'openclaw' | 'antigravity' | 'deepseek'
export const localAgents: LocalAgent[] = ['codex', 'cursor', 'opencode', 'gemini', 'grok', 'muse', 'hermes', 'openclaw', 'antigravity', 'deepseek']
export const statusEvents: Partial<Record<LocalAgent, Record<string, string>>> = {
  gemini: { SessionStart: 'waiting', BeforeAgent: 'working', AfterAgent: 'waiting', SessionEnd: 'ended' },
  grok: { SessionStart: 'waiting', UserPromptSubmit: 'working', Stop: 'waiting', SessionEnd: 'ended' },
  muse: { UserPromptSubmit: 'working', Stop: 'waiting', SessionEnd: 'ended' },
  antigravity: { SessionStart: 'waiting', PreInvocation: 'working', PostInvocation: 'working', Stop: 'waiting' },
}
export const lifecycleCapability = (agent: LocalAgent): string =>
  agent === 'hermes' ? 'adapter-pending' : 'adapter-installed-unverified'

// Antigravity groups events under a named definition, rather than hooks.<event>.
// Stop ends an execution loop, not the conversation. No session-end event is invented.
export const antigravityHooks = (command: (event: string, state: string) => string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(statusEvents.antigravity!).map(([event, state]) => [event, [{ type: 'command', command: command(event, state), timeout: hostHookTimeout('antigravity', event) }]]))

export const cursorEvents: Record<string, string> = {
  sessionStart: 'SessionStart', beforeSubmitPrompt: 'UserPromptSubmit',
  stop: 'Stop', afterAgentResponse: 'Stop', sessionEnd: 'SessionEnd',
}

// Cursor supplies a stable conversation id and a generation id for each user message.
export const cursorEvent = (input: Record<string, unknown>): Record<string, unknown> => {
  const event = cursorEvents[String(input.hook_event_name)]
  if (!event) throw new Error('INVALID_EVENT')
  return { session_id: input.conversation_id ?? input.session_id, turn_id: input.generation_id, hook_event_name: event }
}

// OpenCode supplies session status but no stable turn id on those status events. Keep
// that limit explicit instead of manufacturing a turn id or fetching conversation text.
export const opencodePlugin = (node: string, script: string, progress: string, description: string, home: string): string => `import { spawnSync } from 'node:child_process'
import { tool } from '@opencode-ai/plugin'
${hookGuardSource(home, 'opencode')}
${BOARD_PROMPT_HELPER}

const run = (mode, payload, session, deadline) => {
  const args = [${JSON.stringify(script)}, '--hook-version', '${HOOK_VERSION}', mode, '--agent', 'opencode', '--progress-file', ${JSON.stringify(progress)}]
  if (session) args.push('--session', session)
  if (deadline !== undefined) args.push('--hook-deadline', String(deadline))
  const remaining = deadline === undefined ? ${hookTimeout('opencode') - 1000} : deadline - Date.now()
  if (remaining <= 0) throw Error('HOOK_TIMEOUT')
  const result = spawnSync(${JSON.stringify(node)}, args, { input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: remaining + ${HOOK_WORKER_GRACE}, killSignal: 'SIGKILL' })
  if (result.error?.code === 'ETIMEDOUT') throw Error('HOOK_TIMEOUT')
  if (result.error || result.status !== 0) throw new Error('AGENT_BOARD_REPORT_FAILED')
  return result.stdout
}

export const AgentBoardLocal = async ({ client }) => ({
  'chat.message': async ({ sessionID }, output) => withHook(async (current, deadline) => {
      const info = current(await client.session.get({ path: { id: sessionID } }))
      if (info.error) throw Error('HOST_METADATA_FAILED')
      if (!info.data || info.data.id !== sessionID || info.data.parentID) return
      run('--agent-status', { session_id: sessionID, state: 'working', prompt_submitted: true, ...(isBoardRequest(output) ? { board_request: true } : {}) }, undefined, deadline)
  }),
  event: async ({ event }) => withHook(async (current, deadline) => {
    const p = event.properties ?? {}
    const session = p.sessionID ?? p.info?.id
    if (!session || !['session.created', 'session.status', 'session.idle', 'session.deleted'].includes(event.type)) return
    if (event.type === 'session.status' && !['busy', 'retry', 'idle'].includes(p.status?.type)) return
    const info = event.type === 'session.deleted' ? { data: p.info } : current(await client.session.get({ path: { id: session } }))
    if (info.error) throw Error('HOST_METADATA_FAILED')
    if (!info.data || info.data.id !== session || info.data.parentID) return
    const state = event.type === 'session.deleted' ? 'ended' : event.type === 'session.status' && p.status?.type !== 'idle' ? 'working' : 'waiting'
    run('--agent-status', { session_id: session, state }, undefined, deadline)
  }),
  tool: {
    agent_board_progress: tool({
      description: ${JSON.stringify(description)},
      args: { title: tool.schema.string(), project: tool.schema.string(), state: tool.schema.enum(['working', 'waiting', 'done', 'ended']), steps: tool.schema.array(tool.schema.string()) },
      execute: async (args, context) => run('--codex-report', args, context.sessionID),
    }),
  },
})
`
