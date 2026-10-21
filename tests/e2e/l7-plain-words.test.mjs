import { test } from 'node:test'
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
      assert.equal(dom.node('note').textContent, s.copied)
      const model = (await server.get('/api/board')).json().model
      const copiedText = model.asks.find(ask => ask.task === 'Review gateway').reopen
      assert.ok(copiedText.includes(resume), copiedText)
      assert.ok(dom.copied.includes(copiedText), JSON.stringify(dom.copied))
      noMachineIds(dom.node('note').textContent, world)
      assert.equal(dom.node('copy-text').hidden, true)
      dom.setClipboard(false)
      await server.press('Review gateway', s.serveCopyResume)
      assert.equal(dom.node('note').textContent, s.boardCopyFailedBelow)
      noMachineIds(dom.node('note').textContent, world)
      const field = dom.node('copy-text')
      assert.equal(field.value, copiedText)
      assert.equal(field.getAttribute('readonly'), '')
      assert.equal(field.hidden, false)
      assert.equal(dom.activeElement, field)
      assert.equal(field.selectionStart, 0)
      assert.equal(field.selectionEnd, field.value.length)
      const source = (await server.get(new URL(server.url).pathname + new URL(server.url).search)).body
      assert.match(source, /id="note"[^>]*><\/div>\s*<textarea id="copy-text" readonly hidden/)
      for (const legacyCopy of [true, false]) {
        const fallback = await pageDom(source, model, undefined, { clipboard: false, legacyCopy })
        const ask = fallback.cards().find(card => card.textContent.includes('Review gateway'))
        fallback.buttons(ask).find(button => button.textContent === s.serveCopyResume).click()
        await fallback.flush()
        const area = fallback.node('copy-text')
        assert.equal(area.value, copiedText)
        assert.equal(area.hidden, legacyCopy)
        assert.equal(fallback.node('note').textContent, legacyCopy ? s.copied : s.boardCopyFailedBelow)
        assert.equal(area.focusOptions?.preventScroll, true)
        assert.equal(area.scrollCalls?.length ?? 0, legacyCopy ? 0 : 1)
        if (!legacyCopy) assert.equal(area.scrollCalls[0].block, 'nearest')
        noMachineIds(fallback.node('note').textContent, world)
      }
      const card = dom.cards().find(card => card.textContent.includes('Missing project'))
      assert.ok(card, dom.text())
      const input = dom.inputs(card)[0]
      input.value = 'Continue the synthetic work'
      input.focus()
      await server.press('Missing project', s.serveSend('codex'))
      const note = dom.node('note').textContent
      assert.equal(note, s.serveSendFailed('codex · Missing project', s.serveFolderGone('gone-project')), JSON.stringify(dom.requests))
      noMachineIds(note, world)
      assert.equal(field.hidden, true)
    } finally { await world.close() }
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
      assert.equal(server.dom.node('note').textContent, expected)
      sentence(server.dom.node('note').textContent, world)
      assert.ok(world.read('progress.md').includes('- [ ] Review routes'))
      fault.enable('read')
      const unreadable = await chat(world)
      assert.equal(unreadable.status, 1)
      assert.equal(unreadable.stderr, '')
      assert.equal(unreadable.stdout.trim(), s.chatReadFailed(s.fileProgress, s.storageReadOnly))
      sentence(unreadable.stdout.trim(), world)
    } finally { await world.close() }
  }
  for (const [code, why] of [['EPERM', EN.storageReadOnly], ['EROFS', EN.storageReadOnly], ['EBUSY', EN.storageBusy], ['EAGAIN', EN.storageBusy], ['ENOSPC', EN.storageFull], ['EIO', 'EIO']]) {
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
