import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEAF_AFTER_MS, watchedReads } from '../scripts/watched-reads.ts'

// The page server's idle-poll reads (#254). A stand-in watch reports only what a test tells it to, so
// each case decides which events arrive and when.
const world = () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-board-watched-reads-'))
  const folder = join(root, 'home')
  mkdirSync(folder)
  const progress = join(folder, 'progress.md')
  const seen = join(folder, 'progress-seen.json')
  writeFileSync(progress, '# Project\n')
  writeFileSync(seen, '{"a":1}')
  const watchers = []
  let clock = 1000
  const reads = watchedReads({
    directories: [folder],
    files: [progress],
    now: () => clock,
    watch: (directory, listener) => {
      const watcher = Object.assign(new EventEmitter(), { directory, listener, isClosed: false, close() { this.isClosed = true }, unref() {} })
      watchers.push(watcher)
      return watcher
    },
  })
  let looks = 0
  const readSeen = () => reads.get(seen, 'read', () => { looks += 1; return readFileSync(seen, 'utf8') })
  return {
    root, folder, progress, seen, reads, watchers, readSeen,
    get looks() { return looks },
    tick: ms => { clock += ms },
    event: name => { for (const one of watchers) if (!one.isClosed) one.listener('change', name) },
    close: () => { reads.close(); rmSync(root, { recursive: true, force: true }) },
  }
}

test('an idle poll reads an unchanged file once while its folder watch reports nothing', () => {
  const w = world()
  try {
    w.reads.check()
    assert.equal(w.reads.isOn(), true)
    assert.equal(w.readSeen(), '{"a":1}')
    for (let poll = 0; poll < 5; poll += 1) {
      w.tick(200)
      w.reads.check()
      assert.equal(w.readSeen(), '{"a":1}')
    }
    assert.equal(w.looks, 1)
  } finally { w.close() }
})

test('a file another program wrote in place is read again once the watch names it', () => {
  const w = world()
  try {
    w.reads.check()
    assert.equal(w.readSeen(), '{"a":1}')
    // Same size, written in place: no folder or progress.md stamp moves, only the watch tells.
    writeFileSync(w.seen, '{"a":2}')
    w.event('progress-seen.json')
    w.reads.check()
    assert.equal(w.readSeen(), '{"a":2}')
    assert.equal(w.looks, 2)
  } finally { w.close() }
})

test('a watch event with no file name makes every file of its folder read again', () => {
  const w = world()
  try {
    w.reads.check()
    w.readSeen()
    writeFileSync(w.seen, '{"a":3}')
    w.event(null)
    w.reads.check()
    assert.equal(w.readSeen(), '{"a":3}')
  } finally { w.close() }
})

test('progress.md appended to before its watch event arrives is read again on that poll', () => {
  const w = world()
  try {
    w.reads.check()
    const readProgress = () => w.reads.get(w.progress, 'read', () => readFileSync(w.progress, 'utf8'))
    assert.equal(readProgress(), '# Project\n')
    w.readSeen()
    appendFileSync(w.progress, '- [ ] Ship\n')
    w.tick(100)
    w.reads.check()
    assert.equal(readProgress(), '# Project\n- [ ] Ship\n')
    // The moved stamp forgets every file, not only progress.md.
    assert.equal(w.looks, 1)
    w.readSeen()
    assert.equal(w.looks, 2)
    // The event comes late: the watch still counts as working.
    w.event('progress.md')
    w.tick(DEAF_AFTER_MS)
    w.reads.check()
    assert.equal(w.reads.isOn(), true)
  } finally { w.close() }
})

test('a file renamed over another in the folder is read again on the next poll even before its event', () => {
  const w = world()
  try {
    w.reads.check()
    w.readSeen()
    // The turn stamps the kept file once. NTFS does not move the folder's stamp on a rename over a
    // file, so on Windows it is the turn, seeing the new file identity, that forgets the kept copy.
    w.tick(100)
    w.reads.check()
    const temp = `${w.seen}.tmp`
    writeFileSync(temp, '{"b":1}')
    renameSync(temp, w.seen)
    w.tick(100)
    w.reads.check()
    assert.equal(w.readSeen(), '{"b":1}')
  } finally { w.close() }
})

test('a watch that never reports a change the stamps saw stops the cache, and every read goes to the file', () => {
  const w = world()
  try {
    w.reads.check()
    w.readSeen()
    appendFileSync(w.progress, '- [ ] One\n')
    w.tick(100)
    w.reads.check()
    assert.equal(w.reads.isOn(), true, 'one moved stamp with no event yet is not enough')
    w.tick(DEAF_AFTER_MS)
    w.reads.check()
    assert.equal(w.reads.isOn(), false)
    assert.ok(w.watchers.every(one => one.isClosed))
    // Written in place with no event: read anyway now.
    writeFileSync(w.seen, '{"a":9}')
    assert.equal(w.readSeen(), '{"a":9}')
    const before = w.looks
    w.readSeen()
    assert.equal(w.looks, before + 1)
  } finally { w.close() }
})

