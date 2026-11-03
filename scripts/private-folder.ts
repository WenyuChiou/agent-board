import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'

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
    // /L acts on the folder itself: a folder swapped for a junction never passes its owner and
    // permissions on to the folder it points at.
    execFileSync(icacls, [root, '/setowner', `*${sid}`, '/L'], options)
    execFileSync(icacls, [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/L'], options)
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
      } finally { unlinkSync(saved) }
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
  } catch { throw new Error('PRIVATE_FOLDER') }
}
