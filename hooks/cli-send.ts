import { type Strings } from './i18n'
import { EN } from './strings-en'
import { agentLabel } from './strings'
import { address, type Connection, type Message } from './messaging'
import { relativeTime, type TaskRow } from './view'

export type SendCandidate = {
  connection: Connection
  project: string
  title: string
  updated?: number
}

export type TargetResolution =
  | { kind: 'unique'; candidate: SendCandidate }
  | { kind: 'ambiguous'; candidates: SendCandidate[] }
  | { kind: 'none' }

export type RowMessage = Pick<Message, 'from' | 'to' | 'status' | 'updated' | 'error'>

const MESSAGE_LABEL: Record<Message['status'], (s: Strings) => string> = {
  queued: s => s.messagesQueued,
  accepted: s => s.messagesAccepted,
  acknowledged: s => s.messagesAcknowledged,
  uncertain: s => s.messagesUncertain,
  rejected: s => s.messagesRejected,
}

const cleanOneLine = (text: string): string =>
  text.replace(/[\r\n\t\0]+/g, ' ').replace(/\s+/g, ' ').trim()

export const sanitizeSenderTitle = (title: string, scrub: (text: string) => string = text => text): string =>
  cleanOneLine(scrub(title)
    .replace(/^\s*agent board message\b|reply first with this line alone|<<<\s*AB-|AB-[0-9a-f]{6,32}\s*>>>/gi, ' ')
    .replace(/"/g, "'"))
    .slice(0, 120)

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

export const formatSendCandidate = (
  candidate: SendCandidate,
  now: number,
  s: Strings,
  scrub: (text: string) => string = text => text,
): string => {
  const label = agentLabel(candidate.connection.agent, s)
  const project = cleanOneLine(scrub(candidate.project))
  const age = typeof candidate.updated === 'number' && Number.isFinite(candidate.updated) && candidate.updated > 0 && candidate.updated <= now
    ? relativeTime(candidate.updated, now, s)
    : ''
  return [label, project, age].filter(Boolean).join(' · ')
}

export const isSameWorkspaceAllowed = (
  senderDigest: string | undefined,
  targetDigest: string | undefined,
  isCrossProject: boolean,
): boolean => isCrossProject || (typeof senderDigest === 'string' && senderDigest !== '' && senderDigest === targetDigest)

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
    if (!addrs.includes(one.to) && !addrs.includes(one.from)) continue
    if (latest === undefined || one.updated >= latest.updated) latest = one
  }
  return latest
}

export const formatMessageStatus = (message: RowMessage, now: number, s: Strings): string => {
  const label = MESSAGE_LABEL[message.status](s)
  const when = Number.isFinite(message.updated) && message.updated > 0 && message.updated <= now ? relativeTime(message.updated, now, s) : ''
  return when === '' ? label : `${label} · ${when}`
}
