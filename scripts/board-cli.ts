// The Agent Board for any terminal and any agent, without Claude Code: `node agent-board.mjs`
// prints the board once, `--watch` keeps it on screen and, on a terminal, lets you work in it
// the way the pane does (arrows, Enter, x, a, c, digits), and `--html` writes progress.html
// and opens it. `--serve` prints the board and opens the board's page in the browser, where it
// can be clicked (board-serve.ts). `/progress connect` writes the bundled copy of this file
// beside progress.md (scripts/build-board.ts bundles it into hooks/board-script.ts), with the
// progress file and language the Claude Code session uses set on its first line. `--keys
// "down x"` plays keys without a terminal and prints the board after them, for tests and checks.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { mergeBlock, takeArchivable, takeManualDone, takeTask, setManualStep } from '../hooks/blocks'
import type { PasteProblem } from '../hooks/blocks'
import { startServer } from './board-serve'
import { boardKey, boardScreen, boardText, emptyBoardState, peekInbox, boardItems, pinned } from '../hooks/board'
import type { BoardAction, BoardState } from '../hooks/board'
import { LOG_TAIL } from '../hooks/inbox'
import { dashboardHtml } from '../hooks/dashboard'
import { appendJournal, archivePath, countDay, hasArchiveEntry, journalLine, journalPath } from '../hooks/journal'
import { parseProgress } from '../hooks/parse'
import { qrModules, qrText } from '../hooks/qr'
import { langOf, STRINGS } from '../hooks/strings'
import { answeredJson, answeredPath, buildView, parseAnswered, withAnswered } from '../hooks/view'

// The line `/progress connect` puts above the bundle sets it.
const BAKED = (globalThis as { AGENT_BOARD?: { path?: string; lang?: string } }).AGENT_BOARD ?? {}

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
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

const pending = () => {
  const dir = join(dirname(path), 'progress-inbox')
  let names: string[] = []
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.json'))
  } catch {
    return []
  }
  const files = names.flatMap(name => {
    try {
      const file = join(dir, name)
      return [{ name, body: read(file), at: statSync(file).mtimeMs }]
    } catch {
      return []
    }
  })

  return peekInbox(files, readLog)
}

const view = () => {
  const now = Date.now()
  // A question marked answered in a pane on this machine is kept off the board too.
  return buildView(parseProgress(read(path)), [basename(process.cwd())], null, now, countDay(read(journalPath(path, now)), now), {}, s, parseAnswered(read(answeredPath(path))) ?? [])
}

const pad = (n: number): string => String(n).padStart(2, '0')

const options = () => ({
  width: Math.max(40, Math.min(process.stdout.columns || 80, 120)),
  isColor: process.stdout.isTTY === true && !process.env.NO_COLOR && !args.includes('--no-color'),
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
      renameSync(temp, file)
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
  const page = dashboardHtml(view(), s, path, stamp)
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
    const count = archiveOut(text => takeTask(text, action.ref, now, s), now)
    if (count === null) return s.boardWriteFailed
    if (count === 0) return s.archiveGone
    return s.archivedOne(action.title)
  }
  if (action.type === 'hide' || action.type === 'unhide') {
    // The list every pane on this machine reads too; nothing goes to the agent that asked.
    const keys = action.type === 'hide' || action.key !== null ? [action.key ?? ''] : view().hidden.map(item => item.hideKey)
    if (keys.length === 0) return ''
    const isHidden = action.type === 'hide'
    const file = answeredPath(path)
    // A list the board cannot read or replace is named with its error, as its other files are.
    const wrote = rewrite(file, before => {
      const answered = parseAnswered(before, answeredAge(file))
      return answered === null ? null : answeredJson(withAnswered(answered, keys, isHidden))
    })
    if (wrote === null) return s.hideFailed
    return action.type === 'hide' ? s.boardHidden(action.text) : s.boardShown
  }

  return ''
}

