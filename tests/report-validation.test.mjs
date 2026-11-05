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
const { STRINGS } = await import('../hooks/strings.ts')
loader.deregister()

const fragment = (state, updated) => `## Synthetic\n<!-- auto session=1234abcd agent=muse state=${state} updated=${updated} -->\n### Synthetic work\n- [${state === 'done' ? 'x' : ' '}] A step\n<!-- /auto session=1234abcd -->\n`
const python = process.platform === 'win32' ? 'python' : 'python3'
const mergeScript = join(root, 'scripts/remote-reporter/merge.py')
const cli = (board, files, lang = 'en_US.UTF-8') => spawnSync(python, ['-B', mergeScript, board, ...files], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', LANG: lang, LC_ALL: '', LC_MESSAGES: '' } })
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


test('an omitted state uses the waiting age limit and rejects the whole batch without writes', () => fixture(dir => {
  for (const existing of [true, false]) {
    const board = join(dir, 'progress.md')
    const beforeText = '## Existing\r\n### Keep\r\n- [ ] Hand work\r\n'
    if (existing) writeFileSync(board, beforeText)
    else rmSync(board, { force: true })
    const valid = join(dir, 'valid.md')
    const stale = join(dir, 'stale.md')
    writeFileSync(valid, fragment('done', '2000-01-01T00:00:00Z').replaceAll('1234abcd', 'abcd1234'))
    writeFileSync(stale, fragment('waiting', '2000-01-01T00:00:00Z').replace(' state=waiting', ''))
    const before = readdirSync(dir).sort()
    const result = cli(board, [valid, stale])
    assert.equal(result.error, undefined)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /more than three days old/)
    assert.deepEqual(readdirSync(dir).sort(), before)
    if (existing) assert.equal(readFileSync(board, 'utf8'), beforeText)
  }
}))

test('rapid reporter updates and retirement merge under the same clock at every part of a second', () => {
  const code = `import contextlib, io, json, os, sys, tempfile
from datetime import datetime, timezone
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import merge, reporter
results = []
for micros in (0, 500000, 999999):
    now = datetime(2026, 11, 1, 20, 0, 0, micros, tzinfo=timezone.utc)
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return now
    with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {'AGENT_BOARD_REMOTE_DIR': home, 'BOARD_PROJECT': 'Synthetic'}), patch.object(reporter, 'datetime', Clock), patch.object(merge, 'datetime', Clock), contextlib.redirect_stdout(io.StringIO()):
        steps = os.path.join(home, 'steps.txt')
        with open(steps, 'w', encoding='utf-8') as f:
            f.write('- Check synthetic work\\n')
        board = os.path.join(home, 'progress.md')
        stamps = []
        for index in range(12):
            reporter.cmd_update('synthetic-chat', 'waiting', f'Synthetic update {index}', steps)
            frag = reporter.fragment_path(reporter.session_for('synthetic-chat'))
            merge.merge_file(board, [frag])
            text = reporter.read_text(frag)
            assert reporter.read_text(board).endswith(text.split('\\n', 2)[2])
            _, lines = reporter.fragment_parts(text)
            stamps.append(merge.updated_time(lines[0]))
        reporter.cmd_retire('synthetic-chat', 'Synthetic work stopped')
        merge.merge_file(board, [frag])
        assert 'state=ended' in reporter.read_text(board)
        _, ended = reporter.fragment_parts(reporter.read_text(frag))
        stamps.append(merge.updated_time(ended[0]))
        assert all(a < b for a, b in zip(stamps, stamps[1:]))
        assert all(stamp.replace(microsecond=0) <= now.replace(microsecond=0) for stamp in stamps)
        results.append([stamp.isoformat() for stamp in stamps])
print(json.dumps(results))`
  const result = spawnSync(python, ['-B', '-c', code, dirname(mergeScript)], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const histories = JSON.parse(result.stdout)
  assert.equal(histories.length, 3)
  for (const stamps of histories) {
    assert.equal(stamps.length, 13)
    // The board reads instants with Date.parse, which must distinguish every reporter update too.
    const instants = stamps.map(stamp => Date.parse(stamp))
    assert.ok(instants.every(Number.isFinite))
    assert.ok(instants.every((instant, index) => index === 0 || instant > instants[index - 1]))
  }
})

test('the future guard accepts current-second ordering but refuses the next UTC second', () => {
  const code = `import sys, json
from datetime import datetime, timezone
sys.path.insert(0, sys.argv[1])
import merge
now = datetime(2026, 11, 1, 20, 0, 0, tzinfo=timezone.utc)
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
    input: JSON.stringify(['2026-11-01T20:00:00.999999Z', '2026-11-01T20:00:01Z', '2026-11-01T21:00:01+01:00'].map(at => fragment('waiting', at))),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [true, false, false])
})

test('remote clock errors are generated from all three string tables and delivered in the CLI language', () => fixture(dir => {
  const generated = JSON.parse(readFileSync(join(dirname(mergeScript), 'strings.json'), 'utf8'))
  const expected = Object.fromEntries(Object.entries(STRINGS).map(([lang, s]) => [lang, { remoteReportFuture: s.remoteReportFuture, remoteReportStale: s.remoteReportStale }]))
  assert.deepEqual(generated, expected)
  for (const [locale, lang] of [['en_US.UTF-8', 'en'], ['zh_TW.UTF-8', 'zh-TW'], ['zh_CN.UTF-8', 'zh-CN']]) {
    for (const [key, stamp] of [['remoteReportFuture', '9999-01-01T00:00:00Z'], ['remoteReportStale', '2000-01-01T00:00:00Z']]) {
      const board = join(dir, 'progress.md')
      writeFileSync(board, '## Existing\r\n')
      const input = join(dir, 'fragment.md')
      writeFileSync(input, fragment('waiting', stamp))
      const before = readdirSync(dir).sort()
      const result = cli(board, [input], locale)
      assert.equal(result.error, undefined)
      assert.notEqual(result.status, 0)
      assert.ok(STRINGS[lang][key], `${lang}/${key}`)
      assert.ok(result.stderr.includes(STRINGS[lang][key]), result.stderr)
      assert.equal(readFileSync(board, 'utf8'), '## Existing\r\n')
      assert.deepEqual(readdirSync(dir).sort(), before)
    }
  }
}))
