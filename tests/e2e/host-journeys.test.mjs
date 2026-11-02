import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { AGENT_ICONS } from '../../hooks/agent-icons.ts'
import { BOARD_SCRIPT } from '../../hooks/board-script.ts'
import { agents, apply, assertBlocks, assertRepeat, assertWaiting, assertWorking, board, cleanup, fixture, preview, questionOf, repeatApply, report, repoRoot, setup, snapshot, titleOf } from './lib/host-journey.mjs'

// Every agent the README lists, walked from setup to a card on the board in a synthetic home (#466).
after(cleanup)

let sourcePromise
const sources = () => sourcePromise ??= (async () => {
  const hooksUrl = pathToFileURL(join(repoRoot, 'hooks') + '/').href
  const loader = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(hooksUrl) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  } })
  try {
    const [look, mirror, blocks, strings] = await Promise.all([import('../../hooks/page-look.ts'), import('../../hooks/mirror.ts'), import('../../hooks/blocks.ts'), import('../../hooks/strings-en.ts')])
    return { ...look, ...mirror, ...blocks, ...strings }
  } finally { loader.deregister() }
})()

const claudeMirror = async (f, isWaiting) => {
  const { emptyMirror, applyTaskCreate, applyTaskUpdate } = await sources()
  const now = Date.now()
  let mirror = { ...emptyMirror('claude-session-0123456789', 'api-gateway', now, f.home), title: titleOf(''), state: 'working' }
  mirror = applyTaskCreate(mirror, { subject: 'Read the route table', activeForm: 'Reading the route table' }, '1', now)
  mirror = applyTaskUpdate(mirror, { taskId: '1', status: 'completed' }, now)
  mirror = applyTaskCreate(mirror, { subject: 'Compare the staging routes', activeForm: 'Comparing the staging routes' }, '2', now)
  mirror = applyTaskUpdate(mirror, { taskId: '2', status: 'in_progress' }, now)
  if (isWaiting) mirror = applyTaskCreate({ ...mirror, state: 'waiting' }, { subject: questionOf(''), metadata: { waiting: 'you', ask: 'confirm', why: 'Staging deploys need your go-ahead' } }, '3', now)
  return mirror
}

const writeClaude = async (f, isWaiting) => {
  const { upsertAutoBlock, EN } = await sources()
  const previous = existsSync(f.progress) ? readFileSync(f.progress, 'utf8') : ''
  writeFileSync(f.progress, upsertAutoBlock(previous, await claudeMirror(f, isWaiting), EN))
}

const listedAgents = () => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8').replaceAll('\r\n', '\n')
  const heading = readme.indexOf('### Open the board in your agent\n')
  assert.ok(heading >= 0)
  const lines = readme.slice(heading).split('\n')
  const start = lines.findIndex(line => line.startsWith('|'))
  const end = lines.findIndex((line, i) => i > start && !line.startsWith('|'))
  const names = lines.slice(start, end).filter(line => line.startsWith('| <img')).map(line => /alt="([^"]+)"/.exec(line)?.[1])
  assert.deepEqual(names, Object.keys(agents), 'README command table lists the ten agents in order')
  return names
}

const cache = new Map()
const journeyOf = name => {
  if (!cache.has(name)) cache.set(name, (async () => {
    const { id, sign } = agents[name]
    const f = fixture([sign])
    const icon = AGENT_ICONS.find(icon => icon.name === name)
    assert.ok(icon, `${name}: a brand mark exists`)
    const { agentMark } = await sources()
    assert.equal(agentMark(id), `<span class="ag ag-${icon.file}" aria-hidden="true"></span>`, `${name}: the card label uses its brand mark`)
    if (!id) {
      const before = snapshot(f.home)
      const guidance = [await setup(f), await setup(f, ['--apply']), await setup(f, ['--apply'])]
      for (const text of guidance) {
        assert.ok(text.trim().split(/\r?\n/).length >= 3)
        assert.ok(text.includes('claude plugin marketplace add WenyuChiou/agent-board'))
        assert.ok(text.includes('claude plugin install agent-board@agent-board'))
        assert.equal(text, guidance[0])
      }
      assert.deepEqual(readdirSync(f.home), ['.claude'])
      const after = snapshot(f.home)
      assert.deepEqual(after, before)
      // The plugin keeps the board script and the board file in Claude Code's own folder.
      f.script = join(f.home, '.claude', 'agent-board.mjs')
      f.progress = join(f.home, '.claude', 'progress.md')
      f.env = { ...f.env, CLAUDE_PROGRESS_FILE: f.progress }
      writeFileSync(f.script, BOARD_SCRIPT)
      await writeClaude(f, false)
      assertWorking(await board(f), '')
      await writeClaude(f, true)
      for (const args of [[], ['--chat']]) assertWaiting(await board(f, ...args), '')
      assertBlocks(f, ['claude'])
      return { guidance, before, after }
    }
    await preview(f, [id])
    await apply(f, [id])
    await report(f, id, 'working')
    assertWorking(await board(f), id)
    await report(f, id, 'waiting')
    for (const args of [[], ['--chat']]) assertWaiting(await board(f, ...args), id)
    assertBlocks(f, [id])
    return repeatApply(f)
  })())
  return cache.get(name)
}

