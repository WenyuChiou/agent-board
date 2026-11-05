import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, relative, resolve, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { addedLines, testTitles, titleKnown } from './pr-check.mjs'
import { fragmentIssue, isFragmentPath } from './changelog-fold.mjs'
import { isBundleFile } from './bundle-text.mjs'

const tables = [['hooks/i18n.ts', 'ZH_TW'], ['hooks/strings-en.ts', 'EN'], ['hooks/strings-zh-cn.ts', 'ZH_CN']]
const homeNames = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROGRESS_FILE']
const maxBuffer = 64 * 1024 * 1024
const read = path => readFileSync(path, 'utf8')
const isTest = path => /^tests\/(?:.*\/)?[^/]+\.test\.(mjs|ts|tsx)$/.test(path)
const splitPaths = text => text.split('\0').filter(Boolean)

// Without a recorded or readable identity, a live PID cannot safely be identified as a replacement.
export const isLiveMarker = ({ isAlive, recordedIdentity, identity = null }) =>
  isAlive && (recordedIdentity == null || identity === null || recordedIdentity === identity)

export const accountTestLockPath = ({ platform = process.platform, account = userInfo() } = {}) => {
  const identity = platform === 'win32'
    ? createHash('sha256').update(String(account.homedir)).digest('hex')
    : String(account.uid)
  // userInfo reads the account database, unlike HOME, USERPROFILE or the temp environment.
  return join(account.homedir, `.agent-board-preflight-tests-${identity}`)
}

// A cloud machine can give an agent a read-only home. Every process of the account then shares this one folder,
// named from the account's uid under the literal /tmp (never TMPDIR, which differs between processes). Windows has none.
export const accountFallbackLockPath = ({ platform = process.platform, account = userInfo() } = {}) =>
  platform === 'win32' ? null : `/tmp/.agent-board-preflight-tests-${String(account.uid)}`

export const testLockDirectoryProblem = (stat, { platform = process.platform, uid = userInfo().uid } = {}) => {
  if (stat.isSymbolicLink()) return 'test lock directory is a symbolic link.'
  if (!stat.isDirectory()) return 'test lock directory is not a directory.'
  if (platform !== 'win32') {
    if (stat.uid !== uid) return 'test lock directory belongs to another account.'
    if (stat.mode & 0o022) return 'test lock directory is writable by group or others.'
  }
  return null
}

// The parent of the shared fallback is writable by every account, so only a sticky one keeps others from renaming the folder.
export const sharedParentProblem = (stat, { platform = process.platform } = {}) => {
  if (platform === 'win32') return 'test lock directory has no shared fallback on Windows.'
  if (!stat.isDirectory()) return 'test lock directory fallback parent is not a directory.'
  if ((stat.mode & 0o002) && !(stat.mode & 0o1000)) return 'test lock directory fallback parent is writable by others without the sticky bit.'
  return null
}

const unwritableCodes = new Set(['EROFS', 'EACCES', 'EPERM'])

const isWritable = directory => {
  try {
    accessSync(directory, constants.W_OK | constants.X_OK)
    return true
  } catch (error) {
    if (unwritableCodes.has(error?.code)) return false
    throw new Error('test lock directory could not be inspected; check account directory access.')
  }
}

const prepareTestLockDirectory = directory => {
  try { mkdirSync(directory, { mode: 0o700 }) } catch (error) {
    if (error?.code !== 'EEXIST') throw new Error('test lock directory could not be created; check account directory access.', { cause: error })
  }
  let stat
  try { stat = lstatSync(directory) } catch {
    throw new Error('test lock directory could not be inspected; check account directory access.')
  }
  const problem = testLockDirectoryProblem(stat)
  if (problem) throw new Error(problem)
}

// A folder another run may publish in, read but never created or cleaned here. Missing is fine; anything unsafe fails closed.
const watchedLockDirectory = directory => {
  let stat
  try { stat = lstatSync(directory) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error('test lock directory could not be inspected; check account directory access.')
  }
  const problem = testLockDirectoryProblem(stat)
  if (problem) throw new Error(problem)
  return directory
}

// The account's lock folders this run publishes in and watches. The home folder comes first. When it cannot be written,
// the fallback holds this run's marker and the home folder is still read, so a run there and a run here exclude each other.
const lockDirectories = (directory, fallback) => {
  let isHomeUsable = false
  try {
    prepareTestLockDirectory(directory)
    // A lock folder left from before can sit on a home that is now read-only: it exists, but no marker can be added.
    isHomeUsable = !fallback || isWritable(directory)
  } catch (error) {
    if (!fallback || !unwritableCodes.has(error.cause?.code)) throw error
  }
  if (!isHomeUsable) {
    let parent
    try { parent = statSync(dirname(fallback)) } catch {
      throw new Error('test lock directory fallback parent could not be inspected.')
    }
    const problem = sharedParentProblem(parent)
    if (problem) throw new Error(problem)
    prepareTestLockDirectory(fallback)
    return { own: fallback, watched: [{ directory, isOptional: false }], isFallback: true }
  }
  // A fallback folder that fails its checks is not this account's, so its markers cannot block this run; a restricted
  // run of this account refuses that same folder and starts nothing.
  return { own: directory, watched: fallback ? [{ directory: fallback, isOptional: true }] : [], isFallback: false }
}

// Read only after this run's marker exists, so a run that creates the folder a moment later still meets that marker.
const watchedLiveMarker = ({ directory, isOptional }, marker, readProcessIdentity) => {
  try {
    if (!watchedLockDirectory(directory)) return null
  } catch (error) {
    if (isOptional) return null
    throw error
  }
  return newestLiveMarker(directory, marker, false, readProcessIdentity)
}

