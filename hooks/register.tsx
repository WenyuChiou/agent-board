import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { RenderSurface } from 'claude-code'

import type { ProgressAnswer, ProgressMirror, ProgressPr, ProgressSnapshot } from '../types'
import {
  addManualTask,
  extractAutoBlock,
  manualTaskCount,
  removeAutoBlock,
  setManualStep,
  shortId,
  takeArchivable,
  takeManualDone,
  takeTask,
  upsertAutoBlock,
} from './blocks'
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
  dataBlock,
  emptyMirror,
  fallbackTitle,
  isAllDone,
  fromTaskList,
  isStaleStoreKey,
  noticesOf,
  resumeNote,
  stateOf,
} from './mirror'
import type { ListedTask } from './mirror'
import { baseName, countSteps, doneKey, isHereProject, isTaskComplete, parseProgress } from './parse'
import type { ProgressProject } from '../types'
import { dashboardHtml } from './dashboard'
import { paletteFor } from './palette'
import { drawPane } from './pane'
import type { PaneActions, PaneModel, PaneUi } from './pane'
import { isQuickAdd, parseQuickAdd, quickAddWords } from './quick'
import type { Lang, Strings } from './i18n'
import { RULE_ID, RULES } from './rule'
import { chosenLang, langOf, resolveLang, STRINGS } from './strings'
import { answerTurns, applyDigest, clearAsked, cleanHandoff, isWork, lastQuestion, markAsked, needsRefresh, parseDigest, replyData, requestData, turnTools } from './digest'
import type { Digest } from './digest'
import { agentHooks, boardLangOf, boardScript, DELETE, hasOurHook, isWindowsHost, OPENCLAW_MIN, openclawPrinted, openclawSavedBy, openclawTooOld, psQuote, reporterPs1, reporterSh, withoutSection } from './connect'
import {
  ANSWER_KEEP,
  answerKey,
  inboxOrder,
  isInboxFile,
  isTakenFile,
  isTextLog,
  isTranscriptPath,
  keepInboxDone,
  promptKey,
  readTurn,
  takenName,
  isBoardTurn,
  transcriptTail,
  turnsToDigest,
} from './inbox'
import type { AgentTurn } from './inbox'
import { keepRecent, remindersOf } from './remind'
import { buildView, statusLine } from './view'
import type { StepRef, TaskRef, TaskRow } from './view'

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
// Whether the person picked that language (strings.ts chosenLang), rather than it coming from
// Claude Code's setting or LANG.
const isLangChosen = atom({ plugin: 'agent-board', key: 'isLangChosen' } as const, false)
// Which folded sections the person opened; kept across sessions in $.store.
const opened = atom({ plugin: 'agent-board', key: 'opened' } as const, [] as string[])
// When the pane first saw each hand-kept task done (by doneKey), to archive it a day later.
const doneSeen = atom({ plugin: 'agent-board', key: 'doneSeen' } as const, {} as Record<string, number>)

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
let isDraining = false
// Other agents' turns are summed up one session's files at a time, after the drain that took
// them has let go of the inbox.
let digests: Promise<unknown> = Promise.resolve()
// Set once this session has made sure the store has a record of the inbox (see drainInbox).
let hasInboxRecord = false
let inboxSeen = -1
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
const removeFiles = async ($: EngineInterface, files: readonly string[], isWin: boolean): Promise<void> => {
  if (files.length === 0) return
  const argv = isWin
    ? ['powershell', '-NoProfile', '-Command', `Remove-Item -Force -LiteralPath ${files.map(psQuote).join(',')}`]
    : ['rm', '-f', ...files]
  await $.process.run(argv, { timeoutMs: 10000 }).catch(() => undefined)
}

