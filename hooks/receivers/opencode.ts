import { SURFACE_IDS } from '../messaging.ts'
import type { Strings } from '../i18n.ts'

// OpenCode receives a board message in its own process (#724). The agent-board-local plugin keeps each
// top-level session's board mailbox open, so that session's card has a Send box. While the session is
// busy the plugin holds the message; when the session goes idle (session.idle) it takes the message
// through the board script, tells the board a wake is about to start (attempt), and wakes the session with
// client.session.promptAsync, which returns at once (OpenCode 1.19.3, docs/validation/2026-11-12-opencode-f9-wake.md).
// A message the board saw a wake start for is never handed out again, so there is at most one wake per message;
// if nobody can say whether it arrived, the card reads "sent, not confirmed" after 30 minutes and keeps the text.
// Only a 400 or 404 answer from promptAsync takes it back; any other error leaves it a started wake.
// The message is marked as accepted by the transport only after a 204 answer; it becomes acknowledged when the model
// calls agent_board_ack (also when the answer was lost). A subagent's session (it has a parent) is never registered,
// so it never receives one. Nothing here reads the conversation.
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
  timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} resolve(null) }, TIMING.boardMs)
  child.on('error', () => finish(null))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { if (output.length < 262144) output += chunk })
  child.on('close', code => {
    try { finish(code === 0 ? JSON.parse(output.trim().split(/\\r?\\n/).pop()) : null) } catch { finish(null) }
  })
})
const WORDS = ${JSON.stringify({ send: words.opencodeSendTool, ack: words.opencodeAckTool, sent: words.opencodeSent, acknowledged: words.opencodeAcknowledged, note: words.opencodeAckNote })}
// The summary is optional (the code below reads it as optional); a schema type without optional() keeps it required, as before.
const optionalText = () => { const text = tool.schema.string(); return typeof text.optional === 'function' ? text.optional() : text }
const toB64 = text => Buffer.from(String(text), 'utf8').toString('base64')
// The receiver's own clocks. A test may name shorter ones under this symbol before the plugin loads; nothing else does.
// hostMs: a host call that has not answered within this long counts as no answer, as a failed one does. Every host
// call below runs while the session's step is open, and one that never settled would keep it open: no later event,
// retry or tick could deliver to that session again (#1366 review). The board script calls have their own boardMs.
// backoffMs to backoffMaxMs: the wait before a retry, doubling. settleMs: how long after a wake the session may
// still be busy without an event having said so. leaseMs: how long the board keeps a claim before it gives it back.
const TIMING = { hostMs: 10000, boardMs: 15000, backoffMs: 2000, backoffMaxMs: 60000, settleMs: 5000, leaseMs: 31000, ...(globalThis[Symbol.for('agent-board.opencode-timing')] ?? {}) }
const hostCall = call => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('HOST_TIMEOUT')), TIMING.hostMs)
  timer.unref?.()
  Promise.resolve().then(call).then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})
