import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { agents, apply, assertBlocks, assertRepeat, assertWaiting, board, checked, cleanup, fixture, questionOf, repeatApply, report, repoRoot, run, setup, setupOrder, snapshot, tempFolder } from './e2e/lib/host-journey.mjs'

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
// 0.24.2 set Gemini CLI up too; this release no longer offers it, and an upgrade takes its files away (#1327).
const oldIds = ['codex', 'opencode', 'gemini', 'antigravity']
const upgradeIds = ['codex', 'opencode', 'antigravity']
const oldCommands = { opencode: '.config/opencode/commands/board.md', gemini: '.gemini/commands/board.toml' }
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

// A home that 0.24.2's setup made for Codex, OpenCode, Gemini CLI and Antigravity (Claude Code gets
// its /agent-board command from the plugin, so setup writes nothing for it), with one hand-kept task
// that asks a question and one waiting turn each from Codex and Antigravity.
const oldHome = async old => {
  const f = fixture(['.claude', '.codex', '.gemini/antigravity-cli', '.config/opencode'])
  mkdirSync(join(f.home, '.gemini'), { recursive: true })
  writeFileSync(join(f.home, '.gemini', 'settings.json'), '{}')
  await apply(f, oldIds, old)
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
  mkdirSync(join(ahead.home, '.gemini'), { recursive: true })
  writeFileSync(join(ahead.home, '.gemini', 'settings.json'), '{}')
  await apply(ahead, upgradeIds)
  for (const file of [...Object.values(oldCommands), ...Object.values(skills)]) await openPage(f, ahead.script, flagsIn(f, file), `old ${file}`)

  const before = readFileSync(f.progress, 'utf8')
  const plan = await apply(f, upgradeIds)
  assert.equal(readFileSync(f.progress, 'utf8'), before, 'setup leaves progress.md as it was')
  const removed = plan.plans.flatMap(target => target.changes.filter(change => change.action === 'remove')).map(change => resolve(change.file)).sort()
  assert.deepEqual(removed, [resolve(join(f.home, oldCommands.opencode))], 'setup retires the old OpenCode /board file')
  // Gemini CLI is retired: its old /board file goes with the rest of what setup wrote for it.
  assert.ok(plan.retiredPlans.some(target => target.changes.some(change => change.action === 'remove' && resolve(change.file) === resolve(join(f.home, oldCommands.gemini)))), 'the Gemini plan removes its old /board file')
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

test("an upgrade from 0.24.2 keeps an OpenCode /board file the person changed and names it in setup's output (#877)", async t => {
  const old = oldRelease(t)
  if (!old) return
  const f = await oldHome(old)
  const edited = join(f.home, oldCommands.opencode)
  appendFileSync(edited, '\n# my own note\n')
  const plan = await apply(f, upgradeIds)
  assert.ok(existsSync(edited), 'the edited /board file stays')
  assert.ok(readFileSync(edited, 'utf8').endsWith('# my own note\n'), 'and keeps its edit')
  assert.ok(!existsSync(join(f.home, oldCommands.gemini)), 'the unchanged Gemini one next to it is gone')
  const opencode = plan.plans.find(target => target.agent === 'opencode')
  assert.deepEqual(opencode.keptEdited.map(file => resolve(file)), [resolve(edited)], 'the plan names the kept file')
  assert.deepEqual(opencode.conflicts, [])
  const output = await setup(f, ['--apply'])
  assert.ok(output.includes('your edited old /board command; setup leaves it; the command is now /agent-board'), `setup's output names it\n${output}`)
  assert.ok(output.includes('board.md'), output)
  assert.ok(existsSync(join(f.home, newCommands.opencode)), 'the new /agent-board command is there beside it')
  await openPage(f, f.script, flagsIn(f, newCommands.opencode), 'new opencode command')
})

// #1302: a generated file the person edited never stops an upgrade and is never overwritten.
const sharedSkill = '.agents/skills/agent-board/SKILL.md'
const hookRunner = '.agent-board/agent-board-hook.mjs'

test('an upgrade keeps an edited shared skill, writes the new one beside it, and still upgrades every agent that shares it (#1302)', async t => {
  const old = oldRelease(t)
  if (!old) return
  const f = await oldHome(old)
  const mine = '\nMy own line about the quarterly report.\n'
  appendFileSync(join(f.home, sharedSkill), mine)
  const edited = read(f, sharedSkill)
  const plan = await apply(f, upgradeIds)
  assert.equal(read(f, sharedSkill), edited, 'the edited skill stays exactly as the person left it')
  assert.ok(read(f, sharedSkill).includes('My own line about the quarterly report.'))
  const beside = `${sharedSkill}.new`
  assert.ok(existsSync(join(f.home, beside)), 'the new skill is written beside it')
  assert.ok(!read(f, beside).includes('My own line'), 'the new file is the generated text')
  assert.ok(read(f, beside).startsWith('---'), 'the new file is a whole skill')
  for (const target of plan.plans) {
    assert.deepEqual(target.conflicts, [], `${target.agent}: nothing is skipped`)
    assert.ok(!target.changes.some(change => resolve(change.file) === resolve(join(f.home, sharedSkill))), `${target.agent}: the edited skill is not written`)
  }
  assert.ok(plan.plans.some(target => target.keptText?.some(one => resolve(one.file) === resolve(join(f.home, sharedSkill)) && resolve(one.beside) === resolve(join(f.home, beside)))), 'a plan names the kept file and the file beside it')
  // The rest of the upgrade happened: the new /agent-board commands exist and the old /board ones are retired.
  for (const file of Object.values(newCommands)) assert.ok(existsSync(join(f.home, file)), `${file} is written`)
  for (const file of Object.values(oldCommands)) assert.ok(!existsSync(join(f.home, file)), `${file} is retired`)
  // Hand-kept work is untouched, and a second apply changes nothing.
  assert.ok(readFileSync(f.progress, 'utf8').includes('Prepare the quarterly report'))
  const again = await repeatApply(f)
  assertRepeat(again, upgradeIds)
  assert.equal(read(f, sharedSkill), edited, 'a second apply keeps the edit too')
  const output = await setup(f, ['--apply'])
  assert.ok(output.includes('SKILL.md'), `the output names the file\n${output}`)
  assert.ok(output.includes('SKILL.md.new'), `and the file beside it\n${output}`)
  assert.ok(!output.includes('skipped'), output)
})

test('an upgrade keeps an edited hook runner, says so, and still upgrades the rest (#1302)', async t => {
  const old = oldRelease(t)
  if (!old) return
  const f = await oldHome(old)
  appendFileSync(join(f.home, hookRunner), '\n// my own change\n')
  const edited = read(f, hookRunner)
  const boardBefore = readFileSync(f.script, 'utf8')
  const plan = await apply(f, upgradeIds)
  assert.equal(read(f, hookRunner), edited, 'the edited hook runner stays exactly as it was')
  assert.ok(!existsSync(join(f.home, `${hookRunner}.new`)), 'code a host loads gets no copy beside it')
  assert.notEqual(readFileSync(f.script, 'utf8'), boardBefore, 'the board script is still upgraded')
  for (const target of plan.plans) {
    assert.deepEqual(target.conflicts, [], `${target.agent}: nothing is skipped`)
    assert.ok(target.keptCode?.some(file => resolve(file) === resolve(join(f.home, hookRunner))), `${target.agent}: names the kept hook runner`)
  }
  assertRepeat(await repeatApply(f), upgradeIds)
  assert.equal(read(f, hookRunner), edited)
  const output = await setup(f, ['--apply'])
  assert.ok(output.includes('agent-board-hook.mjs'), `the output names it\n${output}`)
  assert.ok(output.includes('kept your copy'), `and says it kept the old file\n${output}`)
})

// #1327: Gemini CLI is retired. Antigravity keeps its files under the same ~/.gemini folder, so a removal that
// is not exact would touch them. The home below was set up by 0.24.2 for Codex, OpenCode, Gemini CLI and Antigravity.
const geminiFiles = ['.gemini/commands/board.toml', '.gemini/settings.json', '.agent-board/install-gemini.json']
const setupCodexScript = join(repoRoot, 'scripts', 'setup-codex.mjs')
const hashes = (f, prefix) => Object.fromEntries(snapshot(f.home).filter(([name, digest]) => digest !== null && name.startsWith(prefix)))
const files = f => Object.fromEntries(snapshot(f.home).filter(([, digest]) => digest !== null))

// Moves only Antigravity to this release (the helper retires nothing), so what the retirement then does to the
// home can be told apart from what the upgrade of Antigravity does.
const upgradeAntigravityOnly = async f => {
  const result = await run(f, [setupCodexScript, '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), '--lang', 'en', '--json', '--agent', 'antigravity', '--apply'], { timeoutMs: 120000 })
  checked(result, 'upgrade Antigravity alone')
}

test('an upgrade takes away the Gemini CLI files setup wrote and leaves Antigravity byte for byte as it was (#1327)', async t => {
  const old = oldRelease(t)
  if (!old) return
  const f = await oldHome(old)
  for (const file of geminiFiles) assert.ok(existsSync(join(f.home, file)), `${file}: 0.24.2 wrote it`)
  assert.ok(JSON.stringify(JSON.parse(read(f, '.gemini/settings.json')).hooks).includes('agent-board'), '0.24.2 hooked Gemini CLI')
  await upgradeAntigravityOnly(f)
  const antigravity = { ...hashes(f, '.gemini/config/'), ...hashes(f, '.gemini/antigravity-cli/'), ...hashes(f, '.agents/'), ...hashes(f, '.agent-board/install-antigravity.json') }
  assert.ok(Object.keys(antigravity).some(name => name.startsWith('.gemini/config/')), 'Antigravity has files of its own to compare')
  const everything = files(f)

  const preview = await setup(f, ['--json'])
  assert.ok(!preview.targets.includes('gemini'), 'Gemini CLI is not a target')
  assert.deepEqual(preview.retired, ['gemini'], 'the preview says Gemini CLI is being retired')
  assert.deepEqual(files(f), everything, 'a preview writes nothing')

  const plan = await setup(f, ['--apply', '--json'])
  assert.deepEqual(plan.retired, ['gemini'])
  assert.deepEqual(plan.retiredPlans[0].conflicts, [])
  // Gemini's own files are gone ...
  assert.ok(!existsSync(join(f.home, '.gemini/commands/board.toml')))
  assert.ok(!existsSync(join(f.home, '.agent-board/install-gemini.json')))
  assert.ok(!JSON.stringify(JSON.parse(read(f, '.gemini/settings.json'))).includes('agent-board'), 'the Gemini CLI hooks are out of settings.json')
  // ... and nothing else changed: every Antigravity file is the same bytes.
  const after = files(f)
  for (const [name, digest] of Object.entries(antigravity)) assert.equal(after[name], digest, `${name} is unchanged`)
  const changed = Object.keys({ ...everything, ...after }).filter(name => everything[name] !== after[name])
  // (The same run also upgrades Codex and OpenCode, which are not part of this check.)
  assert.deepEqual(changed.filter(name => (name.startsWith('.gemini/') || name.includes('antigravity') || name.startsWith('.agents/')) && !geminiFiles.includes(name)), [], 'only Gemini files changed under .gemini, and nothing of Antigravity or the shared skill')
  // A second run has nothing left to retire.
  const again = await repeatApply(f)
  assert.equal(again.plan.retired, undefined)
  assert.deepEqual(again.after, again.before)
})

test('an upgrade keeps a Gemini CLI file the person edited, names it, and removes the rest (#1327)', async t => {
  const old = oldRelease(t)
  if (!old) return
  const f = await oldHome(old)
  const edited = join(f.home, '.gemini/commands/board.toml')
  appendFileSync(edited, '\n# my own note\n')
  const text = await setup(f, ['--apply'])
  assert.ok(text.includes('Gemini CLI: no longer supported;'), text)
  assert.ok(text.includes('you edited it, so setup leaves it'), text)
  assert.ok(text.includes('board.toml'), text)
  assert.ok(existsSync(edited), 'the edited Gemini file stays')
  assert.ok(readFileSync(edited, 'utf8').endsWith('# my own note\n'), 'with its edit')
  assert.ok(!existsSync(join(f.home, '.agent-board/install-gemini.json')), 'the rest of Gemini CLI is gone')
  // The same home, as data: the plan names the kept file and skips nothing.
  const g = await oldHome(old)
  appendFileSync(join(g.home, '.gemini/commands/board.toml'), '\n# my own note\n')
  const plan = await setup(g, ['--apply', '--json'])
  assert.deepEqual(plan.retiredPlans[0].keptRetired.map(file => resolve(file)), [resolve(join(g.home, '.gemini/commands/board.toml'))])
  assert.deepEqual(plan.retiredPlans[0].conflicts, [])
  assertBlocks(f, ['codex', 'antigravity'])
})

test('remove --agent gemini takes away the Gemini CLI files and not those of Antigravity (#1327)', async t => {
  const old = oldRelease(t)
  if (!old) return
  const f = await oldHome(old)
  await upgradeAntigravityOnly(f)
  const before = hashes(f, '.gemini/config/')
  const plan = await setup(f, ['--remove', '--agent', 'gemini', '--apply', '--json'])
  assert.deepEqual(plan.targets, ['gemini'])
  assert.ok(!existsSync(join(f.home, '.gemini/commands/board.toml')))
  assert.ok(!existsSync(join(f.home, '.agent-board/install-gemini.json')))
  assert.deepEqual(hashes(f, '.gemini/config/'), before, 'Antigravity files are the same bytes')
  assert.ok(existsSync(join(f.home, '.agent-board/install-antigravity.json')))
})

// #1327: a file the record lists that this release no longer writes. The record is edited by hand here, as an
// older release would have left it, with one more file than this release writes.
const recordOf = f => join(f.home, '.agent-board', 'install-codex.json')
const sha = text => createHash('sha256').update(text).digest('hex')
const withDropped = async (hasCreatedDirs, isEdited) => {
  const f = fixture(['.codex'])
  await apply(f, ['codex'])
  const record = JSON.parse(readFileSync(recordOf(f), 'utf8'))
  const folder = join(f.home, '.codex', 'retired-by-a-release')
  const file = join(folder, 'old-hook.mjs')
  mkdirSync(folder, { recursive: true })
  writeFileSync(file, '// written by an earlier setup\n')
  record.files[file] = sha('// written by an earlier setup\n')
  if (hasCreatedDirs) record.createdDirs = [...(record.createdDirs ?? []), folder]
  else delete record.createdDirs
  writeFileSync(recordOf(f), `${JSON.stringify(record, null, 2)}\n`)
  if (isEdited) appendFileSync(file, '// mine\n')
  return { f, folder, file }
}

test('an upgrade removes a file this release no longer writes when its bytes are still the ones setup wrote, and the folder setup made for it (#1327)', async () => {
  const { f, folder, file } = await withDropped(true, false)
  const plan = await setup(f, ['--apply', '--json'])
  const codex = plan.plans[0]
  assert.deepEqual(codex.dropped, [file])
  assert.ok(codex.changes.some(change => change.action === 'remove' && change.file === file))
  assert.ok(!existsSync(file), 'the dropped file is gone')
  assert.ok(!existsSync(folder), 'and the folder the record says setup made')
  const record = JSON.parse(readFileSync(recordOf(f), 'utf8'))
  assert.ok(!Object.hasOwn(record.files, file), 'the record stops naming it')
  assert.ok(!(record.createdDirs ?? []).includes(folder), 'nor the folder')
  assert.ok((record.createdDirs ?? []).length > 0, 'it keeps the folders it recorded for the files it still writes')
  assertRepeat(await repeatApply(f), ['codex'])
})

test('an upgrade of a record with no createdDirs removes the dropped file and leaves the folder, which the record never named (#1327)', async () => {
  const { f, folder, file } = await withDropped(false, false)
  const plan = await setup(f, ['--apply', '--json'])
  assert.deepEqual(plan.plans[0].dropped, [file])
  assert.ok(!existsSync(file), 'the dropped file is gone')
  assert.ok(existsSync(folder), 'its folder stays: an older record cannot say setup made it')
  const record = JSON.parse(readFileSync(recordOf(f), 'utf8'))
  assert.ok(!Object.hasOwn(record.files, file))
  assert.ok(Object.keys(record.files).length > 0)
  assertRepeat(await repeatApply(f), ['codex'])
})

test('an upgrade keeps a dropped file the person edited, names it, and forgets it (#1327)', async () => {
  const { f, folder, file } = await withDropped(true, true)
  const plan = await setup(f, ['--apply', '--json'])
  assert.deepEqual(plan.plans[0].keptDropped, [file])
  assert.deepEqual(plan.plans[0].conflicts, [])
  assert.ok(readFileSync(file, 'utf8').endsWith('// mine\n'), 'the edited file stays as it is')
  assert.ok(existsSync(folder))
  assert.ok(!Object.hasOwn(JSON.parse(readFileSync(recordOf(f), 'utf8')).files, file), 'the record stops naming it')
  assertRepeat(await repeatApply(f), ['codex'])
})