const removeEmptyDir = async ($: EngineInterface, dir: string, isWin: boolean): Promise<void> => {
  const argv = isWin ? ['powershell', '-NoProfile', '-Command', `[IO.Directory]::Delete(${psQuote(dir)})`] : ['rmdir', dir]
  await $.process.run(argv, { timeoutMs: 10000 }).catch(() => undefined)
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

type Completion = Awaited<ReturnType<EngineInterface['model']['complete']>>

// A model call that gives up after MODEL_MS, answering undefined as a failed call does.
const complete = ($: EngineInterface, request: Parameters<EngineInterface['model']['complete']>[0]): Promise<Completion | undefined> =>
  new Promise(resolve => {
    $.clock.after(MODEL_MS, () => resolve(undefined))
    $.model.complete(request).then(resolve, () => resolve(undefined))
  })

// Re-reads the file only when its mtime or size moved, so the 2s timer is a stat.
const poll = async ($: EngineInterface): Promise<void> => {
  if (isPolling) return
  isPolling = true
  try {
    const path = await progressPath($)
    const previous = await read($, snapshot)
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat === undefined) {
      if (!previous.isMissing || previous.path !== path) await update($, snapshot, () => ({ ...EMPTY, path }))
      return
    }
    const isSame = previous.path === path && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size
    if (isSame && previous.error === null && !previous.isMissing) return
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
      await noteDone($, projects)
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

// progress.html beside progress.md: the whole file's view, the same from every session, at
// most once a minute and only when it changed.
const writeDashboard = async ($: EngineInterface, force = false): Promise<string> => {
  const snap = await read($, snapshot)
  const at = await $.clock.now()
  const path = dashboardPath(snap.path || (await progressPath($)))
  if (!force && at - dashboardAt < 60 * 1000) return path
  const s = await wordsOf($)
  const view = buildView(snap.projects, [], null, at, await read($, today), await read($, doneSeen), s)
  const date = new Date(at)
  const html = dashboardHtml(view, s, snap.path, s.dashStamp(`${localDay(at)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`))
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
): Promise<string | null> => {
  let wrote: string | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await readText($, path)
    const after = await change(before)
    if (after === AGAIN) continue
    if (after === null || after === before) break
    await $.fs.write(path, after)
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
  const text = await readText($, journalPath(await progressPath($), at)).catch(() => '')
  countedDay = localDay(at)
  await update($, today, () => countDay(text, at))
}

// Finished steps, a line each in this month's journal.
const journal = ($: EngineInterface, entries: ReadonlyArray<Omit<JournalEntry, 'at'>>): Promise<void> =>
  enqueue(async () => {
    const at = await $.clock.now()
    const path = journalPath(await progressPath($), at)
    const before = await readText($, path)
    const s = await wordsOf($)
    const after = appendJournal(
      before,
      entries.map(entry => journalLine(entry, at, s)),
      s,
    )
    await $.fs.write(path, after)
    countedDay = localDay(at)
    await update($, today, () => countDay(after, at))
  }).catch(() => undefined)

// The theme as /config shows it; the palette follows it.
const readTheme = async ($: EngineInterface): Promise<void> => {
  const rows = await $.config.list().catch(() => [])
  const value = rows.find(row => row.key === 'theme')?.value
  await update($, theme, () => (typeof value === 'string' ? value : 'dark'))
}

// Saves the mirror for this session (the pane redraws) and across restarts ($.store). What
// changed is journaled and, when it needs the person, notified; `quiet` skips both, for a
// re-read of a list whose changes happened while the mod was not looking.
const saveMine = async (
  $: EngineInterface,
  change: (mirror: ProgressMirror) => ProgressMirror,
  quiet = false,
): Promise<void> => {
  const current = await read($, mine)
  if (current === null) return
  const next = change(current)
  await update($, mine, () => next)
  await $.store.set(`mirror:${next.sessionId}`, next)
  if (!quiet) {
    const finished = completedSince(current, next)
    const title = next.title || fallbackTitle(next)
    if (finished.length > 0) {
      journal(
        $,
        finished.map(task => ({ project: next.project, task: title, step: task.subject })),
      ).catch(() => undefined)
    }
    for (const text of noticesOf(current, next, await wordsOf($))) await notify($, text, next.project)
  }
  await refreshStatus($)
}

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
  const stored = (await $.store.get(`mirror:${sessionId}`)) as Partial<ProgressMirror> | undefined
  const fresh = emptyMirror(sessionId, await projectName($), await $.clock.now(), cwd)
  await update($, mine, () => (stored === undefined ? fresh : { ...fresh, ...stored, cwd: stored.cwd || cwd }))
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
    prompt: (await wordsOf($)).namePrompt(mirror.firstPrompt.slice(0, 1200), steps),
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
    prompt: s.refreshPrompt(mirror.firstPrompt.slice(0, 1200), steps, mirror.title || fallbackTitle(mirror), mirror.context),
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
const summarize = async ($: EngineInterface, mirror: ProgressMirror, prompt: string, answer: string): Promise<ProgressMirror | null> => {
  const s = await wordsOf($)
  const steps = mirror.tasks.map(task => `- [${task.status === 'completed' ? 'x' : ' '}] ${task.subject}`).join('\n')
  const asked = await complete($, {
    model: 'haiku',
    maxTokens: 300,
    effort: 'low',
    prompt: s.digestPrompt(requestData(mirror.firstPrompt), requestData(prompt), replyData(answer), mirror.title, mirror.context, steps),
  })
  const question = lastQuestion(answer)
  const parsed = asked?.isAnswered === true ? parseDigest(asked.text) : null
  const empty: Digest = { title: '', context: '', done: '', next: '', ask: '', why: '' }
  const digest: Digest = { ...empty, ...parsed }
  if (digest.ask === '' && question !== null) {
    digest.ask = clip(question, 48)
    digest.why = question
  }
  if (digest.done === '' && digest.next === '' && digest.ask === '' && mirror.source !== 'turns') return null

  return applyDigest(mirror, digest, await $.clock.now())
}

// A turn of this session, which keeps no Task list.
const digestTurn = async ($: EngineInterface, prompt: string, answer: string): Promise<void> => {
  const mirror = await read($, mine)
  if (mirror === null || (mirror.source === 'tasks' && mirror.tasks.length > 0)) return
  const summed = await summarize($, mirror, prompt, answer)
  if (summed === null) return
  await saveMine($, () => summed)
  await settle($)
}

// Another agent's turns, from its hook, written into its own block. Its mirror lives in
// the store, so whichever open session reads the next turn carries on from it. Only the
// last two turns of a burst are summed up by the model; the earlier ones just move on what
// the mirror remembers of the conversation.
// Another open session can take a later turn of the same agent session while this one
// waits on the model; whichever wrote second would drop the other's step. So the mirror is
// checked again just before writing, and when it moved, these turns are folded onto it once
// more (the fold skips a reply it has already seen).
const takeAgentTurns = async ($: EngineInterface, turns: readonly AgentTurn[], isRetry = false): Promise<void> => {
  const last = turns.at(-1)
  if (last === undefined) return
  const at = await $.clock.now()
  const stored = (await $.store.get(`agent:${last.id}`)) as Partial<ProgressMirror> | undefined
  const seen = JSON.stringify(stored ?? null)
  const fresh = emptyMirror(last.id, last.project || (await wordsOf($)).uncategorized, at, last.cwd, last.agent)
  const firstPrompt = promptKey(stored?.firstPrompt || turns.find(one => one.prompt !== '')?.prompt || '')
  let mirror: ProgressMirror = { ...fresh, ...stored, firstPrompt, lastAnswer: answerKey(stored?.lastAnswer ?? ''), resume: last.session }
  const digested = turnsToDigest(turns)
  for (const [index, turn] of turns.entries()) {
    if (turn.event !== 'turn') continue
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
      mirror = (await summarize($, mirror, prompt, answer)) ?? mirror
    }
    mirror = { ...mirror, lastAnswer: answerKey(answer) }
  }
  if (mirror.tasks.length === 0) return
  const state = isAllDone(mirror) ? 'done' : last.event === 'end' ? 'ended' : 'waiting'
  mirror = { ...mirror, state, updated: at }
  const s = await wordsOf($)
  const written = mirror
  let hasMoved = false
  await enqueue(async () => {
    if (!isRetry && JSON.stringify((await $.store.get(`agent:${last.id}`)) ?? null) !== seen) {
      hasMoved = true
      return
    }
    await $.store.set(`agent:${last.id}`, written)
    await rewrite(
      $,
      await progressPath($),
      before => upsertAutoBlock(before, written, s),
      (check, after) => extractAutoBlock(check, written.sessionId) === extractAutoBlock(after, written.sessionId),
    )
    await poll($)
  })
  if (hasMoved) await takeAgentTurns($, turns, true)
}

// `/progress connect`: the reporter script beside progress.md, and a hook for it in every
// agent installed here. Its AGENTS.md-style section goes, so its work does not show twice.
// `remove` takes all of it back out. Files that are not JSON are named and left alone.
// `auto` is the same connect run at a session's start: it counts only the agents it newly
// hooked in, and says nothing of a config it cannot read, so an unchanged machine hears
// nothing.
type ConnectMode = 'connect' | 'remove' | 'auto'

const connectAgents = async ($: EngineInterface, mode: ConnectMode): Promise<{ text: string; done: string[] }> => {
  const remove = mode === 'remove'
  const isAuto = mode === 'auto'
  const s = await wordsOf($)
  const path = await progressPath($)
  const isWin = await isWindows($, path)
  const sep = sepOf(path)
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/[\\/]+$/, '')
  const codexHome = ((await $.env.get('CODEX_HOME')) ?? '').replace(/[\\/]+$/, '') || [home, '.codex'].join(sep)
  const grokHome = ((await $.env.get('GROK_HOME')) ?? '').replace(/[\\/]+$/, '') || [home, '.grok'].join(sep)
  const hermesHome = ((await $.env.get('HERMES_HOME')) ?? '').replace(/[\\/]+$/, '') || [home, '.hermes'].join(sep)
  const openclawHome = ((await $.env.get('OPENCLAW_STATE_DIR')) ?? '').replace(/[\\/]+$/, '') || [home, '.openclaw'].join(sep)
  const script = `${path.replace(/[\\/][^\\/]*$/, '')}${sep}progress-report.${isWin ? 'ps1' : 'sh'}`
  const reporter = isWin ? reporterPs1() : reporterSh(inboxPath(path))
  if (!remove && (await readText($, script).catch(() => '')) !== reporter) await $.fs.write(script, reporter)
  // The board for every other agent: their board commands run it, and so can any terminal.
  const board = `${path.replace(/[\\/][^\\/]*$/, '')}${sep}agent-board.mjs`
  // The board script and the board commands are one set of files for every session here. A
  // language taken from Claude Code's setting or LANG can differ between two sessions (one
  // from the desktop app, one from a terminal), which would take turns rewriting them at each
  // start, so only a language the person picked replaces the one they hold: the one picked
  // now, else the one `/progress lang` last settled.
  const held = await readText($, board).catch(() => '')
  const fileLang = (await read($, isLangChosen)) ? s.lang : (langOf(await $.store.get('boardLang')) ?? langOf(boardLangOf(held)) ?? s.lang)
  const boardCode = boardScript(path, fileLang)
  if (!remove && held !== boardCode) await $.fs.write(board, boardCode)
  if (remove && (await $.fs.exists(board))) await removeFiles($, [board], isWin)
  const done: string[] = []
  const skipped: string[] = []
  const removeFile = (file: string): Promise<void> => removeFiles($, [file], isWin)
  const savedBy = remove ? null : openclawSavedBy(await readText($, [openclawHome, 'openclaw.json'].join(sep)).catch(() => ''))
  // A config no OpenClaw has saved yet (installed, never run) says nothing of its version,
  // so OpenClaw is asked, as it is when the config names one too old.
  const hasOpenclaw = !remove && (await $.fs.exists(openclawHome))
  const openclawOld =
    !hasOpenclaw || (savedBy !== null && openclawTooOld(savedBy) === null) ? null : await installedOpenclawOld($, isWin, savedBy ?? '')
  // Agents with a hook file that could not be written. OpenClaw's config entry loads its
  // plugin file, so when the plugin file fails, the entry is not written either.
  const failed = new Set<string>()
  for (const hook of agentHooks({ home, sep, isWindows: isWin, script, inbox: inboxPath(path), codexHome, grokHome, hermesHome, openclawHome, board, s: STRINGS[fileLang] })) {
    if (failed.has(hook.agent)) continue
    let isInstalled = false
    for (const dir of hook.dirs ?? [hook.dir]) isInstalled = isInstalled || (await $.fs.exists(dir))
    // Taking the hooks out goes by our own files, so one an earlier connect left where the
    // agent is not (or is no longer) found comes out too.
    if (remove) for (const file of [hook.file, ...(hook.old === undefined ? [] : [hook.old])]) isInstalled = isInstalled || (await $.fs.exists(file))
    if (!isInstalled) continue
    // One agent whose file cannot be written (a folder missing, a read-only file) is named and
    // passed over, so the agents after it are still hooked in.
    try {
      // Left under the plugin's earlier name, it would report every turn a second time.
      const hadOld = hook.old !== undefined && (await $.fs.exists(hook.old))
      if (hadOld && hook.old !== undefined) await removeFile(hook.old)
      const before = await readText($, hook.file).catch(() => null)
      if (before === null) {
        if (!isAuto && hook.label !== '') skipped.push(s.connectSkipped(hook.label, hook.file))
        continue
      }
      // An OpenClaw too old for our entry would not start with it in its config, so it is not
      // hooked in, and what an earlier connect put there comes back out.
      if (hook.agent === 'openclaw' && openclawOld !== null) {
        const after = before.trim() === '' ? null : hook.edit(before, true)
        if (after === DELETE) await removeFile(hook.file)
        else if (after !== null && after !== before) await $.fs.write(hook.file, after)
        const note = s.connectTooOld(hook.label, openclawOld, OPENCLAW_MIN)
        if (mode === 'connect' && !skipped.includes(note)) skipped.push(note)
        continue
      }
      if (remove && before.trim() === '') {
        if (hadOld) done.push(hook.label)
        continue
      }
      const after = hook.edit(before, remove)
      if (after === null) {
        if (mode === 'connect' && hook.label !== '') skipped.push(s.connectSkipped(hook.label, hook.file))
        continue
      }
      if (after === DELETE) {
        await removeFile(hook.file)
        // A skill is a folder of ours; an agent may complain of one left without its SKILL.md.
        // Only an empty folder goes, so anything the person added stays.
        if (/[\\/]SKILL\.md$/.test(hook.file)) await removeEmptyDir($, hook.file.replace(/[\\/][^\\/]*$/, ''), isWin)
      } else if (after !== before) {
        await $.fs.write(hook.file, after)
      }
      if ((remove || isAuto) && after === before && !hadOld) continue
      // A session that only brings our own hook up to date (a new timeout, say) does not
      // announce the agent as newly connected.
      // Taking our hooks out also drops empty lists, so whether that changes the text says
      // nothing; the reporter's name in the file does.
      // Codex and Hermes ask the person to approve a changed hook again, so those still say so.
      if (isAuto && hook.agent !== 'codex' && hook.agent !== 'hermes' && (hook.edit(before, true) === DELETE || hasOurHook(before))) continue
      // OpenClaw takes two files, a plugin and the config entry that loads it.
      if (hook.label === '' || done.includes(hook.label)) continue
      done.push(hook.label)
      // The old instructions section is only tidied away; the hook is in either way.
      if (!remove) await dropSection($, hook.agent, home, codexHome, sep).catch(() => undefined)
    } catch {
      // A board command (no label of its own) that cannot be written leaves the agent's hook
      // as it is: the board is an extra, the hook is what reports.
      if (hook.label !== '') failed.add(hook.agent)
      if (!isAuto) skipped.push(hook.label === '' ? s.connectBoardFailed(hook.file) : s.connectFailed(hook.label, hook.file))
    }
  }
  const trust = [...(done.includes('Codex') ? [s.connectCodexTrust] : []), ...(done.includes('Hermes Agent') ? [s.connectHermesTrust] : [])]
  // An agent found but left out is named below it, so "none found" would contradict that.
  const none = skipped.length === 0 ? [s.connectNone] : []
  const lines = remove
    ? [done.length === 0 ? s.connectNothingRemoved : s.connectRemoved(done.join(s.listSep))]
    : isAuto
      ? [s.autoConnected(done.join(s.listSep)), ...trust, s.boardEverywhere(board), s.autoConnectUndo]
      : done.length === 0
        ? [...none, s.boardEverywhere(board)]
        : [s.connectDone(done.join(s.listSep)), ...trust, s.boardEverywhere(board)]

  return { text: [...lines, ...skipped].join('\n'), done }
}

