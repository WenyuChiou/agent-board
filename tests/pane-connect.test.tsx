import {
  BOARD_FILES,
  BOARD_SCRIPT_FILE,
  CODEX_END,
  CODEX_ROLLOUT,
  CODEX_STOP,
  CONNECT,
  CONNECT_BOOTSTRAP,
  CONNECT_EXECUTE,
  EN,
  EVERY_AGENT,
  FILE,
  GROK_STOP,
  INBOX,
  NODE_MIN,
  PANE,
  PROPS,
  RELEASE_0_18_1,
  RELEASE_0_20_5,
  REPORTER_FILE,
  STRINGS,
  TIDY,
  ZH_CN,
  ZH_TW,
  agentHooks,
  boardScript,
  connectDataRoots,
  controlFile,
  engineBeneath,
  expect,
  fromEarlierRelease,
  grokHook,
  hasOwnConnectData,
  here,
  isSetupState,
  nativeState,
  openclawPlugin,
  outside,
  pendingQuestionEntries,
  releasedBoard,
  settledSetup,
  sha256,
  start,
  takeInbox,
  takenOf,
  test,
  type ConnectState,
  type World,
} from './pane-helpers'



test('/progress connect hooks the installed agents into the pane once, keeps their own hooks, and takes ours back out', { options: { autoConnect: true } }, async ($, on) => {
  // Both written under the plugin's earlier name, claude-progress-pane: they go.
  const section = '<!-- claude-progress-pane:start -->\n## Report your progress\n<!-- claude-progress-pane:end -->\n'
  const oldGrok = '/home/me/.grok/hooks/progress-pane.json'
  const world: World = {
    files: new Map([
      ['/home/me/.codex/config.toml', 'model = "gpt-6"\n'],
      ['/home/me/.codex/AGENTS.md', `# Mine\n\nUse tabs.\n\n${section}`],
      [oldGrok, grokHook()],
      ['/home/me/.grok/.metadata_version', '3'],

      ['/home/me/.grok/config.toml', 'model = "grok-build"\n'],
      ['/home/me/.cursor/hooks.json', JSON.stringify({ version: 1, hooks: { stop: [{ command: 'say done' }] } })],
      ['/home/me/.gemini/settings.json', '{ // my comment\n "theme": "dark" }'],
    ]),
    mtime: 1,
    hasTasks: true,
    ran: [],
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)

  const first = await $.command.run({ ...TIDY, args: 'connect' })
  expect(first.text).toContain('已接上：Codex、Cursor、Grok Build。')
  expect(world.files.get('/home/me/.grok/hooks/agent-board.json')).toContain("progress-report.sh' grok turn || true")
  expect(first.text).toContain(ZH_TW.setupCodexTrust)
  expect(first.text).toContain('Gemini CLI 的設定檔讀不懂，沒有動它：/home/me/.gemini/settings.json')
  expect(world.files.get('/home/me/.claude/progress-report.sh')).toContain("dir='/home/me/.claude/progress-inbox'")
  const codex = JSON.parse(world.files.get('/home/me/.codex/hooks.json') ?? '{}')
  expect(codex.hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: "sh '/home/me/.claude/progress-report.sh' codex turn || true", timeout: 10 })
  expect(codex.hooks.SessionEnd[0].hooks[0].command).toBe("sh '/home/me/.claude/progress-report.sh' codex end || true")
  expect(world.files.get('/home/me/.codex/AGENTS.md')).toBe(`# Mine\n\nUse tabs.\n\n${section}`)
  expect(world.files.get('/home/me/.gemini/settings.json')).toBe('{ // my comment\n "theme": "dark" }')

  // Again: nothing doubles.
  await $.command.run({ ...TIDY, args: 'connect' })
  const cursor = JSON.parse(world.files.get('/home/me/.cursor/hooks.json') ?? '{}')
  expect(cursor.hooks.stop).toEqual([{ command: 'say done' }, { command: "sh '/home/me/.claude/progress-report.sh' cursor turn || true", timeout: 3 }])
  expect(cursor.hooks.afterAgentResponse).toHaveLength(1)
  expect(cursor.hooks.sessionEnd).toEqual([{ command: "sh '/home/me/.claude/progress-report.sh' cursor end || true", timeout: 3 }])

  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).toContain('已拿掉：Codex、Cursor、Grok Build。')
  expect(JSON.parse(world.files.get('/home/me/.cursor/hooks.json') ?? '{}').hooks).toEqual({ stop: [{ command: 'say done' }] })
  expect(JSON.parse(world.files.get('/home/me/.codex/hooks.json') ?? '{}').hooks).toEqual({})
})

test('a ~/.grok folder with only another tool’s hooks in it is not taken for Grok Build, and connect remove still takes out a hook left there', { options: { autoConnect: true } }, async ($, on) => {
  const orca = '/home/me/.grok/hooks/orca-status.json'
  const ours = '/home/me/.grok/hooks/agent-board.json'
  const world: World = { files: new Map([[orca, '{"hooks":{}}']]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })

  const first = await $.command.run({ ...TIDY, args: 'connect' })
  expect(first.text).not.toContain('已接上')
  expect(world.files.has(ours)).toBe(false)
  expect(world.files.has('/home/me/.agents/skills/agent-board/SKILL.md')).toBe(false)

  // An earlier version took the folder for Grok Build and wrote its hook there.
  world.files.set(ours, grokHook())
  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).toContain('已拿掉：Grok Build。')
  expect(world.files.has(ours)).toBe(false)
  expect(world.files.get(orca)).toBe('{"hooks":{}}')

  // Grok Build itself writes its sessions here: now it is installed.
  world.files.set('/home/me/.grok/sessions/%2Fwork/01a148a9/updates.jsonl', '')
  const again = await $.command.run({ ...TIDY, args: 'connect' })
  expect(again.text).toContain('已接上：Grok Build。')
  expect(world.files.get(ours)).toContain("progress-report.sh' grok turn || true")
})

test('a real Codex turn and its session end, written in the same second, become one ended block named from the request', { options: { autoConnect: true } }, async ($, on) => {
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

test('a session start does not wait for the connect worker\'s Codex check', { options: { autoConnect: true } }, async ($, on) => {
  let reached!: () => void
  let release!: () => void
  const waiting = new Promise<void>(done => { reached = done })
  const held = new Promise<void>(done => { release = done })
  const world: World = { files: new Map([[FILE, '# Progress\n'], ['/home/me/.codex/config.toml', '']]), mtime: 1, hasTasks: true, workerGate: { reached, release: held }, store: { inboxDone: {}, autoConnectOff: false }, stats: [] }
  const clock = engineBeneath(on, world)
  outside(on, world)
  try {
    await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
    await waiting
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
    expect(await ui.find({ type: 'Text', text: ZH_TW.empty })).toBeDefined()
    await clock.advance(5000)
    expect(world.stats?.some(path => path.endsWith('progress.md'))).toBe(true)
    const answer = await $.command.run({ ...TIDY, args: '' })
    expect(answer).toBeDefined()
    await ui.unmount()
  } finally {
    release()
    await settledSetup($, world)
  }
})

test('startup shows the pane and polls the inbox while a version probe waits and remove fences its delayed auto request', { options: { autoConnect: true } }, async ($, on) => {
  let reached!: () => void
  let release!: () => void
  const waiting = new Promise<void>(done => { reached = done })
  const held = new Promise<void>(done => { release = done })
  const world: World = { files: new Map([[FILE, '# Progress\n'], ['/home/me/.codex/config.toml', '']]), mtime: 1, hasTasks: true, nodeGate: { reached, release: held }, store: { inboxDone: {}, autoConnectOff: false }, stats: [] }
  const clock = engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await waiting
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Text', text: ZH_TW.empty })).toBeDefined()
  await clock.advance(5000)
  expect(world.stats?.some(path => path.endsWith('progress.md'))).toBe(true)
  await $.command.run({ ...TIDY, args: 'connect remove' })
  release()
  await settledSetup($, world)
  expect(nativeState(world).disabled).toBe(true)
  expect(world.files.has('/home/me/.codex/hooks.json')).toBe(false)
  expect(world.store?.autoConnectOff).toBe(false)
  expect(seen.notified.some(text => text.includes('已自動接上：Codex'))).toBe(false)
  await ui.unmount()
})

for (const fault of ['node', 'bootstrap', 'worker', 'corrupt'] as const) test(`the setup adapter fails closed for ${fault} without falling back to engine config writes`, { options: { autoConnect: true } }, async ($, on) => {
  const config = '/home/me/.codex/hooks.json'
  const before = '{"private":"synthetic-preserve"}'
  const world: World = { files: new Map([[FILE, '# Progress\n'], [config, before]]), mtime: 1, hasTasks: true, store: { inboxDone: {}, autoConnectOff: true }, ...(fault === 'node' ? { node: null } : fault === 'bootstrap' ? { bootstrapFailure: true } : fault === 'worker' ? { workerFailure: 'LOCK_BUSY' } : {}) }
  if (fault === 'corrupt') world.files.set('/home/me/.agent-board/legacy-connect.json', '{broken')
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const result = await $.command.run({ ...TIDY, args: 'connect' })
  expect(result.text).toContain('代理設定未能完成')
  expect(world.files.get(config)).toBe(before)
  expect(world.store?.autoConnectOff).toBe(true)
  expect(world.files.has('/home/me/.claude/progress-report.sh')).toBe(false)
})

test('on Windows, a progress file written with forward slashes still gets the PowerShell reporter', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = {
    files: new Map(),
    mtime: 1,
    hasTasks: true,
    env: { OS: 'Windows_NT', USERPROFILE: 'C:/Users/me', CLAUDE_PROGRESS_FILE: 'C:/Users/me/.claude/progress.md', LANG: 'en_US.UTF-8' },
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TIDY, args: 'connect' })

  const written = [...world.files.keys()]
  expect(written.some(path => /Users\/me\/\.claude\/progress-report\.ps1$/.test(path))).toBe(true)
  expect(written.some(path => path.endsWith('progress-report.sh'))).toBe(false)
})

test('a session hooks in the agents installed here without /progress connect, and says so in the pane and once by notification', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.codex/config.toml', 'model = "gpt-6"\n']]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  const codex = JSON.parse(world.files.get('/home/me/.codex/hooks.json') ?? '{}')
  expect(codex.hooks.Stop[0].hooks[0].command).toBe("sh '/home/me/.claude/progress-report.sh' codex turn || true")
  expect(world.files.get('/home/me/.claude/progress-report.sh')).toContain("dir='/home/me/.claude/progress-inbox'")
  expect(seen.notified).toHaveLength(1)
  expect(seen.notified[0]).toContain('已自動接上：Codex。重開它們之後，每個回合都會出現在這裡。')
  expect(seen.notified[0]).toContain('尚未確認目前 Codex hook 的核准狀態。請檢查 /hooks；已有的受管理回報指示會保留。')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /Codex 第一次要在它的 \/hooks 裡核准這個 hook 才會跑。/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\/progress connect remove/ })).toBeDefined()
})

