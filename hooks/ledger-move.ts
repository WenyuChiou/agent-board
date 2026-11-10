// Node uses exit codes 1 to 14 for its own failures (5 is a fatal error), so these stay above that
// range: a Node failure must reach the move-command fallback, not read as "another ledger is there".
export const LINK_EXISTS = 70
export const LINK_UNSUPPORTED = 71
export const LINK_KEPT_SOURCE = 72

// The source belongs to this session, so removing it cannot delete another writer's ledger.
// Linking refuses an existing target and avoids a cold PowerShell start on Windows.
// Run it as `node -e LEDGER_LINK -- <from> <to>`: without `--`, a path that starts with a dash is
// read as a Node option. Node drops the `--`, so the two paths are argv[1] and argv[2].
export const LEDGER_LINK = `
const { linkSync, unlinkSync } = require('node:fs')
const [from, to] = process.argv.slice(1)
try {
  linkSync(from, to)
} catch (error) {
  process.exit(error?.code === 'EEXIST' ? ${LINK_EXISTS} : ${LINK_UNSUPPORTED})
}
try {
  unlinkSync(from)
} catch {
  process.exit(${LINK_KEPT_SOURCE})
}
`

// Renames many files in one Node start, so a batch of receipts does not pay a cold PowerShell
// start per file. `renameSync` replaces an existing target. A failed pair does not stop the rest;
// stdout names the failed pairs by index as JSON, for a person reading a log (the caller looks at
// the files instead). Run it as `node -e LEDGER_RENAMES -- from1 to1 from2 to2 …`.
export const LEDGER_RENAMES = `
const { renameSync } = require('node:fs')
const args = process.argv.slice(1), failed = []
for (let at = 0; at + 1 < args.length; at += 2) {
  try {
    renameSync(args[at], args[at + 1])
  } catch {
    failed.push(at / 2)
  }
}
process.stdout.write(JSON.stringify(failed))
`

export const PENDING_STAGE = `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto')
const [target] = process.argv.slice(1)
try {
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink() || !stat.isFile()) process.exit(1)
} catch (error) {
  if (error?.code !== 'ENOENT') process.exit(1)
}
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-pending-')))
fs.chmodSync(directory, 0o700)
const token = crypto.randomBytes(16).toString('hex'), file = path.join(directory, 'pending.json')
fs.writeFileSync(path.join(directory, '.owner'), token, { flag: 'wx', mode: 0o600 })
fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
process.stdout.write(JSON.stringify({ protocol: 1, directory, file, token }))
`

export const PENDING_COMMIT = `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto')
const [target, directoryRaw, token, digest] = process.argv.slice(1)
if (!/^[a-f0-9]{32}$/.test(token)) process.exit(1)
const directory = path.resolve(directoryRaw), temporary = fs.realpathSync(os.tmpdir())
const relative = path.relative(temporary, directory)
if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep) || !path.basename(directory).startsWith('agent-board-pending-') || fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) process.exit(1)
const file = path.join(directory, 'pending.json'), marker = path.join(directory, '.owner')
try {
  if (!/^[a-f0-9]{64}$/.test(digest) || fs.lstatSync(file).isSymbolicLink() || fs.lstatSync(marker).isSymbolicLink() || fs.readFileSync(marker, 'utf8') !== token) throw new Error('INVALID_PENDING_STAGE')
  const payload = fs.readFileSync(file, 'utf8')
  if (crypto.createHash('sha256').update(payload).digest('hex') !== digest) throw new Error('PENDING_DIGEST_CHANGED')
  try {
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('EEXIST')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const destTemp = target + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.board-tmp'
  let isOwned = false
  try {
    const fd = fs.openSync(destTemp, 'wx', 0o600)
    isOwned = true
    fs.closeSync(fd)
    fs.writeFileSync(destTemp, payload, { mode: 0o600 })
    fs.renameSync(destTemp, target)
  } catch (error) {
    if (isOwned) { try { fs.unlinkSync(destTemp) } catch {} }
    throw error
  }
} catch {
  process.exitCode = 1
} finally {
  if (fs.realpathSync(directory) === directory && !fs.lstatSync(directory).isSymbolicLink() && !fs.lstatSync(marker).isSymbolicLink() && fs.readFileSync(marker, 'utf8') === token) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
`

export type PendingStage = { protocol: 1; directory: string; file: string; token: string }
export const pendingStage = (value: unknown): PendingStage | null => {
  if (value === null || typeof value !== 'object') return null
  const stage = value as Partial<PendingStage>
  if (stage.protocol !== 1 || typeof stage.directory !== 'string' || !/^(?:[a-zA-Z]:[\\/]|\/)/.test(stage.directory) || !/[\\/]agent-board-pending-[^\\/]+$/.test(stage.directory) || typeof stage.file !== 'string' || typeof stage.token !== 'string' || !/^[a-f0-9]{32}$/.test(stage.token)) return null
  const normalized = stage.directory.replace(/\\/g, '/') + '/pending.json'
  if (stage.file.replace(/\\/g, '/') !== normalized) return null
  return stage as PendingStage
}
