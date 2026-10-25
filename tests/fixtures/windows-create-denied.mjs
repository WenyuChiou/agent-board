import { spawnSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import assert from 'node:assert/strict'

export const withDeniedCreation = async (folder, action) => {
  const target = resolve(folder)
  const inside = relative(resolve(tmpdir()), target)
  assert.ok(inside !== '' && !inside.startsWith('..') && !isAbsolute(inside), 'ACL fixture must be inside the isolated temporary folder')
  const info = lstatSync(target)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'ACL fixture must be a plain directory')
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const user = spawnSync(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  assert.equal(user.status, 0, user.stderr)
  const sid = user.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0]
  assert.ok(sid, 'current account SID must be available')
  const acl = (...args) => spawnSync(join(system, 'icacls.exe'), [target, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  // Only the new synthetic directory receives this deny; its files remain readable.
  const denied = acl('/deny', `*${sid}:(WD,AD)`)
  try {
    assert.equal(denied.status, 0, denied.stderr || denied.stdout)
    return await action()
  } finally {
    const restored = acl('/remove:d', `*${sid}`)
    assert.equal(restored.status, 0, restored.stderr || restored.stdout)
  }
}
