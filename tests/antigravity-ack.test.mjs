import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { bundleFromDir } from '../scripts/bundle-text.mjs'
import { hookOrDeferred } from './helpers/deferred-turn.mjs'

// The Antigravity turn-end hook reads the model's ACK line from the conversation's own transcript (#1416).
// The hooks run here as the real board script (the committed bundle) against a message store in a temporary
// folder. Nothing calls Antigravity, and every id, code and word is synthetic.
const session = 'synthetic-agy-ack-session'
const importTs = async path => {
  const resolver = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  } })
  try { return await import(path) } finally { resolver.deregister() }
}

// The two surfaces that run the hooks: the app (and the editor) write under `antigravity`, agy TUI under `antigravity-cli`.
const SURFACES = [['IDE', 'antigravity'], ['agy TUI', 'antigravity-cli']]

const fixture = async (folder, fn) => {
  const home = mkdtempSync(join(tmpdir(), 'agy-ack-'))
  try {
    const { defaultMessagesDirectory } = await importTs('../scripts/runtime-folder.ts')
    const { enrollMailbox } = await importTs('../hooks/hook-messages.ts')
    const { queueMessage } = await importTs('../hooks/messaging.ts')
    const root = join(home, '.agent-board')
    const script = join(root, 'agent-board.mjs')
    mkdirSync(root, { recursive: true })
    writeFileSync(script, bundleFromDir(new URL('..', import.meta.url)))
    const progress = join(root, 'progress.md')
    writeFileSync(progress, '')
    const env = {
      ...process.env, HOME: home, USERPROFILE: home, LANG: 'en', CI: '1', NO_COLOR: '1', AGENT_BOARD_SETUP_COMMAND: '',
      AGENT_BOARD_TEST_PID: String(process.pid), XDG_RUNTIME_DIR: join(home, 'runtime'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'),
    }
    const directory = defaultMessagesDirectory(progress, home, env, process.platform)
    const transcript = join(home, '.gemini', folder, 'brain', 'synthetic-conversation', '.system_generated', 'logs', 'transcript.jsonl')
    const call = event => spawnSync(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress,
      '--agent', 'antigravity', '--agent-status', '--state', event === 'Stop' || event === 'SessionStart' ? 'waiting' : 'working', '--event', event,
    ], { cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 15000,
      input: JSON.stringify({ conversationId: session, hook_event_name: event, transcriptPath: transcript }) })
    const state = () => JSON.parse(readFileSync(join(directory, 'messages.json'), 'utf8'))
    const seed = id => {
      let current
      try { current = state() } catch { current = { messages: [] } }
      const now = Date.now()
      const enrolled = enrollMailbox(current, 'antigravity', session, 'IDE', now, 43_200_000)
      const target = enrolled.mailboxes.find(one => one.agent === 'antigravity' && one.session === session)
      const queued = queueMessage(enrolled, { id, target: target.id, turn: 'session', text: 'Synthetic mailbox payload' }, 'board', target, now).state
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'messages.json'), JSON.stringify({ version: 2, ...queued }))
    }
    const one = id => state().messages.find(message => message.id === id)
    // A turn start that hands the message over (a slow store defers the first one by design).
    const handOver = async id => {
      await hookOrDeferred(() => call('PreInvocation'), () => one(id).status === 'accepted')
      assert.equal(one(id).status, 'accepted')
      return one(id).nonce
    }
    const say = (...replies) => {
      mkdirSync(dirname(transcript), { recursive: true })
      writeFileSync(transcript, [
        { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Synthetic prompt' },
        ...replies.map(content => ({ source: 'MODEL', type: 'PLANNER_RESPONSE', content })),
      ].map(line => JSON.stringify(line)).join('\n') + '\n')
    }
    // A turn end. A slow board defers the acknowledgement by design and the next turn end does it (the claim is kept).
    const stop = (id, isExpected) => {
      const first = call('Stop')
      assert.equal(first.status, 0, first.stderr)
      if (isExpected && one(id).status !== 'acknowledged') {
        assert.match(first.stderr, /^board: mailbox deferred$/m)
        const again = call('Stop')
        assert.equal(again.status, 0, again.stderr)
      }
    }
    await fn({ state, seed, one, handOver, say, stop })
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) }
}

for (const [surface, folder] of SURFACES) {
  test(`${surface}: a reply that starts with the ACK line of the message handed over in the turn marks it acknowledged, and only that line is kept`, () => fixture(folder, async f => {
    f.seed('first-message')
    const nonce = await f.handOver('first-message')
    f.say(`ACK ${nonce}\nGot it, I will use the text.`)
    f.stop('first-message', true)
    const message = f.one('first-message')
    assert.equal(message.status, 'acknowledged')
    assert.equal(message.reply, `ACK ${nonce}`)
    assert.ok(!JSON.stringify(f.state()).includes('Got it'))
  }))

  test(`${surface}: a reply without the ACK line, or with another message's code, changes nothing`, () => fixture(folder, async f => {
    // The control: the same turn end acknowledges a matching reply, so the cases below are not unchanged for want of a reader.
    f.seed('control-message')
    const control = await f.handOver('control-message')
    f.say(`ACK ${control}`)
    f.stop('control-message', true)
    assert.equal(f.one('control-message').status, 'acknowledged')
    for (const [id, make] of [
      ['no-line', () => 'Got it, done.'],
      ['another-code', () => 'ACK 0a0a0a\nGot it.'],
      ['line-not-first', nonce => `Got it.\nACK ${nonce}`],
    ]) {
      f.seed(id)
      const nonce = await f.handOver(id)
      f.say(make(nonce))
      f.stop(id, false)
      assert.equal(f.one(id).status, 'accepted', id)
      assert.equal(f.one(id).reply, '', id)
    }
  }))

  test(`${surface}: a turn that handed over no message changes nothing, even when its reply carries the code of an earlier one`, () => fixture(folder, async f => {
    f.seed('control-message')
    const control = await f.handOver('control-message')
    f.say(`ACK ${control}`)
    f.stop('control-message', true)
    assert.equal(f.one('control-message').status, 'acknowledged')
    // Turn 2 hands a message over and its reply has no line, so the turn ends with the claim spent.
    f.seed('second-message')
    const second = await f.handOver('second-message')
    f.say('Got it, no line.')
    f.stop('second-message', false)
    assert.equal(f.one('second-message').status, 'accepted')
    // Turn 3 hands nothing over; its reply cites turn 2's code.
    f.say(`ACK ${second}`)
    const before = JSON.stringify(f.state().messages)
    f.stop('second-message', false)
    assert.equal(JSON.stringify(f.state().messages), before)
  }))
}
