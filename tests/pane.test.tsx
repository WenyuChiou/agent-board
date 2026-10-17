import type { On, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

const FILE = '/home/me/.claude/progress.md'
const SESSION = '2be48af2-6193-5040-aacc-e0546d6784f1'
const PANE = { plugin: 'project-progress', component: 'Pane', requestId: 'project-progress' } as const

const PROPS: RenderPropsOf['Pane'] = {
  title: '進度',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

type World = {
  files: Map<string, string>
  mtime: number
  hasTasks: boolean
  env?: Record<string, string>
  stats?: string[]
  // Paths that exist but refuse to be read (too big, locked).
  unreadable?: Set<string>
  // When set, the next write to progress.md waits here; `reached` resolves once it does.
  hold?: { reached: () => void; release: Promise<void> }
  // What the store holds at the start.
  store?: Record<string, unknown>
  // Every command the mod ran, when set.
  ran?: string[][]
  // What the model answers when asked to name the task.
  named?: string
  // What the model answers to a prompt, when the answer depends on what was asked.
  reply?: (prompt: string) => string | undefined
  // The transcript $.session.messages() returns.
  messages?: Array<{ role: 'user' | 'assistant'; text: string; toolUses: Array<{ tool_use_id: string; tool: string; input: Record<string, unknown> }> }>
  // Answers `gh`; other commands (git) answer the branch.
  gh?: () => { exitCode: number; stdout: string; stderr: string }
}

// On Windows the engine resolves /home/me/... to X:\home\me\... before fs.* reaches these
// handlers; map it back so the in-memory files are found on every host.
const posix = (path: string): string => path.replace(/^[A-Za-z]:\\/, '/').replace(/\\/g, '/')

// Everything a session's engine answers beneath the plugin, with files kept in memory.
const engineBeneath = (on: On, world: World): MockClock => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-16T12:00:00.000Z') })
  // The system says Traditional Chinese, so the pane speaks it unless a test says otherwise.
  mock.env(on, world.env ?? { HOME: '/home/me', LANG: 'zh_TW.UTF-8' })
  mock.store(on, world.store)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: '/work/persona_framework' }))
  on('session.repo', () => ({
    value: {
      root: '/work/persona_framework',
      remote: 'https://github.com/jhk482001/persona_framework.git',
      internal: false,
      name: null,
    },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('tool.list', () => ({
    value: world.hasTasks ? [{ name: 'TaskCreate', description: '', mcp: false }] : [{ name: 'Read', description: '', mcp: false }],
  }))
  on('process.run', ($, e) => {
    const ran =
      e.argv[0] === 'gh' && world.gh !== undefined
        ? world.gh()
        : { exitCode: e.argv[0] === 'gh' ? 1 : 0, stdout: e.argv[0] === 'gh' ? '' : 'claude/progress-mod\n', stderr: '' }
    world.ran?.push([...e.argv])
    return { value: { ...ran, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.messages', () => ({ value: world.messages ?? [] }))
  on('model.complete', ($, e) => ({
    value: {
      isAnswered: true as const,
      text: world.reply?.(typeof e.prompt === 'string' ? e.prompt : '') ?? world.named ?? '「重做進度面板」',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('fs.stat', ($, e) => {
    world.stats?.push(e.path)
    const text = world.files.get(posix(e.path))
    const isDir = [...world.files.keys()].some(path => path.startsWith(`${posix(e.path)}/`))
    if (text === undefined && isDir) return { value: { kind: 'dir' as const, size: 0, mtimeMs: world.mtime, isLink: false } }
    return text === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file' as const, size: text.length, mtimeMs: world.mtime, isLink: false } }
  })
  on('fs.exists', ($, e) => ({ value: world.files.has(posix(e.path)) || [...world.files.keys()].some(path => path.startsWith(`${posix(e.path)}/`)) }))
  on('fs.list', ($, e) => {
    const dir = `${posix(e.path ?? '').replace(/\/$/, '')}/`
    const names = [...world.files.keys()].filter(path => path.startsWith(dir) && !path.slice(dir.length).includes('/'))
    return {
      value: names.map(path => ({ name: path.slice(dir.length), kind: 'file' as const, size: (world.files.get(path) ?? '').length, mtimeMs: world.mtime, isLink: false })),
    }
  })
  on('fs.read', ($, e) => {
    const path = posix(e.path)
    const text = world.files.get(path)
    if (world.unreadable?.has(path)) return { deny: 'EFBIG' }
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', async ($, e) => {
    const path = posix(e.path)
    const hold = world.hold
    if (hold !== undefined && path === FILE) {
      world.hold = undefined
      hold.reached()
      await hold.release
    }
    world.files.set(path, e.text)
    world.mtime += 1
    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  let nextId = 0
  on('tool.call', { tool: 'TaskCreate' }, ($, e) => {
    nextId += 1
    return { result: { task: { id: String(nextId), subject: e.subject } } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, ($, e) => ({
    result: { success: true, taskId: e.taskId, updatedFields: ['status'] },
  }))

  return clock
}

const start = async ($: Engine, text: string): Promise<void> => {
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text, turnId: 't1' })
}

test('Claude’s task calls fill the file and the pane by themselves', async ($, on) => {
  const world: World = { files: new Map([[FILE, '# 專案進度\n\n## 求職\n### Google 暑期實習\n- [?] 推薦信 — 等教授回覆\n']]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await start($, '幫我重做進度面板')

  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: '寫 Mod', description: '', activeForm: '寫 Mod 中' })
  await $.tool.call({ tool: 'TaskCreate', subject: '推分支', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })

  const written = world.files.get(FILE) ?? ''
  expect(written).toContain('## 求職\n### Google 暑期實習')
  expect(written).toContain('## persona_framework')
  expect(written).toContain('<!-- auto session=2be48af2 agent=claude state=working')
  expect(written).toContain('- [x] 讀 API\n- [~] 寫 Mod\n- [ ] 推分支')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })
    // The counts at the top, a zero kept.
    expect(await ui.find({ type: 'Text', text: '● 1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '▸ 1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '⚑ 0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✓ 1' })).toBeDefined()
    // The one thing that needs the person: here a step that waits on someone else, with
    // the task it belongs to and why.
    expect(await ui.find({ type: 'Text', text: '現在最需要你' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '〔等別人〕' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^推薦信$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '求職 › Google 暑期實習' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '等教授回覆' })).toBeDefined()
    // The card is short: where it stands and what comes next, not every step.
    expect(await ui.find({ type: 'Text', text: '正在做：寫 Mod 中' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1\/3$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '○ 下一步：推分支' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ ← 現在$/ })).toBeUndefined()
    // 全部 3 步 opens the numbered list, the step being done marked.
    await ui.press({ key: 'section::steps' })
    expect((await ui.find({ type: 'Text', text: /^寫 Mod$/ }))?.props).toMatchObject({ bold: true })
    expect(await ui.find({ type: 'Text', text: /^2 $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ ← 現在$/ })).toBeDefined()
    // No background yet, and the request is the title: nothing said twice.
    expect(await ui.find({ type: 'Text', text: /^背景：/ })).toBeUndefined()
    await ui.press({ key: 'section::steps' })
    await ui.unmount()
  }
})

test('the end of a turn says the session waits on you, and the model names the task', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  const clock = engineBeneath(on, world)
  await start($, '幫我重做進度面板')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)

  const written = world.files.get(FILE) ?? ''
  expect(written).toContain('state=waiting')
  expect(written).toContain('> 等你回覆 · claude/progress-mod')
  expect(written).toContain('### 重做進度面板')
})

test('after a compaction the conversation gets the progress note', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: '摘要', toolUses: [] }] }))
  await start($, '幫我重做進度面板')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: '寫 Mod', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })

  const out = await $.session.compact({
    trigger: 'auto',
    messages: [{ role: 'user', text: '幫我重做進度面板', toolUses: [] }],
  })
  const last = out.messages?.at(-1)?.text ?? ''
  expect(last).toContain('[進度面板] 對話剛壓縮過')
  expect(last).toContain('正在做：寫 Mod')
  expect(last).toContain('完成 1/2')
})