test('a watch error on a folder that is still there stops the cache', () => {
  const w = world()
  try {
    w.reads.check()
    w.readSeen()
    w.watchers[0].emit('error', new Error('ENOSPC'))
    assert.equal(w.reads.isOn(), false)
    w.readSeen()
    assert.equal(w.looks, 2)
  } finally { w.close() }
})

test('a folder removed and made again is watched again from its new identity', () => {
  const w = world()
  const inbox = join(w.folder, 'progress-inbox')
  mkdirSync(inbox)
  const watchers = []
  let clock = 0
  const reads = watchedReads({
    directories: [inbox], files: [], now: () => clock,
    watch: (directory, listener) => {
      const watcher = Object.assign(new EventEmitter(), { listener, isClosed: false, close() { this.isClosed = true }, unref() {} })
      watchers.push(watcher)
      return watcher
    },
  })
  try {
    reads.check()
    assert.equal(watchers.length, 1)
    let looks = 0
    const names = () => reads.listing(inbox, 'names', () => { looks += 1; return 'listed' })
    names()
    names()
    assert.equal(looks, 1)
    rmSync(inbox, { recursive: true })
    clock += 100
    reads.check()
    assert.equal(watchers[0].isClosed, true)
    names()
    assert.equal(looks, 2, 'a folder with no watch is always looked at')
    mkdirSync(inbox)
    clock += 100
    reads.check()
    assert.equal(watchers.length, 2)
    assert.equal(reads.isOn(), true)
  } finally { reads.close(); w.close() }
})

test('a file another program holds is read again on the next poll, and a missing file is kept as missing', () => {
  const w = world()
  try {
    w.reads.check()
    let tries = 0
    const held = () => w.reads.get(join(w.folder, 'progress-answered.json'), 'read', () => {
      tries += 1
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    })
    assert.throws(held, /EBUSY/)
    assert.throws(held, /EBUSY/)
    assert.equal(tries, 2)
    let misses = 0
    const missing = () => w.reads.get(join(w.folder, 'progress-questions.json'), 'stat', () => {
      misses += 1
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    assert.throws(missing, /ENOENT/)
    assert.throws(missing, /ENOENT/)
    assert.equal(misses, 1)
    w.event('progress-questions.json')
    assert.throws(missing, /ENOENT/)
    assert.equal(misses, 2)
  } finally { w.close() }
})

test('a folder listing is looked at again after any event in its folder', () => {
  const w = world()
  try {
    w.reads.check()
    let looks = 0
    const names = () => w.reads.listing(w.folder, 'folder', () => { looks += 1; return looks })
    assert.equal(names(), 1)
    assert.equal(names(), 1)
    w.event('progress-question-proof-retired-abc.json')
    assert.equal(names(), 2)
  } finally { w.close() }
})

test('a write by this process forgets every kept file', () => {
  const w = world()
  try {
    w.reads.check()
    w.readSeen()
    writeFileSync(w.seen, '{"a":4}')
    w.reads.clear()
    assert.equal(w.readSeen(), '{"a":4}')
  } finally { w.close() }
})

test('a file outside the watched folders is always read', () => {
  const w = world()
  try {
    w.reads.check()
    const other = join(w.root, 'elsewhere.json')
    writeFileSync(other, 'x')
    let looks = 0
    w.reads.get(other, 'read', () => { looks += 1 })
    w.reads.get(other, 'read', () => { looks += 1 })
    assert.equal(looks, 2)
  } finally { w.close() }
})

test('a file written in place while the watch says nothing is found by the turn of kept-file stamps', () => {
  const w = world()
  const answered = join(w.folder, 'progress-answered.json')
  writeFileSync(answered, '{"answered":[]}')
  try {
    w.reads.check()
    const readAnswered = () => w.reads.get(answered, 'read', () => readFileSync(answered, 'utf8'))
    assert.equal(readAnswered(), '{"answered":[]}')
    w.readSeen()
    // Two kept files: each is stamped once within two checks.
    w.tick(100); w.reads.check()
    w.tick(100); w.reads.check()
    // A pane hides a question by writing the list in place; the watch is silent.
    writeFileSync(answered, '{"answered":["q1","q2"]}')
    let seenNew = false
    for (let poll = 0; poll < 2 && !seenNew; poll += 1) {
      w.tick(100)
      w.reads.check()
      seenNew = readAnswered() === '{"answered":["q1","q2"]}'
      w.readSeen()
    }
    assert.ok(seenNew, 'the in-place write must show within one round of the kept files')
    // No event came for it: the watch counts as deaf and the cache goes off.
    for (let poll = 0; poll < 3; poll += 1) { w.tick(DEAF_AFTER_MS); w.reads.check() }
    assert.equal(w.reads.isOn(), false)
  } finally { w.close() }
})
