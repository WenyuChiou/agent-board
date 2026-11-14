import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The same commands as the "generated files" job in .github/workflows/test.yml (tests/merge-check.test.mjs compares them).
export const CHECKS = [
  { label: 'board bundle', command: 'npx', args: ['--yes', 'bun@1.4.2', 'scripts/build-board.ts', '--check'] },
  { label: 'released files table', command: 'npx', args: ['--yes', 'bun@1.4.2', 'scripts/build-released.ts', '--check'] },
]

const maxBuffer = 64 * 1024 * 1024
const short = sha => String(sha).slice(0, 8)
const tail = (text, lines = 20) => String(text ?? '').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n')

// The output of `git rev-parse --local-env-vars` (git 2.47): the variables that tie a git call to one repository.
// An inherited one would make every call from the temporary worktree act on the caller's checkout instead.
const GIT_LOCAL_VARS = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY', 'GIT_DIR',
  'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR',
])

// One environment for every git call and every check: no repository-local variable, and hooks pointed at an empty folder
// (a failing hook of the checkout or of the global config must not decide the verdict). Git finds its repository from cwd.
const cleanEnv = (env, hooksDir) => {
  const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !GIT_LOCAL_VARS.has(key.toUpperCase())))
  return hooksDir ? { ...kept, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooksDir } : kept
}

const isAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}
const deadPid = text => (text ? !isAlive(Number(text)) : false)

// npx is a .cmd file on Windows and needs a shell; the arguments are fixed constants, never user input.
const runCheckCommand = (run, check, cwd, env) => {
  const options = { cwd, env, encoding: 'utf8', maxBuffer, timeout: 600000 }
  if (check.command === 'npx' && process.platform === 'win32') {
    const npx = join(dirname(process.execPath), 'npx.cmd')
    return run(`"${existsSync(npx) ? npx : 'npx.cmd'}" ${check.args.join(' ')}`, [], { ...options, shell: true })
  }
  return run(check.command, check.args, options)
}

// Registered worktrees, by folder name; null when git cannot say.
const listedWorktrees = git => {
  const listed = git(['worktree', 'list', '--porcelain'])
  return listed.ok ? listed.out.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => line.slice(9)) : null
}

// A hard kill cannot be caught, so every run first removes what runs whose process is gone left behind (never a live one's).
// Returns '' when the sweep ran, else why it could not (a listing that fails must not pass for an empty one).
const sweepStale = git => {
  const refs = git(['for-each-ref', '--format=%(refname)', 'refs/merge-check/'])
  if (!refs.ok) return `could not list earlier runs' refs to tidy: ${tail(refs.err, 3)}`
  const worktrees = listedWorktrees(git)
  if (!worktrees) return 'could not list worktrees to tidy'
  for (const ref of refs.out.split(/\r?\n/).filter(Boolean)) {
    if (deadPid(ref.match(/^refs\/merge-check\/(\d+)-/)?.[1])) git(['update-ref', '-d', ref])
  }
  for (const path of worktrees) {
    if (!deadPid(basename(path).match(/^ab-merge-check-(\d+)-/)?.[1])) continue
    if (!git(['worktree', 'remove', '--force', path]).ok) git(['worktree', 'prune'])
  }
  for (const name of readdirSync(tmpdir())) {
    if (deadPid(name.match(/^ab-merge-hooks-(\d+)-/)?.[1])) rmSync(join(tmpdir(), name), { recursive: true, force: true })
  }
  return ''
}

const removeFolder = path => {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // reported by the caller when the folder is still there
  }
  return existsSync(path)
}

const removeWorktree = (git, dir) => {
  const isListed = () => listedWorktrees(git)?.some(path => basename(path) === basename(dir)) ?? null
  if (isListed() !== false) git(['worktree', 'remove', '--force', dir])
  const listed = isListed()
  const left = listed === false ? [] : [`worktree ${dir} still registered`]
  // Only a folder git no longer knows is ours to delete; a registered one stays for whoever repairs the registration.
  if ((listed === false ? removeFolder(dir) : existsSync(dir))) left.push(`folder ${dir} still on disk`)
  return left
}

// Removes this run's refs, worktree and hooks folder, then checks each is gone; returns what is still there.
const cleanup = (git, state) => {
  const left = []
  for (const name of ['main', 'head']) git(['update-ref', '-d', `${state.space}/${name}`])
  const refs = git(['for-each-ref', '--format=%(refname)', `${state.space}/`])
  if (!refs.ok || refs.out) left.push(`refs under ${state.space}/`)
  if (state.dir) left.push(...removeWorktree(git, state.dir))
  if (state.hooksDir && removeFolder(state.hooksDir)) left.push(`folder ${state.hooksDir} still on disk`)
  return left
}

const active = new Set()

