import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL('../', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
let messaging, hookMessages, createMessaging, parseMessageStore, storedMessageState, isClaimRef, messageStatus, EN
try {
  messaging = await import('../hooks/messaging.ts')
  hookMessages = await import('../hooks/hook-messages.ts')
  ;({ createMessaging, parseMessageStore } = await import('../scripts/board-messaging.ts'))
  ;({ storedMessageState, isClaimRef } = await import('../hooks/queued-store.ts'))
  ;({ messageStatus } = await import('../hooks/message-status.ts'))
  ;({ EN } = await import('../hooks/strings-en.ts'))
} finally { loader.deregister() }

// 0.25.1's message store parser (#1860), copied from hooks/queued-store.ts and hooks/messaging.ts at the 0.25.1 release,
// 8ccb458bfde41ac5745ed10f3f1dad8e610462c4. Its helpers come from main: at that release they check messages as main does,
// and the one difference that refuses a store main writes is the list of route lines, pinned here as 0.25.1 had it.
// A typed install of 0.25.1 is 0.26.0's way back, so it must read every store main writes (plan-0.26.0.md, release check 8).
const ROUTE_LINES_0_25_1 = ['now', 'stepEnd', 'nextTurn', 'chatOpen', 'reopen', 'none']
const parseMessageStore0251 = (text, now) => {
  const { FINISHED_KEEP_COUNT, HOP_LIMIT, isAnswersId, isFinished, isMailboxTarget, MAILBOX_REDELIVERIES, messageId, messageText, OPEN_CAP, pruneMessages, textHash } = messaging
  const { MAILBOX_CAP, mailboxId } = hookMessages
  let saved
  try { saved = JSON.parse(text) } catch { throw new Error('INVALID_MESSAGE_STORE') }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('INVALID_MESSAGE_STORE')
  if (saved.pausePeerMessages !== undefined && typeof saved.pausePeerMessages !== 'boolean') throw new Error('INVALID_MESSAGE_STORE')
  if (saved.version !== 1 && saved.version !== 2 || !Array.isArray(saved.messages) || saved.messages.length > OPEN_CAP + FINISHED_KEEP_COUNT) throw new Error('INVALID_MESSAGE_STORE')
  const messages = saved.messages.map(one => saved.version === 1 ? { ...one, hops: 1, claimed: 0, nonce: '' } : { ...one })
    .map(one => ({ ...one, origin: one.origin ?? 'local', hash: one.hash ?? (typeof one.text === 'string' && one.text !== '' ? textHash(one.text) : '') }))
  for (const one of messages) {
    messageId(one.id)
    if (one.framingNonce !== undefined && (typeof one.framingNonce !== 'string' || !/^[0-9a-f]{32}$/.test(one.framingNonce)) || one.awaitsAck !== undefined && typeof one.awaitsAck !== 'boolean') throw new Error('INVALID_MESSAGE_STORE')
    if (one.attempted !== undefined && !(Number.isFinite(one.attempted) && one.attempted > 0)) throw new Error('INVALID_MESSAGE_STORE')
    if (one.ref !== undefined && !isClaimRef(one.ref) || one.redelivered !== undefined && !(Number.isInteger(one.redelivered) && one.redelivered >= 1 && one.redelivered <= MAILBOX_REDELIVERIES)) throw new Error('INVALID_MESSAGE_STORE')
    if (one.answers !== undefined && !isAnswersId(one.answers)) throw new Error('INVALID_MESSAGE_STORE')
    if (one.hasAccepted !== undefined && typeof one.hasAccepted !== 'boolean' || one.awaitsStart !== undefined && one.awaitsStart !== true) throw new Error('INVALID_MESSAGE_STORE')
    if (one.leftAt !== undefined && !Number.isFinite(one.leftAt) || one.heldSince !== undefined && !Number.isFinite(one.heldSince)) throw new Error('INVALID_MESSAGE_STORE')
    if (one.line !== undefined && !ROUTE_LINES_0_25_1.includes(one.line)) throw new Error('INVALID_MESSAGE_STORE')
    if (one.surface !== undefined && (typeof one.surface !== 'string' || one.surface === '' || /[\r\n]/.test(one.surface))) throw new Error('INVALID_MESSAGE_STORE')
    messageId(one.target)
    messageId(one.turn)
    messageText(one.from, 300)
    if (/[\r\n]/.test(one.from)) throw new Error('INVALID_MESSAGE_STORE')
    messageText(one.to, 300)
    if (!['queued', 'uncertain', 'accepted', 'acknowledged', 'rejected'].includes(one.status) || typeof one.reply !== 'string' || typeof one.error !== 'string' || !Number.isFinite(one.updated)) throw new Error('INVALID_MESSAGE_STORE')
    if (!isFinished(one) || one.text !== '') messageText(one.text)
    if (one.origin !== 'local' || typeof one.hash !== 'string' || !/^[0-9a-f]{64}$/.test(one.hash) || one.text !== '' && one.hash !== textHash(one.text)) throw new Error('INVALID_MESSAGE_STORE')
    if (!Number.isSafeInteger(one.hops) || one.hops < 1 || one.hops > HOP_LIMIT || !Number.isSafeInteger(one.claimed) || one.claimed < 0 || typeof one.nonce !== 'string' || !/^(?:[0-9a-f]{6})?$/.test(one.nonce)) throw new Error('INVALID_MESSAGE_STORE')
  }
  if (new Set(messages.map(one => one.id)).size !== messages.length) throw new Error('INVALID_MESSAGE_STORE')
  if (saved.mailboxes !== undefined) {
    if (!Array.isArray(saved.mailboxes) || saved.mailboxes.length > MAILBOX_CAP) throw new Error('INVALID_MESSAGE_STORE')
    for (const one of saved.mailboxes) {
      if (!one || !isMailboxTarget(one.id) || one.id !== mailboxId(messageId(one.agent), messageId(one.session)) || one.scope !== 'mailbox' || one.turn !== 'session' || !Number.isFinite(one.expires)) throw new Error('INVALID_MESSAGE_STORE')
      messageText(one.surface, 100)
      if (one.folderDigest !== undefined && (typeof one.folderDigest !== 'string' || !/^[0-9a-f]{64}$/.test(one.folderDigest)) || one.mcpOwner !== undefined && (typeof one.mcpOwner !== 'string' || !/^[1-9][0-9]*:[^\r\n\0]{1,100}$/.test(one.mcpOwner)) || one.mcpLeaseUntil !== undefined && !Number.isFinite(one.mcpLeaseUntil) || one.contested !== undefined && typeof one.contested !== 'boolean') throw new Error('INVALID_MESSAGE_STORE')
    }
    if (new Set(saved.mailboxes.map(one => one.id)).size !== saved.mailboxes.length) throw new Error('INVALID_MESSAGE_STORE')
  }
  return pruneMessages({ messages, ...(saved.mailboxes === undefined ? {} : { mailboxes: saved.mailboxes }), ...(saved.pausePeerMessages === undefined ? {} : { pausePeerMessages: saved.pausePeerMessages }) }, now)
}

const now = Date.parse('2026-11-27T06:00:00Z')
const { SURFACE_IDS } = messaging
// One synthetic Codex live receiver per surface, each surface on its own line, so one board send takes every line the board can send on.
const sendable = messaging.ROUTE_LINES.filter(line => line !== 'none')
const surfaces = [SURFACE_IDS.codexDaemon, SURFACE_IDS.codexApp, SURFACE_IDS.cli, SURFACE_IDS.tui, SURFACE_IDS.web, SURFACE_IDS.claude, SURFACE_IDS.antigravityTui, SURFACE_IDS.antigravityIde]
const lineSurfaces = sendable.map((line, i) => ({ line, surface: surfaces[i] }))
const routes = [{
  agent: 'codex', kind: 'live', routes: {
    idle: { line: 'now', record: 'docs/validation/synthetic.md', surfaces: lineSurfaces.map(one => one.surface), surfaceLines: Object.fromEntries(lineSurfaces.map(one => [one.surface, one.line])) },
    working: { line: 'none', record: null, surfaces: [] }, ended: { line: 'none', record: null, surfaces: [] },
  },
}]
const session = i => `11111111-2222-4333-8444-5555555555${String(i).padStart(2, '0')}`

const sentStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-0251-'))
  const board = createMessaging(dir, false, { routes, stateOfSession: () => 'idle' })
  try {
    lineSurfaces.forEach(({ surface }, i) => {
      const one = board.act('register', { agent: 'codex', session: session(i), surface, turn: 'session', scope: 'session' }, now)
      board.act('send', { id: `SYNTHETIC-LINE-${i}`, target: one.id, turn: one.turn, text: `Synthetic answer ${i}` }, now)
    })
    return { text: readFileSync(join(dir, 'messages.json'), 'utf8'), snapshot: board.snapshot(now) }
  } finally { board.close(); rmSync(dir, { recursive: true, force: true }) }
}

