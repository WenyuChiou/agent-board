import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { registerHooks } from 'node:module'

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })

import { BOARD_SCRIPT } from '../hooks/board-script.ts'
import { removeTree } from './helpers/remove-tree.mjs'
const { BOARD_REQUEST_HINTS, LEGACY_BOARD_PROMPTS, boardRequestWords, geminiBoardCommand, isBoardRequest, opencodeBoardCommand } = await import('../hooks/board-commands.ts')
const { isInstallerSkill } = await import('../hooks/connect-pure.ts')
const { STRINGS } = await import('../hooks/strings.ts')

const run = (file, args, env) => new Promise((done, fail) => {
  execFile(process.execPath, [file, ...args], { env, encoding: 'utf8', timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => {
    if (error) fail(Object.assign(error, { stdout, stderr }))
    else done({ stdout, stderr })
  })
})

const closePage = url => new Promise(done => {
  const address = new URL(url)
  const req = request({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/api/close', headers: { host: address.host, 'x-board-token': address.searchParams.get('t'), 'content-type': 'application/json' } }, res => res.resume().on('end', done))
  req.on('error', done)
  req.end('{}')
})

test('agent-board with no flag inside an agent opens the page and prints one bare URL', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'board-entry-'))
  const runtime = join(root, 'run')
  const progress = join(root, 'progress.md')
  const script = join(root, 'agent-board.mjs')
  let url = ''
  let pid = null
  try {
    mkdirSync(runtime, { mode: 0o700 })
    writeFileSync(progress, '## Synthetic\n### Plan\n- [ ] Continue\n')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, lang: 'en' })}\n${BOARD_SCRIPT}`)
    const env = {
      ...Object.fromEntries(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
      CI: '',
      AGENT_BOARD_SESSION_ID: 'synthetic-entry-session',
      CLAUDE_PROGRESS_FILE: '',
      HOME: root,
      USERPROFILE: root,
      TEMP: root,
      TMP: root,
      TMPDIR: root,
      XDG_RUNTIME_DIR: runtime,
      NO_COLOR: '1',
    }
    const result = await run(script, ['--no-open'], env)
    assert.equal(result.stderr, '')
    const lines = result.stdout.trim().split(/\r?\n/)
    assert.equal(lines.length, 1)
    url = lines[0]
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/)
    const alias = await run(script, ['--html', '--no-open'], env)
    assert.equal(alias.stderr, '')
    assert.equal(alias.stdout.trim(), url)
    assert.equal(existsSync(join(root, 'progress.html')), false)
    const records = readdirSync(runtime, { recursive: true }).filter(name => String(name).endsWith('.json'))
    const record = records.map(name => join(runtime, String(name))).find(name => {
      try { return JSON.parse(readFileSync(name, 'utf8')).url === url } catch { return false }
    })
    assert.ok(record, 'the live page address is recorded under the scratch runtime folder')
    pid = JSON.parse(readFileSync(record, 'utf8')).pid
  } finally {
    for (const name of (existsSync(runtime) ? readdirSync(runtime, { recursive: true }) : []).filter(name => String(name).endsWith('.json'))) {
      try {
        const record = JSON.parse(readFileSync(join(runtime, String(name)), 'utf8'))
        if (record.path === progress && typeof record.pid === 'number' && typeof record.url === 'string') {
          pid = record.pid
          url = record.url
        }
      } catch {}
    }
    if (url) await closePage(url)
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    if (typeof pid === 'number' && pid !== process.pid) {
      for (let tries = 0; alive() && tries < 100; tries++) await new Promise(done => setTimeout(done, 50))
      assert.equal(alive(), false, 'the page server exits before scratch cleanup')
    }
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    removeTree(root)
  }
})

test('every current and legacy board prompt reads JSON without pasting it, and wrappers invoke the no-flag command', () => {
  const command = 'node "/synthetic/agent-board.mjs"'
  const words = boardRequestWords(Object.values(STRINGS))
  assert.ok(!BOARD_REQUEST_HINTS.includes('--json'))
  for (const fragment of words) assert.ok(BOARD_REQUEST_HINTS.some(hint => fragment.toLowerCase().includes(hint)), fragment)
  assert.equal(LEGACY_BOARD_PROMPTS.length, 3)
  for (const legacy of LEGACY_BOARD_PROMPTS) {
    for (const prompt of [legacy.boardCommandPrompt, legacy.boardSkillPrompt(command), legacy.boardChatSkillPrompt(command)]) {
      assert.equal(isBoardRequest({ prompt }, words), true)
    }
  }
  for (const [lang, s] of Object.entries(STRINGS)) {
    const current = [s.boardCommandPrompt, s.boardSkillPrompt(command), s.boardChatSkillPrompt(command)]
    for (const prompt of current) {
      assert.ok(prompt.includes('--json'), `${s.lang}: prompt reads JSON`)
      assert.ok(!prompt.includes('--chat') && !prompt.includes('--serve'), `${s.lang}: prompt uses the current entry points`)
      assert.ok(!prompt.includes('exactly as it is') && !prompt.includes('照樣貼上') && !prompt.includes('原样贴上'), `${s.lang}: prompt does not ask the model to paste command output`)
      assert.equal(isBoardRequest({ prompt }, words), true)
    }
    assert.ok(s.boardSkillPrompt(command).includes(`\`${command}\``), `${lang}: skill invokes the board without a surface flag`)
    assert.ok(s.boardChatSkillPrompt(command).includes(`${command} --json`))
    assert.ok(s.localAgentSkill(command).includes(`${command} --json`))
    assert.ok(!s.localAgentSkill(command).includes(`${command} --chat`) && !s.localAgentSkill(command).includes(`${command} --serve`))
    assert.ok(!s.localAgentSkill(command).includes('exactly as it is') && !s.localAgentSkill(command).includes('照樣貼上') && !s.localAgentSkill(command).includes('原样贴上'))
    assert.equal(isBoardRequest({ prompt: s.localAgentSkill(command) }, words), true, `${lang}: installer skill is classified as a board request`)
    const installer = `---\nname: agent-board\ndescription: ${JSON.stringify(s.localAgentSkillDescription)}\n---\n\n${s.localAgentSkill(command)}\n`
    assert.equal(isInstallerSkill(installer), true)
    const gemini = JSON.parse(/^prompt = (.+)$/m.exec(geminiBoardCommand(s.boardCommandDescription, s.boardCommandPrompt, command))[1])
    const opencode = opencodeBoardCommand(s.boardCommandDescription, s.boardCommandPrompt, command)
    assert.ok(gemini.includes(`\`${command}\``) && gemini.includes(`!{${command}}`))
    assert.ok(opencode.includes(`\`${command}\``) && opencode.includes(`!\`${command}\``))
    assert.ok(!gemini.includes(`${command} --serve`) && !opencode.includes(`${command} --serve`))
  }
  assert.deepEqual(Object.fromEntries(Object.entries(STRINGS).map(([lang, s]) => [lang, s.localAgentSkillDescription])), {
    en: 'Open the local interactive board and track real task progress for the currently connected session.',
    'zh-TW': '開啟本機互動看板，追蹤目前已接線 session 的實際任務進度。',
    'zh-CN': '打开本地交互看板，跟踪当前已接线 session 的实际任务进度。',
  })
  assert.deepEqual(Object.fromEntries(Object.entries(STRINGS).map(([lang, s]) => [lang, s.boardCommandDescription])), {
    en: 'Agent Board: what every agent is doing, and what waits on you',
    'zh-TW': 'Agent Board：每個 agent 在做什麼、什麼在等你',
    'zh-CN': 'Agent Board：每个 agent 在做什么、什么在等你',
  })
})

