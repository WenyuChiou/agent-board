// Writes hooks/released.ts, the SHA-256 of every file each release of Agent Board generated,
// so a file an earlier release wrote, before the plugin kept a record of its output, is still
// known as ours (`isReleased` in hooks/connect.ts). Each release's own hooks/ come from its git
// tag agent-board--v<version> and run here with synthetic paths; the version in plugin.json,
// until it is tagged, comes from this tree. It also writes tests/fixtures/released.ts, what
// 0.20.5 and 0.18.1 wrote, for the upgrade tests. Run with Bun at each release, after raising
// the version: `bun scripts/build-released.ts`. `--check` fails when either file is out of
// date (CI runs it, with the tags fetched).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RELEASE_PATHS } from '../hooks/connect'
import { sha256 } from '../hooks/sha256'

const root = join(import.meta.dir, '..')
const PREFIX = 'agent-board--v'
const KINDS = ['board', 'skill', 'gemini', 'opencode', 'reporterSh', 'reporterPs1'] as const
type Kind = (typeof KINDS)[number]
type Output = { texts: Record<Kind, string[]>; fixed: Map<string, string> }

// Temp folders to take away even when a check fails part way through a release.
const temps = new Set<string>()
const fail = (message: string): never => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  console.error(message)
  process.exit(1)
}
const git = (...args: string[]): Buffer => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
const byVersion = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true })

// A hash both ways: the table is read by the pure one, so the two must agree on every text.
const hashOf = (text: string): string => {
  const hash = createHash('sha256').update(text, 'utf8').digest('hex')
  if (sha256(text) !== hash) fail(`hooks/sha256.ts disagrees with node:crypto on a ${text.length}-character text`)
  return hash
}

// Two synthetic machines on each system: a template is only a template if it comes out the
// same on both, once the board's and the inbox's paths are swapped for the placeholders.
const MACHINES = [false, true].flatMap(isWindows =>
  ['synthetic-a', 'synthetic-b'].map(user => {
    const sep = isWindows ? '\\' : '/'
    const home = isWindows ? `C:\\Users\\${user}` : `/home/${user}`
    const base = [home, '.claude'].join(sep)
    return {
      name: `${isWindows ? 'windows' : 'posix'} ${user}`,
      system: isWindows ? 'windows' : 'posix',
      ctx: {
        home,
        sep,
        isWindows,
        script: [base, `progress-report.${isWindows ? 'ps1' : 'sh'}`].join(sep),
        inbox: [base, 'progress-inbox'].join(sep),
        codexHome: [home, '.codex'].join(sep),
        grokHome: [home, '.grok'].join(sep),
        hermesHome: [home, '.hermes'].join(sep),
        openclawHome: [home, '.openclaw'].join(sep),
        board: [base, 'agent-board.mjs'].join(sep),
      },
    }
  }),
)

// The paths each kind's caller in hooks/ swaps back: a placeholder left in any other kind's
// text would never match on a real machine.
const SWAPPED: Record<Kind, readonly string[]> = {
  board: [],
  skill: [RELEASE_PATHS.board],
  gemini: [RELEASE_PATHS.board],
  opencode: [RELEASE_PATHS.board],
  reporterSh: [RELEASE_PATHS.inbox],
  reporterPs1: [RELEASE_PATHS.inbox],
}

const outputsOf = async (dir: string, label: string): Promise<Output> => {
  const load = (file: string) => import(pathToFileURL(join(dir, 'hooks', file)).href)
  const connect = await load('connect.ts')
  const { STRINGS } = await load('strings.ts')
  const { BOARD_SCRIPT } = await load('board-script.ts')
  const texts: Record<Kind, string[]> = { board: [BOARD_SCRIPT], skill: [], gemini: [], opencode: [], reporterSh: [], reporterPs1: [] }
  const fixed = new Map<string, string>()
  const seen = new Map<string, string>()
  const add = (kind: Kind, key: string, text: string) => {
    const before = seen.get(key)
    if (before !== undefined && before !== text) fail(`${label}: ${key} does not come out the same on every machine once its paths are swapped`)
    for (const placeholder of Object.values(RELEASE_PATHS)) {
      if (text.includes(placeholder) && !SWAPPED[kind].includes(placeholder)) fail(`${label}: ${key} holds a path its caller in hooks/ does not swap back`)
    }
    seen.set(key, text)
    if (!texts[kind].includes(text)) texts[kind].push(text)
  }
  const swap = (text: string, ctx: { board: string; inbox: string }) => text.split(ctx.board).join(RELEASE_PATHS.board).split(ctx.inbox).join(RELEASE_PATHS.inbox)
  for (const { name, system, ctx } of MACHINES) {
    add('reporterSh', 'reporterSh', swap(connect.reporterSh(ctx.inbox), ctx))
    add('reporterPs1', 'reporterPs1', swap(connect.reporterPs1(ctx.inbox), ctx))
    for (const [lang, s] of Object.entries(STRINGS)) {
      for (const hook of connect.agentHooks({ ...ctx, s })) {
        const text = hook.edit('', false)
        if (typeof text !== 'string') continue
        const file: string = hook.file
        const ending = (...parts: string[]) => file.endsWith(parts.join(ctx.sep))
        if (ending('', 'SKILL.md')) add('skill', `skill ${lang} ${hook.agent}`, swap(text, ctx))
        else if (ending('commands', 'board.toml')) add('gemini', `gemini ${lang}`, swap(text, ctx))
        else if (ending('commands', 'board.md')) add('opencode', `opencode ${lang}`, swap(text, ctx))
        else if (ending('hooks', 'agent-board.json') || ending('plugin', 'agent-board.js') || ending('.openclaw', 'agent-board.mjs')) fixed.set(`${system} ${name} ${file.slice(ctx.home.length)}`, text)
        // A generated file of a kind this script does not know would go unchecked, and an
        // installation from before the record would find it foreign.
        else if (hook.generated === true) fail(`${label}: ${file.slice(ctx.home.length)} is generated but neither in the table nor checked as fixed: add it in scripts/build-released.ts`)
      }
    }
  }
  return { texts, fixed }
}

