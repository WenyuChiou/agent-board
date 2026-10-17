// The Agent Board for any terminal and any agent, without Claude Code: `node agent-board.mjs`
// prints the board once, `--watch` keeps it on screen and, on a terminal, lets you work in it
// the way the pane does (arrows, Enter, x, a, c, digits), and `--html` writes progress.html
// and opens it. `/progress connect` writes the bundled copy of this file beside progress.md
// (scripts/build-board.ts bundles it into hooks/board-script.ts), with the progress file
// and language the Claude Code session uses set on its first line. `--keys "down x"` plays
// keys without a terminal and prints the board after them, for tests and checks.
import { execFile, spawnSync } from 'node:child_process'
import { closeSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { takeTask, setManualStep } from '../hooks/blocks'
import { boardKey, boardScreen, boardText, emptyBoardState, peekInbox, boardItems, pinned } from '../hooks/board'
import type { BoardAction, BoardState } from '../hooks/board'
import { LOG_TAIL } from '../hooks/inbox'
import { dashboardHtml } from '../hooks/dashboard'
import { appendJournal, archivePath, countDay, journalLine, journalPath } from '../hooks/journal'
import { parseProgress } from '../hooks/parse'
import { langOf, STRINGS } from '../hooks/strings'
import { buildView } from '../hooks/view'

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

const read = (file: string): string => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
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
  return buildView(parseProgress(read(path)), [basename(process.cwd())], null, now, countDay(read(journalPath(path, now)), now), {}, s)
}

const pad = (n: number): string => String(n).padStart(2, '0')

const options = () => ({
  width: Math.max(40, Math.min(process.stdout.columns || 80, 120)),
  isColor: process.stdout.isTTY === true && !process.env.NO_COLOR && !args.includes('--no-color'),
})

// A write to a file a Claude Code session may write at the same moment: to a temp file of
// this process's own (two boards can run at once), renamed over it, then read back; made
// again from the new text when another write landed in between or the rename failed (on
// Windows, a file another program holds open), as the pane's own writes are. Null when it
// could not be made to stick. `change` can run more than once, on newer text each time.
const rewrite = (file: string, change: (text: string) => string | null): string | null => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = read(file)
    const after = change(before)
    if (after === null) return null
    if (after === before) return after
    const temp = `${file}.${process.pid}.${Date.now().toString(36)}.board-tmp`
    try {
      writeFileSync(temp, after)
      renameSync(temp, file)
    } catch {
      try {
        unlinkSync(temp)
      } catch {}
      continue
    }
    if (read(file) === after) return after
  }

  return null
}

const copy = (text: string): boolean => {
  // OSC 52 asks the terminal itself to set the clipboard, which works over SSH too; the
  // system's own tool is tried as well, since not every terminal honours it.
  // On a terminal the OSC 52 write counts as copied: over SSH it is often the only way there is.
  const isOsc = process.stdout.isTTY === true
  if (isOsc) process.stdout.write(`\u001b]52;c;${Buffer.from(text).toString('base64')}\u0007`)
  const tools: Array<[string, string[]]> =
    process.platform === 'darwin' ? [['pbcopy', []]] : process.platform === 'win32' ? [['clip', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['-b', '-i']]]
  // A clipboard tool that hangs (X forwarded over a slow link) must not freeze the board.
  const isNative = tools.some(([tool, rest]) => spawnSync(tool, rest, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 2000 }).status === 0)
  return isNative || isOsc
}

