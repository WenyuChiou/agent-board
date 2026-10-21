import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EN } from '../../hooks/strings-en.ts'
import { makeWorld } from './lib/world.mjs'
import { storageFault } from './lib/faults.mjs'
import { run, serve, pageDom } from './lib/surfaces.mjs'

const journalText = world => world.files().filter(name => /^progress-journal-.*\.md$/.test(name)).map(name => world.read(name)).join('\n')
const journalName = world => {
  const day = new Date(world.now)
  return `progress-journal-${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}.md`
}
const stamp = at => {
  const day = new Date(at)
  const two = value => String(value).padStart(2, '0')
  return `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())} ${two(day.getHours())}:${two(day.getMinutes())}`
}
const descendants = node => [node, ...node.childNodes.flatMap(descendants)]
// The whole reason, wrapped under the pressed card and never cut.
const resultUnderCard = (frame, note) => {
  const lines = frame.split('\n')
  const card = lines.findIndex(line => line.includes('First card'))
  assert.ok(card >= 0, frame)
  const under = []
  for (const line of lines.slice(card + 1)) {
    if (!line.startsWith('    ') || under.join(' ') === note) break
    under.push(line.trim())
  }
  assert.equal(under.join(' '), note, frame)
  assert.ok(!under.some(line => line.includes('…')), frame)
}
const unsaved = EN.boardSaveFailed(EN.fileProgress, EN.storageReadOnly)
// progress.md cannot be replaced, the way a read-only file refuses it on Windows; the journal
// beside it can still be written.
const readOnlyProgress = world => storageFault(world, { code: 'EPERM' }).enable('write')

test('L5 read-only file: a failed tick writes no journal line and shows a one-line reason', async () => {
  const world = makeWorld()
  try {
    const step = 'Review every route in the synthetic deployment report'
    const source = `## Demo\n### First card\n- [ ] ${step}\n`
    world.write('progress.md', source)
    readOnlyProgress(world)
    const terminal = await run(world, ['--keys', 'x'])
    assert.notEqual(terminal.status, 0, terminal.stderr)
    assert.equal(terminal.signal, null)
    assert.equal(terminal.stderr.trim(), unsaved)
    resultUnderCard(terminal.stdout, unsaved)
    assert.equal(world.read('progress.md'), source)
    assert.ok(!journalText(world).includes(step))

    const server = await serve.start(world)
    const model = (await server.get('/api/board')).json().model
    let response
    const page = await pageDom((await server.get(new URL(server.url).pathname + new URL(server.url).search)).body, model, async request => {
      response = await server.post(request.path, request.body)
      return { ok: response.status < 400, json: async () => response.json() }
    })
    const card = page.cards().find(one => one.textContent.includes('First card'))
    assert.ok(card, page.text())
    const button = page.buttons(card).find(one => one.textContent === `Done: ${step}`)
    assert.ok(button, card.textContent)
    button.click()
    await page.flush()
    assert.equal(response.status, 409)
    const result = descendants(card).find(one => one.className?.split(' ').includes('press-result'))
    assert.equal(result?.textContent, unsaved)
    assert.equal(world.read('progress.md'), source)
    assert.ok(!journalText(world).includes(step))
  } finally { await world.close() }
})

test('L5 read-only file: a failed confirm-done writes no journal line', async () => {
  const world = makeWorld()
  try {
    // The same step twice gives the same journal line twice: both are taken back.
    const steps = ['Review the synthetic route report', 'Review the synthetic route report', 'Check the synthetic deployment plan']
    const source = `## Demo\n### First card\n${steps.map(step => `- [ ] ${step}`).join('\n')}\n`
    world.write('progress.md', source)
    readOnlyProgress(world)
    const terminal = await run(world, ['--keys', 'd'])
    assert.notEqual(terminal.status, 0, terminal.stderr)
    assert.equal(terminal.signal, null)
    assert.equal(terminal.stderr.trim(), unsaved)
    resultUnderCard(terminal.stdout, unsaved)
    assert.equal(world.read('progress.md'), source)
    for (const step of steps) assert.ok(!journalText(world).includes(step))
  } finally { await world.close() }
})

