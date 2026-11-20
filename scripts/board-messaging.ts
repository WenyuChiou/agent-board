import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { acceptMailboxMessage, attemptMailboxMessage, endMailbox, enrollMailbox, enrollMcp, expireMailboxes, MAILBOX_CAP, mailboxId, releaseMailboxMessage, takeMailboxMessage } from '../hooks/hook-messages'
import { address, claimMessages, deliveryText, disconnectMessages, dismissMessage, FINISHED_KEEP_COUNT, HOP_LIMIT, isAnswersId, isFinished, isMailboxSurfaceLost, isMailboxTarget, MAILBOX_REDELIVERIES, messageFields, messageId, messageReceipt, messageText, observeSession, OPEN_CAP, originOf, pruneMessages, queueMessage, rebindMessages, ROUTE_LINES, sendDecision, shownMessage, textHash } from '../hooks/messaging'
import type { ReceiverRoutes, RouteLine, RowState } from '../hooks/messaging'
import type { Connection, Message, MessageState, ProgressBinding, SessionExpectation } from '../hooks/messaging'
import { STALE_MS } from '../hooks/parse'
import { isClaimRef, parseMessageStore, queuedMessagingOf, shownMessages } from '../hooks/queued-store'
import { isTimeout, privateFolder, takePrivateFolderHandoff } from './private-folder'
import { claimMessageStore } from './message-store-claim'
import { readSettings } from './settings-file'
import type { MessageStoreClaim } from './message-store-claim'

export { isClaimRef, parseMessageStore }

// A peer sender is 'unverified' or one session's address. Anything else is refused before it is saved,
// because the store's own reader would refuse it on the next start.
const peerSender = (from: unknown): string => {
  if (from === 'unverified') return from
  try {
    if (typeof from !== 'string' || from.length > 300) throw new Error()
    const split = from.indexOf(':')
    if (split < 1 || address(messageId(from.slice(0, split)), messageId(from.slice(split + 1))) !== from) throw new Error()
    return from
  } catch { throw new Error('INVALID_SENDER') }
}

export const mailboxAction = (state: MessageState, action: string, body: Record<string, unknown>, now: number) => {
  const agent = messageId(body.agent), session = messageId(body.session)
  if (action === 'mcp-enroll') {
    messageFields(body, ['agent', 'session', 'surface', 'owner', 'folderDigest', 'until'])
    if (typeof body.owner !== 'string' || !/^[1-9][0-9]*:[^\r\n\0]{1,100}$/.test(body.owner) || typeof body.folderDigest !== 'string' || !/^[0-9a-f]{64}$/.test(body.folderDigest) || typeof body.until !== 'number' || !Number.isFinite(body.until) || body.until <= now) throw new Error('INVALID_ENROLLMENT')
    const next = enrollMcp(state, agent, session, messageText(body.surface, 100), body.owner, body.folderDigest, body.until, now, STALE_MS)
    return { state: next, result: { contested: next.mailboxes!.find(one => one.id === mailboxId(agent, session))!.contested === true } }
  }
  if (action === 'mailbox-turn') {
    messageFields(body, ['agent', 'session', 'surface', 'before', 'isRestricted', 'ref'])
    if (body.ref !== undefined && !isClaimRef(body.ref)) throw new Error('INVALID_REF')
    if (body.isRestricted === true && (state.mailboxes?.find(one => one.id === mailboxId(agent, session))?.mcpLeaseUntil ?? 0) > now) throw new Error('NO_LEASE')
    if (body.before !== undefined && (typeof body.before !== 'number' || now > body.before)) return { state, result: { message: null } }
    const next = takeMailboxMessage(state, agent, session, messageText(body.surface, 100), now, STALE_MS, randomBytes(3).toString('hex'), body.ref)
    return { state: next.state, result: { message: next.message } }
  }
  if (action === 'mailbox-release') {
    messageFields(body, ['agent', 'session', 'ref', 'unsent'])
    if (!isClaimRef(body.ref)) throw new Error('INVALID_REF')
    if (body.unsent !== undefined && body.unsent !== true) throw new Error('INVALID_REF')
    const next = releaseMailboxMessage(state, agent, session, body.ref, now, body.unsent === true)
    // OpenCode's plugin must be told when a release changed nothing: a started wake (WAKE_STARTED) or a claim the
    // board no longer holds (NOT_HELD). The other hooks have always been answered ok, and still are.
    if (agent === 'opencode' && next === state) throw new Error(state.messages.some(one => one.target === mailboxId(agent, session) && one.ref === body.ref && one.attempted !== undefined && one.status === 'uncertain' && one.error === '') ? 'WAKE_STARTED' : 'NOT_HELD')
    return { state: next, result: { ok: true } }
  }
  if (action === 'mailbox-attempt') {
    messageFields(body, ['agent', 'session', 'ref'])
    if (!isClaimRef(body.ref)) throw new Error('INVALID_REF')
    if (agent !== 'opencode') throw new Error('INVALID_MAILBOX_CALL')
    return { state: attemptMailboxMessage(state, agent, session, body.ref, now), result: { ok: true } }
  }
  // OpenCode's plugin takes only while a session is idle, so a busy session opens or renews its mailbox with this, which
  // claims nothing (#1366): the board can then queue a message for it, and a turn longer than the mailbox's life keeps it.
  if (action === 'mailbox-open') {
    messageFields(body, ['agent', 'session', 'surface'])
    if (agent !== 'opencode') throw new Error('INVALID_MAILBOX_CALL')
    return { state: enrollMailbox(state, agent, session, messageText(body.surface, 100), now, STALE_MS), result: { ok: true } }
  }
  messageFields(body, action === 'mailbox-end' ? ['agent', 'session'] : action === 'mailbox-ack' ? ['agent', 'session', 'id', 'nonce', 'reply'] : ['agent', 'session', 'id', 'nonce', 'awaitsAck'])
  const target = state.mailboxes?.find(one => one.id === mailboxId(agent, session))
  if (action === 'mailbox-ack' && !target) throw new Error('OFFLINE')
  const next = action === 'mailbox-end' ? endMailbox(state, agent, session, now)
    : action === 'mailbox-ack' ? messageReceipt(state, target!, { id: body.id, nonce: body.nonce, reply: body.reply, status: 'acknowledged' }, now)
      : acceptMailboxMessage(state, agent, session, messageId(body.id), messageText(body.nonce, 6), now)
  return { state: body.awaitsAck === true ? { ...next, messages: next.messages.map(one => one.id === body.id ? { ...one, awaitsAck: true } : one) } : next, result: { ok: true } }
}

