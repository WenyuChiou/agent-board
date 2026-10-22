import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { findCodexExecutable, inspectCodexHooks } from '../scripts/codex-host.ts'

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
`)
  try { await action({config, log, executable, contents}) }
  finally { rmSync(dir, {recursive:true, maxRetries:5, retryDelay:100}) }
}

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
  ['disabled hook', hooks => hooks.map((hook,index) => index === 0 ? {...hook,enabled:false} : hook), 'HOOK_DISABLED_OR_HASH_UNSUPPORTED'],
  ['unsupported hash', hooks => hooks.map((hook,index) => index === 0 ? {...hook,currentHash:'future-hash'} : hook), 'HOOK_DISABLED_OR_HASH_UNSUPPORTED'],
]) test(`trust observation refuses ${label} without granting trust`, async () => fixture({hooks}, async f => {
  await assert.rejects(inspectCodexHooks(f.executable, f.config, identities), new RegExp(error))
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
