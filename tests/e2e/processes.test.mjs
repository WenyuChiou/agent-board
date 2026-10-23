import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { killChecked, processList, stopTree } from './lib/processes.mjs'
import { spawnIsolated } from './lib/spawn.mjs'
import { makeWorld } from './lib/world.mjs'

const within = async (promise, ms, message) => {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })])
  } finally { clearTimeout(timer) }
}

const gone = async pid => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await new Promise(done => setTimeout(done, 25))
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
}

test("L6 soak processes: stopping a tree kills its root, the root's child and a process naming the world folder, spares another world and a root that already exited, and finds none remaining", { timeout: 240000, skip: process.platform === 'darwin' ? 'macOS process lists have no start times, so a path-only match is kept, not killed' : false }, async () => {
  const worlds = [], children = []
  let grandchild, isGrandchildGone = false
  const start = async (world, args, stdio = 'ignore') => {
    const env = Object.fromEntries(Object.entries(world.env).filter(([name]) => name !== 'NODE_OPTIONS' && !name.startsWith('E2E_')))
    const child = spawnIsolated(process.execPath, args, { env, cwd: world.root, stdio })
    // Keep the close event even when stopTree finishes listing after the process exits.
    const closed = new Promise(done => child.once('close', done))
    children.push({ child, closed })
    await within(new Promise((done, reject) => {
      child.once('spawn', done)
      child.once('error', reject)
    }), 10000, 'The isolated process did not start')
    return { child, closed }
  }
  try {
    const a = makeWorld()
    worlds.push(a)
    const b = makeWorld()
    worlds.push(b)
    const root = await start(a, [fileURLToPath(new URL('../fixtures/process-tree.mjs', import.meta.url))], ['ignore', 'pipe', 'pipe'])
    root.child.stderr.resume()
    const lines = createInterface({ input: root.child.stdout, crlfDelay: Infinity })
    try {
      const line = await within(lines[Symbol.asyncIterator]().next(), 10000, 'The root did not print its child pid')
      assert.equal(line.done, false)
      assert.match(line.value, /^[1-9]\d*$/)
      grandchild = Number(line.value)
    } finally {
      lines.close()
      root.child.stdout.resume()
    }
    const args = ['-e', 'setInterval(() => {}, 1000)']
    const orphan = await start(a, [...args, a.root])
    const other = await start(b, [...args, b.root])
    const roots = [a.root, realpathSync.native(a.root)]
    const first = await stopTree({ spawnIsolated, makeWorld, rootPid: root.child.pid, isRootAlive: () => false, roots, timeoutMs: 90000 })
    assert.equal(first.stopped, 1, JSON.stringify(first))
    assert.equal(first.remaining, 0, JSON.stringify(first))
    await within(orphan.closed, 5000, 'The orphan did not close')
    assert.equal(root.child.exitCode, null)
    assert.equal(root.child.signalCode, null)
    assert.doesNotThrow(() => process.kill(root.child.pid, 0))
    assert.doesNotThrow(() => process.kill(grandchild, 0))
    const second = await stopTree({ spawnIsolated, makeWorld, rootPid: root.child.pid, isRootAlive: () => root.child.exitCode === null && root.child.signalCode === null, roots, timeoutMs: 90000 })
    assert.equal(second.stopped - (second.names['conhost.exe'] ?? 0), 2, JSON.stringify(second))
    assert.equal(second.remaining, 0, JSON.stringify(second))
    await within(root.closed, 5000, 'The root did not close')
    await gone(grandchild)
    isGrandchildGone = true
    assert.doesNotThrow(() => process.kill(other.child.pid, 0))
  } finally {
    const errors = []
    if (grandchild !== undefined && !isGrandchildGone) {
      try { process.kill(grandchild, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') errors.push(error) }
    }
    for (const { child } of children) {
      try { child.kill('SIGKILL') } catch (error) { errors.push(error) }
    }
    for (const { closed } of children) {
      try { await within(closed, 5000, 'A test process did not close during cleanup') } catch (error) { errors.push(error) }
    }
    if (grandchild !== undefined && !isGrandchildGone) {
      try { await gone(grandchild) } catch (error) { errors.push(error) }
    }
    // Windows keeps a world's working folder open until its processes have closed.
    for (const world of worlds.reverse()) {
      try { await world.close() } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Process test cleanup failed')
  }
})

test('L6 soak processes: a process whose start time no longer matches its listed one is not killed', { timeout: 120000, skip: process.platform === 'darwin' ? 'macOS process lists have no start times to check' : false }, async () => {
  const worlds = []
  let child, closed
  try {
    const world = makeWorld()
    worlds.push(world)
    const listerWorld = makeWorld()
    worlds.push(listerWorld)
    const env = Object.fromEntries(Object.entries(world.env).filter(([name]) => name !== 'NODE_OPTIONS' && !name.startsWith('E2E_')))
    child = spawnIsolated(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env, cwd: world.root, stdio: 'ignore' })
    closed = new Promise(done => child.once('close', done))
    await within(new Promise((done, reject) => {
      child.once('spawn', done)
      child.once('error', reject)
    }), 10000, 'The isolated process did not start')
    assert.deepEqual(await killChecked({ spawnIsolated, world: listerWorld, targets: [{ pid: child.pid, started: 1, name: 'node' }], timeoutMs: 30000 }), [])
    assert.doesNotThrow(() => process.kill(child.pid, 0))
    assert.equal(child.exitCode, null)
    const { list } = await processList({ spawnIsolated, world: listerWorld, timeoutMs: 30000 })
    const target = list.find(one => one.pid === child.pid)
    assert.notEqual(target, undefined)
    assert.deepEqual(await killChecked({ spawnIsolated, world: listerWorld, targets: [target], timeoutMs: 30000 }), [target])
    await within(closed, 5000, 'The identity-checked process did not close')
  } finally {
    const errors = []
    try { child?.kill('SIGKILL') } catch (error) { errors.push(error) }
    if (closed !== undefined) {
      try { await within(closed, 5000, 'The test process did not close during cleanup') } catch (error) { errors.push(error) }
    }
    for (const world of worlds.reverse()) {
      try { await world.close() } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Process test cleanup failed')
  }
})