const isLiveProcess = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

export const parseProcStat = text => {
  if (typeof text !== 'string' || !/^\d+\s+\(/.test(text)) return null
  const end = text.lastIndexOf(')')
  if (end < 0 || !/^\s/.test(text.slice(end + 1))) return null
  const fields = text.slice(end + 1).trim().split(/\s+/)
  if (!/^[A-Za-z]$/.test(fields[0] ?? '') || !/^\d+$/.test(fields[19] ?? '')) return null
  const ticks = Number(fields[19])
  return Number.isSafeInteger(ticks) ? ticks : null
}

export const parseBootTime = text => {
  if (typeof text !== 'string') return null
  const match = /^btime\s+(\d+)\s*$/m.exec(text)
  if (!match) return null
  const milliseconds = Number(match[1]) * 1000
  return Number.isSafeInteger(milliseconds) ? milliseconds : null
}

export const parsePsLstart = text => {
  if (typeof text !== 'string') return null
  const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim())
  if (!match) return null
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[1])
  const [, , dayText, hourText, minuteText, secondText, yearText] = match
  const [day, hour, minute, second, year] = [dayText, hourText, minuteText, secondText, yearText].map(Number)
  if (year < 100) return null
  const date = new Date(Date.UTC(year, month, day, hour, minute, second))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null
  return date.getTime()
}

let cachedClockTicks
const clockTicksPerSecond = run => {
  if (run === spawnSync && cachedClockTicks !== undefined) return cachedClockTicks
  let frequency = null
  try {
    const result = run('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', windowsHide: true })
    const output = result.stdout?.trim()
    const ticks = /^\d+$/.test(output ?? '') ? Number(output) : null
    if (!result.error && !result.signal && result.status === 0 && Number.isSafeInteger(ticks) && ticks > 0) frequency = ticks
  } catch {}
  if (run === spawnSync) cachedClockTicks = frequency
  return frequency
}

const processStartTime = (pid, { platform = process.platform, run = spawnSync, env = process.env } = {}) => {
  try {
    if (platform === 'win32') {
      const root = env.SystemRoot
      if (typeof root !== 'string' || !win32.isAbsolute(root) || !win32.parse(root).root.replace(/[\\/]/g, '')) return null
      const powershell = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
      const result = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL', windowsHide: true })
      const output = result.stdout?.trim() ?? ''
      if (result.error || result.signal || result.status !== 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(output)) return null
      return Number.isFinite(Date.parse(output)) ? output : null
    }
    const result = run('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL', windowsHide: true, env: { ...env, LC_ALL: 'C', TZ: 'UTC' },
    })
    if (result.error || result.signal || result.status !== 0) return null
    const started = parsePsLstart(result.stdout)
    return started === null ? null : new Date(started).toISOString()
  } catch {
    return null
  }
}

export const processStartedMs = (pid, { platform = process.platform, readText = read, run = spawnSync, clockTicks = () => clockTicksPerSecond(run), ...options } = {}) => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return null
  try {
    if (platform === 'linux') {
      const ticks = parseProcStat(readText(`/proc/${pid}/stat`))
      const boot = parseBootTime(readText('/proc/stat'))
      const frequency = clockTicks()
      if (ticks === null || boot === null || !Number.isSafeInteger(frequency) || frequency <= 0) return null
      const started = boot + ticks * 1000 / frequency
      return Number.isFinite(started) ? started : null
    }
    const time = processStartTime(pid, { platform, run, ...options })
    return time === null ? null : Date.parse(time)
  } catch {
    return null
  }
}

export const processStartIdentity = (pid, { platform = process.platform, readText = read, readLink = readlinkSync, ...options } = {}) => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return null
  try {
    if (platform !== 'linux') {
      const time = processStartTime(pid, { platform, ...options })
      if (time === null || platform === 'win32') return time
      return `${platform === 'darwin' ? 'darwin-second:' : 'ps-second:'}${time}`
    }
    const ticks = parseProcStat(readText(pid === process.pid ? '/proc/self/stat' : `/proc/${pid}/stat`))
    const boot = readText('/proc/sys/kernel/random/boot_id').trim()
    if (ticks === null || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(boot)) return null
    // NSpid lists this process's PID from the procfs mount's PID namespace down to its own.
    // One entry means /proc/N names processes in this PID namespace; equal numbers at two levels do not.
    let time = ''
    let pidNamespace = ''
    try { time = /^time:\[\d+\]$/.exec(readLink('/proc/self/ns/time'))?.[0] ?? '' } catch {}
    try {
      const nspid = /^NSpid:[ \t]*(\d+)[ \t]*$/m.exec(readText('/proc/self/status'))?.[1]
      if (nspid !== undefined && Number(nspid) === process.pid) pidNamespace = /^pid:\[\d+\]$/.exec(readLink('/proc/self/ns/pid'))?.[0] ?? ''
    } catch {}
    return `linux:${boot}:${ticks}${time ? `:${time}` : ''}${pidNamespace ? `:${pidNamespace}` : ''}`
  } catch {
    return null
  }
}

