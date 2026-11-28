// The board's page for `agent-board.mjs --serve`: a server on 127.0.0.1 with a random token in
// its address (and, asked by `--serve --lan`, a second one on a local network address with a
// token of its own, for a phone), and the agents' commands a reply from the page starts. What the page shows and
// what a press does are worked out in hooks/serve.ts; the writes are the terminal board's own
// (board-cli.ts passes them in), so the page changes progress.md the way the pane does.
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, unlinkSync, watch as fsWatch, writeSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, networkInterfaces } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { deliveryTargets } from '../hooks/hook-messages'
import { placeOf } from '../hooks/board-dock'
import type { Rect } from '../hooks/board-dock'
import { boardItems } from '../hooks/board'
import type { BoardAction, PendingTurn } from '../hooks/board'
import type { Strings } from '../hooks/i18n'
import { agentLabel } from '../hooks/strings'
import type { ReceiverRoutes } from '../hooks/messaging'
import { address, agentOf, isRecordedRoute } from '../hooks/messaging'
import type { SendDecision } from '../hooks/messaging'
import { RECEIVER_ROUTES } from '../hooks/receiver-routes'
import { cardSendKey, handledOnly, isSame, lanAddress, localHosts, pagePolicy, replyText, requestProblem, routeText, sendKey, sendPlan, serveAction, serveModel, servePage, sessionState, worktreeRepoName } from '../hooks/serve'
import type { AgentTarget, View } from '../hooks/view'
import { RELEASED } from '../hooks/released'
import { isFolder, runSendPlan } from './background-resume'
import { createMessaging, readTurnLog } from './board-messaging'
import { messageStatus, nextStatusDeadline } from '../hooks/message-status'
import { watchBoard } from './board-watch'
import type { BoardWatch, WatchFn } from './board-watch'
import { startCodexReceiver } from './codex-receiver.mjs'
import { startCodexAppReceiver } from './codex-app-receiver'
import type { CodexAppSession } from './codex-app-receiver'
import { setupAgents } from './setup-discovery.mjs'
import { repoLookup } from './repo-lookup'
import type { ProgressBinding } from '../hooks/messaging'
import { isBarStyle } from '../hooks/progress-bar'
import type { BarStyle } from '../hooks/progress-bar'
import { isSettingsLang } from '../hooks/board-settings'
import type { SettingsLang } from '../hooks/board-settings'
import type { SettingsAgentControl } from './settings-agents'
import { APPROVAL_DRAW_MS, APPROVAL_GRACE_MS, APPROVAL_KEY_MS, APPROVAL_MAX, APPROVAL_PAGE_MS, APPROVAL_PRESS_MS, APPROVAL_SECRET_MS, APPROVAL_WINDOW_MS, approvalOf, approvalPlace, approvalsOffFile, approvalsPayload, approvalsRefusedFile, approvalRefusalNote, approvalTitle, decisionOf, isAskingMode, journalStep, parseApprovalRefusal, pressProblem, readAsk, readPress } from '../hooks/approvals'
import type { Approval, ApprovalDecision, ApprovalRefusal, ApprovalRefusalReason } from '../hooks/approvals'

export type ServeOptions = {
  allowResume?: boolean
  // The receivers' records in place of the built-in ones (the tests' stand-in, see board-cli.ts).
  routes?: readonly ReceiverRoutes[]
  messagesDirectory: string
  isDefaultMessagesDirectory?: boolean
  // The Codex receiver (#318): the Codex session ids the board knows, the Codex program to run (null: none found,
  // so nothing runs). A running turn is never steered (#1409). appSessions: the Codex desktop app conversations, for the
  // receiver that runs their next turn in the background once the app has let go of them (#557); none, no such receiver.
  // appHome: the Codex home `--codex-dir` named, where they were found, which those runs read too.
  codex?: { threads: () => string[]; executable: string | null; unloadMs?: number; clients?: () => Promise<unknown[]>; appSessions?: () => CodexAppSession[]; appHome?: string }
  reports?: (isFresh?: boolean) => ProgressBinding[]
  s: Strings
  port: number
  // What the server answers a second `--serve` with, so it can tell it is the same board.
  ping: Record<string, unknown>
  view: () => View
  pending: (isFresh?: boolean) => PendingTurn[]
  // A tick or an archive, written the way the terminal board writes one: the line to show.
  act: (action: BoardAction) => string
  // Restores the last Archive or Confirm done press matching its offer token (#566).
  undo?: (token?: string) => { ok: boolean; note: string; retryUndo?: boolean }
  undoToken?: () => string | null
  dropUndo?: () => void
  // Every finished task to the archive now: the line to show.
  tidy: () => string
  // A bulk archive in two steps: a preview names the count, a confirm archives it.
  bulkTidy?: (request: { kind: 'preview'; selector: import('../hooks/tidy').TidySelector } | { kind: 'confirm'; token: string; preview: import('../hooks/tidy').TidyPreview } | { kind: 'cancel'; token: string }) => { ok: boolean; note: string; token?: string; preview?: import('../hooks/tidy').TidyPreview; count?: number }
  // The Clean up button: the sweep `--tidy` runs (agent blocks by age; hand-kept tasks only once the
  // move is on, #464), the line to show.
  clean: () => string
  // The progress bar's style (#1085): read from the board's settings file, and written there by
  // Settings so the pane and the terminal board show the same pick.
  barStyle?: () => BarStyle
  setBarStyle?: (style: BarStyle) => { result: 'ok' | 'invalid' | 'unsafe'; lockLeft?: string }
  language?: () => SettingsLang
  setLanguage?: (lang: SettingsLang) => { result: 'ok' | 'invalid' | 'unsafe'; lockLeft?: string }
  isLangOverridden?: () => boolean
  // Where the person last put the docked window (#1084), kept in its own file beside progress.md.
  setWindow?: (place: Rect) => boolean
  agents?: SettingsAgentControl
  sweep: () => void
  sweepMs: number
  paste: (text: string, reviewToken?: string) => { isAdded: boolean; note: string; review?: { token: string; current: string; incoming: string } }
  // Why the board or a press could not be made when it met a file the board could not read or
  // write (the note the terminal board shows), or null for an error of any other kind. A phone
  // on the network is told the file's name only, as it is never told progress.md's path.
  failure: (error: unknown, isLan: boolean) => string | null
  // False when the server cannot be found again (its address file could not be written): it
  // stops then, rather than run on where no one can reach it.
  onReady: (url: string, port: number) => boolean
  onStop: () => void
  onListenError?: (error: NodeJS.ErrnoException) => void
  // The hub of the default folder could not publish its owner record: it has stopped and given its lock back (#1472 review).
  onStoreError?: (error: unknown) => void
  idleMs: number
  // Opens the page in the person's browser at this address (with its one-time approval key) and
  // says whether a window opened. Absent: the board script opens the page itself, and that page
  // cannot answer approvals. `null`: this board opens no window where it runs (over SSH, a test's
  // board) and tried nothing. A rejection counts as tried, so the caller does not try again.
  open?: (url: string, asApp: boolean) => Promise<boolean | null>
  // A journal line for an approval answered on the board: its hash and first words only.
  journal?: (entry: { project: string; task: string; step: string }) => void
  // The tests' shorter waits; the board uses APPROVAL_DRAW_MS, APPROVAL_PRESS_MS, APPROVAL_SECRET_MS,
  // APPROVAL_GRACE_MS and APPROVAL_PAGE_MS.
  approvalTimes?: { drawMs: number; pressMs: number; secretMs?: number; graceMs?: number; pageMs?: number }
  // How long a replaced server keeps HTTP open after dropping locks/receivers so an open tab can read `{ moved: true }` (#1335).
  movedGraceMs?: number
  // progress.md and its inbox folder, watched so an open board request is answered as soon as either changes (#359).
  // `fs` is the tests' stand-in for fs.watch. Absent: no watch, and waiting requests are checked on the timer.
  watch?: { progress: string; inbox: string; fs?: WatchFn }
  // The tests' shorter waits for an open board request; the board uses BOARD_HOLD_MS and BOARD_FALLBACK_MS.
  boardTimes?: { holdMs?: number; fallbackMs?: number }
  // Address file path used to locate sibling approvals-off and approvals-refused state files.
  addressFile?: string
  // Wall clock override and one-use open-link lifetime override for tests.
  now?: () => number
  openLinkMs?: number
  // The tests' shorter wait for a window to load the page /api/open opened; the board uses OPEN_REDEEM_MS.
  openRedeemMs?: number
  // The tests' smaller cap on one-use open links kept at once; the board keeps OPEN_LINK_MAX.
  openLinkMax?: number
}

type Result = { ok: boolean; note: string }

const isWindows = process.platform === 'win32'

const MAX_BODY = 64 * 1024
// The page on the local network stops after this long without a request from it, so an
// address a phone was given does not stay open for the page's whole life.
const LAN_IDLE = 10 * 60 * 1000

// An open board request (#359) is answered "no change" after this long, so the page's clock, ages and the
// server's view of which page is visible stay as fresh as they were with the old 2 s poll.
const BOARD_HOLD_MS = 10_000
// Without a working file watch, waiting requests look at the board this often: a change still shows within 3 s, and
// the board is built no more often than main's page asked for it (every 2 s), so idle cost cannot rise even when a
// watch is judged deaf by mistake.
const BOARD_FALLBACK_MS = 2000
// Changes within this long of each other wake the waiting requests once.
const BOARD_WAKE_MS = 25
// While a request waits on a working watch, the two watched paths are stat-ed this often (no file is read), so a watch
// that set up but never reports is found and the timer takes over: the change still shows within 3 s.
const BOARD_PROBE_MS = 1500

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
const REFUSAL_MAX_BYTES = 4096
const REFUSAL_PROBE_MS = 5000
const OPEN_LINK_MS = 10 * 60 * 1000
const OPEN_LINK_MAX = 64
// The board keeps this many page sessions, the least recently used going first; a session has no
// other lifetime, so a page left open for days keeps working while its board runs (#1650).
const PAGE_SESSION_MAX = 64
// After its opener says yes, /api/open waits this long for the window to load the page, so a board
// command says "opened" only when the page really was (#1650).
const OPEN_REDEEM_MS = 5000

type RawRefusal = { reason: ApprovalRefusalReason; at: string } | 'unreadable' | null

