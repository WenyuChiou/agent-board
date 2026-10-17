// The Agent Board for any terminal and any agent, without Claude Code: `node agent-board.mjs`
// prints the board once, `--watch` keeps it on screen and, on a terminal, lets you work in it
// the way the pane does (arrows, Enter, x, a, c, digits), and `--html` writes progress.html
// and opens it. `/progress connect` writes the bundled copy of this file beside progress.md
// (scripts/build-board.ts bundles it into hooks/board-script.ts), with the progress file
// and language the Claude Code session uses set on its first line. `--keys "down x"` plays
// keys without a terminal and prints the board after them, for tests and checks.
import { execFile, spawnSync } from 'node:child_process'
import { closeSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { takeTask, setManualStep } from '../hooks/blocks'
import { boardKey, boardScreen, boardText, emptyBoardState, peekInbox, boardItems } from '../hooks/board'
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

// A write to a file a Claude Code session may write at the same moment: to a temp file,
// renamed over it, then read back; made again from the new text when another write landed
// in between, as the pane's own writes are. Null when it could not be made to stick.
const rewrite = (file: string, change: (text: string) => string | null): string | null => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = read(file)
    const after = change(before)
    if (after === null) return null
    if (after === before) return after
    try {
      writeFileSync(`${file}.board-tmp`, after)
      renameSync(`${file}.board-tmp`, file)
    } catch {
      return null
    }
    if (read(file) === after) return after
  }

  return null
}

const copy = (text: string): boolean => {
  // OSC 52 asks the terminal itself to set the clipboard, which works over SSH too; the
  // system's own tool is tried as well, since not every terminal honours it.
  if (process.stdout.isTTY) process.stdout.write(`\u001b]52;c;${Buffer.from(text).toString('base64')}\u0007`)
  const tools: Array<[string, string[]]> =
    process.platform === 'darwin' ? [['pbcopy', []]] : process.platform === 'win32' ? [['clip', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['-b', '-i']]]
  return tools.some(([tool, rest]) => spawnSync(tool, rest, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }).status === 0)
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
    let isFound = true
    const wrote = rewrite(path, text => {
      const after = setManualStep(text, action.ref, 'x')
      if (after === text) isFound = false
      return after
    })
    if (wrote === null) return s.boardWriteFailed
    if (!isFound) return s.boardTickGone
    const journal = journalPath(path, now)
    rewrite(journal, text => appendJournal(text, [journalLine({ project: action.ref.project, task: action.ref.title, step: action.ref.step }, now, s)], s))
    return s.boardTicked(action.ref.step)
  }
  if (action.type === 'archive') {
    let entries: string[] = []
    const wrote = rewrite(path, text => {
      const taken = takeTask(text, action.ref, now, s)
      entries = taken === null ? [] : taken.entries
      return taken === null ? text : taken.text
    })
    if (wrote === null) return s.boardWriteFailed
    if (entries.length === 0) return s.archiveGone
    rewrite(archivePath(path, now), past => `${past.trim() === '' ? `${s.archiveTitle}\n\n` : past.replace(/\s*$/, '\n\n')}${entries.join('\n\n')}\n`)
    return s.archivedOne(action.title)
  }

  return ''
}

// Keys as the terminal sends them, named the way boardKey reads them.
const keyName = (chunk: string): string =>
  chunk === '\u001b[A' || chunk === '\u001bOA' ? 'up' : chunk === '\u001b[B' || chunk === '\u001bOB' ? 'down' : chunk === '\r' || chunk === '\n' ? 'enter' : chunk

const press = (state: BoardState, key: string): { state: BoardState; isQuit: boolean; isHtml: boolean } => {
  const items = boardItems(view(), pending())
  const { state: next, action } = boardKey(state, key, items, s)
  if (action === null) return { state: next, isQuit: false, isHtml: false }
  if (action.type === 'quit') return { state: next, isQuit: true, isHtml: false }
  if (action.type === 'html') return { state: next, isQuit: false, isHtml: true }

  return { state: { ...next, note: act(action) }, isQuit: false, isHtml: false }
}

const screen = (state: BoardState): string => boardScreen(view(), pending(), state, s, options())

if (args.includes('--html')) {
  openHtml(note => process.stdout.write(`${note}\n`))
} else if (flag('--keys') !== undefined) {
  let state = emptyBoardState
  for (const key of (flag('--keys') ?? '').split(/\s+/).filter(one => one !== '')) {
    const pressed = press(state, key)
    state = pressed.state
    if (pressed.isQuit) break
  }
  process.stdout.write(screen(state))
} else if (args.includes('--watch') && process.stdin.isTTY) {
  let state = emptyBoardState
  const draw = (): void => {
    process.stdout.write(`\u001b[2J\u001b[H${screen(state)}`)
  }
  const quit = (): void => {
    process.stdin.setRawMode(false)
    process.stdout.write('\u001b[?25h\n')
    process.exit(0)
  }
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdout.write('\u001b[?25l')
  process.stdin.on('data', (chunk: string) => {
    const pressed = press(state, keyName(chunk))
    state = pressed.state
    if (pressed.isQuit) quit()
    if (pressed.isHtml) {
      openHtml(note => {
        state = { ...state, note }
        draw()
      })
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
