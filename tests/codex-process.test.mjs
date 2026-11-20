import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(specifier + '.ts', context)
  }
} })

// The Codex process record (#1092, M7): on Linux the board script walks up from
// the hook to the Codex terminal by reading /proc, never by starting a process.
// The layout is from docs/validation/2026-11-18-c1-codex-terminal-process.md:
// terminal codex -> hook shell -> hook worker (node) -> board script (node), and
// on the shared-server route the chain reaches `codex app-server` instead.
const { codexTerminalPid, procEntryOf } = await import('../hooks/codex-process.ts')

// A fake /proc: pid -> { comm, ppid, argv }.
const procOf = table => pid => table[pid] ?? null

test('the walk finds the in-process Codex terminal above the hook shell and the hook worker', () => {
  const read = procOf({
    400: { comm: 'node', ppid: 300, argv: ['node', '/home/u/.claude/agent-board-hook.mjs'] },
    300: { comm: 'sh', ppid: 200, argv: ['/bin/sh', '-c', 'node hook.mjs'] },
    200: { comm: 'codex', ppid: 100, argv: ['/usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex'] },
    100: { comm: 'node', ppid: 50, argv: ['node', '/usr/bin/codex'] },
    50: { comm: 'bash', ppid: 1, argv: ['-bash'] },
  })
  assert.equal(codexTerminalPid(400, read), 200)
})

test('the walk stops and names no process when it reaches the shared server, even with a terminal above it', () => {
  const read = procOf({
    400: { comm: 'node', ppid: 300, argv: ['node', 'hook.mjs'] },
    300: { comm: 'sh', ppid: 200, argv: ['/bin/sh', '-c', 'node hook.mjs'] },
    200: { comm: 'codex', ppid: 150, argv: ['/opt/codex/codex', 'app-server', '--listen', 'unix'] },
    150: { comm: 'codex', ppid: 1, argv: ['/opt/codex/codex'] },
  })
  assert.equal(codexTerminalPid(400, read), null)
})

test('a process is never taken by its name alone: the npm launcher and a script called codex are refused', () => {
  // Only the npm launcher (node running the codex.js shim) is in the chain: no terminal.
  const launcherOnly = procOf({
    400: { comm: 'node', ppid: 300, argv: ['node', 'hook.mjs'] },
    300: { comm: 'node', ppid: 1, argv: ['node', '/usr/lib/node_modules/@openai/codex/bin/codex.js'] },
  })
  assert.equal(codexTerminalPid(400, launcherOnly), null)
  // A shell whose argv mentions codex is a shell, not the terminal.
  const shell = procOf({
    400: { comm: 'node', ppid: 300, argv: ['node', 'hook.mjs'] },
    300: { comm: 'bash', ppid: 1, argv: ['bash', '-c', 'codex'] },
  })
  assert.equal(codexTerminalPid(400, shell), null)
  // comm says codex but the program is something else.
  const renamed = procOf({
    400: { comm: 'node', ppid: 300, argv: ['node', 'hook.mjs'] },
    300: { comm: 'codex', ppid: 1, argv: ['/usr/bin/python3', 'codex'] },
  })
  assert.equal(codexTerminalPid(400, renamed), null)
})

test('an unreadable process, pid 1, a loop or a very deep chain names no process', () => {
  assert.equal(codexTerminalPid(400, procOf({ 400: { comm: 'node', ppid: 300, argv: ['node'] } })), null)
  assert.equal(codexTerminalPid(400, procOf({ 400: { comm: 'node', ppid: 1, argv: ['node'] } })), null)
  assert.equal(codexTerminalPid(1, procOf({})), null)
  assert.equal(codexTerminalPid(0, procOf({})), null)
  assert.equal(codexTerminalPid(400, procOf({ 400: { comm: 'node', ppid: 401, argv: ['node'] }, 401: { comm: 'sh', ppid: 400, argv: ['sh'] } })), null)
  const deep = {}
  for (let pid = 1000; pid < 1100; pid += 1) deep[pid] = { comm: 'sh', ppid: pid + 1, argv: ['sh'] }
  deep[1100] = { comm: 'codex', ppid: 1, argv: ['/opt/codex/codex'] }
  assert.equal(codexTerminalPid(1000, procOf(deep)), null)
})

test('/proc text is read as the kernel writes it, including a command name with spaces and brackets', () => {
  assert.deepEqual(procEntryOf('200 (codex) S 100 200 100 0 -1 4194560', '/opt/codex/codex\0'), { comm: 'codex', ppid: 100, argv: ['/opt/codex/codex'] })
  assert.deepEqual(procEntryOf('300 (a (b) c) S 7 300', 'x\0y\0'), { comm: 'a (b) c', ppid: 7, argv: ['x', 'y'] })
  assert.equal(procEntryOf('garbage', ''), null)
  assert.equal(procEntryOf('5 (x) S notanumber', 'x\0'), null)
})

test('a SessionStart or UserPromptSubmit replaces a Codex block\'s record with what its own hook saw; anything else keeps it', async () => {
  const { codexClaimOf } = await import('../hooks/codex.ts')
  const host = 'a'.repeat(64)
  const named = { pid: 11, started: 1000, host }
  const seen = { pid: 22, started: 2000, host }
  // An opening event with a record writes it; one whose walk found none (Windows, the shared server) clears the old one,
  // so a session that moved to the shared server is never judged by a process it no longer runs in.
  assert.deepEqual(codexClaimOf({ event: 'SessionStart', seen, named }), seen)
  assert.deepEqual(codexClaimOf({ event: 'UserPromptSubmit', seen, named }), seen)
  assert.equal(codexClaimOf({ event: 'SessionStart', seen: null, named }), null)
  assert.equal(codexClaimOf({ event: 'UserPromptSubmit', seen: null, named }), null)
  // An opening event with nothing seen (a raw replay the board script never ran for) clears it too: when in doubt, no verdict.
  assert.equal(codexClaimOf({ event: 'SessionStart', seen: undefined, named }), null)
  // Other events and a report keep the block's own record.
  for (const event of ['Stop', 'PermissionRequest', 'Interrupt', 'SessionEnd', undefined]) assert.deepEqual(codexClaimOf({ event, seen: undefined, named }), named)
})

test('a Codex block keeps its process record in progress.md, and the board judges it like Claude Code\'s', async () => {
  const { putCodexBlock } = await import('../hooks/codex.ts')
  const { CLAIMING_AGENTS } = await import('../hooks/session-liveness.ts')
  assert.equal(CLAIMING_AGENTS.has('codex'), true)
  const owner = 'b'.repeat(64)
  const host = 'c'.repeat(64)
  const report = { version: 1, agent: 'codex', session: 'codex-session-1092', project: 'demo', title: 'Ship it', state: 'waiting', updated: '2026-11-19T12:00:00Z', steps: ['- [?] Deploy, OK?'], events: [], retiredTurns: [] }
  const text = putCodexBlock('', report, owner, false, undefined, value => value, { pid: 4242, started: 1_700_000_000_000, host })
  assert.match(text, / agentpid=4242 agentstarted=1700000000000 host=c{64} -->/)
})