const secondPrecisionPrefix = identity => ['darwin-second:', 'ps-second:'].find(prefix => identity?.startsWith(prefix))
// Compared without the precision tag, so a record written before the tag existed (this pull request's c3247d6) still matches.
const bareIdentity = identity => typeof identity === 'string' ? identity.slice(secondPrecisionPrefix(identity)?.length ?? 0) : identity
const linuxNamespaces = identity => /^linux:[^:]+:\d+:(time:\[\d+\]:pid:\[\d+\])$/.exec(identity ?? '')?.[1] ?? null
// A PID identifies a process only in one PID namespace, and start ticks only in one time namespace. Compare Linux
// identities only when both namespaces are readable and match; otherwise the owner is unconfirmed.
const comparableIdentities = (recorded, read) => {
  const isLinux = typeof recorded === 'string' && typeof read === 'string' && [recorded, read].some(identity => identity.startsWith('linux:'))
  const [a, b] = [linuxNamespaces(recorded), linuxNamespaces(read)]
  if (isLinux && (!a || !b || a !== b)) return { recorded, read: null, isOtherNamespace: true }
  return { recorded: bareIdentity(recorded), read: bareIdentity(read), isOtherNamespace: false }
}

const knownProcessIdentity = (pid, reader) => {
  try {
    const identity = reader(pid)
    return typeof identity === 'string' && identity.length > 0 && identity.length <= 512 ? identity : null
  } catch {
    return null
  }
}

// Old preflights recognize only empty .lock files. Companion metadata preserves that shared marker format.
const markerIdentity = path => {
  try {
    const stat = lstatSync(`${path}.start`)
    if (!stat.isFile() || stat.size > 1024) return null
    const identity = JSON.parse(read(`${path}.start`))
    return typeof identity === 'string' && identity.length > 0 && identity.length <= 512 ? identity : null
  } catch (error) {
    return error?.code === 'ENOENT' ? undefined : null
  }
}

