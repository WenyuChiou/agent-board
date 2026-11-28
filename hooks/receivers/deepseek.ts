import { SURFACE_IDS } from '../messaging.ts'

// DeepSeek Harness receives a board message in its own process (#725). The agent-board-local plugin keeps
// each root session's board mailbox open, so that session's card has a Send box. When a message waits and
// the session is idle, the plugin takes it through the board script and gives it to the session with
// Agent.followup, which wakes the session and starts a turn (dsh 0.2.2-rc.1: dsh-agent-loop followup, the
// call dsh's own browser prompt uses). It then marks the message delivered. A take that lands while the session
// works is given back at once, and the next idle takes it again, so no lease runs out on a message only the plugin
// holds (#1870). A subagent's session
// (header.origin 'subagent') never receives one. Nothing here reads the conversation.
export const messagingReceiver = {
  host: 'DeepSeek Harness',
  agent: 'deepseek',
  kind: 'mailbox',
  surfaces: [{ name: 'Web', id: SURFACE_IDS.web, evidence: 'docs/validation/2026-11-08-deepseek-harness-live.md' }, { name: 'TUI', id: SURFACE_IDS.tui, evidence: null }],
  tier: 1,
  primitive: '[P1]',
  isImplemented: true,
  // Idle: the live run woke the session within seconds. Working: the plugin gives a claim back and takes it
  // again when the session is idle (tests only; the live note says a long busy session was not run). Ended: no mailbox.
  // The live run was `dsh web` only, so the idle record names the Web surface; the terminal interface keeps Copy.
  routes: {
    idle: { line: 'now', record: 'docs/validation/2026-11-08-deepseek-harness-live.md', surfaces: [SURFACE_IDS.web] },
    working: { line: 'stepEnd', record: null, surfaces: [SURFACE_IDS.web] },
    ended: { line: 'none', record: null, surfaces: [SURFACE_IDS.web] },
  },
}

// A bare option can consume the following argument, so do not infer a mode from an ambiguous command.
export const detectDeepseekSurface = (args: readonly string[]): 'Web' | 'unknown' => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--profile') { index++; continue }
    if (arg.startsWith('-')) { if (arg.includes('=')) continue; return 'unknown' }
    return arg === 'web' ? 'Web' : 'unknown'
  }
  return 'unknown'
}

