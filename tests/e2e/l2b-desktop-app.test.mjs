import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { makeWorld } from './lib/world.mjs'
import { block } from './lib/writers.mjs'
import { run, seenPageWithin, serve, terminal } from './lib/surfaces.mjs'
import { noMachineIds, noSilentPress } from './lib/expect.mjs'
import { PAGE_MS } from './lib/budget.mjs'
import { liveBoardArgv, liveBoardPage } from '../../hooks/live-page.ts'
import { ZH_TW } from '../../hooks/i18n.ts'
import { EN } from '../../hooks/strings-en.ts'
import { ZH_CN } from '../../hooks/strings-zh-cn.ts'

// In the desktop app's Code tab no pane can be placed, so /progress runs the installed board
// script with the arguments openLiveBoard in hooks/register.tsx uses, and reads its link by the
// same rule.
const progress = (world, lang) => {
  const [node, script, ...args] = liveBoardArgv(world.script, lang)
  assert.deepEqual([node, script], ['node', world.script])
  return run(world, args)
}
const progressLink = (stdout, words) => liveBoardPage(stdout, words)?.url ?? null

describe('L2 desktop app', () => {
  test('L2 desktop app: /progress starts the live page, hands every session the same link, and the person answers and archives there', async () => {
    const world = makeWorld()
    let server
    // The page /progress starts runs on after its command returns; own it even when a check fails first.
    world.cleanups.push(async () => { if (!server) await (await serve.start(world).catch(() => undefined))?.stop() })
    try {
      block(world, { agent: 'codex', state: 'waiting', title: 'Release the gateway', steps: ['- [x] Check routes', '- [?] Ship the gateway, OK?'] })
      block(world, { session: 'a1000002', agent: 'antigravity', project: 'docs-site', state: 'done', title: 'Publish the docs', steps: ['- [x] Upload docs'] })

      const first = await progress(world, 'en')
      assert.equal(first.status, 0, first.stderr || first.stdout)
      const link = progressLink(first.stdout, EN)
      assert.ok(link, first.stdout)
      // A quiet start: the reply carries the link, never the board itself.
      for (const words of ['Release the gateway', 'Ship the gateway', 'Publish the docs']) assert.ok(!first.stdout.includes(words), first.stdout)
      noMachineIds(first.stdout, world, { allow: [link] })

      server = await serve.start(world)
      assert.equal(server.url, link, 'The harness attaches to the page /progress started')

      // /progress again, from this or another session in any language, reuses the running page.
      for (const [lang, words] of [['en', EN], ['zh-TW', ZH_TW], ['zh-CN', ZH_CN]]) {
        const again = await progress(world, lang)
        assert.equal(again.status, 0, again.stderr || again.stdout)
        assert.equal(progressLink(again.stdout, words), link, `${lang}: ${again.stdout}`)
      }

      assert.equal((await server.get('/api/board')).json().model.counts.waiting, 1)
      noSilentPress(await server.press('Ship the gateway', 'Already answered, hide'))
      await seenPageWithin(server, text => text.includes('Nothing needs you'), PAGE_MS)
      assert.equal((await server.get('/api/board')).json().model.counts.waiting, 0)
      assert.match(await terminal.screen(world), /\b0 waiting\b/)

      // The press redraws from the server's fresh model; the latency budget is checked on the answer above.
      noSilentPress(await server.press('Publish the docs', EN.serveArchive))
      assert.ok(!(await server.page()).includes('Publish the docs'), 'Archived work leaves the page')
      assert.ok(!world.read('progress.md').includes('Publish the docs'), 'Archived work leaves progress.md')
      noMachineIds(await server.page(), world)
    } finally { await world.close() }
  })
})
