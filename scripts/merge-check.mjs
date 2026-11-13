import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The same commands as the "generated files" job in .github/workflows/test.yml (tests/merge-check.test.mjs compares them).
export const CHECKS = [
  { label: 'board bundle', command: 'npx', args: ['--yes', 'bun@1.4.2', 'scripts/build-board.ts', '--check'] },
  { label: 'released files table', command: 'npx', args: ['--yes', 'bun@1.4.2', 'scripts/build-released.ts', '--check'] },
]

const maxBuffer = 64 * 1024 * 1024
const short = sha => String(sha).slice(0, 8)
const tail = (text, lines = 20) => String(text ?? '').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n')

// npx is a .cmd file on Windows and needs a shell; the arguments are fixed constants, never user input.
const runCheckCommand = (run, check, cwd) => {
  const options = { cwd, encoding: 'utf8', maxBuffer, timeout: 600000 }
  if (check.command === 'npx' && process.platform === 'win32') {
    const npx = join(dirname(process.execPath), 'npx.cmd')
    return run(`"${existsSync(npx) ? npx : 'npx.cmd'}" ${check.args.join(' ')}`, [], { ...options, shell: true })
  }
  return run(check.command, check.args, options)
}

export const runMergeCheck = ({ pr, head, cwd = process.cwd(), remote = 'origin', checks = CHECKS, run = spawnSync, log = console.log } = {}) => {
  const result = { ok: false, reason: '', mainSha: '', headSha: '' }
  const finish = reason => {
    result.reason = reason
    log(result.ok ? `PASS merge-check #${pr}: head ${short(result.headSha)} merged onto main ${short(result.mainSha)}; ${checks.map(check => check.label).join(', ')} current` : `FAIL merge-check #${pr}: ${reason}`)
    return result
  }
  const git = (args, where = cwd) => {
    const done = run('git', args, { cwd: where, encoding: 'utf8', maxBuffer })
    const ok = !done.error && done.status === 0
    return { ok, out: String(done.stdout ?? '').trim(), err: done.error ? done.error.message : String(done.stderr ?? '').trim() }
  }
  const fetchSha = ref => {
    const fetched = git(['fetch', '--no-tags', remote, ref])
    if (!fetched.ok) return { error: `could not fetch ${ref} from ${remote}: ${tail(fetched.err, 3)}` }
    const parsed = git(['rev-parse', 'FETCH_HEAD'])
    if (!parsed.ok || !/^[0-9a-f]{40}$/.test(parsed.out)) return { error: `could not read FETCH_HEAD after fetching ${ref}` }
    return { sha: parsed.out }
  }

  // build-released.ts --check reads the release tags, which CI's full-history checkout has; never overwrite a local tag.
  const tags = git(['fetch', '--no-tags', remote, 'refs/tags/agent-board--v*:refs/tags/agent-board--v*'])
  if (!tags.ok) return finish(`could not fetch the release tags from ${remote}: ${tail(tags.err, 3)}`)
  const main = fetchSha('main')
  if (main.error) return finish(main.error)
  result.mainSha = main.sha
  const fetchedHead = fetchSha(`pull/${pr}/head`)
  if (fetchedHead.error) return finish(fetchedHead.error)
  result.headSha = fetchedHead.sha
  if (result.headSha !== head) return finish(`the pull request's head is now ${short(result.headSha)}, not ${short(head)}`)

  let dir
  let added = false
  try {
    dir = mkdtempSync(join(tmpdir(), 'ab-merge-check-'))
    const created = git(['worktree', 'add', '--detach', dir, result.mainSha])
    if (!created.ok) return finish(`could not create a worktree on main: ${tail(created.err, 3)}`)
    added = true
    // git merge asks for an identity even with --no-commit; CI and fresh accounts have none, and nothing is committed here.
    const merged = git(['-c', 'user.name=merge-check', '-c', 'user.email=merge-check@invalid', 'merge', '--no-commit', '--no-ff', result.headSha], dir)
    if (!merged.ok) {
      const conflicts = git(['diff', '--name-only', '--diff-filter=U'], dir)
      git(['merge', '--abort'], dir)
      const files = conflicts.ok ? conflicts.out.split(/\r?\n/).filter(Boolean).join(', ') : ''
      return finish(files ? `conflict with main: ${files}` : `the merge with main failed: ${tail(merged.err || merged.out, 3)}`)
    }
    for (const check of checks) {
      const done = runCheckCommand(run, check, dir)
      if (done.error || done.status !== 0) {
        log(tail(`${done.stdout ?? ''}\n${done.stderr ?? ''}${done.error ? `\n${done.error.message}` : ''}`))
        return finish(`${check.label} failed`)
      }
    }
    result.ok = true
    return finish('')
  } finally {
    if (added) {
      const removed = git(['worktree', 'remove', '--force', dir])
      if (!removed.ok) {
        git(['worktree', 'prune'])
        log(`could not remove the temporary worktree; leftover folder: ${dir}`)
      }
    }
  }
}

const usage = 'usage: node scripts/merge-check.mjs <pr-number> --head <full 40-hex sha>'

const main = () => {
  const args = process.argv.slice(2)
  const pr = args[0]
  const at = args.indexOf('--head')
  const head = at > 0 ? args[at + 1] : undefined
  if (args.length !== 3 || at !== 1 || !/^[1-9]\d*$/.test(pr ?? '') || !/^[0-9a-f]{40}$/.test(head ?? '')) {
    console.error(usage)
    process.exitCode = 2
    return
  }
  process.exitCode = runMergeCheck({ pr, head }).ok ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
