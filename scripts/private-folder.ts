import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { patiently } from './message-store-claim'
import { identityOf, MESSAGE_FOLDER_ENV } from './runtime-folder'

// This computer's NetBIOS name, which whoami prints as a local account's domain. A board started
// with a trimmed environment has no COMPUTERNAME; Windows takes the name from the host name's
// first 15 characters.
export const computerName = (env: string | undefined, host: string): string => env !== undefined && env !== '' ? env : host.slice(0, 15)

// SDDL writes this computer's own Administrator (RID 500) as LA and its Guest (RID 501) as LG. A
// local account's SID shares their domain part, so for a local account the two letters can be
// read back: run as the local Administrator, the folder's one entry reads LA, not the SID.
export const localAliases = (sid: string, domain: string, computer: string | undefined): Record<string, string> => {
  const base = /^(S-1-5-21-\d+-\d+-\d+)-\d+$/.exec(sid)?.[1]
  return base !== undefined && computer !== undefined && computer !== '' && domain.toLowerCase() === computer.toLowerCase() ? { LA: `${base}-500`, LG: `${base}-501` } : {}
}

// The account and its domain from one `whoami /user /fo csv /nh` row: "DOMAIN\user","S-…".
export const whoamiAccount = (output: string): { sid: string, domain: string } | undefined => {
  const row = /"([^"\\]*)\\[^"]*","(S-\d+(?:-\d+)+)"\s*$/.exec(output)
  const domain = row?.[1], sid = row?.[2]
  return domain === undefined || sid === undefined ? undefined : { sid, domain }
}

// The account this process runs as, from whoami's row, and the SDDL letters that name it there.
export const runningAccount = (whoami: string, env: string | undefined, host: string): { sid: string, own: Record<string, string> } | undefined => {
  const account = whoamiAccount(whoami)
  return account === undefined ? undefined : { sid: account.sid, own: localAliases(account.sid, account.domain, computerName(env, host)) }
}

export const isPrivateDacl = (sddl: string, sid: string, aliases: Record<string, string> = {}): boolean => {
  if (!/^S-\d+(?:-\d+)+$/.test(sid)) return false
  const trustee = /^D:P[A-Z]*\(A;OICI;FA;;;([^;()]+)\)$/.exec(sddl)?.[1]
  return trustee !== undefined && (trustee === sid || aliases[trustee] === sid)
}

// A virus scanner may still hold the access list icacls just saved, and then Windows refuses to
// delete it for a moment (#799). The copy holds only this folder's own entries and sits inside the
// private folder, so a copy still held after the waits is left behind rather than failing the
// start, and one already gone (a delete that was pending finished) needs nothing.
const unlinkSavedCopy = (file: string): void => {
  try { patiently(() => unlinkSync(file)) } catch (error) {
    if (!['EBUSY', 'EPERM', 'EAGAIN', 'ENOENT'].includes(String((error as NodeJS.ErrnoException).code))) throw error
  }
}

