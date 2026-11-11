// The plugin has no file access of its own beyond the host's, which follows links and waits on a
// FIFO. `/progress style` reads and writes the board's settings file through these two short Node
// scripts instead, the same rules as scripts/settings-file.ts (#1276): a link or a non-regular file is
// refused, the read does not wait for a writer, and the write is a new file renamed over the path, so
// it never goes through what the path points to. Run as `node -e SCRIPT -- <file> [<text>]`.
export const SETTINGS_UNSAFE = 71

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

// Exit 0 when written, ${SETTINGS_UNSAFE} when the path is a link or not a regular file (nothing written), 1 otherwise.
export const SETTINGS_WRITE = `
const fs = require('node:fs')
const [file, text] = process.argv.slice(1)
const finish = () => {
  try {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) return ${SETTINGS_UNSAFE}
  } catch (error) {
    if (!error || error.code !== 'ENOENT') return 1
  }
  const temp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp'
  try {
    fs.writeFileSync(temp, text, { flag: 'wx' })
    fs.renameSync(temp, file)
    return 0
  } catch {
    try { fs.unlinkSync(temp) } catch {}
    return 1
  }
}
process.exitCode = finish()
`
