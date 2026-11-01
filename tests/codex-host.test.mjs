import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough, Writable } from 'node:stream'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { discoverCodexBinary, findCodexExecutable, inspectCodexConfigToml, inspectCodexHooks } from '../scripts/codex-host.ts'

const identities = ['stop', 'sessionEnd', 'userPromptSubmit'].map(event => ({event, command:`report-${event}`}))
const npmShim = target => `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\${target}" %*
`
const npmFixture = action => {
  const prefix = mkdtempSync(join(tmpdir(), 'codex-npm-shim-'))
  const root = join(prefix, 'node_modules', '@openai', 'codex')
  const target = 'node_modules\\@openai\\codex\\bin\\codex.js'
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
  writeFileSync(join(root, 'bin', 'codex.js'), '// Synthetic launcher, never executed\n')
  writeFileSync(join(prefix, 'codex.cmd'), npmShim(target))
  const vendor = (arch, bundled = false) => {
    const triple = arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc'
    const base = bundled ? root : join(root, 'node_modules', '@openai', `codex-win32-${arch}`)
    const file = join(base, 'vendor', triple, 'bin', 'codex.exe')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '')
    return realpathSync(file)
  }
  try { action({ prefix, root, target, vendor }) }
  finally { rmSync(prefix, { recursive: true, force: true }) }
}

test('the Codex binary is found behind an npm shim as the vendor codex.exe inside its package', () => {
  for (const arch of ['x64', 'arm64']) for (const bundled of [false, true]) npmFixture(f => {
    const file = f.vendor(arch, bundled)
    assert.equal(findCodexExecutable(f.prefix, 'win32', arch), file)
    // A relative PATH entry depends on the current folder, so it is skipped even when it holds a codex.exe.
    mkdirSync(join(f.prefix, 'relative'))
    writeFileSync(join(f.prefix, 'relative', 'codex.exe'), '')
    const cwd = process.cwd()
    process.chdir(f.prefix)
    try { assert.equal(findCodexExecutable('relative;' + f.prefix, 'win32', arch), file) }
    finally { process.chdir(cwd) }
    const earlier = join(f.prefix, 'earlier')
    mkdirSync(earlier)
    const direct = join(earlier, 'codex.exe')
    writeFileSync(direct, '')
    assert.equal(findCodexExecutable(earlier + ';' + f.prefix, 'win32', arch), realpathSync(direct))
    const local = join(f.prefix, 'codex.exe')
    writeFileSync(local, '')
    assert.equal(findCodexExecutable(f.prefix, 'win32', arch), realpathSync(local))
  })
})

test('an npm shim that points outside its package, or a vendor binary that resolves outside it, is refused', () => {
  const cases = [
    f => writeFileSync(join(f.prefix, 'codex.cmd'), npmShim('..\\elsewhere\\codex.js')),
    f => writeFileSync(join(f.prefix, 'codex.cmd'), npmShim('C:\\elsewhere\\codex.js')),
    f => writeFileSync(join(f.prefix, 'codex.cmd'), npmShim(f.target + '.evil')),
    f => writeFileSync(join(f.prefix, 'codex.cmd'), npmShim('..\\' + f.target)),
    f => writeFileSync(join(f.prefix, 'codex.cmd'), npmShim(f.target) + `"%_prog%" "%dp0%\\${f.target}"\n`),
    f => writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: '@elsewhere/codex' })),
    f => {
      const outside = join(f.prefix, 'outside')
      mkdirSync(join(outside, 'vendor', 'x86_64-pc-windows-msvc', 'bin'), { recursive: true })
      writeFileSync(join(outside, 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'), '')
      const platform = join(f.root, 'node_modules', '@openai', 'codex-win32-x64')
      rmSync(platform, { recursive: true })
      symlinkSync(outside, platform, process.platform === 'win32' ? 'junction' : 'dir')
    },
    f => {
      const outside = join(f.prefix, 'outside-bin')
      mkdirSync(outside)
      writeFileSync(join(outside, 'codex.js'), '')
      rmSync(join(f.root, 'bin'), { recursive: true })
      symlinkSync(outside, join(f.root, 'bin'), process.platform === 'win32' ? 'junction' : 'dir')
    },
    f => writeFileSync(join(f.prefix, 'codex.cmd'), npmShim(f.target) + ' '.repeat(64 * 1024)),
  ]
  for (const change of cases) npmFixture(f => {
    f.vendor('x64')
    change(f)
    assert.equal(findCodexExecutable(f.prefix, 'win32', 'x64'), undefined)
  })
  npmFixture(f => {
    f.vendor('x64')
    assert.equal(findCodexExecutable(f.prefix, 'win32', 'ia32'), undefined)
  })
})

