import childProcess from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

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
