import type { On } from 'claude-code'
import type { ProgressMirror } from '../../types'
import { emptyMirror } from '../../hooks/mirror'
import type { World } from './pane-world'

// A board the size of a busy machine's (#371), all made up: progress.md about 370 KB with 50
// projects, 250 tasks of which 220 are agent blocks (ten old enough to be archived at the next
// start) and 63 ask the person something, a plugin
// store of about 1.4 MB in the key shapes the plugin writes, and an inbox of 736 turn files.
// The same paths as pane-world's FILE and INBOX, kept here so the board can be built outside the
// test kit too (to time the pure modules on their own).
const FILE = '/home/me/.claude/progress.md'
const INBOX = '/home/me/.claude/progress-inbox'
export const BIG_AT = Date.parse('2026-10-16T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const AGENTS = ['codex', 'claude', 'antigravity', 'gemini', 'cursor', 'opencode'] as const
const WORDS = ['parser', 'ledger', 'pane', 'reporter', 'inbox', 'journal', 'archive', 'status', 'theme', 'release', 'install', 'bundle', 'review', 'trace', 'export', 'import', 'cache', 'retry', 'queue', 'index']

// Fixed, made-up words and ids, so every run builds the same board.
const word = (n: number): string => WORDS[n % WORDS.length] ?? 'step'
const hex = (n: number, length = 8): string => {
  let out = ''
  let seed = Math.imul(n + 1, 0x9e3779b1)
  while (out.length < length) {
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), seed | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    out += ((x ^ (x >>> 14)) >>> 0).toString(16).padStart(8, '0')
  }
  return out.slice(0, length)
}
const uuid = (n: number): string => `${hex(n, 8)}-${hex(n + 7919, 4)}-4${hex(n + 15838, 3)}-8${hex(n + 23757, 3)}-${hex(n + 31676, 12)}`
const sentence = (n: number, length: number): string => {
  const parts: string[] = []
  for (let i = 0, size = -1; size < length; i++) {
    const one = word(n * 7 + i * 3)
    parts.push(one)
    size += one.length + 1
  }
  return parts.join(' ')
}
const stamp = (at: number): string => new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')

export type BigBoard = { source: string; store: Record<string, unknown>; inbox: Array<[string, string]>; waiting: number; waitingNow: number; tasks: number; blocks: number; archivable: number }

