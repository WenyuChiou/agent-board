import {
  ARCHIVE,
  CLAIM_MS,
  EN,
  ENGINE_MATRIX,
  FAILING_MATRIX_TITLE,
  FILE,
  IDLE_MS,
  INBOX,
  JOBS,
  JOURNAL,
  LIVE_PRESS,
  LIVE_PRESS_KEY,
  LIVE_SCRIPT,
  NORMAL_MATRIX_TITLE,
  OLDER_SHOWN,
  OLD_DONE,
  PANE,
  PROBE_BODY,
  PROBE_NAME,
  PROBE_REPLY,
  PROMPT_AT,
  PROMPT_ID,
  PROMPT_SESSION,
  PROPS,
  QUESTIONS,
  RELEASE_0_20_5,
  SESSION,
  STRINGS,
  SWEEP_ARMED_KEY,
  TIDY,
  ZH_CN,
  ZH_TW,
  addPrompt,
  answerAgentPrompt,
  beneathButton,
  besideButton,
  besideLabel,
  blockId,
  buildView,
  chatText,
  completionKey,
  completionOverlay,
  confirmStep,
  connectDataRoots,
  effectivePromptMirror,
  emptyMirror,
  emptyQuestions,
  engineBeneath,
  engineMatrixSummary,
  engineMatrixTest,
  expect,
  idleFiles,
  installedBoard,
  isInboxFile,
  namedEngineMatrixTest,
  observeQuestions,
  outside,
  paletteFor,
  paneEngineFixture,
  parseProgress,
  parseSeen,
  peekInbox,
  pressChildren,
  pressNodes,
  pressTarget,
  pressTexts,
  probeStart,
  probeWorld,
  questionProofPath,
  questionWorld,
  questionsJson,
  relativeTime,
  resultAfterControl,
  seenJson,
  seenPath,
  settledSetup,
  sha256,
  start,
  stoppedPaneBoard,
  takenName,
  test,
  upsertAutoBlock,
  withSeen,
  type On,
  type PressNode,
  type ProgressMirror,
  type View,
  type World,
} from './pane-helpers'


test('the pane and its HTML warn once about a torn tail without losing complete tasks', async ($, on) => {
  const source = '## Synthetic day\n### Hand kept\n- [ ] Keep\n' + Array.from({ length: 7 }, (_, i) => `<!-- auto session=${10000000 + i} agent=codex state=working updated=2026-10-16T12:00:00Z -->\n### Day task ${i}\n- [ ] Next\n${i === 6 ? '<!-- /auto se' : `<!-- /auto session=${10000000 + i} -->\n`}`).join('\n')
  const world: World = { files: new Map([[FILE, source]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['others'] } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/other-project', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  const warning = EN.progressIncomplete(1)
  expect(await ui.find({ type: 'Text', text: warning })).toBeDefined()
  for (let i = 0; i < 7; i++) expect(await ui.find({ type: 'Button', key: `Synthetic day::Day task ${i}` })).toBeDefined()
  expect(world.files.get(FILE)).toBe(source)
  expect((world.files.get(FILE.replace('.md', '.html')) ?? '').split(warning).length - 1).toBe(1)
  await ui.unmount()
})

test('the pane names agents by brand name', async ($, on) => {
  const board = '## Demo\n' + ['codex', 'claude'].map((agent, index) => {
    const id = String(index + 1).repeat(8)
    return `<!-- auto session=${id} agent=${agent} state=waiting updated=2026-10-16T12:00:00Z -->\n### Plan ${index}\n- [?] Publish, OK?\n<!-- /auto session=${id} -->\n`
  }).join('\n') + '\n### Hand kept\n- [?] Finish it\n' + ['codex', 'claude'].map((agent, index) => {
    const id = String(index + 5).repeat(8)
    return `\n<!-- auto session=${id} agent=${agent} state=working updated=2026-10-16T12:00:00Z -->\n### Build ${index}\n- [~] Compile\n<!-- /auto session=${id} -->\n`
  }).join('')
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['waiting', 'others'] } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/elsewhere', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  for (const [index, name] of ['Codex', 'Claude Code'].entries()) {
    await ui.press({ key: `ask::Demo::Plan ${index}::0` })
    expect(await ui.find({ type: 'Text', text: `Demo › Plan ${index} · ${name}` })).toBeDefined()
    const hint = index === 0 ? 'Reply in the "Plan 0" session (Codex)' : 'Reply in the "Plan 1" session'
    expect(await ui.find({ type: 'Text', text: `${hint}. Can't reply from here.` })).toBeDefined()
  }
  // A working task's line names its agent by brand name too; a hand-kept one names none.
  expect(await ui.find({ type: 'Text', text: /Codex · Codex is working/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Claude Code · Claude is working/ })).toBeDefined()
  await ui.press({ key: 'ask::Demo::Hand kept::0' })
  expect(await ui.find({ type: 'Text', text: 'Demo › Hand kept' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Demo › Hand kept ·/ })).toBeUndefined()
  await $.turn.start({ text: 'Current plan', turnId: 't1' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Current question', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', metadata: { waiting: 'you', why: 'Publish, OK?' } })
  await ui.press({ key: 'ask::mine::1' })
  expect(await ui.find({ type: 'Text', text: /^.+ › Current plan · Claude Code$/ })).toBeDefined()
  await ui.unmount()
})

test('a task handoff removes Continue while retaining the recipient in the pane and file', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  const clock = engineBeneath(on, world)
  await start($, 'Fix export')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Finish export', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', metadata: { handoffTo: 'Export session' } })
  await $.turn.complete({ answer: 'Export session has taken over.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)
  expect(world.files.get(FILE)).toContain('state=done')
  expect(world.files.get(FILE)).toContain('- [-] Finish export — 已交給 Export session')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })
    expect(await ui.find({ type: 'Button', key: 'continue' })).toBeUndefined()
    await ui.unmount()
  }
})

test('an inbox handoff summary keeps the source cancelled rather than offering its next step again', async ($, on) => {
  const world: World = {
    files: new Map([[FILE, '# Progress\n'], [`${INBOX}/codex-turn-1792216380-1.json`, JSON.stringify({ session_id: 'handoff-source', cwd: '/work/demo', prompt: 'Fix export', last_assistant_message: 'Export session has taken over issue 11.' })]]),
    mtime: 1, hasTasks: true, asked: [], store: { autoConnectOff: true, inboxDone: {} },
    reply: prompt => prompt.includes('TITLE:') ? 'TITLE: Source work\nCONTEXT: Export fixes\nDONE: Fixed issue 10\nNEXT: Finish issue 11\nASK: -\nHANDOFF: Export session' : undefined,
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/source', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  const file = world.files.get(FILE) ?? ''
  expect(file).toContain('agent=codex state=done')
  expect(file).toContain('- [-] Finish issue 11 — 已交給 Export session')
  expect(buildView(parseProgress(file), [], null, Date.parse('2026-10-16T12:00:00Z')).overview.active).toBe(0)
})

for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) test(`pane archive controls protect every live agent and explain why in ${lang}`, { options: { language: lang } }, async ($, on) => {
  const agents = ['claude', 'codex', 'gemini', 'cursor', 'grok', 'muse', 'hermes', 'openclaw', 'opencode', 'antigravity', 'deepseek', 'custom-agent']
  const cases = agents.flatMap((agent, index) => ['working', 'waiting', 'stopped', 'ended'].map((kind, n) => ({ agent, kind, id: (10000000 + index * 4 + n).toString(), title: `${agent} ${kind}` })))
  const file = '# Progress\n\n## Demo\n' + cases.map(({ agent, kind, id, title }) => `<!-- auto session=${id} agent=${agent} state=${kind === 'stopped' ? 'waiting' : kind} updated=${kind === 'stopped' ? '2026-10-15T23:59:59Z' : '2026-10-16T12:00:00Z'} -->\n### ${title}\n- [ ] Next step\n<!-- /auto session=${id} -->\n`).join('\n')
  const world: World = { files: new Map([[FILE, file]]), mtime: 1, hasTasks: true, store: { lang, autoConnectOff: true, opened: ['others', 'stopped'] } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  for (const one of cases) {
    await ui.press({ key: `Demo::${one.title}` })
    const live = one.kind === 'working' || one.kind === 'waiting'
    const button = await ui.find({ type: 'Button', key: `Demo::${one.title}::archive` })
    if (live) {
      expect(button).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: STRINGS[lang].archiveLive })).toBeDefined()
    } else expect(button).toBeDefined()
  }
  const before = world.files.get(FILE)
  await $.command.run({ ...TIDY, args: 'tidy' })
  expect(world.files.get(FILE)).toBe(before)
  await ui.unmount()
})

test('mock file timestamps isolate sidecar writes and preserve explicit progress renewals', async ($, on) => {
  const world: World = { files: new Map([[FILE, '# Progress\n']]), mtime: 10, hasTasks: true }
  expect(Map.prototype.get.call(world.files, FILE)).toBe('# Progress\n')
  const handlers = new Map<string, Function>()
  const capture = ((...args: Parameters<On>) => {
    if (['fs.stat', 'fs.write', 'fs.list'].includes(String(args[0]))) handlers.set(String(args[0]), args.at(-1) as Function)
    return Reflect.apply(on, undefined, args)
  }) as On
  engineBeneath(capture, world)
  // Invoke the exact registered in-memory FS handlers; no session or native FS runs.
  const call = async (name: string, event: unknown): Promise<{ value: unknown }> => Reflect.apply(handlers.get(name)!, undefined, [$, event, () => undefined])
  const stamp = async (path: string): Promise<number> => ((await call('fs.stat', { path })).value as { mtimeMs: number }).mtimeMs
  const dashboard = FILE.replace('.md', '.html')
  const metadata = FILE.replace('.md', '-questions.json')
  const before = await stamp(FILE)
  await call('fs.write', { path: dashboard, text: '<p>Board</p>' })
  expect(await stamp(FILE)).toBe(before)
  const dashboardAt = await stamp(dashboard)
  expect(dashboardAt).toBeGreaterThan(before)
  await call('fs.write', { path: metadata, text: '{}' })
  expect(await stamp(FILE)).toBe(before)
  expect(await stamp(dashboard)).toBe(dashboardAt)
  expect(await stamp(metadata)).toBeGreaterThan(before)
  const listed = (await call('fs.list', { path: '/home/me/.claude' })).value as Array<{ name: string; mtimeMs: number }>
  expect(listed.find(file => file.name === 'progress.html')?.mtimeMs).toBe(dashboardAt)
  await call('fs.write', { path: FILE, text: '# Updated progress\n' })
  expect(await stamp(FILE)).toBe(before + 1)
  expect(await stamp(dashboard)).toBe(dashboardAt)
  world.mtime += 1
  expect(await stamp(FILE)).toBe(before + 2)
  await call('fs.write', { path: dashboard, text: '<p>Updated board</p>' })
  expect(await stamp(FILE)).toBe(before + 2)
  expect(await stamp(dashboard)).toBeGreaterThan(dashboardAt)
  const metadataAt = await stamp(metadata)
  const progressAt = await stamp(FILE)
  expect(world.files.set(metadata, '[]')).toBe(world.files)
  expect(Map.prototype.get.call(world.files, metadata)).toBe('[]')
  expect(await stamp(metadata)).toBeGreaterThan(metadataAt)
  expect(await stamp(FILE)).toBe(progressAt)
  world.mtime += 1
  expect(await stamp(FILE)).toBe(progressAt + 1)
})

for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) test(`Confirm done on the pane journals every new tick and protects the stopped mirror from late turns in ${lang}`, { options: { language: lang } }, async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00Z')
  const id = blockId('codex', 'synthetic-confirm-session')
  const steps = '- [ ] Todo\n- [~] Doing\n- [?] Ask?\n- [>] Running\n- [!] Blocked\n- [-] Canceled\n- [x] Already done\n'
  const file = `## Demo\n### Manual\n${steps}\n<!-- auto session=11223344 agent=claude state=ended updated=2026-10-16T11:00:00Z -->\n### Ended Claude\n${steps}<!-- /auto session=11223344 -->\n<!-- auto session=${id} agent=codex state=waiting updated=2026-10-15T23:00:00Z -->\n### Stopped Codex\n${steps}<!-- /auto session=${id} -->\n<!-- auto session=55667788 agent=codex state=working updated=2026-10-16T12:00:00Z -->\n### Live task\n- [ ] Leave this open\n<!-- /auto session=55667788 -->\n`
  const stored = { ...emptyMirror(id, 'Demo', at - 13 * 3600000, '', 'codex'), title: 'Stopped Codex', source: 'turns', tasks: [confirmStep('Todo'), { ...confirmStep('Doing', '2'), status: 'in_progress' }, { ...confirmStep('Ask?', '3'), waiting: 'you' }, { ...confirmStep('Running', '4'), waiting: 'run' }, { ...confirmStep('Blocked', '5'), blocked: '' }, { ...confirmStep('Already done', '6'), status: 'completed' }] }
  const world: World = { files: new Map([[FILE, file]]), mtime: 1, hasTasks: true, asked: [], store: { inboxDone: {}, autoConnectOff: true, opened: ['others', 'stopped'], [`agent:${id}`]: stored } }
  const clock = engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  for (const title of ['Manual', 'Ended Claude', 'Stopped Codex']) {
    await ui.press({ key: `Demo::${title}` })
    expect(await ui.find({ type: 'Button', key: `Demo::${title}::done`, text: STRINGS[lang].confirmDone })).toBeDefined()
    await ui.press({ key: `Demo::${title}::done` })
    expect(await ui.find({ type: 'Text', text: STRINGS[lang].confirmedDone(title) })).toBeDefined()
  }
  expect((world.files.get(JOURNAL) ?? '').split('\n').filter(line => line.startsWith('- '))).toHaveLength(15)
  expect(world.files.get(JOURNAL)).not.toContain('Canceled')
  expect(world.files.get(JOURNAL)).not.toContain('Already done')
  expect(world.files.get(FILE)?.match(/- \[-\] Canceled/g)).toHaveLength(3)
  expect(world.store![`agent:${id}`]).toEqual(stored)
  const overlay = Object.values(world.store!).find(value => value !== null && typeof value === 'object' && 'owner' in value && value.owner === `agent:${id}`)
  expect(overlay).toMatchObject({ completed: { state: 'done', confirmedAt: at } })
  await ui.press({ key: 'Demo::Live task' })
  expect(await ui.find({ type: 'Button', key: 'Demo::Live task::done' })).toBeUndefined()
  const before = world.files.get(FILE)
  world.files.set(`${INBOX}/codex-turn-${Math.floor((at - 1000) / 1000)}-9.json`, JSON.stringify({ session_id: 'synthetic-confirm-session', cwd: '/work/Demo', prompt: 'old work', last_assistant_message: 'An old turn must not reopen this.' }))
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.get(FILE)).toBe(before)
  expect(world.asked).toHaveLength(0)
  await ui.unmount()
})

test('Confirm done fences the first delayed legacy delivery even when the owner cache did not exist', async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00Z')
  const id = blockId('codex', 'first-cache-session')
  const file = `## Demo\n<!-- auto session=${id} agent=codex state=ended updated=2026-10-16T11:00:00Z -->\n### External task\n- [ ] Old step\n<!-- /auto session=${id} -->\n`
  const world: World = { files: new Map([[FILE, file]]), mtime: 1, hasTasks: true, asked: [], store: { inboxDone: {}, autoConnectOff: true, opened: ['others', 'stopped'] }, reply: () => 'TITLE: External task\nCONTEXT: Synthetic\nDONE: -\nNEXT: Reopened old step\nASK: -' }
  const clock = engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'Demo::External task' })
  await ui.press({ key: 'Demo::External task::done' })
  const confirmed = world.files.get(FILE)
  expect(confirmed).toContain('- [x] Old step')
  world.files.set(`${INBOX}/codex-turn-${Math.floor((at - 1000) / 1000)}-1.json`, JSON.stringify({ session_id: 'first-cache-session', cwd: '/work/Demo', prompt: 'Old request', last_assistant_message: 'Old work must stay complete.' }))
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.get(FILE)).toBe(confirmed)
  expect(world.asked).toHaveLength(0)
  expect(world.store![`agent:${id}`]).toBeUndefined()
  expect(Object.keys(world.store!).some(key => key.startsWith('completion:'))).toBe(true)
  world.files.set(`${INBOX}/codex-turn-${Math.floor((at + 6000) / 1000)}-2.json`, JSON.stringify({ session_id: 'first-cache-session', cwd: '/work/Demo', prompt: 'Fresh request', last_assistant_message: 'New work after confirmation.' }))
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('Reopened old step')
  expect(world.files.get(FILE)).toContain('- [x] Old step')
  expect(world.asked).toHaveLength(1)
  await ui.unmount()
})

for (const [when, delta] of [['older', -1000], ['equal', 0], ['newer', 1000]] as const) test(`uncached completion retains canceled pointers through the first old inbox and ${when} prompt`, async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00Z')
  const session = 'uncached-canceled-session'
  const id = blockId('codex', session)
  const canceled = '- [-] Transfer API — Transferred to Gemini\n- [-] Deferred without a recipient'
  const file = `## Demo\n<!-- auto session=${id} agent=codex state=ended updated=2026-10-16T11:00:00Z resume=${session} -->\n### External task\n- [ ] Old step\n${canceled}\n<!-- /auto session=${id} -->\n`
  const world: World = { files: new Map([[FILE, file]]), mtime: 1, hasTasks: true, asked: [], reads: [], store: { inboxDone: {}, autoConnectOff: true, opened: ['others', 'stopped'] } }
  const clock = engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'Demo::External task' })
  await ui.press({ key: 'Demo::External task::done' })
  const confirmed = world.files.get(FILE)
  expect(confirmed).toContain('- [x] Old step')
  expect(confirmed).toContain(canceled)
  world.files.set(`${INBOX}/codex-turn-${at - 1000}-1.json`, JSON.stringify({ session_id: session, cwd: '/work/Demo', prompt: 'Old request', last_assistant_message: 'Old work must stay complete.' }))
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.get(FILE)).toBe(confirmed)
  world.files.set(`${INBOX}/codex-prompt-${at + delta}-2.json`, JSON.stringify({ session_id: session, prompt: 'PRIVATE_NEW_INPUT', transcript_path: '/private/rollout-canceled.jsonl' }))
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain(canceled)
  expect(world.files.get(FILE)).toContain(`state=${when === 'newer' ? 'working' : 'done'}`)
  if (when !== 'newer') expect(world.files.get(FILE)).toBe(confirmed)
  const steps = parseProgress(world.files.get(FILE)!).flatMap(project => project.tasks).flatMap(task => task.steps)
  expect(steps.filter(step => step.status === 'done')).toHaveLength(1)
  expect(steps.filter(step => step.status === 'cancelled')).toHaveLength(2)
  expect(world.asked).toEqual([])
  expect(world.reads?.some(path => path.includes('rollout-canceled'))).toBe(false)
  expect(world.files.get(FILE)).not.toContain('PRIVATE_NEW_INPUT')
  await ui.unmount()
})

test('an absent owner becoming fresh during completion storage is preserved without false success', async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00Z')
  const id = blockId('codex', 'missing-owner-race')
  const file = `## Demo\n<!-- auto session=${id} agent=codex state=ended updated=2026-10-16T11:00:00Z -->\n### External task\n- [ ] Old step\n<!-- /auto session=${id} -->\n`
  const newer = { ...emptyMirror(id, 'Demo', at + 1, '', 'codex'), turnOrder: (at + 1) * 2, title: 'Fresh accepted work' }
  const world: World = { files: new Map([[FILE, file]]), mtime: 1, hasTasks: true, store: { inboxDone: {}, autoConnectOff: true, opened: ['others', 'stopped'] } }
  engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'Demo::External task' })
  world.beforeStoreSet = key => { if (key.startsWith('completion:')) { world.store![`agent:${id}`] = newer; world.beforeStoreSet = undefined } }
  await ui.press({ key: 'Demo::External task::done' })
  expect(world.store![`agent:${id}`]).toEqual(newer)
  expect(world.files.get(JOURNAL)).toContain(' · Old step\n')
  expect(await ui.find({ type: 'Text', text: ZH_TW.boardWriteFailed })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ZH_TW.confirmedDone('External task') })).toBeUndefined()
  await ui.unmount()
})

test('an old completion fence survives owner pruning and rejects delayed work while allowing a genuinely newer turn', async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00Z')
  const day = 24 * 3600000
  const id = blockId('codex', 'old-completion-session')
  const source = { ...emptyMirror(id, 'Demo', at - 40 * day, '', 'codex'), turnOrder: (at - 40 * day) * 2, title: 'Old task', tasks: [{ id: '1', subject: 'Old step', status: 'pending' as const, activeForm: '', waiting: null, why: null, ask: null, options: [], command: null, link: null, blocked: null, blockedBy: [] }] }
  const overlay = completionOverlay(`agent:${id}`, source, at - 35 * day)
  const key = completionKey(overlay)
  const file = '## Demo\n### Keep manual work\n- [ ] Keep open\n'
  const world: World = { files: new Map([[FILE, file], [`${INBOX}/codex-turn-${Math.floor((at - 36 * day) / 1000)}-1.json`, JSON.stringify({ session_id: 'old-completion-session', cwd: '/work/Demo', prompt: 'Old request', last_assistant_message: 'Old work must stay complete.' })]]), mtime: 1, hasTasks: true, asked: [], store: { inboxDone: {}, autoConnectOff: true, [key]: overlay }, reply: () => 'TITLE: New work\nCONTEXT: Synthetic\nDONE: -\nNEXT: Genuinely newer step\nASK: -' }
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.store![key]).toEqual(overlay)
  expect(world.store![`agent:${id}`]).toBeUndefined()
  expect(world.files.get(FILE)).toBe(file)
  expect(world.asked).toHaveLength(0)
  world.files.set(`${INBOX}/codex-turn-${Math.floor((at + 6000) / 1000)}-2.json`, JSON.stringify({ session_id: 'old-completion-session', cwd: '/work/Demo', prompt: 'Fresh request', last_assistant_message: 'Start new work.' }))
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('Genuinely newer step')
  expect(world.files.get(FILE)).toContain('### Keep manual work\n- [ ] Keep open')
  expect(world.asked).toHaveLength(1)
})

test('repeated Confirm done presses journal each new step once', async ($, on) => {
  const world: World = { files: new Map([[FILE, '## Demo\n### Target\n- [ ] First\n- [~] Second\n- [-] Canceled\n']]), mtime: 1, hasTasks: true, store: { inboxDone: {}, autoConnectOff: true, opened: ['others'] } }
  engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'Demo::Target' })
  await Promise.all([ui.press({ key: 'Demo::Target::done' }), ui.press({ key: 'Demo::Target::done' })])
  expect(world.files.get(FILE)).toContain('- [x] First\n- [x] Second\n- [-] Canceled')
  expect((world.files.get(JOURNAL) ?? '').split(' · First\n')).toHaveLength(2)
  expect((world.files.get(JOURNAL) ?? '').split(' · Second\n')).toHaveLength(2)
  await ui.unmount()
})

