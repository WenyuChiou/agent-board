// The board's page for `agent-board.mjs --serve`: a server on 127.0.0.1 with a random token in
// its address, and the agents' commands a reply from the page starts. What the page shows and
// what a press does are worked out in hooks/serve.ts; the writes are the terminal board's own
// (board-cli.ts passes them in), so the page changes progress.md the way the pane does.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { boardItems } from '../hooks/board'
import type { BoardAction, PendingTurn } from '../hooks/board'
import type { Strings } from '../hooks/i18n'
import { pagePolicy, requestProblem, sendKey, sendPlan, serveAction, serveModel, servePage } from '../hooks/serve'
import type { SendPlan } from '../hooks/serve'
import type { AgentTarget, View } from '../hooks/view'

export type ServeOptions = {
  s: Strings
  port: number
  // What the server answers a second `--serve` with, so it can tell it is the same board.
  ping: Record<string, unknown>
  view: () => View
  pending: () => PendingTurn[]
  // A tick or an archive, written the way the terminal board writes one: the line to show.
  act: (action: BoardAction) => string
  // Every finished task to the archive now: the line to show.
  tidy: () => string
  paste: (text: string) => { isAdded: boolean; note: string }
  // False when the server cannot be found again (its address file could not be written): it
  // stops then, rather than run on where no one can reach it.
  onReady: (url: string, port: number) => boolean
  onStop: () => void
  idleMs: number
}

type Result = { ok: boolean; note: string }

const MAX_BODY = 64 * 1024
const MAX_WAIT = 10 * 60 * 1000
// After a reply that took too long is killed, how long to wait for it to be gone.
const KILL_WAIT = 15 * 1000

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

// A JSON object of at most 64 KB, or null.
const readBody = (req: IncomingMessage): Promise<Record<string, unknown> | null> =>
  new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const isWindows = process.platform === 'win32'

// A program by its full path, from PATH's absolute folders only. Windows looks in the current
// folder first, and a reply runs in the session's folder, which can be a cloned repository
// with a codex.bat or a grok.exe of its own.
const onPath = (name: string, exts: readonly string[]): string | null => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue
    for (const ext of exts) {
      const file = join(dir, `${name}${ext}`)
      if (isFile(file)) return file
    }
  }

  return null
}

type Program = { command: string; args: string[]; isShell: boolean }

// AGENT_BOARD_GROK or AGENT_BOARD_CODEX names a program to run in the agent's place (the tests'
// stand-in); a .js or .mjs one runs on this Node.
const programOf = (plan: SendPlan): Program | null => {
  const stand = process.env[`AGENT_BOARD_${plan.agent.toUpperCase()}`]
  if (stand) return /\.m?js$/i.test(stand) ? { command: process.execPath, args: [stand, ...plan.args], isShell: false } : { command: stand, args: plan.args, isShell: false }
  if (plan.agent === 'grok') {
    // Grok Build installs itself in ~/.grok/bin, which is not always on PATH.
    const own = join(homedir(), '.grok', 'bin', isWindows ? 'grok.exe' : 'grok')
    const found = existsSync(own) ? own : onPath('grok', isWindows ? ['.exe', '.com'] : [''])
    return found === null ? null : { command: found, args: plan.args, isShell: false }
  }
  const found = onPath(plan.command, isWindows ? ['.exe', '.cmd', '.bat', '.com'] : [''])
  if (found === null) return null
  // A .cmd runs only through the shell. Its arguments are all constants or a checked id
  // (sendPlan), and the program's own path is quoted.
  return /\.(cmd|bat)$/i.test(found) ? { command: `"${found}" ${plan.args.join(' ')}`, args: [], isShell: true } : { command: found, args: plan.args, isShell: false }
}

// The whole tree: on Windows, killing a shell leaves the agent it started running; elsewhere the
// agent leads a process group of its own (detached), and the group goes with it.
const killTree = (child: ChildProcess): void => {
  if (!isWindows && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {}
  }
  if (isWindows && child.pid !== undefined) {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    try {
      spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
      return
    } catch {}
  }
  child.kill()
}