test('a session that ends with open steps is marked for someone to pick up', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await start($, '跑實驗')
  await $.tool.call({ tool: 'TaskCreate', subject: '跑 100 次', description: '' })
  await $.session.end({ reason: 'other', sessionId: SESSION, resume: { id: SESSION } as never })

  expect(world.files.get(FILE) ?? '').toContain('state=ended')
  expect(world.files.get(FILE) ?? '').toContain('> 對話已結束，可接手')
})

test('with nothing tracked the pane says so, and where the file is', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/x', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: '目前沒有進行中的工作。' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: FILE })).toBeDefined()
  await ui.unmount()
})

test('without Task tools the pane points to the shell profile, not settings.json', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: false }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/x', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /CLAUDE_CODE_ENABLE_TODO_TOOLS=1 加進 shell 的 profile/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /在 settings\.json 的 env 加上/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /git-bash.*手動記在 progress\.md/ })).toBeDefined()
  await ui.unmount()
})

test('on Windows the file sits under USERPROFILE, even with a Git Bash HOME', async ($, on) => {
  const world: World = {
    files: new Map(),
    mtime: 1,
    hasTasks: true,
    env: { USERPROFILE: 'C:\\Users\\wenyu', HOME: '/c/Users/wenyu' },
    stats: [],
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: 'C:\\work\\persona_framework', surface: 'desktop', isInteractive: true })
  // A Linux host resolves a drive path as relative, so compare the tail the mod built.
  expect((world.stats ?? []).some(path => path.endsWith('C:\\Users\\wenyu\\.claude\\progress.md'))).toBe(true)
})

const JOBS = `# 專案進度

## 求職
### Google 暑期實習
> 截止 12-20
- [x] 改履歷
- [?] 推薦信 — 等教授回覆
- [ ] 投遞

## persona_framework
<!-- auto session=a81d0c42 state=ended updated=2026-10-16T10:00:00.000Z -->
### 修 CI
- [x] 看 log
- [ ] 修測試
<!-- /auto session=a81d0c42 -->
`

test('the pane acts: tick a step, hand a task to Claude, take over, ask aside', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  const submitted: string[] = []
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('model.fork', () => ({
    value: {
      isAnswered: true as const,
      text: '還差修測試。',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })
    expect(await ui.find({ type: 'Button', key: '求職::Google 暑期實習::1::done' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })

  // 完成 on a waiting step ticks it in the file, and the journal has it for the report.
  await ui.press({ key: '求職::Google 暑期實習::1::done' })
  expect(world.files.get(FILE)).toContain('- [x] 推薦信 — 等教授回覆')
  expect(world.files.get('/home/me/.claude/progress-journal-2026-10.md')).toMatch(/ · 求職 · Google 暑期實習 · 推薦信 — 等教授回覆\n$/)

  // Other work is folded to one line until opened; a row then opens to its steps and
  // actions, and 交給 Claude sends a prompt.
  expect(await ui.find({ type: 'Button', key: '求職::Google 暑期實習' })).toBeUndefined()
  await ui.press({ key: 'section::others' })
  await ui.press({ key: '求職::Google 暑期實習' })
  expect(await ui.find({ type: 'Text', text: '投遞' })).toBeDefined()
  await ui.press({ key: '求職::Google 暑期實習::hand' })
  expect(submitted.at(-1)).toContain('幫我處理「Google 暑期實習」（求職）')
  expect(submitted.at(-1)).toContain('下一步是「投遞」')

  // An ended session in this project can be taken over here.
  await ui.press({ key: 'persona_framework::修 CI' })
  await ui.press({ key: 'persona_framework::修 CI::take' })
  expect(submitted.at(-1)).toContain('接手「修 CI」')
  expect(submitted.at(-1)).toContain('剩下：修測試')

  // A side question is answered in the pane.
  await ui.input({ key: 'ask', text: '還差什麼？' })
  expect(await ui.find({ type: 'Text', text: '還差修測試。' })).toBeDefined()
  await ui.press({ key: 'clear-answer' })
  expect(await ui.find({ type: 'Text', text: '還差修測試。' })).toBeUndefined()
  await ui.unmount()
})

test("a 完成 press while Claude's own write is on its way: both land", async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true }
  const clock = engineBeneath(on, world)
  await start($, '幫我重做進度面板')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })

  // Claude's next write is held at the file. The press comes in meanwhile and is given time
  // to run: a tick that reads the file now (no queue) works from text without Claude's
  // change, and whichever write lands second undoes the other. Queued behind Claude's
  // write, the tick waits, then reads what that write left.
  let release = (): void => {}
  let reached = (): void => {}
  const atGate = new Promise<void>(resolve => {
    reached = resolve
  })
  world.hold = {
    reached,
    release: new Promise<void>(resolve => {
      release = resolve
    }),
  }
  const pending = $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await atGate

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  const pressing = ui.press({ key: '求職::Google 暑期實習::1::done' })
  await clock.advance(1)
  release()
  await pressing
  await pending
  await ui.unmount()

  const text = world.files.get(FILE) ?? ''
  expect(text).toContain('- [x] 推薦信 — 等教授回覆')
  expect(text).toContain('- [x] 讀 API')
})

test('a progress.md that cannot be read is never rewritten', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, unreadable: new Set([FILE]) }
  engineBeneath(on, world)
  await start($, '幫我重做進度面板')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  expect(world.files.get(FILE)).toBe(JOBS)
})