test('Confirm done preserves a failed journal notice and retries every new entry once', async ($, on) => {
  const world: World = { files: new Map([[FILE, '## Demo\n### Target\n- [ ] First\n- [~] Second\n']]), mtime: 1, hasTasks: true, store: { inboxDone: {}, autoConnectOff: true, opened: ['others'] }, unwritable: new Set([JOURNAL]) }
  engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'Demo::Target' })
  await ui.press({ key: 'Demo::Target::done' })
  expect(world.files.get(FILE)).toContain('- [x] First\n- [x] Second')
  expect(await ui.find({ type: 'Text', text: ZH_TW.journalFailed })).toBeDefined()
  world.unwritable?.clear()
  await $.turn.start({ text: 'Continue synthetic work', turnId: 'confirm-journal-retry' })
  expect((world.files.get(JOURNAL) ?? '').split(' · First\n')).toHaveLength(2)
  expect((world.files.get(JOURNAL) ?? '').split(' · Second\n')).toHaveLength(2)
  await $.turn.start({ text: 'Continue synthetic work again', turnId: 'confirm-journal-retry-again' })
  expect((world.files.get(JOURNAL) ?? '').split(' · First\n')).toHaveLength(2)
  await ui.unmount()
})

test('Confirm done still journals its saved ticks and reports a completion overlay write failure', async ($, on) => {
  const id = blockId('codex', 'confirm-store-failure')
  const file = `## Demo\n<!-- auto session=${id} agent=codex state=ended updated=2026-10-16T11:00:00Z -->\n### Target\n- [ ] First\n<!-- /auto session=${id} -->\n`
  const world: World = { files: new Map([[FILE, file]]), mtime: 1, hasTasks: true, store: { inboxDone: {}, autoConnectOff: true, opened: ['others', 'stopped'], [`agent:${id}`]: { ...emptyMirror(id, 'Demo', Date.parse('2026-10-15T23:00:00Z'), '', 'codex'), title: 'Target', tasks: [confirmStep('First')] } }, failStore: (operation, key) => operation === 'set' && key.startsWith('completion:') }
  engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'Demo::Target' })
  await ui.press({ key: 'Demo::Target::done' })
  expect(world.files.get(FILE)).toContain('- [x] First')
  expect(world.files.get(JOURNAL)).toContain(' · First\n')
  expect(await ui.find({ type: 'Text', text: ZH_TW.boardWriteFailed })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ZH_TW.confirmedDone('Target') })).toBeUndefined()
  await ui.unmount()
})

for (const phase of ['before press', 'during write', 'between final get and set'] as const) test(`Confirm done preserves a newer stopped-session mirror ${phase}`, async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00Z')
  const id = blockId('codex', 'confirm-concurrent-mirror')
  const file = `## Demo\n<!-- auto session=${id} agent=codex state=ended updated=2026-10-15T23:00:00Z -->\n### Target\n- [ ] First\n<!-- /auto session=${id} -->\n`
  const original = { ...emptyMirror(id, 'Demo', at - 13 * 3600000, '', 'codex'), state: 'ended', title: 'Target', tasks: [confirmStep('First')] }
  const newer = { ...original, state: 'working', title: 'New work accepted', updated: at }
  const world: World = { files: new Map([[FILE, file]]), mtime: 1, hasTasks: true, store: { inboxDone: {}, autoConnectOff: true, opened: ['others', 'stopped'], [`agent:${id}`]: original } }
  engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'Demo::Target' })
  if (phase === 'before press') world.store![`agent:${id}`] = newer
  else if (phase === 'during write') world.afterWrite = () => { world.store![`agent:${id}`] = newer; return world.files.get(FILE)! }
  else world.beforeStoreSet = key => { if (key === `agent:${id}` || key.startsWith('completion:')) { world.store![`agent:${id}`] = newer; world.beforeStoreSet = undefined } }
  await ui.press({ key: 'Demo::Target::done' })
  expect(world.store![`agent:${id}`]).toEqual(newer)
  if (phase === 'before press') {
    expect(world.files.get(FILE)).toBe(file)
    expect(world.files.has(JOURNAL)).toBe(false)
  } else expect(world.files.get(JOURNAL)).toContain(' · First\n')
  expect(await ui.find({ type: 'Text', text: ZH_TW.confirmedDone('Target') })).toBeUndefined()
  await ui.unmount()
})

for (const state of ['ended', 'done'] as const) for (const change of ['newer clock', 'equal-clock content'] as const) test(`Confirm done refuses cached ${state} work with ${change} before capture`, async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00Z')
  const id = blockId('codex', 'stale-selection-session')
  const file = `## Demo\n<!-- auto session=${id} agent=codex state=ended updated=2026-10-16T11:00:00Z -->\n### Target\n- [ ] First\n<!-- /auto session=${id} -->\n`
  const stored = { ...emptyMirror(id, 'Demo', change === 'newer clock' ? at : at - 3600000, '', 'codex'), title: 'Target', state, tasks: [confirmStep('Different newer task')] }
  const world: World = { files: new Map([[FILE, file]]), mtime: 1, hasTasks: true, store: { inboxDone: {}, autoConnectOff: true, opened: ['others', 'stopped'], [`agent:${id}`]: stored } }
  engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'Demo::Target' })
  await ui.press({ key: 'Demo::Target::done' })
  expect(world.files.get(FILE)).toBe(file)
  expect(world.files.has(JOURNAL)).toBe(false)
  expect(world.store![`agent:${id}`]).toEqual(stored)
  expect(Object.keys(world.store!).some(key => key.startsWith('completion:'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: ZH_TW.boardLineChanged })).toBeDefined()
  await ui.unmount()
})

test('a pane Confirm done rechecks changed words and resumed sessions before writing', async ($, on) => {
  const file = '## Demo\n<!-- auto session=11223344 agent=codex state=ended updated=2026-10-16T11:00:00Z -->\n### Target\n- [ ] First\n- [ ] Later\n<!-- /auto session=11223344 -->\n'
  const world: World = { files: new Map([[FILE, file]]), mtime: 1, hasTasks: true, store: { inboxDone: {}, autoConnectOff: true, opened: ['others', 'stopped'] } }
  engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'Demo::Target' })
  const changed = file.replace('Later', 'Changed later step').replace('state=ended', 'state=working').replace('11:00:00Z', '12:00:00Z')
  world.files.set(FILE, changed)
  await ui.press({ key: 'Demo::Target::done' })
  expect(world.files.get(FILE)).toBe(changed)
  expect(world.files.has(JOURNAL)).toBe(false)
  expect(await ui.find({ type: 'Text', text: ZH_TW.boardLineChanged })).toBeDefined()
  await ui.unmount()
})

test('the board command sent to a session leaves its question waiting on you', async ($, on) => {
  const { world, mirror } = questionWorld()
  const before = world.files.get(FILE)
  world.files.set(`${INBOX}/codex-prompt-${PROMPT_AT + 1000}-77.json`, JSON.stringify({ session_id: PROMPT_SESSION, board_request: true }))
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toBe(before)
  expect(effectivePromptMirror(world)).toEqual(mirror)
  expect(world.asked).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(JSON.stringify(await ui.drawn())).toContain('Use staging?')
  await ui.unmount()
})

test('a free-words board request followed by a board-only reply puts the question back once', async ($, on) => {
  const { world } = questionWorld()
  const clock = engineBeneath(on, world)
  await probeStart($)
  addPrompt(world, PROMPT_AT + 1000)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('- [x] Database — Use staging?')
  const name = `${INBOX}/codex-turn-${PROMPT_AT + 2000}-77.json`
  const body = JSON.stringify({ session_id: PROMPT_SESSION, prompt: 'where do things stand?', last_assistant_message: 'Progress  ● 1 waiting  ▸ 0 in progress  ⚑ 0 due soon  ✓ 0 done today' })
  world.files.set(name, body)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('- [?] Database — Use staging?')
  expect(effectivePromptMirror(world).state).toBe('waiting')
  expect(world.asked).toEqual([])
  const restored = world.files.get(FILE)
  world.files.set(name, body)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toBe(restored)
  const ledger = JSON.parse(world.files.get(FILE.replace('.md', '-questions.json'))!).records
  expect(ledger.filter((row: { isUnresolved?: boolean }) => row.isUnresolved)).toHaveLength(1)
})

test('a real answer after a board request still answers the question', async ($, on) => {
  const { world } = questionWorld()
  const clock = engineBeneath(on, world)
  await probeStart($)
  addPrompt(world, PROMPT_AT + 1000)
  await clock.advance(5000)
  addPrompt(world, PROMPT_AT + 3000)
  await clock.advance(5000)
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 2000}-77.json`, JSON.stringify({ session_id: PROMPT_SESSION, prompt: '/board', last_assistant_message: 'Board' }))
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('- [x] Database — Use staging?')
  expect(effectivePromptMirror(world).state).toBe('working')
  expect(effectivePromptMirror(world).tasks.some(one => one.waiting === 'you')).toBe(false)
})

test('a board reply in the same second as a real answer leaves the question answered', async ($, on) => {
  const { world } = questionWorld()
  const clock = engineBeneath(on, world)
  await probeStart($)
  addPrompt(world, PROMPT_AT + 1000)
  world.files.set(`${INBOX}/codex-turn-${(PROMPT_AT + 1000) / 1000}-77.json`, JSON.stringify({ session_id: PROMPT_SESSION, prompt: '/board', last_assistant_message: 'Board' }))
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('- [x] Database — Use staging?')
  expect(effectivePromptMirror(world).state).toBe('working')
  expect(effectivePromptMirror(world).tasks.some(one => one.waiting === 'you')).toBe(false)
  expect(world.asked).toEqual([])
})

test('a board request, its restoring reply, then a real answer answers the question again', async ($, on) => {
  const { world } = questionWorld()
  const clock = engineBeneath(on, world)
  await probeStart($)
  addPrompt(world, PROMPT_AT + 1000)
  await clock.advance(5000)
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 2000}-77.json`, JSON.stringify({ session_id: PROMPT_SESSION, prompt: 'where do things stand?', last_assistant_message: 'Progress  ● 1 waiting  ▸ 0 in progress  ⚑ 0 due soon  ✓ 0 done today' }))
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('- [?] Database — Use staging?')
  expect(effectivePromptMirror(world).state).toBe('waiting')
  addPrompt(world, PROMPT_AT + 3000)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('- [x] Database — Use staging?')
  expect(effectivePromptMirror(world).state).toBe('working')
  expect(effectivePromptMirror(world).tasks.some(one => one.waiting === 'you')).toBe(false)
  const ledger = JSON.parse(world.files.get(FILE.replace('.md', '-questions.json'))!).records
  expect(ledger.filter((row: { isUnresolved?: boolean }) => row.isUnresolved)).toHaveLength(0)
  expect(world.asked).toEqual([])
})

test('a question followed by a board turn in one drain keeps the session waiting', async ($, on) => {
  const { world } = questionWorld()
  const clock = engineBeneath(on, world)
  await probeStart($)
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 1000}-77.json`, JSON.stringify({ session_id: PROMPT_SESSION, prompt: 'Plan migration', last_assistant_message: 'Use staging?' }))
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 2000}-77.json`, JSON.stringify({ session_id: PROMPT_SESSION, prompt: '/board', last_assistant_message: 'Board' }))
  await clock.advance(5000)
  expect(effectivePromptMirror(world).state).toBe('waiting')
  expect(effectivePromptMirror(world).tasks.some(one => one.waiting === 'you')).toBe(true)
  expect(world.asked).toHaveLength(1)
})

// A later turn with text settles an agent's inbox question (#149), but a board look is not an answer.
test('a board turn after an inbox question in one drain does not settle that question', async ($, on) => {
  const { world } = questionWorld()
  const clock = engineBeneath(on, world)
  await probeStart($)
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 1000}-77.json`, JSON.stringify({ session_id: PROMPT_SESSION, prompt: 'Plan migration', last_assistant_message: 'Should the new column be nullable?' }))
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 2000}-77.json`, JSON.stringify({ session_id: PROMPT_SESSION, prompt: '/board', last_assistant_message: 'Board' }))
  await clock.advance(5000)
  await clock.advance(2000)
  const records = JSON.parse(world.files.get(FILE.replace('.md', '-questions.json')) ?? '{"records":[]}').records as Array<{ isUnresolved?: boolean; source?: { kind: string } }>
  expect(records.filter(row => row.source?.kind === 'inbox').map(row => row.isUnresolved)).toEqual([true])
  expect(effectivePromptMirror(world).state).toBe('waiting')
})

test('a board command prompt after an inbox question does not settle that question', async ($, on) => {
  const { world } = questionWorld()
  const clock = engineBeneath(on, world)
  await probeStart($)
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 1000}-77.json`, JSON.stringify({ session_id: PROMPT_SESSION, prompt: 'Plan migration', last_assistant_message: 'Should the new column be nullable?' }))
  await clock.advance(5000)
  world.files.set(`${INBOX}/codex-prompt-${PROMPT_AT + 2000}-77.json`, JSON.stringify({ session_id: PROMPT_SESSION, board_request: true }))
  world.mtime += 1
  await clock.advance(5000)
  await clock.advance(2000)
  const records = JSON.parse(world.files.get(FILE.replace('.md', '-questions.json')) ?? '{"records":[]}').records as Array<{ isUnresolved?: boolean; source?: { kind: string } }>
  expect(records.filter(row => row.source?.kind === 'inbox').map(row => row.isUnresolved)).toEqual([true])
})

test('a work turn followed by two board looks in one drain is still summed up', async ($, on) => {
  const { world } = questionWorld()
  world.reply = () => 'TITLE: Migration\nCONTEXT: fixture\nDONE: Updated schema\nNEXT: Run migration\nASK: -'
  const clock = engineBeneath(on, world)
  await probeStart($)
  for (const [delta, prompt, answer] of [
    [1000, 'Plan migration', 'Updated schema; run migration next.'],
    [2000, '/board', 'Board'],
    [3000, '/board', 'Board'],
  ] as const) world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + delta}-77.json`, JSON.stringify({ session_id: PROMPT_SESSION, prompt, last_assistant_message: answer }))
  await clock.advance(5000)
  expect(world.asked).toHaveLength(1)
  expect(world.files.get(FILE)).toContain('Updated schema')
  expect(world.files.get(FILE)).toContain('Run migration')
})

test('a board look whose block was undone after it was stored restores its question on the retry', async ($, on) => {
  const { world } = questionWorld()
  const clock = engineBeneath(on, world)
  await probeStart($)
  addPrompt(world, PROMPT_AT + 1000)
  await clock.advance(5000)
  const answered = world.files.get(FILE)!
  const name = `codex-turn-${PROMPT_AT + 2000}-77.json`
  let undid = 0
  const undo = (): string => {
    undid += 1
    world.afterWrite = undo
    return answered
  }
  world.afterWrite = undo
  world.files.set(`${INBOX}/${name}`, JSON.stringify({ session_id: PROMPT_SESSION, prompt: 'where do things stand?', last_assistant_message: 'Progress  ● 1 waiting  ▸ 0 in progress  ⚑ 0 due soon  ✓ 0 done today' }))
  await clock.advance(5000)
  expect(undid).toBe(3)
  expect(world.files.get(FILE)).toBe(answered)
  expect(effectivePromptMirror(world).state).toBe('waiting')
  expect((world.store!.inboxFailed as Record<string, string>)[name]).toContain('the block was not on the board when read back')
  world.afterWrite = undefined
  const claimed = [...world.files.keys()].find(path => path.startsWith(`${INBOX}/${name}.`) && path.endsWith('.taking'))!
  const body = world.files.get(claimed)!
  world.files.delete(claimed)
  // Expire this claim without running fifteen minutes of unrelated mock polls.
  world.files.set(`${INBOX}/${takenName(name, SESSION.slice(0, 8), PROMPT_AT - CLAIM_MS)}`, body)
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('- [?] Database — Use staging?')
  expect(effectivePromptMirror(world).state).toBe('waiting')
  expect(world.asked).toEqual([])
  expect(Object.hasOwn(world.store!.inboxDone as object, name)).toBe(true)
})

test('a session end clears a provisional question before a later board turn', async ($, on) => {
  const { world } = questionWorld()
  const clock = engineBeneath(on, world)
  await probeStart($)
  addPrompt(world, PROMPT_AT + 1000)
  await clock.advance(5000)
  world.files.set(`${INBOX}/codex-end-${PROMPT_AT + 2000}-77.json`, JSON.stringify({ session_id: PROMPT_SESSION }))
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 3000}-77.json`, JSON.stringify({ session_id: PROMPT_SESSION, prompt: '/board', last_assistant_message: 'Board' }))
  await clock.advance(5000)
  expect(effectivePromptMirror(world).promptQuestion).toBe(null)
  expect(effectivePromptMirror(world).state).toBe('ended')
  expect(effectivePromptMirror(world).tasks.some(one => one.waiting === 'you')).toBe(false)
  expect(world.asked).toEqual([])
})

for (const [when, delta] of [['older', -1000], ['equal', 0], ['newer', 1000]] as const) test(`raw-owner completion and ${when} prompts compose without restoring prior questions`, async ($, on) => {
  const { world, mirror } = questionWorld()
  const confirmedAt = PROMPT_AT + 5000
  const overlay = completionOverlay(`agent:${PROMPT_ID}`, mirror, confirmedAt)
  world.store![completionKey(overlay)] = overlay
  world.files.set(FILE, upsertAutoBlock(world.files.get(FILE)!, overlay.completed, ZH_TW))
  const completed = world.files.get(FILE)
  addPrompt(world, confirmedAt + delta)
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.store![`agent:${PROMPT_ID}`]).toEqual(mirror)
  expect(world.store![completionKey(overlay)]).toEqual(overlay)
  expect(overlay.source).toBe(sha256(JSON.stringify(mirror)))
  expect(world.files.get(FILE)).toContain(`state=${when === 'newer' ? 'working' : 'done'}`)
  if (when !== 'newer') expect(world.files.get(FILE)).toBe(completed)
  expect(parseProgress(world.files.get(FILE)!).flatMap(project => project.tasks).flatMap(task => task.steps).some(step => step.status === 'waiting')).toBe(false)
  expect(world.files.get(FILE)).not.toContain('Use staging?')
  expect(world.asked).toEqual([])
  expect(world.reads?.some(path => path.includes('rollout-prompt'))).toBe(false)
})

test('a held older model summary cannot stand over a pane confirmation on its raw owner', async ($, on) => {
  const { world, mirror } = questionWorld()
  const ended = { ...mirror, state: 'ended' as const }
  world.store![`agent:${PROMPT_ID}`] = ended
  world.store!.opened = ['others', 'stopped']
  world.files.set(FILE, upsertAutoBlock(world.files.get(FILE)!, ended, ZH_TW))
  let reached!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  world.holdComplete = { reached, release: held }
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 1000}-1.json`, JSON.stringify({ session_id: PROMPT_SESSION, cwd: '/demo', prompt: 'Older work', last_assistant_message: 'OLD_QUESTION?' }))
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  await entered
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'demo::Migration' })
  await ui.press({ key: 'demo::Migration::done' })
  expect(await ui.find({ type: 'Text', text: ZH_TW.confirmedDone('Migration') })).toBeDefined()
  const completed = world.files.get(FILE)
  expect(completed).toContain('state=done')
  release()
  await clock.advance(1000)
  expect(world.files.get(FILE)).toBe(completed)
  expect(world.files.get(FILE)).not.toContain('OLD_QUESTION')
  expect(world.store![`agent:${PROMPT_ID}`]).toEqual(ended)
  expect(world.asked).toHaveLength(1)
  await ui.unmount()
})

test('another agent prompt immediately answers its visible question without a model or transcript read', async ($, on) => {
  const { world, mirror } = questionWorld()
  const foreign = '\n## other\n### Personal task\n- [?] Leave this question alone\n'
  world.files.set(FILE, world.files.get(FILE)! + foreign)
  addPrompt(world, PROMPT_AT + 1000)
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  const saved = effectivePromptMirror(world)
  expect(world.store![`agent:${PROMPT_ID}`]).toEqual(mirror)
  expect(saved.state).toBe('working')
  expect(saved.tasks.some(one => one.waiting === 'you')).toBe(false)
  expect(saved.firstPrompt).toBe('Original request')
  expect(saved.turnOrder).toBe(PROMPT_AT * 2)
  expect(JSON.stringify(saved)).not.toContain('PRIVATE_')
  expect(world.asked).toEqual([])
  expect(world.reads?.some(path => path.includes('rollout-prompt'))).toBe(false)
  expect(world.files.get(FILE)).toContain('state=working')
  expect(world.files.get(FILE)?.endsWith(foreign)).toBe(true)
})

test("a prompt that answers another agent's question takes it off Waiting on you and closes its question record", async ($, on) => {
  const { world } = questionWorld()
  const pending = peekInbox([{ name: `codex-turn-${PROMPT_AT}-1.json`, body: JSON.stringify({ session_id: PROMPT_SESSION, cwd: '/demo', last_assistant_message: 'Use staging?' }), at: PROMPT_AT }])
  const initial = observeQuestions(emptyQuestions(), parseProgress(world.files.get(FILE)!), null, [], PROMPT_AT, true, 'fixture', undefined, pending).ledger
  world.files.set(FILE.replace('.md', '-questions.json'), questionsJson(initial))
  const ledger = () => (JSON.parse(world.files.get(FILE.replace('.md', '-questions.json')) ?? '{"records":[]}').records as Array<{ words: string; isUnresolved?: boolean }>).filter(row => row.isUnresolved)
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(ledger().map(row => row.words)).toEqual(['Database — Use staging?', 'Use staging?'])
  addPrompt(world, PROMPT_AT + 1000)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('- [x] Database — Use staging?')
  expect(ledger()).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Text', text: '● 0' })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).not.toContain('Use staging?')
  await ui.unmount()
})

test('unknown stale equal-clock and unclocked agent prompts change neither mirrors nor board', async ($, on) => {
  const { world, mirror } = questionWorld()
  const before = world.files.get(FILE)
  addPrompt(world, PROMPT_AT - 1000)
  addPrompt(world, PROMPT_AT)
  addPrompt(world, PROMPT_AT + 1000, 'never-seen-session')
  world.files.set(`${INBOX}/codex-prompt-no-clock-88.json`, JSON.stringify({ session_id: PROMPT_SESSION }))
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toBe(before)
  expect(world.store![`agent:${PROMPT_ID}`]).toEqual(mirror)
  expect(Object.keys(world.store!).filter(key => key.startsWith('agent:'))).toEqual([`agent:${PROMPT_ID}`])
  expect(world.asked).toEqual([])
})

test('a known session with no stored source clock keeps its visible question on prompt intake', async ($, on) => {
  const { world, mirror } = questionWorld()
  const { turnOrder, ...unknown } = mirror
  world.store![`agent:${PROMPT_ID}`] = { ...unknown, updated: PROMPT_AT + 6000 }
  const before = world.files.get(FILE)
  addPrompt(world, PROMPT_AT + 1000)
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toBe(before)
  expect(Object.keys(world.store!).some(key => key.startsWith('agentPrompt:'))).toBe(false)
  expect(world.asked).toEqual([])
})