test('native Codex discovery preserves executable permission checks outside Windows', { skip: process.platform === 'win32' && 'Windows files have no executable bit to clear; the Ubuntu CI jobs run this' }, () => {
  npmFixture(f => {
    const file = join(f.prefix, 'codex')
    writeFileSync(file, '')
    chmodSync(file, 0o600)
    assert.equal(findCodexExecutable(f.prefix, 'linux', 'x64'), undefined)
    chmodSync(file, 0o700)
    assert.equal(findCodexExecutable('relative:' + f.prefix, 'linux', 'x64'), realpathSync(file))
  })
})

test('discoverCodexBinary finds executable from PATH or Windows LOCALAPPDATA', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-bin-disc-'))
  try {
    const binDir = join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const binFile = join(binDir, process.platform === 'win32' ? 'codex.exe' : 'codex')
    writeFileSync(binFile, '')
    if (process.platform !== 'win32') chmodSync(binFile, 0o755)

    // 1. From PATH
    assert.equal(discoverCodexBinary({ PATH: binDir }), realpathSync(binFile))

    // 2. On Windows from LOCALAPPDATA, picking the newest version directory by mtime
    if (process.platform === 'win32') {
      const local = join(dir, 'localappdata')
      const vOld = join(local, 'OpenAI', 'Codex', 'bin', 'v1')
      const vNew = join(local, 'OpenAI', 'Codex', 'bin', 'v2')
      mkdirSync(vOld, { recursive: true })
      mkdirSync(vNew, { recursive: true })
      const exeOld = join(vOld, 'codex.exe')
      const exeNew = join(vNew, 'codex.exe')
      writeFileSync(exeOld, '')
      writeFileSync(exeNew, '')
      utimesSync(exeOld, new Date(1000), new Date(1000))
      utimesSync(exeNew, new Date(5000), new Date(5000))
      assert.equal(discoverCodexBinary({ LOCALAPPDATA: local }), realpathSync(exeNew))
    }

    // 3. Undefined when not found
    assert.equal(discoverCodexBinary({ PATH: join(dir, 'nonexistent') }), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inspectCodexConfigToml detects missing config.toml or missing trusted_hash without falsely confirming trust', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-toml-disc-'))
  try {
    const configToml = join(dir, 'config.toml')

    // Missing config.toml returns false
    assert.equal(inspectCodexConfigToml(configToml), false)

    // Empty config.toml returns false
    writeFileSync(configToml, '# Keep this comment\n[features]\nhooks = true\n')
    assert.equal(inspectCodexConfigToml(configToml), false)

    // config.toml with trusted_hash cannot be confirmed without Codex; returns 'unknown'
    writeFileSync(configToml, '[hooks.state."session_start"]\ntrusted_hash = "sha256:1"\n')
    assert.equal(inspectCodexConfigToml(configToml), 'unknown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
const stubChild = receive => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  let buffer = '', isClosed = false
  child.stdin = new Writable({ write(chunk, encoding, done) {
    try {
      buffer += String(chunk)
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        const reply = receive(request)
        if (reply !== undefined) child.stdout.write(JSON.stringify({ id: request.id, ...reply }) + '\n')
      }
      done()
    } catch (error) { done(error) }
  } })
  child.kill = () => {
    if (isClosed) return true
    isClosed = true
    child.stdin.destroy()
    child.stdout.end()
    child.stderr.end()
    child.emit('exit', null, 'SIGTERM')
    return true
  }
  return child
}

const fixture = async (options, action) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-trust-observation-'))
  const config = join(dir, 'hooks.json'), log = join(dir, 'methods.jsonl'), executable = join(dir, 'host.mjs')
  const contents = '{"hooks":{"synthetic":true}}\n'
  writeFileSync(config, contents)
  let hooks = identities.map((one, index) => ({key:`hook-${index}`, currentHash:'sha256:' + String(index + 1).repeat(64), sourcePath:config, eventName:one.event, command:one.command, enabled:true, trustStatus:'trusted'}))
  if (options.hooks) hooks = options.hooks(hooks, dir)
  const response = options.response ?? {data:[{hooks, errors:[]}]}
  writeFileSync(executable, `
import { createInterface } from 'node:readline'
import { appendFileSync, writeFileSync } from 'node:fs'
createInterface({input:process.stdin}).on('line', text => {
  const request = JSON.parse(text)
  appendFileSync(${JSON.stringify(log)}, request.method + '\\n')
  if (request.id === undefined) return
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n')
  else if (request.method === 'hooks/list') {
    ${options.changed ? `writeFileSync(${JSON.stringify(config)}, 'external changed definition')` : ''}
    process.stdout.write(JSON.stringify({id:request.id, ${options.rejected ? 'error:{message:"unsupported"}' : `result:${JSON.stringify(response)}`}})+'\\n')
  } else process.stdout.write(JSON.stringify({id:request.id,error:{message:'FORBIDDEN_METHOD'}})+'\\n')
})
if (process.send) process.send('ready')
`)
  const spawn = childProcess.spawn
  const children = []
  let prestarted, attempts = 0
  const track = child => {
    const closed = new Promise(done => child.once('exit', done).once('error', done))
    children.push({ child, closed })
    return child
  }
  try {
    if (options.prestart) {
      prestarted = track(spawn(process.execPath, [executable, 'app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }))
      // A cold synthetic Node start gets its own 30 s ready handshake, outside the unchanged 5 s RPC cap.
      await new Promise((done, reject) => {
        const timer = setTimeout(() => finish(new Error('FIXTURE_READY_TIMEOUT')), 30000)
        const finish = error => {
          clearTimeout(timer)
          prestarted.off('message', ready)
          prestarted.off('error', failed)
          prestarted.off('exit', exited)
          error ? reject(error) : done()
        }
        const ready = message => { if (message === 'ready') finish() }
        const failed = error => finish(error)
        const exited = () => finish(new Error('FIXTURE_EXITED_BEFORE_READY'))
        prestarted.on('message', ready).once('error', failed).once('exit', exited)
      })
      prestarted.disconnect()
    }
    // Only this fixture's exact app-server argv is intercepted; restore the builtin even when an assertion fails.
    childProcess.spawn = (file, args, ...rest) => {
      if (file !== process.execPath || args?.length !== 3 || ![executable, join(dir, 'tree-host.mjs')].includes(args[0]) || args[1] !== 'app-server' || args[2] !== '--stdio') return spawn(file, args, ...rest)
      attempts++
      if (options.prestart) {
        assert.equal(attempts, 1)
        return prestarted
      }
      if (options.real) return track(spawn(file, args, ...rest))
      const child = stubChild(request => {
        appendFileSync(log, request.method + '\n')
        if (request.id === undefined) return
        if (request.method === 'initialize') return { result: {} }
        if (request.method !== 'hooks/list') return { error: { message: 'FORBIDDEN_METHOD' } }
        if (options.changed) writeFileSync(config, 'external changed definition')
        return options.rejected ? { error: { message: 'unsupported' } } : { result: response }
      })
      children.push({ child, closed: Promise.resolve() })
      return child
    }
    syncBuiltinESMExports()
    await action({config, log, executable, contents, attempts: () => attempts, realChildren: () => children.filter(one => one.child.pid !== undefined).length})
  } finally {
    childProcess.spawn = spawn
    syncBuiltinESMExports()
    try {
      for (const { child, closed } of children) {
        if (child.exitCode == null && child.signalCode == null) child.kill()
        // Reap every owned real child before removing its files; a broken cleanup fails within 5 s.
        let timer
        try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('FIXTURE_CLEANUP_TIMEOUT')), 5000) })]) }
        finally { clearTimeout(timer) }
      }
    } finally { rmSync(dir, {recursive:true, maxRetries:5, retryDelay:100}) }
  }
}

