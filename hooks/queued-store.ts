import { expireMailboxes, MAILBOX_CAP, mailboxId, shownWake } from './hook-messages'
import { FINISHED_KEEP_COUNT, HOP_LIMIT, isAnswersId, isFinished, isHostTurn, isMailboxSurfaceLost, isMailboxTarget, MAILBOX_REDELIVERIES, messageId, messageText, OPEN_CAP, pruneMessages, ROUTE_LINES, shownMessage, SURFACE_IDS, textHash } from './messaging'
import type { Connection, MessageState } from './messaging'
import { addressKey } from './receiver'
import { sha256 } from './sha256'

// The message store's file read without Node (#1296): the page's server, the CLI and the Claude Code pane all
// check it by these rules, and the pane, which has no store of its own, counts from it what the page counts.

// The name a hook gives its mailbox claim, so it can hand back a claim it stopped waiting for (#990).
export const isClaimRef = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{12}$/.test(value)
// A turn number an Antigravity hook counted for its conversation (#1396).
export const isTurnNumber = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
export const parseMessageStore = (text: string, now: number): MessageState => {
  let saved: MessageState & { version: unknown }
  try { saved = JSON.parse(text) as MessageState & { version: unknown } } catch { throw new Error('INVALID_MESSAGE_STORE') }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('INVALID_MESSAGE_STORE')
  if (saved.pausePeerMessages !== undefined && typeof saved.pausePeerMessages !== 'boolean') throw new Error('INVALID_MESSAGE_STORE')
  if (saved.version !== 1 && saved.version !== 2 || !Array.isArray(saved.messages) || saved.messages.length > OPEN_CAP + FINISHED_KEEP_COUNT) throw new Error('INVALID_MESSAGE_STORE')
  // A store written before origins and hashes reads as local, with the hash of the text it kept.
  const messages = saved.messages.map(one => saved.version === 1 ? { ...one, hops: 1, claimed: 0, nonce: '' } : { ...one })
    .map(one => ({ ...one, origin: one.origin ?? 'local', hash: one.hash ?? (typeof one.text === 'string' && one.text !== '' ? textHash(one.text) : '') }))
  for (const one of messages) {
    messageId(one.id)
    if (one.framingNonce !== undefined && (typeof one.framingNonce !== 'string' || !/^[0-9a-f]{32}$/.test(one.framingNonce)) || one.awaitsAck !== undefined && typeof one.awaitsAck !== 'boolean') throw new Error('INVALID_MESSAGE_STORE')
    if (one.attempted !== undefined && !(Number.isFinite(one.attempted) && one.attempted > 0) || one.woke !== undefined && !(Number.isFinite(one.woke) && one.woke > 0) || one.wakeAfter !== undefined && !isTurnNumber(one.wakeAfter)) throw new Error('INVALID_MESSAGE_STORE')
    if (one.ref !== undefined && !isClaimRef(one.ref) || one.redelivered !== undefined && !(Number.isInteger(one.redelivered) && one.redelivered >= 1 && one.redelivered <= MAILBOX_REDELIVERIES)) throw new Error('INVALID_MESSAGE_STORE')
    if (one.answers !== undefined && !isAnswersId(one.answers) || one.boundTurn !== undefined && !isHostTurn(one.boundTurn)) throw new Error('INVALID_MESSAGE_STORE')
    if (one.hasAccepted !== undefined && typeof one.hasAccepted !== 'boolean' || one.awaitsStart !== undefined && one.awaitsStart !== true) throw new Error('INVALID_MESSAGE_STORE')
    if (one.leftAt !== undefined && !Number.isFinite(one.leftAt) || one.heldSince !== undefined && !Number.isFinite(one.heldSince)) throw new Error('INVALID_MESSAGE_STORE')
    if (one.line !== undefined && !ROUTE_LINES.includes(one.line) || one.wake !== undefined && one.wake !== 'sent' && one.wake !== 'failed') throw new Error('INVALID_MESSAGE_STORE')
    if (one.surface !== undefined && (typeof one.surface !== 'string' || one.surface === '' || /[\r\n]/.test(one.surface))) throw new Error('INVALID_MESSAGE_STORE')
    messageId(one.target)
    messageId(one.turn)
    messageText(one.from, 300)
    if (/[\r\n]/.test(one.from)) throw new Error('INVALID_MESSAGE_STORE')
    messageText(one.to, 300)
    if (!['queued', 'uncertain', 'accepted', 'acknowledged', 'rejected'].includes(one.status) || typeof one.reply !== 'string' || typeof one.error !== 'string' || !Number.isFinite(one.updated)) throw new Error('INVALID_MESSAGE_STORE')
    // Only a finished message may have lost its text.
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
      if (one.hostTurn !== undefined && !isHostTurn(one.hostTurn)) throw new Error('INVALID_MESSAGE_STORE')
      if (one.folderDigest !== undefined && (typeof one.folderDigest !== 'string' || !/^[0-9a-f]{64}$/.test(one.folderDigest)) || one.mcpOwner !== undefined && (typeof one.mcpOwner !== 'string' || !/^[1-9][0-9]*:[^\r\n\0]{1,100}$/.test(one.mcpOwner)) || one.mcpLeaseUntil !== undefined && !Number.isFinite(one.mcpLeaseUntil) || one.contested !== undefined && typeof one.contested !== 'boolean') throw new Error('INVALID_MESSAGE_STORE')
      if (one.busySeq !== undefined && !isTurnNumber(one.busySeq)) throw new Error('INVALID_MESSAGE_STORE')
    }
    if (new Set(saved.mailboxes.map(one => one.id)).size !== saved.mailboxes.length) throw new Error('INVALID_MESSAGE_STORE')
  }
  return pruneMessages({ messages, ...(saved.mailboxes === undefined ? {} : { mailboxes: saved.mailboxes }), ...(saved.pausePeerMessages === undefined ? {} : { pausePeerMessages: saved.pausePeerMessages }) }, now)
}

