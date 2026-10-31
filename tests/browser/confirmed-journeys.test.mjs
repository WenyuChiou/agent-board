import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { BoardPage } from './board-page.mjs'
import { browserFixture, hiddenQuestion, installAntigravity, monthlyArchive, writeProgress } from './fixture.mjs'

const block = (session, agent, state, project, title, steps, context = 'Synthetic browser fixture only.', updated = new Date().toISOString()) => `## ${project}
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
      // Each step's Done button sits under its text, as wide as its one-line label allows (not squeezed into the mark's column).
      const ticks = task.locator('.steps li > button')
      assert.equal(await ticks.count(), 3)
      for (const tick of await ticks.all()) {
        const place = await tick.evaluate(node => {
          const box = node.getBoundingClientRect(), text = node.parentElement.querySelector('.clip').getBoundingClientRect()
          return { left: box.left, right: box.right, width: box.width, height: box.height, textLeft: text.left, textRight: text.right, title: node.title }
        })
        assert.ok(place.width >= 44 && place.left >= place.textLeft - 1 && place.right <= place.textRight + 1, JSON.stringify(place))
        assert.ok(place.height <= 56, JSON.stringify(place))
        assert.ok([chinese, english, unbroken].includes(place.title), place.title)
      }
      await task.getByRole('button', { name: `Done: ${chinese}`, exact: true }).first().click()
      await waitFor(() => readFileSync(progress, 'utf8').includes(`- [x] ${chinese}`))
      assert.ok(readFileSync(progress, 'utf8').includes(`- [ ] ${english}`))
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
      await question.getByRole('button', { name: 'Copy "Bold"', exact: true }).waitFor()
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
})
