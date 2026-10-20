import { BOARD_SCRIPT } from './board-script'
import { sha256 } from './sha256'
import { CONNECT_BOOTSTRAP, CONNECT_EXECUTE, workerRequest, workerStage } from './connect-worker'
import type { LegacyConnectRequest, ConnectState } from '../scripts/connect-transaction'
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, PromptSubmitResult, Register } from 'claude-code'

import type { RenderSurface } from 'claude-code'

import type { ProgressAnswer, ProgressMirror, ProgressPr, ProgressSnapshot } from '../types'
import {
  addManualTask,
  confirmMatches,
  confirmTask,
  confirmedTarget,
  extractAutoBlock,
  manualTaskCount,
  removeAutoBlock,
  setManualStep,
  shortId,
  scanBlocks,
  takeArchivable,
  takeManualDone,
  takeTask,
  upsertAutoBlock,
} from './blocks'
import type { ConfirmedTask, ConfirmRef } from './blocks'
import { ciFinished, GH_FIELDS, prFromGh } from './github'
import {
  appendJournal,
  countDay,
  journalLine,
  archivePath,
  journalPath,
  localDay,
  parseJournal,
  previousMonth,
  progressReport,
} from './journal'
import type { JournalEntry } from './journal'
import {
  applyTaskCreate,
  applyTaskUpdate,
  applyTodoWrite,
  asData,
  cleanContext,
  cleanTitle,
  clip,
  completedSince,
  applyCompletionOverlay,
  completionKey,
  completionOverlay,
  completionOfBlock,
  completionPrefix,
  isCompletionOverlay,
  dataBlock,
  emptyMirror,
  fallbackTitle,
  isAllDone,
  fromTaskList,
  isStaleStoreKey,
  markAnswered,
  noticesOf,
  resumeNote,
  stateOf,
} from './mirror'
import type { ListedTask } from './mirror'
import { baseName, countSteps, doneKey, isHereProject, isTaskComplete, parseProgress, STALE_MS } from './parse'
import type { ProgressProject } from '../types'
import { dashboardHtml } from './dashboard'
import { peekInbox, redact } from './board'
import type { PendingTurn } from './board'
import { paletteFor } from './palette'
import { drawPane, reviseKey } from './pane'
import type { PaneActions, PaneModel, PaneUi } from './pane'
import { isQuickAdd, parseQuickAdd, quickAddWords } from './quick'
import type { Lang, Strings } from './i18n'
import { RULE_ID, RULES } from './rule'
import { chosenLang, langOf, resolveLang, STRINGS } from './strings'
import { answerTurns, applyDigest, clearAsked, clearBackgroundJobs, cleanHandoff, finishBackgroundJob, isAskingYou, isPersonsAnswer, isWork, lastQuestion, markAsked, needsRefresh, parseDigest, replyData, requestData, startBackgroundJob, turnTools } from './digest'
import type { Digest } from './digest'
import { isNodeSupported, isSetupState, isWindowsHost, nodeVersionOf, openclawPrinted, openclawSavedBy, openclawTooOld, psQuote, setupLines, setupProblemText, setupSeed } from './connect'
import type { SetupProblem } from './connect'
import {
  ANSWER_KEEP,
  answerKey,
  answerAgentPrompt,
  withAgentPrompts,
  claimAction,
  failedName,
  inboxOrder,
  isInboxFile,
  isTextLog,
  isTranscriptPath,
  keepInboxDone,
  keepInboxFailed,
  MAX_TRIES,
  promptKey,
  readClaim,
  readTurn,
  takenName,
  turnOrder,
  normalizeTurnOrder,
  isBoardTurn,
  transcriptTail,
  turnsToDigest,
} from './inbox'
import type { AgentTurn } from './inbox'
import { keepRecent, remindersOf } from './remind'
import { agentName, answeredJson, answeredPath, buildView, mirrorMatchesTask, parseAnswered, parseSeen, seenJson, seenPath, statusLine, withAnswered, withSeen } from './view'
import type { StepRef, TaskRef, TaskRow, WaitingItem } from './view'
import { acknowledgementKeys, archiveQuestionsKept, captureHashOf, captureJson, capturePath, emptyQuestions, parseCapture, withCaptures, isQuestionProof, isQuestionSnapshot, isTornLedger, migratedAnswered, observeQuestions, parseQuestions, questionProofJson, questionProofOf, questionProofPath, questionWords, questionsJson, questionsPath } from './questions'
import type { QuestionAnswerEvidence, QuestionCapture, QuestionProofs, QuestionRecord } from './questions'

const PANE = 'agent-board'
const POLL_MS = 2000
const TICK_MS = 30 * 1000
// How often the inbox of other agents' turns is looked at: a stat, and a read when it changed.
const INBOX_MS = 5 * 1000
// How often a pull request whose checks are still running is looked at again.
const PR_MS = 2 * 60 * 1000
// How often a session looks for work old enough to archive, besides at its start.
const ARCHIVE_MS = 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000
// How long a model call may take before it counts as no answer: one that never comes back
// must not hold the inbox, or a task's name, for good.
const MODEL_MS = 30 * 1000
// Why an inbox file is still there, kept in the store's `inboxFailed`.
const NO_SUMMARY = 'the model gave no summary and the reply asks nothing'
const NOT_KEPT = 'the block was not on the board when read back'

const EMPTY: ProgressSnapshot = { path: '', isMissing: true, error: null, mtimeMs: 0, size: 0, projects: [] }

const snapshot = atom({ plugin: 'agent-board', key: 'snapshot' } as const, EMPTY)
const here = atom({ plugin: 'agent-board', key: 'here' } as const, [] as string[])
const mine = atom({ plugin: 'agent-board', key: 'mine' } as const, null as ProgressMirror | null)
const now = atom({ plugin: 'agent-board', key: 'now' } as const, 0)
const hasTaskTools = atom({ plugin: 'agent-board', key: 'hasTaskTools' } as const, true)

const expanded = atom({ plugin: 'agent-board', key: 'expanded' } as const, '')
const answer = atom({ plugin: 'agent-board', key: 'answer' } as const, null as ProgressAnswer | null)
const isNotifyOn = atom({ plugin: 'agent-board', key: 'isNotifyOn' } as const, true)
// The person's /config theme, which picks the dark or light 和色 set.
const theme = atom({ plugin: 'agent-board', key: 'theme' } as const, 'dark')
// Steps finished today, from the journal.
const today = atom({ plugin: 'agent-board', key: 'today' } as const, 0)
const isLegendOpen = atom({ plugin: 'agent-board', key: 'isLegendOpen' } as const, false)
// The language the pane speaks (strings.ts resolveLang), settled at session start.
const lang = atom({ plugin: 'agent-board', key: 'lang' } as const, 'zh-TW')
// Which folded sections the person opened; kept across sessions in $.store.
const opened = atom({ plugin: 'agent-board', key: 'opened' } as const, [] as string[])
// When the pane first saw each hand-kept task done (by doneKey), to archive it a day later.
const doneSeen = atom({ plugin: 'agent-board', key: 'doneSeen' } as const, {} as Record<string, number>)
// Questions the person marked answered (view.ts askKeys), read from progress-answered.json
// beside progress.md, which every session on this machine and the board script share.
const hiddenAsks = atom({ plugin: 'agent-board', key: 'hiddenAsks' } as const, [] as string[])
const questionLedger = atom({ plugin: 'agent-board', key: 'questionLedger' } as const, emptyQuestions())
const hasQuestionsProblem = atom({ plugin: 'agent-board', key: 'hasQuestionsProblem' } as const, false)
const hasPendingQuestionsProblem = atom({ plugin: 'agent-board', key: 'hasPendingQuestionsProblem' } as const, false)
const firstSeen = atom({ plugin: 'agent-board', key: 'firstSeen' } as const, {} as Record<string, number>)
// The review whose reply box Needs changes opened.
const revising = atom({ plugin: 'agent-board', key: 'revising' } as const, '')

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const wordsOf = async ($: EngineInterface): Promise<Strings> => STRINGS[langOf(await read($, lang)) ?? 'zh-TW']

// Module state: reset by a reload, which only happens between turns.
let isPolling = false
let isTurnRunning = false
let writes: Promise<unknown> = Promise.resolve()
let askSeq = 0
let isPaneOpen = false
let lastStatus: string | undefined
let isCheckingPr = false
// gh is tried until it fails to start (not installed) or says it is signed out.
let hasGh = true
let countedDay = ''
let lastDashboard = ''
// Set once the questions and due dates already on file at the start are counted as told.
let isReminderSeeded = false
let isReminding = false
// What the person said this turn, for summing the turn up when it ends.
let turnPrompt = ''
// Whether the prompt starting the next turn is the person's own message, as prompt.submit
// saw it.
let isNextTurnAnswer = false
// turn.start has no origin; undefined alone permits its legacy text fallback.
let nextTurnNotification: boolean | undefined
let hasTurnBackgroundLaunch = false
let turnBackgroundJobIds = new Set<string>()
let turnBackgroundLaunchesWithoutId = 0
let hasBackgroundActivity = false
let pendingBackgroundSaves = 0
let backgroundChanges: Promise<unknown> = Promise.resolve()
let isDraining = false
// Other agents' turns are summed up one session's files at a time, after the drain that took
// them has let go of the inbox.
let digests: Promise<unknown> = Promise.resolve()
// Set once this session has made sure the store has a record of the inbox (see drainInbox).
let hasInboxRecord = false
let inboxSeen = -1
let inboxListed = 0
// Each retained file and reason is named once, so two stuck files cannot take turns notifying.
const inboxNoticesShown = new Set<string>()
const pendingJournals = new Map<string, Record<string, string[]>>()
const pendingInboxQuestions = new Map<string, PendingTurn>()
const droppingInboxQuestions = new Set<string>()
let pendingQuestionRetry: Promise<void> | null = null
let hasRestoredInboxQuestions = false
const journalNoticesShown = new Set<string>()
let journalNoticeKey = ''
let dashboardAt = 0

// CLAUDE_PROGRESS_FILE wins; then CLAUDE_CONFIG_DIR, where Claude Code keeps its own files
// when moved; otherwise ~/.claude/progress.md. USERPROFILE comes before HOME because that is
// where Claude Code keeps ~/.claude on Windows even when HOME is set (Git Bash, MSYS); it is
// unset on macOS and Linux.
// Worked out once per session (session.start); the 2-second poll and the inbox look reuse it.
let knownPath: string | null = null

const progressPath = async ($: EngineInterface): Promise<string> => {
  if (knownPath === null) knownPath = await findProgressPath($)

  return knownPath
}

const findProgressPath = async ($: EngineInterface): Promise<string> => {
  const explicit = await $.env.get('CLAUDE_PROGRESS_FILE')
  if (explicit !== undefined && explicit !== '') return explicit
  const config = (await $.env.get('CLAUDE_CONFIG_DIR'))?.replace(/[\\/]+$/, '')
  if (config !== undefined && config !== '') return [config, 'progress.md'].join(config.includes('\\') ? '\\' : '/')
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/[\\/]+$/, '')
  const sep = home.includes('\\') ? '\\' : '/'

  return [home, '.claude', 'progress.md'].join(sep)
}

// One archive file per month (progress-archive-2026-10.md), so none grows past what one
// read can hold.

// Where other agents' hooks leave their turns: a folder beside progress.md.
const inboxPath = (path: string): string => {
  const sep = path.includes('\\') ? '\\' : '/'

  return `${path.replace(/[\\/][^\\/]*$/, '')}${sep}progress-inbox`
}

// Windows decides which shell runs a command and which reporter script an agent gets; the
// path alone does not say (`CLAUDE_PROGRESS_FILE=C:/Users/me/progress.md`).
const isWindows = async ($: EngineInterface, path: string): Promise<boolean> => isWindowsHost(await $.env.get('OS'), path)

const sepOf = (path: string): string => (path.includes('\\') ? '\\' : '/')

// The engine's file calls cannot rename or delete; the system's own commands do.
const removeFiles = async ($: EngineInterface, files: readonly string[], isWin: boolean): Promise<boolean> => {
  if (files.length === 0) return true
  const argv = isWin
    ? ['powershell', '-NoProfile', '-Command', `Remove-Item -Force -LiteralPath ${files.map(psQuote).join(',')} -ErrorAction Stop`]
    : ['rm', '-f', ...files]
  const ran = await $.process.run(argv, { timeoutMs: 10000 }).catch(() => null)
  if (ran === null || ran.exitCode !== 0) return false
  for (const file of files) if (await $.fs.exists(file)) return false

  return true
}

// A rename either happens or fails as a whole, so two sessions renaming one file cannot both
// succeed: true for the one that did.
const moveFile = async ($: EngineInterface, from: string, to: string, isWin: boolean): Promise<boolean> => {
  const argv = isWin
    ? ['powershell', '-NoProfile', '-Command', `Move-Item -LiteralPath ${psQuote(from)} -Destination ${psQuote(to)} -ErrorAction Stop`]
    : ['mv', from, to]
  const ran = await $.process.run(argv, { timeoutMs: 10000 }).catch(() => null)

  return ran !== null && ran.exitCode === 0
}

// A rename that never replaces a file already there. `mv -n` answers 0 when it skips one, so
// the move happened only if the source is gone.
const placeFile = async ($: EngineInterface, from: string, to: string, isWin: boolean): Promise<boolean> => {
  const argv = isWin
    ? ['powershell', '-NoProfile', '-Command', `Move-Item -LiteralPath ${psQuote(from)} -Destination ${psQuote(to)} -ErrorAction Stop`]
    : ['mv', '-n', from, to]
  const ran = await $.process.run(argv, { timeoutMs: 10000 }).catch(() => null)

  return ran !== null && ran.exitCode === 0 && !(await $.fs.exists(from))
}

// The temp file is complete before it replaces the ledger, so readers never see half a write. On
// Windows a reader can still find no ledger for a moment while the replace runs.
const replaceFile = async ($: EngineInterface, from: string, to: string, isWin: boolean): Promise<boolean> => {
  const argv = isWin
    ? ['powershell', '-NoProfile', '-Command', `Move-Item -Force -LiteralPath ${psQuote(from)} -Destination ${psQuote(to)} -ErrorAction Stop`]
    : ['mv', '-f', from, to]
  const ran = await $.process.run(argv, { timeoutMs: 10000 }).catch(() => null)

  return ran !== null && ran.exitCode === 0
}

type Completion = Awaited<ReturnType<EngineInterface['model']['complete']>>

// A model call that gives up after MODEL_MS, answering undefined as a failed call does.
const complete = ($: EngineInterface, request: Parameters<EngineInterface['model']['complete']>[0]): Promise<Completion | undefined> =>
  new Promise(resolve => {
    $.clock.after(MODEL_MS, () => resolve(undefined))
    $.model.complete(request).then(resolve, () => resolve(undefined))
  })

// Another session on this machine, or the board script, may mark a question answered: its file
// is a stat per poll too. A read that fails, or that catches a write half-way, is tried again on
// the next poll, and the list in hand stays until then.
// Null until the first look, so a list kept in the store is checked against the file even when
// the file is gone.
let answeredSeen: string | null = null
const pollAnswered = async ($: EngineInterface, path: string): Promise<void> => {
  const file = answeredPath(path)
  const stat = await $.fs.stat(file).catch(() => undefined)
  const seen = stat === undefined ? '' : `${stat.mtimeMs}:${stat.size}`
  if (seen === answeredSeen) return
  const now = await $.clock.now()
  const list = stat === undefined ? [] : await $.fs.read(file).then(text => parseAnswered(text, now - stat.mtimeMs), () => null)
  if (list === null) return
  answeredSeen = seen
  await update($, hiddenAsks, () => list)
  // Before progress.md is first read the snapshot is empty; that first read draws both.
  if ((await read($, snapshot)).path !== path) return
  await refreshStatus($)
  await writeDashboard($, true)
}

