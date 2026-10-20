import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import { makeWorld } from './lib/world.mjs'
import { ISOLATED_VARIABLES, spawnIsolated, within, worldOf } from './lib/spawn.mjs'
import { block, turn, hook, hookHosts } from './lib/writers.mjs'
import { terminal, chat, seenPageWithin, serve, html, run } from './lib/surfaces.mjs'
import { seenWithin, noSilentPress, noMachineIds } from './lib/expect.mjs'
import { knownFailure } from './lib/known.mjs'
import { killMidWrite, tear, lockFile, twoWriters, readOnly, diskFull, skew, updateMidSession, uninstall, reinstall } from './lib/faults.mjs'
import { PANE_MS, PAGE_MS } from './lib/budget.mjs'

describe('scenario runner', () => {
  test('L0 safety: every journey world points every home and config variable into its own temp folder', async () => {
    const world = makeWorld()
    try {
      // The world is a fresh folder of its own in the temp folder, and spawnIsolated recognises it.
      const found = worldOf(world.root)
      assert.ok(found && within(found, world.root) && within(world.root, found), world.root)
      // userInfo() names the account's real home even when this run's HOME is a stand-in.
      const homes = [homedir(), userInfo().homedir]
      for (const name of ISOLATED_VARIABLES) {
        const value = world.env[name]
        assert.ok(value && isAbsolute(value), name)
        assert.ok(within(world.root, value), `${name}: outside the world`)
        assert.ok(!homes.some(home => within(value, home)), `${name}: a home or a folder holding it`)
        assert.notEqual(value, process.env[name], `${name}: this process's own value`)
      }
    } finally { await world.close() }
  })

  test('L0 safety: a world that leaves any one home variable at the real home refuses to start', async () => {
    const world = makeWorld()
    try {
      const marker = world.write('refused-child-marker-path', '') + '.started'
      const args = ['--input-type=module', '-e', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe child started')`]
      const refuse = async options => {
        let child
        try {
          assert.throws(() => { child = spawnIsolated(process.execPath, args, options) }, /journey|world|machine/)
        } finally {
          // A regression must not leave the marker child running after the assertion fails.
          if (child) {
            child.on('error', () => {})
            const closed = new Promise(done => child.once('close', done))
            child.kill()
            await closed
          }
        }
        assert.equal(existsSync(marker), false)
      }
      for (const name of ISOLATED_VARIABLES) await refuse({ env: { ...world.env, [name]: process.env[name] || homedir() }, cwd: world.root })
      await refuse({ env: process.env, cwd: world.root })
      await refuse({ cwd: world.root })
      // A caller cannot vouch for a folder that is not a world: the temp folder, a home or this checkout.
      for (const cwd of [dirname(world.root), homedir(), userInfo().homedir, process.cwd(), undefined]) await refuse({ env: world.env, cwd })
      for (const name of ISOLATED_VARIABLES) {
        await refuse({ env: { ...world.env, [name]: 'relative-home' }, cwd: world.root })
        await refuse({ env: { ...world.env, [name]: join(world.root, '..', 'outside-home') }, cwd: world.root })
      }
    } finally { await world.close() }
  })

  test('L0 safety: no journey helper spawns a process outside the isolated spawn helper', async () => {
    const root = fileURLToPath(new URL('./', import.meta.url))
    const files = readdirSync(root, { recursive: true }).map(String).filter(name => /\.(?:[cm]?js|[cm]?ts|tsx)$/.test(name))
    assert.ok(files.includes(join('lib', 'spawn.mjs')))
    for (const name of files) {
      if (name === join('lib', 'spawn.mjs')) continue
      let source = readFileSync(join(root, name), 'utf8')
      if (name === join('lib', 'world.mjs')) {
        // Only the clipboard preload template patches the child's own process module.
        const start = source.indexOf("const clipboard = world.write('clipboard-preload.mjs', `")
        const end = source.indexOf('\n`)', start)
        assert.ok(start >= 0 && end > start)
        const preload = source.slice(start, end + 3)
        assert.ok(preload.includes("import cp from 'node:" + 'child' + "_process'"))
        assert.match(preload, /cp\.spawnSync =/)
        source = source.slice(0, start) + source.slice(end + 3)
      }
      // Any mention of the module, any other way to load a built-in, and any computed dynamic import
      // could reach it without the literal name.
      // Split so this file's own pattern text does not match itself.
      const processModule = new RegExp(['child' + '_process', 'getBuiltin' + 'Module', 'create' + 'Require', 'process\\.binding', 'process\\.dlopen'].join('|'))
      const computedImport = /\bimport\s*\(\s*(?!(['"])[^'"`+]*\1\s*\))/
      const processCall = new RegExp('\\b(?:spawn|spawnSync|exec|execFile|execSync|execFileSync|fork)\\s*\\(')
      assert.doesNotMatch(source, processModule, name)
      assert.doesNotMatch(source, computedImport, name)
      // RegExp literal .exec calls are matches, never child-process execution.
      const calls = source.replace(/\/(?:\\.|[^/\r\n])+\/[dgimsuvy]*\.exec\s*\(/g, 'regexMatch(')
      assert.doesNotMatch(calls, processCall, name)
    }
  })

  test('worlds isolate every host path, reject escapes and remove their roots', async () => {
    const a = makeWorld(), b = makeWorld()
    try {
      for (const key of ['HOME', 'USERPROFILE', 'HERMES_HOME', 'GROK_HOME', 'OPENCLAW_STATE_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'LOCALAPPDATA', 'APPDATA', 'TMP', 'TEMP', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROGRESS_FILE']) assert.ok(a.env[key].startsWith(a.root + '\\') || a.env[key].startsWith(a.root + '/'), key)
      assert.notEqual(a.root, b.root)
      assert.equal(a.env.HERMES_HOME, join(a.home, '.hermes'))
      assert.equal(a.env.AGENT_BOARD_CODEX, undefined)
      assert.equal((a.read('agent-board.mjs').match(/\(\(target, done\) => done\(false\)\)\((?:html|url),/g) ?? []).length, 2)
      assert.doesNotMatch(a.read('agent-board.mjs'), /\bopenInBrowser\(/)
      assert.throws(() => a.write('../../../escaped', 'no'), /Outside world/)
      a.write('only-a', 'synthetic')
      assert.equal(b.exists('only-a'), false)
    } finally {
      await a.close()
      await b.close()
    }
    assert.equal(existsSync(a.root), false)
    assert.equal(existsSync(b.root), false)
  })

  test('a cleanup failure still stops every registered child and removes the world', async () => {
    const world = makeWorld()
    try {
      const server = await serve.start(world)
      const watch = terminal.watch(world)
      await watch.next(text => text.includes('Progress'), 10000)
      world.cleanups.push(() => { throw new Error('injected cleanup failure') })
      await assert.rejects(world.close(), error => error instanceof AggregateError && error.errors.some(one => one.message === 'injected cleanup failure'))
      assert.equal(existsSync(world.root), false)
      for (const pid of [server.pid, watch.pid]) assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/i)
    } finally { await world.close() }
  })

  test('block rewrites preserve foreign bytes and turn payloads cover every host', async () => {
    const world = makeWorld()
    try {
      world.write('progress.md', '# Notes\r\n\r\n## api-gateway\r\nforeign bytes  \r\n')
      block(world)
      const before = world.read('progress.md')
      block(world, { title: 'Changed task' })
      assert.ok(world.read('progress.md').startsWith('# Notes\r\n\r\n## api-gateway\r\nforeign bytes  \r\n'))
      assert.equal((world.read('progress.md').match(/<!-- auto /g) ?? []).length, 1)
      assert.notEqual(world.read('progress.md'), before)
      const example = '```markdown\n<!-- auto session=a1000001 agent=codex state=working updated=2026-10-20T12:00:00Z -->\n### Example only\n<!-- /auto session=a1000001 -->\n```\n'
      world.write('progress.md', example + world.read('progress.md'))
      block(world, { title: 'Visible replacement' })
      assert.ok(world.read('progress.md').startsWith(example))
      assert.match(world.read('progress.md'), /Visible replacement/)
      for (const host of ['codex', 'gemini', 'antigravity', 'cursor', 'grok', 'hermes', 'openclaw', 'opencode', 'muse', 'deepseek']) {
        turn(world, host, { project: 'docs-site', text: `Synthetic ${host} turn` })
        assert.match((await terminal.screen(world)), new RegExp(`Synthetic ${host} turn`))
      }
    } finally { await world.close() }
  })

  test('clock preloads new Date, Date(), Date.now, moves at real speed and follows jumps in a live child', async () => {
    const world = makeWorld()
    // A child's reading lies between the world's time just before it started and just after it ended.
    const between = (value, before, after, label) => assert.ok(value >= before && value <= after, `${label}: ${value} is not within ${before}..${after}`)
    try {
      const before = world.now
      const first = (await run(world, [], { code: 'const at = Date.now(); setTimeout(() => console.log(JSON.stringify([at, Date.now(), new Date().getTime(), Date(), new Date(0).getTime()])), 20)' }))
      const after = world.now
      assert.equal(first.status, 0, first.stderr)
      const values = JSON.parse(first.stdout)
      between(values[0], before, after, 'Date.now()')
      // A frozen clock would hand a product retry the same millisecond, and so the same temp name.
      assert.ok(values[1] > values[0], 'The world clock does not move')
      between(values[2], values[1], after, 'new Date()')
      between(Date.parse(values[3]), Math.floor(before / 1000) * 1000, after, 'Date()')
      assert.equal(values[4], 0)
      const file = turn(world, 'codex')
      const mtime = statSync(file).mtimeMs
      const watch = terminal.watch(world)
      try {
        await watch.next(text => text.includes('Progress'), 10000)
        const real = Date.now()
        const prior = world.now
        for (const spec of ['90m', '12h', '3d', '1mo']) world.jump(spec)
        const shift = (90 * 60 + 12 * 3600 + 33 * 86400) * 1000
        assert.equal(statSync(file).mtimeMs, mtime - shift)
        // A jump moves the clock by its span plus the real time it took, never more.
        between(world.now - prior, shift, shift + Date.now() - real, 'four jumps')
        const start = world.now
        const check = (await run(world, [], { code: 'console.log(Date.now())' }))
        between(Number(check.stdout.trim()), start, world.now, 'Date.now() after four jumps')
      } finally { await watch.stop() }
      // A child reads the clock file after startup; its real interval keeps moving.
      const worker = spawnIsolated(process.execPath, ['--input-type=module', '-e', 'console.log(Date.now()); setTimeout(() => { console.log(Date.now()); process.exit(0) }, 450)'], { env: world.env, cwd: world.root, timeout: 20000 })
      let output = ''
      worker.stdout.setEncoding('utf8').on('data', text => { output += text })
      const done = new Promise(resolve => worker.once('close', resolve))
      try {
        await seenWithin(() => output, text => text.includes('\n'), PANE_MS)
        const jumped = world.jump('90m')
        assert.equal(await done, 0)
        between(Number(output.trim().split('\n').at(-1)), jumped, world.now, 'Date.now() after a live jump')
      } finally {
        worker.kill()
        await done
      }
    } finally { await world.close() }
  })

  test('killMidWrite and tear expose incomplete bytes without leaving a child', async () => {
    const world = makeWorld()
    try {
      block(world)
      await killMidWrite(world)
      assert.equal(world.read('progress.md'), '## torn\n<!-- auto session=')
      world.write('torn.json', '{"value":42}')
      tear(world, 'torn.json', 7)
      assert.equal(world.read('torn.json'), '{"value')
      assert.throws(() => JSON.parse(world.read('torn.json')))
    } finally { await world.close() }
  })

  test('lockFile refuses a concurrent writer until the Windows handle closes', async t => {
    const world = makeWorld()
    try {
      world.write('locked', 'old')
      const lock = await lockFile(world, 'locked')
      if (lock.skip) {
        t.skip(lock.skip)
        return
      }
      try {
        const attempt = (await run(world, [], { code: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(world.claudeDir, 'locked'))}, 'new')` }))
        assert.notEqual(attempt.status, 0)
        assert.match(attempt.stderr, /EBUSY|EACCES|EPERM/)
      } finally { await lock.release() }
      world.write('locked', 'released')
      assert.equal(world.read('locked'), 'released')
    } finally { await world.close() }
  })

  test('twoWriters releases two live children against the same file', async () => {
    const world = makeWorld()
    try {
      const results = await twoWriters(world, { name: 'race', text: 'writer a' }, { name: 'race', text: 'writer b' })
      assert.ok(results.some(result => result.status === 0), 'At least one concurrent rename must land')
      for (const result of results) {
        assert.match(result.stdout, /WRITER_READY/)
        if (result.status !== 0) assert.match(result.stderr, /EPERM|EBUSY|EACCES/)
      }
      assert.ok(['writer a', 'writer b'].includes(world.read('race')))
    } finally { await world.close() }
  })

  for (const [name, fault, code] of [['readOnly', readOnly, process.platform === 'win32' ? 'EPERM' : 'EACCES'], ['diskFull', diskFull, 'ENOSPC']]) test(`${name} makes writes and renames fail in children`, async () => {
    const world = makeWorld()
    try {
      world.write('source', 'retained')
      const injected = fault(world)
      try {
        for (const operation of [`writeFileSync(${JSON.stringify(join(world.claudeDir, 'new'))}, 'data')`, `renameSync(${JSON.stringify(join(world.claudeDir, 'source'))}, ${JSON.stringify(join(world.claudeDir, 'dest'))})`]) {
          const attempt = (await run(world, [], { code: `import { writeFileSync, renameSync } from 'node:fs'; ${operation}` }))
          assert.notEqual(attempt.status, 0)
          assert.match(attempt.stderr, new RegExp(code))
        }
      } finally { injected.restore() }
      assert.equal(world.read('source'), 'retained')
    } finally { await world.close() }
  })

  test('skew changes only one producer clock and updateMidSession swaps an older bundle', async () => {
    const world = makeWorld()
    try {
      block(world)
      block(world, { session: 'b2000002', title: 'Other task' })
      const other = world.read('progress.md').split('<!-- auto session=b2000002')[1]
      const stamp = /<!-- auto session=a1000001 [^\n]*?updated=([^\s>]+)/.exec(world.read('progress.md'))[1]
      skew(world, 'a1000001', 60000)
      assert.ok(world.read('progress.md').includes('updated=' + new Date(Date.parse(stamp) + 60000).toISOString()))
      assert.equal(world.read('progress.md').split('<!-- auto session=b2000002')[1], other)
      const before = world.read('agent-board.mjs')
      const update = updateMidSession(world)
      assert.notEqual(world.read('agent-board.mjs'), before)
      console.log(`older bundle: ${update.source}`)
      assert.equal((await run(world)).status, 0)
      update.restore()
      assert.equal(world.read('agent-board.mjs'), before)
    } finally { await world.close() }
  })

  test('uninstall and reinstall move and restore only the isolated installation', async () => {
    const world = makeWorld()
    try {
      block(world)
      const before = world.read('progress.md')
      uninstall(world)
      assert.equal(existsSync(world.script), false)
      reinstall(world)
      assert.equal(world.read('progress.md'), before)
      assert.match((await terminal.screen(world)), /Prepare the gateway/)
    } finally { await world.close() }
  })

  test('all drivers render the shipped board and watch observes a real file change', async () => {
    const world = makeWorld()
    let server, watch
    try {
      block(world)
      assert.match((await terminal.screen(world)), /Prepare the gateway/)
      assert.match((await chat(world)).stdout, /Prepare the gateway/)
      assert.match((await html(world)).visible, /Prepare the gateway/)
      assert.match((await terminal.keys(world, '')), /Prepare the gateway/)
      server = await serve.start(world)
      assert.match(await server.page(), /Prepare the gateway/)
      watch = terminal.watch(world)
      await watch.next(text => text.includes('Prepare the gateway'), 10000)
      block(world, { title: 'Refreshed gateway' })
      const frame = await watch.next(text => text.includes('Refreshed gateway'), PANE_MS)
      assert.ok(frame.elapsed <= PANE_MS)
      await seenPageWithin(server, text => text.includes('Refreshed gateway'), PAGE_MS)
      world.write('progress.md', world.read('progress.md') + '\n## docs-site\n### Publish docs\n- [ ] Check the links\n')
      const press = await server.press('Publish docs', /Check the links/)
      noSilentPress(press)
    } finally {
      await world.close()
    }
  })

  test('expectations detect missed deadlines, silent presses, machine ids and unexpectedly fixed bugs', async () => {
    const world = makeWorld()
    try {
      block(world, { resume: 'synthetic-resume-session' })
      await assert.rejects(seenWithin(() => 'last visible text', () => false, 20), /last visible text/)
      assert.throws(() => noSilentPress({ surface: 'terminal', card: 'Gateway', button: 'x', before: 'same', after: 'same' }), /pressed x on Gateway on terminal: nothing happened/)
      noSilentPress({ before: 'before', after: 'Done' })
      for (const text of ['a1000001', 'synthetic-resume-session', world.root, 'a'.repeat(40), 'b'.repeat(64), '/home/example/work']) assert.throws(() => noMachineIds(text, world))
      noMachineIds('Synthetic task https://example.test/answer', world)
      assert.throws(() => noMachineIds('C:/synthetic/work', world))
      await assert.rejects(knownFailure(null, () => {}), /Invalid known failure/)
      noMachineIds('synthetic-resume-session', world, { allow: ['synthetic-resume-session'] })
      await knownFailure(222, () => assert.fail('intentional assertion'))
      await assert.rejects(knownFailure(222, () => {}), /looks fixed/)
      await knownFailure(222, () => { throw new Error('intentional thrown error') })
    } finally { await world.close() }
  })

  test('hook executes generated Codex, Grok and Antigravity commands in the isolated home', async () => {
    const world = makeWorld()
    try {
      for (const host of hookHosts) {
        const event = host === 'antigravity' ? 'PreInvocation' : 'UserPromptSubmit'
        const result = (await hook(world, host, event))
        assert.equal(result.status, 0, result.stderr || result.stdout)
        assert.match(world.read('progress.md'), new RegExp(`agent=${host} .*state=working`))
      }
    } finally { await world.close() }
  })
})
