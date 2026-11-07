// The Agent Board for any terminal and any agent, without Claude Code: `node agent-board.mjs`
// prints the board once, `--watch` keeps it on screen and, on a terminal, lets you work in it
// the way the pane does (arrows, Enter, x, a, c, digits); the browser key opens the live page
// and opens it. `--serve` prints the board and opens the board's page in the browser, where it
// can be clicked (board-serve.ts). `--chat` prints the board as plain text short enough for a
// chat app, with no link and no secrets, for an agent that answers there. `/progress connect` writes the bundled copy of this file
// beside progress.md (scripts/build-board.ts bundles it into hooks/board-script.ts and its parts), with the
// progress file and language the Claude Code session uses set on its first line. `--keys
// "down x"` plays keys without a terminal and prints the board after them, for tests and checks.
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { localProgressPath, runCodexLocal, setupFailure } from './codex-local'
import { repoLookup } from './repo-lookup'
import { legacyConnect } from './connect-transaction'
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { HISTORY_DAYS, historyDaysOf, settingsPath, sweepHistory } from '../hooks/history'
import { archivableAsking, countManualDone, isHandKeptMoveOn, confirmMatches, confirmTask, CUT_SETTLE_MS, cutBlockLines, cutOffBlocks, cutOffSpans, mergeBlock, scanBlocks, takeArchivable, takeManualDone, takeTask, setManualStep } from '../hooks/blocks'
import type { ConfirmedTask } from '../hooks/blocks'
import type { ProgressProject } from '../types'
import { boardVersion, startServer } from './board-serve'
import { moveLockAside } from './board-messaging'
import { claimMessageStore, hasLiveClaims } from './message-store-claim'
import { immutableQuestionFiles } from './question-files'
import { reusableQuestionObservation } from './question-observation'
import { recentInboxFiles } from './inbox-files'
import { dropServerMemoryEnv, serverMemoryArgs, serverMemoryEnv } from './server-runtime'
import { defaultMessagesDirectory, isOwnFolder, MESSAGE_FOLDER_ENV, migratePrivateRuntimeFile, privateRuntimeFolder, privateRuntimeFolderAsync, readPrivateRuntimeFile, readPrivateRuntimeFileAsync, RUNTIME_FOLDER_ENV, RuntimeFolderError, RuntimeFolderTimeoutError, runtimeFolderHandoff, unprotectedRuntimeFolder, writePrivateRuntimeFile } from './runtime-folder'
import { isTimeout, privateFolderHandoff } from './private-folder'
import { addressFileName } from '../hooks/receiver'
import { idleTimeout, worktreeRepoName } from '../hooks/serve'
import { pickSurface } from '../hooks/surface'
import { pageDoneHash, pageStatePath, readPageDone, readPageState } from '../hooks/live-page'
import { boardStatus } from '../hooks/board-status'
import { boardAgents, boardKey, boardLayout, boardScreen, boardText, CHAT_MAX, chatText, clipped, doneToday, emptyBoardState, frame, isEmptyBoard, mutedLine, peekInbox, pinned, plain, redact, boardItems, routesOf, SCREEN_ENTER, SCREEN_LEAVE, terminalLook } from '../hooks/board'
import { BOARD_JSON_SCHEMA, boardDocument } from '../hooks/board-json'
import { RELEASED } from '../hooks/released'
import type { AnswerRoute, BoardAction, BoardState, PendingTurn } from '../hooks/board'
import { inboxTime, LOG_TAIL, isInboxFile, keepInboxDone } from '../hooks/inbox'
import { oldMonthFiles, OLD_MONTHS_FOLDER } from '../hooks/old-months'
import { appendJournal, archivePath, countDay, journalLine, journalPath, localDay, nextPendingArchive, parseJournal, parsePendingArchive, pendingArchivePath, unwrittenEntries } from '../hooks/journal'
import type { PendingArchiveRecord } from '../hooks/journal'
import { currentPart, inboxDropped, monthParts, prunedNote, prunedSince, prunedTotal, RETENTION, sizeWarnings, storageDetails } from '../hooks/retention'
import { parseProgress, parseStaleMs, progressTail } from '../hooks/parse'
import { qrModules, qrText } from '../hooks/qr'
import { agentLabel, langOf, plainReason, STRINGS } from '../hooks/strings'
import { answeredJson, answeredPath, buildView, handKeptSeenAt, isSeenText, keptQuestionCount, manualDoneSeen, parseAnswered, parseSeen, seenJson, seenPath, withAnswered, withSeen } from '../hooks/view'
import type { TaskRef } from '../hooks/view'
import { acknowledgementKeys, archiveQuestionsKept, refTasks, captureHashOf, captureJson, capturePath, compactQuestionsJson, copiesToKeep, cutOffScopes, emptyQuestions, identitiesToRetire, parseCapture, withCaptures, isAskedBy, isKeptQuestion, isQuestionProof, isQuestionSnapshot, isTornLedger, migratedAnswered, observeQuestions, parseQuestions, questionProofJson, questionProofOf, questionProofPath, questionsPath, resolvedQuestionsToRetire, runQuestionsClosed } from '../hooks/questions'
import type { QuestionCapture, QuestionLedger, QuestionProofs, QuestionRecord } from '../hooks/questions'
import { sha256 } from '../hooks/sha256'
import { currentTidyCandidate, previewTidy, tidySelector, type TidyCandidate, type TidyPreview, type TidySelector } from '../hooks/tidy'
import { codexSignal, isStrongRun, runLookupId } from '../hooks/runs'
import { findSessionFile, readSessionMeta } from './codex-history'
import { runMcp } from './board-mcp'

// The line `/progress connect` puts above the bundle sets it.
const BAKED = (globalThis as { AGENT_BOARD?: { path?: string; lang?: string } }).AGENT_BOARD ?? {}

const args = process.argv.slice(2)
const isJsonBoard = args.includes('--json') && !args.some(arg => ['--recover-hooks', '--codex-setup', '--codex-doctor', '--codex-remove', '--codex-trust'].includes(arg))
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const idleMs = (): number => {
  const value = flag('--idle-minutes')
  if (args.includes('--idle-minutes') && value === undefined) throw new Error('INVALID_IDLE_MINUTES')
  return idleTimeout(value)
}
const staleTimeoutMs = (): number => {
  if (args.includes('--stale-ms') && flag('--stale-ms') === undefined) throw new Error('INVALID_STALE_MS')
  return parseStaleMs(flag('--stale-ms') ?? process.env.AGENT_BOARD_STALE_MS)
}

const progressFile = (): string => {
  const config = process.env.CLAUDE_CONFIG_DIR

  return localProgressPath(flag('--progress-file'), BAKED.path || join(config || join(homedir(), '.claude'), 'progress.md'))
}

// Windows usually has no LANG, so the board also checks the system locale.
const systemLang = (env: unknown) => {
  const language = langOf(env)
  if (language !== null) return language
  try { return langOf(Intl.DateTimeFormat().resolvedOptions().locale) } catch { return null }
}

const path = progressFile()
const s = STRINGS[langOf(flag('--lang')) ?? langOf(BAKED.lang) ?? systemLang(process.env.LANG) ?? 'en']

// Files changed since the board last read progress.md in full. A read refused because another
// program holds the file open can say that nothing was changed only while this is 0. It is
// cleared only after a full read, keeping writes made by that view, so a refresh right after a
// press or view that wrote and then failed still says files may have changed.
let writes = 0

class BoardFileError extends Error {
  readonly isLocked: boolean
  // Set once a press took back everything it wrote before this failure (#248).
  isUnchanged = false
  constructor(readonly file: string, readonly code: string, isRead = false) {
    super(code)
    this.isLocked = isRead && writes === 0 && (code === 'EBUSY' || code === 'EAGAIN')
  }
}

const fileError = (file: string, error: unknown, isRead = false): BoardFileError =>
  new BoardFileError(file, String((error as { code?: string } | null)?.code ?? 'UNKNOWN'), isRead)

const plainFile = (file: string): string => {
  const full = resolve(file)
  return full === resolve(path) ? s.fileProgress
    : full === resolve(questionsPath(path)) ? s.fileQuestions : s.fileNamed(basename(file))
}

// The terminal board and the page say the same about a file they could not read or write.
const storageNote = (error: BoardFileError): string =>
  error.isLocked ? s.boardLocked(plainFile(error.file))
    : error.isUnchanged ? s.boardSaveFailed(plainFile(error.file), plainReason(s, error.code))
    : s.boardStorageFailed(plainFile(error.file), plainReason(s, error.code))

const read = (file: string): string => {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ENOENT') return ''
    throw fileError(file, error, true)
  }
}

// The part of a month's journal or archive new lines go to: the month's file until it reaches
// 1 MB, then `-2`, and so on (hooks/retention.ts, #373).
const partOf = (base: string): string => currentPart(base, file => {
  try {
    return statSync(file).size
  } catch {
    return null
  }
})

// This month's journal as far as today needs it: its last part, and the one before when the last
// began today. The rest of a long month is not read (#373).
const journalRaw = (now: number): string => {
  const base = journalPath(path, now)
  const parts = monthParts(base, existsSync)
  // A month with no journal yet is read as before, so a file the board cannot read is still named.
  const text = read(parts.at(-1) ?? base)
  const before = parts.at(-2)
  return before !== undefined && !parseJournal(text).some(entry => entry.at < localDay(now)) ? `${read(before)}\n${text}` : text
}

// A task any agent finished today is one journal line, written once (#245). Claude's ticks already
// wrote their own lines, so a task with a line today under the same project and title is not added.
let doneProjects: readonly ProgressProject[] = []
const doneBlockLines = (projects: readonly ProgressProject[], journal: string, now: number): string[] => {
  const day = localDay(now)
  const written = new Set(parseJournal(journal).filter(entry => entry.at === day).map(entry => `${entry.project}\n${entry.task}`))
  const lines: string[] = []
  for (const project of projects) {
    for (const task of project.tasks) {
      const updated = task.auto?.state === 'done' ? task.auto.updated : undefined
      if (updated === undefined || !Number.isFinite(updated) || updated <= 0 || updated > now || localDay(updated) !== day) continue
      const title = task.title || s.unnamed
      const line = journalLine({ project: project.name || s.uncategorized, task: title, step: task.steps.filter(step => step.status === 'done').at(-1)?.text ?? title }, updated, s)
      const [parsed] = parseJournal(line)
      if (parsed === undefined || written.has(`${parsed.project}\n${parsed.task}`)) continue
      written.add(`${parsed.project}\n${parsed.task}`)
      lines.push(line)
    }
  }
  return lines
}

// The journal for today with what other agents finished today counted too, so every surface that
// reads it (the count, the done list, --json) agrees with the blocks.
const journalToday = (now: number): string => {
  const text = journalRaw(now)
  return appendJournal(text, doneBlockLines(doneProjects, text, now), s)
}

// An interactive board also saves those lines to the month's journal, which the weekly report reads.
let isDoneSaveFailed = false
const saveDoneBlocks = (projects: readonly ProgressProject[], now: number): void => {
  try {
    isDoneSaveFailed = false
    if (doneBlockLines(projects, journalRaw(now), now).length === 0) return
    rewrite(partOf(journalPath(path, now)), past => {
      const missing = doneBlockLines(projects, `${journalRaw(now)}\n${past}`, now)
      return missing.length === 0 ? null : appendJournal(past, missing, s)
    })
  } catch {
    // The board still counts the task through journalToday and tries again on the next read; the warning says the history is not saved.
    isDoneSaveFailed = true
  }
}

// A session log's end only, kept while the file is unchanged: --watch looks again every
// 2 seconds, and a Codex log can run to tens of megabytes.
const logs = new Map<string, { at: number; text: string }>()
const readLog = (file: string): string => {
  try {
    const { mtimeMs, size } = statSync(file)
    const known = logs.get(file)
    if (known !== undefined && known.at === mtimeMs) return known.text
    const length = Math.min(size, LOG_TAIL)
    const buffer = Buffer.alloc(length)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buffer, 0, length, size - length)
    } finally {
      closeSync(fd)
    }
    const text = buffer.toString('utf8')
    logs.set(file, { at: mtimeMs, text })
    return text
  } catch {
    return ''
  }
}

// `scrub` hides what must not be sent on, in a reply, before its question is picked and cut.
let pageStateCache = readPageState('')
const pageDoneFiles = immutableQuestionFiles({
  directory: dirname(path),
  isPersistent: args.some(arg => ['--watch', '--serve', '--serve-child'].includes(arg)),
  accepts: name => pageDoneHash(name) !== null,
  parse: (text, name) => readPageDone(text, pageDoneHash(name)!),
  // A broken receipt cannot invalidate another session's processed question.
  isValidationIndependent: true,
})
let pageDoneCache: Array<{ name: string; stamp: string }> = []
// A poll can meet the plugin's verified write halfway through; retain its last complete record.
const sharedPageState = () => {
  pageStateCache = readPageState(read(pageStatePath(path)), pageStateCache)
  pageDoneCache = pageDoneFiles.read(!isViewQuestionRead) ?? pageDoneCache
  const at = Date.now()
  // An expired receipt for the same filename must not shadow another session's live receipt.
  const kept = pageDoneCache.filter(done => keepInboxDone({ [done.name]: done.stamp }, at)[done.name] !== undefined)
  return { ...pageStateCache, inboxDone: keepInboxDone({ ...pageStateCache.inboxDone, ...Object.fromEntries(kept.map(done => [done.name, done.stamp])) }, at) }
}
let viewPageState: ReturnType<typeof sharedPageState> | null = null
let droppedLogCache: { at: number; text: string } | null = null

const pending = (scrub?: (text: string) => string, isFresh = !isViewQuestionRead) => {
  const files = inboxFiles.read(isFresh)
  const done = (viewPageState ?? sharedPageState()).inboxDone
  return peekInbox(files.filter(file => done[file.name] === undefined), readLog, scrub, s)
}

// The record last read, kept when the next read catches it half-written, and progress.md's
// time and size, and since when it has held them: tasks gone from it leave the record only once
// it held still for a second (a key press draws twice within milliseconds), so a read caught
// part way through a write never resets every task's age.
let lastSeen: Record<string, number> = {}
let lastStat = { stat: '', at: 0 }
let lastQuestions = emptyQuestions()
const questionWriter = randomUUID()
let questionWrite = 0
const isQuestionWriter = !args.includes('--chat') && !args.includes('--json') && !args.includes('--mcp') && args.some(arg => ['--watch', '--serve', '--serve-child', '--keys'].includes(arg))
const isPersistentQuestions = !args.includes('--chat') && !args.includes('--json') && !args.includes('--mcp') && args.some(arg => ['--watch', '--serve', '--serve-child'].includes(arg))
let isViewQuestionRead = false
const inboxFiles = recentInboxFiles({
  directory: join(dirname(path), 'progress-inbox'),
  isPersistent: isPersistentQuestions,
  accepts: isInboxFile,
})
let tornQuestionCache: { text: string; isTorn: boolean } | null = null
let parsedQuestionCache: { file: string; text: string; isMissing: boolean; ledger: QuestionLedger | null } | null = null
let capturedQuestionCache: { ledger: QuestionLedger; captures: QuestionCapture[]; merged: QuestionLedger } | null = null
let rawQuestionJsonCache: { ledger: QuestionLedger; text: string } | null = null
let emptyCopyCache: { current: QuestionLedger; captures: QuestionCapture[]; observed: string } | null = null
const tornQuestions = (text: string): boolean => {
  if (tornQuestionCache?.text === text) return tornQuestionCache.isTorn
  const isTorn = isTornLedger(text)
  tornQuestionCache = { text, isTorn }
  return isTorn
}
const parsedQuestions = (file: string, text: string, isMissing: boolean): QuestionLedger | null => {
  if (parsedQuestionCache?.file === file && parsedQuestionCache.text === text && parsedQuestionCache.isMissing === isMissing) return parsedQuestionCache.ledger
  const ledger = parseQuestions(text, isMissing)
  parsedQuestionCache = { file, text, isMissing, ledger }
  return ledger
}

