import { expect, test } from 'claude-code/testing'
import { blockId, CLAIM_MS, MAX_TRIES, readClaim, RETAKE_PER_LOOK, RETAKE_TRY, retakenFailedName, takenName, withAgentPrompts } from '../hooks/inbox'
import { parseProgress } from '../hooks/parse'
import { buildView } from '../hooks/view'
import { applyDigest } from '../hooks/digest'
import { emptyMirror } from '../hooks/mirror'
import { upsertAutoBlock } from '../hooks/blocks'
import { ZH_TW } from '../hooks/i18n'
import { engineBeneath, makeWorld, INBOX, FILE, PANE, PROPS } from './fixtures/pane-world'
import type { World } from './fixtures/pane-world'

const AT = Date.parse('2026-10-16T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const QUEUE_LIMIT = 10
const reply = (): string => 'TITLE: Backlog work\nCONTEXT: Synthetic backlog\nDONE: Added the middleware\nNEXT: Check the errors\nASK: -'
const body = (session: string): string => JSON.stringify({ session_id: session, cwd: `/work/${session}`, prompt: 'Add the middleware', last_assistant_message: `Added the middleware for ${session}.` })
const nameOf = (at: number, index = 1): string => `codex-turn-${at}-${index}.json`
const takenOf = (world: World): string[] => [...world.files.keys()].filter(path => path.endsWith('.taking'))
const failedOf = (world: World): string[] => [...world.files.keys()].filter(path => path.endsWith('.failed'))
const viewOf = (world: World, at = AT + 5000) => buildView(parseProgress(world.files.get(FILE) ?? ''), [], null, at)
const backlog = (count: number): World => {
  const world = makeWorld([[FILE, '# Progress\n']])
  world.reply = reply
  world.asked = []
  world.ran = []
  world.clockOffset = 0
  for (let index = 0; index < count; index += 1) world.files.set(`${INBOX}/${nameOf(AT - 60_000, index)}`, body(`backlog-${index}`))
  return world
}

test('a held turn two days old is written with its own time and the row reads as stopped, out of the counts', { timeoutMs: 30_000 }, async ($, on) => {
  const source = AT - 2 * DAY
  const world = makeWorld([[FILE, '# Progress\n'], [`${INBOX}/${nameOf(source)}`, body('old-work')]])
  world.reply = reply
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain(`updated=${new Date(source).toISOString()}`)
  expect(viewOf(world).stopped).toHaveLength(1)
  expect(viewOf(world).overview.active).toBe(0)
  expect(viewOf(world).overview.waiting).toBe(0)
})

test('a held turn five minutes old is written with its own time and the row is live', { timeoutMs: 30_000 }, async ($, on) => {
  const source = AT - 5 * 60_000
  const world = makeWorld([[FILE, '# Progress\n'], [`${INBOX}/${nameOf(source)}`, body('live-work')]])
  world.reply = reply
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain(`updated=${new Date(source).toISOString()}`)
  expect(viewOf(world).stopped).toHaveLength(0)
  expect(viewOf(world).overview.active).toBe(1)
})

test('held turns of one conversation, old and new, write the newest turn\'s own time', { timeoutMs: 30_000 }, async ($, on) => {
  const source = AT - 60_000
  const world = makeWorld([[FILE, '# Progress\n'], [`${INBOX}/${nameOf(source)}`, body('same-work')], [`${INBOX}/${nameOf(AT - 2 * DAY)}`, body('same-work').replace('Added the middleware', 'Started the middleware')]])
  world.reply = reply
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain(`updated=${new Date(source).toISOString()}`)
  expect(viewOf(world).overview.active).toBe(1)
})

test('a held turn whose time is in the future is written with the time of the read', { timeoutMs: 30_000 }, async ($, on) => {
  const world = makeWorld([[FILE, '# Progress\n'], [`${INBOX}/${nameOf(AT + DAY)}`, body('future-work')]])
  world.reply = reply
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain(`updated=${new Date(AT + 5000).toISOString()}`)
})

test('a held turn with no source clock is written with the time of the read', { timeoutMs: 30_000 }, async ($, on) => {
  const world = makeWorld([[FILE, '# Progress\n'], [`${INBOX}/codex-turn-unknown.json`, body('unknown-work')]])
  world.reply = reply
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain(`updated=${new Date(AT + 5000).toISOString()}`)
})

test('a newer duplicate reply does not replace the time of work that changed the block', { timeoutMs: 30_000 }, async ($, on) => {
  const source = AT - 2 * DAY
  const world = makeWorld([[FILE, '# Progress\n'], [`${INBOX}/${nameOf(source)}`, body('duplicate-work')]])
  world.reply = reply
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  world.files.set(`${INBOX}/${nameOf(AT - 60_000)}`, body('duplicate-work'))
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain(`updated=${new Date(source).toISOString()}`)
  expect(viewOf(world).overview.active).toBe(0)
})

test('a held prompt two days old does not make its row look new', { timeoutMs: 30_000 }, async ($, on) => {
  const source = AT - 2 * DAY
  const session = 'prompt-work'
  const id = blockId('codex', session)
  const mirror = { ...applyDigest(emptyMirror(id, session, source - 1000, `/work/${session}`, 'codex'), { title: 'Backlog work', context: '', done: '', next: 'Check the errors', ask: 'Database', why: 'Use staging?' }, source - 1000), resume: session, turnOrder: (source - 1000) * 2 }
  const world = makeWorld([[FILE, upsertAutoBlock('# Progress\n', mirror, ZH_TW)], [`${INBOX}/codex-prompt-${source}-1.json`, JSON.stringify({ session_id: session })]])
  world.store![`agent:${id}`] = mirror
  world.asked = []
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain(`updated=${new Date(source).toISOString()}`)
  expect(world.files.get(FILE)).toContain('state=working')
  expect(world.files.get(FILE)).not.toContain('- [?]')
  const receipts = Object.entries(world.store!).filter(([key]) => key.startsWith(`agentPrompt:${id}:`)).map(([, value]) => value)
  expect(withAgentPrompts(mirror, receipts, AT + 5000)?.updated).toBe(source)
  expect(viewOf(world).stopped).toHaveLength(1)
  expect(viewOf(world).overview.active).toBe(0)
  expect(world.asked).toEqual([])
})

test('a file waiting in this session\'s queue is not taken again, and no try is used up before the model sees it', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(2)
  let reached!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  world.holdComplete = { reached, release: new Promise<void>(resolve => { release = resolve }) }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  await entered
  const before = takenOf(world)
  world.clockOffset = CLAIM_MS + 1
  world.mtime += 1
  await clock.advance(5000)
  const waiting = takenOf(world)
  const askedWhileHeld = world.asked!.length
  const setAside = failedOf(world)
  release()
  await clock.advance(1000)
  expect(waiting).toEqual(before)
  expect(waiting.map(path => readClaim(path.split('/').at(-1)!)?.attempt)).toEqual([1, 1])
  expect(askedWhileHeld).toBe(1)
  expect(setAside).toEqual([])
  expect(world.files.get(FILE)).toContain('## backlog-0\n')
  expect(world.files.get(FILE)).toContain('## backlog-1\n')
  expect(failedOf(world)).toEqual([])
  expect(takenOf(world)).toEqual([])
})

