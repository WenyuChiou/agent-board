import assert from 'node:assert/strict'
import test from 'node:test'
import { pageFixture, PAGE_NOW } from './page-reader-fixture.mjs'
import { pageDom } from './e2e/lib/surfaces.mjs'

const descendants = node => [node, ...node.childNodes.flatMap(descendants)]

test('the shipped page renders hostile task titles as text through its production API', async () => {
  const title = 'Google <script>alert(1)</script>'
  const fixture = await pageFixture(`## demo\n### ${title}\n- [~] Prepare the synthetic application\n`)
  try {
    const model = await fixture.api()
    const dom = await pageDom(fixture.runtime.servePage(fixture.runtime.s, 'synthetic'), model)
    assert.ok(dom.cards().some(card => card.textContent.includes(title)), dom.node('board').readText)
    assert.equal(descendants(dom.node('board')).some(node => node.tag === 'script'), false)
  } finally { await fixture.close() }
})

test('the shipped page renders the stopped shelf title through its production API', async () => {
  const title = 'Stopped <plan>'
  const fixture = await pageFixture(`## demo\n<!-- auto session=abcdef12 agent=codex state=ended updated=${new Date(PAGE_NOW - 60000).toISOString().slice(0, 19)}Z -->\n### ${title}\n- [ ] Finish\n<!-- /auto session=abcdef12 -->\n`)
  try {
    const model = await fixture.api()
    const dom = await pageDom(fixture.runtime.servePage(fixture.runtime.s, 'synthetic'), model)
    assert.ok(dom.cards().some(card => card.textContent.includes(title)), dom.node('board').readText)
    const shelf = dom.buttons(dom.node('board')).find(button => button.textContent.includes(fixture.runtime.s.pgStopped))
    assert.ok(shelf)
    shelf.click()
    await dom.flush()
    assert.ok(dom.node('board').visibleText.includes(title), dom.node('board').visibleText)
  } finally { await fixture.close() }
})