for (const variant of ['archived', 'fenced', 'foreign', 'duplicate', 'unclosed']) test(`a prompt never recreates or changes a ${variant} agent block`, async ($, on) => {
  const { world, mirror } = questionWorld()
  const block = world.files.get(FILE)!
  const before = variant === 'archived' ? '# Progress\n' : variant === 'fenced' ? `\`\`\`markdown\n${block}\n\`\`\`\n` : variant === 'foreign' ? block.replace(`resume=${PROMPT_SESSION}`, 'resume=foreign-owner') : variant === 'unclosed' ? block.replace(`<!-- /auto session=${PROMPT_ID} -->`, '') : `${block}\n${block}`
  world.files.set(FILE, before)
  addPrompt(world, PROMPT_AT + 1000)
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toBe(before)
  expect(world.store![`agent:${PROMPT_ID}`]).toEqual(mirror)
  expect(world.asked).toEqual([])
})

test('a prompt clears a question during an older model summary and that summary cannot reopen it', async ($, on) => {
  const { world } = questionWorld()
  let reached!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  world.holdComplete = { reached, release: held }
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 5000}-1.json`, JSON.stringify({ session_id: PROMPT_SESSION, cwd: '/demo', prompt: 'Older work', last_assistant_message: 'OLD_QUESTION?' }))
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  await entered
  addPrompt(world, PROMPT_AT + 6000)
  await clock.advance(5000)
  expect(effectivePromptMirror(world).state).toBe('working')
  expect(parseProgress(world.files.get(FILE)!).flatMap(project => project.tasks).flatMap(task => task.steps).some(step => step.status === 'waiting')).toBe(false)
  expect(world.asked).toHaveLength(1)
  release()
  await clock.advance(1000)
  expect(world.files.get(FILE)).not.toContain('OLD_QUESTION')
  expect(effectivePromptMirror(world).state).toBe('working')
  expect(world.asked).toHaveLength(2)
  expect(world.files.get(FILE)).not.toContain('- [?]')
})

test('another session prompt barrier survives an older digest read-back retry', async ($, on) => {
  const { world, mirror } = questionWorld()
  const original = world.files.get(FILE)!
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 5000}-1.json`, JSON.stringify({ session_id: PROMPT_SESSION, cwd: '/demo', prompt: 'Older work', last_assistant_message: 'OLD_QUESTION?' }))
  world.afterWrite = () => {
    const current = world.store![`agent:${PROMPT_ID}`] as typeof mirror
    const next = answerAgentPrompt(current, { agent: 'codex', event: 'prompt', id: PROMPT_ID, session: PROMPT_SESSION, cwd: '/demo', project: 'demo', prompt: '', answer: '', transcript: '', at: PROMPT_AT + 6000 }, PROMPT_AT + 7000)!
    world.store![`agent:${PROMPT_ID}`] = next
    return upsertAutoBlock(original, next, ZH_TW)
  }
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('state=working')
  // The answered question keeps its words on a finished step, so its record can close.
  expect(world.files.get(FILE)).not.toContain('- [?]')
  expect(world.files.get(FILE)).toContain('- [x] Old decision — OLD_QUESTION?')
  expect((world.store![`agent:${PROMPT_ID}`] as { state: string }).state).toBe('working')
  expect(world.asked).toHaveLength(1)
})

test('a turn read after a newer prompt keeps its finished steps and its question stays answered', async ($, on) => {
  const { world } = questionWorld()
  world.reply = () => 'TITLE: Migration\nCONTEXT: fixture\nDONE: Added the limiter\nNEXT: Continue\nASK: Limit — 100 or 300?'
  addPrompt(world, PROMPT_AT + 3000)
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  const name = `${INBOX}/codex-turn-${PROMPT_AT + 2000}-1.json`
  world.files.set(name, JSON.stringify({ session_id: PROMPT_SESSION, cwd: '/demo', prompt: 'Add a limiter', last_assistant_message: 'Added the limiter. 100 or 300?' }))
  world.mtime += 1
  await clock.advance(5000)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('- [x] Added the limiter')
  expect(parseProgress(world.files.get(FILE)!).flatMap(project => project.tasks).flatMap(task => task.steps).some(step => step.status === 'waiting')).toBe(false)
  expect(world.files.get(FILE)).not.toContain('100 or 300')
  expect(effectivePromptMirror(world).state).toBe('working')
  expect(world.asked).toHaveLength(1)
  expect(world.files.has(name)).toBe(false)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    expect(JSON.stringify(await ui.drawn())).not.toContain('100 or 300')
  } finally {
    await ui.unmount()
  }
})

test('a session end read after a newer prompt keeps the session working', async ($, on) => {
  const { world } = questionWorld()
  world.reply = () => 'TITLE: Migration\nCONTEXT: fixture\nDONE: Added the limiter\nNEXT: Continue\nASK: Limit — 100 or 300?'
  addPrompt(world, PROMPT_AT + 3000)
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 2000}-1.json`, JSON.stringify({ session_id: PROMPT_SESSION, cwd: '/demo', prompt: 'Add a limiter', last_assistant_message: 'Added the limiter. 100 or 300?' }))
  world.files.set(`${INBOX}/codex-end-${PROMPT_AT + 2000}-1.json`, JSON.stringify({ session_id: PROMPT_SESSION }))
  world.mtime += 1
  await clock.advance(5000)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('- [x] Added the limiter')
  expect(world.files.get(FILE)).toContain('state=working')
  expect(effectivePromptMirror(world).state).toBe('working')
})

test('a board reply older than a newer prompt changes nothing', async ($, on) => {
  const { world } = questionWorld()
  addPrompt(world, PROMPT_AT + 3000)
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  const before = world.files.get(FILE)
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 2000}-77.json`, JSON.stringify({ session_id: PROMPT_SESSION, prompt: '/board', last_assistant_message: 'Board' }))
  world.mtime += 1
  await clock.advance(5000)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toBe(before)
  expect(parseProgress(world.files.get(FILE)!).flatMap(project => project.tasks).flatMap(task => task.steps).some(step => step.status === 'waiting')).toBe(false)
  expect(effectivePromptMirror(world).state).toBe('working')
  expect(world.asked).toEqual([])
})

test('a turn read after a prompt another session took keeps its question answered', async ($, on) => {
  const { world } = questionWorld()
  world.reply = () => 'TITLE: Migration\nCONTEXT: fixture\nDONE: Added the limiter\nNEXT: Continue\nASK: Limit — 100 or 300?'
  world.store![`agentPrompt:${PROMPT_ID}:${(PROMPT_AT + 3000) * 2}:${PROMPT_AT + 3500}`] = { id: PROMPT_ID, agent: 'codex', session: PROMPT_SESSION, at: PROMPT_AT + 3000, updated: PROMPT_AT + 3500 }
  world.files.set(FILE, upsertAutoBlock(world.files.get(FILE)!, effectivePromptMirror(world), ZH_TW))
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  const name = `${INBOX}/codex-turn-${PROMPT_AT + 2000}-1.json`
  world.files.set(name, JSON.stringify({ session_id: PROMPT_SESSION, cwd: '/demo', prompt: 'Add a limiter', last_assistant_message: 'Added the limiter. 100 or 300?' }))
  world.mtime += 1
  await clock.advance(5000)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('- [x] Added the limiter')
  expect(parseProgress(world.files.get(FILE)!).flatMap(project => project.tasks).flatMap(task => task.steps).some(step => step.status === 'waiting')).toBe(false)
  expect(effectivePromptMirror(world).state).toBe('working')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    expect(JSON.stringify(await ui.drawn())).not.toContain('100 or 300')
  } finally {
    await ui.unmount()
  }
})

test('a late reply that only asks keeps the block\'s open steps', async ($, on) => {
  const { world } = questionWorld()
  world.reply = () => 'TITLE: Migration\nCONTEXT: fixture\nDONE: -\nNEXT: -\nASK: Limit — 100 or 300?'
  addPrompt(world, PROMPT_AT + 3000)
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 2000}-1.json`, JSON.stringify({ session_id: PROMPT_SESSION, cwd: '/demo', prompt: 'Add a limiter', last_assistant_message: '100 or 300?' }))
  world.mtime += 1
  await clock.advance(5000)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('- [ ] Continue migration')
  expect(parseProgress(world.files.get(FILE)!).flatMap(project => project.tasks).flatMap(task => task.steps).some(step => step.status === 'waiting')).toBe(false)
  expect(effectivePromptMirror(world).state).toBe('working')
})

test('a late turn and a newer turn read in one look fold in order', async ($, on) => {
  const { world } = questionWorld()
  world.reply = prompt => prompt.includes('Deployed the limiter. Ship it?')
    ? 'TITLE: Migration\nCONTEXT: fixture\nDONE: Deployed the limiter\nNEXT: -\nASK: Ship — Ship it?'
    : 'TITLE: Migration\nCONTEXT: fixture\nDONE: Added the limiter\nNEXT: Continue\nASK: Limit — 100 or 300?'
  addPrompt(world, PROMPT_AT + 3000)
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 2000}-1.json`, JSON.stringify({ session_id: PROMPT_SESSION, cwd: '/demo', prompt: 'Add a limiter', last_assistant_message: 'Added the limiter. 100 or 300?' }))
  world.files.set(`${INBOX}/codex-turn-${PROMPT_AT + 4000}-1.json`, JSON.stringify({ session_id: PROMPT_SESSION, cwd: '/demo', prompt: 'Deploy the limiter', last_assistant_message: 'Deployed the limiter. Ship it?' }))
  world.mtime += 1
  await clock.advance(5000)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('- [x] Added the limiter')
  expect(world.files.get(FILE)).toContain('- [x] Deployed the limiter')
  expect(world.files.get(FILE)).not.toContain('100 or 300')
  const waiting = parseProgress(world.files.get(FILE)!).flatMap(project => project.tasks).flatMap(task => task.steps).filter(step => step.status === 'waiting')
  expect(waiting).toHaveLength(1)
  expect(waiting[0]!.text).toContain('Ship it?')
  expect(effectivePromptMirror(world).state).toBe('waiting')
})

test('a newer owner landing immediately before prompt persistence is never overwritten', async ($, on) => {
  const { world, mirror } = questionWorld()
  const newer = { ...mirror, title: 'Newer owner work', turnOrder: (PROMPT_AT + 2000) * 2, updated: PROMPT_AT + 2000 }
  let isInterleaved = false
  world.beforeStoreSet = key => {
    if (isInterleaved || key !== `agent:${PROMPT_ID}` && !key.startsWith(`agentPrompt:${PROMPT_ID}:`)) return
    isInterleaved = true
    world.store![`agent:${PROMPT_ID}`] = newer
    world.files.set(FILE, upsertAutoBlock(world.files.get(FILE)!, newer, ZH_TW))
  }
  addPrompt(world, PROMPT_AT + 1000)
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(isInterleaved).toBe(true)
  expect(world.store![`agent:${PROMPT_ID}`]).toEqual(newer)
  expect(effectivePromptMirror(world)).toEqual(newer)
  expect(world.files.get(FILE)).toContain('### Newer owner work')
  expect(world.asked).toEqual([])
})

for (const failure of ['denied write', 'nonpersisting write', 'readback error']) test(`a prompt ${failure} retains its claim until its immutable receipt is verified`, async ($, on) => {
  const { world } = questionWorld()
  let isFailing = true
  world.failStore = (operation, key) => isFailing && key.startsWith(`agentPrompt:${PROMPT_ID}:`) && (failure === 'denied write' && operation === 'set' || failure === 'readback error' && operation === 'get')
  world.ignoreStore = key => isFailing && failure === 'nonpersisting write' && key.startsWith(`agentPrompt:${PROMPT_ID}:`)
  const name = addPrompt(world, PROMPT_AT + 1000)
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  const claim = [...world.files.keys()].find(path => path.startsWith(`${INBOX}/${name}.`) && path.endsWith('.taking'))!
  expect(claim).toBeDefined()
  expect(world.files.get(FILE)).toContain('state=working')
  expect((world.store!.inboxDone as Record<string, string>)[name]).toBeUndefined()
  expect((world.store!.inboxFailed as Record<string, string>)[name]).toContain(failure === 'nonpersisting write' ? 'PROMPT_RECEIPT_NOT_KEPT' : 'EIO')
  const expired = `${INBOX}/${name}.deadbeef-${(PROMPT_AT - 3600000).toString(36)}-1.taking`
  world.files.set(expired, world.files.get(claim)!)
  world.files.delete(claim)
  world.mtime += 1
  isFailing = false
  await clock.advance(5000)
  expect(world.files.has(expired)).toBe(false)
  expect((world.store!.inboxDone as Record<string, string>)[name]).toBeDefined()
  expect(effectivePromptMirror(world).state).toBe('working')
  expect(world.asked).toEqual([])
  expect(world.reads?.some(path => path.includes('rollout-prompt'))).toBe(false)
})

test('receipt write failure retains the input despite a verified board output', async ($, on) => {
  const world = probeWorld()
  world.failStore = (operation, key) => operation === 'set' && key === 'inboxDone'
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('### fixture')
  expect((world.store!.inboxDone as Record<string, string>)[PROBE_NAME]).toBeUndefined()
  expect([...world.files.keys()].some(path => path.endsWith('.taking'))).toBe(true)
})

test('a saved inbox digest appears once in chat even when its receipt cannot be written', async ($, on) => {
  const world = probeWorld()
  world.failStore = (operation, key) => operation === 'set' && key === 'inboxDone'
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  const projects = parseProgress(world.files.get(FILE) ?? '')
  const at = Date.parse('2026-10-16T12:00:05Z')
  const files = [...world.files].flatMap(([path, body]) => {
    const name = path.slice(`${INBOX}/`.length)
    return path.startsWith(`${INBOX}/`) && isInboxFile(name) ? [{ name, body, at }] : []
  })
  const text = chatText(buildView(projects, [], null, at, 0, {}, EN), peekInbox(files), [], EN, '/home/me')
  expect([...world.files.keys()].some(path => path.endsWith('.taking'))).toBe(true)
  expect(text.split('› fixture').length - 1).toBe(1)
  expect(text).not.toContain(EN.chatPendingReports)
  expect(text).not.toContain('Implemented a fixture.')
})

test('failed-note write failure retains a settled input rather than silently deleting it', async ($, on) => {
  const world = probeWorld()
  world.store!.inboxFailed = { [PROBE_NAME]: '1:1792152000000:previous failure' }
  world.failStore = (operation, key) => operation === 'set' && key === 'inboxFailed'
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('### fixture')
  expect((world.store!.inboxFailed as Record<string, string>)[PROBE_NAME]).toContain('previous failure')
  expect([...world.files.keys()].some(path => path.endsWith('.taking'))).toBe(true)
})

test('malformed JSON remains available for diagnosis rather than being acknowledged and deleted', async ($, on) => {
  const world = probeWorld()
  world.files.set(`${INBOX}/${PROBE_NAME}`, '{interrupted JSON')
  const clock = engineBeneath(on, world)
  const seen = outside(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.asked).toHaveLength(0)
  expect(world.files.get(FILE)).toBe('# Progress\n')
  expect([...world.files.values()].includes('{interrupted JSON')).toBe(true)
  expect(world.files.get(`${INBOX}/${PROBE_NAME}.failed`)).toBe('{interrupted JSON')
  expect((world.store!.inboxDone as Record<string, string>)[PROBE_NAME]).toBeUndefined()
  expect((world.store!.inboxFailed as Record<string, string>)[PROBE_NAME]).toContain('INVALID_INPUT')
  expect(seen.notified.some(text => text.includes(`${PROBE_NAME}.failed`) && text.includes('INVALID_INPUT'))).toBe(true)
})

test('a report missing its session remains available for diagnosis', async ($, on) => {
  const world = probeWorld()
  const body = JSON.stringify({ cwd: '/work/synthetic', last_assistant_message: 'Real task text with no session field.' })
  world.files.set(`${INBOX}/${PROBE_NAME}`, body)
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.asked).toHaveLength(0)
  expect(world.files.get(FILE)).toBe('# Progress\n')
  expect([...world.files.values()].includes(body)).toBe(true)
  expect(world.files.get(`${INBOX}/${PROBE_NAME}.failed`)).toBe(body)
  expect((world.store!.inboxDone as Record<string, string>)[PROBE_NAME]).toBeUndefined()
})

test('later seconds timestamps can advance a session previously reported in milliseconds', async ($, on) => {
  const world = probeWorld()
  world.files.delete(`${INBOX}/${PROBE_NAME}`)
  world.files.set(`${INBOX}/codex-turn-1792216380000-1.json`, PROBE_BODY)
  world.files.set(`${INBOX}/codex-end-1792216390000-2.json`, JSON.stringify({ session_id: 'pr53-fixture', cwd: '/work/synthetic' }))
  world.reply = prompt => prompt.includes('NEW_SECONDS') ? PROBE_REPLY.replace('fixture', 'Seconds fixture') : PROBE_REPLY
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('agent=codex state=ended')
  world.files.set(`${INBOX}/codex-turn-1792216400-3.json`, PROBE_BODY.replace('Implemented a fixture.', 'NEW_SECONDS implemented a later result.'))
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('### Seconds fixture')
  expect(world.files.get(FILE)).toContain('agent=codex state=waiting')
})

test('a receipt read failure cannot replace other inputs processed records', async ($, on) => {
  const world = probeWorld()
  const other = 'gemini-turn-1792216380-99.json'
  world.store!.inboxDone = { [other]: 'other:1792152000000' }
  world.failStore = (operation, key) => operation === 'get' && key === 'inboxDone' && (world.asked?.length ?? 0) > 0
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('### fixture')
  expect((world.store!.inboxDone as Record<string, string>)[other]).toBe('other:1792152000000')
})

test('receipt persistence recovers through a retained expired claim without another digest', async ($, on) => {
  const world = probeWorld()
  let isDenied = true
  world.failStore = (operation, key) => isDenied && operation === 'set' && key === 'inboxDone'
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  const claim = [...world.files.keys()].find(path => path.endsWith('.taking'))!
  expect(world.files.get(claim)).toBe(PROBE_BODY)
  const calls = world.asked!.length
  // Seed the same retained bytes under an expired claim, avoiding a long timer
  // simulation. This represents recovery, not a real process interruption.
  const expired = `${INBOX}/${PROBE_NAME}.deadbeef-${(Date.parse('2026-10-16T11:00:00Z')).toString(36)}-1.taking`
  world.files.set(expired, world.files.get(claim)!)
  world.files.delete(claim)
  world.mtime += 1
  isDenied = false
  await clock.advance(5000)
  expect(world.files.has(expired)).toBe(false)
  expect([...world.files.keys()].some(path => path.endsWith('.taking'))).toBe(false)
  expect((world.store!.inboxDone as Record<string, string>)[PROBE_NAME]).toBeDefined()
  expect(world.asked!.length).toBe(calls)
})

test('a receipt write that returns success but does not persist cannot authorize deletion', async ($, on) => {
  const world = probeWorld()
  world.ignoreStore = key => key === 'inboxDone'
  const clock = engineBeneath(on, world)
  const seen = outside(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect([...world.files.keys()].some(path => path.endsWith('.taking'))).toBe(true)
  expect((world.store!.inboxDone as Record<string, string>)[PROBE_NAME]).toBeUndefined()
  expect(seen.notified.some(text => text.includes('INBOX_STORE_NOT_VERIFIED'))).toBe(true)
})

test('receipt read-back failure retains input until a later read verifies persistence', async ($, on) => {
  const world = probeWorld()
  let isDenied = true
  world.failStore = (operation, key) => isDenied && operation === 'get' && key === 'inboxDone' && (world.store!.inboxDone as Record<string, string>)[PROBE_NAME] !== undefined
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect([...world.files.keys()].some(path => path.endsWith('.taking'))).toBe(true)
  const calls = world.asked!.length
  isDenied = false
  await clock.advance(60000)
  expect([...world.files.keys()].some(path => path.endsWith('.taking'))).toBe(false)
  expect(world.asked!.length).toBe(calls)
})

test('an unreadable failure-note map preserves both existing maps and the input', async ($, on) => {
  const world = probeWorld()
  world.store!.inboxFailed = { other: '1:1792152000000:prior diagnostic' }
  const clock = engineBeneath(on, world)
  await probeStart($)
  world.failStore = (operation, key) => operation === 'get' && key === 'inboxFailed'
  await clock.advance(5000)
  expect(world.store!.inboxDone).toEqual({})
  expect(world.store!.inboxFailed).toEqual({ other: '1:1792152000000:prior diagnostic' })
  expect(world.files.get(`${INBOX}/${PROBE_NAME}`)).toBe(PROBE_BODY)
})

test('an invalid receipt map cannot authorize cleanup of a retained claim', async ($, on) => {
  const world = probeWorld()
  world.files.delete(`${INBOX}/${PROBE_NAME}`)
  const claim = `${INBOX}/${PROBE_NAME}.deadbeef.taking`
  world.files.set(claim, PROBE_BODY)
  world.store!.inboxDone = { [PROBE_NAME]: 42 }
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.files.get(claim)).toBe(PROBE_BODY)
  expect(world.asked).toHaveLength(0)
})

test('invalid input is retained in place if its quarantine diagnostic cannot persist', async ($, on) => {
  const world = probeWorld()
  world.files.set(`${INBOX}/${PROBE_NAME}`, '{broken')
  world.failStore = (operation, key) => operation === 'set' && key === 'inboxFailed'
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  const claim = [...world.files.keys()].find(path => path.endsWith('.taking'))!
  expect(world.files.get(claim)).toBe('{broken')
  expect(world.files.has(`${INBOX}/${PROBE_NAME}.failed`)).toBe(false)
  expect((world.store!.inboxDone as Record<string, string>)[PROBE_NAME]).toBeUndefined()
})

test('quarantining invalid input preserves an earlier failed payload with the same name', async ($, on) => {
  const world = probeWorld()
  world.files.set(`${INBOX}/${PROBE_NAME}`, '{new broken input')
  world.files.set(`${INBOX}/${PROBE_NAME}.failed`, 'older evidence')
  // Quarantined a day ago: a file given up on is kept for a week (#373).
  world.mtimes = { [`${INBOX}/${PROBE_NAME}.failed`]: Date.parse('2026-10-15T12:00:00.000Z') }
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.files.get(`${INBOX}/${PROBE_NAME}.failed`)).toBe('older evidence')
  expect(world.files.get(`${INBOX}/${PROBE_NAME}.failed.1`)).toBe('{new broken input')
  expect([...world.files.keys()].some(path => path.endsWith('.taking'))).toBe(false)
})