for (const isAuto of [true, false]) test(`OpenCode connect uses its effective config root for ${isAuto ? 'automatic' : 'manual'} setup, repeat and removal`, { options: { autoConnect: isAuto } }, async ($, on) => {
  const root = '/tmp/config with spaces/設定/opencode'
  const defaultRoot = '/home/me/.config/opencode'
  const instructions = '# My rules\n\n<!-- agent-board:start -->\n## Report your progress to the progress pane\nOld board rule\n<!-- agent-board:end -->\n'
  const foreign = '// Personal plugin\n'
  const world: World = {
    files: new Map([
      [`${root}/opencode.json`, '{}'], [`${root}/AGENTS.md`, instructions],
      [`${defaultRoot}/plugin/agent-board.js`, foreign], [`${defaultRoot}/AGENTS.md`, instructions],
    ]),
    env: { HOME: '/home/me', XDG_CONFIG_HOME: '/tmp/config with spaces/設定/', LANG: 'en_US.UTF-8' },
    store: { inboxDone: {} }, mtime: 1, hasTasks: true, ran: [],
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  if (isAuto) await settledSetup($, world)
  if (!isAuto) await $.command.run({ ...TIDY, args: 'connect' })
  const plugin = `${root}/plugin/agent-board.js`
  const command = `${root}/commands/board.md`
  const skill = '/home/me/.agents/skills/agent-board/SKILL.md'
  expect(world.files.get(plugin)).toContain('export const AgentBoard')
  expect(world.files.get(command)).toContain('--serve')
  expect(world.files.get(skill)).toContain('--serve')
  expect(world.files.get(`${root}/AGENTS.md`)).toBe('# My rules\n')
  expect(world.files.get(`${defaultRoot}/plugin/agent-board.js`)).toBe(foreign)
  expect(world.files.get(`${defaultRoot}/AGENTS.md`)).toBe(instructions)
  const before = world.files.get(plugin)
  await $.command.run({ ...TIDY, args: 'connect' })
  expect(world.files.get(plugin)).toBe(before)
  expect((await $.command.run({ ...TIDY, args: 'connect status' })).text).toContain(EN.setupAgent('OpenCode', [EN.setupHookConfigured, EN.setupBoardReady]))
  await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(world.files.has(plugin)).toBe(false)
  expect(world.files.has(command)).toBe(false)
  expect(world.files.get(`${root}/opencode.json`)).toBe('{}')
  expect(world.files.get(`${root}/AGENTS.md`)).toBe('# My rules\n')
  expect(world.files.get(`${defaultRoot}/plugin/agent-board.js`)).toBe(foreign)
  expect(world.files.get(`${defaultRoot}/AGENTS.md`)).toBe(instructions)
})

test('OpenCode explicit config root wins over XDG when using the Windows reporter', { options: { autoConnect: true } }, async ($, on) => {
  const root = '/Agent Config/設定/OpenCode'
  const world: World = {
    files: new Map([[`${root}/opencode.json`, '{}'], ['/xdg/opencode/opencode.json', '{}']]),
    env: { OS: 'Windows_NT', USERPROFILE: 'C:/Users/me', OPENCODE_CONFIG_DIR: `${root}/`, XDG_CONFIG_HOME: 'C:/xdg', CLAUDE_PROGRESS_FILE: 'C:/Users/me/.claude/progress.md', LANG: 'en_US.UTF-8' },
    mtime: 1, hasTasks: true,
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(world.files.get(`${root}/plugin/agent-board.js`)).toContain('export const AgentBoard')
  expect(world.files.get(`${root}/commands/board.md`)).toContain('--serve')
  expect(world.files.has('/xdg/opencode/plugin/agent-board.js')).toBe(false)
  expect(world.files.has('/xdg/opencode/commands/board.md')).toBe(false)
  expect(world.files.get(`${root}/opencode.json`)).toBe('{}')
})

test('OpenCode config override wins over XDG and a stale default directory never indicates installation', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = {
    files: new Map([['/home/me/.config/opencode/opencode.json', '{}'], ['/tmp/xdg/opencode/opencode.json', '{}']]),
    env: { HOME: '/home/me', OPENCODE_CONFIG_DIR: '/tmp/missing/', XDG_CONFIG_HOME: '/tmp/xdg', LANG: 'en_US.UTF-8' },
    mtime: 1, hasTasks: true,
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect((await $.command.run({ ...TIDY, args: 'connect status' })).text).toBe(`${EN.setupStatusTitle}\n${EN.connectNone}`)
  for (const root of ['/home/me/.config/opencode', '/tmp/xdg/opencode', '/tmp/missing']) {
    expect(world.files.has(`${root}/plugin/agent-board.js`)).toBe(false)
    expect(world.files.has(`${root}/commands/board.md`)).toBe(false)
  }
  expect(world.files.has('/home/me/.agents/skills/agent-board/SKILL.md')).toBe(false)
})

test('a session hooks OpenClaw in by a plugin file and its config entry, names it once, and takes both back out', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.openclaw/openclaw.json', '{"gateway":{"port":18789}}']]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(world.files.get('/home/me/.openclaw/agent-board.mjs')).toContain('const INBOX = "/home/me/.claude/progress-inbox"')
  const config = JSON.parse(world.files.get('/home/me/.openclaw/openclaw.json') ?? '{}')
  expect(config.gateway).toEqual({ port: 18789 })
  expect(config.plugins.load.paths).toEqual(['/home/me/.openclaw/agent-board.mjs'])
  expect(config.plugins.entries['agent-board']).toEqual({ enabled: true, hooks: { allowConversationAccess: true } })
  expect(seen.notified).toEqual(['已自動接上：OpenClaw。重開它們之後，每個回合都會出現在這裡。'])

  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).toContain('已拿掉：OpenClaw。')
  expect(JSON.parse(world.files.get('/home/me/.openclaw/openclaw.json') ?? '{}')).toEqual({ gateway: { port: 18789 }, plugins: {} })
})

test('connecting writes the board script and each installed agent’s board command, says how to open them, and removing takes them out', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}'], ['/home/me/.codex/config.toml', '']]), dirs: new Set(['/home/me/.agents/skills/agent-board']), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  const board = world.files.get('/home/me/.claude/agent-board.mjs') ?? ''
  expect(board.split('\n')[0]).toBe('globalThis.AGENT_BOARD = {"hookVersion":1,"path":"/home/me/.claude/progress.md","lang":"zh-TW"}')
  const geminiPrompt = /^prompt = (.*)$/m.exec(world.files.get('/home/me/.gemini/commands/board.toml') ?? '')?.[1] ?? 'null'
  expect(JSON.parse(geminiPrompt)).toContain('!{node "/home/me/.claude/agent-board.mjs" --serve}')
  expect(world.files.get('/home/me/.agents/skills/agent-board/SKILL.md')).toContain('node "/home/me/.claude/agent-board.mjs"')
  expect(world.files.has('/home/me/.config/opencode/commands/board.md')).toBe(false)

  const again = await $.command.run({ ...TIDY, args: 'connect' })
  expect(again.text).toContain('Codex 打 $agent-board')
  expect(again.text).toContain('node "/home/me/.claude/agent-board.mjs" --watch')
  await $.command.run({ ...TIDY, args: 'connect remove' })
  for (const file of ['/home/me/.claude/agent-board.mjs', '/home/me/.gemini/commands/board.toml', '/home/me/.agents/skills/agent-board/SKILL.md']) {
    expect(world.files.has(file)).toBe(false)
  }
})

