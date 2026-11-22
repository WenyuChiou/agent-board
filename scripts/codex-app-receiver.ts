// The Codex desktop app receiver (#557; the owner's 「做進去」, 2026-11-21). The app runs a private Codex server of its own,
// with no outside way into a conversation it shows. What the board can do, and the owner chose, is run the conversation's
// next turn in the background with Codex's own resume command, `codex exec resume <id> -`, once the app has let go of it.
// Codex itself decides that: while the app has the conversation loaded (shown, or another chat in view), any second writer
// is refused before anything is written ("thread-store conflict ... already has an active writer"), so no turn of the board
// can clash with one of the app's. Such a refusal sent nothing: the message goes back to the board's queue and is tried
// again `retryMs` later, for as long as an open message may wait (30 minutes), then refused as not sent. Every other outcome follows the shared background-resume rules (scripts/background-resume.ts and
// docs/MESSAGING.md, "Background resume"): the local board only, the person's default permission mode (no flags), never
// while the board reads a turn running, a dated live record before Send, and card wording that says the turn runs in the
// background. A run that may have reached the model and shows no `ACK <code>` line is `uncertain` and never run again.
import { isAbsolute } from 'node:path'
import { MAX_RESUME_WAIT, disallowedPermissionFlag, isFolder, parseResumeOutput, runBackgroundProcess } from './background-resume'
import type { Program, ProcessResult } from './background-resume'
import { boardClient, deliveryPrompt } from './message-client.mjs'
import { BACKGROUND_TURN_ENV } from '../hooks/hook-safety'
import { OPEN_LIMIT_MS, SURFACE_IDS } from '../hooks/messaging'
import type { RowState } from '../hooks/messaging'

// The receiver's record is hooks/receivers/codex-app.ts (the board's route table and the messaging matrix read it there).
const SURFACE = SURFACE_IDS.codexApp
// The name the desktop app gives itself in the first record of a conversation's history file (`originator`).
export const CODEX_APP_ORIGINATOR = 'Codex Desktop'
const THREAD = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const TICK_MS = 3000
const RETRY_MS = 30_000
// Codex's own words when another client holds the conversation (Codex 0.167 to 0.169, CLI and shared server alike). A
// thread-store conflict counts only when it names the active writer: any other conflict may have written something.
const WRITER_HELD = /thread-store conflict[^\n]*active writer|already has an active writer/i

// Whether a finished run is Codex refusing a second writer, which wrote nothing and asked the model nothing: it failed, it
// printed no reply at all, and its error says another writer holds the conversation. Anything else (a reply, an ACK, a
// timeout, any other error) may have reached the model and is never read as unsent.
export const isWriterHeld = (result: ProcessResult): boolean =>
  result.started && !result.timedOut && result.exitCode !== null && result.exitCode !== 0 && result.stdout.trim() === '' && WRITER_HELD.test(result.stderr)

// The board's address and token live only in this process, and the app's own name is not passed on: the resumed turn is the
// board's, not the app's. Everything else, the person's Codex home included, is what their own Codex reads. One mark is
// added, for the board's hooks in that run: its SessionEnd ends the run, not the conversation, which keeps waiting for the
// person (hooks/codex.ts; live run: without it the conversation read as ended after one background turn).
const childEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(env).filter(([name, value]) => typeof value === 'string' && !/^AGENT_BOARD_/i.test(name) && name.toUpperCase() !== 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE')),
  [BACKGROUND_TURN_ENV]: '1',
})

// The Codex program by full path, as the daemon receiver resolves it (resolveCodexExecutable): an `.exe` or a program is
// run as it is, and Codex's own script is run by this Node, so no shell ever reads an argument.
const programFor = (executable: string, args: readonly string[]): Program =>
  /\.m?js$/i.test(executable) ? { command: process.execPath, args: [executable, ...args], isShell: false } : { command: executable, args: [...args], isShell: false }

