import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

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
