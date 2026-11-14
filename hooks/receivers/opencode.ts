import { SURFACE_IDS } from '../messaging.ts'
import { STALE_MS } from '../parse.ts'
import type { Strings } from '../i18n.ts'

// OpenCode receives a board message in its own process (#724). The agent-board-local plugin keeps each
// top-level session's board mailbox open, so that session's card has a Send box. While the session is
// busy the plugin holds the message; when the session goes idle (session.idle) it takes the message
// through the board script, tells the board a wake is about to start (attempt), and wakes the session with
// client.session.promptAsync, which returns at once (OpenCode 1.19.3, docs/validation/2026-11-12-opencode-f9-wake.md).
// A message the board saw a wake start for is never handed out again, so there is at most one wake per message;
// if nobody can say whether it arrived, the card reads "sent, not confirmed" after 30 minutes and keeps the text.
// Only a 400 or 404 answer from promptAsync, or a wake the plugin knows it never made, takes it back; any other error leaves
// it a started wake. A message left waiting after a lost answer or a failed lookup goes out at the session's next event, the
// next board write or the plugin's 30-second tick, whichever comes first, if the session is idle then.
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
// handlers feed through seen (as an event arrives, before any lookup), drop and note(session, 'working' | 'waiting' | 'ended'), that
// calls the plugin's replay(session, state) at its tick, and whose tool the plugin's tool map spreads in. It uses
// the plugin's own hookError and tool. Only top-level sessions are ever noted. What a session owes the board (its mailbox, a message
// waiting) is read from the board's own file at each tick, never remembered from an answer.
// The words the model reads (tool description, replies, the ack note) come from the string tables, chosen by the caller.
export type OpencodeWords = Pick<Strings, 'opencodeAckTool' | 'opencodeAcknowledged' | 'opencodeAckNote'>
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
const WORDS = ${JSON.stringify({ ack: words.opencodeAckTool, acknowledged: words.opencodeAcknowledged, note: words.opencodeAckNote })}
// The summary is optional (the code below reads it as optional); a schema type without optional() keeps it required, as before.
const optionalText = () => { const text = tool.schema.string(); return typeof text.optional === 'function' ? text.optional() : text }
const toB64 = text => Buffer.from(String(text), 'utf8').toString('base64')
// The receiver's own clocks. A test may name shorter ones under this symbol before the plugin loads; nothing else does.
// hostMs: a host call that has not answered within this long counts as no answer, as a failed one does. Every host
// call below runs while the session's step is open, and one that never settled would keep it open: no later event,
// tick or board write could deliver to that session again (#1366 review). The board script calls have their own boardMs.
// settleMs: how long after a wake the session may still be busy without an event having said so. tickMs: the one clock
// that recovers anything the events and the board's writes did not. mailboxMs: the mailbox's lifetime on the board (its own constant,
// so the two cannot drift apart and reopen at every write); it is renewed
// once less than that minus renewMs is left in the board's file.
const TIMING = { hostMs: 10000, boardMs: 15000, settleMs: 5000, tickMs: 30000, mailboxMs: ${STALE_MS}, renewMs: 600000, ...(globalThis[Symbol.for('agent-board.opencode-timing')] ?? {}) }
const hostCall = call => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('HOST_TIMEOUT')), TIMING.hostMs)
  timer.unref?.()
  Promise.resolve().then(call).then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})
