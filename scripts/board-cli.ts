// The Agent Board for any terminal and any agent, without Claude Code: `node agent-board.mjs`
// prints the board once, `--watch` keeps it on screen and, on a terminal, lets you work in it
// the way the pane does (arrows, Enter, x, a, c, digits), and `--html` writes progress.html
// and opens it. `--serve` prints the board and opens the board's page in the browser, where it
// can be clicked (board-serve.ts). `--chat` prints the board as plain text short enough for a
// chat app, with no link and no secrets, for an agent that answers there. `/progress connect` writes the bundled copy of this file
// beside progress.md (scripts/build-board.ts bundles it into hooks/board-script.ts), with the
// progress file and language the Claude Code session uses set on its first line. `--keys
// "down x"` plays keys without a terminal and prints the board after them, for tests and checks.
import { spawn, spawnSync } from 'node:child_process'
import { runCodexLocal } from './codex-local'
import { legacyConnect } from './connect-transaction'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { confirmMatches, confirmTask, mergeBlock, takeArchivable, takeManualDone, takeTask, setManualStep } from '../hooks/blocks'
import type { ConfirmedTask } from '../hooks/blocks'
import { startServer } from './board-serve'
import { idleTimeout } from '../hooks/serve'
import { boardKey, boardScreen, boardText, CHAT_MAX, chatText, doneToday, emptyBoardState, peekInbox, boardItems, pinned, redact } from '../hooks/board'
import type { BoardAction, BoardState } from '../hooks/board'
import { LOG_TAIL, isInboxFile } from '../hooks/inbox'
import { dashboardHtml } from '../hooks/dashboard'
import { appendJournal, archivePath, countDay, hasArchiveEntry, journalLine, journalPath } from '../hooks/journal'
import { parseProgress } from '../hooks/parse'
import { qrModules, qrText } from '../hooks/qr'
import { langOf, STRINGS } from '../hooks/strings'
import { answeredJson, answeredPath, buildView, manualDoneSeen, parseAnswered, parseSeen, seenJson, seenPath, taskFingerprint, withAnswered, withSeen } from '../hooks/view'
import { acknowledgementKeys, archiveQuestionsKept, captureHashOf, captureJson, capturePath, emptyQuestions, parseCapture, withCaptures, isQuestionProof, isQuestionSnapshot, isTornLedger, migratedAnswered, observeQuestions, parseQuestions, questionProofJson, questionProofOf, questionProofPath, questionsJson, questionsPath } from '../hooks/questions'
import type { QuestionCapture, QuestionProofs, QuestionRecord } from '../hooks/questions'
import { sha256 } from '../hooks/sha256'

// The line `/progress connect` puts above the bundle sets it.
const BAKED = (globalThis as { AGENT_BOARD?: { path?: string; lang?: string } }).AGENT_BOARD ?? {}

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const idleMs = (): number => {
  const value = flag('--idle-minutes')
  if (args.includes('--idle-minutes') && value === undefined) throw new Error('INVALID_IDLE_MINUTES')
  return idleTimeout(value)
}

const progressFile = (): string => {
  const explicit = process.env.CLAUDE_PROGRESS_FILE
  if (explicit) return explicit
  if (BAKED.path) return BAKED.path
  const config = process.env.CLAUDE_CONFIG_DIR

  return join(config || join(homedir(), '.claude'), 'progress.md')
}

const path = progressFile()
const s = STRINGS[langOf(flag('--lang')) ?? langOf(BAKED.lang) ?? langOf(process.env.LANG) ?? 'en']

class BoardFileError extends Error {
  constructor(readonly file: string, readonly code: string) {
    super(code)
  }
}

const fileError = (file: string, error: unknown): BoardFileError =>
  new BoardFileError(file, String((error as { code?: string } | null)?.code ?? 'UNKNOWN'))

