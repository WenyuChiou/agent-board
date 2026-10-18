import { randomBytes, createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const processLives = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid < 1) return true
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

// A lease spans listening, publishing the address and every send. Recovery is
// serialized separately, so two starters cannot remove each other's new lease.
export const ownServer = (file: string): (() => void) | null => {
  const value = { pid: process.pid, nonce: randomBytes(16).toString('hex') }
  const create = (): boolean => {
    let fd: number
    try { fd = openSync(file, 'wx', 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    try { writeFileSync(fd, JSON.stringify(value)) } finally { closeSync(fd) }
    return true
  }
  if (!create()) {
    const recovery = file + '.recover'
    try { mkdirSync(recovery) } catch { return null }
    try {
      const old: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (old === null || typeof old !== 'object' || !('pid' in old) || typeof old.pid !== 'number' || processLives(old.pid)) return null
      unlinkSync(file)
      if (!create()) return null
    } catch { return null } finally { rmdirSync(recovery) }
  }
  return () => {
    try {
      const current = JSON.parse(readFileSync(file, 'utf8')) as typeof value
      if (current.nonce === value.nonce) unlinkSync(file)
    } catch {}
  }
}

// A reservation exists before any agent process starts. Only a confirmed
// successful exit or a confirmed failure to launch removes it; a crash or an
// interrupted command that started remains uncertain.
export const sendClaims = (directory: string) => {
  const path = (key: string): string => join(directory, createHash('sha256').update(key).digest('hex') + '.json')
  return {
    file: path,
    has: (key: string): boolean => existsSync(path(key)),
    reserve: (key: string): (() => boolean) | null => {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const file = path(key)
      const nonce = randomBytes(16).toString('hex')
      let fd: number
      try { fd = openSync(file, 'wx', 0o600) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
        throw error
      }
      try { writeFileSync(fd, JSON.stringify({ key, nonce, status: 'uncertain' })) } finally { closeSync(fd) }
      return () => {
        try {
          const saved = JSON.parse(readFileSync(file, 'utf8')) as { nonce?: string }
          if (saved.nonce !== nonce) return false
          unlinkSync(file)
          return true
        } catch { return false }
      }
    },
  }
}
