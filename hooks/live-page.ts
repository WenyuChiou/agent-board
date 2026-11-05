import type { Strings } from './i18n'
import { sha256 } from './sha256.ts'

// A page /progress starts closes this long after its last open tab stops asking, so the link it
// leaves in a transcript does not keep working until the computer restarts.
export const LIVE_PAGE_IDLE_MINUTES = 30

// The board script /progress connect installs beside progress.md, for a Windows or a POSIX path.
export const liveBoardScript = (progress: string): string => progress.replace(/[^\\/]*$/, 'agent-board.mjs')

// What /progress runs where no pane can be placed: the installed board script starts its live page,
// or reuses the running one. An explicit open also asks the script to open the browser.
export const liveBoardArgv = (script: string, lang: string, isInteractive = false): string[] => [
  'node',
  script,
  '--serve',
  ...(isInteractive ? [] : ['--no-open']),
  '--quiet-board',
  '--idle-minutes',
  String(LIVE_PAGE_IDLE_MINUTES),
  '--lang',
  lang,
]

// The plugin publishes only the counts and processed filenames its separate page process needs.
export const pageStatePath = (progress: string): string => progress.replace(/[^\\/]*$/, 'progress-page-state.json')

// Each processed filename has immutable evidence, independent of the mutable counts snapshot.
export const pageDonePath = (progress: string, hash: string): string => pageStatePath(progress).replace(/\.json$/, `-done-${hash}.json`)
export const pageDoneHash = (name: string): string | null => /^progress-page-state-done-([a-f0-9]{64})\.json$/.exec(name)?.[1] ?? null
export const readPageDone = (text: string, hash: string): { name: string; stamp: string } | null => {
  if (sha256(text) !== hash) return null
  try {
    const value = JSON.parse(text) as { version?: unknown; name?: unknown; stamp?: unknown }
    if (value.version !== 1 || typeof value.name !== 'string' || !/^[^\\/]+\.json$/.test(value.name) || typeof value.stamp !== 'string' || !/^[^:]+:\d+$/.test(value.stamp)) return null
    return { name: value.name, stamp: value.stamp }
  } catch { return null }
}

type PageState = { inboxDone: Record<string, string>; store: number; pruned: unknown }

export const readPageState = (text: string, previous: PageState = { inboxDone: {}, store: 0, pruned: {} }): PageState => {
  try {
    const value = JSON.parse(text) as { version?: unknown; inboxDone?: unknown; store?: unknown; pruned?: unknown }
    const done = value.inboxDone
    if (value.version !== 1 || done === null || typeof done !== 'object' || Array.isArray(done) || Object.values(done).some(stamp => typeof stamp !== 'string') || typeof value.store !== 'number' || !Number.isFinite(value.store) || value.store < 0 || value.pruned === null || typeof value.pruned !== 'object' || Array.isArray(value.pruned)) return previous
    return {
      inboxDone: { ...done } as Record<string, string>,
      store: value.store,
      pruned: value.pruned,
    }
  } catch { return previous }
}

// The page /progress hands out, read from the script's output. Only a last line that is this
// language's address line, with a local address, is a link; any other output is data. `isKept`
// says the script kept an open page because a reply may still be on its way.
export const liveBoardPage = (stdout: string, s: Pick<Strings, 'serveAt' | 'serveKept'>): { url: string; isKept: boolean } | null => {
  const lines = stdout.trimEnd().split(/\r?\n/)
  const line = lines.at(-1) ?? ''
  const match = /http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/\?t=[A-Za-z0-9_-]+$/.exec(line)
  const url = match?.[0]
  if (url === undefined || Number(match?.[1]) > 65535 || line !== s.serveAt(url)) return null
  return { url, isKept: lines.slice(0, -1).includes(s.serveKept) }
}