test('every launcher help lists the agent JSON read and leaves out the retired surfaces', async () => {
  const launcher = fileURLToPath(new URL('../bin/agent-board.mjs', import.meta.url))
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    for (const args of [['--help'], ['--help', 'all']]) {
      const { stdout, stderr } = await run(launcher, [...args, '--lang', lang], process.env)
      assert.equal(stderr, '')
      assert.ok(stdout.includes('--json'), `${lang}: ${args.join(' ')} lists the JSON read`)
      assert.ok(!stdout.includes('--html') && !stdout.includes('--chat'))
      assert.ok(!stdout.includes('text for agents') && !stdout.includes('agent 印純文字') && !stdout.includes('agent 印纯文本'))
    }
  }
})

// Node's rmSync does not retry an EBUSY from the folder itself (main 78fc392), so the test
// cleanup retries it; a stand-in removal makes the busy folder the same on every computer.
test('a test folder that is busy for a moment is still removed, and one that stays busy fails with its error', () => {
  const busy = code => Object.assign(new Error(`synthetic ${code}`), { code })
  for (const code of ['EBUSY', 'EPERM', 'ENOTEMPTY']) {
    let calls = 0
    removeTree('synthetic-folder', { delayMs: 1, remove: () => { calls++; if (calls < 3) throw busy(code) } })
    assert.equal(calls, 3, code)
  }
  let calls = 0
  assert.throws(() => removeTree('synthetic-folder', { attempts: 4, delayMs: 1, remove: () => { calls++; throw busy('EBUSY') } }), { code: 'EBUSY' })
  assert.equal(calls, 4)
  calls = 0
  assert.throws(() => removeTree('synthetic-folder', { delayMs: 1, remove: () => { calls++; throw busy('EACCES') } }), { code: 'EACCES' })
  assert.equal(calls, 1, 'another error is not retried')
})