// Marks whose question has left the file go, so the same words asked again later show. Run once
// the file has held still for a poll, so a write caught half-way never drops one, and only while
// it still holds still (`mtimeMs`, `size`), on disk as well as in this session's last look: a
// file another session or the board changed meanwhile waits for its own turn.
let isPrunePending = false
let questionWrite = 0
let questionFailures = 0
let questionRaces = 0
// Board writes and prompt receipts are already committed when settling can race.
// Keep their evidence through ordinary polls rather than replaying intake without it.
const answeredPending = new Map<string, QuestionAnswerEvidence>()
// When a successful pass first carried each entry. Settling is safe to repeat, so evidence stays
// ten minutes after that instead of until any inbox record of its session shows up: a record
// another session writes late still settles, and sessions that never ask do not pile up.
const answeredKeptSince = new Map<string, number>()
const rememberAnswered = (turns: readonly AgentTurn[]): void => {
  for (const turn of turns) {
    if ((turn.event !== 'prompt' && (turn.event !== 'turn' || turn.answer.trim() === '')) || turn.at === undefined || !Number.isFinite(turn.at)) continue
    const key = JSON.stringify([turn.agent, turn.id])
    if ((answeredPending.get(key)?.at ?? -Infinity) >= turn.at) continue
    answeredPending.set(key, { agent: turn.agent, id: turn.id, event: turn.event, at: turn.at })
    answeredKeptSince.delete(key)
  }
}
const pendingQuestionProofs = new Map<string, { path: string; kind: keyof QuestionProofs; hash: string }>()
const questionCapturesFor = async ($: EngineInterface, path: string): Promise<QuestionCapture[] | null> => {
  try {
    const captures: QuestionCapture[] = []
    for (const entry of await $.fs.list(path.replace(/[\\/][^\\/]*$/, ''))) {
      const hash = captureHashOf(path, entry.name)
      if (hash === null) continue
      const capture = entry.kind === 'file' ? parseCapture(await $.fs.read(capturePath(path, hash)), hash) : null
      if (capture === null) return null
      captures.push(capture)
    }
    return captures
  } catch {
    return null
  }
}
const keepQuestionCapture = async ($: EngineInterface, path: string, record: QuestionRecord, disposition: QuestionCapture['disposition']): Promise<void> => {
  const text = captureJson(record, disposition)
  const file = capturePath(path, sha256(text))
  if (!(await $.fs.exists(file))) await $.fs.write(file, text)
  if (await $.fs.read(file) !== text) throw new Error('QUESTION_RETENTION_FAILED')
}
const questionProofsFor = async ($: EngineInterface, path: string): Promise<QuestionProofs | null> => {
  try {
    if ([...pendingQuestionProofs.values()].some(proof => proof.path === path)) return null
    const proofs: QuestionProofs = { retired: [], consumed: [] }
    const parent = path.replace(/[\\/][^\\/]*$/, '')
    for (const entry of await $.fs.list(parent)) {
      const proof = questionProofOf(path, entry.name)
      if (proof === null) continue
      const file = questionProofPath(path, proof.kind, proof.hash)
      if (entry.kind !== 'file' || !isQuestionProof(await $.fs.read(file), proof.kind, proof.hash)) return null
      proofs[proof.kind].push(proof.hash)
    }
    return proofs
  } catch {
    return null
  }
}

const keepQuestionProof = async ($: EngineInterface, path: string, kind: keyof QuestionProofs, hash: string): Promise<void> => {
  const file = questionProofPath(path, kind, hash)
  pendingQuestionProofs.set(file, { path, kind, hash })
  const text = questionProofJson(kind, hash)
  if (await $.fs.exists(file)) {
    if (!isQuestionProof(await $.fs.read(file), kind, hash)) throw new Error('QUESTION_PROOF_UNREADABLE')
  } else {
    await $.fs.write(file, text)
  }
  if (await $.fs.read(file) !== text) throw new Error('QUESTION_PROOF_NOT_KEPT')
  pendingQuestionProofs.delete(file)
}
const pruneAnswered = async ($: EngineInterface, path: string, projects: readonly ProgressProject[], mtimeMs: number, size: number): Promise<void> => {
  // The ledger retires identities; old acknowledgement bytes remain available for migration.
  const disk = await $.fs.stat(path).catch(() => undefined)
  if (disk?.mtimeMs !== mtimeMs || disk.size !== size) return
  await pollQuestions($, path, projects, true)
}

const pollQuestions = async ($: EngineInterface, path: string, projects: readonly ProgressProject[], isSettled = false, captured: readonly PendingTurn[] = [], answeredTurns: readonly QuestionAnswerEvidence[] = []): Promise<boolean> => {
  const file = questionsPath(path)
  let outcome: 'ok' | 'race' | 'fault' = 'fault'
  try {
    const at = await $.clock.now()
    const mirror = await read($, mine)
    const answered = await read($, hiddenAsks)
    const pending = [...(await pendingTurns($)), ...captured]
    // A delayed save keeps the turn's age, including when a normal poll saw its block first.
    const observe = (current: ReturnType<typeof emptyQuestions>, proofs: QuestionProofs | undefined): ReturnType<typeof emptyQuestions> => {
      const observed = observeQuestions(current, projects, mirror, answered, at, isSettled, incarnation, proofs, pending, answeredTurns).ledger
      return { ...observed, records: observed.records.map(record => {
        const times = captured.filter(turn => record.producerSources?.includes(JSON.stringify(turn))).map(turn => turn.sourceAt ?? turn.at).filter(time => Number.isFinite(time) && time >= 0)
        return times.length === 0 ? record : { ...record, firstObserved: Math.min(record.firstObserved, ...times) }
      }) }
    }
    const session = await $.session.id()
    const incarnation = `${session}:${at}:${questionWrite++}`
    const isWin = await isWindows($, file)
    // A ledger that is not JSON at all was cut off by a write that never finished: moved aside,
    // it is rebuilt from the source copies as a missing one is. JSON in a shape this version does
    // not know may be a newer version's, so parseQuestions leaves that alone.
    const quarantine = async (): Promise<boolean> => {
      const aside = `${file}.torn-${at}-${session}`
      if (!(await moveFile($, file, aside, isWin))) {
        // Another session moved it aside first or wrote a good one: that is a race, not a fault.
        if (!isTornLedger(await readText($, file))) outcome = 'race'
        return false
      }
      if (isTornLedger(await readText($, aside))) {
        await update($, hasQuestionsProblem, () => true)
        return true
      }
      // A good ledger another session wrote between the read and the move goes back, unless a
      // rebuild already took its place; the rebuild comes from the same source copies.
      await placeFile($, aside, file, isWin)
      outcome = 'race'
      return false
    }
    if (isTornLedger(await readText($, file)) && !(await quarantine())) return false
    for (const proof of [...pendingQuestionProofs.values()]) {
      if (proof.path === path) await keepQuestionProof($, path, proof.kind, proof.hash)
    }
    let proofs = await questionProofsFor($, path)
    if (proofs === null) {
      outcome = 'race'
      return false
    }
    const source = await readText($, path)
    if (!isQuestionSnapshot(source) || JSON.stringify(parseProgress(source)) !== JSON.stringify(projects)) {
      outcome = 'race'
      return false
    }
    let expected = ''
    let wasMissing = false
    await rewrite($, file, async before => {
      if (await readText($, path) !== source) return AGAIN
      wasMissing = before.trim() === '' && !(await $.fs.exists(file))
      const parsed = parseQuestions(before, wasMissing)
      if (parsed === null && isTornLedger(before)) {
        if (!(await quarantine())) throw new Error('QUESTION_LEDGER_MOVE_FAILED')
        return AGAIN
      }
      const captures = await questionCapturesFor($, path)
      if (parsed === null || captures === null) return AGAIN
      const current = withCaptures(parsed, captures)
      let observed = observe(current, proofs ?? undefined)
      for (const record of observed.records) {
        if (record.source === undefined) continue
        if (record.isUnresolved && !captures.some(capture => captureJson(capture.record, capture.disposition) === captureJson(record, 'unresolved'))) await keepQuestionCapture($, path, record, 'unresolved')
        if (record.isUnresolved === false && current.records.some(old => old.id === record.id && old.isUnresolved === true)) await keepQuestionCapture($, path, record, 'resolved')
      }
      for (const old of current.records) {
        if (old.isPresent && !observed.records.some(record => record.id === old.id && record.isPresent && record.isWaiting)) await keepQuestionProof($, path, 'retired', sha256(old.id))
      }
      proofs = await questionProofsFor($, path)
      if (proofs === null) return AGAIN
      observed = observe(current, proofs)
      expected = questionsJson(observed)
      return questionsJson(observed) === questionsJson(parsed) ? null : questionsJson(observed)
    }, undefined, async (target, text) => {
      const temporary = `${target}.tmp-${session}-${questionWrite++}`
      await $.fs.write(temporary, text)
      // A ledger rebuilt because none was there never replaces one another session put in place
      // meanwhile (on Windows the ledger is also missing for a moment while a replace runs): the
      // read back then sees theirs, and the change is made again on top of it.
      if (wasMissing ? await placeFile($, temporary, target, isWin) : await replaceFile($, temporary, target, isWin)) return
      // A failed replace on Windows may already have deleted the old ledger: the new one takes its place.
      const isGone = !(await $.fs.exists(target))
      if (isGone && await placeFile($, temporary, target, isWin)) return
      // With no ledger left, the temp file is the only complete copy, so it stays.
      if (isGone) throw new Error('QUESTION_LEDGER_WRITE_FAILED')
      await removeFiles($, [temporary], isWin)
      if (!wasMissing) throw new Error('QUESTION_LEDGER_WRITE_FAILED')
    })
    const parsed = parseQuestions(await readText($, file), !(await $.fs.exists(file)))
    const captures = await questionCapturesFor($, path)
    const kept = parsed === null || captures === null ? null : withCaptures(parsed, captures)
    if (parsed === null || kept === null) return false
    if (expected !== questionsJson(parsed)) {
      outcome = 'race'
      return false
    }
    await update($, questionLedger, () => kept)
    if (isSettled) {
      await rewrite($, answeredPath(path), async before => {
        const stat = await $.fs.stat(answeredPath(path)).catch(() => undefined)
        const current = parseAnswered(before, stat === undefined ? 0 : at - stat.mtimeMs)
        if (current === null) return AGAIN
        const latestProofs = await questionProofsFor($, path)
        if (latestProofs === null) return AGAIN
        const next = migratedAnswered(current, kept, latestProofs.consumed)
        for (const key of current) {
          if (next.includes(key) && Object.hasOwn(kept.legacy, key) && !latestProofs.consumed.includes(sha256(key))) await keepQuestionProof($, path, 'consumed', sha256(key))
        }
        return answeredJson(next) === answeredJson(current) ? null : answeredJson(next)
      })
      const current = parseAnswered(await readText($, answeredPath(path)))
      if (current !== null) await update($, hiddenAsks, () => current)
    }
    outcome = 'ok'
    return true
  } catch {
    return false
  } finally {
    // Another session's write landing between two reads is not a fault: only a ledger that stays
    // unreadable or unwritable for three polls in a row is worth telling the person about. A
    // race that never ends (a damaged proof file) is one too, after half a minute.
    if (outcome === 'ok') {
      questionFailures = 0
      questionRaces = 0
    } else if (outcome === 'race') questionRaces += 1
    else questionFailures += 1
    // Written only when it changes, so a quiet poll does not redraw every pane.
    const wasProblem = await read($, hasQuestionsProblem)
    const isProblem = outcome !== 'ok' && (wasProblem || questionFailures >= 3 || questionRaces >= 15)
    if (isProblem !== wasProblem) await update($, hasQuestionsProblem, () => isProblem)
  }
}

const pollAnsweredQuestions = async ($: EngineInterface, path: string, projects: readonly ProgressProject[] | undefined, evidence: readonly AgentTurn[] = []): Promise<void> => {
  rememberAnswered(evidence)
  try {
    const matches = (record: QuestionRecord, turn: QuestionAnswerEvidence): boolean => record.source?.kind === 'inbox' && record.source.agent === turn.agent && record.source.session === turn.id
    const batch = [...answeredPending.entries()]
    if (evidence.length > 0) {
      if (batch.length === 0) return
      const ledger = await read($, questionLedger)
      if (!batch.some(([, turn]) => ledger.records.some(record => record.isUnresolved && matches(record, turn)))) return
    }
    if (!(await pollQuestions($, path, projects ?? parseProgress(await readText($, path)), false, [], batch.map(([, turn]) => turn)))) return
    const now = await $.clock.now()
    for (const [key, turn] of batch) {
      if (answeredPending.get(key) !== turn) continue
      const since = answeredKeptSince.get(key) ?? now
      answeredKeptSince.set(key, since)
      if (now - since > 10 * 60_000) {
        answeredPending.delete(key)
        answeredKeptSince.delete(key)
      }
    }
  } catch {
    // Intake is committed already. A failed read or settlement retries on an ordinary poll.
  }
}

// Marks one question answered, or lists it again: only progress-answered.json changes, never a
// block, and nothing is sent to any session. Read, changed, written and read back in the write
// queue, so a press in another session or the board script is kept. False when it did not stick.
const setAnswered = async ($: EngineInterface, item: WaitingItem, isHidden: boolean): Promise<boolean> => {
  if (item.hideKey === '') return false
  const snap = await read($, snapshot)
  if (!(await pollQuestions($, snap.path || (await progressPath($)), snap.projects))) return false
  const ledger = await read($, questionLedger)
  const currentView = buildView(snap.projects, [], await read($, mine), await $.clock.now(), 0, {}, await wordsOf($), await read($, hiddenAsks), {}, ledger, await questionProofsFor($, snap.path || (await progressPath($))), await pendingTurns($))
  if (![...currentView.waiting, ...(currentView.reminder ?? []), ...(currentView.older ?? []), ...currentView.hidden].some(one => (!isHidden || one.canHide !== false) && one.hideKey === item.hideKey && one.project === item.project && one.text === item.text && one.note === item.note)) return false
  const file = answeredPath(snap.path || (await progressPath($)))
  const list = await enqueue(async () => {
    const fresh = parseProgress(await readText($, snap.path || (await progressPath($))))
    if (!(await pollQuestions($, snap.path || (await progressPath($)), fresh))) return null
    const latest = await read($, questionLedger)
    const current = buildView(fresh, [], await read($, mine), await $.clock.now(), 0, {}, await wordsOf($), await read($, hiddenAsks), {}, latest, await questionProofsFor($, snap.path || (await progressPath($))), await pendingTurns($))
    if (![...current.waiting, ...(current.reminder ?? []), ...(current.older ?? []), ...current.hidden].some(one => (!isHidden || one.canHide !== false) && one.hideKey === item.hideKey && one.project === item.project && one.text === item.text && one.note === item.note)) return null
    await rewrite(
      $,
      file,
      async before => {
        const stat = await $.fs.stat(file).catch(() => undefined)
        const now = parseAnswered(before, stat === undefined ? 0 : (await $.clock.now()) - stat.mtimeMs)
        const proofs = await questionProofsFor($, snap.path || (await progressPath($)))
        if (proofs === null || (isHidden && proofs.retired.includes(sha256(item.hideKey)))) return AGAIN
        return now === null ? AGAIN : answeredJson(withAnswered(now, isHidden ? [item.hideKey] : acknowledgementKeys(observeQuestions(latest, fresh, await read($, mine), now, await $.clock.now(), true).ledger, item.hideKey), isHidden))
      },
      check => parseAnswered(check)?.includes(item.hideKey) === isHidden,
    )
    return parseAnswered(await readText($, file))
  }).catch(() => null)
  if (list === null || list.includes(item.hideKey) !== isHidden) return false
  await update($, hiddenAsks, () => list)
  await refreshStatus($)
  await writeDashboard($, true)
  return true
}

// A task with no time of its own is aged from when its words were first seen, kept in
// progress-seen.json beside progress.md, which the board script keeps too. It is read when it
// changed (a stat per poll, as the answered list is) and written when progress.md changed. A
// failure leaves the record empty, so an undated task shows rather than hides; a record caught
// half-written keeps the one in hand, which is safe because changed words make a new key.
// Tasks gone from progress.md leave the record only once that file has held still for a poll
// (`still`), and only while it still does, on disk as well (as answered marks do).
// A write that fails is tried again on a later change, or after a minute.
const SEEN_RETRY_MS = 60_000
let seenStat: string | null = null
let hasSeenPending = false
let seenRetryAt = 0
const pollSeen = async (
  $: EngineInterface,
  path: string,
  projects: readonly ProgressProject[],
  isChanged: boolean,
  still: { mtimeMs: number; size: number } | null = null,
): Promise<void> => {
  const file = seenPath(path)
  const before = await read($, firstSeen)
  const set = async (seen: Record<string, number>): Promise<void> => {
    if (seenJson(seen) === seenJson(before)) return
    await update($, firstSeen, () => seen)
    // A changed progress.md redraws both after this; otherwise only the record moved.
    if (isChanged || (await read($, snapshot)).path !== path) return
    await refreshStatus($)
    await writeDashboard($, true)
  }
  let at = 0
  let record: Record<string, number> | null = null
  try {
    at = await $.clock.now()
    const stat = await $.fs.stat(file).catch(() => undefined)
    const key = stat === undefined ? '' : `${stat.mtimeMs}:${stat.size}`
    const isRetry = hasSeenPending && at >= seenRetryAt
    if (!isChanged && !isRetry && still === null && key === seenStat) return
    // Read again at the next poll after anything but a clean read with nothing to write.
    seenStat = null
    record = parseSeen(await readText($, file), stat === undefined ? 0 : at - stat.mtimeMs)
    if (record === null) {
      hasSeenPending = hasSeenPending || isChanged
      return
    }
    const isStale = still !== null && projects.length > 0 && seenJson(withSeen(record, projects, at, {}, true)) !== seenJson(withSeen(record, projects, at))
    if (isChanged || isRetry || isStale) {
      hasSeenPending = true
      let observed = withSeen(record, projects, at)
      await rewrite($, file, async text => {
        const disk = await $.fs.stat(file).catch(() => undefined)
        const current = parseSeen(text, disk === undefined ? 0 : at - disk.mtimeMs)
        if (current === null) return AGAIN
        const held = still === null ? undefined : await $.fs.stat(path).catch(() => undefined)
        const isSettled = isStale && held !== undefined && held.mtimeMs === still?.mtimeMs && held.size === still.size
        observed = withSeen(current, projects, at, observed, isSettled)
        return seenJson(observed) === seenJson(current) ? null : seenJson(observed)
      })
      const kept = parseSeen(await readText($, file))
      if (kept === null || seenJson(kept) !== seenJson(observed)) {
        seenRetryAt = at + SEEN_RETRY_MS
        // Another writer's record is as good as ours: its new tasks show until ours lands.
        if (kept !== null) await set(kept)
        return
      }
      hasSeenPending = false
      await set(kept)
    } else {
      seenStat = key
      await set(record)
    }
  } catch {
    hasSeenPending = hasSeenPending || isChanged
    seenRetryAt = at + SEEN_RETRY_MS
    // A record read but not written still holds the times it had; one not read holds none.
    await set(record ?? {})
  }
}

