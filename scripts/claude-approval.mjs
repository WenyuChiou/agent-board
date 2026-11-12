// Claude Code's PermissionRequest hook for approvals on the board (D3, #1318). Claude Code runs it
// when it is about to ask the person to allow a tool call. It asks the local board page, which
// holds the request open only while a page the board opened is in front of the person and has
// drawn it, at most 30 seconds. A press there comes back as Allow once or Deny; anything else
// (no page, no press, no board, an error) prints nothing, and Claude Code shows its own prompt.
// It does not use an address folder inside the session's working folder, and it does not ask the board
// about a request to run without the sandbox. It never answers in a mode where Claude Code would not
// ask, and it never sends updatedPermissions, updatedInput or interrupt: nothing standing is ever added.
// Plain Node with no imports outside node:, as the plugin's hooks.json runs it directly. The
// address rules are hooks/receiver.ts's (addressKey, addressFolder, addressFileName, parseAddress);
// tests/approvals.test.mjs keeps the two in step.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// A board that will wait for a press sends its headers at once: one that has not within this
// long is hung (suspended, or a stale address whose port another program took), and the host asks.
const HEADERS_MS = 2_000
// The board answers within 30 s of the request; the rest is room for the trip.
const ASK_MS = 35_000
const INPUT_MS = 5_000
const INPUT_MAX = 1024 * 1024
// The board takes a request of up to 64 KB; a tool input past this many bytes is sent with its long
// strings cut, and marked cut, so the board shows it with no button.
const SEND_MAX = 48_000
const CUT_AT = 2_000

// Claude Code asks nobody in these modes, so there is nothing to stand in for.
const QUIET_MODES = new Set(['bypassPermissions', 'dontAsk'])

// Where register.tsx's findProgressPath looks: CLAUDE_PROGRESS_FILE, else progress.md in
// CLAUDE_CONFIG_DIR, else ~/.claude/progress.md.
export const progressPath = env => {
  if (env.CLAUDE_PROGRESS_FILE) return env.CLAUDE_PROGRESS_FILE
  const config = (env.CLAUDE_CONFIG_DIR ?? '').replace(/[\\/]+$/, '')
  if (config !== '') return [config, 'progress.md'].join(config.includes('\\') ? '\\' : '/')
  const home = (env.USERPROFILE ?? env.HOME ?? homedir()).replace(/[\\/]+$/, '')
  return [home, '.claude', 'progress.md'].join(home.includes('\\') ? '\\' : '/')
}

// hooks/receiver.ts addressKey: one board however its path is spelled.
export const addressKey = path => {
  const isWin = /^[A-Za-z]:[\\/]/.test(path)
  if (!isWin && !path.startsWith('/')) return null
  const parts = []
  for (const part of (isWin ? path.slice(2) : path).split(isWin ? /[\\/]+/ : /\/+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return isWin ? `${path.slice(0, 2)}\\${parts.join('\\')}` : `/${parts.join('/')}`
}

export const addressFileName = key => `agent-board-${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}.json`

// hooks/receiver.ts addressFolder: on Windows only the account's own cache folder is trusted.
export const addressFolder = (isWindows, home, runtime, isRuntimeOwn) => {
  if (home === '') return null
  const sep = isWindows ? '\\' : '/'
  const cache = [home.replace(/[\\/]+$/, ''), '.cache', 'agent-board'].join(sep)
  if (runtime === undefined || runtime === '') return cache
  if (isWindows) return null
  return isRuntimeOwn ? runtime : cache
}

// POSIX only: a folder only this account can reach, and in it, when named, a plain file of its own.
const isOwn = (folder, file) => {
  try {
    const dir = statSync(folder)
    const uid = process.getuid()
    if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o077) !== 0) return false
    if (file === undefined) return true
    const own = lstatSync(file)
    return own.isFile() && own.uid === uid
  } catch {
    return false
  }
}

export const parseAddress = (text, key) => {
  try {
    const found = JSON.parse(text)
    if (found === null || typeof found !== 'object' || typeof found.url !== 'string' || typeof found.path !== 'string') return null
    if (addressKey(found.path) !== key) return null
    const parts = /^(http:\/\/127\.0\.0\.1:\d+)\/?\?(?:[^#]*&)?t=([^&#]+)/.exec(found.url)
    return parts === null ? null : { origin: parts[1], token: decodeURIComponent(parts[2]) }
  } catch {
    return null
  }
}

export const addressFile = (env = process.env, platform = process.platform) => {
  const key = addressKey(progressPath(env))
  if (key === null) return null
  const isWindows = platform === 'win32'
  const home = (env.USERPROFILE ?? env.HOME ?? '').replace(/[\\/]+$/, '')
  const runtime = env.XDG_RUNTIME_DIR
  const isRuntimeOwn = !isWindows && runtime !== undefined && runtime !== '' && isOwn(runtime)
  const folder = addressFolder(isWindows, home, runtime, isRuntimeOwn)
  if (folder === null) return null
  return { key, folder, home, file: [folder, addressFileName(key)].join(isWindows ? '\\' : '/') }
}

// The board's process is still running: a board that stopped without removing its file leaves an
// address another program may now hold.
export const isRunning = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // Gone, or running under another account: neither is this person's board.
    return false
  }
}

// A path as the disk spells it (links followed), lower-cased on Windows, where case does not count.
const realOf = (path, platform) => {
  const real = realpathSync.native(path)
  return platform === 'win32' ? real.toLowerCase() : real
}

