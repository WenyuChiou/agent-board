import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCodexConnect } from './codex-connect.mjs'

// Preserve the existing import path while keeping bundled modules side-effect free.
export { connectCodexProxy } from './codex-proxy.mjs'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCodexConnect(['--codex-connect', ...process.argv.slice(2)])
}
