// The Claude Code end of connected-session messaging (#316): this session registers with the
// board's message hub, takes one message at a time when it is idle, starts one turn with it and
// reports what happened. Pure: the module has no network or files, so register.tsx hands in what
// it needs through ReceiverDeps. The hub's contract is docs/MESSAGING.md.
import type { ReceiverPending, ReceiverState } from '../types'
import { sha256 } from './sha256'

export const RECEIVER_MS = 2000
// The hub keeps a lease for 15 s, so a page that was closed stops offering Send within that.
const LEASE_FALLBACK_MS = 15_000
const REGISTER_AGAIN_MS = 10_000
// A receiver that finds itself contested tries again once the lease of a lost self has run out.
const CONTEST_AGAIN_MS = 16_000
// A prompt handed to the engine with no turn to show for it, in an idle session.
const SUBMIT_GRACE_MS = 30_000
const ACK_ROOM = 200

export const emptyReceiver = (): ReceiverState => ({ session: '', connection: '', secret: '', leaseUntil: 0, pending: null, isStopped: false })

export type BoardAddress = { origin: string; token: string }
export type HubAnswer = { status: number; json: unknown }

export type ReceiverDeps = {
  session: () => Promise<string>
  address: () => Promise<BoardAddress | null>
  call: (address: BoardAddress, action: string, body: Record<string, unknown>) => Promise<HubAnswer>
  isBusy: () => boolean
  now: () => Promise<number>
  submit: (text: string) => Promise<{ drop?: string | undefined }>
  load: () => Promise<ReceiverState | undefined>
  save: (state: ReceiverState) => Promise<void>
}