const LEASE_MS = 15_000
// A message an automatic receiver left queued waits this long for the next automatic receiver of its session, then is
// refused as any receiver's is (#318): a session that ended meanwhile has no receiver left to say so.
const LEFT_MS = 10 * 60_000
const LOCK_WRITE_MS = 5_000
const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
// keepsQueued: an automatic receiver (registered `unclaimed`); its leaving leaves its queued messages queued (#318).
// marksStart: a receiver that says `starting` right before it asks its host for anything, so a claim it never said that
// for was never started (#1507).
type Live = Connection & { secret: string; keepsQueued?: boolean; marksStart?: boolean }
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
export type MessageGate = { routes: readonly ReceiverRoutes[]; stateOfSession: (agent: string, session: string) => RowState | undefined }

const openMessaging = (directory: string, isDefault = false, gate?: MessageGate) => {
  const root = resolve(directory)
  const isMade = mkdirSync(root, { recursive: true, mode: 0o700 }) !== undefined
  // The default folder the command that started this server has just checked is not checked
  // again (#799); a folder made here is new and is checked in full.
  const handed = takePrivateFolderHandoff(root)
  const trusted = process.platform === 'win32' && isDefault && !isMade ? handed : undefined
  const isCreated = isMade || trusted?.isCreated === true
  const isFreshDefault = isDefault && isCreated
  try {
    if (lstatSync(root).isSymbolicLink()) throw new Error('UNSAFE_MESSAGE_DIRECTORY')
    // A start that created the folder secures it before any claim file is written inside it.
    // A parallel start that found the default folder already there without a handoff waits if
    // another start is still setting its ACL (#1100), then claims it.
    if (process.platform === 'win32' && trusted === undefined && (isCreated || isDefault)) {
      try {
        privateFolder(root, !isCreated)
      } catch (error) { throw new Error(isTimeout(error) ? 'ACL_CHECK_TIMEOUT' : 'MESSAGE_STORE_ACL', { cause: error }) }
    }
    const claim = claimMessageStore(root)
    try { return openClaimedMessaging(root, claim, isFreshDefault, gate) } catch (error) {
      try { claim.release() } catch (cleanup) { throw new AggregateError([error, cleanup], 'MESSAGE_STORE_CLAIM_BLOCKED') }
      throw error
    }
  } catch (error) {
    if (isFreshDefault) try { rmdirSync(root) } catch {}
    throw error
  }
}

