import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(new URL('..', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { parseProgress, progressTail } = await import('../hooks/parse.ts')
const { reporterProgressTail, reporterTail } = await import('../scripts/reporter-tail.ts')
loader.deregister()

const cut = '<!-- /auto se'
const prefix = '## Synthetic\n### Earlier\n- [ ] Keep\n'

test('a cut marker that only task lines follow warns that tasks may be hidden', () => {
  for (const end of ['- [ ] map a --> b', '-->']) {
    const source = `${prefix}${cut}\n### Hidden\n- [ ] Keep this task\n${end}\n`
    assert.deepEqual(progressTail(source), { offset: prefix.length, tasks: 1, close: null })
    assert.deepEqual(parseProgress(source).flatMap(project => project.tasks.map(task => task.title)), ['Earlier'])
  }
})

test('an ordinary comment that hides tasks and does not start like a marker shows no warning', () => {
  for (const opening of ['<!-- old work', '<!--', '<!-- auto archive of old work']) {
    const source = `${prefix}${opening}\n### Hidden\n- [ ] Keep\n-->\n`
    assert.equal(progressTail(source), null)
    assert.deepEqual(parseProgress(source).flatMap(project => project.tasks.map(task => task.title)), ['Earlier'])
  }
  assert.equal(progressTail(`${prefix}\u0060\u0060\u0060\n${cut}\n### Example\n-->\n\u0060\u0060\u0060\n`), null)
  assert.equal(progressTail(`${prefix}${cut}\nNo task is hidden\n-->\n`), null)
})

test('the reporter and the board agree on a cut tail when a heading uses a non-breaking space', () => {
  for (const space of ['\u00a0', '\u2003', '\t']) {
    const source = `${prefix}<!-- auto se\n##${space}Later\n### Hidden\n-->\n`
    const bytes = Buffer.from(source)
    const board = progressTail(source)
    assert.ok(board)
    assert.deepEqual(reporterProgressTail(bytes), { ...board, offset: Buffer.byteLength(source.slice(0, board.offset)) })
    // Content after a cut is never trimmed as if it were a whitespace-only tail.
    const repaired = reporterTail(bytes)
    assert.deepEqual(repaired.bytes, bytes)
    assert.equal(repaired.fragment, null)
  }
})

test('repairing a cut tail preserves multibyte and malformed UTF-8 before its byte boundary', () => {
  for (const eol of ['\n', '\r\n']) {
    const before = Buffer.concat([Buffer.from(`## 合成${eol}### Keep${eol}- [ ] 𠮷`), Buffer.from([0xff]), Buffer.from(eol)])
    const tail = Buffer.from(`<!-- auto se${eol}  ${eol}`)
    const original = Buffer.concat([before, tail])
    assert.equal(reporterProgressTail(original).offset, before.length)
    const repaired = reporterTail(original)
    assert.deepEqual(repaired.bytes, before)
    assert.deepEqual(repaired.fragment, tail)
    assert.equal(progressTail(repaired.bytes.toString('utf8')), null)
  }
})

const fragment = (state, updated) => `## Synthetic\n<!-- auto session=1234abcd agent=muse state=${state} updated=${updated} -->\n### Synthetic work\n- [${state === 'done' ? 'x' : ' '}] A step\n<!-- /auto session=1234abcd -->\n`
const python = process.platform === 'win32' ? 'python' : 'python3'
const mergeScript = join(root, 'scripts/remote-reporter/merge.py')
const cli = (board, files) => spawnSync(python, ['-B', mergeScript, board, ...files], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
const fixture = action => {
  const dir = mkdtempSync(join(tmpdir(), 'report-clock-'))
  try { action(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('merge.py refuses a working block whose clock is weeks behind and writes nothing', () => fixture(dir => {
  for (const state of ['working', 'waiting']) for (const existing of [true, false]) {
    const board = join(dir, 'progress.md')
    if (existing) writeFileSync(board, '## Existing\r\n### Hand task\r\n- [ ] Keep\r\n')
    else rmSync(board, { force: true })
    const input = join(dir, 'fragment.md')
    writeFileSync(input, fragment(state, '2000-01-01T00:00:00Z'))
    const before = readdirSync(dir).sort()
    const result = cli(board, [input])
    assert.equal(result.error, undefined)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /more than three days old/)
    assert.deepEqual(readdirSync(dir).sort(), before)
    if (existing) assert.equal(readFileSync(board, 'utf8'), '## Existing\r\n### Hand task\r\n- [ ] Keep\r\n')
  }
}))

test('merge.py still merges a done block with an old clock', () => fixture(dir => {
  for (const state of ['done', 'ended']) {
    const board = join(dir, `${state}.md`)
    const input = join(dir, 'history.md')
    writeFileSync(input, fragment(state, '2000-01-01T00:00:00Z'))
    const result = cli(board, [input])
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(readFileSync(board, 'utf8').includes(`state=${state}`))
  }
}))

test('merge.py refuses a future report and validates every fragment before writing the batch', () => fixture(dir => {
  const board = join(dir, 'progress.md')
  writeFileSync(board, '## Existing\n')
  const current = join(dir, 'current.md')
  const future = join(dir, 'future.md')
  writeFileSync(current, fragment('done', '2000-01-01T00:00:00Z'))
  writeFileSync(future, fragment('done', '9999-01-01T00:00:00Z').replaceAll('1234abcd', 'abcd1234'))
  const result = cli(board, [current, future])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /dated in the future/)
  assert.equal(readFileSync(board, 'utf8'), '## Existing\n')
  assert.deepEqual(readdirSync(dir).sort(), ['current.md', 'future.md', 'progress.md'])
}))

test('the remote live-report age limit accepts exactly three days and rejects the next instant', () => {
  const code = `import sys, json
from datetime import datetime, timezone
sys.path.insert(0, sys.argv[1])
import merge
now = datetime(2026, 10, 20, tzinfo=timezone.utc)
results = []
for text in json.loads(sys.stdin.read()):
    try:
        merge.merge_text('', [text], now=now)
        results.append(True)
    except ValueError:
        results.append(False)
print(json.dumps(results))`
  const result = spawnSync(python, ['-B', '-c', code, dirname(mergeScript)], {
    encoding: 'utf8', timeout: 10_000,
    input: JSON.stringify(['2026-10-17T00:00:00Z', '2026-10-16T23:59:59.999Z', '2026-10-17T02:00:00+02:00'].map(at => fragment('working', at))),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [true, false, true])
})
