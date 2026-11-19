import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RELEASE_0_20_5 } from './fixtures/released.ts'

const setup = resolve('scripts/setup-codex.mjs')
const session = 'test-codex-session-123'

const isolatedEnv = home => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
  XDG_CONFIG_HOME: join(home, '.config'),
  CLAUDE_CONFIG_DIR: '',
  CLAUDE_PROGRESS_FILE: '',
})

const fixture = async fn => {
  const home = mkdtempSync(join(tmpdir(), 'manifest-resumed-'))
  const root = join(home, '.agent-board')
  const script = join(root, 'agent-board.mjs')
  const progress = join(root, 'progress.md')
  const env = { ...isolatedEnv(home), CODEX_THREAD_ID: session, NO_COLOR: '1' }
  const run = (file, args, input, extraEnv = {}) => spawnSync(process.execPath, [file, ...args], { env: { ...env, ...extraEnv }, input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const isolated = ['--home', home, '--codex-dir', join(home, '.codex'), '--grok-dir', join(home, '.grok'), '--hermes-dir', join(home, '.hermes')]
  const install = (...args) => run(setup, [...isolated, ...args])
  const command = (args, input, extraEnv = {}) => run(script, [...isolated, ...args], input, extraEnv)
  try {
    return await fn({ home, root, script, progress, env, install, command })
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
}

const recordOlderBoard = f => {
  const olderHash = createHash('sha256').update('an earlier installed board').digest('hex')
  for (const name of ['install-codex.json', 'install-antigravity.json']) {
    const manifestPath = join(f.root, name)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.files[f.script] = olderHash
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
}

test('resumed Antigravity conversations receive bound --codex-report context and non-Codex agents infer session from folderDigest', () => fixture(f => {
  f.install('--agent', 'antigravity', '--apply')
  const workDir = join(f.home, 'ag-workspace')
  mkdirSync(workDir, { recursive: true })
  const resumedSession = 'resumed-ag-session-777'

  // Resumed conversation fires PreInvocation with invocationNum > 0 and no prior SessionStart
  const preInv = f.command(['--agent-status', '--agent', 'antigravity', '--state', 'working', '--event', 'PreInvocation'], {
    conversationId: resumedSession,
    invocationNum: 5,
    workspaceRoot: workDir,
  })
  assert.equal(preInv.status, 0, preInv.stderr)
  const out = JSON.parse(preInv.stdout)
  assert.ok(Array.isArray(out.injectSteps) && out.injectSteps.length === 1)
  assert.match(out.injectSteps[0].ephemeralMessage, /Agent Board is bound to this Antigravity conversation by its native hook\./)

  // Subsequent --codex-report without --session from the same workspace infers the session via folderDigest
  const report = spawnSync(
    process.execPath,
    [f.script, '--codex-report', '--agent', 'antigravity', '--home', f.home, '--progress-file', f.progress],
    {
      cwd: workDir,
      env: f.env,
      input: JSON.stringify({ title: 'Inferred Folder Report', state: 'working', steps: ['- [~] Bound via folderDigest'] }),
      encoding: 'utf8',
      windowsHide: true,
    },
  )
  assert.equal(report.status, 0, report.stderr)
  assert.equal(JSON.parse(report.stdout).session, resumedSession)

  for (const [lang, sentence] of [
    ['en', "the command finds that agent's one active session in this folder, and if there is none or more than one, say it is disconnected."],
    ['zh-CN', '命令会找出该 agent 在此文件夹中唯一进行中的 session；找不到或不止一个就明示未接通。不扫描对话或猜 session，也不指定其他 session。'],
    ['zh-TW', '指令會找出該 agent 在此資料夾中唯一進行中的 session；找不到或不只一個就明示未接通。不掃描對話或猜 session，也不指定其他 session。'],
  ]) {
    const installed = f.install('--agent', 'antigravity', '--apply', '--lang', lang)
    assert.equal(installed.status, 0, installed.stderr)
    const skill = readFileSync(join(f.home, '.gemini', 'config', 'skills', 'agent-board', 'SKILL.md'), 'utf8')
    assert.ok(skill.includes('--codex-report --agent <agent>'), lang)
    assert.ok(skill.includes(sentence), lang)
  }
}))

test('updating shared runtime files for one agent synchronizes sibling install manifests without INSTALL_CONFLICT', () => fixture(f => {
  assert.equal(f.install('--agent', 'codex', '--apply').status, 0)
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)

  // Simulate an older shared worker & skill version recorded in both manifests and on disk
  const workerPath = join(f.root, 'agent-board-hook.mjs')
  const oldWorker = readFileSync(workerPath, 'utf8') + '\n// previous release worker\n'
  const oldWorkerHash = createHash('sha256').update(oldWorker).digest('hex')
  writeFileSync(workerPath, oldWorker)
  for (const name of ['install-codex.json', 'install-antigravity.json']) {
    const manifestPath = join(f.root, name)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.files[workerPath] = oldWorkerHash
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }

  // Updating codex refreshes the shared worker and synchronizes install-antigravity.json
  const updateCodex = f.install('--agent', 'codex', '--apply')
  assert.equal(updateCodex.status, 0, updateCodex.stderr)
  const sibling = JSON.parse(readFileSync(join(f.root, 'install-antigravity.json'), 'utf8'))
  assert.equal(sibling.files[workerPath], createHash('sha256').update(readFileSync(workerPath)).digest('hex'))
  const doctor = f.command(['--codex-doctor', '--agent', 'antigravity', '--json'])
  assert.equal(doctor.status, 0, doctor.stderr)
  assert.equal(JSON.parse(doctor.stdout).installed, true)

  // Now updating or removing antigravity succeeds cleanly with zero INSTALL_CONFLICT
  const updateAg = f.install('--agent', 'antigravity', '--apply')
  assert.equal(updateAg.status, 0, updateAg.stderr)
  const removeAg = f.install('--agent', 'antigravity', '--remove', '--apply')
  assert.equal(removeAg.status, 0, removeAg.stderr)
}))

test('recognized released boards upgrade while an edited released board is kept (#1302)', () => fixture(f => {
  assert.equal(f.install('--agent', 'codex', '--apply').status, 0)
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  recordOlderBoard(f)
  const released = `globalThis.AGENT_BOARD = ${JSON.stringify({ path: f.progress, lang: 'en' })}\n${RELEASE_0_20_5.board}`
  writeFileSync(f.script, released)
  const update = f.install('--agent', 'codex', '--apply')
  assert.equal(update.status, 0, update.stderr + update.stdout)
  const doctor = f.command(['--codex-doctor', '--agent', 'antigravity', '--json'])
  assert.equal(doctor.status, 0, doctor.stderr)
  assert.equal(JSON.parse(doctor.stdout).installed, true)
  writeFileSync(f.script, `${released}// mine\n`)
  const edited = f.install('--agent', 'codex', '--apply', '--json')
  assert.equal(edited.status, 0, edited.stderr + edited.stdout)
  assert.deepEqual(JSON.parse(edited.stdout).keptCode, [f.script])
  assert.equal(readFileSync(f.script, 'utf8'), `${released}// mine\n`)
}))

const boardWith = settings => `globalThis.AGENT_BOARD = ${typeof settings === 'string' ? settings : JSON.stringify(settings)}\n${RELEASE_0_20_5.board}`
const digestOf = text => createHash('sha256').update(text).digest('hex')

test('a released board keeps a settings line the person changed, and one setup or the connect wrote still upgrades (#1302)', () => fixture(f => {
  assert.equal(f.install('--agent', 'codex', '--apply').status, 0)
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const legacy = join(f.home, '.claude', 'progress.md')
  const line = { path: f.progress, lang: 'en' }
  const changed = {
    'spaces in the line': `{ "path": ${JSON.stringify(f.progress)}, "lang": "en" }`,
    'a key of the person': { ...line, note: 'mine' },
    'a hook version no release used': { hookVersion: 99, ...line },
    'a hook version that is not a number': { hookVersion: '1', ...line },
    'another data folder': { path: f.progress, codexRoot: join(f.home, 'mine'), lang: 'en' },
    'another board file': { path: join(f.home, 'mine.md'), lang: 'en' },
    'a recognized older path, on an install with a record': { path: legacy, lang: 'en' },
    'a language setup does not know': { path: f.progress, lang: 'fr' },
  }
  for (const [name, settings] of Object.entries(changed)) {
    recordOlderBoard(f)
    writeFileSync(f.script, boardWith(settings))
    const result = f.install('--agent', 'codex', '--apply')
    assert.equal(result.status, 0, `${name}: ${result.stderr}${result.stdout}`)
    assert.deepEqual(JSON.parse(result.stdout).keptCode, [f.script], name)
    assert.equal(readFileSync(f.script, 'utf8'), boardWith(settings), name)
  }
  const released = [line, { path: f.progress, codexRoot: f.root, lang: 'en' }, { hookVersion: 1, ...line }, { hookVersion: 1, path: f.progress, codexRoot: f.root, lang: 'zh-TW' }]
  for (const settings of released) {
    recordOlderBoard(f)
    writeFileSync(f.script, boardWith(settings))
    const result = f.install('--agent', 'codex', '--apply')
    assert.equal(result.status, 0, `${JSON.stringify(settings)}: ${result.stderr}${result.stdout}`)
    assert.equal(JSON.parse(result.stdout).keptCode, undefined, JSON.stringify(settings))
    assert.notEqual(readFileSync(f.script, 'utf8'), boardWith(settings), JSON.stringify(settings))
  }
}))

test('a released body the record held under another settings line was changed by the person, so it is kept (#1302)', () => fixture(f => {
  assert.equal(f.install('--agent', 'codex', '--apply').status, 0)
  const recorded = boardWith({ hookVersion: 1, path: f.progress, codexRoot: f.root, lang: 'en' })
  const manifestPath = join(f.root, 'install-codex.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.files[f.script] = digestOf(recorded)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const edited = boardWith({ hookVersion: 1, path: f.progress, lang: 'en' })
  writeFileSync(f.script, edited)
  const result = f.install('--agent', 'codex', '--apply')
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.deepEqual(JSON.parse(result.stdout).keptCode, [f.script], result.stdout)
  assert.equal(readFileSync(f.script, 'utf8'), edited)
}))

test('with no install record, a released board naming a known board file upgrades and one naming another file is refused (#1302)', () => fixture(f => {
  const known = boardWith({ path: join(f.home, '.claude', 'progress.md'), lang: 'en' })
  mkdirSync(f.root, { recursive: true })
  writeFileSync(f.script, known)
  const upgraded = f.install('--agent', 'codex', '--apply')
  assert.equal(upgraded.status, 0, upgraded.stderr + upgraded.stdout)
  assert.notEqual(readFileSync(f.script, 'utf8'), known)
  const manifestPath = join(f.root, 'install-codex.json')
  const removed = f.install('--agent', 'codex', '--remove', '--apply')
  assert.equal(removed.status, 0, removed.stderr + removed.stdout)
  assert.equal(existsSync(manifestPath), false)
  const other = boardWith({ path: join(f.home, 'mine.md'), lang: 'en' })
  mkdirSync(f.root, { recursive: true })
  writeFileSync(f.script, other)
  const refused = f.install('--agent', 'codex', '--apply')
  assert.notEqual(refused.status, 0, refused.stdout)
  assert.deepEqual(JSON.parse(refused.stdout).conflicts, [f.script], refused.stdout)
  assert.equal(readFileSync(f.script, 'utf8'), other)
}))

test('updating a released board repairs stale sibling manifests without adding unlisted files', () => fixture(f => {
  assert.equal(f.install('--agent', 'codex', '--apply').status, 0)
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  recordOlderBoard(f)
  const unrelatedPath = join(f.root, 'install-gemini.json')
  const unrelated = JSON.stringify({ files: {}, groups: {}, progress: f.progress }) + '\n'
  writeFileSync(unrelatedPath, unrelated)
  const released = `globalThis.AGENT_BOARD = ${JSON.stringify({ path: f.progress, lang: 'en' })}\n${RELEASE_0_20_5.board}`
  const releaseHash = createHash('sha256').update(released).digest('hex')
  const owner = { files: { [f.script]: releaseHash }, groups: {}, progress: f.progress }
  writeFileSync(join(f.root, 'install-opencode.json'), JSON.stringify(owner) + '\n')
  writeFileSync(f.script, released)
  const update = f.install('--agent', 'codex', '--apply')
  assert.equal(update.status, 0, update.stderr + update.stdout)
  assert.equal(readFileSync(unrelatedPath, 'utf8'), unrelated)
  const doctor = f.command(['--codex-doctor', '--agent', 'antigravity', '--json'])
  assert.equal(doctor.status, 0, doctor.stderr)
  assert.equal(JSON.parse(doctor.stdout).installed, true)
  const sibling = JSON.parse(readFileSync(join(f.root, 'install-antigravity.json'), 'utf8'))
  assert.equal(sibling.files[f.script], createHash('sha256').update(readFileSync(f.script)).digest('hex'))
}))

test('Codex reports use the bound thread instead of session fields in report bodies', () => fixture(f => {
  const installed = f.install('--agent', 'codex', '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const body = { session: 'short', title: 'Bound report', state: 'working', steps: ['- [~] Working'] }
  const report = f.command(['--codex-report'], body)
  assert.equal(report.status, 0, report.stderr)
  const out = JSON.parse(report.stdout)
  assert.equal(out.session, session)
  assert.match(readFileSync(f.progress, 'utf8'), new RegExp(`<!-- auto session=${out.block} agent=codex`))
  const unbound = f.command(['--codex-report', '--lang', 'en'], { ...body, session: 'untrusted-session-123' }, { CODEX_THREAD_ID: undefined })
  assert.notEqual(unbound.status, 0)
  assert.match(unbound.stderr, /This report is not bound to a session/)
}))