const atTag = async (version: string): Promise<Output> => {
  const tag = `${PREFIX}${version}`
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-release-'))
  temps.add(dir)
  try {
    for (const file of git('ls-tree', '-r', '--name-only', tag, 'hooks').toString('utf8').split('\n').filter(Boolean)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), git('show', `${tag}:${file}`))
    }
    return await outputsOf(dir, tag)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    temps.delete(dir)
  }
}

// The releases this tree comes from; in the middle of a merge, those of both sides.
const isMerging = (() => {
  try {
    git('rev-parse', '-q', '--verify', 'MERGE_HEAD')
    return true
  } catch {
    return false
  }
})()
const version: string = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version
const tagged = [...new Set(['HEAD', ...(isMerging ? ['MERGE_HEAD'] : [])].flatMap(head => git('tag', '--merged', head, '--list', `${PREFIX}*`).toString('utf8').split('\n')))]
  .filter(Boolean)
  .map(tag => tag.slice(PREFIX.length))
  .sort(byVersion)
if (!tagged.includes('0.20.5')) fail('the agent-board--v* tags are not here: fetch them (`git fetch --tags`) and run again')

const releases = new Map<string, Output>()
for (const one of tagged) releases.set(one, await atTag(one))
const current = await outputsOf(root, 'this tree')
if (!releases.has(version)) releases.set(version, current)

// The files this table does not cover must be what this tree writes, in every release, or an
// installation from before the record would find its own file foreign. A change to one of them
// means adding it to KINDS (and to `isReleased`'s callers) first.
for (const [one, output] of releases) {
  for (const [key, text] of output.fixed) {
    if (current.fixed.get(key) !== text) fail(`${key} differs between ${one} and this tree: add that file to the table in scripts/build-released.ts`)
  }
}

const list = (hashes: string[]) => `[${hashes.map(hash => `'${hash}'`).join(', ')}]`
const table = [...releases]
  .sort(([a], [b]) => byVersion(a, b))
  .map(([one, output]) => `  {\n    version: '${one}',\n${KINDS.map(kind => `    ${kind}: ${list(output.texts[kind].map(hashOf))},`).join('\n')}\n  },`)
  .join('\n')
const released = `// Generated by scripts/build-released.ts from the git tags agent-board--v*; do not edit by hand.
// For each release, the SHA-256 of each file it generated: the board script from its second
// line on, and the rest with the board's and the inbox's paths as RELEASE_PATHS has them
// (hooks/connect.ts).
export type ReleasedKind = ${KINDS.map(kind => `'${kind}'`).join(' | ')}

export const RELEASED: readonly ({ version: string } & Record<ReleasedKind, readonly string[]>)[] = [
${table}
]
`

const fixture = (one: string, isBoard: boolean): string => {
  const output = releases.get(one) ?? fail(`no release ${one}`)
  const commands = (kind: 'skill' | 'gemini' | 'opencode') => `[${output.texts[kind].map(text => JSON.stringify(text)).join(', ')}]`
  return `export const RELEASE_${one.replaceAll('.', '_')} = {\n${isBoard ? `  board: ${JSON.stringify(output.texts.board[0])},\n` : ''}  skill: ${commands('skill')},\n  gemini: ${commands('gemini')},\n  opencode: ${commands('opencode')},\n  reporterSh: ${JSON.stringify(output.texts.reporterSh[0])},\n  reporterPs1: ${JSON.stringify(output.texts.reporterPs1[0])},\n}\n`
}
const fixtures = `// Generated by scripts/build-released.ts from the git tags agent-board--v0.20.5 and
// agent-board--v0.18.1; do not edit by hand. What those releases wrote, for the upgrade tests:
// 0.20.5's board script from its second line on, and each one's board commands and skill (one
// per language) and reporters, with the board's and the inbox's paths as RELEASE_PATHS has them.
${fixture('0.20.5', true)}
${fixture('0.18.1', false)}`

const targets: [string, string][] = [
  [join(root, 'hooks', 'released.ts'), released],
  [join(root, 'tests', 'fixtures', 'released.ts'), fixtures],
]
if (process.argv.includes('--check')) {
  for (const [target, text] of targets) {
    let held = ''
    try {
      held = readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
    } catch {}
    if (held !== text) fail(`${target.slice(root.length + 1)} is out of date: run \`bun scripts/build-released.ts\``)
  }
} else {
  for (const [target, text] of targets) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
  console.log(`wrote hooks/released.ts (${releases.size} releases, ${tagged.length} tagged) and tests/fixtures/released.ts`)
}