// An OpenClaw config can name a version older than the one installed, since an update leaves
// it as it was, so the installed OpenClaw has the last word; when it cannot be asked, the
// config's stands. The version when it is too old, else null.
const installedOpenclawOld = async ($: EngineInterface, isWin: boolean, savedBy: string): Promise<string | null> => {
  const argv = isWin ? ['cmd', '/c', 'openclaw', '--version'] : ['openclaw', '--version']
  const ran = await $.process.run(argv, { timeoutMs: 10000 }).catch(() => null)
  const printed = ran !== null && ran.exitCode === 0 ? openclawPrinted(ran.stdout) : null

  return openclawTooOld(printed ?? savedBy)
}

// Installing the plugin should be all it takes: each session hooks in any agent installed
// here that is not hooked in yet, an agent installed later included, and says so once. Once
// the person takes the hooks out with `/progress connect remove`, or turns the autoConnect
// option off, nothing is added behind their back.
const autoConnect = async ($: EngineInterface, options: PluginOptions): Promise<void> => {
  if (options.autoConnect === false || (await $.store.get('autoConnectOff')) === true) return
  const { text, done } = await connectAgents($, 'auto')
  if (done.length === 0) return
  const s = await wordsOf($)
  await update($, answer, () => ({ question: s.autoConnectTitle, text, isAsking: false }))
  await $.ui.notify(s.autoConnected(done.join(s.listSep)), { title: s.autoConnectTitle }).catch(() => undefined)
}