export const bigBoard = (at = BIG_AT): BigBoard => {
  const projects = Array.from({ length: 50 }, () => [] as string[])
  let waiting = 0
  let tasks = 0
  let blocks = 0
  let archivable = 0
  // Questions from sessions that wrote in the last twelve hours: the rest are stopped sessions,
  // which the line under the prompt does not count.
  let waitingNow = 0
  for (let i = 0; i < 250; i++) {
    const project = i % 50
    const steps: string[] = []
    const isBlock = i < 220
    const isAsking = isBlock && i % 7 < 2 && waiting < 63
    for (let s = 0; s < 11; s++) steps.push(`- [${s < 6 ? 'x' : s === 6 ? '~' : ' '}] ${sentence(i * 13 + s, 96)} ${s}`)
    if (isAsking) {
      steps[7] = `- [?] ${sentence(i * 17, 60)} ${i} — Publish the ${word(i)} change to the synthetic staging board, OK?`
      waiting += 1
    }
    const title = `Synthetic ${word(i)} ${word(i + 3)} work ${i}`
    const context = `> Context: ${sentence(i * 5, 120)}`
    if (isBlock) {
      const agent = AGENTS[i % AGENTS.length] ?? 'codex'
      // About the mix of a busy board: a fifth done, near half ended, the rest waiting or at work.
      const kind = i % 20
      const state = isAsking ? 'waiting' : kind < 4 ? 'done' : kind < 13 ? 'ended' : kind < 19 ? 'waiting' : 'working'
      // A few finished long enough ago to be archived at the next start; the rest stay.
      const isOld = !isAsking && i % 16 === 3
      // A question stays an hour or more off the 12 h line past which it is no longer counted, so
      // the count does not hang on the seconds between building the board and reading it.
      const hours = isAsking && i % 40 <= 12 ? Math.min(i % 40, 11) : i % 40
      const updated = isOld ? at - 4 * 24 * HOUR : state === 'done' ? at - (i % 11) * HOUR : at - hours * HOUR
      if (isOld) archivable += 1
      if (isAsking && at - updated <= 12 * HOUR) waitingNow += 1
      const session = hex(i)
      const resume = agent === 'claude' ? ` resume=${uuid(i)}` : ''
      projects[project]?.push([
        `<!-- auto session=${session} agent=${agent} state=${state} updated=${stamp(updated)}${resume} dir=/work/project-${project} -->`,
        `### ${title}`,
        context,
        ...steps,
        `<!-- /auto session=${session} -->`,
      ].join('\n'))
      blocks += 1
    } else {
      projects[project]?.push([`### ${title}`, context, ...steps].join('\n'))
    }
    tasks += 1
  }
  const source = ['# Progress', '', ...projects.flatMap((items, n) => [`## project-${n}`, '', ...items.flatMap(item => [item, ''])])].join('\n')

  const store: Record<string, unknown> = { inboxDone: {}, autoConnectOff: true, closedByPerson: true, opened: ['others'] }
  const mirror = (id: string, n: number, agent: string): ProgressMirror => ({
    ...emptyMirror(id, `project-${n % 50}`, at - (n % 30) * HOUR, `/work/project-${n % 50}`, agent),
    title: `Synthetic mirror ${n}`,
    context: sentence(n, 120),
    firstPrompt: sentence(n + 1, 300),
    isTitleFinal: true,
    tasks: Array.from({ length: 9 }, (_, t) => ({ id: String(t + 1), subject: sentence(n * 3 + t, 100), status: t < 5 ? 'completed' : t === 5 ? 'in_progress' : 'pending', activeForm: sentence(n * 5 + t, 50), waiting: null, why: null, ask: null, options: [], command: null, link: null, blocked: null, blockedBy: [] })),
  })
  for (let n = 0; n < 194; n++) store[`agent:${hex(n + 1000)}`] = mirror(hex(n + 1000), n, AGENTS[n % AGENTS.length] ?? 'codex')
  for (let n = 0; n < 69; n++) store[`mirror:${uuid(n + 2000)}`] = mirror(uuid(n + 2000), n, 'claude')
  store['generated:/home/me/.claude/agent-board.mjs'] = sentence(1, 232000)
  for (let n = 0; n < 8; n++) store[`generated:/home/me/.synthetic-agent-${n}/board.md`] = sentence(n + 10, 640)
  const told: Record<string, number> = {}
  for (let n = 0; n < 3400; n++) told[`ask:${hex(n + 3000, 16)}:${word(n)}:${sentence(n, 16)}`] = at - (n % 48) * HOUR
  store.told = told
  for (let n = 0; n < 47; n++) store[`agentPrompt:${hex(n + 1000)}:${n}:${at - n * HOUR}`] = { at: at - n * HOUR, text: sentence(n, 40), order: n }
  for (let n = 0; n < 65; n++) store[`hinted:${uuid(n + 4000)}`] = at - (n % 20) * HOUR
  for (let n = 0; n < 23; n++) store[`done:project-${n}::Synthetic ${word(n + 220)} ${word(n + 223)} work ${n + 220}`] = at - n * HOUR

  const inbox: Array<[string, string]> = []
  const done: Record<string, string> = {}
  for (let n = 0; n < 736; n++) {
    const name = `${AGENTS[n % AGENTS.length] === 'claude' ? 'codex' : AGENTS[n % AGENTS.length]}-turn-${Math.floor((at - (735 - n) * 60000) / 1000)}-${n}.json`
    const body = JSON.stringify({ session_id: `synthetic-session-${n % 40}`, cwd: `/work/project-${n % 50}`, prompt: sentence(n, 300), last_assistant_message: sentence(n + 9, 900) })
    inbox.push([`${INBOX}/${name}`, body])
    // All but the newest few are taken already, as on a board that has run for days.
    if (n < 700) done[name] = `${hex(n + 5000)}:${at - (735 - n) * 60000}`
  }
  store.inboxDone = done

  return { source, store, inbox, waiting, waitingNow, tasks, blocks, archivable }
}