export const runMergeCheck = ({ pr, head, cwd = process.cwd(), remote = 'origin', checks = CHECKS, run = spawnSync, log = console.log, env = process.env } = {}) => {
  const result = { ok: false, reason: '', mainSha: '', headSha: '' }
  // main and the head go to refs of this run alone, in one fetch: FETCH_HEAD is shared by every fetch in this
  // checkout, so another fetch between two reads could make the head pass for main (#1438).
  const state = { space: `refs/merge-check/${process.pid}-${randomBytes(4).toString('hex')}`, dir: '', hooksDir: '' }
  const sources = { main: 'refs/heads/main', head: `refs/pull/${pr}/head` }
  const git = (args, where = cwd) => {
    const done = run('git', args, { cwd: where, env: cleanEnv(env, state.hooksDir), encoding: 'utf8', maxBuffer })
    const ok = !done.error && done.status === 0
    return { ok, out: String(done.stdout ?? '').trim(), err: done.error ? done.error.message : String(done.stderr ?? '').trim() }
  }

  const fetchRefs = () => {
    // build-released.ts --check reads the release tags, which CI's full-history checkout has; never overwrite a local tag.
    const tags = git(['fetch', '--no-tags', remote, 'refs/tags/agent-board--v*:refs/tags/agent-board--v*'])
    if (!tags.ok) return `could not fetch the release tags from ${remote}: ${tail(tags.err, 3)}`
    const fetched = git(['fetch', '--no-tags', remote, `+${sources.main}:${state.space}/main`, `+${sources.head}:${state.space}/head`])
    if (!fetched.ok) return `could not fetch main and pull/${pr}/head from ${remote}: ${tail(fetched.err, 3)}`
    for (const name of ['main', 'head']) {
      const parsed = git(['rev-parse', '--verify', `${state.space}/${name}^{commit}`])
      if (!parsed.ok || !/^[0-9a-f]{40}$/.test(parsed.out)) return `could not read the fetched ${sources[name]}`
      result[`${name}Sha`] = parsed.out
    }
    return result.headSha === head ? '' : `the pull request's head is now ${short(result.headSha)}, not ${short(head)}`
  }

  const mergeHead = () => {
    state.dir = mkdtempSync(join(tmpdir(), `ab-merge-check-${process.pid}-`))
    const created = git(['worktree', 'add', '--detach', state.dir, result.mainSha])
    if (!created.ok) return `could not create a worktree on main: ${tail(created.err, 3)}`
    // git merge asks for an identity even with --no-commit; CI and fresh accounts have none, and nothing is committed here.
    const merged = git(['-c', 'user.name=merge-check', '-c', 'user.email=merge-check@invalid', 'merge', '--no-commit', '--no-ff', result.headSha], state.dir)
    if (merged.ok) return ''
    const conflicts = git(['diff', '--name-only', '--diff-filter=U'], state.dir)
    git(['merge', '--abort'], state.dir)
    const files = conflicts.ok ? conflicts.out.split(/\r?\n/).filter(Boolean).join(', ') : ''
    return files ? `conflict with main: ${files}` : `the merge with main failed: ${tail(merged.err || merged.out, 3)}`
  }

  const runChecks = () => {
    for (const check of checks) {
      const done = runCheckCommand(run, check, state.dir, cleanEnv(env, state.hooksDir))
      if (done.error || done.status !== 0) {
        log(tail(`${done.stdout ?? ''}\n${done.stderr ?? ''}${done.error ? `\n${done.error.message}` : ''}`))
        return `${check.label} failed`
      }
    }
    return ''
  }

  // The head can move while the checks run; what passed must still be what the remote holds.
  const headStillApproved = () => {
    const again = git(['ls-remote', remote, sources.head])
    const sha = again.out.split(/\s+/)[0]
    if (!again.ok || !/^[0-9a-f]{40}$/.test(sha)) return `could not read pull/${pr}/head from ${remote} after the checks`
    return sha === result.headSha ? '' : `the pull request's head moved to ${short(sha)} while the checks ran`
  }

  const inspect = () => {
    state.hooksDir = mkdtempSync(join(tmpdir(), `ab-merge-hooks-${process.pid}-`))
    return sweepStale(git) || fetchRefs() || mergeHead() || runChecks() || headStillApproved()
  }

  const stop = () => cleanup(git, state)
  active.add(stop)
  let reason
  try {
    reason = inspect()
  } catch (error) {
    reason = `unexpected error: ${error.message}`
  }
  const left = stop()
  active.delete(stop)
  if (left.length) reason = [reason, `cleanup left behind: ${left.join('; ')}`].filter(Boolean).join('; ')
  result.reason = reason
  result.ok = reason === ''
  log(result.ok ? `PASS merge-check #${pr}: head ${short(result.headSha)} merged onto main ${short(result.mainSha)}; ${checks.map(check => check.label).join(', ')} current` : `FAIL merge-check #${pr}: ${reason}`)
  return result
}

const usage = 'usage: node scripts/merge-check.mjs <pr-number> --head <full 40-hex sha>'

// Returns the exit code: 0 pass, 1 fail, 2 usage. The options are runMergeCheck's (tests inject checks and a git runner).
export const main = (argv, { error = console.error, ...options } = {}) => {
  const pr = argv[0]
  const at = argv.indexOf('--head')
  const head = at > 0 ? argv[at + 1] : undefined
  if (argv.length !== 3 || at !== 1 || !/^[1-9]\d*$/.test(pr ?? '') || !/^[0-9a-f]{40}$/.test(head ?? '')) {
    error(usage)
    return 2
  }
  return runMergeCheck({ pr, head, ...options }).ok ? 0 : 1
}

// A signal is handled once the event loop turns, which is after the synchronous git and check calls return;
// Ctrl-C also reaches the running check, so it ends early and the cleanup runs here at the latest.
const stopOn = (signal, code) => process.on(signal, () => {
  for (const stop of active) stop()
  process.exit(code)
})

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stopOn('SIGINT', 130)
  stopOn('SIGTERM', 143)
  process.exitCode = main(process.argv.slice(2))
}
