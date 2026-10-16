import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RenderSurface } from 'claude-code'

import type { ProgressAnswer, ProgressMirror, ProgressPr, ProgressSnapshot } from '../types'
import {
  addManualTask,
  extractAutoBlock,
  removeAutoBlock,
  setManualStep,
  shortId,
  takeArchivable,
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
  completedSince,
  emptyMirror,
  fallbackTitle,
  fromTaskList,
  isStaleStoreKey,
  noticesOf,
  resumeNote,
  stateOf,
} from './mirror'
import type { ListedTask } from './mirror'
import { baseName, countSteps, isHereProject, isTaskComplete, parseProgress } from './parse'
import { paletteFor } from './palette'
import { drawPane } from './pane'
import type { PaneActions, PaneModel, PaneUi } from './pane'
import { isQuickAdd, parseQuickAdd, quickAddWords } from './quick'
import { RULE, RULE_ID } from './rule'
import { buildView, statusLine } from './view'
import type { StepRef, TaskRow } from './view'

const PANE = 'project-progress'
const TITLE = '進度'
const POLL_MS = 2000
const TICK_MS = 30 * 1000
// How often a pull request whose checks are still running is looked at again.
const PR_MS = 2 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

const EMPTY: ProgressSnapshot = { path: '', isMissing: true, error: null, mtimeMs: 0, size: 0, projects: [] }

const snapshot = atom({ plugin: 'project-progress', key: 'snapshot' } as const, EMPTY)
const here = atom({ plugin: 'project-progress', key: 'here' } as const, [] as string[])
const mine = atom({ plugin: 'project-progress', key: 'mine' } as const, null as ProgressMirror | null)
const now = atom({ plugin: 'project-progress', key: 'now' } as const, 0)
const hasTaskTools = atom({ plugin: 'project-progress', key: 'hasTaskTools' } as const, true)

const expanded = atom({ plugin: 'project-progress', key: 'expanded' } as const, '')
const answer = atom({ plugin: 'project-progress', key: 'answer' } as const, null as ProgressAnswer | null)
const isNotifyOn = atom({ plugin: 'project-progress', key: 'isNotifyOn' } as const, true)
// The person's /config theme, which picks the dark or light 和色 set.
const theme = atom({ plugin: 'project-progress', key: 'theme' } as const, 'dark')
// Steps finished today, from the journal.
const today = atom({ plugin: 'project-progress', key: 'today' } as const, 0)
const isLegendOpen = atom({ plugin: 'project-progress', key: 'isLegendOpen' } as const, false)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

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

// CLAUDE_PROGRESS_FILE wins; otherwise ~/.claude/progress.md. USERPROFILE comes first
// because that is where Claude Code keeps ~/.claude on Windows even when HOME is set
// (Git Bash, MSYS); it is unset on macOS and Linux.
const progressPath = async ($: EngineInterface): Promise<string> => {
  const explicit = await $.env.get('CLAUDE_PROGRESS_FILE')
  if (explicit !== undefined && explicit !== '') return explicit
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/[\\/]+$/, '')
  const sep = home.includes('\\') ? '\\' : '/'

  return [home, '.claude', 'progress.md'].join(sep)
}

// One archive file per month (progress-archive-2026-10.md), so none grows past what one
// read can hold.
const archivePath = (path: string, now: number): string =>
  `${path.replace(/\.md$/i, '')}-archive-${new Date(now).toISOString().slice(0, 7)}.md`

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
      await refreshStatus($)
    } catch (error) {
      await update($, snapshot, () => ({ ...EMPTY, path, isMissing: false, error: messageOf(error) }))
    }
  } finally {
    isPolling = false
  }
}

// The line under the prompt, for when the pane is not on screen; written only when it
// changes.
const refreshStatus = async ($: EngineInterface): Promise<void> => {
  const text = isPaneOpen
    ? undefined
    : statusLine(
        buildView((await read($, snapshot)).projects, await read($, here), await read($, mine), await $.clock.now(), await read($, today)),
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
    const after = mirror.tasks.length === 0 ? removeAutoBlock(before, mirror.sessionId) : upsertAutoBlock(before, mirror)
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
  await $.ui.notify(text, { title: `進度 · ${project}` }).catch(() => undefined)
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
    const after = appendJournal(before, entries.map(entry => journalLine(entry, at)))
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
    for (const text of noticesOf(current, next)) await notify($, text, next.project)
  }
  await refreshStatus($)
}

