import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { deliveryText, SURFACE_IDS } from '../hooks/messaging.ts'
import { isSessionEnd, isTurnStart, turnStartEnvelope } from '../hooks/hook-messages.ts'
import { sessionPushNote } from '../hooks/others.ts'
import { parseProgress } from '../hooks/parse.ts'
import { STRINGS } from '../hooks/strings.ts'
import type { CodexReport } from '../hooks/codex.ts'
import type { Strings } from '../hooks/i18n.ts'
import type { CodexMeta } from '../hooks/runs.ts'
import { hookMailbox } from './board-messaging.ts'
import { readSessionMeta } from './codex-history.ts'
import { defaultMessagesDirectory } from './runtime-folder.ts'

type Json = Record<string, unknown>

// Only Codex's terminal has a live record of taking a queued message
// (docs/validation/2026-11-12-codex-cli-mailbox-live.md, run with `--no-daemon`); the app's hooks were
// seen firing once for progress (docs/validation/2026-10-24-parity-0.24.0.md), the editor extension's never.
// Codex 0.167 gives a turn-start hook no field naming the client of the turn, so the label says
// only what the hook can see: the session was started in the terminal (the history file's first
// record names `codex-tui`), and no other client's mark is in the hook's environment. Read from
// Codex 0.167's source, not seen in a live run: Codex copies its process environment into hooks; the desktop app and the editor extension start it
// with CODEX_INTERNAL_ORIGINATOR_OVERRIDE set to their own name, and its background service on
// Windows starts with CODEX_DAEMON_SHUTDOWN_SOCKET. Anything else, or no readable file, is a
// surface the board does not know, so the page offers no Queue. A terminal session continued in
// another client that sets neither mark still reads as the terminal; the owner accepted that gap
// (the record's "Not covered" says so). Whether such a client gives the model a message its hook
// claims has no record.
const CODEX_CLIENT_VARIABLE = 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'
const CODEX_DAEMON_VARIABLE = 'CODEX_DAEMON_SHUTDOWN_SOCKET'
export const codexSurface = (meta: CodexMeta | null, client: string | undefined, daemon: string | undefined): string =>
  meta?.originator === 'codex-tui' && (client === undefined || client === 'codex-tui') && daemon === undefined ? SURFACE_IDS.cli : SURFACE_IDS.unknown

export type TurnDelivery = {
  mode: string
  agent: string
  event: string
  session: string
  report: CodexReport | undefined
  raw: Json
  folder: unknown
  base: string | null
  progress: string
  home: string
  root: string
  hookDeadline: number
  s: Strings
  // These stay in codex-local.ts, which owns the file lock, the deadline and the hash scheme;
  // importing them back would make the two files import each other.
  hash: (text: string) => string
  readLocal: (file: string) => string | null
  atomic: (file: string, text: string, current?: () => void, retryRecord?: boolean) => void
  checkDeadline: () => void
  hereNames: (cwd: unknown) => string[]
}

// The live turn-start hand-over, moved out of codex-local.ts unchanged. Returns true when the
// hook has already answered on stdout, so the caller must stop; false lets the caller carry on
// with its own output.
export const deliverTurnEvent = async (delivery: TurnDelivery): Promise<boolean> => {
  const { mode, agent, event, session, report, raw, folder, base, progress, home, root, hookDeadline, s, hash, readLocal, atomic, checkDeadline, hereNames } = delivery
  // Only the live event has a host reading stdout. A queued event and recovery never claim.
  if (mode !== '--codex-report' && report !== undefined && hookDeadline - Date.now() >= 300) {
    let mailbox: ReturnType<typeof hookMailbox> | undefined
    try { mailbox = hookMailbox(defaultMessagesDirectory(progress, home, process.env, process.platform), hookDeadline - Date.now()) } catch {}
    if (isSessionEnd(agent, event)) {
      try { await mailbox?.end(agent, session, Date.now()) } catch {}
    } else if (isTurnStart(agent, event)) {
      let message = null
      const transcript = raw.transcript_path
      const surface = agent === 'cursor' ? SURFACE_IDS.cursor : agent === 'antigravity' ? SURFACE_IDS.antigravityIde
        : agent === 'codex' ? codexSurface(typeof transcript === 'string' && transcript !== '' ? readSessionMeta(transcript, session) : null, process.env[CODEX_CLIENT_VARIABLE], process.env[CODEX_DAEMON_VARIABLE])
        : SURFACE_IDS.cli
      try { message = await mailbox?.turn(agent, session, surface, Date.now()) ?? null } catch {}
      const owner = hash(`${agent}:${session}`)
      const recordFile = join(root, 'sessions', `${owner}.json`)
      let pushed: string[] = []
      try {
        const saved = readLocal(recordFile)
        const parsed = saved === null ? null : JSON.parse(saved) as { pushed?: unknown }
        if (Array.isArray(parsed?.pushed)) pushed = parsed.pushed.filter((one): one is string => typeof one === 'string')
      } catch {}
      let pushResult: { note: string | null; keys: string[] } = { note: null, keys: [] }
      try {
        const text = readLocal(progress)
        if (text !== null) {
          const here = [...hereNames(raw.cwd ?? folder), report.project].filter(name => name !== '')
          const isGeneric = Object.values(STRINGS).some(one => [one.codexTask, one.localAgentTask(agent)].includes(report.title))
          pushResult = sessionPushNote(parseProgress(text), here, {
            sessionId: owner.slice(0, 8), agent, resume: session,
            ...(isGeneric ? {} : { title: report.title }), steps: report.steps,
          }, new Set(pushed), Date.now(), s)
        }
      } catch {}
      if (message !== null || pushResult.note !== null) {
        let hasWritten = false
        try {
          const combined = [message === null ? '' : deliveryText(message, s), pushResult.note ?? ''].filter(Boolean).join('\n\n')
          const envelope = turnStartEnvelope(agent, event, combined, base, session)
          await new Promise<void>((done, fail) => process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`, error => error ? fail(error) : done()))
          hasWritten = true
        } catch {}
        if (hasWritten && message !== null) try { await mailbox?.accept(agent, session, message.id, message.nonce, Date.now()) } catch {}
        if (hasWritten && pushResult.keys.length > 0) {
          try {
            const saved = readLocal(recordFile)
            if (saved !== null) {
              const record = JSON.parse(saved) as Json
              const nextPushed = [...new Set([...pushed, ...pushResult.keys])].slice(-64)
              atomic(recordFile, `${JSON.stringify({ ...record, pushed: nextPushed }, null, 2)}\n`, checkDeadline, true)
            }
          } catch {}
        }
        return true
      }
      if (mailbox?.hasDeferred) process.stderr.write(`${s.localAgentMailboxDeferred}\n`)
    }
  }
  return false
}