test('an uncertain quarantine rename retains bytes and reports their resulting path', async ($, on) => {
  const world = probeWorld()
  world.files.set(`${INBOX}/${PROBE_NAME}`, '{broken')
  world.afterMove = (_from, to) => to.endsWith('.failed')
  const clock = engineBeneath(on, world)
  const seen = outside(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.files.get(`${INBOX}/${PROBE_NAME}.failed`)).toBe('{broken')
  expect(seen.notified.some(text => text.includes(`${PROBE_NAME}.failed`) && text.includes('QUARANTINE_NOT_VERIFIED'))).toBe(true)
  expect((world.store!.inboxDone as Record<string, string>)[PROBE_NAME]).toBeUndefined()
})

test('an invalid input does not prevent a later valid session from reaching the board', async ($, on) => {
  const world = probeWorld()
  const bad = 'gemini-turn-1792216379-9.json'
  world.files.set(`${INBOX}/${bad}`, '{broken')
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.files.get(`${INBOX}/${bad}.failed`)).toBe('{broken')
  expect(world.files.get(FILE)).toContain('### fixture')
  expect((world.store!.inboxDone as Record<string, string>)[PROBE_NAME]).toBeDefined()
})

test('legacy seconds order in a stored mirror still rejects older turns after migration', async ($, on) => {
  const world = probeWorld()
  const clock = engineBeneath(on, world)
  await probeStart($)
  await clock.advance(5000)
  const key = Object.keys(world.store!).find(name => name.startsWith('agent:'))!
  const mirror = world.store![key] as Record<string, unknown>
  world.store![key] = { ...mirror, turnOrder: 1792216380 * 2 }
  const before = world.files.get(FILE)
  world.files.set(`${INBOX}/codex-turn-1792216370-99.json`, PROBE_BODY.replace('Implemented a fixture.', 'OLDER work must not replay.'))
  world.mtime += 1
  await clock.advance(5000)
  expect(world.asked).toHaveLength(1)
  expect(world.files.get(FILE)).toBe(before)
})

test('an unreadable claimed input keeps its bytes and immediately names the failure', async ($, on) => {
  const world = probeWorld()
  const claim = `${INBOX}/${PROBE_NAME}.2be48af2-${(Date.parse('2026-10-16T12:00:00Z') + 5000).toString(36)}-1.taking`
  world.unreadable = new Set([claim])
  const clock = engineBeneath(on, world)
  const seen = outside(on, world)
  await probeStart($)
  await clock.advance(5000)
  expect(world.files.get(claim)).toBe(PROBE_BODY)
  expect((world.store!.inboxFailed as Record<string, string>)[PROBE_NAME]).toContain('EFBIG')
  expect(seen.notified.some(text => text.includes(claim) && text.includes('EFBIG'))).toBe(true)
  expect((world.store!.inboxDone as Record<string, string>)[PROBE_NAME]).toBeUndefined()
  expect(world.asked).toHaveLength(0)
})

test('a denied board write immediately names the retained claim and persistence failure', async ($, on) => {
  const world = probeWorld()
  world.unwritable = new Set([FILE])
  const clock = engineBeneath(on, world)
  const seen = outside(on, world)
  await probeStart($)
  await clock.advance(5000)
  const claim = [...world.files.keys()].find(path => path.endsWith('.taking'))!
  expect(world.files.get(claim)).toBe(PROBE_BODY)
  expect((world.store!.inboxFailed as Record<string, string>)[PROBE_NAME]).toContain('EACCES')
  expect(seen.notified.some(text => text.includes(claim) && text.includes('EACCES'))).toBe(true)
  expect((world.store!.inboxDone as Record<string, string>)[PROBE_NAME]).toBeUndefined()
  expect(world.files.get(FILE)).toBe('# Progress\n')
})

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

test("after a resume the pane's own question still counts under Waiting on you", async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00Z')
  const mirror = {
    ...emptyMirror(SESSION, 'persona_framework', at - 1000, '/work/persona_framework'),
    state: 'ended' as const,
    title: 'Check the release',
    tasks: [{ ...confirmStep('Publish'), waiting: 'you' as const, why: 'Ready to publish?' }],
  }
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, [`mirror:${SESSION}`]: mirror } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })
    expect(await ui.find({ type: 'Button', key: 'section::waiting' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'mine::1::hide' })).toBeDefined()
    await ui.unmount()
  }
  for (const state of ['ended', 'done'] as const) {
    const view = buildView([], ['persona_framework'], { ...mirror, state }, at, 0, {}, EN)
    expect(view.overview.waiting).toBe(1)
    expect(view.waiting[0]?.where).toBe('here')
    expect(view.older).toEqual([])
  }
})

test('the Simplified Chinese Resolve wording marks a question as handled', () => {
  expect(ZH_CN.resolveQuestion).toBe('标为已处理')
  expect(ZH_CN.resolveFailed).toBe('无法保存处理结果，这个问题仍未处理。')
  expect(ZH_CN.resolveSucceeded).toBe('已处理')
  expect(ZH_TW.resolveQuestion).toBe('結案')
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

test('with nothing tracked the pane says so and names the progress file', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/x', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: '目前沒有進行中的工作。' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ZH_TW.progressFileShown })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: FILE })).toBeUndefined()
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
  await ui.press({ key: 'section::stopped' })
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

  // One more old block written since: tidy moves it and counts it.
  world.files.set(FILE, OLD_DONE.replace(/c55e2f10/g, 'd66f3021'))
  world.mtime += 1
  const moved = await $.command.run(TIDY)
  expect(moved.text).toBe('封存了 1 個任務。')
  expect(world.files.get(FILE)).not.toContain('session=d66f3021')

  // Run again with nothing left: it says what goes when.
  const again = await $.command.run(TIDY)
  expect(again.text).toBe('沒有可以封存的。做完的工作會馬上封存；停掉的對話要 3 天沒動靜才會；這個對話自己的區塊不會封存。')
})

test('the rule rides the system prompt only while the session has a Task list', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: '你是 Claude。', scope: 'shared' as const }] }))
  const base = { model: 'claude-test', promptModel: 'claude-test', surfaces: [], outputStyle: null, traits: [] }

  const withTasks = await $.prompt.compose({ ...base, tools: ['Read', 'TaskCreate'] })
  expect(withTasks.sections.map(s => s.id)).toEqual(['intro', 'agent-board:rule'])
  expect(withTasks.sections[1]?.text).toContain('TaskCreate')
  expect(withTasks.sections[1]?.scope).toBe('session')

  const without = await $.prompt.compose({ ...base, tools: ['Read'] })
  expect(without.sections.map(s => s.id)).toEqual(['intro'])
})

test('a synthetic corrupt pending journal is moved aside and new completions are saved', async ($, on) => {
  const world: World = { files: new Map([[FILE, '## demo-1\n### Demo task\n- [?] Demo step\n']]), mtime: 1, hasTasks: true, store: { inboxDone: {} } }
  engineBeneath(on, world)
  await probeStart($)
  const bad = { [JOURNAL]: 'damaged synthetic value' }
  world.store![`pendingJournal:${SESSION}`] = bad
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'demo-1::Demo task::0::done' })
  expect(world.store![`pendingJournalBad:${SESSION}`]).toEqual(bad)
  expect(world.files.get(JOURNAL)).toContain(' · Demo step\n')
  expect(world.store![`pendingJournal:${SESSION}`]).toBeUndefined()
  await ui.unmount()
})

test('a synthetic store write failure still saves the new journal line', async ($, on) => {
  const world: World = { files: new Map([[FILE, '## demo-1\n### Demo task\n- [?] Demo step\n']]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await probeStart($)
  world.failStore = (operation, key) => operation === 'set' && key.startsWith('pendingJournal:')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'demo-1::Demo task::0::done' })
  expect(world.files.get(JOURNAL)).toContain(' · Demo step\n')
  expect(await ui.find({ type: 'Text', text: ZH_TW.journalFailed })).toBeUndefined()
  await ui.unmount()
})

test('synthetic store and journal write failures keep new lines for a later retry', async ($, on) => {
  const world: World = { files: new Map([[FILE, '## demo-1\n### Demo task\n- [?] Demo step\n']]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await probeStart($)
  world.failStore = (operation, key) => operation === 'set' && key.startsWith('pendingJournal:')
  world.unwritable = new Set([JOURNAL])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'demo-1::Demo task::0::done' })
  expect(await ui.find({ type: 'Text', text: ZH_TW.journalFailed })).toBeDefined()
  world.failStore = undefined
  world.unwritable.clear()
  await $.session.end({ reason: 'other', sessionId: SESSION, resume: { id: SESSION } as never })
  expect((world.files.get(JOURNAL) ?? '').split(' · Demo step\n')).toHaveLength(2)
  await ui.unmount()
})

test('a synthetic held journal failure does not hold up or fail turn start', async ($, on) => {
  const line = '- 2026-10-16 08:00 · demo-1 · Demo task · Demo step'
  const world: World = { files: new Map([[JOURNAL, '# Work log\n']]), mtime: 1, hasTasks: true, store: { inboxDone: {} } }
  const clock = engineBeneath(on, world)
  let release = (): void => {}
  let reached = (): void => {}
  const atGate = new Promise<void>(resolve => { reached = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  await start($, 'Demo work')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Next step', description: '' })
  await clock.advance(10)
  world.store![`pendingJournal:${SESSION}`] = { [JOURNAL]: [line] }
  world.holdJournalRead = { reached, release: gate }
  let isStarted = false
  const starting = $.turn.start({ text: 'Continue demo', turnId: 'held-journal' }).then(() => { isStarted = true })
  await atGate
  await clock.advance(1)
  const startedWhileHeld = isStarted
  release()
  await starting
  await $.session.end({ reason: 'other', sessionId: SESSION, resume: { id: SESSION } as never })
  expect(startedWhileHeld).toBe(true)
  expect((world.files.get(JOURNAL) ?? '').split(`${line}\n`)).toHaveLength(2)
})

test('a synthetic journal failure leaves a loading aside in place', async ($, on) => {
  const world: World = { files: new Map([[FILE, '## demo-1\n### Demo task\n- [?] Demo step\n']]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  let release = (): void => {}
  let reached = (): void => {}
  const atGate = new Promise<void>(resolve => { reached = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  on('model.fork', async () => {
    reached()
    await gate
    return { value: { isAnswered: true as const, text: 'Demo answer', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  const asking = ui.input({ key: 'ask', text: 'Demo question' })
  await atGate
  world.unwritable = new Set([JOURNAL])
  await ui.press({ key: 'demo-1::Demo task::0::done' })
  const loading = (await ui.findAll({ type: 'Box' }) as PressNode[]).find(node =>
    !pressNodes(node).some(child => child.type === 'Input' || child.type === 'Button')
    && pressTexts(node).includes(ZH_TW.question('Demo question')) && pressTexts(node).includes(ZH_TW.thinking))
  const notice = await ui.find({ type: 'Text', text: ZH_TW.journalFailed })
  release()
  await asking
  expect(loading).toBeDefined()
  expect(notice).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Demo answer' })).toBeDefined()
  await ui.unmount()
})

test('synthetic pending journals from ended sessions are saved at the next session start', async ($, on) => {
  const line = '- 2026-10-16 08:00 · demo-1 · Demo task · Demo step'
  const other = 'pendingJournal:demo-ended'
  const bad = 'pendingJournalBad:demo-ended'
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, store: { inboxDone: {}, [other]: { [JOURNAL]: [line] }, [bad]: { '/synthetic/leave-alone.md': [line] }, 'pendingJournal:demo-empty': {} } }
  engineBeneath(on, world)
  await probeStart($)
  expect((world.files.get(JOURNAL) ?? '').split(`${line}\n`)).toHaveLength(2)
  expect(world.store![other]).toBeUndefined()
  expect(world.store!['pendingJournal:demo-empty']).toBeUndefined()
  expect(world.store![bad]).toEqual({ '/synthetic/leave-alone.md': [line] })
  expect(world.files.has('/synthetic/leave-alone.md')).toBe(false)
})

for (const isPartial of [false, true]) {
  test(`a synthetic journal sweep keeps newer entries when ${isPartial ? 'one original month fails' : 'its original lines all save'}`, async ($, on) => {
    const line = '- 2026-10-16 08:00 · demo-1 · Demo task · First step'
    const newer = '- 2026-10-16 08:01 · demo-1 · Demo task · Newer step'
    const previous = '/home/me/.claude/progress-journal-2026-09.md'
    const older = '- 2026-09-30 08:00 · demo-1 · Demo task · Older step'
    const other = 'pendingJournal:demo-active'
    const pending = isPartial ? { [previous]: [older], [JOURNAL]: [line] } : { [JOURNAL]: [line] }
    const shared: Record<string, unknown> = { inboxDone: {}, autoConnectOff: true, [other]: pending }
    const world: World = {
      files: new Map([[previous, '# Work log\n']]), mtime: 1, hasTasks: true, shared,
      unreadable: new Set(isPartial ? [previous] : []),
      // The owner adds a completion and fails to save it after the sweep read its key.
      afterJournalWrite: () => { shared[other] = { ...pending, [JOURNAL]: [line, newer] } },
    }
    engineBeneath(on, world)
    await probeStart($)
    expect(shared[other]).toEqual(isPartial ? { [previous]: [older], [JOURNAL]: [newer] } : { [JOURNAL]: [newer] })
    expect((world.files.get(JOURNAL) ?? '').split(`${line}\n`)).toHaveLength(2)
    expect(world.files.get(JOURNAL)).not.toContain(newer)

    world.afterJournalWrite = undefined
    world.unreadable!.clear()
    await probeStart($)
    expect(shared[other]).toBeUndefined()
    expect((world.files.get(JOURNAL) ?? '').split(`${line}\n`)).toHaveLength(2)
    expect((world.files.get(JOURNAL) ?? '').split(`${newer}\n`)).toHaveLength(2)
    if (isPartial) expect((world.files.get(previous) ?? '').split(`${older}\n`)).toHaveLength(2)
  })
}

test('a synthetic journal sweep failure for another session does not promise a next message retry', async ($, on) => {
  const line = '- 2026-10-16 08:00 · demo-1 · Demo task · Demo step'
  const other = 'pendingJournal:demo-ended'
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, store: { inboxDone: {}, [other]: { [JOURNAL]: [line] } }, unwritable: new Set([JOURNAL]) }
  engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Text', text: ZH_TW.journalFailed })).toBeUndefined()
  expect(world.store![other]).toEqual({ [JOURNAL]: [line] })

  world.unwritable!.clear()
  await $.turn.start({ text: 'Continue demo', turnId: 'other-session-pending' })
  await $.session.end({ reason: 'other', sessionId: SESSION, resume: { id: SESSION } as never })
  expect(world.files.get(JOURNAL)).toBeUndefined()
  expect(world.store![other]).toEqual({ [JOURNAL]: [line] })
  await probeStart($)
  expect((world.files.get(JOURNAL) ?? '').split(`${line}\n`)).toHaveLength(2)
  expect(world.store![other]).toBeUndefined()
  await ui.unmount()
})

test('a synthetic pending journal is retried when its session ends', async ($, on) => {
  const world: World = { files: new Map([[FILE, '## demo-1\n### Demo task\n- [?] Demo step\n']]), mtime: 1, hasTasks: true, store: { inboxDone: {} } }
  engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  world.unwritable = new Set([JOURNAL])
  await ui.press({ key: 'demo-1::Demo task::0::done' })
  world.unwritable.clear()
  await $.session.end({ reason: 'other', sessionId: SESSION, resume: { id: SESSION } as never })
  expect((world.files.get(JOURNAL) ?? '').split(' · Demo step\n')).toHaveLength(2)
  expect(world.store![`pendingJournal:${SESSION}`]).toBeUndefined()
  await ui.unmount()
})

test('a synthetic journal failure notice stays dismissed through failed turn retries', async ($, on) => {
  const world: World = { files: new Map([[FILE, '## demo-1\n### Demo task\n- [?] Demo step\n']]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  world.unwritable = new Set([JOURNAL])
  await ui.press({ key: 'demo-1::Demo task::0::done' })
  await ui.press({ key: 'clear-answer' })
  await $.turn.start({ text: 'Continue demo', turnId: 'failed-journal-retry' })
  await $.session.end({ reason: 'other', sessionId: SESSION, resume: { id: SESSION } as never })
  expect(await ui.find({ type: 'Text', text: ZH_TW.journalFailed })).toBeUndefined()
  await ui.unmount()
})

test('a synthetic journal failure leaves a copied report in place', async ($, on) => {
  const world: World = { files: new Map([[FILE, '## demo-1\n### Demo task\n- [?] Demo step\n']]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  outside(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'report' })
  world.unwritable = new Set([JOURNAL])
  await ui.press({ key: 'demo-1::Demo task::0::done' })
  expect(await ui.find({ type: 'Text', text: ZH_TW.copied })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ZH_TW.journalFailed })).toBeUndefined()
  await ui.unmount()
})

test('a synthetic pending-store read failure without entries does not show a journal notice', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await probeStart($)
  world.failStore = (operation, key) => operation === 'get' && key.startsWith('pendingJournal:')
  await $.turn.start({ text: 'Demo work', turnId: 'unreadable-pending' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Text', text: ZH_TW.journalFailed })).toBeUndefined()
  await ui.unmount()
})

test('a synthetic journal read failure preserves the count only until the local day changes', async ($, on) => {
  const world: World = { files: new Map([[FILE, '## demo-1\n### Demo task\n- [?] Demo step\n']]), mtime: 1, hasTasks: true, at: new Date(2026, 9, 16, 23, 59).getTime() }
  const clock = engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'demo-1::Demo task::0::done' })
  expect(await ui.find({ type: 'Text', text: '✓ 1' })).toBeDefined()
  world.unreadable = new Set([JOURNAL])
  await $.session.start({ cwd: '/work/demo-1', surface: 'desktop', isInteractive: true })
  expect(await ui.find({ type: 'Text', text: '✓ 1' })).toBeDefined()
  await clock.advance(2 * 60 * 1000)
  expect(await ui.find({ type: 'Text', text: '✓ 0' })).toBeDefined()
  await ui.unmount()
})

// Synthetic file failures use only the in-memory engine.
for (const [language, words] of [['en', EN], ['zh-TW', ZH_TW], ['zh-CN', ZH_CN]] as const) {
  for (const failure of ['read', 'write'] as const) {
    test(`a synthetic journal ${failure} failure keeps the step done and retries once in ${language}`, async ($, on) => {
      const past = '# Work log\n- 2026-10-15 12:00 · demo-1 · Earlier work · Earlier step\n'
      const world: World = {
        files: new Map([[FILE, '## demo-1\n### Demo task\n- [?] Demo step\n- [?] Next step\n'], [JOURNAL, past]]),
        mtime: 1,
        hasTasks: true,
        store: { inboxDone: {}, notifyOff: true },
      }
      const clock = engineBeneath(on, world)
      await $.session.start({ cwd: '/work/demo-1', surface: 'desktop', isInteractive: true })
      await $.command.run({ ...TIDY, args: `lang ${language}` })
      const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
      if (failure === 'read') world.unreadable = new Set([JOURNAL])
      else world.unwritable = new Set([JOURNAL])

      // Both clicks use the same drawn button before the first tick removes it.
      await Promise.all([
        ui.press({ key: 'demo-1::Demo task::0::done' }),
        ui.press({ key: 'demo-1::Demo task::0::done' }),
      ])
      expect(world.files.get(FILE)).toContain('- [x] Demo step')
      expect(world.files.get(JOURNAL)).toBe(past)
      expect(await ui.find({ type: 'Text', text: words.journalFailed })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: words.question(words.journalNoticeTitle) })).toBeDefined()

      // One ordinary poll verifies notice deduplication; the retry is triggered by turn.start.
      await clock.advance(2000)
      world.unreadable?.clear()
      world.unwritable?.clear()
      await $.turn.start({ text: 'Continue demo', turnId: 'journal-retry' })
      const saved = world.files.get(JOURNAL) ?? ''
      expect(saved.startsWith(past)).toBe(true)
      expect(saved.split(' · Demo step\n')).toHaveLength(2)
      expect(await ui.find({ type: 'Text', text: words.journalFailed })).toBeUndefined()
      await $.turn.start({ text: 'Continue demo again', turnId: 'journal-retry-again' })
      expect(world.files.get(JOURNAL)).toBe(saved)
      await ui.press({ key: 'demo-1::Demo task::1::done' })
      expect((world.files.get(JOURNAL) ?? '').split(' · Demo step\n')).toHaveLength(2)
      expect((world.files.get(JOURNAL) ?? '').split(' · Next step\n')).toHaveLength(2)
      await ui.unmount()
    })
  }
}

test('a synthetic journal write failure retains automatic completions until the next journal write', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, named: 'Demo task' }
  const clock = engineBeneath(on, world)
  await start($, 'Demo work')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Demo step', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Next step', description: '' })
  await clock.advance(10)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  world.unwritable = new Set([JOURNAL])
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  expect(await ui.find({ type: 'Text', text: ZH_TW.journalFailed })).toBeDefined()
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  world.unwritable.clear()
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed' })
  const saved = world.files.get(JOURNAL) ?? ''
  expect(saved.split(' · Demo step\n')).toHaveLength(2)
  expect(saved.split(' · Next step\n')).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: ZH_TW.journalFailed })).toBeUndefined()
  await ui.unmount()
})

test('a synthetic journal read-back failure retries an already saved line without a duplicate', async ($, on) => {
  const world: World = {
    files: new Map([[FILE, '## demo-1\n### Demo task\n- [?] Demo step\n']]),
    mtime: 1,
    hasTasks: true,
    store: { inboxDone: {} },
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo-1', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  world.afterJournalWrite = () => { world.unreadable = new Set([JOURNAL]) }
  await ui.press({ key: 'demo-1::Demo task::0::done' })
  const saved = world.files.get(JOURNAL)
  expect(saved).toContain(' · Demo step\n')
  expect(await ui.find({ type: 'Text', text: ZH_TW.journalFailed })).toBeDefined()
  expect(Object.keys(world.store?.[`pendingJournal:${SESSION}`] ?? {})).toEqual([JOURNAL])
  world.afterJournalWrite = undefined
  world.unreadable?.clear()
  await $.turn.start({ text: 'Continue demo', turnId: 'journal-read-back' })
  expect(world.files.get(JOURNAL)).toBe(saved)
  expect(world.store?.[`pendingJournal:${SESSION}`]).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: ZH_TW.journalFailed })).toBeUndefined()
  await ui.unmount()
})

test('a restored pending journal saves each line once in its original month', async ($, on) => {
  const previous = '/home/me/.claude/progress-journal-2026-09.md'
  const first = '- 2026-09-30 12:00 · demo-1 · Demo task · Earlier step'
  const second = '- 2026-10-01 12:00 · demo-1 · Demo task · Later step'
  const world: World = {
    files: new Map([[previous, `# Work log\r\n${first}\r\n`]]),
    mtime: 1,
    hasTasks: true,
    store: { inboxDone: {}, [`pendingJournal:${SESSION}`]: { [previous]: [first], [JOURNAL]: [second] } },
  }
  engineBeneath(on, world)
  await start($, 'Continue demo')
  expect(world.files.get(previous)).toBe(`# Work log\r\n${first}\r\n`)
  expect(world.files.get(JOURNAL)).toBe(`${ZH_TW.journalTitle}\n${second}\n`)
  expect(world.store?.[`pendingJournal:${SESSION}`]).toBeUndefined()
  await $.turn.start({ text: 'Continue demo again', turnId: 'journal-restored-again' })
  expect(world.files.get(JOURNAL)).toBe(`${ZH_TW.journalTitle}\n${second}\n`)
})

