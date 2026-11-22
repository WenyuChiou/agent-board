import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { agents, apply, assertBlocks, assertRepeat, assertWaiting, board, checked, cleanup, fixture, insideHome, questionOf, repeatApply, report, repoRoot, run, setup, setupOrder, tempFolder } from './e2e/lib/host-journey.mjs'
import { spawnIsolated } from './e2e/lib/spawn.mjs'

// The upgrade journey of #466. It reads the 0.24.0 files from the release tag, so it stays in
// the board group, whose CI job fetches the tags; the other host journeys are in tests/e2e/.
after(cleanup)

// One extraction per release tag, shared by every test that upgrades from it: the old setup
// runs from the extracted folder and writes into the fixture's own home, so the folder is
// unchanged after a run and sharing it saves an extraction per test (#1303). The tag check
// still runs for each test, so a missing tag skips that test.
const sharedFolders = new Map()
const sharedRelease = (t, tag, label) => {
  const available = spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${tag}^{commit}`], { encoding: 'utf8', windowsHide: true })
  assert.ifError(available.error)
  if (available.status !== 0) {
    assert.ok(!process.env.CI, `${tag} is missing in CI; the board job fetches the whole history with its tags`)
    t.skip(`${tag} is missing locally; run git fetch --tags to run this journey`)
    return null
  }
  if (sharedFolders.has(tag)) return sharedFolders.get(tag)
  const folder = tempFolder()
  const archive = spawnSync('git', ['-C', repoRoot, 'archive', '--format=tar', tag, 'scripts', 'hooks', 'bin', 'package.json'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  checked(archive, `archive ${label}`)
  checked(spawnSync('tar', ['-x', '-f', '-'], { cwd: folder, input: archive.stdout, encoding: 'utf8', windowsHide: true }), `extract ${label}`)
  sharedFolders.set(tag, folder)
  return folder
}

test('an upgrade from 0.24.0 in the same home keeps every listed agent\'s card and reports no change on a second apply', async t => {
  const tag = 'agent-board--v0.24.0'
  const oldFolder = sharedRelease(t, tag, '0.24.0')
  if (!oldFolder) return
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

const oldRelease = (t, tag = OLD) => sharedRelease(t, tag, tag)

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

test('an upgrade from 0.24.2 keeps an edited skill, puts the new version beside it, and still upgrades every agent that shares it (#1302)', async t => {
  const old = oldRelease(t)
  if (!old) return
  const f = await oldHome(old)
  const edited = join(f.home, skills.codex), beside = `${edited}.new`
  const oldBoard = readFileSync(f.script, 'utf8')
  appendFileSync(edited, '\n# my own note\n')
  const mine = readFileSync(edited, 'utf8')

  const plan = await apply(f, upgradeIds)
  assert.equal(readFileSync(edited, 'utf8'), mine, 'the line the person added is still on disk')
  assert.ok(!readFileSync(beside, 'utf8').includes('--serve'), 'the new version is beside it')
  for (const target of plan.plans) assert.deepEqual(target.keptText, [{ file: edited, beside }], `${target.agent}: the plan names both files`)
  assert.notEqual(readFileSync(f.script, 'utf8'), oldBoard, 'the shared board script is upgraded')
  assert.ok(existsSync(join(f.home, newCommands.opencode)), 'OpenCode has its new command')
  assert.ok(!read(f, skills.antigravity).includes('--serve'), 'the skill nobody edited is upgraded')

  const output = await setup(f, ['--apply'])
  assert.ok(output.includes('you edited it, so setup leaves your copy as it is'), `setup's output says the file was kept\n${output}`)
  assert.ok(output.includes('SKILL.md.new'), `setup's output says where the new version is\n${output}`)
  await openPage(f, f.script, flagsIn(f, newCommands.opencode), 'new opencode command')
  assertRepeat(await repeatApply(f), upgradeIds)
})

test('an upgrade from 0.24.2 keeps an edited hook runner with the code and hook lines written for it, and says so (#1302)', async t => {
  const old = oldRelease(t)
  if (!old) return
  const f = await oldHome(old)
  const worker = join(f.home, '.agent-board', 'agent-board-hook.mjs')
  const held = [join(f.home, '.config', 'opencode', 'plugins', 'agent-board-local.js'), join(f.home, '.codex', 'hooks.json')]
  appendFileSync(worker, '\n// my own note\n')
  const mine = readFileSync(worker, 'utf8')
  const heldBytes = held.map(file => readFileSync(file, 'utf8'))

  const plan = await apply(f, upgradeIds)
  assert.equal(readFileSync(worker, 'utf8'), mine, 'the line the person added is still on disk')
  held.forEach((file, index) => assert.equal(readFileSync(file, 'utf8'), heldBytes[index], `${file} stays with the kept runner`))
  for (const target of plan.plans) assert.deepEqual(target.keptCode, [worker], `${target.agent}: the plan names the kept runner`)
  assert.ok(!read(f, skills.codex).includes('--serve'), 'text a host only reads still updates')

  const output = await setup(f, ['--apply'])
  assert.ok(output.includes('you edited it and the agent runs it'), `setup's output says the runner was kept\n${output}`)
  assert.ok(output.includes('agent-board-hook.mjs'), output)
  await report(f, 'codex', 'waiting')
  assertWaiting(await board(f, '--chat'), 'codex')
  assertRepeat(await repeatApply(f), upgradeIds)
})

// The same extraction of a released tag, for a release other than 0.24.2.
const taggedRelease = (t, tag, label) => sharedRelease(t, tag, label)