const read = (file: string): string => {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ENOENT') return ''
    throw fileError(file, error)
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
const pending = (scrub?: (text: string) => string) => {
  const dir = join(dirname(path), 'progress-inbox')
  let names: string[] = []
  try {
    names = readdirSync(dir).filter(name => isInboxFile(name))
  } catch {
    return []
  }
  const entries = names.flatMap(name => {
    try {
      const stat = statSync(join(dir, name))
      return stat.isFile() ? [{ name, at: stat.mtimeMs }] : []
    } catch {
      return []
    }
  })
    .sort((a, b) => b.at - a.at)
    .slice(0, 30)
  const files = entries.flatMap(entry => {
    try {
      return [{ ...entry, body: read(join(dir, entry.name)) }]
    } catch {
      return []
    }
  })

  return peekInbox(files, readLog, scrub)
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
const isQuestionWriter = !args.includes('--chat') && args.some(arg => ['--watch', '--serve', '--serve-child', '--keys'].includes(arg))

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
  return ran.status === 0 && !existsSync(source)
}

const quarantineQuestions = (file: string): boolean => {
  const aside = `${file}.torn-${Date.now()}-${process.pid}`
  if (!placeQuestionFile(file, aside)) return false
  if (isTornLedger(read(aside))) return true
  // A good write raced the initial read. Restore it only if no newer ledger took its place.
  placeQuestionFile(aside, file)
  return false
}

const readQuestions = (file: string, text?: string) => {
  if (text === undefined) {
    text = read(file)
    if (isQuestionWriter && isTornLedger(text)) {
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
  const parsed = parseQuestions(text, isMissing)
  const captures = readQuestionCaptures()
  return parsed === null || captures === null ? null : withCaptures(parsed, captures)
}
const readQuestionCaptures = (): QuestionCapture[] | null => {
  try {
    const captures: QuestionCapture[] = []
    for (const name of readdirSync(dirname(path))) {
      const hash = captureHashOf(path, name)
      if (hash === null) continue
      const capture = parseCapture(read(capturePath(path, hash)), hash)
      if (capture === null) return null
      captures.push(capture)
    }
    return captures
  } catch {
    return null
  }
}
const keepQuestionCapture = (record: QuestionRecord, disposition: QuestionCapture['disposition']): void => {
  const text = captureJson(record, disposition)
  const file = capturePath(path, sha256(text))
  try {
    const fd = openSync(file, 'wx', 0o600)
    try { writeFileSync(fd, text) } finally { closeSync(fd) }
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== 'EEXIST') throw fileError(file, error)
  }
  if (read(file) !== text) throw fileError(file, { code: 'EAGAIN' })
}
const readQuestionProofs = (): QuestionProofs | null => {
  try {
    if (pendingQuestionProofs.size > 0) return null
    const proofs: QuestionProofs = { retired: [], consumed: [] }
    for (const name of readdirSync(dirname(path))) {
      const proof = questionProofOf(path, name)
      if (proof === null) continue
      if (!isQuestionProof(read(questionProofPath(path, proof.kind, proof.hash)), proof.kind, proof.hash)) return null
      proofs[proof.kind].push(proof.hash)
    }
    return proofs
  } catch {
    return null
  }
}
const pendingQuestionProofs = new Map<string, { kind: keyof QuestionProofs; hash: string }>()
const keepQuestionProof = (kind: keyof QuestionProofs, hash: string): void => {
  const file = questionProofPath(path, kind, hash)
  pendingQuestionProofs.set(file, { kind, hash })
  const text = questionProofJson(kind, hash)
  try {
    const fd = openSync(file, 'wx', 0o600)
    try { writeFileSync(fd, text) } finally { closeSync(fd) }
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== 'EEXIST') throw fileError(file, error)
  }
  if (!isQuestionProof(read(file), kind, hash)) throw fileError(file, { code: 'EAGAIN' })
  pendingQuestionProofs.delete(file)
}
const view = (source = read(path), now = Date.now()) => {
  for (const proof of [...pendingQuestionProofs.values()]) keepQuestionProof(proof.kind, proof.hash)
  const projects = parseProgress(source)
  const turns = pending(text => redact(text, homeOrNone(), process.platform === 'win32'))
  let stat = ''
  try {
    const one = statSync(path)
    stat = `${one.mtimeMs}:${one.size}`
  } catch {
    // A missing file holds no task to keep or drop.
  }
  if (stat !== lastStat.stat) lastStat = { stat, at: now }
  const isSettled = stat !== '' && now - lastStat.at >= 1000 && projects.length > 0
  let seen = lastSeen
  try {
    const file = seenPath(path)
    const record = parseSeen(read(file), answeredAge(file))
    if (record !== null) {
      seen = record
      // Chat wins over every other flag and must never write a sidecar.
      if (!args.includes('--chat') && args.some(arg => ['--watch', '--serve', '--serve-child'].includes(arg))) {
        let observed = withSeen(record, projects, now)
        const wrote = rewrite(file, before => {
          const current = parseSeen(before, answeredAge(file))
          if (current === null) return null
          observed = withSeen(current, projects, now, observed, isSettled)
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
  let answered = parseAnswered(read(answeredPath(path))) ?? []
  const file = questionsPath(path)
  const record = readQuestions(file)
  let proofs = readQuestionProofs()
  if (record !== null) lastQuestions = record
  const observed = observeQuestions(lastQuestions, projects, null, answered, now, isSettled, 'preview', proofs ?? undefined, turns)
  let questions = observed.ledger
  // Chat and a one-shot read never write. Interactive readers persist before accepting hides.
  if (record !== null && proofs !== null && isQuestionSnapshot(source) && isQuestionWriter) {
    const incarnation = `${questionWriter}:${questionWrite++}`
    const wrote = rewrite(file, before => {
      if (read(path) !== source) return null
      const current = readQuestions(file, before)
      if (current === null) return null
      let next = observeQuestions(current, projects, null, answered, now, isSettled, incarnation, proofs ?? undefined, turns).ledger
      const captures = readQuestionCaptures()
      if (captures === null) return null
      for (const record of next.records) {
        if (record.source === undefined) continue
        if (record.isUnresolved && !captures.some(capture => captureJson(capture.record, capture.disposition) === captureJson(record, 'unresolved'))) keepQuestionCapture(record, 'unresolved')
        if (record.isUnresolved === false && current.records.some(old => old.id === record.id && old.isUnresolved === true)) keepQuestionCapture(record, 'resolved')
      }
      for (const old of current.records) {
        if (old.isPresent && !next.records.some(record => record.id === old.id && record.isPresent && record.isWaiting)) keepQuestionProof('retired', sha256(old.id))
      }
      proofs = readQuestionProofs()
      if (proofs === null) return null
      next = observeQuestions(current, projects, null, answered, now, isSettled, incarnation, proofs, turns).ledger
      const raw = parseQuestions(before, !existsSync(file))
      return raw !== null && questionsJson(next) === questionsJson(raw) ? before : questionsJson(next)
    })
    if (wrote !== null) {
      lastQuestions = readQuestions(file, wrote) ?? lastQuestions
      questions = lastQuestions
      if (isSettled) {
        const migrated = rewrite(answeredPath(path), before => {
          const current = parseAnswered(before, answeredAge(answeredPath(path)))
          if (current === null) return null
          const latestProofs = readQuestionProofs()
          if (latestProofs === null) return null
          const next = migratedAnswered(current, lastQuestions, latestProofs.consumed)
          for (const key of current) {
            if (Object.hasOwn(lastQuestions.legacy, key) && !latestProofs.consumed.includes(sha256(key))) keepQuestionProof('consumed', sha256(key))
          }
          return answeredJson(next) === answeredJson(current) ? before : answeredJson(next)
        })
        if (migrated !== null) answered = parseAnswered(migrated) ?? answered
      }
    }
  }
  // A question marked answered in a pane on this machine is kept off the board too.
  return buildView(projects, [basename(process.cwd())], null, now, countDay(read(journalPath(path, now)), now), manualDoneSeen(projects, seen, now, s), s, answered, seen, questions, readQuestionProofs(), turns)
}

const pad = (n: number): string => String(n).padStart(2, '0')

const options = () => ({
  width: Math.max(40, Math.min(process.stdout.columns || 80, 120)),
  isColor: process.stdout.isTTY === true && !process.env.NO_COLOR && !args.includes('--no-color'),
  isIdleOpen: args.includes('--all'),
})

// A write to a file a Claude Code session may write at the same moment: to a temp file of
// this process's own (two boards can run at once), renamed over it, then read back; made
// again from the new text when another write landed in between or the rename failed (on
// Windows, a file another program holds open), as the pane's own writes are. A failed
// read is never an empty file. `change` can run more than once, on newer text each time.
const rewrite = (file: string, change: (text: string) => string | null): string | null => {
  let failure: unknown = { code: 'EAGAIN' }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = read(file)
    const isLedger = file === questionsPath(path)
    if (isLedger && isTornLedger(before)) {
      if (!quarantineQuestions(file)) return null
      continue
    }
    const wasMissing = isLedger && before === '' && !existsSync(file)
    const after = change(before)
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
        if (!placeQuestionFile(temp, file)) {
          if (!existsSync(file)) {
            // A failed move must not delete the only complete copy.
            isOwned = false
            throw { code: 'EAGAIN' }
          }
          unlinkSync(temp)
          continue
        }
      } else {
        try {
          renameSync(temp, file)
        } catch (error) {
          if (!isLedger || existsSync(file)) throw error
          if (!placeQuestionFile(temp, file)) {
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
    if (read(file) === after) return after
    failure = { code: 'EAGAIN' }
  }

  throw fileError(file, failure)
}

// Windows looks in the current folder first for a program started by name, and an agent's folder
// can be a cloned repository: the system's own tools go by their full path, from the board's folder.
const system32 = (name: string): string => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name)

const copy = (text: string): boolean => {
  // OSC 52 asks the terminal itself to set the clipboard, which works over SSH too; the
  // system's own tool is tried as well, since not every terminal honours it.
  // On a terminal the OSC 52 write counts as copied: over SSH it is often the only way there is.
  const isOsc = process.stdout.isTTY === true
  if (isOsc) process.stdout.write(`\u001b]52;c;${Buffer.from(text).toString('base64')}\u0007`)
  const tools: Array<[string, string[]]> =
    process.platform === 'darwin' ? [['pbcopy', []]] : process.platform === 'win32' ? [[system32('clip.exe'), []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['-b', '-i']]]
  // A clipboard tool that hangs (X forwarded over a slow link) must not freeze the board.
  const isNative = tools.some(([tool, rest]) => spawnSync(tool, rest, { cwd: dirname(path), input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 2000 }).status === 0)
  return isNative || isOsc
}

// A file or a page's address in the browser. The page's address holds only letters, digits,
// `:/?=._-`, so cmd's `start` reads it as one word.
const openInBrowser = (target: string, done: (isOpen: boolean) => void): void => {
  const opener = process.platform === 'win32' ? [system32('cmd.exe'), ['/c', 'start', '', target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]]
  // Not waited on: with no desktop, xdg-open can run a text browser that never returns, and the
  // agent's command would wait with it.
  try {
    const child = spawn(opener[0] as string, opener[1] as string[], { cwd: dirname(path), detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', () => done(false))
    child.once('spawn', () => done(true))
    child.unref()
  } catch {
    done(false)
  }
}

const openHtml = (done: (note: string) => void): void => {
  const now = new Date()
  const stamp = s.dashStamp(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`)
  const html = path.replace(/\.md$/i, '') + '.html'
  const home = homeOrNone()
  const page = dashboardHtml(view(), s, path, stamp, pending(text => redact(text, home, process.platform === 'win32')))
  // Named like any other file the board cannot write, so --watch reports it and runs on.
  try {
    writeFileSync(html, page)
  } catch (error) {
    throw fileError(html, error)
  }
  openInBrowser(html, isOpen => done(isOpen ? s.windowOpened(html) : s.windowFailed(html)))
}

// Into the archive first, then out of the file, as the pane does: a crash between the two
// leaves the work in both, never in neither. An entry already archived by an earlier try
// (another session wrote meanwhile) is not archived twice. How many entries went, or null
// when a file could not be written.
const archiveOut = (take: (text: string) => { text: string; entries: string[] } | null, now: number): number | null => {
  const archived = new Set<string>()
  const wrote = rewrite(path, text => {
    const taken = take(text)
    if (taken === null) return text
    const fresh = taken.entries.filter(entry => !archived.has(entry))
    if (fresh.length > 0) {
      const kept = rewrite(archivePath(path, now), past => {
        // A previous process may have saved the archive but failed to remove the task.
        const missing = fresh.filter(entry => !hasArchiveEntry(past, entry))
        return missing.length === 0 ? past : `${past.trim() === '' ? `${s.archiveTitle}\n\n` : past.replace(/\s*$/, '\n\n')}${missing.join('\n\n')}\n`
      })
      if (kept === null) return null
      for (const entry of fresh) archived.add(entry)
    }
    return taken.text
  })

  return wrote === null ? null : archived.size
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

// What a key's action does to the files, and the line the board shows after it.
const act = (action: BoardAction): string => {
  const now = Date.now()
  if (action.type === 'copy') return copy(action.text) ? s.boardCopied(action.text) : s.boardCopyFailed(action.text)
  if (action.type === 'done') {
    let confirmed: ConfirmedTask | null = null
    const wrote = rewrite(path, text => {
      if (confirmed !== null && confirmMatches(text, confirmed.ref, s)) return text
      const next = confirmTask(text, action.ref, now, s)
      if (next === null) return null
      const lines = next.entries.map(entry => journalLine(entry, now, s))
      rewrite(journalPath(path, now), past => appendJournal(past, lines.filter(line => !past.split(/\r?\n/).includes(line)), s))
      confirmed = next
      return next.text
    })
    const found = confirmed as ConfirmedTask | null
    if (found === null || wrote === null || !confirmMatches(read(path), found.ref, s)) return s.boardLineChanged
    return s.confirmedDone(action.title)
  }
  if (action.type === 'tick') {
    // Found once is found: a retry after another session's write may meet the step already
    // ticked by this press.
    let isFound = false
    const line = journalLine({ project: action.ref.project, task: action.ref.title, step: action.ref.step }, now, s)
    const wrote = rewrite(path, text => {
      const after = setManualStep(text, action.ref, 'x')
      if (after !== text) {
        // Save history before ticking: a journal failure must leave the step available
        // to retry. A later board failure can leave an extra journal line, and is reported.
        rewrite(journalPath(path, now), past => (past.includes(line) ? past : appendJournal(past, [line], s)))
        isFound = true
      }
      return after
    })
    if (wrote === null) return s.boardWriteFailed
    if (!isFound) return s.boardTickGone
    return s.boardTicked(action.ref.step)
  }
  if (action.type === 'archive') {
    view()
    const projects = parseProgress(read(path))
    const ledger = readQuestions(questionsPath(path))
    const hasQuestions = projects.some(project => project.name === action.ref.project && project.tasks.some(task => (action.ref.session === null ? task.title === action.ref.title : task.auto?.session === action.ref.session) && task.steps.some(step => step.status === 'waiting')))
    if (hasQuestions && (ledger === null || !archiveQuestionsKept(projects, action.ref, ledger))) return s.questionRetentionFailed
    let retentionFailed = false
    const count = archiveOut(text => {
      const current = parseProgress(text)
      const latest = readQuestions(questionsPath(path))
      const asking = current.some(project => project.name === action.ref.project && project.tasks.some(task => (action.ref.session === null ? task.title === action.ref.title : task.auto?.session === action.ref.session) && task.steps.some(step => step.status === 'waiting')))
      if (asking && (latest === null || !archiveQuestionsKept(current, action.ref, latest))) {
        retentionFailed = true
        return { text, entries: [] }
      }
      if (asking && latest !== null) for (const record of latest.records) {
        if (record.isUnresolved && record.source?.project === action.ref.project && record.source.task === action.ref.title) keepQuestionCapture(record, 'archived')
      }
      return takeTask(text, action.ref, now, s)
    }, now)
    if (retentionFailed) return s.questionRetentionFailed
    if (count === null) return s.boardWriteFailed
    if (count === 0) return s.archiveGone
    return s.archivedOne(action.title)
  }
  if (action.type === 'hide' || action.type === 'unhide') {
    // The list every pane on this machine reads too; nothing goes to the agent that asked.
    const current = view()
    if (readQuestions(questionsPath(path)) === null) return s.hideFailed
    const keys = action.type === 'hide' || action.key !== null ? [action.key ?? ''] : current.hidden.map(item => item.hideKey)
    if (keys.length === 0) return ''
    const isHidden = action.type === 'hide'
    const file = answeredPath(path)
    // A list the board cannot read or replace is named with its error, as its other files are.
    const wrote = rewrite(file, before => {
      const answered = parseAnswered(before, answeredAge(file))
      const latest = readQuestions(questionsPath(path))
      const persisted = parseQuestions(read(questionsPath(path)))
      const proofs = readQuestionProofs()
      if (proofs === null || (isHidden && keys.some(key => proofs.retired.includes(sha256(key))))) return null
      if (latest === null || persisted === null || (isHidden && keys.some(key => !persisted.records.some(record => record.id === key && record.isWaiting && record.isPresent)))) return null
      const projects = parseProgress(read(path))
      const fresh = buildView(projects, [], null, now, 0, {}, s, answered ?? [], {}, latest, proofs, pending())
      if (isHidden && keys.some(key => ![...fresh.waiting, ...(fresh.reminder ?? []), ...(fresh.older ?? []), ...fresh.hidden].some(item => item.canHide !== false && item.hideKey === key))) return null
      const aliases = observeQuestions(latest, projects, null, answered ?? [], now, true).ledger
      return answered === null ? null : answeredJson(withAnswered(answered, isHidden ? keys : keys.flatMap(key => acknowledgementKeys(aliases, key)), isHidden))
    })
    if (wrote === null) return s.hideFailed
    return action.type === 'hide' ? s.boardHidden(action.text) : s.boardShown
  }

  return ''
}

// Scheduled sweeps keep the plugin's age rules. An explicit interactive tidy may move
// finished work at once; neither mode discards a stopped session before its three days.
const tidy = (isNow = true): string => {
  const now = Date.now()
  const seen = isNow ? {} : parseSeen(read(seenPath(path)), answeredAge(seenPath(path))) ?? {}
  const count = archiveOut(text => {
    const blocks = takeArchivable(text, now, undefined, s, isNow)
    const manual = takeManualDone(blocks.text, now, (_key, project, task) => {
      const at = seen[taskFingerprint(project, task)]
      return at !== undefined && at <= now ? at : undefined
    }, s, isNow)
    const entries = [...blocks.entries, ...manual.entries]
    return entries.length === 0 ? null : { text: manual.text, entries }
  }, now)
  if (count === null) {
    if (!isNow) process.exitCode = 1
    return s.boardWriteFailed
  }
  return count === 0 ? s.tidyNothing : s.tidyMoved(count)
}

// Keys as the terminal sends them, named the way boardKey reads them. One read can hold more
// than one key (a held arrow, a paste).
const keyName = (one: string): string =>
  one === '\u001b[A' || one === '\u001bOA' ? 'up' : one === '\u001b[B' || one === '\u001bOB' ? 'down' : one === '\r' || one === '\n' ? 'enter' : one
// An escape and the character after it (Alt with a letter) is one key the board ignores.
const keysIn = (chunk: string): string[] => (chunk.replace(/\r\n/g, '\r').match(/\u001b[[O][0-9;]*[A-Za-z~]|\u001b[\s\S]?|[\s\S]/gu) ?? []).map(keyName)

const failureNote = (error: unknown): string => {
  if (!(error instanceof BoardFileError)) throw error
  process.exitCode = 1
  const note = s.boardStorageFailed(error.file, error.code)
  // The board's one-line status is clipped to terminal width; keep the full path and
  // recovery advice on stderr too, including for an agent using --keys.
  process.stderr.write(`${note}\n`)
  return note
}

const press = (state: BoardState, key: string): { state: BoardState; isQuit: boolean; isHtml: boolean; isWrite: boolean } => {
  const items = boardItems(view(), pending(), state.isIdleOpen ?? false, state.isOlderOpen ?? false)
  const { state: next, action } = boardKey(state, key, items, s)
  if (action === null) return { state: next, isQuit: false, isHtml: false, isWrite: false }
  if (action.type === 'quit') return { state: next, isQuit: true, isHtml: false, isWrite: false }
  if (action.type === 'html') return { state: next, isQuit: false, isHtml: true, isWrite: false }

  // After a write the lines move; the choice is made again from the screen drawn next.
  let note: string
  try {
    note = act(action)
  } catch (error) {
    note = failureNote(error)
  }
  return { state: { ...next, key: null, note }, isQuit: false, isHtml: false, isWrite: action.type !== 'copy' }
}

const screen = (state: BoardState): string => boardScreen(view(), pending(), state, s, options())

// What the screen shows is what the next key acts on.
const pin = (state: BoardState): BoardState => pinned(state, boardItems(view(), pending(), state.isIdleOpen ?? false, state.isOlderOpen ?? false))

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
    const why = { noBlock: s.pasteNoBlock, mixed: s.pasteMixed, badBlock: s.pasteBadBlock, noProject: s.pasteNoProject, notYours: s.pasteNotYours, badTime: s.pasteBadTime, futureTime: s.pasteFutureTime, older: s.pasteOlder, conflict: s.pasteConflict, unknownOrder: s.pasteUnknownOrder }[found.problem]
    return { isAdded: false, note: s.servePasteRefused(why), review: found.review }
  }
  if (wrote === null || found === null) return { isAdded: false, note: s.boardWriteFailed }
  return { isAdded: true, note: found.isUnchanged ? s.pasteUnchanged : s.servePasted(found.title) }
}

// A folder only this account can use: on a shared one, another account could take the file's
// name first and keep every page from starting.
const isOwnFolder = (dir: string): boolean => {
  try {
    const found = lstatSync(dir)
    return found.isDirectory() && (process.getuid === undefined || (found.uid === process.getuid() && (found.mode & 0o077) === 0))
  } catch {
    return false
  }
}

// The folder for running programs when it is this account's own, else ~/.cache/agent-board
// (the temp folder on Windows, which is the account's own there).
const runFolder = (): string => {
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime && isOwnFolder(runtime)) return runtime
  if (process.platform === 'win32') return tmpdir()
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
const serveFile = (): string => (served ??= join(runFolder(), `agent-board-${createHash('sha256').update(board(path)).digest('hex').slice(0, 16)}.json`))
// Where 0.19.0 left it, beside progress.md.
const oldServeFile = `${path.replace(/\.md$/i, '')}-serve.json`
const script = process.argv[1] ?? ''
const built = (() => {
  try {
    return String(statSync(script).mtimeMs)
  } catch {
    return ''
  }
})()

type Running = { pid: number; port: number; url: string; path: string; built: string }

const readRunning = (file = serveFile()): Running | null => {
  try {
    // Only a file of this account's own, never a link to one somewhere else.
    const own = lstatSync(file)
    if (own.isSymbolicLink() || (process.getuid !== undefined && own.uid !== process.getuid())) return null
    const found = JSON.parse(read(file)) as Partial<Running>
    // Only an address of the shape this server writes: anything else would stop `--serve` when
    // it reads the token out of it.
    return typeof found.pid === 'number' && typeof found.port === 'number' && typeof found.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/.test(found.url)
      ? { pid: found.pid, port: found.port, url: found.url, path: String(found.path ?? ''), built: String(found.built ?? '') }
      : null
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

const serveChild = (): void => {
  startServer({
    allowResume: args.includes('--allow-resume'),
    messagesDirectory: flag('--messages-dir'),
    reports: () => parseProgress(read(path)).flatMap(project => project.tasks.flatMap(task => task.auto === null ? [] : [{ agent: task.auto.agent, session: task.auto.resume ?? task.auto.session, updated: task.auto.updated }])),
    s,
    port: Number(flag('--port') ?? 0) || 0,
    ping: { path, built, idleMs: idleMs(), allowResume: args.includes('--allow-resume'), messagesDirectory: flag('--messages-dir') ? resolve(flag('--messages-dir')!) : null },
    view,
    pending,
    act,
    tidy,
    paste,
    // The page names a file it could not read or write the way the terminal board does, for a
    // press and for the board it shows. The page is answered, so the exit code and stderr are
    // left alone. A phone is told the file name only: the folder names the person's account.
    failure: (error, isLan) => (error instanceof BoardFileError ? s.boardStorageFailed(isLan ? basename(error.file) : error.file, error.code) : null),
    idleMs: idleMs(),
    onReady: (url, port) => {
      // Without its address file no later `--serve` finds this page, and each would start one
      // more; so it does not start at all. Nor when the file is there already: another
      // `--serve` started a page at the same moment and wrote first, and that one is the page.
      try {
        writeFileSync(serveFile(), JSON.stringify({ pid: process.pid, port, url, path, built }), { mode: 0o600, flag: 'wx' })
      } catch {
        return false
      }
      // The one line `--serve` waits for. Its pipe closes once it has read it.
      process.stdout.on('error', () => undefined)
      process.stdout.write(`${url}\n`)
      return true
    },
    onStop: () => {
      // The file goes only while it is still this server's: a newer one may have taken it over.
      unlinkIf(serveFile(), () => readRunning()?.pid === process.pid)
      process.exit(0)
    },
  })
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

// The running page of this copy for this file, or null. Any other page found in the file (one
// that no longer answers, or an older copy's) is let go, so a new one can write the file; but an
// older copy's page that will not close (a reply is on its way) is kept, and `isKept` says so.
const runningPage = async (): Promise<{ page: Running; isKept: boolean; idleMs?: number | undefined } | null> => {
  const running = readRunning()
  if (running === null) {
    // A file that has not read for ten seconds (either way, should the clock have been set
    // back) was cut short by a crash; it would keep every new page from starting.
    unlinkIf(serveFile(), () => Math.abs(Date.now() - statSync(serveFile()).mtimeMs) > 10_000)
    return null
  }
  // A page that is still running but slow to answer (a busy disk) gets longer before it counts
  // as gone and a second one starts.
  const first = await ping(running)
  const answer = first !== null && first !== 'silent' ? first : isRunning(running.pid) ? await ping(running, 5000) : first
  // An idle preference must not close a page that may hold an unsent reply.
  if (answer !== null && answer !== 'silent' && typeof answer.path === 'string' && board(answer.path) === board(path) && answer.built === built && answer.allowResume === args.includes('--allow-resume') && (flag('--messages-dir') === undefined || answer.messagesDirectory === resolve(flag('--messages-dir')!))) return { page: running, isKept: false, idleMs: typeof answer.idleMs === 'number' && Number.isFinite(answer.idleMs) && answer.idleMs >= 0 ? answer.idleMs : undefined }
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

// Prints the board, then the address of its page, started in the background if no page of this
// copy is running yet (and opened in the browser then, unless --no-open). It returns at once, so
// an agent's command tool is not left waiting on the server.
const serveBoard = async (): Promise<void> => {
  const requestedIdle = idleMs()
  process.stdout.write(boardText(view(), pending(), s, options()))
  // The note goes above the address, so the address stays the last line an agent shows.
  const show = async (url: string, isKept = false, actualIdle?: number): Promise<void> => {
    const idleNote = actualIdle !== undefined && actualIdle !== requestedIdle ? `${actualIdle === 0 ? s.serveIdle : s.serveIdleTimed(actualIdle / 60_000)}\n` : ''
    process.stdout.write(`\n${isKept ? `${s.serveKept}\n` : ''}${idleNote}${s.serveAt(url)}\n`)
    // The address comes from a file and goes to a shell on Windows: only the shape this server
    // writes is opened.
    if (!args.includes('--no-open') && /^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/.test(url)) await new Promise<void>(done => openInBrowser(url, () => done()))
    if (args.includes('--lan')) await showLan(url)
  }
  // 0.19.0 kept the address, token and all, beside progress.md.
  const old = readRunning(oldServeFile)
  if (old !== null && (await stays(old, oldServeFile))) return show(old.url, true)
  const found = await runningPage()
  if (found !== null) return show(found.page.url, found.isKept, found.idleMs)
  const rest = ['--lang', '--port', '--messages-dir', '--idle-minutes'].flatMap(name => {
    const value = flag(name)
    return value === undefined ? [] : [name, value]
  })
  if (args.includes('--allow-resume')) rest.push('--allow-resume')
  // In the board's own folder, not the agent's, so the server holds no project folder open.
  const child = spawn(process.execPath, [script, '--serve-child', ...rest], { cwd: dirname(path), detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  // The child prints its address once it listens; it exits at once when it cannot.
  const url = await new Promise<string | null>(done => {
    let out = ''
    const timer = setTimeout(() => done(null), 10_000)
    const end = (value: string | null): void => {
      clearTimeout(timer)
      done(value)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      if (out.includes('\n')) end(out.split('\n')[0]?.trim() || null)
    })
    child.once('exit', () => end(null))
    child.once('error', () => end(null))
  })
  // One that has not answered in time would start late and hold a page nobody was told about.
  if (url === null && child.exitCode === null) child.kill()
  child.stdout?.destroy()
  child.unref()
  if (url === null) {
    // Another `--serve` started at the same moment may have written its address first: this
    // page stopped then, and that one is the page to show.
    const other = await runningPage()
    if (other !== null) return show(other.page.url, other.isKept, other.idleMs)
    process.stdout.write(`\n${s.serveFailed(s.serveOffline)}\n`)
    return
  }
  await show(url)
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
    process.stdout.write(chatText(view(source, now), updates, doneToday(read(journalPath(path, now)), now, s), s, home, isWin, CHAT_MAX, now))
  } catch (error) {
    process.exitCode = 1
    const code = (error as { code?: unknown } | null)?.code
    const reason = typeof code === 'string' ? code : error instanceof Error ? error.message.split('\n')[0]?.slice(0, 160) || error.name : 'UNKNOWN'
    // Nothing here writes, so the board's own advice (files "may already have changed") is not told.
    const told = error instanceof BoardFileError ? s.chatReadFailed(error.file, error.code) : s.chatFailed(reason)
    process.stdout.write(`${redact(told, homeOrNone(), isWin)}\n`)
  }
}

const run = async (): Promise<void> => {
  const request = flag('--legacy-connect-request')
  if (request !== undefined) {
    const trusted = (globalThis as { AGENT_BOARD_WORKER_SOURCE?: string }).AGENT_BOARD_WORKER_SOURCE
    const bundle = (trusted ?? readFileSync(process.argv[1]!, 'utf8')).replace(/^globalThis\.AGENT_BOARD = [^\n]*\n/, '')
    process.stdout.write(`${JSON.stringify(await legacyConnect(JSON.parse(request), bundle))}\n`)
    return
  }
  if (await runCodexLocal(args, path, s)) return
  if (args.includes('--help') && !args.includes('--chat')) {
    process.stdout.write(`${s.boardUsage}\n`)
  } else if (args.includes('--serve-child')) {
    serveChild()
  } else if (args.includes('--chat')) {
    // Before the flags that serve, open or write: a chat reply never starts a page.
    chat()
  } else if (args.includes('--tidy')) {
    process.stdout.write(`${tidy(false)}\n`)
  } else if (args.includes('--serve')) {
    await serveBoard()
  } else if (args.includes('--html')) {
    openHtml(note => process.stdout.write(`${note}\n`))
  } else if (flag('--keys') !== undefined) {
    let state = emptyBoardState
    for (const key of (flag('--keys') ?? '').split(/\s+/).filter(one => one !== '')) {
      const pressed = press(pin(state), key)
      state = pressed.state
      if (pressed.isQuit) break
    }
    process.stdout.write(screen(state))
  } else if (args.includes('--watch') && process.stdin.isTTY) {
    // No fingerprint is kept before the first draw succeeds, and x, a and c then refuse every line.
    let state: BoardState = { ...emptyBoardState, seen: {}, isIdleOpen: args.includes('--all') }
    // The fingerprints kept are those of the very lines this screen shows: one read does both.
    const draw = (): void => {
      try {
        const shown = view()
        const turns = pending()
        state = pinned(state, boardItems(shown, turns, state.isIdleOpen ?? false, state.isOlderOpen ?? false))
        process.stdout.write(`\u001b[2J\u001b[H${boardScreen(shown, turns, state, s, options())}`)
      } catch (error) {
        process.stdout.write(`\u001b[2J\u001b[H${failureNote(error)}\n`)
      }
    }
    const quit = (): void => {
      process.stdin.setRawMode(false)
      process.exit(process.exitCode ?? 0)
    }
    process.stdin.setRawMode(true)
    process.stdin.setEncoding('utf8')
    process.stdout.write('\u001b[?25l')
    // The cursor comes back however the board ends (q, a signal, an error).
    process.on('exit', () => process.stdout.write('\u001b[?25h\n'))
    for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.on(signal, () => process.exit(process.exitCode ?? 0))
    process.stdin.on('data', (chunk: string) => {
      try {
        // Keys that came together (a held arrow) each act on the line the one before left chosen;
        // after a tick or an archive the rest wait, so no key lands on a line not yet drawn. A
        // key acts on the state of the last draw, not on a fresh pin: x and a check that the
        // line is still the one drawn.
        for (const key of keysIn(chunk)) {
          // Quitting must work while the files cannot be read, before pin/view runs.
          if (key === 'q' || key === '\u0003') quit()
          const pressed = press(state, key)
          state = pressed.state
          if (pressed.isQuit) quit()
          if (pressed.isHtml) {
            openHtml(note => {
              state = { ...state, note }
              draw()
            })
          }
          if (pressed.isWrite) break
        }
        draw()
      } catch (error) {
        state = { ...state, note: failureNote(error) }
        draw()
      }
    })
    draw()
    setInterval(draw, 2000)
  } else if (args.includes('--watch')) {
    // Not a terminal (piped, or an agent's tool): no keys to read, so it only redraws.
    const tick = () => {
      try {
        process.stdout.write(`\u001b[2J\u001b[H${boardText(view(), pending(), s, options())}\n${s.boardWatching}\n`)
      } catch (error) {
        process.stdout.write(`\u001b[2J\u001b[H${failureNote(error)}\n`)
      }
    }
    tick()
    setInterval(tick, 2000)
  } else {
    process.stdout.write(boardText(view(), pending(), s, options()))
  }
}

try {
  await run()
} catch (error) {
  failureNote(error)
}
