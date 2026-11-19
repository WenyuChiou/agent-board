import { expect } from 'claude-code/testing'
import { mailboxId } from '../hooks/hook-messages'
import { queueMessage } from '../hooks/messaging'
import { sha256 } from '../hooks/sha256'
import { EN, FILE, PANE, PROPS, engineBeneath, test } from './pane-helpers'
import type { World } from './pane-helpers'

// #1296: after Queue for next turn on the page, the page, --status and --json count the question as handled and
// say it is queued (#1339), but the Claude Code pane still counted it as waiting. The pane now reads the page's
// message store and counts it the same way. Synthetic data only.
const AT = Date.parse('2026-10-16T12:00:00.000Z')
const FIRST = '11111111-2222-4333-8444-555555555555'
const SECOND = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const block = (session: string, text: string, id: string): string =>
  `## Synthetic project ${id}\n<!-- auto session=${id} agent=codex resume=${session} state=waiting updated=2026-10-16T11:59:00Z -->\n### Synthetic task ${id}\n- [?] ${text}\n<!-- /auto session=${id} -->\n`
const BOARD = `# Progress\n\n${block(FIRST, 'Blue or green?', 'abcdef01')}\n${block(SECOND, 'Keep the draft?', 'abcdef02')}`
const mailbox = (session: string) => ({ id: mailboxId('codex', session), agent: 'codex', session, surface: 'CLI', turn: 'session' as const, scope: 'mailbox' as const, expires: AT + 3_600_000 })
// The page's own folder for this progress.md (scripts/runtime-folder.ts), with HOME=/home/me and no runtime folder.
const STORE = `/home/me/.cache/agent-board/agent-board-${sha256(FILE).slice(0, 16)}-messages/messages.json`
const stored = (): string => {
  const box = mailbox(FIRST)
  const queued = queueMessage({ messages: [], mailboxes: [mailbox(FIRST), mailbox(SECOND)] }, { id: 'SYNTHETIC-QUEUED-1', text: 'Blue', target: box.id, turn: 'session' }, 'board', box, AT)
  return JSON.stringify({ version: 2, ...queued.state })
}

test('#1296: the pane counts an answer queued for the next turn as handled and says it is queued, as the page does', async ($, on) => {
  const world: World = { files: new Map([[FILE, BOARD], [STORE, stored()]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(2100)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    expect(await ui.find({ type: 'Text', text: '● 1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `◌ ${EN.boardQueuedCount(1)}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '● 2' })).toBeUndefined()

    // The page's store leaves: every question waits again, at the next poll.
    world.files.delete(STORE)
    await clock.advance(2100)
    expect(await ui.find({ type: 'Text', text: '● 2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `◌ ${EN.boardQueuedCount(1)}` })).toBeUndefined()
  } finally { await ui.unmount() }
})

test('#1296: a store that is a link or not a plain file is not read, and every question waits', async ($, on) => {
  const world: World = { files: new Map([[FILE, BOARD], [STORE, stored()]]), unsafeFiles: new Set([STORE]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(2100)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    expect(await ui.find({ type: 'Text', text: '● 2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `◌ ${EN.boardQueuedCount(1)}` })).toBeUndefined()
  } finally { await ui.unmount() }
})
