// Frozen pre-safety generated templates: exact ownership checks only, never installed.
// Keep both prompt variants and board-request flags without adopting edited files.
import type { ConnectContext } from './connect-pure'
import { boardPromptHelper, boardRequestWords } from './board-commands'
import { STRINGS } from './strings'

const BOARD_PROMPT_HELPER = boardPromptHelper(boardRequestWords(Object.values(STRINGS)))
const OPENCLAW_ID = 'agent-board'

export const legacyOpenCodePlugin = (ctx: ConnectContext, withPrompt = true, flagsBoardRequests = true): string => `// Written by the Agent Board plugin (/progress connect): reports each finished turn to the Agent Board
// pane.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

${withPrompt && flagsBoardRequests ? BOARD_PROMPT_HELPER + '\n' : ''}const INBOX = ${JSON.stringify(ctx.inbox)}

const save = (event, payload) => {
  try {
    mkdirSync(INBOX, { recursive: true })
    const name = \`opencode-\${event}-\${Date.now()}-\${process.pid}\`
    writeFileSync(join(INBOX, name + '.tmp'), JSON.stringify(payload))
    renameSync(join(INBOX, name + '.tmp'), join(INBOX, name + '.json'))
  } catch {}
}

const textOf = message =>
  (message?.parts ?? [])
    .filter(part => part.type === 'text' && !part.synthetic && !part.ignored)
    .map(part => part.text)
    .join('\\n')

export const AgentBoard = async ({ client, directory }) => ({
${withPrompt ? `  'chat.message': async ({ sessionID }${flagsBoardRequests ? ', output' : ''}) => {
    try {
      const session = await client.session.get({ path: { id: sessionID } })
      if (!session.data || session.data.id !== sessionID || session.data.parentID) return
      save('prompt', { session_id: sessionID, cwd: directory${flagsBoardRequests ? ', ...(isBoardRequest(output) ? { board_request: true } : {})' : ''} })
    } catch {}
  },
` : ''}\
  event: async ({ event }) => {
    try {
      if (event.type === 'session.idle') {
        const id = event.properties.sessionID
        const session = await client.session.get({ path: { id } })
        if (session.data?.parentID) return
        const listed = await client.session.messages({ path: { id } })
        const messages = listed.data ?? []
        const last = role => [...messages].reverse().find(message => message.info?.role === role)
        save('turn', { session_id: id, cwd: directory, prompt: textOf(last('user')), last_assistant_message: textOf(last('assistant')) })
      } else if (event.type === 'session.deleted') {
        const id = event.properties.info?.id
        if (id) save('end', { session_id: id, cwd: directory })
      }
    } catch {}
  },
})
`


export const legacyOpenClawPlugin = (ctx: ConnectContext, withPrompt = true, flagsBoardRequests = true): string => `// Written by the Agent Board plugin (/progress connect): reports each finished turn to the Agent Board
// pane.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

${withPrompt && flagsBoardRequests ? BOARD_PROMPT_HELPER + '\n' : ''}const INBOX = ${JSON.stringify(ctx.inbox)}

const save = (event, payload) => {
  try {
    mkdirSync(INBOX, { recursive: true })
    const name = \`openclaw-\${event}-\${Date.now()}-\${process.pid}\`
    writeFileSync(join(INBOX, name + '.tmp'), JSON.stringify(payload))
    renameSync(join(INBOX, name + '.tmp'), join(INBOX, name + '.json'))
  } catch {}
}

const textOf = message =>
  typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.filter(part => part?.type === 'text').map(part => part.text).join('\\n')
      : ''

export default {
  id: '${OPENCLAW_ID}',
  name: 'Agent Board',
  register(api) {
${withPrompt ? `    api.on('before_prompt_build', (_event, ctx) => {
      try {
        if (!ctx?.sessionId || ctx.inputProvenance?.kind !== 'external_user') return
        save('prompt', { session_id: ctx.sessionId, cwd: ctx.workspaceDir ?? ''${flagsBoardRequests ? ', ...(isBoardRequest(_event) ? { board_request: true } : {})' : ''} })
      } catch {}
    })
` : ''}\
    api.on('agent_end', (event, ctx) => {
      try {
        if (!ctx?.sessionId || ctx.trigger === 'heartbeat' || ctx.trigger === 'memory') return
        const messages = Array.isArray(event?.messages) ? event.messages : []
        const last = role => [...messages].reverse().find(message => message?.role === role)
        const answer = textOf(last('assistant'))
        if (answer.trim() === '') return
        save('turn', { session_id: ctx.sessionId, cwd: ctx.workspaceDir ?? '', prompt: textOf(last('user')), last_assistant_message: answer })
      } catch {}
    })
    api.on('session_end', (event, ctx) => {
      try {
        if (event?.reason === 'compaction' || event?.reason === 'restart') return
        const id = ctx?.sessionId ?? event?.sessionId
        if (id) save('end', { session_id: id, cwd: ctx?.workspaceDir ?? '' })
      } catch {}
    })
  },
}
`
