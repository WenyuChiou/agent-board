import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { dockArguments, dockCommand, dockPlace, dockScript, isReachable, launchPlace, probeOf, windowPlaceOf } from '../hooks/board-dock.ts'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'

const screen = (width, height = 1040, x = 0, y = 0) => ({ x, y, width, height })
const address = 'http://127.0.0.1:4242/?t=abc'

test('#1084: the dock is the right quarter of the work area, 400 to 560 wide, and none below 1280', () => {
  assert.deepEqual(dockPlace(screen(1920)), { x: 1440, y: 0, width: 480, height: 1040 })
  assert.deepEqual(dockPlace(screen(1366, 728)), { x: 966, y: 0, width: 400, height: 728 })
  assert.deepEqual(dockPlace(screen(2560, 1392)), { x: 2000, y: 0, width: 560, height: 1392 })
  assert.deepEqual(dockPlace(screen(1280, 680)), { x: 880, y: 0, width: 400, height: 680 })
  assert.equal(dockPlace(screen(1279)), null)
  // A monitor left of the primary one, under a top taskbar.
  assert.deepEqual(dockPlace(screen(1920, 1000, -1920, 40)), { x: -480, y: 40, width: 480, height: 1000 })
})

test('#1084: the open command carries the size and place for 1920, 1366 and 2560 work areas, and none below 1280', () => {
  const profile = 'C:\\Users\\a b\\.cache\\agent-board\\browser'
  for (const [work, size, position] of [[screen(1920), '480,1040', '1440,0'], [screen(1366, 728), '400,728', '966,0'], [screen(2560, 1392), '560,1392', '2000,0']]) {
    const argv = dockArguments(address, null, { foreground: work, works: [work] }, profile)
    assert.deepEqual(argv, [
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--disable-features=msImplicitSignin,msEdgeSyncConsent', `--window-size=${size}`, `--window-position=${position}`, `--app=${address}&dock=1`,
    ])
  }
  // Too narrow, no screen read, or no private profile folder: today's plain app window.
  assert.deepEqual(dockArguments(address, null, { foreground: screen(1200), works: [screen(1200)] }, profile), [`--app=${address}`])
  assert.deepEqual(dockArguments(address, null, null, profile), [`--app=${address}`])
  assert.deepEqual(dockArguments(address, null, { foreground: screen(1920), works: [screen(1920)] }, null), [`--app=${address}`])
})

test('#1084: a remembered place is used on the next open, and one on a monitor that is gone falls back to the dock', () => {
  const left = screen(1920, 1040, -1920, 0)
  const main = screen(2560, 1392)
  const remembered = { x: -1500, y: 100, width: 700, height: 900 }
  assert.deepEqual(launchPlace(remembered, main, [main, left]), remembered)
  assert.deepEqual(launchPlace(remembered, main, [main]), { x: 2000, y: 0, width: 560, height: 1392 })
  // Maximized windows sit a few pixels outside the work area and still count.
  assert.ok(isReachable({ x: -8, y: -8, width: 2576, height: 1408 }, [main]))
  // Only the top strip counts: a window whose title bar is above every screen cannot be dragged back.
  assert.equal(isReachable({ x: 100, y: -400, width: 600, height: 900 }, [main]), false)
  // The remembered place opens even on a screen too narrow to dock.
  const small = screen(1200)
  const kept = { x: 10, y: 10, width: 500, height: 600 }
  assert.deepEqual(dockArguments(address, kept, { foreground: small, works: [small] }, 'p').slice(-3), ['--window-size=500,600', '--window-position=10,10', `--app=${address}&dock=2`])
  // A remembered place is told apart from the dock, so the page does not move it.
  assert.equal(dockArguments(address, remembered, { foreground: main, works: [main, left] }, 'p').at(-1), `--app=${address}&dock=2`)
  assert.equal(dockArguments(address, remembered, { foreground: main, works: [main] }, 'p').at(-1), `--app=${address}&dock=1`)
})

test('#1084: the probe line and the settings file are read strictly', () => {
  assert.deepEqual(probeOf('0,0,2560,1392|0,0,2560,1392;-1920,0,1920,1040\r\n'), { foreground: screen(2560, 1392), works: [screen(2560, 1392), screen(1920, 1040, -1920)] })
  assert.deepEqual(probeOf('|'), { foreground: null, works: [] })
  for (const bad of ['', 'garbage', '0,0,2560|', '0,0,2560,1392', '1,2,3,4|5,6,x,8']) assert.equal(probeOf(bad), null, bad)
  assert.deepEqual(windowPlaceOf('{"barStyle":"ink","window":{"x":-8,"y":0,"width":560,"height":1392}}'), { x: -8, y: 0, width: 560, height: 1392 })
  for (const bad of [null, '', '[]', 'not json', '{"window":{"x":1.5,"y":0,"width":560,"height":900}}', '{"window":{"x":0,"y":0,"width":20,"height":900}}', '{"window":"left"}']) assert.equal(windowPlaceOf(bad), null, String(bad))
})

