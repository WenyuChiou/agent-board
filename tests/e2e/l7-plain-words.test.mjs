import { test } from 'node:test'
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EN } from '../../hooks/strings-en.ts'
import { ZH_TW } from '../../hooks/i18n.ts'
import { ZH_CN } from '../../hooks/strings-zh-cn.ts'
import { makeWorld } from './lib/world.mjs'
import { block, turn } from './lib/writers.mjs'
import { chat, inspectSurfaces, pageDom, plain, run, serve, terminal } from './lib/surfaces.mjs'
import { knownFailure } from './lib/known.mjs'
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
      // The tick takes back its own journal line when progress.md cannot be replaced, so
      // nothing was changed (#248).
      const expected = s.boardSaveFailed(s.fileProgress, s.storageReadOnly)
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

// How wide a terminal draws a line: CJK, fullwidth forms and emoji take two columns, anything
// else one. This count is kept here apart from the board's own in hooks/board.ts, which is not
// exported, so a wrong count in the product cannot hide itself in the check.
const WIDE = /[\u{1100}-\u{115f}\u{2e80}-\u{a4cf}\u{ac00}-\u{d7a3}\u{f900}-\u{faff}\u{fe30}-\u{fe6f}\u{ff00}-\u{ff60}\u{ffe0}-\u{ffe6}\u{20000}-\u{3fffd}\p{Emoji_Presentation}]/u
// A colour code takes no column, so it is taken off before the count.
const displayWidth = text => [...plain(text)].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0)
const COLUMNS = 100
const DAY = 24 * 60 * 60 * 1000

// Each name is its role word and as many repeats of one phrase as it takes to pass 120 columns.
// A Chinese name that long has about 60 characters, so a count of characters instead of columns
// would let it through.
const wording = {
  en: {
    unit: ' reservoir release schedule for the synthetic basin',
    role: { project: 'Basin planning', other: 'Delta monitoring', due: 'Review budget', title: 'Reconcile releases', context: 'Why this exists', step: 'Compare totals', question: 'Publish the schedule', report: 'Finished checking' },
    ask: ', OK?',
  },
  'zh-TW': {
    unit: '合成流域水庫放水排程，',
    role: { project: '流域規劃', other: '三角洲監測', due: '審查預算', title: '核對放水量', context: '這項工作的原因', step: '比對總量', question: '發布排程', report: '完成檢查' },
    ask: '，可以嗎？',
  },
  'zh-CN': {
    unit: '合成流域水库放水排程，',
    role: { project: '流域规划', other: '三角洲监测', due: '审查预算', title: '核对放水量', context: '这项工作的原因', step: '比对总量', question: '发布排程', report: '完成检查' },
    ask: '，可以吗？',
  },
}
const longName = (lang, role, number = '', tail = '') => {
  const { unit, role: roles } = wording[lang]
  let text = number === '' ? roles[role] : `${roles[role]} ${number}`
  while (displayWidth(text + tail) < 120) text += unit
  return text + tail
}
const AGENT = 'synthetic-reporting-agent-with-a-long-name'

// A board with every kind of row in it, all with long names: a question, working, due soon, idle
// and stopped tasks, questions that have waited 4 and 8 days, and a turn nobody has taken in yet.
const seedLongBoard = async (world, lang) => {
  const name = (role, number, tail) => longName(lang, role, number, tail)
  const project = name('project')
  const other = name('other')
  const ask = (session, number, tail = wording[lang].ask) => block(world, { project, agent: AGENT, session, state: 'waiting', title: name('title', number), steps: [`- [?] ${name('question', number, tail)}`] })
  // A question's age starts when the board first looks at it, so the board looks and the clock then moves.
  world.write('progress.md', `## ${project}\n`)
  ask('a1000015', 5)
  await terminal.keys(world, 'down')
  world.jump('4d')
  ask('a1000016', 6)
  await terminal.keys(world, 'down')
  world.jump('4d')
  // The heartbeat of a block does not renew its question, so both stay 8 and 4 days old.
  ask('a1000015', 5)
  ask('a1000016', 6)
  const due = new Date(world.now + 2 * DAY).toISOString().slice(5, 10)
  world.write('progress.md', world.read('progress.md').replace(`## ${project}\n`, `## ${project}\n### ${name('due')}\n> due ${due}\n- [ ] ${name('step', 9)}\n`))
  // The step of the working task that starts with emoji is the one a terminal draws wider than the
  // board counts it.
  const marks = '\u{2705}'.repeat(6)
  block(world, { project, agent: AGENT, session: 'a1000011', title: name('title', 1), steps: [`- [x] ${name('step', 1)}`, `- [~] ${marks}${name('step', 2)}`, `- [ ] ${name('step', 3)}`] })
  ask('a1000012', 2)
  block(world, { project: other, agent: AGENT, session: 'a1000013', updated: new Date(world.now - 8 * DAY).toISOString(), title: name('title', 3), steps: [`- [~] ${name('step', 4)}`] })
  block(world, { project: other, agent: AGENT, session: 'a1000014', state: 'ended', title: name('title', 4), steps: [`- [~] ${name('step', 5)}`] })
  // block() writes one fixed context line, so the long one replaces it.
  world.write('progress.md', world.read('progress.md').replaceAll('> Context: Synthetic journey scenario', `> Context: ${name('context')}`))
  turn(world, 'codex', { session: 'codex-width-session', project: name('other', 'inbox'), text: name('report') })
  return { project, other, name }
}

