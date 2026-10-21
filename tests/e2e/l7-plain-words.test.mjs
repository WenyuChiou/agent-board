import { test } from 'node:test'
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { EN } from '../../hooks/strings-en.ts'
import { ZH_TW } from '../../hooks/i18n.ts'
import { ZH_CN } from '../../hooks/strings-zh-cn.ts'
import { makeWorld } from './lib/world.mjs'
import { block } from './lib/writers.mjs'
import { chat, inspectSurfaces, pageDom, run, serve, terminal } from './lib/surfaces.mjs'
import { noMachineIds } from './lib/expect.mjs'
import { storageFault } from './lib/faults.mjs'

// Resolve the pure plugin module's extensionless imports as the host does.
const resolver = registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })
const { plainReason } = await import('../../hooks/strings.ts')
resolver.deregister()

const locales = [EN, ZH_TW, ZH_CN]
const resume = '12345678-1234-4234-8234-123456789abc'
const seed = world => {
  block(world, { agent: 'codex', resume, dir: world.root, state: 'waiting', title: 'Review gateway', steps: ['- [?] Publish the gateway, OK?'] })
  block(world, { agent: 'claude', session: 'a1000002', resume: '22345678-1234-4234-8234-123456789abc', dir: world.root, title: 'Prepare documentation' })
}
const sentence = (text, world) => {
  assert.ok(text.trim(), 'An error needs a visible explanation')
  assert.ok((text.match(/[.?!。？！](?=\s|$)/gu) ?? []).length <= 1, text)
  assert.ok(!text.includes(world.root) && !text.includes(world.path), text)
  assert.doesNotMatch(text, /^\s*at\s|(?:Error|Exception):|\n\s*\^/m)
  noMachineIds(text, world)
}

test('L7 words: no session id, hash or file path on the default pane, terminal, --chat, page or html views', async () => {
  // The companion test in journeys.test.tsx mounts the actual pane engine.
  for (const s of locales) {
    const world = makeWorld({ lang: s.lang })
    try {
      seed(world)
      const screens = await inspectSurfaces(world)
      assert.ok(world.exists('progress-questions.json'), 'The question list is present')
      for (const text of Object.values(screens)) noMachineIds(text, world)
      assert.ok(screens.html.includes(s.progressFileShown))
      const copied = await terminal.keys(world, 'c')
      assert.ok(copied.includes(s.copied), copied)
      noMachineIds(copied, world)
    } finally { await world.close() }
  }
})

