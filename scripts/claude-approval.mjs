// Claude Code's PermissionRequest hook for approvals on the board (D3, #1318). Claude Code runs it
// when it is about to ask the person to allow a tool call. It asks the local board page, which
// holds the request open only while a page the board opened is in front of the person and has
// drawn it, at most 30 seconds. A press there comes back as Allow once or Deny; anything else
// (no page, no press, no board, an error) prints nothing, and Claude Code shows its own prompt.
// It does not use an address folder inside the session's working folder, and it does not ask the board
// about a request to run without the sandbox. It never answers in a mode where Claude Code would not
// ask, and it never sends updatedPermissions, updatedInput or interrupt: nothing standing is ever added.
// Before it sends anything it checks who is listening (#1651): the address file's process must hold the
// port by the system's own table, be named Node, and have an expected board script as the word directly before
// its first --serve-child. A check that refuses, fails or runs out of time ends the same way as no board: nothing
// printed, Claude Code asks.
// Plain Node with no imports outside node:, as the plugin's hooks.json runs it directly. The
// address rules follow hooks/receiver.ts, plus Windows XDG_RUNTIME_DIR ACL verification matching
// scripts/runtime-folder.ts; tests/approvals.test.mjs keeps them in step.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { Agent, request as httpRequest } from 'node:http'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// A board that will wait for a press sends its headers at once: one that has not within this
// long is hung (suspended, or a stale address whose port another program took), and the host asks.
const HEADERS_MS = 2_000
// The board answers within 30 s of the request; the rest is room for the trip.
const ASK_MS = 35_000
// hooks/hooks.json gives PermissionRequest 45 s in total; address discovery (including Windows
// whoami + PowerShell ACL checks) shares only what remains before the board's reply window.
const HOOK_MS = 45_000
// The discovery budget is a gate, not a promise about the instant the request starts. The hook reads the clock last,
// with the request's bytes already encoded, and starts no request when that read is at or past the deadline. Between
// that read and handing those bytes to node:http, the hook touches no disk, starts no process, and reads the body only
// as its length. Sending the bytes is node:http's work and is not part of the gate.
export const DISCOVERY_MS = HOOK_MS - ASK_MS
// What is left of the hook's limit after discovery and the board's 30 s press window (APPROVAL_PRESS_MS).
export const SEND_ROOM_MS = ASK_MS - 30_000
// The most the check of who is listening may add to a request. Windows needs about 0.6 s of it.
export const LOOKUP_MS = 2_000
const INPUT_MS = 5_000
const INPUT_MAX = 1024 * 1024
// The board takes a request of up to 64 KB; a tool input past this many bytes is sent with its long
// strings cut, and marked cut, so the board shows it with no button.
const SEND_MAX = 48_000
const CUT_AT = 2_000

// Claude Code asks nobody in these modes, so there is nothing to stand in for.
const QUIET_MODES = new Set(['bypassPermissions', 'dontAsk'])

// Where register.tsx's findProgressPath looks: CLAUDE_PROGRESS_FILE, else progress.md in
// CLAUDE_CONFIG_DIR, else ~/.claude/progress.md.
export const progressPath = env => {
  if (env.CLAUDE_PROGRESS_FILE) return env.CLAUDE_PROGRESS_FILE
  const config = (env.CLAUDE_CONFIG_DIR ?? '').replace(/[\\/]+$/, '')
  if (config !== '') return [config, 'progress.md'].join(config.includes('\\') ? '\\' : '/')
  const home = (env.USERPROFILE ?? env.HOME ?? homedir()).replace(/[\\/]+$/, '')
  return [home, '.claude', 'progress.md'].join(home.includes('\\') ? '\\' : '/')
}