// Why the receiver can promise at most one wake per message: the board is told a wake has started (attempt) before the host
// is called, and a message marked that way is never handed out again, whatever happens to the host call. The receiver
// keeps no record of its own beyond the step it is in; after a restart the board's state is enough.
const boardReceiver = (client, directory) => {
  // A session is known only after the plugin saw it report as a top-level session; idle or busy as of its last event.
  // marks: one counter per session, bumped by every event (idle too) and by this receiver's own wake. An answer to a
  // question asked of the host counts only if the counter is what it was when the question was asked.
  // held: the one step a session still owes the board: asking again for an attempt, saving an accept, taking a started wake back.
  const roots = new Map(), taking = new Set(), failing = new Set(), again = new Set(), recheck = new Set(), marks = new Map(), retries = new Map(), settling = new Map(), held = new Map(), ending = new Map(), sawBusy = new Set()
  let watcher = null, folder = null, pending = null, timer = null, ticks = 0
  const mark = session => marks.get(session) ?? 0
  const bump = session => marks.set(session, mark(session) + 1)
  const accept = (session, message) => boardCall('accept', session, directory, ['--id', message.id, '--nonce', message.nonce, '--awaits-ack'])
  // The host's own view of a session. OpenCode lists only sessions that are not idle (F9: \`{}\` for an idle
  // one), so a lookup that answers with no entry means idle; a failed lookup, an error answer or an entry of
  // no known shape leaves it unknown. A host without the lookup is left to the last event.
  const hostState = async session => {
    if (typeof client?.session?.status !== 'function') return 'idle'
    let live
    try { live = await hostCall(() => client.session.status({})) } catch { return 'unknown' }
    if (live?.error || live?.data == null || typeof live.data !== 'object') return 'unknown'
    const entry = live.data[session]
    if (entry === undefined) return 'idle'
    if (!entry || typeof entry.type !== 'string') return 'unknown'
    return entry.type === 'idle' ? 'idle' : 'busy'
  }
  const newRef = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, '0')).join('')
  // What the receiver must try again on its own clock, with one one-shot timer per session: a failed call, a lookup
  // that did not answer, a claim the board gives back at its lease. Nothing else would come back for it, since a
  // board write or the tick may be minutes away. The wait doubles until a delivery goes through.
  const retryLater = (session, wait) => {
    const entry = retries.get(session) ?? { timer: null, delay: TIMING.backoffMs }
    retries.set(session, entry)
    if (entry.timer !== null) {
      // A named wait (a lease) replaces a longer backoff; a backoff never replaces a timer.
      if (wait === undefined) return
      clearTimeout(entry.timer)
    }
    const after = wait ?? entry.delay
    if (wait === undefined) entry.delay = Math.min(entry.delay * 2, TIMING.backoffMaxMs)
    entry.timer = setTimeout(() => { entry.timer = null; heal(session, true) }, after)
    entry.timer.unref?.()
  }
  const calm = session => { const entry = retries.get(session); if (entry !== undefined) entry.delay = TIMING.backoffMs }
  // After a wake the session is still idle for a moment as far as events go. The next take waits until a busy event
  // has been seen or settleMs have passed; the timer is the wait, so an idle that comes meanwhile is never dropped.
  const endSettle = session => { const one = settling.get(session); if (one !== undefined) { clearTimeout(one); settling.delete(session) } }
  const beginSettle = session => {
    endSettle(session)
    const one = setTimeout(() => { settling.delete(session); heal(session) }, TIMING.settleMs)
    one.unref?.()
    settling.set(session, one)
  }
  // Gives a claim back. An unmarked claim also returns at the lease by itself; a started wake only with unsent, and
  // only the plugin knows that the host was never called. NOT_HELD means the board no longer holds it, which is as good.
  const giveBack = async (session, ref, isUnsent) => {
    const answer = await boardCall('release', session, directory, ['--ref', ref, ...(isUnsent ? ['--unsent'] : [])])
    return answer?.ok === true || answer?.code === 'NOT_HELD'
  }
  // A refusal that no retry can change: the message ran out, was dismissed, belongs to another claim or is finished already.
  const isFinal = code => ['MESSAGE_EXPIRED', 'MESSAGE_DISMISSED', 'TARGET_MISMATCH', 'CLAIM_REQUIRED', 'RECEIPT_CONFLICT'].includes(code)
  const finishHeld = async (session, one) => {
    if (one.phase === 'accept') {
      const answer = await accept(session, one.message)
      if (answer?.ok === true || isFinal(answer?.code)) { held.delete(session); calm(session); return }
      retryLater(session)
      return
    }
    // The host was not called for this wake; the board is told so, and the message goes out again after the backoff.
    if (await giveBack(session, one.ref, true)) held.delete(session)
    retryLater(session)
  }
  const step = async session => {
    const one = held.get(session)
    if (one !== undefined && one.phase !== 'attempt') return finishHeld(session, one)
    if (roots.get(session) !== 'idle') return
    const seen = mark(session)
    // The host is asked before the take: a busy or unknown session claims nothing, so no claim waits out a long turn.
    const state = await hostState(session)
    if (!roots.has(session)) return
    // An event arrived while the question was out: its answer says nothing about now, so it is asked again.
    if (mark(session) !== seen) { again.add(session); return }
    // An unknown state claims nothing but is looked at again on the retry clock: no event may come for it.
    if (state === 'unknown') { retryLater(session); return }
    if (state === 'busy') {
      // The host contradicts an idle event: no further event may come, so it is looked at again.
      roots.set(session, 'busy')
      recheck.add(session)
      retryLater(session)
      return
    }
    let message, ref
    if (one !== undefined) ({ message, ref } = one)
    else {
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
      if (message == null) { calm(session); return }
      if (typeof message.text !== 'string' || typeof message.id !== 'string' || typeof message.nonce !== 'string') throw new Error('MAILBOX_FAILED')
    }
    // A session that closed meanwhile does not get it: the claim returns at the lease.
    if (!roots.has(session)) return
    // The session changed after the take: the claim goes back at once, or at the lease if the board cannot take it back.
    if (mark(session) !== seen) {
      if (one !== undefined) { if (roots.get(session) === 'idle') again.add(session); return }
      if (await giveBack(session, ref, false)) { if (roots.get(session) === 'idle') again.add(session) } else retryLater(session, TIMING.leaseMs)
      return
    }
    // The board writes "wake started" before the host is called. Asking again with the same ref gets the same answer.
    const attempted = await boardCall('attempt', session, directory, ['--ref', ref])
    if (attempted?.ok !== true) {
      // CLAIM_LOST: the lease passed and the board has the message again. Any other failure: ask again for this claim.
      if (attempted?.code === 'CLAIM_LOST') held.delete(session)
      else held.set(session, { phase: 'attempt', message, ref })
      retryLater(session)
      return
    }
    held.delete(session)
    if (!roots.has(session)) return
    // It turned busy while the attempt was saved, and the host was never called: the mark is taken back.
    if (mark(session) !== seen) {
      if (!(await giveBack(session, ref, true))) { held.set(session, { phase: 'unsent', message, ref }); retryLater(session) } else if (roots.get(session) === 'idle') again.add(session)
      return
    }
    roots.set(session, 'busy')
    bump(session)
    sawBusy.delete(session)
    let result = 'unknown'
    try {
      const woke = await hostCall(() => client.session.promptAsync({ path: { id: session }, body: { parts: [{ type: 'text', text: message.text + '\\n\\n' + WORDS.note.split('{id}').join(message.id).split('{nonce}').join(message.nonce) }] } }))
      // OpenCode 1.19.3 documents only 400 and 404 for promptAsync; they come before the host stores anything, so only they
      // prove the message was not sent. Any other error answer (a 500, no status) may come after the turn started.
      result = !woke?.error ? 'sent' : woke.response?.status === 400 || woke.response?.status === 404 ? 'refused' : 'unknown'
    } catch {}
    if (!roots.has(session)) return
    if (result === 'refused') {
      // The host answered 400 or 404: proof of not sent. The board takes the mark back, and it goes out again after the backoff.
      if (!(await giveBack(session, ref, true))) held.set(session, { phase: 'unsent', message, ref })
      retryLater(session)
      hookError('MAILBOX_FAILED')
      return
    }
    // A busy event that came while the call was out already ended the wait this would start.
    if (!sawBusy.has(session)) beginSettle(session)
    // A call that threw or passed the deadline: nobody can know whether it arrived. The message stays as a wake that
    // was started, and nothing sends it again. The model's ack settles it, or the card reads sent, not confirmed.
    if (result === 'unknown') { hookError('MAILBOX_FAILED'); return }
    // Accepted is only the transport; the model's ack upgrades it. A failed save is asked again; the message is not handed out meanwhile.
    const answer = await accept(session, message)
    if (answer?.ok !== true && !isFinal(answer?.code)) { held.set(session, { phase: 'accept', message }); retryLater(session); hookError('MAILBOX_FAILED'); return }
    calm(session)
  }
  const deliver = async session => {
    if (!roots.has(session)) return
    const one = held.get(session)
    const isWake = one === undefined || one.phase === 'attempt'
    if (isWake && roots.get(session) !== 'idle') return
    // A message the board writes while a step is under way is taken right after it, not at the next tick.
    if (taking.has(session)) { again.add(session); return }
    if (isWake && settling.has(session)) return
    taking.add(session)
    try { await step(session) } catch { hookError('MAILBOX_FAILED'); retryLater(session) }
    finally {
      taking.delete(session)
      if (again.delete(session)) deliver(session)
    }
  }
  // A retry, a settle wait or the tick: a session marked busy is checked against the host first, since a lost idle
  // event would leave it busy until its next event. A host that cannot list its sessions is left to the events.
  const heal = async (session, isRetry = false) => {
    if (roots.get(session) === 'busy' && typeof client?.session?.status === 'function') {
      const seen = mark(session)
      const state = await hostState(session)
      if (roots.get(session) === 'busy' && mark(session) === seen && state === 'idle') { roots.set(session, 'idle'); recheck.delete(session) }
      // A lookup that fails leaves the session as it was, so it is asked again on the retry clock as for busy.
      else if (isRetry && (state === 'busy' || state === 'unknown') && recheck.has(session)) retryLater(session)
    }
    await deliver(session)
  }
  // The board rewrites messages.json whenever it queues a message: an idle session with one waiting takes it.
  const check = () => {
    let store
    try { store = JSON.parse(readBoardStore(joinBoard(folder, 'messages.json'), 'utf8')) } catch { return }
    const waiting = new Set((Array.isArray(store?.messages) ? store.messages : []).filter(one => one?.status === 'queued' && typeof one.to === 'string').map(one => one.to))
    for (const session of roots.keys()) if (waiting.has('opencode:' + session) || held.has(session)) deliver(session)
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
  // The session's mailbox is closed on the board. A write that failed is asked again, a few times: the mailbox's own
  // lifetime (12 hours) is the last resort. A session that comes back stops it. Reported once.
  const stopEnding = session => { const one = ending.get(session); if (one !== undefined) { clearTimeout(one.timer); ending.delete(session) } }
  const closeMailbox = async (session, delay = TIMING.backoffMs, round = 0) => {
    const answer = await boardCall('end', session, directory)
    if (answer?.ok === true) { stopEnding(session); return }
    if (round === 0) hookError('MAILBOX_FAILED')
    if (round >= 8 || roots.has(session)) { stopEnding(session); return }
    const one = { timer: setTimeout(() => closeMailbox(session, Math.min(delay * 2, TIMING.backoffMaxMs), round + 1), delay) }
    one.timer.unref?.()
    ending.set(session, one)
  }
  return {
    // The plugin reports a top-level session's state: 'working' (a turn runs), 'waiting' (session.idle) or 'ended'.
    note: (session, state) => {
      if (typeof session !== 'string' || session === '') return
      if (state === 'ended') {
        if (!roots.delete(session)) return
        failing.delete(session)
        again.delete(session)
        recheck.delete(session)
        held.delete(session)
        sawBusy.delete(session)
        endSettle(session)
        clearTimeout(retries.get(session)?.timer)
        retries.delete(session)
        marks.delete(session)
        closeMailbox(session)
        if (roots.size === 0) stop()
        return
      }
      if (state === 'working') {
        bump(session)
        roots.set(session, 'busy')
        sawBusy.add(session)
        recheck.delete(session)
        // A busy event after a wake is what the settle wait was for.
        endSettle(session)
        stopEnding(session)
        run()
        return
      }
      if (state !== 'waiting') return
      bump(session)
      roots.set(session, 'idle')
      stopEnding(session)
      run()
      deliver(session)
    },
    // Whether a call is running or a timer is armed for the session; a test asks it, to tell a stall from a wait.
    holds: session => taking.has(session) || settling.has(session) || ending.has(session) || retries.get(session)?.timer != null,
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
        args: { id: tool.schema.string(), nonce: tool.schema.string(), summary: optionalText() },
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
