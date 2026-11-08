// The board server's own system notification (#1014): the per-platform command
// and the one-notification-per-question check, run on plain Node.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { markServerTold, serverNotifyCheck, serverNotifyCommand, serverNotifyDue } = await import('../hooks/notify.ts')
loader.deregister()

const ask = (overrides = {}) => ({
  key: 'ask:one',
  notifyKey: 'ask:aaaa',
  agent: 'codex',
  project: 'Synthetic',
  text: 'Ship it, OK?',
  ...overrides,
})

test('the server notification command is per platform and needs no new dependency', () => {
  const windows = serverNotifyCommand('win32', '進度 · Synthetic', 'codex 在問：Ship it, OK?')
  assert.equal(windows.command, 'powershell')
  assert.equal(windows.args[0], '-NoProfile')
  assert.equal(windows.args[1], '-Command')
  assert.match(windows.args[2], /ToastNotificationManager/)
  assert.match(windows.args[2], /進度 · Synthetic/)
  assert.match(windows.args[2], /codex 在問：Ship it, OK\?/)
  const mac = serverNotifyCommand('darwin', '進度 · Synthetic', 'codex 在問：Ship it, OK?')
  assert.deepEqual(mac, { command: 'osascript', args: ['-e', 'display notification "codex 在問：Ship it, OK?" with title "進度 · Synthetic"'] })
  assert.deepEqual(serverNotifyCommand('linux', '進度 · Synthetic', 'codex 在問：Ship it, OK?'), { command: 'notify-send', args: ['進度 · Synthetic', 'codex 在問：Ship it, OK?'] })
  assert.equal(serverNotifyCommand('freebsd', 'title', 'body'), null)
})

test('a quote in the words is escaped for the platform script', () => {
  const windows = serverNotifyCommand('win32', `it's`, `say 'hi'`)
  assert.match(windows.args[2], /it''s/)
  assert.match(windows.args[2], /say ''hi''/)
  const mac = serverNotifyCommand('darwin', 'say "hi"', 'back\\slash')
  assert.match(mac.args[1], /say \\"hi\\"/)
  assert.match(mac.args[1], /back\\\\slash/)
})

test('the server tells the person about a new waiting question once, never its own', () => {
  const now = Date.parse('2026-11-08T12:00:00Z')
  const first = ask()
  const own = ask({ key: 'ask:two', notifyKey: 'ask:bbbb', isOwn: true })
  const second = ask({ key: 'ask:three', notifyKey: 'ask:cccc', text: 'Merge it, OK?' })
  assert.deepEqual(serverNotifyDue([first, own, second], {}), [first, second])
  const after = serverNotifyCheck([first, own, second], {}, now, false)
  assert.deepEqual(after.due, [first, second])
  assert.equal(after.told['ask:aaaa'], now)
  assert.equal(after.told['ask:cccc'], now)
  assert.equal(after.told['ask:bbbb'], undefined)
  // Told once: the same questions are due no more.
  assert.deepEqual(serverNotifyCheck([first, own, second], after.told, now + 1000, false).due, [])
})

test('when a page that opted in is open, the server only marks the question told', () => {
  const now = Date.parse('2026-11-08T12:00:00Z')
  const first = ask()
  const after = serverNotifyCheck([first], {}, now, true)
  assert.deepEqual(after.due, [])
  assert.equal(after.told['ask:aaaa'], now)
  // The page has seen it, so the server does not tell it again after the tab closes.
  assert.deepEqual(serverNotifyCheck([first], after.told, now + 1000, false).due, [])
})

test('a question without a server key falls back to its board key', () => {
  const now = Date.parse('2026-11-08T12:00:00Z')
  const bare = ask({ notifyKey: undefined })
  const after = serverNotifyCheck([bare], {}, now, false)
  assert.deepEqual(after.due, [bare])
  assert.equal(after.told['ask:one'], now)
})

test('a told key older than three days is pruned, a waiting one is kept', () => {
  const now = Date.parse('2026-11-08T12:00:00Z')
  const old = now - 4 * 24 * 60 * 60 * 1000
  const told = markServerTold([ask()], { 'ask:stale': old }, now)
  assert.equal(told['ask:stale'], undefined)
  assert.equal(told['ask:aaaa'], now)
})
