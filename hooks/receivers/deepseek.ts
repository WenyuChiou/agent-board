import { SURFACE_IDS } from '../messaging.ts'

// DeepSeek Harness receives a board message in its own process (#725). The agent-board-local plugin keeps
// each root session's board mailbox open, so that session's card has a Send box. When a message waits and
// the session is idle, the plugin takes it through the board script and gives it to the session with
// Agent.followup, which wakes the session and starts a turn (dsh 0.2.2-rc.1: dsh-agent-loop followup, the
// call dsh's own browser prompt uses). It then marks the message delivered. A subagent's session
// (header.origin 'subagent') never receives one. Nothing here reads the conversation.
export const messagingReceiver = {
  host: 'DeepSeek Harness',
  agent: 'deepseek',
  kind: 'mailbox',
  surfaces: [{ name: 'Web', id: SURFACE_IDS.web, evidence: 'docs/validation/2026-11-08-deepseek-harness-live.md' }, { name: 'TUI', id: SURFACE_IDS.tui, evidence: null }],
  tier: 1,
  primitive: '[P1]',
  isImplemented: true,
  // Idle: the live run woke the session within seconds. Working: the plugin holds the message until the
  // session is idle (tests only; the live note says a long busy session was not run). Ended: no mailbox.
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
const mailboxCall = (action, session, extra = []) => new Promise(resolve => {
  let child, timer, output = ''
  const finish = value => { clearTimeout(timer); resolve(value) }
  try {
    child = spawnMailbox(${JSON.stringify(node)}, [${JSON.stringify(board)}, '--mailbox', action, '--agent', 'deepseek', '--home', ${JSON.stringify(home)}, '--progress-file', ${JSON.stringify(progress)}, '--session', session, '--surface', surface, ...extra], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  } catch { return resolve(null) }
  timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} resolve(null) }, 15000)
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
const mailboxReceiver = () => {
  const roots = new Map(), busy = new Set(), failing = new Set(), again = new Set(), stashed = new Map(), asks = new Map(), retries = new Map()
  let watcher = null, folder = null, pending = null, timer = null, ticks = 0
  const isDeliverable = message => {
    if (folder === null) return true
    let store
    try { store = JSON.parse(readFileSync(join(folder, 'messages.json'), 'utf8')) } catch { return false }
    const live = Array.isArray(store?.messages) && store.messages.find(one => one?.id === message.id)
    return Boolean(live && live.status === 'uncertain' && live.nonce === message.nonce && (!live.error || live.error === ''))
  }
  const deliver = async agent => {
    const session = sessionOf(agent)
    if (session === undefined || roots.get(session) !== agent || agent.status !== 'idle') return
    // A message the board writes while a take is under way is taken right after it, not at the next tick.
    if (busy.has(session)) { again.add(session); return }
    busy.add(session)
    try {
      let message = stashed.get(session)
      if (message !== undefined) {
        stashed.delete(session)
        if (!isDeliverable(message)) return
      } else {
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
      if (agent.status !== 'idle') {
        stashed.set(session, message)
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
      if (again.delete(session)) { const current = roots.get(session); if (current !== undefined) deliver(current) }
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
      stashed.delete(session)
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