test('0.25.1 reads the message store after a board answer on every route line main sends on, the Codex daemon after a wait included (#1860)', () => {
  const { text, snapshot } = sentStore()
  assert.deepEqual(snapshot.messages.map(one => one.line), sendable, 'the board sent one message on each line')
  assert.ok(sendable.includes('afterWait'))
  const old = parseMessageStore0251(text, now)
  assert.equal(old.messages.length, sendable.length)
  for (const one of old.messages) assert.ok(ROUTE_LINES_0_25_1.includes(one.line), `0.25.1 reads line ${one.line}`)
  // main reads back the line each message was sent on.
  assert.deepEqual(parseMessageStore(text, now).messages.map(one => one.line), sendable)
})

test('a stored message keeps every route line main knows through 0.25.1\'s parser and back, and a route line that does not match its stored line is refused (#1860)', () => {
  const base = { target: 'synthetic-binding', turn: 'synthetic-turn', from: 'board', to: 'codex:synthetic', origin: 'local', hops: 1, claimed: 0, nonce: '', status: 'queued', updated: now, reply: '', error: '' }
  const state = { messages: messaging.ROUTE_LINES.map((line, i) => ({ ...base, id: `SYNTHETIC-${i}`, text: `t${i}`, hash: messaging.textHash(`t${i}`), line })) }
  const text = JSON.stringify({ version: 2, ...storedMessageState(state) })
  assert.doesNotThrow(() => parseMessageStore0251(text, now))
  // 0.25.1 keeps the field it does not know when it writes the store again, so main still reads the finer line after it.
  const rewritten = JSON.stringify({ version: 2, ...parseMessageStore0251(text, now) })
  assert.deepEqual(parseMessageStore(rewritten, now).messages.map(one => one.line), messaging.ROUTE_LINES)
  const wrong = JSON.parse(text)
  const after = wrong.messages.find(one => one.routeLine === 'afterWait')
  after.line = 'stepEnd'
  assert.throws(() => parseMessageStore(JSON.stringify(wrong), now), /INVALID_MESSAGE_STORE/)
  after.line = 'now'; after.routeLine = 'later'
  assert.throws(() => parseMessageStore(JSON.stringify(wrong), now), /INVALID_MESSAGE_STORE/)
})

test('a Codex daemon message read back from the store still says it goes in when its wait ends (#1860)', () => {
  const { text } = sentStore()
  const one = parseMessageStore(text, now).messages.find(message => message.line === 'afterWait')
  assert.ok(one)
  assert.match(messageStatus(one, now, EN).line, new RegExp(EN.statusWhenAfterWait))
})
