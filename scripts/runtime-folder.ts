import { execFileSync } from 'node:child_process'
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import type { BigIntStats, Stats } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export class RuntimeFolderError extends Error {
  constructor() { super('BOARD_RUNTIME_PRIVATE') }
}

type Account = { sid: string; aliases: Record<string, string> }
let account: Account | undefined
const system = (): string => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const options = { encoding: 'utf8' as const, windowsHide: true, timeout: 10_000, stdio: 'pipe' as const }
// The one PowerShell start of a page start is the slow one: 2-10 s on a busy computer, and longer
// when it is the first since a restart. This only stops a start that hangs; icacls and whoami keep 10 s.
const powerShellOptions = { ...options, timeout: 30_000 }

const currentAccount = (): Account => {
  if (account !== undefined) return account
  const output = execFileSync(join(system(), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], options)
  const row = /"([^"\\]*)\\[^"]*","(S-\d+(?:-\d+)+)"\s*$/.exec(output)
  const domain = row?.[1], sid = row?.[2]
  if (domain === undefined || sid === undefined) throw new RuntimeFolderError()
  const computer = process.env.COMPUTERNAME || hostname().slice(0, 15)
  const base = /^(S-1-5-21-\d+-\d+-\d+)-\d+$/.exec(sid)?.[1]
  const aliases: Record<string, string> = base !== undefined && domain.toLowerCase() === computer.toLowerCase() ? { LA: `${base}-500`, LG: `${base}-501` } : {}
  return (account = { sid, aliases })
}

// Owner, group and access list of each path, one PowerShell start for all of them, in order. The
// first path must be readable, or the call fails. Each later path is an address file that may be
// removed by an old page's shutdown, or be unreadable for this account, while the call runs: its
// line is then '-', which no check accepts, and the later read of that file decides, as it did
// when each file had a call of its own.
const acls = (files: string[]): string[] => {
  const lines = execFileSync(join(system(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; $PSModuleAutoLoadingPreference = 'None'; "
      + "$sections = [System.Security.AccessControl.AccessControlSections]'Access,Owner,Group'; "
      // A Windows path cannot hold a pipe, so it can separate the paths.
      + "$targets = $env:AGENT_BOARD_RUNTIME_ACL_PATH.Split('|'); "
      + 'for ($at = 0; $at -lt $targets.Length; $at++) { $target = $targets[$at]; '
      + 'try { $security = if ([System.IO.Directory]::Exists($target)) { [System.IO.Directory]::GetAccessControl($target, $sections) } else { [System.IO.File]::GetAccessControl($target, $sections) }; '
      + '$security.GetSecurityDescriptorSddlForm($sections) } '
      + "catch { if ($at -eq 0) { throw }; '-' } }",
  ], {
    ...powerShellOptions,
    // Fresh isolated profiles need no command discovery, and a PowerShell parent's module
    // path must not select an incompatible or user-supplied security implementation.
    env: { ...process.env, PSModulePath: join(system(), 'WindowsPowerShell', 'v1.0', 'Modules'), AGENT_BOARD_RUNTIME_ACL_PATH: files.map(file => resolve(file)).join('|') },
  }).trim().split(/\r?\n/).map(line => line.trim())
  if (lines.length !== files.length) throw new RuntimeFolderError()
  return lines
}

const acl = (file: string): string => acls([file])[0] ?? ''

// The access list alone as SDDL, without starting PowerShell: icacls saves it to a file in a
// folder made inside the file's own folder. It carries no owner, so it only follows a call that
// set the owner. The folder is the private runtime folder, not %TEMP%, which grants other
// accounts on this computer modify rights: one of them could rewrite or lock the saved list
// between its write and its read.
const dacl = (file: string): string => {
  const holder = mkdtempSync(join(dirname(resolve(file)), '.acl-'))
  const saved = join(holder, 'dacl.txt')
  try {
    execFileSync(join(system(), 'icacls.exe'), [resolve(file), '/save', saved, '/L'], options)
    // UTF-16: the name of the path on the first line, its access list on the second.
    const lines = readFileSync(saved).toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line !== '')
    const found = lines[1]
    if (lines.length !== 2 || found === undefined || !found.startsWith('D:')) throw new RuntimeFolderError()
    return found
  } finally {
    // unlink and rmdir take away a link itself and never follow it. A folder left behind holds only
    // a list of accounts; it is not worth failing the start.
    try { unlinkSync(saved) } catch {}
    try { rmdirSync(holder) } catch {}
  }
}

