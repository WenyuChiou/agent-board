import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { folderIdentity, matchesFolderIdentity } from '../scripts/folder-identity.ts'

test('canonical folder identity matches filesystem aliases and separates same-named directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'folder-identity-'))
  try {
    const physical = join(root, 'physical'), alias = join(root, 'alias')
    mkdirSync(join(physical, 'demo'), { recursive: true })
    mkdirSync(join(root, 'other', 'demo'), { recursive: true })
    symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const real = folderIdentity(join(physical, 'demo'))
    const linked = folderIdentity(join(alias, 'demo'))
    assert.notEqual(linked.folderDigest, real.folderDigest)
    assert.equal(linked.folderCanonicalDigest, real.folderCanonicalDigest)
    assert.equal(matchesFolderIdentity(linked, real), true)
    assert.equal(matchesFolderIdentity(real, linked), true)
    assert.equal(matchesFolderIdentity(linked, folderIdentity(join(root, 'other', 'demo'))), false)
    assert.ok(!JSON.stringify([real, linked]).includes(root))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('legacy folder identity stays exact and malformed or changed canonical proof never falls back', () => {
  const old = 'a'.repeat(64), current = 'b'.repeat(64), other = 'c'.repeat(64)
  assert.equal(matchesFolderIdentity({ folderDigest: old }, { folderDigest: old, folderCanonicalDigest: current }), true)
  assert.equal(matchesFolderIdentity({ folderDigest: old }, { folderDigest: current }), false)
  for (const folderCanonicalDigest of [null, '', 'malformed', other]) {
    assert.equal(matchesFolderIdentity({ folderDigest: old, folderCanonicalDigest }, { folderDigest: old, folderCanonicalDigest: current }), false)
  }
  assert.equal(matchesFolderIdentity({ folderCanonicalDigest: current }, { folderDigest: old, folderCanonicalDigest: current }), false)
  assert.equal(matchesFolderIdentity({ folderDigest: old, folderCanonicalDigest: current }, { folderDigest: old }), false)
})

test('missing or unreadable folder identity preserves lexical compatibility without inventing alias proof', () => {
  const root = mkdtempSync(join(tmpdir(), 'folder-identity-'))
  try {
    const missing = folderIdentity(join(root, 'missing'))
    assert.equal(missing.folderCanonicalDigest, undefined)
    const denied = folderIdentity(root, process.platform, () => { throw Object.assign(new Error('synthetic'), { code: 'EACCES' }) })
    assert.equal(denied.folderCanonicalDigest, undefined)
    assert.equal(matchesFolderIdentity(denied, folderIdentity(root)), true)
    assert.equal(folderIdentity('relative/path'), undefined)
    assert.equal(folderIdentity(null), undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