test('pane feedback lookup uses the card containing the button and rejects the shared answer box', () => {
  const card: PressNode = { type: 'Box', children: [{ type: 'Button', props: { key: 'mine::1::copy' } }] }
  const shared: PressNode = { type: 'Box', children: [{ type: 'Text', children: [EN.copied] }, { type: 'Button', props: { key: 'clear-answer' } }] }
  const other: PressNode = { type: 'Box', children: [{ type: 'Button', props: { key: 'mine::10::copy' } }, { type: 'Text', children: [EN.copied] }] }
  const nodes = [card, shared, other, { type: 'Box', children: [card, shared, other] }]
  expect(besideButton(nodes, 'mine::1::copy')).not.toContain(EN.copied)
  card.children = [...(card.children ?? []), { type: 'Box', children: [{ type: 'Text', children: [EN.copied] }] }]
  expect(besideButton(nodes, 'mine::1::copy')).toContain(EN.copied)
  expect(besideLabel([shared], EN.copied, EN.copied)).toBe(false)
})

test('copy resume command on a live other-session ask shows Copied, or the text to copy when the clipboard fails', async ($, on) => {
  const world: World = { files: new Map([[FILE, LIVE_PRESS]]), mtime: 1, hasTasks: true, store: { autoConnectOff: true } }
  engineBeneath(on, world)
  on('ui.status', () => ({ value: undefined }))
  let mode = 'copied'
  on('ui.copy', () => mode === 'reject' ? { deny: 'clipboard unavailable' } : mode === 'copied' ? { value: { isCopied: true as const } } : { value: { isCopied: false as const, reason: 'refused' as const } })
  on('ui.notify', () => ({ deny: 'notifications unavailable' }))
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  for (const one of ['copied', 'unavailable', 'reject']) {
    mode = one
    await ui.press({ key: `${LIVE_PRESS_KEY}::resume` })
    const result = besideButton(await ui.findAll({ type: 'Box' }), `${LIVE_PRESS_KEY}::resume`)
    expect(result).toContain(one === 'copied' ? ZH_TW.copied : ZH_TW.pressCopyFallback)
    if (one !== 'copied') expect((await ui.find({ type: 'Input', key: `${LIVE_PRESS_KEY}::copy-text` }))?.props.value).toBe('claude --resume a1b2c3d4-1111-2222-3333')
  }
  await ui.unmount()
})

test('already answered, hide on a live other-session ask hides it, or says why not', async ($, on) => {
  const world: World = { files: new Map([[FILE, LIVE_PRESS]]), mtime: 1, hasTasks: true, store: { autoConnectOff: true, opened: ['hidden'] } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  const saved = world.files.get(QUESTIONS)
  world.files.set(QUESTIONS, '{"version":999}')
  world.mtime += 1
  await ui.press({ key: `${LIVE_PRESS_KEY}::hide` })
  expect(besideButton(await ui.findAll({ type: 'Box' }), `${LIVE_PRESS_KEY}::hide`)).toContain(ZH_TW.pressLedgerFailed)
  world.files.set(QUESTIONS, saved ?? '')
  world.mtime += 1
  world.beforeRead = path => { if (path === FILE) throw new Error('synthetic read failure') }
  await ui.press({ key: `${LIVE_PRESS_KEY}::hide` })
  expect(besideButton(await ui.findAll({ type: 'Box' }), `${LIVE_PRESS_KEY}::hide`)).toContain(ZH_TW.pressProgressUnreadable)
  world.beforeRead = undefined
  await ui.press({ key: `${LIVE_PRESS_KEY}::hide` })
  expect(await ui.find({ type: 'Button', key: `${LIVE_PRESS_KEY}::hide` })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: ZH_TW.pressHidden })).toBeDefined()
  await ui.unmount()
})

test('a successful pane step keeps its feedback until the task changes', async ($, on) => {
  const world: World = { files: new Map([[FILE, '# Progress\n\n## Demo\n### Checklist\n- [ ] First step\n- [ ] Last step\n']]), mtime: 1, hasTasks: true, store: { autoConnectOff: true, opened: ['others'] } }
  const clock = engineBeneath(on, world)
  outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'Demo::Checklist' })
  await ui.press({ key: 'Demo::Checklist::tick' })
  expect(besideButton(await ui.findAll({ type: 'Box' }), 'Demo::Checklist::tick')).toContain(ZH_TW.boardTicked('First step'))
  world.files.set(FILE, (world.files.get(FILE) ?? '').replace('Last step', 'Changed next step'))
  world.mtime += 1
  await clock.advance(2100)
  expect(await ui.find({ type: 'Text', text: ZH_TW.boardTicked('First step') })).toBeUndefined()
  await ui.unmount()
})

test("a refusal caused by another agent's change stays next to the card after the redraw", async ($, on) => {
  const world: World = { files: new Map([[FILE, '# Progress\n\n## Demo\n### Checklist\n- [ ] First step\n- [ ] Last step\n']]), mtime: 1, hasTasks: true, store: { autoConnectOff: true, opened: ['others'] } }
  const clock = engineBeneath(on, world)
  outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'Demo::Checklist' })
  world.files.set(FILE, (world.files.get(FILE) ?? '').replace('First step', 'Changed by another agent'))
  world.mtime += 1
  await ui.press({ key: 'Demo::Checklist::tick' })
  expect(await ui.find({ type: 'Text', text: ZH_TW.boardTickGone })).toBeDefined()
  await clock.advance(2100)
  expect(besideButton(await ui.findAll({ type: 'Box' }), 'Demo::Checklist::tick')).toContain(ZH_TW.boardTickGone)
  await ui.unmount()
})

test("a second press elsewhere keeps the first card's pending result", async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, store: { autoConnectOff: true, opened: ['waiting'] } }
  const clock = engineBeneath(on, world)
  outside(on, world)
  let release: () => void = () => undefined
  let hasStarted = false
  let pressError: unknown
  const gate = new Promise<void>(done => { release = done })
  on('prompt.submit', async ($, event) => { hasStarted = true; await gate; return { text: event.text } })
  await start($, 'Pending matrix')
  await $.tool.call({ tool: 'TaskCreate', subject: 'First pending question', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', metadata: { waiting: 'you', ask: 'confirm', why: 'Synthetic pending result' } })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Run the second command', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', metadata: { waiting: 'you', ask: 'do', command: 'echo second', why: 'Synthetic independent card' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  const firstKey = `mine::1::${ZH_TW.yes}`
  await ui.press({ key: 'ask::mine::2' })
  const first = ui.press({ key: firstKey }).catch(error => { pressError = error })
  try {
    await clock.settle()
    expect(pressError).toBeUndefined()
    expect(hasStarted).toBe(true)
    await ui.press({ key: 'mine::2::copy' })
    expect(besideButton(await ui.findAll({ type: 'Box' }), firstKey)).toContain(ZH_TW.pressPending)
    expect(besideButton(await ui.findAll({ type: 'Box' }), 'mine::2::copy')).toContain(ZH_TW.copied)
  } finally {
    release()
    await first
    await ui.unmount()
  }
})

test('folding a question while its reply is sending keeps the pending result and its refusal', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, store: { autoConnectOff: true, opened: ['waiting'] } }
  const clock = engineBeneath(on, world)
  outside(on, world)
  let release: () => void = () => undefined
  const gate = new Promise<void>(done => { release = done })
  on('prompt.submit', async () => { await gate; return { drop: 'synthetic session gone' } })
  await start($, 'Pending fold')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Keep this result, OK?', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', metadata: { waiting: 'you', ask: 'confirm' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  const button = `mine::1::${ZH_TW.yes}`
  const sending = ui.press({ key: button })
  try {
    await clock.settle()
    await ui.press({ key: 'ask::mine::1' })
    expect(besideButton(await ui.findAll({ type: 'Box' }), button)).toContain(ZH_TW.pressPending)
    release()
    await sending
    expect(besideButton(await ui.findAll({ type: 'Box' }), button)).toContain(ZH_TW.pressSessionGone)
    await ui.press({ key: 'ask::mine::1' })
    expect(besideButton(await ui.findAll({ type: 'Box' }), button)).toContain(ZH_TW.pressSessionGone)
  } finally { release(); await sending; await ui.unmount() }
})

for (const one of ENGINE_MATRIX.filter(one => one.title === undefined)) test(`${one.isFailing ? FAILING_MATRIX_TITLE : NORMAL_MATRIX_TITLE} [${one.cell.name} / ${one.button}]`, { options: { language: 'en' } }, engineMatrixTest(one))

test('handing a task to this session shows its result next to its row', { options: { language: 'en' } }, namedEngineMatrixTest('handing a task to this session shows its result next to its row'))
test('completing a hand-kept row shows its result next to that row', { options: { language: 'en' } }, namedEngineMatrixTest('completing a hand-kept row shows its result next to that row'))
test('did it sends the answer from its own pane card', { options: { language: 'en' } }, namedEngineMatrixTest('did it sends the answer from its own pane card'))
test('no sends the answer from its own pane card', { options: { language: 'en' } }, namedEngineMatrixTest('no sends the answer from its own pane card'))
test('the second choice sends the answer from its own pane card', { options: { language: 'en' } }, namedEngineMatrixTest('the second choice sends the answer from its own pane card'))
test('needs changes opens the reply box on its own pane card', { options: { language: 'en' } }, namedEngineMatrixTest('needs changes opens the reply box on its own pane card'))

// Written out so the changelog check can find them; keep them equal to NORMAL_MATRIX_TITLE and FAILING_MATRIX_TITLE.
test('every button on every card kind from every agent, in this session or another, does its job or shows a reason', engineMatrixSummary(false))
test('every button still shows a reason when the engine refuses copy, writes or the session is gone', engineMatrixSummary(true))

test('pane press targets keep titles containing double colons separate', () => {
  const fixture = paneEngineFixture({ agent: 'claude', source: 'another-session', kind: 'hand-kept', name: 'Task' })
  const row = fixture.view.groups.flatMap(group => group.rows)[0]!
  const shorter = { ...row, key: 'Demo::Task', title: 'Task' }
  const longer = { ...row, key: 'Demo::Task::Part', title: 'Task::Part' }
  const view = { ...fixture.view, active: [shorter, longer] }
  expect(pressTarget(view, longer.key).key).toBe(longer.key)
  expect(pressTarget(view, `${longer.key}::tick`).key).toBe(longer.key)
  const askFixture = paneEngineFixture({ agent: 'claude', source: 'another-session', kind: 'needs-you', name: 'Question' })
  const ask = askFixture.view.waiting[0]!
  const shortAsk = { ...ask, key: 'Demo::Question::0' }
  const longAsk = { ...ask, key: 'Demo::Question::0::Part::0', task: 'Question::Part', options: ['std::vector', 'std::list'] }
  const asked = { ...askFixture.view, waiting: [shortAsk, longAsk] }
  expect(pressTarget(asked, `${longAsk.key}::hide`).key).toBe(longAsk.key)
  expect(pressTarget(asked, `ask::${longAsk.key}`).key).toBe(longAsk.key)
  expect(pressTarget(asked, `${longAsk.key}::std::list`)).toEqual({ key: longAsk.key, revision: JSON.stringify([longAsk.questionId, longAsk.text, longAsk.note]), label: 'Question::Part' })
  expect(pressTarget(view, `${longer.key}::std::list`).key).toBe(longer.key)
})

test('a choice answer containing double colons shows its result next to its own card', { options: { language: 'en' } }, async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, store: { autoConnectOff: true, lang: 'en' } }
  const clock = engineBeneath(on, world)
  on('prompt.submit', () => ({ drop: 'synthetic session refusal' }))
  await start($, 'Choose a container')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Container::type', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', metadata: { waiting: 'you', ask: 'choose', options: ['std::vector', 'std::list'], why: 'std::vector or std::list?' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    const key = 'mine::1::std::list'
    await ui.press({ key })
    expect(besideButton(await ui.findAll({ type: 'Box' }), key)).toContain(EN.pressSessionGone)
    await clock.advance(2100)
    expect(besideButton(await ui.findAll({ type: 'Box' }), key)).toContain(EN.pressSessionGone)
  } finally { await ui.unmount() }
})

test('two quick section presses whose first save fails leave the pane matching what was saved', { options: { language: 'en' } }, async ($, on) => {
  const world: World = { files: new Map(idleFiles('# Progress\n## Demo\n### Idle task\n- [ ] Keep the idle task\n', '## Demo\n### Idle task\n- [ ] Keep the idle task\n')), mtime: 1, hasTasks: true, store: { autoConnectOff: true, opened: [] } }
  engineBeneath(on, world)
  await start($, 'Save sections in order')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Current step', description: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  let release!: () => void
  let reached!: () => void
  const saving = new Promise<void>(done => { reached = done })
  world.holdStore = { key: 'opened', reached, release: new Promise<void>(done => { release = done }) }
  let attempts = 0
  world.failStore = (operation, key) => operation === 'set' && key === 'opened' && ++attempts === 1
  try {
    const first = ui.press({ key: 'section::idle' })
    await saving
    expect(JSON.stringify(await ui.find({ type: 'Button', key: 'section::idle' }))).toContain('▸')
    expect(world.store!.opened).toEqual([])
    const second = ui.press({ key: 'section::steps' })
    release()
    await Promise.all([first, second])
    expect(world.store!.opened).toEqual(['steps'])
    for (const id of ['idle', 'steps']) {
      const isOpen = JSON.stringify(await ui.find({ type: 'Button', key: `section::${id}` })).includes('▾')
      expect(isOpen).toBe((world.store!.opened as string[]).includes(id))
    }
    const steps = await ui.find({ type: 'Button', key: 'section::steps' })
    expect(JSON.stringify(steps)).toContain('▾')
    expect(JSON.stringify(await ui.find({ type: 'Button', key: 'section::idle' }))).toContain('▸')
    // The first press's failure stays beside its own control, and only there: not under the steps toggle.
    expect(resultAfterControl(await ui.findAll({ type: 'Box' }), 'section::idle', EN.settingSaveFailed)).toBe(true)
    expect(await ui.findAll({ type: 'Text', text: EN.settingSaveFailed })).toHaveLength(1)
  } finally { release(); await ui.unmount() }
})

test('two quick notification presses whose first save fails leave the setting matching what was saved', { options: { language: 'en' } }, async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, store: { autoConnectOff: true } }
  engineBeneath(on, world)
  await start($, 'Save notifications in order')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  let release!: () => void
  let reached!: () => void
  const saving = new Promise<void>(done => { reached = done })
  world.holdStore = { key: 'notifyOff', reached, release: new Promise<void>(done => { release = done }) }
  let attempts = 0
  world.failStore = (operation, key) => operation === 'set' && key === 'notifyOff' && ++attempts === 1
  try {
    const first = ui.press({ key: 'notify' })
    await saving
    expect(JSON.stringify(await ui.find({ type: 'Button', key: 'notify' }))).toContain(EN.notifyOnButton)
    expect(world.store!.notifyOff).toBeUndefined()
    const second = ui.press({ key: 'notify' })
    release()
    await Promise.all([first, second])
    expect(world.store!.notifyOff).toBe(true)
    const isOff = JSON.stringify(await ui.find({ type: 'Button', key: 'notify' })).includes(EN.notifyOffButton)
    expect(isOff).toBe(world.store!.notifyOff === true)
  } finally { release(); await ui.unmount() }
})

test('a display control that saves after a failed try drops its old failure line', { options: { language: 'en' } }, async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, store: { autoConnectOff: true } }
  engineBeneath(on, world)
  await start($, 'Retry the setting')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    world.failStore = (operation, key) => operation === 'set' && key === 'notifyOff'
    await ui.press({ key: 'notify' })
    expect(resultAfterControl(await ui.findAll({ type: 'Box' }), 'notify', EN.settingSaveFailed)).toBe(true)
    world.failStore = undefined
    await ui.press({ key: 'notify' })
    expect(resultAfterControl(await ui.findAll({ type: 'Box' }), 'notify', EN.settingSaveFailed)).toBe(false)
    expect(await ui.find({ type: 'Text', text: EN.settingSaveFailed })).toBeUndefined()
    expect(world.store!.notifyOff).toBe(true)
  } finally { await ui.unmount() }
})

test('two quick presses of one section whose first save fails leave no failure line', { options: { language: 'en' } }, async ($, on) => {
  const world: World = { files: new Map(idleFiles('# Progress\n## Demo\n### Idle task\n- [ ] Keep the idle task\n', '## Demo\n### Idle task\n- [ ] Keep the idle task\n')), mtime: 1, hasTasks: true, store: { autoConnectOff: true, opened: [] } }
  engineBeneath(on, world)
  await start($, 'Retry one section')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  let release!: () => void
  let reached!: () => void
  const saving = new Promise<void>(done => { reached = done })
  world.holdStore = { key: 'opened', reached, release: new Promise<void>(done => { release = done }) }
  let attempts = 0
  world.failStore = (operation, key) => operation === 'set' && key === 'opened' && ++attempts === 1
  try {
    const first = ui.press({ key: 'section::idle' })
    await saving
    const second = ui.press({ key: 'section::idle' })
    release()
    await Promise.all([first, second])
    expect(world.store!.opened).toEqual(['idle'])
    expect(JSON.stringify(await ui.find({ type: 'Button', key: 'section::idle' }))).toContain('▾')
    expect(resultAfterControl(await ui.findAll({ type: 'Box' }), 'section::idle', EN.settingSaveFailed)).toBe(false)
    expect(await ui.find({ type: 'Text', text: EN.settingSaveFailed })).toBeUndefined()
  } finally { release(); await ui.unmount() }
})

test('a question fold that saves after a failed try drops its old failure line', { options: { language: 'en' } }, async ($, on) => {
  const fixture = paneEngineFixture({ agent: 'claude', source: 'this-session', kind: 'needs-you', name: 'Retry question fold' })
  const { world } = fixture
  world.store!.opened = ['waiting']
  engineBeneath(on, world)
  let isFailing = false
  on('state.set', ($, event, next) => event.plugin === 'agent-board' && event.key === 'expanded' && isFailing ? { deny: 'EIO' } : next(event))
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    const button = `ask::${fixture.target}`
    isFailing = true
    await ui.press({ key: button })
    expect(await ui.find({ type: 'Text', text: EN.settingSaveFailed })).toBeDefined()
    isFailing = false
    await ui.press({ key: button })
    expect(besideButton(await ui.findAll({ type: 'Box' }), button)).not.toContain(EN.settingSaveFailed)
    expect(await ui.find({ type: 'Text', text: EN.settingSaveFailed })).toBeUndefined()
  } finally { await ui.unmount() }
})

// The second question is not the focus, so its folded line is the only place for the reason.
test('a folded question whose fold fails says why right under its own line', { options: { language: 'en' } }, async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, store: { autoConnectOff: true, opened: ['waiting'] } }
  engineBeneath(on, world)
  let isFailing = false
  on('state.set', ($, event, next) => event.plugin === 'agent-board' && event.key === 'expanded' && isFailing ? { deny: 'EIO' } : next(event))
  await start($, 'Fold the second question')
  await $.tool.call({ tool: 'TaskCreate', subject: 'First question', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', metadata: { waiting: 'you', ask: 'confirm', why: 'Synthetic focus' } })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Second question', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', metadata: { waiting: 'you', ask: 'confirm', why: 'Synthetic folded row' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    isFailing = true
    await ui.press({ key: 'ask::mine::2' })
    expect(resultAfterControl(await ui.findAll({ type: 'Box' }), 'ask::mine::2', EN.settingSaveFailed)).toBe(true)
  } finally { await ui.unmount() }
})

test('a notification command whose save fails says the setting is unchanged', { options: { language: 'en' } }, async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, store: { autoConnectOff: true } }
  engineBeneath(on, world)
  await start($, 'Save notification command')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    world.failStore = (operation, key) => operation === 'set' && key === 'notifyOff'
    expect((await $.command.run({ ...TIDY, args: 'notify off' })).text).toBe(EN.settingSaveFailed)
    expect(world.store!.notifyOff).toBeUndefined()
    expect(JSON.stringify(await ui.find({ type: 'Button', key: 'notify' }))).toContain(EN.notifyOnButton)
    world.failStore = undefined
    expect((await $.command.run({ ...TIDY, args: 'notify off' })).text).toBe(EN.notifyOff)
    world.failStore = (operation, key) => operation === 'delete' && key === 'notifyOff'
    expect((await $.command.run({ ...TIDY, args: 'notify on' })).text).toBe(EN.settingSaveFailed)
    expect(world.store!.notifyOff).toBe(true)
    expect(JSON.stringify(await ui.find({ type: 'Button', key: 'notify' }))).toContain(EN.notifyOffButton)
  } finally { await ui.unmount() }
})

test('display failures keep their section names when the control disappears', () => {
  const view = buildView([], [], null, 0)
  for (const s of [EN, ZH_TW, ZH_CN]) {
    expect(pressTarget(view, 'section::hidden', s).label).toBe(s.hiddenCount(0))
    expect(pressTarget(view, 'section::idle', s).label).toBe(s.idleCount(0))
    expect(pressTarget(view, 'section::stopped', s).label).toBe(s.stoppedCount(0))
    expect(pressTarget({ ...view, current: { title: 'Current task' } as View['current'] }, 'section::steps', s).label).toBe('Current task')
    expect(pressTarget(view, 'section::waiting', s).label).toBe(s.sectionWaiting)
    expect(pressTarget(view, 'section::due', s).label).toBe(s.sectionDue)
    expect(pressTarget(view, 'section::recent', s).label).toBe(s.sectionRecent)
    expect(pressTarget(view, 'section::reminder', s).label).toBe(s.sectionQuestionReminders)
    expect(pressTarget(view, 'section::older', s).label).toBe(s.sectionOlderQuestions)
    expect(pressTarget(view, 'section::others', s).label).toBe(s.sectionActive)
    expect(pressTarget({ ...view, current: { title: 'Current task' } as View['current'] }, 'section::others', s).label).toBe(s.sectionOther)
    expect(pressTarget(view, 'focus::more', s).label).toBe(s.moreWaiting(0))
  }
})

test('a failed browser open names the actual page without its folder', { options: { language: 'en' } }, async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, store: { autoConnectOff: true }, browserExitCode: 1, env: { HOME: '/home/me', LANG: 'en_US.UTF-8', CLAUDE_PROGRESS_FILE: '/home/me/private/board.md' } }
  engineBeneath(on, world)
  await start($, 'Open the board')
  world.env!.CLAUDE_PROGRESS_FILE = '/home/me/elsewhere/other.md'
  const result = await $.command.run({ ...TIDY, args: 'open' })
  expect(result.text).toBe(EN.windowFailed('board.html', 'board.md'))
  expect(result.text).not.toContain('/home/me')
})

