import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { agents, apply, assertBlocks, assertRepeat, assertWaiting, board, checked, cleanup, fixture, repeatApply, report, repoRoot, setupOrder, tempFolder } from './e2e/lib/host-journey.mjs'

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