test('codex host: control requests answer through the fixture stub, so a slow Node start cannot reach the deadline', async () => fixture({}, async f => {
  assert.equal((await inspectCodexHooks(f.executable, f.config, identities)).trusted, true)
  assert.equal(f.attempts(), 1)
  assert.equal(f.realChildren(), 0)
  assert.deepEqual(readFileSync(f.log, 'utf8').trim().split('\n'), ['initialize', 'initialized', 'hooks/list'])
}))

test('codex host: one real app-server subprocess smoke test still passes', { timeout: 45000 }, async () => fixture({prestart:true}, async f => {
  assert.equal((await inspectCodexHooks(f.executable, f.config, identities)).trusted, true)
  assert.equal(f.attempts(), 1)
  assert.equal(f.realChildren(), 1)
  assert.deepEqual(readFileSync(f.log, 'utf8').trim().split('\n'), ['initialize', 'initialized', 'hooks/list'])
  assert.equal(readFileSync(f.config, 'utf8'), f.contents)
}))

test('legacy hook trust observation accepts only the three exact current definitions and makes no changes', async () => fixture({}, async f => {
  const result = await inspectCodexHooks(f.executable, f.config, identities)
  assert.equal(result.trusted, true)
  assert.equal(result.source, resolve(f.config))
  assert.equal(result.sourceHash, createHash('sha256').update(f.contents).digest('hex'))
  assert.equal(result.hooks.length, 3)
  assert.equal(readFileSync(f.config, 'utf8'), f.contents)
  assert.deepEqual(readFileSync(f.log, 'utf8').trim().split('\n'), ['initialize','initialized','hooks/list'])
  assert.doesNotMatch(JSON.stringify(result), /report-stop|synthetic/)
}))