test('opening the board page when it cannot be written says so instead of Opened', { options: { language: 'en' } }, async ($, on) => {
  const page = '/home/me/private/board.html'
  const ran: string[][] = []
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, store: { autoConnectOff: true }, ran, env: { HOME: '/home/me', LANG: 'en_US.UTF-8', CLAUDE_PROGRESS_FILE: '/home/me/private/board.md' } }
  engineBeneath(on, world)
  await start($, 'Write the board page')
  world.unwritable = new Set([page])
  ran.length = 0
  const failed = await $.command.run({ ...TIDY, args: 'open' })
  expect(failed.text).toContain('board.html')
  expect(failed.text).not.toContain(EN.windowOpened())
  expect(failed.text).not.toContain('/home/me')
  expect(failed.text).toBe(EN.boardStorageFailed(EN.fileNamed('board.html'), EN.storageReadOnly))
  expect(ran.some(argv => ['xdg-open', 'open', 'cmd'].includes(argv[0] ?? ''))).toBe(false)
  world.writeDeny = 'refused'
  const unknown = await $.command.run({ ...TIDY, args: 'open' })
  expect(unknown.text).toBe(EN.boardStorageFailed(EN.fileNamed('board.html'), EN.storageUnknown))
  expect(unknown.text).not.toContain('/home/me')
  expect(ran.some(argv => ['xdg-open', 'open', 'cmd'].includes(argv[0] ?? ''))).toBe(false)
  world.unwritable = undefined
  world.writeDeny = undefined
  expect((await $.command.run({ ...TIDY, args: 'open' })).text).toBe(EN.windowOpened())
  expect(ran.at(-1)).toEqual(['xdg-open', page])
})

test('an empty reply is answered in the alert colour', { options: { language: 'en' } }, async ($, on) => {
  const fixture = paneEngineFixture({ agent: 'claude', source: 'this-session', kind: 'needs-you', askKind: 'text', name: 'Empty reply' })
  engineBeneath(on, fixture.world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    await ui.input({ key: `${fixture.target}::reply`, text: '   ' })
    expect((await ui.find({ type: 'Text', text: EN.pressEmpty }))?.props).toMatchObject({ color: paletteFor('dark').alert })
    expect(besideButton(await ui.findAll({ type: 'Box' }), `${fixture.target}::reply`, false)).toContain(EN.pressEmpty)
  } finally { await ui.unmount() }
})

test('a display control whose setting cannot be saved says so next to it and stays as it was', { timeoutMs: 5000, options: { language: 'en' } }, async ($, on) => {
  const fixture = paneEngineFixture({ agent: 'claude', source: 'this-session', kind: 'needs-you', name: 'Display settings' })
  const { world } = fixture
  world.store!.opened = ['waiting']
  world.files.set(FILE, world.files.get(FILE) + '\n## persona_framework\n### Another question\n- [?] Keep this too, OK?\n' +
    '<!-- auto session=55556666 agent=codex state=waiting updated=2026-10-16T11:59:00Z -->\n### Hidden question\n- [?] Hide this, OK?\n<!-- /auto session=55556666 -->\n' +
    '<!-- auto session=11112222 agent=codex state=ended updated=2026-10-16T11:59:00Z -->\n### Stopped display task\n- [ ] Stopped step\n<!-- /auto session=11112222 -->\n' +
    '### Idle display task\n- [ ] Keep the idle task\n')
  world.files.set(seenPath(FILE), idleFiles('', '## persona_framework\n### Idle display task\n- [ ] Keep the idle task\n')[1][1])
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    await ui.press({ key: 'ask::persona_framework::Hidden question::0' })
    await ui.press({ key: 'persona_framework::Hidden question::0::hide' })
    await ui.press({ key: 'section::waiting' })
    const controls = async () => JSON.stringify(await ui.findAll({ type: 'Button' }))
    for (const button of ['focus::more', 'section::idle', 'section::steps', 'section::hidden', 'section::stopped', 'section::others', 'count::waiting', 'count::others', 'count::due', 'count::recent', 'notify']) {
      const key = button === 'notify' ? 'notifyOff' : 'opened'
      for (const isChanged of [false, true]) {
        const control = isChanged && button === 'focus::more' ? 'section::waiting' : button
        expect(await ui.find({ type: 'Button', key: control })).toBeDefined()
        const before = await controls()
        const saved = JSON.stringify(world.store![key])
        world.failStore = (operation, candidate) => operation === (isChanged && button === 'notify' ? 'delete' : 'set') && candidate === key
        await ui.press({ key: control })
        expect(resultAfterControl(await ui.findAll({ type: 'Box' }), control, EN.settingSaveFailed)).toBe(true)
        expect(await controls()).toBe(before)
        expect(JSON.stringify(world.store![key])).toBe(saved)
        world.failStore = undefined
        await ui.press({ key: control })
        expect(resultAfterControl(await ui.findAll({ type: 'Box' }), control, EN.settingSaveFailed)).toBe(false)
        if (!button.startsWith('count::')) expect(await controls()).not.toBe(before)
        expect(JSON.stringify(world.store![key])).not.toBe(saved)
      }
    }
    const before = await controls()
    await ui.press({ key: 'legend' })
    expect(await controls()).not.toBe(before)
    await ui.press({ key: 'legend' })
    expect(await controls()).toBe(before)
  } finally { await ui.unmount() }
})

test('enter in the report copy box keeps the warning under the report controls', { options: { language: 'en' } }, async ($, on) => {
  const world: World = { files: new Map([[FILE, '# Progress\n']]), mtime: 1, hasTasks: true, store: { autoConnectOff: true, lang: 'en' } }
  engineBeneath(on, world)
  on('ui.copy', () => ({ deny: 'synthetic clipboard refusal' }))
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    await ui.press({ key: 'report' })
    const value = (await ui.find({ type: 'Input', key: 'report::copy-text' }))?.props.value as string
    expect(value.length > 0).toBe(true)
    expect(resultAfterControl(await ui.findAll({ type: 'Box' }), 'report', EN.pressCopyFallback)).toBe(true)
    await ui.input({ key: 'report::copy-text', text: value })
    expect(resultAfterControl(await ui.findAll({ type: 'Box' }), 'report', EN.pressCopyFallback)).toBe(true)
    expect((await ui.find({ type: 'Input', key: 'report::copy-text' }))?.props.value).toBe(value)
    expect(resultAfterControl(await ui.findAll({ type: 'Box' }), 'report', value)).toBe(false)
    expect(await ui.findAll({ type: 'Text', text: value })).toHaveLength(1)
  } finally { await ui.unmount() }
})

test('shared pane controls show their results before the next row', async ($, on) => {
  const world: World = { files: new Map([[FILE, '# Progress\n']]), mtime: 1, hasTasks: true, store: { autoConnectOff: true, lang: 'en' } }
  engineBeneath(on, world)
  outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  const followsControl = async (key: string, text: string): Promise<boolean> => (await ui.findAll({ type: 'Box' }) as PressNode[]).some(node => {
    const children = pressChildren(node).filter((child): child is PressNode => typeof child !== 'string')
    const at = children.findIndex(child => pressNodes(child).some(one => (one.type === 'Button' || one.type === 'Input') && (one.key ?? one.props?.key) === key))
    return at >= 0 && children[at + 1] !== undefined && pressTexts(children[at + 1]!).includes(text)
  })
  try {
    await ui.input({ key: 'ask', text: '' })
    expect(await followsControl('ask', EN.pressEmpty)).toBe(true)
    await ui.press({ key: 'report' })
    expect(await followsControl('report', EN.copied)).toBe(true)
    await ui.press({ key: 'clear-answer' })
    const boxes = await ui.findAll({ type: 'Box' }) as PressNode[]
    const parent = boxes.find(node => pressChildren(node).some(child => typeof child !== 'string' && pressNodes(child).some(one => one.type === 'Button' && (one.key ?? one.props?.key) === 'report'))
      && pressChildren(node).some(child => typeof child !== 'string' && pressTexts(child).includes(EN.pressDone)))
    expect(parent).toBeDefined()
    const children = pressChildren(parent!).filter((child): child is PressNode => typeof child !== 'string')
    const resultAt = children.findIndex(child => pressTexts(child).includes(EN.pressDone))
    const reportAt = children.findIndex(child => pressNodes(child).some(one => one.type === 'Button' && (one.key ?? one.props?.key) === 'report'))
    expect(resultAt < reportAt).toBe(true)
  } finally { await ui.unmount() }
})

test('every pane button shows a result or a reason next to its card when pressed', async ($, on) => {
  const world: World = { files: new Map([[FILE, '# Progress\n\n## persona_framework\n### Finished card\n- [x] Finished step\n']]), mtime: 1, hasTasks: true, store: { autoConnectOff: true, lang: 'en' } }
  engineBeneath(on, world)
  outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    for (const [key, expected] of [['report', EN.copied], ['clear-answer', EN.pressDone], ['archive', EN.tidyMoved(1)]] as const) {
      if (key === 'archive') await ui.press({ key: 'section::recent' })
      expect(await ui.find({ type: 'Button', key })).toBeDefined()
      await ui.press({ key })
      expect(await ui.find({ type: 'Text', text: expected })).toBeDefined()
    }
    for (const key of ['notify', 'legend']) {
      const before = JSON.stringify(await ui.findAll({ type: 'Text' })) + (await ui.find({ type: 'Button', key }))?.text
      await ui.press({ key })
      const after = JSON.stringify(await ui.findAll({ type: 'Text' })) + (await ui.find({ type: 'Button', key }))?.text
      expect(after).not.toBe(before)
    }
    await ui.input({ key: 'ask', text: '' })
    expect(await ui.find({ type: 'Text', text: EN.pressEmpty })).toBeDefined()
  } finally { await ui.unmount() }
})

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
  const seen = outside(on, world)
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
  const seen = outside(on, world)
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
  const seen = outside(on, world)
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

test('/progress with no surface that places panes replies with the board page instead of the host reason', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS], [LIVE_SCRIPT, installedBoard()]]), mtime: 1, hasTasks: true, ran: [], store: { autoConnectOff: true } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    await $.command.run({ ...TIDY, args: `lang ${lang}` })
    for (const reason of ['no-surface: no surface is attached ($.session.surfaces() is empty)', 'no attached surface places panes (desktop)']) {
      world.paneReason = reason
      const url = `http://127.0.0.1:34567/?t=${'a'.repeat(32)}`
      world.liveOutput = `${STRINGS[lang].serveAt(url)}\n`
      const result = await $.command.run({ ...TIDY, args: '' })
      const s = STRINGS[lang]
      expect(result.text).toBe(`${s.livePageOpened}\n<${url}>`)
      expect(result.text).not.toContain(reason)
      expect(result.text).not.toContain('surface')
    }
  }
  expect(world.ran?.filter(argv => argv.includes('--serve')).length).toBe(6)
  expect(world.ran?.some(argv => argv[0] === 'xdg-open')).toBe(false)
})

test('/progress keeps the host reason when the pane fails for another reason', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, ran: [], paneReason: 'placement unavailable', store: { autoConnectOff: true } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    await $.command.run({ ...TIDY, args: `lang ${lang}` })
    const result = await $.command.run({ ...TIDY, args: '' })
    expect(result.text).toBe(STRINGS[lang].paneNotOpened('placement unavailable'))
  }
  expect(world.ran?.some(argv => argv[0] === 'xdg-open')).toBe(false)
})

test('/progress opens the static board page when the live page cannot start, whether or not the browser opens', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS], [LIVE_SCRIPT, installedBoard()]]), mtime: 1, hasTasks: true, ran: [], paneReason: 'no attached surface places panes (desktop)', store: { autoConnectOff: true, lang: 'en' } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  expect(world.ran?.some(argv => argv[0] === 'xdg-open')).toBe(false)
  for (const exitCode of [0, 1]) {
    world.browserExitCode = exitCode
    // Force a fresh page from the file even when an earlier page was already written.
    const title = exitCode === 0 ? 'Demo task opened in the browser' : 'Demo task saved for manual opening'
    world.files.set(FILE, JOBS.replace('Google 暑期實習', title))
    world.mtime += 1
    const result = await $.command.run({ ...TIDY, args: '' })
    expect(world.files.get('/home/me/.claude/progress.html')).toContain(title)
    expect(world.ran?.at(-1)).toEqual(['xdg-open', '/home/me/.claude/progress.html'])
    expect(result.text).toBe(`${EN.livePageFallback}\n${exitCode === 0 ? EN.windowOpened() : EN.windowFailed('progress.html', 'progress.md')}`)
  }
  expect(world.ran?.filter(argv => argv.includes('--serve')).length).toBe(2)
})

test('/progress starts the live board page when the pane cannot be placed and replies with its link', async ($, on) => {
  const url = `http://127.0.0.1:34567/?t=${'b'.repeat(32)}`
  const progress = '/work/demo folder/board $sample.md'
  const script = '/work/demo folder/agent-board.mjs'
  const world: World = { files: new Map([[progress, JOBS], [script, installedBoard(progress)]]), mtime: 1, hasTasks: true, ran: [], liveCalls: [], paneReason: 'no attached surface places panes (desktop)', env: { HOME: '/home/me', CLAUDE_PROGRESS_FILE: progress }, store: { autoConnectOff: true } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  expect(world.liveCalls).toEqual([])
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    await $.command.run({ ...TIDY, args: `lang ${lang}` })
    world.liveOutput = `Synthetic board contents\n${STRINGS[lang].serveAt(url)}\n`
    const result = await $.command.run({ ...TIDY, args: '' })
    expect(result.text).toBe(`${STRINGS[lang].livePageOpened}\n<${url}>`)
    expect(result.text?.split('b'.repeat(32)).length).toBe(2)
    const call = world.liveCalls?.at(-1)
    expect(world.files.get(script)).toBe(installedBoard(progress))
    expect(call?.argv).toEqual(['node', script, '--serve', '--no-open', '--quiet-board', '--idle-minutes', '30', '--lang', lang])
    expect(call?.init).toEqual({ timeoutMs: 35000 })
    expect(call?.argv).not.toContain(progress)
  }
  expect(world.ran?.some(argv => ['xdg-open', 'open', 'cmd'].includes(argv[0] ?? ''))).toBe(false)
})

test('/progress waits for a pending upgrade connection before its first live-page start', { options: { autoConnect: true } }, async ($, on) => {
  const old = `globalThis.AGENT_BOARD = ${JSON.stringify({ path: FILE, lang: 'en' })}\n${RELEASE_0_20_5.board}`
  const url = `http://127.0.0.1:34567/?t=${'u'.repeat(32)}`
  let reached!: () => void
  let release!: () => void
  const waiting = new Promise<void>(done => { reached = done })
  const held = new Promise<void>(done => { release = done })
  const world: World = { files: new Map([[FILE, JOBS], [LIVE_SCRIPT, old]]), mtime: 1, hasTasks: true, ran: [], liveCalls: [], workerGate: { reached, release: held }, paneReason: 'no attached surface places panes (desktop)', store: { inboxDone: {}, lang: 'en' }, liveOutput: `${EN.serveAt(url)}\n` }
  engineBeneath(on, world)
  outside(on, world)
  try {
    await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
    await waiting
    expect(world.files.get(LIVE_SCRIPT)).toBe(old)
    // The first command reads the old bytes while the existing worker resumes its upgrade.
    world.beforeRead = path => { if (path === LIVE_SCRIPT) release() }
    const result = await $.command.run({ ...TIDY, args: '' })
    expect(result.text).toBe(`${EN.livePageOpened}\n<${url}>`)
    expect(world.files.get(LIVE_SCRIPT)).toBe(installedBoard())
    expect(world.liveCalls).toHaveLength(1)
    expect(world.ran?.some(argv => ['xdg-open', 'open', 'cmd'].includes(argv[0] ?? ''))).toBe(false)
  } finally {
    release()
    await settledSetup($, world)
  }
})

test('/progress bounds a pending upgrade connection and uses the read-only fallback', { options: { autoConnect: true } }, async ($, on) => {
  const old = `globalThis.AGENT_BOARD = ${JSON.stringify({ path: FILE, lang: 'en' })}\n${RELEASE_0_20_5.board}`
  const url = `http://127.0.0.1:34567/?t=${'v'.repeat(32)}`
  let reached!: () => void
  let release!: () => void
  let armed!: () => void
  const waiting = new Promise<void>(done => { reached = done })
  const held = new Promise<void>(done => { release = done })
  const timer = new Promise<void>(done => { armed = done })
  const world: World = { files: new Map([[FILE, JOBS], [LIVE_SCRIPT, old]]), mtime: 1, hasTasks: true, ran: [], liveCalls: [], workerGate: { reached, release: held }, paneReason: 'no attached surface places panes (desktop)', store: { inboxDone: {}, lang: 'en' }, liveOutput: `${EN.serveAt(url)}\n` }
  let isObserving = false
  // The clock call stays pending until it fires; observe the original mock's registration.
  const clockOn = ((...args: Parameters<On>) => {
    const callback = args.at(-1)
    if (args[0] !== 'clock.after' || typeof callback !== 'function') return Reflect.apply(on, undefined, args)
    return on('clock.after', ($, event, next) => {
      const result = Reflect.apply(callback, undefined, [$, event, next])
      if (isObserving && event.ms === 5000) armed()
      return result
    })
  }) as On
  const clock = engineBeneath(clockOn, world)
  outside(on, world)
  try {
    await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
    await waiting
    isObserving = true
    const opening = $.command.run({ ...TIDY, args: '' })
    expect(await Promise.race([timer.then(() => true), opening.then(() => false)])).toBe(true)
    await clock.advance(5000)
    const result = await opening
    expect(result.text).toBe(`${EN.livePageFallback}\n${EN.livePageNeedsInstall}\n${EN.windowOpened()}`)
    expect(world.files.get(LIVE_SCRIPT)).toBe(old)
    expect(world.liveCalls).toEqual([])
    release()
    await settledSetup($, world)
    expect((await $.command.run({ ...TIDY, args: '' })).text).toBe(`${EN.livePageOpened}\n<${url}>`)
  } finally {
    release()
    await settledSetup($, world)
  }
})

test('/progress in print mode saves the read-only page without opening a browser', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, ran: [], hasNoSurface: true, paneReason: 'no-surface: no surface is attached ($.session.surfaces() is empty)', env: { HOME: '/home/me', OS: 'Windows_NT' }, store: { inboxDone: {}, autoConnectOff: true, lang: 'en' } }
  engineBeneath(on, world)
  outside(on, world)
  await $.session.start({ cwd: '/work/demo', surface: null, isInteractive: false })
  await settledSetup($, world)
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    await $.command.run({ ...TIDY, args: `lang ${lang}` })
    for (const isInstalled of [false, true]) {
      world.files.delete(LIVE_SCRIPT)
      if (isInstalled) world.files.set(LIVE_SCRIPT, installedBoard())
      world.liveFailure = isInstalled ? 'exit' : undefined
      for (const args of ['', 'open']) {
        const before = world.ran?.length ?? 0
        const result = await $.command.run({ ...TIDY, args })
        expect(world.ran?.slice(before).some(argv => ['xdg-open', 'open', 'cmd'].includes(argv[0] ?? ''))).toBe(false)
        expect(result.text).toContain('progress.html')
        expect(world.files.get('/home/me/.claude/progress.html')).toContain('<!doctype html>')
      }
    }
  }
})

test('/progress reuses a running live page and does not start a second one', async ($, on) => {
  const url = `http://127.0.0.1:34567/?t=${'c'.repeat(32)}`
  const world: World = { files: new Map([[FILE, JOBS], [LIVE_SCRIPT, installedBoard()]]), mtime: 1, hasTasks: true, ran: [], written: [], liveCalls: [], paneReason: 'no attached surface places panes (desktop)', store: { autoConnectOff: true, lang: 'en' }, liveOutput: `${EN.serveAt(url)}\n` }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await world.setupDone
  const first = await $.command.run({ ...TIDY, args: '' })
  const ranBefore = world.ran?.length ?? 0
  const writtenBefore = world.written?.length ?? 0
  // A page the person started with plain --serve is reused; the note that it keeps its own idle
  // setting is not part of the reply.
  world.liveOutput = `${EN.serveIdle}\n${EN.serveAt(url)}\n`
  const again = await $.command.run({ ...TIDY, args: '' })
  expect(again.text).toBe(first.text)
  expect(again.text).toBe(`${EN.livePageOpened}\n<${url}>`)
  // Both requests go through the CLI's existing reuse check, never straight to a child.
  expect(world.ran?.filter(argv => argv.includes('--serve')).length).toBe(2)
  const argv = ['node', LIVE_SCRIPT, '--serve', '--no-open', '--quiet-board', '--idle-minutes', '30', '--lang', 'en']
  expect(world.liveCalls?.map(call => call.argv)).toEqual([argv, argv])
  expect(world.ran?.slice(ranBefore)).toEqual([argv])
  expect(world.written?.slice(writtenBefore).filter(path => path.endsWith('.mjs'))).toEqual([])
})

test('/progress falls back to the read-only page when the live page cannot start', async ($, on) => {
  const url = `http://127.0.0.1:34567/?t=${'d'.repeat(32)}`
  const world: World = { files: new Map([[FILE, JOBS], [LIVE_SCRIPT, installedBoard()]]), mtime: 1, hasTasks: true, ran: [], paneReason: 'no attached surface places panes (desktop)', store: { autoConnectOff: true } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await world.setupDone
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    await $.command.run({ ...TIDY, args: `lang ${lang}` })
    for (const failure of ['exit', 'timeout', 'truncated', 'empty'] as const) {
      world.liveFailure = failure === 'exit' || failure === 'timeout' || failure === 'truncated' ? failure : undefined
      world.liveOutput = failure === 'empty' ? '' : `${STRINGS[lang].serveAt(url)}\n`
      const before = world.ran?.filter(argv => argv.includes('--serve')).length ?? 0
      const result = await $.command.run({ ...TIDY, args: '' })
      const s = STRINGS[lang]
      expect(result.text).toBe(`${s.livePageFallback}\n${s.windowOpened()}`)
      expect(result.text).not.toContain('SYNTHETIC_STARTUP_DETAIL')
      expect(result.text).not.toContain('BOOTSTRAP_FAILED')
      expect(result.text).not.toContain(url)
      expect(world.ran?.at(-1)).toEqual(['xdg-open', '/home/me/.claude/progress.html'])
      expect(world.files.get('/home/me/.claude/progress.html')).toContain('<!doctype html>')
      expect(world.ran?.filter(argv => argv.includes('--serve')).length).toBe(before + 1)
    }
  }
})