// The receiver's part of the generated plugin: module-level code that the plugin's apply wires to the
// agent/created, agent/status and agent/disposed events. It uses the plugin's own hookError.
export const deepseekReceiverSource = (node: string, board: string, progress: string, home: string): string => `import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import { spawn as spawnMailbox } from 'node:child_process'
// The board only sends when the command identifies the recorded Web surface.
const detectSurface = ${detectDeepseekSurface.toString()}
const surface = detectSurface(process.argv.slice(2))
// One call to the board script's --mailbox; its one JSON line, or null when it failed or took too long.
const mailboxCall = (action, session, extra = [], wait = 15000) => new Promise(resolve => {
  let child, timer, output = ''
  const finish = value => { clearTimeout(timer); resolve(value) }
  try {
    child = spawnMailbox(${JSON.stringify(node)}, [${JSON.stringify(board)}, '--mailbox', action, '--agent', 'deepseek', '--home', ${JSON.stringify(home)}, '--progress-file', ${JSON.stringify(progress)}, '--session', session, '--surface', surface, ...extra], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  } catch { return resolve(null) }
  timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} resolve(null) }, wait)
  child.on('error', () => finish(null))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { if (output.length < 262144) output += chunk })
  child.on('close', code => {
    try { finish(code === 0 ? JSON.parse(output.trim().split(/\\r?\\n/).pop()) : null) } catch { finish(null) }
  })
})
const deepFreeze = value => {
  if (value !== null && typeof value === 'object') { for (const one of Object.values(value)) deepFreeze(one); Object.freeze(value) }
  return value
}
// The message shape createUserMessage of @deepseek-ai/dsh-llm makes, built by hand: a plugin loaded by
// file URL cannot import that package. Its own source kind, as dsh's reminders have (kind 'schedule'), makes
// dsh's page show it as one folded line, the board and the answer, rather than as text the person typed.
const boardMessage = (text, summary) => deepFreeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: typeof summary === 'string' && summary !== '' ? { kind: 'agent-board', form: 'notice', summary } : { kind: 'agent-board' } })
const sessionOf = agent => {
  const id = agent?.session?.header?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}
// A take the board answers with deferred (its store was busy, so nothing was checked) is asked again, for that
// session only, 250 ms later, this many times in a row: about 5 s, the 5000 ms a take itself is given, which outlasts
// the stalls of a few seconds seen on a busy computer. After that the watcher and the ten-minute tick are all there is.
const DEFERRED_ASKS = 20
// The board's lease on a claim (MAILBOX_LEASE_MS): after it, a claim nobody accepted reads Unsure and is not the plugin's to give.
const LEASE_MS = 30000
// How long a receiver waits before it gives a kept claim back again while its session works, and how long it lets one
// give-back run.
const GIVE_BACK_MS = 1000
const GIVE_BACK_CALL_MS = 5000
const HOLDER_LOST = 'HOLDER_LOST'
const mailboxReceiver = () => {
  const roots = new Map(), busy = new Set(), failing = new Set(), again = new Map(), stashed = new Map(), asks = new Map(), retries = new Map(), regives = new Map()
  let watcher = null, folder = null, pending = null, timer = null, ticks = 0
  // A named claim the plugin kept because its give-back failed goes to the session only when the session went idle inside
  // the board's lease and the board still holds it for this claim: same nonce and name, no error, or past the lease only the
  // HOLDER_LOST the lease's end wrote, which drops the name (a claim so marked is never handed to anyone else, and an accept
  // still settles it). An older board's claim names nothing, cannot be given back, and that board keeps it for this plugin
  // past its lease, so it keeps the old rule: it goes at the next idle while the board holds it. An answer with no name is
  // trusted only while the board holds the claim with no name either.
  const readClaim = message => {
    if (folder === null) return undefined
    let store
    try { store = JSON.parse(readFileSync(join(folder, 'messages.json'), 'utf8')) } catch { return null }
    const live = Array.isArray(store?.messages) && store.messages.find(one => one?.id === message.id)
    return live && live.status === 'uncertain' && live.nonce === message.nonce ? live : null
  }
  const isHeld = (message, live) => Boolean(live && (!live.error || live.error === '')
    && (typeof message.ref === 'string' ? live.ref === message.ref : typeof live.ref !== 'string'))
  const isDeliverable = (message, asked) => {
    const live = readClaim(message)
    if (live === undefined) return typeof message.ref !== 'string'
    if (typeof message.ref !== 'string') return isHeld(message, live)
    if (!live || typeof live.claimed !== 'number' || asked - live.claimed >= LEASE_MS) return false
    return isHeld(message, live) || live.error === HOLDER_LOST && live.ref === undefined && Date.now() - live.claimed >= LEASE_MS
  }
  // When the board's lease on a kept named claim ends, by the board's own claim time; 0 once the board no longer holds it.
  const leaseEnd = message => {
    const live = readClaim(message)
    return isHeld(message, live) && typeof live.claimed === 'number' ? live.claimed + LEASE_MS : 0
  }
  // Gives a claim back to the board, which queues it again for the next take. True when the board no longer holds it for
  // this claim. A take from an older board names no claim, so there is nothing to give back.
  const giveBack = async (session, message) => {
    if (typeof message.ref !== 'string') return false
    const answer = await mailboxCall('release', session, ['--ref', message.ref], GIVE_BACK_CALL_MS)
    return answer?.ok === true || answer?.code === 'NOT_HELD'
  }
  // A named claim whose give-back failed is given back again every second while the session works, up to the end of the
  // board's lease, so a board that recovers queues it again before it reads Unsure. An idle that comes during a try waits
  // for it and then hands the kept claim over by the time it came (isDeliverable), so a try that ends after the lease does
  // not cost that idle the message.
  const keep = (session, agent, message) => {
    stashed.set(session, message)
    if (typeof message.ref !== 'string') return
    const later = () => {
      if (Date.now() + GIVE_BACK_MS >= leaseEnd(message)) return
      const one = setTimeout(attempt, GIVE_BACK_MS)
      one.unref?.()
      regives.set(session, one)
    }
    const attempt = async () => {
      regives.delete(session)
      if (stashed.get(session) !== message || roots.get(session) !== agent || agent.status === 'idle') return
      if (busy.has(session)) { later(); return }
      busy.add(session)
      try {
        if (await giveBack(session, message)) { if (stashed.get(session) === message) stashed.delete(session) }
        else later()
      } finally {
        busy.delete(session)
        if (again.has(session)) { const asked = again.get(session); again.delete(session); const current = roots.get(session); if (current !== undefined) deliver(current, asked) }
      }
    }
    later()
  }
  const unkeep = session => { stashed.delete(session); clearTimeout(regives.get(session)); regives.delete(session) }
  // asked: when this idle came, which a deliver that waited for another call keeps.
  const deliver = async (agent, asked = Date.now()) => {
    const session = sessionOf(agent)
    if (session === undefined || roots.get(session) !== agent || agent.status !== 'idle') return
    // A message the board writes while a take is under way is taken right after it, not at the next tick.
    if (busy.has(session)) { if (!again.has(session)) again.set(session, asked); return }
    busy.add(session)
    try {
      let message = stashed.get(session)
      if (message !== undefined) {
        unkeep(session)
        // A kept claim the board no longer holds (a give-back it saved but whose answer was lost, a dismissal, a lease
        // that ran out) is dropped, and this idle takes afresh, so a message queued again is not left for a later idle.
        if (!isDeliverable(message, asked)) message = undefined
      }
      if (message === undefined) {
        const taken = await mailboxCall('take', session)
        // A session that closed while its take ran (or was added again as a new agent) changes nothing: no
        // watcher, no failure log and no count or timer, since its id can come back as a new session, which
        // starts with every ask. A message it took runs out its claim and goes out again.
        if (roots.get(session) !== agent) return
        // A board script that is missing, fails or does not answer keeps the card from offering Send. It is
        // logged once, until a call works again, so a timer that keeps asking does not fill the log.
        if (taken === null || typeof taken !== 'object') {
          if (!failing.has(session)) { failing.add(session); hookError('MAILBOX_FAILED') }
          return
        }
        failing.delete(session)
        if (typeof taken.watch === 'string') follow(taken.watch)
        message = taken.message
        if (message == null && taken.deferred === true) {
          const asked = (asks.get(session) ?? 0) + 1
          asks.set(session, asked)
          // Its own timer, so one session's asks never take for another session or use up another's count.
          if (asked <= DEFERRED_ASKS && folder !== null) {
            clearTimeout(retries.get(session))
            const retry = setTimeout(() => { retries.delete(session); check(session) }, 250)
            retry.unref?.()
            retries.set(session, retry)
          }
        } else {
          // A plain answer ends the run of asks; an earlier timer still armed would start a take it no longer needs.
          asks.delete(session)
          clearTimeout(retries.get(session))
          retries.delete(session)
        }
      }
      if (message == null) return
      if (typeof message.text !== 'string' || typeof message.id !== 'string' || typeof message.nonce !== 'string') throw new Error('MAILBOX_FAILED')
      // A session that closed meanwhile does not get it: the claim runs out and the board hands it out again.
      if (roots.get(session) !== agent) return
      // The session started a turn while the take ran: the claim goes back, and the next idle takes it again (#1870).
      // Only a give-back that failed keeps it here: given back again while the session works, else for the next idle inside its lease.
      if (agent.status !== 'idle') {
        if (!(await giveBack(session, message))) keep(session, agent, message)
        return
      }
      // Given first, then marked delivered: if the mark fails, the claim runs out and the session may get the
      // same answer again, which beats losing it. Awaited, so a followup that fails is never marked delivered.
      await agent.followup(boardMessage(message.text, message.summary))
      const accepted = await mailboxCall('accept', session, ['--id', message.id, '--nonce', message.nonce])
      if (accepted?.ok !== true) throw new Error('MAILBOX_FAILED')
    } catch { hookError('MAILBOX_FAILED') }
    finally {
      busy.delete(session)
      // A message that came in meanwhile goes to the session's current agent: the one whose take this was may
      // have been replaced by a new agent with the same id, which only set the flag.
      if (again.has(session)) { const asked = again.get(session); again.delete(session); const current = roots.get(session); if (current !== undefined) deliver(current, asked) }
    }
  }
  // The board rewrites messages.json whenever it queues a message: a session with one waiting takes it.
  // An ask again after a deferred take passes its session, and only that session takes.
  const check = only => {
    let store
    try { store = JSON.parse(readFileSync(join(folder, 'messages.json'), 'utf8')) } catch { return }
    const waiting = new Set((Array.isArray(store?.messages) ? store.messages : []).filter(one => one?.status === 'queued' && typeof one.to === 'string').map(one => one.to))
    for (const [session, agent] of roots) if ((only === undefined || only === session) && (waiting.has('deepseek:' + session) || stashed.has(session))) deliver(agent)
  }
  const follow = directory => {
    if (watcher !== null && folder === directory) return
    try { watcher?.close() } catch {}
    watcher = null
    folder = directory
    try {
      const current = watch(directory, { persistent: false }, (_event, name) => {
        // A removed folder can keep reporting itself indefinitely on Windows.
        if (name !== 'messages.json' && !existsSync(directory)) {
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
      current.on('error', () => { try { current.close() } catch {} if (watcher === current) watcher = null })
    } catch { watcher = null }
  }
  // With no folder to watch yet (no board has run), each idle session asks once a minute; with one, every
  // ten minutes, which keeps its mailbox open and takes a message whose earlier claim ran out.
  const tick = () => {
    ticks += 1
    if (watcher === null || ticks % 10 === 0) for (const agent of roots.values()) deliver(agent)
  }
  return {
    add: agent => {
      const session = sessionOf(agent)
      if (session === undefined || agent?.session?.header?.origin === 'subagent') return
      roots.set(session, agent)
      if (timer === null) { timer = setInterval(tick, 60000); timer.unref?.() }
      deliver(agent)
    },
    idle: agent => { if (roots.get(sessionOf(agent)) === agent) deliver(agent) },
    remove: agent => {
      const session = sessionOf(agent)
      if (session === undefined || roots.get(session) !== agent) return
      roots.delete(session)
      failing.delete(session)
      again.delete(session)
      asks.delete(session)
      clearTimeout(retries.get(session))
      retries.delete(session)
      unkeep(session)
      mailboxCall('end', session)
      if (roots.size > 0) return
      clearInterval(timer)
      timer = null
      try { watcher?.close() } catch {}
      watcher = null
    },
  }
}
`
