import childProcess from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// The message-folder module uses the host's extensionless imports; resolve only those local
// paths, as tests/messaging.test.mjs does.
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })

const sid = 'S-1-5-21-100-200-300-1001'
const freshRuntime = name => import(`../scripts/runtime-folder.ts?${name}`)

test('sync and async runtime checks run identical commands, remove extra grants and recheck every address read', async t => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-runners-'))
  const file = join(root, 'address.json')
  const histories = []
  try {
    for (const mode of ['sync', 'async']) {
      const runtime = await freshRuntime(`parity-${mode}`)
      writeFileSync(file, 'synthetic address')
      const history = []
      let hasRemoved = false
      const output = (program, args, options) => {
        const name = basename(program).toLowerCase()
        history.push({
          name, args: args.map((arg, at) => args[at - 1] === '/save' ? '<scratch>/dacl.txt' : arg),
          timeout: options.timeout, windowsHide: options.windowsHide, encoding: options.encoding, stdio: options.stdio,
          env: options.env === undefined ? undefined : { PSModulePath: options.env.PSModulePath, AGENT_BOARD_RUNTIME_ACL_PATH: options.env.AGENT_BOARD_RUNTIME_ACL_PATH },
        })
        if (name === 'whoami.exe') return `"SYNTHETIC\\user","${sid}"\n`
        if (name === 'powershell.exe') return options.env.AGENT_BOARD_RUNTIME_ACL_PATH.split('|').map(target => {
          const sddl = `O:${sid}G:SYD:${target === root ? 'P(A;OICI;' : 'AI(A;ID;'}FA;;;${sid})`
          return target === root && !hasRemoved ? `${sddl}(A;OICI;FR;;;WD)` : sddl
        }).join('\n')
        assert.equal(name, 'icacls.exe')
        if (args.includes('/remove')) { assert.ok(args.includes('*S-1-1-0')); hasRemoved = true }
        if (args.includes('/save')) {
          const saved = args[args.indexOf('/save') + 1]
          assert.ok(saved.startsWith(join(root, '.acl-')), 'the saved list stays in the checked runtime folder')
          writeFileSync(saved, `address.json\r\nD:AI(A;ID;FA;;;${sid})\r\n`, 'utf16le')
        }
        return ''
      }
      t.mock.method(childProcess, 'execFileSync', output)
      t.mock.method(childProcess, 'execFile', (program, args, options, callback) => {
        queueMicrotask(() => { try { callback(null, output(program, args, options)) } catch (error) { callback(error) } })
        return {}
      })
      syncBuiltinESMExports()
      const folder = mode === 'sync' ? runtime.privateRuntimeFolder : runtime.privateRuntimeFolderAsync
      const read = mode === 'sync' ? runtime.readPrivateRuntimeFile : runtime.readPrivateRuntimeFileAsync
      assert.equal(await folder(root, ['address.json']), root)
      for (let index = 0; index < 2; index++) assert.equal((await read(file)).text, 'synthetic address')
      writeFileSync(file, 'changed synthetic address')
      assert.equal((await read(file)).text, 'changed synthetic address')
      assert.equal(history.filter(one => one.args.includes('/save')).length, 2, 'an unchanged file still gets a fresh DACL check on each read')
      assert.equal(history.filter(one => one.name === 'powershell.exe').length, 3, 'a changed file needs its owner and full ACL again')
      for (const one of history) {
        assert.equal(one.timeout, one.name === 'powershell.exe' ? 30_000 : 10_000)
        assert.equal(one.windowsHide, true)
        assert.equal(one.encoding, 'utf8')
      }
      assert.deepEqual(readdirSync(root), ['address.json'], 'both runners remove every scratch folder')
      histories.push(history)
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
    assert.deepEqual(histories[0], histories[1])
    for (const history of histories) {
      const grant = history.findIndex(one => one.args.includes('/grant:r'))
      const owner = history.findIndex(one => one.args.includes('/setowner'))
      assert.ok(grant !== -1 && owner !== -1 && grant < owner, 'the grant comes before taking ownership')
    }
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

test('async runtime reads refuse failed or untrusted ACLs and files replaced while a command is running', async t => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-async-refusal-'))
  const file = join(root, 'address.json')
  try {
    for (const fault of ['command', 'owner', 'grant', 'replaced']) {
      const runtime = await freshRuntime(`refusal-${fault}`)
      writeFileSync(file, 'synthetic address')
      t.mock.method(childProcess, 'execFile', (program, args, options, callback) => {
        queueMicrotask(() => {
          if (/whoami\.exe$/i.test(program)) return callback(null, `"SYNTHETIC\\user","${sid}"\n`)
          if (fault === 'command') return callback(new Error('synthetic ACL refusal'))
          let descriptor = `O:${sid}G:SYD:AI(A;ID;FA;;;${sid})`
          if (fault === 'owner') descriptor = descriptor.replace(`O:${sid}`, 'O:SY')
          if (fault === 'grant') descriptor += '(A;ID;FR;;;WD)'
          if (fault === 'replaced') { rmSync(file); writeFileSync(file, 'replacement address') }
          callback(null, descriptor)
        })
        return {}
      })
      syncBuiltinESMExports()
      assert.equal(await runtime.readPrivateRuntimeFileAsync(file), null, fault)
      assert.equal(readFileSync(file, 'utf8'), fault === 'replaced' ? 'replacement address' : 'synthetic address')
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

// A folder made outside the user profile may grant the account only Modify: taking ownership
// first then fails with access denied, while granting first works because the owner may always
// change the list (#1042).
test('on Windows a folder that only grants Modify becomes private for both folder checks', { skip: process.platform !== 'win32' && 'Windows ACLs only', timeout: 60_000 }, async () => {
  const { privateFolder } = await import('../scripts/private-folder.ts')
  const runtime = await freshRuntime('modify-only')
  const dir = mkdtempSync(join(tmpdir(), 'runtime-modify-only-'))
  try {
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    const whoami = childProcess.execFileSync(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
    const sid = /"(S-\d+(?:-\d+)+)"\s*$/.exec(whoami)?.[1]
    assert.ok(sid)
    const options = { encoding: 'utf8', windowsHide: true, timeout: 10_000 }
    const icacls = join(system, 'icacls.exe')
    const modifyOnly = folder => {
      mkdirSync(folder)
      childProcess.execFileSync(icacls, [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)M`, '/L'], options)
    }
    const runtimeFolder = join(dir, 'runtime')
    modifyOnly(runtimeFolder)
    assert.equal(runtime.privateRuntimeFolder(runtimeFolder), runtimeFolder)
    const messageFolder = join(dir, 'messages')
    modifyOnly(messageFolder)
    privateFolder(messageFolder)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// PowerShell printed every address line but had not exited when its limit ran out: the
// answer is complete without the exit, so the folder check takes the lines it left behind (#799).
test('a PowerShell that printed every address line but has not exited still checks the folder, in both runners', async t => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-stalled-acls-'))
  try {
    for (const mode of ['sync', 'async']) {
      const runtime = await freshRuntime(`stalled-acls-${mode}`)
      const sddl = target => `O:${sid}G:SYD:${target === root ? 'P(A;OICI;' : 'AI(A;ID;'}FA;;;${sid})`
      const other = program => {
        const name = basename(program).toLowerCase()
        if (name === 'whoami.exe') return `"SYNTHETIC\\user","${sid}"\n`
        assert.equal(name, 'icacls.exe')
        return ''
      }
      // The sync runner's error carries the printed lines, as Node's does; the async
      // runner's error carries only the kill, and the lines arrive as the callback's
      // stdout, as Node's does.
      t.mock.method(childProcess, 'execFileSync', (program, args, options) => {
        if (basename(program).toLowerCase() === 'powershell.exe') {
          const lines = options.env.AGENT_BOARD_RUNTIME_ACL_PATH.split('|').map(sddl).join('\n')
          throw Object.assign(new Error('synthetic PowerShell stall'), { code: 'ETIMEDOUT', signal: 'SIGTERM', stdout: lines })
        }
        return other(program)
      })
      t.mock.method(childProcess, 'execFile', (program, args, options, callback) => {
        queueMicrotask(() => {
          if (basename(program).toLowerCase() === 'powershell.exe') {
            const lines = options.env.AGENT_BOARD_RUNTIME_ACL_PATH.split('|').map(sddl).join('\n')
            callback(Object.assign(new Error('synthetic PowerShell stall'), { code: null, signal: 'SIGTERM', killed: true }), lines)
            return
          }
          try { callback(null, other(program)) } catch (error) { callback(error) }
        })
        return {}
      })
      syncBuiltinESMExports()
      const folder = mode === 'sync' ? runtime.privateRuntimeFolder : runtime.privateRuntimeFolderAsync
      assert.equal(await folder(root, []), root)
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

// A shorter answer is still a failure, and the folder check says the check did not finish
// rather than that the file could not be protected (#799).
test('a PowerShell that printed only some address lines before its limit still fails the folder check as a timeout', async t => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-stalled-short-'))
  const address = join(root, 'address.json')
  writeFileSync(address, '{"url":"http://127.0.0.1:1"}')
  try {
    for (const mode of ['sync', 'async']) {
      const runtime = await freshRuntime(`stalled-short-${mode}`)
      const stalled = (program, args, options, callback) => {
        const name = basename(program).toLowerCase()
        if (name === 'whoami.exe') {
          if (callback === undefined) return `"SYNTHETIC\\user","${sid}"\n`
          callback(null, `"SYNTHETIC\\user","${sid}"\n`)
          return
        }
        if (name === 'icacls.exe') {
          if (callback === undefined) return ''
          callback(null, '')
          return
        }
        assert.equal(name, 'powershell.exe')
        // One line where two were asked for (the folder and its address file).
        const line = `O:${sid}G:SYD:P(A;OICI;FA;;;${sid})`
        if (callback === undefined) throw Object.assign(new Error('synthetic PowerShell stall'), { code: 'ETIMEDOUT', signal: 'SIGTERM', stdout: line })
        callback(Object.assign(new Error('synthetic PowerShell stall'), { code: null, signal: 'SIGTERM', killed: true }), line)
      }
      t.mock.method(childProcess, 'execFileSync', (program, args, options) => stalled(program, args, options))
      t.mock.method(childProcess, 'execFile', (program, args, options, callback) => {
        queueMicrotask(() => stalled(program, args, options, callback))
        return {}
      })
      syncBuiltinESMExports()
      const folder = mode === 'sync' ? runtime.privateRuntimeFolder : runtime.privateRuntimeFolderAsync
      // The sync check throws outright; only the async one rejects a promise.
      if (mode === 'sync') assert.throws(() => folder(root, ['address.json']), error => error instanceof runtime.RuntimeFolderTimeoutError)
      else await assert.rejects(() => folder(root, ['address.json']), error => error instanceof runtime.RuntimeFolderTimeoutError)
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

// The recovery is only for a command killed by its limit: a command that failed on its own
// is not recovered even when it left a complete answer behind (#799).
test('a PowerShell that failed without a timeout is not recovered even when its output is complete', async t => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-failed-acls-'))
  try {
    for (const mode of ['sync', 'async']) {
      const runtime = await freshRuntime(`failed-acls-${mode}`)
      const failed = (program, args, options, callback) => {
        const name = basename(program).toLowerCase()
        if (name === 'whoami.exe') {
          if (callback === undefined) return `"SYNTHETIC\\user","${sid}"\n`
          callback(null, `"SYNTHETIC\\user","${sid}"\n`)
          return
        }
        if (name === 'icacls.exe') {
          if (callback === undefined) return ''
          callback(null, '')
          return
        }
        assert.equal(name, 'powershell.exe')
        const line = `O:${sid}G:SYD:P(A;OICI;FA;;;${sid})`
        if (callback === undefined) throw Object.assign(new Error('synthetic ACL failure'), { stdout: line })
        callback(Object.assign(new Error('synthetic ACL failure'), { stdout: line }), line)
      }
      t.mock.method(childProcess, 'execFileSync', (program, args, options) => failed(program, args, options))
      t.mock.method(childProcess, 'execFile', (program, args, options, callback) => {
        queueMicrotask(() => failed(program, args, options, callback))
        return {}
      })
      syncBuiltinESMExports()
      const folder = mode === 'sync' ? runtime.privateRuntimeFolder : runtime.privateRuntimeFolderAsync
      // The sync check throws outright; only the async one rejects a promise.
      if (mode === 'sync') assert.throws(() => folder(root, []), error => error instanceof runtime.RuntimeFolderError && !(error instanceof runtime.RuntimeFolderTimeoutError))
      else await assert.rejects(() => folder(root, []), error => error instanceof runtime.RuntimeFolderError && !(error instanceof runtime.RuntimeFolderTimeoutError))
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})
