import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { spawnIsolated } from './spawn.mjs'
import { makeWorld } from './world.mjs'

// Shared by the host journeys (tests/e2e/host-journeys.test.mjs) and the upgrade journey
// (tests/host-upgrade.test.mjs): a synthetic home, the setup commands run inside it, one
// reported turn and what the board shows for it. Nothing here runs an agent or a model.
// Every process starts through spawnIsolated, inside a journey world (lib/world.mjs).
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
export const agents = {
  'Claude Code': { id: '', sign: '.claude' },
  Codex: { id: 'codex', sign: '.codex' },
  Antigravity: { id: 'antigravity', sign: '.gemini/antigravity-cli' },
  OpenCode: { id: 'opencode', sign: '.config/opencode' },
  Cursor: { id: 'cursor', sign: '.cursor' },
  'Grok Build': { id: 'grok', sign: '.grok' },
  'Muse Code': { id: 'muse', sign: '.config/muse' },
  'Hermes Agent': { id: 'hermes', sign: '.hermes' },
  OpenClaw: { id: 'openclaw', sign: '.openclaw' },
  'DeepSeek Harness': { id: 'deepseek', sign: '.dsh' },
}
// The order setup takes the nine agents it installs (Claude Code installs through its plugin).
export const setupOrder = ['codex', 'cursor', 'opencode', 'grok', 'muse', 'hermes', 'openclaw', 'antigravity', 'deepseek']
// Each agent reports its own title and question, so a card that carried another agent's words fails.
const label = id => id || 'claude'
export const titleOf = id => `Check the ${label(id)} gateway routes`
export const questionOf = id => `Deploy the ${label(id)} routes to staging, OK?`
const worlds = []
const folders = []
export const cleanup = async () => {
  const errors = []
  for (const world of worlds) {
    try { await world.close() } catch (error) { errors.push(error) }
  }
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  if (errors.length) throw new AggregateError(errors, 'World cleanup failed')
}
// A new temporary folder that the test's cleanup removes; only folders made here are removed.
export const tempFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), 'agent-board-journey-'))
  folders.push(folder)
  return folder
}

// A world whose home holds only the folders that name the agents under test, so setup's own
// detection sees exactly those agents. Every host variable names a folder of this home.
export const fixture = signs => {
  const world = makeWorld()
  worlds.push(world)
  const home = join(world.root, 'host')
  mkdirSync(home, { recursive: true })
  for (const sign of signs) mkdirSync(join(home, sign), { recursive: true })
  // spawnIsolated refuses an empty CLAUDE_PROGRESS_FILE, so the board file is named here. That is
  // the file a fresh setup defaults to; tests/codex-local.test.mjs covers the default itself.
  const progress = join(home, '.agent-board', 'progress.md')
  const env = {
    ...world.env, HOME: home, USERPROFILE: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'),
    CLAUDE_PROGRESS_FILE: progress, CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'), GROK_HOME: join(home, '.grok'), HERMES_HOME: join(home, '.hermes'),
    XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
    OPENCLAW_STATE_DIR: join(home, '.openclaw'), DSH_HOME: join(home, '.dsh'),
    LANG: 'en',
  }
  return { world, home, env, script: join(home, '.agent-board', 'agent-board.mjs'), progress }
}

// Runs node with the given arguments in the fixture's world and collects what it printed.
const run = (f, args, { input, timeoutMs, env }) => new Promise((resolveRun, reject) => {
  const child = spawnIsolated(process.execPath, args, { env: env ? { ...f.env, ...env } : f.env, cwd: f.world.root, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', failure
  const timer = setTimeout(() => {
    failure = new Error(`timed out after ${timeoutMs} ms`)
    child.kill()
  }, timeoutMs)
  child.on('error', error => { failure = error })
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure = error })
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.once('close', status => {
    clearTimeout(timer)
    if (failure) reject(failure)
    else resolveRun({ status, stdout, stderr })
  })
  child.stdin.end(input)
})

export const snapshot = home => {
  const entries = []
  const visit = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(folder, entry.name)
      const name = relative(home, file).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        entries.push([`${name}/`, null])
        visit(file)
      } else entries.push([name, createHash('sha256').update(readFileSync(file)).digest('hex')])
    }
  }
  visit(home)
  return entries
}