// Why the receiver can promise at most one wake per message: the board is told a wake has started (attempt) before the host
// is called, and a message marked that way is never handed out again, whatever happens to the host call. The receiver
// keeps no record of its own beyond the step it is in; after a restart the board's state is enough.
// Why it can promise that a message left waiting goes out: no step arms a timer of its own, and no way out of a step has to
// remember to write anything down. A session is written down before its lookup is awaited; the tick every 30 seconds acts on
// every known session unless it has proof there is nothing to do, and looks every session still written down up again through
// the plugin's own path. A claim nobody marked is handed to the next take at once, so the tick needs no lease to wait out.
const boardReceiver = (client, directory, replay) => {
  // A session is known only after the plugin's own path reported it as a top-level session; idle or busy as of its last event.
  // marks: one counter per session, bumped by every event (idle too) and by this receiver's own wake. An answer to a
  // question asked of the host counts only if the counter is what it was when the question was asked.
  // held: the one step a session still owes the board: saving an accept, taking a started wake back as unsent.
  // ending: a closed mailbox whose end the board has not saved yet, with the tries so far.
  // pending: a session an event or chat.message named that is not known yet, with the state it reported and the tick's tries.
  // opening: an open under way. Nothing else remembers whether a mailbox is open or a message waits: owed() reads the board's file.
  const roots = new Map(), taking = new Set(), again = new Set(), marks = new Map(), settling = new Map(), held = new Map(), ending = new Map(), pending = new Map(), replaying = new Set(), closing = new Set(), sawBusy = new Set(), opening = new Set()
  let watcher = null, folder = null, debounce = null, timer = null, isTakeFailing = false, isOpenFailing = false
  const mark = session => marks.get(session) ?? 0
  const bump = session => marks.set(session, mark(session) + 1)
  const accept = (session, message) => boardCall('accept', session, directory, ['--id', message.id, '--nonce', message.nonce, '--awaits-ack'])
  // A take opens a session's mailbox, and a busy session takes nothing (#1366 review). A busy session opens or renews it
  // with open instead, which claims nothing, so the board can queue a message for it while its turn runs, and a turn longer
  // than the mailbox's 12 hours keeps it. The answer changes nothing here but the board folder it names: a failed or empty answer
  // needs no handling, since the next tick reads the file and finds the mailbox still missing. A failure is logged once, until one works.
  // An open and an end of one session never run at once: an end waits for the open, so a mailbox the session closed
  // meanwhile is not left open behind it, and an open skipped for an end stays owed for the tick.
  const openMailbox = async session => {
    if (opening.has(session) || closing.has(session)) return
    opening.add(session)
    const answer = await boardCall('open', session, directory)
    opening.delete(session)
    if (typeof answer?.watch === 'string') follow(answer.watch)
    if (answer?.ok === true) isOpenFailing = false
    else if (!isOpenFailing) { isOpenFailing = true; hookError('MAILBOX_FAILED') }
    if (ending.has(session)) closeMailbox(session)
  }
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
  // After a wake the session is still idle for a moment as far as events go. The next take waits until a busy event
  // has been seen or settleMs have passed; the timer is the wait, so an idle that comes meanwhile is never dropped.
  const endSettle = session => { const one = settling.get(session); if (one !== undefined) { clearTimeout(one); settling.delete(session) } }
  const beginSettle = session => {
    endSettle(session)
    const one = setTimeout(() => { settling.delete(session); heal(session) }, TIMING.settleMs)
    one.unref?.()
    settling.set(session, one)
  }
  // Gives a claim back. A started wake goes back only with unsent, and only the plugin knows that the host was never called.
  // NOT_HELD means the board no longer holds it, which is as good.
  const giveBack = async (session, ref, isUnsent) => {
    const answer = await boardCall('release', session, directory, ['--ref', ref, ...(isUnsent ? ['--unsent'] : [])])
    return answer?.ok === true || answer?.code === 'NOT_HELD'
  }
  // A refusal that no retry can change: the message ran out, was dismissed, belongs to another claim or is finished already.
  const isFinal = code => ['MESSAGE_EXPIRED', 'MESSAGE_DISMISSED', 'TARGET_MISMATCH', 'CLAIM_REQUIRED', 'RECEIPT_CONFLICT'].includes(code)
  // The step the session still owes. Neither needs the session to be idle, and a failed one stays owed for the tick.
  const finishHeld = async (session, one) => {
    if (one.phase === 'accept') {
      const answer = await accept(session, one.message)
      if (answer?.ok === true || isFinal(answer?.code)) held.delete(session)
      return
    }
    // The host was not called for this wake; the board is told so, and the message goes out again at the next take.
    if (await giveBack(session, one.ref, true)) held.delete(session)
  }
  const step = async session => {
    const one = held.get(session)
    if (one !== undefined) return finishHeld(session, one)
    if (roots.get(session) !== 'idle') return
    const before = mark(session)
    // The host is asked before the take: a busy or unknown session claims nothing, so no claim waits out a long turn.
    const state = await hostState(session)
    if (!roots.has(session)) return
    // An event arrived while the question was out: its answer says nothing about now, so it is asked again.
    if (mark(session) !== before) { again.add(session); return }
    // An unknown state claims nothing, and the message stays queued for the tick to see.
    if (state === 'unknown') return
    if (state === 'busy') {
      // The host contradicts an idle event: no further event may come, so the tick asks again. A session with no mailbox yet
      // takes nothing while busy: it opens one.
      roots.set(session, 'busy')
      openIfOwed(session)
      return
    }
    const ref = newRef()
    const taken = await boardCall('take', session, directory, ['--ref', ref])
    // A board script that is missing, fails or does not answer keeps the card from offering Send; it says so
    // with ok false, which is not the same as an empty mailbox. It is logged once, until a take works again,
    // so a tick that keeps asking does not fill the log.
    if (taken === null || typeof taken !== 'object' || taken.ok === false) {
      if (!isTakeFailing) { isTakeFailing = true; hookError('MAILBOX_FAILED') }
      return
    }
    isTakeFailing = false
    if (typeof taken.watch === 'string') follow(taken.watch)
    const message = taken.message
    if (message == null) return
    if (typeof message.text !== 'string' || typeof message.id !== 'string' || typeof message.nonce !== 'string') throw new Error('MAILBOX_FAILED')
    // A session that closed meanwhile does not get it: the next take of its mailbox has the claim.
    if (!roots.has(session)) return
    // The session changed after the take: the claim goes back at once, or to the next take if the board cannot take it back.
    if (mark(session) !== before) {
      if (await giveBack(session, ref, false) && roots.get(session) === 'idle') again.add(session)
      return
    }
    // The board writes "wake started" before the host is called. Asking again with the same ref gets the same answer.
    const attempted = await boardCall('attempt', session, directory, ['--ref', ref])
    if (attempted?.ok !== true) {
      // CLAIM_LOST: another take has the claim now, so there is nothing to give back. Any other failure: the host was never called,
      // so the claim goes back as unsent at once, whether or not the board saved the mark, and the tick takes it again.
      if (attempted?.code !== 'CLAIM_LOST' && !(await giveBack(session, ref, true))) held.set(session, { phase: 'unsent', message, ref })
      return
    }
    if (!roots.has(session)) return
    // It turned busy while the attempt was saved, and the host was never called: the mark is taken back.
    if (mark(session) !== before) {
      if (!(await giveBack(session, ref, true))) held.set(session, { phase: 'unsent', message, ref })
      else if (roots.get(session) === 'idle') again.add(session)
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
      // The host answered 400 or 404: proof of not sent. The board takes the mark back, and it goes out again at the next take.
      if (!(await giveBack(session, ref, true))) held.set(session, { phase: 'unsent', message, ref })
      hookError('MAILBOX_FAILED')
      return
    }
    // A busy event that came while the call was out already ended the wait this would start.
    if (!sawBusy.has(session)) beginSettle(session)
    // A call that threw or passed the deadline: nobody can know whether it arrived. The message stays as a wake that
    // was started, and nothing sends it again. The model's ack settles it, or the card reads sent, not confirmed.
    if (result === 'unknown') { hookError('MAILBOX_FAILED'); return }
    // Accepted is only the transport; the model's ack upgrades it. A failed save is owed to the board; the message is not handed out meanwhile.
    const answer = await accept(session, message)
    if (answer?.ok !== true && !isFinal(answer?.code)) { held.set(session, { phase: 'accept', message }); hookError('MAILBOX_FAILED'); return }
  }
  const deliver = async session => {
    if (!roots.has(session)) return
    const isWake = !held.has(session)
    if (isWake && roots.get(session) !== 'idle') return
    // A message the board writes while a step is under way is taken right after it, not at the next tick.
    if (taking.has(session)) { again.add(session); return }
    if (isWake && settling.has(session)) return
    taking.add(session)
    try { await step(session) } catch { hookError('MAILBOX_FAILED') }
    finally {
      taking.delete(session)
      if (ending.has(session)) closeMailbox(session)
      if (again.delete(session)) deliver(session)
    }
  }
  // A settle wait or the tick: a session marked busy is checked against the host first, since a lost idle event would leave
  // it busy until its next event. A host that cannot list its sessions is left to the events.
  const heal = async session => {
    if (roots.get(session) === 'busy' && !held.has(session) && typeof client?.session?.status === 'function') {
      const seen = mark(session)
      const state = await hostState(session)
      if (roots.get(session) === 'busy' && mark(session) === seen && state === 'idle') roots.set(session, 'idle')
    }
    await deliver(session)
  }
  // The board's file, read: null when no folder is known yet or the file cannot be read (not knowing), undefined when the known
  // folder does not exist (no board has made it, so nobody can queue anything and there is nothing to open).
  const readStore = () => {
    if (folder === null) return null
    if (!boardFolderExists(folder)) return undefined
    try { return JSON.parse(readBoardStore(joinBoard(folder, 'messages.json'), 'utf8')) } catch { return null }
  }
  // What one session owes, worked out from the file each time and never remembered (#1366 round 6): mailbox (none in the file, or
  // less than its lifetime minus ten minutes left, so it is opened or renewed), waiting (a message queued for it, and with
  // isClaimed also one claimed and not marked as a wake, which a take lost on its way back leaves behind), and sure (the file was read).
  const owed = (session, store, isClaimed) => {
    if (store === undefined) return { mailbox: false, waiting: false, sure: true }
    if (store === null || typeof store !== 'object') return { mailbox: true, waiting: false, sure: false }
    const entry = (Array.isArray(store.mailboxes) ? store.mailboxes : []).find(one => one?.agent === 'opencode' && one.session === session)
    const messages = Array.isArray(store.messages) ? store.messages : []
    const waiting = messages.some(one => one?.to === 'opencode:' + session && (one.status === 'queued' || isClaimed && one.status === 'uncertain' && one.error === '' && one.attempted === undefined && typeof one.ref === 'string'))
    return { mailbox: !(entry?.expires - Date.now() > TIMING.mailboxMs - TIMING.renewMs), waiting, sure: true }
  }
  // A busy session with no mailbox, or one running out, opens or renews it; an idle one does the same by taking.
  const openIfOwed = session => { if (owed(session, readStore(), false).mailbox) openMailbox(session) }
  // The board rewrites messages.json whenever it queues a message or a mailbox goes: an idle session with one waiting takes it,
  // and a session whose mailbox is gone gets it again.
  const check = () => {
    const store = readStore()
    if (store == null) return
    for (const session of roots.keys()) {
      const need = owed(session, store, false)
      const isBusy = roots.get(session) === 'busy'
      if (isBusy && need.mailbox) openMailbox(session)
      if (held.has(session) || need.waiting || need.mailbox && !isBusy) deliver(session)
    }
  }
  const follow = directoryToWatch => {
    if (watcher !== null && folder === directoryToWatch) return
    try { watcher?.close() } catch {}
    watcher = null
    folder = directoryToWatch
    try {
      const current = watchBoard(directoryToWatch, { persistent: false }, (_event, name) => {
        // On Windows the watcher of a removed folder reports it without end, about 80,000 times a second, and
        // keeps OpenCode busy: stop watching, and the tick asks the board instead.
        if (name !== 'messages.json' && !boardFolderExists(directoryToWatch)) {
          try { current.close() } catch {}
          if (watcher === current) watcher = null
          return
        }
        if (name != null && name !== 'messages.json') return
        clearTimeout(debounce)
        debounce = setTimeout(check, 250)
        debounce.unref?.()
      })
      watcher = current
      watcher.on('error', () => { try { current.close() } catch {} if (watcher === current) watcher = null })
    } catch { watcher = null }
  }
  const stop = () => {
    clearInterval(timer)
    timer = null
    try { watcher?.close() } catch {}
    watcher = null
  }
  const stopIfIdle = () => { if (roots.size === 0 && ending.size === 0 && pending.size === 0) stop() }
  // The session's mailbox is closed on the board. A write that failed is asked again at the tick, a few times: the mailbox's
  // own lifetime (12 hours) is the last resort. A session that comes back stops it. Reported once.
  // An end never runs beside a take of the same session: a take that the board applies after the end would enrol the mailbox
  // again, and the end, once saved, is not asked for again (#1366 review). It waits, and the take's step asks for it when it is over.
  const closeMailbox = async session => {
    if (closing.has(session) || opening.has(session) || taking.has(session)) return
    closing.add(session)
    const answer = await boardCall('end', session, directory)
    closing.delete(session)
    const round = ending.get(session)
    if (round === undefined) return
    if (answer?.ok === true) { ending.delete(session); stopIfIdle(); return }
    if (round === 0) hookError('MAILBOX_FAILED')
    if (round >= 8 || roots.has(session)) { ending.delete(session); stopIfIdle(); return }
    ending.set(session, round + 1)
  }
  // A session still written down goes through the plugin's own path again (replay), the one that made it known in the first
  // place, so it gets its card as a session an event found does. It replays the host's current state when the host can say it,
  // else the state its last event reported. After 20 tries it is let go, and that is logged once.
  const recover = async session => {
    const one = pending.get(session)
    if (one === undefined || replaying.has(session)) return
    if (one.tries >= 20) { pending.delete(session); hookError('HOST_METADATA_FAILED'); stopIfIdle(); return }
    one.tries += 1
    replaying.add(session)
    try {
      const live = typeof client?.session?.status === 'function' ? await hostState(session) : 'unknown'
      if (pending.get(session) === one) await replay(session, live === 'idle' ? 'waiting' : live === 'busy' ? 'working' : one.state)
    } catch {} finally { replaying.delete(session) }
  }
  // The one recovery path, every 30 seconds. Each known session is judged from the board's file alone (owed): a busy one whose
  // mailbox is missing or running out opens it, and any one that owes a mailbox or a message, owes the board a step, or whose
  // file could not be read goes through heal and then deliver. A session with nothing owed costs nothing. A folder that
  // appeared after it was learned is watched from then on. Every session still written down is looked up again.
  const tick = () => {
    const store = readStore()
    if (store !== null && store !== undefined && watcher === null) follow(folder)
    for (const session of roots.keys()) {
      const need = owed(session, store, true)
      const isBusy = roots.get(session) === 'busy'
      if (isBusy && need.mailbox) openMailbox(session)
      if (taking.has(session)) continue
      if (held.has(session) || need.waiting || !need.sure || need.mailbox && !isBusy) heal(session)
    }
    for (const session of ending.keys()) closeMailbox(session)
    for (const session of pending.keys()) recover(session)
    stopIfIdle()
  }
  const run = () => { if (timer === null) { timer = setInterval(tick, TIMING.tickMs); timer.unref?.() } }
  // Every event and chat.message reaches the receiver here, as the first thing the plugin does with it and before anything is
  // awaited (#1366 round 6). A session not known yet is written down, in the state it reported, so no way out of its lookup (a
  // throw, a hang, an error answer, no data) can lose it; it leaves only on an answer that settles it: made known, found to be a
  // subagent or another session (drop), ended, or given up at the tick. A known session's counter moves at once, and a busy
  // event also marks it busy and ends the settle wait, so a step already under way sees the change when its call returns.
  const seen = (session, state) => {
    if (typeof session !== 'string' || session === '') return
    if (state === 'ended') { drop(session); return }
    if (!['working', 'waiting'].includes(state)) return
    if (roots.has(session)) {
      bump(session)
      if (state === 'working') { roots.set(session, 'busy'); sawBusy.add(session); endSettle(session) }
      return
    }
    const one = pending.get(session)
    if (one === undefined) pending.set(session, { state, tries: 0 })
    else one.state = state
    run()
  }
  const drop = session => { if (pending.delete(session)) stopIfIdle() }
  // The plugin reports a top-level session's state: 'working' (a turn runs), 'waiting' (session.idle) or 'ended'. A session not
  // known yet becomes known only once the plugin's progress report of it went out (isReported); until then it stays written down.
  const note = (session, state, isReported = true) => {
    if (typeof session !== 'string' || session === '') return
    if (state === 'ended') {
      pending.delete(session)
      if (!roots.delete(session)) { stopIfIdle(); return }
      again.delete(session)
      held.delete(session)
      sawBusy.delete(session)
      endSettle(session)
      marks.delete(session)
      ending.set(session, 0)
      closeMailbox(session)
      return
    }
    if (state !== 'working' && state !== 'waiting') return
    if (!roots.has(session) && !isReported) { seen(session, state); return }
    pending.delete(session)
    // The counter moved when the event arrived (seen); this only records the state of the newest event.
    if (state === 'working') {
      roots.set(session, 'busy')
      sawBusy.add(session)
      // A busy event after a wake is what the settle wait was for.
      endSettle(session)
      ending.delete(session)
      run()
      openIfOwed(session)
      return
    }
    roots.set(session, 'idle')
    ending.delete(session)
    run()
    deliver(session)
  }
  return {
    note,
    seen,
    drop,
    // The tool is bound to the session id the host gives each call, so a call cannot name another session.
    tools: {
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