// The overflow lines #383 names, as wideLinesOf words them ("<language> / <screen> / <width> columns: <line>").
// They are the group heading (a line that starts with the arrow), a line with emoji, the due badge
// that is added after the line is clipped, and the rows of the shelves that --all opens (a project
// and task row with the arrow between them, and the question under it).
const SHELF_QUESTION = new RegExp(`: {5}(?:${Object.values(wording).map(one => one.role.question).join('|')})`)
const of383 = line => /: ▸ \S/.test(line) || /\p{Emoji_Presentation}/u.test(line) || line.includes('⚑')
  || (line.includes('/ board with --all /') && (/: {3}\S.* › /.test(line) || SHELF_QUESTION.test(line)))

const wideLines = text => text.split(/\r?\n/).filter(line => displayWidth(line) > COLUMNS).map(line => `${displayWidth(line)} columns: ${line}`)

// Draws the long-named board in each language and gives back every line a 100-column terminal
// would wrap, with its language and screen. All three languages run before anything is asserted,
// so one failure shows how far each of them goes.
const wideLinesOf = async (look, expected) => {
  const wide = []
  for (const s of locales) {
    const world = makeWorld({ lang: s.lang })
    try {
      await seedLongBoard(world, s.lang)
      // The board reads the terminal's width from process.stdout.columns, which a piped run lacks.
      const preload = world.write('columns-preload.mjs', `Object.defineProperty(process.stdout, 'columns', { value: ${COLUMNS}, configurable: true })\n`)
      world.env.NODE_OPTIONS += ` --import=${pathToFileURL(preload).href}`
      const screens = await look(world)
      // A screen that never showed the long names would pass for the wrong reason.
      const shown = screens.map(([, text]) => text).join('\n')
      // The role word and the number are what tells one row from another, so both must be there.
      for (const [role, number] of expected) assert.ok(shown.includes(`${wording[s.lang].role[role]} ${number}`.trim()), `${s.lang}: ${role} ${number} is not on any screen\n${shown}`)
      for (const [surface, text] of screens) wide.push(...wideLines(text).map(line => `${s.lang} / ${surface} / ${line}`))
    } finally { await world.close() }
  }
  return wide
}

test('L7 one line per row at 100 columns: the terminal board and its screen keep every line within 100 display columns in en, zh-TW and zh-CN', async () => {
  const wide = await wideLinesOf(async world => {
    const screens = [['board', await terminal.screen(world)], ['board with --all', await terminal.screen(world, ['--all'])]]
    // The screen shows a row's steps only once the row is open, and one run opens one line. With
    // the idle shelf open (i) the lines are the question, due, working, idle and stopped tasks and
    // the turn. With the older shelf open (l) the two aged questions come after the first one.
    const opened = ['enter', 'i down enter', 'i down down enter', 'i down down down enter', 'i down down down down enter', 'i down down down down down enter', 'l down enter', 'l down down enter']
    for (const keys of opened) screens.push([`screen after ${keys}`, await terminal.keys(world, keys)])
    // The 100 must have reached the board, or every line would fit at the 80 it falls back to.
    assert.ok(screens.some(([, text]) => text.split('\n').some(line => displayWidth(line) > 80)), screens[0][1])
    return screens
  }, [['project', ''], ['other', ''], ['due', ''], ['title', 1], ['title', 3], ['title', 4], ['question', 2], ['question', 5], ['question', 6], ['other', 'inbox']])
  // Four kinds of line run past 100 columns today, and #383 names all of them. A line of any other
  // kind is a new overflow and fails here at once, outside the known failure. The chat print is
  // left out on purpose, since it has its own 200-column line.
  assert.deepEqual(wide.filter(line => !of383(line)), [], 'a line past 100 columns that #383 does not name')
  const named = wide.filter(of383)
  // The overflow does not depend on load, so the known failure may not pass quietly.
  assert.deepEqual(named, [])
})