test('with 1,400 new files waiting, at most a queue\'s worth is taken while the model is slow', { timeoutMs: 60_000 }, async ($, on) => {
  const world = backlog(1400)
  let reached!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  world.holdComplete = { reached, release: new Promise<void>(resolve => { release = resolve }) }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  await entered
  const counts = [takenOf(world).length]
  for (let look = 0; look < 3; look += 1) {
    world.mtime += 1
    await clock.advance(5000)
    counts.push(takenOf(world).length)
  }
  const askedWhileHeld = world.asked!.length
  release()
  await clock.advance(1000)
  expect(Math.max(...counts)).toBeLessThanOrEqual(QUEUE_LIMIT)
  expect(askedWhileHeld).toBe(1)
  expect(failedOf(world)).toEqual([])
})

test('100 claims left by a closed session are retaken or set aside within a few looks, even with 1,400 new files waiting', { timeoutMs: 120_000 }, async ($, on) => {
  const world = backlog(1400)
  const claims: string[] = []
  for (let index = 0; index < 100; index += 1) {
    const name = nameOf(AT - DAY, index)
    const claim = `${INBOX}/${takenName(name, 'deadbeef', AT - CLAIM_MS - 1)}`
    claims.push(claim)
    world.files.set(claim, body(`closed-${index}`))
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  for (let look = 0; look < Math.ceil(100 / QUEUE_LIMIT) + 1; look += 1) {
    world.mtime += 1
    await clock.advance(5000)
  }
  expect(claims.filter(path => world.files.has(path))).toEqual([])
  for (let index = 0; index < 100; index += 1) expect(world.files.get(FILE)).toContain(`## closed-${index}\n`)
  expect(failedOf(world)).toEqual([])
})

test('a delivered file whose delete fails once is deleted at the next look and the failure is recorded, not shown', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(1)
  world.failNextRemove = true
  const notified: string[] = []
  on('ui.notify', ($, event) => {
    notified.push(event.text)
    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  const remaining = takenOf(world)
  const recorded = world.store!.inboxDeleteFailed as Record<string, string> | undefined
  const notices = [...notified]
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  const notice = await ui.find({ type: 'Text', text: ZH_TW.inboxTitle })
  world.mtime += 1
  await clock.advance(5000)
  expect(remaining).toHaveLength(1)
  expect(recorded?.[nameOf(AT - 60_000, 0)]).toBe(`1:${AT + 5000}:INBOX_DELETE_FAILED`)
  expect(takenOf(world)).toEqual([])
  expect(world.store!.inboxDeleteFailed).toEqual({})
  expect(notices).toEqual([])
  expect(notified).toEqual([])
  expect(notice).toBeUndefined()
  expect(world.asked).toHaveLength(1)
  await ui.unmount()
})

test('a full queue still deletes delivered claims and sets aside exhausted claims', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(QUEUE_LIMIT)
  let reached!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  world.holdComplete = { reached, release: new Promise<void>(resolve => { release = resolve }) }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  await entered
  const delivered = nameOf(AT - DAY, 100)
  const exhausted = nameOf(AT - DAY, 101)
  const deliveredPath = `${INBOX}/${takenName(delivered, 'deadbeef', AT - CLAIM_MS - 1)}`
  const exhaustedPath = `${INBOX}/${takenName(exhausted, 'deadbeef', AT - CLAIM_MS - 1, 8)}`
  world.files.set(deliveredPath, body('already-delivered'))
  world.files.set(exhaustedPath, body('exhausted'))
  const done = { ...world.store!.inboxDone as Record<string, string> }
  done[delivered] = `previous:${AT}`
  world.store!.inboxDone = done
  const held = nameOf(AT - DAY, 102)
  world.files.set(`${INBOX}/${held}.failed`, body('held-full'))
  world.store!.inboxFailed = { ...world.store!.inboxFailed as Record<string, string>, [exhausted]: `${MAX_TRIES}:${AT}:MODEL_FAILED`, [held]: `${MAX_TRIES}:${AT}:MAX_TRIES` }
  world.mtime += 1
  await clock.advance(5000)
  const deleted = !world.files.has(deliveredPath)
  const setAside = world.files.has(`${INBOX}/${exhausted}.failed`)
  const queueSize = takenOf(world).length
  const isHeld = world.files.has(`${INBOX}/${held}.failed`)
  release()
  await clock.advance(1000)
  expect(deleted).toBe(true)
  expect(setAside).toBe(true)
  expect(queueSize).toBe(QUEUE_LIMIT)
  expect(isHeld).toBe(true)
})

test('a file retaken before any job tried it keeps its attempt', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(1)
  let reached!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  world.holdComplete = { reached, release: new Promise<void>(resolve => { release = resolve }) }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  await entered
  const names = [nameOf(AT - DAY, 501), nameOf(AT - DAY, 502)]
  for (const [index, name] of names.entries()) world.files.set(`${INBOX}/${takenName(name, 'closed', AT - CLAIM_MS - 1, index === 0 ? 1 : MAX_TRIES)}`, body(`untried-${index}`))
  world.mtime += 1
  await clock.advance(5000)
  const claims = takenOf(world).map(path => readClaim(path.split('/').at(-1)!)!).filter(claim => names.includes(claim.name))
  const notes = { ...world.store!.inboxFailed as Record<string, string> }
  const failed = failedOf(world)
  release()
  await clock.advance(1000)
  expect(claims.map(claim => claim.attempt)).toEqual([1, MAX_TRIES])
  expect(notes[names[0]!]).toBeUndefined()
  expect(notes[names[1]!]).toBeUndefined()
  expect(failed).toEqual([])
  for (const name of names) expect((world.store!.inboxDone as Record<string, string>)[name]).toBeDefined()
})

