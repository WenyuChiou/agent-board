// A queued lifecycle event needs one bounded follow-up even when no new prompt arrives.
// Generate this inside the existing worker so setup adds no service or receiving transport.
export const hookRecoverySource = (home: string, script: string, dataRoot?: string): string => String.raw`
const recoveryRoot = ${dataRoot === undefined ? `path.dirname(${JSON.stringify(script)})` : JSON.stringify(dataRoot)}
const recoveryProgress = value('--progress-file')
const recoveryToken = value('--recovery-token')
const recoveryPrevious = value('--recovery-previous') ?? recoveryToken
const recoveryName = () => {
  if (typeof recoveryProgress !== 'string' || !recoveryProgress || recoveryProgress.length > 4096) throw Error('RECOVERY_ARGUMENT')
  const normalized = path.resolve(recoveryProgress)
  return path.join(recoveryRoot, 'hook-recovery-' + createHash('sha256').update(process.platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex') + '.json')
}
const readRecoveryClaim = file => {
  let fd
  try {
    const before = fs.lstatSync(file)
    if (!before.isFile() || before.nlink !== 1 || before.size > 2048) throw Error('UNSAFE_RECOVERY_CLAIM')
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const actual = fs.fstatSync(fd)
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino || actual.size > 2048) throw Error('UNSAFE_RECOVERY_CLAIM')
    const bytes = Buffer.alloc(2049), count = fs.readSync(fd, bytes, 0, bytes.length, 0)
    if (count > 2048 || count !== actual.size) throw Error('RECOVERY_CLAIM_CHANGED')
    const text = bytes.subarray(0, count).toString('utf8'), owner = JSON.parse(text)
    const after = fs.lstatSync(file)
    if (!after.isFile() || after.dev !== actual.dev || after.ino !== actual.ino || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs) throw Error('RECOVERY_CLAIM_CHANGED')
    if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !/^[a-f0-9]{32}$/.test(owner.token) || !Number.isSafeInteger(owner.created) || owner.created < 0 || owner.created > Date.now() + 60000) throw Error('INVALID_RECOVERY_CLAIM')
    return { ...owner, text, dev: actual.dev, ino: actual.ino }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}
const releaseRecovery = (file, token) => {
  const owner = readRecoveryClaim(file)
  if (owner?.token === token && owner.pid === process.pid) fs.unlinkSync(file)
}
const createRecoveryClaim = (file, created) => {
  const token = randomUUID().replaceAll('-', '')
  let fd
  try {
    fd = fs.openSync(file, 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid, token, created }))
    return token
  } catch (error) { if (error.code === 'EEXIST') return null; throw error }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}
const requestRecovery = () => {
  let file, token
  try {
    file = recoveryName()
    fs.mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 })
    const created = Date.now()
    token = createRecoveryClaim(file, created)
    let previous = token
    if (token === null) {
      const owner = readRecoveryClaim(file)
      if (owner === null) {
        token = createRecoveryClaim(file, created)
        previous = token
        if (token === null) return
      } else {
        if (created - owner.created < 30000) return
        let isDead = false
        try { process.kill(owner.pid, 0) } catch (error) {
          if (error.code !== 'ESRCH') throw Error('RECOVERY_OWNER_UNVERIFIED')
          isDead = true
        }
        if (!isDead) return
        // The board's existing write lock decides which candidate may replace this token.
        previous = owner.token
        token = randomUUID().replaceAll('-', '')
      }
    }
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--recover-pending', '--recovery-token', token, '--recovery-previous', previous, '--recovery-created', String(created), '--progress-file', recoveryProgress, '--agent', safeAgent], { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', () => {
      try { releaseRecovery(file, token) } catch {}
      hookError('HOOK_RECOVERY_NEEDED')
    })
    child.unref()
  } catch {
    if (file && token) { try { releaseRecovery(file, token) } catch {} }
    hookError('HOOK_RECOVERY_NEEDED')
  }
}
const recoverPending = () => {
  let file, token = recoveryToken, previous = recoveryPrevious
  try {
    file = recoveryName()
    const owner = readRecoveryClaim(file)
    if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token) || typeof previous !== 'string' || !/^[a-f0-9]{32}$/.test(previous)) throw Error('RECOVERY_OWNERSHIP')
    if (owner === null || owner.token !== previous && owner.token !== token) return
    const created = Number(value('--recovery-created') ?? owner.created)
    if (!Number.isSafeInteger(created) || created < 0 || created > Date.now() + 1000) throw Error('RECOVERY_ARGUMENT')
    // Count launch delay too; a suspended child must not renew an expired job.
    const deadline = Math.min(created + 8000, Math.floor(performance.timeOrigin) + 8000)
    if (Date.now() >= deadline) throw Error('RECOVERY_EXPIRED')
    const hasQueued = () => {
      const pending = path.join(recoveryRoot, 'pending')
      let names
      try { names = fs.readdirSync(pending).filter(name => name.endsWith('.json')) }
      catch (error) { if (error.code === 'ENOENT') return false; throw error }
      for (const name of names) {
        if (Date.now() >= deadline) return true
        const one = path.join(pending, name)
        try {
          if (fs.statSync(one).size > 2097152) return true
          const text = fs.readFileSync(one, 'utf8')
          if (Buffer.byteLength(text) > 2097152) return true
          const entry = JSON.parse(text)
          const at = Array.isArray(entry.argv) ? entry.argv.indexOf('--progress-file') : -1
          const selected = entry.kind === 'raw' && at >= 0 ? entry.argv[at + 1] : entry.progress
          if (typeof selected !== 'string' || path.resolve(selected) === path.resolve(recoveryProgress)) return true
        } catch (error) { if (error.code !== 'ENOENT') return true }
      }
      return false
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const available = Math.min(2000, deadline - Date.now())
      if (available < 400) break
      const result = spawnSync(process.execPath, [${JSON.stringify(script)}, '--recover-hooks', '--home', ${JSON.stringify(home)}, '--data-dir', recoveryRoot, '--progress-file', recoveryProgress, '--hook-deadline', String(Date.now() + available - 200), '--recovery-owner-token', token, '--recovery-previous-token', previous, '--recovery-owner-pid', String(process.pid), '--recovery-owner-created', String(created)], {
        input: '', encoding: 'utf8', windowsHide: true, timeout: available, killSignal: 'SIGKILL', maxBuffer: 65536,
      })
      let outcome
      try { if (!result.error && result.status === 0 && !result.signal) outcome = JSON.parse(result.stdout) } catch {}
      if (outcome?.recoveryVersion !== 1 || !Number.isSafeInteger(outcome.processed) || outcome.processed < 0 || !Number.isSafeInteger(outcome.pending) || outcome.pending < 0) throw Error('RECOVERY_FAILED')
      if (outcome.owner === 'coalesced') return
      if (outcome.owner === 'busy') continue
      if (outcome.owner !== 'owned') throw Error('RECOVERY_OWNERSHIP')
      previous = token
      if (outcome.pending === 0) {
        releaseRecovery(file, token)
        token = undefined
        // An arrival while this marker was held must not wait for another prompt.
        if (!hasQueued()) return
        if (attempt >= 2 || Date.now() >= deadline) break
        token = createRecoveryClaim(file, created)
        if (token === null) return
        previous = token
      }
    }
    hookError('HOOK_RECOVERY_NEEDED')
  } catch { hookError('HOOK_RECOVERY_NEEDED') }
  finally { if (file && token) { try { releaseRecovery(file, token) } catch { hookError('HOOK_RECOVERY_NEEDED') } } }
}
`