const removeLockFile = path => {
  try {
    unlinkSync(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

const releaseTestLock = path => {
  removeLockFile(path)
  removeLockFile(`${path}.start`)
}

// Stale markers are removed only from this run's own folder.
const newestLiveMarker = (directory, marker, isOwn, readProcessIdentity) => {
  let newest = null
  for (const name of readdirSync(directory)) {
    if (name === marker) continue
    const match = /^([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.lock$/i.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    // Node's process.kill accepts signed 32-bit PIDs; larger values are not usable owner markers.
    if (!Number.isInteger(pid) || pid > 2147483647) continue
    let stat
    try { stat = lstatSync(join(directory, name)) } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    // Unfamiliar entries, including links and directories, never become stale markers.
    if (!stat.isFile() || stat.size !== 0) continue
    const isAlive = isLiveProcess(pid)
    const path = join(directory, name)
    const recordedIdentity = isAlive ? markerIdentity(path) : undefined
    const identity = isAlive && recordedIdentity !== undefined ? knownProcessIdentity(pid, readProcessIdentity) : null
    // Linux and Windows matches count as confirmed: Linux hands out PIDs in turn up to pid_max, so the same PID cannot
    // return within one clock tick, and Windows start times are kept to 100 ns. ps start times are only to the second.
    const compared = comparableIdentities(recordedIdentity, identity)
    if (isLiveMarker({ isAlive, recordedIdentity: compared.recorded, identity: compared.read })) {
      const uncertainty = recordedIdentity === undefined ? 'legacy' : compared.isOtherNamespace ? 'namespace'
        : recordedIdentity === null || identity === null ? 'unknown' : secondPrecisionPrefix(identity) ? 'second' : null
      if (!newest || stat.mtimeMs > newest.markerMs) newest = { pid, name, markerMs: stat.mtimeMs, uncertainty }
      continue
    }
    if (isOwn) releaseTestLock(path)
  }
  return newest
}

const acquireTestLock = (directory, onPublished, fallback, readProcessIdentity) => {
  const { own, watched, isFallback } = lockDirectories(directory, fallback)
  const marker = `${process.pid}-${randomUUID()}.lock`
  const path = join(own, marker)
  let isPublished = false
  let isIdentityPublished = false
  try {
    // Publish metadata first so every visible marker already has its identity, even during a clock change.
    // An unreadable own identity is published as null, so readers block on a live PID.
    writeFileSync(`${path}.start`, JSON.stringify(knownProcessIdentity(process.pid, readProcessIdentity)), { flag: 'wx', mode: 0o600 })
    isIdentityPublished = true
    const file = openSync(path, 'wx', 0o600)
    isPublished = true
    closeSync(file)
    onPublished?.()
    // Every folder is read, even after a live marker is found, so this run's own stale markers are still cleaned.
    const blockedBy = [newestLiveMarker(own, marker, true, readProcessIdentity), ...watched.map(other => watchedLiveMarker(other, marker, readProcessIdentity))]
      .filter(Boolean).sort((a, b) => b.markerMs - a.markerMs)[0]
    if (blockedBy) {
      releaseTestLock(path)
      return { blockedBy }
    }
    return { path, isFallback }
  } catch (error) {
    if (isPublished) releaseTestLock(path)
    else if (isIdentityPublished) removeLockFile(`${path}.start`)
    throw error
  }
}

// Child diagnostics can contain private paths or terminal control characters.
export const safeLine = (value, { hasSpacedUnixPaths = false } = {}) => {
  let text = String(value).replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '')
  // A file URL must reach the path rules before its e:/ can look like a drive.
  if (hasSpacedUnixPaths) text = text.replace(/\bfile:\/\/[^/\s]*(?=\/)/gi, '')
  // Home directory names can contain spaces even in unquoted diagnostics.
  // TAP names need conservative path removal; status lines keep adjacent relative paths.
  const unixPath = hasSpacedUnixPaths
    ? /(^|[^\w])(?:file:\/\/)?\/(?:[^\s/"'`<>:|?]+(?: [^\s/"'`<>:|?]+)*\/)*(?:[^\s/"'`<>:|?]+(?: [^\s/"'`<>:|?]+)*?\.[\w-]+(?=$|[\s"'`<>,;:)])|[^\s"'`<>?]*)/g
    : /(^|[\s"'`(])(?:file:\/\/)?\/(?:[^\s/"'`<>:|?]+\/)*(?:[^\s/"'`<>:|?]+(?: [^\s/"'`<>:|?]+)*?\.[\w-]+(?=$|[\s"'`<>,;:)])|[^\s"'`<>?]*)/g
  text = text.replace(/(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:home|Users)\/)[^\\/"'`<>]+(?=[\\/])/gi, match => match.replaceAll(' ', '\ue000'))
  text = text.replace(/(?:[A-Za-z]:[\\/]|\\\\)(?:[^\s\\/"'`<>:|?]+(?: [^\s\\/"'`<>:|?]+)*[\\/])*(?:[^\s\\/"'`<>:|?]+(?: [^\s\\/"'`<>:|?]+)*?\.[\w-]+(?=$|[\s"'`<>,;:)])|[^\s"'`<>?]*)/g, '<path>')
    .replace(unixPath, '$1<path>')
    .replace(/([?&]t=)[^\s&#"'`<>]+/gi, '$1<token>')
    .replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]+/gi, '<token>')
  for (const name of [process.env.USERNAME, process.env.USER].filter(value => value && value.length > 2)) {
    text = text.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<user>')
  }
  return text
}

const failedTapNames = output => {
  const names = []
  let diagnosticIndent
  for (const line of output.split(/\r?\n/)) {
    const opening = /^(\s*)---\s*$/.exec(line)
    if (diagnosticIndent === undefined && opening) {
      diagnosticIndent = opening[1]
      continue
    }
    if (diagnosticIndent !== undefined) {
      const closing = /^(\s*)\.\.\.\s*$/.exec(line)
      if (closing?.[1] === diagnosticIndent) diagnosticIndent = undefined
      continue
    }
    const match = /^\s*not ok \d+ - (.+?)\s*$/.exec(line)
    if (!match || /\s+#\s*(?:TODO|SKIP)\b/i.test(match[1])) continue
    // TAP escapes paths and hashes; decode before the path sanitizer sees them.
    const name = safeLine(match[1].replace(/\\(.)/g, '$1'), { hasSpacedUnixPaths: true }).slice(0, 160)
    if (name && !names.includes(name)) names.push(name)
    if (names.length === 3) break
  }
  return names
}

// Keep literals as tokens so braces and helper names inside prose cannot become code.
export const codeTokens = text => {
  const tokens = []
  const pattern = /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|[\w$]+|=>|\?\.|\.\.\.|[^\s]/gy
  let match
  let line = 1
  while ((match = pattern.exec(text))) {
    const value = match[0]
    if (!/^\s|^\/\/|^\/\*/.test(value)) {
      if (value === '/' && (!tokens.length || /^(?:=|\(|\[|,|:|return|=>|!|\?|\|\||&&)$/.test(tokens.at(-1).value))) {
        const regex = /^\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\\r\n])+\/[a-z]*/.exec(text.slice(match.index))
        if (regex) {
          pattern.lastIndex = match.index + regex[0].length
          tokens.push({ value: '<regex>', line })
          continue
        }
      }
      const isString = /^["'`]/.test(value)
      tokens.push({ value: isString ? value.slice(1, -1).replace(/\\(['"`\\])/g, '$1') : value, raw: value, isString, line })
    }
    line += (value.match(/\n/g) ?? []).length
  }
  return tokens
}

export const objectKeys = (text, name) => {
  const tokens = codeTokens(text)
  let index = tokens.findIndex((token, i) => token.value === 'const' && tokens[i + 1]?.value === name)
  if (index === -1) throw new Error('table declaration is missing')
  while (tokens[index]?.value !== '=' && index < tokens.length) index++
  if (tokens[++index]?.value !== '{') throw new Error('table is not an object literal')
  const keys = []
  let depth = 1
  let isKey = true
  for (index++; index < tokens.length; index++) {
    const token = tokens[index]
    if (depth === 1 && isKey && token.value !== '}') {
      if ((!token.isString && !/^[\w$]+$/.test(token.value)) || tokens[index + 1]?.value !== ':') throw new Error('unsupported table key')
      keys.push(token.value)
      isKey = false
    }
    if (!token.isString) {
      if (['{', '[', '('].includes(token.value)) depth++
      if (['}', ']', ')'].includes(token.value)) depth--
      if (!depth) return keys
      if (depth === 1 && token.value === ',' && (tokens[index + 1]?.value === '}' || tokens[index + 2]?.value === ':')) isKey = true
    }
  }
  throw new Error('table object is incomplete')
}

export const engineProblems = text => {
  const tokens = codeTokens(text)
  const allowed = new Set()
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.isString) continue
    if (!depth && token.value === 'function') allowed.add(tokens[i + 1]?.value)
    if (!depth && token.value === 'const') {
      let at = i + 2
      while (at < tokens.length && tokens[at].value !== '=' && !['const', 'function', ';'].includes(tokens[at].value)) at++
      if (tokens[at]?.value === '=') {
        let nested = 0
        for (at++; at < tokens.length; at++) {
          const next = tokens[at]
          if (next.isString) continue
          if (!nested && next.value === '=>') { allowed.add(tokens[i + 1]?.value); break }
          if (!nested && [';', 'const', 'function', 'export'].includes(next.value)) break
          if (['(', '[', '{'].includes(next.value)) nested++
          if ([')', ']', '}'].includes(next.value)) nested--
        }
      }
    }
    if (!depth && token.value === 'import' && tokens[i + 1]?.value !== 'type') {
      let end = i + 1
      while (end < tokens.length && !tokens[end].isString) end++
      if (tokens[end]?.value.startsWith('.') || tokens[end]?.value === 'claude-code') {
        for (let at = i + 1; at < end; at++) {
          const item = tokens[at]
          if (/^[\w$]+$/.test(item.value) && !['from', 'as', 'type'].includes(item.value) && tokens[at + 1]?.value !== 'as') {
            // These SDK primitives receive the engine directly, rather than being user helpers.
            const original = tokens[at - 1]?.value === 'as' ? tokens[at - 2]?.value : item.value
            if (tokens[end].value !== 'claude-code' || ['read', 'update'].includes(original)) allowed.add(item.value)
          }
        }
      }
    }
    if (token.value === '{') depth++
    if (token.value === '}') depth--
  }
  return tokens.flatMap((token, i) => !token.isString && token.value !== 'async' && /^[\w$]+$/.test(token.value)
    && !['.', '?.', 'function'].includes(tokens[i - 1]?.value)
    && tokens[i + 1]?.value === '(' && tokens[i + 2]?.value === '$'
    && [',', ')'].includes(tokens[i + 3]?.value) && !allowed.has(token.value)
    ? [{ name: token.value, line: token.line }] : [])
}

export const bundleSources = cwd => {
  const sources = new Set(['scripts/build-board.ts'])
  const visit = path => {
    if (isBundleFile(path)) return
    if (sources.has(path)) return
    sources.add(path)
    if (!existsSync(join(cwd, path))) return
    const tokens = codeTokens(read(join(cwd, path)))
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (!token.isString || !token.value.startsWith('.') || !['from', 'import'].includes(tokens[i - 1]?.value)) continue
      let declaration = i - 1
      while (declaration >= 0 && !['import', 'export'].includes(tokens[declaration].value)) declaration--
      if (declaration < 0 || tokens[declaration + 1]?.value === 'type') continue
      const target = resolve(cwd, dirname(path), token.value)
      const found = [target, `${target}.ts`, `${target}.tsx`, `${target}.mjs`, join(target, 'index.ts')].find(candidate => existsSync(candidate) && statSync(candidate).isFile())
      if (!found) throw new Error('an imported bundle source is missing')
      const name = relative(cwd, found).replaceAll('\\', '/')
      if (name.startsWith('../')) throw new Error('bundle import leaves the repository')
      visit(name)
    }
  }
  visit('scripts/board-cli.ts')
  return sources
}

const testDeclarations = cwd => {
  const declarations = []
  const visit = path => {
    if (!existsSync(join(cwd, path))) return
    for (const item of readdirSync(join(cwd, path), { withFileTypes: true })) {
      const name = `${path}/${item.name}`
      if (item.isDirectory()) visit(name)
      else if (item.isFile() && isTest(name)) {
        const tokens = codeTokens(read(join(cwd, name)))
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i].isString || !['test', 'it'].includes(tokens[i].value) || tokens[i - 1]?.value === '.') continue
          let at = i + 1
          if (tokens[at]?.value === '.' && ['skip', 'only', 'todo'].includes(tokens[at + 1]?.value)) at += 2
          if (tokens[at]?.value === '(' && tokens[at + 1]?.isString) {
            declarations.push(testTitles([{ path: name, text: `test(${tokens[at + 1].raw})` }]))
          }
        }
      }
    }
  }
  visit('tests')
  return declarations
}

const parseArgs = argv => {
  const options = { base: 'origin/main' }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (seen.has(key)) throw new Error('duplicate option')
    seen.add(key)
    if (key === '--no-fetch') options.isNoFetch = true
    else if (['--base', '--body-file', '--title'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      options[{ '--base': 'base', '--body-file': 'bodyFile', '--title': 'title' }[key]] = argv[++i]
    } else throw new Error('use node scripts/preflight.mjs [--base origin/main] [--no-fetch] [--body-file <f> --title <t>]')
  }
  if (Boolean(options.bodyFile) !== Boolean(options.title)) throw new Error('--body-file and --title must be supplied together')
  return options
}

export const runPreflight = async ({ cwd = process.cwd(), base = 'origin/main', isNoFetch = false, isFromMain = false, bodyFile, title, run = spawnSync, lockPath = accountTestLockPath(), fallbackLockPath = accountFallbackLockPath(), readProcessIdentity = processStartIdentity, onCheck, onProgress, onLockPublished } = {}) => {
  const checks = []
  // `exact` replaces the \ue001 mark after redaction: a validated lock file name and fixed folder pattern, which an account name must not alter.
  const add = (state, message, exact = '') => {
    const item = { state, message: safeLine(message).replace('\ue001', exact) }
    checks.push(item)
    onCheck?.(item)
  }
  const command = (program, args, options = {}) => run(program, args, {
    cwd, encoding: 'utf8', maxBuffer, timeout: 120000,
    env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' }, ...options,
  })
  const git = (...args) => {
    const executed = command('git', args)
    if (executed.error || executed.status !== 0) throw new Error('Git could not read the requested base or working tree')
    return executed.stdout
  }
  const check = async (label, action) => {
    try { await action() } catch { add('FAIL', `${label} could not finish; check its inputs and tools.`) }
  }
  let changed
  let added
  let mergeBase
  let newPaths
  try {
    let hasFetchFailed = false
    if (!isFromMain && isNoFetch) add('WARN', 'using the local preflight because --no-fetch was supplied; origin/main freshness is unknown.')
    if (!isFromMain && !isNoFetch) {
      const fetched = command('git', ['fetch', 'origin', 'main'])
      hasFetchFailed = Boolean(fetched.error || fetched.status !== 0)
      if (hasFetchFailed) add('WARN', 'using the local preflight because git fetch origin main failed; origin/main freshness is unknown.')
    }
    // Hand over before taking the test lock; main's imports come from its checkout, while all checks still target cwd.
    if (!isFromMain && !isNoFetch && !hasFetchFailed) {
      try {
        const sha = git('rev-parse', '--verify', 'origin/main^{commit}').trim()
        const compared = command('git', ['diff', '--quiet', '--no-ext-diff', '--no-textconv', sha, '--', 'scripts/preflight.mjs'])
        if (compared.error || ![0, 1].includes(compared.status)) throw new Error('preflight comparison failed')
        if (compared.status === 1) {
          const temp = mkdtempSync(join(tmpdir(), 'agent-board-preflight-main-'))
          const checkout = join(temp, 'repo')
          let isCreated = false
          try {
            const created = command('git', ['worktree', 'add', '--detach', checkout, sha])
            if (created.error || created.status !== 0) throw new Error('preflight checkout failed')
            isCreated = true
            const fromMain = await import(pathToFileURL(join(checkout, 'scripts/preflight.mjs')).href)
            add('PASS', 'preflight from origin/main \ue001', sha)
            checks.push(...await fromMain.runPreflight({
              cwd, base, isNoFetch, isFromMain: true, bodyFile, title, run, lockPath, fallbackLockPath,
              readProcessIdentity, onCheck, onProgress, onLockPublished,
            }))
          } finally {
            try {
              if (isCreated || existsSync(join(checkout, '.git'))) {
                const removed = command('git', ['worktree', 'remove', '--force', checkout])
                if (removed.error || removed.status !== 0) throw new Error('preflight checkout cleanup failed')
              }
            } finally {
              rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
            }
          }
          return checks
        }
      } catch {
        add('FAIL', 'preflight from origin/main could not finish; check main and Git working tree.')
        return checks
      }
    }
    const ancestor = command('git', ['merge-base', '--is-ancestor', base, 'HEAD'])
    if (ancestor.error || ![0, 1].includes(ancestor.status)) add('FAIL', 'the main merged check could not read the base or HEAD.')
    else {
      // main does not require an up-to-date branch, so a branch behind main can merge as it is; main is merged only for a conflict.
      if (ancestor.status === 1) add('WARN', 'the branch does not contain the latest main; that is fine unless GitHub shows a conflict, then merge origin/main (no rebase, no force-push).')
      else if (!hasFetchFailed) add('PASS', 'the branch contains the base.')
    }
    mergeBase = git('merge-base', base, 'HEAD').trim()
    const untracked = splitPaths(git('ls-files', '--others', '--exclude-standard', '-z'))
    newPaths = new Set([...splitPaths(git('diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', mergeBase)), ...untracked])
    changed = new Set([
      ...splitPaths(git('diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`)),
      ...splitPaths(git('diff', '--name-only', '--no-renames', '-z', 'HEAD')), ...untracked,
      ...splitPaths(git('diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD')),
    ])
    added = addedLines(git('diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=0', mergeBase))
    for (const path of untracked.filter(path => path.startsWith('tests/') || path === 'CHANGELOG.md' || fragmentIssue(path) !== null)) {
      read(join(cwd, path)).split(/\r?\n/).forEach((text, i) => added.push({ path, line: i + 1, text }))
    }
  } catch {
    add('FAIL', 'changed files could not be read; check the base and Git working tree.')
    return checks
  }

  await check('touched Node tests', () => {
    const paths = [...changed].filter(path => isTest(path) && path.endsWith('.mjs') && existsSync(join(cwd, path)))
    if (!paths.length) add('PASS', 'no touched Node test files need running.')
    let owner = null
    try { owner = paths.length ? acquireTestLock(lockPath, onLockPublished, fallbackLockPath, readProcessIdentity) : null } catch (error) {
      add('FAIL', error.message?.startsWith('test lock directory ') ? error.message : 'test lock directory could not be used; check account directory access.')
      return
    }
    if (owner?.blockedBy) {
      const { pid, name, markerMs, uncertainty } = owner.blockedBy
      const minutes = Math.floor(Math.max(0, Date.now() - markerMs) / 60_000)
      const detail = uncertainty === 'legacy' ? ', owner could not be confirmed because no process identity was recorded'
        : uncertainty === 'unknown' ? ', process start time could not be read, so the owner could not be confirmed'
          : uncertainty === 'second' ? ', process identity is known only to the second; this may be a reused process ID'
            : uncertainty === 'namespace' ? ', its time or process ID namespace differs or could not be read, so the owner could not be confirmed' : ''
      add('FAIL', `another preflight test run is already active on this computer (process ${pid}, started ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago${detail}); finish it, or if no preflight is running, delete its .lock file \ue001 and run preflight again.`, `${name} from this account's .agent-board-preflight-tests-* folder`)
    }
    if (owner?.isFallback) add('PASS', "the home folder cannot hold the test lock, so the test lock was this account's shared fallback folder, and any home lock folder was still read.")
    if (owner?.path) {
      try {
        for (const path of paths) {
          const temp = mkdtempSync(join(tmpdir(), 'agent-board-preflight-'))
          try {
            const env = { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' }
            // A nested test runner must emit its own TAP, not the parent's IPC protocol.
            delete env.NODE_TEST_CONTEXT
            for (const name of Object.keys(env)) if (/^(GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|ANTHROPIC_API_KEY)$/i.test(name)) delete env[name]
            for (const name of homeNames) env[name] = name === 'CLAUDE_PROGRESS_FILE' ? join(temp, 'progress.md') : temp
            onProgress?.(`RUN ${safeLine(path)}`)
            const tested = command(process.execPath, ['--test', '--test-reporter=tap', path], { env, timeout: 600000 })
            const output = `${tested.stdout ?? ''}\n${tested.stderr ?? ''}`
            const count = output.match(/^# fail (\d+)\s*$/m)?.[1]
            const total = output.match(/^# tests (\d+)\s*$/m)?.[1]
            const isPassed = !tested.error && tested.status === 0 && count === '0'
            const failedNames = isPassed ? [] : failedTapNames(output)
            const failedDetail = failedNames.length ? `; failed: ${failedNames.join('; ')}` : ''
            add(isPassed ? 'PASS' : 'FAIL', `${path}: ${total ?? 'unknown'} tests, ${count ?? 'unknown'} failed${failedDetail}${tested.error || tested.signal ? '; the runner did not finish' : ''}.`)
          } finally {
            rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
          }
        }
      } finally {
        releaseTestLock(owner.path)
      }
    }
    if ([...changed].some(path => /^tests\/.*\.test\.tsx?$/.test(path))) add('WARN', 'run `claude plugin test .` once before Ready (not run here)')
    else add('PASS', 'no touched plugin tests need the Claude test runner.')
  })

  await check('string tables', () => {
    if (!tables.some(([path]) => changed.has(path))) { add('PASS', 'string tables are unchanged.'); return }
    const loader = `const tables = ${JSON.stringify(tables.map(([path, name]) => [pathToFileURL(join(cwd, path)).href, name]))}; const keys = []; for (const [path, name] of tables) keys.push(Object.keys((await import(path))[name])); console.log(JSON.stringify(keys))`
    const loaded = command(process.execPath, ['--input-type=module', '-e', loader])
    let keys
    let method = 'Node type stripping'
    try {
      if (loaded.error || loaded.status !== 0) throw new Error('load failed')
      keys = JSON.parse(loaded.stdout)
      if (keys.length !== 3 || !keys.every(list => Array.isArray(list) && list.every(key => typeof key === 'string'))) throw new Error('invalid tables')
    } catch {
      method = 'text scan'
      keys = tables.map(([path, name]) => objectKeys(read(join(cwd, path)), name))
    }
    const all = new Set(keys.flat())
    const missing = keys.flatMap((list, i) => [...all].filter(key => !list.includes(key)).map(key => `${tables[i][1]} lacks ${key}`))
    add(missing.length ? 'FAIL' : 'PASS', `string tables (${method}): ${missing.length ? missing.join(', ') : 'all top-level keys match'}.`)
    try {
      const newKeys = new Set()
      for (let i = 0; i < tables.length; i++) {
        const old = command('git', ['show', `${mergeBase}:${tables[i][0]}`])
        if (old.error || old.status !== 0) throw new Error('base table could not be read')
        const oldKeys = objectKeys(old.stdout, tables[i][1])
        for (const key of keys[i]) if (!oldKeys.includes(key)) newKeys.add(key)
      }
      const misplaced = [...newKeys].filter(key => keys.every(list => list.includes(key)) && new Set(keys.map(list => list[list.indexOf(key) - 1] ?? '<first>')).size > 1)
      add(misplaced.length ? 'WARN' : 'PASS', misplaced.length ? `put new string keys after the same neighbour in every table: ${misplaced.join(', ')}.` : 'new string keys have the same neighbour in every table.')
    } catch (error) {
      add('WARN', `string placement not checked: ${error.message}.`)
    }
  })

  for (const group of [['README.md', 'README.zh-TW.md', 'README.zh-CN.md'], ['docs/GUIDE.md', 'docs/GUIDE.zh-TW.md', 'docs/GUIDE.zh-CN.md']]) {
    const missing = group.some(path => changed.has(path)) ? group.filter(path => !changed.has(path)) : []
    add(missing.length ? 'WARN' : 'PASS', missing.length ? `update the language copies too: ${missing.join(', ')}.` : `${group[0]} language copies are synchronized or unchanged.`)
  }

  await check('board bundle scan', () => {
    const hasSource = [...bundleSources(cwd)].some(path => changed.has(path))
    const hasBundle = [...changed].some(isBundleFile)
    if (hasBundle && !hasSource) add('FAIL', 'never edit the bundle by hand')
    else if (hasSource && !hasBundle) add('WARN', "the board bundle is out of date: rebuild with `npx --yes bun@1.4.2 scripts/build-board.ts`, or write 'maintainer rebuilds at merge' under Checks")
    else add('PASS', 'board bundle and its sources changed together or are unchanged.')
  })

  await check('messaging matrix check', () => {
    if (!existsSync(join(cwd, 'scripts/messaging-matrix.mjs'))) { add('PASS', 'no messaging matrix in this tree.'); return }
    const checked = command(process.execPath, ['scripts/messaging-matrix.mjs', '--check'])
    if (!checked.error && checked.status === 0) add('PASS', 'messaging matrix is up to date.')
    else add('FAIL', `messaging matrix: ${checked.stderr?.split(/\r?\n/)[0] || 'the check could not finish'}`)
  })

  await check('engine helper scan', () => {
    const problems = changed.has('hooks/register.tsx') ? engineProblems(read(join(cwd, 'hooks/register.tsx'))) : []
    if (!problems.length) add('PASS', 'engine helper declarations have no detected problem.')
    for (const item of problems) add('FAIL', `${item.name} at hooks/register.tsx line ${item.line}: the plugin engine refuses a helper that receives \`$\` unless it is a top-level const or function in register.tsx`)
  })

  const processFiles = new Map()
  for (const item of added.filter(item => item.path.startsWith('tests/'))) processFiles.set(item.path, `${processFiles.get(item.path) ?? ''}\n${item.text}`)
  const unsafe = [...processFiles].filter(([, text]) => {
    const tokens = codeTokens(text)
    return tokens.some((token, i) => !token.isString && ['spawn', 'exec', 'execFile', 'fork'].includes(token.value)
      && !['.', '?.'].includes(tokens[i - 1]?.value) && tokens[i + 1]?.value === '(')
      && !/\bfinally\b|\bkill\s*\(/.test(text)
  })
  if (!unsafe.length) add('PASS', 'added test process launches have cleanup markers or none were added.')
  for (const [path] of unsafe) add('WARN', `${path}: a test that starts a process must stop it in \`finally\` and wait for it to exit, on Windows too`)

  if (bodyFile && title) {
    await check('PR body check', () => {
      const prCheck = extra => command(process.execPath, ['scripts/pr-check.mjs', '--body-file', resolve(cwd, bodyFile), '--title', title, '--no-bundle', '--base', base, ...extra])
      const firstOf = checked => `${checked.stdout ?? ''}\n${checked.stderr ?? ''}`.split(/\r?\n/).find(line => /^FAIL |^pr-check:/.test(line) && !/^pr-check: new pull request/.test(line))
      let checked = prCheck([])
      let note = ''
      // Without GitHub the body is still checked offline; the GitHub part is reported as not run, never as passed.
      if (checked.status !== 0 && /network check failed/.test(firstOf(checked) ?? '')) {
        const installed = command('gh', ['--version'])
        const signedIn = installed.error || installed.status !== 0 ? null : command('gh', ['auth', 'status'])
        const why = !signedIn ? 'the GitHub CLI is not installed' : signedIn.error || signedIn.status !== 0 ? 'the GitHub CLI is not signed in or cannot reach GitHub' : 'GitHub could not be reached'
        add('WARN', `pr-check's GitHub checks (issue, claim, open pull request cap, review) did not run here, because ${why}; CI's pr-check runs them on the pull request.`)
        checked = prCheck(['--offline'])
        note = ' without GitHub (--offline)'
      }
      const first = firstOf(checked)
      add(!checked.error && checked.status === 0 ? 'PASS' : 'FAIL', checked.status === 0 ? `PR body passed pr-check${note}.` : `PR body: ${first ?? 'pr-check could not finish.'}`)
    })
  } else add('PASS', 'PR body check skipped; supply --body-file and --title to include it.')

  await check('CHANGELOG test titles', () => {
    // The release writes each fix and feature's CHANGELOG line from its title, so a new pull request adds no fragment.
    const fragmentPaths = [...newPaths].filter(isFragmentPath)
    for (const path of fragmentPaths) add('WARN', `${path} is a new changelog fragment; a new pull request adds none, since the release writes the CHANGELOG line from its title (CONTRIBUTING rule 6).`)
    if (!fragmentPaths.length) add('PASS', 'no changelog fragment; the release writes the CHANGELOG line from the pull request title.')
    const lines = existsSync(join(cwd, 'CHANGELOG.md')) ? read(join(cwd, 'CHANGELOG.md')).split(/\r?\n/) : []
    const start = lines.findIndex(line => /^## Unreleased\s*$/.test(line))
    const next = lines.findIndex((line, i) => i > start && /^## /.test(line))
    const touched = new Set(added.filter(item => item.path === 'CHANGELOG.md').map(item => item.line))
    const titles = testDeclarations(cwd)
    const problems = []
    // A fragment kept from before the change still names its covering tests, so the release can fold it.
    const entries = fragmentPaths.filter(path => fragmentIssue(path) !== null).map(path => added.filter(item => item.path === path).map(item => item.text).join('\n'))
    if (start !== -1) {
      let at = start + 1
      while (at < (next === -1 ? lines.length : next)) {
        const begin = at
        while (at < (next === -1 ? lines.length : next) && lines[at].trim()) at++
        const entry = lines.slice(begin, at).join('\n')
        if (Array.from({ length: at - begin }, (_, i) => begin + i + 1).some(line => touched.has(line))) {
          entries.push(entry)
        }
        at++
      }
    }
    for (const entry of entries) {
      const tail = entry.match(/\bTests:\s*([\s\S]*)/)?.[1] ?? ''
      for (const match of tail.matchAll(/`([^`\n]+)`/g)) {
        if (/\.test\.(mjs|ts|tsx)$/.test(match[1])) continue
        const count = titles.filter(declaration => titleKnown(match[1], declaration)).length
        if (count !== 1) problems.push(`${match[1]} (${count} test declarations)`)
      }
    }
    add(problems.length ? 'FAIL' : 'PASS', problems.length ? `CHANGELOG must name each test exactly once in tests/: ${problems.join(', ')}.` : 'new CHANGELOG test titles each name exactly one test, or none were listed.')
  })
  return checks
}

// Module callers can isolate synthetic CLI fixtures without a command-line lock override.
export const main = async (argv = process.argv.slice(2), { lockPath, fallbackLockPath, onLockPublished } = {}) => {
  let checks
  const print = item => console.log(`${item.state} ${item.message}`)
  try { checks = await runPreflight({ ...parseArgs(argv), lockPath, fallbackLockPath, onLockPublished, onCheck: print, onProgress: console.log }) } catch (error) {
    checks = [{ state: 'FAIL', message: safeLine(error.message) }]
    print(checks[0])
  }
  const counts = Object.fromEntries(['PASS', 'WARN', 'FAIL'].map(state => [state, checks.filter(item => item.state === state).length]))
  console.log(`preflight: ${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL`)
  return counts.FAIL ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main()