test('a file a job really tried and failed is retaken with its next attempt, and set aside after its last real try', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(1)
  const name = nameOf(AT - 60_000, 0)
  world.failStore = (operation, key) => operation === 'set' && key.startsWith('agent:')
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    if (attempt > 1) world.clockOffset! += CLAIM_MS + 1
    world.mtime += 1
    await clock.advance(5000)
    expect(readClaim(takenOf(world)[0]!.split('/').at(-1)!)?.attempt).toBe(attempt)
    expect((world.store!.inboxFailed as Record<string, string>)[name]).toContain(`${attempt}:`)
    expect((world.store!.inboxFailed as Record<string, string>)[name]).not.toContain('TRYING')
    expect(world.asked).toHaveLength(attempt)
  }
  world.clockOffset! += CLAIM_MS + 1
  world.mtime += 1
  await clock.advance(5000)
  expect(takenOf(world)).toEqual([])
  expect(world.files.has(`${INBOX}/${name}.failed`)).toBe(true)
  expect(world.asked).toHaveLength(MAX_TRIES)
  world.clockOffset! += CLAIM_MS + 1
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.has(`${INBOX}/${name}.failed`)).toBe(true)
  expect(world.asked).toHaveLength(MAX_TRIES)
})

test('a session that closed while trying a file leaves a note, and the retake counts that try', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(1)
  let reached!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  world.holdComplete = { reached, release: new Promise<void>(resolve => { release = resolve }) }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  await entered
  const original = nameOf(AT - 60_000, 0)
  const trying = (world.store!.inboxFailed as Record<string, string>)[original]!
  expect(trying).toBe(`1:${AT + 5000}:TRYING`)
  // A closed session leaves exactly the store marker observed above and its claim.
  const closed = nameOf(AT - DAY, 503)
  world.files.set(`${INBOX}/${takenName(closed, 'closed', AT - CLAIM_MS - 1)}`, body('closed-trying'))
  const notes = { ...world.store!.inboxFailed as Record<string, string> }
  notes[closed] = trying
  world.store!.inboxFailed = notes
  world.mtime += 1
  await clock.advance(5000)
  const claim = takenOf(world).map(path => readClaim(path.split('/').at(-1)!)!).find(one => one.name === closed)
  release()
  await clock.advance(1000)
  expect(claim?.attempt).toBe(2)
  expect((world.store!.inboxFailed as Record<string, string>)[closed]).toBeUndefined()
  expect((world.store!.inboxDone as Record<string, string>)[closed]).toBeDefined()
})

