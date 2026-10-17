// The Agent Board for any terminal and any agent, without Claude Code: `node agent-board.mjs`
// prints the board once, `--watch` keeps it on screen, `--html` writes progress.html and
// opens it. `/progress connect` writes the bundled copy of this file beside progress.md
// (scripts/build-board.ts bundles it into hooks/board-script.ts), with the progress file
// and language the Claude Code session uses set on its first line. It only reads.
import { execFile } from 'node:child_process'
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { boardText, peekInbox } from '../hooks/board'
import { LOG_TAIL } from '../hooks/inbox'
import { dashboardHtml } from '../hooks/dashboard'
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

const view = () => buildView(parseProgress(read(path)), [basename(process.cwd())], null, Date.now(), 0, {}, s)

const pad = (n: number): string => String(n).padStart(2, '0')

const draw = (): string =>
  boardText(view(), pending(), s, {
    width: Math.max(40, Math.min(process.stdout.columns || 80, 120)),
    isColor: process.stdout.isTTY === true && !process.env.NO_COLOR && !args.includes('--no-color'),
  })

if (args.includes('--html')) {
  const now = new Date()
  const stamp = s.dashStamp(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`)
  const html = path.replace(/\.md$/i, '') + '.html'
  writeFileSync(html, dashboardHtml(view(), s, path, stamp))
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', html]] : process.platform === 'darwin' ? ['open', [html]] : ['xdg-open', [html]]
  execFile(opener[0] as string, opener[1] as string[], error => process.stdout.write(`${error ? s.windowFailed(html) : s.windowOpened(html)}\n`))
} else if (args.includes('--watch')) {
  const tick = () => process.stdout.write(`\u001b[2J\u001b[H${draw()}\n${s.boardWatching}\n`)
  tick()
  setInterval(tick, 2000)
} else {
  process.stdout.write(draw())
}