test('a session whose system speaks another language leaves the board script and skill in the language they hold, until the person picks one, auto included', { options: { autoConnect: true } }, async ($, on) => {
  const board = '/home/me/.claude/agent-board.mjs'
  const skill = '/home/me/.agents/skills/agent-board/SKILL.md'
  // A desktop session with LANG=zh_TW wrote them; this terminal session's LANG is English.
  const world: World = {
    files: new Map([
      ['/home/me/.codex/config.toml', ''],
      // What a release wrote in that language, so it is the plugin's own to rewrite.
      [board, boardScript('/home/me/.claude/progress.md', 'zh-TW')],
    ]),
    env: { HOME: '/home/me', LANG: 'en_US.UTF-8' },
    mtime: 1,
    hasTasks: true,
    ran: [],
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect((world.files.get(board) ?? '').split('\n')[0]).toBe('globalThis.AGENT_BOARD = {"hookVersion":1,"path":"/home/me/.claude/progress.md","lang":"zh-TW"}')
  expect(world.files.get(skill)).toContain(`description: ${JSON.stringify(ZH_TW.boardCommandDescription)}`)

  // A language picked takes the files with it at once; so does going back to auto, which
  // then means this session's.
  await $.command.run({ ...TIDY, args: 'lang zh-CN' })
  expect((world.files.get(board) ?? '').split('\n')[0]).toBe('globalThis.AGENT_BOARD = {"hookVersion":1,"path":"/home/me/.claude/progress.md","lang":"zh-CN"}')
  expect(world.files.get(skill)).toContain(`description: ${JSON.stringify(ZH_CN.boardCommandDescription)}`)
  await $.command.run({ ...TIDY, args: 'lang auto' })
  expect((world.files.get(board) ?? '').split('\n')[0]).toBe('globalThis.AGENT_BOARD = {"hookVersion":1,"path":"/home/me/.claude/progress.md","lang":"en"}')
  expect(world.files.get(skill)).toContain(`description: ${JSON.stringify(EN.boardCommandDescription)}`)
})

test('with the autoConnect option off, going back to auto reaches the board script and skill at the next connect run by hand', { options: { autoConnect: false } }, async ($, on) => {
  const board = '/home/me/.claude/agent-board.mjs'
  const skill = '/home/me/.agents/skills/agent-board/SKILL.md'
  // An earlier `/progress lang zh-CN` wrote them; this session's LANG is English.
  const world: World = {
    files: new Map([
      ['/home/me/.codex/config.toml', ''],
      // What a release wrote in that language, so it is the plugin's own to rewrite.
      [board, boardScript('/home/me/.claude/progress.md', 'zh-CN')],
    ]),
    env: { HOME: '/home/me', LANG: 'en_US.UTF-8' },
    mtime: 1,
    hasTasks: true,
    ran: [],
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  // Nothing is written behind the person's back, so the files wait for a connect.
  await $.command.run({ ...TIDY, args: 'lang auto' })
  expect((world.files.get(board) ?? '').split('\n')[0]).toBe('globalThis.AGENT_BOARD = {"hookVersion":1,"path":"/home/me/.claude/progress.md","lang":"zh-CN"}')
  await $.command.run({ ...TIDY, args: 'connect' })
  expect((world.files.get(board) ?? '').split('\n')[0]).toBe('globalThis.AGENT_BOARD = {"hookVersion":1,"path":"/home/me/.claude/progress.md","lang":"en"}')
  expect(world.files.get(skill)).toContain(`description: ${JSON.stringify(EN.boardCommandDescription)}`)
})

test('a connect run by hand takes the language another session picked after this one started, auto included', { options: { autoConnect: false } }, async ($, on) => {
  const board = '/home/me/.claude/agent-board.mjs'
  const skill = '/home/me/.agents/skills/agent-board/SKILL.md'
  // This session started while `/progress lang zh-CN` was the person's pick.
  const shared: Record<string, unknown> = { inboxDone: {}, lang: 'zh-CN', boardLang: 'zh-CN' }
  const world: World = {
    files: new Map([
      ['/home/me/.codex/config.toml', ''],
      // What a release wrote in that language, so it is the plugin's own to rewrite.
      [board, boardScript('/home/me/.claude/progress.md', 'zh-CN')],
    ]),
    env: { HOME: '/home/me', LANG: 'en_US.UTF-8' },
    mtime: 1,
    hasTasks: true,
    ran: [],
    shared,
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })

  // Another session, whose LANG is English, then ran `/progress lang auto`.
  delete shared.lang
  const native = nativeState(world)
  native.boardLang = 'en'
  world.files.set('/home/me/.agent-board/legacy-connect.json', JSON.stringify(native))
  await $.command.run({ ...TIDY, args: 'connect' })
  expect((world.files.get(board) ?? '').split('\n')[0]).toBe('globalThis.AGENT_BOARD = {"hookVersion":1,"path":"/home/me/.claude/progress.md","lang":"en"}')
  expect(world.files.get(skill)).toContain(`description: ${JSON.stringify(EN.boardCommandDescription)}`)

  // And then `/progress lang zh-TW`.
  shared.lang = 'zh-TW'
  native.boardLang = 'zh-TW'
  world.files.set('/home/me/.agent-board/legacy-connect.json', JSON.stringify(native))
  await $.command.run({ ...TIDY, args: 'connect' })
  expect((world.files.get(board) ?? '').split('\n')[0]).toBe('globalThis.AGENT_BOARD = {"hookVersion":1,"path":"/home/me/.claude/progress.md","lang":"zh-TW"}')
  expect(world.files.get(skill)).toContain(`description: ${JSON.stringify(ZH_TW.boardCommandDescription)}`)
})

test('the plugin’s language option gives the board script and skill their language ahead of the one /progress lang last picked', { options: { autoConnect: true, language: 'zh-CN' } }, async ($, on) => {
  const board = '/home/me/.claude/agent-board.mjs'
  const skill = '/home/me/.agents/skills/agent-board/SKILL.md'
  const world: World = {
    files: new Map([
      ['/home/me/.codex/config.toml', ''],
      // What a release wrote in that language, so it is the plugin's own to rewrite.
      [board, boardScript('/home/me/.claude/progress.md', 'en')],
    ]),
    env: { HOME: '/home/me', LANG: 'en_US.UTF-8' },
    mtime: 1,
    hasTasks: true,
    ran: [],
    store: { inboxDone: {}, lang: 'en', boardLang: 'en' },
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect((world.files.get(board) ?? '').split('\n')[0]).toBe('globalThis.AGENT_BOARD = {"hookVersion":1,"path":"/home/me/.claude/progress.md","lang":"zh-CN"}')
  expect(world.files.get(skill)).toContain(`description: ${JSON.stringify(ZH_CN.boardCommandDescription)}`)
})

test('an agent’s turn that only showed the board gets no block', { options: { autoConnect: true } }, async ($, on) => {
  const look = JSON.stringify({ session_id: 'c9', cwd: '/home/me/work/api-gateway', prompt: '$agent-board', last_assistant_message: 'Here it is. The release plan needs you first.' })
  const { text, asked } = await takeInbox($, on, [[`${INBOX}/codex-turn-1792220000-1.json`, look]])
  expect(asked).toEqual([])
  expect(text).not.toContain('agent=codex')
})

test('a Grok Build turn that printed the board for a plain request gets no block, and copies no other project’s question', { options: { autoConnect: true } }, async ($, on) => {
  // Grok Build 1.0.62 took "我想看一下目前所有專案的進度" for the board skill on its own.
  const board = '```\nProgress  ● 1 waiting  ▸ 2 in progress  ⚑ 0 due soon  ✓ 0 done today\n\n● Waiting on you\n  persona_framework › T10\n    [Review] Three rejudgments wait for your call\n```\n\nThe T10 review needs you first.'
  const stop = { ...JSON.parse(GROK_STOP), lastAssistantMessage: board, last_assistant_message: board }
  const { text, asked } = await takeInbox($, on, [[`${INBOX}/grok-turn-1792220000-1.json`, JSON.stringify(stop)]])
  expect(asked).toEqual([])
  expect(text).not.toContain('agent=grok')
})

test('an OpenClaw older than 2026.4.24 is not hooked in, what an earlier connect put there comes back out, and connecting by hand says why', { options: { autoConnect: true } }, async ($, on) => {
  const meta = { lastTouchedVersion: '2026.3.8' }
  const earlier = { meta, gateway: { port: 18789 }, plugins: { load: { paths: ['/home/me/.openclaw/agent-board.mjs'] }, entries: { 'agent-board': { enabled: true, hooks: { allowConversationAccess: true } } } } }
  const world: World = { files: new Map([['/home/me/.openclaw/openclaw.json', JSON.stringify(earlier)], ['/home/me/.openclaw/agent-board.mjs', openclawPlugin(CONNECT)]]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  const healed = world.files.get('/home/me/.openclaw/openclaw.json') ?? ''
  expect(JSON.parse(healed)).toEqual({ meta, gateway: { port: 18789 }, plugins: {} })
  // The session start says why, once, where it used to leave the person guessing.
  expect(seen.notified).toEqual([`OpenClaw 2026.3.8 太舊，要 2026.4.24 以上才接得上，所以沒有接它。更新之後再跑 /progress connect。\n${ZH_TW.setupStatusHint}`])

  const connected = await $.command.run({ ...TIDY, args: 'connect' })
  expect(connected.text).toContain('OpenClaw 2026.3.8 太舊，要 2026.4.24 以上才接得上，所以沒有接它。更新之後再跑 /progress connect。')
  // Two files, one note, and no "none found" above it.
  expect(connected.text?.split('OpenClaw 2026.3.8').length).toBe(2)
  expect(connected.text).not.toContain('OpenClaw 的設定檔讀不懂')
  expect(connected.text).not.toContain('沒找到可以接的 agent')
  expect(world.files.get('/home/me/.openclaw/openclaw.json')).toBe(healed)
})

test('an agent whose config cannot be written is named, and the agents after it are still hooked in', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = {
    files: new Map([
      ['/home/me/.codex/config.toml', 'model = "gpt-6"\n'],
      ['/home/me/.gemini/settings.json', '{}\n'],
    ]),
    mtime: 1,
    hasTasks: true,
    ran: [],
    unwritable: new Set(['/home/me/.codex/hooks.json']),
  }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(world.files.has('/home/me/.codex/hooks.json')).toBe(false)
  expect(JSON.parse(world.files.get('/home/me/.gemini/settings.json') ?? '{}').hooks.AfterAgent[0].hooks[0].command).toBe("sh '/home/me/.claude/progress-report.sh' gemini turn || true")
  expect(seen.notified).toHaveLength(1)
  expect(seen.notified[0]).toContain('已自動接上：Gemini CLI。')
  expect(seen.notified[0]).toContain('Codex 的設定檔寫不進去：/home/me/.codex/hooks.json')

  const connected = await $.command.run({ ...TIDY, args: 'connect' })
  expect(connected.text).toContain('Codex 的設定檔寫不進去：/home/me/.codex/hooks.json')
  expect(connected.text).not.toContain('沒找到可以接的 agent')
})

test('a board command that cannot be written is named as one, and the agent is still hooked in', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}\n']]), mtime: 1, hasTasks: true, ran: [], unwritable: new Set(['/home/me/.gemini/commands/board.toml']) }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(JSON.parse(world.files.get('/home/me/.gemini/settings.json') ?? '{}').hooks.AfterAgent).toHaveLength(1)
  const connected = await $.command.run({ ...TIDY, args: 'connect' })
  expect(connected.text).toContain('看板指令檔寫不進去：/home/me/.gemini/commands/board.toml')
  expect(connected.text).not.toContain('的設定檔寫不進去')
})

test('a hand-run connect names each approval it needs once', { options: { autoConnect: false } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.codex/config.toml', ''], ['/home/me/.hermes/config.yaml', '']]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  for (const s of Object.values(STRINGS)) {
    await $.command.run({ ...TIDY, args: `lang ${s.lang}` })
    for (let run = 0; run < 2; run++) {
      const connected = await $.command.run({ ...TIDY, args: 'connect' })
      expect(connected.text.split(s.setupCodexTrust)).toHaveLength(2)
      expect(connected.text.split(s.setupHermesTrust)).toHaveLength(2)
      expect(connected.text.split('--accept-hooks')).toHaveLength(2)
      expect(connected.text).toContain(s.setupCodexTrust)
      expect(connected.text).toContain(s.setupHermesTrust)
      expect(connected.text).not.toContain(s.connectCodexTrust)
      expect(connected.text).not.toContain(s.connectHermesTrust)
    }
    const status = await $.command.run({ ...TIDY, args: 'connect status' })
    expect(status.text.split(s.setupCodexTrust)).toHaveLength(2)
    expect(status.text.split(s.setupHermesTrust)).toHaveLength(2)
  }
})

