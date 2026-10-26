import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type HookRecoveryOwner = { token: string; previous: string; pid: number; created: number }

// Called only while the selected board's existing native write lock is held.
// A second recovery gate would itself need crash recovery and can strand every job.
export const claimHookRecovery = (root: string, progress: string, request: HookRecoveryOwner): boolean => {
  const now = Date.now()
  if (!/^[a-f0-9]{32}$/.test(request.token) || !/^[a-f0-9]{32}$/.test(request.previous)
    || !Number.isSafeInteger(request.pid) || request.pid <= 0 || !Number.isSafeInteger(request.created)
    || request.created < 0 || request.created > now + 1000 || now - request.created > 8000) throw new Error('INVALID_RECOVERY_OWNER')
  const selected = resolve(progress)
  const file = join(root, `hook-recovery-${createHash('sha256').update(process.platform === 'win32' ? selected.toLowerCase() : selected).digest('hex')}.json`)
  let fd: number | undefined, temporary: string | undefined
  try {
    const before = lstatSync(file)
    if (!before.isFile() || before.nlink !== 1 || before.size > 2048) throw new Error('UNSAFE_RECOVERY_CLAIM')
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const actual = fstatSync(fd)
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino || actual.size > 2048) throw new Error('UNSAFE_RECOVERY_CLAIM')
    const bytes = Buffer.alloc(2049)
    const count = readSync(fd, bytes, 0, bytes.length, 0)
    if (count > 2048 || count !== actual.size) throw new Error('RECOVERY_CLAIM_CHANGED')
    const text = bytes.subarray(0, count).toString('utf8')
    const owner = JSON.parse(text) as { version?: unknown; pid?: unknown; token?: unknown; created?: unknown }
    if (owner.version !== 1 || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.token !== 'string' || !/^[a-f0-9]{32}$/.test(owner.token)
      || typeof owner.created !== 'number' || !Number.isSafeInteger(owner.created) || owner.created < 0 || owner.created > now + 60000) throw new Error('INVALID_RECOVERY_CLAIM')
    if (owner.token === request.token && owner.pid === request.pid && owner.created === request.created) return true
    if (owner.token !== request.previous) return false
    if (request.previous === request.token) {
      if (owner.created !== request.created) return false
    } else {
      if (now - owner.created < 30000) return false
      let isDead = false
      try { process.kill(owner.pid, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('RECOVERY_OWNER_UNVERIFIED')
        isDead = true
      }
      if (!isDead) return false
    }
    const current = lstatSync(file)
    const checked = Buffer.alloc(2049)
    const checkedCount = readSync(fd, checked, 0, checked.length, 0)
    if (!current.isFile() || current.nlink !== 1 || current.dev !== actual.dev || current.ino !== actual.ino
      || checkedCount !== count || !checked.subarray(0, checkedCount).equals(bytes.subarray(0, count))) throw new Error('RECOVERY_CLAIM_CHANGED')
    closeSync(fd)
    fd = undefined
    temporary = `${file}.${process.pid}.${request.token}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, pid: request.pid, token: request.token, created: request.created }), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
    temporary = undefined
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (temporary !== undefined) { try { unlinkSync(temporary) } catch {} }
  }
}