// Re-reads the file only when its mtime or size moved, so the 2s timer is a stat.
const poll = async ($: EngineInterface): Promise<void> => {
  if (isPolling) return
  isPolling = true
  try {
    const path = await progressPath($)
    await pollAnswered($, path).catch(() => undefined)
    const previous = await read($, snapshot)
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat === undefined) {
      if (Object.keys(await read($, firstSeen)).length > 0) await update($, firstSeen, () => ({}))
      if (!previous.isMissing || previous.path !== path) await update($, snapshot, () => ({ ...EMPTY, path }))
      return
    }
    const isSame = previous.path === path && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size
    if (isSame && previous.error === null && !previous.isMissing) {
      await pollSeen($, path, previous.projects, false, isPrunePending ? { mtimeMs: stat.mtimeMs, size: stat.size } : null)
      await pollAnsweredQuestions($, path, previous.projects)
      if (isPrunePending) {
        isPrunePending = false
        // Not waited on: poll also runs inside queued jobs, which the prune would queue behind.
        pruneAnswered($, path, previous.projects, stat.mtimeMs, stat.size).catch(() => undefined)
      }
      return
    }
    try {
      const projects = parseProgress(await $.fs.read(path))
      await update($, snapshot, () => ({
        path,
        isMissing: false,
        error: null,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        projects,
      }))
      await pollSeen($, path, projects, true)
      await pollAnsweredQuestions($, path, projects)
      await noteDone($, projects)
      isPrunePending = true
      await refreshStatus($)
      await writeDashboard($)
      await remind($)
    } catch (error) {
      await update($, snapshot, () => ({ ...EMPTY, path, isMissing: false, error: messageOf(error) }))
    }
  } finally {
    isPolling = false
  }
}

const dashboardPath = (path: string): string => `${path.replace(/\.md$/i, '')}.html`

const pad2 = (n: number): string => String(n).padStart(2, '0')

// Pending turns are optional: an unavailable inbox must not stop the board or its reminders.
let pendingCache: { key: string; turns: PendingTurn[] } | null = null
const pendingTurns = async ($: EngineInterface): Promise<PendingTurn[]> => {
  try {
    const path = await progressPath($)
    const dir = inboxPath(path)
    const done = await readInboxRecord($, 'inboxDone').catch(() => ({} as Record<string, string>))
    const cacheKey = JSON.stringify([path, await $.clock.now(), done])
    if (pendingCache?.key === cacheKey) return pendingCache.turns
    const entries = (await $.fs.list(dir))
      .filter(entry => entry.kind === 'file' && isInboxFile(entry.name) && done[entry.name] === undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 30)
    const files: Array<{ name: string; body: string; at: number }> = []
    for (const entry of entries) {
      const body = await $.fs.read(`${dir}${sepOf(dir)}${entry.name}`).catch(() => '')
      files.push({ name: entry.name, body, at: entry.mtimeMs })
    }
    const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/[\\/]+$/, '')
    const isWin = await isWindows($, path)
    const turns = peekInbox(files, () => '', text => redact(text, home, isWin))
    pendingCache = { key: cacheKey, turns }
    return turns
  } catch {
    return []
  }
}

// progress.html beside progress.md: the file's view and pending turns, at most once a minute
// and only when it changed.
const writeDashboard = async ($: EngineInterface, force = false): Promise<string> => {
  const snap = await read($, snapshot)
  const at = await $.clock.now()
  const path = dashboardPath(snap.path || (await progressPath($)))
  if (!force && at - dashboardAt < 60 * 1000) return path
  const s = await wordsOf($)
  const view = buildView(snap.projects, [], null, at, await read($, today), await read($, doneSeen), s, await read($, hiddenAsks), await read($, firstSeen), await read($, questionLedger), await questionProofsFor($, snap.path || (await progressPath($))), await pendingTurns($))
  const pending = await pendingTurns($)
  const date = new Date(at)
  const html = dashboardHtml(view, s, snap.path, s.dashStamp(`${localDay(at)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`), pending)
  dashboardAt = at
  if (html === lastDashboard) return path
  lastDashboard = html
  await $.fs.write(path, html).catch(() => undefined)

  return path
}

// Opens progress.html in the default browser: a window of its own on the desktop.
const openDashboard = async ($: EngineInterface): Promise<boolean> => {
  const path = await writeDashboard($, true)
  const argv = (await isWindows($, path))
    ? ['cmd', '/c', 'start', '', path]
    : (await $.env.get('HOME'))?.startsWith('/Users/')
      ? ['open', path]
      : ['xdg-open', path]
  const ran = await $.process.run(argv, { timeoutMs: 10000 }).catch(() => null)

  return ran !== null && ran.exitCode === 0
}

// Hand-kept tasks seen done for the first time get a timestamp, so they leave a day later.
const noteDone = async ($: EngineInterface, projects: readonly ProgressProject[]): Promise<void> => {
  const seen = await read($, doneSeen)
  const fresh: Record<string, number> = {}
  const at = await $.clock.now()
  for (const project of projects) {
    for (const task of project.tasks) {
      if (task.auto !== null || task.line < 0 || !isTaskComplete(task)) continue
      const key = doneKey(project.name, task.title)
      if (seen[key] === undefined) fresh[key] = at
    }
  }
  const keys = Object.keys(fresh)
  if (keys.length === 0) return
  await update($, doneSeen, old => ({ ...old, ...fresh }))
  for (const key of keys) await $.store.set(key, fresh[key])
}

// The line under the prompt, for when the pane is not on screen; written only when it
// changes.
const refreshStatus = async ($: EngineInterface): Promise<void> => {
  const s = await wordsOf($)
  const text = isPaneOpen
    ? undefined
    : statusLine(
        buildView(
          (await read($, snapshot)).projects,
          await read($, here),
          await read($, mine),
          await $.clock.now(),
          await read($, today),
          await read($, doneSeen),
          s,
          await read($, hiddenAsks),
          await read($, firstSeen),
          await read($, questionLedger),
          await questionProofsFor($, await progressPath($)),
          await pendingTurns($),
        ),
        s,
      )
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

// A file that is not there reads as empty; one that is there and cannot be read (too big,
// locked) rejects, so nothing is written over it.
const readText = async ($: EngineInterface, path: string): Promise<string> => {
  try {
    return await $.fs.read(path)
  } catch (error) {
    if (!(await $.fs.exists(path))) return ''
    throw error
  }
}

// Every write this session makes (its block, a tick, an archive) goes through one queue,
// so none reads the file while another is on its way and writes over it.
const enqueue = <T,>(job: () => Promise<T>): Promise<T> => {
  const run = writes.then(job, job)
  writes = run.catch(() => undefined)

  return run
}

// What a change answers to have the file read again before it is made: a write caught half-way.
const AGAIN = Symbol('again')

// Read, change, write, read back. When another session's write lands in between, the change
// is made again over what that session wrote, so neither undoes the other; `change` must be
// safe to make twice. It answers null to leave the file as it is. `isKept` says whether what
// was read back still holds the change (by default: is exactly what was written). The text
// last written comes back, or null when nothing was.
const rewrite = async (
  $: EngineInterface,
  path: string,
  change: (before: string) => Promise<string | null | typeof AGAIN> | string | null | typeof AGAIN,
  isKept: (check: string, after: string) => boolean = (check, after) => check === after,
  writer: (path: string, text: string) => Promise<void> = (path, text) => $.fs.write(path, text),
): Promise<string | null> => {
  let wrote: string | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await readText($, path)
    const after = await change(before)
    if (after === AGAIN) continue
    if (after === null || after === before) break
    await writer(path, after)
    wrote = after
    if (isKept(await readText($, path), after)) break
  }

  return wrote
}

// This session's block, written over whatever is there now, and kept when another session
// writes its own block in between.
const writeMine = async ($: EngineInterface): Promise<void> => {
  const mirror = await read($, mine)
  if (mirror === null) return
  const s = await wordsOf($)
  await rewrite(
    $,
    await progressPath($),
    async before => {
      // Zero bytes from a file the last poll saw with content is most likely another write
      // caught half-way: look again rather than write a file holding only this block.
      if (before === '' && (await read($, snapshot)).size > 0) {
        await poll($)
        return AGAIN
      }
      return mirror.tasks.length === 0 ? removeAutoBlock(before, mirror.sessionId) : upsertAutoBlock(before, mirror, s)
    },
    (check, after) => extractAutoBlock(check, mirror.sessionId) === extractAutoBlock(after, mirror.sessionId),
  )
  await poll($)
}

const queueWrite = ($: EngineInterface): Promise<void> => enqueue(() => writeMine($)).catch(() => undefined)

const notify = async ($: EngineInterface, text: string, project: string): Promise<void> => {
  if (!(await read($, isNotifyOn))) return
  await $.ui.notify(text, { title: (await wordsOf($)).notifyTitle(project) }).catch(() => undefined)
}

// Recounts today's finished steps from this month's journal.
const countToday = async ($: EngineInterface): Promise<void> => {
  const at = await $.clock.now()
  const text = await readText($, journalPath(await progressPath($), at)).catch(() => null)
  if (text === null) {
    if (localDay(at) !== countedDay) await update($, today, () => 0)
    return
  }
  countedDay = localDay(at)
  await update($, today, () => countDay(text, at))
}

// Keep the original month and timestamp across retries, including a module reload.
const journal = ($: EngineInterface, entries: ReadonlyArray<Omit<JournalEntry, 'at'>> = [], storedKey?: string): Promise<void> => {
  let hasPending = entries.length > 0
  let key = storedKey ?? ''
  return enqueue(async () => {
    const at = await $.clock.now()
    const s = await wordsOf($)
    if (key === '') key = `pendingJournal:${await $.session.id()}`
    const pending = { ...pendingJournals.get(key) }
    hasPending ||= Object.values(pending).some(lines => lines.length > 0)
    let isStoreReadable = true
    let stored: unknown
    try {
      stored = await $.store.get(key)
    } catch {
      isStoreReadable = false
    }
    if (stored !== undefined && stored !== null && (typeof stored !== 'object' || Array.isArray(stored) || Object.values(stored).some(lines => !Array.isArray(lines) || lines.some(line => typeof line !== 'string')))) {
      try {
        await $.store.set(key.replace('pendingJournal:', 'pendingJournalBad:'), stored)
        await $.store.delete(key)
      } catch {
        isStoreReadable = false
      }
    } else {
      for (const [path, lines] of Object.entries((stored ?? {}) as Record<string, string[]>)) {
        pending[path] = [...new Set([...(pending[path] ?? []), ...lines])]
      }
    }
    if (entries.length > 0) {
      const path = journalPath(await progressPath($), at)
      pending[path] = [...new Set([...(pending[path] ?? []), ...entries.map(entry => journalLine(entry, at, s))])]
    }
    hasPending ||= Object.values(pending).some(lines => lines.length > 0)
    // A broken store must not prevent the file write or a retry in this module.
    if (hasPending) {
      pendingJournals.set(key, pending)
      if (isStoreReadable && storedKey === undefined) await $.store.set(key, { ...pending }).catch(() => undefined)
    }
    let hasFailed = false
    const verified: Record<string, string[]> = {}
    for (const [path, lines] of Object.entries(pending)) {
      try {
        await rewrite($, path, before => {
          const saved = new Set(before.split(/\r?\n/))
          return appendJournal(before, lines.filter(line => !saved.has(line)), s)
        })
        const saved = new Set((await readText($, path)).split(/\r?\n/))
        if (lines.some(line => !saved.has(line))) throw new Error('JOURNAL_NOT_VERIFIED')
        verified[path] = lines
        delete pending[path]
      } catch {
        hasFailed = true
      }
    }
    if (Object.keys(pending).length === 0) {
      pendingJournals.delete(key)
    }
    if (isStoreReadable) {
      try {
        // The owner may have added lines while this session was saving its earlier ones.
        const latest = await $.store.get(key)
        if (latest === undefined || latest === null || typeof latest === 'object' && !Array.isArray(latest) && Object.values(latest).every(lines => Array.isArray(lines) && lines.every(line => typeof line === 'string'))) {
          const remaining = { ...pending }
          for (const [path, lines] of Object.entries((latest ?? {}) as Record<string, string[]>)) {
            const saved = new Set(verified[path])
            const rest = [...new Set([...(remaining[path] ?? []), ...lines])].filter(line => !saved.has(line))
            if (rest.length > 0) remaining[path] = rest
            else delete remaining[path]
          }
          if (Object.keys(remaining).length === 0) await $.store.delete(key)
          else await $.store.set(key, remaining)
        }
      } catch {
        // Unsaved lines stay in memory when the store cannot be updated.
      }
    }
    if (hasFailed) throw new Error('JOURNAL_NOT_VERIFIED')
    if (hasPending) {
      await countToday($)
      journalNoticesShown.delete(key)
      if (journalNoticeKey === key) {
        await update($, answer, current => Object.values(STRINGS).some(words => current?.text === words.journalFailed) ? null : current)
        journalNoticeKey = ''
      }
    }
  }).catch(async () => {
    try {
      if (!hasPending || key !== `pendingJournal:${await $.session.id()}` || journalNoticesShown.has(key)) return
      const s = await wordsOf($)
      let isShown = false
      await update($, answer, current => {
        if (current?.isAsking || current?.copied !== undefined) return current
        isShown = true
        return { question: s.journalNoticeTitle, text: s.journalFailed, isAsking: false }
      })
      if (isShown) {
        journalNoticesShown.add(key)
        journalNoticeKey = key
      }
    } catch {
      // Even a notice that cannot be drawn must not reject the turn or completion.
    }
  })
}

// The theme as /config shows it; the palette follows it.
const readTheme = async ($: EngineInterface): Promise<void> => {
  const rows = await $.config.list().catch(() => [])
  const value = rows.find(row => row.key === 'theme')?.value
  await update($, theme, () => (typeof value === 'string' ? value : 'dark'))
}

const updateBackgroundMirror = async (
  $: EngineInterface,
  change: (mirror: ProgressMirror) => ProgressMirror,
): Promise<{ current: ProgressMirror | null; next: ProgressMirror | null }> => {
  let current = null as ProgressMirror | null
  const next = await update($, mine, value => {
    current = value
    return value === null ? null : change(value)
  })
  return { current, next }
}

// Saves the mirror for this session (the pane redraws) and across restarts ($.store). What
// changed is journaled and, when it needs the person, notified; `quiet` skips both, for a
// re-read of a list whose changes happened while the mod was not looking.
const saveMine = async (
  $: EngineInterface,
  change: (mirror: ProgressMirror) => ProgressMirror,
  quiet = false,
): Promise<void> => {
  const { current, next } = await updateBackgroundMirror($, change)
  if (next === null || current === null) return
  await $.store.set(`mirror:${next.sessionId}`, next)
  if (!quiet) {
    const finished = completedSince(current, next)
    const title = next.title || fallbackTitle(next)
    if (finished.length > 0) {
      await journal(
        $,
        finished.map(task => ({ project: next.project, task: title, step: task.subject })),
      )
    }
    for (const text of noticesOf(current, next, await wordsOf($))) await notify($, text, next.project)
  }
  await refreshStatus($)
}

// Parallel tool calls and delivered notices must not overwrite each other's counts.
const saveBackground = ($: EngineInterface, change: (mirror: ProgressMirror) => ProgressMirror): Promise<void> => {
  hasBackgroundActivity = true
  pendingBackgroundSaves += 1
  const run = backgroundChanges.then(() => saveMine($, change)).finally(() => { pendingBackgroundSaves -= 1 })
  backgroundChanges = run.catch(() => undefined)
  return run
}

const saveCurrent = ($: EngineInterface, change: (mirror: ProgressMirror) => ProgressMirror): Promise<void> =>
  hasBackgroundActivity ? saveBackground($, change) : saveMine($, change)

// The project this session writes under: the remote's repo name, else the folder's.
const projectName = async ($: EngineInterface): Promise<string> => {
  const repo = await $.session.repo().catch(() => null)
  if (repo?.remote) return baseName(repo.remote).replace(/\.git$/, '')
  if (repo !== null) return baseName(repo.root)

  return baseName(await $.session.root().catch(() => '')) || (await wordsOf($)).uncategorized
}

const branchName = async ($: EngineInterface): Promise<string> => {
  const root = await $.session.root().catch(() => undefined)
  const ran = await $.process
    .run(['git', 'branch', '--show-current'], root === undefined ? undefined : { cwd: root })
    .catch(() => undefined)

  return ran?.exitCode === 0 ? ran.stdout.trim() : ''
}

// Names this session's project may go by: repo name, main worktree folder, session folder.
const detectHere = async ($: EngineInterface): Promise<void> => {
  const names = new Set<string>()
  const root = await $.session.root().catch(() => undefined)
  if (root !== undefined) names.add(baseName(root))
  const repo = await $.session.repo().catch(() => null)
  if (repo !== null) {
    names.add(baseName(repo.root))
    if (repo.name !== null) names.add(baseName(repo.name))
    if (repo.remote !== null) names.add(baseName(repo.remote).replace(/\.git$/, ''))
  }
  await update($, here, () => [...names].filter(name => name !== ''))
}

