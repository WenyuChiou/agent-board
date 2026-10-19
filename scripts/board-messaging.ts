import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { claimMessages, disconnectMessages, messageFields, messageId, messageReceipt, messageText, observeSession, queueMessage } from '../hooks/messaging'
import type { Connection, MessageState, ProgressBinding, SessionExpectation } from '../hooks/messaging'

const LEASE_MS = 15_000
const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
type Live = Connection & { secret: string }

// Only a host adapter can register a receiving session. Registrations and secrets die with
// this server; message ids and receipts survive restart so uncertainty is never auto-retried.
export const createMessaging = (directory: string) => {
  const root = resolve(directory)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  if (lstatSync(root).isSymbolicLink()) throw new Error('UNSAFE_MESSAGE_DIRECTORY')
  const file = join(root, 'messages.json')
  const lock = join(root, 'server.lock')
  writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
  let state: MessageState = { messages: [] }
  const connections = new Map<string, Live>()
  const expectations = new Map<string, SessionExpectation>()
  if (existsSync(file)) {
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('UNSAFE_MESSAGE_FILE')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { version: unknown; messages: MessageState['messages'] }
    if (saved.version !== 1 || !Array.isArray(saved.messages) || saved.messages.length > 1000) throw new Error('INVALID_MESSAGE_STORE')
    for (const one of saved.messages) {
      messageId(one.id); messageId(one.target); messageId(one.turn); messageText(one.from, 300); messageText(one.to, 300); messageText(one.text)
      if (!['queued', 'uncertain', 'accepted', 'acknowledged', 'rejected'].includes(one.status) || typeof one.reply !== 'string' || typeof one.error !== 'string' || !Number.isFinite(one.updated)) throw new Error('INVALID_MESSAGE_STORE')
    }
    if (new Set(saved.messages.map(one => one.id)).size !== saved.messages.length) throw new Error('INVALID_MESSAGE_STORE')
    state = { messages: saved.messages }
    for (const id of new Set(state.messages.map(one => one.target))) state = disconnectMessages(state, id, Date.now())
  }
  const save = (next: MessageState): void => {
    if (next === state) return
    const temp = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, ...next }), { mode: 0o600, flag: 'wx' })
      renameSync(temp, file)
      state = next
    } finally { if (existsSync(temp)) unlinkSync(temp) }
  }
  // Persist reconciliation even if a server closes before a browser polls it again.
  if (existsSync(file)) { const next = state; state = { messages: [] }; save(next) }
  const expire = (now: number): void => {
    for (const one of connections.values()) if (one.expires <= now) {
      save(disconnectMessages(state, one.id, now))
      connections.delete(one.id)
    }
  }
  const authenticated = (id: unknown, secret: unknown, now: number): Live => {
    const one = connections.get(messageId(id))
    if (!one || typeof secret !== 'string' || !same(one.secret, secret) || one.expires <= now) throw new Error('CONNECTOR_NOT_CONNECTED')
    return one
  }
  return {
    close: () => { if (existsSync(lock) && readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock) },
    snapshot: (now: number, reports: readonly ProgressBinding[] = []) => {
      expire(now)
      for (const [id, one] of expectations) expectations.set(id, observeSession(one, reports, now))
      return {
        enabled: true, connections: [...connections.values()].map(({ secret: _secret, ...one }) => one), messages: state.messages,
        sessions: [
          ...[...expectations.values()].map(one => ({
            id: one.id, agent: one.agent, session: one.session, surface: one.surface,
            status: one.observed !== null ? 'reported' : now >= one.deadline ? 'timed_out' : 'waiting',
            progress: reports.some(report => report.agent === one.agent && report.session === one.session),
            receiving: [...connections.values()].some(live => live.agent === one.agent && live.session === one.session),
          })),
          ...[...connections.values()].filter(live => ![...expectations.values()].some(one => one.agent === live.agent && one.session === live.session)).map(one => ({
            id: one.id, agent: one.agent, session: one.session, surface: one.surface, status: 'connected',
            progress: reports.some(report => report.agent === one.agent && report.session === one.session), receiving: true,
          })),
        ],
      }
    },
    act: (action: string, body: Record<string, unknown>, now: number, reports: readonly ProgressBinding[] = []) => {
      expire(now)
      if (action === 'expect') {
        messageFields(body, ['id', 'agent', 'session', 'surface', 'timeoutMs'])
        const id = messageId(body.id), agent = messageId(body.agent), session = messageId(body.session), surface = messageText(body.surface, 100)
        const timeoutMs = body.timeoutMs ?? 60_000
        if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error('INVALID_EXPECTATION_TIMEOUT')
        const existing = expectations.get(id)
        if (existing) {
          if (existing.agent !== agent || existing.session !== session || existing.surface !== surface || existing.deadline - existing.created !== timeoutMs) throw new Error('ID_CONFLICT')
          return { id, deadline: existing.deadline }
        }
        if (expectations.size >= 100) throw new Error('EXPECTATION_LIMIT')
        const baseline = Math.max(-1, ...reports.filter(one => one.agent === agent && one.session === session).map(one => one.updated))
        expectations.set(id, { id, agent, session, surface, created: now, deadline: now + timeoutMs, baseline, observed: null })
        return { id, deadline: now + timeoutMs }
      }
      if (action === 'register') {
        messageFields(body, ['agent', 'session', 'surface', 'turn', 'scope'])
        const agent = messageId(body.agent), session = messageId(body.session), turn = messageId(body.turn), surface = messageText(body.surface, 100)
        const scope = body.scope ?? 'turn'
        if (scope !== 'turn' && scope !== 'session' || scope === 'session' && turn !== 'session') throw new Error('INVALID_CONNECTION_SCOPE')
        if ([...connections.values()].some(one => one.agent === agent && one.session === session)) throw new Error('SESSION_ALREADY_CONNECTED')
        if (connections.size >= 100) throw new Error('CONNECTION_LIMIT')
        const one: Live = { id: randomBytes(16).toString('hex'), secret: randomBytes(24).toString('base64url'), agent, session, surface, turn, scope, expires: now + LEASE_MS }
        connections.set(one.id, one)
        return { ...one, leaseMs: LEASE_MS }
      }
      if (action === 'send') {
        const { source, secret, ...input } = body
        const from = source === undefined ? 'board' : (() => { const one = authenticated(source, secret, now); return `${one.agent}:${one.session}` })()
        if (source === undefined && secret !== undefined) throw new Error('UNKNOWN_FIELD')
        const queued = queueMessage(state, input, from, connections.get(String(input.target)), now)
        save(queued.state)
        return queued.message
      }
      messageFields(body, action === 'receipt' ? ['connection', 'secret', 'id', 'status', 'reply', 'error'] : ['connection', 'secret', 'turn'])
      const one = authenticated(body.connection, body.secret, now)
      if (action === 'receipt') {
        const { connection: _id, secret: _secret, ...receipt } = body
        save(messageReceipt(state, one, receipt, now))
        return { ok: true }
      }
      if (body.turn !== one.turn) throw new Error('STALE_TURN')
      if (action === 'disconnect') {
        save(disconnectMessages(state, one.id, now)); connections.delete(one.id)
        return { ok: true }
      }
      if (action !== 'poll') throw new Error('UNKNOWN_ACTION')
      connections.set(one.id, { ...one, expires: now + LEASE_MS })
      const claimed = claimMessages(state, one, now)
      // Claim reaches disk before a connector can perform any external delivery.
      save(claimed.state)
      return { messages: claimed.messages, leaseMs: LEASE_MS }
    },
  }
}