// A sole full-control grant is deliberate: accepting a second principal or an inherited
// folder grant would put a bearer token back within reach of a sandbox account.
const isSoleGrant = (controls: string, flags: string, trustee: string, sid: string, isDirectory: boolean, aliases: Record<string, string>): boolean =>
  (trustee === sid || aliases[trustee] === sid) && (isDirectory ? controls.includes('P') && flags === 'OICI' : flags === '' || flags === 'ID')

export const isPrivateRuntimeSddl = (sddl: string, sid: string, isDirectory: boolean, aliases: Record<string, string> = {}): boolean => {
  if (!/^S-\d+(?:-\d+)+$/.test(sid)) return false
  const parts = /^O:([^:]+?)(?:G:[^:]*)?D:([A-Z]*)(\(A;([A-Z]*);FA;;;([^;()]+)\))$/.exec(sddl)
  if (parts === null) return false
  const owner = parts[1] ?? '', controls = parts[2] ?? '', flags = parts[4] ?? '', trustee = parts[5] ?? ''
  return (owner === sid || aliases[owner] === sid) && isSoleGrant(controls, flags, trustee, sid, isDirectory, aliases)
}

// The same rule for an access list read without its owner (`D:` and what follows).
export const isPrivateRuntimeDacl = (list: string, sid: string, isDirectory: boolean, aliases: Record<string, string> = {}): boolean => {
  if (!/^S-\d+(?:-\d+)+$/.test(sid)) return false
  const parts = /^D:([A-Z]*)(\(A;([A-Z]*);FA;;;([^;()]+)\))$/.exec(list)
  if (parts === null) return false
  return isSoleGrant(parts[1] ?? '', parts[3] ?? '', parts[4] ?? '', sid, isDirectory, aliases)
}

const isPlain = (file: string, isDirectory: boolean): boolean => {
  const found = lstatSync(file)
  return !found.isSymbolicLink() && (isDirectory ? found.isDirectory() : found.isFile() && found.nlink === 1)
}

