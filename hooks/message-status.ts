import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { BOARD_RESTARTED, HOLDER_LOST, MOVED_ON, UNCONFIRMED, address, isEndedUncertain, isMailboxTarget } from './messaging'
import type { Message } from './messaging'
import { relativeTime } from './view'

// One status line for a message the board sent (plan-0.26.0.md B4, #1843), read from its stored receipt alone, so the
// terminal board, --print and --json say the same words. Sending is the page's own state while a send has no answer yet.
export const MESSAGE_STATES = ['sending', 'queued', 'delivered', 'read', 'answered', 'unsure', 'notDelivered'] as const
export type StatusState = typeof MESSAGE_STATES[number]
export type StatusTone = 'wait' | 'done' | 'alert'
export type MessageStatus = { state: StatusState; line: string; tone: StatusTone; updatedAt: number }
export type StatusMessage = Pick<Message, 'id' | 'status' | 'error' | 'reply' | 'updated' | 'claimed' | 'target'>
  & Partial<Pick<Message, 'hasAccepted' | 'line' | 'answers'>> & { isSurfaceLost?: boolean; wake?: 'sent' | 'failed' | 'started' | 'off' }

// A claim, and a message on a route that goes in now, read Unsure this long after their last event. A route that waits
// for a step's end or a turn has no clock and shows its age (owner, #1843 answers 2 and 3).
export const NOW_ROUTE_MS = 20_000

// The last message the board sent to a session, or with no session the one that answers a question: the message whose
// receipt the page shows on that card.
export const latestMessage = <T extends Pick<Message, 'to'> & { answers?: string }>(messages: readonly T[], agent: string, session: string | undefined, answers?: string): T | undefined => {
  if (session === undefined) return answers === undefined ? undefined : messages.filter(one => one.answers === answers).at(-1)
  const to = address(agent || 'claude', session)
  return messages.filter(one => one.to === to && (answers === undefined || one.answers === undefined || one.answers === answers)).at(-1)
}

const isNowRoute = (one: StatusMessage): boolean => one.line === 'now' || one.line === undefined && !isMailboxTarget(one.target)
const whenOf = (one: StatusMessage, s: Strings): string =>
  one.line === 'stepEnd' ? s.statusWhenStepEnd
    : one.line === 'afterWait' ? s.statusWhenAfterWait
      : one.line === 'chatOpen' ? s.statusWhenChatOpen
        : one.line === 'reopen' ? s.statusWhenReopen
          : s.statusWhenNextTurn
// The store takes the nonce ACK off a reply; a receipt kept from a version 1 store was acknowledged with the message id.
// A reply of several lines reads as one.
const replyOf = (one: StatusMessage): string => {
  const ack = `ACK ${one.id}`
  return (one.reply.startsWith(ack) && (one.reply.length === ack.length || /\s/.test(one.reply.charAt(ack.length))) ? one.reply.slice(ack.length) : one.reply).replace(/\s+/g, ' ').trim()
}
const unsureWhy = (one: StatusMessage, s: Strings): string =>
  one.error === HOLDER_LOST ? s.statusWhyHolderLost
    : one.error === BOARD_RESTARTED ? s.statusWhyRestarted
      : one.error === UNCONFIRMED ? s.statusWhyUnconfirmed
        : one.error === 'EXPIRED' ? s.statusWhyExpired
          : isEndedUncertain(one) ? s.statusWhyTurnStopped
            : /TIMEOUT/.test(one.error) ? s.statusWhyTimedOut
              : one.error === 'DISCONNECTED' || one.error === 'CONNECTION_LOST' ? s.statusWhyConnectionLost
                : s.statusWhyNoAnswer

