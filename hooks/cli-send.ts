import { ZH_TW, type Strings } from './i18n'
import { EN } from './strings-en'
import { agentLabel } from './strings'
import { address, type Connection, type Message } from './messaging'
import { relativeTime, type TaskRow } from './view'

export type SendCandidate = {
  connection: Connection
  project: string
  title: string
}

export type TargetResolution =
  | { kind: 'unique'; candidate: SendCandidate }
  | { kind: 'ambiguous'; candidates: SendCandidate[] }
  | { kind: 'none' }

export type RowMessage = Pick<Message, 'to' | 'status' | 'updated' | 'error'>

const MESSAGE_LABEL: Record<Message['status'], (s: Strings) => string> = {
  queued: s => s.messagesQueued,
  accepted: s => s.messagesAccepted,
  acknowledged: s => s.messagesAcknowledged,
  uncertain: s => s.messagesUncertain,
  rejected: s => s.messagesRejected,
}

const cleanOneLine = (text: string): string =>
  text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()

const tokenize = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/i).filter(Boolean)

const fieldScore = (query: string, raw: string): number => {
  const value = cleanOneLine(raw).toLowerCase()
  if (value === '') return 0
  if (value === query) return 3
  if (tokenize(value).includes(query)) return 2
  return value.includes(query) ? 1 : 0
}

const candidateScore = (query: string, candidate: SendCandidate, s: Strings): number => {
  const { connection } = candidate
  const fields = [
    connection.agent,
    agentLabel(connection.agent, s),
    agentLabel(connection.agent, EN),
    candidate.project,
    candidate.title,
  ]
  return fields.reduce((best, field) => Math.max(best, fieldScore(query, field)), 0)
}

export const sessionOfAddress = (addr: string): string => {
  const split = addr.indexOf(':')
  return split === -1 ? '' : addr.slice(split + 1)
}

export const resolveSendTarget = (
  query: string,
  candidates: readonly SendCandidate[],
  now: number,
  s: Strings,
  excludeAddress?: string,
): TargetResolution => {
  const clean = cleanOneLine(query).toLowerCase()
  if (clean === '') return { kind: 'none' }
  const scored = candidates
    .filter(one => one.connection.expires > now && address(one.connection.agent, one.connection.session) !== excludeAddress)
    .map(candidate => ({ candidate, score: candidateScore(clean, candidate, s) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) =>
      b.score - a.score
      || agentLabel(a.candidate.connection.agent, s).localeCompare(agentLabel(b.candidate.connection.agent, s))
      || a.candidate.project.localeCompare(b.candidate.project)
      || a.candidate.title.localeCompare(b.candidate.title),
    )
  const top = scored[0]?.score ?? 0
  if (top === 0) return { kind: 'none' }
  const winners = scored.filter(entry => entry.score === top).map(entry => entry.candidate)
  return winners.length === 1 ? { kind: 'unique', candidate: winners[0]! } : { kind: 'ambiguous', candidates: scored.map(entry => entry.candidate) }
}

export const formatSendCandidate = (candidate: SendCandidate, s: Strings): string =>
  [agentLabel(candidate.connection.agent, s), candidate.project, candidate.title]
    .map(cleanOneLine)
    .filter(Boolean)
    .join(' · ')

export const isSameWorkspaceAllowed = (
  senderDigest: string | undefined,
  targetDigest: string | undefined,
  isCrossProject: boolean,
): boolean => isCrossProject || (typeof senderDigest === 'string' && senderDigest !== '' && senderDigest === targetDigest)

export const formatPeerDeliveryHeader = (sender: { agent: string; title: string } | null, s: Strings = ZH_TW): string => {
  if (sender === null) return s.cliSendDeliveryUnverified
  const cleanTitle = sender.title
    .replace(/^\s*agent board message\b|reply first with this line alone|<<<\s*AB-|AB-[0-9a-f]{6,32}\s*>>>/gi, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  const name = agentLabel(sender.agent, s)
  return cleanTitle === '' ? s.cliSendDeliveryFromNoTitle(name) : s.cliSendDeliveryFrom(name, cleanTitle)
}

export const buildPeerMessageText = (sender: { agent: string; title: string } | null, body: string, s: Strings = ZH_TW): string =>
  `${formatPeerDeliveryHeader(sender, s)}\n\n${body.trim()}`

export const rowSessionAddresses = (row: Pick<TaskRow, 'agent' | 'nativeSession' | 'target'>): string[] => {
  const agent = row.agent || 'claude'
  const sessions = [row.nativeSession, row.target?.session].filter((one): one is string => typeof one === 'string' && one !== '')
  return [...new Set(sessions.map(session => address(agent, session)))]
}

export const latestRowMessage = (
  messages: readonly RowMessage[],
  row: Pick<TaskRow, 'agent' | 'nativeSession' | 'target'>,
): RowMessage | undefined => {
  const addrs = rowSessionAddresses(row)
  if (addrs.length === 0) return undefined
  let latest: RowMessage | undefined
  for (const one of messages) {
    if (!addrs.includes(one.to)) continue
    if (latest === undefined || one.updated >= latest.updated) latest = one
  }
  return latest
}

export const formatMessageStatus = (message: RowMessage, now: number, s: Strings): string => {
  const label = MESSAGE_LABEL[message.status](s)
  const when = Number.isFinite(message.updated) && message.updated > 0 && message.updated <= now ? relativeTime(message.updated, now, s) : ''
  return when === '' ? label : `${label} · ${when}`
}
