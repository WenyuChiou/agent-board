import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CHECKS, runMergeCheck } from '../scripts/merge-check.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false']

const git = (cwd, ...args) => {
  const done = spawnSync('git', [...identity, ...args], { cwd, encoding: 'utf8' })
  assert.equal(done.status, 0, `git ${args.join(' ')} failed: ${done.stderr}`)
  return done.stdout.trim()
}

const commitFile = async (cwd, name, text, message) => {
  await writeFile(join(cwd, name), text)
  git(cwd, 'add', name)
  git(cwd, 'commit', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

// A bare remote, a clone, a base commit on main, a PR branch as refs/pull/1/head, then main moves.
const setup = async ({ onPr, onMain }) => {
  const base = await mkdtemp(join(tmpdir(), 'ab-merge-test-'))
  const remote = join(base, 'remote.git')
  const clone = join(base, 'clone')
  git(base, 'init', '--bare', '-b', 'main', remote)
  git(base, 'clone', remote, clone)
  git(clone, 'checkout', '-B', 'main')
  const baseSha = await commitFile(clone, 'a.txt', 'one\ntwo\nthree\n', 'base')
  git(clone, 'push', 'origin', 'main')
  git(clone, 'checkout', '-b', 'pr')
  const head = await onPr(clone)
  git(clone, 'push', 'origin', 'HEAD:refs/pull/1/head')
  git(clone, 'checkout', 'main')
  const moved = await onMain(clone)
  git(clone, 'push', 'origin', 'main')
  git(clone, 'checkout', '--detach')
  return { base, clone, baseSha, head, moved }
}

const assertClean = clone => {
  const output = git(clone, 'worktree', 'list', '--porcelain')
  const listed = output.split(/\r?\n/).filter(line => line.startsWith('worktree '))
  assert.equal(listed.length, 1)
  assert.equal(realpathSync(listed[0].slice(9)), realpathSync(clone))
  assert.equal(output.includes('ab-merge-check-'), false)
}

// The merge check runs with no global or system git config, as on a CI runner or a fresh account: no identity.
const noConfig = { ...process.env, GIT_CONFIG_GLOBAL: join(tmpdir(), 'ab-merge-test-no-global-config'), GIT_CONFIG_NOSYSTEM: '1' }
const bare = (command, args, options) => spawnSync(command, args, { ...options, env: noConfig })

const script = (condition, code) => ['-e', `const f=require('fs');process.exit(${condition}?${code}:${1 - code})`]
const bothExist = "f.existsSync('m.txt')&&f.existsSync('h.txt')"
const failsWhenBoth = { label: 'both files', command: process.execPath, args: script(bothExist, 1) }
const passesWhenBoth = { label: 'merged tree', command: process.execPath, args: script(bothExist, 0) }

const addFiles = {
  onPr: clone => commitFile(clone, 'h.txt', 'h\n', 'pr adds h'),
  onMain: clone => commitFile(clone, 'm.txt', 'm\n', 'main adds m'),
}

test('a head and a main that each pass alone fail together on the latest main', async () => {
  const s = await setup(addFiles)
  try {
    const lines = []
    const headOnly = join(s.base, 'head-only')
    const mainOnly = join(s.base, 'main-only')
    git(s.clone, 'worktree', 'add', '--detach', headOnly, s.head)
    git(s.clone, 'worktree', 'add', '--detach', mainOnly, s.moved)
    assert.equal(spawnSync(failsWhenBoth.command, failsWhenBoth.args, { cwd: headOnly }).status, 0)
    assert.equal(spawnSync(failsWhenBoth.command, failsWhenBoth.args, { cwd: mainOnly }).status, 0)
    git(s.clone, 'worktree', 'remove', '--force', headOnly)
    git(s.clone, 'worktree', 'remove', '--force', mainOnly)
    const result = runMergeCheck({ run: bare, pr: 1, head: s.head, cwd: s.clone, checks: [failsWhenBoth], log: line => lines.push(line) })
    assert.equal(result.ok, false)
    assert.match(result.reason, /both files failed/)
    assert.equal(result.mainSha, s.moved)
    assert.equal(result.headSha, s.head)
    assert.match(lines.at(-1), /^FAIL merge-check #1: both files failed/)
    assertClean(s.clone)
  } finally {
    await rm(s.base, { recursive: true, force: true })
  }
})

test('a conflict with main names the file and leaves nothing behind', async () => {
  const s = await setup({
    onPr: clone => commitFile(clone, 'a.txt', 'one\nPR\nthree\n', 'pr edits a'),
    onMain: clone => commitFile(clone, 'a.txt', 'one\nMAIN\nthree\n', 'main edits a'),
  })
  try {
    const result = runMergeCheck({ run: bare, pr: 1, head: s.head, cwd: s.clone, checks: [failsWhenBoth], log: () => {} })
    assert.equal(result.ok, false)
    assert.match(result.reason, /^conflict with main: .*a\.txt/)
    assertClean(s.clone)
  } finally {
    await rm(s.base, { recursive: true, force: true })
  }
})

test('a clean merge whose checks pass is ok, and the checks see the merged tree', async () => {
  const s = await setup(addFiles)
  try {
    const lines = []
    const result = runMergeCheck({ run: bare, pr: 1, head: s.head, cwd: s.clone, checks: [passesWhenBoth], log: line => lines.push(line) })
    assert.equal(result.ok, true)
    assert.match(lines.at(-1), /^PASS merge-check #1: head [0-9a-f]{8} merged onto main [0-9a-f]{8}; merged tree current$/)
    assertClean(s.clone)
  } finally {
    await rm(s.base, { recursive: true, force: true })
  }
})

test('a head that moved since approval is refused and leaves no worktree', async () => {
  const s = await setup(addFiles)
  try {
    const result = runMergeCheck({ run: bare, pr: 1, head: s.baseSha, cwd: s.clone, checks: [failsWhenBoth], log: () => {} })
    assert.equal(result.ok, false)
    assert.match(result.reason, /the pull request's head is now [0-9a-f]{8}, not [0-9a-f]{8}/)
    assertClean(s.clone)
  } finally {
    await rm(s.base, { recursive: true, force: true })
  }
})

test('a failing fetch is a failure, never a pass', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ab-merge-test-'))
  try {
    git(base, 'init', '-b', 'main')
    const result = runMergeCheck({ run: bare, pr: 1, head: 'a'.repeat(40), cwd: base, checks: [], log: () => {} })
    assert.equal(result.ok, false)
    assert.match(result.reason, /could not fetch/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('CHECKS match the generated files job in the CI workflow', () => {
  const lines = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8').split(/\r?\n/)
  const start = lines.findIndex(line => /^  generated:\s*$/.test(line))
  assert.ok(start >= 0, 'generated job not found')
  const runs = []
  for (const line of lines.slice(start + 1)) {
    if (/^  \S/.test(line)) break
    const match = line.match(/^\s+run:\s*(.+?)\s*$/)
    if (match) runs.push(match[1])
  }
  assert.deepEqual(runs, CHECKS.map(check => [check.command, ...check.args].join(' ')))
  assert.equal(existsSync(join(root, 'scripts/merge-check.mjs')), true)
})
