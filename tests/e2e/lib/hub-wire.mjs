import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const pause = ms => new Promise(done => setTimeout(done, ms))
const isAlive = pid => {
  try { process.kill(pid, 0); return true } catch { return false }
}

// Ends a --serve process without letting it clean up, as a crash would. It is ended only while the
// world's address file still names its pid and address (as the soak ends its page server), so a pid
// the system gave to another program is never touched. True once the process is gone.
export const killServe = async server => {
  if (!server.isOwned()) return false
  process.kill(server.pid, 'SIGKILL')
  // Up to 20 seconds: a loaded Windows runner can take more than a few to reap a killed process.
  for (let waited = 0; waited < 400 && isAlive(server.pid); waited += 1) await pause(50)
  return !isAlive(server.pid)
}

// What the hub calls finished (docs/MESSAGING.md): acknowledged, rejected, or uncertain with the
// error EXPIRED or DISMISSED. Written out here, so a store check does not lean on the code it checks.
export const isFinishedRecord = one => ['acknowledged', 'rejected'].includes(one.status) || one.status === 'uncertain' && ['EXPIRED', 'DISMISSED'].includes(one.error)

const hex = text => createHash('sha256').update(text).digest('hex')
const KINDS = [
  { status: 'acknowledged', error: '' },
  { status: 'rejected', error: 'DISCONNECTED' },
  { status: 'uncertain', error: 'EXPIRED' },
  { status: 'uncertain', error: 'DISMISSED' },
]

// One finished message as the hub saves it (store version 2): its text gone, its hash kept. Each is
// a second older than the one before, so when the hub keeps only the newest 1,000 the highest numbers go first.
export const finishedRecord = (index, now) => {
  const kind = KINDS[index % KINDS.length]
  // An acknowledged or expired message was handed out; a dismissed or rejected one here never was.
  const nonce = kind.status === 'acknowledged' || kind.error === 'EXPIRED' ? (0xa00000 + index).toString(16) : ''
  const updated = now - index * 1000
  return {
    id: `AB-seed-${index}`, target: hex(`target ${index % 50}`).slice(0, 32), turn: 'seed-turn',
    from: 'board', to: `codex:seed-session-${index % 50}`, text: '', hash: hex(`synthetic message ${index}`),
    origin: 'local', status: kind.status, updated, reply: kind.status === 'acknowledged' ? `ACK ${nonce}` : '', error: kind.error,
    hops: 1, claimed: nonce ? updated - 500 : 0, nonce,
  }
}

export const seedStore = (directory, messages) => writeFileSync(join(directory, 'messages.json'), JSON.stringify({ version: 2, messages }))
// On Windows a read can meet the hub's rename of the file; it tries again for a moment first.
export const readStore = directory => {
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(readFileSync(join(directory, 'messages.json'), 'utf8')).messages } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
}