export const checked = (result, label) => {
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${label}: ${result.stderr}\n${result.stdout}`)
  assert.equal(result.stderr.toString(), '', `${label}: empty stderr`)
  return result.stdout
}

export const insideHome = (home, file) => {
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value
  const path = relative(normalize(resolve(home)), normalize(resolve(file)))
  assert.ok(path !== '' && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path), `setup change stays in the synthetic home: ${file}`)
}

export const setup = async (f, args = [], source = repoRoot) => {
  const stdout = checked(await run(f, [join(source, 'scripts', 'setup-agent.mjs'), '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), '--lang', 'en', ...args], { timeoutMs: 120000 }), `setup ${args.join(' ')}`)
  if (!stdout.trimStart().startsWith('{')) return stdout
  const plan = JSON.parse(stdout)
  for (const target of plan.plans) {
    assert.deepEqual(target.conflicts, [], `${target.agent}: no setup conflicts`)
    for (const change of target.changes) insideHome(f.home, change.file)
  }
  return plan
}

export const preview = async (f, ids, source = repoRoot) => {
  const before = snapshot(f.home)
  const plan = await setup(f, [], source)
  assert.deepEqual(plan.targets, ids)
  assert.equal(plan.applied, false)
  assert.ok(plan.plans.every(target => target.changes.length > 0))
  assert.deepEqual(snapshot(f.home), before, 'preview writes nothing')
  return plan
}

export const apply = async (f, ids, source = repoRoot) => {
  const plan = await setup(f, ['--apply'], source)
  assert.deepEqual(plan.targets, ids)
  assert.equal(plan.applied, true)
  for (const target of plan.plans) for (const change of target.changes) assert.ok(existsSync(change.file), `${target.agent}: ${change.file} exists`)
  assert.ok(existsSync(f.script))
  assert.ok(existsSync(f.progress))
  return plan
}

export const board = async (f, ...args) => checked(await run(f, [f.script, ...args], { timeoutMs: 60000 }), `board ${args.join(' ')}`)

export const report = async (f, id, state) => {
  const session = `${id}-journey-session`
  const args = [f.script, '--codex-report', '--agent', id, ...(id === 'codex' ? [] : ['--session', session])]
  // Codex names its session in the environment; the other reporters take it as an argument.
  checked(await run(f, args, {
    input: JSON.stringify({ title: titleOf(id), project: 'api-gateway', state, steps: ['- [x] Read the route table', '- [~] Compare the staging routes', state === 'waiting' ? `- [?] ${questionOf(id)}` : '- [ ] Deploy the routes'] }),
    timeoutMs: 60000, env: id === 'codex' ? { CODEX_THREAD_ID: session } : undefined,
  }), `${id}: ${state} turn`)
}

export const assertWorking = (text, id) => {
  assert.ok(text.includes(titleOf(id)), `${id || 'Claude Code'}: working title`)
  assert.ok(text.includes('Compare the staging routes'), `${id || 'Claude Code'}: working step`)
  if (id) assert.ok(text.includes(` · ${id}`), `${id}: the working card names the agent`)
}

export const assertWaiting = (text, id) => {
  const heading = text.indexOf('Waiting on you')
  assert.ok(heading >= 0, `${id || 'Claude Code'}: Waiting on you heading`)
  const card = `api-gateway${id ? ` · ${id}` : ''} › ${titleOf(id)}`
  const at = text.indexOf(card, heading)
  assert.ok(at > heading, `${id || 'Claude Code'}: waiting card ${card}\n${text}`)
  const nextLine = text.slice(at + card.length).trimStart().split('\n')[0]
  // Observed: the reporters label the question [Confirm] and the Claude Code plugin's card [Reply].
  assert.ok(nextLine.startsWith(`[${id ? 'Confirm' : 'Reply'}] ${questionOf(id)}`), `${id || 'Claude Code'}: the card carries its question\n${text}`)
}

export const assertBlocks = (f, ids) => {
  const starts = readFileSync(f.progress, 'utf8').split(/\r?\n/).filter(line => line.startsWith('<!-- auto session='))
  assert.equal(starts.length, ids.length, 'one block per agent')
  for (const id of ids) assert.equal(starts.filter(line => line.includes(` agent=${id} `)).length, 1, `${id}: one block after repeated turns`)
}

export const repeatApply = async f => {
  const before = snapshot(f.home)
  const plan = await setup(f, ['--apply'])
  const after = snapshot(f.home)
  return { plan, before, after }
}

export const assertRepeat = ({ plan, before, after }, ids) => {
  assert.deepEqual(plan.targets, ids)
  assert.equal(plan.applied, true)
  assert.equal(plan.plans.length, ids.length, 'one plan per agent')
  for (const target of plan.plans) assert.deepEqual(target.changes, [], `${target.agent}: second apply reports no changes`)
  assert.deepEqual(after, before, 'second apply leaves every file byte-identical')
}