const openHtml = (done: (note: string) => void): void => {
  const now = new Date()
  const stamp = s.dashStamp(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`)
  const html = path.replace(/\.md$/i, '') + '.html'
  writeFileSync(html, dashboardHtml(view(), s, path, stamp))
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', html]] : process.platform === 'darwin' ? ['open', [html]] : ['xdg-open', [html]]
  execFile(opener[0] as string, opener[1] as string[], error => done(error ? s.windowFailed(html) : s.windowOpened(html)))
}

// What a key's action does to the files, and the line the board shows after it.
const act = (action: BoardAction): string => {
  const now = Date.now()
  if (action.type === 'copy') return copy(action.text) ? s.boardCopied(action.text) : s.boardCopyFailed(action.text)
  if (action.type === 'tick') {
    // Found once is found: a retry after another session's write may meet the step already
    // ticked by this press.
    let isFound = false
    const wrote = rewrite(path, text => {
      const after = setManualStep(text, action.ref, 'x')
      if (after !== text) isFound = true
      return after
    })
    if (wrote === null) return s.boardWriteFailed
    if (!isFound) return s.boardTickGone
    const journal = journalPath(path, now)
    rewrite(journal, text => appendJournal(text, [journalLine({ project: action.ref.project, task: action.ref.title, step: action.ref.step }, now, s)], s))
    return s.boardTicked(action.ref.step)
  }
  if (action.type === 'archive') {
    // Into the archive first, then out of the file, as the pane does: a crash between the two
    // leaves the block in both, never in neither. An entry already archived by an earlier
    // try (another session wrote meanwhile) is not archived twice.
    const archived = new Set<string>()
    const wrote = rewrite(path, text => {
      const taken = takeTask(text, action.ref, now, s)
      if (taken === null) return text
      const fresh = taken.entries.filter(entry => !archived.has(entry))
      if (fresh.length > 0) {
        const kept = rewrite(archivePath(path, now), past => `${past.trim() === '' ? `${s.archiveTitle}\n\n` : past.replace(/\s*$/, '\n\n')}${fresh.join('\n\n')}\n`)
        if (kept === null) return null
        for (const entry of fresh) archived.add(entry)
      }
      return taken.text
    })
    if (wrote === null) return s.boardWriteFailed
    if (archived.size === 0) return s.archiveGone
    return s.archivedOne(action.title)
  }

  return ''
}

// Keys as the terminal sends them, named the way boardKey reads them. One read can hold more
// than one key (a held arrow, a paste).
const keyName = (one: string): string =>
  one === '\u001b[A' || one === '\u001bOA' ? 'up' : one === '\u001b[B' || one === '\u001bOB' ? 'down' : one === '\r' || one === '\n' ? 'enter' : one
const keysIn = (chunk: string): string[] => (chunk.replace(/\r\n/g, '\r').match(/\u001b[[O][0-9;]*[A-Za-z~]|[\s\S]/gu) ?? []).map(keyName)

const press = (state: BoardState, key: string): { state: BoardState; isQuit: boolean; isHtml: boolean } => {
  const items = boardItems(view(), pending())
  const { state: next, action } = boardKey(state, key, items, s)
  if (action === null) return { state: next, isQuit: false, isHtml: false }
  if (action.type === 'quit') return { state: next, isQuit: true, isHtml: false }
  if (action.type === 'html') return { state: next, isQuit: false, isHtml: true }

  // After a write the lines move; the choice is made again from the screen drawn next.
  return { state: { ...next, key: null, note: act(action) }, isQuit: false, isHtml: false }
}

const screen = (state: BoardState): string => boardScreen(view(), pending(), state, s, options())

// What the screen shows is what the next key acts on.
const pin = (state: BoardState): BoardState => pinned(state, boardItems(view(), pending()))

if (args.includes('--html')) {
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
    state = pin(state)
    process.stdout.write(`\u001b[2J\u001b[H${screen(state)}`)
  }
  const quit = (): void => {
    process.stdin.setRawMode(false)
    process.exit(0)
  }
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdout.write('\u001b[?25l')
  // The cursor comes back however the board ends (q, a signal, an error).
  process.on('exit', () => process.stdout.write('\u001b[?25h\n'))
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.on(signal, () => process.exit(0))
  process.stdin.on('data', (chunk: string) => {
    for (const key of keysIn(chunk)) {
      const pressed = press(state, key)
      state = pressed.state
      if (pressed.isQuit) quit()
      if (pressed.isHtml) {
        openHtml(note => {
          state = { ...state, note }
          draw()
        })
      }
    }
    draw()
  })
  draw()
  setInterval(draw, 2000)
} else if (args.includes('--watch')) {
  // Not a terminal (piped, or an agent's tool): no keys to read, so it only redraws.
  const tick = () => process.stdout.write(`\u001b[2J\u001b[H${boardText(view(), pending(), s, options())}\n${s.boardWatching}\n`)
  tick()
  setInterval(tick, 2000)
} else {
  process.stdout.write(boardText(view(), pending(), s, options()))
}