test("a progress.md holding only whitespace still gets this session's block", async ($, on) => {
  const world: World = { files: new Map([[FILE, '  \n\n']]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await start($, '幫我重做進度面板')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  expect(world.files.get(FILE)).toContain('<!-- auto session=2be48af2 agent=claude state=working')
})

const ARCHIVE = '/home/me/.claude/progress-archive-2026-10.md'
const TIDY = {
  command: 'progress',
  args: '整理',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
}
const OLD_DONE = `# 專案進度

## ai-research-skills
<!-- auto session=c55e2f10 state=done updated=2026-10-15T09:00:00.000Z -->
### 發佈 1.7.4
> 完成
- [x] 打 tag
<!-- /auto session=c55e2f10 -->
`

test('an archive file that cannot be read is left alone, and so is progress.md', async ($, on) => {
  const world: World = {
    files: new Map([
      [FILE, OLD_DONE],
      [ARCHIVE, '# 進度封存\n\n（很大的舊紀錄）\n'],
    ]),
    mtime: 1,
    hasTasks: true,
    unreadable: new Set([ARCHIVE]),
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run(TIDY)
  expect(ran.text).toBe('讀不到進度檔或封存檔，沒有動任何檔案。')
  expect(world.files.get(FILE)).toBe(OLD_DONE)
  expect(world.files.get(ARCHIVE)).toBe('# 進度封存\n\n（很大的舊紀錄）\n')
})

test("old done blocks go to the month's archive file, after what it already holds", async ($, on) => {
  const world: World = {
    files: new Map([
      [FILE, OLD_DONE],
      [ARCHIVE, '# 進度封存\n\n## alpha · 2026-10-01\n### 舊的\n- [x] 一\n'],
    ]),
    mtime: 1,
    hasTasks: true,
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await $.command.run(TIDY)
  expect(world.files.get(ARCHIVE)).toBe(
    '# 進度封存\n\n## alpha · 2026-10-01\n### 舊的\n- [x] 一\n\n## ai-research-skills · 2026-10-15\n### 發佈 1.7.4\n> 完成\n- [x] 打 tag\n',
  )
  expect(world.files.get(FILE)).not.toContain('session=c55e2f10')
})

test('the rule rides the system prompt only while the session has a Task list', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: '你是 Claude。', scope: 'shared' as const }] }))
  const base = { model: 'claude-test', promptModel: 'claude-test', surfaces: [], outputStyle: null, traits: [] }

  const withTasks = await $.prompt.compose({ ...base, tools: ['Read', 'TaskCreate'] })
  expect(withTasks.sections.map(s => s.id)).toEqual(['intro', 'project-progress:rule'])
  expect(withTasks.sections[1]?.text).toContain('TaskCreate')
  expect(withTasks.sections[1]?.scope).toBe('session')

  const without = await $.prompt.compose({ ...base, tools: ['Read'] })
  expect(without.sections.map(s => s.id)).toEqual(['intro'])
})

const JOURNAL = '/home/me/.claude/progress-journal-2026-10.md'

// The engine's side of what the mod shows outside its pane, written down for the tests.
const outside = (on: On) => {
  const seen = { notified: [] as string[], copied: [] as string[], status: [] as Array<string | undefined> }
  on('ui.notify', ($, e) => {
    seen.notified.push(e.text)
    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('ui.copy', ($, e) => {
    seen.copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })

  return seen
}

test('a + line in the pane adds a task to the file, under its project', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })

  await ui.input({ key: 'ask', text: '+ 求職：Meta 實習 截止 11-20' })
  const text = world.files.get(FILE) ?? ''
  expect(text).toContain('- [ ] 投遞\n\n### Meta 實習\n> 截止 11-20\n- [ ] 改履歷\n- [ ] 寫求職信\n- [ ] 投遞\n- [ ] 追蹤回覆\n\n## persona_framework')
  expect(await ui.find({ type: 'Text', text: '已加進「求職」：Meta 實習（4 步，截止 11-20）' })).toBeDefined()

  // The same through the command, with no project: this session's repo.
  const ran = await $.command.run({ ...TIDY, args: '加 修 flaky 測試；重跑三次' })
  expect(ran.text).toBe('已加進「persona_framework」：修 flaky 測試（1 步）')
  expect(world.files.get(FILE)).toContain('### 修 flaky 測試\n- [ ] 重跑三次\n')
  await ui.unmount()
})

test('finished steps reach the journal, and 週報 copies a report of them', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  const clock = engineBeneath(on, world)
  const seen = outside(on)
  await start($, '幫我重做進度面板')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: '寫 Mod', description: '' })
  // The task is named as soon as it has a step, so the journal carries the real name.
  await clock.advance(10)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })

  expect(world.files.get(JOURNAL)).toMatch(/^# 工作日誌\n- 2026-10-1\d \d\d:\d\d · persona_framework · 重做進度面板 · 讀 API\n$/)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'report' })
  expect(seen.copied.at(-1)).toContain('- persona_framework · 重做進度面板：讀 API')
  expect(seen.copied.at(-1)).toContain('進行中\n- persona_framework · 重做進度面板：下一步 寫 Mod (1/2)')
  expect(await ui.find({ type: 'Text', text: '已複製到剪貼簿' })).toBeDefined()
  await ui.unmount()

  const ran = await $.command.run({ ...TIDY, args: '今天' })
  expect(ran.text).toContain('今天的進度')
  expect(ran.text).toContain('（已複製到剪貼簿）')
})

test('a step that needs you notifies, the whole list finishing notifies, and 通知：關 silences both', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  const seen = outside(on)
  await start($, '幫我重做進度面板')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: '選版本', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', metadata: { waiting: 'you' } })
  expect(seen.notified).toEqual(['需要你：選版本'])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'notify' })
  expect(await ui.find({ type: 'Button', key: 'notify', text: '通知：關' })).toBeDefined()
  await ui.unmount()

  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed' })
  expect(seen.notified).toEqual(['需要你：選版本'])

  const ran = await $.command.run({ ...TIDY, args: '通知 開' })
  expect(ran.text).toContain('已打開')
})

