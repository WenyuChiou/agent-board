import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { mkdirSync, mkdtempSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recentInboxFiles } from '../scripts/inbox-files.ts'
import { immutableQuestionFiles } from '../scripts/question-files.ts'

const kinds = [
  { name: 'inbox', create: options => recentInboxFiles(options), value: result => result[0]?.body },
  { name: 'question', create: options => immutableQuestionFiles({ ...options, parse: text => text }), value: result => result?.[0] },
]

const until = async (check, label) => {
  for (const end = Date.now() + 2000; Date.now() < end; await new Promise(done => setTimeout(done, 20))) if (check()) return
  assert.fail(label)
}

for (const kind of kinds) {
  test(`the ${kind.name} watcher stops watching its folder when it is removed and watches it again when it returns`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-board-removed-watch-'))
    const directory = join(root, 'files')
    const watchers = []
    mkdirSync(directory)
    writeFileSync(join(directory, 'one.json'), 'before')
    const reader = kind.create({
      directory, isPersistent: true, accepts: name => name.endsWith('.json'),
      watchFiles: (folder, listener) => {
        const current = watch(folder, listener)
        current.on('close', () => { current.isClosed = true })
        watchers.push(current)
        return current
      },
    })
    try {
      assert.equal(kind.value(reader.read(false)), 'before')
      assert.equal(watchers.length, 1)
      assert.notEqual(watchers[0].isClosed, true)
      rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
      await until(() => watchers[0].isClosed === true, 'the watcher of the removed folder was closed')
      mkdirSync(directory)
      writeFileSync(join(directory, 'one.json'), 'after')
      assert.equal(kind.value(reader.read(false)), 'after')
      assert.equal(watchers.length, 2)
      assert.notEqual(watchers[1].isClosed, true)
    } finally {
      reader.close()
      for (const current of watchers) current.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
    }
  })

  test(`an old ${kind.name} watcher cannot close its replacement`, () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-board-old-watch-'))
    const directory = join(root, 'files')
    const watchers = []
    mkdirSync(directory)
    writeFileSync(join(directory, 'one.json'), 'before')
    const reader = kind.create({
      directory, isPersistent: true, accepts: name => name.endsWith('.json'),
      watchFiles: (_folder, listener) => {
        const current = new EventEmitter()
        current.close = () => { current.isClosed = true; current.emit('close') }
        current.unref = () => {}
        current.changed = name => listener('rename', name)
        watchers.push(current)
        return current
      },
    })
    try {
      assert.equal(kind.value(reader.read(false)), 'before')
      renameSync(directory, join(root, 'old'))
      mkdirSync(directory)
      writeFileSync(join(directory, 'one.json'), 'after')
      assert.equal(kind.value(reader.read(false)), 'after')
      assert.equal(watchers.length, 2)
      rmSync(directory, { recursive: true, force: true })
      watchers[0].changed('files')
      watchers[0].emit('error', new Error('late old watcher error'))
      assert.notEqual(watchers[1].isClosed, true)
    } finally {
      reader.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test(`the ${kind.name} reader reads a replaced folder again when its file number differs only past 2^53 (#1498)`, () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-board-file-number-'))
    const directory = join(root, 'files')
    mkdirSync(directory)
    writeFileSync(join(directory, 'one.json'), 'before')
    // Windows gives folders 64-bit file numbers. These two are one Number, so only the exact
    // number tells the new folder from the old one; both are made in the same clock tick.
    let number = 2n ** 60n
    const realStat = fs.statSync
    fs.statSync = (path, options) => {
      const found = realStat(path, options)
      if (path !== directory) return found
      const same = options?.bigint === true
        ? { ino: number, birthtimeMs: 1000n, birthtimeNs: 1000000000n }
        : { ino: Number(number), birthtimeMs: 1000 }
      return Object.assign(Object.create(Object.getPrototypeOf(found)), found, same)
    }
    syncBuiltinESMExports()
    const reader = kind.create({
      directory, isPersistent: true, accepts: name => name.endsWith('.json'),
      watchFiles: () => {
        const current = new EventEmitter()
        current.close = () => current.emit('close')
        current.unref = () => {}
        return current
      },
    })
    try {
      assert.equal(kind.value(reader.read(false)), 'before')
      renameSync(directory, join(root, 'old'))
      mkdirSync(directory)
      writeFileSync(join(directory, 'one.json'), 'after')
      number += 1n
      assert.equal(kind.value(reader.read(false)), 'after')
    } finally {
      reader.close()
      fs.statSync = realStat
      syncBuiltinESMExports()
      rmSync(root, { recursive: true, force: true })
    }
  })
}