// hooks/receiver.ts addressKey: one board however its path is spelled.
export const addressKey = path => {
  const isWin = /^[A-Za-z]:[\\/]/.test(path)
  if (!isWin && !path.startsWith('/')) return null
  const parts = []
  for (const part of (isWin ? path.slice(2) : path).split(isWin ? /[\\/]+/ : /\/+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return isWin ? `${path.slice(0, 2)}\\${parts.join('\\')}` : `/${parts.join('/')}`
}

export const addressFileName = key => `agent-board-${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}.json`

// On POSIX, an own XDG_RUNTIME_DIR holds the address file directly; on Windows, the board places
// it in <XDG_RUNTIME_DIR>\agent-board and protects its ACL via scripts/runtime-folder.ts (#1378).
export const addressFolder = (isWindows, home, runtime, isRuntimeOwn) => {
  if (home === '') return null
  const sep = isWindows ? '\\' : '/'
  const cache = [home.replace(/[\\/]+$/, ''), '.cache', 'agent-board'].join(sep)
  if (runtime === undefined || runtime === '') return cache
  if (isWindows) return isRuntimeOwn ? [runtime.replace(/[\\/]+$/, ''), 'agent-board'].join(sep) : null
  return isRuntimeOwn ? runtime : cache
}

// POSIX only: a folder only this account can reach, and in it, when named, a plain file of its own.
const isOwn = (folder, file) => {
  try {
    const dir = statSync(folder)
    const uid = process.getuid()
    if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o077) !== 0) return false
    if (file === undefined) return true
    const own = lstatSync(file)
    return own.isFile() && own.uid === uid
  } catch {
    return false
  }
}

// scripts/runtime-folder.ts isOwnFolder, the board's rule for XDG_RUNTIME_DIR: the folder itself (lstat, so
// a link to one does not count), this account's, and closed to others. The board writes to its cache folder
// otherwise, so the hook must not look in a linked runtime folder (#1368 review).
const isOwnRuntime = dir => {
  try {
    const found = lstatSync(dir)
    return found.isDirectory() && (process.getuid === undefined || (found.uid === process.getuid() && (found.mode & 0o077) === 0))
  } catch {
    return false
  }
}