// The answers waiting for a session's next turn, read from the store's file without a lock and without writing,
// for the terminal board, --status and --json to count what the page counts (#1296). The file is replaced whole,
// never edited in place, so a read sees one complete save. Nothing (undefined) when the folder holds no store or
// the file cannot be read as one: those surfaces then count every question as waiting, as they did before.
export const readQueuedMessaging = (directory: string, now: number) => {
  try {
    // The server refuses a store folder that is a link; so does this read, and every question then waits (#1276 review).
    if (lstatSync(resolve(directory)).isSymbolicLink()) return undefined
    const found = readSettings(join(resolve(directory), 'messages.json'))
    if (found.kind !== 'ok') return undefined
    return queuedMessagingOf(found.text, now)
  } catch { return undefined }
}

// The board's own verdict on its messages file as it is on disk now (#1366): read as readQueuedMessaging reads it, without a
// lock and without writing, and checked by parseMessageStore, as every call that opens the store checks it. mark is the
// sha256 of the text it accepted; null when nothing is at the folder or the folder holds no file. A folder or a file it would
// refuse throws. OpenCode's plugin says nothing about a session only on a text this accepted, so it keeps no copy of these rules.
export const checkStoreFile = (directory: string, now: number): { mark: string | null } => {
  const root = resolve(directory)
  try { if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('BOARD_NOT_RUNNING') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mark: null }
    throw error
  }
  const found = readSettings(join(root, 'messages.json'))
  if (found.kind === 'missing') return { mark: null }
  if (found.kind !== 'ok') throw new Error('UNSAFE_MESSAGE_FILE')
  try { parseMessageStore(found.text, now) } catch { throw new Error('INVALID_MESSAGE_STORE') }
  return { mark: createHash('sha256').update(found.text, 'utf8').digest('hex') }
}