// Neither a quarantine nor a missing ledger may replace another session's complete file.
// mv -n also returns zero when it skips a destination, so check that the source is gone.
const placeQuestionFile = (from: string, to: string): boolean => {
  const source = resolve(from)
  const target = resolve(to)
  const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`
  const [tool, argv] = process.platform === 'win32'
    // Move-Item, as the pane uses: a .NET method call is refused under Constrained Language Mode.
    ? [system32('WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `Move-Item -LiteralPath ${quote(source)} -Destination ${quote(target)} -ErrorAction Stop`]] as const
    : ['mv', ['-n', '--', source, target]] as const
  const ran = spawnSync(tool, [...argv], { cwd: dirname(path), stdio: 'ignore', timeout: 10000, windowsHide: true })
  const isMoved = ran.status === 0 && !existsSync(source)
  if (isMoved) writes += 1
  return isMoved
}

// A hard link fails when the target exists, so it never replaces another writer's ledger, and it
// starts no program: on a fresh Windows profile PowerShell alone could take longer than the move's
// 10 s limit. Only for a file this process owns; a volume without hard links uses the move program.
const placeOwnedQuestionFile = (source: string, target: string): boolean => {
  try {
    linkSync(source, target)
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'EEXIST') return false
    return placeQuestionFile(source, target)
  }
  unlinkSync(source)
  return true
}

const quarantineQuestions = (file: string): boolean => {
  const aside = `${file}.torn-${Date.now()}-${process.pid}`
  // The shared ledger keeps the move program: another writer can rename a newer ledger onto it
  // between a link and an unlink, and the unlink would then delete that newer ledger.
  if (!placeQuestionFile(file, aside)) return false
  if (isTornLedger(read(aside))) return true
  // A good write raced the initial read. Restore it only if no newer ledger took its place. A
  // throw here means the ledger is back and the aside, a second name for it, could not be removed.
  try {
    placeOwnedQuestionFile(aside, file)
  } catch {}
  return false
}

const readQuestions = (file: string, text?: string) => {
  if (text === undefined) {
    text = read(file)
    if (isQuestionWriter && tornQuestions(text)) {
      if (!quarantineQuestions(file)) return null
      text = read(file)
    }
  }
  let isMissing = false
  try {
    statSync(file)
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== 'ENOENT') throw fileError(file, error)
    isMissing = true
  }
  const parsed = parsedQuestions(file, text, isMissing)
  const captures = readQuestionCaptures()
  if (parsed === null || captures === null) return null
  if (capturedQuestionCache?.ledger === parsed && capturedQuestionCache.captures === captures) return capturedQuestionCache.merged
  const merged = withCaptures(parsed, captures)
  capturedQuestionCache = { ledger: parsed, captures, merged }
  return merged
}
// A capture or proof file is named by the hash of what it holds, so a listed name is read and
// checked once, and again only if its size or time moves (#156): --watch draws every 2 seconds.
const captureFiles = immutableQuestionFiles<QuestionCapture>({
  directory: dirname(path),
  isPersistent: isPersistentQuestions,
  accepts: name => captureHashOf(path, name) !== null,
  parse: (text, name) => {
    const hash = captureHashOf(path, name)
    return hash === null ? null : parseCapture(text, hash)
  },
  // A partial capture left by a process killed mid-flush cannot invalidate
  // the captures that did land: the record stays in the ledger, so the next
  // view re-derives the missing copy instead of stalling the writer path
  // (#921 T6). A genuine read failure still returns null.
  isValidationIndependent: true,
})
const readQuestionCaptures = (): QuestionCapture[] | null => captureFiles.read(!isViewQuestionRead)
const proofFiles = immutableQuestionFiles<{ kind: keyof QuestionProofs; hash: string }>({
  directory: dirname(path),
  isPersistent: isPersistentQuestions,
  accepts: name => questionProofOf(path, name) !== null,
  parse: (text, name) => {
    const proof = questionProofOf(path, name)
    return proof !== null && isQuestionProof(text, proof.kind, proof.hash) ? proof : null
  },
})
let questionProofCache: { files: { kind: keyof QuestionProofs; hash: string }[]; proofs: QuestionProofs } | null = null
const keepQuestionCapture = (record: QuestionRecord, disposition: QuestionCapture['disposition']): void => {
  const text = captureJson(record, disposition)
  const file = capturePath(path, sha256(text))
  // The name is the hash of the bytes, so a file whose bytes differ is a
  // partial write from a process killed mid-flush (#921 T6): no valid capture
  // can mismatch its own name. Remove it and write the capture again instead
  // of failing the flush for a record the ledger still holds. A live writer's
  // in-flight write goes through its own descriptor and holds the same bytes,
  // so removing the name cannot corrupt it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx', 0o600)
      try { writeFileSync(fd, text) } finally { closeSync(fd) }
      writes += 1
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== 'EEXIST') throw fileError(file, error)
    }
    if (read(file) === text) {
      captureFiles.invalidate(basename(file))
      return
    }
    try { unlinkSync(file) } catch {}
  }
  throw fileError(file, { code: 'EAGAIN' })
}
const readQuestionProofs = (): QuestionProofs | null => {
  if (pendingQuestionProofs.size > 0) return null
  const files = proofFiles.read(!isViewQuestionRead)
  if (files === null) return null
  if (questionProofCache?.files === files) return questionProofCache.proofs
  const proofs: QuestionProofs = { retired: [], consumed: [] }
  for (const proof of files) proofs[proof.kind].push(proof.hash)
  questionProofCache = { files, proofs }
  return proofs
}
const pendingQuestionProofs = new Map<string, { kind: keyof QuestionProofs; hash: string }>()
// The captures a view queued but has not written yet. A first view of a big
// board queues one capture per new question (500 on the synthetic big board);
// writing them all inside the request blocks the page server for seconds
// (#921), so the view enqueues them and a background flush writes a few per
// tick. Keyed by the capture bytes, so a rewrite retry re-enqueueing the same
// copies is a no-op; the ledger already holds the records, so a crash loses
// at most the pending files and the next view re-derives them.
const pendingQuestionCaptures = new Map<string, QuestionCapture>()
// How many queued captures one background tick writes. One tick stays well
// under the 150 ms mailbox budget: ~0.45 ms per file on this VM (T0), ~10 ms
// per file on Windows under antivirus (the issue's figure), so 5 files are
// ~2 ms here and ~50 ms there.
const QUESTION_CAPTURE_FLUSH_PER_TICK = 5
let questionCaptureFlushScheduled = false
const scheduleQuestionCaptureFlush = (): void => {
  if (questionCaptureFlushScheduled || pendingQuestionCaptures.size === 0) return
  questionCaptureFlushScheduled = true
  setImmediate(() => {
    questionCaptureFlushScheduled = false
    flushQuestionCaptures(QUESTION_CAPTURE_FLUSH_PER_TICK)
  })
}
const queueQuestionCaptures = (copies: readonly { record: QuestionRecord; disposition: 'unresolved' | 'resolved' }[]): void => {
  for (const copy of copies) {
    const capture: QuestionCapture = { version: 1, disposition: copy.disposition, record: copy.record }
    pendingQuestionCaptures.set(captureJson(copy.record, copy.disposition), capture)
  }
  scheduleQuestionCaptureFlush()
}
// Writes up to `budget` queued captures, in queue order, with the same
// per-file semantics as a synchronous write (keepQuestionCapture also bumps
// `writes` per landed file, so a locked read after a flush still says files
// may have changed). Every attempt counts toward the budget, failed or not:
// counting only successes let one tick attempt the whole queue when every
// write failed (#921 dot P2). A file that cannot be written stays queued and
// is named on stderr: the record may no longer be in the ledger (a stale
// replay can drop it while its capture is still pending), so dropping it here
// would lose the only remaining evidence (#921 dot P1). The empty-copy cache
// is cleared so the next view looks again instead of trusting the earlier
// empty decision, and that view restarts the flush while entries remain.
const flushQuestionCaptures = (budget: number): void => {
  let attempted = 0
  let landed = 0
  for (const [key, capture] of [...pendingQuestionCaptures]) {
    if (attempted >= budget) break
    attempted += 1
    try {
      keepQuestionCapture(capture.record, capture.disposition)
    } catch (error) {
      emptyCopyCache = null
      process.stderr.write(`agent-board: could not write queued question capture ${basename(capturePath(path, sha256(key)))}: ${error instanceof Error ? error.message : String(error)}\n`)
      continue
    }
    pendingQuestionCaptures.delete(key)
    landed += 1
  }
  // Only keep the chain running while it makes progress: retrying a tick
  // that landed nothing would spin the setImmediate loop on a failure that
  // is not going away. A later view restarts the flush while entries remain.
  if (landed > 0 && pendingQuestionCaptures.size > 0) scheduleQuestionCaptureFlush()
}
// Drains the whole queued-capture backlog synchronously. Only deliberate acts
// call this (archive, tidy, sweep): the view never waits for the queue, but a
// block must not be taken while its durable copy is still pending (#921).
const drainQuestionCaptures = (): void => {
  flushQuestionCaptures(Number.POSITIVE_INFINITY)
}
const keepQuestionProof = (kind: keyof QuestionProofs, hash: string): void => {
  const file = questionProofPath(path, kind, hash)
  pendingQuestionProofs.set(file, { kind, hash })
  const text = questionProofJson(kind, hash)
  try {
    const fd = openSync(file, 'wx', 0o600)
    try { writeFileSync(fd, text) } finally { closeSync(fd) }
    writes += 1
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== 'EEXIST') throw fileError(file, error)
  }
  if (!isQuestionProof(read(file), kind, hash)) throw fileError(file, { code: 'EAGAIN' })
  proofFiles.invalidate(basename(file))
  pendingQuestionProofs.delete(file)
}
// A file that cannot be looked at is not settled, as view() reads it.
const isCutSettledAt = (now: number): boolean => {
  try {
    return now - statSync(path).mtimeMs >= CUT_SETTLE_MS
  } catch {
    return false
  }
}
// What the explicit archive checks before it takes a block that asks (#174): its questions are
// kept in the ledger, and a durable 'archived' copy of each one still open is written. False
// leaves the block where it is; a copy that cannot be written throws. Only a board that writes the
// ledger brings it up to date, so a question asked since (or asked again in the words of an
// answered one) may not be in it yet: the sources are looked at as a settling pass would, and a
// block with a question that pass would add stays.
const keepAskedQuestions = (projects: ReturnType<typeof parseProgress>, ref: TaskRef, now: number, frozen: ReadonlySet<string>): boolean => {
  // Archive must not take a block whose durable copy is still pending (#921).
  drainQuestionCaptures()
  const latest = readQuestions(questionsPath(path))
  const proofs = readQuestionProofs()
  if (latest === null || proofs === null || !archiveQuestionsKept(projects, ref, latest)) return false
  const settled = observeQuestions(latest, projects, null, parseAnswered(read(answeredPath(path))) ?? [], now, true, 'preview', proofs, pending(), [], frozen).ledger
  const task = refTasks(projects, ref)[0]
  if (settled.records.some(record => record.isUnresolved && isAskedBy(record, ref, task) && !latest.records.some(old => old.id === record.id && old.isUnresolved))) return false
  for (const record of latest.records) {
    if (record.isUnresolved && isAskedBy(record, ref, task)) keepQuestionCapture(record, 'archived')
  }

  return true
}
let progressProjectCache: { source: string; projects: ReturnType<typeof parseProgress> } | null = null
let progressHealthCache: { source: string; isCutSettled: boolean; frozen: ReadonlySet<string>; isSnapshot: boolean; tail: ReturnType<typeof progressTail>; lines: string[] } | null = null
const observeWriterQuestions = reusableQuestionObservation()
const observeViewQuestions = reusableQuestionObservation()
const readBoardView = (source: string, now: number) => {
  const pageState = sharedPageState()
  viewPageState = pageState
  for (const proof of [...pendingQuestionProofs.values()]) keepQuestionProof(proof.kind, proof.hash)
  if (progressProjectCache?.source !== source) progressProjectCache = { source, projects: parseProgress(source) }
  const projects = progressProjectCache.projects
  const turns = pending(text => redact(text, homeOrNone(), process.platform === 'win32'))
  let stat = ''
  let mtimeMs = 0
  try {
    const one = statSync(path)
    stat = `${one.mtimeMs}:${one.size}`
    mtimeMs = one.mtimeMs
  } catch {
    // A missing file holds no task to keep or drop.
  }
  if (stat !== lastStat.stat) lastStat = { stat, at: now }
  const isSettled = stat !== '' && now - lastStat.at >= 1000 && projects.length > 0
  const isCutSettled = stat !== '' && now - mtimeMs >= CUT_SETTLE_MS
  // The four integrity readers scan the same source. Its settling boundary is an input too:
  // an unchanged incomplete tail must become a frozen crashed block after ten seconds.
  if (progressHealthCache?.source !== source || progressHealthCache.isCutSettled !== isCutSettled) {
    progressHealthCache = {
      source, isCutSettled,
      frozen: cutOffScopes(projects, cutOffSpans(source, isCutSettled)),
      isSnapshot: isQuestionSnapshot(source, isCutSettled),
      tail: progressTail(source),
      lines: cutBlockLines(cutOffBlocks(source, isCutSettled), s),
    }
  }
  let seen = lastSeen
  try {
    const file = seenPath(path)
    const record = parseSeen(read(file), answeredAge(file))
    if (record !== null) {
      seen = record
      // Read-only output must never write a sidecar, even beside interactive flags.
      if (!args.includes('--chat') && !args.includes('--json') && !args.includes('--mcp') && args.some(arg => ['--watch', '--serve', '--serve-child'].includes(arg))) {
        let observed = withSeen(record, projects, now, {}, false, true)
        const wrote = rewrite(file, before => {
          const current = parseSeen(before, answeredAge(file))
          if (current === null) return null
          observed = withSeen(current, projects, now, observed, isSettled, true)
          return seenJson(observed) === seenJson(current) ? before : seenJson(observed)
        })
        seen = wrote === null ? seen : (parseSeen(wrote) ?? seen)
      }
    }
  } catch {
    // A locked or unwritable record does not stop drawing or hide an undated task.
    seen = {}
  }
  lastSeen = seen
  doneProjects = projects
  if (isQuestionWriter && progressHealthCache.isSnapshot) saveDoneBlocks(projects, now)
  let answered = parseAnswered(read(answeredPath(path))) ?? []
  const file = questionsPath(path)
  const isWritingQuestions = progressHealthCache.isSnapshot && isQuestionWriter
  let proofs = readQuestionProofs()
  // Writers read inside rewrite, which also checks every retry against the latest ledger.
  // Reading it here as well doubles the file work on every unchanged page poll.
  const record = isWritingQuestions && proofs !== null ? null : readQuestions(file)
  const previewProofs = proofs
  if (record !== null) lastQuestions = record
  const frozen = progressHealthCache.frozen
  let questions: QuestionLedger | null = null
  // Chat and a one-shot read never write. Interactive readers persist before accepting hides.
  if (proofs !== null && isWritingQuestions) {
    const incarnation = `${questionWriter}:${questionWrite++}`
    const wrote = rewrite(file, before => {
      const current = readQuestions(file, before)
      if (current === null) return null
      lastQuestions = current
      if (read(path) !== source) return null
      let next = observeWriterQuestions(current, projects, null, answered, now, isSettled, incarnation, proofs ?? undefined, turns, [], frozen).ledger
      let nextText = compactQuestionsJson(next)
      const captures = readQuestionCaptures()
      if (captures === null) return null
      // Only a completed empty decision is reusable, with the same validated inputs and every
      // observed field unchanged. Missing or changed companions still force the durable-copy check.
      if (emptyCopyCache?.current !== current || emptyCopyCache.captures !== captures || emptyCopyCache.observed !== nextText) {
        // Pending captures count as held: a copy already queued is not queued
        // again, and the view returns without waiting for the flush (#921).
        // A resolved copy is written synchronously instead: after a restart
        // copiesToKeep emits nothing for a record the ledger already holds
        // resolved, so a queued resolved copy lost to an exit is never
        // re-derived. Unresolved copies are re-derived, so only they queue.
        const copies = copiesToKeep(current, next, [...captures, ...pendingQuestionCaptures.values()])
        for (const copy of copies) if (copy.disposition === 'resolved') keepQuestionCapture(copy.record, copy.disposition)
        queueQuestionCaptures(copies.filter(copy => copy.disposition === 'unresolved'))
        if (copies.length === 0) emptyCopyCache = { current, captures, observed: nextText }
      }
      for (const id of identitiesToRetire(current, next, resolvedQuestionsToRetire(current, projects, null, turns, frozen), proofs?.retired)) keepQuestionProof('retired', sha256(id))
      const latestProofs = readQuestionProofs()
      if (latestProofs === null) { proofs = null; return null }
      // New retirement proofs change the observation; unchanged validated proofs already produced
      // this result. Repeating it needlessly copies and hashes every retained question (#428).
      if (latestProofs !== proofs) {
        next = observeWriterQuestions(current, projects, null, answered, now, isSettled, incarnation, latestProofs, turns, [], frozen).ledger
        nextText = compactQuestionsJson(next)
      }
      proofs = latestProofs
      const raw = parsedQuestions(file, before, !existsSync(file))
      // The parsed ledger is immutable. Keep one canonical form instead of allocating another
      // complete copy for every unchanged page or terminal poll.
      if (raw !== null && rawQuestionJsonCache?.ledger !== raw) rawQuestionJsonCache = { ledger: raw, text: compactQuestionsJson(raw) }
      return raw !== null && nextText === rawQuestionJsonCache?.text ? before : nextText
    })
    if (wrote !== null) {
      lastQuestions = readQuestions(file, wrote) ?? lastQuestions
      questions = lastQuestions
      if (isSettled) {
        const migrated = rewrite(answeredPath(path), before => {
          const current = parseAnswered(before, answeredAge(answeredPath(path)))
          if (current === null) return null
          const latestProofs = readQuestionProofs()
          if (latestProofs === null) { proofs = null; return null }
          proofs = latestProofs
          const next = migratedAnswered(current, lastQuestions, latestProofs.consumed)
          const consumed = new Set(latestProofs.consumed)
          let hasNewProof = false
          for (const key of current) {
            if (Object.hasOwn(lastQuestions.legacy, key) && !consumed.has(sha256(key))) {
              keepQuestionProof('consumed', sha256(key))
              hasNewProof = true
            }
          }
          if (hasNewProof) { proofs = readQuestionProofs(); if (proofs === null) return null }
          return answeredJson(next) === answeredJson(current) ? before : answeredJson(next)
        })
        if (migrated !== null) answered = parseAnswered(migrated) ?? answered
      }
    }
  }
  questions ??= observeWriterQuestions(lastQuestions, projects, null, answered, now, isSettled, 'preview', previewProofs ?? undefined, turns, [], frozen).ledger
  // A record that left the ledger while its capture is still pending (retired
  // in a later pass) stays visible until the flush lands, as a synchronous
  // write would have shown it. View-only: the persisted ledger never sees
  // pending captures (#921).
  const viewQuestions = pendingQuestionCaptures.size === 0 ? questions : withCaptures(questions, [...pendingQuestionCaptures.values()])
  // A flush that stopped after a tick that landed nothing (every write
  // failed) restarts here: the queue still holds the evidence, and the next
  // view is the retry. Without this, a retained failed entry would sit until
  // a new copy arrived. A no-op while a flush is already scheduled.
  if (pendingQuestionCaptures.size > 0) scheduleQuestionCaptureFlush()
  // A question marked answered in a pane on this machine is kept off the board too.
  const tail = progressHealthCache.tail
  const sizes = { progress: Buffer.byteLength(source), store: pageState.store }
  const large = sizeWarnings(sizes, s)
  const warnings = [...(tail === null ? [] : [s.progressIncomplete(tail.tasks)]), ...(isDoneSaveFailed ? [s.journalFailed] : []), ...large]
  const finished = countManualDone(projects, now, (_key, project, task) => handKeptSeenAt(seen, project, task, now))
  const details = storageDetails(sizes, finished, s)
  const health = progressHealthCache.lines
  const droppedAt = Date.now()
  if (droppedLogCache === null || droppedAt < droppedLogCache.at || droppedAt - droppedLogCache.at >= 60000) {
    droppedLogCache = { at: droppedAt, text: read(join(dirname(path), 'progress-inbox', 'dropped.log')) }
  }
  const dropped = inboxDropped(droppedLogCache.text, prunedSince(now))
  const pruned = prunedNote({ ...prunedTotal(pageState.pruned, now), turns: dropped.age + dropped.cap }, s)
  // Proof writes above refresh this snapshot; drawing need not list the directory again.
  return { ...buildView(projects, [basename(process.cwd())], null, now, countDay(journalToday(now), now), manualDoneSeen(projects, seen, now, s), s, answered, seen, viewQuestions, proofs, turns, frozen, observeViewQuestions, staleTimeoutMs()), ...(warnings.length === 0 ? {} : { warning: warnings.join(' · ') }), ...(large.length === 0 ? {} : { isLarge: true as const }), ...(large.length === 0 && finished === 0 ? {} : { isCleanable: true as const }), ...(details === undefined ? {} : { details }), ...(pruned === null ? {} : { pruned }), ...(health.length === 0 ? {} : { health }) }
}

const view = (source = read(path), now = Date.now()) => {
  isViewQuestionRead = true
  try { return readBoardView(source, now) } finally { isViewQuestionRead = false }
}

const freshView = () => {
  const before = writes
  const shown = view()
  writes -= before
  return shown
}


// The questions the running page can answer into their session, as it last said (`refreshRoutes`).
let routes: Record<string, AnswerRoute> = {}

const options = () => ({
  width: Math.max(40, Math.min(process.stdout.columns || 80, 120)),
  ...terminalLook(process.env, args, process.stdout.isTTY === true),
  isIdleOpen: args.includes('--all'),
  routes,
})

// How many times `rewrite` makes a change; it tells the change which try is the last.
const REWRITE_TRIES = 3
// What a change answers to have the file read again before it is made: another write landed
// while the change was being worked out.
const AGAIN = Symbol('again')

// A write to a file a Claude Code session may write at the same moment: to a temp file of
// this process's own (two boards can run at once), renamed over it, then read back; made
// again from the new text when another write landed in between or the rename failed (on
// Windows, a file another program holds open), as the pane's own writes are. A failed
// read is never an empty file. `change` can run more than once, on newer text each time, and
// is told when it runs for the last time.
const rewrite = (file: string, change: (text: string, isLast: boolean) => string | null | typeof AGAIN, onReplaced?: () => void): string | null => {
  let failure: unknown = { code: 'EAGAIN' }
  for (let attempt = 0; attempt < REWRITE_TRIES; attempt += 1) {
    const before = read(file)
    const isLedger = file === questionsPath(path)
    if (isLedger && tornQuestions(before)) {
      if (!quarantineQuestions(file)) return null
      continue
    }
    const wasMissing = isLedger && before === '' && !existsSync(file)
    const after = change(before, attempt === REWRITE_TRIES - 1)
    if (after === AGAIN) continue
    if (after === null) return null
    if (after === before) return after
    const temp = `${file}.${process.pid}.${Date.now().toString(36)}.board-tmp`
    let isOwned = false
    try {
      let mode: number | undefined
      try {
        mode = statSync(file).mode & 0o777
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== 'ENOENT') throw error
      }
      // Exclusive creation avoids truncating somebody else's temp. Apply the old mode
      // after writing too, since the process umask may be more restrictive than it.
      const fd = openSync(temp, 'wx', mode ?? 0o600)
      isOwned = true
      closeSync(fd)
      writeFileSync(temp, after)
      if (mode !== undefined) chmodSync(temp, mode)
      if (wasMissing) {
        if (!placeOwnedQuestionFile(temp, file)) {
          if (!existsSync(file)) {
            // A failed move must not delete the only complete copy.
            isOwned = false
            throw { code: 'EAGAIN' }
          }
          unlinkSync(temp)
          continue
        }
      } else {
        // `change` can take long (a sweep reads and writes question files for each block that
        // asks), and a rename over a file another agent wrote meanwhile would undo that write:
        // look at the file once more and make the change again from what it holds now.
        if (read(file) !== before) {
          unlinkSync(temp)
          isOwned = false
          continue
        }
        try {
          renameSync(temp, file)
        } catch (error) {
          if (!isLedger || existsSync(file)) throw error
          if (!placeOwnedQuestionFile(temp, file)) {
            if (!existsSync(file)) isOwned = false
            throw error
          }
        }
      }
    } catch (error) {
      failure = error
      try {
        if (isOwned) unlinkSync(temp)
      } catch {}
      continue
    }
    writes += 1
    // The file is replaced now, even if reading it back fails below.
    onReplaced?.()
    if (read(file) === after) return after
    failure = { code: 'EAGAIN' }
  }

  throw fileError(file, failure)
}

// Windows looks in the current folder first for a program started by name, and an agent's folder
// can be a cloned repository: the system's own tools go by their full path, from the board's folder.
const system32 = (name: string): string => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name)
const powershell = (): string => system32('WindowsPowerShell\\v1.0\\powershell.exe')

// clip.exe reads its input in the console's code page (950 on a Traditional Chinese Windows), so text
// outside ASCII reached the clipboard garbled while the board said it was copied (#817). That text goes
// to PowerShell's Set-Clipboard as base64, which no code page changes; PowerShell takes about a second
// to start, so ASCII stays with clip.exe. A command line holds at most 32,767 characters; 30,000 leaves
// room for the program's path and its flags.
const windowsClipboard = (text: string): Array<[string, string[]]> => {
  if (/^[\x00-\x7f]*$/.test(text)) return [[system32('clip.exe'), []]]
  const command = `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text).toString('base64')}')))`
  return command.length < 30000 ? [[powershell(), ['-NoProfile', '-NonInteractive', '-Command', command]]] : []
}

