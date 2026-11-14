import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'
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

// Only Codex's terminal has a live record of a queued message being taken
// (docs/validation/2026-11-12-codex-cli-mailbox-live.md; its second run, the one that checked this
// label, used `--no-daemon`). The app's hooks were seen firing once for progress
// (docs/validation/2026-10-24-parity-0.24.0.md), the editor extension's never.
// Codex 0.167 gives a turn-start hook no field naming the client of the turn, so the label says
// only what the hook can see: the session was started in the terminal (the history file's first
// record names `codex-tui`), and no other client's mark is in the hook's environment. Read from
// Codex 0.167's source and the app's and the extension's installed code, not seen in a live run:
// Codex copies its process environment into hooks; the desktop app and the editor extension start
// it with CODEX_INTERNAL_ORIGINATOR_OVERRIDE set to their own name, and its background service on
// Windows starts with CODEX_DAEMON_SHUTDOWN_SOCKET. Anything else, or no readable file, is the
// unknown surface, which the send gate refuses, so the page offers no Queue; that includes a
// terminal whose Codex runs under the Windows background service. A terminal session continued in
// another client that sets neither mark still reads as the terminal; the owner accepted that gap
// (the record's "Not covered" says so). Whether such a client gives the model a message its hook
// claims has no record.
// The label is read again at every turn-start hook. A hook that reads another surface does not
// claim a message saved with a surface (claimMessages in hooks/messaging.ts); a message saved
// without one, by an older board or from another agent's session, is not held to a surface.
const CODEX_CLIENT_VARIABLE = 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'
const CODEX_DAEMON_VARIABLE = 'CODEX_DAEMON_SHUTDOWN_SOCKET'
export const codexSurface = (meta: CodexMeta | null, client: string | undefined, daemon: string | undefined): string =>
  meta?.originator === 'codex-tui' && (client === undefined || client === 'codex-tui') && daemon === undefined ? SURFACE_IDS.cli : SURFACE_IDS.unknown

// Antigravity's CLI, desktop app and editor run the same hooks and send no client name, so the
// surface comes from the hook's transcript path (else its artifact folder): the folder name right
// after the last `.gemini` folder that is followed by one of the three names below.
// `antigravity-cli` gives agy TUI, `antigravity` and `antigravity-ide` give IDE (only the CLI and
// the app were run). Whole folder names are compared, so a look-alike folder is a surface the board
// does not know. A Map, so a folder named like a property every object inherits (`constructor`)
// is no surface either.
// Letter case is ignored on every system, by choice, though Linux and macOS tell `.Gemini` from `.gemini`.
const ANTIGRAVITY_FOLDERS: ReadonlyMap<string, string> = new Map([
  ['antigravity-cli', SURFACE_IDS.antigravityTui], ['antigravity', SURFACE_IDS.antigravityIde], ['antigravity-ide', SURFACE_IDS.antigravityIde],
])
const antigravityFolderSurface = (path: unknown): string => {
  if (typeof path !== 'string') return SURFACE_IDS.unknown
  // `.` and `..` are resolved first, so a folder the path leaves again does not name the surface.
  const parts = posix.normalize(path.replace(/\\/g, '/')).split('/').map(part => part.toLowerCase())
  for (let at = parts.length - 2; at >= 0; at -= 1) {
    const surface = parts[at] === '.gemini' ? ANTIGRAVITY_FOLDERS.get(parts[at + 1] ?? '') : undefined
    if (surface !== undefined) return surface
  }
  return SURFACE_IDS.unknown
}
export const antigravitySurface = (transcriptPath: unknown, artifactPath: unknown): string => {
  const surface = antigravityFolderSurface(transcriptPath)
  return surface !== SURFACE_IDS.unknown ? surface : antigravityFolderSurface(artifactPath)
}

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
    let setupError: string | null = null
    try { mailbox = hookMailbox(defaultMessagesDirectory(progress, home, process.env, process.platform), hookDeadline - Date.now()) } catch (error) {
      setupError = error instanceof Error && error.message ? error.message : 'MAILBOX_FAILED'
    }
    if (isSessionEnd(agent, event)) {
      try { await mailbox?.end(agent, session, Date.now()) } catch {}
    } else if (isTurnStart(agent, event)) {
      let message = null
      const transcript = raw.transcript_path
      const surface = agent === 'cursor' ? SURFACE_IDS.cursor : agent === 'antigravity' ? antigravitySurface(raw.transcriptPath, raw.artifactDirectoryPath)
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
      const failed = mailbox?.error ?? setupError
      if (mailbox?.hasDeferred) process.stderr.write(`${s.localAgentMailboxDeferred}\n`)
      else if (failed !== null) process.stderr.write(`${s.localAgentMailboxFailed(failed)}\n`)
    }
  }
  return false
}