test('a file that cannot be read is named as unreadable, not as unwritable', { options: { autoConnect: false } }, async ($, on) => {
  const board = '/home/me/.claude/agent-board.mjs'
  const reporter = '/home/me/.claude/progress-report.sh'
  const command = '/home/me/.gemini/commands/board.toml'
  const config = '/home/me/.cursor/hooks.json'
  const old = '/home/me/.grok/hooks/progress-pane.json'
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  for (const s of Object.values(STRINGS)) {
    await $.command.run({ ...TIDY, args: `lang ${s.lang}` })
    for (const file of [board, reporter, command, config, old]) {
      world.files.clear()
      for (const [path, text] of [['/home/me/.gemini/settings.json', '{}'], ['/home/me/.grok/config.toml', ''], [file, 'unreadable bytes']]) world.files.set(path!, text!)
      world.unreadable = new Set([file])
      const connected = await $.command.run({ ...TIDY, args: 'connect' })
      const expected = file === config ? s.connectReadFailed('Cursor', file) : file === old ? s.connectReadFailed('Grok Build', file) : s.connectBoardReadFailed(file)
      expect(connected.text.split(expected)).toHaveLength(2)
      expect(connected.text).not.toContain(s.connectBoardFailed(file))
      expect(connected.text).not.toContain(s.connectReporterFailed(file))
      expect(connected.text).not.toContain(s.connectFailed(file === config ? 'Cursor' : 'Grok Build', file))
      if (file === config) expect(connected.text).not.toContain(s.connectSkipped('Cursor', file))
      expect(connected.text).not.toContain(s.setupHookUnreadable)
      expect(world.files.get(file)).toBe('unreadable bytes')
      const status = await $.command.run({ ...TIDY, args: 'connect status' })
      expect(status.text.split(expected)).toHaveLength(2)
    }
    world.unreadable = new Set()
    world.files.clear()
    world.files.set(config, 'invalid json')
    const connected = await $.command.run({ ...TIDY, args: 'connect' })
    expect(connected.text.split(s.connectSkipped('Cursor', config))).toHaveLength(2)
    expect(connected.text).toContain(s.setupHookUnreadable)
    expect(connected.text).not.toContain(s.connectReadFailed('Cursor', config))
  }
})

test('a problem stored by an English session is shown in the language of the session that asks', { options: { autoConnect: false } }, async ($, on) => {
  const config = '/home/me/.codex/hooks.json'
  const command = '/home/me/.gemini/commands/board.toml'
  const shared: Record<string, unknown> = { inboxDone: {}, lang: 'en' }
  const world: World = {
    files: new Map([['/home/me/.codex/config.toml', ''], ['/home/me/.gemini/settings.json', '{}'], [command, 'personal command']]),
    mtime: 1,
    hasTasks: true,
    shared,
    unwritable: new Set([config]),
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  const connected = await $.command.run({ ...TIDY, args: 'connect' })
  expect(connected.text).toContain(EN.connectFailed('Codex', config))
  expect(connected.text).toContain(EN.connectPreserved(command))

  const native = nativeState(world)
  const state = native.setup
  expect(isSetupState(state)).toBe(true)
  if (!isSetupState(state)) throw new Error('Expected a saved setup state')
  expect(state.problems).toContainEqual({ key: `writeFailed:${config}`, message: 'connectFailed', args: ['Codex', config] })

  const legacy = EN.connectPreserved('/synthetic/legacy')
  state.problems.push({ key: 'legacy', text: legacy })
  world.files.set(controlFile, JSON.stringify(native))
  const stored = structuredClone(native)
  const files = [...world.files]
  shared.lang = 'zh-TW'
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  const status = await $.command.run({ ...TIDY, args: 'connect status' })
  expect(status.text).toContain(ZH_TW.connectFailed('Codex', config))
  expect(status.text).toContain(ZH_TW.connectPreserved(command))

  expect(status.text).toContain(legacy)
  expect(status.text).not.toContain(EN.connectFailed('Codex', config))
  expect(status.text).not.toContain(EN.connectPreserved(command))

  expect(nativeState(world)).toEqual(stored)
  expect([...world.files]).toEqual(files)
})

test('/progress connect status keeps valid problems and agents when a stored problem is unknown', { options: { autoConnect: false } }, async ($, on) => {
  const state = {
    agents: [{ agent: 'codex', label: 'Codex', hook: 'configured', board: 'ready' }],
    problems: [
      { key: 'node:missing', message: 'setupNodeMissing', args: [NODE_MIN] },
      { key: 'unknown', message: 'notAStringKey', args: [] },
    ],
    node: null,
  }
  const shared = { inboxDone: {}, setupState: state }
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, shared }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  const status = await $.command.run({ ...TIDY, args: 'connect status' })
  expect(status.text).toBe([
    ZH_TW.setupStatusTitle,
    ZH_TW.setupAgent('Codex', [ZH_TW.setupHookConfigured, ZH_TW.setupCodexTrust, ZH_TW.setupBoardReady]),
    ZH_TW.setupNodeMissing(NODE_MIN),
  ].join('\n'))
  expect(shared.setupState).toEqual(state)
})

test('a setup failure a session start used to hide is announced once, the next start stays quiet, and /progress connect status still lists it', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = {
    files: new Map([
      ['/home/me/.codex/config.toml', 'model = "gpt-6"\n'],
      ['/home/me/.gemini/settings.json', '{}\n'],
    ]),
    mtime: 1,
    hasTasks: true,
    ran: [],
    shared: { inboxDone: {} },
    unwritable: new Set(['/home/me/.codex/hooks.json']),
  }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(seen.notified).toHaveLength(1)
  expect(seen.notified[0]).toContain('Gemini CLI')
  expect(seen.notified[0]).toContain('Codex 的設定檔寫不進去：/home/me/.codex/hooks.json')
  expect(seen.notified[0]).toContain(ZH_TW.setupStatusHint)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(seen.notified).toHaveLength(1)
  // Asking for the status writes nothing.
  const files = [...world.files]
  const status = await $.command.run({ ...TIDY, args: 'connect status' })
  expect([...world.files]).toEqual(files)
  expect(status.text).toContain(ZH_TW.setupStatusTitle)
  expect(status.text).toContain(ZH_TW.setupAgent('Gemini CLI', [ZH_TW.setupHookConfigured, ZH_TW.setupBoardReady]))
  // Its hook did not go in, yet the board command it shares with the others did.
  expect(status.text).toContain(ZH_TW.setupAgent('Codex', [ZH_TW.setupHookFailed, ZH_TW.setupBoardReady]))
  expect(status.text).toContain('Codex 的設定檔寫不進去：/home/me/.codex/hooks.json')
})

test('a config a session start cannot read is named once, and nothing in it is changed', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.cursor/hooks.json', '{ not json']]), mtime: 1, hasTasks: true, ran: [], shared: { inboxDone: {} } }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(seen.notified).toHaveLength(1)
  expect(seen.notified[0]).toContain('Cursor 的設定檔讀不懂，沒有動它：/home/me/.cursor/hooks.json')
  expect(world.files.get('/home/me/.cursor/hooks.json')).toBe('{ not json')
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(seen.notified).toHaveLength(1)
  const status = await $.command.run({ ...TIDY, args: 'connect status' })
  expect(status.text).toContain(ZH_TW.setupAgent('Cursor', [ZH_TW.setupHookUnreadable, ZH_TW.setupBoardReady]))
})

test('without Node.js automatic setup fails closed once and leaves reporting hooks unchanged', { options: { autoConnect: true } }, async ($, on) => {
  const before = '{}\n'
  const config = '/home/me/.gemini/settings.json'
  const world: World = { files: new Map([[config, before]]), mtime: 1, hasTasks: true, ran: [], shared: { inboxDone: {} }, node: null }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(world.ran).toContainEqual(['node', '--version'])
  expect(world.files.get(config)).toBe(before)
  expect(seen.notified).toEqual([ZH_TW.connectWorkerFailed('NODE_REQUIRED')])
  expect(world.files.has(controlFile)).toBe(false)
  const status = await $.command.run({ ...TIDY, args: 'connect status' })
  expect(status.text).toBe(ZH_TW.connectWorkerFailed('NODE_REQUIRED'))
})

test('a problem that goes away and comes back is announced again', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}\n']]), mtime: 1, hasTasks: true, ran: [], shared: { inboxDone: {} }, node: null }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(seen.notified).toHaveLength(1)
  world.node = 'v24.1.0\n'
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(seen.notified).toHaveLength(2)
  world.node = null
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(seen.notified).toHaveLength(3)
  expect(seen.notified[2]).toBe(ZH_TW.connectWorkerFailed('NODE_REQUIRED'))
})

test('a removal that could not finish is still shown by the status, with what is left', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}\n']]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  world.unwritable = new Set(['/home/me/.gemini/settings.json'])
  expect((await $.command.run({ ...TIDY, args: 'connect remove' })).text).toContain(ZH_TW.connectRemoveIncomplete)
  const status = (await $.command.run({ ...TIDY, args: 'connect status' })).text
  expect(status).not.toBe(ZH_TW.setupRemoved)
  expect(status).not.toContain(ZH_TW.connectNone)
  expect(status).toContain('/home/me/.gemini/settings.json')
})

test('a Node.js older than the board needs is named with its version when connecting by hand', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}\n']]), mtime: 1, hasTasks: true, ran: [], node: 'v16.20.2\n' }
  engineBeneath(on, world)
  outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  const connected = await $.command.run({ ...TIDY, args: 'connect' })
  expect(connected.text).toBe(ZH_TW.connectWorkerFailed('NODE_UNSUPPORTED'))
  expect(world.files.get('/home/me/.gemini/settings.json')).toBe('{}\n')
})

test('the status says what each agent still needs, Codex approving, Hermes Agent asking and OpenClaw restarting, apart from whether its board command is ready', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map(EVERY_AGENT), mtime: 1, hasTasks: true, ran: [], openclaw: 'OpenClaw 2026.5.2 (1a2b3c4)\n' }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  const status = await $.command.run({ ...TIDY, args: 'connect status' })
  expect(status.text).toContain(ZH_TW.setupAgent('Codex', [ZH_TW.setupHookConfigured, ZH_TW.setupCodexTrust, ZH_TW.setupBoardReady]))
  expect(status.text).toContain(ZH_TW.setupAgent('Hermes Agent', [ZH_TW.setupHookConfigured, ZH_TW.setupHermesTrust, ZH_TW.setupBoardReady]))
  expect(status.text).toContain(ZH_TW.setupAgent('OpenClaw', [ZH_TW.setupHookConfigured, ZH_TW.setupOpenclawRestart, ZH_TW.setupBoardReady]))
  // Antigravity gets its report hooks with its skill (#285).
  for (const label of ['Gemini CLI', 'Cursor', 'Grok Build', 'Muse Code', 'OpenCode', 'Antigravity']) expect(status.text).toContain(ZH_TW.setupAgent(label, [ZH_TW.setupHookConfigured, ZH_TW.setupBoardReady]))
})

