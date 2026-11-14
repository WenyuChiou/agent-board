import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { BoardPage } from './board-page.mjs'
import { browserFixture, hiddenQuestion, installAntigravity, monthlyArchive, writeProgress } from './fixture.mjs'

// One second in the past: the board refuses a pasted source time ahead of its own clock (#954).
const block = (session, agent, state, project, title, steps, context = 'Synthetic browser fixture only.', updated = new Date(Date.now() - 1000).toISOString()) => `## ${project}
<!-- auto session=${session} agent=${agent} state=${state} updated=${updated} -->
### ${title}
> Context: ${context}
${steps.join('\n')}
<!-- /auto session=${session} -->
`

const museQuestion = block('a11ce001', 'muse', 'waiting', 'Synthetic journeys', 'Choose a launch tone', ['- [?] Bold or quiet?', '- [ ] Publish the synthetic note'])
const antigravityQuestion = block('a11ce002', 'antigravity', 'waiting', 'Synthetic journeys', 'Choose a review window', ['- [?] 24 hours or 7 days?', '- [ ] Record the synthetic choice'])

const waitFor = async (check, within = 15_000) => {
  const until = Date.now() + within
  while (!check()) {
    if (Date.now() > until) throw new Error('the board file did not change in time')
    await new Promise(done => setTimeout(done, 100))
  }
}

const assertNoIdentifiers = async (page, root, sessions) => {
  const visible = (await page.getByRole('main').innerText()).toLowerCase()
  for (const value of [root, root.replaceAll('\\', '/'), ...sessions]) assert.ok(!visible.includes(value.toLowerCase()), `the default board exposed ${value}`)
}