// The project this session writes under: the remote's repo name, else the folder's.
const projectName = async ($: EngineInterface): Promise<string> => {
  const repo = await $.session.repo().catch(() => null)
  if (repo?.remote) return baseName(repo.remote).replace(/\.git$/, '')
  if (repo !== null) return baseName(repo.root)

  return baseName(await $.session.root().catch(() => '')) || '（未分類）'
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
    const finished = ciFinished(before, pr)
    if (finished !== null) await notify($, finished, mirror.project)
    if (mirror.tasks.length > 0) await queueWrite($)
  } finally {
    isCheckingPr = false
  }
}

const nameTask = async ($: EngineInterface): Promise<void> => {
  const mirror = await read($, mine)
  if (mirror === null || mirror.isTitleFinal || mirror.tasks.length === 0) return
  await saveMine($, one => ({ ...one, isTitleFinal: true, title: one.title || fallbackTitle(one) }))
  const steps = mirror.tasks.map(task => `- ${task.subject}`).join('\n')
  const asked = await $.model
    .complete({
      model: 'haiku',
      maxTokens: 120,
      effort: 'low',
      prompt:
        `使用者的需求：\n${mirror.firstPrompt.slice(0, 1200)}\n\n步驟：\n${steps}\n\n` +
        '回兩行，用使用者的語言（中文就用繁體中文），不要引號：\n' +
        '第一行：這件工作的名稱，4 到 14 個字，像待辦清單的標題：白話、具體、說出要做成什麼，不要標點。\n' +
        '第二行：一句 40 字以內的背景，給一個沒看過這段對話的人看：為什麼要做、做完會怎樣。',
    })
    .catch(() => undefined)
  const lines = asked?.isAnswered === true ? asked.text.split(/\r?\n/).filter(line => line.trim() !== '') : []
  const title = cleanTitle(lines[0] ?? '')
  const context = cleanContext(lines[1] ?? '')
  if (title === '' && context === '') return
  await saveMine($, one => ({ ...one, title: title || one.title, context: context || one.context }))
  await queueWrite($)
}

// Old finished blocks move to that month's archive file, so the file stays about what is open.
const archiveOld = async ($: EngineInterface): Promise<number> => {
  const path = await progressPath($)
  const text = await readText($, path)
  const mirror = await read($, mine)
  const keep = mirror === null ? undefined : shortId(mirror.sessionId)
  const { text: kept, entries } = takeArchivable(text, await $.clock.now(), keep)
  if (entries.length === 0) return 0
  const archive = archivePath(path, await $.clock.now())
  const past = await readText($, archive)
  const head = past.trim() === '' ? '# 進度封存\n\n' : past.replace(/\s*$/, '\n\n')
  await $.fs.write(archive, head + entries.join('\n\n') + '\n')
  await $.fs.write(path, kept)
  await poll($)

  return entries.length
}

// For a session's first turn: work in this project that other sessions left or hold.
const othersNote = async ($: EngineInterface): Promise<string | null> => {
  const names = await read($, here)
  const mirror = await read($, mine)
  const own = mirror === null ? '' : shortId(mirror.sessionId)
  const at = await $.clock.now()
  const lines: string[] = []
  for (const project of (await read($, snapshot)).projects) {
    if (!isHereProject(project.name, names)) continue
    for (const task of project.tasks) {
      const auto = task.auto
      if (auto === null || auto.session === own || auto.state === 'done' || isTaskComplete(task)) continue
      if (at - auto.updated > 7 * DAY) continue
      const { done, total } = countSteps(task)
      const open = task.steps.find(step => step.status !== 'done' && step.status !== 'cancelled')
      lines.push(
        auto.state === 'ended'
          ? `- 「${task.title}」對話已結束，停在：${open?.text ?? '（無）'}（完成 ${done}/${total}）`
          : `- 「${task.title}」另一個對話正在處理（完成 ${done}/${total}）`,
      )
    }
  }
  if (lines.length === 0) return null

  return [
    '[進度面板] 這個專案在 progress.md 裡還有其他對話的工作：',
    ...lines,
    '只有在使用者要接著做時才接手；接手時用 TaskCreate 重建剩下的步驟。不要重做另一個對話正在處理的事。',
  ].join('\n')
}

// Keeps the store to the last month of sessions.
const pruneStore = async ($: EngineInterface, at: number): Promise<void> => {
  for (const key of await $.store.keys()) {
    if (isStaleStoreKey(key, await $.store.get(key), at, 30 * DAY)) await $.store.delete(key)
  }
}

