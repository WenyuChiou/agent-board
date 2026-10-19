import { connectCodexProxy } from './codex-proxy.mjs'

const usage = `Usage: node agent-board.mjs --codex-connect [--help]
Read one JSON object from stdin (maximum 16000 UTF-8 bytes):
{"boardUrl":"http://127.0.0.1:PORT/?t=PRIVATE_TOKEN","executable":"/absolute/path/to/codex","thread":"EXACT_THREAD_UUID","turn":"EXACT_ACTIVE_TURN_ID","surface":"Codex CLI","socket":"/optional/absolute/existing/socket"}
boardUrl, thread and turn are required. CODEX_THREAD_ID, when set, must match thread.
Use an absolute executable and optional existing socket, or endpoint: "ws://127.0.0.1:PORT/optional-path".
endpoint needs Node.js 22+ with global WebSocket, forbids credentials/query/hash and cannot be combined with socket; executable is optional.
joinLoaded defaults to true: verify the exact loaded thread, then join its metadata with excludeTurns and require active status. Set false to skip joining.
The loaded check and metadata join are not atomic; an unload race may reload metadata. Every send still requires its expected active turn.
Connects to an existing owner and active turn; attaching creates no server, thread or model turn.
Requires a reachable supported owner transport; this does not establish Codex desktop support.
Stops and unregisters on owner disconnect, turn completion, SIGINT or SIGTERM.`

const codeOf = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message) ? error.message : 'CODEX_CONNECT_FAILED'

// No top-level runner: the installed board can bundle this module safely.
export const runCodexConnect = async args => {
  if (!args.includes('--codex-connect')) return false
  let connection, interrupted = false
  const stop = () => {
    interrupted = true
    if (connection) void connection.close()
    else if (!process.stdin.readableEnded) process.stdin.destroy(new Error('INTERRUPTED'))
  }
  try {
    if (args.some(arg => !['--codex-connect', '--help'].includes(arg)) || new Set(args).size !== args.length) throw new Error('INVALID_CONNECT_ARGUMENTS')
    if (args.includes('--help')) { process.stdout.write(usage + '\n'); return true }
    if (process.stdin.isTTY) throw new Error('CONNECT_INPUT_REQUIRED')
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    const chunks = []
    let length = 0
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.length
      if (length > 16000) throw new Error('INPUT_TOO_LARGE')
      chunks.push(bytes)
    }
    if (interrupted) return true
    let binding
    try { binding = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { throw new Error('INVALID_CONNECT_INPUT') }
    const fields = ['boardUrl', 'executable', 'thread', 'turn', 'surface', 'socket', 'endpoint', 'joinLoaded']
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).some(key => !fields.includes(key))) throw new Error('INVALID_CONNECT_INPUT')
    if (binding.joinLoaded !== undefined && typeof binding.joinLoaded !== 'boolean') throw new Error('INVALID_CONNECT_INPUT')
    if (process.env.CODEX_THREAD_ID && binding.thread !== process.env.CODEX_THREAD_ID) throw new Error('OWN_THREAD_REQUIRED')
    connection = await connectCodexProxy({ ...binding, joinLoaded: binding.joinLoaded ?? true, onError: error => { process.stderr.write(JSON.stringify({ error: codeOf(error) }) + '\n') } })
    if (interrupted) await connection.close()
    else process.stdout.write(JSON.stringify({ status: 'connected', transport: connection.transport, ack: 'not-yet-observed' }) + '\n')
    await connection.closed
    process.stdout.write(JSON.stringify({ status: 'disconnected' }) + '\n')
  } catch (error) {
    if (!interrupted) {
      process.stderr.write(JSON.stringify({ error: codeOf(error) }) + '\n')
      process.exitCode = 1
    }
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await connection?.close()
  }
  return true
}