// Every finished task out now, the way `/progress tidy` and the pane's 現在封存 do it: done
// blocks and finished hand-kept tasks at once, a stopped session's block after its three days.
const tidy = (): string => {
  const now = Date.now()
  const count = archiveOut(text => {
    const blocks = takeArchivable(text, now, undefined, s, true)
    // This script keeps no record of when a task was seen done: asked for now, it is today's.
    const manual = takeManualDone(blocks.text, now, () => undefined, s, true)
    const entries = [...blocks.entries, ...manual.entries]
    return entries.length === 0 ? null : { text: manual.text, entries }
  }, now)
  if (count === null) return s.boardWriteFailed
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
  const items = boardItems(view(), pending())
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
const pin = (state: BoardState): BoardState => pinned(state, boardItems(view(), pending()))

// A block pasted into the page from a web chat, merged the way the remote reporter's merge
// does: read, change only that block, write, read back.
const paste = (text: string): { isAdded: boolean; note: string } => {
  const found: { problem: PasteProblem | null; title: string } = { problem: null, title: '' }
  const wrote = rewrite(path, before => {
    const merged = mergeBlock(before, text, Date.now(), s)
    if ('problem' in merged) {
      found.problem = merged.problem
      return null
    }
    found.problem = null
    found.title = merged.title
    return merged.text
  })
  if (found.problem !== null) {
    const why = { noBlock: s.pasteNoBlock, mixed: s.pasteMixed, badBlock: s.pasteBadBlock, noProject: s.pasteNoProject, notYours: s.pasteNotYours }[found.problem]
    return { isAdded: false, note: s.servePasteRefused(why) }
  }
  if (wrote === null) return { isAdded: false, note: s.boardWriteFailed }
  return { isAdded: true, note: s.servePasted(found.title) }
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

// The running page's own answer, or null when nothing answers at its address.
const ping = async (running: Running, waitMs = 1500): Promise<Record<string, unknown> | null> => {
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/api/ping`, { headers: { 'x-board-token': tokenOf(running.url) }, signal: AbortSignal.timeout(waitMs) })
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const serveChild = (): void => {
  startServer({
    s,
    port: Number(flag('--port') ?? 0) || 0,
    ping: { path, built },
    view,
    pending,
    act,
    tidy,
    paste,
    // The page names a file it could not read or write the way the terminal board does, for a
    // press and for the board it shows. The page is answered, so the exit code and stderr are
    // left alone. A phone is told the file name only: the folder names the person's account.
    failure: (error, isLan) => (error instanceof BoardFileError ? s.boardStorageFailed(isLan ? basename(error.file) : error.file, error.code) : null),
    idleMs: 30 * 60 * 1000,
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

// The page at that address is asked to close (it refuses while a reply is on its way, and then
// stops by itself once idle), and its file goes while it still names that page: another
// `--serve` may have started a new one since.
const letGo = async (running: Running, file: string): Promise<void> => {
  await fetch(`http://127.0.0.1:${running.port}/api/close`, { method: 'POST', headers: { 'x-board-token': tokenOf(running.url), 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1500) }).catch(() => undefined)
  unlinkIf(file, () => readRunning(file)?.pid === running.pid)
}

// The running page of this copy for this file, or null. Any other page found in the file (one
// that no longer answers, or an older copy's) is let go, so a new one can write the file.
const runningPage = async (): Promise<Running | null> => {
  const running = readRunning()
  if (running === null) {
    // A file that has not read for ten seconds (either way, should the clock have been set
    // back) was cut short by a crash; it would keep every new page from starting.
    unlinkIf(serveFile(), () => Math.abs(Date.now() - statSync(serveFile()).mtimeMs) > 10_000)
    return null
  }
  // A page that is still running but slow to answer (a busy disk) gets longer before it counts
  // as gone and a second one starts.
  const answer = (await ping(running)) ?? (isRunning(running.pid) ? await ping(running, 5000) : null)
  if (answer !== null && typeof answer.path === 'string' && board(answer.path) === board(path) && answer.built === built) return running
  await letGo(running, serveFile())
  return null
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
  process.stdout.write(boardText(view(), pending(), s, options()))
  const show = async (url: string): Promise<void> => {
    process.stdout.write(`\n${s.serveAt(url)}\n`)
    // The address comes from a file and goes to a shell on Windows: only the shape this server
    // writes is opened.
    if (!args.includes('--no-open') && /^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/.test(url)) await new Promise<void>(done => openInBrowser(url, () => done()))
    if (args.includes('--lan')) await showLan(url)
  }
  // 0.19.0 kept the address, token and all, beside progress.md.
  const old = readRunning(oldServeFile)
  if (old !== null) await letGo(old, oldServeFile)
  const found = await runningPage()
  if (found !== null) return show(found.url)
  const rest = ['--lang', '--port'].flatMap(name => {
    const value = flag(name)
    return value === undefined ? [] : [name, value]
  })
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
    if (other !== null) return show(other.url)
    process.stdout.write(`\n${s.serveFailed(s.serveOffline)}\n`)
    return
  }
  await show(url)
}

const run = async (): Promise<void> => {
  if (args.includes('--serve-child')) {
    serveChild()
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
    let state = emptyBoardState
    const draw = (): void => {
      try {
        state = pin(state)
        process.stdout.write(`\u001b[2J\u001b[H${screen(state)}`)
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
        // after a tick or an archive the rest wait, so no key lands on a line not yet drawn.
        for (const key of keysIn(chunk)) {
          // Quitting must work while the files cannot be read, before pin/view runs.
          if (key === 'q' || key === '\u0003') quit()
          const pressed = press(pin(state), key)
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