const takeOverPrompt = (row: TaskRow): string => {
  const left = row.left

  return [
    `接手「${row.title}」（${row.project}，之前的對話沒做完，完成 ${row.done}/${row.total}）。`,
    row.context === '' ? '' : `背景：${row.context}`,
    left.length === 0 ? '' : `剩下：${left.join('；')}`,
    '先用 TaskCreate 重建剩下的步驟，再從第一個沒做完的開始。',
  ]
    .filter(line => line !== '')
    .join('\n')
}

const handOverPrompt = (row: TaskRow): string =>
  [
    `幫我處理「${row.title}」（${row.project}）。`,
    row.context === '' ? '' : `背景：${row.context}。`,
    row.next === null ? '' : `下一步是「${row.next.step}」。`,
    `progress.md 裡這個任務的段落是目前的狀態，做完一步就在那裡打勾。`,
  ]
    .filter(line => line !== '')
    .join('')

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
  const forked = await $.model
    .fork({ prompt: `${text}\n\n（側邊面板的問題：用繁體中文、三句以內回答，不要動任何檔案。）` })
    .catch(() => undefined)
  const reply =
    forked?.isAnswered === true
      ? forked.text.trim()
      : forked?.reason === 'nothing-to-fork'
        ? '這個對話還沒開始，先跟 Claude 說一句話再問。'
        : '沒問到，再試一次。'
  // A slower answer to an earlier question is dropped rather than shown under a newer one.
  if (seq !== askSeq) return
  await update($, answer, () => ({ question: text, text: reply, isAsking: false }))
}

// A line from the pane's box that starts with +: a hand-kept task, written under its
// project. Without a `專案：` the session's repo is the project, or 待辦 outside one.
const quickAdd = async ($: EngineInterface, input: string): Promise<string> => {
  const repo = await $.session.repo().catch(() => null)
  const fallback = repo === null ? '待辦' : ((await read($, mine))?.project ?? '待辦')
  const entry = parseQuickAdd(input, fallback)
  if (entry === null) return '要加什麼？例如「+ 求職：Google 實習 截止 11-01；改履歷；投遞」。'
  const wrote = await enqueue(async () => {
    const path = await progressPath($)
    const before = await readText($, path)
    await $.fs.write(path, addManualTask(before, entry))
    await poll($)
  })
    .then(() => true)
    .catch(() => false)

  return wrote ? quickAddWords(entry) : '讀不到進度檔，沒有加進去。'
}

// What finished in the last `days` days (from the journal), what is open and what waits.
const buildReport = async ($: EngineInterface, days: number): Promise<string> => {
  const at = await $.clock.now()
  const path = await progressPath($)
  const months = [...new Set([journalPath(path, previousMonth(at)), journalPath(path, at)])]
  const texts = await Promise.all(months.map(one => readText($, one).catch(() => '')))

  return progressReport(texts.flatMap(parseJournal), (await read($, snapshot)).projects, await read($, mine), at, days)
}