test('a file the old rule set aside without a real try is taken once more after the upgrade and lands', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(0)
  const name = nameOf(AT - DAY, 504)
  const real = nameOf(AT - DAY, 505)
  world.files.set(`${INBOX}/${name}.failed`, body('old-max-tries'))
  world.files.set(`${INBOX}/${real}.failed`, body('real-failure'))
  world.store!.inboxFailed = { [name]: `${MAX_TRIES}:${AT - DAY}:MAX_TRIES`, [real]: `${MAX_TRIES}:${AT - DAY}:MODEL_FAILED` }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(world.files.get(FILE)).toContain('## old-max-tries\n')
  expect(world.files.has(`${INBOX}/${name}.failed`)).toBe(false)
  expect((world.store!.inboxDone as Record<string, string>)[name]).toBeDefined()
  expect((world.store!.inboxFailed as Record<string, string>)[name]).toBeUndefined()
  expect(world.files.has(`${INBOX}/${real}.failed`)).toBe(true)
  expect(world.asked).toHaveLength(1)
})

test('old untried set-asides are limited, oldest first, and a failed extra try never returns', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(0)
  const names = Array.from({ length: RETAKE_PER_LOOK + 1 }, (_, index) => nameOf(AT - DAY + index, 600 + index))
  world.store!.inboxFailed = Object.fromEntries(names.map(name => [name, `${MAX_TRIES}:${AT}:MAX_TRIES`]))
  for (const name of [...names].reverse()) world.files.set(`${INBOX}/${name}.failed`, body(name))
  const excluded = ['INVALID_INPUT', 'MODEL_FAILED', 'QUARANTINE_FAILED', 'MAX_TRIES:extra']
  const notes = world.store!.inboxFailed as Record<string, string>
  for (const [index, reason] of excluded.entries()) {
    const name = nameOf(AT - DAY, 700 + index)
    world.files.set(`${INBOX}/${name}.failed`, body(name))
    notes[name] = `${MAX_TRIES}:${AT}:${reason}`
  }
  const tooMany = nameOf(AT - DAY, 710)
  world.files.set(`${INBOX}/${tooMany}.failed`, body(tooMany))
  notes[tooMany] = `${RETAKE_TRY}:${AT}:MAX_TRIES`
  world.failStore = (operation, key) => operation === 'set' && key.startsWith('agent:')
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  const claims = takenOf(world).map(path => readClaim(path.split('/').at(-1)!)!)
  expect(claims.map(claim => claim.name)).toEqual(names.slice(0, RETAKE_PER_LOOK))
  expect(claims.every(claim => claim.attempt === RETAKE_TRY)).toBe(true)
  world.clockOffset! += CLAIM_MS + 1
  world.mtime += 1
  await clock.advance(5000)
  for (const name of names.slice(0, RETAKE_PER_LOOK)) expect(world.files.has(`${INBOX}/${retakenFailedName(name)}`)).toBe(true)
  const calls = world.asked!.length
  world.clockOffset! += CLAIM_MS + 1
  world.mtime += 1
  await clock.advance(5000)
  // The expired claims occupied this look's retake allowance before removal.
  // Its next look admits the sixth file; earlier failed retakes stay aside.
  expect(world.asked).toHaveLength(calls + 1)
  expect(readClaim(takenOf(world)[0]!.split('/').at(-1)!)?.name).toBe(names[RETAKE_PER_LOOK])
  for (const name of names.slice(0, RETAKE_PER_LOOK)) expect(world.files.has(`${INBOX}/${retakenFailedName(name)}`)).toBe(true)
  world.clockOffset! += CLAIM_MS + 1
  world.mtime += 1
  await clock.advance(5000)
  for (const name of names) expect(world.files.has(`${INBOX}/${retakenFailedName(name)}`)).toBe(true)
  world.mtime += 1
  await clock.advance(5000)
  expect(world.asked).toHaveLength(calls + 1)
  for (const [index] of excluded.entries()) expect(world.files.has(`${INBOX}/${nameOf(AT - DAY, 700 + index)}.failed`)).toBe(true)
  expect(world.files.has(`${INBOX}/${tooMany}.failed`)).toBe(true)
})