// The path is the folder or somewhere under it.
export const isInside = (path, folder, platform = process.platform) => {
  const sep = platform === 'win32' ? '\\' : '/'
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep)
}

// The session works in the home folder itself, the default folder of a new terminal.
const isHome = (where, home, platform) => {
  try { return typeof home === 'string' && home !== '' && where === realOf(home, platform) } catch { return false }
}

// An address folder inside the folder the session works in is one the agent can write: it could name
// a listener of its own there and answer its own prompts. A session that says nothing of its folder is
// not checked (Claude Code always sends it); one that names it badly is refused. The home folder itself
// is excepted (owner, 2026-11-12): every address folder is under it, so the check would turn the board's
// approvals off for any session started there, and SECURITY.md names what that leaves open.
const isInsideSession = (found, cwd, platform) => {
  if (cwd === undefined) return false
  if (typeof cwd !== 'string' || cwd === '') return true
  let where
  try { where = realOf(cwd, platform) } catch { where = platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd) }
  if (isHome(where, found.home, platform)) return false
  return isInside(realOf(found.folder, platform), where, platform) || isInside(realOf(found.file, platform), where, platform)
}

const readAddress = (env, platform, cwd) => {
  const found = addressFile(env, platform)
  if (found === null) return null
  try {
    if (lstatSync(found.file).isSymbolicLink()) return null
    if (isInsideSession(found, cwd, platform)) return null
    if (platform !== 'win32' && !isOwn(found.folder, found.file)) return null
    const text = readFileSync(found.file, 'utf8')
    if (!isRunning(JSON.parse(text)?.pid)) return null
    return parseAddress(text, found.key)
  } catch {
    return null
  }
}

// Bash's request to run outside the sandbox: Claude Code's own prompt decides it, never the board.
// Any value but absent or false counts, so a string such as "true" is not a way past.
export const isSandboxOff = input => {
  const flag = input.tool_input?.dangerouslyDisableSandbox
  return flag !== undefined && flag !== null && flag !== false
}

const bytesOf = value => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')

// What the board is told: the request as Claude Code gave it, with a very long input cut and
// marked cut. A cut request is never pressed on the board: the person would approve words they
// did not see, such as a command padded far past what the page shows.
export const askBody = input => {
  const toolInput = input.tool_input ?? null
  let sent = toolInput
  let isCut = false
  try {
    if (bytesOf(toolInput) > SEND_MAX) {
      isCut = true
      sent = toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
        ? Object.fromEntries(Object.entries(toolInput).map(([name, value]) => [name, typeof value === 'string' && value.length > CUT_AT ? `${value.slice(0, CUT_AT)}…` : value]))
        : null
      if (bytesOf(sent) > SEND_MAX) sent = null
    }
  } catch {
    sent = null
    isCut = true
  }
  return {
    agent: 'claude',
    session: typeof input.session_id === 'string' ? input.session_id : '',
    // Claude Code's prompt id is the turn; a request without one is shown with no button.
    turn: typeof input.prompt_id === 'string' ? input.prompt_id : '',
    tool: typeof input.tool_name === 'string' ? input.tool_name : '',
    input: sent,
    // A sub-agent's request carries its parent's session id, so it shows on the parent's row.
    isSubagent: typeof input.agent_id === 'string' && input.agent_id !== '',
    mode: typeof input.permission_mode === 'string' ? input.permission_mode : '',
    isCut,
  }
}

// The only two answers there are. A deny carries the person's words, or the board's own line.
export const decisionOutput = decision => {
  if (decision === null || typeof decision !== 'object') return null
  if (decision.behavior === 'allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
  if (decision.behavior === 'deny' && typeof decision.message === 'string' && decision.message !== '') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: decision.message.slice(0, 4000) } } }
  }
  return null
}

const readInput = () => new Promise(done => {
  const chunks = []
  let size = 0
  const timer = setTimeout(() => done(null), INPUT_MS)
  process.stdin.on('data', chunk => {
    size += chunk.length
    if (size > INPUT_MAX) { clearTimeout(timer); done(null); return }
    chunks.push(chunk)
  })
  process.stdin.on('end', () => {
    clearTimeout(timer)
    try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { done(null) }
  })
  process.stdin.on('error', () => { clearTimeout(timer); done(null) })
})

export const run = async (env = process.env, platform = process.platform) => {
  const input = await readInput()
  if (input === null || typeof input !== 'object' || QUIET_MODES.has(input.permission_mode)) return null
  // Not sent to the board at all: it could only allow or deny, and the board allowing is the thing refused.
  if (isSandboxOff(input)) return null
  const address = readAddress(env, platform, input.cwd)
  if (address === null) return null
  const stop = new AbortController()
  let timer = setTimeout(() => stop.abort(), HEADERS_MS)
  try {
    const answer = await fetch(`${address.origin}/api/approvals/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-token': address.token },
      body: JSON.stringify(askBody(input)),
      signal: stop.signal,
    })
    // The headers came: the board is alive, and the press may take up to 30 s.
    clearTimeout(timer)
    timer = setTimeout(() => stop.abort(), ASK_MS)
    if (!answer.ok) return null
    const body = await answer.json()
    return decisionOutput(body?.decision ?? null)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The answer is written out in full before the process ends; a hook that fails says nothing.
  run().then(output => new Promise(done => {
    if (output === null) done()
    else process.stdout.write(JSON.stringify(output), () => done())
  }), () => undefined).finally(() => process.exit(0))
}