test('the pull request shows on the card and in the block, and a finished CI run notifies', async ($, on) => {
  const answers = ['PENDING', 'FAILURE']
  const asked: string[][] = []
  const world: World = {
    files: new Map(),
    mtime: 1,
    hasTasks: true,
    ran: asked,
    gh: () => {
      const conclusion = answers.length > 1 ? (answers.shift() ?? '') : (answers[0] ?? '')
      const check = conclusion === 'PENDING' ? { status: 'IN_PROGRESS', conclusion: '' } : { status: 'COMPLETED', conclusion }
      const stdout = JSON.stringify({
        number: 12,
        url: 'https://github.com/jhk482001/persona_framework/pull/12',
        state: 'OPEN',
        isDraft: false,
        statusCheckRollup: [check],
        reviewDecision: 'REVIEW_REQUIRED',
      })
      return { exitCode: 0, stdout, stderr: '' }
    },
  }
  const clock = engineBeneath(on, world)
  const seen = outside(on)
  await start($, '幫我修 CI')
  await $.tool.call({ tool: 'TaskCreate', subject: '看 log', description: '' })
  await clock.advance(10)

  expect(asked.some(argv => argv.join(' ').startsWith('gh pr view --json number,url'))).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect((await ui.find({ type: 'Link' }))?.props).toMatchObject({
    href: 'https://github.com/jhk482001/persona_framework/pull/12',
    label: 'PR #12 · CI 跑中 · 等審查',
  })
  await ui.unmount()

  // Checks still running are looked at again; the run finishing is notified once.
  await clock.advance(2 * 60 * 1000)
  expect(seen.notified).toEqual(['PR #12 CI 失敗 1'])
  expect(world.files.get(FILE)).toContain('pr=12 ci=fail -->')
  expect(world.files.get(FILE)).toContain('PR #12 · CI 失敗 1 · 等審查')
  await clock.advance(2 * 60 * 1000)
  expect(seen.notified).toEqual(['PR #12 CI 失敗 1'])
})

test('with the pane closed, the line under the prompt carries the progress', async ($, on) => {
  // Closed by hand in an earlier session, so it does not open by itself.
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, store: { closedByPerson: true } }
  engineBeneath(on, world)
  const seen = outside(on)
  await start($, '幫我重做進度面板')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  expect(seen.status.at(-1)).toMatch(/^進度 · .* 0\/1 · Claude 正在做 · 1 件等你$/)

  // Opened, the pane says it all, so the line is cleared.
  await $.command.run({ ...TIDY, args: '' })
  expect(seen.status.at(-1)).toBe(undefined)
})

test('an ended session elsewhere offers its resume command, copied for the terminal', async ($, on) => {
  const file = `# 專案進度

## FLOODABM
<!-- auto session=dddddddd state=ended updated=2026-10-16T10:00:00.000Z resume=dddddddd-2222-3333 dir=%2Fwork%2FFLOODABM -->
### 跑實驗
- [x] 準備資料
- [ ] 跑 100 次
<!-- /auto session=dddddddd -->
`
  const world: World = { files: new Map([[FILE, file]]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  const seen = outside(on)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'section::others' })
  await ui.press({ key: 'FLOODABM::跑實驗' })
  expect(await ui.find({ type: 'Button', key: 'FLOODABM::跑實驗::take' })).toBeUndefined()
  await ui.press({ key: 'FLOODABM::跑實驗::resume' })
  expect(seen.copied).toEqual(["cd '/work/FLOODABM' && claude --resume dddddddd-2222-3333"])
  expect(await ui.find({ type: 'Text', text: '已複製到剪貼簿' })).toBeDefined()
  await ui.unmount()
})

test('the task gets a line of background with its name, and a step that needs you says why', async ($, on) => {
  const world: World = {
    files: new Map(),
    mtime: 1,
    hasTasks: true,
    named: '重做進度面板\n背景：想在右側一眼看到各專案做到哪，壓縮後也接得上',
  }
  const clock = engineBeneath(on, world)
  await start($, '幫我做一個進度面板 Mod')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: '選版號', description: '' })
  await clock.advance(10)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', metadata: { waiting: 'you', why: '要決定用 0.6 還是 1.0' } })

  const text = world.files.get(FILE) ?? ''
  expect(text).toContain('### 重做進度面板\n> Claude 正在做\n> 背景：想在右側一眼看到各專案做到哪，壓縮後也接得上\n')
  expect(text).toContain('- [?] 選版號 — 要決定用 0.6 還是 1.0\n')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Text', text: '背景：想在右側一眼看到各專案做到哪，壓縮後也接得上' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '要決定用 0.6 還是 1.0' })).toBeDefined()
  await ui.unmount()

  // Clearing the wait clears its reason.
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', metadata: { waiting: null } })
  expect(world.files.get(FILE)).toContain('- [ ] 選版號\n')
})

test('the pane takes the light 和色 set under a light theme, and 說明 lists every mark', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  on('config.list', () => ({
    value: [{ key: 'theme', label: 'Theme', kind: 'enum' as const, value: 'light-daltonized', provider: { kind: 'core' } } as never],
  }))
  await start($, '幫我重做進度面板')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  // Every step shows once opened; 藍 for the step in progress, not the dark set's 浅葱.
  await ui.press({ key: 'section::steps' })
  expect((await ui.find({ type: 'Text', text: /^▸ $/ }))?.props).toMatchObject({ color: '#165E83' })
  expect(await ui.find({ type: 'Text', text: /^ 卡住$/ })).toBeUndefined()
  await ui.press({ key: 'legend' })
  expect(await ui.find({ type: 'Text', text: /^ 卡住$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '⚑ 兩週內截止' })).toBeDefined()
  await ui.unmount()
})

test('a question this session asks is answered from the pane, with the buttons its kind calls for', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  const seen = outside(on)
  const submitted: string[] = []
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await start($, '幫我發版')
  await $.tool.call({ tool: 'TaskCreate', subject: '推上 main', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: '選版號', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: '跑安裝', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', metadata: { waiting: 'you', why: '可以直接推到 main 嗎？' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  // 確認: 好 / 不要, and a press answers Claude in this session.
  expect(await ui.find({ type: 'Text', text: '〔確認〕' })).toBeDefined()
  await ui.press({ key: 'mine::1::好' })
  expect(submitted.at(-1)).toBe('關於「推上 main」：好，照做')
  expect(await ui.find({ type: 'Text', text: '已回覆 Claude：好，照做' })).toBeDefined()

  // 選一個: a button per option Claude gave.
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', metadata: { waiting: null } })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', metadata: { waiting: 'you', ask: 'choose', options: ['0.7.0', '1.0.0'], why: '這版叫什麼？' } })
  await ui.press({ key: 'mine::2::1.0.0' })
  expect(submitted.at(-1)).toBe('關於「選版號」：1.0.0')

  // 動手: the command to copy, then 做好了.
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', metadata: { waiting: null } })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', metadata: { waiting: 'you', ask: 'do', command: 'pwsh ./scripts/setup.ps1', why: '在你的電腦上跑' } })
  expect(await ui.find({ type: 'Text', text: '$ pwsh ./scripts/setup.ps1' })).toBeDefined()
  await ui.press({ key: 'mine::3::copy' })
  expect(seen.copied.at(-1)).toBe('pwsh ./scripts/setup.ps1')
  await ui.press({ key: 'mine::3::did' })
  expect(submitted.at(-1)).toBe('關於「跑安裝」：做好了')
  await ui.unmount()
})

