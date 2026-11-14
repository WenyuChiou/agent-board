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
      // The press must reach the board and be taken: a lost or refused press fails here, not as a row that never leaves (#1468).
      const pressed = page.waitForResponse(answer => new URL(answer.url()).pathname === '/api/act')
      await stoppedRow.getByRole('button', { name: 'Archive', exact: true }).click()
      assert.equal((await pressed).status(), 200)
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

  test('a press held while the board redraws still archives the row it was pressed on (#1468)', { concurrency: false, timeout: 120_000 }, async () => {
    await browserFixture('press-during-redraw', async ({ page, progress, startServer }) => {
      const old = new Date(Date.now() - 4 * 86400000).toISOString()
      const title = 'Archive under a moving board'
      const working = step => block('a62ce003', 'antigravity', 'working', 'Synthetic presses', 'Keep the board moving', [step])
      const stopped = block('a62ce001', 'codex', 'ended', 'Synthetic presses', title, ['- [ ] Completed synthetic inspection'], 'Synthetic browser fixture only.', old)
      writeProgress(progress, [stopped, working('- [~] Inspect the first synthetic step')].join('\n'))
      const board = new BoardPage(page)
      await board.open(await startServer())
      await page.locator('.shelf-head').filter({ hasText: 'Stopped' }).click()
      const row = await board.openTask(title)
      const archive = row.getByRole('button', { name: 'Archive', exact: true })
      // The opened row settles a moment after it opens; press only once the button has stayed put for a second,
      // so the only thing that can move it under the pointer is the redraw this test makes.
      let lastBox = ''
      let still = 0
      for (const until = Date.now() + 10_000; still < 10; await new Promise(done => setTimeout(done, 100))) {
        if (Date.now() > until) throw new Error('the Archive button kept moving after its row opened')
        const box = JSON.stringify(await archive.boundingBox())
        still = box === lastBox ? still + 1 : 0
        lastBox = box
      }
      await archive.hover()
      await page.mouse.down()
      // The file changes while the button is held, and the board's next answer carries the new model.
      const moved = page.waitForResponse(answer => new URL(answer.url()).pathname === '/api/board' && answer.status() === 200)
      writeProgress(progress, [stopped, working('- [~] Inspect the second synthetic step')].join('\n'))
      await moved
      // The page asks again only after it has handled the last answer, so the next answer means that one was handled.
      await page.waitForResponse(answer => new URL(answer.url()).pathname === '/api/board')
      // Under the press the board keeps what it showed.
      assert.equal(await page.getByText('Inspect the second synthetic step').count(), 0)
      const pressed = page.waitForResponse(answer => new URL(answer.url()).pathname === '/api/act')
      await page.mouse.up()
      assert.equal((await pressed).status(), 200)
      await board.task(title).waitFor({ state: 'detached' })
      // Once the pointer is up the board draws again, with the step that changed under the press.
      await page.getByText('Inspect the second synthetic step').first().waitFor()
    })
  })
  // One board, one press held by a synthetic event, one change in the file: does the board draw it before the press ends?
  // `hold` and `end` run in the page; `drawsAfterEnd` says whether the change must show once `end` has run.
  const pointerSource = "const hit = (type, id, buttons = 1) => document.dispatchEvent(new PointerEvent(type, { pointerId: id, buttons, bubbles: true }));"
  const nextBoard = (page) => page.waitForResponse(answer => new URL(answer.url()).pathname === '/api/board')
  const holdJourney = async (name, hold, end, drawsAfterEnd) => {
    await browserFixture(name, async ({ page, progress, startServer }) => {
      const working = step => block('a63ce003', 'antigravity', 'working', 'Synthetic presses', 'Keep the board moving', [step])
      writeProgress(progress, working('- [~] Inspect the first synthetic step'))
      await new BoardPage(page).open(await startServer())
      await page.getByText('Inspect the first synthetic step').first().waitFor()
      await page.evaluate(`(() => { ${pointerSource} ${hold} })()`)
      writeProgress(progress, working('- [~] Inspect the second synthetic step'))
      await page.waitForResponse(answer => new URL(answer.url()).pathname === '/api/board' && answer.status() === 200)
      await nextBoard(page)
      assert.equal(await page.getByText('Inspect the second synthetic step').count(), 0, 'the board drew under the held press')
      await page.evaluate(`(() => { ${pointerSource} ${end} })()`)
      if (drawsAfterEnd) await page.getByText('Inspect the second synthetic step').first().waitFor()
      else {
        await nextBoard(page)
        await nextBoard(page)
        assert.equal(await page.getByText('Inspect the second synthetic step').count(), 0, 'a press that is still held ended early')
        await page.evaluate(`(() => { ${pointerSource} hit('pointerup', 1, 0); hit('pointerup', 2, 0) })()`)
        await page.getByText('Inspect the second synthetic step').first().waitFor()
      }
    })
  }

  test('a cancelled press ends the hold and the board draws again (#1468)', { concurrency: false, timeout: 120_000 }, async () => {
    await holdJourney('press-cancel', "hit('pointerdown', 1)", "hit('pointercancel', 1, 0)", true)
  })

  test('a window that loses focus ends the hold and the board draws again (#1468)', { concurrency: false, timeout: 120_000 }, async () => {
    await holdJourney('press-blur', "hit('pointerdown', 1)", "window.dispatchEvent(new Event('blur'))", true)
  })

  test('a move with no button held ends the hold and the board draws again (#1468)', { concurrency: false, timeout: 120_000 }, async () => {
    await holdJourney('press-move', "hit('pointerdown', 1)", "hit('pointermove', 1, 0)", true)
  })

  test('a release timer left over from an earlier press does not end a newer press (#1468)', { concurrency: false, timeout: 120_000 }, async () => {
    // The mouse reuses one pointer id: down, up and down again before the release timer runs.
    await holdJourney('press-stale-timer', "hit('pointerdown', 1)", "hit('pointerup', 1, 0); hit('pointerdown', 1)", false)
  })

  test('releasing one of two pointers keeps the hold while the other is down (#1468)', { concurrency: false, timeout: 120_000 }, async () => {
    await holdJourney('press-two-pointers', "hit('pointerdown', 1); hit('pointerdown', 2)", "hit('pointerup', 2, 0)", false)
  })
})