test('/progress runs the installed board script only when it is the same version as the plugin', async ($, on) => {
  const url = `http://127.0.0.1:34567/?t=${'f'.repeat(32)}`
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, ran: [], liveCalls: [], unreadable: new Set(), paneReason: 'no attached surface places panes (desktop)', store: { autoConnectOff: true }, liveOutput: '' }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await world.setupDone
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    await $.command.run({ ...TIDY, args: `lang ${lang}` })
    const s = STRINGS[lang]
    for (const version of ['missing', 'other', 'unreadable', 'same'] as const) {
      world.files.delete(LIVE_SCRIPT)
      world.unreadable?.clear()
      if (version !== 'missing') world.files.set(LIVE_SCRIPT, version === 'other' ? installedBoard() + '\n// another version' : installedBoard())
      if (version === 'unreadable') world.unreadable?.add(LIVE_SCRIPT)
      world.liveOutput = `${s.serveAt(url)}\n`
      const before = world.liveCalls?.length ?? 0
      const result = await $.command.run({ ...TIDY, args: '' })
      if (version === 'same') {
        expect(world.liveCalls?.length).toBe(before + 1)
        expect(world.liveCalls?.at(-1)?.argv[1]).toBe(LIVE_SCRIPT)
        expect(result.text).toBe(`${s.livePageOpened}\n<${url}>`)
      } else {
        expect(world.liveCalls?.length).toBe(before)
        expect(result.text).toBe(`${s.livePageFallback}\n${s.livePageNeedsInstall}\n${s.windowOpened()}`)
      }
    }
  }
})

test('/progress refuses an installed board script whose first line was changed', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, ran: [], liveCalls: [], paneReason: 'no attached surface places panes (desktop)', store: { autoConnectOff: true, lang: 'en' } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await world.setupDone
  const installed = installedBoard()
  const newline = installed.indexOf('\n')
  for (const changed of [
    `${installed.slice(0, newline)}; import("node:os")${installed.slice(newline)}`,
    installed.slice(newline + 1),
    installedBoard('/other/progress.md'),
  ]) {
    world.files.set(LIVE_SCRIPT, changed)
    const result = await $.command.run({ ...TIDY, args: '' })
    expect(world.liveCalls).toEqual([])
    expect(world.ran?.some(argv => argv.includes('--serve'))).toBe(false)
    expect(result.text).toBe(`${EN.livePageFallback}\n${EN.livePageNeedsInstall}\n${EN.windowOpened()}`)
  }
})

test('/progress passes no environment to the board script and asks it for a quiet start', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS], [LIVE_SCRIPT, installedBoard()]]), mtime: 1, hasTasks: true, ran: [], liveCalls: [], paneReason: 'no attached surface places panes (desktop)', store: { autoConnectOff: true } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    await $.command.run({ ...TIDY, args: `lang ${lang}` })
    await $.command.run({ ...TIDY, args: '' })
    const call = world.liveCalls?.at(-1)
    expect(call?.argv).toEqual(['node', LIVE_SCRIPT, '--serve', '--no-open', '--quiet-board', '--idle-minutes', '30', '--lang', lang])
    expect(call?.init).toEqual({ timeoutMs: 35000 })
  }
})

test('/progress keeps the board page note in its reply when the page waits for a reply', async ($, on) => {
  const url = `http://127.0.0.1:34567/?t=${'k'.repeat(32)}`
  const world: World = { files: new Map([[FILE, JOBS], [LIVE_SCRIPT, installedBoard()]]), mtime: 1, hasTasks: true, ran: [], liveCalls: [], paneReason: 'no attached surface places panes (desktop)', store: { autoConnectOff: true } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    const s = STRINGS[lang]
    await $.command.run({ ...TIDY, args: `lang ${lang}` })
    world.liveOutput = `\n${s.serveKept}\n${s.serveAt(url)}\n`
    const result = await $.command.run({ ...TIDY, args: '' })
    expect(result.text).toBe(`${s.livePageOpened}\n<${url}>\n${s.serveKept}`)
  }
})

test('the footer says the board page is starting while /progress waits for it', async ($, on) => {
  const url = `http://127.0.0.1:34567/?t=${'s'.repeat(32)}`
  const world: World = { files: new Map([[FILE, JOBS], [LIVE_SCRIPT, installedBoard()]]), mtime: 1, hasTasks: true, ran: [], liveCalls: [], paneReason: 'no attached surface places panes (desktop)', store: { autoConnectOff: true, closedByPerson: true } }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    const s = STRINGS[lang]
    await $.command.run({ ...TIDY, args: `lang ${lang}` })
    world.liveOutput = `${s.serveAt(url)}\n`
    let release = (): void => undefined
    const reached = new Promise<void>(done => {
      world.liveHold = { reached: done, release: new Promise<void>(go => { release = go }) }
    })
    const running = $.command.run({ ...TIDY, args: '' })
    await reached
    expect(seen.status.at(-1)).toContain(s.livePageStarting)
    expect(seen.status.at(-1)).not.toContain(s.statusBoardPage)
    release()
    expect((await running).text).toBe(`${s.livePageOpened}\n<${url}>`)
    expect(seen.status.at(-1)).toContain(s.statusBoardPage)
    expect(seen.status.at(-1)).not.toContain(s.livePageStarting)
  }
})

test('/progress accepts only a local board page address from the board script', async ($, on) => {
  const token = 'e'.repeat(32)
  const local = `http://127.0.0.1:34567/?t=${token}`
  const world: World = { files: new Map([[FILE, JOBS], [LIVE_SCRIPT, installedBoard()]]), mtime: 1, hasTasks: true, ran: [], paneReason: 'no attached surface places panes (desktop)', store: { autoConnectOff: true, lang: 'en' } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  for (const address of [
    `http://example.invalid:34567/?t=${token}`,
    `http://127.0.0.1.example.invalid:34567/?t=${token}`,
    `http://127.0.0.1@example.invalid:34567/?t=${token}`,
    `https://127.0.0.1:34567/?t=${token}`,
    `http://127.0.0.1:0/?t=${token}`,
    `http://127.0.0.1:65536/?t=${token}`,
    `http://127.0.0.1:034567/?t=${token}`,
    `${local}&extra=yes`, `${local}#fragment`, `${local}/extra`,
    'http://127.0.0.1:34567/?t=',
    `${local}%0a`,
  ]) {
    world.liveOutput = `${EN.serveAt(address)}\n`
    const result = await $.command.run({ ...TIDY, args: '' })
    expect(result.text).toBe(`${EN.livePageFallback}\n${EN.windowOpened()}`)
    expect(result.text).not.toContain(token)
  }
  for (const output of [`${local}\n`, `${EN.serveAt(local)}\nStartup failed\n`, `Task text ${local}\n`]) {
    world.liveOutput = output
    expect((await $.command.run({ ...TIDY, args: '' })).text).toContain(EN.livePageFallback)
  }
})

test('the footer status names /progress when no surface places panes', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, hasNoSurface: true, paneReason: 'no-surface: no surface is attached ($.session.surfaces() is empty)', store: { autoConnectOff: true, lang: 'en' } }
  const clock = engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await clock.advance(10)
  expect(seen.status.at(-1)).toBe(EN.statusBoardPage)
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    await $.command.run({ ...TIDY, args: `lang ${lang}` })
    world.paneReason = 'no attached surface places panes (desktop)'
    await $.command.run({ ...TIDY, args: '' })
    expect(seen.status.at(-1)).toBe(STRINGS[lang].statusBoardPage)
    expect(seen.status.at(-1)).not.toContain('surface')
  }
  // From here the attached surface's own answer decides; the roster is not read again.
  const surfaceCalls = world.surfaceCalls
  world.files.set(FILE, JOBS)
  world.mtime += 1
  await clock.advance(2000)
  expect(seen.status.at(-1)).toContain(' · ')
  expect(seen.status.at(-1)).toContain(ZH_CN.statusBoardPage)
  expect(world.surfaceCalls).toBe(surfaceCalls)
})

test('the footer status names /progress at session start when no surface is attached, even with the pane closed by hand', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, hasNoSurface: true, store: { autoConnectOff: true, closedByPerson: true, lang: 'en' } }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  expect(seen.status.at(-1)).toBe(EN.statusBoardPage)
  expect(world.paneOpenCalls ?? 0).toBe(0)
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    await $.command.run({ ...TIDY, args: `lang ${lang}` })
    expect(seen.status.at(-1)).toBe(STRINGS[lang].statusBoardPage)
  }
  expect(world.paneOpenCalls ?? 0).toBe(0)
})

test('session start survives an engine without session surfaces and shows no board-page hint', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, hasBrokenSurfaces: true, paneReason: 'placement unavailable', store: { autoConnectOff: true, lang: 'en' } }
  const clock = engineBeneath(on, world)
  const seen = outside(on, world)
  const started = await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  expect(started.cwd).toBe('/work/demo')
  expect(world.paneOpenCalls).toBe(1)
  expect(seen.status.at(-1)).toBe(`${EN.statusPrefix} · ${EN.statusWaiting(1)}`)
})

test('a terminal that binds after session start clears the board-page hint', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, hasNoSurface: true, store: { autoConnectOff: true, closedByPerson: true, lang: 'en' } }
  const clock = engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  const normalStatus = `${EN.statusPrefix} · ${EN.statusWaiting(1)}`
  expect(seen.status.at(-1)).toBe(`${normalStatus} · ${EN.statusBoardPage}`)
  world.hasBrokenSurfaces = true
  await clock.advance(30000)
  expect(seen.status.at(-1)).toBe(`${normalStatus} · ${EN.statusBoardPage}`)
  world.hasBrokenSurfaces = false
  world.hasNoSurface = false
  await clock.advance(30000)
  expect(seen.status.at(-1)).toBe(normalStatus)
  expect(world.paneOpenCalls ?? 0).toBe(0)
  const surfaceCalls = world.surfaceCalls
  await clock.advance(30000)
  expect(world.surfaceCalls).toBe(surfaceCalls)
})

test('a terminal that binds after the pane found no surface at session start clears the board-page hint', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, hasNoSurface: true, paneReason: 'no-surface: no surface is attached ($.session.surfaces() is empty)', store: { autoConnectOff: true, lang: 'en' } }
  const clock = engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  expect(world.paneOpenCalls).toBe(1)
  const normalStatus = `${EN.statusPrefix} · ${EN.statusWaiting(1)}`
  expect(seen.status.at(-1)).toBe(`${normalStatus} · ${EN.statusBoardPage}`)
  world.hasNoSurface = false
  await clock.advance(30000)
  expect(seen.status.at(-1)).toBe(normalStatus)
})

test('the footer status is unchanged when the pane is placed', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, store: { autoConnectOff: true, closedByPerson: true, lang: 'en' } }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  expect(seen.status.at(-1)).toBe(`${EN.statusPrefix} · ${EN.statusWaiting(1)}`)
  const opened = await $.command.run({ ...TIDY, args: '' })
  expect(opened.text).toBe(EN.paneOpened(FILE))
  expect(seen.status.at(-1)).toBeUndefined()
  const surfaceCalls = world.surfaceCalls
  // A later successful placement clears a hint left by an unavailable pane.
  world.paneReason = 'no attached surface places panes (desktop)'
  await $.command.run({ ...TIDY, args: '' })
  expect(seen.status.at(-1)).toContain(EN.statusBoardPage)
  world.paneReason = undefined
  await $.command.run({ ...TIDY, args: '' })
  expect(seen.status.at(-1)).toBeUndefined()
  expect(world.surfaceCalls).toBe(surfaceCalls)
})

test('with a pane surface, /agent-board starts the live board page and leaves the pane open', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS], [LIVE_SCRIPT, installedBoard()]]), mtime: 1, hasTasks: true, ran: [], liveCalls: [], store: { autoConnectOff: true, lang: 'en' } }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    const url = `http://127.0.0.1:34567/?t=${lang.replace('-', '').padEnd(32, 'a')}`
    const s = STRINGS[lang]
    await $.command.run({ ...TIDY, args: `lang ${lang}` })
    world.liveOutput = `${s.serveAt(url)}\n`
    const paneOpenCalls = world.paneOpenCalls
    const status = seen.status.at(-1)
    const result = await $.command.run({ ...TIDY, command: 'agent-board', args: '' })
    expect(result.text).toBe(`${s.boardPageOpened}\n<${url}>`)
    expect(world.paneOpenCalls).toBe(paneOpenCalls)
    expect(seen.status.at(-1)).toBe(status)
    expect(world.liveCalls?.at(-1)).toEqual({
      argv: ['node', LIVE_SCRIPT, '--serve', '--no-open', '--quiet-board', '--idle-minutes', '30', '--lang', lang],
      init: { timeoutMs: 35000 },
    })
  }
  expect(world.ran?.some(argv => ['xdg-open', 'open', 'cmd'].includes(argv[0] ?? ''))).toBe(false)
})

test('with no pane surface, /agent-board replies with the live board page link and does not try to place the pane', async ($, on) => {
  const url = `http://127.0.0.1:34567/?t=${'n'.repeat(32)}`
  const world: World = { files: new Map([[FILE, JOBS], [LIVE_SCRIPT, installedBoard()]]), mtime: 1, hasTasks: true, hasNoSurface: true, paneReason: 'no-surface: no surface is attached ($.session.surfaces() is empty)', ran: [], liveCalls: [], liveOutput: `${EN.serveAt(url)}\n`, store: { autoConnectOff: true, closedByPerson: true, lang: 'en' } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  const result = await $.command.run({ ...TIDY, command: 'agent-board', args: '' })
  expect(result.text).toBe(`${EN.boardPageOpened}\n<${url}>`)
  expect(world.paneOpenCalls ?? 0).toBe(0)
})

test('/agent-board falls back to the read-only page when the live page cannot start', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS], [LIVE_SCRIPT, installedBoard()]]), mtime: 1, hasTasks: true, ran: [], liveCalls: [], liveFailure: 'exit', paneReason: 'no attached surface places panes (desktop)', store: { autoConnectOff: true, lang: 'en' } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  const board = await $.command.run({ ...TIDY, command: 'agent-board', args: '' })
  const progress = await $.command.run({ ...TIDY, args: '' })
  const expected = `${EN.livePageFallback}\n${EN.windowOpened()}`
  expect(board.text).toBe(expected)
  expect(progress.text).toBe(expected)
  expect(world.files.get('/home/me/.claude/progress.html')).toContain('<!doctype html>')
})

test('the footer status shows the waiting count and /agent-board when no surface is attached', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, hasNoSurface: true, store: { autoConnectOff: true, closedByPerson: true, lang: 'en' } }
  const clock = engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await clock.advance(10)
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    const s = STRINGS[lang]
    await $.command.run({ ...TIDY, args: `lang ${lang}` })
    const normalStatus = `${s.statusPrefix} · ${s.statusWaiting(1)}`
    expect(seen.status.at(-1)).toBe(`${normalStatus} · ${s.statusBoardPage}`)
    expect(seen.status.at(-1)).toContain('/agent-board')
    expect(seen.status.at(-1)).toContain(s.statusWaiting(1))
  }
})

test('the plugin registers /agent-board beside /progress', async ($, on) => {
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, registered: [], registeredDescriptions: [], store: { autoConnectOff: true, closedByPerson: true, lang: 'en' } }
  engineBeneath(on, world)
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    world.store!.lang = lang
    const before = world.registered?.length ?? 0
    await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
    expect(world.registered?.slice(before)).toEqual(['progress', 'agent-board'])
    expect(world.registeredDescriptions?.slice(before)).toEqual([
      STRINGS[lang].commandDescription,
      STRINGS[lang].liveBoardCommandDescription,
    ])
    expect(world.registeredDescriptions?.slice(before).every(description => description.length > 0)).toBe(true)
  }
})

test('a second press of continue before the first turn starts sends nothing', async ($, on) => {
  const fixture = paneEngineFixture({ agent: 'claude', source: 'this-session', kind: 'own-block', name: 'Pending continue' })
  const { world } = fixture
  const clock = engineBeneath(on, world)
  const submissions: string[] = []
  let release = (): void => undefined
  let reached = (): void => undefined
  const gate = new Promise<void>(done => { release = done })
  const started = new Promise<void>(done => { reached = done })
  on('prompt.submit', async ($, event) => {
    submissions.push(event.text)
    reached()
    await gate
    return { text: event.text }
  })
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  const first = ui.press({ key: 'continue' })
  let second: Promise<void> | undefined
  try {
    await started
    second = ui.press({ key: 'continue' })
    await clock.settle()
    expect(submissions).toEqual([EN.continueText])
    release()
    await Promise.all([first, second])
    expect(besideButton(await ui.findAll({ type: 'Box' }), 'continue')).toContain(EN.pressSent)
    await ui.press({ key: 'continue' })
    expect(submissions).toEqual([EN.continueText, EN.continueText])
    expect(besideButton(await ui.findAll({ type: 'Box' }), 'continue')).toContain(EN.pressSent)
  } finally {
    release()
    await first.catch(() => undefined)
    await second?.catch(() => undefined)
    await ui.unmount()
  }
})

test('a press of continue whose prompt was refused does not block the next press', async ($, on) => {
  const { world } = paneEngineFixture({ agent: 'claude', source: 'this-session', kind: 'own-block', name: 'Refused continue' })
  engineBeneath(on, world)
  const submissions: string[] = []
  on('prompt.submit', ($, event) => {
    submissions.push(event.text)
    return submissions.length === 1 ? { drop: 'synthetic session gone' } : { text: event.text }
  })
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    await ui.press({ key: 'continue' })
    expect(besideButton(await ui.findAll({ type: 'Box' }), 'continue')).toContain(EN.pressSessionGone)
    await ui.press({ key: 'continue' })
    expect(submissions).toEqual([EN.continueText, EN.continueText])
    expect(besideButton(await ui.findAll({ type: 'Box' }), 'continue')).toContain(EN.pressSent)
  } finally {
    await ui.unmount()
  }
})

test('with the pane closed, the line under the prompt carries the progress', async ($, on) => {
  // Closed by hand in an earlier session, so it does not open by itself.
  const world: World = { files: new Map([[FILE, JOBS]]), mtime: 1, hasTasks: true, store: { closedByPerson: true } }
  engineBeneath(on, world)
  const seen = outside(on, world)
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
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'section::stopped' })
  await ui.press({ key: 'FLOODABM::跑實驗' })
  expect(await ui.find({ type: 'Button', key: 'FLOODABM::跑實驗::take' })).toBeUndefined()
  await ui.press({ key: 'FLOODABM::跑實驗::resume' })
  expect(seen.copied).toEqual(["cd '/work/FLOODABM' && claude --resume dddddddd-2222-3333"])
  expect(await ui.find({ type: 'Text', text: '已複製到剪貼簿' })).toBeDefined()
  await ui.unmount()
})

test('question retention failure refuses explicit archive and preserves the original source', { options: { autoConnect: true } }, async ($, on) => {
  const board = '## demo\n### Plan\n- [?] Keep the complete question?\n- [ ] Finish\n'
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, unwritable: new Set([QUESTIONS]), store: { opened: ['others', 'waiting'] } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'demo::Plan' })
  await ui.press({ key: 'demo::Plan::archive' })
  expect(world.files.get(FILE)).toBe(board)
  expect(await ui.find({ type: 'Text', text: ZH_TW.questionRetentionFailed })).toBeDefined()
  await ui.unmount()
})

test('the pane keeps stopped tasks behind one toggle and shows their actions when opened', async ($, on) => {
  const board = '## persona_framework\n<!-- auto session=a1b2c3d4 agent=claude state=ended updated=2026-10-16T11:00:00Z resume=stopped-session-123 -->\n### Stopped plan\n- [ ] Finish\n<!-- /auto session=a1b2c3d4 -->'
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Button', key: 'persona_framework::Stopped plan' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'section::stopped', text: '▸ 1 項已停止' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'section::others' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: ZH_TW.empty })).toBeUndefined()
  await ui.press({ key: 'section::stopped' })
  expect(await ui.find({ type: 'Button', key: 'section::stopped', text: '▾ 1 項已停止' })).toBeDefined()
  await ui.press({ key: 'persona_framework::Stopped plan' })
  for (const action of ['resume', 'take', 'done', 'archive']) {
    expect(await ui.find({ type: 'Button', key: `persona_framework::Stopped plan::${action}` })).toBeDefined()
  }
  await ui.press({ key: 'section::stopped' })
  expect(await ui.find({ type: 'Button', key: 'persona_framework::Stopped plan' })).toBeUndefined()
  expect(world.files.get(FILE)).toBe(board)
  await ui.unmount()
})

test('a question from a stopped session shows on the Stopped shelf with Resolve', async ($, on) => {
  const board = '## persona_framework\n<!-- auto session=a1b2c3d4 agent=codex state=waiting updated=2026-10-15T23:00:00Z -->\n### Stopped plan\n- [?] Publish?\n- [?] Keep the docs?\n<!-- /auto session=a1b2c3d4 -->'
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Button', key: 'section::waiting' })).toBeUndefined()
  await ui.press({ key: 'section::stopped' })
  for (const index of [0, 1]) expect(await ui.find({ type: 'Button', key: `persona_framework::Stopped plan::${index}::resolve`, text: EN.resolveQuestion })).toBeDefined()
  expect(world.files.get(FILE)).toBe(board)
  await ui.unmount()
})

test("resolving a stopped session's question closes its ledger record and keeps the copy", async ($, on) => {
  const board = '## persona_framework\n<!-- auto session=a1b2c3d4 agent=codex state=ended updated=2026-10-16T11:00:00Z -->\n### Stopped plan\n- [?] Publish?\n- [?] Keep the docs?\n<!-- /auto session=a1b2c3d4 -->'
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['stopped'] } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  const before = JSON.parse(world.files.get(QUESTIONS)!)
  const record = before.records.find((row: { words: string }) => row.words === 'Publish?')
  await ui.press({ key: 'persona_framework::Stopped plan::0::resolve' })
  await clock.advance(2_000)
  const after = JSON.parse(world.files.get(QUESTIONS)!)
  expect(after.records.find((row: { id: string }) => row.id === record.id)?.isUnresolved).toBe(false)
  expect(after.records.find((row: { id: string }) => row.id === record.id)?.source).toEqual(record.source)
  expect(after.records.find((row: { words: string }) => row.words === 'Keep the docs?')?.isUnresolved).toBe(true)
  expect([...world.files].some(([path, text]) => path.includes('-questions-source-') && JSON.parse(text).disposition === 'resolved' && JSON.parse(text).record.id === record.id)).toBe(true)
  expect(world.files.get(FILE)).toBe(board)
  expect(await ui.find({ type: 'Button', key: 'persona_framework::Stopped plan::0::resolve' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: EN.resolveSucceeded })).toBeDefined()
  await ui.unmount()
})

test('a failed Resolve shows its reason under the pressed question', async ($, on) => {
  const board = '## persona_framework\n<!-- auto session=a1b2c3d4 agent=codex state=ended updated=2026-10-16T11:00:00Z -->\n### Stopped plan\n- [?] Publish?\n- [?] Keep the docs?\n<!-- /auto session=a1b2c3d4 -->'
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['stopped'] } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  world.failQuestionCapture = 'write'
  const key = 'persona_framework::Stopped plan::0'
  await ui.press({ key: `${key}::resolve` })
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: EN.resolveFailed })).toBeDefined()
  expect(beneathButton(await ui.drawn(), key, EN.resolveFailed)).toBe(true)
  expect(world.files.get(FILE)).toBe(board)
  await ui.unmount()
})

