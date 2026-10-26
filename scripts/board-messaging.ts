import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { address, claimMessages, deliveryText, disconnectMessages, dismissMessage, FINISHED_KEEP_COUNT, HOP_LIMIT, isFinished, messageFields, messageId, messageReceipt, messageText, observeSession, OPEN_CAP, originOf, pruneMessages, queueMessage, shownMessage, textHash } from '../hooks/messaging'
import type { Connection, MessageState, ProgressBinding, SessionExpectation } from '../hooks/messaging'
import { privateFolder } from './private-folder'
import { claimMessageStore } from './message-store-claim'
import type { MessageStoreClaim } from './message-store-claim'

const LEASE_MS = 15_000
const LOCK_WRITE_MS = 5_000
const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
type Live = Connection & { secret: string }
// On Windows a virus scanner or indexer can hold a file just written, and a rename onto it then
// fails for a moment. A short wait clears it, so the store is called busy only if it stays busy.
const RENAME_WAITS_MS = [10, 25, 50, 100]
const replaceFile = (from: string, to: string): void => {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const wait = RENAME_WAITS_MS[attempt]
      if (wait === undefined || !['EPERM', 'EBUSY', 'EAGAIN'].includes(String((error as NodeJS.ErrnoException).code))) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
    }
  }
}

// Two hubs can find the same dead pid. Only one can move the lock aside, and one that cannot
// read it or finds that another hub had just taken it puts it back.
export const moveLockAside = (lock: string, recorded: string, claim: MessageStoreClaim): boolean => {
  claim.check(dirname(lock))
  const aside = `${lock}.${process.pid}.stale`
  renameSync(lock, aside)
  let moved: string
  try { moved = readFileSync(aside, 'utf8') } catch (error) {
    try { linkSync(aside, lock) } catch {} finally { try { unlinkSync(aside) } catch {} }
    throw error
  }
  if (moved !== recorded) {
    try { linkSync(aside, lock) } catch {} finally { try { unlinkSync(aside) } catch {} }
    return false
  }
  unlinkSync(aside)
  return true
}

// Only a host adapter can register a receiving session. Registrations and secrets die with
// this server; message ids and receipts survive restart so uncertainty is never auto-retried.
const openMessaging = (directory: string, isDefault = false) => {
  const root = resolve(directory)
  const isCreated = mkdirSync(root, { recursive: true, mode: 0o700 }) !== undefined
  if (lstatSync(root).isSymbolicLink()) throw new Error('UNSAFE_MESSAGE_DIRECTORY')
  if (process.platform === 'win32' && (isCreated || isDefault)) {
    try {
      privateFolder(root)
    } catch { throw new Error('MESSAGE_STORE_ACL') }
  }
  const claim = claimMessageStore(root)
  try { return openClaimedMessaging(root, claim) } catch (error) {
    try { claim.release() } catch (cleanup) { throw new AggregateError([error, cleanup], 'MESSAGE_STORE_CLAIM_BLOCKED') }
    throw error
  }
}