test('trying notes stay within the queue and cannot evict notes needed to recover set-aside files', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(QUEUE_LIMIT)
  const notes = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [nameOf(AT - DAY, 1000 + index), `${MAX_TRIES}:${AT - DAY}:${index % 2 === 0 ? 'MAX_TRIES' : 'QUESTION_RETENTION_FAILED'}`]))
  for (const name of Object.keys(notes)) world.files.set(`${INBOX}/${name}.failed`, body(name))
  world.store!.inboxFailed = notes
  let reached!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  world.holdComplete = { reached, release: new Promise<void>(resolve => { release = resolve }) }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  await entered
  const kept = { ...world.store!.inboxFailed as Record<string, string> }
  release()
  await clock.advance(1000)
  const held = Object.entries(kept).filter(([name]) => notes[name] !== undefined)
  expect(held).toHaveLength(200)
  for (const [name, note] of held) expect(note).toBe(notes[name])
  expect(kept[nameOf(AT - 60_000, 0)]).toBe(`1:${AT + 5000}:TRYING`)
  expect(Object.keys(kept)).toHaveLength(201)
  expect(Object.values(kept).filter(note => note.endsWith(':TRYING')).length).toBeLessThanOrEqual(QUEUE_LIMIT)
})

test('an idle inbox look does not rewrite an unchanged delete-failure record', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(0)
  world.files.set(`${INBOX}/unrelated.txt`, 'synthetic')
  let writes = 0
  world.beforeStoreSet = key => { if (key === 'inboxDeleteFailed') writes += 1 }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  world.mtime += 1
  await clock.advance(5000)
  expect(writes).toBe(0)
})

test('delete failure counts increase quietly and clear when another session removes the file', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(1)
  world.isRemoveRefused = path => path.endsWith('.taking')
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  world.mtime += 1
  await clock.advance(5000)
  expect((world.store!.inboxDeleteFailed as Record<string, string>)[nameOf(AT - 60_000, 0)]).toBe(`2:${AT + 10000}:INBOX_DELETE_FAILED`)
  for (const path of takenOf(world)) world.files.delete(path)
  // Keep the directory visible to the in-memory filesystem after external cleanup.
  world.files.set(`${INBOX}/unrelated.txt`, 'synthetic')
  world.mtime += 1
  await clock.advance(5000)
  expect(world.store!.inboxDeleteFailed).toEqual({})
  expect(world.asked).toHaveLength(1)
})

test('notes for set-aside files that are gone are dropped, and a failing file still uses up its tries with 200 set-aside notes in the store', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(1)
  const name = nameOf(AT - 60_000, 0)
  const stale = Array.from({ length: 200 }, (_, index) => nameOf(AT - DAY, 2000 + index))
  world.store!.inboxFailed = Object.fromEntries(stale.map((name, index) => [name, `${MAX_TRIES}:${AT - DAY}:${index % 2 === 0 ? 'MAX_TRIES' : 'QUESTION_RETENTION_FAILED'}`]))
  const session = 'backlog-0'
  const id = blockId('codex', session)
  const earlier = AT - 120_000
  const mirror = { ...applyDigest(emptyMirror(id, session, earlier, `/work/${session}`, 'codex'), { title: 'Earlier work', context: '', done: '', next: 'Keep the earlier work', ask: '-', why: '' }, earlier), resume: session, turnOrder: earlier * 2 }
  world.store![`agent:${id}`] = mirror
  world.files.set(FILE, upsertAutoBlock('# Progress\n', mirror, ZH_TW))
  world.reply = () => { throw new Error('MODEL_FAILED') }
  // Existing work makes the final silent-model fallback write a mirror; refuse that too.
  world.failStore = (operation, key) => operation === 'set' && key.startsWith('agent:')
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    if (attempt > 1) world.clockOffset! += CLAIM_MS + 1
    world.mtime += 1
    await clock.advance(5000)
    expect(readClaim(takenOf(world)[0]!.split('/').at(-1)!)?.attempt).toBe(attempt)
    for (const old of stale) {
      if (attempt === 1) expect((world.store!.inboxFailed as Record<string, string>)[old]).toBeDefined()
      else expect((world.store!.inboxFailed as Record<string, string>)[old]).toBeUndefined()
    }
    expect(world.asked).toHaveLength(attempt)
  }
  world.clockOffset! += CLAIM_MS + 1
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.has(`${INBOX}/${name}.failed`)).toBe(true)
  expect(takenOf(world)).toEqual([])
  expect(world.asked).toHaveLength(MAX_TRIES)
})

