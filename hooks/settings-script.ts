// The plugin has no file access of its own beyond the host's, which follows links and waits on a
// FIFO. `/progress style` reads and writes the board's settings file through these two short Node
// scripts instead, the same rules as scripts/settings-file.ts (#1276): a link or a non-regular file is
// refused, the read does not wait for a writer, and the write is a new file renamed over the path, so
// it never goes through what the path points to. Run as `node -e SCRIPT -- <file> [<text>]`.
export const SETTINGS_UNSAFE = 71
export const SETTINGS_CHANGED = 72
export const SETTINGS_LOCKED = 73

// Prints one JSON line: {kind:'missing'}, {kind:'unsafe'} or {kind:'ok',text}. Exit 1 on any other error.
export const SETTINGS_READ = `
const fs = require('node:fs')
const file = process.argv[1]
const say = (body) => { process.stdout.write(JSON.stringify(body)) }
const answer = () => {
  try {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) return { kind: 'unsafe' }
  } catch (error) {
    return error && error.code === 'ENOENT' ? { kind: 'missing' } : null
  }
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0))
  } catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'missing' }
    return error && ['ELOOP', 'EISDIR', 'ENXIO'].includes(error.code) ? { kind: 'unsafe' } : null
  }
  try {
    return fs.fstatSync(fd).isFile() ? { kind: 'ok', text: fs.readFileSync(fd, 'utf8') } : { kind: 'unsafe' }
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}
const found = answer()
if (found === null) process.exitCode = 1
else say(found)
`

// `node -e SCRIPT -- <file> <kind>` with `{"next":…,"base":…}` as JSON on stdin: replaces the file with `next`, which was
// worked out from `base` (the text read earlier; <kind> is 'ok' for a file that held it, 'missing' for none). The
// texts go on stdin, never in the process arguments, which any user on the computer can list. The file is read again just before
// the swap and once after it: when it no longer holds <base>, nothing is written over it and the exit is
// 72, so the caller reads and works the change out again and a save made meanwhile is not undone.
// The new file gets the old one's permission bits (0600 when there was none).
// Exit 0 when written, 71 for an unsafe settings path, 73 for a lock timeout, and 1 for another error.
export const SETTINGS_WRITE = `
const fs = require('node:fs')
const path = require('node:path')
const [file, kind] = process.argv.slice(1)
let next, base
try {
  const given = JSON.parse(fs.readFileSync(0, 'utf8'))
  next = given.next
  base = given.base
  if (typeof next !== 'string' || (kind === 'ok' && typeof base !== 'string')) throw new Error('bad input')
} catch {
  process.exit(1)
}
// Every read here, the one after the rename too, refuses a link or a non-regular file and never waits for a writer.
const look = () => {
  try {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) return { kind: 'unsafe' }
    const flag = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0)
    return { kind: 'ok', text: fs.readFileSync(file, { encoding: 'utf8', flag }) }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'missing' }
    if (error && ['ELOOP', 'EISDIR', 'ENXIO', 'EAGAIN'].includes(error.code)) return { kind: 'unsafe' }
    throw error
  }
}
const held = () => {
  const now = look()
  if (now.kind === 'unsafe') return 'unsafe'
  return now.kind === kind && (kind === 'missing' || now.text === base) ? 'same' : 'changed'
}
// The same lock as scripts/settings-file.ts: exclusive creation, a 2 s wait, and release by its creator.
// Never take over another lock: its owner may still be writing, and inspecting it can block or race a fresh save.
const lockPath = path.resolve(file) + '.agent-board.lock'
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const withSettingsLock = (run) => {
  const deadline = performance.now() + 2000
  let fd
  for (;;) {
    if (performance.now() >= deadline) throw Object.assign(new Error('another save of the settings file is in progress, or died holding its lock; if none is running, delete ' + lockPath), { code: 'SETTINGS_LOCKED' })
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600)
      break
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      sleep(25)
    }
  }
  let own
  try {
    own = fs.fstatSync(fd)
    fs.writeFileSync(fd, process.pid + ' ' + Date.now() + '\\n')
    return run()
  } finally {
    if (own) try {
      const current = fs.lstatSync(lockPath)
      if (current.dev === own.dev && current.ino === own.ino) fs.unlinkSync(lockPath)
    } catch {}
    fs.closeSync(fd)
  }
}
const finish = () => {
  let mode = 0o600
  try {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) return ${SETTINGS_UNSAFE}
    mode = stat.mode & 0o777
  } catch (error) {
    if (!error || error.code !== 'ENOENT') return 1
  }
  const temp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp'
  // Only a temp file this write created is ever deleted: a name that was already taken is somebody else's.
  let created = false
  try {
    const early = held()
    if (early !== 'same') return early === 'unsafe' ? ${SETTINGS_UNSAFE} : ${SETTINGS_CHANGED}
    const fd = fs.openSync(temp, 'wx', mode)
    created = true
    try { fs.writeFileSync(fd, next) } finally { fs.closeSync(fd) }
    fs.chmodSync(temp, mode)
    const late = held()
    if (late !== 'same') {
      fs.unlinkSync(temp)
      return late === 'unsafe' ? ${SETTINGS_UNSAFE} : ${SETTINGS_CHANGED}
    }
    fs.renameSync(temp, file)
  } catch {
    if (created) try { fs.unlinkSync(temp) } catch {}
    return 1
  }
  try {
    const after = look()
    return after.kind === 'ok' && after.text === next ? 0 : after.kind === 'unsafe' ? ${SETTINGS_UNSAFE} : ${SETTINGS_CHANGED}
  } catch {
    return 1
  }
}
try {
  process.exitCode = withSettingsLock(finish)
} catch (error) {
  process.stderr.write(String(error && error.message || error) + '\\n')
  if (error && error.code === 'SETTINGS_LOCKED') process.stdout.write(lockPath)
  process.exitCode = error && error.code === 'SETTINGS_LOCKED' ? ${SETTINGS_LOCKED} : 1
}
`