const openClaimedMessaging = (root: string, claim: MessageStoreClaim) => {
  let isClosed = false
  const requireOpen = (): void => { if (isClosed) throw new Error('MESSAGE_STORE_CLOSED') }
  const file = join(root, 'messages.json')
  const lock = join(root, 'server.lock')
  const owner = join(root, 'server.owner')
  const acquire = (): void => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
        if (readFileSync(lock, 'utf8') !== String(process.pid)) throw new Error('MESSAGE_STORE_IN_USE')
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') continue
        if (code !== 'EEXIST') throw error
      }
      try {
        const recorded = readFileSync(lock, 'utf8')
        // A lock is created empty and its pid written a moment later; an empty one that new is in use.
        if (recorded === '' && Date.now() - statSync(lock).mtimeMs < LOCK_WRITE_MS) throw new Error('MESSAGE_STORE_IN_USE')
        const pid = Number(recorded)
        if (/^[1-9][0-9]*$/.test(recorded) && Number.isInteger(pid) && pid <= 2147483647) {
          try {
            process.kill(pid, 0)
            throw new Error('MESSAGE_STORE_IN_USE')
          } catch (probe) {
            const code = (probe as NodeJS.ErrnoException).code
            if (code === 'EPERM') throw new Error('MESSAGE_STORE_IN_USE')
            if (code !== 'ESRCH') throw probe
          }
        }
        if (!moveLockAside(lock, recorded, claim)) throw new Error('MESSAGE_STORE_IN_USE')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    throw new Error('MESSAGE_STORE_IN_USE')
  }
  const release = (): void => { if (existsSync(lock) && readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock) }
  acquire()
  // An owner record belongs only to the lock it was written under.
  try { unlinkSync(owner) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { release() } catch {}
      throw error
    }
  }
  let state: MessageState = { messages: [] }
  const connections = new Map<string, Live>()
  const expectations = new Map<string, SessionExpectation>()
  // Every write is pruned first, so the file never holds more than the two caps allow.
  const save = (changed: MessageState, now: number): void => {
    requireOpen()
    const next = pruneMessages(changed, now)
    if (next === state) return
    const temp = `${file}.${process.pid}.tmp`
    try {
      // A temp file an earlier save could not remove would block every save after it.
      try { unlinkSync(temp) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      writeFileSync(temp, JSON.stringify({ version: 2, ...next }), { mode: 0o600, flag: 'wx' })
      replaceFile(temp, file)
      state = next
    } finally {
      // A temp file that cannot go now goes at the next start; the save's own error is the one reported.
      try { if (existsSync(temp)) unlinkSync(temp) } catch {}
    }
  }
  // A store that cannot be read gives its lock back, so fixing the file is all a retry needs.
  try {
    // A hub killed between writing and renaming leaves its temp file; with the lock held, none is in use.
    for (const name of readdirSync(root)) {
      if (/^messages\.json\.\d+\.tmp$/.test(name)) try { unlinkSync(join(root, name)) } catch {}
    }
    if (existsSync(file)) {
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('UNSAFE_MESSAGE_FILE')
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { version: unknown; messages: MessageState['messages'] }
      if (saved.version !== 1 && saved.version !== 2 || !Array.isArray(saved.messages) || saved.messages.length > OPEN_CAP + FINISHED_KEEP_COUNT) throw new Error('INVALID_MESSAGE_STORE')
      // A store written before origins and hashes reads as local, with the hash of the text it kept.
      const messages = saved.messages.map(one => saved.version === 1 ? { ...one, hops: 1, claimed: 0, nonce: '' } : { ...one })
        .map(one => ({ ...one, origin: one.origin ?? 'local', hash: one.hash ?? (typeof one.text === 'string' && one.text !== '' ? textHash(one.text) : '') }))
      for (const one of messages) {
        messageId(one.id)
        messageId(one.target)
        messageId(one.turn)
        messageText(one.from, 300)
        messageText(one.to, 300)
        if (!['queued', 'uncertain', 'accepted', 'acknowledged', 'rejected'].includes(one.status) || typeof one.reply !== 'string' || typeof one.error !== 'string' || !Number.isFinite(one.updated)) throw new Error('INVALID_MESSAGE_STORE')
        // Only a finished message may have lost its text.
        if (!isFinished(one) || one.text !== '') messageText(one.text)
        if (one.origin !== 'local' || typeof one.hash !== 'string' || !/^[0-9a-f]{64}$/.test(one.hash) || one.text !== '' && one.hash !== textHash(one.text)) throw new Error('INVALID_MESSAGE_STORE')
        if (!Number.isSafeInteger(one.hops) || one.hops < 1 || one.hops > HOP_LIMIT || !Number.isSafeInteger(one.claimed) || one.claimed < 0 || typeof one.nonce !== 'string' || !/^(?:[0-9a-f]{6})?$/.test(one.nonce)) throw new Error('INVALID_MESSAGE_STORE')
      }
      if (new Set(messages.map(one => one.id)).size !== messages.length) throw new Error('INVALID_MESSAGE_STORE')
      state = { messages }
      state = pruneMessages(state, Date.now())
      for (const id of new Set(state.messages.map(one => one.target))) state = disconnectMessages(state, id, Date.now())
      // Persist reconciliation even if a server closes before a browser polls it again.
      const next = state
      state = { messages: [] }
      save(next, Date.now())
    }
  } catch (error) {
    release()
    throw error
  }
  // A connection goes only once its messages' new states are on disk.
  const expire = (now: number): void => {
    const gone = [...connections.values()].filter(one => one.expires <= now)
    save(gone.reduce((next, one) => disconnectMessages(next, one.id, now), state), now)
    for (const one of gone) connections.delete(one.id)
  }
  const authenticated = (id: unknown, secret: unknown, now: number): Live => {
    const one = connections.get(messageId(id))
    if (!one || typeof secret !== 'string' || !same(one.secret, secret) || one.expires <= now) throw new Error('CONNECTOR_NOT_CONNECTED')
    return one
  }
  return {
    recordOwner: (port: number, url: string): void => {
      requireOpen()
      writeFileSync(owner, JSON.stringify({ pid: process.pid, port, url }), { mode: 0o600 })
    },
    close: (): void => {
      if (isClosed) return
      // Quiesce every store method before releasing the lifetime claim.
      isClosed = true
      try {
        // A lock left behind keeps its owner record for explicit recovery.
        release()
        try { if (JSON.parse(readFileSync(owner, 'utf8')).pid === process.pid) unlinkSync(owner) } catch {}
      } finally { claim.release() }
    },
    snapshot: (now: number, reports: readonly ProgressBinding[] = []) => {
      expire(now)
      for (const [id, one] of expectations) expectations.set(id, observeSession(one, reports, now))
      return {
        enabled: true, connections: [...connections.values()].map(({ secret: _secret, ...one }) => one), messages: state.messages.map(shownMessage),
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
        messageFields(body, ['agent', 'session', 'surface', 'turn', 'scope', 'origin', 'connection', 'secret'])
        const agent = messageId(body.agent), session = messageId(body.session), turn = messageId(body.turn), surface = messageText(body.surface, 100)
        const scope = body.scope ?? 'turn'
        if (scope !== 'turn' && scope !== 'session' || scope === 'session' && turn !== 'session') throw new Error('INVALID_CONNECTION_SCOPE')
        const origin = originOf(body.origin)
        // A receiver that restarts presents its old connection and secret: that connection is
        // ended as by a disconnect and the new one takes its place, instead of both being
        // contested. Old credentials whose lease already ran out are simply not needed.
        if ((body.connection === undefined) !== (body.secret === undefined)) throw new Error('CONNECTOR_NOT_CONNECTED')
        const previous = body.connection === undefined ? undefined : connections.get(messageId(body.connection))
        if (previous) {
          if (typeof body.secret !== 'string' || !same(previous.secret, body.secret)) throw new Error('CONNECTOR_NOT_CONNECTED')
          if (previous.agent !== agent || previous.session !== session) throw new Error('REPLACE_MISMATCH')
          save(disconnectMessages(state, previous.id, now), now)
          connections.delete(previous.id)
        }
        if (connections.size >= 100) throw new Error('CONNECTION_LIMIT')
        const matches = [...connections.values()].filter(one => address(one.agent, one.session) === address(agent, session))
        for (const live of matches) connections.set(live.id, { ...live, contested: true })
        const one: Live = { id: randomBytes(16).toString('hex'), secret: randomBytes(24).toString('base64url'), agent, session, surface, turn, scope, origin, expires: now + LEASE_MS, contested: matches.length > 0 }
        connections.set(one.id, one)
        return { ...one, leaseMs: LEASE_MS }
      }
      if (action === 'send') {
        const { source, secret, ...input } = body
        if (source === undefined && secret !== undefined) throw new Error('UNKNOWN_FIELD')
        const sender = source === undefined ? undefined : authenticated(source, secret, now)
        const from = sender === undefined ? 'board' : address(sender.agent, sender.session)
        const queued = queueMessage(state, input, from, connections.get(String(input.target)), now, sender?.origin ?? 'local')
        save(queued.state, now)
        // The nonce is the receiver's alone; a retried send never learns it.
        return shownMessage(queued.message)
      }
      if (action === 'dismiss') {
        messageFields(body, ['id'])
        save(dismissMessage(state, messageId(body.id), now), now)
        return { ok: true }
      }
      messageFields(body, action === 'receipt' ? ['connection', 'secret', 'id', 'nonce', 'status', 'reply', 'error'] : action === 'poll' ? ['connection', 'secret', 'turn', 'receive'] : ['connection', 'secret', 'turn'])
      const one = authenticated(body.connection, body.secret, now)
      if (action === 'receipt') {
        const { connection: _id, secret: _secret, ...receipt } = body
        save(messageReceipt(state, one, receipt, now), now)
        return { ok: true }
      }
      if (body.turn !== one.turn) throw new Error('STALE_TURN')
      if (action === 'disconnect') {
        save(disconnectMessages(state, one.id, now), now)
        connections.delete(one.id)
        return { ok: true }
      }
      if (action !== 'poll') throw new Error('UNKNOWN_ACTION')
      if (body.receive !== undefined && typeof body.receive !== 'boolean') throw new Error('INVALID_RECEIVE')
      connections.set(one.id, { ...one, expires: now + LEASE_MS })
      const claimed = one.contested || body.receive === false ? { state, messages: [] } : claimMessages(state, one, now, randomBytes(3).toString('hex'))
      // Claim reaches disk before a connector can perform any external delivery.
      save(claimed.state, now)
      return { messages: claimed.messages.map(message => ({ ...message, prompt: deliveryText(message) })), leaseMs: LEASE_MS }
    },
  }
}

// The server's startup boundary retains the message alone, so preserve a safe errno there.
export const createMessaging = (directory: string, isDefault = false) => {
  try { return openMessaging(directory, isDefault) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (error instanceof Error && !/^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) && typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
      throw Object.assign(new Error(code, { cause: error }), { code })
    }
    throw error
  }
}