test('one untrusted current definition keeps the observation untrusted', async () => fixture({hooks:hooks => hooks.map((hook,index) => index === 1 ? {...hook,trustStatus:'untrusted'} : hook)}, async f => {
  assert.equal((await inspectCodexHooks(f.executable, f.config, identities)).trusted, false)
  assert.equal(readFileSync(f.config, 'utf8'), f.contents)
}))

for (const [label, hooks, error] of [
  ['missing hook', hooks => hooks.slice(1), 'OWNED_HOOKS_NOT_FOUND'],
  ['foreign source', (hooks,dir) => hooks.map(hook => ({...hook,sourcePath:join(dir,'other-hooks.json')})), 'OWNED_HOOKS_NOT_FOUND'],
  ['changed command', hooks => hooks.map((hook,index) => index === 1 ? {...hook,command:'personal-command'} : hook), 'OWNED_HOOKS_NOT_FOUND'],
  ['duplicate definition', hooks => [...hooks, hooks[0]], 'OWNED_HOOKS_NOT_FOUND'],
  ['duplicate key', hooks => hooks.map(hook => ({...hook,key:'shared'})), 'OWNED_HOOKS_NOT_FOUND'],
  ['disabled hook', hooks => hooks.map((hook,index) => index === 0 ? {...hook,enabled:false} : hook), 'HOOK_DISABLED'],
  ['unsupported hash', hooks => hooks.map((hook,index) => index === 0 ? {...hook,currentHash:'future-hash'} : hook), 'HOOK_FORMAT_UNSUPPORTED'],
  ['missing key', hooks => hooks.map(({key, ...hook}) => hook), 'HOOK_FORMAT_UNSUPPORTED'],
  ['enabled flag that is not a boolean', hooks => hooks.map((hook,index) => index === 0 ? {...hook,enabled:'yes'} : hook), 'HOOK_FORMAT_UNSUPPORTED'],
  ['disabled hook without a key', hooks => hooks.map(({key, ...hook},index) => index === 0 ? {...hook,enabled:false} : {key, ...hook}), 'HOOK_DISABLED'],
]) test(`trust observation refuses ${label} without granting trust`, async () => fixture({hooks}, async f => {
  await assert.rejects(inspectCodexHooks(f.executable, f.config, identities), new RegExp(error))
  assert.equal(readFileSync(f.config, 'utf8'), f.contents)
}))