test('L5 read-only file: a failed tick keeps the journal lines that were there before or written meanwhile', async () => {
  const world = makeWorld()
  try {
    const step = 'Review the synthetic gateway routes'
    const source = `## Demo\n### First card\n- [ ] ${step}\n`
    world.write('progress.md', source)
    // A CRLF line inside, so a rewrite that normalised the lines it keeps would show.
    const before = '# Work log\r\n- 2026-10-01 09:00 · Demo · Earlier card · Earlier synthetic work\n'
    const meanwhile = '- 2026-10-01 09:05 · Docs · Other card · Another writer finished a synthetic report\r\n'
    const journal = world.write(journalName(world), before)
    // Another writer adds a line between this tick's journal write and its refused board write.
    const preload = world.write('meanwhile-fault.cjs', `const fs = require('node:fs')
const { resolve } = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const target = ${JSON.stringify(world.path)}
const rename = fs.renameSync
let isFirst = true
fs.renameSync = (from, to, ...args) => {
  if (resolve(String(to)) !== resolve(target)) return rename(from, to, ...args)
  if (isFirst) { isFirst = false; fs.appendFileSync(${JSON.stringify(journal)}, ${JSON.stringify(meanwhile)}) }
  throw Object.assign(new Error('synthetic read-only progress file'), { code: 'EPERM' })
}
syncBuiltinESMExports()
`)
    world.env.NODE_OPTIONS += ` --require=${JSON.stringify(preload)}`
    const terminal = await run(world, ['--keys', 'x'])
    assert.notEqual(terminal.status, 0, terminal.stderr)
    assert.equal(terminal.stderr.trim(), unsaved)
    assert.equal(world.read('progress.md'), source)
    assert.equal(world.read(journalName(world)), before + meanwhile)
  } finally { await world.close() }
})

test('L5 read-only file: a failed tick whose line was already in the journal leaves the journal as it was', async () => {
  const world = makeWorld()
  try {
    const step = 'Review the synthetic gateway routes'
    const source = `## Demo\n### First card\n- [ ] ${step}\n`
    world.write('progress.md', source)
    // The line this tick would write, for this minute and the next, so a minute that turns
    // during the run still finds it there.
    // CRLF endings: an append would turn the last one into LF, so this passes only when the
    // tick found its line there and wrote nothing.
    const lines = [world.now, world.now + 60000].map(at => `- ${stamp(at)} · Demo · First card · ${step}`)
    const before = `# Work log\r\n${lines.join('\r\n')}\r\n`
    world.write(journalName(world), before)
    readOnlyProgress(world)
    const terminal = await run(world, ['--keys', 'x'])
    assert.notEqual(terminal.status, 0, terminal.stderr)
    assert.equal(terminal.stderr.trim(), unsaved)
    assert.equal(world.read('progress.md'), source)
    assert.equal(world.read(journalName(world)), before)
  } finally { await world.close() }
})

test('L5 locked file: a tick whose board write landed before the file was locked keeps its journal line', async () => {
  const world = makeWorld()
  try {
    const step = 'Review the synthetic gateway routes'
    world.write('progress.md', `## Demo\n### First card\n- [ ] ${step}\n`)
    // The board is replaced, then another program holds progress.md, so reading it back fails.
    const preload = world.write('landed-fault.cjs', `const fs = require('node:fs')
const { resolve } = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const target = ${JSON.stringify(world.path)}
const rename = fs.renameSync
const read = fs.readFileSync
let isHeld = false
fs.renameSync = (from, to, ...args) => {
  const result = rename(from, to, ...args)
  if (resolve(String(to)) === resolve(target)) isHeld = true
  return result
}
fs.readFileSync = (file, ...args) => {
  if (isHeld && resolve(String(file)) === resolve(target)) throw Object.assign(new Error('synthetic busy file'), { code: 'EBUSY' })
  return read(file, ...args)
}
syncBuiltinESMExports()
`)
    world.env.NODE_OPTIONS += ` --require=${JSON.stringify(preload)}`
    const terminal = await run(world, ['--keys', 'x'])
    assert.notEqual(terminal.status, 0, terminal.stderr)
    assert.ok(terminal.stderr.includes(EN.boardStorageFailed(EN.fileProgress, EN.storageBusy)), terminal.stderr)
    assert.ok(world.read('progress.md').includes(`- [x] ${step}`))
    assert.ok(journalText(world).includes(`First card · ${step}`))
  } finally { await world.close() }
})