test('folded sections open on a press and stay open in the next session', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, store: { opened: ['recent'] } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Button', key: 'section::others', text: '▸ 其他進行中' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'section::others', text: '▸ 進行中' })).toBeDefined()
  await ui.press({ key: 'section::others' })
  expect(await ui.find({ type: 'Button', key: 'section::others', text: '▾ 進行中' })).toBeDefined()
  // The counts open what they count, too.
  await ui.press({ key: 'count::others' })
  expect(await ui.find({ type: 'Button', key: 'section::others', text: '▸ 進行中' })).toBeDefined()
  await ui.press({ key: 'count::others' })
  await ui.unmount()

  const again = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await again.find({ type: 'Button', key: 'section::others', text: '▾ 進行中' })).toBeDefined()
  await again.unmount()
})

test('a hand-kept task done for a day leaves for the archive by itself, and the next hour clears a done block', async ($, on) => {
  const day = 24 * 60 * 60 * 1000
  const now = Date.parse('2026-10-16T12:00:00.000Z')
  const file = `# 專案進度

## 求職
### Google 暑期實習
- [x] 改履歷
- [x] 投遞

### Meta 實習
- [ ] 投遞

## ai-research-skills
<!-- auto session=c55e2f10 agent=claude state=done updated=${new Date(now - 11.5 * 60 * 60 * 1000).toISOString()} -->
### 發佈 1.7.4
- [x] 打 tag
<!-- /auto session=c55e2f10 -->
`
  const world: World = { files: new Map([[FILE, file]]), mtime: 1, hasTasks: true, store: { 'done:求職::Google 暑期實習': now - 2 * day } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await clock.advance(1)

  expect(world.files.get(ARCHIVE)).toContain('## 求職 · 2026-10-14\n### Google 暑期實習\n- [x] 改履歷\n- [x] 投遞')
  expect(world.files.get(FILE)).toContain('## 求職\n### Meta 實習\n- [ ] 投遞')
  expect(world.files.get(FILE)).not.toContain('Google 暑期實習')
  // Not yet half a day old: the done block stays until the hourly pass after it is.
  expect(world.files.get(FILE)).toContain('session=c55e2f10')
  await clock.advance(60 * 60 * 1000)
  expect(world.files.get(FILE)).not.toContain('session=c55e2f10')
  expect(world.files.get(ARCHIVE)).toContain('### 發佈 1.7.4')
})

test('on a light terminal no text falls back to the terminal dim', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, store: { opened: ['others', 'waiting', 'recent', 'steps'] } }
  engineBeneath(on, world)
  on('config.list', () => ({
    value: [{ key: 'theme', label: 'Theme', kind: 'enum' as const, value: 'light', provider: { kind: 'core' } } as never],
  }))
  await start($, '幫我重做進度面板')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  await ui.press({ key: 'legend' })
  const dimmed = (node: unknown): number => {
    if (typeof node !== 'object' || node === null) return 0
    const element = node as { type?: string; props?: { dimColor?: boolean }; children?: unknown[] }
    const own = element.type === 'Text' && element.props?.dimColor === true ? 1 : 0
    return own + (element.children ?? []).reduce<number>((sum, child) => sum + dimmed(child), 0)
  }
  const texts = (node: unknown): number => {
    if (typeof node !== 'object' || node === null) return 0
    const element = node as { type?: string; children?: unknown[] }
    return (element.type === 'Text' ? 1 : 0) + (element.children ?? []).reduce<number>((sum, child) => sum + texts(child), 0)
  }
  const tree = await ui.drawn()
  expect(texts(tree)).toBeGreaterThan(10)
  expect(dimmed(tree)).toBe(0)
  await ui.unmount()
})

test('with the language option set to English, the pane, the file and the rule speak English', { options: { language: 'en' } }, async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  await start($, 'Rebuild the progress pane')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Read the API', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Pick a version', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', metadata: { waiting: 'you', why: 'Push 0.7.0 to main?' } })

  expect(world.files.get(FILE)).toContain('# Project progress')
  expect(world.files.get(FILE)).toContain('> Claude is working')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Text', text: 'Needs you now' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '[Confirm]' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Yes' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^▸ All 2 steps$/ })).toBeDefined()
  await ui.unmount()

  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [], tools: ['TaskCreate'] })
  expect(composed.sections[1]?.text).toContain('# Progress pane (project-progress)')
})

test('/progress lang switches the language and remembers it; auto goes back to the system', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  let ran = await $.command.run({ ...TIDY, args: 'lang zh-CN' })
  expect(ran.text).toBe('面板改用简体中文。')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Text', text: '目前没有进行中的工作。' })).toBeDefined()
  await ui.unmount()

  ran = await $.command.run({ ...TIDY, args: 'lang en' })
  expect(ran.text).toBe('The pane now speaks English.')
  ran = await $.command.run({ ...TIDY, args: 'lang klingon' })
  expect(ran.text).toBe('Supported languages: en, zh-TW, zh-CN, auto.')
  ran = await $.command.run({ ...TIDY, args: 'lang auto' })
  expect(ran.text).toBe('面板改用繁體中文。')
})

test('progress.html is written beside progress.md, and /progress open opens it in the browser', async ($, on) => {
  const ran: string[][] = []
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, ran }
  engineBeneath(on, world)
  await start($, '幫我重做進度面板')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  const page = world.files.get('/home/me/.claude/progress.html') ?? ''
  expect(page).toContain('<title>進度</title>')
  expect(page).toContain('Google 暑期實習')

  const result = await $.command.run({ ...TIDY, args: 'open' })
  expect(ran.at(-1)).toEqual(['xdg-open', '/home/me/.claude/progress.html'])
  expect(result.text).toBe('已在瀏覽器打開：/home/me/.claude/progress.html')
})

test('on the phone (no input box) the pane still draws, focus first, with its buttons', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await start($, '幫我重做進度面板')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile', props: PROPS })
  expect(await ui.find({ type: 'Text', text: '現在最需要你' })).toBeDefined()
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.press({ key: '求職::Google 暑期實習::1::done' })
  expect(world.files.get(FILE)).toContain('- [x] 推薦信 — 等教授回覆')
  await ui.unmount()
})

test('another agent’s question is answered there, but its command can be copied and its link opened from here', async ($, on) => {
  const board = `# Project progress

## data-pipeline

<!-- auto session=3db00eaf agent=gemini state=waiting updated=2026-10-16T11:50:00Z -->
### Backfill last year's events
> Context: the warehouse lost three months in the migration
- [x] Write backfill.sh
- [?] Log in to the warehouse — run \`gcloud auth login\` on your own machine
<!-- /auto session=3db00eaf -->

## docs-site

<!-- auto session=239098eb agent=cursor state=waiting updated=2026-10-16T11:55:00Z -->
### October release notes
- [?] Check the preview — https://docs.example.com/preview/2026-10
<!-- /auto session=239098eb -->
`
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, store: { opened: ['waiting'] } }
  engineBeneath(on, world)
  const seen = outside(on)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })

  expect(await ui.find({ type: 'Text', text: '$ gcloud auth login' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /到 data-pipeline 的對話（gemini）回覆/ })).toBeDefined()
  await ui.press({ key: "data-pipeline::Backfill last year's events::1::copy" })
  expect(seen.copied.at(-1)).toBe('gcloud auth login')

  await ui.press({ key: 'ask::docs-site::October release notes::0' })
  const links = (await ui.findAll({ type: 'Link' })).map(link => link.props.href)
  expect(links).toContain('https://docs.example.com/preview/2026-10')
  await ui.unmount()
})