// The same progress.md named two ways is one board. Node's path.resolve for a path that is
// already absolute; anything else has no board this module can name.
export const addressKey = (path: string): string | null => {
  const isWin = /^[A-Za-z]:[\\/]/.test(path)
  if (!isWin && !path.startsWith('/')) return null
  const parts: string[] = []
  for (const part of (isWin ? path.slice(2) : path).split(isWin ? /[\\/]+/ : /\/+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }

  return isWin ? `${path.slice(0, 2)}\\${parts.join('\\')}` : `/${parts.join('/')}`
}

// One address file per progress.md; scripts/board-cli.ts writes it and this names it the same way.
export const addressFileName = (key: string): string => `agent-board-${sha256(key).slice(0, 16)}.json`

// Which folder holds the address, as board-cli.ts's runFolder chooses it. A folder this module
// cannot show is the account's own gives no address: the card stays on Copy. On Windows that is a
// runtime folder someone set, as $.fs cannot read its access list.
export const addressFolder = (isWindows: boolean, home: string, runtime: string | undefined, isRuntimeOwn: boolean): string | null => {
  if (home === '') return null
  const sep = isWindows ? '\\' : '/'
  const cache = [home.replace(/[\\/]+$/, ''), '.cache', 'agent-board'].join(sep)
  if (runtime === undefined || runtime === '') return cache
  if (isWindows) return null

  return isRuntimeOwn ? runtime : cache
}

export const parseAddress = (text: string, key: string): BoardAddress | null => {
  try {
    const found = JSON.parse(text) as { url?: unknown; path?: unknown } | null
    if (found === null || typeof found !== 'object' || typeof found.url !== 'string' || typeof found.path !== 'string') return null
    // Its token is good only for the board it names, and only over this computer's own loopback.
    if (addressKey(found.path) !== key) return null
    const parts = /^(http:\/\/127\.0\.0\.1:\d+)\/?\?(?:[^#]*&)?t=([^&#]+)/.exec(found.url)
    if (parts === null || parts[1] === undefined || parts[2] === undefined) return null
    return { origin: parts[1], token: decodeURIComponent(parts[2]) }
  } catch { return null }
}

// The line the hub takes as this delivery's ACK: the reply's own first line, nothing past it. A
// first line over the room keeps the ACK alone.
export const ackLine = (answer: string, nonce: string): string | null => {
  const line = (answer.split(/\r\n|\r|\n/, 1)[0] ?? '').trim()
  const ack = `ACK ${nonce}`
  if (line !== ack && !line.startsWith(`${ack} `)) return null
  return line.length > ACK_ROOM ? ack : line
}

export type Receiver = {
  tick: () => Promise<void>
  // True when this turn is the delivery's: its text and answer stay out of the board's records.
  turnStarted: (text: string, turnId: string) => Promise<boolean>
  turnEnded: (turnId: string, answer: string, isAborted: boolean) => Promise<boolean>
  end: () => Promise<void>
}

const isMessage = (one: unknown): one is { id: string; nonce: string; prompt: string } => {
  const message = one as { id?: unknown; nonce?: unknown; prompt?: unknown } | null
  return typeof message?.id === 'string' && typeof message.nonce === 'string' && typeof message.prompt === 'string' && message.prompt !== ''
}

export const createReceiver = (deps: ReceiverDeps): Receiver => {
  let held: ReceiverState | null = null
  let address: BoardAddress | null = null
  let isTicking = false
  let isSubmitting = false
  let registerAfter = 0
  let contestAfter = 0

  const state = async (): Promise<ReceiverState> => (held ??= (await deps.load().catch(() => undefined)) ?? emptyReceiver())
  const set = async (change: Partial<ReceiverState>): Promise<void> => {
    held = { ...(await state()), ...change }
    await deps.save(held).catch(() => undefined)
  }
  const call = async (action: string, body: Record<string, unknown>): Promise<HubAnswer | null> => {
    if (address === null) return null
    return deps.call(address, action, body).catch(() => null)
  }
  // Receipts past the boundary are never sent twice: one that does not arrive leaves the card on
  // what it last said. 'unreached' says the hub may not have seen it; 'refused' that it answered no.
  const receipt = async (pending: ReceiverPending, status: string, extra: { reply?: string; error?: string } = {}): Promise<'done' | 'refused' | 'unreached'> => {
    const { connection, secret } = await state()
    const answer = await call('receipt', { connection, secret, id: pending.id, nonce: pending.nonce, status, ...extra })
    if (answer === null || answer.status >= 500) return 'unreached'
    return answer.status === 200 ? 'done' : 'refused'
  }

  const register = async (session: string, now: number): Promise<void> => {
    if (now < registerAfter) return
    registerAfter = now + REGISTER_AGAIN_MS
    address = await deps.address().catch(() => null)
    if (address === null) return
    const { connection, secret, session: was } = await state()
    const replaces = connection !== '' && was === session ? { connection, secret } : {}
    const answer = await call('register', { agent: 'claude', session, surface: 'Claude Code', turn: 'session', scope: 'session', ...replaces })
    const made = answer?.json as { id?: unknown; secret?: unknown; leaseMs?: unknown } | undefined
    if (answer?.status !== 200 || typeof made?.id !== 'string' || typeof made.secret !== 'string') {
      // Credentials of a page that is gone, or of its last run, are not asked about again.
      if (answer !== null && answer !== undefined && answer.status < 500) await set({ connection: '', secret: '', leaseUntil: 0 })
      return
    }
    registerAfter = 0
    await set({ session, connection: made.id, secret: made.secret, leaseUntil: now + (typeof made.leaseMs === 'number' ? made.leaseMs : LEASE_FALLBACK_MS) })
  }

  const finish = async (change: Partial<ReceiverState> = {}): Promise<void> => set({ pending: null, ...change })

  const deliver = async (pending: ReceiverPending): Promise<void> => {
    // The boundary: past this receipt the message may have reached Claude. Refused (taken back),
    // it never reaches the engine. Unanswered, nothing has reached Claude yet, so it is asked again.
    const accepted = await receipt(pending, 'accepted')
    if (accepted === 'refused') return finish()
    if (accepted === 'unreached') return
    const submittedAt = await deps.now()
    await set({ pending: { ...pending, phase: 'submitted', submittedAt } })
    isSubmitting = true
    deps.submit(pending.prompt).then(async entered => {
      isSubmitting = false
      if (entered.drop === undefined) return
      await receipt(pending, 'rejected', { error: 'STOPPED' })
      await finish({ isStopped: true })
    }, async () => {
      isSubmitting = false
      await receipt(pending, 'uncertain', { error: 'DELIVERY_UNCERTAIN' })
      await finish()
    }).catch(() => undefined)
  }

  const poll = async (now: number): Promise<void> => {
    const { connection, secret, pending, isStopped } = await state()
    const canTake = pending === null && !isStopped && !deps.isBusy()
    const answer = await call('poll', { connection, secret, turn: 'session', receive: canTake })
    if (answer === null || answer.status >= 500) {
      // The page may be back; a lease that ran out is registered again, with no message resent.
      if (now >= (await state()).leaseUntil) address = null
      return
    }
    if (answer.status !== 200) {
      address = null
      await set({ connection: '', secret: '', leaseUntil: 0 })
      return
    }
    const polled = answer.json as { messages?: unknown; leaseMs?: unknown; contested?: unknown }
    await set({ leaseUntil: now + (typeof polled.leaseMs === 'number' ? polled.leaseMs : LEASE_FALLBACK_MS) })
    // Polling keeps a contested connection alive, so it would never clear. It may be contested by
    // a lost self (a register whose answer never came, a process killed moments ago) whose lease
    // ends unrenewed. Another live window keeps it contested, which is right: the card stays on Copy.
    if (polled.contested === true) {
      if (now >= contestAfter) {
        contestAfter = now + CONTEST_AGAIN_MS
        registerAfter = 0
        await register((await state()).session, now)
      }
      return
    }
    const message = Array.isArray(polled.messages) ? polled.messages[0] : undefined
    if (message === undefined) return
    if (!isMessage(message)) return
    await set({ pending: { id: message.id, nonce: message.nonce, prompt: message.prompt, phase: 'claimed' } })
  }

  return {
    tick: async () => {
      if (isTicking) return
      isTicking = true
      try {
        const session = await deps.session()
        const now = await deps.now()
        const before = await state()
        // /clear and the like make this another session: the old address ends with it.
        if (before.session !== '' && before.session !== session && before.connection !== '') {
          if (address !== null) await call('disconnect', { connection: before.connection, secret: before.secret, turn: 'session' })
          await set({ connection: '', secret: '', leaseUntil: 0, pending: null, isStopped: false })
        }
        if (address === null || (await state()).connection === '') await register(session, now)
        if (address === null || (await state()).connection === '') return
        await poll(now)
        const { pending } = await state()
        if (pending === null) return
        if (pending.phase === 'claimed' && !deps.isBusy()) await deliver(pending)
        // Handed over and nothing came of it, as after a reload that lost the engine's answer.
        else if (pending.phase === 'submitted' && !isSubmitting && !deps.isBusy() && now - (pending.submittedAt ?? now) >= SUBMIT_GRACE_MS) {
          await receipt(pending, 'uncertain', { error: 'DELIVERY_UNCERTAIN' })
          await finish({ late: pending })
        }
      } finally { isTicking = false }
    },
    turnStarted: async (text, turnId) => {
      const { pending, isStopped, late } = await state()
      if (pending !== null && pending.phase !== 'running' && text.includes(`<<<AB-${pending.nonce}`)) {
        await set({ pending: { ...pending, phase: 'running', turnId } })
        return true
      }
      if (late !== null && late !== undefined && text.includes(`<<<AB-${late.nonce}`)) {
        await set({ late: { ...late, turnId } })
        return true
      }
      // Someone else's turn: the person's own, which also lifts a stop.
      if (isStopped) await set({ isStopped: false })
      return false
    },
    turnEnded: async (turnId, answer, isAborted) => {
      const { pending, late } = await state()
      if (late !== null && late !== undefined && late.turnId === turnId) {
        const line = isAborted ? null : ackLine(answer, late.nonce)
        if (line !== null) await receipt(late, 'acknowledged', { reply: line })
        await set({ late: null })
        return true
      }
      if (pending === null || pending.phase !== 'running' || pending.turnId !== turnId) return false
      const line = isAborted ? null : ackLine(answer, pending.nonce)
      if (line !== null) await receipt(pending, 'acknowledged', { reply: line })
      else await receipt(pending, 'uncertain', { error: isAborted ? 'TURN_ABORTED' : 'ACK_MISSING' })
      await finish()
      return true
    },
    end: async () => {
      const { connection, secret } = await state()
      if (connection !== '' && address !== null) await call('disconnect', { connection, secret, turn: 'session' })
      await set({ connection: '', secret: '', leaseUntil: 0, pending: null, late: null, isStopped: false })
      registerAfter = 0
    },
  }
}
