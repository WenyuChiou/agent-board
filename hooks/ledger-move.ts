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
