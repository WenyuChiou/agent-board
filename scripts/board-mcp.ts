import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { MCP_SURFACE, address, deliveryText, messageId, senderLabel } from '../hooks/messaging'
import type { Message } from '../hooks/messaging'
import type { Strings } from '../hooks/i18n'
import { MCP_LEASE_MS, mcpRequest, rpcError, toolResult } from '../hooks/mcp-tools'
import type { McpLevel } from '../hooks/mcp-tools'
import { folderIdentity } from './folder-identity'
import { mcpMailbox } from './board-messaging'

// How long a tool call may wait on the lookup below, the budget roadmap invariant 5 names.
export const MCP_VERIFY_WAIT_MS = 120
// PowerShell, the only stock way to read this on every Windows, takes most of a second to start.
// So the lookup never blocks: it runs beside the server, and a call waits MCP_VERIFY_WAIT_MS at most.
export const processStart = (pid: number, signal?: AbortSignal): Promise<string | null> => new Promise(done => {
  if (!Number.isSafeInteger(pid) || pid < 1) { done(null); return }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      done(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] ?? null)
    } catch { done(null) }
    return
  }
  const [file, args] = process.platform === 'darwin'
    ? ['/bin/ps', ['-o', 'lstart=', '-p', String(pid)]] as const
    : [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`]] as const
  try {
    execFile(file, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, signal }, (error, stdout) => { done(error ? null : stdout.trim() || null) })
  } catch { done(null) }
})
type Options = {
  directory: string; cwd: string; version: string; s: Strings
  // What agent-board --json prints: the board's document, or its error document when the board cannot be read.
  document: () => object
  env?: Record<string, string | undefined>; parentPid?: number; processStart?: (pid: number, signal?: AbortSignal) => Promise<string | null> | string | null
}
export const createMcpServer = (o: Options) => {
  const env = o.env ?? process.env
  const parentPid = () => o.parentPid ?? process.ppid
  // A process's start time never changes, so one lookup per parent serves every later lease.
  const stopLookup = new AbortController()
  let lookup: { parent: number; started: string | null | undefined } | null = null
  const look = (parent: number) => {
    if (lookup?.parent === parent) return lookup
    const current: { parent: number; started: string | null | undefined; settled?: Promise<void> } = { parent, started: undefined }
    lookup = current
    current.settled = (async () => { try { current.started = await (o.processStart ?? processStart)(parent, stopLookup.signal) } catch { current.started = null } })()
    return current
  }
  let agent = '', session = '', level: McpLevel = 'unbound', until = 0, isRevoked = false
  try {
    agent = messageId(env.AGENT_BOARD_AGENT)
    session = messageId(env.AGENT_BOARD_SESSION_ID)
    level = 'restricted'
  } catch {}
  const access = mcpMailbox(o.directory)
  // Two names for one folder are one workspace, as they are for a reporter's owner.
  const identity = folderIdentity(o.cwd)
  const folderDigest = identity?.folderCanonicalDigest ?? identity?.folderDigest
  const binding = () => ({ agent, session, surface: MCP_SURFACE })
  const renew = async (now: number) => {
    if (level === 'unbound' || isRevoked) return
    if (until <= now) {
      level = 'restricted'
      const parent = parentPid()
      if (env.AGENT_BOARD_HOST_PID !== String(parent)) {
        isRevoked = true
        return
      }
      const current = look(parent) as { started: string | null | undefined; settled?: Promise<void> }
      if (current.started === undefined) {
        let timer: NodeJS.Timeout | undefined
        await Promise.race([current.settled, new Promise(done => { timer = setTimeout(done, MCP_VERIFY_WAIT_MS) })])
        clearTimeout(timer)
      }
      // Still looking: this call goes on without a lease, and a later one finds the answer.
      if (current.started === undefined) return
      if (!current.started || current.started !== env.AGENT_BOARD_HOST_STARTED) {
        isRevoked = true
        return
      }
      level = 'leased'
    }
    if (level === 'leased') {
      try {
        const result = await access('mcp-enroll', { ...binding(), owner: `${parentPid()}:${env.AGENT_BOARD_HOST_STARTED}`, folderDigest, until: now + MCP_LEASE_MS }, now)
        until = now + MCP_LEASE_MS
        if (result.contested) {
          level = 'restricted'
          isRevoked = true
        }
      } catch (error) {
        level = 'restricted'
        throw error
      }
    }
  }
  const start = async (now: number) => { try { await renew(now) } catch {} }
  return {
    start,
    stop: () => stopLookup.abort(),
    revokeLease: () => {
      isRevoked = true
      level = level === 'unbound' ? level : 'restricted'
    },
    handle: async (line: string, now: number): Promise<{ frame?: unknown; accepted?: () => Promise<unknown> }> => {
      const request = mcpRequest(line, o.version, o.s, now)
      if (!request.tool) return { frame: request.frame }
      const { name, args } = request.tool
      const reply = (result: unknown, accepted?: () => Promise<unknown>) => ({ frame: { jsonrpc: '2.0', id: request.id, result }, accepted })
      try {
        await start(now)
        if (name === 'board_status') {
          const document = o.document()
          // The caller's level is not the board's, so it stays outside the shared document.
          return reply({ ...toolResult(document, 'error' in document), _meta: { level } })
        }
        if (name === 'board_send') return reply(toolResult(await access('peer-send', { ...args, id: args.id ?? randomBytes(16).toString('hex'), from: level === 'leased' ? address(agent, session) : 'unverified', folderDigest }, now)))
        if (level === 'unbound') throw new Error('NO_SESSION')
        if (name === 'board_ack') {
          if (level !== 'leased') throw new Error('NO_LEASE')
          return reply(toolResult(await access('mailbox-ack', { agent, session, id: args.id, nonce: args.nonce, reply: `ACK ${args.nonce}${args.summary ? ` ${args.summary}` : ''}` }, now)))
        }
        const result = await access('mailbox-turn', { ...binding(), ...(level === 'leased' ? {} : { isRestricted: true }) }, now), message = result.message as Message | null
        return reply(toolResult({ message: message ? { id: message.id, from: senderLabel(message.from), nonce: message.nonce, envelope: deliveryText(message, o.s) } : null }), message ? () => access('mailbox-accept', { agent, session, id: message.id, nonce: message.nonce, ...(level === 'leased' ? { awaitsAck: true } : {}) }, now) : undefined)
      } catch (error) {
        const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'BOARD_NOT_RUNNING'
        if (code === 'CONTESTED' && name !== 'board_send') {
          level = 'restricted'
          isRevoked = true
        }
        return reply(toolResult({ code }, true))
      }
    },
  }
}
export const runMcp = async (o: Options, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> => {
  const server = createMcpServer(o)
  await server.start(Date.now())
  let pending = '', isOver = false
  const onError = () => {}
  output.on('error', onError)
  // The host has the message by now. If this cannot be recorded it stays uncertain, and the stream goes on.
  const settle = async (accepted?: () => Promise<unknown>) => { try { await accepted?.() } catch { process.stderr.write('MCP_ACCEPT_FAILED\n') } }
  const write = (frame: unknown) => new Promise<void>((done, fail) => { output.write(`${JSON.stringify(frame)}\n`, error => error ? fail(error) : done()) })
  try {
    input.setEncoding('utf8')
    for await (const chunk of input) {
      for (const part of String(chunk).split(/(?<=\n)/)) {
        if (!isOver) pending += part
        if (Buffer.byteLength(pending) > 1024 * 1024) {
          isOver = true
          pending = ''
        }
        if (!part.endsWith('\n')) continue
        const response: Awaited<ReturnType<typeof server.handle>> = isOver ? { frame: rpcError(null, -32700) } : await server.handle(pending, Date.now())
        pending = ''
        isOver = false
        if (response.frame !== undefined) {
          await write(response.frame)
          await settle(response.accepted)
        }
      }
    }
    if (isOver) await write(rpcError(null, -32700))
    else if (pending) {
      const response = await server.handle(pending, Date.now())
      if (response.frame !== undefined) {
        await write(response.frame)
        await settle(response.accepted)
      }
    }
  } catch { process.stderr.write('MCP_TRANSPORT_FAILED\n') }
  finally {
    server.stop()
    await new Promise(done => setImmediate(done))
    output.removeListener('error', onError)
  }
}
