import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CHECKS, main, runMergeCheck } from '../scripts/merge-check.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false']

// Fixture git commands never see the developer's global or system config (a global failing hook or commit.gpgsign=true would break them).
const fixtureDir = mkdtempSync(join(tmpdir(), 'ab-merge-fixture-'))
const emptyConfig = join(fixtureDir, 'empty-gitconfig')
writeFileSync(emptyConfig, '')
after(() => rmSync(fixtureDir, { recursive: true, force: true }))
const noConfig = { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' }
const withoutRepoVars = env => Object.fromEntries(Object.entries(env).filter(([key]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)))
const fixtureEnv = () => ({ ...withoutRepoVars(process.env), ...noConfig })

const git = (cwd, ...args) => {
  const done = spawnSync('git', [...identity, ...args], { cwd, encoding: 'utf8', env: fixtureEnv() })
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
  // The native form expands Windows short names (RUNNER~1) in the temp folder, as git's own listing does.
  assert.equal(realpathSync.native(listed[0].slice(9)), realpathSync.native(clone))
  assert.equal(output.includes('ab-merge-check-'), false)
  assert.equal(git(clone, 'for-each-ref', 'refs/merge-check'), '')
}

// The merge check runs with no global or system git config, as on a CI runner or a fresh account: no identity.
const bare = (command, args, options) => spawnSync(command, args, { ...options, env: { ...(options.env ?? process.env), ...noConfig } })

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

test('another fetch in the same checkout cannot make the head pass for main', async () => {
  const s = await setup(addFiles)
  try {
    // Every fetch of the check is followed by another fetch of the head, as a second merge check in this checkout would do.
    const racing = (command, args, options) => {
      const done = bare(command, args, options)
      if (command === 'git' && args[0] === 'fetch') bare('git', ['fetch', '--no-tags', 'origin', 'refs/pull/1/head'], { cwd: options.cwd, encoding: 'utf8' })
      return done
    }
    const result = runMergeCheck({ run: racing, pr: 1, head: s.head, cwd: s.clone, checks: [failsWhenBoth], log: () => {} })
    assert.equal(result.mainSha, s.moved)
    assert.equal(result.ok, false)
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

const writeHook = (dir, name) => {
  const file = join(dir, name)
  writeFileSync(file, '#!/bin/sh\nexit 1\n')
  chmodSync(file, 0o755)
}
const listedWorktrees = clone => git(clone, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => line.slice(9))
const leftovers = clone => listedWorktrees(clone).filter(path => path.includes('ab-merge-check-'))
const removeLeftovers = clone => {
  for (const path of leftovers(clone)) git(clone, 'worktree', 'remove', '--force', path)
  for (const ref of git(clone, 'for-each-ref', '--format=%(refname)', 'refs/merge-check').split(/\r?\n/).filter(Boolean)) git(clone, 'update-ref', '-d', ref)
}
const repoState = clone => ({
  head: git(clone, 'rev-parse', 'HEAD'),
  branches: git(clone, 'branch', '--list'),
  status: git(clone, 'status', '--porcelain'),
  staged: spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: clone, env: fixtureEnv() }).status,
  files: git(clone, 'ls-files'),
})

test('GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE inherited from the caller cannot redirect the check', async () => {
  const s = await setup(addFiles)
  const saved = {}
  const hostile = { GIT_DIR: join(s.clone, '.git'), GIT_WORK_TREE: s.clone, GIT_INDEX_FILE: join(s.clone, '.git', 'index'), ...noConfig }
  try {
    const before = repoState(s.clone)
    for (const [key, value] of Object.entries(hostile)) { saved[key] = process.env[key]; process.env[key] = value }
    let result
    try {
      result = runMergeCheck({ pr: 1, head: s.head, cwd: s.clone, checks: [passesWhenBoth], log: () => {} })
    } finally {
      for (const key of Object.keys(hostile)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
    }
    assert.equal(result.ok, true, result.reason)
    assert.deepEqual(repoState(s.clone), before)
    assertClean(s.clone)
  } finally {
    await rm(s.base, { recursive: true, force: true })
  }
})

test('a cleanup that fails is a FAIL naming what was left, never a PASS', async () => {
  const s = await setup(addFiles)
  try {
    const lines = []
    const refusing = (command, args, options) => (command === 'git' && args[0] === 'worktree' && args[1] === 'remove' ? { status: 1, stdout: '', stderr: 'refused' } : bare(command, args, options))
    const result = runMergeCheck({ run: refusing, pr: 1, head: s.head, cwd: s.clone, checks: [passesWhenBoth], log: line => lines.push(line) })
    assert.equal(result.ok, false)
    assert.match(result.reason, /left behind.*ab-merge-check-/)
    assert.equal(lines.filter(line => line.startsWith('PASS')).length, 0)
    assert.equal(lines.filter(line => line.includes('merge-check #1')).length, 1)
    assert.match(lines.at(-1), /^FAIL merge-check #1: .*left behind/)
  } finally {
    removeLeftovers(s.clone)
    await rm(s.base, { recursive: true, force: true })
  }
})

test('a failing post-checkout hook in the checkout changes neither the verdict nor the cleanup', async () => {
  const s = await setup(addFiles)
  try {
    writeHook(join(s.clone, '.git', 'hooks'), 'post-checkout')
    const result = runMergeCheck({ run: bare, pr: 1, head: s.head, cwd: s.clone, checks: [passesWhenBoth], log: () => {} })
    assert.equal(result.ok, true, result.reason)
    assertClean(s.clone)
  } finally {
    removeLeftovers(s.clone)
    await rm(s.base, { recursive: true, force: true })
  }
})

test('a worktree add that fails after registering the worktree is a FAIL and leaves no registration or folder', async () => {
  const s = await setup(addFiles)
  const ours = () => readdirSync(tmpdir()).filter(name => name.startsWith(`ab-merge-check-${process.pid}-`)).sort()
  const before = ours()
  try {
    // git can register the worktree and then fail (a checkout error, a full disk); the cleanup must still remove it.
    const addFailsLate = (command, args, options) => {
      const done = bare(command, args, options)
      return args[0] === 'worktree' && args[1] === 'add' ? { ...done, status: 128, stderr: 'synthetic failure after the worktree was registered' } : done
    }
    const result = runMergeCheck({ run: addFailsLate, pr: 1, head: s.head, cwd: s.clone, checks: [passesWhenBoth], log: () => {} })
    assert.equal(result.ok, false)
    assert.match(result.reason, /^could not create a worktree on main: synthetic failure/)
    assertClean(s.clone)
    assert.deepEqual(ours(), before)
  } finally {
    removeLeftovers(s.clone)
    await rm(s.base, { recursive: true, force: true })
  }
})

test('a head that moves while the checks run is a FAIL', async () => {
  const s = await setup(addFiles)
  try {
    const lines = []
    let moved = false
    const moving = (command, args, options) => {
      if (command !== 'git' && !moved) {
        moved = true
        git(s.clone, 'push', '--force', 'origin', `${s.moved}:refs/pull/1/head`)
      }
      return bare(command, args, options)
    }
    const result = runMergeCheck({ run: moving, pr: 1, head: s.head, cwd: s.clone, checks: [passesWhenBoth], log: line => lines.push(line) })
    assert.equal(moved, true)
    assert.equal(result.ok, false)
    assert.match(result.reason, /the pull request's head moved to [0-9a-f]{8} while the checks ran/)
    assert.match(lines.at(-1), /^FAIL merge-check #1: the pull request's head moved/)
    assertClean(s.clone)
  } finally {
    await rm(s.base, { recursive: true, force: true })
  }
})

test('leftovers of dead runs are removed and those of a live process are kept', async () => {
  const s = await setup(addFiles)
  try {
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    const deadDir = join(s.base, `ab-merge-check-${dead}-stale`)
    const liveDir = join(s.base, `ab-merge-check-${process.pid}-live`)
    git(s.clone, 'update-ref', `refs/merge-check/${dead}-abcd/main`, s.head)
    git(s.clone, 'update-ref', `refs/merge-check/${process.pid}-abcd/main`, s.head)
    git(s.clone, 'worktree', 'add', '--detach', deadDir, s.head)
    git(s.clone, 'worktree', 'add', '--detach', liveDir, s.head)
    const result = runMergeCheck({ run: bare, pr: 1, head: s.head, cwd: s.clone, checks: [passesWhenBoth], log: () => {} })
    assert.equal(result.ok, true, result.reason)
    const refs = git(s.clone, 'for-each-ref', '--format=%(refname)', 'refs/merge-check')
    assert.equal(refs.includes(`${dead}-abcd`), false)
    assert.equal(refs.includes(`${process.pid}-abcd`), true)
    assert.equal(leftovers(s.clone).some(path => path.includes(`ab-merge-check-${dead}-`)), false)
    assert.equal(existsSync(deadDir), false)
    assert.equal(leftovers(s.clone).some(path => path.includes(`ab-merge-check-${process.pid}-live`)), true)
  } finally {
    removeLeftovers(s.clone)
    await rm(s.base, { recursive: true, force: true })
  }
})

// A global config that would break a careless merge check: failing hooks, signed commits, fast-forward only.
const hostileConfig = () => {
  const hooks = join(fixtureDir, 'hostile-hooks')
  mkdirSync(hooks, { recursive: true })
  for (const name of ['post-checkout', 'post-merge', 'pre-merge-commit', 'pre-commit', 'commit-msg', 'reference-transaction']) writeHook(hooks, name)
  const file = join(fixtureDir, 'hostile-gitconfig')
  writeFileSync(file, `[core]\n\thooksPath = ${hooks.replaceAll('\\', '/')}\n[commit]\n\tgpgsign = true\n[merge]\n\tff = only\n[pull]\n\trebase = true\n`)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' }
  // Code that ignores the env option still runs under the hostile config through this wrapper's default.
  return { env, run: (command, args, options) => spawnSync(command, args, { ...options, env: options.env ?? env }) }
}

const conflict = {
  onPr: clone => commitFile(clone, 'a.txt', 'one\nPR\nthree\n', 'pr edits a'),
  onMain: clone => commitFile(clone, 'a.txt', 'one\nMAIN\nthree\n', 'main edits a'),
}

test('a hostile global git config does not stop a clean merge from passing', async () => {
  const s = await setup(addFiles)
  try {
    const { env, run } = hostileConfig()
    const result = runMergeCheck({ run, env, pr: 1, head: s.head, cwd: s.clone, checks: [passesWhenBoth], log: () => {} })
    assert.equal(result.ok, true, result.reason)
    assertClean(s.clone)
  } finally {
    removeLeftovers(s.clone)
    await rm(s.base, { recursive: true, force: true })
  }
})

test('a hostile global git config does not hide a conflict', async () => {
  const s = await setup(conflict)
  try {
    const { env, run } = hostileConfig()
    const result = runMergeCheck({ run, env, pr: 1, head: s.head, cwd: s.clone, checks: [passesWhenBoth], log: () => {} })
    assert.equal(result.ok, false)
    assert.match(result.reason, /^conflict with main: .*a\.txt/)
    assertClean(s.clone)
  } finally {
    removeLeftovers(s.clone)
    await rm(s.base, { recursive: true, force: true })
  }
})

const cli = (cwd, ...args) => spawnSync(process.execPath, [join(root, 'scripts/merge-check.mjs'), ...args], { cwd, encoding: 'utf8', env: fixtureEnv() })

test('the command line exits 2 with a usage line on bad arguments', () => {
  const done = cli(root, '1', '--head', 'abc')
  assert.equal(done.status, 2)
  assert.match(done.stderr, /^usage: node scripts\/merge-check\.mjs <pr-number> --head/)
  assert.equal(done.stdout, '')
})

test('the command line exits 1 and prints a FAIL line on a conflict', async () => {
  const s = await setup(conflict)
  try {
    const done = cli(s.clone, '1', '--head', s.head)
    assert.equal(done.status, 1, done.stderr)
    assert.match(done.stdout, /^FAIL merge-check #1: conflict with main: .*a\.txt/m)
    assertClean(s.clone)
  } finally {
    await rm(s.base, { recursive: true, force: true })
  }
})

test('main returns 0 when the checks pass, 1 when they fail and 2 on bad arguments', async () => {
  const s = await setup(addFiles)
  try {
    const lines = []
    const errors = []
    const deps = { run: bare, cwd: s.clone, log: line => lines.push(line), error: line => errors.push(line) }
    assert.equal(main(['1', '--head', s.head], { ...deps, checks: [passesWhenBoth] }), 0)
    assert.match(lines.at(-1), /^PASS merge-check #1/)
    assert.equal(main(['1', '--head', s.head], { ...deps, checks: [failsWhenBoth] }), 1)
    assert.match(lines.at(-1), /^FAIL merge-check #1/)
    assert.equal(main(['1', s.head], deps), 2)
    assert.match(errors.at(-1), /^usage: /)
    assertClean(s.clone)
  } finally {
    await rm(s.base, { recursive: true, force: true })
  }
})
