import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
let board, parseProgress, buildView, serveModel, STRINGS
try {
  board = await import('../hooks/board.ts')
  ;({ parseProgress } = await import('../hooks/parse.ts'))
  ;({ buildView } = await import('../hooks/view.ts'))
  ;({ serveModel } = await import('../hooks/serve.ts'))
  ;({ STRINGS } = await import('../hooks/strings.ts'))
} finally { loader.deregister() }

const now = Date.parse('2026-11-05T06:00:00Z')
const progress = `## Synthetic guidance
<!-- auto session=a11ce101 agent=codex state=waiting updated=2026-11-05T06:00:00Z -->
### Inspect the synthetic choice
- [?] Blue or green?
<!-- /auto session=a11ce101 -->
`
const viewFor = words => buildView(parseProgress(progress), [], null, now, 0, {}, words)

test('a hideable question exposes its exact restore key and no key is offered for review-only questions', () => {
  for (const words of Object.values(STRINGS)) {
    const view = viewFor(words)
    assert.ok(view.waiting[0]?.hideKey)
    const model = serveModel(view, [], words)
    assert.equal(model.asks[0].unhideKey, `hidden:${view.waiting[0].hideKey}`)
    const review = { ...view, waiting: view.waiting.map(one => ({ ...one, canHide: false })) }
    assert.equal(serveModel(review, [], words).asks[0].unhideKey, undefined)
  }
})

test('the terminal footer at 100 columns clips a Latin word only at a whole-word boundary', () => {
  const view = viewFor(STRINGS.en)
  const state = board.pinned(board.emptyBoardState, board.boardItems(view, []))
  for (const width of [80, 100, 120]) {
    const footer = board.boardScreen(view, [], state, STRINGS.en, { width, isColor: false }).trimEnd().split('\n').at(-1)
    assert.ok(board.displayColumns(footer) <= width, footer)
    assert.ok(footer.endsWith(STRINGS.en.boardKeysMove), footer)
    const shortened = footer.split(' · ' + STRINGS.en.boardKeysMove)[0]
    if (!shortened.endsWith('…')) continue
    const prefix = shortened.slice(0, -1)
    const full = board.boardScreen(view, [], state, STRINGS.en, { width: 1000, isColor: false }).trimEnd().split('\n').at(-1).split(' · ' + STRINGS.en.boardKeysMove)[0]
    assert.ok(full.startsWith(prefix), prefix)
    assert.ok(!/[A-Za-z0-9]$/.test(prefix) || !/[A-Za-z0-9]/.test(full[prefix.length] || ''), footer)
  }
})

test('the terminal footer preserves Chinese glyphs and its column budget', () => {
  for (const words of [STRINGS['zh-TW'], STRINGS['zh-CN']]) {
    const view = viewFor(words)
    const state = board.pinned(board.emptyBoardState, board.boardItems(view, []))
    const footer = board.boardScreen(view, [], state, words, { width: 100, isColor: false }).trimEnd().split('\n').at(-1)
    assert.ok(board.displayColumns(footer, true) <= 100, footer)
    assert.ok(footer.endsWith(words.boardKeysMove), footer)
    assert.ok(!footer.includes('\ufffd'), footer)
  }
})