test('the pane connects with Antigravity present without Node’s Buffer or process', { options: { autoConnect: true } }, async ($, on) => {
  const runtime = globalThis as unknown as {
    Buffer?: unknown
    process?: { execPath?: unknown }
  }
  expect(runtime.Buffer).toBeUndefined()
  expect(runtime.process?.execPath).toBeUndefined()
  const home = '/home/synthetic-user'
  const files = new Map(EVERY_AGENT.map(([path, text]): [string, string] => [path.replace('/home/me', home), text]))
  const world: World = {
    files, mtime: 1, hasTasks: true, ran: [], openclaw: 'OpenClaw 2026.5.2 (1a2b3c4)\n',
    env: { HOME: home, LANG: 'en_US.UTF-8' },
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic-project', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  await $.command.run({ ...TIDY, args: 'connect' })
  const status = await $.command.run({ ...TIDY, args: 'connect status' })
  expect(status.text).not.toContain(EN.setupHookFailed)
  expect(status.text).not.toContain(EN.setupBoardFailed)
  expect(status.text).toContain(EN.setupAgent('Antigravity', [EN.setupHookConfigured, EN.setupBoardReady]))
})

test('once the hooks are taken out, the status says so rather than showing the last setup', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}\n']]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  expect((await $.command.run({ ...TIDY, args: 'connect status' })).text).toBe(ZH_TW.setupNoState)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  await $.command.run({ ...TIDY, args: 'connect remove' })
  expect((await $.command.run({ ...TIDY, args: 'connect status' })).text).toBe(ZH_TW.setupRemoved)
})

test('a reporter that cannot be written is named as the reporter, and no agent is hooked in to run it', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}\n']]), mtime: 1, hasTasks: true, ran: [], unwritable: new Set(['/home/me/.claude/progress-report.sh']) }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  const connected = await $.command.run({ ...TIDY, args: 'connect' })
  expect(connected.text).toContain('回報腳本寫不進去：/home/me/.claude/progress-report.sh')
  expect(connected.text).not.toContain('看板指令檔寫不進去：/home/me/.claude/progress-report.sh')
  expect(world.files.get('/home/me/.gemini/settings.json')).toBe('{}\n')
})

test('a plugin file this plugin recorded writing in an earlier version is brought up to date without announcing the agent again', { options: { autoConnect: true } }, async ($, on) => {
  const shared: Record<string, unknown> = { inboxDone: {} }
  const world: World = { files: new Map([['/home/me/.openclaw/openclaw.json', JSON.stringify({ meta: { lastTouchedVersion: '2026.5.2' } })]]), mtime: 1, hasTasks: true, shared, ran: [] }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  const plugin = '/home/me/.openclaw/agent-board.mjs'
  const current = world.files.get(plugin)
  expect(current).toBeDefined()
  // What an earlier version wrote and recorded, before its plugin changed.
  const earlier = '// agent-board: the plugin an earlier version wrote\n'
  world.files.set(plugin, earlier)
  const native = nativeState(world)
  native.owned[plugin] = sha256(earlier)
  world.files.set('/home/me/.agent-board/legacy-connect.json', JSON.stringify(native))
  const before = seen.notified.length
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(world.files.get(plugin)).toBe(current)
  expect(seen.notified.slice(before)).toEqual([])
})

test('an OpenClaw whose plugin file cannot be written gets no config entry that would load a missing file', { options: { autoConnect: true } }, async ($, on) => {
  const config = JSON.stringify({ meta: { lastTouchedVersion: '2026.5.2' }, gateway: { port: 18789 } })
  const world: World = { files: new Map([['/home/me/.openclaw/openclaw.json', config]]), mtime: 1, hasTasks: true, ran: [], unwritable: new Set(['/home/me/.openclaw/agent-board.mjs']) }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(world.files.get('/home/me/.openclaw/openclaw.json')).toBe(config)
  const connected = await $.command.run({ ...TIDY, args: 'connect' })
  expect(connected.text).toContain('OpenClaw 的設定檔寫不進去：/home/me/.openclaw/agent-board.mjs')
  expect(world.files.get('/home/me/.openclaw/openclaw.json')).toBe(config)
})

test('an OpenClaw updated since it last saved its config is hooked in, since the installed one says which version it is', { options: { autoConnect: true } }, async ($, on) => {
  const config = JSON.stringify({ meta: { lastTouchedVersion: '2026.3.8' } })
  const world: World = { files: new Map([['/home/me/.openclaw/openclaw.json', config]]), mtime: 1, hasTasks: true, ran: [], openclaw: 'OpenClaw 2026.5.2 (1a2b3c4)\n' }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(world.ran).toContainEqual(['openclaw', '--version'])
  expect(JSON.parse(world.files.get('/home/me/.openclaw/openclaw.json') ?? '{}').plugins.entries['agent-board']).toEqual({ enabled: true, hooks: { allowConversationAccess: true } })
  expect(seen.notified).toEqual(['已自動接上：OpenClaw。重開它們之後，每個回合都會出現在這裡。'])
})

test('a ~/.grok that only another tool put hooks in is not taken for Grok Build', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.grok/hooks/orca.json', '{"hooks":{}}']]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  const connected = await $.command.run({ ...TIDY, args: 'connect' })
  expect(connected.text).toContain('沒找到可以接的 agent')
  expect(world.files.has('/home/me/.grok/hooks/agent-board.json')).toBe(false)
})

test('an OpenClaw that has not saved its config yet is asked its version, and an old one is left out', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.openclaw/openclaw.json', '{}']]), mtime: 1, hasTasks: true, ran: [], openclaw: 'OpenClaw 2026.3.8 (abc)\n' }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(world.ran).toContainEqual(['openclaw', '--version'])
  expect(world.files.get('/home/me/.openclaw/openclaw.json')).toBe('{}')
  expect(world.files.has('/home/me/.openclaw/agent-board.mjs')).toBe(false)
})

test('taking the hooks out also takes out a Grok hook an earlier version left in a ~/.grok without Grok', { options: { autoConnect: true } }, async ($, on) => {
  const orphan = '/home/me/.grok/hooks/agent-board.json'
  const world: World = { files: new Map([[orphan, grokHook()]]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  await $.command.run({ ...TIDY, args: 'connect remove' })
})

test('an agent already hooked in is left as it is, and unconfirmed Codex approval is named once', { options: { autoConnect: true } }, async ($, on) => {
  const hooked = String(agentHooks(CONNECT).find(hook => hook.agent === 'codex')!.edit('', false))
  const world: World = { files: new Map([['/home/me/.codex/hooks.json', hooked]]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(world.files.get('/home/me/.codex/hooks.json')).toBe(hooked)
  expect(seen.notified).toEqual(['尚未確認目前 Codex hook 的核准狀態。請檢查 /hooks；已有的受管理回報指示會保留。\n之後要再看：/progress connect status'])
})

test('an agent hooked in by an earlier version gets the new hook without a word', { options: { autoConnect: true } }, async ($, on) => {
  // 0.17.0 and earlier gave Grok Build's end hook 1 second.
  const earlier = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: "sh '/home/me/.claude/progress-report.sh' grok turn || true", timeout: 10 }] }], SessionEnd: [{ hooks: [{ type: 'command', command: "sh '/home/me/.claude/progress-report.sh' grok end || true", timeout: 1 }] }] } }, null, 2) + '\n'
  const ours = '/home/me/.grok/hooks/agent-board.json'
  const world: World = { files: new Map([['/home/me/.grok/config.toml', ''], [ours, earlier]]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(JSON.parse(world.files.get(ours) ?? '{}').hooks.SessionEnd[0].hooks[0].timeout).toBe(5)
  expect(seen.notified).toEqual([])
})

test('a changed hook of ours in Codex is still announced, since Codex asks to approve it again', { options: { autoConnect: true } }, async ($, on) => {
  const earlier = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: "sh '/home/me/.claude/progress-report.sh' codex turn || true", timeout: 1 }] }], SessionEnd: [{ hooks: [{ type: 'command', command: "sh '/home/me/.claude/progress-report.sh' codex end || true", timeout: 3 }] }] } }, null, 2) + '\n'
  const ours = '/home/me/.codex/hooks.json'
  const world: World = { files: new Map([[ours, earlier]]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(JSON.parse(world.files.get(ours) ?? '{}').hooks.Stop[0].hooks[0].timeout).toBe(10)
  expect(seen.notified).toHaveLength(1)
  expect(seen.notified[0]).toContain('已自動接上：Codex。重開它們之後，每個回合都會出現在這裡。')
  expect(seen.notified[0]).toContain('尚未確認目前 Codex hook 的核准狀態。請檢查 /hooks；已有的受管理回報指示會保留。')
})