// The mirror outlives a reload in $.state and a restart in $.store. A mirror stored by an
// older version gets the fields it lacks from a fresh one.
const loadMine = async ($: EngineInterface, cwd: string): Promise<void> => {
  const sessionId = await $.session.id()
  const held = await read($, mine)
  if (held !== null && held.sessionId === sessionId) return
  const key = `mirror:${sessionId}`
  const raw = await $.store.get(key) as ProgressMirror | undefined
  const stored = (await completedMirror($, key, raw)).mirror
  const fresh = emptyMirror(sessionId, await projectName($), await $.clock.now(), cwd)
  // Background processes belong to the old host, even when the conversation resumes.
  await update($, mine, () => (stored === undefined ? fresh : { ...clearBackgroundJobs({ ...fresh, ...stored }), isTurnRunning: false, cwd: stored.cwd || cwd }))
}

const completedMirror = async ($: EngineInterface, key: string, raw: ProgressMirror | undefined): Promise<{ mirror: ProgressMirror | undefined; barrier: number }> => {
  let mirror = raw
  let barrier = 0
  for (const name of (await $.store.keys()).filter(name => name.startsWith(completionPrefix(key)))) {
    const overlay = await $.store.get(name)
    if (!isCompletionOverlay(overlay, key)) continue
    if (raw === undefined) {
      barrier = Math.max(barrier, overlay.updated)
      if (mirror === undefined || (mirror.confirmedAt ?? 0) <= overlay.updated) mirror = overlay.completed
      continue
    }
    const projected = applyCompletionOverlay(raw, overlay)
    if (projected !== raw) {
      barrier = Math.max(barrier, overlay.updated)
      if ((mirror?.confirmedAt ?? 0) <= overlay.updated) mirror = projected
    }
  }
  return { mirror, barrier }
}

// Claude's own list, read when the mirror missed calls (installed mid-session, a reload).
const resync = async ($: EngineInterface): Promise<void> => {
  const ran = await $.tool.call({ tool: 'TaskList' }).catch(() => undefined)
  if (ran === undefined || ran.deny !== undefined || ran.isError === true) return
  const listed = (ran.result as { tasks?: ListedTask[] } | undefined)?.tasks
  if (listed === undefined) return
  const at = await $.clock.now()
  await saveMine($, mirror => fromTaskList(mirror, listed, at), true)
}

// The pull request of this branch, through the person's own gh; only in a GitHub repo.
const refreshPr = async ($: EngineInterface): Promise<void> => {
  if (!hasGh || isCheckingPr) return
  const repo = await $.session.repo().catch(() => null)
  if (repo?.remote?.includes('github') !== true) return
  isCheckingPr = true
  try {
    const ran = await $.process
      .run(['gh', 'pr', 'view', '--json', GH_FIELDS], { cwd: repo.root, timeoutMs: 15000 })
      .catch((error: unknown) => {
        // Not installed: stop asking. A timeout is tried again next time.
        if (/ENOENT|not found|cannot start|spawn/i.test(messageOf(error))) hasGh = false
        return null
      })
    if (ran === null) return
    if (ran.exitCode !== 0 && /gh auth login/.test(ran.stderr)) hasGh = false
    const pr: ProgressPr | null = ran.exitCode === 0 ? prFromGh(ran.stdout) : null
    const mirror = await read($, mine)
    if (mirror === null) return
    const before = mirror.pr ?? null
    if (JSON.stringify(before) === JSON.stringify(pr)) return
    await saveMine($, one => ({ ...one, pr }))
    const finished = ciFinished(before, pr, await wordsOf($))
    if (finished !== null) await notify($, finished, mirror.project)
    if (mirror.tasks.length > 0) await queueWrite($)
  } finally {
    isCheckingPr = false
  }
}

const nameTask = async ($: EngineInterface): Promise<void> => {
  const mirror = await read($, mine)
  if (mirror === null || mirror.isTitleFinal || mirror.tasks.length === 0 || mirror.source === 'turns') return
  await saveMine($, one => ({ ...one, isTitleFinal: true, title: one.title || fallbackTitle(one), namedSteps: one.tasks.length }))
  const steps = mirror.tasks.map(task => `- ${task.subject}`).join('\n')
  const asked = await complete($, {
    model: 'haiku',
    maxTokens: 120,
    effort: 'low',
    prompt: (await wordsOf($)).namePrompt(requestData(mirror.firstPrompt), steps),
  })
  const lines = asked?.isAnswered === true ? asked.text.split(/\r?\n/).filter(line => line.trim() !== '') : []
  const title = cleanTitle(lines[0] ?? '')
  const context = cleanContext(lines[1] ?? '')
  if (title === '' && context === '') return
  await saveMine($, one => ({ ...one, title: title || one.title, context: context || one.context }))
  await queueWrite($)
}

// The list grew well past what the title and background were written for: the model looks
// again, and keeps both when the goal is the same.
const refreshName = async ($: EngineInterface): Promise<void> => {
  const mirror = await read($, mine)
  if (mirror === null || !needsRefresh(mirror)) return
  await saveMine($, one => ({ ...one, namedSteps: one.tasks.length }), true)
  const s = await wordsOf($)
  const steps = mirror.tasks.map(task => `- ${task.subject}`).join('\n')
  const asked = await complete($, {
    model: 'haiku',
    maxTokens: 120,
    effort: 'low',
    prompt: s.refreshPrompt(requestData(mirror.firstPrompt), steps, mirror.title || fallbackTitle(mirror), mirror.context),
  })
  const lines = asked?.isAnswered === true ? asked.text.split(/\r?\n/).filter(line => line.trim() !== '') : []
  const title = cleanTitle(lines[0] ?? '')
  const context = cleanContext(lines[1] ?? '')
  if (title === '' && context === '') return
  await saveMine($, one => ({ ...one, title: title || one.title, context: context || one.context }), true)
  await queueWrite($)
}

// A turn summed up into a session's steps: what it finished, what comes next and what it
// ended up asking. Without the model's answer, the question the reply ends on is still
// caught. null when the turn gave nothing to track and the session is not tracked yet.
// `onSilence`: with neither the model's answer nor a question, an empty summary drops the
// session's open steps, so another agent's turn is tried again later ('retry', it throws) or,
// on its last try, leaves the steps as they are ('keep', null).
const summarize = async (
  $: EngineInterface,
  mirror: ProgressMirror,
  prompt: string,
  answer: string,
  onSilence: 'sum' | 'keep' | 'retry' = 'sum',
): Promise<{ digest: Digest; now: number; s: Strings } | null> => {
  const s = await wordsOf($)
  const steps = mirror.tasks.map(task => `- [${task.status === 'completed' ? 'x' : ' '}] ${task.subject}`).join('\n')
  const asked = await complete($, {
    model: 'haiku',
    maxTokens: 300,
    effort: 'low',
    prompt: s.digestPrompt(requestData(mirror.firstPrompt), requestData(prompt), replyData(answer), mirror.title, mirror.context, steps),
  })
  const question = lastQuestion(answer)
  if (asked?.isAnswered !== true && question === null) {
    if (onSilence === 'retry') throw new Error(NO_SUMMARY)
    if (onSilence === 'keep') return null
  }
  const parsed = asked?.isAnswered === true ? parseDigest(asked.text) : null
  const empty: Digest = { title: '', context: '', done: '', next: '', ask: '', why: '' }
  const digest: Digest = { ...empty, ...parsed }
  if (digest.ask === '' && question !== null) {
    digest.ask = clip(question, 48)
    digest.why = question
  }
  if (digest.done === '' && digest.next === '' && digest.ask === '' && mirror.source !== 'turns' && (mirror.backgroundJobs ?? 0) === 0) return null

  return { digest, now: await $.clock.now(), s }
}

// A turn of this session, which keeps no Task list.
const digestTurn = async ($: EngineInterface, prompt: string, answer: string, hasRunningTurnBackgroundJob: boolean): Promise<void> => {
  const mirror = await read($, mine)
  if (mirror === null || mirror.state === 'ended' || (mirror.source === 'tasks' && mirror.tasks.length > 0)) return
  const summed = await summarize($, mirror, prompt, answer)
  if (summed === null) return
  // Fold the finished steps onto the current mirror so concurrent releases survive.
  let isEnded = false
  await saveCurrent($, current => {
    isEnded = current.state === 'ended'
    if (current.source === 'tasks' && current.tasks.length > 0) return current
    return applyDigest(current, summed.digest, summed.now, summed.s, hasRunningTurnBackgroundJob)
  })
  if (isEnded) await queueWrite($)
  else await settle($)
}

// Another agent's turns, from its hook, written into its own block. Its mirror lives in
// the store, so whichever open session reads the next turn carries on from it. Only the
// last two turns of a burst are summed up by the model; the earlier ones just move on what
// the mirror remembers of the conversation.
// Another open session can take a later turn of the same agent session while this one
// waits on the model; whichever wrote second would drop the other's step. So the mirror is
// checked again just before writing, and when it moved, these turns are folded onto it once
// more (the fold skips a reply it has already seen).
// It throws unless the block is on the board, read back, or the turns had nothing to track:
// the inbox files stay until then. `isLastTry`: the model's silence no longer holds the turns
// back, so what can be written without it is.
// A turn older than one already folded in (a file taken again after a later turn of the same
// session got through, its end included) changes nothing: its steps would stand over newer ones.
// Completion hashes always refer to the raw owner, before prompt projection.
const agentProjection = async ($: EngineInterface, id: string, raw: ProgressMirror | undefined): Promise<{ mirror: ProgressMirror | undefined; barrier: number }> => {
  const completion = await completedMirror($, `agent:${id}`, raw)
  const receipts = []
  for (const key of await $.store.keys()) {
    if (key.startsWith(`agentPrompt:${id}:`)) receipts.push(await $.store.get(key))
  }
  return { mirror: withAgentPrompts(completion.mirror, receipts, await $.clock.now()), barrier: completion.barrier }
}

const agentMirror = async ($: EngineInterface, id: string): Promise<ProgressMirror | undefined> =>
  (await agentProjection($, id, await $.store.get(`agent:${id}`) as ProgressMirror | undefined)).mirror

const takeAgentTurns = async ($: EngineInterface, turns: readonly AgentTurn[], attempt = 0, isLastTry = false): Promise<void> => {
  const last = turns.at(-1)
  if (last === undefined) return
  const at = await $.clock.now()
  const owner = `agent:${last.id}`
  const raw = await $.store.get(owner) as ProgressMirror | undefined
  const completion = await agentProjection($, last.id, raw)
  const stored = completion.mirror
  const seen = JSON.stringify(raw ?? null)
  const completedSeen = JSON.stringify(completion)
  const fresh = emptyMirror(last.id, last.project || (await wordsOf($)).uncategorized, at, last.cwd, last.agent)
  const firstPrompt = promptKey(stored?.firstPrompt || turns.find(one => one.prompt !== '')?.prompt || '')
  let mirror: ProgressMirror = { ...fresh, ...stored, firstPrompt, lastAnswer: answerKey(stored?.lastAnswer ?? ''), resume: last.session }
  const newest = normalizeTurnOrder(stored?.turnOrder) ?? -1
  const promptBarrier = normalizeTurnOrder(stored?.promptOrder) ?? -1
  const barrier = Math.max(stored?.confirmedAt ?? 0, completion.barrier)
  const isNewer = (turn: AgentTurn): boolean => (turnOrder(turn) ?? newest) >= newest && (promptBarrier < 0 || (turnOrder(turn) ?? -1) >= promptBarrier) && (barrier === 0 || (turnOrder(turn) ?? -1) > barrier * 2 + 1)
  const evidence = turns.filter(isNewer)
  const digested = turnsToDigest(turns.map(turn => turn.event === 'end' && lastQuestion(turn.answer, true) !== null ? { ...turn, event: 'turn' as const } : turn))
  for (const [index, turn] of turns.entries()) {
    if ((turn.event !== 'turn' && lastQuestion(turn.answer, true) === null) || !isNewer(turn)) continue
    let { prompt, answer } = turn
    // Codex's Stop carries the reply but not the request; the session log has both.
    if ((answer === '' || prompt === '') && isTranscriptPath(turn.transcript) && (digested.has(index) || mirror.firstPrompt === '')) {
      const log = await $.fs.read(turn.transcript).catch(() => '')
      const tail = transcriptTail(typeof log === 'string' ? log : '', ANSWER_KEEP, isTextLog(turn.transcript))
      answer = answer || tail.answer
      prompt = prompt || tail.prompt
    }
    // Known only now for Codex, whose Stop leaves the request out.
    if (isBoardTurn({ ...turn, prompt, answer })) continue
    if (mirror.firstPrompt === '' && prompt !== '') mirror = { ...mirror, firstPrompt: promptKey(prompt) }
    if (answer === '' || answerKey(answer) === mirror.lastAnswer) continue
    if (digested.has(index)) {
      mirror = answerTurns(mirror)
      const summed = await summarize($, mirror, prompt, answer, isLastTry ? 'keep' : 'retry')
      if (summed !== null) mirror = applyDigest(mirror, summed.digest, summed.now, summed.s)
    }
    mirror = { ...mirror, lastAnswer: answerKey(answer) }
  }
  const latest = evidence.at(-1)
  // Only older turns: the block already says more than they do, and writing it again would
  // bring back one archived since.
  if (mirror.tasks.length === 0 || latest === undefined) {
    rememberAnswered(evidence)
    return
  }
  const state = isAllDone(mirror) ? 'done' : latest.event === 'end' ? 'ended' : 'waiting'
  mirror = { ...mirror, state, updated: at, turnOrder: Math.max(newest, ...turns.map(one => turnOrder(one) ?? -1)) }
  const s = await wordsOf($)
  const written = mirror
  let hasMoved = false
  await enqueue(async () => {
    const current = await $.store.get(owner) as ProgressMirror | undefined
    if (JSON.stringify(current ?? null) !== seen || JSON.stringify(await agentProjection($, last.id, current)) !== completedSeen) {
      hasMoved = true
      return
    }
    await $.store.set(owner, written)
    rememberAnswered(evidence)
    const path = await progressPath($)
    const isKept = (check: string): boolean =>
      extractAutoBlock(check, written.sessionId) === extractAutoBlock(upsertAutoBlock(check, written, s), written.sessionId)
    await rewrite($, path, async before => {
      const current = await $.store.get(owner) as ProgressMirror | undefined
      if (JSON.stringify(current ?? null) !== JSON.stringify(written) || JSON.stringify((await agentProjection($, last.id, current)).mirror ?? null) !== JSON.stringify(written)) {
        hasMoved = true
        return null
      }
      return upsertAutoBlock(before, written, s)
    }, isKept)
    if (hasMoved) return
    // Another session's write can undo it three times over; only a block read back counts.
    if (!isKept(await readText($, path))) throw new Error(NOT_KEPT)
    await pollAnsweredQuestions($, path, undefined, evidence)
    await poll($)
  })
  if (hasMoved) {
    if (attempt >= 2) throw new Error(NOT_KEPT)
    await takeAgentTurns($, turns, attempt + 1, isLastTry)
  }
}

// This queue contains bounded file writes, never model work. Prompt receipts can
// therefore answer a visible question while an older turn is still being summed.
const takeAgentPrompt = async ($: EngineInterface, prompt: AgentTurn): Promise<void> => {
  await enqueue(async () => {
    const stored = await agentMirror($, prompt.id)
    const updated = await $.clock.now()
    const next = answerAgentPrompt(stored, prompt, updated)
    if (next === null) return
    const path = await progressPath($)
    const s = await wordsOf($)
    let written: string | null = null
    let original: string | undefined
    await rewrite($, path, async before => {
      if (JSON.stringify((await agentMirror($, prompt.id)) ?? null) !== JSON.stringify(stored)) throw new Error('PROMPT_CHANGED')
      const matches = parseProgress(before).flatMap(project => project.tasks).filter(task => task.auto?.session === prompt.id)
      if (matches.length !== 1 || matches[0]?.auto?.agent !== prompt.agent || matches[0]?.auto?.resume !== prompt.session) return null
      const spans = scanBlocks(before.split(/\r?\n/)).filter(span => span.session === prompt.id)
      if (spans.length !== 1 || !spans[0]?.isClosed) return null
      const block = extractAutoBlock(before, prompt.id)
      if (block === null) return null
      if (original !== undefined && block !== original) return null
      original = block
      written = extractAutoBlock(upsertAutoBlock(before, next, s), prompt.id)
      return upsertAutoBlock(before, next, s)
    }, check => extractAutoBlock(check, prompt.id) === written)
    if (written === null) return
    if (extractAutoBlock(await readText($, path), prompt.id) !== written) throw new Error(NOT_KEPT)
    // No owner-key write: a later owner may advance while this await is pending.
    // Every receipt has its own key, so simultaneous prompts do not erase barriers.
    const key = `agentPrompt:${prompt.id}:${next.promptOrder}:${updated}`
    const receipt = { id: prompt.id, agent: prompt.agent, session: prompt.session, at: prompt.at, updated }
    await $.store.set(key, receipt)
    // The stored receipt makes a retry skip this prompt, so its evidence is kept before the check.
    rememberAnswered([prompt])
    // A successful call alone does not prove persistence. Keep the claimed input
    // until this immutable barrier can be read back with the same binding/time.
    if (JSON.stringify(await $.store.get(key)) !== JSON.stringify(receipt)) throw new Error('PROMPT_RECEIPT_NOT_KEPT')
    await pollAnsweredQuestions($, path, undefined, [prompt])
    await poll($)
  })
}

