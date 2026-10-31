import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

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

  // Now updating or removing antigravity succeeds cleanly with zero INSTALL_CONFLICT
  const updateAg = f.install('--agent', 'antigravity', '--apply')
  assert.equal(updateAg.status, 0, updateAg.stderr)
  const removeAg = f.install('--agent', 'antigravity', '--remove', '--apply')
  assert.equal(removeAg.status, 0, removeAg.stderr)
}))