export type CodexAppSession = { id: string; dir: string }
type Attached = Awaited<ReturnType<ReturnType<typeof boardClient>['attach']>>

export const startCodexAppReceiver = ({
  boardUrl, sessions, stateOf, isTaken = () => false, executable, client,
  tickMs = TICK_MS, retryMs = RETRY_MS, pollMs = 2000, maxWaitMs = MAX_RESUME_WAIT,
  // A clock that never goes back, as the daemon receiver's.
  now = () => performance.now(), run = runBackgroundProcess, env = process.env, onError = () => undefined,
}: {
  boardUrl: string
  // The Codex desktop app conversations the board lists and has not read as ended, each with its own folder.
  sessions: () => readonly CodexAppSession[]
  // The board's reading of a conversation now; only `idle` takes a message.
  stateOf: (id: string) => RowState | undefined
  // A conversation the daemon receiver is attached to: that one has it, and two connections would contest the card.
  isTaken?: (id: string) => boolean
  executable: string
  client?: Pick<ReturnType<typeof boardClient>, 'attach'>
  tickMs?: number
  retryMs?: number
  pollMs?: number
  maxWaitMs?: number
  now?: () => number
  run?: typeof runBackgroundProcess
  env?: NodeJS.ProcessEnv
  onError?: (error: unknown) => void
}) => {
  if (!isAbsolute(executable ?? '')) throw new Error('EXPLICIT_EXECUTABLE_REQUIRED')
  // boardClient refuses any address but this computer's own (limit 1), before anything is attached.
  const board = client ?? boardClient(boardUrl)
  const attached = new Map<string, Attached>()
  const attaching = new Set<string>()
  // Conversations with a run in flight, and when one Codex refused may be tried again.
  const running = new Set<string>()
  const heldUntil = new Map<string, number>()
  // When Codex first refused each message (by the message's id) because the app held its conversation (`id`).
  const firstRefused = new Map<string, { id: string; at: number }>()
  let listed = new Map<string, string>(), isClosed = false, isTicking = false

  const isWanted = (id: string): boolean => !isClosed && listed.has(id) && !isTaken(id)
  // A conversation with a run in flight keeps its connection until the run's receipt is in, whatever the list says meanwhile:
  // closing it would leave the board a claim it lost the connection of (`uncertain`) for a turn that may well have run. The
  // board client counts a delivery as sending until its receipt has been sent, which is after the run is over.
  const isSending = (id: string): boolean => attached.get(id)?.isSending?.() === true
  const isKept = (id: string): boolean => !isClosed && (running.has(id) || isSending(id)) || isWanted(id)
  const giveBack = async (unsent: () => Promise<unknown>): Promise<undefined> => {
    try { await unsent() } catch (error) { onError(error) }
    return undefined
  }

  const attach = async (id: string): Promise<void> => {
    const one = await board.attach({
      agent: 'codex', session: id, scope: 'session', turn: 'session', surface: SURFACE, unclaimed: true, marksStart: true, pollMs, onError,
      verify: async () => isKept(id),
      canReceive: async () => !running.has(id) && now() >= (heldUntil.get(id) ?? 0) && stateOf(id) === 'idle' && isWanted(id),
      deliver: async (message: { id: string; nonce?: string; prompt?: string }, _accept: () => Promise<unknown>, begin: () => void, unsent: () => Promise<unknown>, starting: () => Promise<unknown>) => {
        const dir = listed.get(id)
        // Never mid-turn (limit 3): a conversation the board no longer reads as idle, or one this receiver is running, gets
        // nothing, and the claim goes back to the queue with its text.
        if (running.has(id) || stateOf(id) !== 'idle' || dir === undefined || !isWanted(id)) return giveBack(unsent)
        const args = ['exec', 'resume', '--skip-git-repo-check', id, '-']
        // Default permission mode only (limit 2): the arguments are constants and the conversation's id, never a flag.
        if (disallowedPermissionFlag(args) !== null) throw new Error('PERMISSION_MODE_DISALLOWED')
        // A folder that is gone runs nothing: the claim is refused with the reason.
        if (!isFolder(dir)) throw new Error('FOLDER_GONE')
        const prompt = deliveryPrompt(message)
        running.add(id)
        try {
          // Right before Codex is asked for anything: from then on a lost connection leaves the claim in doubt (#1507).
          try { await starting() } catch (error) { onError(error); return await giveBack(unsent) }
          // A turn that began while the board took that receipt, or a conversation it let go of meanwhile, gets nothing.
          if (stateOf(id) !== 'idle' || !isWanted(id)) return await giveBack(unsent)
          const result = await run(programFor(executable, args), { cwd: dir, stdin: prompt, maxWaitMs, env: childEnvironment(env) })
          // Nothing ran: the claim is refused with the reason, and nothing reached Codex.
          if (!result.started) throw new Error(result.spawnErrorCode === 'ENOENT' ? 'COMMAND_MISSING' : 'SPAWN_FAILED')
          if (isWriterHeld(result)) {
            // An app left open does not keep the message queued for ever: after the time an open message may wait, it is
            // refused as not sent, with the reason (nothing has begun, so the board client says `rejected`).
            const first = firstRefused.get(message.id)?.at ?? now()
            if (now() - first >= OPEN_LIMIT_MS) { firstRefused.delete(message.id); throw new Error('APP_STILL_OPEN') }
            firstRefused.set(message.id, { id, at: first })
            heldUntil.set(id, now() + retryMs)
            return await giveBack(unsent)
          }
          firstRefused.delete(message.id)
          // From here the turn may have reached the model: any failure is uncertain, and nothing runs it again.
          begin()
          if (result.timedOut) throw new Error('EXIT_TIMEOUT')
          if (result.exitCode !== 0) throw new Error('EXIT_FAILED')
          const parsed = parseResumeOutput(result.stdout, message.nonce ?? '')
          if (!message.nonce || parsed.receiptReply === null) throw new Error('ACK_REQUIRED')
          return parsed.receiptReply
        } finally {
          running.delete(id)
        }
      },
    })
    attached.set(id, one)
  }

  const tick = async (): Promise<void> => {
    if (isClosed || isTicking) return
    isTicking = true
    try {
      try {
        listed = new Map(sessions().filter(one => THREAD.test(one.id) && typeof one.dir === 'string' && one.dir !== '').map(one => [one.id, one.dir]))
      } catch (error) { onError(error); return }
      for (const [id, one] of [...attached]) {
        if (one.isClosed() || !isKept(id)) {
          attached.delete(id)
          if (!one.isClosed()) await one.close().catch(onError)
        }
      }
      for (const id of [...heldUntil.keys()]) if (!listed.has(id)) heldUntil.delete(id)
      for (const [key, one] of [...firstRefused]) if (!listed.has(one.id)) firstRefused.delete(key)
      for (const id of listed.keys()) {
        if (attached.has(id) || attaching.has(id) || !isWanted(id)) continue
        attaching.add(id)
        try { await attach(id) } catch (error) { if ((error as Error)?.message !== 'HOST_NOT_CONNECTED') onError(error) } finally { attaching.delete(id) }
      }
    } finally { isTicking = false }
  }

  const timer = setInterval(() => { void tick() }, tickMs)
  timer.unref?.()
  return {
    tick,
    // The conversations this receiver is attached to now.
    attached: () => [...attached.keys()],
    // How many background turns it is running now, or still sending the receipt of: the board does not stop for being
    // idle while one does.
    sending: () => new Set([...running, ...[...attached.keys()].filter(isSending)]).size,
    kill: () => {
      if (isClosed) return
      isClosed = true
      clearInterval(timer)
      for (const one of attached.values()) void one.close().catch(onError)
      attached.clear()
    },
  }
}
