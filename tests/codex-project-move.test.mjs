import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Production hook imports omit extensions because Bun bundles them.
const resolver = registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })
let modules
try {
  modules = await Promise.all([import('../hooks/codex.ts'), import('../hooks/parse.ts')])
} finally { resolver.deregister() }
const [{ putCodexBlock }, { parseProgress }] = modules

const ownerOf = session => createHash('sha256').update(`codex:${session}`).digest('hex')
const blockOf = (text, owner) => text.match(new RegExp(`<!-- auto session=${owner.slice(0, 8)} [^\\n]*owner=${owner}[^\\n]*-->[\\s\\S]*?<!-- /auto session=${owner.slice(0, 8)} -->`))?.[0]

test('a native report moves into a same-prefix peer project without moving or rewriting the peer', () => {
  // These synthetic native ids have distinct full digests with a genuine shared prefix.
  const own = 'collision-fixture-9342', peer = 'collision-fixture-29381'
  const owner = ownerOf(own), peerOwner = ownerOf(peer)
  assert.equal(owner.slice(0, 8), peerOwner.slice(0, 8))
  assert.notEqual(owner, peerOwner)
  const report = { session: own, agent: 'codex', turn: null, state: 'working', title: 'Owned task', project: 'Original project', steps: ['- [~] Keep my work'], updated: '2026-10-30T00:00:00Z' }
  const peerText = putCodexBlock('', { ...report, session: peer, title: 'Peer task', project: 'Shared project', steps: ['- [?] Keep this peer question'] }, peerOwner)
  const before = putCodexBlock(peerText, report, owner)
  const savedPeer = blockOf(before, peerOwner)
  assert.ok(savedPeer)
  const moved = putCodexBlock(before, { ...report, project: 'Shared project' }, owner, true)
  const ownedProjects = parseProgress(moved).filter(project => project.tasks.some(task => task.auto?.agent === 'codex' && task.auto.resume === own))
  assert.equal(ownedProjects.length, 1)
  assert.equal(ownedProjects[0].name, 'Shared project')
  assert.equal(blockOf(moved, peerOwner), savedPeer)
  assert.equal((moved.match(new RegExp(`owner=${owner} `, 'g')) ?? []).length, 1)
})