test('a first connection to a config holding only an empty hook list is still announced', { options: { autoConnect: true } }, async ($, on) => {
  // Taking our hooks out of this config would drop the empty list, though none of ours is in it.
  const world: World = { files: new Map([['/home/me/.codex/hooks.json', '{"hooks":{"PreToolUse":[]}}']]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(JSON.parse(world.files.get('/home/me/.codex/hooks.json') ?? '{}').hooks.Stop).toHaveLength(1)
  expect(seen.notified).toHaveLength(1)
  expect(seen.notified[0]).toContain('已自動接上：Codex。重開它們之後，每個回合都會出現在這裡。')
  expect(seen.notified[0]).toContain('尚未確認目前 Codex hook 的核准狀態。請檢查 /hooks；已有的受管理回報指示會保留。')
})

test('once the hooks are taken out, a session does not put them back', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.codex/config.toml', '']]), mtime: 1, hasTasks: true, ran: [], store: { inboxDone: {}, autoConnectOff: true } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(world.files.has('/home/me/.codex/hooks.json')).toBe(false)
  // Connecting by hand works as before; taking the hooks out again keeps them out of later sessions.
  await $.command.run({ ...TIDY, args: 'connect' })
  expect(JSON.parse(world.files.get('/home/me/.codex/hooks.json') ?? '{}').hooks.Stop).toHaveLength(1)
  await $.command.run({ ...TIDY, args: 'connect remove' })
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(JSON.parse(world.files.get('/home/me/.codex/hooks.json') ?? '{}').hooks).toEqual({})
})

test('with the autoConnect option off, a session hooks nothing in', { options: { autoConnect: false } }, async ($, on) => {
  const world: World = { files: new Map([['/home/me/.codex/config.toml', '']]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  expect(world.files.has('/home/me/.codex/hooks.json')).toBe(false)
})

test('automatic connect compares normalized data paths and reads escaped host path data', { options: { autoConnect: true } }, async () => {
  expect(hasOwnConnectData('C:\\Users\\Me', 'c:/users/me/.claude/', 'C:\\USERS\\ME\\.claude\\progress.md', true)).toBe(false)
  expect(hasOwnConnectData('/home/me', '/home/me/.claude/', '/home/me/.claude/../other/progress.md', false)).toBe(true)
  expect(hasOwnConnectData('/home/me', '', '/home/me/.claude-other/progress.md', false)).toBe(true)
  expect(hasOwnConnectData('/home/me', '/home/me/Other', '/home/me/.claude/progress.md', false)).toBe(true)
  expect(connectDataRoots(JSON.stringify({ command: 'powershell -File "C:\\Other Home\\progress-report.ps1" codex turn' }))).toContain('C:\\Other Home')
  expect(connectDataRoots(JSON.stringify({ command: 'powershell -File "C:\\O\'Brien\\progress-report.ps1" codex turn' }))).toContain("C:\\O'Brien")
  expect(connectDataRoots("sh '/home/O'\\''Brien/.claude/progress-report.sh' codex turn")).toContain("/home/O'Brien/.claude")
  const board = '/scratch/資料/agent-board.mjs'
  expect(connectDataRoots(`String.fromCodePoint(${Array.from(board, char => char.codePointAt(0)).join(',')})`)).toContain('/scratch/資料')
  const escaped = String.raw`"powershell -File C:\\Users\\Jos\xE9\\data\\progress-report.ps1 hermes turn"`
  expect(connectDataRoots(escaped)).toContain('C:\\Users\\José\\data')
  expect(connectDataRoots(String.raw`"sh '/Users/Jos\xE9/\u8CC7\U0001F600/progress-report.sh' hermes turn"`)).toContain('/Users/José/資😀')
  expect(hasOwnConnectData('/home/me', '', '/home/me/synced/progress.md', false, '/home/me/synced/progress.md')).toBe(false)
  expect(hasOwnConnectData('/home/me', '/home/me/other-root', '/home/me/synced/progress.md', false, '/home/me/synced/progress.md')).toBe(true)
  expect(hasOwnConnectData('/home/me', '', '/home/me/synced/another.md', false, '/home/me/synced/progress.md')).toBe(true)
  expect(hasOwnConnectData('C:\\Users\\Me', 'c:/users/me/.claude/', 'C:\\Synced\\progress.md', true, 'c:/synced/progress.md')).toBe(false)
})

test("a session with its own Claude data folder does not connect the machine's agents automatically", { options: { autoConnect: true } }, async ($, on) => {
  const config = '/scratch/home/.gemini/settings.json'
  const world: World = { files: new Map([[config, '{}']]), mtime: 1, hasTasks: true, ran: [], written: [], env: { USERPROFILE: '/scratch/home', HOME: '/scratch/home', CLAUDE_CONFIG_DIR: '/scratch/home/other-root', LANG: 'en' } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  const status = await $.command.run({ ...TIDY, args: 'connect status' })
  expect(status.text).toBe(EN.setupOwnData)
  expect(world.ran?.some(argv => argv.includes(CONNECT_BOOTSTRAP) || argv.includes(CONNECT_EXECUTE))).toBe(false)
  expect(world.files.get(config)).toBe('{}')
  expect(world.written?.some(path => !path.startsWith('/scratch/home/other-root/'))).toBe(false)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: EN.setupProgressAutoOff })).toBeUndefined()
  await ui.unmount()
})

test('a progress file in a subfolder of the Claude folder is its own data folder', { options: { autoConnect: true } }, async ($, on) => {
  expect(hasOwnConnectData('/home/me', '', '/home/me/.claude/sub/progress.md', false)).toBe(true)
  expect(hasOwnConnectData('C:\\Users\\Me', '', 'c:/users/me/.claude/sub/progress.md', true)).toBe(true)
  const config = '/scratch/home/.gemini/settings.json'
  const world: World = {
    files: new Map([[config, '{}']]), mtime: 1, hasTasks: true, ran: [],
    env: { HOME: '/scratch/home', CLAUDE_PROGRESS_FILE: '/scratch/home/.claude/sub/progress.md', LANG: 'en' },
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ ...TIDY, args: 'connect status' })).text).toBe(EN.setupProgressAutoOff)
  expect(world.ran?.some(argv => argv.includes(CONNECT_BOOTSTRAP) || argv.includes(CONNECT_EXECUTE))).toBe(false)
  expect(world.files.get(config)).toBe('{}')
})

test('a progress file in a synced folder that was connected by hand still connects automatically', { options: { autoConnect: true } }, async ($, on) => {
  const progress = '/home/me/synced/progress.md'
  const config = '/home/me/.gemini/settings.json'
  const world: World = {
    files: new Map([[config, '{}']]), mtime: 1, hasTasks: true, ran: [], store: { inboxDone: {} },
    env: { HOME: '/home/me', CLAUDE_PROGRESS_FILE: progress, LANG: 'en' },
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TIDY, args: 'connect status' })
  expect(world.ran?.some(argv => argv.includes(CONNECT_EXECUTE))).toBe(false)
  await $.command.run({ ...TIDY, args: 'connect' })
  expect(nativeState(world).connectedProgress).toBe(progress)
  world.files.set(config, '{}')
  world.ran = []
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(world.ran?.some(argv => argv.includes(CONNECT_EXECUTE) && JSON.parse(argv[6] ?? '{}').mode === 'auto')).toBe(true)
  expect(world.files.get(config)).toContain('/home/me/synced/')
  await $.command.run({ ...TIDY, args: 'lang zh-TW' })
  expect(world.store?.lang).toBe('zh-TW')
  expect(nativeState(world).boardLang).toBe('zh-TW')
})

test('a progress file elsewhere that was never connected by hand does not connect automatically', { options: { autoConnect: true } }, async ($, on) => {
  const config = '/home/me/.gemini/settings.json'
  const world: World = {
    files: new Map([[config, '{}'], [controlFile, JSON.stringify({
      version: 1, revision: 1, disabled: false, owned: {}, notified: [], connectedProgress: '/home/me/synced/progress.md',
    })]]),
    mtime: 1, hasTasks: true, ran: [], written: [],
    env: { HOME: '/home/me', CLAUDE_PROGRESS_FILE: '/home/me/elsewhere/progress.md', LANG: 'en' },
  }
  engineBeneath(on, world)
  const before = world.files.get(controlFile)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ ...TIDY, args: 'connect status' })).text).toBe(EN.setupProgressAutoOff)
  expect(world.ran?.some(argv => argv.includes(CONNECT_EXECUTE))).toBe(false)
  expect(world.files.get(config)).toBe('{}')
  expect(world.files.get(controlFile)).toBe(before)
  expect(world.written?.some(file => !file.startsWith('/home/me/elsewhere/'))).toBe(false)
})

test('automatic connect waits for its result before the gate is checked', { options: { autoConnect: true } }, async ($, on) => {
  let reached!: () => void
  let release!: () => void
  const waiting = new Promise<void>(done => { reached = done })
  const held = new Promise<void>(done => { release = done })
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}']]), mtime: 1, hasTasks: true, ran: [], nodeGate: { reached, release: held } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  await waiting
  let isSettled = false
  const status = $.command.run({ ...TIDY, args: 'connect status' }).then(result => { isSettled = true; return result })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  // Drain status while the startup version probe remains held.
  await clock.advance(2000)
  expect(isSettled).toBe(false)
  expect(world.ran?.some(argv => argv.includes(CONNECT_EXECUTE))).toBe(false)
  release()
  await status
  expect(world.ran?.some(argv => argv.includes(CONNECT_EXECUTE) && JSON.parse(argv[6] ?? '{}').mode === 'auto')).toBe(true)
  expect(world.files.get('/home/me/.gemini/settings.json')).toContain('/home/me/.claude/')
  await ui.unmount()
})

for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) test(`a synced progress file that was connected before this update says once how to turn automatic connect on in ${lang}`, { options: { autoConnect: true, language: lang } }, async ($, on) => {
  const config = '/home/me/.gemini/settings.json'
  const world: World = {
    files: new Map([[config, '{}'], [controlFile, JSON.stringify({ version: 1, revision: 1, disabled: false, owned: {}, notified: [] })]]),
    mtime: 1, hasTasks: true, ran: [], env: { HOME: '/home/me', CLAUDE_PROGRESS_FILE: '/home/me/synced/progress.md' },
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TIDY, args: 'connect status' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  const text = STRINGS[lang].setupProgressAutoOff
  expect((await ui.findAll({ type: 'Text', text })).length).toBe(1)
  await $.command.run({ ...TIDY, args: 'connect status' })
  expect((await ui.findAll({ type: 'Text', text })).length).toBe(1)
  expect(world.ran?.some(argv => argv.includes(CONNECT_EXECUTE))).toBe(false)
  expect(world.files.get(config)).toBe('{}')
  await ui.unmount()
})

test('a disabled automatic connect shows no progress file opt-in notice', { options: { autoConnect: false } }, async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, env: { HOME: '/home/me', CLAUDE_PROGRESS_FILE: '/home/me/synced/progress.md', LANG: 'en' } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TIDY, args: 'connect status' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: EN.setupProgressAutoOff })).toBeUndefined()
  await ui.unmount()
})

test('a progress file whose connections were removed by hand gets no automatic connect notice', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = {
    files: new Map([[controlFile, JSON.stringify({ version: 1, revision: 1, disabled: true, owned: {}, notified: [] })]]),
    mtime: 1, hasTasks: true, ran: [], env: { HOME: '/home/me', CLAUDE_PROGRESS_FILE: '/home/me/synced/progress.md', LANG: 'en' },
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TIDY, args: 'connect status' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: EN.setupProgressAutoOff })).toBeUndefined()
  expect(world.ran?.some(argv => argv.includes(CONNECT_EXECUTE))).toBe(false)
  expect((await $.command.run({ ...TIDY, args: 'connect status' })).text).toBe(EN.setupRemoved)
  await ui.unmount()
})

test('a stored automatic connect removal gets no progress file opt-in notice', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, store: { autoConnectOff: true }, env: { HOME: '/home/me', CLAUDE_PROGRESS_FILE: '/home/me/synced/progress.md', LANG: 'en' } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TIDY, args: 'connect status' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: EN.setupProgressAutoOff })).toBeUndefined()
  await ui.unmount()
})

test('connect status for a synced progress file explains how to turn automatic connect on', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, env: { HOME: '/home/me', CLAUDE_PROGRESS_FILE: '/home/me/synced/progress.md', LANG: 'en' } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ ...TIDY, args: 'connect status' })).text).toBe(EN.setupProgressAutoOff)
})

test('a dismissed automatic connect notice stays dismissed after connect status', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, env: { HOME: '/home/me', CLAUDE_PROGRESS_FILE: '/home/me/synced/progress.md', LANG: 'en' } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TIDY, args: 'connect status' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect((await ui.findAll({ type: 'Text', text: EN.setupProgressAutoOff })).length).toBe(1)
  await ui.press({ key: 'clear-answer' })
  await $.command.run({ ...TIDY, args: 'connect status' })
  expect(await ui.find({ type: 'Text', text: EN.setupProgressAutoOff })).toBeUndefined()
  await ui.unmount()
})