test('a question asked again after its resolved step was ticked counts under Waiting on you', async ($, on) => {
  const board = '## persona_framework\n<!-- auto session=a1b2c3d4 agent=codex state=ended updated=2026-10-16T11:00:00Z -->\n### Stopped plan\n- [?] Push to main, OK?\n<!-- /auto session=a1b2c3d4 -->'
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['stopped'] } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  const id = JSON.parse(world.files.get(QUESTIONS)!).records[0].id
  await ui.press({ key: 'persona_framework::Stopped plan::0::resolve' })
  await clock.advance(2000)
  world.files.set(FILE, board.replace('[?]', '[x]'))
  world.mtime += 1
  await clock.advance(2000)
  expect(world.files.get(questionProofPath(FILE, 'retired', sha256(id)))).toBeDefined()
  world.files.set(FILE, board.replace('state=ended', 'state=waiting').replace('11:00:00Z', '12:00:00Z'))
  world.mtime += 1
  await clock.advance(2000)
  const pane = await ui.drawn()
  expect(JSON.stringify(pane)).toContain('Push to main')
  expect(await ui.find({ type: 'Button', key: 'section::waiting' })).toBeDefined()
  const ledger = JSON.parse(world.files.get(QUESTIONS)!)
  expect(ledger.records.some((record: { id: string; words: string; isUnresolved: boolean }) => record.id !== id && record.words === 'Push to main, OK?' && record.isUnresolved)).toBe(true)
  await ui.unmount()
})

test('a resolved done question keeps its result beside the task after the task leaves the shelf', async ($, on) => {
  const board = '## persona_framework\n<!-- auto session=a1b2c3d4 agent=codex state=done updated=2026-10-15T11:00:00Z -->\n### Finished plan\n- [?] Publish?\n<!-- /auto session=a1b2c3d4 -->'
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['stopped'] } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'persona_framework::Finished plan::0::resolve' })
  await clock.advance(2000)
  expect(await ui.find({ type: 'Button', key: 'persona_framework::Finished plan', text: '▸ Finished plan' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: EN.resolveSucceeded })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'section::stopped', text: `▾ ${EN.stoppedCount(1)}` })).toBeDefined()
  await ui.press({ key: 'persona_framework::Finished plan' })
  expect(await ui.find({ type: 'Button', key: 'persona_framework::Finished plan::archive' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'persona_framework::Finished plan::0::resolve' })).toBeUndefined()
  expect(world.files.get(FILE)).toBe(board)
  await ui.unmount()
})

test('a changed question explains a refused Resolve beside its button', async ($, on) => {
  const board = '## persona_framework\n<!-- auto session=a1b2c3d4 agent=codex state=ended updated=2026-10-16T11:00:00Z -->\n### Stopped plan\n- [?] Publish?\n<!-- /auto session=a1b2c3d4 -->'
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['stopped'] } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  world.files.set(FILE, board.replace('Publish?', 'Choose a date?'))
  await ui.press({ key: 'persona_framework::Stopped plan::0::resolve' })
  await settledSetup($, world)
  expect(await ui.find({ type: 'Text', text: EN.resolveChanged })).toBeDefined()
  expect(beneathButton(await ui.drawn(), 'persona_framework::Stopped plan::0', EN.resolveChanged)).toBe(true)
  const ledger = JSON.parse(world.files.get(QUESTIONS)!)
  expect(ledger.records.some((record: { words: string; isUnresolved: boolean }) => record.words === 'Choose a date?' && record.isUnresolved)).toBe(true)
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: EN.resolveChanged })).toBeDefined()
  expect(beneathButton(await ui.drawn(), 'persona_framework::Stopped plan::0', EN.resolveChanged)).toBe(true)
  world.files.set(FILE, `${world.files.get(FILE)}\n## another-project\n### Unrelated task\n- [~] Continue\n`)
  await clock.advance(2000)
  expect(beneathButton(await ui.drawn(), 'persona_framework::Stopped plan::0', EN.resolveChanged)).toBe(true)
  await ui.unmount()
})

test('a resolve result line never shows under a different question', async ($, on) => {
  const board = '## persona_framework\n<!-- auto session=a1b2c3d4 agent=codex state=ended updated=2026-10-16T11:00:00Z -->\n### Stopped plan\n- [?] Publish?\n<!-- /auto session=a1b2c3d4 -->'
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['stopped'] } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  world.failQuestionCapture = 'write'
  const key = 'persona_framework::Stopped plan::0'
  await ui.press({ key: `${key}::resolve` })
  await clock.advance(2000)
  expect(beneathButton(await ui.drawn(), key, EN.resolveFailed)).toBe(true)
  world.failQuestionCapture = undefined
  world.files.set(FILE, board.replace('Publish?', 'Choose a date?').replaceAll('a1b2c3d4', '11223344'))
  await clock.advance(2000)
  expect(await ui.find({ type: 'Button', key: `${key}::resolve` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: EN.resolveFailed })).toBeUndefined()
  expect(beneathButton(await ui.drawn(), key, EN.resolveFailed)).toBe(false)
  await ui.unmount()
})

test('a saved resolution succeeds even when the question index cannot be replaced', async ($, on) => {
  const board = '## persona_framework\n<!-- auto session=a1b2c3d4 agent=codex state=ended updated=2026-10-16T11:00:00Z -->\n### Stopped plan\n- [?] Publish?\n<!-- /auto session=a1b2c3d4 -->'
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['stopped'] } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  const id = JSON.parse(world.files.get(QUESTIONS)!).records[0].id
  world.unwritable = new Set([QUESTIONS])
  await ui.press({ key: 'persona_framework::Stopped plan::0::resolve' })
  await clock.advance(2000)
  expect([...world.files].some(([path, text]) => path.includes('-questions-source-') && JSON.parse(text).disposition === 'resolved' && JSON.parse(text).record.id === id)).toBe(true)
  expect(await ui.find({ type: 'Text', text: EN.resolveSucceeded })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: EN.resolveFailed })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'persona_framework::Stopped plan::0::resolve' })).toBeUndefined()
  expect(world.files.get(FILE)).toBe(board)
  await ui.unmount()
})

test('a failed Resolve stays beside its question through unrelated report changes', async ($, on) => {
  const board = '## persona_framework\n<!-- auto session=a1b2c3d4 agent=codex state=ended updated=2026-10-16T11:00:00Z -->\n### Stopped plan\n- [?] Publish?\n<!-- /auto session=a1b2c3d4 -->'
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['stopped'] } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  world.failQuestionCapture = 'write'
  const key = 'persona_framework::Stopped plan::0'
  await ui.press({ key: `${key}::resolve` })
  await clock.advance(2000)
  expect(beneathButton(await ui.drawn(), key, EN.resolveFailed)).toBe(true)
  world.files.set(FILE, `${board}\n## Other\n### Another task\n- [~] Work\n`)
  world.mtime += 1
  await clock.advance(2000)
  expect(beneathButton(await ui.drawn(), key, EN.resolveFailed)).toBe(true)
  world.files.set(FILE, board.replace('Publish?', 'Choose a date?'))
  world.mtime += 1
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: EN.resolveFailed })).toBeUndefined()
  await ui.unmount()
})

test('Resolve feedback stays with the matching Done recently row when titles repeat', async ($, on) => {
  const block = (session: string, question: string) => `<!-- auto session=${session} agent=codex state=done updated=2026-10-16T11:00:00Z -->\n### Finished plan\n- [?] ${question}\n<!-- /auto session=${session} -->`
  const board = `## persona_framework\n${block('a1b2c3d4', 'Publish?')}\n${block('11223344', 'Keep the docs?')}`
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['recent'] } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  world.failQuestionCapture = 'write'
  const key = 'persona_framework::Finished plan#2::0'
  await ui.press({ key: `${key}::resolve` })
  await clock.advance(2000)
  expect(beneathButton(await ui.drawn(), key, EN.resolveFailed)).toBe(true)
  expect(JSON.stringify(await ui.drawn()).split(EN.resolveFailed).length - 1).toBe(1)
  expect(await ui.find({ type: 'Text', text: 'persona_framework · Finished plan#2' })).toBeUndefined()
  await ui.unmount()
})

test('a detached Resolve result names its project and task without the repeated-title key', async ($, on) => {
  const block = (session: string) => `<!-- auto session=${session} agent=codex state=ended updated=2026-10-16T11:00:00Z -->\n### Finished plan\n> due 2026-10-17\n- [?] Publish?\n- [ ] Finish\n<!-- /auto session=${session} -->`
  const board = `## persona_framework\n${block('a1b2c3d4')}\n${block('11223344')}`
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['stopped'] } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'persona_framework::Finished plan#2::0::resolve' })
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: EN.resolveSucceeded })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'persona_framework · Finished plan' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'persona_framework · Finished plan#2' })).toBeUndefined()
  await ui.unmount()
})

test('Resolve refuses a stopped question that a newer pending inbox turn makes live', async ($, on) => {
  const session = 'synthetic-woken-session'
  const id = blockId('codex', session)
  const board = `## persona_framework\n<!-- auto session=${id} agent=codex state=waiting updated=2026-10-15T23:00:00Z -->\n### Stopped plan\n- [?] Publish?\n<!-- /auto session=${id} -->`
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['stopped'] } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  world.files.set(`${INBOX}/codex-turn-1792152000-1.json`, JSON.stringify({ session_id: session, cwd: '/work/persona_framework', last_assistant_message: 'Publish?' }))
  world.mtimes![`${INBOX}/codex-turn-1792152000-1.json`] = Date.parse('2026-10-16T12:00:00Z')
  await clock.advance(1)
  await ui.press({ key: 'persona_framework::Stopped plan::0::resolve' })
  await settledSetup($, world)
  expect(await ui.find({ type: 'Text', text: EN.resolveChanged })).toBeDefined()
  expect(JSON.parse(world.files.get(QUESTIONS)!).records.some((record: { words: string; isUnresolved: boolean }) => record.words === 'Publish?' && record.isUnresolved)).toBe(true)
  expect([...world.files].some(([path, text]) => path.includes('-questions-source-') && JSON.parse(text).disposition === 'resolved')).toBe(false)
  await ui.unmount()
})

test('resolving the last question does not add a phantom stopped task when it moves to Due or Idle', async ($, on) => {
  // Blocks with no time are never aged out by the archive, which takes a stopped block that asks after three days; the seen record makes the idle one old.
  const block = (session: string, title: string, notes: string) => `<!-- auto session=${session} agent=codex state=ended -->\n### ${title}\n${notes}- [?] Publish?\n- [ ] Finish\n<!-- /auto session=${session} -->`
  const board = `## persona_framework\n${block('a1b2c3d4', 'Due plan', '> due 2026-10-17\n')}\n${block('11223344', 'Idle plan', '')}`
  const world: World = { files: new Map(idleFiles(board, board)), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['stopped'] } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Button', key: 'section::stopped', text: `▾ ${EN.stoppedCount(2)}` })).toBeDefined()
  await ui.press({ key: 'persona_framework::Due plan::0::resolve' })
  await clock.advance(2000)
  expect(await ui.find({ type: 'Button', key: 'section::stopped', text: `▾ ${EN.stoppedCount(1)}` })).toBeDefined()
  await ui.press({ key: 'persona_framework::Idle plan::0::resolve' })
  await clock.advance(2000)
  expect(await ui.find({ type: 'Button', key: 'section::stopped' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'section::due' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'section::idle' })).toBeDefined()
  expect(world.files.get(FILE)).toBe(board)
  await ui.unmount()
})

test('the pane shows one line for questions in stopped sessions under Waiting, and pressing it opens the Older list', async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00Z')
  const firstAt = at - 4 * 86400000
  const board = stoppedPaneBoard(2, at)
  const ledger = observeQuestions(emptyQuestions(), parseProgress(board), null, [], firstAt, true, 'fixture:stopped').ledger
  const world: World = { files: new Map([[FILE, board], [QUESTIONS, questionsJson(ledger)]]), mtime: 1, hasTasks: true, at, store: { lang: 'en', inboxDone: {} } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    expect(await ui.find({ type: 'Button', key: 'section::stoppedAsking', text: `▸ ${EN.stoppedAsking(2)}` })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'section::waiting' })).toBeUndefined()
    for (let index = 0; index < 2; index += 1) expect(await ui.find({ type: 'Button', key: `ask::older::Synthetic::Plan ${index}::0` })).toBeUndefined()
    await ui.press({ key: 'section::stoppedAsking' })
    expect(await ui.find({ type: 'Button', key: 'section::older', text: `▾ ${EN.sectionOlderQuestions}` })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'section::stoppedAsking', text: `▾ ${EN.stoppedAsking(2)}` })).toBeDefined()
    for (let index = 0; index < 2; index += 1) expect(await ui.find({ type: 'Button', key: `ask::older::Synthetic::Plan ${index}::0` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: relativeTime(firstAt, at, EN) })).toBeDefined()
    const view = buildView(parseProgress(board), [], null, at, 0, {}, EN, [], {}, ledger)
    expect(pressTarget(view, 'section::stoppedAsking', EN).label).toBe(EN.stoppedAsking(2))
    expect(world.files.get(FILE)).toBe(board)
  } finally {
    await ui.unmount()
  }
})

test('Older shows ten questions and a Show all button for the rest', async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00Z')
  const firstAt = at - 4 * 86400000
  const board = stoppedPaneBoard(OLDER_SHOWN, at)
  const ledger = observeQuestions(emptyQuestions(), parseProgress(board), null, [], firstAt, true, 'fixture:stopped').ledger
  const world: World = { files: new Map([[FILE, board], [QUESTIONS, questionsJson(ledger)]]), mtime: 1, hasTasks: true, at, store: { lang: 'en', inboxDone: {} } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    await ui.press({ key: 'section::stoppedAsking' })
    for (let index = 0; index < OLDER_SHOWN; index += 1) expect(await ui.find({ type: 'Button', key: `ask::older::Synthetic::Plan ${index}::0` })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'section::olderAll' })).toBeUndefined()
    const expanded = stoppedPaneBoard(12, at)
    const nextLedger = observeQuestions(ledger, parseProgress(expanded), null, [], firstAt, true, 'fixture:more').ledger
    world.files.set(FILE, expanded)
    world.files.set(QUESTIONS, questionsJson(nextLedger))
    world.mtime += 1
    await clock.advance(2000)
    for (let index = 0; index < 12; index += 1) {
      const question = await ui.find({ type: 'Button', key: `ask::older::Synthetic::Plan ${index}::0` })
      if (index < OLDER_SHOWN) expect(question).toBeDefined()
      else expect(question).toBeUndefined()
    }
    expect(await ui.find({ type: 'Button', key: 'section::olderAll', text: EN.showAllQuestions(12) })).toBeDefined()
    await ui.press({ key: 'section::olderAll' })
    for (let index = 0; index < 12; index += 1) expect(await ui.find({ type: 'Button', key: `ask::older::Synthetic::Plan ${index}::0` })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'section::olderAll' })).toBeUndefined()
  } finally {
    await ui.unmount()
  }
})

test('the pane hides idle tasks behind one toggle and shows them with their age when opened', async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00Z')
  const board = '## demo\n### Old plan\n- [?] Publish, OK?\n- [ ] Finish\n'
  const record = seenJson(withSeen({}, parseProgress(board), at - 9 * 24 * 60 * 60 * 1000))
  const ledger = observeQuestions(emptyQuestions(), parseProgress(board), null, [], at - 9 * 24 * 60 * 60 * 1000, true, 'fixture:1').ledger
  const world: World = { files: new Map([[FILE, board], [seenPath(FILE), record], [QUESTIONS, questionsJson(ledger)]]), mtime: 1, hasTasks: true }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Button', key: 'demo::Old plan' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'section::idle', text: '▸ 1 項超過 7 天沒動' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'section::waiting' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '● 0' })).toBeDefined()
  await ui.press({ key: 'section::idle' })
  expect(await ui.find({ type: 'Button', key: 'demo::Old plan' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /9 天前/ })).toBeDefined()
  await ui.press({ key: 'demo::Old plan' })
  expect(await ui.find({ type: 'Text', text: 'Publish, OK?' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'demo::Old plan::tick' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'demo::Old plan::archive' })).toBeDefined()
  await ui.press({ key: 'section::idle' })
  expect(world.files.get(FILE)).toBe(board)
  expect(world.files.get(seenPath(FILE))).toBe(seenJson(withSeen(parseSeen(record) ?? {}, parseProgress(board), at, {}, false, true)))
  await ui.unmount()
})

test('the pane records first observations once and keeps undated work visible when its record cannot be read or written', async ($, on) => {
  const board = '## demo\n### Fresh plan\n- [ ] Finish\n'
  const world: World = { files: new Map([[FILE, board]]), mtime: 1, hasTasks: true }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const record = world.files.get(seenPath(FILE))
  expect(record).toBeDefined()
  await clock.advance(5000)
  expect(world.files.get(seenPath(FILE))).toBe(record)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  world.files.set(seenPath(FILE), seenJson(withSeen({}, parseProgress(board), Date.parse('2026-10-16T12:00:00Z') - IDLE_MS - 1)))
  world.mtime += 1
  await clock.advance(5000)
  expect(await ui.find({ type: 'Button', key: 'section::idle' })).toBeDefined()
  // A record that turns unreadable (a lock or a permission change) has a new stat too.
  world.unreadable = new Set([seenPath(FILE)])
  world.mtime += 1
  await clock.advance(5000)
  expect(await ui.find({ type: 'Button', key: 'section::idle' })).toBeUndefined()
  world.unreadable = new Set()
  world.unwritable = new Set([seenPath(FILE)])
  await clock.advance(5000)
  expect(await ui.find({ type: 'Button', key: 'section::idle' })).toBeDefined()
  // A record that is read but cannot be written keeps the times it holds; a task it does not
  // know yet stays on the board.
  world.files.set(FILE, board + '### New plan\n- [ ] Finish\n')
  world.mtime += 1
  // One poll: the one that fails to write.
  await clock.advance(2000)
  expect(await ui.find({ type: 'Button', key: 'section::others' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'section::idle', text: '▸ 1 項超過 7 天沒動' })).toBeDefined()
  await clock.advance(70000)
  expect(await ui.find({ type: 'Button', key: 'section::others' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'section::idle' })).toBeDefined()
  await ui.unmount()
})

test("one empty read of progress.md does not reset a task's first-seen time", async ($, on) => {
  const board = '## demo\n### Old plan\n- [ ] Finish\n'
  const old = seenJson(withSeen({}, parseProgress(board), Date.parse('2026-10-16T12:00:00Z') - IDLE_MS - 1))
  const world: World = { files: new Map([[FILE, board], [seenPath(FILE), old]]), mtime: 1, hasTasks: true }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await settledSetup($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await clock.advance(5000)
  const armed = world.files.get(seenPath(FILE)) ?? ''
  const first = parseSeen(armed) ?? {}
  expect(first).toEqual({ ...parseSeen(old), [SWEEP_ARMED_KEY]: Date.parse('2026-10-16T12:00:00Z') })
  expect(await ui.find({ type: 'Button', key: 'section::idle' })).toBeDefined()
  // Another program empties the file before writing it again, and the pane reads it in between,
  // even for a whole poll.
  world.files.set(FILE, '')
  world.mtime += 1
  await clock.advance(5000)
  world.files.set(FILE, board)
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.get(seenPath(FILE))).toBe(armed)
  expect(await ui.find({ type: 'Button', key: 'section::idle' })).toBeDefined()
  // A task gone for good leaves the record once the file has held still.
  world.files.set(FILE, '## demo\n### New plan\n- [ ] Start\n')
  world.mtime += 1
  await clock.advance(5000)
  const kept = parseSeen(world.files.get(seenPath(FILE)) ?? '') ?? {}
  expect(Object.keys(kept)).toEqual(Object.keys(withSeen({}, parseProgress(world.files.get(FILE) ?? ''), 1, first, true, true)))
  expect(kept[SWEEP_ARMED_KEY]).toBe(first[SWEEP_ARMED_KEY])
  await ui.unmount()
})

test('a YAML escaped backslash before a folded line break stays a backslash', () => {
  const scalar = 'command: "powershell -File C:\\\\scratch\\\\\n      folder\\\\progress-report.ps1 hermes turn"'
  expect(connectDataRoots(scalar)).toContain('C:\\scratch\\ folder')
  expect(connectDataRoots(scalar)).not.toContain('C:\\scratchfolder')
  expect(connectDataRoots(scalar)).not.toContain('C:\\scratch\folder')
})

test('an unmatched quote in a plain YAML value does not hide a later escaped command', () => {
  const yaml = 'note: unmatched"quote\ncommand: "sh \'/scratch/Jos\\xE9/progress-report.sh\' hermes turn"'
  expect(connectDataRoots(yaml)).toContain('/scratch/José')
})

test('YAML named escapes decode every PyYAML character in path data', () => {
  for (const [escape, value] of Object.entries({ a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029' })) {
    expect(connectDataRoots(`command: "sh '/scratch/a\\${escape}b/progress-report.sh' hermes turn"`)).toContain(`/scratch/a${value}b`)
  }
})

test('a Claude print-mode session writes no block and leaves its existing block alone', async ($, on) => {
  const prior = `## Synthetic project
<!-- auto session=${SESSION.slice(0, 8)} agent=claude state=waiting updated=2026-10-27T12:00:00Z -->
### Existing work
- [ ] Preserve this block
<!-- /auto session=${SESSION.slice(0, 8)} -->
`
  const shared: Record<string, unknown> = { autoConnectOff: true }
  const world: World = { files: new Map([[FILE, prior]]), mtime: 1, hasTasks: true, shared }
  const clock = engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/demo', surface: null, isInteractive: false })
  await $.turn.start({ text: 'Synthetic review', turnId: 'print-turn' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Review synthetic work', description: '', metadata: { waiting: 'you', ask: 'review', why: 'Ready to review, OK?' } })
  await clock.advance(5000)
  expect(world.files.get(FILE)).toBe(prior)
  expect(JSON.parse(world.files.get(QUESTIONS) ?? '{"records":[]}').records).toEqual([])
  const mirror = shared[`mirror:${SESSION}`] as ProgressMirror
  expect(mirror.isRun).toBe(true)
  expect(mirror.tasks[0]?.waiting).toBe('you')
  const view = buildView(parseProgress(prior), [], mirror, Date.parse('2026-10-27T12:00:10Z'), 0, {}, ZH_TW, [], {}, emptyQuestions())
  expect(view.waiting).toEqual([])
  expect(view.overview.waiting).toBe(0)
  expect(seen.status.at(-1) ?? '').not.toContain(ZH_TW.statusWaiting(1))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Button', key: 'mine::1::沒問題' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '● 0' })).toBeDefined()
  await ui.unmount()
  world.files.set(FILE, '')
  world.mtime += 1
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await clock.advance(5000)
  expect(world.files.get(FILE)).toBe('')
  expect(JSON.parse(world.files.get(QUESTIONS) ?? '{"records":[]}').records).toEqual([])
})