test('封存 on a row takes that task out of the file now and into this month’s archive', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })

  // A session of this project that stopped.
  await ui.press({ key: 'section::others' })
  await ui.press({ key: 'persona_framework::修 CI' })
  await ui.press({ key: 'persona_framework::修 CI::archive' })
  expect(world.files.get(FILE)).not.toContain('修 CI')
  expect(world.files.get(ARCHIVE)).toBe('# 進度封存\n\n## persona_framework · 2026-10-16\n### 修 CI\n- [x] 看 log\n- [ ] 修測試\n')
  expect(await ui.find({ type: 'Text', text: '已封存「修 CI」。' })).toBeDefined()

  // A hand-kept task, steps and note with it.
  await ui.press({ key: '求職::Google 暑期實習' })
  await ui.press({ key: '求職::Google 暑期實習::archive' })
  expect(world.files.get(FILE)).not.toContain('Google')
  expect(world.files.get(ARCHIVE)).toContain('\n\n## 求職 · 2026-10-16\n### Google 暑期實習\n> 截止 12-20\n- [x] 改履歷\n- [?] 推薦信 — 等教授回覆\n- [ ] 投遞\n')
  expect(await ui.find({ type: 'Button', key: '求職::Google 暑期實習' })).toBeUndefined()
  await ui.unmount()
})

test('封存 of a task someone changed meanwhile says so and leaves the file alone', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'section::others' })
  await ui.press({ key: 'persona_framework::修 CI' })
  // Another session reopened the block before the press: it has no end marker now.
  const changed = JOBS.replace('<!-- /auto session=a81d0c42 -->\n', '')
  world.files.set(FILE, changed)
  await ui.press({ key: 'persona_framework::修 CI::archive' })
  expect(world.files.get(FILE)).toBe(changed)
  expect(world.files.has(ARCHIVE)).toBe(false)
  expect(await ui.find({ type: 'Text', text: '找不到這件工作，可能已經改過或封存了。' })).toBeDefined()
  await ui.unmount()
})

const ASKED = (text: string): string => `# 專案進度

## FLOODABM
<!-- auto session=dddddddd agent=codex state=waiting updated=2026-10-16T11:59:00.000Z -->
### 跑實驗
- [?] ${text}
<!-- /auto session=dddddddd -->
`

const DUE = '# 專案進度\n\n## 求職\n### Google 暑期實習\n> 截止 10-16\n- [ ] 投遞\n'

test('a question another agent asks notifies once, not the ones already there at the start', async ($, on) => {
  const world: World = { files: new Map([[FILE, ASKED('要不要重跑 — 可以重跑嗎？')]]), mtime: 1, hasTasks: true, store: { told: { old: Date.parse('2026-10-16T00:00:00.000Z') } } }
  const clock = engineBeneath(on, world)
  const seen = outside(on)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  expect(seen.notified).toEqual([])

  world.files.set(FILE, ASKED('選哪個種子 — 42 還是 7'))
  world.mtime += 1
  await clock.advance(2000)
  expect(seen.notified).toEqual(['codex 在問：選哪個種子'])
  await clock.advance(30 * 1000)
  expect(seen.notified).toEqual(['codex 在問：選哪個種子'])
})

test('work due today notifies once that day', async ($, on) => {
  const world: World = { files: new Map([[FILE, DUE]]), mtime: 1, hasTasks: true, store: { told: { old: Date.parse('2026-10-16T00:00:00.000Z') } } }
  const clock = engineBeneath(on, world)
  const seen = outside(on)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  expect(seen.notified).toEqual(['到期：Google 暑期實習（今天截止）'])
  await clock.advance(60 * 1000)
  expect(seen.notified).toHaveLength(1)
})

test('with notifications off, reminders stay quiet', async ($, on) => {
  const store = { told: { old: Date.parse('2026-10-16T00:00:00.000Z') }, notifyOff: true }
  const world: World = { files: new Map([[FILE, DUE]]), mtime: 1, hasTasks: true, store }
  const clock = engineBeneath(on, world)
  const seen = outside(on)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  world.files.set(FILE, `${DUE}${ASKED('選哪個種子 — 42 還是 7').replace('# 專案進度\n', '')}`)
  world.mtime += 1
  await clock.advance(60 * 1000)
  expect(seen.notified).toEqual([])
})

test('the first run ever says nothing about what is already in the file', async ($, on) => {
  const both = `${DUE}${ASKED('要不要重跑 — 可以重跑嗎？').replace('# 專案進度\n', '')}`
  const world: World = { files: new Map([[FILE, both]]), mtime: 1, hasTasks: true }
  const clock = engineBeneath(on, world)
  const seen = outside(on)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(60 * 1000)
  expect(seen.notified).toEqual([])
})