// The page's script in a stand-in window: the screen, the window's place and the timers are fake.
const runDockScript = ({ search, place, avail }) => {
  const timers = []
  const calls = []
  const moves = []
  const win = { screenX: place.x, screenY: place.y, outerWidth: place.width, outerHeight: place.height }
  const context = {
    location: { search },
    URLSearchParams,
    Math,
    window: Object.assign(win, {
      screen: { availLeft: avail.x, availTop: avail.y, availWidth: avail.width, availHeight: avail.height },
      resizeTo: (w, h) => { moves.push(['resize', w, h]); win.outerWidth = w; win.outerHeight = h },
      moveTo: (x, y) => { moves.push(['move', x, y]); win.screenX = x; win.screenY = y },
    }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms, every: false }); return timers.length },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = () => {} },
    setInterval: (fn, ms) => { timers.push({ fn, ms, every: true }); return timers.length },
    call: (path, body) => { calls.push([path, JSON.parse(JSON.stringify(body))]); return Promise.resolve({ ok: true }) },
    isClosed: false,
  }
  vm.runInNewContext(dockScript, context)
  const tick = () => {
    for (const one of [...timers]) {
      if (one.every) one.fn()
      else if (!one.done) { one.done = true; one.fn() }
    }
  }
  return { win, calls, moves, tick, timers, context }
}

test('#1084: the docked page docks itself when the browser put it off its screen, and reports only the person\'s moves, once they settle', () => {
  // Display scaling: the flags were computed in physical pixels, the page sees a 2048 wide screen.
  const scaled = runDockScript({ search: '?t=abc&dock=1', place: { x: 2000, y: 0, width: 560, height: 1168 }, avail: screen(2048, 1114) })
  assert.deepEqual(scaled.moves, [['resize', 512, 1114], ['move', 1536, 0]])
  scaled.tick()
  scaled.tick()
  assert.deepEqual(scaled.calls, [], 'the place it opened at is not sent')
  scaled.win.screenX = 300
  scaled.tick()
  assert.deepEqual(scaled.calls, [], 'a move is sent only once it holds')
  scaled.tick()
  assert.deepEqual(scaled.calls, [['/api/window', { x: 300, y: 0, width: 512, height: 1114 }]])

  // A remembered place across two monitors (dock=2) stays where the person put it, and their
  // next move is still reported.
  const across = runDockScript({ search: '?t=abc&dock=2', place: { x: 1650, y: 100, width: 600, height: 800 }, avail: screen(1920, 1040, 1920) })
  assert.deepEqual(across.moves, [])
  across.tick()
  across.win.screenX = 1700
  across.tick()
  across.tick()
  assert.deepEqual(across.calls, [['/api/window', { x: 1700, y: 100, width: 600, height: 800 }]])

  // A page a newer one replaced, or the person closed, reports nothing more, even a move already
  // waiting to settle.
  across.win.screenX = 1800
  across.tick()
  across.context.isClosed = true
  across.tick()
  across.win.screenX = 1900
  across.tick()
  across.tick()
  assert.equal(across.calls.length, 1, 'a closed page reports no move')

  const inside = runDockScript({ search: '?t=abc&dock=1', place: { x: 2000, y: 0, width: 560, height: 1392 }, avail: screen(2560, 1392) })
  assert.deepEqual(inside.moves, [])

  // A page not opened docked (a browser tab, the phone) never moves or reports its window.
  const tab = runDockScript({ search: '?t=abc', place: { x: 2000, y: 0, width: 560, height: 1392 }, avail: screen(1000) })
  assert.deepEqual(tab.moves, [])
  assert.equal(tab.timers.length, 0)
})

test('#1084: the built page carries the dock script', () => {
  assert.ok(BOARD_SCRIPT.includes("mode === '1' && !isInside(now, area)"))
  assert.ok(BOARD_SCRIPT.includes("call('/api/window', one)"))
})