// `/progress connect`: the reporter script beside progress.md, and a hook for it in every
// agent installed here. Its AGENTS.md-style section goes, so its work does not show twice.
// `remove` takes all of it back out. Files that are not JSON are named and left alone.
// `auto` is the same connect run at a session's start: it counts only the agents it newly
// hooked in, and says nothing of a config it cannot read, so an unchanged machine hears
// nothing.
type ConnectMode = 'connect' | 'remove' | 'auto' | 'status' | 'language' | 'ack'
type ConnectResult = { text: string; lines: string[]; done: string[]; problems: SetupProblem[] }
type ConnectReply = { state: ConnectState; result: ConnectResult | null; request: LegacyConnectRequest }
const setupFailures = new Set<string>()
let backgroundConnect: Promise<void> | null = null

const workerProblem = (error: unknown): string => /\b(?:E[A-Z]{2,15}|[A-Z]{3,}_[A-Z_]+)\b/.exec(messageOf(error))?.[0] ?? 'SETUP_FAILED'

const connectAgents = async ($: EngineInterface, mode: ConnectMode, options: PluginOptions, change: Partial<LegacyConnectRequest> = {}, previous?: LegacyConnectRequest): Promise<ConnectReply> => {
  const s = await wordsOf($)
  let request = previous
  if (request === undefined) {
    const path = await progressPath($)
    const sep = sepOf(path)
    const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/[\\/]+$/, '')
    const dirs: NonNullable<LegacyConnectRequest['dirs']> = {
      codex: ((await $.env.get('CODEX_HOME')) ?? '').replace(/[\\/]+$/, '') || [home, '.codex'].join(sep),
      grok: ((await $.env.get('GROK_HOME')) ?? '').replace(/[\\/]+$/, '') || [home, '.grok'].join(sep),
      hermes: ((await $.env.get('HERMES_HOME')) ?? '').replace(/[\\/]+$/, '') || [home, '.hermes'].join(sep),
      openclaw: ((await $.env.get('OPENCLAW_STATE_DIR')) ?? '').replace(/[\\/]+$/, '') || [home, '.openclaw'].join(sep),
    }
    const config = ((await $.env.get('XDG_CONFIG_HOME')) ?? '').replace(/[\\/]+$/, '') || [home, '.config'].join(sep)
    dirs.opencode = ((await $.env.get('OPENCODE_CONFIG_DIR')) ?? '').replace(/[\\/]+$/, '') || [config, 'opencode'].join(sep)
    const node = await nodeVersion($)
    if (node === null) throw new Error('NODE_REQUIRED')
    if (!isNodeSupported(node)) throw new Error('NODE_UNSUPPORTED')
    let openclawVersion: string | undefined
    if ((mode === 'auto' || mode === 'connect') && await $.fs.exists(dirs.openclaw!)) {
      const savedBy = openclawSavedBy(await readText($, [dirs.openclaw!, 'openclaw.json'].join(sep)).catch(() => ''))
      if (savedBy === null || openclawTooOld(savedBy) !== null) {
        const argv = await isWindows($, path) ? ['cmd', '/c', 'openclaw', '--version'] : ['openclaw', '--version']
        const ran = await $.process.run(argv, { timeoutMs: 10000 }).catch(() => null)
        openclawVersion = ran !== null && ran.exitCode === 0 ? openclawPrinted(ran.stdout) ?? undefined : undefined
      }
    }
    const owned: Record<string, string> = {}
    for (const key of await $.store.keys()) {
      if (!key.startsWith('generated:')) continue
      const value = await $.store.get(key)
      if (typeof value === 'string') owned[key.slice('generated:'.length)] = sha256(value)
    }
    const notified = await $.store.get('setupNotified')
    const boardLang = chosenLang(options.language, await $.store.get('lang')) ?? langOf(await $.store.get('boardLang')) ?? undefined
    const setup = setupSeed(await $.store.get('setupState'))
    const preference = mode === 'connect' ? chosenLang(options.language, await $.store.get('lang')) : mode === 'auto' ? langOf(options.language) : null
    request = { mode, home, progress: path, lang: s.lang, node, dirs, ...(preference === null ? {} : { boardLang: preference }), ...(openclawVersion === undefined ? {} : { openclawVersion }), seed: { ...(setup === undefined ? {} : { setup }), owned, disabled: (await $.store.get('autoConnectOff')) === true, notified: Array.isArray(notified) ? notified.filter((key): key is string => typeof key === 'string') : [], ...(boardLang === undefined ? {} : { boardLang }) } }
  }
  request = { ...request, ...change, mode, lang: s.lang }
  const argument = workerRequest(request)
  if (argument === null) throw new Error('INVALID_WORKER_REQUEST')
  const digest = sha256(BOARD_SCRIPT)
  const created = await $.process.run(['node', '-e', CONNECT_BOOTSTRAP, digest], { timeoutMs: 10000 })
  if (created.exitCode !== 0 || created.isStdoutTruncated) throw new Error(workerProblem(created.stderr))
  const stage = workerStage(JSON.parse(created.stdout), digest)
  if (stage === null) throw new Error('INVALID_WORKER_STAGE')
  await $.fs.write(stage.file, BOARD_SCRIPT)
  if (sha256(await readText($, stage.file)) !== digest) throw new Error('WORKER_DIGEST_CHANGED')
  const completed = await $.process.run(['node', '--input-type=module', '-e', CONNECT_EXECUTE, digest, JSON.stringify(stage), argument], { timeoutMs: 10000 })
  if (completed.exitCode !== 0 || completed.isStdoutTruncated) throw new Error(workerProblem(completed.stderr + completed.stdout))
  const reply = JSON.parse(completed.stdout) as Partial<ConnectReply>
  const state = reply.state
  const result = reply.result
  if (state === undefined || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || typeof state.disabled !== 'boolean' || !Array.isArray(state.notified) || state.notified.some(key => typeof key !== 'string') || state.setup !== undefined && !isSetupState(state.setup) || result === undefined || result !== null && (typeof result.text !== 'string' || !Array.isArray(result.lines) || result.lines.some(line => typeof line !== 'string') || !Array.isArray(result.done) || result.done.some(line => typeof line !== 'string') || !isSetupState({ agents: [], problems: result.problems, node: null }))) throw new Error('INVALID_WORKER_REPLY')
  return { state, result, request }
}

const nodeVersion = async ($: EngineInterface): Promise<string | null> => {
  const ran = await $.process.run(['node', '--version'], { timeoutMs: 10000 }).catch(() => null)
  return ran !== null && ran.exitCode === 0 ? nodeVersionOf(ran.stdout) : null
}

const autoConnect = async ($: EngineInterface, options: PluginOptions): Promise<void> => {
  if (options.autoConnect === false) return
  const reply = await connectAgents($, 'auto', options)
  setupFailures.clear()
  if (reply.result === null) return
  const { lines, done, problems } = reply.result
  const known = new Set(reply.state.notified)
  const fresh = problems.filter(problem => !known.has(problem.key))
  if (done.length === 0 && fresh.length === 0) {
    await connectAgents($, 'ack', options, { acknowledgement: { revision: reply.state.revision, keys: problems.map(problem => problem.key) } }, reply.request)
    return
  }
  const s = await wordsOf($)
  const title = fresh.length > 0 ? s.connectAttention : s.autoConnectTitle
  const text = [...(done.length > 0 ? lines : []), ...fresh.map(problem => setupProblemText(problem, s)), ...(fresh.length > 0 ? [s.setupStatusHint] : [])].join('\n')
  await update($, answer, () => ({ question: title, text, isAsking: false }))
  await $.ui.notify(fresh.length > 0 ? text : s.autoConnected(done.join(s.listSep)), { title }).catch(() => undefined)
  await connectAgents($, 'ack', options, { acknowledgement: { revision: reply.state.revision, keys: problems.map(problem => problem.key) } }, reply.request)
}

const startAutoConnect = ($: EngineInterface, options: PluginOptions): void => {
  if (backgroundConnect !== null) return
  backgroundConnect = autoConnect($, options).catch(async error => {
    const reason = workerProblem(error)
    if (setupFailures.has(reason)) return
    setupFailures.add(reason)
    const s = await wordsOf($)
    const text = s.connectWorkerFailed(reason)
    await update($, answer, () => ({ question: s.connectAttention, text, isAsking: false }))
    await $.ui.notify(text, { title: s.connectAttention }).catch(() => undefined)
  }).finally(() => { backgroundConnect = null })
  backgroundConnect.catch(() => undefined)
}

// New files in the inbox, each taken by one open session: it renames the file to a name of
// its own, which only one rename can do, and reads what it renamed. The file is deleted only
// once its turn is on the board, read back, or held nothing to track. A turn the board or the
// model could not take leaves its file taken, and a later look takes it again (claimAction);
// why it failed is in the store's `inboxFailed`. The inbox is let go of before the model is
// asked, so a slow answer never stops the next look. The reporter script clears files older
// than two days that no session took.
type Taken = { path: string; name: string; attempt: number; turn: AgentTurn | null | undefined; body?: string; error?: string }

const inboxFailure = (error: unknown): string => /\b(?:E[A-Z]{2,15}|[A-Z]{3,}_[A-Z_]+)\b/.exec(messageOf(error))?.[0] ?? 'INBOX_FAILED'
const inboxNotice = async ($: EngineInterface, path: string, reason: string): Promise<void> => {
  const s = await wordsOf($)
  const text = s.inboxHeld(path, reason)
  if (inboxNoticesShown.has(text)) return
  inboxNoticesShown.add(text)
  await update($, answer, () => ({ question: s.inboxTitle, text, isAsking: false }))
  await notify($, text, s.inboxTitle)
}

// A broken payload is evidence for fixing the reporter, not an empty turn. Keep
// it under .failed without replacing an earlier retained payload of that name: a later one
// takes the next free name (.failed.1, .failed.2, ...). One that cannot be read is still
// moved aside, so it is not tried again at every look; only its move is checked.
const quarantineInbox = async ($: EngineInterface, from: string, to: string, reason: string, isWin: boolean): Promise<void> => {
  let target = to
  for (let n = 1; await $.fs.exists(target); n += 1) {
    if (n > 99) throw new Error('QUARANTINE_EXISTS')
    target = `${to}.${n}`
  }
  const body = await $.fs.read(from).catch(() => undefined)
  const argv = isWin
    ? ['powershell', '-NoProfile', '-Command', `Move-Item -LiteralPath ${psQuote(from)} -Destination ${psQuote(target)} -ErrorAction Stop`]
    : ['mv', '-n', from, target]
  const ran = await $.process.run(argv, { timeoutMs: 10000 })
  if (ran.exitCode !== 0 || await $.fs.exists(from) || !(await $.fs.exists(target)) || (body !== undefined && await $.fs.read(target) !== body)) throw new Error('QUARANTINE_NOT_VERIFIED')
  await inboxNotice($, target, reason)
}

const pendingQuestionsProblem = async ($: EngineInterface, hasProblem: boolean): Promise<void> => {
  if (await read($, hasPendingQuestionsProblem) !== hasProblem) await update($, hasPendingQuestionsProblem, () => hasProblem)
}

// Keep only the ledger's source preview, never the original inbox payload. Each source has its
// own store key so another session can recover it without replacing this session's pending list.
const keepInboxQuestions = async ($: EngineInterface, captured: readonly PendingTurn[], isRestoring: boolean): Promise<void> => {
  const path = await progressPath($)
  const prefix = `pendingInboxQuestion:${sha256(path)}:`
  const own = new Set(captured.map(turn => `${prefix}${sha256(JSON.stringify([turn.id, turn.sourceRevisions]))}`))
  for (const turn of captured) pendingInboxQuestions.set(`${prefix}${sha256(JSON.stringify([turn.id, turn.sourceRevisions]))}`, turn)
  await enqueue(async () => {
    let hasCleanupProblem = false
    const discard = async (key: string): Promise<void> => {
      let isRemoved = false
      try {
        await $.store.delete(key)
        isRemoved = await $.store.get(key) == null
      } catch {
        // A saved question can retry cleanup without holding its processed turn.
      }
      pendingInboxQuestions.delete(key)
      if (isRemoved) droppingInboxQuestions.delete(key)
      else {
        droppingInboxQuestions.add(key)
        hasCleanupProblem = true
      }
    }
    for (const key of [...droppingInboxQuestions]) {
      if (key.startsWith(prefix)) await discard(key)
    }
    let hasRestoreProblem = false
    if (isRestoring || !hasRestoredInboxQuestions) {
      const keys = await $.store.keys().catch(() => { hasRestoreProblem = true; return [] as string[] })
      for (const key of keys) {
        if (!key.startsWith(prefix) || droppingInboxQuestions.has(key)) continue
        const value = await $.store.get(key).catch(() => { hasRestoreProblem = true; return undefined })
        if (value === undefined || value === null) continue
        if (typeof value !== 'object' || !('isQuestion' in value) || value.isQuestion !== true || !('id' in value) || typeof value.id !== 'string' || !('text' in value) || typeof value.text !== 'string' || !('agent' in value) || typeof value.agent !== 'string' || !('project' in value) || typeof value.project !== 'string' || !('at' in value) || typeof value.at !== 'number' || !Number.isFinite(value.at) || value.at < 0 || 'sourceAt' in value && (typeof value.sourceAt !== 'number' || !Number.isFinite(value.sourceAt) || value.sourceAt < 0) || ['sources', 'sourceRevisions'].some(field => field in value && (!Array.isArray((value as Record<string, unknown>)[field]) || ((value as Record<string, unknown>)[field] as unknown[]).some(one => typeof one !== 'string')))) {
          await discard(key)
          continue
        }
        if (!pendingInboxQuestions.has(key)) pendingInboxQuestions.set(key, value as PendingTurn)
      }
      hasRestoredInboxQuestions = !hasRestoreProblem
    }
    const at = await $.clock.now()
    let pending = [...pendingInboxQuestions].filter(([key]) => key.startsWith(prefix)).sort((a, b) => b[1].at - a[1].at)
    for (const [index, [key, turn]] of pending.entries()) {
      if (at - turn.at > 3 * DAY || index >= 50) await discard(key)
    }
    pending = pending.filter(([key]) => pendingInboxQuestions.has(key))
    // An older failed save cannot hold the turn files this drain owns.
    const unkept = new Set<string>()
    for (const [key, turn] of pending) {
      const isKept = await $.store.get(key).then(value => JSON.stringify(value) === JSON.stringify(turn)).catch(() => false)
        || await $.store.set(key, turn).then(async () => JSON.stringify(await $.store.get(key)) === JSON.stringify(turn)).catch(() => false)
      if (isKept) continue
      if (!own.has(key)) {
        unkept.add(key)
        continue
      }
      for (const one of own) pendingInboxQuestions.delete(one)
      await pendingQuestionsProblem($, true)
      throw new Error('PENDING_QUESTION_NOT_KEPT')
    }
    pending = pending.filter(([key]) => !unkept.has(key))
    if (pending.length === 0) {
      await pendingQuestionsProblem($, hasCleanupProblem || hasRestoreProblem || unkept.size > 0)
      return
    }
    const text = await readText($, path).catch(() => null)
    if (text === null || !isQuestionSnapshot(text)) {
      await pendingQuestionsProblem($, true)
      return
    }
    const projects = parseProgress(text)
    for (const [key, turn] of pending) {
      const words = questionWords(turn.text)
      const steps = projects.filter(project => project.name === turn.project).flatMap(project => project.tasks).filter(task => task.auto?.session === turn.id && task.auto.agent === turn.agent).flatMap(task => task.steps).filter(step => questionWords(step.text) === words || questionWords(step.text).endsWith(` — ${words}`))
      if (steps.length > 0 && !steps.some(step => step.status === 'waiting')) await discard(key)
    }
    pending = pending.filter(([key]) => pendingInboxQuestions.has(key))
    // A record created here is settled by the next pollAnsweredQuestions pass, which carries the
    // remembered answers.
    if (pending.length > 0 && !(await pollQuestions($, path, projects, false, pending.map(([, turn]) => turn)))) {
      await pendingQuestionsProblem($, true)
      return
    }
    for (const [key] of pending) await discard(key)
    await pendingQuestionsProblem($, hasCleanupProblem || hasRestoreProblem || unkept.size > 0)
  })
}

const retainInboxQuestions = async ($: EngineInterface, captured: readonly PendingTurn[] = [], isRestoring = false): Promise<void> => {
  if (captured.length === 0 && (pendingQuestionRetry !== null || !isRestoring && hasRestoredInboxQuestions && pendingInboxQuestions.size === 0 && droppingInboxQuestions.size === 0)) return
  const job = keepInboxQuestions($, captured, isRestoring)
  if (captured.length > 0) return job
  pendingQuestionRetry = job
  try {
    await job
  } finally {
    pendingQuestionRetry = null
  }
}