// Shows `text` under the pane's box, copied to the clipboard when the surface allows.
const showCopied = async ($: EngineInterface, question: string, text: string, surface?: RenderSurface): Promise<void> => {
  const copied = await $.ui
    .copy(surface === undefined ? { text } : { text, surface })
    .then(result => result.isCopied)
    .catch(() => false)
  await update($, answer, () => ({ question, text, isAsking: false, copied }))
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: '進度面板：開啟；整理、同步、加 …、週報、今天、通知 開/關',
      argumentHint: '[整理|同步|加 …|週報|今天|通知 開/關]',
    })
    await detectHere($)
    await loadMine($, e.cwd)
    await update($, isNotifyOn, () => true)
    if ((await $.store.get('notifyOff')) === true) await update($, isNotifyOn, () => false)
    await readTheme($)
    await countToday($)
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
    $.clock.every(TICK_MS, () => {
      $.clock
        .now()
        .then(async at => {
          await update($, now, () => at)
          // A new day starts the count over.
          if (localDay(at) !== countedDay) await countToday($)
          await refreshStatus($)
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
    if ((await $.store.get('closedByPerson')) !== true) {
      $.ui
        .open({ id: PANE, title: TITLE })
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
    if (arg === '整理' || arg === 'archive') {
      const moved = await enqueue(() => archiveOld($)).catch(() => null)
      if (moved === null) return { text: '讀不到進度檔或封存檔，沒有動任何檔案。' }

      return { text: moved === 0 ? '沒有要封存的。' : `封存了 ${moved} 個完成的任務。` }
    }
    if (arg === '同步' || arg === 'sync') {
      await resync($)
      await settle($)
      await refreshPr($)

      return { text: '已從 Task 清單重新同步。' }
    }
    const add = /^(?:加|新增|add|[+＋])\s*(.*)$/is.exec(arg)
    if (add !== null) return { text: await quickAdd($, add[1] ?? '') }
    if (arg === '週報' || arg === '今天' || arg === 'report' || arg === 'today') {
      const text = await buildReport($, arg === '今天' || arg === 'today' ? 1 : 7)
      const copied = await $.ui
        .copy({ text })
        .then(result => result.isCopied)
        .catch(() => false)

      return { text: copied ? `${text}\n\n（已複製到剪貼簿）` : text }
    }
    const toggle = /^(?:通知|notify)\s*(開|關|on|off)?$/i.exec(arg)
    if (toggle !== null) {
      const word = toggle[1]?.toLowerCase()
      const isOn = word === undefined ? !(await read($, isNotifyOn)) : word === '開' || word === 'on'
      await setNotify($, isOn)

      return { text: isOn ? '桌面通知已打開：需要你、做完、CI 跑完時會通知。' : '桌面通知已關掉。' }
    }
    await poll($)
    await $.store.delete('closedByPerson')
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    isPaneOpen = opened.isPlaced
    await refreshStatus($)
    const { path } = await read($, snapshot)

    return { text: opened.isPlaced ? `進度面板已開啟：${path}` : `進度面板開不了：${opened.reason}` }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    isTurnRunning = true
    const mirror = await read($, mine)
    if (mirror !== null && mirror.firstPrompt === '' && e.text.trim() !== '') {
      await saveMine($, one => ({ ...one, firstPrompt: e.text.trim() }))
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
    if (mirror !== null && mirror.tasks.length > 0) {
      const branch = await branchName($)
      await saveMine($, one => ({ ...one, branch }))
      await settle($)
      if (!mirror.isTitleFinal) {
        $.clock.after(1, () => {
          nameTask($).catch(() => undefined)
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
    const note = mirror === null || e.agentId !== undefined ? null : resumeNote(mirror)
    if (note === null) return next(e)
    const keep = '保留 Task 清單上每一步的狀態，特別是正在做的那一步和還沒做的步驟。'
    const out = await next({ ...e, instructions: [e.instructions, keep].filter(Boolean).join('\n') })
    if (out.skip !== undefined || e.trigger === 'precompute') return out

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

    return { sections: [...composed.sections, { id: RULE_ID, text: RULE, scope: 'session' as const }] }
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
    const view = buildView(snap.projects, await read($, here), await read($, mine), at, await read($, today))
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
          <Text color="red">讀不到進度檔</Text>
          <Text dimColor>{snap.error}</Text>
          <Text dimColor wrap="truncate-start">
            {snap.path}
          </Text>
        </Box>
      )
    }
    const model: PaneModel = {
      view,
      expanded: await read($, expanded),
      answer: await read($, answer),
      path: snap.path,
      width: Math.max(8, Math.min(28, e.props.bodyColumns - 4)),
      hasTaskTools: await read($, hasTaskTools),
      isNotifyOn: await read($, isNotifyOn),
      isLegendOpen: await read($, isLegendOpen),
      palette: paletteFor(await read($, theme)),
    }
    const actions: PaneActions = {
      toggle: key => {
        update($, expanded, open => (open === key ? '' : key)).catch(() => undefined)
      },
      continueHere: () => {
        $.prompt.submit({ text: '繼續' }).catch(() => undefined)
      },
      archive: () => {
        enqueue(() => archiveOld($)).catch(() => undefined)
      },
      takeOver: row => {
        $.prompt.submit({ text: takeOverPrompt(row) }).catch(() => undefined)
      },
      handOver: row => {
        $.prompt.submit({ text: handOverPrompt(row) }).catch(() => undefined)
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
        showCopied($, `回到「${row.title}」的指令，貼到終端機執行`, row.resume, surface).catch(() => undefined)
      },
      report: surface => {
        buildReport($, 7)
          .then(text => showCopied($, '週報', text, surface))
          .catch(() => undefined)
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