test('a held retake whose session closed before its job keeps its last try', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(1)
  let reached!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  world.holdComplete = { reached, release: new Promise<void>(resolve => { release = resolve }) }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  await entered
  const name = nameOf(AT - DAY, 3000)
  world.files.set(`${INBOX}/${name}.failed`, body('closed-retake'))
  world.store!.inboxFailed = { ...world.store!.inboxFailed as Record<string, string>, [name]: `${MAX_TRIES}:${AT - DAY}:MAX_TRIES` }
  world.mtime += 1
  await clock.advance(5000)
  expect((world.store!.inboxFailed as Record<string, string>)[name]).toBe(`${RETAKE_TRY}:${AT + 10000}:INBOX_RETAKEN`)
  const path = takenOf(world).find(path => readClaim(path.split('/').at(-1)!)?.name === name)!
  const claim = readClaim(path.split('/').at(-1)!)!
  // The kit has one engine: transfer the queued claim to a closed-session stand-in.
  // Its old job will skip that path, leaving the same persisted retake note.
  world.files.set(`${INBOX}/${takenName(name, 'closed', claim.at!, RETAKE_TRY)}`, world.files.get(path)!)
  world.files.delete(path)
  world.clockOffset! += CLAIM_MS + 1
  world.mtime += 1
  await clock.advance(5000)
  const retaken = takenOf(world).map(path => readClaim(path.split('/').at(-1)!)!).find(claim => claim.name === name)
  const calls = world.asked!.length
  release()
  await clock.advance(1000)
  expect(retaken?.attempt).toBe(RETAKE_TRY)
  expect(calls).toBe(1)
  expect(world.asked).toHaveLength(2)
  expect(world.files.get(FILE)).toContain('## closed-retake\n')
  expect((world.store!.inboxDone as Record<string, string>)[name]).toBeDefined()
  expect(failedOf(world)).toEqual([])
})

test('a late turn held behind a newer prompt does not make its row older than that prompt', { timeoutMs: 30_000 }, async ($, on) => {
  const source = AT - 2 * DAY
  const promptAt = AT - 60_000
  const session = 'late-prompt-work'
  const id = blockId('codex', session)
  const mirror = { ...applyDigest(emptyMirror(id, session, source - 1000, `/work/${session}`, 'codex'), { title: 'Earlier work', context: '', done: '', next: 'Check the errors', ask: '-', why: '' }, promptAt), state: 'working' as const, resume: session, turnOrder: (source - 1000) * 2, promptOrder: promptAt * 2 }
  const world = makeWorld([[FILE, upsertAutoBlock('# Progress\n', mirror, ZH_TW)], [`${INBOX}/${nameOf(source)}`, body(session)]])
  world.store![`agent:${id}`] = mirror
  world.reply = reply
  world.asked = []
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(world.asked).toHaveLength(1)
  expect(world.files.get(FILE)).toContain('Added the middleware')
  expect((world.store![`agent:${id}`] as typeof mirror).updated).toBe(promptAt)
  expect(world.files.get(FILE)).toContain(`updated=${new Date(promptAt).toISOString()}`)
  expect(viewOf(world).stopped).toHaveLength(0)
  expect(viewOf(world).overview.active).toBe(1)
})

test('a read error uses up its tries without asking the model', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(1)
  const name = nameOf(AT - 60_000, 0)
  world.beforeRead = path => { if (path.endsWith('.taking')) throw new Error('EIO') }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    if (attempt > 1) world.clockOffset! += CLAIM_MS + 1
    world.mtime += 1
    await clock.advance(5000)
    expect((world.store!.inboxFailed as Record<string, string>)[name]).toBe(`${attempt}:${AT + attempt * 5000 + world.clockOffset!}:INBOX_FAILED`)
  }
  world.clockOffset! += CLAIM_MS + 1
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.has(`${INBOX}/${name}.failed`)).toBe(true)
  expect(takenOf(world)).toEqual([])
  expect(world.asked).toEqual([])
})