const drainInbox = async ($: EngineInterface): Promise<void> => {
  if (isDraining) return
  isDraining = true
  const taken: Taken[] = []
  let isWin = false
  let at = 0
  try {
    const path = await progressPath($)
    const dir = inboxPath(path)
    isWin = await isWindows($, path)
    const sep = sepOf(dir)
    const stored = await $.store.get('inboxDone')
    if (stored !== undefined && stored !== null && (typeof stored !== 'object' || Array.isArray(stored) || Object.values(stored).some(stamp => typeof stamp !== 'string'))) throw new Error('INVALID_INBOX_RECORD')
    const hasRecord = stored !== null && typeof stored === 'object'
    // A store with no record of the inbox (the first run, or the store of the plugin's
    // earlier name left behind) counts what is there now as read, so an upgrade does not
    // sum up two days of turns again.
    if (!hasRecord && !hasInboxRecord) {
      const names = (await $.fs.list(dir).catch(() => []))
        .filter(entry => entry.kind === 'file' && isInboxFile(entry.name))
        .map(entry => entry.name)
      const now = await $.clock.now()
      const stamp = `${(await read($, mine))?.sessionId.slice(0, 8) ?? '-'}:${now}`
      await $.store.set('inboxDone', keepInboxDone(Object.fromEntries(names.map(name => [name, stamp])), now))
      hasInboxRecord = true
      return
    }
    hasInboxRecord = true
    // A file landing in the folder moves its modified time; nothing to read until it does.
    // On a file system that keeps whole seconds, a file can land in the same second as the
    // last listing: the folder is listed again while its time is that fresh.
    const stat = await $.fs.stat(dir).catch(() => undefined)
    if (stat === undefined) return
    // A file left taken changes nothing in the folder, so it is listed once a minute anyway.
    const now = await $.clock.now()
    if (stat.mtimeMs === inboxSeen && now - stat.mtimeMs > 2000 && now - inboxListed < 60 * 1000) return
    inboxSeen = stat.mtimeMs
    inboxListed = now
    const entries = await $.fs.list(dir).catch(() => [])
    const done = hasRecord ? (stored as Record<string, string>) : {}
    at = await $.clock.now()
    const session = (await read($, mine))?.sessionId.slice(0, 8) ?? '-'
    // Files left taken. One whose turn reached the board, and only its delete failed, goes
    // now; one whose session closed half-way, or whose turn failed, is taken again once its
    // time is up, or set aside after its last try.
    const delivered: string[] = []
    for (const entry of entries) {
      const claim = entry.kind === 'file' ? readClaim(entry.name) : null
      if (claim === null || taken.length >= 20) continue
      const from = `${dir}${sep}${entry.name}`
      if (done[claim.name] !== undefined) {
        delivered.push(from)
        continue
      }
      const action = claimAction(claim, entry.mtimeMs, at)
      if (action === 'setAside') {
        try {
          const notes = await readInboxRecord($, 'inboxFailed')
          await recordInbox($, [], { [claim.name]: notes[claim.name] ?? `${claim.attempt}:${at}:MAX_TRIES` }, at)
          await quarantineInbox($, from, `${dir}${sep}${failedName(claim.name)}`, 'MAX_TRIES', isWin)
        } catch (error) {
          await inboxNotice($, await $.fs.exists(from) ? from : `${dir}${sep}${failedName(claim.name)}`, inboxFailure(error))
        }
      }
      if (action !== 'retake') continue
      const to = `${dir}${sep}${takenName(claim.name, session, at, claim.attempt + 1)}`
      if (await moveFile($, from, to, isWin)) taken.push({ path: to, name: claim.name, attempt: claim.attempt + 1, turn: undefined })
    }
    await removeFiles($, delivered, isWin)
    const fresh = entries
      .filter(entry => entry.kind === 'file' && isInboxFile(entry.name) && done[entry.name] === undefined)
      .map(entry => entry.name)
      .sort(inboxOrder)
      .slice(0, Math.max(0, 20 - taken.length))
    for (const name of fresh) {
      const to = `${dir}${sep}${takenName(name, session, at)}`
      if (await moveFile($, `${dir}${sep}${name}`, to, isWin)) taken.push({ path: to, name, attempt: 1, turn: undefined })
    }
    // Read at once, before the model may keep the turn waiting. A file that cannot be read
    // now stays taken for a later look; malformed JSON or a missing session is
    // retained for inspection, and must not stop later valid inputs in the loop.
    for (const one of taken) {
      const body = await $.fs.read(one.path).catch(async error => {
        one.error = inboxFailure(error)
        await inboxNotice($, one.path, one.error)
        return undefined
      })
      if (typeof body !== 'string') continue
      one.body = body
      try {
        one.turn = readTurn(one.name, body)
      } catch {
        one.turn = null
      }
    }
  } catch (error) {
    await inboxNotice($, inboxPath(await progressPath($)), inboxFailure(error))
    throw error
  } finally {
    isDraining = false
  }
  if (taken.length === 0) return
  // Prompt intake bypasses the digest promise, which may be waiting on a model.
  const prompts = taken.filter(one => one.turn?.event === 'prompt')
  if (prompts.length > 0) {
    const settled: Taken[] = []
    const failed: Record<string, string> = {}
    for (const one of prompts.sort((a, b) => inboxOrder(a.name, b.name))) {
      if (one.turn === null || one.turn === undefined || !(await $.fs.exists(one.path))) continue
      try { await takeAgentPrompt($, one.turn); settled.push(one) } catch (error) {
        const reason = inboxFailure(error)
        failed[one.name] = `${one.attempt}:${at}:${reason}`
        await inboxNotice($, one.path, reason)
      }
    }
    await recordInbox($, settled.map(one => one.name), failed, at)
    await removeFiles($, settled.map(one => one.path), isWin)
  }
  const regular = taken.filter(one => one.turn?.event !== 'prompt')
  if (regular.length === 0) return
  const job = digests.then(async () => {
    const invalid = regular.filter(one => one.turn === null)
    const settled = regular.filter(one => one.turn !== null && one.turn !== undefined && isBoardTurn(one.turn))
    const failed: Record<string, string> = Object.fromEntries([
      ...invalid.map(one => [one.name, `${one.attempt}:${at}:INVALID_INPUT`]),
      ...regular.filter(one => one.error !== undefined).map(one => [one.name, `${one.attempt}:${at}:${one.error}`]),
    ])
    const bySession = new Map<string, Taken[]>()
    for (const one of [...regular].sort((a, b) => inboxOrder(a.name, b.name))) {
      if (one.turn === null || one.turn === undefined || isBoardTurn(one.turn)) continue
      bySession.set(one.turn.id, [...(bySession.get(one.turn.id) ?? []), one])
    }
    for (const all of bySession.values()) {
      // The queue can run longer than a claim holds: a file another look took again while
      // this job waited is that look's to finish.
      const group: Taken[] = []
      for (const one of all) if (await $.fs.exists(one.path)) group.push(one)
      if (group.length === 0) continue
      const isLastTry = group.some(one => one.attempt >= MAX_TRIES)
      try {
        const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/[\\/]+$/, '')
        await takeAgentTurns($, group.flatMap(one => (one.turn === null || one.turn === undefined ? [] : [one.turn])), 0, isLastTry)
        const questions = peekInbox(group.flatMap(one => one.body === undefined ? [] : [{ name: one.name, body: one.body, at }]), () => '', text => redact(text, home, isWin)).filter(turn => turn.isQuestion)
        if (questions.length > 0) {
          await retainInboxQuestions($, questions)
          // A question and its answer can arrive in one look: the answer was remembered before
          // the question was kept, so it settles now instead of at the next poll.
          const asked = new Set(questions.map(one => JSON.stringify([one.agent, one.id])))
          if ([...answeredPending.keys()].some(key => asked.has(key))) await pollAnsweredQuestions($, await progressPath($), undefined)
        }
        settled.push(...group)
      } catch (error) {
        const why = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200)
        for (const one of group) failed[one.name] = `${one.attempt}:${at}:${why}`
        // A file error is named now. The model's silence, or a block not yet read back, is
        // tried again quietly, as before; the last try sets the file aside, which is named.
        const reason = inboxFailure(error)
        if (reason !== 'INBOX_FAILED') await inboxNotice($, group[0]!.path, reason)
      }
    }
    await recordInbox($, settled.map(one => one.name), failed, at)
    for (const one of invalid) {
      const to = one.path.replace(/[^\\/]+$/, () => failedName(one.name))
      await quarantineInbox($, one.path, to, 'INVALID_INPUT', isWin).catch(async error => inboxNotice($, await $.fs.exists(one.path) ? one.path : to, inboxFailure(error)))
    }
    await removeFiles($, settled.map(one => one.path), isWin)
  }).catch(async error => {
    await inboxNotice($, taken[0]!.path, inboxFailure(error))
    throw error
  })
  digests = job.catch(() => undefined)
  await job
}

// The store's record after a look: the files done, so a delete that failed is tried again
// rather than the turn, and why each file still in the inbox is there.
const recordInbox = async ($: EngineInterface, settled: readonly string[], failed: Readonly<Record<string, string>>, at: number): Promise<void> => {
  if (settled.length === 0 && Object.keys(failed).length === 0) return
  await enqueue(async () => {
    const stamp = `${(await read($, mine))?.sessionId.slice(0, 8) ?? '-'}:${at}`
    // Read both maps before replacing either. A read error must not become an
    // empty map, and cleanup must wait for the required records to read back.
    const before = await readInboxRecord($, 'inboxDone')
    const held = await readInboxRecord($, 'inboxFailed')
    const notes = Object.entries(held).filter(([name]) => !settled.includes(name))
    await writeInboxRecord($, 'inboxFailed', keepInboxFailed({ ...Object.fromEntries(notes), ...failed }))
    await writeInboxRecord($, 'inboxDone', keepInboxDone({ ...before, ...Object.fromEntries(settled.map(name => [name, stamp])) }, at))
  })
}

const readInboxRecord = async ($: EngineInterface, key: string): Promise<Record<string, string>> => {
  const value = await $.store.get(key)
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(stamp => typeof stamp !== 'string')) throw new Error('INVALID_INBOX_RECORD')
  return { ...value } as Record<string, string>
}

const writeInboxRecord = async ($: EngineInterface, key: string, value: Record<string, string>): Promise<void> => {
  await $.store.set(key, value)
  const check = await readInboxRecord($, key)
  if (Object.keys(check).length !== Object.keys(value).length || Object.entries(value).some(([name, stamp]) => check[name] !== stamp)) throw new Error('INBOX_STORE_NOT_VERIFIED')
}

// A compaction's summary made into one line for whoever takes over, kept in the block.
const writeHandoff = async ($: EngineInterface, summary: string): Promise<void> => {
  const mirror = await read($, mine)
  if (mirror === null || mirror.tasks.length === 0 || summary.trim() === '') return
  const s = await wordsOf($)
  const asked = await complete($, {
    model: 'haiku',
    maxTokens: 160,
    effort: 'low',
    prompt: s.handoffPrompt(mirror.title || fallbackTitle(mirror), summary.slice(0, 6000)),
  })
  const line = asked?.isAnswered === true ? cleanHandoff(asked.text) : ''
  if (line === '') return
  await saveMine($, one => ({ ...one, handoff: line }), true)
  await queueWrite($)
}

// Old work moves to that month's archive file, so the file stays about what is open: done
// blocks after half a day, stopped ones after three, hand-kept tasks a day after the pane saw
// their last step ticked.
// `isNow`: the person asked (`/progress tidy`, the archive button), so finished work goes now.
const archiveOld = async ($: EngineInterface, isNow = false): Promise<number> => {
  const path = await progressPath($)
  const mirror = await read($, mine)
  const keep = mirror === null ? undefined : shortId(mirror.sessionId)
  const at = await $.clock.now()
  const s = await wordsOf($)
  const seen = await read($, doneSeen)
  const archived = new Set<string>()
  const keys = new Set<string>()
  await rewrite($, path, async text => {
    const blocks = takeArchivable(text, at, keep, s, isNow)
    const manual = takeManualDone(blocks.text, at, key => seen[key], s, isNow)
    const entries = [...blocks.entries, ...manual.entries]
    if (entries.length === 0) return null
    // Made again after another session's write, the same blocks are not archived twice.
    await appendArchive($, archivePath(path, at), entries.filter(entry => !archived.has(entry)), s)
    for (const entry of entries) archived.add(entry)
    for (const key of manual.keys) keys.add(key)
    return manual.text
  })
  if (keys.size > 0) {
    await update($, doneSeen, old => Object.fromEntries(Object.entries(old).filter(([key]) => !keys.has(key))))
    for (const key of keys) await $.store.delete(key)
  }
  await poll($)

  return archived.size
}

// Entries added at the end of a month's archive file, after what it holds.
const appendArchive = async ($: EngineInterface, archive: string, entries: readonly string[], s: Strings): Promise<void> => {
  if (entries.length === 0) return
  const past = await readText($, archive)
  const head = past.trim() === '' ? `${s.archiveTitle}\n\n` : past.replace(/\s*$/, '\n\n')
  await $.fs.write(archive, head + entries.join('\n\n') + '\n')
}

// One task to the archive at the person's word, written the way archiveOld writes. False when
// it could not be found for sure, so the file is left as it was.
const archiveOne = async ($: EngineInterface, ref: TaskRef): Promise<boolean> => {
  const path = await progressPath($)
  const at = await $.clock.now()
  const s = await wordsOf($)
  const archived = new Set<string>()
  const wrote = await rewrite($, path, async text => {
    const projects = parseProgress(text)
    const hasQuestions = projects.some(project => project.name === ref.project && project.tasks.some(task => (ref.session === null ? task.title === ref.title : task.auto?.session === ref.session) && task.steps.some(step => step.status === 'waiting')))
    if (hasQuestions && (!(await pollQuestions($, path, projects, true)) || !archiveQuestionsKept(projects, ref, await read($, questionLedger)))) throw new Error('QUESTION_RETENTION_FAILED')
    if (hasQuestions) for (const record of (await read($, questionLedger)).records) {
      if (record.isUnresolved && record.source?.project === ref.project && record.source.task === ref.title) await keepQuestionCapture($, path, record, 'archived')
    }
    const taken = takeTask(text, ref, at, s)
    if (taken === null) return null
    await appendArchive($, archivePath(path, at), taken.entries.filter(entry => !archived.has(entry)), s)
    for (const entry of taken.entries) archived.add(entry)
    return taken.text
  })
  if (wrote === null) return false
  if (ref.session === null) {
    const key = doneKey(ref.project, ref.title)
    await update($, doneSeen, old => Object.fromEntries(Object.entries(old).filter(([one]) => one !== key)))
    await $.store.delete(key)
  }
  await poll($)

  return true
}

const confirmOne = async ($: EngineInterface, ref: ConfirmRef): Promise<(ConfirmedTask & { isMirrorSaved: boolean }) | null> => {
  const path = await progressPath($)
  const at = await $.clock.now()
  const s = await wordsOf($)
  const original = await readText($, path)
  const candidate = confirmTask(original, ref, at, s)
  if (candidate === null) return null
  const selected = confirmedTarget(original, ref, s)
  const mirrors = new Map<string, { stored: ProgressMirror | undefined; seen: string }>()
  if (candidate.auto !== null) {
    const keys = [`agent:${candidate.auto.session}`, ...(candidate.auto.agent === 'claude' ? [`mirror:${candidate.auto.resume ?? candidate.auto.session}`] : [])]
    for (const key of keys) {
      const stored = await $.store.get(key) as ProgressMirror | undefined
      const effective = key.startsWith('agent:') ? (await agentProjection($, key.slice(6), stored)).mirror : (await completedMirror($, key, stored)).mirror
      if (effective !== undefined && (effective.updated > candidate.auto.updated || selected === null || !mirrorMatchesTask(effective, ref.project, selected, s))) return null
      mirrors.set(key, { stored, seen: JSON.stringify(stored ?? null) })
    }
  }
  let confirmed: ConfirmedTask | null = null
  await rewrite($, path, text => {
    if (confirmed !== null && confirmMatches(text, confirmed.ref, s)) return text
    const next = confirmTask(text, ref, at, s)
    if (next === null) return null
    confirmed = next
    return next.text
  })
  const found = confirmed as ConfirmedTask | null
  if (found === null || !confirmMatches(await readText($, path), found.ref, s)) return null
  const block = confirmedTarget(found.text, found.ref, s)
  let isMirrorSaved = true
  try {
    for (const [key, { stored, seen }] of mirrors) {
      // Another session may have accepted fresh work while this file write was pending.
      // Its newer mirror must never be marked complete by an older selected row.
      if (JSON.stringify((await $.store.get(key)) ?? null) !== seen) { isMirrorSaved = false; continue }
      const overlay = stored !== undefined && Array.isArray(stored.tasks) ? completionOverlay(key, stored, at) : block === null ? null : completionOfBlock(key, found.ref.project, block, ref.expected, at)
      if (overlay !== null) {
        const overlayKey = completionKey(overlay)
        await $.store.set(overlayKey, overlay)
        if (JSON.stringify((await $.store.get(overlayKey)) ?? null) !== JSON.stringify(overlay) || JSON.stringify((await $.store.get(key)) ?? null) !== seen) isMirrorSaved = false
      } else isMirrorSaved = false
    }
  } catch {
    isMirrorSaved = false
  }
  await poll($)
  return { ...found, isMirrorSaved }
}