// The instruction files setup --agents writes the section into, per agent.
const dropSection = async ($: EngineInterface, agent: string, home: string, codexHome: string, sep: string): Promise<void> => {
  const files: Record<string, string[]> = {
    codex: [[codexHome, 'AGENTS.md'].join(sep), [codexHome, 'AGENTS.override.md'].join(sep)],
    gemini: [[home, '.gemini', 'GEMINI.md'].join(sep)],
    opencode: [[home, '.config', 'opencode', 'AGENTS.md'].join(sep)],
  }
  for (const file of files[agent] ?? []) {
    const text = await readText($, file).catch(() => '')
    const after = withoutSection(text)
    if (after !== text) await $.fs.write(file, after)
  }
}

// New files in the inbox, each taken by one open session: it renames the file to a name of
// its own, which only one rename can do, reads what it renamed, and deletes it once summed
// up. The inbox is let go of before the model is asked, so a slow answer never stops the
// next look. The reporter script clears files older than two days that no session took.
const drainInbox = async ($: EngineInterface): Promise<void> => {
  if (isDraining) return
  isDraining = true
  const taken: string[] = []
  const turns: AgentTurn[] = []
  let isWin = false
  try {
    const path = await progressPath($)
    const dir = inboxPath(path)
    isWin = await isWindows($, path)
    const sep = sepOf(dir)
    const stored = await $.store.get('inboxDone')
    const hasRecord = stored !== null && typeof stored === 'object'
    // A store with no record of the inbox (the first run, or the store of the plugin's
    // earlier name left behind) counts what is there now as read, so an upgrade does not
    // sum up two days of turns again.
    if (!hasRecord && !hasInboxRecord) {
      const names = (await $.fs.list(dir).catch(() => []))
        .filter(entry => entry.kind === 'file' && isInboxFile(entry.name))
        .map(entry => entry.name)
      const at = await $.clock.now()
      const stamp = `${(await read($, mine))?.sessionId.slice(0, 8) ?? '-'}:${at}`
      await $.store.set('inboxDone', keepInboxDone(Object.fromEntries(names.map(name => [name, stamp])), at))
      hasInboxRecord = true
      return
    }
    hasInboxRecord = true
    // A file landing in the folder moves its modified time; nothing to read until it does.
    // On a file system that keeps whole seconds, a file can land in the same second as the
    // last listing: the folder is listed again while its time is that fresh.
    const stat = await $.fs.stat(dir).catch(() => undefined)
    if (stat === undefined) return
    if (stat.mtimeMs === inboxSeen && (await $.clock.now()) - stat.mtimeMs > 2000) return
    inboxSeen = stat.mtimeMs
    const entries = await $.fs.list(dir).catch(() => [])
    const done = hasRecord ? (stored as Record<string, string>) : {}
    const at = await $.clock.now()
    // A file a session took and never deleted (it closed half-way) goes after a day.
    await removeFiles(
      $,
      entries.filter(entry => entry.kind === 'file' && isTakenFile(entry.name) && at - entry.mtimeMs > DAY).map(entry => `${dir}${sep}${entry.name}`),
      isWin,
    )
    const fresh = entries
      .filter(entry => entry.kind === 'file' && isInboxFile(entry.name) && done[entry.name] === undefined)
      .map(entry => entry.name)
      .sort(inboxOrder)
      .slice(0, 20)
    if (fresh.length === 0) return
    const session = (await read($, mine))?.sessionId.slice(0, 8) ?? '-'
    for (const name of fresh) {
      const to = `${dir}${sep}${takenName(name, session)}`
      if (!(await moveFile($, `${dir}${sep}${name}`, to, isWin))) continue
      taken.push(to)
      // Read at once: the model may keep the turn waiting, and a taken file is only safe
      // from the day-old sweep of another session while it is fresh.
      const body = await $.fs.read(to).catch(() => '')
      // One file that cannot be read must not stop the loop, or the files taken before it
      // wait a day for the sweep that deletes them unread.
      let turn: AgentTurn | null = null
      try {
        turn = readTurn(name, typeof body === 'string' ? body : '')
      } catch {
        turn = null
      }
      if (turn !== null) turns.push(turn)
    }
    if (taken.length === 0) return
    const stamp = `${session}:${at}`
    const names = fresh.filter(name => taken.includes(`${dir}${sep}${takenName(name, session)}`))
    await $.store.set('inboxDone', keepInboxDone({ ...done, ...Object.fromEntries(names.map(name => [name, stamp])) }, at)).catch(() => undefined)
  } finally {
    isDraining = false
  }
  if (taken.length === 0) return
  const job = digests.then(async () => {
    try {
      const bySession = new Map<string, AgentTurn[]>()
      for (const turn of turns.filter(one => !isBoardTurn(one))) bySession.set(turn.id, [...(bySession.get(turn.id) ?? []), turn])
      for (const group of bySession.values()) await takeAgentTurns($, group).catch(() => undefined)
    } finally {
      await removeFiles($, taken, isWin)
    }
  })
  digests = job.catch(() => undefined)
  await job
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
  await update($, isLangChosen, () => chosenLang(options.language, stored) !== null)
}

