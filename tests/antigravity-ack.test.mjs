import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
    // `fields` changes the hook's input, so a test can send a turn end without a transcript path.
    const call = (event, fields = {}) => spawnSync(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress,
      '--agent', 'antigravity', '--agent-status', '--state', event === 'Stop' || event === 'SessionStart' ? 'waiting' : 'working', '--event', event,
    ], { cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 15000,
      input: JSON.stringify({ conversationId: session, hook_event_name: event, transcriptPath: transcript, ...fields }) })
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
    // `fields` changes the hook's input, as `call` does (an invocation number other than the turn's first, for one).
    const handOver = async (id, fields = {}) => {
      await hookOrDeferred(() => call('PreInvocation', fields), () => one(id).status === 'accepted')
      assert.equal(one(id).status, 'accepted')
      return one(id).nonce
    }
    // A turn's entries are added to the end of the transcript, as Antigravity does.
    const append = (...entries) => {
      mkdirSync(dirname(transcript), { recursive: true })
      appendFileSync(transcript, entries.map(line => JSON.stringify(line)).join('\n') + '\n')
    }
    const say = (...replies) => append(
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Synthetic prompt' },
      ...replies.map(content => ({ source: 'MODEL', type: 'PLANNER_RESPONSE', content })),
    )
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
    await fn({ state, seed, one, handOver, say, append, stop, call, directory, root, transcript })
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
      ['blank-first-line', nonce => `\nACK ${nonce}`],
    ]) {
      f.seed(id)
      const nonce = await f.handOver(id)
      f.say(make(nonce))
      f.stop(id, false)
      assert.equal(f.one(id).status, 'accepted', id)
      assert.equal(f.one(id).reply, '', id)
    }
  }))

  test(`${surface}: an ACK the board could not take at the turn end is taken at the next turn end, even when that turn's reply says something else`, () => fixture(folder, async f => {
    f.seed('busy-message')
    const nonce = await f.handOver('busy-message')
    f.say(`ACK ${nonce}`)
    // The board's store is in use at this turn end: a server lock that names no process defers the acknowledgement.
    const lock = join(f.directory, 'server.lock')
    writeFileSync(lock, 'starting')
    const busy = f.call('Stop')
    assert.equal(busy.status, 0, busy.stderr)
    assert.match(busy.stderr, /^board: mailbox deferred$/m)
    assert.equal(f.one('busy-message').status, 'accepted')
    rmSync(lock)
    // The next turn hands nothing over and its reply is about something else; the kept acknowledgement goes through.
    f.say('Something else entirely.')
    await hookOrDeferred(() => f.call('Stop'), () => f.one('busy-message').status === 'acknowledged')
    assert.equal(f.one('busy-message').status, 'acknowledged')
    assert.equal(f.one('busy-message').reply, `ACK ${nonce}`)
  }))

  test(`${surface}: an ACK line followed by more than 256 KiB of the same turn is still read at the turn end`, () => fixture(folder, async f => {
    f.say('An earlier turn.')
    f.seed('long-turn')
    const nonce = await f.handOver('long-turn')
    f.say(`ACK ${nonce}`)
    f.append({ source: 'SYSTEM', type: 'TOOL_RESULT', content: 'x'.repeat(300 * 1024) }, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Done.' })
    f.stop('long-turn', true)
    assert.equal(f.one('long-turn').status, 'acknowledged')
    assert.equal(f.one('long-turn').reply, `ACK ${nonce}`)
  }))

  test(`${surface}: a turn end that cannot read the transcript keeps the claim, and the next turn end takes the ACK`, () => fixture(folder, async f => {
    f.seed('unread-message')
    const nonce = await f.handOver('unread-message')
    f.say(`ACK ${nonce}`)
    renameSync(f.transcript, `${f.transcript}.away`)
    const blind = f.call('Stop')
    assert.equal(blind.status, 0, blind.stderr)
    assert.match(blind.stderr, /^board: mailbox failed \(TRANSCRIPT_UNREADABLE\)$/m)
    assert.equal(f.one('unread-message').status, 'accepted')
    renameSync(`${f.transcript}.away`, f.transcript)
    f.say('A later turn about something else.')
    f.stop('unread-message', true)
    assert.equal(f.one('unread-message').status, 'acknowledged')
  }))

  test(`${surface}: a hand-over whose code cannot be kept in either folder is still accepted, and the hook says so`, () => fixture(folder, async f => {
    f.seed('unsaved-claim')
    // A file where each codes' folder goes makes both writes fail.
    writeFileSync(join(f.root, 'antigravity-acks'), 'not a folder')
    writeFileSync(`${f.directory}-acks`, 'not a folder')
    const result = await hookOrDeferred(() => f.call('PreInvocation'), () => f.one('unsaved-claim').status === 'accepted')
    assert.equal(f.one('unsaved-claim').status, 'accepted')
    assert.match(result.stderr, /^board: mailbox failed \(ACK_CLAIM_UNSAVED\)$/m)
  }))

  test(`${surface}: a hand-over whose code cannot be kept in the board folder keeps it beside the message store, and its ACK is taken`, () => fixture(folder, async f => {
    f.seed('second-place')
    writeFileSync(join(f.root, 'antigravity-acks'), 'not a folder')
    const result = await hookOrDeferred(() => f.call('PreInvocation'), () => f.one('second-place').status === 'accepted')
    assert.doesNotMatch(result.stderr, /ACK_CLAIM_UNSAVED/)
    const nonce = f.one('second-place').nonce
    f.say(`ACK ${nonce}`)
    f.stop('second-place', true)
    assert.equal(f.one('second-place').status, 'acknowledged')
  }))

  test(`${surface}: a turn end with no transcript path keeps the claim, and the next turn end takes the ACK`, () => fixture(folder, async f => {
    f.seed('no-path')
    const nonce = await f.handOver('no-path')
    f.say(`ACK ${nonce}`)
    const blind = f.call('Stop', { transcriptPath: undefined })
    assert.equal(blind.status, 0, blind.stderr)
    assert.match(blind.stderr, /^board: mailbox failed \(TRANSCRIPT_UNREADABLE\)$/m)
    assert.equal(f.one('no-path').status, 'accepted')
    f.stop('no-path', true)
    assert.equal(f.one('no-path').status, 'acknowledged')
  }))

  test(`${surface}: a claim kept after a turn end that could not read it is not acknowledged by a later turn citing its code`, () => fixture(folder, async f => {
    f.seed('kept-claim')
    const nonce = await f.handOver('kept-claim')
    f.say('Got it, no line.')
    renameSync(f.transcript, `${f.transcript}.away`)
    assert.match(f.call('Stop').stderr, /TRANSCRIPT_UNREADABLE/)
    renameSync(`${f.transcript}.away`, f.transcript)
    // A later turn hands nothing over; its reply cites the kept claim's code.
    f.say(`ACK ${nonce}`)
    const before = JSON.stringify(f.state().messages)
    f.stop('kept-claim', false)
    assert.equal(JSON.stringify(f.state().messages), before)
  }))

  test(`${surface}: a claim still kept does not move a later hand-over's reading window past its ACK`, () => fixture(folder, async f => {
    f.seed('older-claim')
    await f.handOver('older-claim')
    f.say('Got it, no line.')
    renameSync(f.transcript, `${f.transcript}.away`)
    assert.match(f.call('Stop').stderr, /TRANSCRIPT_UNREADABLE/)
    renameSync(`${f.transcript}.away`, f.transcript)
    // More than 8 MiB of later turns, then a new hand-over answered at once.
    f.append({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Synthetic prompt' }, { source: 'SYSTEM', type: 'TOOL_RESULT', content: 'x'.repeat(9 * 1024 * 1024) })
    f.seed('newer-claim')
    const nonce = await f.handOver('newer-claim')
    f.say(`ACK ${nonce}`)
    f.stop('newer-claim', true)
    assert.equal(f.one('newer-claim').status, 'acknowledged')
    assert.equal(f.one('older-claim').status, 'accepted')
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

  // #1622: the turn's input may be written before the hand-over (the order the live run shows). Such a turn ends at the next
  // USER_INPUT, so a turn with no reply whose turn end could not read the transcript is not acknowledged by the next turn.
  const input = { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Synthetic prompt' }
  const blindStop = f => {
    renameSync(f.transcript, `${f.transcript}.away`)
    assert.match(f.call('Stop').stderr, /^board: mailbox failed \(TRANSCRIPT_UNREADABLE\)$/m)
    renameSync(`${f.transcript}.away`, f.transcript)
  }

  test(`${surface}: a turn whose input came before the hand-over, with no reply and a turn end that cannot read the transcript, is not acknowledged by the next turn's ACK`, () => fixture(folder, async f => {
    f.say('An earlier turn.')
    f.append(input)
    f.seed('input-first')
    const nonce = await f.handOver('input-first')
    // The turn works but writes no reply, then its turn end cannot read the transcript, so the claim is kept.
    f.append({ source: 'SYSTEM', type: 'TOOL_RESULT', content: 'Synthetic tool output' }, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: '   ' })
    blindStop(f)
    assert.equal(f.one('input-first').status, 'accepted')
    // The next turn hands nothing over; its reply's first line is the kept claim's ACK line.
    f.say(`ACK ${nonce}`)
    const before = JSON.stringify(f.state().messages)
    f.stop('input-first', false)
    assert.equal(JSON.stringify(f.state().messages), before)
  }))

  test(`${surface}: a turn whose input came before the hand-over is acknowledged by its own reply, after a turn end that cannot read the transcript too`, () => fixture(folder, async f => {
    f.say('An earlier turn.')
    f.append(input)
    f.seed('input-first-ack')
    const nonce = await f.handOver('input-first-ack')
    f.append({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: `ACK ${nonce}` })
    blindStop(f)
    assert.equal(f.one('input-first-ack').status, 'accepted')
    f.say('A later turn about something else.')
    f.stop('input-first-ack', true)
    assert.equal(f.one('input-first-ack').status, 'acknowledged')
    assert.equal(f.one('input-first-ack').reply, `ACK ${nonce}`)
  }))

  test(`${surface}: a hand-over at a later invocation of a turn, with no reply after it and a turn end that cannot read the transcript, is not acknowledged by the next turn's ACK`, () => fixture(folder, async f => {
    f.say('The turn so far.')
    f.seed('mid-turn')
    const nonce = await f.handOver('mid-turn', { invocationNum: 1 })
    f.append({ source: 'SYSTEM', type: 'TOOL_RESULT', content: 'Synthetic tool output' })
    blindStop(f)
    assert.equal(f.one('mid-turn').status, 'accepted')
    f.say(`ACK ${nonce}`)
    const before = JSON.stringify(f.state().messages)
    f.stop('mid-turn', false)
    assert.equal(JSON.stringify(f.state().messages), before)
  }))
}