// Tells the person, once across every open session, of a question another session or agent
// put to them and of work due today or late. Questions already on file when a session starts
// count as told (the pane opening shows them), and the first run ever says nothing at all, so
// installing does not replay the whole file.
const remind = async ($: EngineInterface): Promise<void> => {
  if (isReminding) return
  isReminding = true
  try {
    await remindNow($)
  } finally {
    isReminding = false
  }
}

const remindNow = async ($: EngineInterface): Promise<void> => {
  const at = await $.clock.now()
  const s = await wordsOf($)
  const view = buildView(
    (await read($, snapshot)).projects,
    await read($, here),
    await read($, mine),
    at,
    await read($, today),
    await read($, doneSeen),
    s,
    await read($, hiddenAsks),
    await read($, firstSeen),
    await read($, questionLedger),
    await questionProofsFor($, await progressPath($)),
    await pendingTurns($),
  )
  const stored = await $.store.get('told')
  const told = stored !== null && typeof stored === 'object' ? (stored as Record<string, number>) : {}
  const fresh = remindersOf(view, told, at, localDay(at), s)
  const isSeeding = !isReminderSeeded
  isReminderSeeded = true
  if (fresh.length === 0) return
  const next = keepRecent(told, at)
  for (const one of fresh) next[one.key] = at
  await $.store.set('told', next)
  if (isSeeding && Object.keys(told).length === 0) return
  for (const one of fresh) {
    if (isSeeding && one.kind === 'ask') continue
    await notify($, one.text, one.project)
  }
}

// For a session's first turn: work in this project that other sessions left or hold.
const othersNote = async ($: EngineInterface): Promise<string | null> => {
  const names = await read($, here)
  const mirror = await read($, mine)
  const own = mirror === null ? '' : shortId(mirror.sessionId)
  const at = await $.clock.now()
  const s = await wordsOf($)
  const lines: string[] = []
  for (const project of (await read($, snapshot)).projects) {
    if (!isHereProject(project.name, names)) continue
    for (const task of project.tasks) {
      const auto = task.auto
      if (auto === null || auto.session === own || auto.state === 'done' || isTaskComplete(task)) continue
      if (at - auto.updated > 7 * DAY) continue
      const { done, total } = countSteps(task)
      const open = task.steps.find(step => step.status !== 'done' && step.status !== 'cancelled')
      // Another agent wrote these words: they reach Claude as quoted data, never as a line of
      // their own that reads like an instruction.
      const title = asData(task.title)
      lines.push(auto.state === 'ended' ? s.othersEnded(title, open === undefined ? s.none : asData(open.text), done, total) : s.othersHeld(title, done, total))
    }
  }
  if (lines.length === 0) return null

  return [s.othersHead, ...dataBlock(lines, s), s.othersTail].join('\n')
}

// Keeps the store to the last month of sessions.
const pruneStore = async ($: EngineInterface, at: number): Promise<void> => {
  for (const key of await $.store.keys()) {
    // Journal retries remove verified keys; failed lines and quarantined values stay.
    if (key.startsWith('pendingJournal:') || key.startsWith('pendingJournalBad:')) continue
    if (key.startsWith('pendingInboxQuestion:')) {
      const value = await $.store.get(key) as { at?: number } | null | undefined
      if (typeof value?.at !== 'number' || at - value.at > 3 * DAY) await $.store.delete(key)
      continue
    }
    if (isStaleStoreKey(key, await $.store.get(key), at, 30 * DAY)) await $.store.delete(key)
  }
}

// The row's words were written by another session or agent: they go to Claude fenced as data.
const takeOverPrompt = (row: TaskRow, s: Strings): string =>
  [
    s.takeOverHead(asData(row.title), asData(row.project), row.done, row.total),
    ...dataBlock(
      [
        row.context === '' ? '' : s.resumeContext(asData(row.context)),
        row.handoff === '' ? '' : s.takeOverHandoff(asData(row.handoff, 200)),
        row.left.length === 0 ? '' : s.takeOverLeft(row.left.map(step => asData(step)).join(s.stepSep)),
      ].filter(line => line !== ''),
      s,
    ),
    s.takeOverTail,
  ].join('\n')

const handOverPrompt = (row: TaskRow, s: Strings): string =>
  [
    s.handOverHead(asData(row.title), asData(row.project)),
    row.context === '' ? '' : s.handOverContext(asData(row.context)),
    row.next === null ? '' : s.handOverNext(asData(row.next.step)),
    s.handOverTail,
  ]
    .filter(line => line !== '')
    .join(' ')

// A press on 完成: the step is ticked in the file, by the person's own hand, and journaled
// like a step Claude finished.
const tickStep = async ($: EngineInterface, ref: StepRef): Promise<boolean> => {
  const wrote = await rewrite($, await progressPath($), before => setManualStep(before, ref, 'x'))
  await poll($)

  return wrote !== null
}

// A side question: answered over this session's transcript, without a turn of its own.
const askAside = async ($: EngineInterface, question: string): Promise<void> => {
  const text = question.trim()
  if (text === '') return
  askSeq += 1
  const seq = askSeq
  await update($, answer, () => ({ question: text, text: '', isAsking: true }))
  const s = await wordsOf($)
  const forked = await $.model.fork({ prompt: `${text}\n\n${s.asideSuffix}` }).catch(() => undefined)
  const reply =
    forked?.isAnswered === true ? forked.text.trim() : forked?.reason === 'nothing-to-fork' ? s.asideNotStarted : s.asideFailed
  // A slower answer to an earlier question is dropped rather than shown under a newer one.
  if (seq !== askSeq) return
  await update($, answer, () => ({ question: text, text: reply, isAsking: false }))
}

// A line from the pane's box that starts with +: a hand-kept task, written under its
// project. Without a `專案：` the session's repo is the project, or 待辦 outside one.
const quickAdd = async ($: EngineInterface, input: string): Promise<string> => {
  const s = await wordsOf($)
  const repo = await $.session.repo().catch(() => null)
  const fallback = repo === null ? s.defaultProject : ((await read($, mine))?.project ?? s.defaultProject)
  const entry = parseQuickAdd(input, fallback, s)
  if (entry === null) return s.quickEmpty
  const wrote = await enqueue(async () => {
    // Made again over another session's write, the task is added once: a retry finds the
    // heading already there one more time than at the first read.
    let count: number | null = null
    await rewrite($, await progressPath($), before => {
      const found = manualTaskCount(before, entry)
      if (count === null) count = found
      return found > count ? null : addManualTask(before, entry, s)
    })
    await poll($)
  })
    .then(() => true)
    .catch(() => false)

  return wrote ? quickAddWords(entry, s) : s.quickUnreadable
}

// What finished in the last `days` days (from the journal), what is open and what waits.
const buildReport = async ($: EngineInterface, days: number): Promise<string> => {
  const at = await $.clock.now()
  const path = await progressPath($)
  const months = [...new Set([journalPath(path, previousMonth(at)), journalPath(path, at)])]
  const texts = await Promise.all(months.map(one => readText($, one).catch(() => '')))

  return progressReport(texts.flatMap(parseJournal), (await read($, snapshot)).projects, await read($, mine), at, days, await wordsOf($))
}

// Shows `text` under the pane's box, copied to the clipboard when the surface allows.
const showCopied = async ($: EngineInterface, question: string, text: string, surface?: RenderSurface): Promise<void> => {
  const copied = await $.ui
    .copy(surface === undefined ? { text } : { text, surface })
    .then(result => result.isCopied)
    .catch(() => false)
  await update($, answer, () => ({ question, text, isAsking: false, copied }))
}

// The language from the four places it can come from (strings.ts resolveLang).
const settleLang = async ($: EngineInterface, options: PluginOptions): Promise<void> => {
  const settings = (await $.settings.read().catch(() => ({}))) as { language?: unknown }
  const stored = await $.store.get('lang')
  const chosen = resolveLang(options.language, stored, settings.language, await $.env.get('LANG'))
  await update($, lang, () => chosen)
}

const setNotify = async ($: EngineInterface, isOn: boolean): Promise<void> => {
  await update($, isNotifyOn, () => isOn)
  if (isOn) await $.store.delete('notifyOff')
  else await $.store.set('notifyOff', true)
}

const settle = async ($: EngineInterface, isWriteBlocking = true): Promise<void> => {
  const at = await $.clock.now()
  await saveMine($, mirror => ({ ...mirror, state: stateOf(mirror, isTurnRunning), isTurnRunning, updated: at }))
  const writing = queueWrite($)
  if (isWriteBlocking) await writing
}

// A prompt of this plugin's own, run as a turn once the session is idle. It is not the
// person's message, even when another plugin's hook took theirs without passing it on, and
// it skips this plugin's own prompt.submit hook.
const submitOwn = ($: EngineInterface, text: string): Promise<PromptSubmitResult> => {
  isNextTurnAnswer = false
  nextTurnNotification = false

  return $.prompt.submit({ text })
}