const setNotify = async ($: EngineInterface, isOn: boolean): Promise<void> => {
  await update($, isNotifyOn, () => isOn)
  if (isOn) await $.store.delete('notifyOff')
  else await $.store.set('notifyOff', true)
}

const settle = async ($: EngineInterface): Promise<void> => {
  const at = await $.clock.now()
  await saveMine($, mirror => ({ ...mirror, state: stateOf(mirror, isTurnRunning), updated: at }))
  await queueWrite($)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    knownPath = await findProgressPath($)
    await settleLang($, options)
    const words = await wordsOf($)
    await $.command.register({ name: 'progress', description: words.commandDescription, argumentHint: words.commandHint })
    await detectHere($)
    await loadMine($, e.cwd)
    await update($, isNotifyOn, () => true)
    if ((await $.store.get('notifyOff')) === true) await update($, isNotifyOn, () => false)
    await readTheme($)
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
    await autoConnect($, options).catch(() => undefined)
    const startedAt = await $.clock.now()
    await update($, now, () => startedAt)
    await pruneStore($, startedAt)
    // Work left running past a dispatch can outlive the module (a reload, the end): its
    // rejections are dropped rather than left unhandled.
    $.clock.every(POLL_MS, () => {
      poll($).catch(() => undefined)
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
      await $.store.set('boardLang', (await wordsOf($)).lang)
      await autoConnect($, options).catch(() => undefined)

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
    const connect = /^(?:connect|接上|连接|連接)\s*(remove|off|拿掉|去掉|移除)?$/i.exec(arg)
    if (connect !== null) {
      // Taking the hooks out also stops a session from putting them back; connecting again
      // lets it.
      const isRemove = connect[1] !== undefined
      if (isRemove) await $.store.set('autoConnectOff', true)
      else await $.store.delete('autoConnectOff')
      return { text: (await connectAgents($, isRemove ? 'remove' : 'connect')).text }
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

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    isTurnRunning = true
    turnPrompt = e.text.trim()
    const mirror = await read($, mine)
    if (mirror !== null && mirror.firstPrompt === '' && e.text.trim() !== '') {
      await saveMine($, one => ({ ...one, firstPrompt: promptKey(e.text) }))
    }
    // The person is answering: what waited on them from the last turn's question is settled.
    if (mirror !== null && (mirror.autoAsk !== null || mirror.source === 'turns')) {
      await saveMine($, one => answerTurns(clearAsked(one)), true)
    }
    if (mirror !== null && mirror.tasks.length > 0) {
      await settle($)
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
    isTurnRunning = false
    const mirror = await read($, mine)
    const question = e.isAborted ? null : lastQuestion(e.answer)
    if (mirror !== null && mirror.tasks.length > 0) {
      const branch = await branchName($)
      await saveMine($, one => ({ ...one, branch }))
      // A turn that ended on a question waits on the person even if Claude did not mark it.
      if (question !== null && mirror.source === 'tasks') await saveMine($, one => markAsked(one, question))
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
    // No Task list: a turn that changed something, or any turn once the session is tracked,
    // is summed up into steps.
    if (mirror !== null && !e.isAborted && (mirror.tasks.length === 0 || mirror.source === 'turns')) {
      const messages = await $.session.messages().catch(() => [])
      if (mirror.source === 'turns' || isWork(turnTools(messages))) {
        const prompt = turnPrompt
        $.clock.after(1, () => {
          digestTurn($, prompt, e.answer).catch(() => undefined)
        })
      }
    }
    $.clock.after(1, () => {
      refreshPr($).catch(() => undefined)
    })

    return next(e)
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
    const mirror = await read($, mine)
    if (mirror !== null && mirror.tasks.length > 0) {
      const at = await $.clock.now()
      const state = mirror.tasks.every(task => task.status === 'completed') ? 'done' : 'ended'
      await saveMine($, one => ({ ...one, state, updated: at }))
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
    const view = buildView(snap.projects, await read($, here), await read($, mine), at, await read($, today), await read($, doneSeen), s)
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
      opened: await read($, opened),
      answer: await read($, answer),
      path: snap.path,
      width: Math.max(8, Math.min(28, e.props.bodyColumns - 4)),
      hasTaskTools: await read($, hasTaskTools),
      isNotifyOn: await read($, isNotifyOn),
      isLegendOpen: await read($, isLegendOpen),
      palette,
      s,
    }
    const actions: PaneActions = {
      toggle: key => {
        update($, expanded, open => (open === key ? '' : key)).catch(() => undefined)
      },
      continueHere: () => {
        $.prompt.submit({ text: s.continueText }).catch(() => undefined)
      },
      archive: () => {
        enqueue(() => archiveOld($, true)).catch(() => undefined)
      },
      archiveRow: row => {
        const ref = row.archive
        if (ref === null) return
        enqueue(() => archiveOne($, ref))
          .then(isTaken =>
            update($, answer, () => ({ question: row.title, text: isTaken ? s.archivedOne(row.title) : s.archiveGone, isAsking: false })),
          )
          .then(() => update($, expanded, open => (open === row.key ? '' : open)))
          .catch(() => undefined)
      },
      takeOver: row => {
        $.prompt.submit({ text: takeOverPrompt(row, s) }).catch(() => undefined)
      },
      handOver: row => {
        $.prompt.submit({ text: handOverPrompt(row, s) }).catch(() => undefined)
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
        $.prompt
          .submit({ text: s.answerText(item.text, text) })
          .then(() => update($, answer, () => ({ question: item.text, text: s.answered(text), isAsking: false })))
          .catch(() => undefined)
      },
      copyCommand: (item, surface) => {
        if (item.command === null) return
        showCopied($, s.commandOf(item.text), item.command, surface).catch(() => undefined)
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