export const parseAddress = (text, key) => {
  try {
    const found = JSON.parse(text)
    if (found === null || typeof found !== 'object' || typeof found.url !== 'string' || typeof found.path !== 'string') return null
    if (addressKey(found.path) !== key) return null
    const parts = /^(http:\/\/127\.0\.0\.1:\d+)\/?\?(?:[^#]*&)?t=([^&#]+)/.exec(found.url)
    return parts === null ? null : { origin: parts[1], token: decodeURIComponent(parts[2]) }
  } catch {
    return null
  }
}

const WIN_OPTIONS = { encoding: 'utf8', windowsHide: true, timeout: DISCOVERY_MS, stdio: 'pipe' }
const winSystem = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const winIsKilled = error => error?.code === 'ETIMEDOUT' || typeof error?.signal === 'string'
let winAccount

const deadlineTimeout = (deadline, now = () => performance.now()) => {
  if (deadline === undefined) return DISCOVERY_MS
  const left = Math.floor(deadline - now())
  return left > 0 ? Math.min(DISCOVERY_MS, left) : 0
}

const winCurrentAccount = (timeout = DISCOVERY_MS) => {
  if (winAccount !== undefined) return winAccount
  if (timeout <= 0) return null
  try {
    const output = execFileSync(join(winSystem(), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { ...WIN_OPTIONS, timeout })
    const row = /"([^"\\]*)\\[^"]*","(S-\d+(?:-\d+)+)"\s*$/.exec(output)
    const domain = row?.[1], sid = row?.[2]
    if (domain === undefined || sid === undefined) return null
    const computer = process.env.COMPUTERNAME || hostname().slice(0, 15)
    const base = /^(S-1-5-21-\d+-\d+-\d+)-\d+$/.exec(sid)?.[1]
    const aliases = base !== undefined && domain.toLowerCase() === computer.toLowerCase() ? { LA: `${base}-500`, LG: `${base}-501` } : {}
    return (winAccount = { sid, aliases })
  } catch {
    return null
  }
}

const winAcls = (files, timeout = DISCOVERY_MS) => {
  if (timeout <= 0) return null
  const resolved = files.map(file => resolve(file))
  const script = "$ErrorActionPreference = 'Stop'; $PSModuleAutoLoadingPreference = 'None'; "
    + "$sections = [System.Security.AccessControl.AccessControlSections]'Access,Owner,Group'; "
    + "$targets = $env:AGENT_BOARD_RUNTIME_ACL_PATH.Split('|'); "
    + 'for ($at = 0; $at -lt $targets.Length; $at++) { $target = $targets[$at]; '
    + 'try { '
    + 'if (([System.IO.File]::GetAttributes($target) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "reparse" }; '
    + 'if ([System.IO.Directory]::Exists($target)) { [System.IO.Directory]::GetAccessControl($target, $sections).GetSecurityDescriptorSddlForm($sections) } '
    + "else { $fs = [System.IO.File]::Open($target, 'Open', 'Read', 'Read'); try { $fs.GetAccessControl().GetSecurityDescriptorSddlForm($sections) } finally { $fs.Dispose() } } "
    + "} catch { if ($at -eq 0) { throw }; '-' } }"
  let output
  try {
    output = execFileSync(join(winSystem(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {
      ...WIN_OPTIONS,
      timeout,
      env: { ...process.env, PSModulePath: join(winSystem(), 'WindowsPowerShell', 'v1.0', 'Modules'), AGENT_BOARD_RUNTIME_ACL_PATH: resolved.join('|') },
    })
  } catch (error) {
    const printed = error?.stdout
    if (!winIsKilled(error) || typeof printed !== 'string' || !printed.endsWith('\n')) return null
    const lines = printed.trim().split(/\r?\n/).map(line => line.trim())
    return lines.length === files.length && lines.every(line => line !== '') ? lines : null
  }
  const lines = output.trim().split(/\r?\n/).map(line => line.trim())
  return lines.length === files.length ? lines : null
}

// scripts/runtime-folder.ts isPrivateRuntimeSddl: owner + sole full-control grant to this account.
const isSoleGrant = (controls, flags, trustee, sid, isDirectory, aliases) =>
  (trustee === sid || aliases[trustee] === sid) && (isDirectory ? controls.includes('P') && flags === 'OICI' : flags === '' || flags === 'ID')

export const isPrivateRuntimeSddl = (sddl, sid, isDirectory, aliases = {}) => {
  if (!/^S-\d+(?:-\d+)+$/.test(sid)) return false
  const parts = /^O:([^:]+?)(?:G:[^:]*)?D:([A-Z]*)(\(A;([A-Z]*);FA;;;([^;()]+)\))$/.exec(sddl)
  if (parts === null) return false
  const owner = parts[1] ?? '', controls = parts[2] ?? '', flags = parts[4] ?? '', trustee = parts[5] ?? ''
  return (owner === sid || aliases[owner] === sid) && isSoleGrant(controls, flags, trustee, sid, isDirectory, aliases)
}

const isPlain = (file, isDirectory) => {
  const found = lstatSync(file)
  return !found.isSymbolicLink() && (isDirectory ? found.isDirectory() : found.isFile() && found.nlink === 1)
}

const hasPlainParents = dir => {
  let current = resolve(dir)
  for (;;) {
    try { if (!isPlain(current, true)) return false } catch { return false }
    const parent = dirname(current)
    if (parent === current) return true
    current = parent
  }
}

const identityOf = dir => {
  try {
    const found = lstatSync(dir, { bigint: true })
    return found.isDirectory() && !found.isSymbolicLink() ? `${found.dev}:${found.ino}:${found.birthtimeNs}` : undefined
  } catch {
    return undefined
  }
}

const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs

const sameOpenFile = (folder, folderId, file, before, fd) => hasPlainParents(folder)
  && identityOf(folder) === folderId
  && isPlain(file, false)
  && sameFile(before, fstatSync(fd, { bigint: true }))
  && sameFile(before, lstatSync(file, { bigint: true }))

const isOwnWindowsRuntime = (folder, { deadline, now = () => performance.now(), probeAccount = winCurrentAccount, probeAcls = winAcls } = {}) => {
  if (deadline !== undefined && now() >= deadline) return false
  const folderBefore = identityOf(folder)
  if (folderBefore === undefined || !hasPlainParents(folder)) return false
  const accountTimeout = deadlineTimeout(deadline, now)
  if (accountTimeout <= 0) return false
  const account = probeAccount(accountTimeout)
  if (account === null) return false
  const aclTimeout = deadlineTimeout(deadline, now)
  if (aclTimeout <= 0) return false
  const sddls = probeAcls([folder], aclTimeout)
  return sddls !== null && (deadline === undefined || now() < deadline)
    && hasPlainParents(folder) && identityOf(folder) === folderBefore
    && isPrivateRuntimeSddl(sddls[0] ?? '', account.sid, true, account.aliases)
}

const readWindowsPrivateFile = (folder, file, { deadline, now = () => performance.now(), probeAccount = winCurrentAccount, probeAcls = winAcls } = {}) => {
  let fd
  try {
    if (deadline !== undefined && now() >= deadline) return null
    const folderBefore = identityOf(folder)
    if (folderBefore === undefined || !hasPlainParents(folder)) return null
    const before = lstatSync(file, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 16_384n) return null
    // Hold the address file open before spawning account/ACL probes so Windows locks its plain
    // ancestor directories against swaps during inspection, and verify path and handle stay identical.
    fd = openSync(file, 'r')
    if (!sameOpenFile(folder, folderBefore, file, before, fd)) return null
    const accountTimeout = deadlineTimeout(deadline, now)
    if (accountTimeout <= 0) return null
    const account = probeAccount(accountTimeout)
    if (account === null) return null
    const aclTimeout = deadlineTimeout(deadline, now)
    if (aclTimeout <= 0) return null
    const sddls = probeAcls([folder, file], aclTimeout)
    if (sddls === null || (deadline !== undefined && now() >= deadline)) return null
    if (!isPrivateRuntimeSddl(sddls[0] ?? '', account.sid, true, account.aliases)) return null
    if (!isPrivateRuntimeSddl(sddls[1] ?? '', account.sid, false, account.aliases)) return null
    if (!sameOpenFile(folder, folderBefore, file, before, fd)) return null
    const text = readFileSync(fd, 'utf8')
    if (!sameOpenFile(folder, folderBefore, file, before, fd)) return null
    if (deadline !== undefined && now() >= deadline) return null
    return text
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

const resolveAddressFile = (env, platform, verifyWindowsRuntime, discovery = {}) => {
  const key = addressKey(progressPath(env))
  if (key === null) return null
  const isWindows = platform === 'win32'
  const home = (env.USERPROFILE ?? env.HOME ?? '').replace(/[\\/]+$/, '')
  const runtime = env.XDG_RUNTIME_DIR
  const winRuntime = isWindows && runtime !== undefined && runtime !== ''
    ? [runtime.replace(/[\\/]+$/, ''), 'agent-board'].join('\\')
    : ''
  const isRuntimeOwn = isWindows
    ? (winRuntime !== '' && (!verifyWindowsRuntime || (process.platform === 'win32' && isOwnWindowsRuntime(winRuntime, discovery))))
    : (runtime !== undefined && runtime !== '' && isOwnRuntime(runtime))
  const folder = addressFolder(isWindows, home, runtime, isRuntimeOwn)
  if (folder === null) return null
  return { key, folder, home, file: [folder, addressFileName(key)].join(isWindows ? '\\' : '/') }
}

export const addressFile = (env = process.env, platform = process.platform, discovery = {}) => {
  const now = discovery.now ?? (() => performance.now())
  const deadline = discovery.deadline ?? (now() + (discovery.discoveryMs ?? DISCOVERY_MS))
  return resolveAddressFile(env, platform, true, { ...discovery, deadline, now })
}

// The board's process is still running: a board that stopped without removing its file leaves an
// address another program may now hold.
export const isRunning = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // Gone, or running under another account: neither is this person's board.
    return false
  }
}

// A path as the disk spells it (links followed), lower-cased on Windows, where case does not count.
const realOf = (path, platform) => {
  const real = realpathSync.native(path)
  return platform === 'win32' ? real.toLowerCase() : real
}

// The path is the folder or somewhere under it.
export const isInside = (path, folder, platform = process.platform) => {
  const sep = platform === 'win32' ? '\\' : '/'
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep)
}

// The session works in the home folder itself, the default folder of a new terminal.
const isHome = (where, home, platform) => {
  try { return typeof home === 'string' && home !== '' && where === realOf(home, platform) } catch { return false }
}

// An address folder inside the folder the session works in is one the agent can write: it could name
// a listener of its own there and answer its own prompts. A session that says nothing of its folder is
// not checked (Claude Code always sends it); one that names it badly is refused. The home folder itself
// is excepted (owner, 2026-11-12): every address folder is under it, so the check would turn the board's
// approvals off for any session started there, and SECURITY.md names what that leaves open.
const isInsideSession = (found, cwd, platform) => {
  if (cwd === undefined) return false
  if (typeof cwd !== 'string' || cwd === '') return true
  let where
  try { where = realOf(cwd, platform) } catch { where = platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd) }
  if (isHome(where, found.home, platform)) return false
  return isInside(realOf(found.folder, platform), where, platform) || isInside(realOf(found.file, platform), where, platform)
}

export const readAddress = (env, platform, cwd, discovery = {}) => {
  const now = discovery.now ?? (() => performance.now())
  const deadline = discovery.deadline ?? (now() + (discovery.discoveryMs ?? DISCOVERY_MS))
  const found = resolveAddressFile(env, platform, false, { ...discovery, deadline, now })
  if (found === null) return null
  const hasRuntime = env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR !== ''
  try {
    if (now() >= deadline) return null
    if (lstatSync(found.file).isSymbolicLink()) return null
    if (isInsideSession(found, cwd, platform)) return null
    let text
    if (platform === 'win32') {
      if (hasRuntime) {
        if (process.platform !== 'win32') return null
        text = readWindowsPrivateFile(found.folder, found.file, { ...discovery, deadline, now })
        if (text === null) return null
      } else {
        text = readFileSync(found.file, 'utf8')
      }
    } else {
      if (!isOwn(found.folder, found.file)) return null
      text = readFileSync(found.file, 'utf8')
    }
    if (now() >= deadline) return null
    const pid = JSON.parse(text)?.pid
    if (!isRunning(pid)) return null
    const parsed = parseAddress(text, found.key)
    if (parsed === null) return null
    // The port the request would go to, from the address itself and not the file's separate field.
    const port = Number(parsed.origin.slice(parsed.origin.lastIndexOf(':') + 1))
    return { ...parsed, pid, port, file: found.file, scripts: boardScripts(env, found.home, platform) }
  } catch {
    return null
  }
}

// Where a board script is installed: beside the progress file, the independent setup's folder, and the
// copy the Claude Code plugin writes into its config folder. Paths and not hashes, so a board that
// updates itself still passes.
export const boardScripts = (env, home, platform) => {
  const sep = platform === 'win32' ? '\\' : '/'
  const config = (env.CLAUDE_CONFIG_DIR ?? '').replace(/[\\/]+$/, '')
  return [
    progressPath(env).replace(/[^\\/]*$/, 'agent-board.mjs'),
    [home, '.agent-board', 'agent-board.mjs'].join(sep),
    [config !== '' ? config : [home, '.claude'].join(sep), 'agent-board.mjs'].join(sep),
  ]
}

// Files beside the address file, named for the same board: the page's off switch and what the page shows of a refusal.
export const approvalsOffFile = file => file.replace(/\.json$/, '-approvals-off.json')
export const approvalsRefusedFile = file => file.replace(/\.json$/, '-approvals-refused.json')

// The person's off switch: the file being there is the whole signal, whatever it holds. Only a file
// known to be absent leaves approvals on, so a marker the hook cannot read still stops it.
export const isSwitchedOff = file => {
  try {
    lstatSync(approvalsOffFile(file))
    return true
  } catch (error) {
    return error?.code !== 'ENOENT'
  }
}

// So approvals do not vanish without a word: the reason, and never the command. The page reads it, and
// a record that cannot be written changes nothing about the answer.
const leaveRefusal = (file, reason) => {
  const record = approvalsRefusedFile(file)
  const temp = `${record}.${process.pid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify({ at: new Date().toISOString(), reason })}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temp, record)
  } catch {
    try { unlinkSync(temp) } catch {}
  }
}

// A check that passes ends what an earlier refusal said, or the page would go on reporting a refusal that is over.
// A record that cannot be removed changes nothing about the request.
const clearRefusal = file => {
  try { unlinkSync(approvalsRefusedFile(file)) } catch {}
}

// The listening rows for a port in `netstat -ano -p TCP`. Windows translates the state column on some
// systems, so a listening row is known by its empty foreign address. 0.0.0.0 counts: it takes
// connections to 127.0.0.1 too.
export const netstatListeners = (text, port) => {
  const owners = []
  for (const line of text.split(/\r?\n/)) {
    const row = /^\s*TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)\s+0\.0\.0\.0:0\s+.*?(\d+)\s*$/i.exec(line)
    if (row !== null && Number(row[1]) === port) owners.push(Number(row[2]))
  }
  return owners
}

// The same from Linux's /proc/net/tcp: the socket numbers listening (state 0A) on the port. The kernel prints an
// address in the machine's own byte order, so 127.0.0.1 is spelled the other way round on a big-endian machine.
export const procListeners = (text, port) => {
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  const wanted = new Set([`0100007F:${hex}`, `7F000001:${hex}`, `00000000:${hex}`])
  return text.split('\n').slice(1).map(line => line.trim().split(/\s+/))
    .filter(cells => cells[3] === '0A' && wanted.has(cells[1])).map(cells => cells[9])
}

// Every listener on the port must be this process: a port shared with another could hand it the request.
export const isSoleOwner = (listeners, own) => listeners.length > 0 && listeners.every(one => own.has(one))

// How a Windows program splits its command line (CommandLineToArgvW). The first word takes no escapes.
export const splitWindowsCommand = text => {
  const words = []
  const isGap = char => char === ' ' || char === '\t'
  let at = 0
  while (at < text.length) {
    if (isGap(text[at])) { at += 1; continue }
    let word = ''
    let isQuoted = false
    while (at < text.length && (isQuoted || !isGap(text[at]))) {
      if (text[at] === '\\' && words.length > 0) {
        let end = at
        while (text[end] === '\\') end += 1
        const slashes = end - at
        if (text[end] !== '"') word += text.slice(at, end)
        else word += '\\'.repeat(slashes >> 1) + (slashes % 2 === 1 ? '"' : '')
        at = text[end] === '"' && slashes % 2 === 1 ? end + 1 : end
      } else if (text[at] === '"' && isQuoted && text[at + 1] === '"' && words.length > 0) {
        word += '"'
        at += 2
      } else if (text[at] === '"') {
        isQuoted = !isQuoted
        at += 1
      } else {
        word += text[at]
        at += 1
      }
    }
    words.push(word)
  }
  return words
}

// Two lines from the query below, each marked so that an empty value is still a line.
export const parseWindowsProcess = text => {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length !== 2 || !lines.every(line => line.startsWith('='))) return null
  const [exe, command] = lines.map(line => Buffer.from(line.slice(1), 'base64').toString('utf8'))
  return { exe, argv: splitWindowsCommand(command) }
}

// Base64, as PowerShell would otherwise print a path in the system's code page.
const winProcessScript = pid => "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $PSModuleAutoLoadingPreference = 'None'; "
  + "Microsoft.PowerShell.Core\\Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1'); "
  + "Microsoft.PowerShell.Core\\Import-Module ($PSHOME + '\\Modules\\CimCmdlets\\CimCmdlets.psd1'); "
  + `$found = CimCmdlets\\Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}' -Property ExecutablePath,CommandLine; `
  + 'if ($null -eq $found) { exit 3 }; '
  + "foreach ($value in @($found.ExecutablePath, $found.CommandLine)) { '=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value)) }"

// What the system itself says. Windows: netstat and one process query (Get-NetTCPConnection is too slow
// for a hook). Linux: /proc, which needs nothing installed. Any other system has no lookup here. `files` reads /proc,
// so a test can play a state no real process can be held in.
export const systemLookup = (platform, files = { readdirSync, readlinkSync, readFileSync }) => {
  if (platform === 'win32') return {
    isSoleListener: (pid, port, timeout) => isSoleOwner(netstatListeners(execFileSync(join(winSystem(), 'netstat.exe'), ['-ano', '-p', 'TCP'], { ...WIN_OPTIONS, timeout }), port), new Set([pid])),
    processOf: (pid, timeout) => {
      const found = parseWindowsProcess(execFileSync(join(winSystem(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', winProcessScript(pid)], { ...WIN_OPTIONS, timeout }))
      if (found === null) throw new Error('unreadable process query')
      return found
    },
  }
  if (platform === 'linux') return {
    isSoleListener: (pid, port) => {
      const own = new Set()
      for (const name of files.readdirSync(`/proc/${pid}/fd`)) {
        // A descriptor can close between the listing and this read.
        try {
          const socket = /^socket:\[(\d+)\]$/.exec(files.readlinkSync(`/proc/${pid}/fd/${name}`))
          if (socket !== null) own.add(socket[1])
        } catch {}
      }
      return isSoleOwner(procListeners(files.readFileSync('/proc/net/tcp', 'utf8'), port), own)
    },
    processOf: pid => ({
      // A Node upgraded while the board runs reads as "<path> (deleted)".
      exe: files.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''),
      argv: files.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, -1),
    }),
  }
  return null
}

const isNodeProgram = exe => /^node(?:js)?(?:\d[\d.]*)?(?:\.exe)?$/i.test(exe.split(/[\\/]/).at(-1) ?? '')
const isFullPath = (path, platform) => platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) : path.startsWith('/')

// The word the board's launcher writes directly after its script, in every release since 0.25.0, whatever Node options
// come before them. Judging these two words leaves Node's own option rules to Node. A program that copies them chooses
// its own command line, which SECURITY.md names as the limit of this check. The program's own word is never the script.
export const launcherScriptOf = argv => {
  const at = argv.indexOf('--serve-child')
  return at < 2 ? null : argv[at - 1]
}

// Which file a path reaches, however it is spelled: a link, a short name and another letter case all reach the same one,
// while two names that differ only by case in a case-sensitive Windows folder are two files. Null when the system gives no number.
export const fileIdOf = path => {
  const found = statSync(path, { bigint: true })
  return found.isFile() && found.ino !== 0n ? `${found.dev}:${found.ino}` : null
}

// Why this process is not the board, or null when it is.
export const processRefusal = (found, scripts, platform, fileId = fileIdOf) => {
  if (found.argv.every(word => word.trim() === '')) return 'empty-command-line'
  if (!isNodeProgram(found.exe)) return 'not-node'
  const script = launcherScriptOf(found.argv)
  if (script === null || !isFullPath(script, platform)) return 'not-board-script'
  // Read once, so a self-update that replaces the file during this check cannot make the script differ from itself.
  let id
  try { id = fileId(script) } catch { return 'not-board-script' }
  if (id === null) return 'not-board-script'
  const isSame = one => {
    if (one === script) return true
    try { return fileId(one) === id } catch { return false }
  }
  return scripts.some(isSame) ? null : 'not-board-script'
}

// Why the listener on the address file's port may not be told the command, or null when it may. Every way this
// can go wrong is a reason, so nothing here can fall through to asking the listener.
export const listenerRefusal = (board, { platform, now = () => performance.now(), deadline = Infinity, lookupMs = LOOKUP_MS, lookup = systemLookup(platform), fileId = fileIdOf }) => {
  if (lookup === null) return 'no-lookup'
  const stop = Math.min(now() + lookupMs, deadline)
  const left = () => Math.floor(stop - now())
  try {
    if (left() <= 0) return 'lookup-timeout'
    const isListener = lookup.isSoleListener(board.pid, board.port, left())
    if (left() <= 0) return 'lookup-timeout'
    if (!isListener) return 'not-listening'
    const found = lookup.processOf(board.pid, left())
    if (left() <= 0) return 'lookup-timeout'
    // The disk can be the slow part (a home folder on a network drive), so the clock is read again after it.
    const refusal = processRefusal(found, board.scripts, platform, fileId)
    return refusal ?? (left() <= 0 ? 'lookup-timeout' : null)
  } catch (error) {
    return winIsKilled(error) ? 'lookup-timeout' : 'lookup-failed'
  }
}

// Bash's request to run outside the sandbox: Claude Code's own prompt decides it, never the board.
// Any value but absent or false counts, so a string such as "true" is not a way past.
export const isSandboxOff = input => {
  const flag = input.tool_input?.dangerouslyDisableSandbox
  return flag !== undefined && flag !== null && flag !== false
}

const bytesOf = value => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')

// What the board is told: the request as Claude Code gave it, with a very long input cut and
// marked cut. A cut request is never pressed on the board: the person would approve words they
// did not see, such as a command padded far past what the page shows.
export const askBody = input => {
  const toolInput = input.tool_input ?? null
  let sent = toolInput
  let isCut = false
  try {
    if (bytesOf(toolInput) > SEND_MAX) {
      isCut = true
      sent = toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
        ? Object.fromEntries(Object.entries(toolInput).map(([name, value]) => [name, typeof value === 'string' && value.length > CUT_AT ? `${value.slice(0, CUT_AT)}…` : value]))
        : null
      if (bytesOf(sent) > SEND_MAX) sent = null
    }
  } catch {
    sent = null
    isCut = true
  }
  return {
    agent: 'claude',
    session: typeof input.session_id === 'string' ? input.session_id : '',
    // Claude Code's prompt id is the turn; a request without one is shown with no button.
    turn: typeof input.prompt_id === 'string' ? input.prompt_id : '',
    tool: typeof input.tool_name === 'string' ? input.tool_name : '',
    input: sent,
    // A sub-agent's request carries its parent's session id, so it shows on the parent's row.
    isSubagent: typeof input.agent_id === 'string' && input.agent_id !== '',
    mode: typeof input.permission_mode === 'string' ? input.permission_mode : '',
    isCut,
  }
}

// The only two answers there are. A deny carries the person's words, or the board's own line.
export const decisionOutput = decision => {
  if (decision === null || typeof decision !== 'object') return null
  if (decision.behavior === 'allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
  if (decision.behavior === 'deny' && typeof decision.message === 'string' && decision.message !== '') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: decision.message.slice(0, 4000) } } }
  }
  return null
}