const isRealDir = (dir: string): boolean => {
  try {
    const stat = lstatSync(dir)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

const isOffMarkerAt = (addressFile: string): boolean => {
  try {
    lstatSync(approvalsOffFile(addressFile))
    return true
  } catch (error) {
    // Fail closed on unreadable/ambiguous paths, matching scripts/claude-approval.mjs.
    return (error as NodeJS.ErrnoException)?.code !== 'ENOENT'
  }
}

const writeOffMarker = (addressFile: string, atIso: string): boolean => {
  const offPath = approvalsOffFile(addressFile)
  if (!isRealDir(dirname(offPath))) return false
  let fd: number
  try {
    fd = openSync(offPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') return false
    try {
      const stat = lstatSync(offPath)
      return stat.isFile() && !stat.isSymbolicLink()
    } catch {
      return false
    }
  }
  // The file is ours now. If it cannot be written or closed it goes again: an empty marker would turn
  // approvals off for the hook while the page says the switch failed.
  let isOpen = true
  try {
    writeSync(fd, `${JSON.stringify({ at: atIso })}\n`)
    isOpen = false
    closeSync(fd)
    return true
  } catch {
    if (isOpen) try { closeSync(fd) } catch {}
    try { unlinkSync(offPath) } catch {}
    return false
  }
}

const removeOffMarker = (addressFile: string): boolean => {
  const offPath = approvalsOffFile(addressFile)
  if (!isRealDir(dirname(offPath))) return false
  try {
    const stat = lstatSync(offPath)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    unlinkSync(offPath)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
  }
}

const readRawRefusal = (addressFile: string): RawRefusal => {
  const record = approvalsRefusedFile(addressFile)
  let lst
  try {
    lst = lstatSync(record, { bigint: true })
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : 'unreadable'
  }
  if (!lst.isFile() || lst.isSymbolicLink() || lst.size > BigInt(REFUSAL_MAX_BYTES)) return 'unreadable'
  let fd: number
  try {
    fd = openSync(record, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    return 'unreadable'
  }
  let raw: string
  try {
    const fst = fstatSync(fd, { bigint: true })
    if (!fst.isFile() || fst.size > BigInt(REFUSAL_MAX_BYTES) || (lst.ino !== 0n && (fst.dev !== lst.dev || fst.ino !== lst.ino))) return 'unreadable'
    const buf = Buffer.allocUnsafe(REFUSAL_MAX_BYTES + 1)
    let total = 0
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, null)
      if (n === 0) break
      total += n
    }
    if (total > REFUSAL_MAX_BYTES) return 'unreadable'
    raw = buf.toString('utf8', 0, total)
  } catch {
    return 'unreadable'
  } finally {
    try { closeSync(fd) } catch {}
  }
  const parsed = parseApprovalRefusal(raw)
  return parsed ?? 'unreadable'
}

const formatRefusal = (raw: RawRefusal, lastPassedAskAt: number, s: Strings): ApprovalRefusal | undefined => {
  if (raw === null) return undefined
  if (raw === 'unreadable') return { reason: 'unreadable', at: null, note: approvalRefusalNote('unreadable', s) }
  // Ignore a stale refusal stamped before or alongside a passing hook check.
  if (Date.parse(raw.at) <= lastPassedAskAt) return undefined
  return { reason: raw.reason, at: raw.at, note: approvalRefusalNote(raw.reason, s) }
}

const versionParts = (version: string): number[] => version.split('.').map(Number)
const isNewerVersion = (candidate: string, current: string): boolean => {
  const next = versionParts(candidate)
  const held = versionParts(current)
  for (let index = 0; index < 3; index += 1) {
    if ((next[index] ?? 0) !== (held[index] ?? 0)) return (next[index] ?? 0) > (held[index] ?? 0)
  }
  return false
}
export const boardVersion = RELEASED.reduce((highest, release) => {
  return isNewerVersion(release.version, highest) ? release.version : highest
}, '0.0.0')
const packageVersionValue = process.env.AGENT_BOARD_PACKAGE_VERSION ?? ''
// A later launcher that reuses this server reports the package it runs from, so the page
// notice follows the newest package (#1304). These change on that refresh, never on a request.
let packageVersion: string | null = /^\d+\.\d+\.\d+$/.test(packageVersionValue) ? packageVersionValue : null

// How to update this install, for the page notice when the package is newer than the board
// script (#1304). An independent install names the setup preview, with the same agents and
// data folder the launcher names; a plugin-written copy names the plugin update. The package
// name is the published one: this bundle ships only in @wenyuchiou/agent-board.
// The folder as a literal shell argument, quoted the way setup quotes its own commands
// (scripts/setup-agent.mjs `quote`): bare when it holds only word, dot, slash, colon, at,
// equals, comma or dash characters, else single-quoted, so `$`, backticks and double quotes in
// a custom folder reach the shell unchanged. A double-quoted folder would let the shell expand
// `$` and backticks. That helper lives in the setup script, which runs on import, so this is
// the same rule written here, not an import.
export const quoteArg = (value: string): string => /^[\w./:@=,-]+$/.test(value) ? value : process.platform === 'win32'
  ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
const olderScriptUpdate = (): { update: 'setup' | 'plugin'; command?: string; lanCommand?: string } | undefined => {
  if (packageVersion === null) return undefined
  const prelude = (globalThis as { AGENT_BOARD?: { codexRoot?: unknown } }).AGENT_BOARD ?? {}
  if (typeof prelude.codexRoot !== 'string') return { update: 'plugin' }
  let root = resolve(prelude.codexRoot)
  // Only what setup sets up: setup refuses a retired agent in any selection that is
  // not a removal (#1327), so a retained install-gemini.json from an earlier Gemini
  // CLI setup must not put gemini back into the update command.
  const targets = setupAgents
  const listed = (folder: string): string[] | undefined => { try { return readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() && /^install-.+\.json$/.test(entry.name)).map(entry => entry.name.slice(8, -5)).filter(agent => targets.includes(agent)).sort() } catch { return undefined } }
  let agents = listed(root)
  // A moved data folder: the board script's own folder is where the board is now.
  if (!agents) { root = dirname(process.argv[1] ?? ''); agents = listed(root) ?? [] }
  const agentOpts = agents.length ? ` --agent ${agents.join(',')}` : ''
  const dataOpts = root !== join(homedir(), '.agent-board') ? ` --data-dir ${quoteArg(root)}` : ''
  const base = `npx @wenyuchiou/agent-board@${packageVersion} setup`
  // The page on the local network is plain HTTP: its advice is the same command without the
  // data folder, built here beside the full one, so no path can survive redaction (#1304).
  return { update: 'setup', command: `${base}${agentOpts}${dataOpts}`, lanCommand: `${base}${agentOpts}` }
}
let olderScript = olderScriptUpdate()

// The package a later launcher reports, when it is newer than the one this server started
// with: an older launcher reusing the server must not take the notice away, and a version
// that is not three numbers is not a package at all. Pending messages are untouched: only
// the two values the next /api/board answer reads change.
const refreshPackageVersion = (version: string): boolean => {
  if (!/^\d+\.\d+\.\d+$/.test(version) || (packageVersion !== null && !isNewerVersion(version, packageVersion))) return false
  packageVersion = version
  olderScript = olderScriptUpdate()
  return true
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

// A JSON object of at most 64 KB, or null.
const readBody = (req: IncomingMessage): Promise<Record<string, unknown> | null> =>
  new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

// A press names its step by its file line; anything else is no line, so the press ticks
// the next step by text, as before.
const lineOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined)

export const startServer = (o: ServeOptions): void => {
  const messaging = (() => {
    try {
      return createMessaging(o.messagesDirectory, o.isDefaultMessagesDirectory, {
        routes: o.routes ?? RECEIVER_ROUTES, stateOfSession: (agent, session) => sessionState(o.view(), agent, session),
        // An Antigravity conversation's turn log, read fresh at each wake call (#1396).
        turnsOfSession: (agent, session) => readTurnLog(o.messagesDirectory, agent, session),
        // Read only when the board sends an answer to a question (#1843, B3.2).
        reportedAt: (agent, session) => Math.max(-1, ...(o.reports?.() ?? []).filter(one => one.agent === agent && one.session === session).map(one => one.updated)),
      })
    }
    // The code (EACCES, EPERM) goes along, so the person gets advice that fits the cause.
    catch (error) { throw Object.assign(new Error(error instanceof Error ? error.message : '', { cause: 'MESSAGE_STORE_FAILED' }), { code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined }) }
  })()
  const token = randomBytes(24).toString('base64url')
  const sending = new Set<string>()
  const repoOf = repoLookup(worktreeRepoName)
  // The last answer of each session the page sent to, until the next send to that session. One
  // entry per session at most; the page shows those that came after it loaded.
  const replies = new Map<string, Result & { at: number; key: string }>()
  let port = 0
  let lastSeen = Date.now()
  // Open board requests (#359). A page that already has the board sends its etag and x-board-wait: 1; when
  // nothing changed the answer waits here until the file watch, a press, an approval or a reply wakes it, or
  // until BOARD_HOLD_MS passes (then 304). Nothing reads a file while a request waits and the watch works.
  // Without a working watch, waiting requests are checked every BOARD_FALLBACK_MS instead.
  // Who waits: the page's id ('' on the network), its approval secret, whether it said it was in sight, and on which side.
  type WaitingPage = { id: string; secret: string; isVisible: boolean; isLan: boolean }
  type Waiter = WaitingPage & { wake: () => void; drop: () => void }
  const waiters = new Set<Waiter>()
  let boardWatch: BoardWatch | null = null
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  let fallbackTimer: ReturnType<typeof setInterval> | null = null
  let probeTimer: ReturnType<typeof setInterval> | null = null
  // Several changes in a burst (a hook writes the inbox and progress.md) wake the waiting requests once.
  const wakeAll = (): void => {
    if (wakeTimer !== null || waiters.size === 0) return
    wakeTimer = setTimeout(() => {
      wakeTimer = null
      for (const one of [...waiters]) one.wake()
    }, BOARD_WAKE_MS)
  }
  // A message on a route that goes in now reads Unsure 20 s after its last event, with no write to wake the pages that
  // wait on the board: a timer wakes them then, and is set again from the store (#1843, B4).
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null
  const clearDeadline = (): void => {
    if (deadlineTimer === null) return
    clearTimeout(deadlineTimer)
    deadlineTimer = null
  }
  const syncDeadline = (): void => {
    clearDeadline()
    if (waiters.size === 0) return
    const now = Date.now()
    let at: number | null
    try { at = nextStatusDeadline(messaging.snapshot(now).messages, now) } catch { return }
    if (at === null) return
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null
      for (const one of [...waiters]) one.wake()
      syncDeadline()
    }, Math.max(0, at - now) + 1)
  }
  const syncFallback = (): void => {
    const isNeeded = waiters.size > 0 && !(boardWatch?.isWatching() ?? false)
    if (isNeeded && fallbackTimer === null) fallbackTimer = setInterval(wakeAll, o.boardTimes?.fallbackMs ?? BOARD_FALLBACK_MS)
    else if (!isNeeded && fallbackTimer !== null) {
      clearInterval(fallbackTimer)
      fallbackTimer = null
    }
    const isProbed = waiters.size > 0 && (boardWatch?.isWatching() ?? false)
    if (isProbed && probeTimer === null) probeTimer = setInterval(() => boardWatch?.probe(), BOARD_PROBE_MS)
    else if (!isProbed && probeTimer !== null) {
      clearInterval(probeTimer)
      probeTimer = null
    }
  }
  // recheck answers when the board changed and says whether it did; last always answers.
  // A page whose request waits here is still open, as it was while it asked every 2 s: the windows sized for that poll
  // (an approval's watching page, APPROVAL_PAGE_MS; the board command's open-window check; the idle exit) see it as
  // having asked just now. Only a page in sight counts as watching or as activity; a hidden one only stays open (#359).
  const touchPage = (one: WaitingPage, now: number): void => {
    if (!one.isLan && one.id !== '') {
      const page = pages.get(one.id)
      if (page !== undefined) page.at = now
    }
    const held = one.secret === '' ? undefined : pageSecrets.get(one.secret)
    if (held !== undefined) {
      held.seen = now
      if (one.isVisible) held.watched = now
    }
    if (one.isVisible) {
      if (one.isLan) { if (lan !== null) lan.lastSeen = now }
      else lastSeen = now
    }
  }
  const touchWaiting = (now: number): void => {
    for (const one of waiters) touchPage(one, now)
  }
  const holdBoard = (res: ServerResponse, page: WaitingPage, recheck: () => boolean, last: () => boolean): void => {
    const { id } = page
    const seq = id === '' ? 0 : pages.get(id)?.seq ?? 0
    let isDone = false
    const done = (): void => {
      if (isDone) return
      isDone = true
      clearTimeout(timer)
      waiters.delete(waiter)
      if (waiters.size === 0) clearDeadline()
      // The page asked until this moment, so it counts as having asked now: an approval that arrives before its next
      // request (a round trip away) still finds it watching. A page already dropped (replaced, gone) is not brought back.
      touchPage(page, Date.now())
      syncFallback()
    }
    const settle = (answer: () => boolean): void => {
      if (isDone) return
      let isAnswered = true
      try {
        // A page replaced while it waited is told so, as its next request would be (#265).
        const isSuperseded = id !== '' && !isMoved && (isRetiredPage(id) || (seq > 0 && activeMaxSeq > seq))
        if (isSuperseded) {
          pages.delete(id)
          retirePage(id)
          dropPageSecrets(id)
        }
        if (isMoved || isSuperseded) {
          if (isMoved && id !== '') movedWaiting.delete(id)
          if (isMoved) res.once('finish', () => { if (movedWaiting.size === 0 && movedReleased) setImmediate(finish) })
          json(res, 200, { moved: true })
        } else isAnswered = answer()
      } catch {
        if (!res.headersSent) json(res, 500, {})
      }
      if (isAnswered) done()
    }
    const waiter: Waiter = { ...page, wake: () => settle(recheck), drop: done }
    const timer = setTimeout(() => settle(last), o.boardTimes?.holdMs ?? BOARD_HOLD_MS)
    res.once('close', done)
    waiters.add(waiter)
    syncFallback()
    syncDeadline()
  }
  // Which board pages are open (#265). A page names itself in x-board-page on every poll; loading the page counts until its
  // first poll. The terminal board and other scripts read GET /api/board without that header and do not count. A page that
  // says it left is dropped alone, so another page that is still open stays counted. Only a page that reported itself visible
  // counts as a window the person can see; a hidden or minimized one does not. When a newer page has asked, an older page is
  // told it was replaced and stops asking.
  const pages = new Map<string, { seq: number; at: number; visible: boolean }>()
  let loadedAt = 0
  let pageSeq = 0
  // Pages told they were replaced. They stay replaced: a poll already on its way when the page stopped must not make it the newest again.
  // Up to RETIRED_EXACT_LIMIT recent ids sit in an exact Set; evicted older ids spill into a fixed 64 KB Bloom filter
  // so forgotten unkeyed ids still stay retired with bounded memory (#1474).
  const retired = new Set<string>()
  const RETIRED_EXACT_LIMIT = 4096
  const RETIRED_BLOOM_BITS = 1 << 19
  let retiredOverflow: Uint32Array | null = null
  const bloomDigest = (id: string): Buffer => createHash('sha256').update(id).digest()
  const markOverflow = (id: string): void => {
    const filter = retiredOverflow ??= new Uint32Array(RETIRED_BLOOM_BITS >>> 5)
    const digest = bloomDigest(id)
    for (let offset = 0; offset < 24; offset += 4) {
      const bit = digest.readUInt32BE(offset) & (RETIRED_BLOOM_BITS - 1)
      const word = bit >>> 5
      filter[word] = (filter[word] ?? 0) | (1 << (bit & 31))
    }
  }
  const hasOverflow = (id: string): boolean => {
    const filter = retiredOverflow
    if (filter === null) return false
    const digest = bloomDigest(id)
    for (let offset = 0; offset < 24; offset += 4) {
      const bit = digest.readUInt32BE(offset) & (RETIRED_BLOOM_BITS - 1)
      if (((filter[bit >>> 5] ?? 0) & (1 << (bit & 31))) === 0) return false
    }
    return true
  }
  const isRetiredPage = (id: string): boolean => retired.has(id) || hasOverflow(id)
  let activeMaxSeq = 0
  const retirePage = (id: string): void => {
    if (id === '') return
    retired.add(id)
    // A bound on the memory: oldest exact ids move to the fixed Bloom filter once retired passes RETIRED_EXACT_LIMIT.
    while (retired.size > RETIRED_EXACT_LIMIT) {
      const evicted = retired.values().next().value as string
      retired.delete(evicted)
      markOverflow(evicted)
    }
  }
  // A page that has not asked for this long no longer stands for a newer page (a backgrounded tab asks about once a minute).
  const PAGE_STALE_MS = 150_000
  const pageIdOf = (headers: IncomingMessage['headers']): string => {
    const id = text(headers['x-board-page'])
    return /^[\w-]{1,64}$/.test(id) ? id : ''
  }
  // How long ago a visible page last loaded or asked; null when none did.
  const pageAgo = (now: number): number | null => {
    touchWaiting(now)
    let latest = loadedAt
    for (const one of pages.values()) if (one.visible && one.at > latest) latest = one.at
    return latest === 0 ? null : now - latest
  }
  let isStopping = false
  let isMoved = false
  let movedReleased = false
  let movedTimer: ReturnType<typeof setTimeout> | null = null
  const movedWaiting = new Set<string>()
  let isFinished = false
  // The page on the local network: its own server, address and token, so the computer's token
  // never crosses the network.
  let lan: { server: Server; host: string; token: string; url: string; lastSeen: number } | null = null
  let lanOpening: Promise<{ url: string } | { note: string }> | null = null
  // Approvals (D3, #1318). The press needs a secret that only a page the board opened holds: the
  // board opens the browser itself with a one-time key after the address's #, which is never in
  // the address file, on standard output or in a reply, and the page trades it once for its
  // secret, which it keeps in memory only. A command that reads the address file has the token
  // and nothing more. The key does pass on the browser's command line: a used key stays known
  // until it expires, and a second use of it turns approvals off (see the pair route).
  const pairKeys = new Map<string, { until: number; secret: string }>()
  // Each page secret: which page holds it, that page's order (when known), when it was given,
  // when that page last asked for the board with it, and when it did so while visible.
  const pageSecrets = new Map<string, { page: string; seq: number; pairedAt: number; seen: number; watched: number }>()
  const dropPageSecrets = (id: string): void => {
    if (id === '') return
    for (const [secret, held] of pageSecrets) if (held.page === id) pageSecrets.delete(secret)
  }
  const dropOlderSecrets = (id: string, seq: number, now: number): void => {
    for (const [other, held] of pageSecrets) if (now - held.seen > secretMs || (id !== '' && held.page !== '' && held.page !== id && held.seq < seq)) pageSecrets.delete(other)
  }
  // A pairing key used twice: no page answers approvals again until the board restarts.
  let isApprovalOff = false
  // One-use page open links and the non-URL sessions they mint (M8a, #1650).
  const openLinks = new Map<string, { until: number; used: boolean; pairKey: string }>()
  const pageSessions = new Map<string, number>()
  // /api/open waits on these to learn whether the window it opened loaded its code.
  const redeemWaiters = new Map<string, () => void>()
  const clockNow = o.now ?? Date.now
  // Null when the table is full of codes that may still be wanted: the caller answers busy and opens nothing.
  const mintOpenLink = (now: number, pairKey = ''): string | null => {
    for (const [code, entry] of openLinks) if (entry.until < now) openLinks.delete(code)
    // A used code with no key has nothing left to catch, so it goes first. A used code with a key is the
    // record that tells a replay from the person's own window: it stays until it expires and does not
    // count toward the cap (the 16 pair keys bound those). An unused code may be the link a command
    // just printed, or one an /api/open waits on, so it is never pushed out: a full table says no (#1650).
    for (const [code, entry] of openLinks) if (entry.used && entry.pairKey === '') openLinks.delete(code)
    let unused = 0
    for (const entry of openLinks.values()) if (!entry.used) unused += 1
    if (unused >= (o.openLinkMax ?? OPEN_LINK_MAX)) return null
    const code = randomBytes(24).toString('base64url')
    openLinks.set(code, { until: now + (o.openLinkMs ?? OPEN_LINK_MS), used: false, pairKey })
    return code
  }
  const mintPageSession = (now: number): string => {
    if (pageSessions.size >= PAGE_SESSION_MAX) pageSessions.delete(pageSessions.keys().next().value as string)
    const id = randomBytes(24).toString('base64url')
    pageSessions.set(id, now)
    return id
  }
  const livePageSession = (candidate: string, now: number): string => {
    if (candidate === '') return ''
    if (!pageSessions.has(candidate)) return ''
    pageSessions.delete(candidate)
    pageSessions.set(candidate, now)
    return candidate
  }
  // A host asked for an approval since the board started: only then does an open page that cannot
  // answer one make the board script open another.
  let hasAsked = false
  // A page that held no secret pressed the approvals switch: the next board command opens a keyed page.
  let isSwitchWanted = false
  let lastPassedAskAt = 0
  let isUserOff = o.addressFile !== undefined && isOffMarkerAt(o.addressFile)
  let rawRefusal: RawRefusal = null
  let isApprovalFilesDirty = true
  let lastApprovalFilesReadAt = 0
  let isApprovalWatchLive = false
  let approvalWatcher: FSWatcher | null = null
  const refreshApprovalFiles = (now: number): void => {
    if (o.addressFile === undefined) return
    if (isApprovalWatchLive && !isApprovalFilesDirty && now - lastApprovalFilesReadAt < REFUSAL_PROBE_MS) return
    isUserOff = isOffMarkerAt(o.addressFile)
    rawRefusal = readRawRefusal(o.addressFile)
    isApprovalFilesDirty = false
    lastApprovalFilesReadAt = now
  }
  const secretMs = o.approvalTimes?.secretMs ?? APPROVAL_SECRET_MS
  const graceMs = o.approvalTimes?.graceMs ?? APPROVAL_GRACE_MS
  // The sessions whose first press the person confirmed on the page.
  const confirmed = new Set<string>()
  type Pending = { item: Approval; answer?: ((decision: ApprovalDecision | null) => void) | undefined; timers: ReturnType<typeof setTimeout>[] }
  const approvals = new Map<string, Pending>()
  const secretOf = (headers: IncomingMessage['headers'], now: number): string => {
    const secret = text(headers['x-board-approve'])
    const held = secret === '' || isApprovalOff ? undefined : pageSecrets.get(secret)
    if (held === undefined) return ''
    // A page that stopped asking, left, or was replaced takes its secret with it (#1378).
    if (now - held.seen > secretMs || (held.page !== '' && isRetiredPage(held.page))) {
      pageSecrets.delete(secret)
      return ''
    }
    if (held.page !== '' && pageIdOf(headers) !== held.page) return ''
    return secret
  }
  const isWatched = (now: number): boolean => { touchWaiting(now); return !isApprovalOff && [...pageSecrets.values()].some(held => now - held.seen <= secretMs && now - held.watched < (o.approvalTimes?.pageMs ?? APPROVAL_PAGE_MS)) }
  // A page that can answer approvals is still open, if only behind another window.
  const hasLiveSecret = (now: number): boolean => { touchWaiting(now); return !isApprovalOff && [...pageSecrets.values()].some(held => now - held.seen <= secretMs) }
  // The hook's answer: a decision, or none, and the host's own prompt asks. The request then stays
  // on its row a minute as asked in its window, with no button.
  const settleApproval = (id: string, decision: ApprovalDecision | null): void => {
    const pending = approvals.get(id)
    if (pending === undefined) return
    wakeAll()
    pending.timers.forEach(clearTimeout)
    pending.timers = []
    const answer = pending.answer
    pending.answer = undefined
    if (decision === null) {
      pending.item = { ...pending.item, state: 'window' }
      const gone = setTimeout(() => { approvals.delete(id); wakeAll() }, APPROVAL_WINDOW_MS)
      // Holds no process open: a board that stops forgets it anyway.
      gone.unref()
      pending.timers.push(gone)
    } else approvals.delete(id)
    answer?.(decision)
  }
  const turnApprovalsOff = (): void => {
    isApprovalOff = true
    pageSecrets.clear()
    for (const [id, pending] of [...approvals]) if (pending.answer !== undefined) settleApproval(id, null)
  }

  const closeLan = (): void => {
    if (lan === null) return
    lan.server.close()
    lan.server.closeAllConnections()
    lan = null
  }

  let codexReceiver: ReturnType<typeof startCodexReceiver> | null = null
  let codexAppReceiver: ReturnType<typeof startCodexAppReceiver> | null = null
  const isBusySending = (): boolean => sending.size > 0 || (codexReceiver?.sending() ?? 0) > 0 || (codexAppReceiver?.sending() ?? 0) > 0

  const closeNonServer = (): void => {
    // A lock a scanner holds for a moment must not stop the page from closing; the next start recovers the pid once this process is gone.
    try { messaging.close() } catch {}
    closeLan()
  }

  const finish = (): void => {
    if (isFinished) return
    isFinished = true
    if (movedTimer !== null) {
      clearTimeout(movedTimer)
      movedTimer = null
    }
    closeNonServer()
    boardWatch?.close()
    try { approvalWatcher?.close() } catch {}
    approvalWatcher = null
    if (wakeTimer !== null) clearTimeout(wakeTimer)
    for (const one of [...waiters]) one.drop()
    if (probeTimer !== null) clearInterval(probeTimer)
    if (fallbackTimer !== null) clearInterval(fallbackTimer)
    clearDeadline()
    server.close()
    server.closeAllConnections()
    o.onStop()
  }

  const stop = (moved = false): void => {
    if (isStopping) {
      if (!moved && isMoved) {
        isMoved = false
        if (movedReleased) finish()
      }
      return
    }
    isStopping = true
    // The Codex desktop app receiver lets go of its board connections; a turn it already started runs on in Codex.
    codexAppReceiver?.kill()
    for (const id of [...approvals.keys()]) settleApproval(id, null)
    for (const one of approvals.values()) one.timers.forEach(clearTimeout)
    approvals.clear()
    if (moved) {
      const now = Date.now()
      for (const [id, one] of pages) if (now - one.at < PAGE_STALE_MS) movedWaiting.add(id)
      pages.clear()
    }
    if (moved && movedWaiting.size > 0) {
      isMoved = true
      // Pages waiting on the board hear at once that it moved.
      for (const one of [...waiters]) one.wake()
      movedTimer = setTimeout(finish, o.movedGraceMs ?? 5_000)
      const released = (): void => {
        movedReleased = true
        closeNonServer()
        if (!isMoved || movedWaiting.size === 0) finish()
      }
      if (codexReceiver === null) released()
      else void Promise.race([codexReceiver.close().catch(() => undefined), new Promise(done => setTimeout(done, 1500))]).then(released)
      return
    }
    if (codexReceiver === null) {
      finish()
      return
    }
    // The receiver says goodbye to the board before it goes, and the Codex program it runs is ended; the wait is short.
    void Promise.race([codexReceiver.close().catch(() => undefined), new Promise(done => setTimeout(done, 1500))]).then(finish)
  }

  // On the same port as the computer's page when it is free there, else on any.
  const listenLan = (address: string): Promise<{ url: string } | { note: string }> =>
    new Promise(done => {
      const token = randomBytes(16).toString('base64url')
      const lanServer = createServer((req, res) => {
        handle(req, res, true).catch(() => {
          if (!res.headersSent) json(res, 500, {})
        })
      })
      const attempt = (at: number): void => {
        const fail = (error: NodeJS.ErrnoException): void => {
          // The first try's callback would fire too once the second one listens.
          lanServer.removeAllListeners('listening')
          if (at !== 0 && error.code === 'EADDRINUSE') return attempt(0)
          done({ note: o.s.serveLanFailed })
        }
        lanServer.once('error', fail)
        lanServer.listen(at, address, () => {
          lanServer.off('error', fail)
          lanServer.on('error', closeLan)
          const host = `${address}:${(lanServer.address() as AddressInfo).port}`
          lan = { server: lanServer, host, token, url: `http://${host}/?t=${token}`, lastSeen: Date.now() }
          done({ url: lan.url })
        })
      }
      attempt(port)
    })

  const openLan = (wanted: string | null): Promise<{ url: string } | { note: string }> => {
    // Asked again, it gives the same address with its 10 minutes counted afresh, so the code
    // just printed does not close before the phone opens it.
    if (lan !== null) {
      lan.lastSeen = Date.now()
      return Promise.resolve({ url: lan.url })
    }
    if (lanOpening !== null) return lanOpening
    const address = lanAddress(networkInterfaces(), wanted)
    if (address === null) return Promise.resolve({ note: wanted !== null && /^[\d.]+$/.test(wanted) ? o.s.serveLanNotOurs(wanted) : o.s.serveLanNone })
    lanOpening = listenLan(address).finally(() => {
      lanOpening = null
    })
    return lanOpening
  }

  // One reply at a time per session, in the background: the page asks for the board every 3
  // seconds and the answer comes with it, however long the agent takes.
  const send = (target: AgentTarget, reply: string, title: string, cardKey: string): { status: number; note: string } => {
    const plan = sendPlan(target, reply, process.platform === 'win32')
    if (plan === null) return { status: 409, note: o.s.serveSendNone(agentLabel(target.agent, o.s)) }
    const label = `${agentLabel(target.agent, o.s)} · ${title}`
    if (plan.cwd !== null && !isFolder(plan.cwd)) return { status: 409, note: o.s.serveSendFailed(label, o.s.serveFolderGone(basename(plan.cwd))) }
    const key = sendKey(target)
    if (sending.has(key)) return { status: 409, note: o.s.serveSendBusy(agentLabel(target.agent, o.s)) }
    sending.add(key)
    sending.add(cardSendKey(cardKey))
    replies.delete(key)
    runSendPlan(plan, o.s, label)
      .then(result => replies.set(key, { ...result, at: Date.now(), key: cardKey }))
      .catch((error: unknown) => replies.set(key, { ok: false, note: o.s.serveSendFailed(label, String(error)), at: Date.now(), key: cardKey }))
      .finally(() => { sending.delete(key); sending.delete(cardSendKey(cardKey)); wakeAll() })
    return { status: 202, note: o.s.serveQueued(label) }
  }

  // `isLan`: the request came to the page on the local network.
  const handle = async (req: IncomingMessage, res: ServerResponse, isLan = false): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const isPage = req.method === 'GET' && url.pathname === '/'
    const side = isLan ? lan : null
    if (isLan && side === null) return json(res, 404, {})
    const hosts = side === null ? localHosts(port) : [side.host]
    if (!isLan && url.pathname.startsWith('/open/')) {
      if (!hosts.includes((req.headers.host ?? '').toLowerCase())) return json(res, 421, {})
      if (req.method !== 'GET') return json(res, 405, {})
      if (isMoved) return json(res, 410, { moved: true })
      if (/prefetch/i.test(text(req.headers['sec-purpose']) || text(req.headers.purpose))) return json(res, 403, {})
      // A link used, expired or never made (one from scrollback, or a model's earlier reply) gets the
      // page with no session, which says how to get a fresh link, not a bare refusal (#1650).
      const deadLink = (): void => {
        const nonce = randomBytes(16).toString('base64')
        res.writeHead(403, {
          ...HEADERS,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': pagePolicy(nonce),
          'x-frame-options': 'DENY',
        })
        res.end(servePage(o.s, nonce, false, o.idleMs, o.language?.(), o.isLangOverridden?.() ?? false, ''))
      }
      const code = url.pathname.slice('/open/'.length)
      if (!/^[\w-]{16,128}$/.test(code)) return deadLink()
      const now = clockNow()
      const entry = openLinks.get(code)
      if (entry === undefined) return deadLink()
      if (entry.until < now) {
        openLinks.delete(code)
        return deadLink()
      }
      if (entry.used) {
        if (entry.pairKey !== '') turnApprovalsOff()
        return deadLink()
      }
      if (entry.pairKey !== '') entry.used = true
      else openLinks.delete(code)
      redeemWaiters.get(code)?.()
      const session = mintPageSession(now)
      loadedAt = Date.now()
      lastSeen = loadedAt
      const nonce = randomBytes(16).toString('base64')
      res.writeHead(200, {
        ...HEADERS,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': pagePolicy(nonce),
        'x-frame-options': 'DENY',
      })
      res.end(servePage(o.s, nonce, false, o.idleMs, o.language?.(), o.isLangOverridden?.() ?? false, session))
      return
    }
    if (!isLan && isPage && !url.searchParams.has('t')) {
      if (!hosts.includes((req.headers.host ?? '').toLowerCase())) return json(res, 421, {})
      if (isMoved) return json(res, 410, { moved: true })
      const nonce = randomBytes(16).toString('base64')
      res.writeHead(200, {
        ...HEADERS,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': pagePolicy(nonce),
        'x-frame-options': 'DENY',
      })
      res.end(servePage(o.s, nonce, false, o.idleMs, o.language?.(), o.isLangOverridden?.() ?? false, ''))
      return
    }
    const authNow = clockNow()
    const headerToken = isPage ? '' : text(req.headers['x-board-token'])
    const pageSession = !isLan && !isPage ? livePageSession(headerToken, authNow) : ''
    const isClientToken = side === null && !isPage && pageSession === '' && isSame(headerToken, token)
    const problem = requestProblem(
      {
        method: req.method ?? '',
        host: req.headers.host ?? '',
        origin: req.headers.origin ?? '',
        contentType: req.headers['content-type'] ?? '',
        token: isPage ? (url.searchParams.get('t') ?? '') : (pageSession !== '' ? token : headerToken),
      },
      hosts,
      side === null ? token : side.token,
    )
    if (problem !== null) return json(res, problem, {})
    // A press, a send, a message or a tidy can change the board: an open board request looks again once it is answered.
    // A connector's poll comes every 2 s per connector; only one that hands out a message wakes it (replyMessage).
    if (req.method !== 'GET' && url.pathname !== '/api/messages/poll') res.once('finish', wakeAll)
    const replyMessage = (action: string, payload: Record<string, unknown>): void => {
      // A browser can send or dismiss a message, but cannot impersonate a receiving host adapter.
      if (!['send', 'dismiss'].includes(action) && (!isClientToken || req.headers.origin !== undefined)) return json(res, 403, {})
      try {
        const result = messaging.act(action, payload, Date.now(), action === 'expect' ? o.reports?.() : undefined)
        if (action === 'poll' && ((result as { messages?: unknown[] }).messages?.length ?? 0) > 0) res.once('finish', wakeAll)
        return json(res, 200, result)
      }
      catch (error) {
        // A temporary file lock is storage unavailability, not a stale binding.
        // Only the owner's lease-bounded poller retries; sends and receipts do not.
        const code = (error as { code?: unknown } | null)?.code
        if (['EPERM', 'EBUSY', 'EAGAIN'].includes(String(code))) return json(res, 503, { error: 'MESSAGE_STORE_BUSY' })
        return json(res, 409, { error: error instanceof Error ? error.message : 'MESSAGE_FAILED' })
      }
    }
    if (isMoved) {
      if (!isLan && req.method === 'GET' && url.pathname === '/api/board') {
        const id = pageIdOf(req.headers)
        if (id !== '') movedWaiting.delete(id)
        res.once('finish', () => { if (movedWaiting.size === 0 && movedReleased) setImmediate(finish) })
        return json(res, 200, { moved: true })
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (body === null) return json(res, 400, {})
        if (!isLan && url.pathname === '/api/page-gone') {
          const id = pageIdOf(req.headers)
          if (id !== '') movedWaiting.delete(id)
          res.once('finish', () => { if (movedWaiting.size === 0 && movedReleased) setImmediate(finish) })
          return json(res, 200, {})
        }
        if (url.pathname === '/api/close') {
          if (body.moved !== true) res.once('finish', () => setImmediate(() => stop(false)))
          return json(res, 200, {})
        }
        // Before closeNonServer() closes messaging, let codexReceiver disconnect and any in-flight receipt finish cleanly (#1335).
        if (!isLan && !movedReleased && url.pathname.startsWith('/api/messages/')) {
          const action = url.pathname.slice('/api/messages/'.length)
          if (['disconnect', 'receipt', 'mailbox-accept', 'mailbox-ack'].includes(action)) {
            return replyMessage(action, body)
          }
        }
      }
      return json(res, 410, { moved: true })
    }
    if (!isLan && isPage) loadedAt = Date.now()
    let isReplaced = false
    if (!isLan && req.method === 'GET' && url.pathname === '/api/board' && pageIdOf(req.headers) !== '') {
      const now = Date.now()
      const id = pageIdOf(req.headers)
      const rawSecret = text(req.headers['x-board-approve'])
      // Even if retired's FIFO bound forgot an old id, an unseen page presenting an unrecognised approval secret
      // cannot allocate a new pageSeq or displace a live keyed page (#1474).
      if (isRetiredPage(id) || (!pages.has(id) && rawSecret !== '' && secretOf(req.headers, now) === '')) {
        // A retired page already dropped its secrets when it left or was replaced; keep its late poll
        // from allocating a fresh pageSeq or disturbing any other page's secret (#1378).
        isReplaced = true
        pages.delete(id)
      } else {
        const mine = pages.get(id)?.seq ?? ++pageSeq
        const superseded = activeMaxSeq > mine || [...pages.entries()].some(([other, one]) => other !== id && one.seq > mine && now - one.at < PAGE_STALE_MS)
        isReplaced = superseded
        if (isReplaced) {
          pages.delete(id)
          retirePage(id)
          dropPageSecrets(id)
        } else {
          pages.set(id, { seq: mine, at: now, visible: req.headers['x-board-visible'] !== '0' })
          // A newer page: an older one waiting on the board hears now that it was replaced.
          if (mine > activeMaxSeq) { activeMaxSeq = mine; wakeAll() }
          // Any secret bound to an older page is retired once a newer page asks for the board (#1378).
          dropOlderSecrets(id, mine, now)
        }
      }
      // A page asking with its secret keeps it; only a visible one counts as watching for approvals.
      const held = isReplaced ? undefined : pageSecrets.get(secretOf(req.headers, now))
      if (held !== undefined) {
        if (held.page === '') {
          held.page = id
          held.seq = pages.get(id)!.seq
        }
        held.seen = now
        if (req.headers['x-board-visible'] !== '0') held.watched = now
      }
      // Pages that stopped asking long ago (a crashed window) are forgotten.
      if (pages.size > 32) for (const [other, one] of pages) if (now - one.at > 300_000) pages.delete(other)
    }
    // A hidden tab waiting on the board (#359) is not someone using it: a tab left open behind others does not keep an idle
    // server, or the address a phone was given, alive. A tab in sight still counts while it waits, so the server does not
    // go while someone reads the board; so do loading the page, a request for the whole board and every press.
    const isWaitingAsk = req.method === 'GET' && url.pathname === '/api/board' && req.headers['x-board-wait'] === '1' && req.headers['x-board-visible'] === '0'
    if (!url.pathname.startsWith('/api/messages/') && !isWaitingAsk) {
      lastSeen = Date.now()
      if (side !== null) side.lastSeen = lastSeen
    }
    if (isPage) {
      const nonce = randomBytes(16).toString('base64')
      res.writeHead(200, { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': pagePolicy(nonce), 'x-frame-options': 'DENY' })
      res.end(servePage(o.s, nonce, isLan, o.idleMs, o.language?.(), o.isLangOverridden?.() ?? false, ''))
      return
    }
    if (req.method === 'GET') {
      if (url.pathname === '/api/agents' && o.agents !== undefined) {
        try {
          if (url.searchParams.has('agent') || url.searchParams.has('action')) {
            if (isLan) return json(res, 403, {})
            const result = await o.agents.preview(url.searchParams.get('agent'), url.searchParams.get('action'))
            return json(res, result.status, result)
          }
          const rows = await o.agents.rows()
          return json(res, 200, { rows: isLan ? rows.map(row => ({ agent: row.agent, name: row.name, state: row.state, button: null })) : rows })
        } catch (error) {
          return json(res, 409, { note: o.failure(error, isLan) ?? o.s.settingsAgentsReadFailed })
        }
      }
      if (url.pathname === '/api/board') {
        // An older page stops asking: it shows one line that the board moved to the newer page (#265).
        if (isReplaced) return json(res, 200, { moved: true })
        // A file the board cannot read is named on the page, which would otherwise say it is offline. The page
        // is always the grouped one; the old ?group=agent address asks for what every address gets now.
        const ifNoneMatch = req.headers['if-none-match']
        // Answers with the board, or with the note of a file it could not read; an unchanged board is
        // answered (304) only when isLast, and otherwise left waiting. Says whether it answered.
        const answer = (isLast: boolean): boolean => {
          try {
            const now = Date.now()
            const view = o.view()
            const state = messaging.snapshot(now, o.reports?.(false))
            const group = { now, repoOf, versions: { board: boardVersion, package: packageVersion }, unreadable: view.unreadable ?? [], ...(olderScript === undefined ? {} : { olderScript }) }
            // The page on the network learns only that an approval waits: no command, no button, no off-switch or refusal.
            if (!isLan) refreshApprovalFiles(now)
            const refusal = !isLan ? formatRefusal(rawRefusal, lastPassedAskAt, o.s) : undefined
            const approvalsShown = approvalsPayload([...approvals.values()].map(one => one.item), view, isLan, !isLan && secretOf(req.headers, now) !== '', o.s, { isLockdown: isApprovalOff, isOff: !isLan && isUserOff, refusal })
            const payload = { model: serveModel(view, o.pending(false), o.s, sending, isLan, isLan ? handledOnly(state) : state, o.allowResume, group, o.routes), replies: [...replies.values()], messaging: isLan ? undefined : state, barStyle: o.barStyle?.() ?? 'ink', lang: o.language?.() ?? 'auto', now, ...(approvalsShown === undefined ? {} : { approvals: approvalsShown }) }
            // The page already compares its clock at minute precision. Keep that refresh boundary
            // without treating each millisecond as changed content; replies and receipts stay exact.
            const fingerprint = JSON.stringify(payload, (key, value) => key === 'now' ? Math.floor(value / 60000) : value)
            const etag = `W/"${createHash('sha256').update(fingerprint).digest('hex')}"`
            const matches = ifNoneMatch?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.slice(2))
            if (matches) {
              if (!isLast) return false
              res.writeHead(304, { ...HEADERS, etag })
              res.end()
              return true
            }
            res.writeHead(200, { ...HEADERS, etag, 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(payload))
            return true
          } catch (error) {
            const note = o.failure(error, isLan)
            if (note === null) {
              process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
              json(res, 500, { note: o.s.pressFailed })
              return true
            }
            json(res, 409, { note })
            return true
          }
        }
        // Only a page that holds the board it would be answered with waits; the terminal board and scripts never do.
        const wantsWait = req.headers['x-board-wait'] === '1' && ifNoneMatch !== undefined && !isStopping
        if (answer(!wantsWait)) return
        const waitingNow = Date.now()
        holdBoard(res, { id: isLan ? '' : pageIdOf(req.headers), secret: isLan ? '' : secretOf(req.headers, waitingNow), isVisible: req.headers['x-board-visible'] !== '0', isLan }, () => answer(false), () => answer(true))
        return
      }
      // Only the board script on the computer asks; the answer names progress.md's path.
      // wantsKeyedPage: approvals are in use and no open page can answer them, so the board script
      // opens one with a key rather than pointing at a page that cannot. A paired page that is only
      // hidden still can; before any host asked, the page that is open is enough.
      if (url.pathname === '/api/ping' && !isLan) {
        if (!isClientToken) return json(res, 403, {})
        return json(res, 200, { ...o.ping, sending: [...sending].filter(one => !one.startsWith('card:')).length + (codexReceiver?.sending() ?? 0) + (codexAppReceiver?.sending() ?? 0), pageAgo: pageAgo(Date.now()), wantsKeyedPage: o.open !== undefined && !isApprovalOff && (hasAsked || isUserOff || isSwitchWanted) && !hasLiveSecret(Date.now()) })
      }
      return json(res, 404, {})
    }
    const body = await readBody(req)
    if (body === null) return json(res, 400, {})
    if (url.pathname === '/api/open-link') {
      if (isLan || !isClientToken || req.headers.origin !== undefined) return json(res, 403, {})
      const code = mintOpenLink(clockNow())
      if (code === null) return json(res, 503, { error: 'busy' })
      return json(res, 200, { url: `http://127.0.0.1:${port}/open/${code}` })
    }
    if (url.pathname === '/api/page-gone' && !isLan) {
      // The page is gone for good: a poll of it that was already on its way must not bring it back as an open page.
      // Its approval secret retires at once so /api/ping asks for a keyed page right away (#1378).
      const gone = pageIdOf(req.headers)
      pages.delete(gone)
      if (gone !== '') {
        retirePage(gone)
        dropPageSecrets(gone)
      }
      loadedAt = 0
      return json(res, 200, {})
    }
    if (url.pathname === '/api/open' || url.pathname === '/api/approvals/ask' || url.pathname === '/api/approvals/pair' || url.pathname === '/api/approvals/switch' || url.pathname === '/api/approvals/drawn' || url.pathname === '/api/approvals/press') {
      // Never from the page on the network.
      if (isLan) return json(res, 403, {})
      const now = Date.now()
      // The host's hook asks, as a script on the computer: a web page always sends an Origin.
      if (url.pathname === '/api/approvals/ask') {
        if (!isClientToken || req.headers.origin !== undefined) return json(res, 403, {})
        const ask = readAsk(body)
        if (ask === null) return json(res, 400, {})
        // No decision where the host would not ask the person: refused, and nothing is shown.
        if (!isAskingMode(ask.mode)) return json(res, 403, {})
        hasAsked = true
        lastPassedAskAt = Math.max(lastPassedAskAt, clockNow())
        // Approvals turned off (by replay lockdown or the page switch), or too many kept: the host asks in its own window.
        if (isApprovalOff || (o.addressFile !== undefined && isOffMarkerAt(o.addressFile))) return json(res, 200, {})
        for (const [id, one] of [...approvals]) {
          if (approvals.size < APPROVAL_MAX) break
          if (one.answer !== undefined) continue
          one.timers.forEach(clearTimeout)
          approvals.delete(id)
        }
        if (approvals.size >= APPROVAL_MAX) return json(res, 200, {})
        const item = approvalOf(ask, randomBytes(12).toString('base64url'), now, homedir(), isWindows, o.s)
        const pending: Pending = { item, timers: [] }
        approvals.set(item.id, pending)
        wakeAll()
        // No turn, or no page in front of the person that can answer it: the host asks at once.
        if (item.state === 'window' || !isWatched(now)) {
          settleApproval(item.id, null)
          return json(res, 200, {})
        }
        // The answer can take 30 seconds: the headers go now, so the hook tells a board that waits
        // from one that hangs, and gives up on the second within seconds.
        res.writeHead(200, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' })
        res.flushHeaders()
        await new Promise<void>(done => {
          let isDone = false
          pending.answer = decision => {
            if (isDone) return
            isDone = true
            res.end(JSON.stringify(decision === null ? {} : { decision }))
            done()
          }
          // The page did not say it drew it: nobody is looking, so the host asks.
          pending.timers.push(setTimeout(() => { if (approvals.get(item.id)?.item.state === 'asking') settleApproval(item.id, null) }, o.approvalTimes?.drawMs ?? APPROVAL_DRAW_MS))
          pending.timers.push(setTimeout(() => settleApproval(item.id, null), o.approvalTimes?.pressMs ?? APPROVAL_PRESS_MS))
          // The hook went away (its host answered in its own window, or stopped): the item goes.
          res.on('close', () => {
            if (isDone) return
            isDone = true
            const left = approvals.get(item.id)
            if (left !== undefined) {
              left.timers.forEach(clearTimeout)
              approvals.delete(item.id)
              // Its buttons leave the page now.
              wakeAll()
            }
            done()
          })
        })
        return
      }
      if (url.pathname === '/api/open') {
        // Only the board script on the computer asks the board to open its page.
        if (o.open === undefined) return json(res, 404, {})
        if (!isClientToken || req.headers.origin !== undefined) return json(res, 403, {})
        for (const [key, one] of pairKeys) if (one.until < now) pairKeys.delete(key)
        // A used key stays known until it expires, so it is never pushed out early; past this many
        // in two minutes, or with approvals off, the page opens with no key.
        const key = isApprovalOff || pairKeys.size >= 16 ? '' : randomBytes(24).toString('base64url')
        if (key !== '') pairKeys.set(key, { until: now + APPROVAL_KEY_MS, secret: '' })
        const openCode = mintOpenLink(clockNow(), key)
        if (openCode === null) {
          pairKeys.delete(key)
          return json(res, 503, { error: 'busy' })
        }
        let isRedeemed = false
        const redeemed = new Promise<void>(done => redeemWaiters.set(openCode, () => { isRedeemed = true; done() }))
        const tried = await o.open(`http://127.0.0.1:${port}/open/${openCode}${key === '' ? '' : `#k=${key}`}`, body.asApp === true).catch(() => false)
        const isOpen = tried === true
        // A launcher that said yes is no proof of a window: a caller that asks (`waitRedeem`) hears
        // "opened" only when this window loaded its page, and prints a link otherwise. One that does
        // not ask gets the answer at once.
        if (isOpen && !isRedeemed && body.waitRedeem === true) {
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([redeemed, new Promise<void>(done => { timer = setTimeout(done, o.openRedeemMs ?? OPEN_REDEEM_MS) })])
          clearTimeout(timer)
        }
        redeemWaiters.delete(openCode)
        if (!isOpen) {
          if (key !== '') {
            // No window opened, yet the key or link was used: whoever read it from the opener's command line
            // paired with it or redeemed it, and it was not the person's page. Approvals go off, as for a key used twice.
            if (pairKeys.get(key)?.secret || openLinks.get(openCode)?.used) turnApprovalsOff()
            pairKeys.delete(key)
          }
          openLinks.delete(openCode)
        }
        // `hasTried`: this computer's browsers were tried and none opened, so the caller does not
        // try them again (a second window when a launcher reported an error after all).
        return json(res, 200, { isOpen, hasTried: tried !== null, isRedeemed })
      }
      // The rest are the page's own. The Origin check only turns away a careless caller, as any
      // program can send one: the one-time key and the page secret are what count.
      if (req.headers.origin === undefined) return json(res, 403, {})
      if (url.pathname === '/api/approvals/pair') {
        const page = pageIdOf(req.headers)
        const key = text(body.key)
        const known = key === '' ? undefined : pairKeys.get(key)
        // Only in time: a key read later from a browser's history opens nothing.
        if (isApprovalOff || known === undefined || known.until < now) return json(res, 403, { note: isApprovalOff ? o.s.approvalOff : o.s.approvalNoSecret })
        // A key used twice: another program read it, from the browser's command line, and one of
        // the two pages is not the person's. Neither may answer, and approvals stay off until the
        // board restarts. Checked before rejecting a retired page so a replay there still shuts down.
        if (known.secret !== '') {
          turnApprovalsOff()
          return json(res, 403, { note: o.s.approvalOff })
        }
        if (page === '' || isRetiredPage(page)) return json(res, 403, { note: o.s.approvalNoSecret })
        const secret = randomBytes(24).toString('base64url')
        known.secret = secret
        const seq = page !== '' ? (pages.get(page)?.seq ?? ++pageSeq) : 0
        if (seq > activeMaxSeq) activeMaxSeq = seq
        if (page !== '' && !pages.has(page)) pages.set(page, { seq, at: now, visible: false })
        dropOlderSecrets(page, seq, now)
        if (pageSecrets.size >= 16) pageSecrets.delete(pageSecrets.keys().next().value as string)
        // Counted as watching only once the page asks for the board while it is in front.
        pageSecrets.set(secret, { page, seq, pairedAt: now, seen: now, watched: 0 })
        return json(res, 200, { secret })
      }
      const secret = secretOf(req.headers, now)
      if (secret === '') {
        // The switch is drawn on every local page, so one that holds no secret asks for a keyed page.
        if (url.pathname === '/api/approvals/switch' && !isApprovalOff) {
          isSwitchWanted = true
          return json(res, 403, { note: o.s.approvalSwitchNoSecret })
        }
        return json(res, 403, { note: isApprovalOff ? o.s.approvalOff : o.s.approvalNoSecret })
      }
      if (url.pathname === '/api/approvals/switch') {
        // A switch that failed leaves the marker as the hook reads it: if it is there, the hook is off, so the board is too.
        const failedSwitch = (addressFile: string): void => {
          isUserOff = isOffMarkerAt(addressFile)
          if (isUserOff) for (const [id, one] of [...approvals]) if (one.answer !== undefined) settleApproval(id, null)
          json(res, 409, { note: o.s.approvalSwitchFailed })
        }
        if (isApprovalOff) return json(res, 403, { note: o.s.approvalOff })
        if (typeof body.enabled !== 'boolean') return json(res, 400, {})
        if (o.addressFile === undefined) return json(res, 409, { note: o.s.approvalSwitchFailed })
        if (body.enabled === false) {
          if (!writeOffMarker(o.addressFile, new Date(clockNow()).toISOString())) return failedSwitch(o.addressFile)
          hasAsked = true
          isUserOff = true
          isApprovalFilesDirty = false
          lastApprovalFilesReadAt = now
          for (const [id, one] of [...approvals]) if (one.answer !== undefined) settleApproval(id, null)
          return json(res, 200, { isOff: true, note: o.s.settingsChanged(o.s.settingsApprovals, o.s.settingsOff) })
        }
        if (!removeOffMarker(o.addressFile)) return failedSwitch(o.addressFile)
        hasAsked = true
        isUserOff = false
        isApprovalFilesDirty = false
        lastApprovalFilesReadAt = now
        return json(res, 200, { isOff: false, note: o.s.settingsChanged(o.s.settingsApprovals, o.s.settingsOn) })
      }
      if (url.pathname === '/api/approvals/drawn') {
        // The page drew these, as they were: only then does the hook keep waiting for a press.
        const drawn: unknown[] = Array.isArray(body.items) ? body.items : []
        for (const one of drawn) {
          if (one === null || typeof one !== 'object') continue
          const seen = one as Record<string, unknown>
          const pending = approvals.get(text(seen.id))
          if (pending === undefined || pending.answer === undefined || pending.item.state !== 'asking' || text(seen.turn) !== pending.item.turn || text(seen.state) !== 'asking') continue
          pending.item = { ...pending.item, state: 'shown' }
        }
        return json(res, 200, {})
      }
      if (url.pathname === '/api/approvals/press') {
        const press = readPress(body)
        if (press === null) return json(res, 400, {})
        // A page paired a moment ago waits out the grace window: if its key was stolen, the real
        // page's own use of the key turns approvals off before this page can press.
        const wait = graceMs - (now - (pageSecrets.get(secret)?.pairedAt ?? now))
        if (wait > 0) return json(res, 425, { note: o.s.approvalTooSoon(Math.ceil(wait / 1000)) })
        const pending = approvals.get(press.id)
        // An answered, ended or fallen-back request, or one drawn at another turn or state.
        if (pending === undefined || pending.answer === undefined || pressProblem(pending.item, press) !== null) return json(res, 409, { note: o.s.approvalChanged })
        const item = pending.item
        const session = `${item.agent}:${item.session}`
        const view = o.view()
        // The first press for a session waits for the person's confirm on the page.
        if (!confirmed.has(session) && !press.isConfirmed) return json(res, 428, { needsConfirm: true, note: o.s.approvalConfirm(agentLabel(item.agent, o.s), approvalTitle(view, item.agent, item.session, o.s)) })
        confirmed.add(session)
        settleApproval(item.id, decisionOf(item, press, o.s))
        try {
          const place = approvalPlace(view, item.agent, item.session)
          o.journal?.({ project: place?.project || o.s.uncategorized, task: place?.task || agentLabel(item.agent, o.s), step: journalStep(item, press.behavior, o.s) })
        } catch (error) {
          // The decision already went to the host; a journal line that could not be written is said.
          process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
        }
        return json(res, 200, { note: press.behavior === 'allow' ? o.s.approvalAllowed : o.s.approvalDenied })
      }
      return json(res, 404, {})
    }
    if (url.pathname.startsWith('/api/messages/')) {
      if (isLan) return json(res, 403, {})
      return replyMessage(url.pathname.slice('/api/messages/'.length), body)
    }
    // A press that met a file the board could not read or write is answered with why; any other
    // error stays a bare server error.
    try {
      if (url.pathname === '/api/agents/setup' || url.pathname === '/api/agents/remove') {
        if (isLan) return json(res, 403, {})
        if (o.agents === undefined) return json(res, 400, { note: o.s.settingsAgentInvalid })
        const result = await o.agents.change(body.agent, url.pathname.endsWith('/setup') ? 'setup' : 'remove')
        return json(res, result.status, result)
      }
      if (url.pathname === '/api/act') {
        const state = isLan ? undefined : messaging.snapshot(Date.now())
        // A message sent, and what came of it, in the one status line the terminal board and --json read from its stored
        // receipt, the same words for every agent and route (#1843, B4).
        const statusNote = (receipt: ReturnType<typeof messaging.act>): string =>
          'status' in receipt ? messageStatus(receipt as Parameters<typeof messageStatus>[0], Date.now(), o.s)?.line ?? '' : o.s.messagesFailed
        const sendMessage = (input: Record<string, unknown>, agent: string) => {
          try {
            const receipt = messaging.act('send', input, Date.now())
            return json(res, 200, { note: statusNote(receipt), receipt })
          } catch (error) {
            // A second answer to a question whose first is still open says another answer went first, with that one's
            // status line (#1843, B3.2, B4).
            const first = (error as { receipt?: ReturnType<typeof messaging.act> } | null)?.receipt
            if (error instanceof Error && error.message === 'ANSWER_OPEN' && first !== undefined) return json(res, 409, { note: o.s.statusAnswerOpen(statusNote(first)), receipt: first })
            const code = (error as { code?: unknown } | null)?.code
            if (['EPERM', 'EBUSY', 'EAGAIN'].includes(String(code))) return json(res, 503, { error: 'MESSAGE_STORE_BUSY' })
            const decision = (error as { decision?: SendDecision } | null)?.decision
            if (error instanceof Error && error.message === 'NO_RECORDED_ROUTE' && decision !== undefined && !decision.canSend) {
              const state = sessionState(o.view(), agent, text(body.session))
              return json(res, 409, { note: routeText(decision.line, false, agent, o.s, state, decision.reason) })
            }
            const notes: Record<string, string> = { ID_CONFLICT: o.s.messagesConflict, TARGET_BUSY: o.s.messagesBusy, PAIR_BUSY: o.s.messagesBusy, TEXT_REFUSED: o.s.messagesTextRefused, CONTESTED: o.s.messagesContested }
            return json(res, 409, { note: error instanceof Error ? notes[error.message] ?? o.s.messagesFailed : o.s.messagesFailed })
          }
        }
        // A press made again under an id the board stored is answered with that message, before the card is checked: its
        // receiver may have connected again since, under a connection the press no longer names. Only for the session it was
        // sent to, and only with the same words; the store refuses other words (#1843, B3.1). The session is the pressed
        // card's: its agent and the session it names, so another agent's card with the same session id is refused. A card
        // gone since (its agent took the answer and moved on) has nothing to show the message on wrongly: the stored
        // message's own agent stands in for it.
        const known = text(body.type) === 'message' ? state?.messages.find(one => one.id === body.id) : undefined
        if (known !== undefined) {
          const card = boardItems(o.view(), o.pending(), true, false).find(one => one.key === text(body.key))
          const cardAgent = card === undefined ? agentOf(known.to) : card.type === 'ask' ? card.ask.agent || 'claude' : card.type === 'row' ? card.row.agent || 'claude' : ''
          if (known.from !== 'board' || known.to !== address(cardAgent, text(body.session))) return json(res, 409, { note: o.s.messagesConflict })
          return sendMessage({ id: known.id, target: known.target, turn: known.turn, text: replyText(text(body.text)) }, agentOf(known.to))
        }
        const view = o.view()
        // The press picks its target as the card did: a live connection hides the mailbox only on a recorded route (#318).
        const targets = deliveryTargets(state?.connections ?? [], state?.mailboxes, live => isRecordedRoute(live, (agent, session) => sessionState(view, agent, session), o.routes ?? RECEIVER_ROUTES))
        // Hiding a question on the reminder or Older shelf, or archiving an ended session's task from there (#155), names a line
        // of that shelf; no other press needs it, and its fingerprints stay as drawn.
        const isShelf = text(body.type) === 'hide' || text(body.type) === 'archive' && text(body.key).startsWith('older:')
        const action = serveAction(boardItems(view, o.pending(), true, isShelf), { key: text(body.key), type: text(body.type), text: text(body.text), session: text(body.session), asked: text(body.asked), fp: text(body.fp), line: lineOf(body.line), connection: text(body.connection), turn: text(body.turn) }, o.s, isLan, targets, true, o.allowResume, o.routes)
        if (action.type === 'refuse') return json(res, 409, { note: action.note || o.s.pressNothing })
        if (action.type === 'message') {
          if (isLan) return json(res, 403, {})
          o.dropUndo?.()
          return sendMessage({ id: body.id, target: action.connection.id, turn: action.connection.turn, text: action.text, ...(action.answers === undefined ? {} : { answers: action.answers }) }, action.connection.agent)
        }
        if (action.type === 'send') {
          o.dropUndo?.()
          const sent = send(action.target, action.text, action.title, text(body.key))
          return json(res, sent.status, { note: sent.note })
        }
        const note = o.act(action) || o.s.pressNothing
        const isDone = ![o.s.boardWriteFailed, o.s.boardTickGone, o.s.archiveGone, o.s.hideFailed, o.s.boardLineChanged, o.s.questionRetentionFailed, o.s.pressFailed].includes(note)
        const undoToken = isDone && (action.type === 'archive' || action.type === 'done') ? o.undoToken?.() ?? null : null
        return json(res, isDone ? 200 : 409, { note, ...(undoToken ? { canUndo: true, undoToken } : {}) })
      }
      if (url.pathname === '/api/undo') {
        if (o.undo === undefined) return json(res, 409, { ok: false, note: o.s.undoNothing })
        const result = o.undo(text(body.token))
        return json(res, result.ok ? 200 : 409, result)
      }
      if (url.pathname === '/api/tidy') {
        const note = o.tidy()
        return json(res, note === o.s.boardWriteFailed ? 409 : 200, { note })
      }
      if (url.pathname === '/api/tidy-bulk') {
        if (o.bulkTidy === undefined) return json(res, 400, { note: o.s.pressFailed })
        const result = o.bulkTidy(body as unknown as Parameters<Exclude<typeof o.bulkTidy, undefined>>[0])
        return json(res, result.ok ? 200 : 409, result)
      }
      if (url.pathname === '/api/style') {
        const style = body.style
        if (!isBarStyle(style) || o.setBarStyle === undefined) return json(res, 400, { note: o.s.pressFailed })
        const saved = o.setBarStyle(style)
        if (saved.result !== 'ok') return json(res, 409, { note: saved.result === 'unsafe' ? o.s.barStyleUnsafe : o.s.barStyleUnreadable })
        const note = saved.lockLeft === undefined ? undefined : o.s.settingsLockLeft(isLan ? basename(saved.lockLeft) : saved.lockLeft)
        return json(res, 200, { style, ...(note === undefined ? {} : { note }) })
      }
      if (url.pathname === '/api/language') {
        const lang = body.lang
        if (!isSettingsLang(lang) || o.setLanguage === undefined) return json(res, 400, { note: o.s.pressFailed })
        const saved = o.setLanguage(lang)
        if (saved.result !== 'ok') return json(res, 409, { note: saved.result === 'unsafe' ? o.s.barStyleUnsafe : o.s.barStyleUnreadable })
        const isOverridden = o.isLangOverridden?.() ?? false
        const note = isOverridden ? o.s.settingsLanguageOverridden : o.s.settingsLanguageChanged
        const lockNote = saved.lockLeft === undefined ? '' : ` ${o.s.settingsLockLeft(isLan ? basename(saved.lockLeft) : saved.lockLeft)}`
        return json(res, 200, { lang, isOverridden, note: note + lockNote, ...(saved.lockLeft === undefined ? {} : { lockLeft: true }) })
      }
      if (url.pathname === '/api/window') {
        // Only the computer's own page has a window to place; the phone's page never sends one.
        const place = placeOf(body)
        if (isLan || place === null || o.setWindow === undefined) return json(res, 400, {})
        // A page a newer one replaced (#265) keeps its window until the person closes it; a move
        // there must not overwrite where the current window was put.
        const id = pageIdOf(req.headers)
        const mine = pages.get(id)?.seq
        const now = Date.now()
        if (isRetiredPage(id) || mine !== undefined && [...pages.entries()].some(([other, one]) => other !== id && one.seq > mine && now - one.at < PAGE_STALE_MS)) return json(res, 409, {})
        return o.setWindow(place) ? json(res, 200, {}) : json(res, 409, {})
      }
      if (url.pathname === '/api/clean') {
        const note = o.clean()
        return json(res, note === o.s.boardWriteFailed ? 409 : 200, { note })
      }
      if (url.pathname === '/api/paste') {
        o.dropUndo?.()
        const pasted = o.paste(text(body.text), text(body.reviewToken))
        return json(res, pasted.isAdded ? 200 : 409, { note: pasted.note, review: pasted.review })
      }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (url.pathname === '/api/act' && body.type === 'message' && ['EPERM', 'EBUSY', 'EAGAIN'].includes(String(code))) return json(res, 503, { error: 'MESSAGE_STORE_BUSY' })
      const note = o.failure(error, isLan)
      if (note === null) {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
        return json(res, 500, { note: o.s.pressFailed })
      }
      return json(res, 409, { note })
    }
    // Only the board script on the computer opens the page to the network: it asks with the
    // computer's token and no Origin, which a script on a web page always sends.
    if (url.pathname === '/api/lan') {
      if (isLan || !isClientToken || req.headers.origin !== undefined) return json(res, 403, {})
      const wanted = text(body.address)
      const opened = await openLan(wanted === '' ? null : wanted)
      return json(res, 'url' in opened ? 200 : 409, opened)
    }
    // Only the board script on the computer tells the server the package a later launcher runs
    // from: a reused server learns the newer package, and its page shows the notice (#1304).
    // A web page always sends an Origin, and the phone's page never sends this.
    if (url.pathname === '/api/package') {
      if (isLan || !isClientToken || req.headers.origin !== undefined) return json(res, 403, {})
      const version = text(body.version)
      if (!/^\d+\.\d+\.\d+$/.test(version)) return json(res, 400, {})
      refreshPackageVersion(version)
      return json(res, 200, { package: packageVersion })
    }
    if (url.pathname === '/api/close') {
      // Closing would cut a reply off halfway: on Windows the agent goes with the server.
      if (isBusySending()) return json(res, 409, { note: o.s.serveCloseBusy })
      const moved = body.moved === true
      json(res, 200, {})
      setImmediate(() => stop(moved))
      return
    }
    return json(res, 404, {})
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, {})
    })
  })
  let isListening = false
  server.on('error', (error: NodeJS.ErrnoException) => {
    try { messaging.close() } catch {}
    try { approvalWatcher?.close() } catch {}
    approvalWatcher = null
    if (!isListening && o.onListenError !== undefined) o.onListenError(error)
    else o.onStop()
  })
  server.listen(o.port, '127.0.0.1', () => {
    isListening = true
    port = (server.address() as AddressInfo).port
    const url = `http://127.0.0.1:${port}/?t=${token}`
    // A later --serve asks this address before moving a lock this hub left behind, and a hook reads a lock with no owner
    // as a hub still starting, so every take waits. A hub that cannot publish its owner record would hold the lock that way
    // for as long as it ran (#1472 review): the record goes out before the page is announced, and a failure stops the hub,
    // gives the lock back and names the cause.
    if (o.isDefaultMessagesDirectory) {
      try { messaging.recordOwner(port, url) } catch (error) {
        isStopping = true
        try { messaging.close() } catch {}
        server.close()
        server.closeAllConnections()
        if (o.onStoreError !== undefined) o.onStoreError(error)
        else o.onStop()
        return
      }
    }
    if (!o.onReady(url, port)) {
      stop()
      return
    }
    messaging.markPublished()
    if (o.watch !== undefined) {
      const { progress, inbox, fs } = o.watch
      boardWatch = watchBoard({ progress, inbox, onChange: wakeAll, onFail: () => { syncFallback(); wakeAll() }, ...(fs === undefined ? {} : { watch: fs }) })
      if (o.addressFile !== undefined) {
        try {
          const watchFn = fs ?? fsWatch
          const watcher = watchFn(dirname(o.addressFile), () => {
            isApprovalFilesDirty = true
            wakeAll()
          })
          watcher.on('error', () => {
            isApprovalWatchLive = false
            isApprovalFilesDirty = true
            try { watcher.close() } catch {}
            if (approvalWatcher === watcher) approvalWatcher = null
          })
          approvalWatcher = watcher
          isApprovalWatchLive = true
        } catch {
          isApprovalWatchLive = false
        }
      }
    }
    // Preparing a private address can block; inactivity starts once that address is ready.
    lastSeen = Date.now()
    if (o.codex?.executable) {
      // The address and token stay in this process: the Codex program is given neither.
      codexReceiver = startCodexReceiver({ boardUrl: url, threads: o.codex.threads, executable: o.codex.executable, ...(o.codex.clients === undefined ? {} : { clients: o.codex.clients }), ...(o.codex.unloadMs === undefined ? {} : { unloadMs: o.codex.unloadMs, unloadMarginMs: o.codex.unloadMs }) })
      // A process that exits another way (Windows sends no SIGTERM) still ends the Codex program it started.
      process.once('exit', () => codexReceiver?.kill())
      if (o.codex.appSessions !== undefined) {
        const executable = o.codex.executable, appSessions = o.codex.appSessions
        codexAppReceiver = startCodexAppReceiver({
          boardUrl: url, executable, sessions: appSessions,
          // The Codex home the conversations were found in, so their runs resume from it too.
          ...(o.codex.appHome === undefined ? {} : { codexHome: o.codex.appHome }),
          stateOf: id => sessionState(o.view(), 'codex', id),
          // The daemon receiver has a conversation it is attached to; two connections would contest its card.
          isTaken: id => codexReceiver?.attached().includes(id) === true,
        })
        process.once('exit', () => codexAppReceiver?.kill())
      }
    }
    // The idle timer starts only once the server is listening: a listen failure
    // throws before this point, and a timer made earlier would keep the failed
    // child alive instead of letting it exit.
    // An open page keeps a board request open and asks again when it is answered (#359); a hidden tab's waiting requests
    // are not counted, so the server goes once no tab in sight has asked and nobody has loaded the page or pressed
    // anything for `idleMs`, and no reply is on its way.
    const idle = setInterval(() => {
      if (isStopping) return
      touchWaiting(Date.now())
      if (lan !== null && Date.now() - lan.lastSeen > LAN_IDLE) closeLan()
      if (o.idleMs > 0 && !isBusySending() && Date.now() - lastSeen > o.idleMs) stop()
    }, o.idleMs > 0 ? Math.min(30_000, Math.max(10, o.idleMs)) : 30_000)
    server.on('close', () => clearInterval(idle))
    const sweeper = setInterval(() => { if (!isStopping) try { o.sweep() } catch {} }, o.sweepMs)
    server.on('close', () => clearInterval(sweeper))
  })
}