// The answers waiting for a session's next turn, in the shape the page's model reads: no connection (only the
// running page has those), the mailboxes still open at `now`, and each message as anyone but its receiver sees it.
// The surface itself stays off the page; a message to a Codex desktop app conversation is marked, since it runs only once the
// app has let go of the conversation and the page says so while it waits (#557).
// isSidecarOn: whether the Antigravity sidecar polls now, which only the page's server knows.
export const shownMessages = (state: Pick<MessageState, 'messages' | 'mailboxes'>, isSidecarOn?: boolean) =>
  state.messages.map(one => {
    const { wake: _wake, ...shown } = shownMessage(one)
    const wake = shownWake(one, isSidecarOn)
    return { ...shown, ...(wake === undefined ? {} : { wake }), ...(isMailboxSurfaceLost(one, state.mailboxes) ? { isSurfaceLost: true as const } : {}), ...(one.surface === SURFACE_IDS.codexApp ? { isAfterAppQuit: true as const } : {}) }
  })
export const queuedMessagingOf = (text: string, now: number) => {
  const state = expireMailboxes(parseMessageStore(text, now), now)
  return { connections: [] as Connection[], mailboxes: state.mailboxes ?? [], messages: shownMessages(state) }
}

// The page's own messages folder for this progress.md, named by the rule of scripts/runtime-folder.ts
// (defaultMessagesDirectory), so the pane reads the file the page writes. `isRuntimeOwn` says the runtime folder is
// this account's own (POSIX); on Windows a runtime folder that is set is used as it is, as the page uses it. Null
// when the path or the home folder cannot be named: the pane then counts every question as waiting.
export const messagesFolder = (isWindows: boolean, progress: string, home: string, runtime: string | undefined, isRuntimeOwn: boolean): string | null => {
  const key = addressKey(progress)
  if (key === null || home === '') return null
  const sep = isWindows ? '\\' : '/'
  const trimmed = (dir: string): string => dir.replace(/[\\/]+$/, '')
  const cache = [trimmed(home), '.cache', 'agent-board'].join(sep)
  const folder = isWindows ? (runtime ? [trimmed(runtime), 'agent-board'].join(sep) : cache) : runtime && isRuntimeOwn ? trimmed(runtime) : cache
  return [folder, `agent-board-${sha256(key).slice(0, 16)}-messages`].join(sep)
}
