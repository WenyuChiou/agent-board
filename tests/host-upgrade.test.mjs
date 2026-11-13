import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { agents, apply, assertBlocks, assertRepeat, assertWaiting, board, checked, cleanup, fixture, questionOf, repeatApply, report, repoRoot, run, setup, setupOrder, tempFolder } from './e2e/lib/host-journey.mjs'

// The upgrade journey of #466. It reads the 0.24.0 files from the release tag, so it stays in
// the board group, whose CI job fetches the tags; the other host journeys are in tests/e2e/.
after(cleanup)

test('an upgrade from 0.24.0 in the same home keeps every listed agent\'s card and reports no change on a second apply', async t => {
  const tag = 'agent-board--v0.24.0'
  const available = spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${tag}^{commit}`], { encoding: 'utf8', windowsHide: true })
  assert.ifError(available.error)
  if (available.status !== 0) {
    assert.ok(!process.env.CI, `${tag} is missing in CI; the board job fetches the whole history with its tags`)
    return t.skip(`${tag} is missing locally; run git fetch --tags to run this journey`)
  }
  const oldFolder = tempFolder()
  const archive = spawnSync('git', ['-C', repoRoot, 'archive', '--format=tar', tag, 'scripts', 'hooks', 'bin', 'package.json'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  checked(archive, 'archive 0.24.0')
  checked(spawnSync('tar', ['-x', '-f', '-'], { cwd: oldFolder, input: archive.stdout, encoding: 'utf8', windowsHide: true }), 'extract 0.24.0')
  const f = fixture(Object.values(agents).filter(agent => agent.id).map(agent => agent.sign))
  await apply(f, setupOrder, oldFolder)
  for (const id of setupOrder) await report(f, id, 'waiting')
  const plan = await apply(f, setupOrder)
  assert.ok(plan.plans.some(target => target.changes.some(change => resolve(change.file) === resolve(f.script) && change.action === 'update')), 'upgrade updates the shared board script')
  const text = await board(f, '--chat')
  for (const id of setupOrder) assertWaiting(text, id)
  await report(f, 'codex', 'waiting')
  assertBlocks(f, setupOrder)
  assertRepeat(await repeatApply(f), setupOrder)
})

// The upgrade journey of #877: 0.24.3 renames the board command to /agent-board and rewrites every
// agent's command and skill files, and the owner's rule is that an update never breaks the board.
// The home is set up by the 0.24.2 tag's own setup, then upgraded by this tree's setup.
const OLD = 'agent-board--v0.24.2'
const upgradeIds = ['codex', 'opencode', 'antigravity']
const oldCommands = { opencode: '.config/opencode/commands/board.md' }
const newCommands = { opencode: '.config/opencode/commands/agent-board.md' }
// Codex and Antigravity have no /board file: their skill is what ran --serve.
const skills = { codex: '.agents/skills/agent-board/SKILL.md', antigravity: '.gemini/config/skills/agent-board/SKILL.md' }
const handKept = ['## Quarterly work', '### Prepare the quarterly report', '- [x] Collect the numbers', '- [ ] Write the summary', '- [?] Send it to Dana or to the whole team?']

const oldRelease = t => {
  const available = spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${OLD}^{commit}`], { encoding: 'utf8', windowsHide: true })
  assert.ifError(available.error)
  if (available.status !== 0) {
    assert.ok(!process.env.CI, `${OLD} is missing in CI; the board job fetches the whole history with its tags`)
    t.skip(`${OLD} is missing locally; run git fetch --tags to run this journey`)
    return null
  }
  const folder = tempFolder()
  const archive = spawnSync('git', ['-C', repoRoot, 'archive', '--format=tar', OLD, 'scripts', 'hooks', 'bin', 'package.json'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  checked(archive, 'archive 0.24.2')
  checked(spawnSync('tar', ['-x', '-f', '-'], { cwd: folder, input: archive.stdout, encoding: 'utf8', windowsHide: true }), 'extract 0.24.2')
  return folder
}

// A home that 0.24.2's setup made for Codex, OpenCode and Antigravity (Claude Code gets
// its /agent-board command from the plugin, so setup writes nothing for it), with one hand-kept task
// that asks a question and one waiting turn each from Codex and Antigravity.
const oldHome = async old => {
  const f = fixture(['.claude', '.codex', '.gemini/antigravity-cli', '.config/opencode'])
  await apply(f, upgradeIds, old)
  for (const id of ['codex', 'antigravity']) await report(f, id, 'waiting')
  appendFileSync(f.progress, `\n${handKept.join('\n')}\n`)
  return f
}

const read = (f, file) => readFileSync(join(f.home, file), 'utf8')
// The flags the first command line in a file passes to the board script.
const flagsIn = (f, file) => {
  const text = read(f, file)
  const at = text.indexOf(f.script)
  assert.ok(at >= 0, `${file} runs the board script`)
  assert.ok(text.slice(Math.max(0, at - 400), at).includes(process.execPath), `${file} runs it with node`)
  return /^["']?((?: --[a-z-]+)*)/.exec(text.slice(at + f.script.length))[1].split(' ').filter(Boolean)
}

const closePage = url => new Promise(done => {
  const address = new URL(url)
  const req = request({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/api/close', headers: { host: address.host, 'x-board-token': address.searchParams.get('t'), 'content-type': 'application/json' } }, res => res.resume().on('end', done))
  req.on('error', done)
  req.end('{}')
})

// Runs the board script the way a command file does and loads the page it prints, then closes it.
const openPage = async (f, script, flags, label) => {
  const stdout = checked(await run(f, [script, ...flags], { timeoutMs: 60000 }), `${label}: board ${flags.join(' ')}`)
  const url = /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/.exec(stdout)?.[0]
  assert.ok(url, `${label}: the output carries the page address\n${stdout}`)
  try {
    const response = await fetch(url)
    assert.equal(response.status, 200, `${label}: the page loads`)
    await response.text()
    const address = new URL(url)
    const board = await fetch(`${address.origin}/api/board`, { headers: { 'x-board-token': address.searchParams.get('t') } })
    assert.equal(board.status, 200, `${label}: the page's board data loads`)
    const data = JSON.stringify(await board.json())
    assert.ok(data.includes('Prepare the quarterly report'), `${label}: the page shows the hand-kept task`)
    assert.ok(data.includes('Send it to Dana'), `${label}: the page shows its question`)
    for (const id of ['codex', 'antigravity']) assert.ok(data.includes(questionOf(id)), `${label}: the page shows the ${id} question that was waiting`)
  } finally { await closePage(url) }
}

test('0.24.2 to this release: the old /board files and skills still open the page, setup then retires them, and nothing the person kept is lost (#877)', async t => {
  const old = oldRelease(t)
  if (!old) return
  const f = await oldHome(old)
  // What 0.24.2 wrote: every file that opens the board runs it with --serve, and each /board file exists.
  for (const file of [...Object.values(oldCommands), ...Object.values(skills)]) assert.deepEqual(flagsIn(f, file), ['--serve'], `${file}: 0.24.2 runs --serve`)
  const seeded = readFileSync(f.progress, 'utf8')
  for (const line of handKept) assert.ok(seeded.includes(line), `seeded: ${line}`)

  // The board script of this release, before setup has rewritten a command file: that is the state after
  // the plugin or package updates and before the person runs setup. Every old command line still opens the page.
  const ahead = fixture(['.claude', '.codex', '.gemini/antigravity-cli', '.config/opencode'])
  await apply(ahead, upgradeIds)
  for (const file of [...Object.values(oldCommands), ...Object.values(skills)]) await openPage(f, ahead.script, flagsIn(f, file), `old ${file}`)

  const before = readFileSync(f.progress, 'utf8')
  const plan = await apply(f, upgradeIds)
  assert.equal(readFileSync(f.progress, 'utf8'), before, 'setup leaves progress.md as it was')
  const removed = plan.plans.flatMap(target => target.changes.filter(change => change.action === 'remove')).map(change => resolve(change.file)).sort()
  assert.deepEqual(removed, Object.values(oldCommands).map(file => resolve(join(f.home, file))).sort(), 'setup retires exactly the old /board file')
  for (const file of Object.values(oldCommands)) assert.ok(!existsSync(join(f.home, file)), `${file} is gone`)
  assert.ok(plan.plans.every(target => !target.keptEdited?.length), 'nothing edited was kept, so nothing is named')

  // The new files open the page with no flag, and no file setup wrote still asks for --serve.
  for (const file of [...Object.values(newCommands), ...Object.values(skills)]) {
    assert.deepEqual(flagsIn(f, file), [], `${file}: the new command runs no flag`)
    assert.ok(!read(f, file).includes('--serve'), `${file}: no --serve left`)
    await openPage(f, f.script, flagsIn(f, file), `new ${file}`)
  }
  // --serve itself keeps working for anything that still calls it.
  await openPage(f, f.script, ['--serve'], 'a leftover --serve')

  const text = readFileSync(f.progress, 'utf8')
  for (const line of seeded.split(/\r?\n/).filter(line => line.trim() !== '' && !line.trimStart().startsWith('<!--'))) assert.ok(text.includes(line), `progress.md keeps: ${line}`)
  assertBlocks(f, ['codex', 'antigravity'])
  assertRepeat(await repeatApply(f), upgradeIds)
})

test("an upgrade from 0.24.2 keeps a /board file the person changed and names it in setup's output (#877)", async t => {
  const old = oldRelease(t)
  if (!old) return
  const f = await oldHome(old)
  const edited = join(f.home, oldCommands.opencode)
  appendFileSync(edited, '\n# my own note\n')
  const plan = await apply(f, upgradeIds)
  assert.ok(existsSync(edited), 'the edited /board file stays')
  assert.ok(readFileSync(edited, 'utf8').endsWith('# my own note\n'), 'and keeps its edit')
  const opencode = plan.plans.find(target => target.agent === 'opencode')
  assert.deepEqual(opencode.keptEdited.map(file => resolve(file)), [resolve(edited)], 'the plan names the kept file')
  assert.deepEqual(opencode.conflicts, [])
  const output = await setup(f, ['--apply'])
  assert.ok(output.includes('your edited old /board command; setup leaves it; the command is now /agent-board'), `setup's output names it\n${output}`)
  assert.ok(output.includes('board.md'), output)
  assert.ok(existsSync(join(f.home, newCommands.opencode)), 'the new /agent-board command is there beside it')
  await openPage(f, f.script, flagsIn(f, newCommands.opencode), 'new opencode command')
})
