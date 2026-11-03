import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const standard = /^(?:messages\.json|server\.lock|[^/\\]+\.tmp)$/
const claimName = /^\.message-claim-([1-9][0-9]*)-([a-f0-9]{32})\.json$/

// Read at most 513 bytes, without accepting links or a replaced file as evidence.
export const readMessageStoreFiles = directory => {
  const entries = []
  try {
    for (const name of readdirSync(directory)) {
      if (standard.test(name)) continue
      const file = join(directory, name)
      let fd
      try {
        const before = lstatSync(file)
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 512) throw new Error('unsafe claim')
        fd = openSync(file, 'r')
        const opened = fstatSync(fd)
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size > 512) throw new Error('changed claim')
        const buffer = Buffer.alloc(513)
        const count = readSync(fd, buffer, 0, buffer.length, 0)
        const after = lstatSync(file)
        if (count > 512 || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1) throw new Error('changed claim')
        entries.push({ name, bytes: buffer.subarray(0, count) })
      } catch {
        entries.push({ name, bytes: undefined })
      } finally { if (fd !== undefined) closeSync(fd) }
    }
  } catch { entries.push({ name: '<unreadable message folder>', bytes: undefined }) }
  return entries
}

export const messageStoreFileState = () => ({ stray: new Set(), pending: new Set(), verified: new Set(), observed: new Map() })

// A partial publication is provisional, never a pass. It must later become the
// exact canonical claim from a hub this run started, even across its crash test.
export const classifyMessageStoreFiles = (entries, ownedPids, previous = messageStoreFileState()) => {
  const next = { stray: new Set(previous.stray), pending: new Set(), verified: new Set(previous.verified), observed: new Map() }
  const present = new Set(entries.map(one => one.name))
  for (const name of previous.pending) if (!present.has(name)) next.stray.add(name)
  for (const { name, bytes } of entries) {
    const match = name.match(claimName)
    const pid = Number(match?.[1])
    if (!match || !Number.isSafeInteger(pid) || pid > 2147483647 || !ownedPids.has(pid)) { next.stray.add(name); continue }
    const expected = Buffer.from(JSON.stringify({ version: 1, pid, nonce: match[2] }) + '\n')
    if (bytes !== undefined && bytes.equals(expected)) {
      next.verified.add(name)
      next.observed.set(name, pid)
    } else if (bytes !== undefined && bytes.length < expected.length && expected.subarray(0, bytes.length).equals(bytes)) {
      next.pending.add(name)
    } else next.stray.add(name)
  }
  return next
}

export const isMessageStoreClean = (state, pid) => state.stray.size === 0 && state.pending.size === 0
  && state.observed.size === 1 && [...state.observed.values()][0] === pid