const openClaimedMessaging = (root: string, claim: MessageStoreClaim, isFreshDefault = false, gate?: MessageGate) => {
  let isClosed = false
  let isPublished = false
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
  // Whether what this connection leaves queued stays queued: only an automatic receiver's, unless its session ended.
  const keepsLeft = (one: Live, isEnded = false): boolean => one.keepsQueued === true && !isEnded
  const expectations = new Map<string, SessionExpectation>()
  // Every write is pruned first, so the file never holds more than the two caps allow.
  const save = (changed: MessageState, now: number): void => {
    requireOpen()
    const next = pruneMessages(changed, now)
    if (next === state) return
    // An owner whose claim another board retired (after proving it ended, M6) writes nothing.
    claim.check(root)
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
      if (/^(?:messages\.json|server\.owner)\.\d+\.tmp$/.test(name)) try { unlinkSync(join(root, name)) } catch {}
    }
    if (existsSync(file)) {
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('UNSAFE_MESSAGE_FILE')
      state = parseMessageStore(readFileSync(file, 'utf8'), Date.now())
      state = expireMailboxes(state, Date.now())
      // A message an automatic receiver left queued keeps its stamp across a restart of the hub; expire() refuses it on time.
      for (const id of new Set(state.messages.map(one => one.target))) {
        if (!state.mailboxes?.some(one => one.id === id)) state = disconnectMessages(state, id, Date.now(), state.messages.some(one => one.target === id && one.status === 'queued' && one.leftAt !== undefined))
      }
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
    let next = gone.reduce((sum, one) => disconnectMessages(sum, one.id, now, keepsLeft(one)), state)
    // A message left queued is refused LEFT_MS after the stamp it carries. A later automatic receiver took over (and
    // unstamped) what it could; a save that failed here is tried again at the next request, which comes through here.
    for (const id of new Set(next.messages.filter(one => one.status === 'queued' && one.leftAt !== undefined && now - one.leftAt >= LEFT_MS).map(one => one.target))) next = disconnectMessages(next, id, now)
    save(expireMailboxes(next, now), now)
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
      const temp = `${owner}.${process.pid}.tmp`
      try {
        try { unlinkSync(temp) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        writeFileSync(temp, JSON.stringify({ pid: process.pid, port, url }), { mode: 0o600, flag: 'wx' })
        replaceFile(temp, owner)
      } finally {
        try { if (existsSync(temp)) unlinkSync(temp) } catch {}
      }
    },
    // The owner record goes out before the page is announced (#1472), so only an announced page keeps a folder this
    // start made: a start whose address file then fails still leaves nothing behind.
    markPublished: (): void => { isPublished = true },
    close: (): void => {
      if (isClosed) return
      // Quiesce every store method before releasing the lifetime claim.
      isClosed = true
      try {
        // A lock left behind keeps its owner record for explicit recovery.
        release()
        try { if (JSON.parse(readFileSync(owner, 'utf8')).pid === process.pid) unlinkSync(owner) } catch {}
      } finally {
        try { claim.release() } finally {
          // A default folder made by a start that never published its page leaves nothing behind.
          if (isFreshDefault && !isPublished) try { rmdirSync(root) } catch {}
        }
      }
    },
    snapshot: (now: number, reports: readonly ProgressBinding[] = []) => {
      expire(now)
      for (const [id, one] of expectations) expectations.set(id, observeSession(one, reports, now))
      return {
        enabled: true, mailboxes: state.mailboxes ?? [], connections: [...connections.values()].map(({ secret: _secret, keepsQueued: _keepsQueued, marksStart: _marksStart, ...one }) => one), messages: shownMessages(state),
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
      if (action === 'peer-pause') {
        messageFields(body, ['isPaused'])
        if (typeof body.isPaused !== 'boolean') throw new Error('INVALID_PAUSE')
        save({ ...state, pausePeerMessages: body.isPaused }, now)
        return { ok: true }
      }
      if (action === 'peer-send') {
        messageFields(body, ['agent', 'session', 'text', 'id', 'from', 'folderDigest'])
        const agent = messageId(body.agent), session = messageId(body.session)
        const from = peerSender(body.from)
        const target = state.mailboxes?.find(one => one.agent === agent && one.session === session)
        const existing = state.messages.find(one => one.id === body.id)
        if (existing && existing.to !== address(agent, session)) throw new Error('ID_CONFLICT')
        if (!existing) {
          if (!target?.folderDigest) throw new Error('WORKSPACE_UNKNOWN')
          if (target.folderDigest !== body.folderDigest) throw new Error('WORKSPACE_MISMATCH')
        }
        const queued = queueMessage(state, { id: body.id, text: body.text, target: existing?.target ?? target?.id, turn: existing?.turn ?? target?.turn }, from, target, now, 'local', randomBytes(16).toString('hex'))
        save(queued.state, now)
        return shownMessage(queued.message)
      }
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
        messageFields(body, ['agent', 'session', 'surface', 'turn', 'scope', 'origin', 'connection', 'secret', 'unclaimed', 'marksStart'])
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
          save(disconnectMessages(state, previous.id, now, keepsLeft(previous)), now)
          connections.delete(previous.id)
        }
        if (connections.size >= 100) throw new Error('CONNECTION_LIMIT')
        const matches = [...connections.values()].filter(one => address(one.agent, one.session) === address(agent, session))
        // An automatic receiver asks to join only a session nobody holds, so it never marks a person's own connection contested.
        if (body.unclaimed !== undefined && typeof body.unclaimed !== 'boolean' || body.marksStart !== undefined && typeof body.marksStart !== 'boolean') throw new Error('INVALID_CONNECTION_REQUEST')
        if (body.unclaimed === true && matches.length > 0) throw new Error('TARGET_CLAIMED')
        for (const live of matches) connections.set(live.id, { ...live, contested: true })
        const one: Live = { id: randomBytes(16).toString('hex'), secret: randomBytes(24).toString('base64url'), agent, session, surface, turn, scope, origin, expires: now + LEASE_MS, contested: matches.length > 0, ...(body.unclaimed === true ? { keepsQueued: true } : {}), ...(body.marksStart === true ? { marksStart: true } : {}) }
        // It takes over what an earlier automatic receiver of this session left queued, before it can be polled.
        if (one.keepsQueued === true) save(rebindMessages(state, one, id => connections.has(id)), now)
        connections.set(one.id, one)
        return { ...one, leaseMs: LEASE_MS }
      }
      if (action === 'send') {
        const { source, secret, ...input } = body
        if (source === undefined && secret !== undefined) throw new Error('UNKNOWN_FIELD')
        const sender = source === undefined ? undefined : authenticated(source, secret, now)
        const from = sender === undefined ? 'board' : address(sender.agent, sender.session)
        messageFields(input, ['id', 'target', 'turn', 'text', 'answers'])
        let target = connections.get(String(input.target)) ?? state.mailboxes?.find(one => one.id === input.target)
        let line: RouteLine | undefined, surface: string | undefined
        if (from === 'board' && !state.messages.some(one => one.id === input.id)) {
          const decision = sendDecision(String(input.target), [...connections.values()], state.mailboxes ?? [], gate?.stateOfSession ?? (() => undefined), gate?.routes ?? [], now)
          if (!decision.canSend) {
            const code = decision.reason === 'CONTESTED' ? 'CONTESTED' : decision.reason === 'OFFLINE' || decision.reason === 'NO_TARGET' ? 'OFFLINE' : 'NO_RECORDED_ROUTE'
            throw Object.assign(new Error(code), { decision })
          }
          target = decision.target
          line = decision.line
          surface = decision.target.surface
        }
        const queued = queueMessage(state, input, from, target, now, sender?.origin ?? 'local', undefined, line, surface)
        save(queued.state, now)
        // The nonce is the receiver's alone; a retried send never learns it.
        return shownMessage(queued.message)
      }
      if (action === 'dismiss') {
        messageFields(body, ['id'])
        save(dismissMessage(state, messageId(body.id), now), now)
        return { ok: true }
      }
      if (['mailbox-turn', 'mailbox-release', 'mailbox-attempt', 'mailbox-open', 'mailbox-accept', 'mailbox-end', 'mailbox-ack', 'mcp-enroll'].includes(action)) {
        const next = mailboxAction(state, action, body, now)
        save(next.state, now)
        return next.result
      }
      messageFields(body, action === 'receipt' ? ['connection', 'secret', 'id', 'nonce', 'status', 'reply', 'error'] : action === 'poll' ? ['connection', 'secret', 'turn', 'receive'] : action === 'disconnect' ? ['connection', 'secret', 'turn', 'ended'] : ['connection', 'secret', 'turn'])
      const one = authenticated(body.connection, body.secret, now)
      if (action === 'receipt') {
        const { connection: _id, secret: _secret, ...receipt } = body
        save(messageReceipt(state, one, receipt, now), now)
        return { ok: true }
      }
      if (body.turn !== one.turn) throw new Error('STALE_TURN')
      if (action === 'disconnect') {
        // ended: the receiver read its session as ended, so what it leaves queued is refused as before.
        if (body.ended !== undefined && typeof body.ended !== 'boolean') throw new Error('INVALID_CONNECTION_REQUEST')
        save(disconnectMessages(state, one.id, now, keepsLeft(one, body.ended === true)), now)
        connections.delete(one.id)
        return { ok: true }
      }
      if (action !== 'poll') throw new Error('UNKNOWN_ACTION')
      if (body.receive !== undefined && typeof body.receive !== 'boolean') throw new Error('INVALID_RECEIVE')
      connections.set(one.id, { ...one, expires: now + LEASE_MS })
      const claimed = one.contested || body.receive === false ? { state, messages: [] } : claimMessages(state, one, now, randomBytes(3).toString('hex'), undefined, one.marksStart === true)
      // Claim reaches disk before a connector can perform any external delivery.
      save(claimed.state, now)
      return { messages: claimed.messages.map(message => ({ ...message, prompt: deliveryText(message) })), leaseMs: LEASE_MS, contested: one.contested === true }
    },
  }
}

