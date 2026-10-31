// Bundles scripts/board-cli.ts and the pure modules it uses into one plain JavaScript file and keeps it as
// strings in hooks/board-script.ts and its parts (hooks/board-script-1.ts, ...) for `/progress connect` to
// write out. The parts exist because Claude Code does not load a module over 1 MiB (#582). Run with Bun
// after changing any of them: `bun scripts/build-board.ts`. `--check` fails when the kept copy is out of
// date, a part is stale or missing from package.json, or a module is too big (CI runs it).
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { RELEASED } from '../hooks/released'
import { bundleFromDir, bundleFromRef } from './bundle-text.mjs'
import { bundleModules, missingFromPackage, moduleBudget, staleParts } from './bundle-parts.mjs'

// Each part after the first starts at this module banner line; boundaries move only when a maintainer edits this
// list. An entry must be a line that appears once in the bundle: Bun repeats a banner such as `// scripts/board-cli.ts`.
const PART_STARTS = ['// hooks/digest.ts']

const root = join(import.meta.dir, '..')
const version: string = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version
// The native setup worker imports released ownership. Its bundle cannot contain
// its own fingerprint: updating that table would otherwise change the hash again.
// Once a tag exists its hash is frozen. Later source with the same manifest
// version must still recognize that tagged board, even without install records.
const fingerprint = (code: string): string => createHash('sha256').update(code).digest('hex')
const taggedFingerprint = (): string | undefined => {
  const ref = `refs/tags/agent-board--v${version}`
  const probe = spawnSync('git', ['show-ref', '--verify', '--quiet', ref], { cwd: root })
  if (probe.status === 1) return undefined
  if (probe.error || probe.status !== 0) throw new Error('Could not inspect the current release tag')
  const hash = fingerprint(bundleFromRef(root, ref))
  if (!RELEASED.some(release => release.version === version && release.board.includes(hash))) throw new Error('Tagged board is missing from the release table; regenerate it first')
  return hash
}
const compile = async (currentBoard: readonly string[]): Promise<string> => {
  const bundled = RELEASED.map(release => release.version === version ? { ...release, board: currentBoard } : release)
  const built = await Bun.build({
    entrypoints: [join(root, 'scripts', 'board-cli.ts')], target: 'node', format: 'esm',
    plugins: [{
      name: 'released-board-ownership',
      setup(build) {
        build.onLoad({ filter: /[\\/]hooks[\\/]released\.ts$/ }, ({ path }) => {
          if (path !== join(root, 'hooks', 'released.ts')) return
          return { contents: `export const RELEASED = ${JSON.stringify(bundled)}`, loader: 'js' }
        })
      },
    }],
  })
  if (!built.success) throw new AggregateError(built.logs, 'bundling the board failed')
  return built.outputs[0]!.text()
}
const candidate = await compile([])
const tagged = taggedFingerprint()
const code = tagged !== undefined && tagged !== fingerprint(candidate) ? await compile([tagged]) : candidate
const modules: Record<string, string> = bundleModules(code, PART_STARTS)
const isCheck = process.argv.includes('--check')
const problems: string[] = []
const count = (number: number): string => number.toLocaleString('en-US')
const rebuild = 'npx --yes bun@1.4.2 scripts/build-board.ts'
const stale: string[] = staleParts(readdirSync(join(root, 'hooks')), modules)
let isCurrent = true

if (isCheck) {
  for (const [path, text] of Object.entries(modules)) {
    if (!existsSync(join(root, path)) || readFileSync(join(root, path), 'utf8') !== text) {
      problems.push(`${path} is out of date: run \`${rebuild}\``)
      isCurrent = false
    }
  }
  for (const path of stale) {
    problems.push(`${path} is no longer part of the bundle: rebuild, which removes it`)
    isCurrent = false
  }
} else {
  for (const [path, text] of Object.entries(modules)) writeFileSync(join(root, path), text)
  // Generated files this script owns: a part the split no longer makes would be left behind, and shipped.
  for (const path of stale) {
    unlinkSync(join(root, path))
    console.log(`removed ${path} (no longer part of the bundle)`)
  }
  console.log(`wrote ${Object.keys(modules).join(', ')} (${count(code.length)} characters)`)
}
// What a reader decodes from the files on disk must be the bundle that was built.
if (isCurrent && bundleFromDir(root) !== code) problems.push('hooks/board-script*.ts do not read back as the bundle that was built')

const budget = moduleBudget(modules)
for (const { path, lf, crlf } of budget.sizes) console.log(`${path}: ${count(lf)} bytes, ${count(crlf)} with CRLF line endings`)
for (const note of budget.notes) console.log(`note: ${note}`)
problems.push(...budget.problems)
const listed: string[] = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files
const missing: string[] = missingFromPackage(modules, listed)
if (missing.length) problems.push(`package.json "files" must list: ${missing.join(', ')}`)

if (problems.length) {
  for (const problem of problems) console.error(problem)
  process.exit(1)
}
