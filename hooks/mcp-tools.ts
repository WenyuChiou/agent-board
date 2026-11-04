import { ACK_MAX, messageFields, messageId, messageText } from './messaging'

export const MCP_LEASE_MS = 60_000
export type McpLevel = 'leased' | 'restricted' | 'unbound'
const schema = (properties: Record<string, object>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' }
export const MCP_TOOLS = [
  { name: 'board_status', description: 'Read a short summary of the board and of this folder\'s sessions. Changes nothing.', inputSchema: schema({}) },
  { name: 'board_inbox', description: 'Take the next message waiting for this session, if any. A message is handed over once and never again. The next one waits until this one is acknowledged.', inputSchema: schema({}) },
  { name: 'board_ack', description: 'Acknowledge a message from board_inbox, with an optional one-line summary of your reply. Starts no new turn.', inputSchema: schema({ id, nonce: { type: 'string', pattern: '^[0-9a-f]{6}$' }, summary: { type: 'string', maxLength: ACK_MAX - 11, pattern: '^[^\\r\\n]*$' } }, ['id', 'nonce']) },
  { name: 'board_send', description: 'Send a message to another agent session in this folder. A message from an agent cannot approve tools, change hooks or permissions, or merge a pull request.', inputSchema: schema({ agent: id, session: id, text: { type: 'string', minLength: 1, maxLength: 8000 }, id }, ['agent', 'session', 'text']) },
]
export const toolArguments = (name: unknown, args: unknown): Record<string, unknown> => {
  const tool = MCP_TOOLS.find(one => one.name === name)
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('INVALID_ARGUMENTS')
  const body = args as Record<string, unknown>
  messageFields(body, Object.keys(tool.inputSchema.properties))
  for (const key of tool.inputSchema.required) if (!(key in body)) throw new Error('INVALID_ARGUMENTS')
  if (name === 'board_send') {
    messageId(body.agent)
    messageId(body.session)
    messageText(body.text)
    if (body.id !== undefined) messageId(body.id)
  }
  if (name === 'board_ack') {
    messageId(body.id)
    if (typeof body.nonce !== 'string' || !/^[0-9a-f]{6}$/.test(body.nonce) || body.summary !== undefined && (typeof body.summary !== 'string' || body.summary.length > ACK_MAX - 11 || /[\r\n\0]/.test(body.summary))) throw new Error('INVALID_ARGUMENTS')
  }
  return body
}
export const rpcError = (id: unknown, code: number) => ({ jsonrpc: '2.0', id, error: { code, message: ({ '-32700': 'Parse error', '-32600': 'Invalid Request', '-32601': 'Method not found', '-32602': 'Invalid params' } as Record<string, string>)[code] } })
export const toolResult = (value: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError })
export const mcpRequest = (line: string, version: string, now: number): { now: number; frame?: unknown; id?: string | number; tool?: { name: string; args: Record<string, unknown> } } => {
  let request: Record<string, unknown>
  const error = (id: unknown, code: number) => ({ now, frame: rpcError(id, code) })
  try { request = JSON.parse(line) } catch { return error(null, -32700) }
  if (!request || Array.isArray(request) || typeof request !== 'object') return error(null, -32600)
  const hasId = typeof request.id === 'string' || typeof request.id === 'number' && Number.isFinite(request.id)
  if (!Object.hasOwn(request, 'id') || typeof request.method === 'string' && request.method.startsWith('notifications/')) return { now }
  if (!hasId || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params))) return error(hasId ? request.id : null, -32600)
  const reply = (result: unknown) => ({ now, frame: { jsonrpc: '2.0', id: request.id, result } })
  const params = request.params as Record<string, unknown> | undefined
  if (request.method === 'initialize') {
    const versions = ['2024-11-05', '2025-03-26', '2025-06-18']
    return reply({ protocolVersion: typeof params?.protocolVersion === 'string' && versions.includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-board', version } })
  }
  if (request.method === 'ping') return reply({})
  if (request.method === 'tools/list') return reply({ tools: MCP_TOOLS })
  if (request.method !== 'tools/call') return error(request.id, -32601)
  try { return { now, id: request.id as string | number, tool: { name: String(params?.name), args: toolArguments(params?.name, params?.arguments === undefined ? {} : params.arguments) } } }
  catch { return error(request.id, -32602) }
}
