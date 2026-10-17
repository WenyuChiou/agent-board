import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { RenderSurface } from 'claude-code'

import type { ProgressAnswer, ProgressMirror, ProgressPr, ProgressSnapshot } from '../types'
import {
  addManualTask,
  extractAutoBlock,
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
  cleanContext,
  cleanTitle,
  clip,
  completedSince,
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
import { langOf, resolveLang, STRINGS } from './strings'
import { answerTurns, applyDigest, clearAsked, cleanHandoff, isWork, lastQuestion, markAsked, needsRefresh, parseDigest, turnTools } from './digest'
import type { Digest } from './digest'
import { agentHooks, DELETE, reporterPs1, reporterSh, withoutSection } from './connect'
import { inboxOrder, isInboxFile, isTranscriptPath, readTurn, transcriptTail } from './inbox'
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
const archivePath = (path: string, now: number): string => `${path.replace(/\.md$/i, '')}-archive-${localDay(now).slice(0, 7)}.md`

// Where other agents' hooks leave their turns: a folder beside progress.md.
const inboxPath = (path: string): string => {
  const sep = path.includes('\\') ? '\\' : '/'

  return `${path.replace(/[\\/][^\\/]*$/, '')}${sep}progress-inbox`
}

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
  const argv = path.includes('\\')
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

// This session's block, written over whatever is there now; read again afterwards so a
// write that raced another session's is retried instead of lost.
const writeMine = async ($: EngineInterface): Promise<void> => {
  const mirror = await read($, mine)
  if (mirror === null) return
  const path = await progressPath($)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await readText($, path)
    // Zero bytes from a file the last poll saw with content is most likely another write
    // caught half-way: look again rather than write a file holding only this block.
    if (before === '' && (await read($, snapshot)).size > 0) {
      await poll($)
      continue
    }
    const after =
      mirror.tasks.length === 0 ? removeAutoBlock(before, mirror.sessionId) : upsertAutoBlock(before, mirror, await wordsOf($))
    if (after === before) break
    await $.fs.write(path, after)
    const check = await readText($, path)
    if (extractAutoBlock(check, mirror.sessionId) === extractAutoBlock(after, mirror.sessionId)) break
  }
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
  const asked = await $.model
    .complete({
      model: 'haiku',
      maxTokens: 120,
      effort: 'low',
      prompt: (await wordsOf($)).namePrompt(mirror.firstPrompt.slice(0, 1200), steps),
    })
    .catch(() => undefined)
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
  const asked = await $.model
    .complete({
      model: 'haiku',
      maxTokens: 120,
      effort: 'low',
      prompt: s.refreshPrompt(mirror.firstPrompt.slice(0, 1200), steps, mirror.title || fallbackTitle(mirror), mirror.context),
    })
    .catch(() => undefined)
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
  const asked = await $.model
    .complete({
      model: 'haiku',
      maxTokens: 300,
      effort: 'low',
      prompt: s.digestPrompt(
        mirror.firstPrompt.slice(0, 1200),
        prompt.slice(0, 1200),
        answer.slice(-3000),
        mirror.title,
        mirror.context,
        steps,
      ),
    })
    .catch(() => undefined)
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
// the store, so whichever open session reads the next turn carries on from it.
const takeAgentTurns = async ($: EngineInterface, turns: readonly AgentTurn[]): Promise<void> => {
  const last = turns.at(-1)
  if (last === undefined) return
  const at = await $.clock.now()
  const stored = (await $.store.get(`agent:${last.id}`)) as Partial<ProgressMirror> | undefined
  const fresh = emptyMirror(last.id, last.project || (await wordsOf($)).uncategorized, at, last.cwd, last.agent)
  let mirror: ProgressMirror = { ...fresh, ...stored, firstPrompt: stored?.firstPrompt || turns.find(one => one.prompt !== '')?.prompt || '' }
  for (const turn of turns) {
    if (turn.event !== 'turn') continue
    let { prompt, answer } = turn
    // Codex's Stop carries the reply but not the request; the session log has both.
    if ((answer === '' || prompt === '') && isTranscriptPath(turn.transcript)) {
      const log = await $.fs.read(turn.transcript).catch(() => '')
      const tail = transcriptTail(typeof log === 'string' ? log : '')
      answer = answer || tail.answer
      prompt = prompt || tail.prompt
    }
    if (mirror.firstPrompt === '' && prompt !== '') mirror = { ...mirror, firstPrompt: prompt }
    if (answer === '' || answer.trim() === mirror.lastAnswer) continue
    mirror = answerTurns(mirror)
    mirror = { ...((await summarize($, mirror, prompt, answer)) ?? mirror), lastAnswer: answer.trim() }
  }
  if (mirror.tasks.length === 0) return
  const state = isAllDone(mirror) ? 'done' : last.event === 'end' ? 'ended' : 'waiting'
  mirror = { ...mirror, state, updated: at }
  await $.store.set(`agent:${last.id}`, mirror)
  const s = await wordsOf($)
  const written = mirror
  await enqueue(async () => {
    const path = await progressPath($)
    const before = await readText($, path)
    const after = upsertAutoBlock(before, written, s)
    if (after !== before) await $.fs.write(path, after)
    await poll($)
  })
}

// `/progress connect`: the reporter script beside progress.md, and a hook for it in every
// agent installed here. Its AGENTS.md-style section goes, so its work does not show twice.
// `remove` takes all of it back out. Files that are not JSON are named and left alone.
const connectAgents = async ($: EngineInterface, remove: boolean): Promise<string> => {
  const s = await wordsOf($)
  const path = await progressPath($)
  const isWindows = path.includes('\\')
  const sep = isWindows ? '\\' : '/'
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/[\\/]+$/, '')
  const codexHome = ((await $.env.get('CODEX_HOME')) ?? '').replace(/[\\/]+$/, '') || [home, '.codex'].join(sep)
  const grokHome = ((await $.env.get('GROK_HOME')) ?? '').replace(/[\\/]+$/, '') || [home, '.grok'].join(sep)
  const hermesHome = ((await $.env.get('HERMES_HOME')) ?? '').replace(/[\\/]+$/, '') || [home, '.hermes'].join(sep)
  const script = `${path.replace(/[\\/][^\\/]*$/, '')}${sep}progress-report.${isWindows ? 'ps1' : 'sh'}`
  if (!remove) await $.fs.write(script, isWindows ? reporterPs1(inboxPath(path)) : reporterSh(inboxPath(path)))
  const done: string[] = []
  const skipped: string[] = []
  const removeFile = async (file: string): Promise<void> => {
    const argv = isWindows ? ['powershell', '-NoProfile', '-Command', `Remove-Item -Force -LiteralPath '${file.replace(/'/g, "''")}'`] : ['rm', '-f', file]
    await $.process.run(argv, { timeoutMs: 10000 }).catch(() => undefined)
  }
  for (const hook of agentHooks({ home, sep, isWindows, script, inbox: inboxPath(path), codexHome, grokHome, hermesHome })) {
    if (!(await $.fs.exists(hook.dir))) continue
    // Left under the plugin's earlier name, it would report every turn a second time.
    const hadOld = hook.old !== undefined && (await $.fs.exists(hook.old))
    if (hadOld && hook.old !== undefined) await removeFile(hook.old)
    const before = await readText($, hook.file).catch(() => null)
    if (before === null) {
      skipped.push(s.connectSkipped(hook.label, hook.file))
      continue
    }
    if (remove && before.trim() === '') {
      if (hadOld) done.push(hook.label)
      continue
    }
    const after = hook.edit(before, remove)
    if (after === null) {
      if (!remove) skipped.push(s.connectSkipped(hook.label, hook.file))
      continue
    }
    if (after === DELETE) {
      await removeFile(hook.file)
    } else if (after !== before) {
      await $.fs.write(hook.file, after)
    }
    if (remove && after === before && !hadOld) continue
    done.push(hook.label)
    if (!remove) await dropSection($, hook.agent, home, codexHome, sep)
  }
  const lines = remove
    ? [done.length === 0 ? s.connectNothingRemoved : s.connectRemoved(done.join(s.listSep))]
    : [done.length === 0 ? s.connectNone : s.connectDone(done.join(s.listSep)), ...(done.includes('Codex') ? [s.connectCodexTrust] : []), ...(done.includes('Hermes Agent') ? [s.connectHermesTrust] : [])]

  return [...lines, ...skipped].join('\n')
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

// New files in the inbox, each taken by one open session: it stamps the file in the store,
// looks again, and reads it only if its stamp stayed. The reporter script clears old files.
const drainInbox = async ($: EngineInterface): Promise<void> => {
  if (isDraining) return
  isDraining = true
  try {
    const dir = inboxPath(await progressPath($))
    // A file landing in the folder moves its modified time; nothing to read until it does.
    // On a file system that keeps whole seconds, a file can land in the same second as the
    // last listing: the folder is listed again while its time is that fresh.
    const stat = await $.fs.stat(dir).catch(() => undefined)
    if (stat === undefined) return
    if (stat.mtimeMs === inboxSeen && (await $.clock.now()) - stat.mtimeMs > 2000) return
    inboxSeen = stat.mtimeMs
    const entries = await $.fs.list(dir).catch(() => [])
    const stored = await $.store.get('inboxDone')
    const done = stored !== null && typeof stored === 'object' ? (stored as Record<string, string>) : {}
    const fresh = entries
      .filter(entry => entry.kind === 'file' && isInboxFile(entry.name) && done[entry.name] === undefined)
      .map(entry => entry.name)
      .sort(inboxOrder)
      .slice(0, 20)
    if (fresh.length === 0) return
    const at = await $.clock.now()
    const stamp = `${(await read($, mine))?.sessionId.slice(0, 8) ?? '-'}:${at}`
    const kept = Object.fromEntries(Object.entries(done).filter(([, value]) => at - Number(value.split(':')[1] ?? 0) < 3 * DAY))
    await $.store.set('inboxDone', { ...kept, ...Object.fromEntries(fresh.map(name => [name, stamp])) })
    const check = (await $.store.get('inboxDone')) as Record<string, string> | undefined
    const taken = fresh.filter(name => check?.[name] === stamp)
    const sep = dir.includes('\\') ? '\\' : '/'
    const turns: AgentTurn[] = []
    for (const name of taken) {
      const body = await $.fs.read(`${dir}${sep}${name}`).catch(() => '')
      const turn = readTurn(name, typeof body === 'string' ? body : '')
      if (turn !== null) turns.push(turn)
    }
    const bySession = new Map<string, AgentTurn[]>()
    for (const turn of turns) bySession.set(turn.id, [...(bySession.get(turn.id) ?? []), turn])
    for (const group of bySession.values()) await takeAgentTurns($, group)
  } finally {
    isDraining = false
  }
}

// A compaction's summary made into one line for whoever takes over, kept in the block.
const writeHandoff = async ($: EngineInterface, summary: string): Promise<void> => {
  const mirror = await read($, mine)
  if (mirror === null || mirror.tasks.length === 0 || summary.trim() === '') return
  const s = await wordsOf($)
  const asked = await $.model
    .complete({ model: 'haiku', maxTokens: 160, effort: 'low', prompt: s.handoffPrompt(mirror.title || fallbackTitle(mirror), summary.slice(0, 6000)) })
    .catch(() => undefined)
  const line = asked?.isAnswered === true ? cleanHandoff(asked.text) : ''
  if (line === '') return
  await saveMine($, one => ({ ...one, handoff: line }), true)
  await queueWrite($)
}

// Old work moves to that month's archive file, so the file stays about what is open: done
// blocks after half a day, stopped ones after three, hand-kept tasks a day after the pane saw
// their last step ticked.
const archiveOld = async ($: EngineInterface): Promise<number> => {
  const path = await progressPath($)
  const text = await readText($, path)
  const mirror = await read($, mine)
  const keep = mirror === null ? undefined : shortId(mirror.sessionId)
  const at = await $.clock.now()
  const s = await wordsOf($)
  const blocks = takeArchivable(text, at, keep, s)
  const seen = await read($, doneSeen)
  const manual = takeManualDone(blocks.text, at, key => seen[key], s)
  const entries = [...blocks.entries, ...manual.entries]
  if (entries.length === 0) return 0
  const archive = archivePath(path, at)
  const past = await readText($, archive)
  const head = past.trim() === '' ? `${s.archiveTitle}\n\n` : past.replace(/\s*$/, '\n\n')
  await $.fs.write(archive, head + entries.join('\n\n') + '\n')
  await $.fs.write(path, manual.text)
  if (manual.keys.length > 0) {
    await update($, doneSeen, old => Object.fromEntries(Object.entries(old).filter(([key]) => !manual.keys.includes(key))))
    for (const key of manual.keys) await $.store.delete(key)
  }
  await poll($)

  return entries.length
}

// One task to the archive at the person's word, written the way archiveOld writes. False when
// it could not be found for sure, so the file is left as it was.
const archiveOne = async ($: EngineInterface, ref: TaskRef): Promise<boolean> => {
  const path = await progressPath($)
  const text = await readText($, path)
  const at = await $.clock.now()
  const s = await wordsOf($)
  const taken = takeTask(text, ref, at, s)
  if (taken === null) return false
  const archive = archivePath(path, at)
  const past = await readText($, archive)
  const head = past.trim() === '' ? `${s.archiveTitle}\n\n` : past.replace(/\s*$/, '\n\n')
  await $.fs.write(archive, head + taken.entries.join('\n\n') + '\n')
  await $.fs.write(path, taken.text)
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
      lines.push(auto.state === 'ended' ? s.othersEnded(task.title, open?.text ?? s.none, done, total) : s.othersHeld(task.title, done, total))
    }
  }
  if (lines.length === 0) return null

  return [s.othersHead, ...lines, s.othersTail].join('\n')
}

