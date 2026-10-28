import { test, expect } from 'claude-code/testing'
import { groupBoard } from '../hooks/grouping'
import type { GroupingAsk, GroupingDone, GroupingInput, GroupingRetained, GroupingRow, GroupingTurn } from '../hooks/grouping'
import type { ServeModel } from '../hooks/serve'
import { EN } from '../hooks/strings-en'

const NOW = Date.parse('2026-10-28T12:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ago = (ms: number): number => NOW - ms

const row = (agent: string, project: string, title: string, over: Partial<GroupingRow> = {}): GroupingRow => ({
  key: `row:${project}::${title}`,
  project,
  title,
  context: '',
  status: 'Working',
  tone: 'quiet',
  when: '',
  agent,
  done: 0,
  total: 0,
  due: null,
  pr: '',
  steps: [],
  next: null,
  canArchive: false,
  canConfirm: false,
  archiveNote: '',
  resume: null,
  handoff: '',
  isAsking: false,
  question: '',
  send: 'none',
  session: '',
  fp: '',
  where: '',
  info: '',
  isSending: false,
  hasCopyBox: false,
  ...over,
})

const ask = (agent: string, project: string, task: string, text: string, over: Partial<GroupingAsk> = {}): GroupingAsk => ({
  key: `ask:${project}::${task}::1`,
  project,
  agent,
  task,
  text,
  note: '',
  context: '',
  kind: 'reply',
  chip: '',
  answers: [],
  command: null,
  link: null,
  canTick: false,
  canHide: false,
  archiveNote: '',
  send: 'none',
  session: '',
  fp: '',
  where: '',
  info: '',
  back: '',
  sessionId: null,
  reopen: null,
  isSending: false,
  ...over,
})

const retained = (agent: string, project: string, task: string, text: string, over: Partial<GroupingRetained> = {}): GroupingRetained => ({ key: `older:${project}::${task}::${text}`, canHide: false, project, agent, task, text, note: '', context: '', when: '', ...over })

const turn = (agent: string, project: string, text: string, isQuestion: boolean, over: Partial<GroupingTurn> = {}): GroupingTurn => ({ key: `turn:${agent}:${project}:${text.length}`, project, agent, text, isQuestion, info: '', ...over })

const done = (project: string, title: string, over: Partial<GroupingDone> = {}): GroupingDone => ({ project, title, when: '', ...over })

const board = (over: Partial<GroupingInput> = {}): GroupingInput => ({ asks: [], reminder: [], older: [], idle: [], stopped: [], groups: [], turns: [], recent: [], ...over })

// The page's groups: one per heading, in the order the headings first appear.
const grouped = (rows: GroupingRow[]): GroupingInput['groups'] => {
  const byProject = new Map<string, GroupingRow[]>()
  for (const one of rows) byProject.set(one.project, [...(byProject.get(one.project) ?? []), one])

  return [...byProject].map(([project, list]) => ({ project, rows: list }))
}

const none = (): null => null

const titles = (list: ReadonlyArray<{ title: string }>): string[] => list.map(one => one.title)

test('grouping puts every task and question under its agent with open, needs, stopped and done counts', () => {
  // An empty board has no agent group and nothing to show; the same model type the page builds is accepted as it is.
  const empty: ServeModel = { counts: { waiting: 0, active: 0, due: 0, today: 0 }, hidden: [], asks: [], reminder: [], older: [], idle: [], stopped: [], groups: [], turns: [], recent: [] }
  const nothing = groupBoard(empty, NOW, none, EN)
  expect(nothing.agents).toEqual([])
  expect(nothing.needs).toEqual({ n: 0, questions: 0, stuck: 0, cards: [], older: [] })
  expect(nothing.all.isHidden).toBe(true)
  expect(nothing.all.counts).toEqual({ open: 0, needs: 0, stopped: 0, done: 0, older: 0 })
  expect(nothing.own.counts).toEqual({ open: 0, needs: 0, stopped: 0, done: 0, older: 0 })
  expect(nothing.working).toEqual([])
  expect(nothing.projects).toEqual([])

  const claudeRows = [
    row('', 'demo', 'Draft the synthetic report', { at: ago(5 * MIN) }),
    row('', 'demo', '修正同步問題', { at: ago(3 * HOUR) }),
    // Same time, so the input order stands: sorting never looks at the words.
    row('', 'demo', 'Zulu synthetic', { at: ago(2 * DAY) }),
    row('', 'demo', 'Alpha synthetic', { at: ago(2 * DAY) }),
  ]
  const codexOpen = [row('codex', 'demo', 'Port the parser', { at: ago(10 * MIN) }), row('codex', 'demo', 'Write the notes', { at: ago(DAY) })]
  const model = board({
    asks: [ask('codex', 'demo', 'Port the parser', 'Merge the synthetic branch, OK?', { at: ago(MIN) }), ask('', 'Home', 'Pay the synthetic invoice', 'Which synthetic account?', { isOwn: true })],
    groups: grouped([...claudeRows, ...codexOpen, row('', 'Home', 'Pay the synthetic invoice', { isOwn: true, at: ago(HOUR) })]),
    stopped: [
      row('', 'demo', 'Old synthetic spike', { at: ago(6 * DAY) }),
      row('codex', 'demo', 'Retire the flag', { at: ago(4 * DAY) }),
      row('dot', 'demo', 'Review the synthetic card', { at: ago(DAY) }),
      row('Robo-7', 'demo', 'Idle synthetic helper', { at: ago(3 * DAY) }),
    ],
    idle: [row('codex', 'demo', 'Dormant branch', { at: ago(9 * DAY) })],
    recent: [
      // No agent: the model's own reading is Claude Code.
      done('demo', 'Ship the synthetic demo', { at: ago(HOUR) }),
      done('demo', 'Rename the synthetic module', { agent: 'codex', at: ago(2 * DAY) }),
      done('demo', 'Retired long ago', { agent: 'codex', at: ago(8 * DAY) }),
      done('Home', 'Call the synthetic plumber', { isOwn: true, at: ago(DAY) }),
    ],
    // Only the mark makes a group for an agent with no task.
    agents: [{ agent: 'cursor', unreadable: true }, { agent: 'gemini' }],
  })
  const result = groupBoard(model, NOW, none, EN)

  // Most recent activity first; an agent with nothing dated goes last, whatever its place in the input.
  expect(result.agents.map(group => group.agent)).toEqual(['codex', 'claude', 'dot', 'robo-7', 'cursor'])
  const [codex, claude, dot, robo, cursor] = result.agents
  expect(claude?.counts).toEqual({ open: 4, needs: 0, stopped: 1, done: 1, older: 0 })
  expect(codex?.counts).toEqual({ open: 2, needs: 1, stopped: 2, done: 1, older: 0 })
  expect(dot?.counts).toEqual({ open: 0, needs: 0, stopped: 1, done: 0, older: 0 })
  expect(robo?.counts).toEqual({ open: 0, needs: 0, stopped: 1, done: 0, older: 0 })
  expect(cursor?.counts).toEqual({ open: 0, needs: 0, stopped: 0, done: 0, older: 0 })
  expect(cursor?.isUnreadable).toBe(true)
  expect(claude?.isUnreadable).toBe(false)
  expect(result.own.counts).toEqual({ open: 1, needs: 1, stopped: 0, done: 1, older: 0 })

  // Brand name and icon from the tables; an unknown agent keeps its id and gets a letter tile.
  expect([claude?.name, claude?.icon]).toEqual(['Claude Code', 'claude-code'])
  expect([codex?.name, codex?.icon]).toEqual(['Codex', 'codex'])
  expect([dot?.name, dot?.icon]).toEqual(['dot', 'letter:D'])
  expect([robo?.name, robo?.icon]).toEqual(['Robo-7', 'letter:R'])
  expect(claude?.last).toBe(ago(5 * MIN))
  expect(cursor?.last).toBe(0)

  // Lists are newest first by time alone: Chinese and English titles, and a tie in input order.
  expect(titles(claude?.open ?? [])).toEqual(['Draft the synthetic report', '修正同步問題', 'Zulu synthetic', 'Alpha synthetic'])
  // The codex task that has a question card is not also listed as open.
  expect(titles(codex?.open ?? [])).toEqual(['Write the notes'])
  expect(titles(codex?.stopped ?? [])).toEqual(['Retire the flag', 'Dormant branch'])
  expect(codex?.stopped.map(one => one.isIdle)).toEqual([false, true])
  expect(titles(codex?.done ?? [])).toEqual(['Rename the synthetic module'])
  expect(titles(claude?.done ?? [])).toEqual(['Ship the synthetic demo'])
  expect(codex?.cards.map(card => card.type)).toEqual(['question'])
  expect(result.own.cards.map(card => [card.agent, card.isOwn])).toEqual([['', true]])

  // All holds every agent's rows, each tagged with its agent, and not the hand-kept ones.
  expect(result.all.isHidden).toBe(false)
  expect(result.all.counts).toEqual({ open: 6, needs: 1, stopped: 5, done: 2, older: 0 })
  expect(result.all.stopped.map(one => one.agent)).toEqual(['dot', 'robo-7', 'codex', 'claude', 'codex'])
  expect(result.agents.reduce((sum, group) => sum + group.counts.stopped, 0)).toBe(result.all.counts.stopped)
  // Needs you spans the hand-kept question too.
  expect(result.needs.n).toBe(2)

  // One agent only: the group is still there, and All is hidden.
  const single = groupBoard(board({ groups: grouped([row('', 'demo', 'Only synthetic task', { at: ago(MIN) })]) }), NOW, none, EN)
  expect(single.agents.map(group => group.agent)).toEqual(['claude'])
  expect(single.agents[0]?.counts.open).toBe(1)
  expect(single.all.isHidden).toBe(true)
  expect(single.all.counts.open).toBe(1)
})

test('grouping lists each unanswered question once in Needs you and leaves a carded task out of Open', () => {
  const parser = ask('codex', 'demo', 'Port the parser', 'Merge the synthetic branch, OK?', { key: 'ask:demo::Port the parser::1@a', at: ago(4 * MIN) })
  // The same question in a second block of the same task: one question, kept at the newer time.
  const again = ask('codex', 'demo', 'Port the parser', ' Merge the synthetic  branch, OK? ', { key: 'ask:demo::Port the parser::1@b', at: ago(2 * MIN) })
  const metric = ask('', 'demo', 'Pick the metric', 'Which metric, win rate or Elo?', { at: ago(10 * MIN) })
  // Another agent asking the same words is another question.
  const alike = ask('gemini', 'demo', 'Choose a metric', 'Which metric, win rate or Elo?', { at: ago(12 * MIN) })
  const first = ask('', 'demo', 'Tie one', 'Tie question one?', { at: ago(20 * MIN) })
  const second = ask('', 'demo', 'Tie two', 'Tie question two?', { at: ago(20 * MIN) })
  const inbox = turn('cursor', 'demo', 'Deploy the synthetic page?', true, { at: ago(7 * MIN) })
  const model = board({
    asks: [parser, again, metric, alike, first, second],
    turns: [inbox, turn('cursor', 'demo', '{"synthetic":"progress turn"}', false, { at: ago(MIN) })],
    // The same words as a pending question never also sit on the older line.
    reminder: [retained('codex', 'demo', 'Port the parser', 'Merge the synthetic branch, OK?', { questionId: 'q-old-0', at: ago(2 * DAY) })],
    older: [retained('codex', 'demo', 'Old spike', 'Old question one?', { questionId: 'q-old-1', at: ago(3 * DAY) }), retained('', 'demo', 'Old plan', 'Old question two?', { at: ago(5 * DAY) })],
    groups: grouped([
      row('codex', 'demo', 'Port the parser', { at: ago(20 * MIN) }),
      row('', 'demo', 'Pick the metric', { at: ago(25 * MIN) }),
      // `stuck` is only what the page marked; a row without it is not stuck.
      row('', 'demo', 'Build the synthetic image', { at: ago(3 * MIN), stuck: { reason: 'No output for 40 minutes' } }),
      row('', 'demo', 'Plain row', { at: ago(15 * MIN) }),
      row('', 'demo', 'At the edge', { at: ago(30 * MIN) }),
      row('', 'demo', 'Just past it', { at: ago(30 * MIN + 1) }),
      row('', 'Home', 'Water the synthetic plants', { isOwn: true, at: ago(MIN) }),
    ]),
  })
  const result = groupBoard(model, NOW, none, EN)

  // Questions once each: the two blocks of the codex question are one; the turn's JSON line is no question.
  expect(result.needs.questions).toBe(6)
  expect(result.needs.stuck).toBe(1)
  expect(result.needs.n).toBe(7)
  // Newest first; the last two have the same time, so they keep the input order.
  expect(result.needs.cards.map(card => card.key)).toEqual([again.key, 'stuck:row:demo::Build the synthetic image', inbox.key, metric.key, alike.key, first.key, second.key])
  expect(result.needs.cards.map(card => card.type)).toEqual(['question', 'stuck', 'question', 'question', 'question', 'question', 'question'])
  expect(result.needs.older.map(one => [one.text, one.stage])).toEqual([['Old question one?', 'older'], ['Old question two?', 'older']])

  // A task with a card is counted as open but is not listed under Open; a stuck task is carded too.
  const claude = result.agents.find(group => group.agent === 'claude')
  const codex = result.agents.find(group => group.agent === 'codex')
  expect(claude?.counts.open).toBe(5)
  expect(titles(claude?.open ?? [])).toEqual(['Plain row', 'At the edge', 'Just past it'])
  expect(claude?.open.every(task => !task.hasCard)).toBe(true)
  expect(codex?.counts.open).toBe(1)
  expect(codex?.open).toEqual([])
  expect(result.all.open.some(task => task.title === 'Port the parser')).toBe(false)

  // Working now: the 30 minutes before `now`, newest first, no carded task and no hand-kept one.
  expect(titles(result.working)).toEqual(['Plain row', 'At the edge'])
})

test('grouping names one project per repository and lists only projects with something open or a question', () => {
  const known: Record<string, string> = { '/work/app': 'app', '/work/app-fix-login': 'app', '/work/app-2': 'app', '/work/site': 'site' }
  const calls: string[] = []
  const repoOf = (dir: string): string | null => {
    calls.push(dir)
    return known[dir] ?? null
  }
  const model = board({
    asks: [ask('', 'app-fix-login', 'Fix login', 'Reset the synthetic session?', { dir: '/work/app-fix-login', at: ago(2 * MIN) })],
    groups: grouped([
      row('', 'app-fix-login', 'Fix login', { dir: '/work/app-fix-login', at: ago(MIN) }),
      row('codex', 'app', 'Add cache', { dir: '/work/app', at: ago(5 * MIN) }),
      row('gemini', 'app-2', 'Try a fork', { dir: '/work/app-2', at: ago(9 * MIN) }),
      // Chores has no folder: its heading stands for it.
      row('', 'Chores', 'Sort the synthetic mail', { at: ago(6 * MIN) }),
      row('', 'site', 'Edit pages', { dir: '/work/site', at: ago(8 * MIN) }),
      // A folder `repoOf` does not know is named by its own folder, on a Windows path too.
      row('cursor', 'misc', 'Keep notes', { dir: 'C:\\Users\\demo\\work\\notes\\', at: ago(7 * MIN) }),
    ]),
    // Nothing open in these: stopped or finished work does not make a project.
    stopped: [row('', 'site', 'Old page', { dir: '/work/site', at: ago(5 * DAY) }), row('', 'archive-only', 'Shelved', { dir: '/work/archive-only', at: ago(4 * DAY) })],
    recent: [done('finished-only', 'All done', { dir: '/work/finished-only', at: ago(DAY) })],
    // A question of any age keeps its project in the list, with nothing open.
    older: [retained('', 'quiet', 'Old task', 'Is the synthetic plan still wanted?', { dir: '/work/quiet', at: ago(3 * DAY) })],
    reminder: [retained('codex', 'stale-one', 'Stale task', 'Which synthetic release?', { at: ago(5 * DAY) })],
  })
  const result = groupBoard(model, NOW, repoOf, EN)

  expect(result.projects).toEqual([
    { name: 'app', open: 3 },
    { name: 'Chores', open: 1 },
    { name: 'notes', open: 1 },
    { name: 'site', open: 1 },
    { name: 'quiet', open: 0 },
    { name: 'stale-one', open: 0 },
  ])
  // Worktree folders are not projects of their own.
  expect(result.projects.some(project => project.name === 'app-fix-login' || project.name === 'app-2')).toBe(false)
  // Every row and question carries its repository.
  expect(result.all.open.filter(task => task.repo === 'app').map(task => task.title)).toEqual(['Add cache', 'Try a fork'])
  expect(result.needs.cards.map(card => card.repo)).toEqual(['app'])
  expect(result.all.stopped.map(task => [task.project, task.repo])).toEqual([['archive-only', 'archive-only'], ['site', 'site']])
  expect(result.needs.older.map(one => one.repo)).toEqual(['quiet', 'stale-one'])
  // The caller's lookup runs once for each of the eight folders, however many rows share one.
  expect(calls).toHaveLength(8)
  expect(new Set(calls).size).toBe(8)
})

test('grouping keeps a helper run\'s question under its starter\'s agent', () => {
  const starterId = 'a1b2c3d4-0000-4000-8000-000000000001'
  const runId = 'f0e1d2c3-0000-4000-8000-000000000002'
  const model = board({
    asks: [
      // A Codex run asks: the question belongs to the Cursor session that started it.
      ask('codex', 'demo', 'Helper thread', 'Should the helper rename the synthetic file?', { isRun: true, parent: starterId, session: '99887766', at: ago(MIN) }),
      // The same question again from a second block of the run: still one.
      ask('codex', 'demo', 'Helper thread', 'Should the helper rename the synthetic file?', { key: 'ask:demo::Helper thread::2', isRun: true, parent: starterId, session: '99887766', at: ago(2 * MIN) }),
      // A run of a run: followed up to the person's session.
      ask('claude', 'demo', 'Nested helper', 'Use the synthetic fixture?', { isRun: true, parent: runId, session: '55443322', at: ago(3 * MIN) }),
      // A run whose starter is not on the board: the question stays with the agent that asked.
      ask('codex', 'demo', 'Orphan helper', 'Which synthetic folder?', { isRun: true, parent: 'no-such-session', session: '11223344', at: ago(4 * MIN) }),
    ],
    // A finished helper run is no finished task either.
    recent: [done('demo', 'Helper thread', { isRun: true, at: ago(HOUR) })],
    groups: grouped([
      row('cursor', 'demo', 'Refactor the synthetic parser', { session: 'aa11bb22', sessionId: starterId, at: ago(5 * MIN) }),
      row('codex', 'demo', 'Helper thread', { isRun: true, parent: starterId, session: '99887766', sessionId: runId, at: ago(MIN) }),
    ]),
  })
  const result = groupBoard(model, NOW, none, EN)

  const cursor = result.agents.find(group => group.agent === 'cursor')
  const codex = result.agents.find(group => group.agent === 'codex')
  expect(cursor?.cards.map(card => (card.type === 'question' ? card.text : ''))).toEqual(['Should the helper rename the synthetic file?', 'Use the synthetic fixture?'])
  expect(cursor?.counts.needs).toBe(2)
  expect(cursor?.cards.every(card => card.agent === 'cursor')).toBe(true)
  expect(codex?.cards.map(card => (card.type === 'question' ? card.text : ''))).toEqual(['Which synthetic folder?'])
  // Needs you holds all three once, and the run is nobody's row.
  expect(result.needs.n).toBe(3)
  expect(codex?.counts).toEqual({ open: 0, needs: 1, stopped: 0, done: 0, older: 0 })
  expect(cursor?.counts.open).toBe(1)
  expect(titles(result.all.open)).toEqual(['Refactor the synthetic parser'])
  expect(result.all.counts.done).toBe(0)
  expect(result.agents.map(group => group.agent)).toEqual(['cursor', 'codex'])
  expect(titles(result.working)).toEqual(['Refactor the synthetic parser'])
})

// A board shaped like a heavy user's (#460): 8 agents, 300 open tasks, 200 stopped, 500 older
// questions, worktree folders named `<repo>-<n>`, helper runs, a question in two blocks, a turn
// that is JSON, Chinese and English titles. Every name and word is made up. The expected totals
// are counted here as the board is built, never read from the result.
const AGENTS = ['claude', 'codex', 'gemini', 'cursor', 'grok', 'muse', 'opencode', 'antigravity']
const REPOS = ['repo-a', 'repo-b', 'repo-c', 'repo-d', 'repo-e', 'repo-f', 'repo-g', 'repo-h', 'repo-i', 'repo-j', 'repo-k', 'repo-l']

type Tally = { open: number; needs: number; stopped: number; done: number; older: number }

const bigBoard = () => {
  let seed = 20261028
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const tally = new Map<string, Tally>()
  const count = (agent: string, field: keyof Tally): void => {
    const held = tally.get(agent) ?? { open: 0, needs: 0, stopped: 0, done: 0, older: 0 }
    held[field] += 1
    tally.set(agent, held)
  }
  const repoOpen = new Map<string, number>()
  const wireOf = (agent: string): string => (agent === 'claude' ? '' : agent)
  const folder = (repo: string, n: number): string => `/work/${repo}-${n}`
  const title = (i: number): string => (i % 3 === 0 ? `修正同步問題 ${i}` : `Fix the synthetic sync ${i}`)

  const open: GroupingRow[] = []
  const asks: GroupingAsk[] = []
  const starters: string[] = []
  for (let i = 0; i < 300; i += 1) {
    const isOwn = i % 60 === 0
    const agent = AGENTS[i % 8] as string
    // 40 worktree headings: 10 repositories of 4 folders each (repo-k and repo-l have no open task).
    const slot = i % 40
    const repo = REPOS[slot % 10] as string
    const n = 1 + Math.floor(slot / 10)
    const at = ago(Math.floor(next() * 3 * DAY))
    const sessionId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    const found = isOwn
      ? row('', 'Home', `Keep the synthetic list ${i}`, { isOwn: true, at })
      : row(wireOf(agent), `${repo}-${n}`, title(i), { dir: folder(repo, n), at, session: String(i).padStart(8, '0'), sessionId, ...(i >= 11 && i <= 13 ? { stuck: { reason: `No output for ${i} minutes` } } : {}) })
    open.push(found)
    count(isOwn ? '' : agent, 'open')
    if (isOwn) repoOpen.set('Home', (repoOpen.get('Home') ?? 0) + 1)
    else repoOpen.set(repo, (repoOpen.get(repo) ?? 0) + 1)
    if (i >= 11 && i <= 13) count(agent, 'needs')
    // Rows 1 to 6 each ask a question; the first asks it in two blocks.
    if (i >= 1 && i <= 6) {
      const one = ask(wireOf(agent), found.project, found.title, `Ship the synthetic change ${i}, OK?`, { key: `ask:${found.project}::${found.title}::1`, dir: folder(repo, n), at })
      asks.push(one)
      if (i === 1) asks.push({ ...one, key: `${one.key}@second` })
      count(agent, 'needs')
    }
    if (i === 7 || i === 8) starters.push(sessionId)
    // Two hand-kept questions.
    if (isOwn && i <= 60) {
      asks.push(ask('', 'Home', found.title, `Which synthetic account for ${i}?`, { isOwn: true, at }))
      count('', 'needs')
    }
  }
  // Helper runs sit next to the real sessions; they are nobody's row. Two of them ask, for the
  // sessions of rows 7 and 8 (antigravity and claude).
  const runs: GroupingRow[] = []
  for (let r = 0; r < 12; r += 1) runs.push(row('codex', `repo-a-${1 + (r % 4)}`, `Helper run ${r}`, { dir: folder('repo-a', 1 + (r % 4)), isRun: true, parent: starters[r % 2], at: ago(r * MIN) }))
  asks.push(ask('codex', 'repo-a-1', 'Helper run 0', 'Should the helper keep the synthetic cache?', { isRun: true, parent: starters[0], dir: folder('repo-a', 1), at: ago(MIN) }))
  count('antigravity', 'needs')
  asks.push(ask('codex', 'repo-a-2', 'Helper run 1', 'Should the helper drop the synthetic log?', { isRun: true, parent: starters[1], dir: folder('repo-a', 2), at: ago(2 * MIN) }))
  count('claude', 'needs')
  // One turn that is a question and one that is raw JSON.
  const turns = [turn('cursor', 'repo-b-1', 'Deploy the synthetic page now?', true, { dir: folder('repo-b', 1), at: ago(3 * MIN) }), turn('cursor', 'repo-b-1', '{"synthetic":{"progress":[1,2,3]}}', false, { dir: folder('repo-b', 1), at: ago(MIN) })]
  count('cursor', 'needs')

  const stopped: GroupingRow[] = []
  const idle: GroupingRow[] = []
  for (let j = 0; j < 200; j += 1) {
    const isOwn = j === 199
    const agent = AGENTS[j % 8] as string
    const repo = REPOS[j % 12] as string
    const n = 1 + (Math.floor(j / 12) % 4)
    const found = isOwn ? row('', 'Home', `Shelved synthetic list ${j}`, { isOwn: true, at: ago(20 * DAY) }) : row(wireOf(agent), `${repo}-${n}`, title(j + 1000), { dir: folder(repo, n), at: ago(DAY + Math.floor(next() * 20 * DAY)) })
    ;(j < 40 ? idle : stopped).push(found)
    count(isOwn ? '' : agent, 'stopped')
  }

  // 500 older questions, none from repo-k, so repo-k has nothing open and no question.
  const questionRepos = [...REPOS.slice(0, 10), 'repo-l']
  const reminder: GroupingRetained[] = []
  const older: GroupingRetained[] = []
  for (let q = 0; q < 500; q += 1) {
    const agent = AGENTS[q % 8] as string
    const repo = questionRepos[q % 11] as string
    ;(q < 200 ? reminder : older).push(retained(wireOf(agent), `${repo}-${1 + (q % 4)}`, `Closed task ${q}`, `Older synthetic question ${q}?`, { questionId: `old-${q}`, dir: folder(repo, 1 + (q % 4)), at: ago(8 * DAY + q * MIN) }))
    count(agent, 'older')
  }

  // 14 finished within the week (2 of them hand-kept), 6 a week and more ago.
  const recent: GroupingDone[] = []
  for (let k = 0; k < 20; k += 1) {
    const isOwn = k < 14 && k % 7 === 6
    const agent = AGENTS[k % 8] as string
    const isRecent = k < 14
    recent.push(done(isOwn ? 'Home' : `${REPOS[k % 10]}-1`, `Finished synthetic task ${k}`, { ...(isOwn ? { isOwn: true as const } : agent === 'claude' ? {} : { agent }), ...(isOwn ? {} : { dir: folder(REPOS[k % 10] as string, 1) }), at: isRecent ? ago(k * 11 * HOUR) : ago(8 * DAY + k * HOUR) }))
    if (isRecent) count(isOwn ? '' : agent, 'done')
  }

  const model: GroupingInput = board({ asks, turns, reminder, older, idle, stopped, groups: grouped([...open, ...runs]), recent })
  const repoOf = (dir: string): string | null => /^\/work\/(repo-[a-l])-\d$/.exec(dir)?.[1] ?? null

  return { model, repoOf, tally, repoOpen }
}

test('grouping on the synthetic big board adds up to the board\'s totals', () => {
  const { model, repoOf, tally, repoOpen } = bigBoard()
  // The board is the size of a heavy user's: about 50 headings, 300 open tasks, 200 stopped, 500 older questions.
  const headings = new Set([...model.groups.map(group => group.project), ...model.stopped.map(one => one.project), ...model.idle.map(one => one.project)])
  expect(headings.size).toBeGreaterThanOrEqual(48)
  expect(model.groups.reduce((sum, group) => sum + group.rows.filter(one => one.isRun !== true).length, 0)).toBe(300)
  expect(model.stopped.length + model.idle.length).toBe(200)
  expect(model.reminder.length + model.older.length).toBe(500)

  const result = groupBoard(model, NOW, repoOf, EN)
  expect(result.agents).toHaveLength(8)

  // Each agent's counts are the ones counted while the board was built.
  for (const group of result.agents) expect([group.agent, group.counts]).toEqual([group.agent, { open: 0, needs: 0, stopped: 0, done: 0, older: 0, ...tally.get(group.agent) }])
  expect(result.own.counts).toEqual({ open: 0, needs: 0, stopped: 0, done: 0, older: 0, ...tally.get('') })

  // And together they are the board's totals: 300 open, 200 stopped, 500 older, 14 finished this week.
  const sum = (field: keyof Tally): number => result.agents.reduce((total, group) => total + group.counts[field], 0) + result.own.counts[field]
  expect(sum('open')).toBe(300)
  expect(sum('stopped')).toBe(200)
  expect(sum('older')).toBe(500)
  expect(sum('done')).toBe(14)
  // Questions once each: 6 asks (one in two blocks), 2 by helper runs, 1 inbox turn, 2 hand-kept; plus 3 stuck tasks.
  expect(sum('needs')).toBe(14)
  expect(result.needs.n).toBe(14)
  expect(result.needs.questions).toBe(11)
  expect(result.needs.stuck).toBe(3)
  expect(result.needs.older).toHaveLength(500)
  expect(result.all.counts).toEqual({ open: 295, needs: 12, stopped: 199, done: 12, older: 500 })
  expect(result.all.isHidden).toBe(false)

  // Agents are in order of their latest activity, and the order is the input's alone.
  const lasts = result.agents.map(group => group.last)
  expect(lasts).toEqual([...lasts].sort((a, b) => b - a))
  expect(groupBoard(model, NOW, repoOf, EN).agents.map(group => group.agent)).toEqual(result.agents.map(group => group.agent))

  // Worktree folders are one project per repository; a repository with nothing open and no question is not listed.
  const names = result.projects.map(project => project.name)
  expect(new Set(names).size).toBe(names.length)
  expect([...names].sort()).toEqual(['Home', ...REPOS.slice(0, 10), 'repo-l'].sort())
  expect(names.some(name => /-\d$/.test(name))).toBe(false)
  for (const project of result.projects) expect([project.name, project.open]).toEqual([project.name, repoOpen.get(project.name) ?? 0])
  expect(result.projects.find(project => project.name === 'repo-l')?.open).toBe(0)

  // Helper runs are no rows, and nothing listed as working was last active more than 30 minutes ago.
  expect(result.all.open.some(task => task.title.startsWith('Helper run'))).toBe(false)
  expect(result.working.every(task => NOW - task.at <= 30 * MIN)).toBe(true)
})