describe('confirmed browser journeys', { concurrency: 1 }, () => {
  test("a web chat's block pressed in with Ctrl+V shows as its own card", { concurrency: false, timeout: 120_000 }, async () => {
    await browserFixture('web-chat-clipboard', async ({ page, startServer }) => {
      const context = page.context()
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      const board = new BoardPage(page)
      await board.open(await startServer())
      const requests = []
      // Chromium on Windows hands the clipboard back with CRLF, which the merge accepts.
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/paste') requests.push(request.postDataJSON().text.replaceAll('\r\n', '\n')) })
      const title = 'Synthetic Muse clipboard report'
      const report = block('a561cafe', 'muse', 'working', 'Synthetic clipboard', title, ['- [~] Check synthetic relay'])
      await page.evaluate(text => navigator.clipboard.writeText(text), report)
      await page.locator('body').click({ position: { x: 2, y: 2 } })
      await page.keyboard.press('ControlOrMeta+V')
      await board.task(title).waitFor()
      assert.deepEqual(requests, [report])
      await page.evaluate(text => navigator.clipboard.writeText(text), 'not a block')
      // Wait for the browser paste event itself, so the assertion does not race its delivery.
      await page.evaluate(() => { window.syntheticPasteSeen = false; document.addEventListener('paste', () => { window.syntheticPasteSeen = true }, { once: true }) })
      await page.keyboard.press('ControlOrMeta+V')
      await page.waitForFunction(() => window.syntheticPasteSeen)
      assert.deepEqual(requests, [report])
    })
  })

  for (const [lang, refused, added] of [
    ['en', 'Not added: The agent name "claude" is reserved for Claude Code. Ask the web chat to use "claude-web", then paste again.', 'Added to the board: '],
    ['zh-TW', '沒加進去：代理名稱「claude」保留給 Claude Code 使用。請網頁聊天改用「claude-web」，再貼一次。', '已加進看板：'],
    ['zh-CN', '没加进去：代理名称“claude”保留给 Claude Code 使用。请网页聊天改用“claude-web”，再粘贴一次。', '已加进看板：'],
  ]) {
    test(`a real clipboard paste naming itself claude explains the refusal and accepts claude-web in ${lang}`, { concurrency: false, timeout: 120_000 }, async () => {
      await browserFixture(`reserved-agent-clipboard-${lang}`, async ({ page, progress, evidence, startServer }) => {
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
        const board = new BoardPage(page)
        await board.open(await startServer({ language: lang }))
        const before = readFileSync(progress)
        const title = 'Synthetic corrected web chat report'
        const report = block('a823cafe', 'claude', 'working', 'Synthetic clipboard', title, ['- [~] Check synthetic relay'])
        const requests = []
        page.on('request', request => { if (new URL(request.url()).pathname === '/api/paste') requests.push(request.postDataJSON().text.replaceAll('\r\n', '\n')) })
        const paste = async text => {
          await page.evaluate(value => navigator.clipboard.writeText(value), text)
          await page.locator('body').click({ position: { x: 2, y: 2 } })
          const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/paste' && result.request().method() === 'POST')
          await page.keyboard.press('ControlOrMeta+V')
          return response
        }
        assert.equal((await paste(report)).status(), 409)
        const note = page.locator('#note')
        await note.filter({ hasText: refused }).waitFor({ state: 'visible' })
        assert.equal(await note.innerText(), refused)
        assert.deepEqual(readFileSync(progress), before)
        assert.equal(await board.task(title).count(), 0)
        await page.screenshot({ path: join(evidence, 'reserved-agent-refused.png'), fullPage: true })

        const corrected = report.replace('agent=claude', 'agent=claude-web')
        assert.equal((await paste(corrected)).status(), 200)
        await note.filter({ hasText: `${added}${title}` }).waitFor({ state: 'visible' })
        assert.equal(await note.innerText(), `${added}${title}`)
        await board.task(title).getByText(title, { exact: true }).waitFor({ state: 'visible' })
        // The arriving row expands a clipped grid track and glows. A nonzero row box alone
        // can still be a grey sliver; capture only after its title fits and finite motion ends.
        await page.waitForFunction(expected => {
          const title = [...document.querySelectorAll('li.row .r-title')].find(node => node.textContent === expected)
          const row = title?.closest('li.row')
          const clip = row?.querySelector(':scope > .fx > .fx-in')
          if (!clip || clip.parentElement.inert || clip.parentElement.classList.contains('gone')) return false
          const text = title.getBoundingClientRect(), visible = clip.getBoundingClientRect()
          return text.height > 0 && text.top >= visible.top && text.bottom <= visible.bottom
            && row.getAnimations({ subtree: true }).every(animation =>
              !Number.isFinite(animation.effect.getComputedTiming().endTime) || animation.playState === 'finished')
        }, title, { timeout: 15_000 })
        assert.match(readFileSync(progress, 'utf8'), /agent=claude-web/)
        assert.deepEqual(requests, [report, corrected])
        await page.screenshot({ path: join(evidence, 'reserved-agent-corrected.png'), fullPage: true })
      })
    })
  }

  test('on a 375 px phone every step and note is one line and opens to the whole text', { concurrency: false, timeout: 120_000 }, async () => {
    await browserFixture('phone-one-line', async ({ page, progress, startServer }) => {
      await page.setViewportSize({ width: 375, height: 812 })
      const chinese = '整'.repeat(60)
      const english = 'Review every synthetic result and write the full report. '.repeat(5).trim()
      const unbroken = 'SyntheticWord'.repeat(25)
      const notes = ['First synthetic note '.repeat(12).trim(), 'Second synthetic note '.repeat(12).trim(), 'Third synthetic note '.repeat(12).trim()]
      const review = 'Review the notes and preserve every detail. '.repeat(5).trim()
      const stopped = 'Inspect the stopped synthetic task. '.repeat(6).trim()
      writeProgress(progress, `## Synthetic phone\n### Read every step\n- [ ] ${chinese}\n- [ ] ${english}\n- [ ] ${unbroken}\n\n### Read card notes\n${notes.map(note => `> ${note}`).join('\n')}\n- [ ] ${review}\n\n${block('a61ce021', 'codex', 'ended', 'Synthetic phone', 'Stopped phone task', [`- [ ] ${stopped}`])}`)
      const board = new BoardPage(page)
      await board.open(await startServer())
      const task = await board.openTask('Read every step')
      const noted = await board.openTask('Read card notes')
      // A row shows its current step; the others sit in a fold, which has to be open to be measured.
      await task.getByText('2 more steps', { exact: true }).click()
      await page.locator('.shelf-head').filter({ hasText: 'Stopped' }).click()
      await board.openTask('Stopped phone task')
      const stepClips = page.locator('.steps .clip')
      assert.equal(await stepClips.count(), 5)
      const all = [...await stepClips.all(), noted.locator('.clip.context')]
      for (const clip of all) {
        const summary = clip.locator(':scope > summary')
        const short = clip.locator('.short')
        // A fold that was just opened may still be growing; measure once the line has its width.
        await short.evaluate(node => new Promise(done => { const at = Date.now(); const check = () => (node.clientWidth > 0 || Date.now() - at > 3000 ? done() : requestAnimationFrame(check)); check() }))
        const metrics = await short.evaluate(node => {
          const style = getComputedStyle(node)
          return { height: node.parentElement.getBoundingClientRect().height, font: parseFloat(style.fontSize), width: node.clientWidth, scroll: node.scrollWidth, whiteSpace: style.whiteSpace, overflow: style.overflow, ellipsis: style.textOverflow }
        })
        assert.ok(metrics.width > 0 && metrics.scroll > metrics.width)
        assert.ok(metrics.height <= metrics.font * 1.8, JSON.stringify(metrics))
        assert.deepEqual([metrics.whiteSpace, metrics.overflow, metrics.ellipsis], ['nowrap', 'hidden', 'ellipsis'])
        const whole = await clip.locator('.whole').textContent()
        assert.ok(whole.length > 60 || whole === chinese)
        await summary.focus()
        await summary.press('Enter')
        assert.equal(await clip.getAttribute('open'), '')
        assert.equal(await clip.locator('.whole').innerText(), whole)
        const height = await summary.evaluate(node => node.getBoundingClientRect().height)
        assert.ok(height > metrics.font * 1.8)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        await summary.press('Space')
      }
      const noteWhole = await noted.locator('.clip.context .whole').textContent()
      for (const note of notes) assert.ok(noteWhole.includes(note))
      assert.deepEqual(await task.locator('.steps .whole').allTextContents(), [chinese, english, unbroken])
      // Each step has one Done button (#942): the next step's is the primary button in the actions row, and the
      // list ticks only the others, each under its text, as wide as its one-line label allows (not squeezed into the mark's column).
      const ticks = task.locator('.steps li > button')
      assert.equal(await ticks.count(), 2)
      for (const tick of await ticks.all()) {
        const place = await tick.evaluate(node => {
          const box = node.getBoundingClientRect(), text = node.parentElement.querySelector('.clip').getBoundingClientRect()
          return { left: box.left, right: box.right, width: box.width, height: box.height, textLeft: text.left, textRight: text.right, title: node.title, cls: node.className }
        })
        // The page's button, as Confirm done and Copy are.
        assert.equal(place.cls, 'btn', JSON.stringify(place))
        assert.ok(place.width >= 44 && place.left >= place.textLeft - 1 && place.right <= place.textRight + 1, JSON.stringify(place))
        assert.ok(place.height <= 56, JSON.stringify(place))
        assert.ok([english, unbroken].includes(place.title), place.title)
      }
      const next = task.locator(`button[title="${chinese}"]`)
      assert.equal(await next.count(), 1)
      await next.click()
      await waitFor(() => readFileSync(progress, 'utf8').includes(`- [x] ${chinese}`))
      assert.ok(readFileSync(progress, 'utf8').includes(`- [ ] ${english}`))
    })
  })

  test('a fold of finished or further steps the person opened stays open when the board redraws', { concurrency: false, timeout: 120_000 }, async () => {
    await browserFixture('fold-stays-open', async ({ page, progress, startServer }) => {
      const steps = ['- [x] Synthetic first finished step', '- [x] Synthetic second finished step', '- [ ] Synthetic current step', '- [ ] Synthetic second open step', '- [ ] Synthetic third open step']
      writeProgress(progress, `## Synthetic folds\n### Keep the folds open\n${steps.join('\n')}\n`)
      const board = new BoardPage(page)
      await board.open(await startServer())
      const task = await board.openTask('Keep the folds open')
      const folds = ['2 steps done', '2 more steps'].map(label => task.getByText(label, { exact: true }))
      for (const fold of folds) await fold.click()
      const openFolds = () => Promise.all(folds.map(fold => fold.evaluate(node => node.parentElement.open)))
      assert.deepEqual(await openFolds(), [true, true])
      // Another task in the file changes the board, and the page draws every row again.
      writeProgress(progress, readFileSync(progress, 'utf8') + '\n### Synthetic task added later\n- [ ] Synthetic later step\n')
      await board.task('Synthetic task added later').waitFor()
      assert.deepEqual(await openFolds(), [true, true])
      assert.equal(await task.getByText('Synthetic third open step').first().isVisible(), true)
    })
  })

  test('setup is idempotent and a reported Muse question remains recoverable across reloads', { concurrency: false, timeout: 120_000 }, async () => {
    await browserFixture('report-hide-restore', async ({ page, progress, root, startServer }) => {
      const board = new BoardPage(page)
      await board.open(await startServer())
      await page.getByText('Your board is ready', { exact: true }).waitFor()
      // There is no paste box any more: a web chat's report reaches the board as a progress block in the file.
      assert.equal(await page.locator('textarea#paste').count(), 0)
      writeProgress(progress, museQuestion)

      const question = board.question('Bold or quiet?')
      await question.waitFor()
      // A Copy-only question: its options are choices and one Copy arrow, never a Send (#1107).
      await question.getByRole('button', { name: 'Bold', exact: true }).waitFor()
      await question.getByRole('button', { name: 'Copy', exact: true }).waitFor()
      assert.equal(await question.getByRole('button', { name: /^Send/ }).count(), 0)
      await question.getByRole('button', { name: 'More', exact: true }).click()
      await question.getByRole('button', { name: 'Already answered, hide', exact: true }).click()

      const hidden = page.getByText('1 answered, hidden', { exact: true })
      await hidden.waitFor()
      await page.reload()
      await hidden.waitFor()
      await hidden.click()
      await page.getByRole('button', { name: 'Show again', exact: true }).click()
      await board.question('Bold or quiet?').waitFor()
      assert.match(readFileSync(progress, 'utf8'), /Bold or quiet\?/)
      await assertNoIdentifiers(page, root, ['a11ce001'])
    })
  })

  test('agent filters and light and dark themes operate on three synthetic agent cards', { concurrency: false, timeout: 120_000 }, async () => {
    await browserFixture('filters-themes', async ({ page, progress, root, startServer }) => {
      writeProgress(progress, [
        block('a11ce011', 'codex', 'working', 'Synthetic filters', 'Codex fixture card', ['- [~] Codex fixture step']),
        block('a11ce012', 'antigravity', 'working', 'Synthetic filters', 'Antigravity fixture card', ['- [~] Antigravity fixture step']),
        block('a11ce013', 'gemini', 'working', 'Synthetic filters', 'Gemini fixture card', ['- [~] Gemini fixture step']),
      ].join('\n'))
      const board = new BoardPage(page)
      await board.open(await startServer())
      for (const title of ['Codex fixture card', 'Antigravity fixture card', 'Gemini fixture card']) await page.getByText(title, { exact: true }).waitFor()

      await board.selectAgent('antigravity')
      await page.getByText('Antigravity fixture card', { exact: true }).waitFor()
      // The other agents' rows slide shut and stop taking focus (their block is `gone` and inert), so wait for that.
      const folded = title => page.waitForFunction(text => {
        const row = [...document.querySelectorAll('li.row')].find(one => one.textContent.includes(text))
        return !!row && row.firstElementChild.classList.contains('gone') && row.firstElementChild.inert === true
      }, title)
      await folded('Codex fixture card')
      await folded('Gemini fixture card')
      assert.equal(await board.task('Antigravity fixture card').locator('xpath=./div[contains(@class,"gone")]').count(), 0)

      await board.chooseTheme('Dark')
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
      await page.reload()
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
      await board.chooseTheme('Light')
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
      await assertNoIdentifiers(page, root, ['a11ce011', 'a11ce012', 'a11ce013'])
    })
  })

  test('finishing and archiving manual work preserves active and hidden questions', { concurrency: false, timeout: 120_000 }, async () => {
    await browserFixture('finish-archive', async ({ page, progress, root, startServer }) => {
      writeProgress(progress, `${museQuestion}\n${antigravityQuestion}
## Synthetic manual tasks
### Check the installation checklist
> Context: Synthetic browser fixture only.
- [ ] Preview installation
- [ ] Verify existing settings survive

${block('a11ce023', 'gemini', 'done', 'Synthetic archive', 'Completed synthetic handoff', ['- [x] Finish the synthetic handoff'])}`)
      const board = new BoardPage(page)
      await board.open(await startServer())

      const hiddenCard = board.question('24 hours or 7 days?')
      await hiddenCard.getByRole('button', { name: 'More', exact: true }).click()
      await hiddenCard.getByRole('button', { name: 'Already answered, hide', exact: true }).click()
      await page.getByText('1 answered, hidden', { exact: true }).waitFor()

      const task = await board.openTask('Check the installation checklist')
      await task.getByRole('button', { name: 'Done: Preview installation', exact: true }).first().click()
      await waitFor(() => readFileSync(progress, 'utf8').includes('- [x] Preview installation'))
      await task.getByRole('button', { name: 'Done: Verify existing settings survive', exact: true }).first().click()
      // A finished task moves to the closed Done shelf, which holds Archive now.
      const done = page.getByRole('button', { name: /^Done/ }).filter({ has: page.locator('.count') })
      await done.click()
      // The row, not the line that keeps the last press's result, which names the task too.
      const finished = page.locator('li.row').filter({ has: page.getByText('Check the installation checklist', { exact: true }) })
      await finished.waitFor()

      await page.getByRole('button', { name: 'Archive now', exact: true }).click()
      await finished.waitFor({ state: 'detached' })
      await board.question('Bold or quiet?').waitFor()
      await page.getByText('1 answered, hidden', { exact: true }).waitFor()

      const current = readFileSync(progress, 'utf8')
      assert.match(current, /Bold or quiet\?/)
      assert.ok(!current.includes('Check the installation checklist'))
      assert.ok(!current.includes('Completed synthetic handoff'))
      assert.equal(hiddenQuestion(progress, '24 hours or 7 days?').isHidden, true)
      const archive = monthlyArchive(progress)
      assert.match(archive, /Check the installation checklist/)
      assert.match(archive, /Completed synthetic handoff/)
      assert.ok(!archive.includes('Bold or quiet?'))
      assert.ok(!archive.includes('24 hours or 7 days?'))
      await assertNoIdentifiers(page, root, ['a11ce001', 'a11ce002', 'a11ce023'])
    })
  })

  test('a queued final Stop updates the visible card without another hook or manual recovery', { concurrency: false, timeout: 120_000 }, async () => {
    await browserFixture('final-stop-recovery', async fixture => {
      const { root, home, progress, installedScript, page, evidence, startServer } = fixture
      const fire = await installAntigravity(fixture)
      const session = 'synthetic-browser-stop-session'
      const cwd = join(root, 'Synthetic lifecycle')
      mkdirSync(cwd)
      const payload = { conversationId: session, invocationNum: 1, cwd }
      fire('PreInvocation', payload)
      const data = dirname(installedScript)
      const recordPath = join(data, 'sessions', `${createHash('sha256').update(`antigravity:${session}`).digest('hex')}.json`)
      const readRecord = () => JSON.parse(readFileSync(recordPath, 'utf8'))
      const before = readRecord()
      assert.equal(before.state, 'working')
      const board = new BoardPage(page)
      await board.open(await startServer())
      const card = board.task(before.title)
      await card.waitFor()
      assert.equal(await board.main.locator('li.row').count(), 1)

      const marker = join(root, 'synthetic-progress-lock')
      const injection = join(root, 'synthetic-progress-lock.cjs')
      writeFileSync(injection, `const fs=require('node:fs');const locked=p=>require('node:path').resolve(String(p))===${JSON.stringify(progress)}&&fs.existsSync(${JSON.stringify(marker)});const busy=()=>{throw Object.assign(Error('Synthetic progress lock'),{code:'EBUSY'})};for(const k of ['readFileSync','openSync']){const old=fs[k];fs[k]=(p,...a)=>{if(locked(p))busy();return old(p,...a)}}const old=fs.renameSync;fs.renameSync=(a,b)=>{if(locked(b))busy();return old(a,b)};require('node:module').syncBuiltinESMExports()`)
      writeFileSync(marker, 'owned synthetic lock', { flag: 'wx' })
      let queued
      try {
        fire('Stop', payload, { NODE_OPTIONS: `--require ${JSON.stringify(injection)}` })
        queued = readdirSync(join(data, 'pending')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(data, 'pending', name), 'utf8')))
        assert.ok(queued.some(entry => entry.session === session && entry.event === 'Stop'))
        assert.equal(readRecord().state, 'working')
      } finally {
        unlinkSync(marker)
      }
      const releasedAt = Date.now()
      const until = releasedAt + 10_000
      while (readRecord().state !== 'waiting' && Date.now() < until) await new Promise(done => setTimeout(done, 25))
      const after = readRecord()
      assert.equal(after.state, 'waiting')
      assert.ok(queued.some(entry => entry.at === after.appliedAt))
      assert.deepEqual(readdirSync(join(data, 'pending')).filter(name => name.endsWith('.json')), [])
      // The page has no separate "is working" label any more (a task in Working now is working); after the queued Stop
      // is applied it still shows the one task, once, with the lifecycle step the record now holds.
      await page.reload()
      await card.waitFor()
      assert.equal(await board.main.locator('li.row').count(), 1)
      assert.match(await card.innerText(), /Waiting for the next instruction/)
      assert.equal(existsSync(marker), false)
      writeFileSync(join(evidence, 'stop-recovery.json'), JSON.stringify({ releasedAt, observedAt: Date.now(), sourceAt: after.appliedAt, state: after.state, pendingAfter: 0, noNextHookOrManualRecovery: true }, null, 2))
      await assertNoIdentifiers(page, root, [session])
    })
  })

  test('archiving a four-day stopped task retains its unanswered question and original observations', { concurrency: false, timeout: 120_000 }, async () => {
    await browserFixture('old-unanswered-archive', async ({ root, page, progress, startServer }) => {
      const old = new Date(Date.now() - 4 * 86400000).toISOString()
      const words = 'Keep the four-day question recoverable, OK?'
      const title = 'Preserve an old unanswered question'
      writeProgress(progress, [
        block('a61ce001', 'muse', 'ended', 'Synthetic aging', title, [`- [?] ${words}`], 'Synthetic four-day archive boundary.', old),
        block('a61ce002', 'codex', 'ended', 'Synthetic aging', 'Another stopped fixture', ['- [ ] Completed synthetic inspection'], 'Synthetic browser fixture only.', old),
        block('a61ce003', 'antigravity', 'working', 'Synthetic aging', 'Keep the active fixture visible', ['- [~] Inspect the archive boundary']),
      ].join('\n'))
      const board = new BoardPage(page)
      await board.open(await startServer())
      const ledger = join(dirname(progress), 'progress-questions.json')
      const record = () => JSON.parse(readFileSync(ledger, 'utf8')).records.find(one => one.words === words)
      const until = Date.now() + 10_000
      while (Date.now() < until && (!existsSync(ledger) || !record())) await new Promise(done => setTimeout(done, 100))
      const before = record()
      assert.ok(before)
      await page.locator('.shelf-head').filter({ hasText: 'Stopped' }).click()
      // The question shows on its Stopped row (the step it stopped at) and in the Older line on the Needs you sheet.
      const stoppedRow = await board.openTask(title)
      await stoppedRow.locator('.r-meta').getByText(words).waitFor()
      await stoppedRow.getByRole('button', { name: 'Archive', exact: true }).click()
      await board.task(title).waitFor({ state: 'detached' })
      await page.getByText('1 older question still unanswered (its chat has stopped)', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'See all', exact: true }).click()
      await page.getByText(words, { exact: true }).waitFor()
      await board.task('Keep the active fixture visible').waitFor()
      await page.reload()
      await page.getByRole('button', { name: 'See all', exact: true }).click()
      await page.getByText(words, { exact: true }).waitFor()
      const after = record()
      assert.equal(after.id, before.id)
      assert.equal(after.firstObserved, before.firstObserved)
      assert.deepEqual(after.source, before.source)
      assert.equal(after.isArchived, true)
      assert.equal(after.isUnresolved, true)
      assert.equal(JSON.parse(after.source.data).auto.updated, Date.parse(old))
      assert.ok(!readFileSync(progress, 'utf8').includes(title))
      assert.match(monthlyArchive(progress), /Keep the four-day question recoverable/)
      await assertNoIdentifiers(page, root, ['a61ce001', 'a61ce002', 'a61ce003'])
    })
  })

  test('a clipped text or step fold the person closes stays closed when a redraw runs before its toggle event (#1456)', { concurrency: false, timeout: 120_000 }, async () => {
    await browserFixture('details-close-redraw-race', async ({ page, progress, startServer }) => {
      const longStep = 'Review the complete synthetic rollout plan without losing collapsed state across a concurrent board redraw. '.repeat(3).trim()
      const steps = [`- [ ] ${longStep}`, '- [ ] Synthetic second open step', '- [ ] Synthetic third open step']
      writeProgress(progress, `## Synthetic race\n### Close before toggle\n${steps.join('\n')}\n`)
      const board = new BoardPage(page)
      await board.open(await startServer())
      const task = await board.openTask('Close before toggle')
      const fold = task.locator('details:not(.clip)').filter({ has: page.locator('summary', { hasText: '2 more steps' }) })
      const clip = task.locator('.steps details.clip').first()
      await fold.evaluate(node => new Promise(done => {
        node.addEventListener('toggle', () => done(), { once: true })
        node.querySelector('summary').click()
      }))
      await clip.evaluate(node => new Promise(done => {
        node.addEventListener('toggle', () => done(), { once: true })
        node.querySelector('summary').click()
      }))
      assert.equal(await fold.evaluate(node => node.open), true)
      assert.equal(await clip.evaluate(node => node.open), true)

      await page.evaluate(() => {
        const origFetch = window.fetch
        window.__race = { armed: true, done: false, toggledBeforeDraw: null, closedSync: null, afterDraw: null }
        window.fetch = async function (...args) {
          const res = await origFetch.apply(this, args)
          const url = typeof args[0] === 'string' ? args[0] : ''
          if (!window.__race.armed || !url.includes('/api/board') || res.status !== 200) return res
          const origJson = res.json.bind(res)
          res.json = async function () {
            const data = await origJson()
            if (window.__race.armed && JSON.stringify(data).includes('Synthetic redraw race task')) {
              window.__race.armed = false
              const root = document.getElementById('board')
              const liveFold = [...root.querySelectorAll('details:not(.clip)')].find(node => node.querySelector('summary')?.textContent === '2 more steps')
              const liveClip = [...root.querySelectorAll('.steps details.clip')].find(node => node.textContent.includes('Review the complete synthetic rollout plan'))
              let toggled = false
              const mark = () => { toggled = true }
              liveFold.addEventListener('toggle', mark, { once: true })
              liveClip.addEventListener('toggle', mark, { once: true })
              liveFold.querySelector('summary').click()
              liveClip.querySelector('summary').click()
              const closedSync = [liveFold.open, liveClip.open]
              const observer = new MutationObserver(() => {
                if (!root.textContent.includes('Synthetic redraw race task')) return
                observer.disconnect()
                const nextFold = [...root.querySelectorAll('details:not(.clip)')].find(node => node.querySelector('summary')?.textContent === '2 more steps')
                const nextClip = [...root.querySelectorAll('.steps details.clip')].find(node => node.textContent.includes('Review the complete synthetic rollout plan'))
                window.__race = {
                  armed: false,
                  done: true,
                  toggledBeforeDraw: toggled,
                  closedSync,
                  afterDraw: [nextFold?.open ?? null, nextClip?.open ?? null],
                }
              })
              observer.observe(root, { childList: true, subtree: true })
            }
            return data
          }
          return res
        }
      })

      writeProgress(progress, `## Synthetic race\n### Close before toggle\n${steps.join('\n')}\n\n### Synthetic redraw race task\n- [ ] Trigger redraw\n`)
      await board.task('Synthetic redraw race task').waitFor()
      const race = await page.evaluate(() => window.__race)
      assert.equal(race.done, true)
      assert.equal(race.toggledBeforeDraw, false)
      assert.deepEqual(race.closedSync, [false, false])
      assert.deepEqual(race.afterDraw, [false, false])
      await page.evaluate(() => new Promise(done => setTimeout(done, 0)))
      assert.deepEqual(await Promise.all([fold.evaluate(node => node.open), clip.evaluate(node => node.open)]), [false, false])
      // Re-opening after the race still sticks across a subsequent redraw.
      await fold.locator('summary', { hasText: '2 more steps' }).click()
      await clip.locator('summary').click()
      writeProgress(progress, `## Synthetic race\n### Close before toggle\n${steps.join('\n')}\n\n### Synthetic redraw race task\n- [ ] Trigger second redraw\n`)
      await page.locator('.short', { hasText: 'Trigger second redraw' }).waitFor()
      assert.deepEqual(await Promise.all([fold.evaluate(node => node.open), clip.evaluate(node => node.open)]), [true, true])
    })
  })
})