const EDITED = [
  { role: 'user' as const, text: '幫我把限流加到 API', toolUses: [] },
  { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Edit', input: {} }] },
]

const DIGEST = (prompt: string): string | undefined =>
  prompt.includes('TITLE:')
    ? 'TITLE: 幫 API 加上限流\nCONTEXT: 公開端點被刷爆，要擋掉濫用\nDONE: 加好限流中介層\nNEXT: 寫限流測試\nASK: 每把金鑰的上限 — 一分鐘 100 還是 300？'
    : undefined

test('without a Task list, a turn that changed something is summed up into steps and its question', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: false, messages: EDITED, reply: DIGEST }
  const clock = engineBeneath(on, world)
  const seen = outside(on)
  await start($, '幫我把限流加到 API')
  await $.turn.complete({ answer: '加好了。每把金鑰一分鐘要 100 還是 300？', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)

  const written = world.files.get(FILE) ?? ''
  expect(written).toContain('source=turns')
  expect(written).toContain('### 幫 API 加上限流\n> 等你回覆')
  expect(written).toContain('> 背景：公開端點被刷爆，要擋掉濫用\n- [x] 加好限流中介層\n- [?] 每把金鑰的上限 — 一分鐘 100 還是 300？\n- [ ] 寫限流測試\n')
  expect(seen.notified).toContain('需要你：每把金鑰的上限')

  // The person answers: the question counts as settled; the next turn adds what it did.
  world.reply = (prompt: string) => (prompt.includes('TITLE:') ? 'TITLE: 幫 API 加上限流\nCONTEXT: -\nDONE: 寫好限流測試\nNEXT: -\nASK: -' : undefined)
  await $.turn.start({ text: '100', turnId: 't2' })
  await $.turn.complete({ answer: '測試寫好了，都過了。', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(10)
  const after = world.files.get(FILE) ?? ''
  expect(after).toContain('state=done')
  expect(after).toContain('- [x] 加好限流中介層\n- [x] 每把金鑰的上限\n- [x] 寫好限流測試\n')

  // Claude starting a real list replaces the summed-up steps.
  await $.turn.start({ text: '再加上 IP 限流', turnId: 't3' })
  await $.tool.call({ tool: 'TaskCreate', subject: '加 IP 限流', description: '' })
  const listed = world.files.get(FILE) ?? ''
  expect(listed).not.toContain('source=turns')
  expect(listed).toContain('- [ ] 加 IP 限流\n<!-- /auto')
  expect(listed).not.toContain('加好限流中介層')
})

test('a turn that only answered a question leaves no block behind', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: false, reply: DIGEST, messages: [{ role: 'user', text: '這段程式在做什麼？', toolUses: [] }] }
  const clock = engineBeneath(on, world)
  await start($, '這段程式在做什麼？')
  await $.turn.complete({ answer: '它在解析設定檔。還有別的嗎？', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)
  expect(world.files.get(FILE) ?? '').not.toContain('<!-- auto')
})

test('a turn that ends on a question waits on you even when Claude did not mark it, until you answer', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  const clock = engineBeneath(on, world)
  const seen = outside(on)
  await start($, '幫我重做進度面板')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: '選配色', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
  await $.turn.complete({ answer: '我準備了兩組。\n\n要用和色還是 Nord？', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)
  expect(world.files.get(FILE) ?? '').toContain('- [?] 選配色 — 要用和色還是 Nord？')
  expect(seen.notified).toContain('需要你：選配色')

  await $.turn.start({ text: '和色', turnId: 't2' })
  await clock.advance(10)
  expect(world.files.get(FILE) ?? '').toContain('- [~] 選配色\n')
})

test('a compaction leaves a handoff line in the block', async ($, on) => {
  const world: World = {
    files: new Map(),
    mtime: 1,
    hasTasks: true,
    reply: (prompt: string) => (prompt.includes('交接') ? '交接：讀完 API；卡在授權；下一步寫 Mod' : undefined),
  }
  const clock = engineBeneath(on, world)
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: '摘要：讀完 API，授權那段還沒解', toolUses: [] }] }))
  await start($, '幫我重做進度面板')
  await $.tool.call({ tool: 'TaskCreate', subject: '讀 API', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: '寫 Mod', description: '' })
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: '幫我重做進度面板', toolUses: [] }] })
  await clock.advance(10)
  expect(world.files.get(FILE) ?? '').toContain('> 交接：讀完 API；卡在授權；下一步寫 Mod\n')
})

test('a stopped session’s handoff line shows on its row and goes with 接手做完', async ($, on) => {
  const file = JOBS.replace('### 修 CI\n', '### 修 CI\n> 交接：log 看完了；卡在 flaky 測試；下一步重跑三次\n')
  const world: World = { files: new Map([[FILE, file]]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  const submitted: string[] = []
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'section::others' })
  await ui.press({ key: 'persona_framework::修 CI' })
  expect(await ui.find({ type: 'Text', text: '交接：log 看完了；卡在 flaky 測試；下一步重跑三次' })).toBeDefined()
  await ui.press({ key: 'persona_framework::修 CI::take' })
  expect(submitted.at(-1)).toContain('交接：log 看完了；卡在 flaky 測試；下一步重跑三次')
  await ui.unmount()
})


const INBOX = '/home/me/.claude/progress-inbox'

test('another agent’s turn, left in the inbox by its hook, becomes its block once, read by one session', async ($, on) => {
  const payload = JSON.stringify({
    type: 'agent-turn-complete',
    'thread-id': '0199a7c3-codex-thread',
    cwd: '/work/api-gateway',
    'input-messages': ['幫我把公開端點加上限流'],
    'last-assistant-message': '中介層加好了。每把金鑰一分鐘要 100 還是 300？',
  })
  const world: World = {
    files: new Map([
      [FILE, '# 專案進度\n'],
      [`${INBOX}/codex-turn-1760000000-42.json`, payload],
    ]),
    mtime: 1,
    hasTasks: true,
    reply: DIGEST,
  }
  const clock = engineBeneath(on, world)
  const seen = outside(on)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)

  const text = world.files.get(FILE) ?? ''
  expect(text).toContain('## api-gateway\n\n<!-- auto session=')
  expect(text).toContain('agent=codex state=waiting')
  expect(text).toContain('- [?] 每把金鑰的上限 — 一分鐘 100 還是 300？')
  expect(seen.notified.some(line => line.includes('codex 在問：每把金鑰的上限'))).toBe(true)

  // Read once: the same file does not add the step again.
  world.mtime += 1
  await clock.advance(5000)
  expect((world.files.get(FILE) ?? '').match(/加好限流中介層/g)).toHaveLength(1)

  // The session ends: its block says so.
  world.files.set(`${INBOX}/codex-end-1760000100-43.json`, JSON.stringify({ session_id: '0199a7c3-codex-thread', cwd: '/work/api-gateway' }))
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.get(FILE) ?? '').toContain('agent=codex state=ended')
})


test('/progress connect hooks the installed agents into the pane once, keeps their own hooks, and takes ours back out', async ($, on) => {
  const section = '<!-- claude-progress-pane:start -->\n## Report your progress\n<!-- claude-progress-pane:end -->\n'
  const world: World = {
    files: new Map([
      ['/home/me/.codex/config.toml', 'model = "gpt-6"\n'],
      ['/home/me/.codex/AGENTS.md', `# Mine\n\nUse tabs.\n\n${section}`],
      ['/home/me/.cursor/hooks.json', JSON.stringify({ version: 1, hooks: { stop: [{ command: 'say done' }] } })],
      ['/home/me/.gemini/settings.json', '{ // my comment\n "theme": "dark" }'],
    ]),
    mtime: 1,
    hasTasks: true,
    ran: [],
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })

  const first = await $.command.run({ ...TIDY, args: 'connect' })
  expect(first.text).toContain('已接上：Codex、Cursor。')
  expect(first.text).toContain('Codex 第一次要在它的 /hooks 裡核准這個 hook 才會跑。')
  expect(first.text).toContain('Gemini CLI 的設定檔讀不懂，沒有動它：/home/me/.gemini/settings.json')
  expect(world.files.get('/home/me/.claude/progress-report.sh')).toContain("dir='/home/me/.claude/progress-inbox'")
  const codex = JSON.parse(world.files.get('/home/me/.codex/hooks.json') ?? '{}')
  expect(codex.hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: "sh '/home/me/.claude/progress-report.sh' codex turn", timeout: 10 })
  expect(codex.hooks.SessionEnd[0].hooks[0].command).toBe("sh '/home/me/.claude/progress-report.sh' codex end")
  expect(world.files.get('/home/me/.codex/AGENTS.md')).toBe('# Mine\n\nUse tabs.\n')
  expect(world.files.get('/home/me/.gemini/settings.json')).toBe('{ // my comment\n "theme": "dark" }')

  // Again: nothing doubles.
  await $.command.run({ ...TIDY, args: 'connect' })
  const cursor = JSON.parse(world.files.get('/home/me/.cursor/hooks.json') ?? '{}')
  expect(cursor.hooks.stop).toEqual([{ command: 'say done' }, { command: "sh '/home/me/.claude/progress-report.sh' cursor turn" }])
  expect(cursor.hooks.afterAgentResponse).toHaveLength(1)
  expect(cursor.hooks.sessionEnd).toEqual([{ command: "sh '/home/me/.claude/progress-report.sh' cursor end" }])

  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).toContain('已拿掉：Codex、Cursor。')
  expect(JSON.parse(world.files.get('/home/me/.cursor/hooks.json') ?? '{}').hooks).toEqual({ stop: [{ command: 'say done' }] })
  expect(JSON.parse(world.files.get('/home/me/.codex/hooks.json') ?? '{}').hooks).toEqual({})
})

