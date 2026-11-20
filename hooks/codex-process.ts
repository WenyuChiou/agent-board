// The Codex terminal process an event ran under (#1092, M7), as pure data: the walk
// up the parent chain, given what /proc says of each process. The board script
// reads /proc (scripts/session-liveness.ts); this module only decides.
//
// The layout is from docs/validation/2026-11-18-c1-codex-terminal-process.md. In
// process: the Codex terminal starts the hook's shell, which starts the hook
// worker, which starts the board script. On the shared server (`codex app-server`)
// the server runs the hook, so the chain never reaches this session's window, and
// the server outlives every window: a walk that reaches it names no process.

export type ProcEntry = { comm: string; ppid: number; argv: readonly string[] }
export type ProcRead = (pid: number) => ProcEntry | null

// The deepest chain the walk follows. The in-process chain is three or four
// steps; a longer one is not the layout C1 measured, so it names no process.
export const CODEX_WALK_DEPTH = 16

const baseName = (path: string): string => path.split('/').pop() ?? ''

// The Codex program itself: its command name and the program it runs are both
// `codex`. The npm launcher (node running codex.js), the hook's shell and any
// script named codex fail one of the two, so a process is never taken by a name.
const isCodexTerminal = (entry: ProcEntry): boolean => entry.comm === 'codex' && baseName(entry.argv[0] ?? '') === 'codex'

const isSharedServer = (entry: ProcEntry): boolean => entry.argv.includes('app-server')

// The pid of the Codex terminal above `start`, or null when the walk cannot name
// it for certain: an unreadable process, pid 1, a loop, a chain deeper than
// CODEX_WALK_DEPTH, or the shared server anywhere on the way.
export const codexTerminalPid = (start: number, read: ProcRead): number | null => {
  const seen = new Set<number>()
  let pid = start
  for (let depth = 0; depth < CODEX_WALK_DEPTH; depth += 1) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || seen.has(pid)) return null
    seen.add(pid)
    const entry = read(pid)
    if (entry === null || isSharedServer(entry)) return null
    if (isCodexTerminal(entry)) return pid
    pid = entry.ppid
  }
  return null
}

// One process from the text of /proc/<pid>/stat and /proc/<pid>/cmdline. The
// command name sits between the first '(' and the last ')', since it may hold
// spaces and brackets; the parent pid is the second field after it.
export const procEntryOf = (stat: string, cmdline: string): ProcEntry | null => {
  const open = stat.indexOf('(')
  const close = stat.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const ppid = Number(stat.slice(close + 2).trim().split(/\s+/)[1])
  if (!Number.isSafeInteger(ppid) || ppid < 0) return null
  return { comm: stat.slice(open + 1, close), ppid, argv: cmdline.split('\0').filter(one => one !== '') }
}