for (const [label, change] of [
  ['a hash format this code does not know', hook => ({...hook,currentHash:'future-hash'})],
  ['no enabled flag', ({enabled, ...hook}) => hook],
  ['no key', ({key, ...hook}) => hook],
]) test(`an untrusted answer with ${label} is still a no`, async () => fixture({hooks:hooks => hooks.map((hook,index) => index === 0 ? change({...hook,trustStatus:'untrusted'}) : hook)}, async f => {
  assert.equal((await inspectCodexHooks(f.executable, f.config, identities)).trusted, false)
  assert.equal(readFileSync(f.config, 'utf8'), f.contents)
}))

for (const response of [{}, {data:[]}, {data:[{hooks:[],errors:['unreadable']}]}, {data:[null]}, {data:[{hooks:'invalid',errors:[]}]}]) {
  test('incomplete host discovery cannot establish approved hooks: ' + JSON.stringify(response), async () => fixture({response}, async f => {
    await assert.rejects(inspectCodexHooks(f.executable, f.config, identities), /HOOK_DISCOVERY_FAILED/)
  }))
}

test('a source change during discovery invalidates even a trusted host reply', async () => fixture({changed:true}, async f => {
  await assert.rejects(inspectCodexHooks(f.executable, f.config, identities), /HOOK_DEFINITION_CHANGED/)
  assert.equal(readFileSync(f.config,'utf8'), 'external changed definition')
}))

test('an unsupported host API fails closed without a trust write', async () => fixture({rejected:true}, async f => {
  await assert.rejects(inspectCodexHooks(f.executable, f.config, identities), /CODEX_CONTROL_REJECTED/)
  assert.equal(readFileSync(f.config,'utf8'), f.contents)
  assert.doesNotMatch(readFileSync(f.log,'utf8'), /config|thread|turn|resume/)
}))

test('an empty or duplicate identity request cannot use vacuous trust', async () => fixture({}, async f => {
  await assert.rejects(inspectCodexHooks(f.executable, f.config, []), /OWNED_HOOK_IDENTITIES_REQUIRED/)
  await assert.rejects(inspectCodexHooks(f.executable, f.config, [identities[0],identities[0]]), /OWNED_HOOK_IDENTITIES_REQUIRED/)
}))

test('a Codex control request whose shared deadline has expired times out immediately', async () => fixture({}, async f => {
  await assert.rejects(inspectCodexHooks(f.executable, f.config, identities, 2000, performance.now() - 1), /CODEX_CONTROL_TIMEOUT/)
  assert.equal(readFileSync(f.config, 'utf8'), f.contents)
}))

// This separate real-process exception verifies Windows descendant cleanup, not cold app-server startup.
test('closing the Codex check ends the processes its app-server started, on Windows', { skip: process.platform !== 'win32' && 'the process-tree kill is Windows-only; elsewhere only the app-server itself is ended' }, async () => fixture({real:true}, async f => {
  const pidFile = join(f.config, '..', 'helper.pid'), host = join(f.config, '..', 'tree-host.mjs')
  // A synthetic app-server that starts a helper of its own before it answers.
  writeFileSync(host, `import { spawn as startHelper } from 'node:child_process'
import { writeFileSync as writePid } from 'node:fs'
writePid(${JSON.stringify(pidFile)}, String(startHelper(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true }).pid))
` + readFileSync(f.executable, 'utf8'))
  let pid
  const isAlive = () => { try { process.kill(pid, 0); return true } catch { return false } }
  try {
    assert.equal((await inspectCodexHooks(host, f.config, identities)).trusted, true)
    pid = Number(readFileSync(pidFile, 'utf8'))
    for (const until = Date.now() + 5000; isAlive() && Date.now() < until;) await new Promise(done => setTimeout(done, 50))
    assert.equal(isAlive(), false)
  } finally {
    // Discovery can fail after the helper starts but before its pid was read above.
    if (pid === undefined) {
      try { pid = Number(readFileSync(pidFile, 'utf8')) } catch {}
    }
    if (Number.isSafeInteger(pid) && pid > 0) {
      if (isAlive()) process.kill(pid)
      for (const until = Date.now() + 5000; isAlive() && Date.now() < until;) await new Promise(done => setTimeout(done, 50))
      assert.equal(isAlive(), false, 'the synthetic helper must exit before the fixture is removed')
    }
  }
}))