// The server's startup boundary retains the message alone, so preserve a safe errno there.
export const createMessaging = (directory: string, isDefault = false, gate?: MessageGate) => {
  try { return openMessaging(directory, isDefault, gate) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (error instanceof Error && !/^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) && typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
      throw Object.assign(new Error(code, { cause: error }), { code })
    }
    throw error
  }
}

const CONTENTION_ERRNO = new Set(['EEXIST', 'EPERM', 'EBUSY', 'EAGAIN'])
const WRITE_CONTENTION_ERRNO = new Set(['EPERM', 'EBUSY', 'EAGAIN'])
const isClaimContention = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  if (error.message === 'MESSAGE_STORE_IN_USE') return true
  if (error.message !== 'MESSAGE_STORE_CLAIM_BLOCKED') return false
  const cause = (error as { cause?: unknown }).cause as NodeJS.ErrnoException | null | undefined
  return cause == null || CONTENTION_ERRNO.has(String(cause.code ?? ''))
}
const isClaimDamaged = (error: unknown): boolean => error instanceof Error && error.message === 'MESSAGE_STORE_CLAIM_DAMAGED'
const errorLabel = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)) return error.message
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code
  const prefixed = error instanceof Error ? /^([A-Z][A-Z0-9_]{1,63}):/.exec(error.message)?.[1] : undefined
  if (prefixed !== undefined) return prefixed
  return 'MAILBOX_FAILED'
}

