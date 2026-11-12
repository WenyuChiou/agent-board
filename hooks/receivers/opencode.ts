import { SURFACE_IDS } from '../messaging.ts'
import type { Strings } from '../i18n.ts'

// OpenCode receives a board message in its own process (#724). The agent-board-local plugin keeps each
// top-level session's board mailbox open, so that session's card has a Send box. While the session is
// busy the plugin holds the message; when the session goes idle (session.idle) it takes the message
// through the board script and wakes the session with client.session.promptAsync, which returns at once
// (OpenCode 1.19.3, docs/validation/2026-11-12-opencode-f9-wake.md). The message is then marked as
// accepted by the transport only; it becomes acknowledged when the model calls agent_board_ack. A
// subagent's session (it has a parent) is never registered, so it never receives one. Nothing here reads
// the conversation.
export const messagingReceiver = {
  host: 'OpenCode',
  agent: 'opencode',
  kind: 'mailbox',
  // The plugin cannot tell the terminal, the desktop app and the web page apart, so all three share the
  // generic CLI surface id. No plugin run on any of them is recorded yet.
  surfaces: [{ name: 'CLI TUI', id: SURFACE_IDS.cli, evidence: null }, { name: 'Desktop App', id: SURFACE_IDS.cli, evidence: null }, { name: 'Web UI', id: SURFACE_IDS.cli, evidence: null }],
  tier: 1,
  primitive: '[P1]',
  isImplemented: true,
  // Idle: promptAsync woke an idle headless session (F9), but no run of this plugin is recorded, so no
  // record is named and the card keeps Copy. Working: the plugin holds the message until session.idle
  // (tests only). Ended: no mailbox.
  routes: {
    idle: { line: 'now', record: null, surfaces: [SURFACE_IDS.cli] },
    working: { line: 'stepEnd', record: null, surfaces: [SURFACE_IDS.cli] },
    ended: { line: 'none', record: null, surfaces: [SURFACE_IDS.cli] },
  },
}