// The person wrote in this session: with a Task list, every step Claude asked them is answered.
const answerHere = async ($: EngineInterface): Promise<void> => {
  const mirror = await read($, mine)
  if (mirror === null || !isAskingYou(mirror)) return
  await saveMine($, markAnswered, true)
  await settle($)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    pendingCache = null
    knownPath = await findProgressPath($)
    await settleLang($, options)
    const words = await wordsOf($)
    await $.command.register({ name: 'progress', description: words.commandDescription, argumentHint: words.commandHint })
    await detectHere($)
    await loadMine($, e.cwd)
    await update($, isNotifyOn, () => true)
    if ((await $.store.get('notifyOff')) === true) await update($, isNotifyOn, () => false)
    await readTheme($)
    const journalKeys = new Set([...(await $.store.keys().catch(() => [])), ...pendingJournals.keys()])
    for (const key of journalKeys) {
      if (key.startsWith('pendingJournal:')) await journal($, [], key)
    }
    await countToday($)
    const storedOpen = await $.store.get('opened')
    await update($, opened, () => (Array.isArray(storedOpen) ? storedOpen.filter((one): one is string => typeof one === 'string') : []))
    const seen: Record<string, number> = {}
    for (const key of await $.store.keys()) {
      if (!key.startsWith('done:')) continue
      const value = await $.store.get(key)
      if (typeof value === 'number') seen[key] = value
    }
    await update($, doneSeen, () => seen)
    const tools = await $.tool.list().catch(() => [])
    const hasTools = tools.length === 0 || tools.some(tool => tool.name === 'TaskCreate' || tool.name === 'TodoWrite')
    await update($, hasTaskTools, () => hasTools)
    await poll($)
    await retainInboxQuestions($, [], true).catch(async () => pendingQuestionsProblem($, true)).catch(() => undefined)
    const startedAt = await $.clock.now()
    await update($, now, () => startedAt)
    await pruneStore($, startedAt).catch(() => undefined)
    // Work left running past a dispatch can outlive the module (a reload, the end): its
    // rejections are dropped rather than left unhandled.
    $.clock.every(POLL_MS, () => {
      poll($).catch(() => undefined).then(() => retainInboxQuestions($)).catch(async () => pendingQuestionsProblem($, true)).catch(() => undefined)
    })
    $.clock.every(INBOX_MS, () => {
      drainInbox($).catch(() => undefined)
    })
    $.clock.every(TICK_MS, () => {
      $.clock
        .now()
        .then(async at => {
          await update($, now, () => at)
          // A new day starts the count over.
          if (localDay(at) !== countedDay) await countToday($)
          await refreshStatus($)
          await writeDashboard($)
          // A date turns due at midnight with nothing in the file changing.
          await remind($)
        })
        .catch(() => undefined)
    })
    // Checks still running are looked at again until they finish.
    $.clock.every(PR_MS, () => {
      read($, mine)
        .then(mirror => (mirror?.pr?.ci === 'pending' ? refreshPr($) : undefined))
        .catch(() => undefined)
    })
    $.clock.after(1, () => {
      refreshPr($).catch(() => undefined)
    })
    enqueue(() => archiveOld($)).catch(() => undefined)
    // A session left open for days still clears out old work.
    $.clock.every(ARCHIVE_MS, () => {
      enqueue(() => archiveOld($)).catch(() => undefined)
    })
    if ((await $.store.get('closedByPerson')) !== true) {
      $.ui
        .open({ id: PANE, title: words.paneTitle })
        .then(opened => {
          isPaneOpen = opened.isPlaced
          return refreshStatus($)
        })
        .catch(() => undefined)
    } else {
      await refreshStatus($)
    }

    startAutoConnect($, options)
    return next(e)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    const arg = e.args.trim()
    const language = /^(?:lang|language|語言|语言)\s*(\S*)$/i.exec(arg)
    if (language !== null) {
      const wanted = language[1] ?? ''
      if (wanted.toLowerCase() === 'auto') await $.store.delete('lang')
      else if (langOf(wanted) !== null) await $.store.set('lang', langOf(wanted))
      else return { text: (await wordsOf($)).langUnknown }
      await settleLang($, options)
      $.ui.invalidate('ui.render')
      await refreshStatus($)
      // The board script and the board commands take the language just settled, `auto`
      // included, at once and at every later connect, so a session in another language, or a
      // `/progress connect` run by hand with autoConnect off, leaves them so.
      try {
        await connectAgents($, 'language', options, { boardLang: (await wordsOf($)).lang })
        await autoConnect($, options)
      } catch (error) { return { text: (await wordsOf($)).connectWorkerFailed(workerProblem(error)) } }

      return { text: (await wordsOf($)).langSet }
    }
    const s = await wordsOf($)
    if (/^(整理|archive|tidy)$/i.test(arg)) {
      const moved = await enqueue(() => archiveOld($, true)).catch(() => null)
      if (moved === null) return { text: s.tidyUnreadable }

      return { text: moved === 0 ? s.tidyNothing : s.tidyMoved(moved) }
    }
    if (/^(open|window|html|視窗|窗口|網頁|网页)$/i.test(arg)) {
      const path = dashboardPath((await read($, snapshot)).path || (await progressPath($)))
      return { text: (await openDashboard($)) ? s.windowOpened(path) : s.windowFailed(path) }
    }
    if (/^(同步|sync)$/i.test(arg)) {
      await resync($)
      await settle($)
      await refreshPr($)

      return { text: s.synced }
    }
    const connect = /^(?:connect|接上|连接|連接)\s*(remove|off|拿掉|去掉|移除|status|狀態|状态)?$/i.exec(arg)
    // What the last connect found, agent by agent; it writes nothing.
    if (connect !== null) {
      try {
        const mode = /^(status|狀態|状态)$/i.test(connect[1] ?? '') ? 'status' : connect[1] !== undefined ? 'remove' : 'connect'
        const reply = await connectAgents($, mode, options)
        if (mode === 'status') {
          const text = reply.state.setup === undefined ? reply.state.disabled ? s.setupRemoved : s.setupNoState : setupLines(reply.state.setup, s).join('\n')
          return { text: await read($, hasPendingQuestionsProblem) ? `${text}\n${s.inboxQuestionNotKept}` : text }
        }
        return { text: reply.result?.text ?? s.setupNoState }
      } catch (error) { return { text: s.connectWorkerFailed(workerProblem(error)) } }
    }
    const add = /^(?:加|新增|add|[+＋])\s*(.*)$/is.exec(arg)
    if (add !== null) return { text: await quickAdd($, add[1] ?? '') }
    if (/^(週報|周报|今天|report|weekly|today)$/i.test(arg)) {
      const text = await buildReport($, /^(今天|today)$/i.test(arg) ? 1 : 7)
      const copied = await $.ui
        .copy({ text })
        .then(result => result.isCopied)
        .catch(() => false)

      return { text: copied ? `${text}\n\n${s.copiedSuffix}` : text }
    }
    const toggle = /^(?:通知|notify|notifications)\s*(開|關|开|关|on|off)?$/i.exec(arg)
    if (toggle !== null) {
      const word = toggle[1]?.toLowerCase()
      const isOn = word === undefined ? !(await read($, isNotifyOn)) : word === '開' || word === '开' || word === 'on'
      await setNotify($, isOn)

      return { text: isOn ? s.notifyOn : s.notifyOff }
    }
    await poll($)
    await $.store.delete('closedByPerson')
    const opened = await $.ui.open({ id: PANE, title: s.paneTitle, focus: true })
    isPaneOpen = opened.isPlaced
    await refreshStatus($)
    const { path } = await read($, snapshot)

    return { text: opened.isPlaced ? s.paneOpened(path) : s.paneNotOpened(opened.reason) }
  })

  // Who wrote a prompt is known here, not at turn.start: only the person's own message answers
  // what waits on them. A pane button's answer is marked when it is pressed.
  on('prompt.submit', async ($, e, next) => {
    const isAnswer = isPersonsAnswer(e)
    if (e.turnId === undefined) {
      isNextTurnAnswer = isAnswer
      nextTurnNotification = e.origin.kind === 'task-notification'
    }
    const entered = await next(e)
    // Dropped: no turn starts, so the next one must not take this prompt's answer.
    if (entered.drop !== undefined) {
      isNextTurnAnswer = false
      nextTurnNotification = undefined
    }
    // Typed over a running turn, or queued behind it: it answers what waited on the person
    // when they wrote it, though no turn of its own starts now.
    else if (e.turnId !== undefined && isAnswer) await answerHere($)
    else if (e.turnId !== undefined && e.origin.kind === 'task-notification')
      await saveBackground($, one => finishBackgroundJob(one, e.text, true, isTurnRunning))

    return entered
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    journal($).catch(() => undefined)
    isTurnRunning = true
    hasTurnBackgroundLaunch = false
    turnBackgroundJobIds = new Set()
    turnBackgroundLaunchesWithoutId = 0
    turnPrompt = e.text.trim()
    const isAnswer = isNextTurnAnswer && e.text.trim() !== ''
    isNextTurnAnswer = false
    const isNotification = nextTurnNotification
    nextTurnNotification = undefined
    const hasPendingBackgroundSave = pendingBackgroundSaves > 0
    if (hasBackgroundActivity) await backgroundChanges
    let mirror = await read($, mine)
    if (mirror?.state === 'ended') {
      await saveMine($, one => ({ ...one, state: 'working' }))
      mirror = await read($, mine)
    }
    // A turn can still read its initial mirror after waiting for a queued launch.
    if (mirror !== null && isNotification !== false && ((mirror.backgroundJobs ?? 0) > 0 || hasPendingBackgroundSave)) {
      await saveBackground($, one => finishBackgroundJob(one, e.text, isNotification === true))
      mirror = await read($, mine)
    }
    if (mirror !== null && mirror.firstPrompt === '' && e.text.trim() !== '') {
      await saveMine($, one => ({ ...one, firstPrompt: promptKey(e.text) }))
    }
    // The person is answering: what waited on them from the last turn's question is settled.
    // With a Task list, their own message also marks the steps Claude asked them answered,
    // until Claude asks again. So an answered review does not stay up with a "Looks good"
    // button that would say the opposite of what they wrote.
    if (mirror !== null && (mirror.autoAsk !== null || mirror.source === 'turns' || (isAnswer && isAskingYou(mirror)))) {
      await saveMine($, one => answerTurns(clearAsked(isAnswer && one.source === 'tasks' ? markAnswered(one) : one)), true)
    }
    if (mirror !== null && (mirror.tasks.length > 0 || mirror.source === 'turns')) {
      await settle($, false)
    } else if (mirror !== null && (await $.store.get(`hinted:${mirror.sessionId}`)) === undefined) {
      await $.store.set(`hinted:${mirror.sessionId}`, await $.clock.now())
      const note = await othersNote($)
      if (note !== null) {
        // The engine takes a plugin's row as a hidden (meta) user row; the file's words in it
        // sit in a fence, marked as data. The row has said `isMeta` since 0.12.0, which the
        // engine's types do not name, so it is built apart from the call.
        const message = { type: 'user' as const, isMeta: true, content: [{ type: 'text' as const, text: note }] }
        await $.session.append({ message }).catch(() => undefined)
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (hasBackgroundActivity) await backgroundChanges
    isTurnRunning = false
    const mirror = await read($, mine)
    const hasRunningTurnBackgroundJob = (mirror?.backgroundJobIds ?? []).some(id => turnBackgroundJobIds.has(id)) ||
      (turnBackgroundLaunchesWithoutId > 0 && (mirror?.backgroundJobs ?? 0) > (mirror?.backgroundJobIds?.length ?? 0))
    if ((mirror?.backgroundReleases?.length ?? 0) > 0 || (mirror?.backgroundReleaseCount ?? 0) > 0)
      await saveBackground($, one => ({ ...one, backgroundReleases: [], backgroundReleaseCount: 0 })).catch(() => undefined)
    const question = e.isAborted ? null : lastQuestion(e.answer)
    if (mirror !== null && mirror.tasks.length > 0) {
      const branch = await branchName($)
      await saveMine($, one => ({ ...one, branch }))
      // A turn that ended on a question waits on the person even if Claude did not mark it.
      if (question !== null && mirror.source === 'tasks') await saveMine($, one => markAsked(one, question, hasRunningTurnBackgroundJob))
      await settle($)
      if (!mirror.isTitleFinal) {
        $.clock.after(1, () => {
          nameTask($).catch(() => undefined)
        })
      } else if (needsRefresh(mirror)) {
        $.clock.after(1, () => {
          refreshName($).catch(() => undefined)
        })
      }
    }
    if (mirror !== null && mirror.tasks.length === 0 && mirror.source === 'turns') await settle($)
    // No Task list: a turn that changed something, or any turn once the session is tracked,
    // is summed up into steps.
    if (mirror !== null && !e.isAborted && (mirror.tasks.length === 0 || mirror.source === 'turns')) {
      const hasWork = mirror.source === 'turns' || hasTurnBackgroundLaunch || isWork(turnTools(await $.session.messages().catch(() => [])))
      if (hasWork) {
        const prompt = turnPrompt
        $.clock.after(1, () => {
          digestTurn($, prompt, e.answer, hasRunningTurnBackgroundJob).catch(() => undefined)
        })
      }
    }
    $.clock.after(1, () => {
      refreshPr($).catch(() => undefined)
    })

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.parentAgentId !== undefined || !e.background || e.isTeammate === true || e.workflow !== undefined) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    hasTurnBackgroundLaunch = true
    if (e.tool_use_id) turnBackgroundJobIds.add(e.tool_use_id)
    else turnBackgroundLaunchesWithoutId += 1
    saveBackground($, one => startBackgroundJob(one, e.tool_use_id || undefined)).catch(() => undefined)
    return ran
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || e.tool === 'Agent' || !('run_in_background' in e) || e.run_in_background !== true) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    hasTurnBackgroundLaunch = true
    if (e.tool_use_id) turnBackgroundJobIds.add(e.tool_use_id)
    else turnBackgroundLaunchesWithoutId += 1
    // turn.complete drains the queue; the tool's result need not wait for pane reads.
    saveBackground($, one => startBackgroundJob(one, e.tool_use_id || undefined)).catch(() => undefined)
    return ran
  })

  // Claude's own task calls, mirrored as they land. A call naming a task the mirror never
  // saw (installed mid-session, a reload) re-reads the whole list first.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true) return ran
    try {
      const id = ran.result.task.id
      const mirror = await read($, mine)
      const highest = Math.max(0, ...(mirror?.tasks ?? []).map(task => Number(task.id) || 0))
      if (Number(id) > highest + 1) await resync($)
      const at = await $.clock.now()
      await saveMine($, one => applyTaskCreate(one, e, id, at))
      await settle($)
      // Named now rather than at the end of the turn, so the journal and the pane carry the
      // real name from the first finished step.
      if ((await read($, mine))?.isTitleFinal === false) {
        $.clock.after(1, () => {
          nameTask($).catch(() => undefined)
        })
      }
    } catch {
      // The tool already ran; a failed mirror update must not touch its result.
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true) return ran
    try {
      const mirror = await read($, mine)
      if (mirror !== null && !mirror.tasks.some(task => task.id === e.taskId)) await resync($)
      const at = await $.clock.now()
      await saveMine($, one => applyTaskUpdate(one, e, at))
      await settle($)
    } catch {
      // The tool already ran; a failed mirror update must not touch its result.
    }

    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true) return ran
    try {
      const at = await $.clock.now()
      await saveMine($, one => applyTodoWrite(one, e.todos, at))
      await settle($)
    } catch {
      // The tool already ran; a failed mirror update must not touch its result.
    }

    return ran
  })

  // Compaction: the summarizer is told to keep the list, and the conversation it leaves
  // gets a short note of where things stand, so the next step is not lost.
  on('session.compact', async ($, e, next) => {
    const mirror = await read($, mine)
    const note = mirror === null || e.agentId !== undefined ? null : resumeNote(mirror, await wordsOf($))
    if (note === null) return next(e)
    const keep = (await wordsOf($)).compactKeep
    const out = await next({ ...e, instructions: [e.instructions, keep].filter(Boolean).join('\n') })
    if (out.skip !== undefined || e.trigger === 'precompute') return out
    // The summary leads what the compaction keeps; a line of it goes into the block.
    const summary = out.messages[0]?.text ?? ''
    $.clock.after(1, () => {
      writeHandoff($, summary).catch(() => undefined)
    })

    return { ...out, messages: [...out.messages, { role: 'user' as const, text: note, toolUses: [] }] }
  })

  on('session.end', async ($, e, next) => {
    if (hasBackgroundActivity) await backgroundChanges
    await journal($)
    const mirror = await read($, mine)
    if (mirror !== null && (mirror.tasks.length > 0 || (mirror.backgroundJobs ?? 0) > 0)) {
      const at = await $.clock.now()
      await saveCurrent($, one => {
        const cleared = clearBackgroundJobs(one)
        const state = cleared.tasks.length > 0 && cleared.tasks.every(task => task.status === 'completed') ? 'done' : 'ended'
        return { ...cleared, state, isTurnRunning: false, updated: at }
      })
      await queueWrite($)
    }

    return next(e)
  })

  // The rule rides the system prompt while the session has a Task list to follow; static
  // text after the shared sections, so the prompt cache keeps it.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const hasList = e.tools.includes('TaskCreate') || e.tools.includes('TodoWrite')
    if (!hasList || composed.sections.some(section => section.id === RULE_ID)) return composed

    const rule = RULES[langOf(await read($, lang)) ?? 'zh-TW']

    return { sections: [...composed.sections, { id: RULE_ID, text: rule, scope: 'session' as const }] }
  })

  // A theme change in /config repaints the pane in the matching set.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const set = await next(e)
    await readTheme($)

    return set
  })

  // The person closing the pane is remembered: it stops opening by itself until /progress.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set('closedByPerson', true)
    const closed = await next(e)
    if (e.id === PANE) {
      isPaneOpen = false
      await refreshStatus($)
    }

    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const at = (await read($, now)) || (await $.clock.now())
    const s = await wordsOf($)
    const palette = paletteFor(await read($, theme))
    const view = buildView(snap.projects, await read($, here), await read($, mine), at, await read($, today), await read($, doneSeen), s, await read($, hiddenAsks), await read($, firstSeen), await read($, questionLedger), await questionProofsFor($, snap.path || (await progressPath($))), await pendingTurns($))
    const ui: PaneUi = {
      Box: table.Box,
      Text: table.Text,
      Button: table.Button,
      Input: 'Input' in table ? table.Input : null,
      Link: 'Link' in table ? table.Link : null,
    }
    if (snap.error !== null) {
      const { Box, Text } = table

      return (
        <Box flexDirection="column">
          <Text color={palette.alert}>{s.fileUnreadable}</Text>
          {await read($, hasPendingQuestionsProblem) && <Text color={palette.alert}>{s.inboxQuestionNotKept}</Text>}
          {await read($, hasQuestionsProblem) && <Text color={palette.alert}>{s.questionsUnreadable(questionsPath(snap.path))}</Text>}
          <Text color={palette.muted}>{snap.error}</Text>
          <Text color={palette.muted} wrap="truncate-start">
            {snap.path}
          </Text>
        </Box>
      )
    }
    const model: PaneModel = {
      view,
      expanded: await read($, expanded),
      revising: await read($, revising),
      opened: await read($, opened),
      answer: await read($, answer),
      path: snap.path,
      width: Math.max(8, Math.min(28, e.props.bodyColumns - 4)),
      hasTaskTools: await read($, hasTaskTools),
      hasPendingQuestionsProblem: await read($, hasPendingQuestionsProblem),
      isNotifyOn: await read($, isNotifyOn),
      isLegendOpen: await read($, isLegendOpen),
      hasQuestionsProblem: await read($, hasQuestionsProblem),
      palette,
      s,
    }
    const actions: PaneActions = {
      toggle: key => {
        update($, expanded, open => (open === key ? '' : key)).catch(() => undefined)
      },
      continueHere: () => {
        submitOwn($, s.continueText).catch(() => undefined)
      },
      archive: () => {
        enqueue(() => archiveOld($, true)).catch(() => undefined)
      },
      archiveRow: row => {
        const ref = row.archive
        if (ref === null) return
        enqueue(() => archiveOne($, ref))
          .then(isTaken =>
            update($, answer, () => ({ question: row.title, text: isTaken === true ? s.archivedOne(row.title) : s.archiveGone, isAsking: false })),
          )
          .then(() => update($, expanded, open => (open === row.key ? '' : open)))
          .catch(error => update($, answer, () => ({ question: row.title, text: error instanceof Error && error.message === 'QUESTION_RETENTION_FAILED' ? s.questionRetentionFailed : s.boardWriteFailed, isAsking: false })))
      },
      confirmRow: row => {
        if (row.confirm == null) return
        enqueue(() => confirmOne($, row.confirm!))
          .then(async confirmed => {
            if (confirmed !== null) await journal($, confirmed.entries)
            await update($, answer, current => current?.text === s.journalFailed ? current : ({ question: row.title, text: confirmed === null ? s.boardLineChanged : confirmed.isMirrorSaved ? s.confirmedDone(row.title) : s.boardWriteFailed, isAsking: false }))
            if (confirmed !== null) await update($, expanded, open => open === row.key ? '' : open)
          })
          .catch(() => update($, answer, () => ({ question: row.title, text: s.boardWriteFailed, isAsking: false })))
      },
      takeOver: row => {
        submitOwn($, takeOverPrompt(row, s)).catch(() => undefined)
      },
      handOver: row => {
        submitOwn($, handOverPrompt(row, s)).catch(() => undefined)
      },
      tick: ref => {
        enqueue(() => tickStep($, ref))
          .then(ticked => (ticked ? journal($, [{ project: ref.project, task: ref.title, step: ref.step }]) : undefined))
          .catch(() => undefined)
      },
      ask: input => {
        if (!isQuickAdd(input)) {
          askAside($, input).catch(() => undefined)
          return
        }
        quickAdd($, input)
          .then(text => update($, answer, () => ({ question: input.trim(), text, isAsking: false })))
          .catch(() => undefined)
      },
      clearAnswer: () => {
        update($, answer, () => null).catch(() => undefined)
      },
      copyResume: (row, surface) => {
        if (row.resume === null) return
        showCopied($, s.resumeOf(row.title), row.resume, surface).catch(() => undefined)
      },
      report: surface => {
        buildReport($, 7)
          .then(text => showCopied($, s.report, text, surface))
          .catch(() => undefined)
      },
      toggleSection: id => {
        update($, opened, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))
          .then(async () => $.store.set('opened', await read($, opened)))
          .catch(() => undefined)
      },
      answer: (item, text) => {
        if (item.where !== 'here') return
        // A dropped or rejected submission is not resolution evidence. Keep the exact ask
        // until delivery succeeds, then recheck its producer revision and full source.
        const id = item.key.replace(/^mine::/, '')
        const send = async (): Promise<void> => {
          const before = await read($, mine)
          const task = before?.tasks.find(one => one.id === id)
          if (before === null || task === undefined || task.subject !== item.text || (task.why ?? '') !== item.note) return
          const source = JSON.stringify({ session: before.sessionId, project: before.project, title: before.title, context: before.context, task })
          const matches = (one: ProgressMirror): boolean => source === JSON.stringify({ session: one.sessionId, project: one.project, title: one.title, context: one.context, task: one.tasks.find(row => row.id === id) })
          const isSameAsk = async (one: ProgressMirror): Promise<boolean> => {
            const view = buildView([], [], one, await $.clock.now(), 0, {}, s, await read($, hiddenAsks), {}, await read($, questionLedger), await questionProofsFor($, await progressPath($)))
            return [...view.waiting, ...(view.reminder ?? []), ...(view.older ?? [])].some(ask => ask.key === item.key && ask.questionId === item.questionId && ask.text === item.text && ask.note === item.note)
          }
          if (!(await isSameAsk(before))) return
          const entered = await submitOwn($, s.answerText(item.text, text))
          if (entered.drop !== undefined) return
          const latest = await read($, mine)
          if (latest === null || !matches(latest) || !(await isSameAsk(latest))) return
          await saveMine($, one => matches(one) ? markAnswered(one, [id]) : one, true)
          await settle($)
          await update($, answer, () => ({ question: item.text, text: s.answered(text), isAsking: false }))
        }
        send().catch(() => undefined)
      },
      copyCommand: (item, surface) => {
        if (item.command === null) return
        showCopied($, s.commandOf(item.text), item.command, surface).catch(() => undefined)
      },
      copyAskedResume: (item, surface) => {
        if (item.reopen === null) return
        showCopied($, s.resumeOf(item.task), item.reopen, surface).catch(() => undefined)
      },
      hide: item => {
        setAnswered($, item, true)
          .then(isDone => (isDone ? undefined : update($, answer, () => ({ question: item.text, text: s.hideFailed, isAsking: false }))))
          .catch(() => undefined)
      },
      unhide: item => {
        setAnswered($, item, false)
          .then(isDone => (isDone ? undefined : update($, answer, () => ({ question: item.text, text: s.hideFailed, isAsking: false }))))
          .catch(() => undefined)
      },
      revise: item => {
        update($, revising, open => (open === reviseKey(item) ? '' : reviseKey(item))).catch(() => undefined)
      },
      toggleLegend: () => {
        update($, isLegendOpen, open => !open).catch(() => undefined)
      },
      toggleNotify: () => {
        read($, isNotifyOn)
          .then(isOn => setNotify($, !isOn))
          .catch(() => undefined)
      },
    }

    return drawPane(ui, model, actions)
  })
}