const isPresent = (file: string): boolean => {
  try {
    lstatSync(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export const privateFolder = (dir: string): void => {
  if (process.platform !== 'win32') return
  try {
    const root = resolve(dir)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (lstatSync(root).isSymbolicLink()) throw new Error('PRIVATE_FOLDER')
    const options = { encoding: 'utf8' as const, windowsHide: true, timeout: 10_000, stdio: 'pipe' as const }
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    const icacls = join(system, 'icacls.exe')
    const account = runningAccount(execFileSync(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], options), process.env.COMPUTERNAME, hostname())
    if (account === undefined) throw new Error('PRIVATE_FOLDER')
    const { sid, own } = account
    // The grant comes first: a folder that only grants Modify has no WRITE_OWNER, so taking
    // ownership first fails with access denied, while the owner may always change the list.
    // /L acts on the folder itself: a folder swapped for a junction never passes its owner and
    // permissions on to the folder it points at.
    execFileSync(icacls, [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/L'], options)
    execFileSync(icacls, [root, '/setowner', `*${sid}`, '/L'], options)
    // Another account may still hold rights here, so the saved copy gets a name it cannot guess,
    // must not exist before, and must be a plain file afterwards: icacls never writes through a
    // planted link.
    const readDacl = (): string => {
      const saved = join(root, `.acl-${randomBytes(8).toString('hex')}`)
      if (isPresent(saved)) throw new Error('PRIVATE_FOLDER')
      execFileSync(icacls, [root, '/save', saved, '/L'], options)
      try {
        const copy = lstatSync(saved)
        if (!copy.isFile() || copy.nlink !== 1) throw new Error('PRIVATE_FOLDER')
        return readFileSync(saved, 'utf16le').split(/\r?\n/).find(line => line.startsWith('D:')) ?? ''
      } finally { unlinkSavedCopy(saved) }
    }
    // Grant replacement leaves other explicit entries in place. Remove those principals
    // without enabling inheritance or requiring the backup privileges of /restore.
    const aliases: Record<string, string> = {
      BA: 'S-1-5-32-544', BU: 'S-1-5-32-545', BG: 'S-1-5-32-546',
      SY: 'S-1-5-18', LS: 'S-1-5-19', NS: 'S-1-5-20',
      WD: 'S-1-1-0', AU: 'S-1-5-11', IU: 'S-1-5-4',
      CO: 'S-1-3-0', CG: 'S-1-3-1', OW: 'S-1-3-4',
      ...own,
    }
    const sddl = readDacl()
    for (const match of sddl.matchAll(/\([^()]*;;;([^;()]+)\)/g)) {
      const trustee = match[1] ?? ''
      const other = /^S-\d+(?:-\d+)+$/.test(trustee) ? trustee : aliases[trustee]
      if (!other) throw new Error('PRIVATE_FOLDER')
      if (other === sid) continue
      execFileSync(icacls, [root, '/remove', `*${other}`, '/L'], options)
    }
    if (!isPrivateDacl(readDacl(), sid, own) || lstatSync(root).isSymbolicLink()) throw new Error('PRIVATE_FOLDER')
  } catch (error) { throw new Error('PRIVATE_FOLDER', { cause: error }) }
}

// The page's server is started by a command that has just checked its message folder. As with
// the runtime folder (RUNTIME_FOLDER_ENV), the command hands over the folder's identity in
// MESSAGE_FOLDER_ENV and the server checks only that the same plain folder is still there: once
// the folder's list is the sole full-control grant of this account, only this account can change
// it. Its parent must be private too, or another account could swap the folder between the two
// checks, so only the default message folder, inside the private runtime folder, is handed over
// (#799).

// Checks the folder in full and returns what the server is handed. Whether this call made the
// folder goes along, so a server that cannot start still removes the empty folder, as it would
// have had it made the folder itself.
export const privateFolderHandoff = (dir: string): string => {
  const root = resolve(dir)
  let isCreated = false
  try {
    isCreated = mkdirSync(root, { recursive: true, mode: 0o700 }) !== undefined
    // The folder checked must be the folder handed over, whoever else could reach its parent.
    const identity = identityOf(root)
    privateFolder(root)
    if (identity === undefined || identityOf(root) !== identity) throw new Error('PRIVATE_FOLDER')
    return JSON.stringify({ path: root, identity, isCreated })
  } catch (error) {
    // A folder made here for a check that failed is left as it was found: absent.
    if (isCreated) try { rmdirSync(root) } catch {}
    throw error
  }
}

// An access command that ran out of time says so, apart from a folder another account can open.
export const isTimeout = (error: unknown): boolean => {
  let at = error
  for (let depth = 0; depth < 4 && at instanceof Error; depth++) {
    if ((at as NodeJS.ErrnoException).code === 'ETIMEDOUT') return true
    at = at.cause
  }
  return false
}

// The handoff for this folder, taken once. A missing or malformed handoff, one for another folder,
// or a folder that is no longer the same plain folder leaves the full check to the caller.
export const takePrivateFolderHandoff = (dir: string): { isCreated: boolean } | undefined => {
  const value = process.env[MESSAGE_FOLDER_ENV]
  if (value === undefined) return undefined
  // Meant for this process alone, not for programs it starts.
  delete process.env[MESSAGE_FOLDER_ENV]
  try {
    const found = JSON.parse(value) as { path?: unknown; identity?: unknown; isCreated?: unknown } | null
    const root = resolve(dir)
    return found?.path === root && typeof found.identity === 'string' && typeof found.isCreated === 'boolean' && identityOf(root) === found.identity
      ? { isCreated: found.isCreated }
      : undefined
  } catch { return undefined }
}