// Runs the agent with the reply and waits for its answer, at most 10 minutes. `label` names the
// agent and the task in what the page says, since two sessions can be answered at once.
const run = (plan: SendPlan, s: Strings, label: string): Promise<Result> =>
  new Promise(resolve => {
    const program = programOf(plan)
    if (program === null) {
      resolve({ ok: false, note: s.serveSendFailed(label, s.serveSendMissing(plan.agent)) })
      return
    }
    let out = ''
    let err = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    let isTimedOut = false
    let isDone = false
    const finish = (ok: boolean, note: string): void => {
      if (isDone) return
      isDone = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({ ok, note })
    }
    // The current folder is never searched for a program a shell or a script starts by name.
    const options = { cwd: plan.cwd ?? homedir(), detached: !isWindows, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' } }
    let child: ChildProcess
    try {
      child = program.isShell ? spawn(program.command, { ...options, shell: true }) : spawn(program.command, program.args, options)
    } catch (error) {
      finish(false, s.serveSendFailed(label, String(error)))
      return
    }
    // The session stays held until the agent is gone, so a second reply never meets it.
    timer = setTimeout(() => {
      isTimedOut = true
      killTree(child)
      timer = setTimeout(() => finish(false, s.serveSendFailed(label, s.serveSendTimeout)), KILL_WAIT)
    }, MAX_WAIT)
    child.stdout?.on('data', (chunk: Buffer) => {
      out = (out + chunk.toString('utf8')).slice(-8000)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString('utf8')).slice(-2000)
    })
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish(false, s.serveSendFailed(label, error.code === 'ENOENT' ? s.serveSendMissing(plan.agent) : error.message)),
    )
    const settle = (code: number | null): void => {
      if (isTimedOut) return finish(false, s.serveSendFailed(label, s.serveSendTimeout))
      const said = (code === 0 ? out : err || out).trim()
      const tail = said.length > 600 ? `…${said.slice(-600)}` : said
      finish(code === 0, code === 0 ? s.serveSent(label, tail) : s.serveSendFailed(label, `${s.serveSendExit(code ?? -1)} ${tail}`.trim()))
    }
    child.on('close', settle)
    // A program the agent started (an MCP server) can hold its output open after the agent has
    // gone; the answer is in by then, so it is not taken for a reply that never came.
    child.on('exit', code => {
      setTimeout(() => settle(code), 2000)
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(plan.stdin ?? '')
  })

export const startServer = (o: ServeOptions): void => {
  const token = randomBytes(24).toString('base64url')
  const sending = new Set<string>()
  // The last answer of each session the page sent to, until the next send to that session. One
  // entry per session at most; the page shows those that came after it loaded.
  const replies = new Map<string, Result & { at: number }>()
  let port = 0
  let lastSeen = Date.now()
  let isStopping = false

  const stop = (): void => {
    if (isStopping) return
    isStopping = true
    server.close()
    server.closeAllConnections()
    o.onStop()
  }

  // One reply at a time per session, in the background: the page asks for the board every 3
  // seconds and the answer comes with it, however long the agent takes.
  const send = (target: AgentTarget, reply: string, title: string): { status: number; note: string } => {
    const plan = sendPlan(target, reply, isWindows)
    if (plan === null) return { status: 409, note: o.s.serveSendNone(target.agent) }
    if (plan.cwd !== null && !isFolder(plan.cwd)) return { status: 409, note: o.s.serveSendFailed(target.agent, plan.cwd) }
    const key = sendKey(target)
    if (sending.has(key)) return { status: 409, note: o.s.serveSendBusy(target.agent) }
    sending.add(key)
    replies.delete(key)
    const label = `${target.agent} · ${title}`
    run(plan, o.s, label)
      .then(result => replies.set(key, { ...result, at: Date.now() }))
      .catch((error: unknown) => replies.set(key, { ok: false, note: o.s.serveSendFailed(label, String(error)), at: Date.now() }))
      .finally(() => sending.delete(key))
    return { status: 202, note: o.s.serveQueued(label) }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const isPage = req.method === 'GET' && url.pathname === '/'
    const problem = requestProblem(
      {
        method: req.method ?? '',
        host: req.headers.host ?? '',
        origin: req.headers.origin ?? '',
        contentType: req.headers['content-type'] ?? '',
        token: isPage ? (url.searchParams.get('t') ?? '') : text(req.headers['x-board-token']),
      },
      port,
      token,
    )
    if (problem !== null) return json(res, problem, {})
    lastSeen = Date.now()
    if (isPage) {
      const nonce = randomBytes(16).toString('base64')
      res.writeHead(200, { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': pagePolicy(nonce), 'x-frame-options': 'DENY' })
      res.end(servePage(o.s, nonce))
      return
    }
    if (req.method === 'GET') {
      if (url.pathname === '/api/board') {
        return json(res, 200, { model: serveModel(o.view(), o.pending(), o.s, sending), replies: [...replies.values()], now: Date.now() })
      }
      if (url.pathname === '/api/ping') return json(res, 200, { ...o.ping, sending: sending.size })
      return json(res, 404, {})
    }
    const body = await readBody(req)
    if (body === null) return json(res, 400, {})
    if (url.pathname === '/api/act') {
      const action = serveAction(boardItems(o.view(), o.pending()), { key: text(body.key), type: text(body.type), text: text(body.text), session: text(body.session) }, o.s)
      if (action.type === 'refuse') return json(res, 409, { note: action.note })
      if (action.type === 'send') {
        const sent = send(action.target, action.text, action.title)
        return json(res, sent.status, { note: sent.note })
      }
      const note = o.act(action)
      const isDone = ![o.s.boardWriteFailed, o.s.boardTickGone, o.s.archiveGone, o.s.hideFailed].includes(note)
      return json(res, isDone ? 200 : 409, { note })
    }
    if (url.pathname === '/api/tidy') {
      const note = o.tidy()
      return json(res, note === o.s.boardWriteFailed ? 409 : 200, { note })
    }
    if (url.pathname === '/api/paste') {
      const pasted = o.paste(text(body.text))
      return json(res, pasted.isAdded ? 200 : 409, { note: pasted.note })
    }
    if (url.pathname === '/api/close') {
      // Closing would cut a reply off halfway: on Windows the agent goes with the server.
      if (sending.size > 0) return json(res, 409, { note: o.s.serveCloseBusy })
      json(res, 200, {})
      setImmediate(stop)
      return
    }
    return json(res, 404, {})
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, {})
    })
  })
  server.on('error', () => o.onStop())
  // The page asks every 3 seconds while it is open; the server goes once nobody has asked for
  // `idleMs` and no reply is on its way.
  const idle = setInterval(() => {
    if (sending.size === 0 && Date.now() - lastSeen > o.idleMs) stop()
  }, Math.min(30_000, o.idleMs))
  server.on('close', () => clearInterval(idle))
  server.listen(o.port, '127.0.0.1', () => {
    port = (server.address() as AddressInfo).port
    if (!o.onReady(`http://127.0.0.1:${port}/?t=${token}`, port)) stop()
  })
}
