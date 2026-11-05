import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { askOf } = await import('../hooks/ask.ts')
const { parseProgress } = await import('../hooks/parse.ts')
const { buildView } = await import('../hooks/view.ts')
const { serveModel } = await import('../hooks/serve.ts')
const { STRINGS } = await import('../hooks/strings.ts')
loader.deregister()

const question = 'Merge FAQ into Troubleshooting or keep separate?'
const options = ['Merge FAQ into Troubleshooting', 'keep separate']

test('an A-or-B question keeps both complete options even when the first is longer than 24 characters', () => {
  assert.equal(askOf(question, '').kind, 'choose')
  assert.deepEqual(askOf(question, '').options, options)
  const second = 'keep all the existing sections separate'
  assert.deepEqual(askOf(`Merge FAQ into Troubleshooting or ${second}?`, '').options, [options[0], second])
})

test('long choices remain choices in both Chinese scripts', () => {
  for (const separator of ['還是', '还是']) {
    const a = '合併所有現有的常見問題與疑難排解內容並保留每一個完整的章節標題'
    const b = '分開保留現有章節與全部範例'
    assert.deepEqual(askOf(`${a}${separator}${b}？`, ''), { kind: 'choose', options: [a, b], command: null, link: null })
  }
})

test('explicit question metadata and independent review notes retain their precedence', () => {
  assert.equal(askOf(question, '', { ask: 'input' }).kind, 'input')
  assert.equal(askOf(question, 'Please review the preview.').kind, 'review')
  assert.equal(askOf(question, 'Waiting for the owner.').kind, 'wait')
  assert.equal(askOf('Merge the FAQ?', '').kind, 'confirm')
})

test('every page language offers the complete choice replies instead of Yes and No', () => {
  const now = Date.parse('2026-10-30T12:00:00Z')
  const source = `## Synthetic\n<!-- auto session=abcd1234 agent=codex state=waiting updated=2026-10-30T11:59:00Z -->\n### Organize FAQ\n- [?] ${question}\n<!-- /auto session=abcd1234 -->\n`
  for (const s of Object.values(STRINGS)) {
    const model = serveModel(buildView(parseProgress(source), [], null, now, 0, {}, s), [], s)
    assert.equal(model.asks.length, 1)
    assert.equal(model.asks[0].kind, 'choose')
    assert.deepEqual(model.asks[0].answers, options)
  }
})