const copy = (text: string): boolean => {
  // OSC 52 asks the terminal itself to set the clipboard, which works over SSH too; the
  // system's own tool is tried as well, since not every terminal honours it.
  // On a terminal the OSC 52 write counts as copied: over SSH it is often the only way there is.
  const isOsc = process.stdout.isTTY === true
  if (isOsc) process.stdout.write(`\u001b]52;c;${Buffer.from(text).toString('base64')}\u0007`)
  const tools: Array<[string, string[]]> =
    process.platform === 'darwin' ? [['pbcopy', []]] : process.platform === 'win32' ? windowsClipboard(text) : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['-b', '-i']]]
  // A clipboard tool that hangs (X forwarded over a slow link) must not freeze the board. PowerShell
  // takes about a second to start, so it gets 5 s; it reads the text from its command, not its input,
  // and runs hidden so no console window flashes.
  const isNative = tools.some(([tool, rest]) => {
    const isPowershell = tool === powershell()
    return spawnSync(tool, rest, { cwd: dirname(path), input: isPowershell ? undefined : text, stdio: ['pipe', 'ignore', 'ignore'], timeout: isPowershell ? 5000 : 2000, windowsHide: isPowershell }).status === 0
  })
  return isNative || isOsc
}

// A browser that starts and then exits with an error at once (no display, no sandbox) opened no
// window, so a launch counts only when it exits cleanly or is still running a moment later.
const LAUNCH_GRACE_MS = 750
const watchLaunch = (child: ChildProcess, onResult: (isOpen: boolean) => void): void => {
  let isSettled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (isOpen: boolean) => {
    if (isSettled) return
    isSettled = true
    if (timer !== undefined) clearTimeout(timer)
    onResult(isOpen)
  }
  child.once('error', () => finish(false))
  child.once('exit', code => finish(code === 0))
  child.once('spawn', () => {
    child.unref()
    timer = setTimeout(() => finish(true), LAUNCH_GRACE_MS)
  })
}