// `reportedAt` is when the session last reported: an answer handed over before it reads Answered (owner, #1843 answer 5).
// Null for a message dismissed after it was handed out, which shows no line (answer 4).
export const messageStatus = (one: StatusMessage, now: number, s: Strings = ZH_TW, reportedAt?: number): MessageStatus | null => {
  const shown = (state: StatusState, line: string, tone: StatusTone): MessageStatus => ({ state, line, tone, updatedAt: one.updated })
  const unsure = (why: string): MessageStatus => shown('unsure', s.statusUnsure(why), 'alert')
  const notDelivered = (why: string): MessageStatus => shown('notDelivered', s.statusNotDelivered(why), 'alert')
  if (one.error === 'DISMISSED') return one.status === 'rejected' ? notDelivered(s.statusWhyTakenBack) : null
  const isHanded = one.status === 'acknowledged' || one.status === 'accepted' || one.hasAccepted === true
  if (one.answers !== undefined && isHanded && reportedAt !== undefined && reportedAt > one.updated) return shown('answered', s.statusAnswered, 'done')
  if (one.status === 'acknowledged') return shown('read', s.statusRead(replyOf(one)), 'done')
  // Once something took it, it is never said to be undelivered: a refusal after an acceptance reads Unsure (answer 4).
  if (one.status === 'rejected') return one.hasAccepted === true ? unsure(s.statusWhyDelivered)
    : notDelivered(one.error === 'STOPPED' ? s.statusWhyStopped : one.error === 'APP_STILL_OPEN' ? s.statusWhyAppOpen : one.error === MOVED_ON ? s.statusWhyMovedOn : s.statusWhyRefused)
  // A delivered message whose holder went away is never said to be delivered, nor queued again (answer 4).
  if (one.status === 'accepted') return one.error === '' ? shown('delivered', s.statusDelivered(relativeTime(one.updated, now, s)), 'done') : unsure(s.statusWhyDelivered)
  // Once something took it, it is never said to be undelivered, even when its mailbox now reads another surface.
  if (one.hasAccepted === true) return unsure(s.statusWhyDelivered)
  if (one.isSurfaceLost === true) return notDelivered(s.statusWhySurfaceLost)
  // Given up at the open limit before anything took it: it never left the board.
  if (one.status === 'uncertain' && one.error === 'EXPIRED' && one.claimed === 0) return notDelivered(s.statusWhyHeldTooLong)
  if (one.status === 'uncertain' && one.error !== '') return unsure(unsureWhy(one, s))
  // A message the Antigravity sidecar wakes is queued until the new turn takes it, so it says how the wake went (#1396). A
  // wake that was sent or started is on a route that goes in now, so it keeps the 20 s clock (#1843); one that failed or
  // has no sidecar waits for the next turn, which has none.
  if (one.status === 'queued' && one.wake !== undefined && (one.wake === 'failed' || one.wake === 'off' || now - one.updated < NOW_ROUTE_MS)) return shown('queued', one.wake === 'sent' ? s.agyWoken : one.wake === 'failed' ? s.agyWakeFailed : one.wake === 'started' ? s.agyWaking : s.agySidecarOff, 'wait')
  const hasClock = one.status === 'uncertain' || isNowRoute(one) || one.wake === 'sent' || one.wake === 'started'
  if (hasClock && now - one.updated >= NOW_ROUTE_MS) return unsure(s.statusWhyNoAnswer)
  return shown('queued', s.statusQueued(hasClock ? s.statusWhenNow : `${whenOf(one, s)} · ${relativeTime(one.updated, now, s)}`), 'wait')
}

// When the next message turns Unsure on the 20 s clock with no event of its own: the board wakes the pages waiting on it
// then, so they show the line as it turns (#1843, B4). Null when no message is on that clock.
export const nextStatusDeadline = (messages: readonly StatusMessage[], now: number): number | null => {
  const due = messages
    .filter(one => messageStatus(one, now)?.state === 'queued' && messageStatus(one, one.updated + NOW_ROUTE_MS)?.state === 'unsure')
    .map(one => one.updated + NOW_ROUTE_MS)
  return due.length === 0 ? null : Math.min(...due)
}