test('L7 page: the copy status never shows a session id, and a refused copy leaves the text in a selected field', async () => {
  for (const s of locales) {
    const world = makeWorld({ lang: s.lang })
    try {
      seed(world)
      block(world, { session: 'a1000003', agent: 'codex', resume: '32345678-1234-4234-8234-123456789abc', dir: join(world.root, 'gone-project'), state: 'ended', title: 'Missing project' })
      const server = await serve.start(world, ['--allow-resume'])
      await server.press('Review gateway', s.serveCopyResume)
      const dom = server.dom
      const resultSlot = card => card.childNodes.flatMap(node => [node, ...node.childNodes]).find(node => node.className?.split(' ').includes('press-result'))
      const reviewSlot = () => resultSlot(dom.cards().find(card => card.textContent.includes('Review gateway')))
      assert.equal(reviewSlot().textContent, s.copied)
      assert.equal(dom.node('note').textContent, '')
      const model = (await server.get('/api/board')).json().model
      const copiedText = model.asks.find(ask => ask.task === 'Review gateway').reopen
      assert.ok(copiedText.includes(resume), copiedText)
      assert.ok(dom.copied.includes(copiedText), JSON.stringify(dom.copied))
      noMachineIds(reviewSlot().textContent, world)
      assert.equal(dom.inputs(reviewSlot()).length, 0)
      dom.setClipboard(false)
      await server.press('Review gateway', s.serveCopyResume)
      assert.equal(reviewSlot().textContent, s.boardCopyFailedBelow)
      noMachineIds(reviewSlot().textContent, world)
      assert.equal(dom.node('note').textContent, '')
      const field = dom.inputs(reviewSlot())[0]
      assert.equal(field.value, copiedText)
      assert.equal(field.getAttribute('readonly'), '')
      assert.notEqual(field.hidden, true)
      assert.equal(dom.activeElement, field)
      assert.equal(field.selectionStart, 0)
      assert.equal(field.selectionEnd, field.value.length)
      assert.equal(field.focusOptions?.preventScroll, true)
      assert.equal(field.scrollCalls.length, 1)
      assert.equal(field.scrollCalls[0].block, 'nearest')
      await dom.redraw({ ...model, counts: { ...model.counts, active: model.counts.active + 1 } })
      const redrawn = dom.inputs(reviewSlot())[0]
      assert.equal(dom.activeElement, redrawn)
      assert.equal(redrawn.value, copiedText)
      assert.equal(redrawn.selectionStart, 0)
      assert.equal(redrawn.selectionEnd, copiedText.length)
      assert.equal(redrawn.focusOptions?.preventScroll, true)
      assert.equal(redrawn.scrollCalls?.length ?? 0, 0)
      redrawn.setSelectionRange(2, 7)
      await dom.redraw({ ...model, counts: { ...model.counts, active: model.counts.active + 2 } })
      const selected = dom.inputs(reviewSlot())[0]
      assert.equal(dom.activeElement, selected)
      assert.equal(selected.selectionStart, 2)
      assert.equal(selected.selectionEnd, 7)
      const elsewhere = dom.node('paste')
      elsewhere.focus()
      await dom.redraw(model)
      assert.equal(dom.activeElement, elsewhere)
      assert.equal(dom.inputs(reviewSlot())[0].focusOptions, undefined)
      const source = (await server.get(new URL(server.url).pathname + new URL(server.url).search)).body
      assert.doesNotMatch(source, /id="copy-text"/)
      let finishSend
      const late = await pageDom(source, model, async () => ({ ok: true, json: () => new Promise(resolve => { finishSend = resolve }) }), { clipboard: false })
      const missing = late.cards().find(card => card.className?.split(' ').includes('row') && card.textContent.includes('Missing project'))
      late.inputs(missing)[0].value = 'Continue the synthetic work'
      late.buttons(missing).find(button => button.textContent === s.serveSend('codex')).click()
      await late.flush()
      const review = late.cards().find(card => card.textContent.includes('Review gateway'))
      late.buttons(review).find(button => button.textContent === s.serveCopyResume).click()
      await late.flush()
      await late.redraw({ ...model, asks: [], hidden: [], idle: [], stopped: [], groups: [], turns: [], recent: [] })
      const lostField = () => late.inputs(resultSlot(late.cards().find(card => card.textContent.includes('Review gateway'))))[0]
      lostField().setSelectionRange(2, 7)
      lostField().focus({ preventScroll: true })
      finishSend({ ok: false, note: s.pressFailed })
      await late.flush()
      const retained = lostField()
      assert.equal(late.activeElement, retained)
      assert.equal(retained.value, copiedText)
      assert.equal(retained.selectionStart, 2)
      assert.equal(retained.selectionEnd, 7)
      assert.equal(retained.focusOptions?.preventScroll, true)
      assert.equal(retained.scrollCalls?.length ?? 0, 0)
      for (const legacyCopy of [true, false]) {
        const fallback = await pageDom(source, model, undefined, { clipboard: false, legacyCopy })
        const ask = fallback.cards().find(card => card.textContent.includes('Review gateway'))
        fallback.buttons(ask).find(button => button.textContent === s.serveCopyResume).click()
        await fallback.flush()
        const slot = resultSlot(ask)
        assert.equal(slot.textContent, legacyCopy ? s.copied : s.boardCopyFailedBelow)
        assert.equal(fallback.node('note').textContent, '')
        assert.equal(fallback.inputs(slot).length, legacyCopy ? 0 : 1)
        if (legacyCopy) assert.equal(fallback.node('body').childNodes.length, 0)
        const area = legacyCopy ? fallback.activeElement : fallback.inputs(slot)[0]
        assert.equal(area.value, copiedText)
        assert.equal(area.focusOptions?.preventScroll, true)
        assert.equal(area.selectionStart, 0)
        assert.equal(area.selectionEnd, area.value.length)
        assert.equal(area.scrollCalls?.length ?? 0, legacyCopy ? 0 : 1)
        if (!legacyCopy) {
          assert.equal(area.getAttribute('readonly'), '')
          assert.notEqual(area.hidden, true)
          assert.equal(fallback.activeElement, area)
          assert.equal(area.scrollCalls[0].block, 'nearest')
        }
        noMachineIds(slot.textContent, world)
      }
      const card = dom.cards().find(card => card.className?.split(' ').includes('row') && card.textContent.includes('Missing project'))
      assert.ok(card, dom.text())
      const input = dom.inputs(card)[0]
      input.value = 'Continue the synthetic work'
      input.focus()
      await server.press('Missing project', s.serveSend('codex'))
      const note = resultSlot(dom.cards().find(card => card.className?.split(' ').includes('row') && card.textContent.includes('Missing project'))).textContent
      assert.equal(note, s.serveSendFailed('codex · Missing project', s.serveFolderGone('gone-project')), JSON.stringify(dom.requests))
      noMachineIds(note, world)
      assert.equal(dom.inputs(reviewSlot()).length, 0)
      assert.equal(dom.node('note').textContent, '')
    } finally { await world.close() }
  }
})