for (const [suffix, env] of [
  ['CLAUDE_CONFIG_DIR', { CLAUDE_CONFIG_DIR: '/home/me/other-root' }],
  ['CLAUDE_PROGRESS_FILE', { CLAUDE_PROGRESS_FILE: '/home/me/other-root/progress.md' }],
] as const) test(`choosing a language in a session with its own data folder changes no shared file: ${suffix}`, { options: { autoConnect: true } }, async ($, on) => {
  const world: World = {
    files: new Map([['/home/me/.gemini/settings.json', '{}'], [controlFile, JSON.stringify({
      version: 1, revision: 4, disabled: false, owned: {}, notified: [], boardLang: 'en',
      pending: { request: { mode: 'connect', progress: '/home/me/.claude/progress.md' } },
    })]]),
    mtime: 1, hasTasks: true, ran: [], written: [], store: { inboxDone: {}, lang: 'en' },
    env: { HOME: '/home/me', ...env, LANG: 'en' },
  }
  if ('CLAUDE_CONFIG_DIR' in env) {
    const state = JSON.parse(world.files.get(controlFile) ?? '{}') as ConnectState
    state.connectedProgress = '/home/me/other-root/progress.md'
    world.files.set(controlFile, JSON.stringify(state))
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  const before = new Map([...world.files].filter(([file]) => !file.startsWith('/home/me/other-root/')))
  for (const lang of ['zh-TW', 'zh-CN', 'auto']) {
    const result = await $.command.run({ ...TIDY, args: `lang ${lang}` })
    expect(result.text).toBe(STRINGS[lang === 'auto' ? 'en' : lang as 'zh-TW' | 'zh-CN'].langSet)
  }
  expect(new Map([...world.files].filter(([file]) => !file.startsWith('/home/me/other-root/')))).toEqual(before)
  expect(world.store?.lang).toBe('en')
  expect(world.ran?.some(argv => argv.includes(CONNECT_BOOTSTRAP) || argv.includes(CONNECT_EXECUTE))).toBe(false)
  expect(world.written?.some(file => !file.startsWith('/home/me/other-root/'))).toBe(false)
})

test('connect status in a separate data folder keeps the result of a manual connection', { options: { autoConnect: true } }, async ($, on) => {
  const world: World = {
    files: new Map([['/home/me/.gemini/settings.json', '{}']]), mtime: 1, hasTasks: true, ran: [],
    env: { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/home/me/other-root', LANG: 'en' },
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TIDY, args: 'connect' })
  const before = world.ran?.length
  const status = await $.command.run({ ...TIDY, args: 'connect status' })
  expect(status.text.startsWith(EN.setupOwnData + '\n')).toBe(true)
  expect(status.text).toContain('Gemini CLI')
  expect(world.ran?.length).toBe(before)
})

test('automatic connection and removal preserve personal commands and skills, including edits after installation', { options: { autoConnect: true } }, async ($, on) => {
  const files = ['/home/me/.gemini/commands/board.toml', '/home/me/.config/opencode/commands/board.md', '/home/me/.agents/skills/agent-board/SKILL.md', '/home/me/.hermes/skills/agent-board/SKILL.md', '/home/me/.gemini/config/skills/agent-board/SKILL.md']
  const world: World = {
    files: new Map([
      ...files.map(file => [file, `personal content in ${file}\r\n`] as [string, string]),
      ['/home/me/.gemini/antigravity/config.json', '{}'],
      ['/home/me/.codex/config.toml', ''],
    ]),
    mtime: 1, hasTasks: true,
  }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  for (const file of files) expect(world.files.get(file)).toBe(`personal content in ${file}\r\n`)
  expect(seen.notified.some(text => text.includes(files[0] ?? 'missing'))).toBe(true)
  const connected = await $.command.run({ ...TIDY, args: 'connect' })
  for (const file of files) expect(connected.text).toContain(file)
  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).toContain('清理尚未完成')
  for (const file of files) expect(world.files.get(file)).toBe(`personal content in ${file}\r\n`)

  // Unmodified owned output can upgrade with a language change, while a later user edit stays.
  world.files.delete(files[0] ?? '')
  await $.command.run({ ...TIDY, args: 'connect' })
  await $.command.run({ ...TIDY, args: 'lang en' })
  await $.command.run({ ...TIDY, args: 'connect' })
  const gemini = files[0] ?? ''
  expect(world.files.get(gemini)).toContain('Show me the Agent Board')
  const edited = `${world.files.get(gemini)}\n# my change\n`
  world.files.set(gemini, edited)
  await $.command.run({ ...TIDY, args: 'connect' })
  await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(world.files.get(gemini)).toBe(edited)
})

test('an empty personal file and an unowned legacy plugin are preserved, and a foreign reporter is never hooked in', { options: { autoConnect: true } }, async ($, on) => {
  const empty = '/home/me/.gemini/commands/board.toml'
  const old = '/home/me/.config/opencode/plugin/progress-pane.js'
  const reporter = '/home/me/.claude/progress-report.sh'
  const world: World = { files: new Map([[empty, ''], [old, '// personal plugin\n'], [reporter, '#!/bin/sh\necho personal\n']]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(world.files.get(empty)).toBe('')
  expect(world.files.get(old)).toBe('// personal plugin\n')
  expect(world.files.get(reporter)).toBe('#!/bin/sh\necho personal\n')
  expect(world.files.has('/home/me/.gemini/settings.json')).toBe(false)
  expect(seen.notified.some(text => text.includes(reporter))).toBe(true)
  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).toContain(old)
  expect(world.files.get(old)).toBe('// personal plugin\n')
  expect(world.files.get(empty)).toBe('')
})

test('a collision is announced even when all installed reporting hooks were already connected', { options: { autoConnect: true } }, async ($, on) => {
  const settings = '/home/me/.gemini/settings.json'
  const command = '/home/me/.gemini/commands/board.toml'
  const hook = agentHooks(CONNECT).find(one => one.agent === 'gemini' && one.label !== '')
  const world: World = { files: new Map([[settings, String(hook?.edit('', false))], [command, 'personal']]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(seen.notified).toHaveLength(1)
  expect(seen.notified[0]).toContain(command)
  expect(seen.notified[0]).not.toContain('已自動接上：。')
})

test('an installation from 0.20.5 with no record upgrades silently: its board script, every agent’s board command and skill, and its reporter, with no agent’s hook passed over', { options: { autoConnect: true } }, async ($, on) => {
  // The reporter and OpenCode command remain unchanged. Gemini now escapes its TOML
  // prompt; the skills gained chat-app guidance. Select the historical language by
  // its description rather than assuming every command still matches byte for byte.
  const { world, shared, written, notices } = await fromEarlierRelease($, on, (world, before) => {
    world.files.set(BOARD_SCRIPT_FILE, releasedBoard(RELEASE_0_20_5.board))
    world.files.set(REPORTER_FILE, here(RELEASE_0_20_5.reporterSh))
    // 0.20.5's board commands and skill (one skill for every agent), in the language they were written in.
    for (const file of BOARD_FILES) {
      const kind = file.endsWith('.toml') ? 'gemini' : file.endsWith('board.md') ? 'opencode' : 'skill'
      const texts = RELEASE_0_20_5[kind].map(here)
      const text = kind === 'opencode' ? texts.find(one => one === before.get(file)) : texts.find(one => one.includes(JSON.stringify(ZH_TW.boardCommandDescription)))
      expect(text).toBeDefined()
      if (kind !== 'opencode') expect(text).not.toBe(before.get(file))
      world.files.set(file, text ?? '')
    }
  })
  expect(written.get(BOARD_SCRIPT_FILE)).not.toBe(releasedBoard(RELEASE_0_20_5.board))
  expect(notices).toEqual([])
  for (const [file, text] of written) expect(world.files.get(file)).toBe(text)
  for (const file of [BOARD_SCRIPT_FILE, REPORTER_FILE, ...BOARD_FILES]) expect(nativeState(world).owned[file]).toBe(sha256(written.get(file) ?? ''))
})

test('board commands and skills written before --serve (0.17.1 to 0.18.1), with no record, upgrade silently in every agent', { options: { autoConnect: true } }, async ($, on) => {
  const { world, written, notices } = await fromEarlierRelease($, on, world => {
    for (const file of BOARD_FILES) {
      const kind = file.endsWith('.toml') ? 'gemini' : file.endsWith('board.md') ? 'opencode' : 'skill'
      world.files.set(file, here(RELEASE_0_18_1[kind][0] ?? ''))
      expect(world.files.get(file)).not.toContain('--serve')
    }
  })
  expect(notices).toEqual([])
  for (const file of BOARD_FILES) expect(world.files.get(file)).toBe(written.get(file))
  expect(written.get('/home/me/.gemini/commands/board.toml')).toContain('--serve')
})

test('a released file edited by hand, with no record, is still preserved byte for byte and named', { options: { autoConnect: true } }, async ($, on) => {
  const board = `${releasedBoard(RELEASE_0_20_5.board)}// my change\n`
  const gemini = `${here(RELEASE_0_18_1.gemini[0] ?? '')}# my change\n`
  const command = '/home/me/.gemini/commands/board.toml'
  const { world, written, notices } = await fromEarlierRelease($, on, world => {
    world.files.set(BOARD_SCRIPT_FILE, board)
    world.files.set(command, gemini)
  })
  expect(world.files.get(BOARD_SCRIPT_FILE)).toBe(board)
  expect(world.files.get(command)).toBe(gemini)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain(BOARD_SCRIPT_FILE)
  // The reporter is still ours, so every agent stays hooked in.
  for (const [file] of EVERY_AGENT) expect(world.files.get(file)).toBe(written.get(file))
  expect(world.files.get(REPORTER_FILE)).toBe(written.get(REPORTER_FILE))
  // With the board script ours again, the edited command is looked at too: kept and named.
  world.files.set(BOARD_SCRIPT_FILE, written.get(BOARD_SCRIPT_FILE) ?? '')
  const again = await $.command.run({ ...TIDY, args: 'connect' })
  expect(world.files.get(command)).toBe(gemini)
  expect(again.text).toContain(command)
  expect(world.files.get(BOARD_FILES[0] ?? '')).toBe(written.get(BOARD_FILES[0] ?? ''))
})

test('failed and falsely successful deletes report exact leftovers, retain the board, and permit a later retry', { options: { autoConnect: true } }, async ($, on) => {
  const command = '/home/me/.gemini/commands/board.toml'
  const skill = '/home/me/.agents/skills/agent-board/SKILL.md'
  const board = '/home/me/.claude/agent-board.mjs'
  const sibling = '/home/me/.agents/skills/agent-board/my-notes.txt'
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}'], [sibling, 'keep me']]), mtime: 1, hasTasks: true, unremovable: new Set(), retainedOnRemove: new Set() }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  world.unremovable?.add(command)
  world.retainedOnRemove?.add(skill)
  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).toContain('清理尚未完成')
  expect(removed.text).toContain(ZH_TW.connectRemoveFailed(command))
  expect(removed.text).toContain(ZH_TW.connectRemoveFailed(skill))
  expect(removed.text).toContain('仍有指令檔未移除')
  for (const file of [command, skill, board, sibling]) expect(world.files.has(file)).toBe(true)
  world.unremovable?.clear()
  world.retainedOnRemove?.clear()
  const retried = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(retried.text).not.toContain('清理尚未完成')
  for (const file of [command, skill, board]) expect(world.files.has(file)).toBe(false)
  expect(world.files.get(sibling)).toBe('keep me')
  expect(world.files.has('/home/me/.claude/progress-report.sh')).toBe(true)
})

test('an empty skill folder that cannot be removed is named by the remove, and the status still lists it', { options: { autoConnect: true } }, async ($, on) => {
  const dir = '/home/me/.agents/skills/agent-board'
  const board = '/home/me/.claude/agent-board.mjs'
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}']]), dirs: new Set([dir]), mtime: 1, hasTasks: true, ran: [], unremovable: new Set([dir]) }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).toContain(ZH_TW.connectRemoveIncomplete)
  expect(removed.text).toContain(ZH_TW.connectRemoveFailed(dir))
  expect(world.files.has(`${dir}/SKILL.md`)).toBe(false)
  expect(world.dirs?.has(dir)).toBe(true)
  // Nothing runs the board script once the skill is gone, so it goes, and nothing says it stayed.
  expect(world.files.has(board)).toBe(false)
  expect(removed.text).not.toContain(ZH_TW.connectBoardRetained(board))
  const files = [...world.files]
  const ran = [...(world.ran ?? [])]
  const status = await $.command.run({ ...TIDY, args: 'connect status' })
  expect(status.text).toContain(ZH_TW.connectRemoveFailed(dir))
  expect([...world.files]).toEqual(files)
  expect(world.ran?.slice(ran.length).every(argv => argv[0] === 'node')).toBe(true)
})