test('a non-string inbox read is noted as invalid and uses up its tries', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(1)
  const name = nameOf(AT - 60_000, 0)
  world.readValue = () => undefined
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    if (attempt > 1) world.clockOffset! += CLAIM_MS + 1
    world.mtime += 1
    await clock.advance(5000)
    expect((world.store!.inboxFailed as Record<string, string>)[name]).toBe(`${attempt}:${AT + attempt * 5000 + world.clockOffset!}:INVALID_INPUT`)
  }
  world.clockOffset! += CLAIM_MS + 1
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.has(`${INBOX}/${name}.failed`)).toBe(true)
  expect(takenOf(world)).toEqual([])
  expect(world.asked).toEqual([])
})

test('a file whose existence check fails records each attempt and stops after its last try', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(1)
  const name = nameOf(AT - 60_000, 0)
  const readPaths = new Set<string>()
  let checks = 0
  world.beforeRead = path => { if (path.endsWith('.taking')) readPaths.add(path) }
  world.beforeExists = path => {
    if (!readPaths.delete(path)) return
    checks += 1
    throw new Error('EIO')
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    if (attempt > 1) world.clockOffset! += CLAIM_MS + 1
    world.mtime += 1
    await clock.advance(5000)
    expect((world.store!.inboxFailed as Record<string, string>)[name]).toBe(`${attempt}:${AT + attempt * 5000 + world.clockOffset!}:INBOX_FAILED`)
    expect(checks).toBe(attempt)
  }
  world.clockOffset! += CLAIM_MS + 1
  world.mtime += 1
  await clock.advance(5000)
  expect(world.files.has(`${INBOX}/${name}.failed`)).toBe(true)
  expect(takenOf(world)).toEqual([])
  expect(world.asked).toEqual([])
})