export const bigWorld = (at = BIG_AT): World => {
  const board = bigBoard(at)
  return { files: new Map([[FILE, board.source], ...board.inbox]), mtime: 1, hasTasks: true, store: board.store, at, env: { HOME: '/home/me', LANG: 'en_US.UTF-8' } }
}


// Engine calls that go to the host and back. In Claude Code each is a message to the host and
// its answer, so the hooks worker answers its heartbeat while one is out; between two of them
// the module's own code runs without a break. The store, the clock and the environment are left
// out, so the measure holds even where those answer inside the worker.
const HOST_CALLS = /^(fs|process|ui|command|tool|model|session|settings)\./

// `entered` is when the module made its first engine call of any kind, so loading the module
// (which the test kit does on the first event) is not counted; `firstCommand` is when `/progress`
// was registered, after that. `longest` is the longest time between two host calls from then on.
export type Stretches = {
  entered: number | null
  firstCommand: number | null
  longest: number
  at: string
  calls: number
  top: Array<[number, string]>
  trace: Array<[number, string]>
}

// Waits in real time until no host call has come for `quietMs`, so the work a session start
// leaves running (archiving, connecting the agents) is timed to its end too.
export const untilQuiet = async (stretches: Stretches, quietMs = 1000, capMs = 180000): Promise<void> => {
  const started = performance.now()
  let before = -1
  while (stretches.calls !== before && performance.now() - started < capMs) {
    before = stretches.calls
    await new Promise(resolve => setTimeout(resolve, quietMs))
  }
}

// Wraps `on` so every engine call the module makes beneath it is timed, until `stop`.
export const timeStretches = (on: On): { on: On; stretches: Stretches; begin: () => void; stop: () => void } => {
  let last = 0
  let lastName = ''
  let isTiming = false
  const stretches: Stretches = { entered: null, firstCommand: null, longest: 0, at: '', calls: 0, top: [], trace: [] }
  let started = 0
  const seen = (name: string): void => {
    if (!isTiming) return
    const now = performance.now()
    if (stretches.trace.length < 5000) stretches.trace.push([now - started, name])
    if (stretches.entered === null) {
      stretches.entered = now - started
      last = now
      lastName = name
    }
    if (!HOST_CALLS.test(name)) return
    if (now - last > stretches.longest) {
      stretches.longest = now - last
      stretches.at = `${lastName} → ${name}`
    }
    stretches.top = [...stretches.top, [now - last, `${lastName} → ${name}`] as [number, string]].sort((a, b) => b[0] - a[0]).slice(0, 8)
    if (name === 'command.register' && stretches.firstCommand === null) stretches.firstCommand = now - started - stretches.entered
    stretches.calls += 1
    last = now
    lastName = name
  }
  const timed = ((...args: unknown[]) => {
    const name = args[0]
    const handler = args.at(-1)
    if (typeof name !== 'string' || typeof handler !== 'function') return Reflect.apply(on, undefined, args)
    return Reflect.apply(on, undefined, [...args.slice(0, -1), (...inner: unknown[]) => {
      const event = inner[1] as { path?: unknown; argv?: unknown; key?: unknown } | undefined
      const detail = typeof event?.path === 'string' ? ` ${event.path.split(/[\\/]/).pop()}` : Array.isArray(event?.argv) ? ` ${String(event.argv[0])}` : typeof event?.key === 'string' ? ` ${event.key.slice(0, 24)}` : ''
      seen(`${name}${detail}`)
      return Reflect.apply(handler, undefined, inner)
    }])
  }) as On
  return {
    on: timed,
    stretches,
    // Timing can stop while the test waits and begin again: the wait is the test's, not the module's.
    begin: () => {
      if (started === 0) started = performance.now()
      if (stretches.entered !== null) last = performance.now()
      isTiming = true
    },
    stop: () => { isTiming = false },
  }
}