test('a second remove names the empty skill folder again, and takes it once it can', { options: { autoConnect: true } }, async ($, on) => {
  const dir = '/home/me/.agents/skills/agent-board'
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}']]), dirs: new Set([dir]), mtime: 1, hasTasks: true, ran: [], unremovable: new Set([dir]) }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  await $.command.run({ ...TIDY, args: 'connect remove' })
  const again = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(again.text).toContain(ZH_TW.connectRemoveFailed(dir))
  expect((await $.command.run({ ...TIDY, args: 'connect status' })).text).toContain(ZH_TW.connectRemoveFailed(dir))
  world.unremovable?.clear()
  const last = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(last.text).not.toContain(ZH_TW.connectRemoveIncomplete)
  expect(world.dirs?.has(dir)).toBe(false)
  expect((await $.command.run({ ...TIDY, args: 'connect status' })).text).toBe(ZH_TW.setupRemoved)
})

test('a skill folder with another file in it stays and nothing is reported', { options: { autoConnect: true } }, async ($, on) => {
  const dir = '/home/me/.agents/skills/agent-board'
  const sibling = `${dir}/my-notes.txt`
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}'], [sibling, 'keep me']]), dirs: new Set([dir]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).not.toContain(ZH_TW.connectRemoveIncomplete)
  expect(removed.text).not.toContain(dir)
  // Removing refuses a folder with anything in it, so it is tried and the file stays.
  expect(world.files.has(`${dir}/SKILL.md`)).toBe(false)
  expect(world.files.get(sibling)).toBe('keep me')
  expect(world.dirs?.has(dir)).toBe(true)
  expect((await $.command.run({ ...TIDY, args: 'connect status' })).text).toBe(ZH_TW.setupRemoved)
})

test('a skill folder that cannot be listed is reported and left in place', { options: { autoConnect: true } }, async ($, on) => {
  const dir = '/home/me/.agents/skills/agent-board'
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}']]), dirs: new Set([dir]), mtime: 1, hasTasks: true, ran: [], unlistable: new Set([dir]), unremovable: new Set([dir]) }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).toContain(ZH_TW.connectRemoveIncomplete)
  expect(removed.text).toContain(ZH_TW.connectRemoveFailed(dir))
  expect(world.dirs?.has(dir)).toBe(true)
  expect((await $.command.run({ ...TIDY, args: 'connect status' })).text).toContain(ZH_TW.connectRemoveFailed(dir))
})

for (const failure of ['rejectedOnRemove', 'retainedOnRemove'] as const) {
  test(`an empty skill folder is reported when its removal is ${failure === 'rejectedOnRemove' ? 'rejected' : 'falsely successful'}`, { options: { autoConnect: true } }, async ($, on) => {
    const dir = '/home/me/.agents/skills/agent-board'
    const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}']]), dirs: new Set([dir]), mtime: 1, hasTasks: true, [failure]: new Set([dir]) }
    engineBeneath(on, world)
    await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
    const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
    expect(removed.text).toContain(ZH_TW.connectRemoveIncomplete)
    expect(removed.text).toContain(ZH_TW.connectRemoveFailed(dir))
    expect(world.dirs?.has(dir)).toBe(true)
  })
}

test('an empty skill folder is removed successfully', { options: { autoConnect: true } }, async ($, on) => {
  const dir = '/home/me/.agents/skills/agent-board'
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}']]), dirs: new Set([dir]), mtime: 1, hasTasks: true, ran: [] }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).not.toContain(ZH_TW.connectRemoveIncomplete)
  expect(world.dirs?.has(dir)).toBe(false)
})

test('a failed primary plugin deletion is not counted as disconnected and other cleanup continues', { options: { autoConnect: true } }, async ($, on) => {
  const plugin = '/home/me/.grok/hooks/agent-board.json'
  const world: World = { files: new Map([['/home/me/.grok/config.toml', ''], ['/home/me/.gemini/settings.json', '{}']]), mtime: 1, hasTasks: true, unremovable: new Set() }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  world.unremovable?.add(plugin)
  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).toContain(plugin)
  expect(removed.text).not.toContain('已拿掉：Gemini CLI、Grok Build')
  expect(removed.text).toContain('已拿掉：Gemini CLI。')
  expect(world.files.has(plugin)).toBe(true)
  expect(JSON.parse(world.files.get('/home/me/.gemini/settings.json') ?? '{}').hooks).toEqual({})
})

test('recorded generated bytes permit an upgrade while unreadable or subsequently edited artifacts stay intact', { options: { autoConnect: true } }, async ($, on) => {
  const board = '/home/me/.claude/agent-board.mjs'
  const command = '/home/me/.gemini/commands/board.toml'
  const old = '# earlier generated version\n'
  const world: World = { files: new Map([[board, old], [command, 'personal file']]), mtime: 1, hasTasks: true, unreadable: new Set([command]), store: { inboxDone: {}, [`generated:${board}`]: old } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(world.files.get(board)).toBe(boardScript(FILE, 'zh-TW'))
  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).toContain(command)
  expect(world.files.get(command)).toBe('personal file')
  expect(world.files.has(board)).toBe(true)
})

test('Windows removal uses native verified deletion and preserves a retained file', { options: { autoConnect: true } }, async ($, on) => {
  const command = '/home/me/.gemini/commands/board.toml'
  const world: World = { files: new Map([['/home/me/.gemini/settings.json', '{}']]), mtime: 1, hasTasks: true, ran: [], retainedOnRemove: new Set([command]), env: { HOME: '/home/me', LANG: 'en', OS: 'Windows_NT' } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).toContain('Could not verify removal')
  expect(removed.text).toContain(command)
  expect(world.files.has(command)).toBe(true)
  expect(world.ran?.some(argv => argv[0] === 'powershell')).toBe(false)
})

test('an exact pre-ownership board and command from a release upgrade in the language they hold, while a modified old board stays', { options: { autoConnect: true } }, async ($, on) => {
  const board = '/home/me/.claude/agent-board.mjs'
  // 0.20.5's bundle, written in English by a session before the plugin kept a record.
  const old = `globalThis.AGENT_BOARD = ${JSON.stringify({ path: FILE, lang: 'en' })}\n${RELEASE_0_20_5.board}`
  const command = String(agentHooks({ ...CONNECT, s: STRINGS.en }).find(hook => hook.file === '/home/me/.gemini/commands/board.toml')?.edit('', false))
  const world: World = { files: new Map([[board, old], ['/home/me/.gemini/commands/board.toml', command]]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  expect(world.files.get(board)).toBe(boardScript(FILE, 'en'))
  expect(world.files.get('/home/me/.gemini/commands/board.toml')).toBe(command)
  expect(seen.notified.some(text => text.includes('已保留'))).toBe(false)
  const personal = `${old}\n// my addition\n`
  world.files.set(board, personal)
  const connected = await $.command.run({ ...TIDY, args: 'connect' })
  expect(connected.text).toContain(board)
  expect(world.files.get(board)).toBe(personal)
  const removed = await $.command.run({ ...TIDY, args: 'connect remove' })
  expect(removed.text).toContain('清理尚未完成')
  expect(world.files.get(board)).toBe(personal)
})


for (const failure of ['read', 'write'] as const) {
  test(`immutable question capture ${failure} failure marks same-batch end sources processed with the question pending`, { options: { autoConnect: true } }, async ($, on) => {
    const first = `${INBOX}/codex-turn-1792152000-1.json`
    const end = `${INBOX}/codex-end-1792152000-2.json`
    const body = (question: string) => JSON.stringify({ session_id: 'one-owner', cwd: '/work/demo', last_assistant_message: question })
    const world: World = { files: new Map([[FILE, ''], [first, body('Keep the first full original?')], [end, body('Keep the end-only full original?')]]), mtime: 1, hasTasks: true, failQuestionCapture: failure, store: { inboxDone: {}, autoConnectOff: true }, reply: () => 'TITLE: Keep originals\nNEXT: Continue\nASK: Keep the end-only full original?' }
    const clock = engineBeneath(on, world)
    await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
    await clock.advance(5000)
    expect(Object.keys(world.store?.inboxDone ?? {})).toHaveLength(2)
    expect(world.files.get(FILE) ?? '').toContain('Keep the end-only full original?')
    expect(pendingQuestionEntries(world)).toHaveLength(2)
    expect(takenOf(world)).toEqual([])
    world.failQuestionCapture = undefined
    world.mtime += 1
    await clock.advance(2000)
    const captures = [...world.files].filter(([path]) => path.includes('-questions-source-')).map(([, text]) => JSON.parse(text))
    expect(captures.some(capture => capture.record.source.text === 'Keep the first full original?')).toBe(true)
    expect(captures.some(capture => capture.record.source.text === 'Keep the end-only full original?')).toBe(true)
    expect(pendingQuestionEntries(world)).toEqual([])
  })
}
