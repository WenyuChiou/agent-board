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

test('Chinese and English questions offer clean choices or a yes and no', () => {
  const rows = [
    ['藍色或綠色？', 'choose', ['藍色', '綠色']],
    ['要寫哪種水果？蘋果或香蕉', 'choose', ['蘋果', '香蕉']],
    ['要 A 或 B 嗎？', 'choose', ['A', 'B']],
    ['你想用 React 還是 Vue 呢？', 'choose', ['React', 'Vue']],
    ['选择 A 还是 B？', 'choose', ['A', 'B']],
    ['Should the retry limit be 3 or 5?', 'choose', ['3', '5']],
    ['Do you want to use React or Vue?', 'choose', ['React', 'Vue']],
    ['是否繼續執行？', 'confirm', []],
    ['Ready to push?', 'confirm', []],
    ['Want me to continue?', 'confirm', []],
    ['Continue? (y/n)', 'confirm', []],
    ['要繼續嗎？(是/否)', 'confirm', []],
    ['要 A 或 B 嗎？(是/否)', 'choose', ['A', 'B']],
    ['選 A 或 B 呢？', 'choose', ['A', 'B']],
    ['要 A 或 B 吗？', 'choose', ['A', 'B']],
    ['要 A 或 B 吧？', 'choose', ['A', 'B']],
    ['咖啡館還是酒吧？', 'choose', ['咖啡館', '酒吧']],
    ['棉布還是毛呢？', 'choose', ['棉布', '毛呢']],
    ['A or B? (y/n)', 'choose', ['A', 'B']],
    ['或許明天再說？', 'reply', []],
    ['或者是說明天？', 'reply', []],
    ['系統或許需要修復？', 'reply', []],
    ['藍色或綠色', 'reply', []],
    [`${'甲'.repeat(41)}或乙？`, 'reply', []],
    ['Should I keep files that are backed up or delete them?', 'choose', ['Should I keep files that are backed up', 'delete them']],
    ['Should the size be small, medium, large or huge?', 'choose', ['small', 'medium', 'large', 'huge']],
    ['Do you want X, Y or Z?', 'choose', ['X', 'Y', 'Z']],
    ['A、B 還是 C？', 'choose', ['A', 'B', 'C']],
    ['用 A、B 还是 C？', 'choose', ['A', 'B', 'C']],
    ['先用旗標給部分人，還是直接全部開？', 'choose', ['先用旗標給部分人', '直接全部開']],
    ['"Top shelf or bottom shelf?"', 'choose', ['Top shelf', 'bottom shelf']],
    ['「先開旗標」還是「全部開？」', 'choose', ['先開旗標', '全部開']],
    // A 或 in a statement never pairs with a later sentence's question mark.
    ['我覺得 A 或 B 都行。要繼續嗎？', 'confirm', []],
    ['A 或 B 都可以，要繼續嗎？', 'confirm', []],
    ['我改了 3 或 4 個檔案。是否繼續？', 'confirm', []],
    ['這是 A 或 B。你覺得呢？', 'reply', []],
    ['Tests pass. Ready to push?', 'confirm', []],
    // A lead-in goes whole; 或以上 sets a bound, not a choice.
    ['是否要用 A 或 B？', 'choose', ['A', 'B']],
    ['要不要 A 或 B？', 'choose', ['A', 'B']],
    ['是否要用 A 還是 B？', 'choose', ['A', 'B']],
    ['請問你要用 A 或 B？', 'choose', ['A', 'B']],
    ['Node 18 或以上？', 'reply', []],
    ['需要 Node 18 或以上嗎？', 'confirm', []],
    // One-word options share the words after the last one.
    ['MySQL or Postgres for the DB?', 'choose', ['MySQL', 'Postgres']],
    ['Tabs or spaces for indentation?', 'choose', ['Tabs', 'spaces']],
    ['Ship now or wait for the review?', 'choose', ['Ship now', 'wait for the review']],
  ]
  for (const [text, kind, options] of rows) {
    for (const [subject, note] of [[text, ''], ['Pick', text]]) {
      const result = askOf(subject, note)
      assert.deepEqual({ kind: result.kind, options: result.options }, { kind, options }, text)
    }
  }
})