test('#1084: the computer\'s page keeps the window place in the settings file; a bad place is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'board-dock-'))
  let url = ''
  try {
    const progress = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')
    writeFileSync(join(root, 'progress-settings.json'), '{"barStyle":"blue"}\n')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, lang: 'en' })}\n${BOARD_SCRIPT}`)
    const result = spawnSync(process.execPath, [script, '--html', '--no-open'], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, CLAUDE_PROGRESS_FILE: '', AGENT_BOARD_TEST_PID: '', NO_COLOR: '1' },
    })
    assert.equal(result.status, 0, result.stderr)
    url = result.stdout.trim()
    const page = new URL(url)
    const post = body => fetch(new URL('/api/window', page), { method: 'POST', headers: { 'x-board-token': page.searchParams.get('t'), 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await post({ x: -1500, y: 20, width: 700, height: 900 })).status, 200)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'progress-settings.json'), 'utf8')), { barStyle: 'blue', window: { x: -1500, y: 20, width: 700, height: 900 } })
    assert.equal((await post({ x: 'left', y: 0, width: 700, height: 900 })).status, 400)
    assert.equal((await post({ x: 0, y: 0, width: 10, height: 900 })).status, 400)
    // A page a newer page replaced (#265) cannot overwrite the place; the newer page can.
    const token = page.searchParams.get('t')
    const poll = id => fetch(new URL('/api/board', page), { headers: { 'x-board-token': token, 'x-board-page': id } })
    const postFrom = (id, body) => fetch(new URL('/api/window', page), { method: 'POST', headers: { 'x-board-token': token, 'x-board-page': id, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await poll('pold')).status, 200)
    assert.equal((await poll('pnew')).status, 200)
    assert.equal((await postFrom('pold', { x: 10, y: 10, width: 700, height: 900 })).status, 409)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'progress-settings.json'), 'utf8')).window, { x: -1500, y: 20, width: 700, height: 900 })
    assert.equal((await postFrom('pnew', { x: 20, y: 20, width: 700, height: 900 })).status, 200)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'progress-settings.json'), 'utf8')).window, { x: 20, y: 20, width: 700, height: 900 })
    // A settings file that is a folder, or a link to another file, is left as it is (#1261).
    const settings = join(root, 'progress-settings.json')
    rmSync(settings)
    mkdirSync(settings)
    assert.equal((await post({ x: 0, y: 0, width: 700, height: 900 })).status, 409)
    rmSync(settings, { recursive: true })
    const victim = join(root, 'victim.json')
    writeFileSync(victim, '{"kept":true}')
    let hasLink = true
    try { symlinkSync(victim, settings) } catch { hasLink = false }
    if (hasLink) {
      assert.equal((await post({ x: 0, y: 0, width: 700, height: 900 })).status, 409)
      assert.equal(readFileSync(victim, 'utf8'), '{"kept":true}')
      unlinkSync(settings)
    }
  } finally {
    if (url) {
      const page = new URL(url)
      await fetch(new URL('/api/close', page), { method: 'POST', headers: { 'x-board-token': page.searchParams.get('t'), 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
      await new Promise(r => setTimeout(r, 500))
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

// The launch PowerShell itself, on Windows: the probe's line, the arguments read back from stdin,
// the program started with them; a program that does not start, and no arguments, both fail so
// the caller opens today's plain window. The stand-in program is Node, started hidden.
const literal = value => `'${value.replace(/'/g, "''")}'`
const runLaunch = (programs, answer, cwd) => new Promise(done => {
  const command = dockCommand(programs, literal(cwd), 1500, true)
  const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  let isAnswered = false
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    out += chunk
    if (!isAnswered && out.includes('\n')) { isAnswered = true; child.stdin.end(answer === null ? '\n' : `${Buffer.from(answer, 'utf16le').toString('base64')}\n`) }
  })
  child.stdin.on('error', () => {})
  const timer = setTimeout(() => child.kill(), 30000)
  child.on('exit', code => { clearTimeout(timer); done({ code, lines: out.split(/\r?\n/).filter(Boolean) }) })
})

test('#1084: the launch PowerShell reads the screens, then starts the program with the arguments it is sent, and fails when none starts', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'board-dock-launch-'))
  try {
    const seen = join(root, 'seen.json')
    const stand = join(root, 'stand-in.mjs')
    writeFileSync(stand, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)))\n`)
    const app = `--app=${address}&dock=1`
    const started = await runLaunch(`${literal(join(root, 'no-such-browser.exe'))}, ${literal(process.execPath)}`, `"${stand}" "--window-size=480,1040" "${app}"`, root)
    assert.equal(started.code, 0, started.lines.join('\n'))
    const probe = probeOf(started.lines[0])
    assert.ok(probe !== null && probe.works.length >= 1, `the probe reads every monitor: ${started.lines[0]}`)
    assert.match(started.lines.at(-1), /^\d+$/, 'the started program\'s id')
    for (let i = 0; i < 100 && !existsSync(seen); i++) await new Promise(r => setTimeout(r, 100))
    assert.deepEqual(JSON.parse(readFileSync(seen, 'utf8')), ['--window-size=480,1040', app])

    const none = await runLaunch(literal(join(root, 'no-such-browser.exe')), `"${app}"`, root)
    assert.equal(none.code, 1)
    const unanswered = await runLaunch(literal(process.execPath), null, root)
    assert.equal(unanswered.code, 2)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