// The receiver's part of the generated plugin: module-level code that the plugin's event and chat.message
// handlers feed through note(session, 'working' | 'waiting' | 'ended'), and whose tools the plugin's tool
// map spreads in. It uses the plugin's own hookError and tool. Only top-level sessions are ever noted.
// The words the model reads (tool descriptions, replies, the ack note) come from the string tables, chosen by the caller.
export type OpencodeWords = Pick<Strings, 'opencodeSendTool' | 'opencodeAckTool' | 'opencodeSent' | 'opencodeAcknowledged' | 'opencodeAckNote'>
export const opencodeReceiverSource = (node: string, board: string, progress: string, home: string, words: OpencodeWords): string => `import { spawn as spawnBoard } from 'node:child_process'
import { existsSync as boardFolderExists, readFileSync as readBoardStore, watch as watchBoard } from 'node:fs'
import { join as joinBoard } from 'node:path'
// One call to the board script's --mailbox; its one JSON line, or null when it failed or took too long.
const boardCall = (action, session, directory, extra = []) => new Promise(resolve => {
  let child, timer, output = ''
  const finish = value => { clearTimeout(timer); resolve(value) }
  try {
    child = spawnBoard(${JSON.stringify(node)}, [${JSON.stringify(board)}, '--mailbox', action, '--agent', 'opencode', '--home', ${JSON.stringify(home)}, '--progress-file', ${JSON.stringify(progress)}, '--session', session, '--surface', 'CLI', ...(typeof directory === 'string' && directory !== '' ? ['--cwd', directory] : []), ...extra], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  } catch { return resolve(null) }
  timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} resolve(null) }, 15000)
  child.on('error', () => finish(null))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { if (output.length < 262144) output += chunk })
  child.on('close', code => {
    try { finish(code === 0 ? JSON.parse(output.trim().split(/\\r?\\n/).pop()) : null) } catch { finish(null) }
  })
})
const WORDS = ${JSON.stringify({ send: words.opencodeSendTool, ack: words.opencodeAckTool, sent: words.opencodeSent, acknowledged: words.opencodeAcknowledged, note: words.opencodeAckNote })}
const toB64 = text => Buffer.from(String(text), 'utf8').toString('base64')
const boardReceiver = (client, directory) => {
  // A session is known only after the plugin saw it report as a top-level session; idle or busy as of its last event.
  const roots = new Map(), taking = new Set(), failing = new Set(), again = new Set(), stashed = new Map(), given = new Set(), uncertain = new Set(), versions = new Map(), retries = new Map()
  let watcher = null, folder = null, pending = null, timer = null, ticks = 0
  const isDeliverable = message => {
    if (folder === null) return true
    let store
    try { store = JSON.parse(readBoardStore(joinBoard(folder, 'messages.json'), 'utf8')) } catch { return false }
    const live = Array.isArray(store?.messages) && store.messages.find(one => one?.id === message.id)
    return Boolean(live && live.status === 'uncertain' && live.nonce === message.nonce && (!live.error || live.error === ''))
  }
  const accept = (session, message) => boardCall('accept', session, directory, ['--id', message.id, '--nonce', message.nonce, '--awaits-ack'])
  // The host's own view of a session. OpenCode lists only sessions that are not idle (F9: \`{}\` for an idle
  // one), so a lookup that answers with no entry means idle; a failed lookup, an error answer or an entry of
  // no known shape leaves it unknown. A host without the lookup is left to the last event.
  const hostState = async session => {
    if (typeof client?.session?.status !== 'function') return 'idle'
    let live
    try { live = await client.session.status({}) } catch { return 'unknown' }
    if (live?.error || live?.data == null || typeof live.data !== 'object') return 'unknown'
    const entry = live.data[session]
    if (entry === undefined) return 'idle'
    if (!entry || typeof entry.type !== 'string') return 'unknown'
    return entry.type === 'idle' ? 'idle' : 'busy'
  }
  // Whether the session's own messages hold the wake: a user part naming the message id (the ack note does).
  // null when the host cannot say, which holds the message instead of waking the session a second time.
  const reached = async (session, message) => {
    let listed
    try { listed = await client.session.messages({ path: { id: session } }) } catch { return null }
    if (listed?.error || !Array.isArray(listed?.data)) return null
    return listed.data.some(one => one?.info?.role === 'user' && Array.isArray(one.parts) && one.parts.some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.includes(message.id)))
  }
  const newRef = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, '0')).join('')
  // What the receiver must try again on its own clock, with one one-shot timer per session: a take, release or
  // accept that failed, and a wake whose answer was lost. Nothing else would come back for it, since a board
  // write or the tick may be minutes away. The wait doubles from 2 s to 60 s until a delivery goes through.
  const retryLater = (session, wait) => {
    const entry = retries.get(session) ?? { timer: null, delay: 2000 }
    retries.set(session, entry)
    if (entry.timer !== null) {
      // A named wait (a lookup, a lease) replaces a longer backoff; a backoff never replaces a timer.
      if (wait === undefined) return
      clearTimeout(entry.timer)
    }
    const after = wait ?? entry.delay
    if (wait === undefined) entry.delay = Math.min(entry.delay * 2, 60000)
    entry.timer = setTimeout(() => { entry.timer = null; heal(session) }, after)
    entry.timer.unref?.()
  }
  const calm = session => { const entry = retries.get(session); if (entry !== undefined) entry.delay = 2000 }
  // A message this receiver still has to settle for a session. The claim is on the board's side; this only remembers it.
  const hold = (session, message, ref, isLookup = false) => {
    stashed.set(session, { message, ref, isLookup })
    retryLater(session)
  }
  const deliver = async (session, whileBusy = false) => {
    const known = roots.get(session)
    // A busy session is looked at only for what it already holds: events say when to look, the host says what is true.
    if (known === undefined || known !== 'idle' && !(whileBusy && stashed.has(session))) return
    // Every busy or ended event bumps the session's version, so an answer that began before it can be told from a current one.
    const version = versions.get(session) ?? 0
    const isStale = () => (versions.get(session) ?? 0) !== version || roots.get(session) !== 'idle'
    // A message the board writes while a take is under way is taken right after it, not at the next tick.
    if (taking.has(session)) { again.add(session); return }
    taking.add(session)
    try {
      const kept = stashed.get(session)
      let message, ref = null
      if (kept !== undefined) {
        stashed.delete(session)
        if (!isDeliverable(kept.message)) return
        message = kept.message
        ref = kept.ref
      } else {
        // The host is asked before the take: a busy or unknown session claims nothing, so no claim waits out a long turn.
        const state = await hostState(session)
        if (!roots.has(session)) return
        if (isStale()) return
        if (state === 'busy') roots.set(session, 'busy')
        if (state !== 'idle') return
        ref = newRef()
        const taken = await boardCall('take', session, directory, ['--ref', ref])
        // A board script that is missing, fails or does not answer keeps the card from offering Send; it says so
        // with ok false, which is not the same as an empty mailbox. It is logged once, until a call works again,
        // so a timer that keeps asking does not fill the log.
        if (taken === null || typeof taken !== 'object' || taken.ok === false) {
          if (!failing.has(session)) { failing.add(session); hookError('MAILBOX_FAILED') }
          retryLater(session)
          return
        }
        failing.delete(session)
        if (typeof taken.watch === 'string') follow(taken.watch)
        message = taken.message
      }
      if (message == null) { calm(session); return }
      if (typeof message.text !== 'string' || typeof message.id !== 'string' || typeof message.nonce !== 'string') throw new Error('MAILBOX_FAILED')
      // A session that closed meanwhile does not get it: the claim runs out and the board hands it out again.
      if (!roots.has(session)) return
      // Given once: a message this process already handed over only has its acceptance retried. When the wake's
      // answer was lost, the session's own messages say whether it arrived. This needs no idle session.
      if (given.has(message.id)) {
        if (uncertain.has(message.id)) {
          const found = await reached(session, message)
          if (!roots.has(session)) return
          if (found === null) { hold(session, message, ref, true); return }
          if (found) uncertain.delete(message.id)
          else if (kept?.isLookup === true) {
            // A miss proves nothing yet, since the host may list the wake late. Only the board handing the message
            // out again after its lease means the wake did not arrive; this looks again then.
            retryLater(session, 35000)
            return
          } else {
            uncertain.delete(message.id)
            given.delete(message.id)
          }
        }
        if (given.has(message.id)) {
          if ((await accept(session, message))?.ok !== true) { hold(session, message, ref); throw new Error('MAILBOX_FAILED') }
          calm(session)
          return
        }
      }
      // It became busy while the message was being taken: give the claim back, or a long turn would expire it.
      // If the board cannot take it back, hold it and try the release again until the session is idle.
      if (isStale()) {
        if (ref !== null && (await boardCall('release', session, directory, ['--ref', ref]))?.ok === true) return
        hold(session, message, ref)
        return
      }
      // A message held earlier was not covered by the check before the take: the host's own view wins over the last event.
      if (kept !== undefined) {
        const state = await hostState(session)
        if (!roots.has(session)) return
        if (!isStale() && state === 'busy') roots.set(session, 'busy')
        if (state !== 'idle' || isStale()) { hold(session, message, ref); return }
      }
      roots.set(session, 'busy')
      given.add(message.id)
      if (given.size > 200) given.delete(given.values().next().value)
      let woke = null, lost = false
      try {
        woke = await client.session.promptAsync({ path: { id: session }, body: { parts: [{ type: 'text', text: message.text + '\\n\\n' + WORDS.note.split('{id}').join(message.id).split('{nonce}').join(message.nonce) }] } })
      } catch { lost = true }
      if (lost) {
        // The answer was lost, so the wake may have arrived: it stays given. A miss now is not a verdict (the host
        // may list the wake late), so the message is looked for again in 2 s and the board's lease decides after that.
        uncertain.add(message.id)
        const found = await reached(session, message)
        if (found !== true) {
          stashed.set(session, { message, ref, isLookup: true })
          retryLater(session, 2000)
          throw new Error('MAILBOX_FAILED')
        }
        uncertain.delete(message.id)
      } else if (woke?.error) {
        // Not handed over: the claim goes back at once, so the board does not hand it out again as a repeat.
        // The session stays marked busy until the host says otherwise, so a refusal that repeats backs off.
        given.delete(message.id)
        if (ref === null || (await boardCall('release', session, directory, ['--ref', ref]))?.ok !== true) stashed.set(session, { message, ref, isLookup: false })
        retryLater(session)
        throw new Error('MAILBOX_FAILED')
      }
      // Given first, then marked accepted: if the mark fails, the claim runs out and the session may get the
      // same message again, which beats losing it. Accepted is only the transport; the model's ack upgrades it.
      if ((await accept(session, message))?.ok !== true) { hold(session, message, ref); throw new Error('MAILBOX_FAILED') }
      calm(session)
    } catch { hookError('MAILBOX_FAILED') }
    finally {
      taking.delete(session)
      if (again.delete(session)) deliver(session)
    }
  }
  // A retry or the tick: a session marked busy is checked against the host first, since a lost idle event would
  // leave it busy until its next event. A host that cannot list its sessions is left to the events.
  const heal = async session => {
    if (roots.get(session) === 'busy' && typeof client?.session?.status === 'function') {
      const version = versions.get(session) ?? 0
      const state = await hostState(session)
      if (roots.get(session) === 'busy' && (versions.get(session) ?? 0) === version && state === 'idle') roots.set(session, 'idle')
    }
    await deliver(session, true)
  }
  // The board rewrites messages.json whenever it queues a message: an idle session with one waiting takes it.
  const check = () => {
    let store
    try { store = JSON.parse(readBoardStore(joinBoard(folder, 'messages.json'), 'utf8')) } catch { return }
    const waiting = new Set((Array.isArray(store?.messages) ? store.messages : []).filter(one => one?.status === 'queued' && typeof one.to === 'string').map(one => one.to))
    for (const session of roots.keys()) if (waiting.has('opencode:' + session) || stashed.has(session)) deliver(session)
  }
  const follow = directoryToWatch => {
    if (watcher !== null && folder === directoryToWatch) return
    try { watcher?.close() } catch {}
    watcher = null
    folder = directoryToWatch
    try {
      const current = watchBoard(directoryToWatch, { persistent: false }, (_event, name) => {
        // On Windows the watcher of a removed folder reports it without end, about 80,000 times a second, and
        // keeps OpenCode busy: stop watching, and the once-a-minute tick asks the board instead.
        if (name !== 'messages.json' && !boardFolderExists(directoryToWatch)) {
          try { current.close() } catch {}
          if (watcher === current) watcher = null
          return
        }
        if (name != null && name !== 'messages.json') return
        clearTimeout(pending)
        pending = setTimeout(check, 250)
        pending.unref?.()
      })
      watcher = current
      watcher.on('error', () => { try { current.close() } catch {} if (watcher === current) watcher = null })
    } catch { watcher = null }
  }
  // With no folder to watch yet (no board has run), each session asks once a minute; with one, every ten
  // minutes, which keeps its mailbox open and takes a message whose earlier claim ran out. A session marked
  // busy is checked against the host first, so a lost idle event heals.
  const tick = () => {
    ticks += 1
    if (watcher === null || ticks % 10 === 0) for (const session of roots.keys()) heal(session)
  }
  const stop = () => {
    clearInterval(timer)
    timer = null
    try { watcher?.close() } catch {}
    watcher = null
  }
  const run = () => { if (timer === null) { timer = setInterval(tick, 60000); timer.unref?.() } }
  return {
    // The plugin reports a top-level session's state: 'working' (a turn runs), 'waiting' (session.idle) or 'ended'.
    note: (session, state) => {
      if (typeof session !== 'string' || session === '') return
      if (state === 'ended') {
        if (!roots.delete(session)) return
        failing.delete(session)
        again.delete(session)
        stashed.delete(session)
        clearTimeout(retries.get(session)?.timer)
        retries.delete(session)
        versions.set(session, (versions.get(session) ?? 0) + 1)
        boardCall('end', session, directory)
        if (roots.size === 0) stop()
        return
      }
      if (state === 'working') {
        versions.set(session, (versions.get(session) ?? 0) + 1)
        roots.set(session, 'busy')
        run()
        return
      }
      if (state !== 'waiting') return
      roots.set(session, 'idle')
      run()
      deliver(session)
    },
    // The two tools are bound to the session id the host gives each call, so a call cannot name another session.
    tools: {
      agent_board_send: tool({
        description: WORDS.send,
        args: { agent: tool.schema.string(), session: tool.schema.string(), text: tool.schema.string() },
        execute: async (args, context) => {
          const own = context?.sessionID
          if (typeof own !== 'string' || own === '' || !roots.has(own)) throw new Error('AGENT_BOARD_SEND_FAILED: NO_SESSION')
          const answer = await boardCall('send', own, directory, ['--to-agent', String(args.agent), '--to-session', String(args.session), '--text-b64', toB64(args.text)])
          if (answer?.ok !== true) throw new Error('AGENT_BOARD_SEND_FAILED' + (typeof answer?.code === 'string' ? ': ' + answer.code : ''))
          return WORDS.sent
        },
      }),
      agent_board_ack: tool({
        description: WORDS.ack,
        args: { id: tool.schema.string(), nonce: tool.schema.string(), summary: tool.schema.string() },
        execute: async (args, context) => {
          const own = context?.sessionID
          if (typeof own !== 'string' || own === '' || !roots.has(own)) throw new Error('AGENT_BOARD_ACK_FAILED: NO_SESSION')
          if (typeof args.id !== 'string' || args.id === '' || typeof args.nonce !== 'string' || !/^[0-9a-f]{6}$/.test(args.nonce)) throw new Error('AGENT_BOARD_ACK_FAILED: INVALID_ARGUMENTS')
          const summary = typeof args.summary === 'string' ? args.summary.replace(/[\\r\\n\\0]+/g, ' ').trim().slice(0, 150) : ''
          const answer = await boardCall('ack', own, directory, ['--id', args.id, '--nonce', args.nonce, ...(summary === '' ? [] : ['--summary-b64', toB64(summary)])])
          if (answer?.ok !== true) throw new Error('AGENT_BOARD_ACK_FAILED' + (typeof answer?.code === 'string' ? ': ' + answer.code : ''))
          return WORDS.acknowledged
        },
      }),
    },
  }
}
`