// Keeps the store to the last month of sessions.
const pruneStore = async ($: EngineInterface, at: number): Promise<void> => {
  for (const key of await $.store.keys()) {
    if (isStaleStoreKey(key, await $.store.get(key), at, 30 * DAY)) await $.store.delete(key)
  }
}

const takeOverPrompt = (row: TaskRow, s: Strings): string =>
  [
    s.takeOverHead(row.title, row.project, row.done, row.total),
    row.context === '' ? '' : s.resumeContext(row.context),
    row.handoff === '' ? '' : s.takeOverHandoff(row.handoff),
    row.left.length === 0 ? '' : s.takeOverLeft(row.left.join(s.stepSep)),
    s.takeOverTail,
  ]
    .filter(line => line !== '')
    .join('\n')

const handOverPrompt = (row: TaskRow, s: Strings): string =>
  [
    s.handOverHead(row.title, row.project),
    row.context === '' ? '' : s.handOverContext(row.context),
    row.next === null ? '' : s.handOverNext(row.next.step),
    s.handOverTail,
  ]
    .filter(line => line !== '')
    .join(' ')

// A press on 完成: the step is ticked in the file, by the person's own hand, and journaled
// like a step Claude finished.
const tickStep = async ($: EngineInterface, ref: StepRef): Promise<boolean> => {
  const path = await progressPath($)
  const before = await readText($, path)
  const after = setManualStep(before, ref, 'x')
  if (after !== before) await $.fs.write(path, after)
  await poll($)

  return after !== before
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
    const path = await progressPath($)
    const before = await readText($, path)
    await $.fs.write(path, addManualTask(before, entry, s))
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
  const chosen = resolveLang(options.language, await $.store.get('lang'), settings.language, await $.env.get('LANG'))
  await update($, lang, () => chosen)
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

      return { text: (await wordsOf($)).langSet }
    }
    const s = await wordsOf($)
    if (/^(整理|archive|tidy)$/i.test(arg)) {
      const moved = await enqueue(() => archiveOld($)).catch(() => null)
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
    if (connect !== null) return { text: await connectAgents($, connect[1] !== undefined) }
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
      await saveMine($, one => ({ ...one, firstPrompt: e.text.trim() }))
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
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } }).catch(() => undefined)
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
        enqueue(() => archiveOld($)).catch(() => undefined)
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
