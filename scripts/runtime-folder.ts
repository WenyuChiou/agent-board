import { execFileSync } from 'node:child_process'
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export class RuntimeFolderError extends Error {
  constructor() { super('BOARD_RUNTIME_PRIVATE') }
}

type Account = { sid: string; aliases: Record<string, string> }
let account: Account | undefined
const system = (): string => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const options = { encoding: 'utf8' as const, windowsHide: true, timeout: 10_000, stdio: 'pipe' as const }

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

const acl = (file: string): string => execFileSync(join(system(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
  '-NoProfile', '-NonInteractive', '-Command',
  "$ErrorActionPreference = 'Stop'; Get-Acl -LiteralPath $env:AGENT_BOARD_RUNTIME_ACL_PATH | Select-Object -ExpandProperty Sddl",
], {
  ...options,
  // A PowerShell 7 parent's module path can select an incompatible or user-supplied ACL
  // module in Windows PowerShell. This security check uses the system's modules only.
  env: { ...process.env, PSModulePath: join(system(), 'WindowsPowerShell', 'v1.0', 'Modules'), AGENT_BOARD_RUNTIME_ACL_PATH: resolve(file) },
}).trim()

// A sole full-control grant is deliberate: accepting a second principal or an inherited
// folder grant would put a bearer token back within reach of a sandbox account.
export const isPrivateRuntimeSddl = (sddl: string, sid: string, isDirectory: boolean, aliases: Record<string, string> = {}): boolean => {
  if (!/^S-\d+(?:-\d+)+$/.test(sid)) return false
  const parts = /^O:([^:]+?)(?:G:[^:]*)?D:([A-Z]*)(\(A;([A-Z]*);FA;;;([^;()]+)\))$/.exec(sddl)
  if (parts === null) return false
  const owner = parts[1] ?? '', controls = parts[2] ?? '', flags = parts[4] ?? '', trustee = parts[5] ?? ''
  return (owner === sid || aliases[owner] === sid) && (trustee === sid || aliases[trustee] === sid)
    && (isDirectory ? controls.includes('P') && flags === 'OICI' : flags === '' || flags === 'ID')
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

export const privateRuntimeFolder = (dir: string): string => {
  try {
    const root = resolve(dir)
    plainParents(root)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    plainParents(root)
    if (!isPlain(root, true)) throw new RuntimeFolderError()
    const { sid, aliases: own } = currentAccount()
    const icacls = join(system(), 'icacls.exe')
    // As in the message hub, /L never changes the destination of a planted link.
    execFileSync(icacls, [root, '/setowner', `*${sid}`, '/L'], options)
    execFileSync(icacls, [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/L'], options)
    let descriptor = acl(root)
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
    if (!isPlain(root, true) || !isPrivateRuntimeSddl(descriptor, sid, true, own)) throw new RuntimeFolderError()
    return root
  } catch { throw new RuntimeFolderError() }
}

const sameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs

// Check the existing file's owner and DACL before any token is read. The descriptor must
// still name the same single-link plain file after the read, including at a legacy location.
export const readPrivateRuntimeFile = (file: string): { text: string; stamp: Stats } | null => {
  let fd: number | undefined
  try {
    const before = lstatSync(file)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 16_384) return null
    const { sid, aliases } = currentAccount()
    if (!isPrivateRuntimeSddl(acl(file), sid, false, aliases)) return null
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
    if (!isPlain(dirname(file), true) || !isPrivateRuntimeSddl(acl(dirname(file)), sid, true, aliases)) throw new RuntimeFolderError()
    fd = openSync(file, 'wx', 0o600)
    created = fstatSync(fd)
    const opened = lstatSync(file)
    if (!isPlain(file, false) || opened.dev !== created.dev || opened.ino !== created.ino) throw new RuntimeFolderError()
    // An elevated token may default new-file ownership to Administrators. Only this newly
    // created empty file gets an explicit owner; existing address files are never promoted.
    execFileSync(join(system(), 'icacls.exe'), [file, '/setowner', `*${sid}`, '/L'], options)
    // An empty file can be discarded safely if a filesystem did not inherit the private ACL.
    const protectedFile = lstatSync(file)
    if (!isPlain(file, false) || protectedFile.dev !== created.dev || protectedFile.ino !== created.ino || !isPrivateRuntimeSddl(acl(file), sid, false, aliases)) throw new RuntimeFolderError()
    writeFileSync(fd, text)
    fsyncSync(fd)
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
