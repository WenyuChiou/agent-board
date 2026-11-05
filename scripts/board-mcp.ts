import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Readable, Writable } from 'node:stream'
import { address, deliveryText, messageId, senderLabel } from '../hooks/messaging'
import type { Message } from '../hooks/messaging'
import type { Strings } from '../hooks/i18n'
import { MCP_LEASE_MS, mcpRequest, rpcError, toolResult } from '../hooks/mcp-tools'
import type { McpLevel } from '../hooks/mcp-tools'
import { folderIdentity } from './folder-identity'
import { mcpMailbox } from './board-messaging'

export const processStart = (pid: number): string | null => {
  try {
    if (!Number.isSafeInteger(pid) || pid < 1) return null
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] ?? null
    }
    const result = process.platform === 'darwin'
      ? spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 120 })
      : spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { encoding: 'utf8', timeout: 120, windowsHide: true })
    return result.status === 0 && !result.error ? result.stdout.trim() || null : null
  } catch { return null }
}
type Options = {
  directory: string; cwd: string; version: string; s: Strings
  // What agent-board --json prints: the board's document, or its error document when the board cannot be read.
  document: () => object
  env?: Record<string, string | undefined>; parentPid?: number; processStart?: typeof processStart; elapsed?: () => number
}
export const createMcpServer = (o: Options) => {
  const env = o.env ?? process.env, parent = o.parentPid ?? process.ppid
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
  const binding = () => ({ agent, session, surface: 'mcp' })
  const renew = async (now: number) => {
    if (level === 'unbound' || isRevoked) return
    if (until <= now) {
      level = 'restricted'
      const clock = o.elapsed ?? (() => performance.now()), start = clock()
      let started: string | null = null
      try { if (env.AGENT_BOARD_HOST_PID === String(parent)) started = (o.processStart ?? processStart)(parent) } catch {}
      if (clock() - start > 120 || !started || started !== env.AGENT_BOARD_HOST_STARTED) {
        isRevoked = true
        return
      }
      level = 'leased'
    }
    if (level === 'leased') {
      try {
        const result = await access('mcp-enroll', { ...binding(), owner: `${parent}:${env.AGENT_BOARD_HOST_STARTED}`, folderDigest, until: now + MCP_LEASE_MS }, now)
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
    await new Promise(done => setImmediate(done))
    output.removeListener('error', onError)
  }
}
