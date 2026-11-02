import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { BOARD_SCRIPT } from '../../hooks/board-script.ts'
import { makeWorld } from './lib/world.mjs'
import { spawnIsolated } from './lib/spawn.mjs'

const wait = ms => new Promise(done => setTimeout(done, ms))

// The barriers only schedule real reads and renames. No filesystem result or
// receiving transport is replaced, and each reported owner must answer HTTP.
test('three real hub starts never leave two live owners of one message store', { timeout: 120_000 }, async () => {
  const world = makeWorld()
  let failure
  try {
    const logs = process.env.AGENT_BOARD_PREFLIGHT_EVIDENCE_DIR
      ? join(process.env.AGENT_BOARD_PREFLIGHT_EVIDENCE_DIR, 'hub-ownership-' + basename(world.root))
      : join(world.root, 'evidence')
    mkdirSync(logs, { recursive: true })
    const root = world.root
    const store = join(root, 'messages')
    const control = join(root, 'control')
    mkdirSync(store, { mode: 0o700 })
    mkdirSync(control)
    const lock = join(store, 'server.lock')
    let dead = 2147483000
    for (;;) {
      try { process.kill(dead, 0); dead-- } catch (error) {
        if (error.code === 'ESRCH') break
        throw error
      }
    }
    writeFileSync(lock, String(dead))
    const launches = []
    world.cleanups.push(async () => {
      writeFileSync(join(logs, 'cleanup.json'), JSON.stringify({
        exited: launches.map(one => ({ label: one.label, pid: one.child.pid, exitCode: one.child.exitCode, signal: one.child.signalCode })),
      }, null, 2))
    })
    const sentinel = name => join(control, name)
    const untilFile = async name => {
      const end = Date.now() + 20_000
      while (!existsSync(sentinel(name))) {
        if (Date.now() > end) throw new Error('Missing controlled barrier ' + name)
        await wait(20)
      }
    }
    const preload = join(control, 'barrier.cjs')
    writeFileSync(preload, [
      "const fs = require('node:fs'), path = require('node:path')",
      'const lock = ' + JSON.stringify(lock),
      'const control = ' + JSON.stringify(control),
      'const read = fs.readFileSync, rename = fs.renameSync',
      'let captured = false, moved = false',
      "const pause = name => { const end = Date.now()+65000; while(!fs.existsSync(path.join(control,name))) { if(Date.now()>end) throw new Error('BARRIER_TIMEOUT'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10) } }",
      "fs.readFileSync = function(file,...args) { const value=read.call(this,file,...args); if(!captured && typeof file==='string' && path.resolve(file)===lock) { captured=true; fs.writeFileSync(path.join(control,'captured'),String(value)); pause('continue-read') } return value }",
      "fs.renameSync = function(from,to,...args) { const result=rename.call(this,from,to,...args); if(!moved && typeof from==='string' && path.resolve(from)===lock) { moved=true; fs.writeFileSync(path.join(control,'moved'),String(to)); pause('continue-rename') } return result }",
      "require('node:module').syncBuiltinESMExports()",
    ].join('\n'))
    const launch = (label, hasBarrier = false) => {
      const home = join(root, label)
      mkdirSync(home)
      const progress = join(home, 'progress.md'), script = join(home, 'board.mjs')
      writeFileSync(progress, '# Synthetic three-owner regression\n')
      writeFileSync(script, 'globalThis.AGENT_BOARD = ' + JSON.stringify({ path: progress, lang: 'en' }) + '\n' + BOARD_SCRIPT)
      const env = { ...world.env, CLAUDE_PROGRESS_FILE: progress, E2E_BOARD_PATH: progress }
      const args = [...(hasBarrier ? ['-r', preload] : []), script, '--serve-child', '--messages-dir', store]
      const child = spawnIsolated(process.execPath, args, { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })))
      const outcome = new Promise(done => {
        let settled = false
        const finish = value => { if (!settled) { settled = true; clearTimeout(timer); done(value) } }
        const timer = setTimeout(() => finish({ timeout: true }), hasBarrier ? 90_000 : 20_000)
        child.stdout.on('data', chunk => {
          stdout += chunk
          appendFileSync(join(logs, label + '-stdout.log'), chunk)
          if (stdout.includes('\n')) {
            const line = stdout.split('\n')[0].trim()
            if (/^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/.test(line)) finish({ address: line })
          }
        })
        child.stderr.on('data', chunk => { stderr += chunk; appendFileSync(join(logs, label + '-stderr.log'), chunk) })
        child.once('error', error => finish({ error: error.message }))
        child.once('exit', (code, signal) => finish({ code, signal, stderr }))
      })
      const item = { label, child, outcome, exited }
      launches.push(item)
      world.cleanups.push(async () => {
        writeFileSync(sentinel('continue-read'), 'cleanup')
        writeFileSync(sentinel('continue-rename'), 'cleanup')
        const result = await outcome
        if (result.address) {
          const uri = new URL(result.address)
          try {
            await fetch(new URL('/api/close', uri), { method: 'POST', headers: { 'x-board-token': uri.searchParams.get('t'), 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) })
          } catch {}
        }
        if (child.exitCode === null && child.signalCode === null) {
          let timer
          try { await Promise.race([exited, new Promise(done => { timer = setTimeout(done, 5000) })]) }
          finally { clearTimeout(timer) }
          if (child.exitCode === null && child.signalCode === null) child.kill()
        }
        let timer
        const exit = await Promise.race([exited, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('Owned hub did not exit')), 5000) })]).finally(() => clearTimeout(timer))
        writeFileSync(join(logs, label + '-exit.json'), JSON.stringify(exit))
        assert.equal(exit.signal, null, 'Owned hub did not exit normally')
      })
      writeFileSync(join(logs, label + '-command.json'), JSON.stringify({ executable: process.execPath, args, pid: child.pid, cwd: home }, null, 2))
      return item
    }
    let outcomes
    try {
      const b = launch('B', true)
      await untilFile('captured')
      assert.equal(readFileSync(sentinel('captured'), 'utf8'), String(dead))
      const a = launch('A')
      const ar = await a.outcome
      assert.ok(ar.address || /MESSAGE_STORE_IN_USE|MESSAGE_STORE_CLAIM/.test(ar.stderr || ''), JSON.stringify(ar))
      writeFileSync(sentinel('continue-read'), 'go')
      await untilFile('moved')
      const c = launch('C')
      const cr = await c.outcome
      assert.ok(cr.address || /MESSAGE_STORE_IN_USE|MESSAGE_STORE_CLAIM/.test(cr.stderr || ''), JSON.stringify(cr))
      writeFileSync(sentinel('continue-rename'), 'go')
      const br = await b.outcome
      assert.ok(br.address || /MESSAGE_STORE_IN_USE|MESSAGE_STORE_CLAIM/.test(br.stderr || ''), JSON.stringify(br))
      outcomes = [ar, br, cr]
      const owners = []
      for (let index = 0; index < outcomes.length; index++) {
        if (!outcomes[index].address) continue
        const uri = new URL(outcomes[index].address)
        const response = await fetch(new URL('/api/ping', uri), { headers: { 'x-board-token': uri.searchParams.get('t') }, signal: AbortSignal.timeout(5000) })
        const ping = await response.json()
        assert.equal(response.status, 200)
        assert.equal(ping.messagesDirectory, store)
        owners.push({ label: ['A', 'B', 'C'][index], pid: launches.find(one => one.label === ['A', 'B', 'C'][index]).child.pid })
      }
      const proof = { fixture: root, store, dead, lock: readFileSync(lock, 'utf8'), liveOwners: owners, sourceSha256: createHash('sha256').update(readFileSync(new URL('../../scripts/board-messaging.ts', import.meta.url))).digest('hex'), providerModelsInvoked: 0, controlledFilesystemInterleaving: true }
      writeFileSync(join(logs, 'proof.json'), JSON.stringify(proof, null, 2))
      console.log(JSON.stringify({ liveOwners: owners.map(one => one.label), sharedStore: true, sourceSha256: proof.sourceSha256, providerModelsInvoked: 0 }))
      assert.equal(owners.length, 1, 'Exclusive store ownership failed: two actual server processes answer for one directory')
    } finally {
      writeFileSync(sentinel('continue-read'), 'cleanup')
      writeFileSync(sentinel('continue-rename'), 'cleanup')
    }
  } catch (error) { failure = error }
  finally {
    try { await world.close() } catch (cleanup) {
      throw new AggregateError(failure ? [failure, cleanup] : [cleanup], 'Message ownership cleanup failed')
    }
  }
  if (failure) throw failure
})