const readInput = () => new Promise(done => {
  const chunks = []
  let size = 0
  const timer = setTimeout(() => done(null), INPUT_MS)
  process.stdin.on('data', chunk => {
    size += chunk.length
    if (size > INPUT_MAX) { clearTimeout(timer); done(null); return }
    chunks.push(chunk)
  })
  process.stdin.on('end', () => {
    clearTimeout(timer)
    try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { done(null) }
  })
  process.stdin.on('error', () => { clearTimeout(timer); done(null) })
})

// The request goes to the address that was checked and nowhere else: an agent of its own takes no proxy from the
// environment, and node:http follows no redirect. Any failure, status or unreadable answer is no answer.
export const askBoard = (address, payload) => new Promise(done => {
  const { hostname, port } = new URL(address.origin)
  let timer
  const finish = value => { clearTimeout(timer); done(value) }
  const asked = httpRequest({
    host: hostname,
    port,
    path: '/api/approvals/ask',
    method: 'POST',
    agent: new Agent(),
    headers: { 'content-type': 'application/json', 'content-length': payload.length, 'x-board-token': address.token },
  }, answer => {
    // A refusal is known from its status, so a body left open cannot hold the person's prompt back.
    if (answer.statusCode < 200 || answer.statusCode >= 300) {
      finish(null)
      asked.destroy()
      return
    }
    // The headers came: the board is alive, and the press may take up to 30 s.
    clearTimeout(timer)
    timer = setTimeout(() => asked.destroy(), ASK_MS)
    const chunks = []
    answer.on('data', chunk => chunks.push(chunk))
    answer.on('error', () => finish(null))
    answer.on('end', () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { finish(null) }
    })
  })
  timer = setTimeout(() => asked.destroy(), HEADERS_MS)
  asked.on('error', () => finish(null))
  asked.on('close', () => finish(null))
  asked.end(payload)
})

