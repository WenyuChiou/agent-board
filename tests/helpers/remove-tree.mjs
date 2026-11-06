import { rmSync } from 'node:fs'

const BUSY = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

// Node's rmSync maxRetries never retries an EBUSY from the top-level rmdir (a child
// that still holds the folder as its cwd on Windows), so retry the whole removal here.
export const removeTree = (path, { attempts = 10, delayMs = 100, remove = rmSync } = {}) => {
  for (let attempt = 1; ; attempt++) {
    try { return remove(path, { recursive: true, force: true }) } catch (error) {
      if (!BUSY.has(error.code) || attempt >= attempts) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
    }
  }
}