// What Codex 0.163.0 handed its Stop and SessionEnd hooks, and the lines of its session log the
// pane reads, from a real `codex exec` turn (home directory renamed to /home/me).
const CODEX_STOP = "{\"session_id\":\"01a1486b-b48b-7621-8c35-f8c0c2e2d4f6\",\"turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"transcript_path\":\"/home/me/.codex/sessions/2026/10/17/rollout-2026-10-17T05-53-00-01a1486b-b48b-7621-8c35-f8c0c2e2d4f6.jsonl\",\"cwd\":\"/home/me/work/api-gateway\",\"hook_event_name\":\"Stop\",\"model\":\"mock-model\",\"permission_mode\":\"bypassPermissions\",\"stop_hook_active\":false,\"last_assistant_message\":\"Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?\"}"
const CODEX_END = "{\"session_id\":\"01a1486b-b48b-7621-8c35-f8c0c2e2d4f6\",\"transcript_path\":\"/home/me/.codex/sessions/2026/10/17/rollout-2026-10-17T05-53-00-01a1486b-b48b-7621-8c35-f8c0c2e2d4f6.jsonl\",\"cwd\":\"/home/me/work/api-gateway\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
const CODEX_ROLLOUT = "{\"timestamp\":\"2026-10-17T05:53:00.625Z\",\"ordinal\":3,\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg_01a1486b-b4cb-7423-9bc1-70f09cad585f\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<environment_context>\\n  <cwd>/home/me/work/api-gateway</cwd>\\n  <shell>bash</shell>\\n  <current_date>2026-10-17</current_date>\\n  <timezone>Etc/UTC</timezone>\\n  <filesystem><workspace_roots><root>/home/me/work/api-gateway</root></workspace_roots><permission_profile type=\\\"managed\\\"><file_system type=\\\"restricted\\\"><entry access=\\\"read\\\"><special>:root</special></entry></file_system></permission_profile></filesystem>\\n</environment_context>\"}],\"internal_chat_message_metadata_passthrough\":{\"turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"create_time\":1792216380.6198695,\"content_item_kinds\":[\"environments.environment_context\"]}}}\n{\"timestamp\":\"2026-10-17T05:53:00.644Z\",\"ordinal\":7,\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg_01a1486b-b4e4-7b50-a7d0-331c8e1059ec\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Add rate limiting to the public endpoints\"}],\"internal_chat_message_metadata_passthrough\":{\"turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"create_time\":1792216380.6447554,\"content_item_kinds\":[\"user.text\"]}},\"metadata\":{\"retained_source\":{\"id\":{\"message_id\":\"msg_01a1486b-b4e4-7b50-a7d0-331c8e1059ec\",\"turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"role\":\"user\"},\"revision\":\"retained_01a1486b-b4e4-7b50-a7d0-333ccd7ec592\",\"complete\":true},\"client_authored\":false,\"user_input_order\":0,\"mcp_attribution\":{\"status\":\"none\"}}}\n{\"timestamp\":\"2026-10-17T05:53:00.664Z\",\"ordinal\":10,\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg_1\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?\"}],\"internal_chat_message_metadata_passthrough\":{\"turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"content_item_kinds\":[\"unknown\"]}},\"metadata\":{\"retained_source\":{\"id\":{\"message_id\":\"msg_1\",\"turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"role\":\"assistant\"},\"revision\":\"retained_01a1486b-b4f8-7542-ab8c-2860525eccd1\",\"complete\":true},\"client_authored\":false,\"user_input_order\":1}}\n{\"timestamp\":\"2026-10-17T05:53:00.708Z\",\"ordinal\":13,\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"root_turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"last_agent_message\":\"Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?\",\"started_at\":1792216380,\"completed_at\":1792216380,\"duration_ms\":123,\"time_to_first_token_ms\":76}}\n"

test('a real Codex turn and its session end, written in the same second, become one ended block named from the request', async ($, on) => {
  const rollout = '/home/me/.codex/sessions/2026/10/17/rollout-2026-10-17T05-53-00-01a1486b-b48b-7621-8c35-f8c0c2e2d4f6.jsonl'
  const asked: string[] = []
  const world: World = {
    files: new Map([
      [FILE, '# 專案進度\n'],
      [rollout, CODEX_ROLLOUT],
      // The same second: sorted by name, the end would come first.
      [`${INBOX}/codex-end-1792216380-1500.json`, CODEX_END],
      [`${INBOX}/codex-turn-1792216380-1473.json`, CODEX_STOP],
    ]),
    mtime: 1,
    hasTasks: true,
    reply: (prompt: string) => {
      asked.push(prompt)
      return prompt.includes('TITLE:')
        ? 'TITLE: 公開端點加上限流\nCONTEXT: -\nDONE: 加好 token bucket 中介層\nNEXT: -\nASK: 每把金鑰的上限 — 一分鐘 100 還是 300？'
        : undefined
    },
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)

  // The request came from the session log, since Stop carries only the reply.
  expect(asked.some(prompt => prompt.includes('Add rate limiting to the public endpoints'))).toBe(true)
  const text = world.files.get(FILE) ?? ''
  expect(text).toContain('## api-gateway\n\n<!-- auto session=')
  expect(text).toContain('agent=codex state=ended')
  expect(text).toContain('### 公開端點加上限流\n')
  expect(text).toContain('- [x] 加好 token bucket 中介層\n- [?] 每把金鑰的上限 — 一分鐘 100 還是 300？\n')
})