// A scratch board (its own home, temp and runtime folders) and the page cleanup every test below needs.
const withBoard = async fn => {
  const root = mkdtempSync(join(tmpdir(), 'board-entry-'))
  const runtime = join(root, 'run')
  const progress = join(root, 'progress.md')
  const script = join(root, 'agent-board.mjs')
  mkdirSync(runtime, { mode: 0o700 })
  writeFileSync(progress, '## Synthetic\n### Entry plan\n- [ ] Continue the entry work\n')
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, lang: 'en' })}\n${BOARD_SCRIPT}`)
  const env = {
    ...Object.fromEntries(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    CI: '', AGENT_BOARD_SESSION_ID: 'synthetic-entry-session', CLAUDE_PROGRESS_FILE: '', HOME: root, USERPROFILE: root, TEMP: root, TMP: root, TMPDIR: root, XDG_RUNTIME_DIR: runtime, NO_COLOR: '1',
    AGENT_BOARD_TEST_PID: String(process.pid),
  }
  let pid = null
  try {
    await fn({ root, script, env })
  } finally {
    for (const name of (existsSync(runtime) ? readdirSync(runtime, { recursive: true }) : []).filter(name => String(name).endsWith('.json'))) {
      try {
        const record = JSON.parse(readFileSync(join(runtime, String(name)), 'utf8'))
        if (record.path === progress && typeof record.pid === 'number' && typeof record.url === 'string') {
          pid = record.pid
          await closePage(record.url)
        }
      } catch {}
    }
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    if (typeof pid === 'number' && pid !== process.pid) {
      for (let tries = 0; alive() && tries < 100; tries++) await new Promise(done => setTimeout(done, 50))
      assert.equal(alive(), false, 'the page server exits before scratch cleanup')
    }
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    removeTree(root)
  }
}

test('--serve from an older command file opens the page and prints no text board before its address (#868)', { timeout: 30_000 }, async () => {
  await withBoard(async ({ script, env }) => {
    const result = await run(script, ['--serve', '--no-open'], env)
    assert.equal(result.stderr, '')
    const lines = result.stdout.trim().split(/\r?\n/)
    assert.equal(lines.length, 1, result.stdout)
    assert.match(lines[0], /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/)
    assert.ok(!result.stdout.includes('Entry plan') && !result.stdout.includes('Continue the entry work'), 'the board text is not printed')
  })
})

test('--lan without --serve opens the page and shows the network address, as --serve --lan does (#868)', { timeout: 30_000 }, async () => {
  await withBoard(async ({ script, env }) => {
    const result = await run(script, ['--no-open', '--lan'], env)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)
    assert.match(result.stdout, /open http:\/\/[\d.]+:\d+\/\?t=[\w-]+ or scan this code:|This computer has no address on a local network/)
    assert.ok(!result.stdout.includes('Entry plan'), 'no text board either')
  })
})

test('--lan with the board page already open still shows the network address (#868)', { timeout: 30_000 }, async () => {
  await withBoard(async ({ script, env }) => {
    const first = await run(script, ['--no-open'], env)
    const local = first.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)?.[0]
    assert.ok(local, first.stdout)
    // A page loading the address is what makes the board count it as open.
    await new Promise((done, fail) => request(local, res => { res.resume(); res.on('end', done) }).on('error', fail).end())
    const result = await run(script, ['--lan'], env)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /already open in your browser/)
    assert.match(result.stdout, /open http:\/\/[\d.]+:\d+\/\?t=[\w-]+ or scan this code:|This computer has no address on a local network/)
  })
})

test('the plain launcher help no longer lists --serve, and --help all marks it old (#868)', async () => {
  const launcher = fileURLToPath(new URL('../bin/agent-board.mjs', import.meta.url))
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const plain = await run(launcher, ['--help', '--lang', lang], process.env)
    assert.ok(!plain.stdout.includes('--serve'), `${lang}: plain help`)
    const all = await run(launcher, ['--help', 'all', '--lang', lang], process.env)
    assert.match(all.stdout, /--serve +(old|舊用法|旧用法)/, lang)
  }
  const unknown = await run(launcher, ['serve'], process.env).catch(error => error)
  assert.ok(!unknown.stderr.includes('--serve'), 'the unknown-command hint does not suggest --serve')
})

// The first run of a person: no board script anywhere, a keyboard to answer on.
const firstRun = async (answer, check, extraEnv = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'board-first-'))
  try {
    const shim = join(root, 'tty-shim.cjs')
    writeFileSync(shim, 'process.stdout.isTTY = true; process.stdin.isTTY = true;\n')
    const home = join(root, 'home')
    mkdirSync(home)
    // One synthetic agent folder and a PATH with only Node on it, so setup finds the same agent on every machine.
    mkdirSync(join(home, '.cursor'))
    const env = {
      ...Object.fromEntries(['SystemRoot', 'SystemDrive', 'windir', 'ComSpec'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
      PATH: dirname(process.execPath),
      CI: '', LANG: 'en_US.UTF-8', HOME: home, USERPROFILE: home, TEMP: root, TMP: root, TMPDIR: root, NO_COLOR: '1', AGENT_BOARD_TEST_PID: String(process.pid),
      // The shim fakes a terminal for the launcher only; setup asks through its own test seam.
      AGENT_BOARD_SETUP_TTY: '1', ...extraEnv,
    }
    const launcher = fileURLToPath(new URL('../bin/agent-board.mjs', import.meta.url))
    const result = await new Promise(done => {
      const child = execFile(process.execPath, ['--require', shim, launcher], { env, encoding: 'utf8', timeout: 25_000, windowsHide: true }, (error, stdout, stderr) => done({ status: error ? (error.code ?? 1) : 0, stdout, stderr }))
      // { after, text } types the answer only once the question is on screen, as a person does.
      if (typeof answer === 'string') child.stdin.end(answer)
      else {
        let seen = ''
        child.stdout.on('data', chunk => {
          seen += chunk
          if (seen.includes(answer.after) && !child.stdin.writableEnded) child.stdin.end(answer.text)
        })
      }
    })
    check(result, home)
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    removeTree(root)
  }
}

test('the first plain agent-board in a terminal with nothing set up asks one question, and no changes nothing (#868)', { timeout: 40_000 }, async () => {
  await firstRun('n\n', ({ status, stdout, stderr }, home) => {
    const asked = stdout.indexOf('Set these up? [Y/n]')
    assert.ok(asked > 0, stdout)
    assert.equal(stdout.split('Set these up?').length - 1, 1, 'one question')
    assert.ok(stdout.includes('would create') && stdout.indexOf('would create') < asked, 'the preview is printed before the question')
    assert.ok(stdout.indexOf('--apply') > asked, 'a no keeps the manual apply step')
    // Setup's no already says what to do next, so the launcher adds no "not set up" error.
    assert.equal(status, 0, stderr)
    assert.doesNotMatch(stderr, /not set up for this account yet/)
    assert.equal(existsSync(join(home, '.agent-board')), false, 'nothing was written')
  })
})

test('the first plain agent-board in a terminal with nothing set up applies setup on one yes (#868)', { timeout: 60_000 }, async () => {
  await firstRun('y\n', ({ status, stdout, stderr }, home) => {
    const asked = stdout.indexOf('Set these up? [Y/n]')
    assert.ok(asked > 0 && stdout.includes('would create') && stdout.indexOf('would create') < asked, 'the preview is printed before the question')
    assert.equal(stdout.split('Set these up?').length - 1, 1, 'one question')
    assert.ok(existsSync(join(home, '.agent-board', 'agent-board.mjs')), stdout)
    assert.doesNotMatch(stderr, /not set up for this account yet/)
    assert.equal(status, 0, stderr)
    // CI picks the text board, so no window opens; the same run shows the board after setup.
    const after = stdout.slice(asked)
    assert.match(after, /Nothing needs you|No work in progress|Progress/, after.slice(-400))
    assert.ok(!stdout.includes('--serve'), 'setup output names the plain command')
  }, { CI: '1' })
})

// The launcher opens process.stdin, which leaves the inherited pipe non-blocking on POSIX, so setup's
// first read of an answer not typed yet fails with EAGAIN; setup must wait for the answer instead.
test('the first plain agent-board waits for a yes typed after the question, though the launcher left stdin non-blocking (#1162)', { skip: process.platform === 'win32', timeout: 60_000 }, async () => {
  await firstRun({ after: 'Set these up?', text: 'y\n' }, ({ status, stdout, stderr }, home) => {
    assert.equal(status, 0, stderr)
    assert.ok(existsSync(join(home, '.agent-board', 'agent-board.mjs')), stdout)
    assert.doesNotMatch(stdout, /Apply these changes: /)
  }, { CI: '1' })
})

test('a first-run setup preview that fails shows its own error and exit status, and asks nothing (#868)', { timeout: 40_000 }, async () => {
  // The preload makes setup itself fail before it previews or asks; the launcher is untouched.
  const shimDir = mkdtempSync(join(tmpdir(), 'board-first-fail-'))
  try {
    const failShim = join(shimDir, 'fail-preview.cjs')
    writeFileSync(failShim, "if ((process.argv[1] || '').endsWith('setup-agent.mjs') && !process.argv.includes('--apply')) { process.stderr.write('setup preview failed for the test\\n'); process.exit(3) }\n")
    await firstRun('y\n', ({ status, stdout, stderr }, home) => {
      assert.equal(status, 3, stderr)
      assert.match(stderr, /setup preview failed for the test/)
      assert.doesNotMatch(stdout, /Set these up\?/)
      assert.doesNotMatch(stderr, /not set up for this account yet/)
      assert.equal(existsSync(join(home, '.agent-board')), false, 'nothing was written')
    }, { NODE_OPTIONS: `--require "${failShim.replace(/\\/g, '/')}"` })
  } finally {
    removeTree(shimDir)
  }
})