const mailboxAccess = (directory: string, budget: number, storeBudget = budget, writesRelease = false) => {
  const root = resolve(directory)
  let hasDeferred = false
  let lastError: string | null = null
  // The connection to the board failed after the request may have reached it: a failed take then hands back what the
  // board may have claimed, as after a timeout (#990), while the error itself is reported, not read as busy (#1631).
  let isCutOff = false
  // The last call failed on the connection to the board (refused, reset or cut), not on a timeout or the board's answer.
  let hasTransportError = false
  // The one place that decides "no folder": the first look at the root said ENOENT. Nothing at that path, so no board has run here;
  // a link (even a dead one), a file in its place or any other failure is not that, and no caller looks at the disk again.
  let isAbsent = false
  // A claim Windows would not let go of is still this hook's own, checked again before every write.
  // The next call reuses it, so the accept for a message already handed out is not refused by it.
  let held: MessageStoreClaim | null = null
  const livePid = (): number | null => {
    try {
      const raw = readFileSync(join(root, 'server.lock'), 'utf8')
      if (!/^[1-9][0-9]*$/.test(raw)) { hasDeferred = true; throw new Error('MESSAGE_STORE_IN_USE') }
      const pid = Number(raw)
      try { process.kill(pid, 0); return pid } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return pid
        throw error
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const call = async (action: string, body: Record<string, unknown>, now: number): Promise<Record<string, unknown>> => {
    hasDeferred = false
    lastError = null
    isAbsent = false
    isCutOff = false
    hasTransportError = false
    const wait = budget
    try {
      const started = Date.now()
      let folder: ReturnType<typeof lstatSync>
      try { folder = lstatSync(root) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') isAbsent = true
        throw error
      }
      if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('BOARD_NOT_RUNNING')
      if (budget <= 0) {
        // The folder exists, so failing on a zero wait budget means busy/timed out rather than missing store.
        hasDeferred = true
        throw new Error('BOARD_NOT_RUNNING')
      }
      const pid = livePid()
      if (pid !== null) {
        let ownerRaw: string
        try { ownerRaw = readFileSync(join(root, 'server.owner'), 'utf8') } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            hasDeferred = true
            throw new Error('BOARD_NOT_RUNNING')
          }
          throw error
        }
        // Only the zero-byte file of a writer whose bytes have not landed yet is a hub still starting; no board writes
        // a record of spaces, so a damaged one is reported as such, not as a hub not yet running (#1448).
        if (ownerRaw === '') {
          hasDeferred = true
          throw new Error('BOARD_NOT_RUNNING')
        }
        let owner: { pid?: unknown; url?: unknown }
        try { owner = JSON.parse(ownerRaw) as { pid?: unknown; url?: unknown } } catch { throw new Error('INVALID_SERVER_OWNER') }
        if (!owner || typeof owner !== 'object' || owner.pid !== pid || typeof owner.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/.test(owner.url)) throw new Error('INVALID_SERVER_OWNER')
        return await new Promise<Record<string, unknown>>((done, fail) => {
          const url = new URL(owner.url as string)
          // This call ends the request itself when its time is up or the answer is too long to read. The error that ending
          // raises is no transport failure: the call stays deferred, as before #1631, and is not asked again.
          let isEndedHere = false
          const endHere = (): void => {
            isEndedHere = true
            clearTimeout(timer)
            req.destroy()
            hasDeferred = true
            fail(new Error('BOARD_NOT_RUNNING'))
          }
          const req = request(new URL(`/api/messages/${action}`, url), { method: 'POST', headers: { 'x-board-token': url.searchParams.get('t')!, 'content-type': 'application/json' } }, res => {
            let text = ''
            res.setEncoding('utf8')
            res.on('data', chunk => { text += chunk; if (text.length > 65_536 && !isEndedHere) endHere() })
            res.on('end', () => {
              clearTimeout(timer)
              try {
                const result = JSON.parse(text)
                if (res.statusCode !== 200) {
                  if (res.statusCode === 503 || result.error === 'MESSAGE_STORE_BUSY') hasDeferred = true
                  throw new Error(result.error ?? 'BOARD_NOT_RUNNING')
                }
                hasDeferred = false
                lastError = null
                done(result)
              } catch (error) { fail(error) }
            })
            res.on('error', error => { if (isEndedHere) return; clearTimeout(timer); isCutOff = true; hasTransportError = true; fail(error) })
          })
          const timer = setTimeout(endHere, wait)
          // Only the timer above is a timeout; any other transport failure keeps its own code (ECONNREFUSED, ECONNRESET).
          // A refused connection never reached the board, so it claimed nothing to hand back.
          req.on('error', error => { if (isEndedHere) return; clearTimeout(timer); isCutOff = (error as NodeJS.ErrnoException).code !== 'ECONNREFUSED'; hasTransportError = true; fail(error) })
          req.end(JSON.stringify(action === 'mailbox-turn' ? { ...body, before: started + wait } : body))
        })
      }
      // Only a running board claims after the hook stopped waiting; the store is written by the hook itself.
      // An in-process plugin hands a claim back through the store itself (writesRelease); a hook that stopped waiting leaves that to a running board.
      if (action === 'peer-send' || (action === 'mailbox-release' || action === 'mailbox-attempt') && !writesRelease) throw new Error('BOARD_NOT_RUNNING')
      // A kept claim that is no longer on disk is gone, and a fresh one is taken.
      const kept = held
      held = null
      let claim: MessageStoreClaim
      if (kept !== null && (() => { try { kept.check(root); return true } catch { return false } })()) claim = kept
      else {
        try { claim = claimMessageStore(root) } catch (error) {
          if (isClaimContention(error)) hasDeferred = true
          throw error
        }
      }
      const file = join(root, 'messages.json'), temp = `${file}.${process.pid}.tmp`
      try {
        // An accept acknowledges output already written, so a slow claim must not discard it.
        if (action !== 'mailbox-accept' && Date.now() - started > storeBudget || livePid() !== null) {
          hasDeferred = true
          throw new Error('BOARD_NOT_RUNNING')
        }
        if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new Error('UNSAFE_MESSAGE_FILE')
        let state = existsSync(file) ? parseMessageStore(readFileSync(file, 'utf8'), now) : { messages: [] }
        const next = mailboxAction(state, action, body, now)
        state = next.state
        // A recheck that fails on a damaged claim is a store error; any other failure defers,
        // so a message whose write never happened stays queued for the next turn (#1484). The
        // check itself names a read failure that is not a refusal Windows clears as damage.
        try { claim.check(root) } catch (error) {
          if (!isClaimDamaged(error)) hasDeferred = true
          throw error
        }
        try {
          writeFileSync(temp, JSON.stringify({ version: 2, ...pruneMessages(state, now) }), { flag: 'wx', mode: 0o600 })
          replaceFile(temp, file)
        } catch (error) {
          if (WRITE_CONTENTION_ERRNO.has(String((error as NodeJS.ErrnoException | null)?.code ?? ''))) hasDeferred = true
          throw error
        }
        hasDeferred = false
        lastError = null
        return next.result
      } finally {
        try { unlinkSync(temp) } catch {}
        // Cleanup cannot take back a saved delivery that the host still needs to read.
        try { claim.release() } catch { held = claim }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        hasDeferred = false
        if (action === 'mailbox-turn') {
          lastError = null
          return { message: null }
        }
        // Nothing at the messages folder means no board has run here, which is not a failure: the open a named take asks
        // first (#1366) reads as empty there, as an unnamed take does (#1448). Its caller still tells it apart by isAbsent.
        lastError = action === 'mailbox-open' && isAbsent ? null : 'BOARD_NOT_RUNNING'
        throw new Error('BOARD_NOT_RUNNING')
      }
      if (hasDeferred) lastError = null
      else lastError = errorLabel(error)
      throw error
    }
  }
  return { call, isDeferred: () => hasDeferred, isCutOff: () => isCutOff, hasTransportError: () => hasTransportError, isAbsent: () => isAbsent, error: () => lastError }
}
export const mcpMailbox = (directory: string, budget = 1000) => mailboxAccess(directory, budget).call
// A turn-start hook has little time, so its waits are short (150 ms for the board, 120 ms for the store). An
// in-process receiver that has seconds to spare may pass longer ones, so a busy board or store is waited for.
export const hookMailbox = (directory: string, budget: number, boardWait = 150, storeWait = 120) => {
  const deadline = Date.now() + budget
  const access = mailboxAccess(directory, Math.min(boardWait, budget), Math.min(storeWait, budget))
  // The last take failed after the board may have claimed a message, and handing it back did not go through.
  let isHeld = false
  const call = async (action: string, body: Record<string, unknown>, now: number): Promise<Message | null> => {
    try { return (await access.call(action, body, now)).message as Message ?? null } catch { return null }
  }
  // The take itself; a failure is thrown, so a caller that must tell it from an empty mailbox can.
  const takeTurn = async (agent: string, session: string, surface: string, now: number, named?: string): Promise<Message | null> => {
    isHeld = false
    const ref = named ?? randomBytes(6).toString('hex')
    // A plugin that names its claim also marks its wake (attempt) and gives it back as unsent, which a board started before
    // the plugin existed refuses with UNKNOWN_FIELD, so a claim it took could never go back: it waits out 30 minutes and its text
    // is cleared. Such a board is told by open, which claims nothing, so nothing is taken there (#1366 review). An open that
    // fails any other way (a lost reply, a busy board) shows nothing either, so nothing is taken: the plugin asks again.
    // Only a missing folder (nothing at that path) means no board has run here, so nothing waits: that take is empty. A link,
    // a file in its place or any other failure is a failure, so the plugin logs it.
    if (named !== undefined) {
      try { await access.call('mailbox-open', { agent, session, surface }, now) } catch (error) {
        if ((error as Error).message === 'UNKNOWN_FIELD') throw new Error('BOARD_OLDER')
        if (access.isAbsent()) return null
        throw error
      }
    }
    try { return (await access.call('mailbox-turn', { agent, session, surface, ref }, now)).message as Message ?? null } catch (error) {
      // A board started before claims had names refuses the field until it restarts: ask it as before.
      if ((error as Error).message === 'UNKNOWN_FIELD') {
        if (deadline - Date.now() < boardWait) throw error
        // A claim with no name cannot be handed back, so one this take may have made stays held (#1631).
        try { return (await access.call('mailbox-turn', { agent, session, surface }, Date.now())).message as Message ?? null } catch (unnamed) {
          if (access.isDeferred() || access.isCutOff()) isHeld = true
          throw unnamed
        }
      }
      // The board may have claimed a message after this hook stopped waiting: hand it back (#990).
      // Its own budget is what the hook has left; a claim not handed back waits out the lease.
      const left = deadline - Date.now()
      if (access.isDeferred() || access.isCutOff()) {
        isHeld = true
        if (left > 0) try { await mailboxAccess(directory, Math.min(boardWait, left)).call('mailbox-release', { agent, session, ref }, Date.now()); isHeld = false } catch {}
      }
      throw error
    }
  }
  return {
    get hasDeferred() { return access.isDeferred() },
    get error() { return access.error() },
    // True when the last call failed on the connection to the board itself (refused, reset or cut): its error is reported,
    // and a caller with time to spare may ask again, as after a deferred take (#1631).
    get hasTransportError() { return access.hasTransportError() },
    // True when the board may still hold a claim from the last take (handing it back failed): asking again would find
    // nothing while that message waits, so the caller reports the error instead (#1631).
    get hasHeldClaim() { return isHeld },
    // True only when the last call found nothing at the messages folder's path.
    get hasNoFolder() { return access.isAbsent() },
    // An in-process plugin may name the claim (a 12-hex ref), so it can hand the claim back with release.
    turn: (agent: string, session: string, surface: string, now: number, named?: string): Promise<Message | null> => takeTurn(agent, session, surface, now, named).catch(() => null),
    // The same take for a caller that must tell a failed take from an empty mailbox; a deferred claim is handed back first.
    turnOrThrow: takeTurn,
    // An in-process plugin's acceptance, explicit acknowledgement and send; a refusal keeps its code for the caller, so only a saved acceptance reads as done.
    acceptOrThrow: async (agent: string, session: string, id: string, nonce: string, now: number, awaitsAck = false): Promise<void> => { await access.call('mailbox-accept', { agent, session, id, nonce, ...(awaitsAck ? { awaitsAck: true } : {}) }, now) },
    ack: async (agent: string, session: string, id: string, nonce: string, reply: string, now: number): Promise<void> => { await access.call('mailbox-ack', { agent, session, id, nonce, reply }, now) },
    send: async (body: { agent: string; session: string; text: string; id: string; from: string; folderDigest: string }, now: number): Promise<void> => { await access.call('peer-send', body, now) },
    // A plugin that took a message and cannot hand it over gives the claim back at once instead of holding it.
    release: async (agent: string, session: string, ref: string, now: number, isUnsent = false): Promise<void> => {
      const left = deadline - Date.now()
      await mailboxAccess(directory, Math.min(boardWait, left), Math.min(storeWait, left), true).call('mailbox-release', { agent, session, ref, ...(isUnsent ? { unsent: true } : {}) }, now)
    },
    // An OpenCode plugin marks the wake it is about to start, in the store it can write itself when no board runs (#724).
    attempt: async (agent: string, session: string, ref: string, now: number): Promise<void> => {
      const left = deadline - Date.now()
      await mailboxAccess(directory, Math.min(boardWait, left), Math.min(storeWait, left), true).call('mailbox-attempt', { agent, session, ref }, now)
    },
    // An OpenCode plugin opens or renews a busy session's mailbox without taking anything (#1366).
    open: async (agent: string, session: string, surface: string, now: number): Promise<void> => { await access.call('mailbox-open', { agent, session, surface }, now) },
    // Whether the board took the accept: a caller that tells its host the message was delivered needs to know it did not (#1430).
    accept: async (agent: string, session: string, id: string, nonce: string, now: number): Promise<boolean> => {
      try { await access.call('mailbox-accept', { agent, session, id, nonce }, now); return true } catch { return false }
    },
    end: (agent: string, session: string, now: number) => call('mailbox-end', { agent, session }, now),
    // The same end for a caller that must tell a write that failed from one that worked.
    endOrThrow: async (agent: string, session: string, now: number): Promise<void> => { await access.call('mailbox-end', { agent, session }, now) },
  }
}