test('L7 words: an unknown storage reason stays a short clause in every language', () => {
  for (const [s, reason] of [[EN, 'the system reported an unexpected error'], [ZH_TW, '系統回報了意外的錯誤'], [ZH_CN, '系统报告了意外的错误']]) {
    assert.equal(s.storageUnknown, reason)
    for (const [code, expected] of [
      ['EISDIR', s.storageIsFolder], ['ENOENT', s.storageMissing], ['ENOTDIR', s.storageMissing],
      ...['EIO', 'UNKNOWN', '', 'EFBIG', 'EMFILE', 'ENFILE', 'ENAMETOOLONG', 'EEXIST'].map(code => [code, s.storageUnknown]),
    ]) {
      assert.equal(plainReason(s, code), expected)
      assert.notEqual(plainReason(s, code), code)
    }
    assert.doesNotMatch(s.storageUnknown, /[.?!。？！]/u)
    const message = s.boardStorageFailed(s.fileNamed('board.html'), s.storageUnknown)
    assert.ok(message.includes(reason), message)
    assert.equal((message.match(/[.?!。？！](?=\s|$)/gu) ?? []).length, 1, message)
  }
})

test('L7 errors: every error is one plain sentence with no stack trace and no full path', async () => {
  for (const s of locales) {
    const world = makeWorld({ lang: s.lang })
    try {
      world.write('progress.md', '## Synthetic\n### Check routes\n- [ ] Review routes\n')
      const fault = storageFault(world)
      const server = await serve.start(world)
      await server.page()
      fault.enable('write')
      const result = await run(world, ['--keys', 'x'])
      assert.equal(result.status, 1, result.stdout + result.stderr)
      const expected = s.boardStorageFailed(s.fileProgress, s.storageReadOnly)
      assert.equal(result.stderr.trim(), expected)
      sentence(result.stderr.trim(), world)
      const status = result.stdout.split('\n').find(line => line.includes(expected.slice(0, 24)))
      assert.ok(status, result.stdout)
      sentence(status, world)
      await server.press('Check routes', s.serveTickNext('Review routes'))
      const card = server.dom.cards().find(card => card.className?.split(' ').includes('row') && card.textContent.includes('Check routes'))
      const slot = card.childNodes.flatMap(node => [node, ...node.childNodes]).find(node => node.className?.split(' ').includes('press-result'))
      assert.ok(slot, card.textContent)
      assert.equal(slot.textContent, expected)
      sentence(slot.textContent, world)
      assert.equal(server.dom.node('note').textContent, '')
      assert.ok(world.read('progress.md').includes('- [ ] Review routes'))
      fault.enable('read')
      const unreadable = await chat(world)
      assert.equal(unreadable.status, 1)
      assert.equal(unreadable.stderr, '')
      assert.equal(unreadable.stdout.trim(), s.chatReadFailed(s.fileProgress, s.storageReadOnly))
      sentence(unreadable.stdout.trim(), world)
    } finally { await world.close() }
  }
  for (const [code, why] of [['EPERM', EN.storageReadOnly], ['EROFS', EN.storageReadOnly], ['EBUSY', EN.storageBusy], ['EAGAIN', EN.storageBusy], ['ENOSPC', EN.storageFull], ['EIO', EN.storageUnknown]]) {
    const world = makeWorld()
    try {
      world.write('progress.md', '## Synthetic\n### Check routes\n- [ ] Review routes\n')
      storageFault(world, { code }).enable('read')
      const result = await chat(world)
      assert.equal(result.status, 1)
      // A read refused because another program has the file open, before anything was written,
      // says only that the file is locked (#244).
      assert.equal(result.stdout.trim(), ['EBUSY', 'EAGAIN'].includes(code) ? EN.boardLocked(EN.fileProgress) : EN.chatReadFailed(EN.fileProgress, why))
      sentence(result.stdout.trim(), world)
    } finally { await world.close() }
  }
})