// What a host does with a hook line: runs its command in a shell, with the event on standard input.
const fireHook = (f, command, payload, env) => new Promise((done, fail) => {
  const child = spawnIsolated(command, [], { env: { ...f.env, ...env }, cwd: f.world.root, shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  const timer = setTimeout(() => child.kill(), 60000)
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.once('error', fail)
  child.once('close', status => { clearTimeout(timer); done({ status, stdout, stderr }) })
  child.stdin.end(JSON.stringify(payload))
})
// The first block line one agent's card has in progress.md.
const blockOf = (f, id) => readFileSync(f.progress, 'utf8').split(/\r?\n/).find(line => line.startsWith('<!-- auto session=') && line.includes(` agent=${id} `))

test('a 0.24.2 hook line still reaches the board through a kept hook runner after the upgrade (#1302)', async t => {
  const old = oldRelease(t)
  if (!old) return
  const f = await oldHome(old)
  const worker = join(f.home, '.agent-board', 'agent-board-hook.mjs'), hooks = join(f.home, '.codex', 'hooks.json')
  appendFileSync(worker, '\n// my own note\n')
  const oldBoard = readFileSync(f.script, 'utf8'), heldBytes = readFileSync(hooks, 'utf8')
  assert.ok(blockOf(f, 'codex').includes('state=waiting'), 'the Codex card waits before the hook line fires')

  await apply(f, upgradeIds)
  assert.notEqual(readFileSync(f.script, 'utf8'), oldBoard, 'the board script is the new one')
  assert.equal(readFileSync(hooks, 'utf8'), heldBytes, 'the hook lines stay as 0.24.2 wrote them')
  const command = JSON.parse(heldBytes).hooks.UserPromptSubmit[0].hooks[0].command
  const fired = await fireHook(f, command, { session_id: 'codex-journey-session', hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2', prompt: 'Synthetic follow-up' }, { CODEX_THREAD_ID: 'codex-journey-session' })
  assert.equal(fired.status, 0, `${fired.stderr}\n${fired.stdout}`)
  assert.ok(blockOf(f, 'codex').includes('state=working'), `the kept runner delivered the event to the new board script\n${blockOf(f, 'codex')}`)
})

test('an upgrade from 0.24.2 keeps an edited board script with the runner and hooks written for it (#1302)', async t => {
  const old = oldRelease(t)
  if (!old) return
  const f = await oldHome(old)
  const held = [join(f.home, '.agent-board', 'agent-board-hook.mjs'), join(f.home, '.config', 'opencode', 'plugins', 'agent-board-local.js'), join(f.home, '.codex', 'hooks.json')]
  appendFileSync(f.script, '\n// my own note\n')
  const mine = readFileSync(f.script, 'utf8')
  const heldBytes = held.map(file => readFileSync(file, 'utf8'))
  const olderSkill = read(f, skills.codex)

  const plan = await apply(f, upgradeIds)
  assert.equal(readFileSync(f.script, 'utf8'), mine, 'the line the person added is still on disk')
  held.forEach((file, index) => assert.equal(readFileSync(file, 'utf8'), heldBytes[index], `${file} stays with the kept script`))
  for (const target of plan.plans) assert.deepEqual(target.keptCode, [f.script], `${target.agent}: the plan names the kept script`)
  assert.equal(read(f, skills.codex), olderSkill, 'the skill keeps the words the kept script can answer')
  // The old /board command is the one the kept script answers, so it stays and still runs that script with the flag
  // it knows; no /agent-board command is written for a script that may not know its options (#1698). The page itself
  // is not opened here: a 0.24.2 page server does not close on request.
  assert.ok(existsSync(join(f.home, oldCommands.opencode)), 'OpenCode keeps its /board command')
  assert.deepEqual(flagsIn(f, oldCommands.opencode), ['--serve'], 'the kept /board command still runs the kept script')
  assert.equal(existsSync(join(f.home, newCommands.opencode)), false, 'no /agent-board command is written for the kept script')

  const output = await setup(f, ['--apply'])
  assert.ok(output.includes('you edited it and the agent runs it'), `setup's output says the script was kept\n${output}`)
  await report(f, 'codex', 'waiting')
  assertWaiting(await board(f, '--chat'), 'codex')
  assertRepeat(await repeatApply(f), upgradeIds)
})

test('an upgrade from 0.25.0 keeps an edited skill and an edited board script (#1302)', async t => {
  const old = taggedRelease(t, 'agent-board--v0.25.0', '0.25.0')
  if (!old) return
  const f = await oldHome(old)
  const edited = join(f.home, skills.codex), beside = `${edited}.new`
  const held = [join(f.home, '.agent-board', 'agent-board-hook.mjs'), join(f.home, '.config', 'opencode', 'plugins', 'agent-board-local.js'), join(f.home, '.codex', 'hooks.json')]
  appendFileSync(edited, '\n# my own note\n')
  appendFileSync(f.script, '\n// my own note\n')
  const mineSkill = readFileSync(edited, 'utf8'), mineScript = readFileSync(f.script, 'utf8')
  const heldBytes = held.map(file => readFileSync(file, 'utf8'))

  const plan = await apply(f, upgradeIds)
  assert.equal(readFileSync(edited, 'utf8'), mineSkill, 'the skill line the person added is still on disk')
  assert.ok(existsSync(beside), 'the new skill is beside it')
  assert.deepEqual(plan.plans.find(target => target.agent === 'codex').keptText, [{ file: edited, beside }])
  assert.equal(readFileSync(f.script, 'utf8'), mineScript, 'the board script the person edited is still on disk')
  held.forEach((file, index) => assert.equal(readFileSync(file, 'utf8'), heldBytes[index], `${file} stays with the kept script`))
  for (const target of plan.plans) assert.deepEqual(target.keptCode, [f.script], `${target.agent}: the plan names the kept script`)

  await report(f, 'codex', 'waiting')
  assertWaiting(await board(f, '--chat'), 'codex')
  assertRepeat(await repeatApply(f), upgradeIds)
})

test('an edited plugin kept beside an updated hook runner still reports (#1302)', async t => {
  const old = oldRelease(t)
  if (!old) return
  const f = await oldHome(old)
  await report(f, 'opencode', 'waiting')
  const plugin = join(f.home, '.config', 'opencode', 'plugins', 'agent-board-local.js')
  appendFileSync(plugin, '\n// my own note\n')
  const mine = readFileSync(plugin, 'utf8')
  assert.ok(blockOf(f, 'opencode').includes('state=waiting'), 'the OpenCode card waits before the plugin reports')

  await apply(f, upgradeIds)
  assert.equal(readFileSync(plugin, 'utf8'), mine, 'the edited plugin stays')
  // The call the kept plugin makes to its runner: the runner and the arguments are the ones the plugin names.
  const call = /const args = \[("(?:[^"\\]|\\.)*"), '--hook-version', '(\d+)', mode, '--agent', 'opencode', '--progress-file', ("(?:[^"\\]|\\.)*")\]/.exec(mine)
  assert.ok(call, 'the kept plugin calls its runner with this argument list')
  const result = await run(f, [JSON.parse(call[1]), '--hook-version', call[2], '--agent-status', '--agent', 'opencode', '--progress-file', JSON.parse(call[3]), ...(mine.includes('--hook-deadline') ? ['--hook-deadline', String(Date.now() + 20000)] : [])], { input: JSON.stringify({ session_id: 'opencode-journey-session', state: 'working', prompt_submitted: true }), timeoutMs: 60000 })
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  assert.ok(blockOf(f, 'opencode').includes('state=working'), `the report landed on the board\n${blockOf(f, 'opencode')}`)
})

// The upgrade journey of #1588: 0.24.3 is the release before 0.25.0, and the parity run found
// that an upgrade skips Hermes when config.yaml holds an earlier release's board hooks.
// The home is set up by the 0.24.3 tag's own setup, then upgraded by this tree's setup.
const OLD1588 = 'agent-board--v0.24.3'
const hermesEvents1588 = ['on_session_start', 'pre_llm_call', 'post_llm_call', 'on_session_end', 'post_tool_call']

const oldRelease1588 = t => sharedRelease(t, OLD1588, '0.24.3')

test('an upgrade from 0.24.3 updates a Hermes config of an earlier release whose install record no longer names its hooks (#1588)', async t => {
  const old = oldRelease1588(t)
  if (!old) return
  const f = fixture(['.hermes'])
  await apply(f, ['hermes'], old)
  const config = join(f.home, '.hermes', 'config.yaml')
  const before = readFileSync(config, 'utf8')
  assert.ok(before.includes('agent-board-hook.mjs'), '0.24.3 wrote its board hooks')
  for (const event of hermesEvents1588) assert.ok(before.includes(`  ${event}:`), `0.24.3 wrote ${event}`)
  // The parity home's install record no longer names the hooks (its marketplace entry was
  // replaced), so setup must recognise them by their released command, not by the record.
  const manifest = join(f.home, '.agent-board', 'install-hermes.json')
  const record = JSON.parse(readFileSync(manifest, 'utf8'))
  assert.ok(record.groups?.hooks, '0.24.3 recorded its hooks')
  delete record.groups.hooks
  writeFileSync(manifest, `${JSON.stringify(record, null, 2)}\n`)
  // Run this tree's setup for Hermes and read its plan without the no-conflict assertion,
  // so the failure names the conflict instead of the exit status.
  const result = await run(f, [join(repoRoot, 'scripts', 'setup-agent.mjs'), '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), '--lang', 'en', '--agent', 'hermes', '--apply', '--json'], { timeoutMs: 120000 })
  assert.ok(result.stdout.trimStart().startsWith('{'), `upgrade prints a JSON plan\n${result.stdout}\n${result.stderr}`)
  const plan = JSON.parse(result.stdout)
  assert.deepEqual(plan.targets, ['hermes'])
  assert.equal(plan.applied, true, 'the upgrade applies instead of skipping Hermes')
  const hermes = plan.plans.find(target => target.agent === 'hermes')
  assert.deepEqual(hermes.conflicts, [], 'no conflict on an earlier release\u2019s board hooks')
  const after = readFileSync(config, 'utf8')
  for (const event of hermesEvents1588) assert.ok(after.includes(`  ${event}:`), `the upgrade keeps ${event}`)
  assert.ok(after.includes('agent-board-hook.mjs'), 'the config still holds the board hooks')
  const repaired = JSON.parse(readFileSync(manifest, 'utf8'))
  assert.deepEqual(Object.keys(repaired.groups.hooks).sort(), [...hermesEvents1588].sort(), 'the upgrade re-records the hooks')
  assertRepeat(await repeatApply(f), ['hermes'])
})

// The moved Node of #1662: the same Node copied to another folder, as an upgrade from a
// second install would run it. Setup from it must keep the hook commands the first install
// wrote, so the approvals Codex bound to them stay, and the trust command from the Node on
// PATH still passes its ownership gate.
// Runs a command with a given executable in the fixture's world, like run() but not the test's Node.
const runWith = (f, executable, args, { input, timeoutMs, env }) => new Promise((resolveRun, reject) => {
  const child = spawnIsolated(executable, args, { env: env ? { ...f.env, ...env } : f.env, cwd: f.world.root, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', failure
  const timer = setTimeout(() => { failure = new Error(`timed out after ${timeoutMs} ms`); child.kill() }, timeoutMs)
  child.on('error', error => { failure = error })
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure = error })
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.once('close', status => { clearTimeout(timer); if (failure) reject(failure); else resolveRun({ status, stdout, stderr }) })
  child.stdin.end(input)
})

// Runs setup-agent.mjs with a given Node, like setup() but not the test's Node.
const setupFrom = async (f, executable, args = []) => {
  const result = await runWith(f, executable, [join(repoRoot, 'scripts', 'setup-agent.mjs'), '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), '--lang', 'en', ...args], { timeoutMs: 120000 })
  checked(result, `setup from ${executable} ${args.join(' ')}`)
  const plan = JSON.parse(result.stdout)
  for (const target of plan.plans) {
    assert.deepEqual(target.conflicts, [], `${target.agent}: no setup conflicts`)
    for (const change of target.changes) insideHome(f.home, change.file)
  }
  return plan
}

test('setup from a Node in another folder keeps the Codex hook commands and the trust command still works from the Node on PATH (#1662)', async () => {
  const f = fixture(['.codex'])
  await apply(f, ['codex'])
  const config = join(f.home, '.codex', 'hooks.json')
  const before = readFileSync(config, 'utf8')
  const parsed = JSON.parse(before)
  const events = Object.keys(parsed.hooks)
  assert.equal(events.length, 7, 'All seven Codex hook events are covered')
  for (const event of events) {
    assert.equal(parsed.hooks[event].length, 1, `${event}: the initial install has one board group`)
    assert.equal(parsed.hooks[event][0].hooks[0].type, 'command', `${event}: the board group is a command hook`)
  }
  // The same Node copied to another folder: the Node on PATH stays where it was, so the
  // commands setup wrote still run.
  const movedDir = join(f.world.root, 'moved-node')
  mkdirSync(movedDir, { recursive: true })
  const movedNode = join(movedDir, process.platform === 'win32' ? 'node.exe' : 'node')
  copyFileSync(process.execPath, movedNode)
  if (process.platform !== 'win32') chmodSync(movedNode, 0o755)
  const plan = await setupFrom(f, movedNode, ['--apply', '--json'])
  assert.deepEqual(plan.targets, ['codex'])
  assert.equal(plan.applied, true)
  assert.deepEqual(plan.plans[0].changes, [], 'the moved Node reports no changes')
  assert.equal(readFileSync(config, 'utf8'), before, 'the hook commands stay byte-identical')
  assert.ok(!readFileSync(config, 'utf8').includes(movedNode), 'no hook command names the moved Node')
  // The trust command from the Node on PATH still passes its ownership gate: with no Codex
  // binary in this home it stops at the binary, not at the install. The trust mode runs on
  // the installed board script itself, not through setup-agent.mjs, which always forwards
  // --codex-setup.
  const trust = await run(f, [f.script, '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), '--agent', 'codex', '--codex-trust', '--json'], { timeoutMs: 60000 })
  assert.notEqual(trust.status, 0)
  assert.match(trust.stderr, /CODEX_BINARY_REQUIRED/)
  assertRepeat(await repeatApply(f), ['codex'])
})

// The commands of the board's hooks in a Codex hooks.json.
const hookCommands = config => Object.values(JSON.parse(readFileSync(config, 'utf8')).hooks).flat().flatMap(group => group.hooks.map(hook => hook.command))
// A copy of the test's Node in its own folder of the fixture's world.
const copyNode = (f, folder) => {
  const node = join(f.world.root, folder, process.platform === 'win32' ? 'node.exe' : 'node')
  mkdirSync(join(f.world.root, folder), { recursive: true })
  copyFileSync(process.execPath, node)
  if (process.platform !== 'win32') chmodSync(node, 0o755)
  return node
}
const sharedSkill = f => join(f.home, '.agents', 'skills', 'agent-board', 'SKILL.md')

test('setup for Codex and OpenCode from a Node in another folder keeps the shared skill and the hook commands (#1662)', async () => {
  const f = fixture(['.codex', '.config/opencode'])
  await apply(f, ['codex', 'opencode'])
  const config = join(f.home, '.codex', 'hooks.json')
  const before = { config: readFileSync(config, 'utf8'), skill: readFileSync(sharedSkill(f), 'utf8') }
  // OpenCode has no hook commands to read a Node from, so it reads the one the shared skill names.
  const plan = await setupFrom(f, copyNode(f, 'moved-node'), ['--apply', '--json'])
  assert.deepEqual(plan.targets, ['codex', 'opencode'])
  for (const target of plan.plans) assert.deepEqual(target.changes, [], `${target.agent}: the moved Node reports no changes`)
  assert.equal(readFileSync(config, 'utf8'), before.config, 'the hook commands stay byte-identical')
  assert.equal(readFileSync(sharedSkill(f), 'utf8'), before.skill, 'the shared skill still names the Node it was set up from')
  assertRepeat(await repeatApply(f), ['codex', 'opencode'])
})

test('setup from another name for the Node it was set up from keeps the hook commands and the skill as written (#1662)', async () => {
  const f = fixture(['.codex'])
  const firstNode = copyNode(f, 'first-node')
  await setupFrom(f, firstNode, ['--apply', '--json'])
  const config = join(f.home, '.codex', 'hooks.json')
  const before = { config: readFileSync(config, 'utf8'), skill: readFileSync(sharedSkill(f), 'utf8') }
  // A hard link is the same file under another name, as process.execPath reports it.
  const linked = join(f.world.root, 'linked-node', process.platform === 'win32' ? 'node.exe' : 'node')
  mkdirSync(join(f.world.root, 'linked-node'))
  linkSync(firstNode, linked)
  const plan = await setupFrom(f, linked, ['--apply', '--json'])
  assert.deepEqual(plan.plans[0].changes, [], 'the other name reports no changes')
  assert.equal(readFileSync(config, 'utf8'), before.config, 'the hook commands keep the name they were written with')
  assert.equal(readFileSync(sharedSkill(f), 'utf8'), before.skill, 'the skill keeps the name it was written with')
  assert.ok(hookCommands(config).every(command => !command.includes(linked)), 'no hook command names the other name')
  assertRepeat(await repeatApply(f), ['codex'])
})

test('setup does not keep a file that is not Node in the place of the Node it was set up from (#1662)', async () => {
  const f = fixture(['.codex'])
  const firstNode = copyNode(f, 'first-node')
  await setupFrom(f, firstNode, ['--apply', '--json'])
  // Windows may still hold the program's file open for a moment after it ends, but it lets the name move.
  renameSync(firstNode, join(f.world.root, 'first-node', 'moved-away'))
  writeFileSync(firstNode, 'not a program\n')
  const movedNode = copyNode(f, 'moved-node')
  const plan = await setupFrom(f, movedNode, ['--apply', '--json'])
  assert.ok(plan.plans[0].changes.length > 0, 'the hooks and the skill are written again')
  const config = join(f.home, '.codex', 'hooks.json')
  assert.ok(hookCommands(config).every(command => !command.includes(firstNode)), 'no hook command starts the file that is not Node')
  assert.ok(readFileSync(sharedSkill(f), 'utf8').includes(`"${movedNode}"`), 'the skill names the Node that ran setup')
})

// The person's own line in the shared skill: setup keeps that copy as it is and reads no Node from it.
const editSkill = f => appendFileSync(sharedSkill(f), '\n# my own note\n')
// A copy of the test's Node under a name of its own, as some installers name it.
const copyNodeAs = (f, folder, name) => {
  const node = join(f.world.root, folder, process.platform === 'win32' ? `${name}.exe` : name)
  mkdirSync(join(f.world.root, folder), { recursive: true })
  copyFileSync(process.execPath, node)
  if (process.platform !== 'win32') chmodSync(node, 0o755)
  return node
}

test('setup takes no Node from a shared skill the person edited (#1662)', async () => {
  const f = fixture(['.codex'])
  const firstNode = copyNode(f, 'first-node')
  await setupFrom(f, firstNode, ['--apply', '--json'])
  // The person points the skill at a Node of their own: a working one, so only the edit keeps setup from using it.
  const personNode = copyNode(f, 'person-node')
  writeFileSync(sharedSkill(f), readFileSync(sharedSkill(f), 'utf8').replaceAll(firstNode, personNode))
  const mine = readFileSync(sharedSkill(f), 'utf8')
  const movedNode = copyNode(f, 'moved-node')
  await setupFrom(f, movedNode, ['--apply', '--json'])
  assert.equal(readFileSync(sharedSkill(f), 'utf8'), mine, 'the skill the person edited stays as it is')
  const beside = readFileSync(`${sharedSkill(f)}.new`, 'utf8')
  assert.ok(beside.includes(`"${movedNode}"`), 'the new version beside it names the Node that ran setup')
  assert.ok(!beside.includes(personNode), 'the new version does not take the Node from the edited skill')
})

test('setup for Hermes from a Node in another folder keeps the hook commands it wrote, when the shared skill no longer names that Node (#1662)', async () => {
  const f = fixture(['.hermes'])
  await setupFrom(f, copyNode(f, 'first-node'), ['--apply', '--json'])
  const config = join(f.home, '.hermes', 'config.yaml')
  const before = readFileSync(config, 'utf8')
  assert.ok(before.includes('agent-board-hook.mjs'), 'the first install wrote the board hooks')
  editSkill(f)
  const plan = await setupFrom(f, copyNode(f, 'moved-node'), ['--apply', '--json'])
  assert.ok(plan.plans[0].changes.every(change => change.file !== config), 'Hermes config is not rewritten')
  assert.equal(readFileSync(config, 'utf8'), before, 'the hook commands Hermes approved stay byte-identical')
})

test('setup from a Node in another folder keeps the hook commands it wrote for a Node with a name of its own (#1662)', async () => {
  const f = fixture(['.codex'])
  await setupFrom(f, copyNodeAs(f, 'first-node', 'node22'), ['--apply', '--json'])
  const config = join(f.home, '.codex', 'hooks.json')
  const before = { config: readFileSync(config, 'utf8'), skill: readFileSync(sharedSkill(f), 'utf8') }
  const plan = await setupFrom(f, copyNode(f, 'moved-node'), ['--apply', '--json'])
  assert.deepEqual(plan.plans[0].changes, [], 'the moved Node reports no changes')
  assert.equal(readFileSync(config, 'utf8'), before.config, 'the hook commands stay byte-identical')
  assert.equal(readFileSync(sharedSkill(f), 'utf8'), before.skill, 'the shared skill still names the Node it was set up from')
})

test('setup does not wait on a recorded program that ignores the stop signal, and keeps its commands as for a slow Node (#1662, #625)', { skip: process.platform === 'win32' && 'POSIX signals only' }, async () => {
  const f = fixture(['.codex'])
  const firstNode = copyNode(f, 'first-node')
  await setupFrom(f, firstNode, ['--apply', '--json'])
  const config = join(f.home, '.codex', 'hooks.json')
  const before = readFileSync(config, 'utf8')
  // Where the Node was, a program that ignores SIGTERM and never answers: only SIGKILL ends its probe.
  renameSync(firstNode, join(f.world.root, 'first-node', 'moved-away'))
  writeFileSync(firstNode, "#!/bin/sh\ntrap '' TERM\nexec sleep 90\n")
  chmodSync(firstNode, 0o755)
  const started = performance.now()
  await setupFrom(f, copyNode(f, 'moved-node'), ['--apply', '--json'])
  assert.ok(performance.now() - started < 60_000, 'setup ends the probe at its time limit instead of waiting for the program')
  assert.equal(readFileSync(config, 'utf8'), before, 'a probe that runs out of time keeps the commands (#625)')
})

test('on Windows setup from a Node in another folder keeps the encoded launch it wrote for a Node whose path needs one (#1662)', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const f = fixture(['.codex'])
  // Brackets are not among the characters a hook may start a program by, so the first install encodes the launch.
  await setupFrom(f, copyNode(f, 'node (first)'), ['--apply', '--json'])
  const config = join(f.home, '.codex', 'hooks.json')
  const before = readFileSync(config, 'utf8')
  assert.ok(hookCommands(config).every(command => command.startsWith('powershell.exe ')), 'the first install starts Node inside an encoded launch')
  // With the skill edited, only the encoded launch itself can say which Node the hooks start.
  editSkill(f)
  const plan = await setupFrom(f, copyNode(f, 'moved-node'), ['--apply', '--json'])
  assert.ok(plan.plans[0].changes.every(change => change.file !== config), 'the hooks are not rewritten')
  assert.equal(readFileSync(config, 'utf8'), before, 'the encoded launches stay byte-identical')
})

const codexHookSlots = async source => {
  const f = fixture(['.codex'])
  await apply(f, ['codex'], source)
  const config = join(f.home, '.codex', 'hooks.json')
  const before = JSON.parse(readFileSync(config, 'utf8'))
  const events = Object.entries(before.hooks)
  assert.equal(events.length, 7, 'All seven Codex hook events are covered')
  for (const [index, [event, groups]] of events.entries()) {
    assert.equal(groups.length, 1, `${event}: the initial install has one board group`)
    const first = { hooks: [{ type: 'command', command: `synthetic-before-${event}`, timeout: 5 }] }
    const last = { hooks: [{ type: 'command', command: `synthetic-after-${event}`, timeout: 5 }] }
    before.hooks[event] = index % 2 === 0 ? [...groups, last] : [first, ...groups, last]
  }
  const text = JSON.stringify(before, null, 2) + '\n'
  writeFileSync(config, text)
  await apply(f, ['codex'])
  assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), before, 'The board and every foreign hook keep their original slots and declarations')
  assert.equal(readFileSync(config, 'utf8'), text, 'An unchanged hook configuration stays byte-identical')
  assertRepeat(await repeatApply(f), ['codex'])
}

test('Codex setup keeps every hook group in its original slot', () => codexHookSlots(repoRoot))

test('Codex 0.25.0 upgrade keeps every hook group in its original slot', async t => {
  const old = oldRelease(t, 'agent-board--v0.25.0')
  if (old) await codexHookSlots(old)
})

// J11a of #1303: the 0.25.0 to this release upgrade, with a Codex that answers hooks/list.
// The step count is the commands the person types to finish the upgrade: the setup command
// itself, plus the trust preview and the trust apply whenever the output lists the trust step.
// A stand-in Codex that answers hooks/list from the hooks.json as it is when asked, with the
// trust state from a file the test flips. It reads hooks.json on each call, so an upgrade that
// rewrites the hooks does not stale its answers (the mock in codex-local.test.mjs reads them
// once when it is made).
const mockCodex = f => {
  const hooksJson = join(f.home, '.codex', 'hooks.json')
  const stateFile = join(f.home, 'mock-codex-state.json')
  writeFileSync(stateFile, JSON.stringify({ trusted: true }))
  const script = `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { capabilities: {} } }) + '\\n');
    } else if (msg.method === 'hooks/list') {
      const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
      const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(hooksJson)}, 'utf8'));
      const expected = Object.entries(manifest.hooks).map(([event, list]) => ({
        event: event[0].toLowerCase() + event.slice(1),
        command: list[0].hooks[0].command,
      }));
      const hooks = expected.map((item, i) => ({
        sourcePath: ${JSON.stringify(hooksJson)},
        eventName: item.event,
        command: item.command,
        key: 'hook-' + i,
        enabled: true,
        currentHash: 'sha256:' + 'a'.repeat(64),
        trustStatus: state.trusted ? 'trusted' : 'untrusted'
      }));
      process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [{ hooks, errors: [] }] } }) + '\\n');
    }
  } catch {}
});
`
  const executable = join(f.home, 'bin', 'codex-mock.js')
  mkdirSync(join(f.home, 'bin'), { recursive: true })
  writeFileSync(executable, script, { mode: 0o755 })
  return { executable, stateFile }
}

// A home the 0.25.0 tag's own setup made for Codex alone.
const oldCodexHome = async old => {
  const f = fixture(['.codex'])
  await apply(f, ['codex'], old)
  return f
}

// The commands the person types to finish the upgrade: the setup command, plus the trust
// preview and apply whenever the output lists the trust step.
const upgradeSteps = output => 1 + (output.includes('--codex-trust') ? 2 : 0)
const isolatedArgs = f => ['--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes')]

test('J11a: a 0.25.0 to this release upgrade that keeps Codex trust costs one step and names no trust command (#1303)', async t => {
  const old = taggedRelease(t, 'agent-board--v0.25.0', '0.25.0')
  if (!old) return
  const f = await oldCodexHome(old)
  const mock = mockCodex(f)
  const output = await setup(f, ['--apply', '--codex-bin', mock.executable])
  assert.ok(output.includes("Codex: the board's hooks are still trusted."), `the upgrade says trust held\n${output}`)
  assert.doesNotMatch(output, /--codex-trust/, `no trust command after an upgrade that kept trust\n${output}`)
  assert.equal(upgradeSteps(output), 1, 'one step: the upgrade command')
})

test('J11a: a 0.25.0 to this release upgrade that loses Codex trust names the lost hooks and costs three steps (#1303)', async t => {
  const old = taggedRelease(t, 'agent-board--v0.25.0', '0.25.0')
  if (!old) return
  const f = await oldCodexHome(old)
  const mock = mockCodex(f)
  // The hooks were trusted before the upgrade: the trust preview on the 0.25.0 home says so.
  const before = checked(await run(f, [f.script, ...isolatedArgs(f), '--agent', 'codex', '--codex-trust', '--json', '--codex-bin', mock.executable], { timeoutMs: 60000 }), 'trust preview before the upgrade')
  assert.equal(JSON.parse(before).changes, 0, 'the 0.25.0 hooks were trusted before the upgrade')
  // The upgrade rewrites the board's hooks and Codex no longer trusts them.
  writeFileSync(mock.stateFile, JSON.stringify({ trusted: false }))
  const output = await setup(f, ['--apply', '--codex-bin', mock.executable])
  assert.doesNotMatch(output, /still trusted/, `the upgrade does not claim trust held\n${output}`)
  assert.ok(output.includes('UserPromptSubmit'), `the question names the lost hook\n${output}`)
  assert.ok(output.includes('PostToolUse'), `the question names the new hook\n${output}`)
  assert.match(output, /--codex-trust --codex-bin/, `the trust step is the question\n${output}`)
  assert.equal(upgradeSteps(output), 3, 'three steps: the upgrade, the trust preview, the trust apply')
})

test('J11a: a 0.25.0 to this release upgrade with no Codex to ask keeps the trust step as the question (#1303)', async t => {
  const old = taggedRelease(t, 'agent-board--v0.25.0', '0.25.0')
  if (!old) return
  const f = await oldCodexHome(old)
  // This VM has a real Codex on PATH, so the upgrade runs with a PATH that has no codex on it.
  const output = checked(await run(f, [join(repoRoot, 'scripts', 'setup-agent.mjs'), ...isolatedArgs(f), '--lang', 'en', '--apply'], { timeoutMs: 120000, env: { PATH: '/usr/bin:/bin' } }), 'setup --apply')
  assert.doesNotMatch(output, /still trusted/, `unconfirmed trust is never claimed held\n${output}`)
  assert.match(output, /Codex: setup could not find Codex/, `the question names the missing Codex\n${output}`)
})

test('J11a: a 0.25.0 to this release upgrade that never had Codex trust keeps the trust step (#1303)', async t => {
  const old = taggedRelease(t, 'agent-board--v0.25.0', '0.25.0')
  if (!old) return
  const f = await oldCodexHome(old)
  const mock = mockCodex(f)
  writeFileSync(mock.stateFile, JSON.stringify({ trusted: false }))
  const output = await setup(f, ['--apply', '--codex-bin', mock.executable])
  assert.doesNotMatch(output, /still trusted/, `never-approved hooks are not claimed held\n${output}`)
  assert.match(output, /--codex-trust --codex-bin/, `the first approval stays a step the person takes\n${output}`)
  assert.equal(upgradeSteps(output), 3, 'three steps: the upgrade, the trust preview, the trust apply')
})

// J11a of #1303, round 2: the upgrade asks the Codex the person selected with --codex-dir,
// not the inherited home. This mock answers from the home its environment names, and records
// every home it was asked about, so a read-back for the wrong home is visible: the inherited
// home holds the 0.25.0 hooks of another profile, while the selected directory holds this
// release's hooks and the trust state the test flips.
const mockCodexEnv = f => {
  const homesFile = join(f.home, 'mock-codex-homes.json')
  writeFileSync(homesFile, '[]')
  const methodsFile = join(f.home, 'mock-codex-methods.json')
  writeFileSync(methodsFile, '[]')
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const home = process.env.CODEX_HOME || ${JSON.stringify(join(f.home, '.codex'))};
const hooksJson = path.join(home, 'hooks.json');
const stateFile = path.join(home, 'mock-codex-state.json');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  try {
    const msg = JSON.parse(line);
    const methods = JSON.parse(fs.readFileSync(${JSON.stringify(methodsFile)}, 'utf8'));
    methods.push(msg.method);
    fs.writeFileSync(${JSON.stringify(methodsFile)}, JSON.stringify(methods));
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { capabilities: {} } }) + '\\n');
    } else if (msg.method === 'hooks/list') {
      const homes = JSON.parse(fs.readFileSync(${JSON.stringify(homesFile)}, 'utf8'));
      homes.push(process.env.CODEX_HOME ?? '(unset)');
      fs.writeFileSync(${JSON.stringify(homesFile)}, JSON.stringify(homes));
      let trusted = false;
      try { trusted = JSON.parse(fs.readFileSync(stateFile, 'utf8')).trusted === true } catch {}
      const manifest = JSON.parse(fs.readFileSync(hooksJson, 'utf8'));
      const expected = Object.entries(manifest.hooks).map(([event, list]) => ({
        event: event[0].toLowerCase() + event.slice(1),
        command: list[0].hooks[0].command,
      }));
      const hooks = expected.map((item, i) => ({
        sourcePath: hooksJson,
        eventName: item.event,
        command: item.command,
        key: 'hook-' + i,
        enabled: true,
        currentHash: 'sha256:' + 'a'.repeat(64),
        trustStatus: trusted ? 'trusted' : 'untrusted'
      }));
      process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [{ hooks, errors: [] }] } }) + '\\n');
    }
  } catch {}
});
`
  const executable = join(f.home, 'bin', 'codex-mock.js')
  mkdirSync(join(f.home, 'bin'), { recursive: true })
  writeFileSync(executable, script, { mode: 0o755 })
  return { executable, homesFile, methodsFile }
}

// A home the 0.25.0 tag's own setup made for Codex alone, in an explicit directory
// that is not the inherited Codex home (the fixture's CODEX_HOME is f.home/.codex).
const oldCodexHomeIn = async old => {
  const f = fixture(['.codex', '.codex-alt'])
  const alt = join(f.home, '.codex-alt')
  const out = checked(await run(f, [join(old, 'scripts', 'setup-agent.mjs'), '--home', f.home, '--codex-dir', alt, '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), '--lang', 'en', '--agent', 'codex', '--apply', '--json'], { timeoutMs: 120000 }), 'old setup --apply')
  const plan = JSON.parse(out)
  assert.deepEqual(plan.targets, ['codex'], 'the old setup targets Codex alone')
  assert.equal(plan.applied, true, 'the old setup applied')
  assert.ok(existsSync(f.script), 'the old setup wrote the board script')
  return { f, alt }
}

const upgradeIn = (f, alt, mock) => run(f, [join(repoRoot, 'scripts', 'setup-agent.mjs'), '--home', f.home, '--codex-dir', alt, '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), '--lang', 'en', '--agent', 'codex', '--apply', '--codex-bin', mock.executable], { timeoutMs: 120000 })

const readBackHomes = mock => JSON.parse(readFileSync(mock.homesFile, 'utf8'))
const readBackMethods = mock => JSON.parse(readFileSync(mock.methodsFile, 'utf8'))
const assertReadBackHome = (mock, alt) => {
  const homes = readBackHomes(mock)
  assert.ok(homes.length >= 1, 'the read-back asked Codex')
  for (const home of homes) assert.equal(resolve(home), resolve(alt), `the read-back asked the selected directory, not ${home}`)
}

test('J11a: a 0.25.0 to this release upgrade in an explicit Codex directory asks that directory, not the inherited home (#1303)', async t => {
  const old = taggedRelease(t, 'agent-board--v0.25.0', '0.25.0')
  if (!old) return
  const { f, alt } = await oldCodexHomeIn(old)
  const mock = mockCodexEnv(f)
  copyFileSync(join(alt, 'hooks.json'), join(f.home, '.codex', 'hooks.json'))
  writeFileSync(join(alt, 'mock-codex-state.json'), JSON.stringify({ trusted: true }))
  writeFileSync(join(f.home, '.codex', 'mock-codex-state.json'), JSON.stringify({ trusted: false }))
  // The selected profile holds a config the preview must not touch: the read-back is
  // read-only, so it sends no approval write and the file's bytes are unchanged.
  const config = join(alt, 'config.toml')
  const configBytes = 'trust = "board"\n'
  writeFileSync(config, configBytes)
  const output = checked(await upgradeIn(f, alt, mock), 'setup --apply')
  assert.ok(output.includes("Codex: the board's hooks are still trusted."), `the upgrade says trust held\n${output}`)
  assert.doesNotMatch(output, /--codex-trust/, `no trust command after an upgrade that kept trust\n${output}`)
  assert.equal(upgradeSteps(output), 1, 'one step: the upgrade command')
  assertReadBackHome(mock, alt)
  assert.ok(readBackMethods(mock).includes('hooks/list'), 'the read-back asked Codex for its hooks')
  assert.ok(!readBackMethods(mock).includes('config/batchWrite'), 'the preview sent no approval write')
  assert.equal(readFileSync(config, 'utf8'), configBytes, 'the preview left the selected profile untouched')
})

test('J11a: a 0.25.0 to this release upgrade in an explicit Codex directory that loses trust names the directory in the trust command (#1303)', async t => {
  const old = taggedRelease(t, 'agent-board--v0.25.0', '0.25.0')
  if (!old) return
  const { f, alt } = await oldCodexHomeIn(old)
  const mock = mockCodexEnv(f)
  copyFileSync(join(alt, 'hooks.json'), join(f.home, '.codex', 'hooks.json'))
  writeFileSync(join(alt, 'mock-codex-state.json'), JSON.stringify({ trusted: false }))
  writeFileSync(join(f.home, '.codex', 'mock-codex-state.json'), JSON.stringify({ trusted: false }))
  const output = checked(await upgradeIn(f, alt, mock), 'setup --apply')
  assert.doesNotMatch(output, /still trusted/, `the upgrade does not claim trust held\n${output}`)
  assert.ok(output.includes('UserPromptSubmit'), `the question names the lost hook\n${output}`)
  assert.ok(output.includes('PostToolUse'), `the question names the new hook\n${output}`)
  assert.match(output, /--codex-trust --codex-bin/, `the trust step is the question\n${output}`)
  assert.ok(output.includes('--codex-dir') && (output.includes(`--codex-dir ${alt}`) || output.includes(`--codex-dir '${alt}'`)), `the trust command names the selected directory\n${output}`)
  assert.equal(upgradeSteps(output), 3, 'three steps: the upgrade, the trust preview, the trust apply')
  assertReadBackHome(mock, alt)
})