test('each agent the README lists installs, reports a turn and shows its card in a synthetic home', async () => {
  for (const name of listedAgents()) await journeyOf(name)
})

test('a second setup apply reports no change for each listed agent', async () => {
  for (const name of listedAgents()) {
    const result = await journeyOf(name)
    if (agents[name].id) assertRepeat(result, [agents[name].id])
    else {
      assert.equal(result.guidance[2], result.guidance[0])
      assert.deepEqual(result.after, result.before)
    }
  }
})

test('a hook config that starts with a byte-order mark keeps its other entries through setup, a turn and a second apply', async () => {
  const configs = { codex: '.codex/hooks.json', cursor: '.cursor/hooks.json', grok: '.grok/hooks/agent-board-local.json', muse: '.config/muse/settings.json', antigravity: '.gemini/config/hooks.json', openclaw: '.openclaw/openclaw.json' }
  for (const [id, path] of Object.entries(configs)) {
    const f = fixture([Object.values(agents).find(agent => agent.id === id).sign])
    const seed = { other: { keep: true }, ...(['codex', 'cursor', 'grok', 'muse'].includes(id) ? { hooks: { ForeignEvent: [{ command: 'echo foreign' }] } } : id === 'openclaw' ? { plugins: { entries: { other: { enabled: true } } } } : {}) }
    const config = join(f.home, path)
    mkdirSync(dirname(config), { recursive: true })
    const original = Buffer.from(`\uFEFF${JSON.stringify(seed, null, 2).replaceAll('\n', '\r\n')}\r\n`)
    writeFileSync(config, original)
    await preview(f, [id])
    assert.deepEqual(readFileSync(config), original, `${id}: preview preserves BOM and CRLF bytes`)
    await apply(f, [id])
    const value = JSON.parse(readFileSync(config, 'utf8').replace(/^\uFEFF/, ''))
    assert.deepEqual(value.other, seed.other, `${id}: foreign data survives`)
    if (seed.hooks) assert.deepEqual(value.hooks.ForeignEvent, seed.hooks.ForeignEvent, `${id}: foreign hook survives`)
    if (seed.plugins) assert.deepEqual(value.plugins.entries.other, seed.plugins.entries.other, `${id}: foreign plugin survives`)
    await report(f, id, 'waiting')
    for (const args of [[], ['--chat']]) assertWaiting(await board(f, ...args), id)
    assertBlocks(f, [id])
    const installed = readFileSync(config)
    assertRepeat(await repeatApply(f), [id])
    assert.deepEqual(readFileSync(config), installed, `${id}: second apply preserves config bytes`)
  }
})

test('two agents and Claude Code in one home keep separate cards through setup and a second apply', async () => {
  // tests/host-upgrade.test.mjs installs all nine at once; two are enough to show the shared script,
  // skill and progress file hold one card per agent.
  const ids = ['codex', 'cursor']
  const f = fixture(Object.values(agents).filter(agent => ids.includes(agent.id)).map(agent => agent.sign))
  await preview(f, ids)
  await apply(f, ids)
  for (const id of ids) await report(f, id, 'waiting')
  const text = await board(f, '--chat')
  for (const id of ids) assertWaiting(text, id)
  assertBlocks(f, ids)
  assertRepeat(await repeatApply(f), ids)
  // Claude Code installs through its plugin, which writes into the same board file when
  // CLAUDE_PROGRESS_FILE names it, so its block is written here with the plugin's own writers.
  await writeClaude(f, true)
  const withClaude = await board(f, '--chat')
  for (const id of [...ids, '']) assertWaiting(withClaude, id)
  assertBlocks(f, [...ids, 'claude'])
})