const plainParents = (dir: string): void => {
  let current = resolve(dir)
  for (;;) {
    try { if (!isPlain(current, true)) throw new RuntimeFolderError() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

const sameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs

// What this process has read in full, so a later step does not start PowerShell for it again.
// A folder is known by the identity of the plain folder that was checked; an address file by
// its stat when its owner and access list were read. Anything that differs is checked in full.
const key = (path: string): string => resolve(path).toLowerCase()
const checkedFolders = new Map<string, string>()
const checkedFiles = new Map<string, Stats>()
let latest: { path: string; identity: string } | undefined

// Which plain folder is at the path: device, file number and creation time, so a folder that
// was deleted and made again under a reused file number is not taken for the checked one.
const identityOf = (dir: string): string | undefined => {
  try {
    const found: BigIntStats = lstatSync(dir, { bigint: true })
    return found.isDirectory() && !found.isSymbolicLink() ? `${found.dev}:${found.ino}:${found.birthtimeNs}` : undefined
  } catch { return undefined }
}

const isCheckedFolder = (dir: string): boolean => {
  const identity = identityOf(dir)
  return identity !== undefined && checkedFolders.get(key(dir)) === identity
}

const remember = (root: string, identity: string): void => {
  checkedFolders.set(key(root), identity)
  latest = { path: root, identity }
}

// The page's server is started by a process that has already checked the folder. It hands over
// the folder's identity in this variable and the server checks only that it is still the same
// plain folder: once the folder's list is the sole full-control grant of this account, only this
// account can change it. Without the variable, or with another folder, the server checks in full.
export const RUNTIME_FOLDER_ENV = 'AGENT_BOARD_RUNTIME_FOLDER'

export const runtimeFolderHandoff = (): string | undefined => latest === undefined ? undefined : JSON.stringify(latest)

const takeHandoff = (): { path: string; identity: string } | undefined => {
  const value = process.env[RUNTIME_FOLDER_ENV]
  if (value === undefined) return undefined
  // Meant for this process alone, not for programs it starts.
  delete process.env[RUNTIME_FOLDER_ENV]
  try {
    const found = JSON.parse(value) as { path?: unknown; identity?: unknown } | null
    return typeof found?.path === 'string' && typeof found.identity === 'string' ? { path: found.path, identity: found.identity } : undefined
  } catch { return undefined }
}

// `names` are address files that may already sit in the folder: their owner and access list
// are read in the same PowerShell start, so reading one later needs none of its own.
export const privateRuntimeFolder = (dir: string, names: string[] = []): string => {
  try {
    const root = resolve(dir)
    plainParents(root)
    const handed = takeHandoff()
    if (handed !== undefined && handed.path === root && isPlain(root, true) && identityOf(root) === handed.identity) {
      remember(root, handed.identity)
      return root
    }
    mkdirSync(root, { recursive: true, mode: 0o700 })
    plainParents(root)
    if (!isPlain(root, true)) throw new RuntimeFolderError()
    const identity = identityOf(root)
    if (identity === undefined) throw new RuntimeFolderError()
    const { sid, aliases: own } = currentAccount()
    const icacls = join(system(), 'icacls.exe')
    // As in the message hub, /L never changes the destination of a planted link.
    execFileSync(icacls, [root, '/setowner', `*${sid}`, '/L'], options)
    execFileSync(icacls, [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/L'], options)
    // A file that is gone or not a plain file by now is left to the later read, which refuses it.
    const present: string[] = []
    const stamps: Stats[] = []
    for (const name of names) {
      const file = join(root, name)
      try {
        const found = lstatSync(file)
        if (found.isFile() && !found.isSymbolicLink() && found.nlink === 1) { present.push(file); stamps.push(found) }
      } catch {}
    }
    const read = acls([root, ...present])
    let descriptor = read[0] ?? ''
    const aliases: Record<string, string> = {
      BA: 'S-1-5-32-544', BU: 'S-1-5-32-545', BG: 'S-1-5-32-546',
      SY: 'S-1-5-18', LS: 'S-1-5-19', NS: 'S-1-5-20',
      WD: 'S-1-1-0', AU: 'S-1-5-11', IU: 'S-1-5-4',
      CO: 'S-1-3-0', CG: 'S-1-3-1', OW: 'S-1-3-4', ...own,
    }
    // Replacing this account's grant does not remove another explicit grant.
    let hasRemoved = false
    for (const match of descriptor.matchAll(/\([^()]*;;;([^;()]+)\)/g)) {
      const trustee = match[1] ?? ''
      const other = /^S-\d+(?:-\d+)+$/.test(trustee) ? trustee : aliases[trustee]
      if (other === undefined) throw new RuntimeFolderError()
      if (other === sid) continue
      execFileSync(icacls, [root, '/remove', `*${other}`, '/L'], options)
      hasRemoved = true
    }
    if (hasRemoved) descriptor = acl(root)
    if (!isPlain(root, true) || identityOf(root) !== identity || !isPrivateRuntimeSddl(descriptor, sid, true, own)) throw new RuntimeFolderError()
    // A file that passes is not read in full again while it stays as it was; one that does not
    // pass is left out, and reading it later checks it in full and refuses it.
    present.forEach((file, at) => {
      const stamp = stamps[at]
      try {
        if (stamp !== undefined && isPrivateRuntimeSddl(read[at + 1] ?? '', sid, false, own) && sameFile(stamp, lstatSync(file))) checkedFiles.set(key(file), stamp)
      } catch {}
    })
    remember(root, identity)
    return root
  } catch { throw new RuntimeFolderError() }
}

// Check the existing file's owner and DACL before any token is read. The descriptor must
// still name the same single-link plain file after the read, including at a legacy location.
export const readPrivateRuntimeFile = (file: string): { text: string; stamp: Stats } | null => {
  let fd: number | undefined
  try {
    const before = lstatSync(file)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 16_384) return null
    const { sid, aliases } = currentAccount()
    const known = checkedFiles.get(key(file))
    // The owner of a file seen unchanged since it was read in full is still that owner; its
    // access list is read again, which needs no PowerShell.
    const isPrivate = known !== undefined && sameFile(known, before)
      ? isPrivateRuntimeDacl(dacl(file), sid, false, aliases)
      : isPrivateRuntimeSddl(acl(file), sid, false, aliases)
    if (!isPrivate) return null
    fd = openSync(file, 'r')
    if (!sameFile(before, fstatSync(fd))) return null
    const text = readFileSync(fd, 'utf8')
    if (!isPlain(file, false) || !sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(file))) return null
    return { text, stamp: before }
  } catch { return null }
  finally { if (fd !== undefined) closeSync(fd) }
}

export const writePrivateRuntimeFile = (file: string, text: string): void => {
  let fd: number | undefined
  let created: Stats | undefined
  try {
    const { sid, aliases } = currentAccount()
    const folder = dirname(file)
    // The folder was checked by `privateRuntimeFolder` in this process; one that was not (a call
    // on its own) is read in full.
    if (!isCheckedFolder(folder) && (!isPlain(folder, true) || !isPrivateRuntimeSddl(acl(folder), sid, true, aliases))) throw new RuntimeFolderError()
    fd = openSync(file, 'wx', 0o600)
    created = fstatSync(fd)
    const opened = lstatSync(file)
    if (!isPlain(file, false) || opened.dev !== created.dev || opened.ino !== created.ino) throw new RuntimeFolderError()
    // An elevated token may default new-file ownership to Administrators. Only this newly
    // created empty file gets an explicit owner; existing address files are never promoted.
    // icacls fails the call when it cannot set the owner, and nothing else can change the owner
    // of a file in the folder meanwhile, so the owner needs no PowerShell read here.
    execFileSync(join(system(), 'icacls.exe'), [file, '/setowner', `*${sid}`, '/L'], options)
    // An empty file can be discarded safely if a filesystem did not inherit the private ACL.
    const protectedFile = lstatSync(file)
    if (!isPlain(file, false) || protectedFile.dev !== created.dev || protectedFile.ino !== created.ino || !isPrivateRuntimeDacl(dacl(file), sid, false, aliases)) throw new RuntimeFolderError()
    writeFileSync(fd, text)
    fsyncSync(fd)
    // Reading this file back, as the server does when it stops, then needs no PowerShell.
    checkedFiles.set(key(file), fstatSync(fd))
  } catch (error) {
    if (fd !== undefined) { closeSync(fd); fd = undefined }
    if (created !== undefined) {
      try {
        const found = lstatSync(file)
        if (found.dev === created.dev && found.ino === created.ino) unlinkSync(file)
      } catch {}
    }
    throw error
  } finally { if (fd !== undefined) closeSync(fd) }
}

// A legacy file that was accessible to other accounts or belongs to another board is never
// used to contact a page. Only an accepted private file is copied, without replacing a winner.
export const migratePrivateRuntimeFile = (source: string, target: string, accepts: (text: string) => boolean): void => {
  const previous = readPrivateRuntimeFile(source)
  if (previous === null || !accepts(previous.text)) return
  try { writePrivateRuntimeFile(target, previous.text) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw error
  }
  try {
    if (isPlain(source, false) && sameFile(previous.stamp, lstatSync(source))) unlinkSync(source)
  } catch {}
}