// A file or a page's address in the browser. The page's address holds only letters, digits,
// `:/?=._-`, so cmd's `start` reads it as one word.
const openInBrowser = (target: string, done: (isOpen: boolean) => void, asApp = false): void => {
  // A board a test started never opens a window on the tester's screen (#959).
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.AGENT_BOARD_TEST_PID) return done(false)
  const fallback = () => {
    const opener = process.platform === 'win32' ? [system32('cmd.exe'), ['/c', 'start', '', target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]]
    // Waited on only for the launch grace: with no desktop, xdg-open can run a text browser that
    // never returns, and the agent's command would wait with it.
    try {
      watchLaunch(spawn(opener[0] as string, opener[1] as string[], { cwd: dirname(path), detached: true, stdio: 'ignore', windowsHide: true }), done)
    } catch {
      done(false)
    }
  }

  if (!asApp) return fallback()

  const candidates: string[] = []
  if (process.platform === 'win32') {
    const progX86 = process.env['ProgramFiles(x86)'] || process.env.ProgramFiles
    const prog = process.env.ProgramFiles
    const local = process.env.LOCALAPPDATA
    if (progX86) candidates.push(join(progX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    if (prog) candidates.push(join(prog, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    if (local) candidates.push(join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    if (prog) candidates.push(join(prog, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    if (progX86) candidates.push(join(progX86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    if (local) candidates.push(join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    candidates.push('msedge', 'chrome')
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'google-chrome',
      'chrome',
    )
  } else {
    candidates.push(
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      'microsoft-edge',
      'microsoft-edge-stable',
    )
  }

  const tryCandidate = (index: number): void => {
    if (index >= candidates.length) return fallback()
    const bin = candidates[index]!
    try {
      if (bin.includes('/') || bin.includes('\\')) {
        if (!existsSync(bin)) return tryCandidate(index + 1)
      }
      const child = spawn(bin, [`--app=${target}`], { cwd: dirname(path), detached: true, stdio: 'ignore', windowsHide: false })
      watchLaunch(child, isOpen => isOpen ? done(true) : tryCandidate(index + 1))
    } catch {
      tryCandidate(index + 1)
    }
  }

  tryCandidate(0)
}

const isRegularFile = (file: string): boolean => {
  try {
    const stat = lstatSync(file)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

const isSymlinkOrNonRegular = (file: string): boolean => {
  try {
    const stat = lstatSync(file)
    return stat.isSymbolicLink() || !stat.isFile()
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ENOENT') return false
    return true
  }
}

// Into the archive first, then out of the file, as the pane does: a crash between the two
// leaves the work in both, never in neither. An entry already archived by an earlier try
// (another session wrote meanwhile) is not archived twice. How many entries went, or null
// when a file could not be written.
// Entries are counted with their number: two done blocks with the same title and steps make
// the same entry text, and both leave (#231).
const archiveOut = (take: (text: string, isLast: boolean) => { text: string; entries: string[] } | null | typeof AGAIN, now: number, onReplaced?: () => void): number | null => {
  const archived = new Map<string, number>()
  const pendingFile = pendingArchivePath(path)
  let pending: PendingArchiveRecord[] = []
  if (isRegularFile(pendingFile)) {
    try {
      pending = parsePendingArchive(read(pendingFile))
    } catch {}
  }
  let didRemove = false
  const wrote = rewrite(path, (text, isLast) => {
    didRemove = false
    const currentBoardHash = createHash('sha256').update(text).digest('hex')
    const taken = take(text, isLast)
    if (taken === AGAIN) return AGAIN
    if (taken === null) return text
    // Text changed with nothing to archive (a hidden date added to a finished step, #922).
    if (taken.entries.length === 0) return taken.text
    didRemove = true
    const fresh = unwrittenEntries(taken.entries, archived)
    if (fresh.length > 0 || archived.size > 0) {
      const month = archivePath(path, now)
      const part = partOf(month)
      // Earlier parts of this month keep the copy-count baseline stable across part rotations.
      const earlier = monthParts(month, existsSync).filter(one => one !== part).map(read)
      const kept = rewrite(part, past => {
        // A previous process may have saved the archive but failed to remove the task.
        const planned = nextPendingArchive([past, ...earlier], fresh, archived, pending, currentBoardHash)
        if (planned.missing.length === 0 && archived.size === 0) return past
        if (isSymlinkOrNonRegular(pendingFile)) {
          throw fileError(pendingFile, Object.assign(new Error('EEXIST: refusing to write symlinked or non-regular pending note'), { code: 'EEXIST' }))
        }
        const temp = `${pendingFile}.${process.pid}.${Date.now().toString(36)}.board-tmp`
        try {
          const fd = openSync(temp, 'wx', 0o600)
          closeSync(fd)
          writeFileSync(temp, JSON.stringify({ version: 1, boardHash: currentBoardHash, entries: planned.records }) + '\n')
          renameSync(temp, pendingFile)
        } catch (error) {
          try { unlinkSync(temp) } catch {}
          throw fileError(part, error)
        }
        pending = planned.records
        return planned.missing.length === 0 ? past : `${past.trim() === '' ? `${s.archiveTitle}\n\n` : past.replace(/\s*$/, '\n\n')}${planned.missing.join('\n\n')}\n`
      })
      if (kept === null) return null
      for (const entry of fresh) archived.set(entry, (archived.get(entry) ?? 0) + 1)
    }
    return taken.text
  }, onReplaced)

  if (wrote !== null && didRemove && isRegularFile(pendingFile)) {
    try {
      unlinkSync(pendingFile)
    } catch (error) {
      const rawCode = error !== null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
      const code = typeof rawCode === 'string' && /^[A-Z0-9_]+$/.test(rawCode) ? rawCode : undefined
      process.stderr.write(`${s.pendingNoteRemoveFailed(basename(pendingFile), code)}\n`)
    }
  }

  return wrote === null ? null : [...archived.values()].reduce((sum, one) => sum + one, 0)
}

// How long ago the hidden list was written; 0 when that cannot be told, so a list that is not
// JSON counts as a write caught half-way and a press never writes over the marks in it.
const answeredAge = (file: string): number => {
  try {
    return Date.now() - statSync(file).mtimeMs
  } catch {
    return 0
  }
}

// A press whose board write never landed takes back only the journal lines it added: lines
// that were there before, or that another writer added meanwhile, stay as they are. If that
// fails too, the board's own error is the true one: some changes may already be saved.
// Otherwise nothing of this press is left, so the count of writes goes back to before it.
const undoJournal = (added: Map<string, number>, journal: string, writesBefore: number, error?: unknown): void => {
  try {
    if (added.size > 0) rewrite(journal, past => {
      const remaining = new Map(added)
      return past.split(/(?<=\n)/).filter(line => {
        const entry = line.replace(/\r?\n$/, '')
        const count = remaining.get(entry) ?? 0
        if (count === 0) return true
        remaining.set(entry, count - 1)
        return false
      }).join('')
    })
  } catch (undoError) {
    throw error ?? undoError
  }
  writes = writesBefore
}

// What a key's action does to the files, and the line the board shows after it.
const act = (action: BoardAction, fallback?: { copyText?: string; tone?: 'done' | 'alert' }): string => {
  const done = (text: string): string => {
    if (fallback !== undefined) fallback.tone = 'done'
    return text
  }
  const now = Date.now()
  // Chosen once, so lines a failed press takes back come out of the part they went to.
  const journal = partOf(journalPath(path, now))
  if (action.type === 'copy') {
    if (copy(action.text)) return done(s.copied)
    if (fallback !== undefined) fallback.copyText = action.text
    return s.boardCopyFailed(action.text)
  }
  if (action.type === 'done') {
    let confirmed: ConfirmedTask | null = null
    const added = new Map<string, number>()
    let isReplaced = false
    const writesBefore = writes
    let wrote: string | null
    try {
      wrote = rewrite(path, text => {
        if (confirmed !== null && confirmMatches(text, confirmed.ref, s)) return text
        const next = confirmTask(text, action.ref, now, s, lastSeen, staleTimeoutMs())
        if (next === null) return null
        const lines = next.entries.map(entry => journalLine(entry, now, s))
        rewrite(journal, past => {
          const missing = lines.filter(line => !past.split(/\r?\n/).includes(line))
          for (const line of missing) added.set(line, Math.max(added.get(line) ?? 0, missing.filter(entry => entry === line).length))
          return appendJournal(past, missing, s)
        })
        confirmed = next
        return next.text
      }, () => { isReplaced = true })
    } catch (error) {
      if (!(error instanceof BoardFileError) || error.file !== path || isReplaced) throw error
      undoJournal(added, journal, writesBefore, error)
      error.isUnchanged = true
      throw error
    }
    // A retry found the task changed by another writer. If no write of this press landed, its
    // journal lines go too; the press says the line changed, as before.
    if (wrote === null && !isReplaced) undoJournal(added, journal, writesBefore)
    const found = confirmed as ConfirmedTask | null
    if (found === null || wrote === null || !confirmMatches(read(path), found.ref, s)) return s.boardLineChanged
    return done(s.confirmedDone(action.title))
  }
  if (action.type === 'tick') {
    // Found once is found: a retry after another session's write may meet the step already
    // ticked by this press.
    let isFound = false
    let isReplaced = false
    const writesBefore = writes
    const added = new Map<string, number>()
    const line = journalLine({ project: action.ref.project, task: action.ref.title, step: action.ref.step }, now, s)
    let wrote: string | null
    try {
      wrote = rewrite(path, text => {
        const after = setManualStep(text, action.ref, 'x', now)
        if (after !== text) {
          // Save history before ticking: a journal failure must leave the step available
          // to retry. A failed board replacement removes only this press's journal line.
          rewrite(journal, past => {
            if (past.includes(line)) return past
            added.set(line, 1)
            return appendJournal(past, [line], s)
          })
          isFound = true
        }
        return after
      }, () => { isReplaced = true })
    } catch (error) {
      if (!(error instanceof BoardFileError) || error.file !== path || isReplaced) throw error
      undoJournal(added, journal, writesBefore, error)
      error.isUnchanged = true
      throw error
    }
    if (wrote === null) return s.boardWriteFailed
    if (!isFound) return s.boardTickGone
    return done(s.boardTicked(action.ref.step))
  }
  if (action.type === 'archive') {
    view()
    const projects = parseProgress(read(path))
    const ledger = readQuestions(questionsPath(path))
    const hasQuestions = refTasks(projects, action.ref).some(task => task.steps.some(step => step.status === 'waiting'))
    if (hasQuestions && (ledger === null || !archiveQuestionsKept(projects, action.ref, ledger))) return s.questionRetentionFailed
    let retentionFailed = false
    const count = archiveOut(text => {
      const current = parseProgress(text)
      const asking = refTasks(current, action.ref).some(task => task.steps.some(step => step.status === 'waiting'))
      if (asking && !keepAskedQuestions(current, action.ref, now, cutOffScopes(current, cutOffSpans(text, isCutSettledAt(now))))) {
        retentionFailed = true
        return { text, entries: [] }
      }
      return takeTask(text, action.ref, now, s, lastSeen, staleTimeoutMs())
    }, now)
    if (retentionFailed) return s.questionRetentionFailed
    if (count === null) return s.boardWriteFailed
    if (count === 0) return s.archiveGone
    // Not through view(), which may rewrite the question list and throw: a list another process holds
    // for a moment must not change what is said about an archive that has already happened.
    try {
      const source = read(path)
      const after = parseProgress(source)
      const latest = readQuestions(questionsPath(path))
      const proofs = readQuestionProofs()
      const frozen = cutOffScopes(after, cutOffSpans(source, isCutSettledAt(now)))
      const kept = latest === null || proofs === null ? 0 : keptQuestionCount(buildView(after, [], null, now, 0, {}, s, parseAnswered(read(answeredPath(path))) ?? [], {}, latest, proofs, pending(), frozen, undefined, staleTimeoutMs()), action.ref, s)
      return done(kept > 0 ? s.archivedKeptQuestions(action.title, kept) : s.archivedOne(action.title))
    } catch {
      return done(s.archivedOne(action.title))
    }
  }
  if (action.type === 'hide' || action.type === 'unhide') {
    // The list every pane on this machine reads too; nothing goes to the agent that asked.
    const current = view()
    if (readQuestions(questionsPath(path)) === null) return s.hideFailed
    const keys = action.type === 'hide' || action.key !== null ? [action.key ?? ''] : current.hidden.map(item => item.hideKey)
    if (keys.length === 0) return s.pressNothing
    const isHidden = action.type === 'hide'
    const file = answeredPath(path)
    // A list the board cannot read or replace is named with its error, as its other files are.
    const wrote = rewrite(file, before => {
      const answered = parseAnswered(before, answeredAge(file))
      const latest = readQuestions(questionsPath(path))
      const persisted = parseQuestions(read(questionsPath(path)))
      const proofs = readQuestionProofs()
      // A question kept from an archived block has a retired identity and no longer waits on the board, and can still be hidden (#400).
      const isKept = (key: string): boolean => latest !== null && isKeptQuestion(latest, key)
      if (proofs === null || (isHidden && keys.some(key => proofs.retired.includes(sha256(key)) && !isKept(key)))) return null
      if (latest === null || persisted === null || (isHidden && keys.some(key => !isKept(key) && !persisted.records.some(record => record.id === key && record.isWaiting && record.isPresent)))) return null
      const source = read(path)
      const projects = parseProgress(source)
      const frozen = cutOffScopes(projects, cutOffSpans(source, isCutSettledAt(now)))
      const fresh = buildView(projects, [], null, now, 0, {}, s, answered ?? [], {}, latest, proofs, pending(), frozen, undefined, staleTimeoutMs())
      if (isHidden && keys.some(key => ![...fresh.waiting, ...(fresh.reminder ?? []), ...(fresh.older ?? []), ...fresh.hidden].some(item => item.canHide !== false && item.hideKey === key))) return null
      const aliases = observeQuestions(latest, projects, null, answered ?? [], now, true, 'preview', undefined, [], [], frozen).ledger
      return answered === null ? null : answeredJson(withAnswered(answered, isHidden ? keys : keys.flatMap(key => acknowledgementKeys(aliases, key)), isHidden))
    })
    if (wrote === null) return s.hideFailed
    return done(action.type === 'hide' ? s.boardHidden(action.text) : s.boardShown)
  }

  return s.pressNothing
}

// Archive and journal months before the last three move to an archives folder beside them (#922).
// A name the folder already holds, or a move that fails, leaves the file for the next pass.
const moveOldMonths = (): void => {
  try {
    const dir = dirname(path)
    const stem = basename(path).replace(/\.md$/i, '')
    const now = Date.now()
    const names = readdirSync(dir)
    if (!names.some(name => oldMonthFiles(stem, [name], [], now).length > 0)) return
    const folder = join(dir, OLD_MONTHS_FOLDER)
    const taken = existsSync(folder) ? readdirSync(folder) : []
    for (const name of oldMonthFiles(stem, names, taken, now)) {
      try {
        mkdirSync(folder, { recursive: true })
        const target = join(folder, name)
        if (!existsSync(target)) renameSync(join(dir, name), target)
      } catch {}
    }
  } catch {}
}

// Scheduled sweeps keep the plugin's age rules. An explicit interactive tidy may move
// finished work at once; neither mode discards a stopped session before its three days.
const tidyCount = (isNow: boolean, isStrict = false, isCleanUp = false, counted?: (finished: number) => void): number | null => {
  // The sweep and the tidy take blocks; a pending capture must land first (#921).
  drainQuestionCaptures()
  const now = Date.now()
  let seen: Record<string, number> = {}
  if (!isNow) {
    try {
      const text = read(seenPath(path))
      // The page's sweep writes nothing on a seen file it cannot read: half written, damaged or the wrong shape.
      if (isStrict && !isSeenText(text)) return 0
      seen = parseSeen(text, answeredAge(seenPath(path))) ?? {}
    } catch {
      if (isStrict) return 0
      // Unknown manual ages stay; an unreadable hint need not block dated agent blocks.
    }
  }
  // The blocks that ask which a try has archived, by session, with the lines they had then.
  const moved = new Map<string, string>()
  const runCache = new Map<string, boolean>()
  const codexHome = resolve(flag('--codex-dir') ?? (process.env.CODEX_HOME || join(homedir(), '.codex')))
  const cursorPath = `${path.replace(/\.md$/i, '')}-run-cursor.txt`
  const cursor = read(cursorPath).trim()
  const lookupKey = (id: string): string => sha256(`${codexHome}\0${id}`)
  let nextCursor = cursor
  // The run questions each try closes, and those of every try whose write landed: only a landed
  // write closes them (#511), even when its read-back then fails and a later try finds no block.
  let closing: QuestionRecord[] = []
  const landed = new Map<string, QuestionRecord>()
  // Read on the sweep only, never on a poll; a missing or unreadable file means the default.
  let historyDays = HISTORY_DAYS
  if (!isNow && !isCleanUp) {
    try {
      historyDays = historyDaysOf(read(settingsPath(path)))
    } catch {}
  }
  const count = archiveOut((text, isLast) => {
    closing = []
    const lines = text.split(/\r?\n/)
    const spans = scanBlocks(lines)
    const runs = new Set<number>()
    const ids = [...new Set([...spans].sort((a, b) => b.updated - a.updated || b.start - a.start).flatMap(span => {
      const id = span.isClosed ? runLookupId(lines[span.start] ?? '') : null
      return id === null ? [] : [id]
    }))]
    // Resume after the last lookup so retained and unreadable blocks cannot starve older runs.
    // Only the cursor survives a tidy; every archive still needs fresh proof from the history.
    const first = ids.findIndex(id => lookupKey(id) === cursor) + 1
    for (const id of [...ids.slice(first), ...ids.slice(0, first)]) {
      if (runCache.has(id)) continue
      // The cache is shared by rewrite retries, keeping the whole tidy within fifty lookups.
      if (runCache.size >= 50) break
      const file = findSessionFile(codexHome, id)
      const signal = file === null ? undefined : codexSignal(true, file, readSessionMeta(file, id))
      runCache.set(id, signal !== undefined && isStrongRun(signal))
      nextCursor = lookupKey(id)
    }
    for (const span of spans) if (span.isClosed && runCache.get(runLookupId(lines[span.start] ?? '') ?? '') === true) runs.add(span.start)
    if (!isNow && counted) counted(countManualDone(parseProgress(text), now, (_key, project, task) => handKeptSeenAt(seen, project, task, now)))
    // A block that still asks goes only when the explicit archive's own check passes for it (#174).
    // A board busy enough to change on every try would skip the whole sweep, so the last try checks
    // no question and the rest (done blocks, hand-kept tasks) goes ahead, as the pane's sweep does.
    // A block that asks stays then, unless an earlier try archived it and it still reads the same:
    // its questions are kept and its copy is in the archive, so it leaves as counted.
    const asking = archivableAsking(text, now).filter(one => !runs.has(one.span.start))
    const kept = new Set<number>()
    if (isLast) {
      for (const { span, text: lines } of asking) if (moved.get(span.session) === lines) kept.add(span.start)
    } else {
      const projects = parseProgress(text)
      const frozen = cutOffScopes(projects, cutOffSpans(text, isCutSettledAt(now)))
      for (const { span, ref } of asking) {
        try {
          if (keepAskedQuestions(projects, ref, now, frozen)) kept.add(span.start)
        } catch (error) {
          // A copy that cannot be written keeps the block, as a failed check does.
          if (!(error instanceof BoardFileError)) throw error
        }
      }
      // Another agent's write during the question check (a new `[?]` step) is read again before
      // anything is archived. One that lands after this read is caught by `rewrite` once the
      // archive is written, and the next try starts again from it.
      if (asking.length > 0 && read(path) !== text) return AGAIN
    }
    const blocks = takeArchivable(text, now, undefined, s, isNow, span => kept.has(span.start), span => runs.has(span.start))
    const manual = !isNow && !isCleanUp && !isHandKeptMoveOn
      ? { text: blocks.text, entries: [], keys: [] }
      : takeManualDone(blocks.text, now, (_key, project, task) => handKeptSeenAt(seen, project, task, now), s, isNow)
    // The unattended sweep also dates the finished steps of hand-kept tasks it has not seen done,
    // and moves the ones dated more than the history days ago (#922).
    const history = isNow || isCleanUp ? null : sweepHistory(manual.text, now, historyDays, s)
    const entries = [...blocks.entries, ...manual.entries, ...(history?.entries ?? [])]
    if (entries.length === 0) return history === null || history.text === manual.text ? null : { text: history.text, entries: [] }
    // A verified run goes without keeping its questions, so they close with its block (#511); the
    // ledger would otherwise keep them open with no block left to hide them. A try that does not land
    // (another session's write, a retry) closes none.
    let ledger: QuestionLedger | null = null
    try {
      if (runs.size > 0) ledger = readQuestions(questionsPath(path))
    } catch (error) {
      // A ledger that cannot be read closes nothing; the run is archived as before.
      if (!(error instanceof BoardFileError)) throw error
    }
    if (ledger !== null) {
      const projects = parseProgress(text)
      for (const span of spans) {
        if (!runs.has(span.start)) continue
        const tasks = projects.filter(project => project.name === span.project).flatMap(project => project.tasks).filter(task => task.auto?.session === span.session)
        const task = tasks[0]
        if (tasks.length !== 1 || task === undefined) continue
        closing.push(...runQuestionsClosed(ledger, { project: span.project, title: task.title, line: task.line, session: span.session }, task, now))
      }
    }
    for (const { span, text: lines } of asking) if (kept.has(span.start)) moved.set(span.session, lines)
    return { text: history?.text ?? manual.text, entries }
  }, now, () => { for (const record of closing) landed.set(record.id, record) })
  if (count !== null && count > 0) for (const record of landed.values()) keepQuestionCapture(record, 'resolved')
  if (nextCursor !== cursor) rewrite(cursorPath, () => `${nextCursor}\n`)
  return count
}

// A bulk archive is two steps: a preview names the count, and a second step confirms
// it. Between the two the file may change, so the confirm re-previews and refuses any
// block whose session, project or fingerprint no longer matches. Every block that moves
// leaves an audit marker in the journal, and a block that still asks goes only when its
// questions are kept, as the single archive does.
const tidyAudit = (candidate: TidyCandidate, state: 'prepared' | 'committed', now: number): string =>
  `<!-- agent-board-tidy ${JSON.stringify({ state, at: new Date(now).toISOString(), session: candidate.ref.session, project: candidate.ref.project, title: candidate.ref.title, fingerprint: candidate.fingerprint })} -->`

const bulkTidyPreviews = new Map<string, { preview: TidyPreview; expires: number }>()

const bulkTidy = (request: { kind: 'preview'; selector: TidySelector } | { kind: 'confirm'; token: string; preview: TidyPreview } | { kind: 'cancel'; token: string }): { ok: boolean; note: string; token?: string; preview?: TidyPreview; count?: number } => {
  const now = Date.now()
  if (request.kind === 'cancel') {
    bulkTidyPreviews.delete(request.token)
    return { ok: true, note: s.tidyCancelled }
  }
  if (request.kind === 'preview') {
    // A request that arrives over HTTP may carry any shape; only a selector that
    // validates is honoured, so a malformed one cannot silently mean "stopped".
    const raw = request.selector
    const selector = tidySelector(raw.kind, raw.kind === 'agent' ? raw.value : raw.kind === 'older' ? String(raw.days) : undefined)
    if (selector === null) return { ok: false, note: s.tidyInvalid }
    const text = read(path)
    const preview = previewTidy(text, selector, now, s, staleTimeoutMs())
    const token = randomUUID()
    bulkTidyPreviews.set(token, { preview, expires: now + 5 * 60000 })
    if (bulkTidyPreviews.size > 16) for (const [old] of bulkTidyPreviews) { bulkTidyPreviews.delete(old); break }
    return { ok: true, note: s.tidyPreviewCount(preview.candidates.length), token, preview, count: preview.candidates.length }
  }
  const entry = bulkTidyPreviews.get(request.token)
  // The page round-trips the preview through JSON, so the comparison is structural, not
  // by reference: a reference check would refuse every confirm that came over HTTP.
  if (entry === undefined || JSON.stringify(entry.preview) !== JSON.stringify(request.preview) || entry.expires <= now) {
    bulkTidyPreviews.delete(request.token)
    return { ok: false, note: s.tidyExpired }
  }
  bulkTidyPreviews.delete(request.token)
  const staleMs = staleTimeoutMs()
  let moved = 0
  let refused = 0
  for (const candidate of entry.preview.candidates) {
    const body = read(path)
    const current = currentTidyCandidate(body, entry.preview, candidate, s, staleMs)
    if (current === undefined) { refused += 1; continue }
    const projects = parseProgress(body)
    const frozen = cutOffScopes(projects, cutOffSpans(body, isCutSettledAt(now)))
    if (current.asks && !keepAskedQuestions(projects, current.ref, now, frozen)) { refused += 1; continue }
    // The marker goes in first: a crash after it leaves the block in place with a
    // prepared marker, never an archived block with no audit trail.
    rewrite(journalPath(path, now), text => appendJournal(text, [tidyAudit(current, 'prepared', now)], s))
    const taken = archiveOut((text, isLast) => {
      // Recheck at the write boundary: the block may have changed after the
      // preview check, while the prepared marker was written, or on a retry.
      // takeTask alone checks ownership and staleness, not the fingerprint or
      // the question retention, so a changed block would otherwise be archived
      // and its new question lost.
      const fresh = currentTidyCandidate(text, entry.preview, candidate, s, staleMs)
      if (fresh === undefined) return null
      const freshProjects = parseProgress(text)
      if (fresh.asks && !keepAskedQuestions(freshProjects, fresh.ref, now, cutOffScopes(freshProjects, cutOffSpans(text, isCutSettledAt(now))))) return null
      const again = takeTask(text, fresh.ref, now, s, {}, staleMs)
      if (again === null) return null
      if (isLast) return { text: again.text, entries: again.entries }
      if (read(path) !== text) return AGAIN
      return { text: again.text, entries: again.entries }
    }, now, () => rewrite(journalPath(path, now), text => appendJournal(text, [tidyAudit(current, 'committed', now)], s)))
    if (taken === null || taken === 0) {
      // Another agent's archive landed first, or the question check failed after the
      // preview: the block stays, and the prepared marker says it was never committed.
      refused += 1
      continue
    }
    moved += taken
  }
  if (moved === 0 && refused > 0) return { ok: false, note: s.tidyPartial(moved, refused) }
  return { ok: true, note: refused > 0 ? s.tidyPartial(moved, refused) : s.tidyResult(moved), count: moved }
}

// The command line asks once and acts once: without a terminal there is no second press,
// so a selector without one only previews and changes nothing.
const runBulkTidy = (): boolean => {
  const kinds = ['--stopped', '--agent', '--older'].filter(one => args.includes(one))
  if (kinds.length === 0) return false
  if (kinds.length > 1) {
    process.stdout.write(`${s.tidyInvalid}\n`)
    process.exitCode = 1
    return true
  }
  const selector = tidySelector(kinds[0]?.slice(2), kinds[0] === '--agent' ? flag('--agent') : kinds[0] === '--older' ? flag('--older') : undefined)
  if (selector === null) {
    process.stdout.write(`${s.tidyInvalid}\n`)
    process.exitCode = 1
    return true
  }
  const preview = bulkTidy({ kind: 'preview', selector })
  if (process.stdin.isTTY !== true) {
    process.stdout.write(`${preview.note}\n${s.tidyNeedsTerminal}\n`)
    return true
  }
  process.stdout.write(`${s.tidyConfirmPrompt(preview.count ?? 0)}\n`)
  let answer = ''
  const chunk = Buffer.alloc(1024)
  let readBytes: number | null = 0
  while (readBytes !== null && !answer.includes('\n')) {
    readBytes = (() => { try { return readSync(0, chunk, 0, chunk.length, null) } catch { return null } })()
    if (readBytes !== null && readBytes > 0) answer += chunk.subarray(0, readBytes).toString('utf8')
  }
  if (answer.trim() !== 'ARCHIVE') {
    bulkTidy({ kind: 'cancel', token: preview.token ?? '' })
    process.stdout.write(`${s.tidyCancelled}\n`)
    return true
  }
  const result = bulkTidy({ kind: 'confirm', token: preview.token ?? '', preview: preview.preview as TidyPreview })
  process.stdout.write(`${result.note}\n`)
  if (!result.ok) process.exitCode = 1
  return true
}

const tidyNote = (count: number | null, isNow: boolean, finished = 0): string =>
  count === null ? s.boardWriteFailed : count === 0 ? (isNow ? s.tidyNothing : finished > 0 ? s.canArchive(finished) : s.tidyScheduledNothing) : s.tidyMoved(count)

const tidy = (isNow = true): string => {
  let finished = 0
  const count = tidyCount(isNow, false, false, count => { finished = count })
  if (!isNow) moveOldMonths()
  if (count === null && !isNow) process.exitCode = 1
  return tidyNote(count, isNow, finished)
}

// A person's Clean up moves the due hand-kept tasks as well as the normal sweep's blocks.
// An unreadable completion record stops the whole press before any write.
const cleanUp = (): string => {
  try {
    if (!isSeenText(read(seenPath(path)))) return s.cleanSeenUnreadable
  } catch {
    return s.cleanSeenUnreadable
  }
  return tidyNote(tidyCount(false, true, true), false)
}

// Keys as the terminal sends them, named the way boardKey reads them. One read can hold more
// than one key (a held arrow, a paste).
const keyName = (one: string): string =>
  one === '\u001b[A' || one === '\u001bOA' ? 'up' : one === '\u001b[B' || one === '\u001bOB' ? 'down' : one === '\r' || one === '\n' ? 'enter' : one
// An escape and the character after it (Alt with a letter) is one key the board ignores.
const keysIn = (chunk: string): string[] => (chunk.replace(/\r\n/g, '\r').match(/\u001b[[O][0-9;]*[A-Za-z~]|\u001b[\s\S]?|[\s\S]/gu) ?? []).map(keyName)

const failureNote = (error: unknown): string => {
  process.exitCode = 1
  if (error instanceof Error && error.message === 'INVALID_STALE_MS') {
    process.stderr.write(`INVALID_STALE_MS: ${s.invalidStaleMs}\n`)
    return s.invalidStaleMs
  }
  if (!(error instanceof BoardFileError)) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    return s.pressFailed
  }
  const note = storageNote(error)
  process.stderr.write(`${note}\n`)
  return note
}

type Send = Extract<BoardAction, { type: 'send' }>

const press = (state: BoardState, key: string): { state: BoardState; isQuit: boolean; isHtml: boolean; isWrite: boolean; send?: Send } => {
  const shown = freshView()
  const items = boardItems(shown, pending(), state.isIdleOpen ?? false, state.isOlderOpen ?? false)
  // A bulk archive previews on the first A and confirms on the second; any other key
  // drops the pending preview and acts as usual.
  if (key === 'A') {
    try {
      if (state.bulkTidy !== undefined) {
        const result = bulkTidy({ kind: 'confirm', token: state.bulkTidy.token, preview: state.bulkTidy.preview })
        return { state: { ...state, bulkTidy: undefined, key: null, note: result.note, tone: result.ok ? 'done' : 'alert' }, isQuit: false, isHtml: false, isWrite: result.ok }
      }
      const preview = bulkTidy({ kind: 'preview', selector: { kind: 'stopped' } })
      if (!preview.ok || preview.token === undefined || preview.preview === undefined) {
        return { state: { ...state, key: null, note: preview.note, tone: 'alert' }, isQuit: false, isHtml: false, isWrite: false }
      }
      return { state: { ...state, bulkTidy: { token: preview.token, preview: preview.preview }, key: null, note: `${preview.note} ${s.tidyConfirmKey}`, tone: 'quiet' }, isQuit: false, isHtml: false, isWrite: false }
    } catch (error) {
      return { state: { ...state, bulkTidy: undefined, key: null, note: failureNote(error), tone: 'alert' }, isQuit: false, isHtml: false, isWrite: false }
    }
  }
  const { state: next, action } = boardKey(state.bulkTidy === undefined ? state : { ...state, bulkTidy: undefined }, key, items, s, routes)
  if (action === null) return { state: next, isQuit: false, isHtml: false, isWrite: false }
  if (action.type === 'quit') return { state: next, isQuit: true, isHtml: false, isWrite: false }
  if (action.type === 'html') return { state: { ...next, note: s.pressPending, tone: 'quiet' }, isQuit: false, isHtml: true, isWrite: false }
  // The page sends it; the note says so until its answer comes back.
  if (action.type === 'send') return { state: { ...next, note: s.serveSending(agentLabel(action.route.agent || 'claude', s)), tone: 'quiet' }, isQuit: false, isHtml: false, isWrite: false, send: action }
  if (action.type === 'tidy') {
    let note: string
    try {
      note = tidy()
    } catch (error) {
      note = failureNote(error)
    }
    return { state: { ...next, key: null, note, tone: note === s.boardWriteFailed ? 'alert' : 'done' }, isQuit: false, isHtml: false, isWrite: true }
  }

  // After a write the lines move; the choice is made again from the screen drawn next.
  let note: string
  const fallback: { copyText?: string; tone?: 'done' | 'alert' } = { tone: 'alert' }
  try {
    note = act(action, fallback)
  } catch (error) {
    note = failureNote(error)
  }
  return { state: { ...next, key: null, note, tone: fallback.tone, copyText: fallback.copyText, result: next.result === undefined ? undefined : { ...next.result, revision: null } }, isQuit: false, isHtml: false, isWrite: action.type !== 'copy' }
}

// The agents that reported here, for an empty board to name: from the turns their hooks left.
const agentsHere = (shown: ReturnType<typeof view>, turns: ReturnType<typeof pending>): string[] => {
  if (!isEmptyBoard(shown, turns)) return []
  let names: string[] = []
  try {
    names = readdirSync(join(dirname(path), 'progress-inbox'))
  } catch {}
  return boardAgents(names, shown, turns)
}

const screen = (state: BoardState): string => {
  const shown = view()
  const turns = pending()
  return boardScreen(shown, turns, state, s, { ...options(), agents: agentsHere(shown, turns) })
}

// What the screen shows is what the next key acts on.
const pin = (state: BoardState): BoardState => pinned(state, boardItems(view(), pending(), state.isIdleOpen ?? false, state.isOlderOpen ?? false))

// The running page, found without making its folder: the terminal board only looks for one.
const runningAddress = async (): Promise<Running | null> => {
  const runtime = process.env.XDG_RUNTIME_DIR
  const folder = process.platform === 'win32' ? (runtime ? join(runtime, 'agent-board') : join(homedir(), '.cache', 'agent-board')) : runtime && isOwnFolder(runtime) ? runtime : join(homedir(), '.cache', 'agent-board')
  if (!existsSync(folder)) return null
  try {
    if (process.platform !== 'win32') return readRunning()
    if (served === undefined) {
      const name = addressFileName(board(path))
      let root: string
      try { root = await privateRuntimeFolderAsync(folder, [name]) }
      catch (error) { root = readOnlyRunFolder(folder, error) }
      served = join(root, name)
    }
    if (!isOwnAddressFile(served)) return null
    const source = (await readPrivateRuntimeFileAsync(served))?.text
    return source === undefined ? null : parseRunning(source)
  } catch {
    return null
  }
}

// Which questions the running page answers into their session; true when that changed. With no
// page, or none that answers, every answer key copies.
let routeRefresh: Promise<boolean> | null = null
const refreshRoutes = async (): Promise<boolean> => {
  if (routeRefresh !== null) return false
  routeRefresh = updateRoutes()
  try { return await routeRefresh }
  finally { routeRefresh = null }
}
const updateRoutes = async (): Promise<boolean> => {
  const running = await runningAddress()
  let next: Record<string, AnswerRoute> = {}
  if (running !== null) {
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/api/board`, { headers: { 'x-board-token': tokenOf(running.url) }, signal: AbortSignal.timeout(1500) })
      if (res.ok) next = routesOf(((await res.json()) as { model?: unknown } | null)?.model)
    } catch {}
  }
  const isChanged = JSON.stringify(next) !== JSON.stringify(routes)
  routes = next
  return isChanged
}

// An answer key's answer, sent by the running page as its own button sends it: the page checks
// the line, the question and the session again, and answers with what came of it.
const sendAnswer = async (action: Send): Promise<{ note: string; tone: 'done' | 'alert' }> => {
  const running = await runningAddress()
  if (running === null) return { note: s.messagesFailed, tone: 'alert' }
  const { route } = action
  const body = route.mode === 'connected' && route.delivery !== undefined
    ? { key: action.key, type: 'message', id: `AB-${randomUUID()}`, text: action.text, connection: route.delivery.id, turn: route.delivery.turn, session: route.session, asked: route.asked, fp: route.fp }
    : { key: action.key, type: 'send', text: action.text, session: route.session, asked: route.asked, fp: route.fp }
  try {
    // A closed session is started to take it, and answers only once it is done.
    const res = await fetch(`http://127.0.0.1:${running.port}/api/act`, { method: 'POST', headers: { 'x-board-token': tokenOf(running.url), 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(route.mode === 'send' ? 300_000 : 5000) })
    const data = (await res.json().catch(() => null)) as { note?: unknown } | null
    const note = typeof data?.note === 'string' && data.note !== '' ? data.note : res.ok ? s.messagesQueued : s.messagesFailed
    // What was sent leads the note, so a key pressed by mistake shows at once.
    return res.ok ? { note: s.boardAnswered(action.text, note), tone: 'done' } : { note, tone: 'alert' }
  } catch {
    return { note: s.messagesFailed, tone: 'alert' }
  }
}

// A block pasted into the page from a web chat, merged the way the remote reporter's merge
// does: read, change only that block, write, read back.
const paste = (text: string, reviewToken = '') => {
  let latest: ReturnType<typeof mergeBlock> | null = null
  const wrote = rewrite(path, before => {
    latest = mergeBlock(before, text, Date.now(), s, reviewToken)
    return 'problem' in latest ? null : latest.text
  })
  const found = latest as ReturnType<typeof mergeBlock> | null
  if (found !== null && 'problem' in found) {
    const why = found.problem === 'oldTime' ? s.pasteOldTime(found.daysBehind)
      : { noBlock: s.pasteNoBlock, mixed: s.pasteMixed, badBlock: s.pasteBadBlock, noProject: s.pasteNoProject, notYours: s.pasteNotYours, badTime: s.pasteBadTime, futureTime: s.pasteFutureTime, older: s.pasteOlder, conflict: s.pasteConflict, unknownOrder: s.pasteUnknownOrder }[found.problem]
    return { isAdded: false, note: s.servePasteRefused(why), review: found.review }
  }
  if (wrote === null || found === null) return { isAdded: false, note: s.boardWriteFailed }
  return { isAdded: true, note: found.isUnchanged ? s.pasteUnchanged : s.servePasted(found.title) }
}

// Windows temp folders can grant sandbox accounts access. Protect only our dedicated child,
// never the caller's whole runtime directory, before a token can be written.
// `name` is the address file: it is read in the same check as the folder when it is already there.
let runtimeUnprotected = false
// Whether the folder check that failed ran out of time: the person is told the check did not
// finish, not that the file could not be protected (#799).
let runtimeCheckTimedOut = false
const readOnlyRunFolder = (folder: string, error: unknown): string => {
  if (!(error instanceof RuntimeFolderError)) throw error
  if (error instanceof RuntimeFolderTimeoutError) runtimeCheckTimedOut = true
  // A process that cannot protect the folder may reuse a running page, but every later
  // step must refuse to start one or write through this unprotected path.
  runtimeUnprotected = true
  return unprotectedRuntimeFolder(folder)
}
const runFolder = (name: string): string => {
  const runtime = process.env.XDG_RUNTIME_DIR
  if (process.platform === 'win32') {
    const folder = runtime ? join(runtime, 'agent-board') : join(homedir(), '.cache', 'agent-board')
    try {
      return privateRuntimeFolder(folder, [name])
    } catch (error) {
      return readOnlyRunFolder(folder, error)
    }
  }
  if (runtime && isOwnFolder(runtime)) return runtime
  const own = join(homedir(), '.cache', 'agent-board')
  try {
    mkdirSync(own, { recursive: true, mode: 0o700 })
  } catch {}
  return own
}

// Where a running page leaves its address, so the next `--serve` opens that page instead of a
// second one. Not beside progress.md: the address holds the page's token, and that folder is
// often a git repository that syncs itself. One file per progress.md. `built` is when this
// script was written: a page started by an older copy (before an update) is closed and
// started again.
// Worked out only when serving, so a plain print makes no folder.
let served: string | undefined
// The same progress.md named two ways (C:/x and C:\x) is one board, with one page.
const board = (file: string): string => resolve(file)
const serveFile = (): string => {
  if (served !== undefined) return served
  const name = addressFileName(board(path))
  return (served = join(runFolder(name), name))
}
const messagesDirectory = (): string => resolve(flag('--messages-dir') ?? (args.includes('--mcp') ? defaultMessagesDirectory(path, homedir(), process.env, process.platform) : serveFile().replace(/\.json$/, '-messages')))
// Where 0.19.0 left it, beside progress.md.
const oldServeFile = `${path.replace(/\.md$/i, '')}-serve.json`
const script = process.argv[1] ?? ''
const built = (() => {
  if (args.includes('--status')) return ''
  try {
    return String(statSync(script).mtimeMs)
  } catch {
    return ''
  }
})()

type Running = { pid: number; port: number; url: string; path: string; built: string }

const parseRunning = (text: string): Running | null => {
  try {
    const found = JSON.parse(text) as Partial<Running> | null
    if (found === null || typeof found !== 'object') return null
    // A private file can still have been renamed from another board's old shared folder.
    // Its token authorizes requests only after it is bound to the requested progress file.
    return typeof found.pid === 'number' && typeof found.port === 'number' && typeof found.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/.test(found.url)
      && typeof found.path === 'string' && board(found.path) === board(path)
      ? { pid: found.pid, port: found.port, url: found.url, path: found.path, built: String(found.built ?? '') }
      : null
  } catch { return null }
}

const isOwnAddressFile = (file: string): boolean => {
  const own = lstatSync(file)
  return !own.isSymbolicLink() && (process.getuid === undefined || own.uid === process.getuid())
}
const readRunning = (file = serveFile()): Running | null => {
  try {
    // Only a file of this account's own, never a link to one somewhere else.
    if (!isOwnAddressFile(file)) return null
    const source = process.platform === 'win32' ? readPrivateRuntimeFile(file)?.text : read(file)
    return source === undefined ? null : parseRunning(source)
  } catch {
    return null
  }
}

const tokenOf = (url: string): string => new URL(url).searchParams.get('t') ?? ''

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // Gone, or running as another account, whose program took the number since.
    return false
  }
}

const unlinkIf = (file: string, isIt: () => boolean): void => {
  try {
    if (isIt()) unlinkSync(file)
  } catch {}
}

// The running page's own answer; null when nothing there answers like a board page (nobody at
// the address, or another program), and 'silent' when something takes the connection but says
// nothing in time.
const ping = async (running: Running, waitMs = 1500): Promise<Record<string, unknown> | 'silent' | null> => {
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/api/ping`, { headers: { 'x-board-token': tokenOf(running.url) }, signal: AbortSignal.timeout(waitMs) })
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null
  } catch (error) {
    return error instanceof Error && error.name === 'TimeoutError' ? 'silent' : null
  }
}

// A board page counts as an open window only if it reported itself visible within this long. A visible page asks every
// 3 seconds; a hidden or minimized one does not count, so opening the board then shows a window (#265). Only a test
// process may shorten it.
const PAGE_OPEN_MS = (): number => (process.env.AGENT_BOARD_TEST_PID && Number(process.env.AGENT_BOARD_PAGE_OPEN_MS) > 0 ? Math.min(Number(process.env.AGENT_BOARD_PAGE_OPEN_MS), 10_000) : 10_000)
const pageIsOpen = async (server: RunningServer): Promise<boolean> => {
  if (server.isNew) return false
  const answer = await ping({ pid: 0, port: server.port, url: server.url, path: '', built: '' })
  return answer !== null && answer !== 'silent' && typeof answer.pageAgo === 'number' && answer.pageAgo >= 0 && answer.pageAgo < PAGE_OPEN_MS()
}

const serveChild = (): void => {
  // Resolve the protected address before asynchronous callbacks can run.
  const file = serveFile()
  // A child that could not protect the folder cannot start a page: its address file would
  // be unprotected. The parent reuses a running page itself; a child on its own refuses.
  if (runtimeUnprotected) throw runtimeCheckTimedOut ? new RuntimeFolderTimeoutError() : new RuntimeFolderError()
  // A page a test started stops once that test's process is gone, even after a killed run (#959).
  // Only tests set AGENT_BOARD_TEST_PID, to their own process id.
  const testPid = Number(process.env.AGENT_BOARD_TEST_PID)
  if (Number.isInteger(testPid) && testPid > 0) {
    setInterval(() => {
      try {
        process.kill(testPid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return
        unlinkIf(file, () => readRunning(file)?.pid === process.pid)
        process.exit(0)
      }
    }, 2000).unref()
  }
  try {
    startServer({
      allowResume: args.includes('--allow-resume'),
      messagesDirectory: messagesDirectory(),
      isDefaultMessagesDirectory: flag('--messages-dir') === undefined,
      reports: (isFresh = true) => {
        // A page snapshot follows its synchronous view read. Handoff requests
        // still read current bytes instead of accepting an older page's baseline.
        const projects = !isFresh && progressProjectCache !== null ? progressProjectCache.projects : parseProgress(read(path))
        return projects.flatMap(project => project.tasks.flatMap(task => task.auto === null ? [] : [{ agent: task.auto.agent, session: task.auto.resume ?? task.auto.session, updated: task.auto.updated }]))
      },
      s,
      port: Number(flag('--port') ?? 0) || 0,
      ping: { path, built, idleMs: idleMs(), staleMs: staleTimeoutMs(), allowResume: args.includes('--allow-resume'), messagesDirectory: messagesDirectory() },
      // Every page request starts by reading the board.
      view: freshView,
      pending: (isFresh = true) => pending(undefined, isFresh),
      act,
      tidy,
      paste,
      clean: cleanUp,
      bulkTidy,
      sweep: () => { tidyCount(false, true); moveOldMonths() },
      // Tests can shorten the hourly interval without changing the sweep rules.
      sweepMs: Number.isInteger(Number(process.env.AGENT_BOARD_SWEEP_MS)) && Number(process.env.AGENT_BOARD_SWEEP_MS) >= 10 && Number(process.env.AGENT_BOARD_SWEEP_MS) <= 3_600_000 ? Number(process.env.AGENT_BOARD_SWEEP_MS) : 3_600_000,
      // The page names a file it could not read or write the way the terminal board does, for a
      // press and for the board it shows. The page is answered, so the exit code and stderr are
      // left alone. File labels and reasons stay the same on local and network pages.
      failure: error => (error instanceof BoardFileError ? storageNote(error) : null),
      idleMs: idleMs(),
      onReady: (url, port) => {
        // Without its address file no later `--serve` finds this page, and each would start one
        // more; so it does not start at all. Nor when the file is there already: another
        // `--serve` started a page at the same moment and wrote first, and that one is the page.
        try {
          const text = JSON.stringify({ pid: process.pid, port, url, path, built })
          if (process.platform === 'win32') writePrivateRuntimeFile(file, text)
          else writeFileSync(file, text, { mode: 0o600, flag: 'wx' })
        } catch (error) {
          // Another `--serve` that wrote first is the page, so that start stops quietly. Any other
          // failure says why, as a child whose folder check failed does, instead of stopping without
          // a word (#799): the command shows the same reason, not the generic line.
          // The file's own icacls calls end in their raw time-out error, not the folder check's.
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') process.stderr.write(`${error instanceof RuntimeFolderTimeoutError || isTimeout(error) ? s.serveRuntimeCheckTimeout : s.serveRuntimePrivate}\n`)
          return false
        }
        // The one line `--serve` waits for. Its pipe closes once it has read it.
        process.stdout.on('error', () => undefined)
        process.stderr.on('error', () => undefined)
        process.stdout.write(`${url}\n`)
        return true
      },
      onStop: () => {
        // The file goes only while it is still this server's: a newer one may have taken it over.
        unlinkIf(file, () => readRunning(file)?.pid === process.pid)
        process.exit(0)
      },
    })
  } catch (error) {
    if (!(error instanceof Error) || error.cause !== 'MESSAGE_STORE_FAILED') throw error
    const errno = (error as NodeJS.ErrnoException).code
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message
      : typeof errno === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(errno) ? errno : 'UNREADABLE'
    process.stderr.write(`MESSAGE_STORE_FAILED ${code}\n`)
    process.exitCode = 1
  }
}

// The page at that address is asked to close, and whether it agreed is answered. It refuses while
// a reply is on its way (and then stops by itself once idle). Its file goes only when it agreed,
// and while it still names that page: another `--serve` may have started a new one since.
const letGo = async (running: Running, file: string): Promise<boolean> => {
  const isClosed = await fetch(`http://127.0.0.1:${running.port}/api/close`, { method: 'POST', headers: { 'x-board-token': tokenOf(running.url), 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1500) }).then(
    res => res.ok,
    () => false,
  )
  if (isClosed) unlinkIf(file, () => readRunning(file)?.pid === running.pid)
  return isClosed
}

// Whether a page that is not wanted has to stay. One that did not agree to close is still there
// if it answers, or if its process runs and keeps the connection but says nothing; a reply may be
// on its way from it, and a second page beside it would send that reply again. A number a
// restarted computer gave to another program, with nothing of ours at the port, is not it: its
// file goes, so a stale address never keeps the board from starting.
const stays = async (running: Running, file: string): Promise<boolean> => {
  if (await letGo(running, file)) return false
  const answer = await ping(running, 500)
  if (answer === 'silent' ? isRunning(running.pid) : answer !== null) return true
  unlinkIf(file, () => readRunning(file)?.pid === running.pid)
  return false
}

// A page already running, found without asking it to close and without touching its file. A
// process that cannot start a replacement reuses the link as it is, even when the page would
// not match a new start: closing it would leave no page and no link.
const keptPage = async (file: string): Promise<Running | null> => {
  const running = readRunning(file)
  if (running === null) return null
  const answer = await ping(running)
  if (answer === 'silent' ? isRunning(running.pid) : answer !== null) return running
  return null
}

// The running page of this copy for this file, or null. Any other page found in the file (one
// that no longer answers, or an older copy's) is let go, so a new one can write the file; but an
// older copy's page that will not close (a reply is on its way) is kept, and `isKept` says so.
const runningPage = async (isStarting = false): Promise<{ page: Running; isKept: boolean; idleMs?: number | undefined } | null> => {
  const running = readRunning()
  if (running === null) {
    // A file that has not read for ten seconds (either way, should the clock have been set
    // back) was cut short by a crash; it would keep every new page from starting.
    // During a launch, this may still be the winning child's reservation. Its age can cross
    // the crash cutoff while native permission checks run; only the initial lookup clears it.
    if (!isStarting) unlinkIf(serveFile(), () => Math.abs(Date.now() - statSync(serveFile()).mtimeMs) > 10_000)
    return null
  }
  // A page that is still running but slow to answer (a busy disk) gets longer before it counts
  // as gone and a second one starts.
  const first = await ping(running)
  const answer = first !== null && first !== 'silent' ? first : isRunning(running.pid) ? await ping(running, 5000) : first
  // An idle preference must not close a page that may hold an unsent reply.
  const requestedStale = staleTimeoutMs()
  if (answer !== null && answer !== 'silent' && typeof answer.path === 'string' && board(answer.path) === board(path) && answer.built === built && answer.allowResume === args.includes('--allow-resume') && (flag('--messages-dir') === undefined || answer.messagesDirectory === messagesDirectory()) && (answer.staleMs === undefined || answer.staleMs === requestedStale)) return { page: running, isKept: false, idleMs: typeof answer.idleMs === 'number' && Number.isFinite(answer.idleMs) && answer.idleMs >= 0 ? answer.idleMs : undefined }
  return (await stays(running, serveFile())) ? { page: running, isKept: true } : null
}

// `--lan`: the running page opens to the local network too, and its address there is printed
// with a QR code a phone's camera opens. Never opened here: it is for the phone. `--lan
// <address>` picks which of the computer's addresses.
const showLan = async (url: string): Promise<void> => {
  const wanted = flag('--lan')
  const answer = await fetch(`http://127.0.0.1:${new URL(url).port}/api/lan`, {
    method: 'POST',
    headers: { 'x-board-token': tokenOf(url), 'content-type': 'application/json' },
    body: JSON.stringify({ address: wanted !== undefined && /^[\d.]+$/.test(wanted) ? wanted : '' }),
    signal: AbortSignal.timeout(5000),
  })
    .then(res => res.json() as Promise<{ url?: unknown; note?: unknown }>)
    .catch(() => ({ note: s.serveLanFailed }) as { url?: unknown; note?: unknown })
  const lanUrl = typeof answer.url === 'string' && /^http:\/\/[\d.]+:\d+\/\?t=[\w-]+$/.test(answer.url) ? answer.url : null
  if (lanUrl === null) {
    process.stdout.write(`\n${typeof answer.note === 'string' && answer.note !== '' ? answer.note : s.serveLanFailed}\n`)
    return
  }
  const modules = qrModules(lanUrl)
  process.stdout.write(`\n${s.serveLanAt(lanUrl)}\n${modules === null ? '' : `${qrText(modules, options().isColor)}\n`}`)
}

interface RunningServer {
  url: string
  port: number
  isKept: boolean
  isNew: boolean
  idleMs?: number | undefined
}

type ServeFailure = { storeCode?: string; isChildCheckTimeout?: boolean; isChildCheckPrivate?: boolean }

// The note a failed start prints: the message folder's failure first, then the child's
// own folder failure, then the generic line. The child prints its folder failure in the
// command's language, so the parent matches the same words.
const serveFailureNote = (failure: ServeFailure): string => {
  if (failure.storeCode !== undefined) return s.serveStoreFailed(failure.storeCode, messagesDirectory())
  if (failure.isChildCheckTimeout) return s.serveFailed(s.serveRuntimeCheckTimeout)
  if (failure.isChildCheckPrivate) return s.serveFailed(s.serveRuntimePrivate)
  return s.serveFailed(s.serveNotStarted)
}

const ensureServer = async (failure?: ServeFailure): Promise<RunningServer | null> => {
  const file = serveFile()
  // A folder that could not be protected is read-only: no legacy address is ever moved into
  // it, and no page is ever started from it. Only a page already running is reused.
  if (process.platform === 'win32' && !runtimeUnprotected && !existsSync(file)) {
    const runtime = process.env.XDG_RUNTIME_DIR
    const legacy = [runtime ? join(runtime, basename(file)) : '', join(tmpdir(), basename(file))]
    for (const previous of new Set(legacy.filter(value => value !== '' && value !== file))) {
      if (!existsSync(file)) migratePrivateRuntimeFile(previous, file, text => parseRunning(text) !== null)
    }
  }
  // A lookup that cannot start a replacement never asks a page to close: the page it finds
  // is reused as it is, even when it would not match a new start.
  if (runtimeUnprotected) {
    const kept = (await keptPage(oldServeFile)) ?? (await keptPage(file))
    if (kept !== null) return { url: kept.url, port: kept.port, isKept: true, isNew: false }
    throw runtimeCheckTimedOut ? new RuntimeFolderTimeoutError() : new RuntimeFolderError()
  }
  const old = readRunning(oldServeFile)
  if (old !== null && (await stays(old, oldServeFile))) return { url: old.url, port: old.port, isKept: true, isNew: false }
  const found = await runningPage()
  if (found !== null) return { url: found.page.url, port: found.page.port, isKept: found.isKept, isNew: false, idleMs: found.idleMs }
  const rest = ['--lang', '--port', '--idle-minutes', '--stale-ms'].flatMap(name => {
    const value = flag(name)
    return value === undefined ? [] : [name, value]
  })
  if (args.includes('--allow-resume')) rest.push('--allow-resume')
  // The child runs with cwd set to the board's folder, so a relative path would resolve
  // against the board's folder instead of this command's folder. Pass the board and the
  // messages folder the parent resolved, as absolute paths, so the child serves the same
  // board and messages. The board is passed every time: a relative CLAUDE_PROGRESS_FILE
  // would resolve differently in the child too.
  rest.push('--progress-file', path)
  if (flag('--messages-dir') !== undefined) rest.push('--messages-dir', messagesDirectory())
  // On Windows the server child is told which folders were just checked, so it does not check them again.
  const handoff = runtimeFolderHandoff()
  // The default message folder is checked here, so its whoami and icacls starts are not among
  // what the child does in the few seconds it has to print its address (#799). A check that
  // fails here is left to the child, which checks in full and reports what it finds.
  // Its timeout is the one the person is told about when the child, checking in full, is cut off
  // before it can say why.
  let messageHandoff: string | undefined
  let isCheckTimeout = false
  if (process.platform === 'win32' && flag('--messages-dir') === undefined) {
    try { messageHandoff = privateFolderHandoff(messagesDirectory()) } catch (error) { isCheckTimeout = isTimeout(error) }
  }
  // Only what this command checked is handed over, never a value it inherited.
  const handed: NodeJS.ProcessEnv = { ...process.env }
  delete handed[RUNTIME_FOLDER_ENV]
  delete handed[MESSAGE_FOLDER_ENV]
  if (handoff !== undefined) handed[RUNTIME_FOLDER_ENV] = handoff
  if (messageHandoff !== undefined) handed[MESSAGE_FOLDER_ENV] = messageHandoff
  const childEnv = serverMemoryEnv(handed)
  const startPage = async (): Promise<{ url: string | null; stderr: string; readyBy: number }> => {
    // In the board's own folder, not the agent's, so the server holds no project folder open.
    const readyBy = performance.now() + 10_000
    const child = spawn(process.execPath, [...serverMemoryArgs(process.execArgv, process.env.NODE_OPTIONS), script, '--serve-child', ...rest], { cwd: dirname(path), detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-16_384) })
    // The child prints its address once it listens; it exits at once when it cannot.
    const url = await new Promise<string | null>(done => {
      let out = ''
      const timer = setTimeout(() => done(null), Math.max(0, readyBy - performance.now()))
      const end = (value: string | null): void => {
        clearTimeout(timer)
        done(value)
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
        if (out.includes('\n')) end(out.split('\n')[0]?.trim() || null)
      })
      child.once('close', () => end(null))
      child.once('error', () => end(null))
    })
    // One that has not answered in time would start late and hold a page nobody was told about.
    if (url === null && child.exitCode === null) child.kill()
    child.stdout?.destroy()
    child.stderr?.destroy()
    child.unref()
    return { url, stderr, readyBy }
  }
  // Whether the lock no longer holds `held`: gone, or another pid. A lock that cannot be read counts as unchanged.
  const isTaken = (lock: string, held: string): boolean => {
    try { return readFileSync(lock, 'utf8') !== held } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
  }
  const deadline = performance.now() + 20_000
  while (performance.now() < deadline) {
    const { url, stderr, readyBy } = await startPage()
    if (url !== null) return { url, port: Number(new URL(url).port), isKept: false, isNew: true }
    // Another `--serve` started at the same moment may have written its address first: this
    // page stopped then, and that one is the page to show. When it took the message folder
    // first, this page stopped before that one had written its address, so it is given the
    // few seconds a page takes to start.
    const storeCode = /^MESSAGE_STORE_FAILED ([A-Z][A-Z0-9_]{0,63})\r?$/m.exec(stderr)?.[1]
    const lock = join(messagesDirectory(), 'server.lock')
    let held = ''
    if (storeCode === 'MESSAGE_STORE_IN_USE' && flag('--messages-dir') === undefined) {
      try {
        held = readFileSync(lock, 'utf8')
      } catch { held = '' }
    }
    const until = storeCode === 'MESSAGE_STORE_IN_USE' ? Math.min(deadline, performance.now() + (held ? 10_000 : 2_000)) : readyBy
    for (;;) {
      const other = await runningPage(true)
      if (other !== null) return { url: other.page.url, port: other.page.port, isKept: other.isKept, isNew: false, idleMs: other.idleMs }
      if (performance.now() >= until) break
      // A protected Windows address may still be publishing within this launch deadline.
      if (storeCode !== 'MESSAGE_STORE_IN_USE' && (process.platform !== 'win32' || !existsSync(file))) break
      await new Promise(done => setTimeout(done, storeCode === 'MESSAGE_STORE_IN_USE' ? 100 : 50))
    }
    if (held === '' && storeCode === 'MESSAGE_STORE_IN_USE' && flag('--messages-dir') === undefined) {
      try { held = readFileSync(lock, 'utf8') } catch { held = '' }
    }
    // A hub killed without stopping leaves its pid, and after a restart that number can belong to
    // another program. The hub of the default folder leaves its address beside the lock, so the
    // lock is moved only when that address no longer answers. A hub still starting has no address
    // yet, and another board using this folder through --messages-dir writes none and removes
    // any left from before it took the lock, so neither is ever taken over. A folder given here
    // through --messages-dir is never taken over either.
    if (/^[1-9][0-9]*$/.test(held)) {
      let isMoved = false
      let releaseClaim: (() => void) | undefined
      try {
        const claim = claimMessageStore(messagesDirectory())
        releaseClaim = claim.release
        const owner = JSON.parse(readFileSync(join(messagesDirectory(), 'server.owner'), 'utf8')) as Partial<Running>
        if (owner.pid === Number(held) && typeof owner.port === 'number' && Number.isInteger(owner.port) && typeof owner.url === 'string'
          && /^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/.test(owner.url)
          && owner.port === Number(new URL(owner.url).port)
          && await ping({ pid: owner.pid, port: owner.port, url: owner.url, path: '', built: '' }, 5000) === null
          && readFileSync(lock, 'utf8') === held) {
          isMoved = moveLockAside(lock, held, claim)
        }
      } catch {} finally { releaseClaim?.() }
      // Another try only when this --serve moved the lock, or the lock is gone or holds another pid.
      // It may be gone because its hub stopped meanwhile; another --serve's page may still be starting.
      // The next try waits for that page; the same pid (put back, or never moved) is not tried again.
      if (isMoved || isTaken(lock, held)) continue
    } else if (storeCode === 'MESSAGE_STORE_IN_USE' && flag('--messages-dir') === undefined) {
      // Collision in claims or another start is in flight: back off with randomized jitter, then retry or wait for its page
      await new Promise(done => setTimeout(done, Math.floor(Math.random() * 150) + 50))
      const afterWait = await runningPage(true)
      if (afterWait !== null) return { url: afterWait.page.url, port: afterWait.page.port, isKept: afterWait.isKept, isNew: false, idleMs: afterWait.idleMs }
      if (performance.now() < deadline) continue
    }
    const code = storeCode ?? (isCheckTimeout ? 'ACL_CHECK_TIMEOUT' : undefined)
    if (failure !== undefined && code !== undefined) failure.storeCode = code
    // The child names its own folder failure on its stderr; the command carries that
    // reason instead of the generic line, so the person is told the check did not finish.
    if (failure !== undefined && code === undefined) {
      if (stderr.includes(s.serveRuntimeCheckTimeout)) failure.isChildCheckTimeout = true
      else if (stderr.includes(s.serveRuntimePrivate)) failure.isChildCheckPrivate = true
    }
    return null
  }
  return null
}

// Prints the board, then the address of its page, started in the background if no page of this
// copy is running yet (and opened in the browser then, unless --no-open). It returns at once, so
// an agent's command tool is not left waiting on the server.
const serveBoard = async (): Promise<void> => {
  const requestedIdle = idleMs()
  const requestedStale = staleTimeoutMs()
  const failure: ServeFailure = {}
  // `--serve` is what older command files and scripts still run: it opens the page like the plain
  // command and prints no text board before the address (#868). `--quiet-board` is now a no-op.
  const serverPromise = ensureServer(failure)
  // The note goes above the address, so the address stays the last line an agent shows.
  const show = async (url: string, isKept = false, actualIdle?: number, isPageOpen = false): Promise<void> => {
    const idleNote = actualIdle !== undefined && actualIdle !== requestedIdle ? `${actualIdle === 0 ? s.serveIdle : s.serveIdleTimed(actualIdle / 60_000)}\n` : ''
    process.stdout.write(`\n${isKept ? `${s.serveKept}\n` : ''}${idleNote}${s.serveAt(url)}\n`)
    // The address comes from a file and goes to a shell on Windows: only the shape this server
    // writes is opened.
    if (!args.includes('--no-open') && /^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/.test(url) && !isPageOpen) await new Promise<void>(done => openInBrowser(url, () => done()))
    if (args.includes('--lan')) await showLan(url)
  }
  const server = await serverPromise
  if (server === null) {
    process.stdout.write(`\n${serveFailureNote(failure)}\n`)
    return
  }
  await show(server.url, server.isKept, server.idleMs, await pageIsOpen(server))
}

const openPage = async (): Promise<{ note: string; isOpen: boolean; url?: string }> => {
  const failure: ServeFailure = {}
  const server = await ensureServer(failure)
  if (server === null) {
    process.exitCode = 1
    return { note: serveFailureNote(failure), isOpen: false }
  }
  const address = server.url
  const isShape = !args.includes('--no-open') && /^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/.test(address)
  // The page is already in a window: point at it rather than opening another one that would poll too.
  if (isShape && await pageIsOpen(server)) return { note: s.boardPageAlreadyOpen(address), isOpen: true, url: address }
  const isOpen = isShape ? await new Promise<boolean>(done => openInBrowser(address, done, true)) : false
  return { note: isOpen ? s.boardPageWindowOpened(address) : s.boardPageLink(address), isOpen, url: address }
}

const openPageSurface = async (): Promise<void> => {
  const opened = await openPage()
  process.stdout.write(`${opened.note}\n`)
  // `--lan` without `--serve`: the page opens here and the phone's address follows it (#868).
  if (args.includes('--lan') && opened.url !== undefined) await showLan(opened.url)
}

const stopBoard = async (): Promise<void> => {
  const found = await runningPage()
  if (found === null) {
    process.stdout.write(`${s.serveNoneRunning}\n`)
    return
  }
  if (await letGo(found.page, serveFile())) {
    process.stdout.write(`${s.serveStopped}\n`)
  } else {
    process.stdout.write(`${s.serveNotStopped}\n`)
    process.exitCode = 1
  }
}

const sshHost = (): string => {
  const conn = process.env.SSH_CONNECTION
  if (conn) {
    const parts = conn.trim().split(/\s+/)
    if (parts.length >= 3 && parts[2]) return parts[2]
  }
  return process.env.HOSTNAME || 'host'
}

// The home folder, or none when the computer does not say: a failure must not raise another.
const homeOrNone = (): string => {
  try {
    return homedir()
  } catch {
    return ''
  }
}

// The board for a chat app. Nothing is served, opened or written. Whatever goes wrong, the reply
// is one plain line, never a stack trace (it names folders and is sent as it is): a file it
// cannot read says which and why, anything else says what it can, and both go through the same
// hiding as the board.
const chat = (): void => {
  const isWin = process.platform === 'win32'
  try {
    const now = Date.now()
    const home = homeOrNone()
    // A reply is hidden whole, before its question is picked and cut to length.
    const source = read(path)
    const updates = pending(text => redact(text, home, isWin))
    process.stdout.write(chatText(view(source, now), updates, doneToday(journalToday(now), now, s), s, home, isWin, CHAT_MAX, now))
  } catch (error) {
    process.exitCode = 1
    const code = (error as { code?: unknown } | null)?.code
    const reason = typeof code === 'string' ? code : error instanceof Error ? error.message.split('\n')[0]?.slice(0, 160) || error.name : 'UNKNOWN'
    // Nothing here writes, so the board's own advice (files "may already have changed") is not told.
    const told = error instanceof BoardFileError ? error.isLocked ? s.boardLocked(plainFile(error.file)) : s.chatReadFailed(plainFile(error.file), plainReason(s, error.code)) : s.chatFailed(reason)
    process.stdout.write(`${redact(told, homeOrNone(), isWin)}\n`)
  }
}

const jsonFailureDocument = (error: unknown) => {
  const home = homeOrNone()
  const isWin = process.platform === 'win32'
  const code = (error as { code?: unknown } | null)?.code
  const reason = typeof code === 'string' ? code : error instanceof Error ? error.message.split('\n')[0] || error.name : 'UNKNOWN'
  const told = error instanceof BoardFileError ? error.isLocked ? s.boardLocked(plainFile(error.file)) : s.chatReadFailed(plainFile(error.file), plainReason(s, error.code)) : s.chatFailed(reason)
  return { schemaVersion: BOARD_JSON_SCHEMA, error: redact(clipped(plain(told), home, isWin), home, isWin) }
}
const jsonFailure = (error: unknown): void => {
  process.exitCode = 1
  process.stdout.write(`${JSON.stringify(jsonFailureDocument(error))}\n`)
}

// The one document for an agent's read: --json prints it and MCP's board_status returns it.
const boardJson = () => {
  // --mcp keeps running and --json does not: each read starts from what a new process would hold.
  lastSeen = {}
  lastStat = { stat: '', at: 0 }
  lastQuestions = emptyQuestions()
  droppedLogCache = null
  const now = Date.now()
  const home = homeOrNone()
  const isWin = process.platform === 'win32'
  const source = read(path)
  // After the view, whose page state says which turns are already settled.
  const current = view(source, now)
  const updates = pending(text => redact(text, home, isWin))
  const board = RELEASED.reduce((held, release) => {
    const next = release.version.split('.').map(Number)
    const previous = held.split('.').map(Number)
    for (let index = 0; index < 3; index += 1) {
      if ((next[index] ?? 0) !== (previous[index] ?? 0)) return (next[index] ?? 0) > (previous[index] ?? 0) ? release.version : held
    }
    return held
  }, '0.0.0')
  const packageVersion = process.env.AGENT_BOARD_PACKAGE_VERSION ?? ''
  const group = {
    now, repoOf: repoLookup(worktreeRepoName),
    versions: { board, package: /^\d+\.\d+\.\d+$/.test(packageVersion) ? packageVersion : null },
    unreadable: current.unreadable ?? [],
  }
  return boardDocument(current, updates, doneToday(journalToday(now), now, s), s, home, isWin, now, group)
}
const json = (): void => {
  try { process.stdout.write(`${JSON.stringify(boardJson())}\n`) } catch (error) { jsonFailure(error) }
}

const runWatchTerminal = async (): Promise<void> => {
  let sshHint = ''
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) {
    const server = await ensureServer()
    if (server) {
      sshHint = `\n${mutedLine(s.serveSshHint(server.port, sshHost(), server.url), options())}\n`
    }
  }
  let state: BoardState = { ...emptyBoardState, seen: {}, isIdleOpen: args.includes('--all') }
  // What is on the screen now: a redraw that would show the same writes nothing.
  let drawn: string | null = null
  const paintScreen = (text: string, focus: readonly [number, number] | null = null): void => {
    const out = frame(drawn, text, process.stdout.rows || 0, focus)
    drawn = text
    if (out !== null) process.stdout.write(out)
  }
  const draw = (): void => {
    try {
      const shown = freshView()
      const turns = pending()
      state = pinned(state, boardItems(shown, turns, state.isIdleOpen ?? false, state.isOlderOpen ?? false))
      // The window follows the selected line, so a key never acts on a line off the screen.
      const { screen, focus } = boardLayout(shown, turns, state, s, { ...options(), agents: agentsHere(shown, turns) })
      paintScreen(`${screen}${sshHint}`, focus)
    } catch (error) {
      paintScreen(`${failureNote(error)}\n`)
    }
  }
  const quit = (): void => {
    if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(false)
    process.exit(process.exitCode ?? 0)
  }
  if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdout.write(SCREEN_ENTER)
  process.on('exit', () => process.stdout.write(SCREEN_LEAVE))
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.on(signal, () => process.exit(process.exitCode ?? 0))
  // A new size redraws everything: the old lines are where the terminal put them.
  process.stdout.on('resize', () => {
    drawn = null
    draw()
  })
  const send = (action: Send): void => {
    void sendAnswer(action).then(({ note, tone }) => {
      state = { ...state, note, tone, result: state.result === undefined ? undefined : { ...state.result, revision: null } }
      void refreshRoutes().finally(draw)
    })
  }
  process.stdin.on('data', (chunk: string) => {
    try {
      for (const key of keysIn(chunk)) {
        if (key === 'q' || key === '\u0003') quit()
        const pressed = press(state, key)
        state = pressed.state
        if (pressed.isQuit) quit()
        if (pressed.isHtml) {
          void openPage().then(({ note, isOpen }) => {
            state = { ...state, note, tone: isOpen ? 'done' : 'alert', result: undefined }
            draw()
          }).catch(error => {
            state = { ...state, note: failureNote(error), tone: 'alert', result: undefined }
            draw()
          })
        }
        if (pressed.send !== undefined) {
          send(pressed.send)
          break
        }
        if (pressed.isWrite) break
      }
      draw()
    } catch (error) {
      state = { ...state, note: failureNote(error), tone: 'alert' }
      draw()
    }
  })
  draw()
  setInterval(() => {
    draw()
    // Whether a key answers into a session or copies follows the page's own connections.
    void refreshRoutes().then(isChanged => { if (isChanged) draw() })
  }, 2000)
  void refreshRoutes().then(isChanged => { if (isChanged) draw() })
}

const run = async (): Promise<void> => {
  // Setup keeps its own --json protocol; a board read wins over every action flag.
  if (isJsonBoard) {
    json()
    return
  }
  if (args.includes('--mcp')) {
    await runMcp({ directory: messagesDirectory(), cwd: process.cwd(), version: boardVersion, s, document: () => { try { return boardJson() } catch (error) { return jsonFailureDocument(error) } } })
    return
  }
  if (args.includes('--status')) {
    const safeSidecar = (file: string): string => {
      try {
        const text = readFileSync(file, 'utf8')
        return text.length > RETENTION.progressSoftBytes ? text.slice(0, RETENTION.progressSoftBytes) : text
      } catch {
        return ''
      }
    }
    const answeredText = safeSidecar(answeredPath(path))
    const questionsText = safeSidecar(questionsPath(path))
    // A turn waiting in the inbox counts on the page and the terminal: --status reads the
    // same inbox files, read-only and size-capped, so its line agrees (#1000). No session
    // log is read: a turn file alone names its question.
    let turns: PendingTurn[] = []
    try {
      const inboxDir = join(dirname(path), 'progress-inbox')
      const files = readdirSync(inboxDir)
        .filter(name => isInboxFile(name))
        .map(name => {
          try {
            const text = readFileSync(join(inboxDir, name), 'utf8')
            return { name, body: text.length > RETENTION.progressSoftBytes ? text.slice(0, RETENTION.progressSoftBytes) : text, at: inboxTime(name) ?? Date.now() }
          } catch {
            return null
          }
        })
        .filter((file): file is { name: string; body: string; at: number } => file !== null)
      turns = peekInbox(files, () => '', undefined, s)
    } catch {
      turns = []
    }
    process.stdout.write(`${boardStatus(read(path), Date.now(), s, staleTimeoutMs(), answeredText, questionsText, turns)}\n`)
    return
  }
  const request = flag('--legacy-connect-request')
  if (request !== undefined) {
    const trusted = (globalThis as { AGENT_BOARD_WORKER_SOURCE?: string }).AGENT_BOARD_WORKER_SOURCE
    const bundle = (trusted ?? readFileSync(process.argv[1]!, 'utf8')).replace(/^globalThis\.AGENT_BOARD = [^\n]*\n/, '')
    process.stdout.write(`${JSON.stringify(await legacyConnect(JSON.parse(request), bundle))}\n`)
    return
  }
  if (await runCodexLocal(args, path, s)) return
  if (args.includes('--help') && !args.includes('--chat')) {
    process.stdout.write(args.includes('all') ? `${s.boardUsageAll}\n` : `${s.boardUsage}\n`)
  } else if (args[0] === 'stop' || args.includes('--stop')) {
    await stopBoard()
  } else if (args.includes('--serve-child')) {
    dropServerMemoryEnv(process.env)
    serveChild()
  } else if (args.includes('--chat')) {
    // Before the flags that serve, open or write: a chat reply never starts a page.
    chat()
  } else if (args.includes('--tidy')) {
    if (!runBulkTidy()) process.stdout.write(`${tidy(false)}\n`)
  } else if (args.includes('--serve')) {
    await serveBoard()
  } else if (args.includes('--html')) {
    await openPageSurface()
  } else if (args.includes('--print')) {
    // The explicit read-only print retains the questions and journal the old chat view showed.
    const at = Date.now()
    process.stdout.write(boardText(view(undefined, at), pending(), s, { ...options(), isQuestionsOpen: true }, doneToday(journalToday(at), at, s)))
  } else if (flag('--keys') !== undefined) {
    let state = emptyBoardState
    await refreshRoutes()
    for (const key of (flag('--keys') ?? '').split(/\s+/).filter(one => one !== '')) {
      const pressed = press(pin(state), key)
      state = pressed.state
      if (pressed.isQuit) break
      if (pressed.send !== undefined) {
        const sent = await sendAnswer(pressed.send)
        state = { ...state, ...sent, result: state.result === undefined ? undefined : { ...state.result, revision: null } }
        await refreshRoutes()
      }
      if (pressed.isHtml) {
        try {
          const { note, isOpen } = await openPage()
          state = { ...state, note, tone: isOpen ? 'done' : 'alert' }
        } catch (error) { state = { ...state, note: failureNote(error), tone: 'alert' } }
      }
    }
    process.stdout.write(screen(pin(state)))
  } else if (args.includes('--watch') && process.stdout.isTTY !== true) {
    // Into a pipe or a log: the board once, as plain text with no control codes (FORCE_COLOR
    // still paints it, for `| less -R`).
    try {
      process.stdout.write(boardText(view(), pending(), s, options()))
    } catch (error) {
      process.stdout.write(`${failureNote(error)}\n`)
    }
  } else if (args.includes('--watch') && process.stdin.isTTY) {
    await runWatchTerminal()
  } else if (args.includes('--watch')) {
    // A terminal to draw on with no keys to read (an agent's tool): it only redraws.
    let drawn: string | null = null
    const tick = () => {
      let text: string
      try {
        text = `${boardText(freshView(), pending(), s, options())}\n${s.boardWatching}\n`
      } catch (error) {
        text = `${failureNote(error)}\n`
      }
      const out = frame(drawn, text, process.stdout.rows || 0)
      drawn = text
      if (out !== null) process.stdout.write(out)
    }
    process.stdout.write(SCREEN_ENTER)
    process.on('exit', () => process.stdout.write(SCREEN_LEAVE))
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => process.exit(process.exitCode ?? 0))
    tick()
    setInterval(tick, 2000)
  } else {
    // `--lan` is for a phone, which only the page serves, so it picks the page everywhere.
    const surface = args.includes('--lan') ? 'page' : pickSurface({ env: process.env, isTty: Boolean(process.stdout.isTTY && process.stdin.isTTY), platform: process.platform })
    if (surface === 'page') {
      await openPageSurface()
    } else if (surface === 'terminal' && process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      await runWatchTerminal()
    } else {
      process.stdout.write(boardText(view(), pending(), s, options()))
    }
  }
}

try {
  await run()
} catch (error) {
  if (isJsonBoard) {
    jsonFailure(error)
  } else if (args.includes('--mcp')) {
    process.exitCode = 1
    process.stderr.write('MCP_START_FAILED\n')
  } else if (error instanceof RuntimeFolderTimeoutError) {
    process.exitCode = 1
    const output = args.includes('--serve-child') ? process.stderr : process.stdout
    output.write(`${s.serveRuntimeCheckTimeout}\n`)
  } else if (error instanceof RuntimeFolderError) {
    process.exitCode = 1
    const output = args.includes('--serve-child') ? process.stderr : process.stdout
    output.write(`${s.serveRuntimePrivate}\n`)
  } else if (flag('--legacy-connect-request') !== undefined && typeof (globalThis as { AGENT_BOARD_WORKER_SOURCE?: unknown }).AGENT_BOARD_WORKER_SOURCE === 'string') {
    // The verified worker wrapper bounds data-URL errors and owns stage cleanup.
    throw error
  } else if (args.some(arg => ['--codex-event', '--agent-status', '--codex-report', '--report', '--plan-event'].includes(arg))) {
    // A plan mirror is a host's decision hook: it never fails the host, and says why on stderr only.
    process.exitCode = args.includes('--plan-event') ? 0 : 1
    const raw = String((error as { code?: string })?.code ?? (error instanceof Error ? error.message : 'UNKNOWN'))
    const reason = /^[A-Z][A-Z0-9_]{0,63}$/.test(raw) ? raw : 'UNKNOWN'
    // A plan mirror's stderr only feeds the hook log, so it always names its code (#962 review).
    process.stderr.write(`${args.includes('--plan-event') ? s.reporterFailed(reason) : reason === 'UNBOUND_REPORT' ? s.codexReportUnbound : reason === 'LOCK_DENIED' ? s.reporterLockDenied : reason === 'INCOMPLETE_PROGRESS_TAIL' ? s.tailRepairFailed : s.reporterFailed(reason)}\n`)
  } else if (args.some(arg => ['--codex-setup', '--codex-doctor', '--codex-remove', '--codex-trust'].includes(arg))) {
    process.exitCode = 1
    const failure = setupFailure(error, flag('--agent') ?? 'codex', s)
    process.stderr.write(`${args.includes('--json') ? JSON.stringify({ error: failure }) : failure.message}\n`)
  } else failureNote(error)
}
