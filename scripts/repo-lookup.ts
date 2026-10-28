// The repository a worktree folder belongs to, found by reading the folder's `.git` file and its
// `commondir` (no git process). It takes only node: modules, the name rule and the clock, so a
// test can run it with a fake clock instead of waiting out the 30 seconds.
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

const REPO_RETRY = 30 * 1000

export const repoLookup = (nameOf: (dir: string, gitFile: string, commonDir: string) => string | null, now = Date.now): ((dir: string) => string | null) => {
  const repos = new Map<string, { repo: string | null; at: number }>()

  return dir => {
    const known = repos.get(dir)
    const at = now()
    // Both hits and misses expire because repositories can move while the page stays open.
    if (known !== undefined && at - known.at < REPO_RETRY) return known.repo
    let repo: string | null = null
    try {
      if (!isAbsolute(dir)) throw new Error('a folder the file names without its full path')
      const gitFile = readFileSync(join(dir, '.git'), 'utf8')
      const first = gitFile.split(/\r?\n/, 1)[0]?.trim() ?? ''
      const named = /^gitdir:\s*(.+)$/i.exec(first)?.[1]?.trim()
      if (named !== undefined) {
        const gitDir = isAbsolute(named) ? named : resolve(dir, named.replace(/[\\/]/g, sep))
        const commonDir = readFileSync(join(gitDir, 'commondir'), 'utf8')
        const common = commonDir.trim().replace(/[\\/]/g, sep)
        const commonGit = isAbsolute(common) ? common : resolve(gitDir, common)
        if (statSync(dirname(commonGit)).isDirectory()) repo = nameOf(dir, gitFile, commonDir)
      }
    } catch {}
    repos.set(dir, { repo, at })
    return repo
  }
}