export const run = async (env = process.env, platform = process.platform, options = {}) => {
  const now = options.now ?? (() => performance.now())
  const discoveryDeadline = now() + (options.discoveryMs ?? DISCOVERY_MS)
  const input = options.input !== undefined ? options.input : await readInput()
  if (input === null || typeof input !== 'object' || QUIET_MODES.has(input.permission_mode)) return null
  // Not sent to the board at all: it could only allow or deny, and the board allowing is the thing refused.
  if (isSandboxOff(input)) return null
  const address = readAddress(env, platform, input.cwd, { ...options, deadline: discoveryDeadline, now })
  if (address === null || now() >= discoveryDeadline) return null
  if (isSwitchedOff(address.file)) return null
  const refusal = (options.checkListener ?? listenerRefusal)(address, { ...options, platform, deadline: discoveryDeadline, now })
  if (refusal !== null) {
    leaveRefusal(address.file, refusal)
    return null
  }
  ;(options.clearRefusal ?? clearRefusal)(address.file)
  const payload = Buffer.from(JSON.stringify(askBody(input)))
  if (now() >= discoveryDeadline) return null
  const body = await askBoard(address, payload)
  return decisionOutput(body?.decision ?? null)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The answer is written out in full before the process ends; a hook that fails says nothing.
  run().then(output => new Promise(done => {
    if (output === null) done()
    else process.stdout.write(JSON.stringify(output), () => done())
  }), () => undefined).finally(() => process.exit(0))
}