test('a failing existence check for one conversation neither sets aside nor holds up another conversation\'s untried claim', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(1)
  const first = nameOf(AT - 60_000, 0)
  const next = nameOf(AT - 59_000, 1)
  world.files.set(`${INBOX}/${takenName(next, 'closed', AT - CLAIM_MS - 1, MAX_TRIES)}`, body('untried-work'))
  const readPaths = new Set<string>()
  const notesBeforeTry: Array<string | undefined> = []
  const writtenNotes: Array<string | undefined> = []
  world.beforeRead = path => { if (path.endsWith('.taking')) readPaths.add(path) }
  world.beforeExists = path => {
    if (!readPaths.delete(path)) return
    if (path.includes(first)) throw new Error('EIO')
    if (path.includes(next)) notesBeforeTry.push((world.store!.inboxFailed as Record<string, string> | undefined)?.[next])
  }
  world.afterStoreSet = (key, value) => {
    if (key === 'inboxFailed') writtenNotes.push((value as Record<string, string>)[next])
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(notesBeforeTry).toEqual([undefined])
  expect(writtenNotes.filter(note => note !== undefined)).toEqual([`${MAX_TRIES}:${AT + 5000}:TRYING`])
  expect((world.store!.inboxFailed as Record<string, string>)[first]).toBe(`1:${AT + 5000}:INBOX_FAILED`)
  expect((world.store!.inboxDone as Record<string, string>)[next]).toBeDefined()
  expect(failedOf(world)).toEqual([])
  expect(world.asked!.filter(prompt => prompt.includes('untried-work'))).toHaveLength(1)
  expect((world.files.get(FILE) ?? '').match(/## untried-work\n/g)).toHaveLength(1)
  world.clockOffset! += CLAIM_MS + 1
  world.mtime += 1
  await clock.advance(5000)
  expect(failedOf(world)).toEqual([])
  expect(world.asked!.filter(prompt => prompt.includes('untried-work'))).toHaveLength(1)
  expect((world.files.get(FILE) ?? '').match(/## untried-work\n/g)).toHaveLength(1)
})

test('a prompt whose existence check fails is noted and does not stop the turns taken with it', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(1)
  const name = `codex-prompt-${AT - 60_000}-1.json`
  const next = `codex-prompt-${AT - 59_000}-2.json`
  world.files.set(`${INBOX}/${name}`, JSON.stringify({ session_id: 'failed-prompt' }))
  world.files.set(`${INBOX}/${next}`, JSON.stringify({ session_id: 'next-prompt' }))
  const readPaths = new Set<string>()
  world.beforeRead = path => { if (path.includes(name) && path.endsWith('.taking')) readPaths.add(path) }
  world.beforeExists = path => {
    if (readPaths.delete(path)) throw new Error('EIO')
  }
  const notified: string[] = []
  on('ui.notify', ($, event) => {
    notified.push(event.text)
    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect((world.store!.inboxFailed as Record<string, string>)[name]).toBe(`1:${AT + 5000}:INBOX_FAILED`)
  expect((world.store!.inboxDone as Record<string, string>)[name]).toBeUndefined()
  expect(takenOf(world)).toHaveLength(1)
  const claim = takenOf(world)[0]!
  expect(readClaim(claim.split('/').at(-1)!)?.name).toBe(name)
  expect(notified).toContain(ZH_TW.inboxHeld(claim, 'INBOX_FAILED'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Text', text: ZH_TW.inboxTitle })).toBeDefined()
  expect((world.store!.inboxDone as Record<string, string>)[next]).toBeDefined()
  expect((world.store!.inboxDone as Record<string, string>)[nameOf(AT - 60_000, 0)]).toBeDefined()
  expect(world.files.get(FILE)).toContain('## backlog-0\n')
  expect(world.asked).toHaveLength(1)
  await ui.unmount()
})

test('delete diagnostics cannot stop fresh turns when their record is invalid or the store refuses reads or writes', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(0)
  let denied: 'get' | 'set' | undefined
  world.failStore = (operation, key) => key === 'inboxDeleteFailed' && operation === denied
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  for (const [index, mode] of ['invalid', 'get', 'set'].entries()) {
    denied = mode === 'get' || mode === 'set' ? mode : undefined
    world.store!.inboxDeleteFailed = mode === 'invalid' ? ['bad record'] : { missing: `1:${AT}:INBOX_DELETE_FAILED` }
    const name = nameOf(AT - 60_000, 4000 + index)
    world.files.set(`${INBOX}/${name}`, body(`diagnostics-${mode}`))
    world.mtime += 1
    await clock.advance(5000)
    expect(world.files.get(FILE)).toContain(`## diagnostics-${mode}\n`)
    expect((world.store!.inboxDone as Record<string, string>)[name]).toBeDefined()
    expect(takenOf(world)).toEqual([])
  }
  expect(world.asked).toHaveLength(3)
})

test('an idle look preserves held notes for listed files without rewriting the failure record', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(0)
  const names = [nameOf(AT - DAY, 5000), nameOf(AT - DAY, 5001), nameOf(AT - DAY, 5002)]
  world.files.set(`${INBOX}/${names[0]}.failed`, body('listed-hold'))
  world.files.set(`${INBOX}/${takenName(names[1]!, 'closed', AT, 1)}`, body('listed-claim'))
  world.files.set(`${INBOX}/${names[2]}`, body('listed-fresh'))
  world.store!.inboxFailed = Object.fromEntries(names.map(name => [name, `${MAX_TRIES}:${AT}:MAX_TRIES`]))
  // Refusing moves leaves every listed representation in place for the idle check.
  world.isMoveRefused = () => true
  let writes = 0
  world.beforeStoreSet = key => { if (key === 'inboxFailed') writes += 1 }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  world.mtime += 1
  await clock.advance(5000)
  expect(Object.keys(world.store!.inboxFailed as Record<string, string>).sort()).toEqual([...names].sort())
  expect(writes).toBe(0)
  const path = `${INBOX}/${names[0]}.failed`
  world.files.delete(path)
  world.mtime += 1
  await clock.advance(5000)
  expect((world.store!.inboxFailed as Record<string, string>)[names[0]!]).toBeDefined()
  world.unlistable = new Set([INBOX])
  world.mtime += 1
  await clock.advance(5000)
  expect((world.store!.inboxFailed as Record<string, string>)[names[0]!]).toBeDefined()
  expect(writes).toBe(0)
  world.unlistable = undefined
  world.files.set(path, body('listed-hold'))
  world.mtime += 1
  await clock.advance(5000)
  world.files.delete(path)
  world.mtime += 1
  await clock.advance(5000)
  expect((world.store!.inboxFailed as Record<string, string>)[names[0]!]).toBeDefined()
  expect(writes).toBe(0)
  world.mtime += 1
  await clock.advance(5000)
  expect((world.store!.inboxFailed as Record<string, string>)[names[0]!]).toBeUndefined()
  expect(writes).toBe(1)
})

test('trying notes do not rewrite the done record before a file settles', { timeoutMs: 30_000 }, async ($, on) => {
  const world = backlog(1)
  let reached!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  world.holdComplete = { reached, release: new Promise<void>(resolve => { release = resolve }) }
  let writes = 0
  world.beforeStoreSet = key => { if (key === 'inboxDone') writes += 1 }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  await entered
  const before = writes
  release()
  await clock.advance(1000)
  expect(before).toBe(0)
  expect(writes).toBe(1)
})
