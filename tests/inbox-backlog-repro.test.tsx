import { expect, test } from 'claude-code/testing'
import { blockId, claimAction, CLAIM_MS, failedName, MAX_TRIES, readClaim, takenName } from '../hooks/inbox'
import { engineBeneath, makeWorld, FILE, INBOX } from './fixtures/pane-world'
import type { ProgressMirror } from '../types'

const AT = Date.parse('2026-10-16T12:00:00Z')
// Only this stand-in switch changes in the pre-fix restricted copy.
const isFixed = true

test('two sessions draining 200 held turns while each model call takes 30 s set none aside, and every turn lands once', { timeoutMs: 240_000 }, async ($, on) => {
  const world = makeWorld([[FILE, '# Progress\n']])
  world.isInboxClockOnly = true
  // Thirty-second looks avoid thousands of unrelated mock polls over two hours.
  world.inboxLookMs = 30_000
  world.completeDelayMs = 30_000
  world.asked = []
  const names: string[] = []
  const newest = new Map<string, number>()
  for (let index = 0; index < 200; index += 1) {
    const session = `repro-${Math.floor(index / 2)}`
    const at = AT - 60_000 + index
    const name = `codex-turn-${at}-${index}.json`
    names.push(name)
    newest.set(session, at * 2)
    world.files.set(`${INBOX}/${name}`, JSON.stringify({ session_id: session, cwd: `/work/${session}`, prompt: 'Track this work', last_assistant_message: `Finished synthetic turn ${index}.` }))
  }
  world.reply = () => 'TITLE: Synthetic backlog\nCONTEXT: Two sessions\nDONE: Saved the turn\nNEXT: Check the result\nASK: -'
  const deliveries = new Map<string, number>()
  const stamps = new Map<string, string>()
  const writes = new Map<string, number>()
  const tried = new Set<string>()
  let tryingMax = 0
  world.afterStoreSet = (key, value) => {
    if (key === 'inboxFailed') tryingMax = Math.max(tryingMax, Object.values(value as Record<string, string>).filter(note => note.endsWith(':TRYING')).length)
    if (key.startsWith('agent:')) {
      const mirror = value as ProgressMirror
      const turn = `${key}:${mirror.turnOrder}`
      writes.set(turn, (writes.get(turn) ?? 0) + 1)
    }
    if (key !== 'inboxDone') return
    for (const [name, stamp] of Object.entries(value as Record<string, string>)) {
      if (!names.includes(name) || stamps.get(name) === stamp) continue
      deliveries.set(name, (deliveries.get(name) ?? 0) + 1)
      stamps.set(name, stamp)
    }
  }
  const clock = engineBeneath(on, world)
  let at = AT
  // The kit owns one engine per test. This second session does only the shipped
  // claim look: it has no local queue and shares the inbox and failure store.
  const secondLook = (): void => {
    at += 30_000
    for (const prompt of world.asked!) {
      for (const match of prompt.matchAll(/Finished synthetic turn (\d+)\./g)) {
        const index = Number(match[1])
        // The digest reads the pair together, even when it sums only its newest turn.
        tried.add(names[index]!)
        tried.add(names[index - index % 2]!)
      }
    }
    const done = world.store!.inboxDone as Record<string, string>
    const notes = { ...world.store!.inboxFailed as Record<string, string> | undefined }
    let taken = 0
    for (const [path, body] of [...world.files]) {
      const claim = readClaim(path.split('/').at(-1)!)
      if (claim === null || !isFixed && taken >= 20) continue
      if (done[claim.name] !== undefined) { world.files.delete(path); continue }
      const action = claimAction(claim, world.mtimes?.[path] ?? world.mtime, at)
      if (action === 'leave') continue
      const isTried = !isFixed || Number(notes[claim.name]?.split(':')[0] ?? 0) >= claim.attempt
      const isAside = action === 'setAside' && isTried
      if (!isAside && taken >= (isFixed ? 10 : 20)) continue
      const next = isAside ? failedName(claim.name) : takenName(claim.name, 'secondsession', at, claim.attempt + (isTried ? 1 : 0))
      if (isAside) notes[claim.name] ??= `${claim.attempt}:${at}:MAX_TRIES`
      world.files.delete(path)
      world.files.set(`${INBOX}/${next}`, body)
      if (!isAside) taken += 1
    }
    world.store!.inboxFailed = notes
    world.mtime += 1
  }
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  // Eight claim lifetimes cover exhaustion under the old rule, including the
  // files the stand-in retakes after the first session skips their old paths.
  for (let elapsed = 0; elapsed < (MAX_TRIES + 1) * (CLAIM_MS + 5000); elapsed += 30_000) {
    secondLook()
    await clock.advance(30_000)
    world.completeDue?.(at)
    await clock.advance(0)
  }
  const failed = [...world.files.keys()].filter(path => path.endsWith('.failed'))
  const untried = failed.filter(path => !tried.has(path.slice(INBOX.length + 1, -'.failed'.length)))
  const duplicates = [...deliveries.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  const duplicateWrites = [...writes.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  const file = world.files.get(FILE) ?? ''
  console.log(`REPRO2 ${JSON.stringify({ isFixed, failed: failed.length, untriedSetAsides: untried.length, turnsLanded: deliveries.size, duplicates, duplicateWrites, blocks: (file.match(/<!-- auto session=/g) ?? []).length, modelCalls: world.asked!.length, tryingMax })}`)
  expect(failed).toEqual([])
  expect(deliveries.size).toBe(200)
  expect(duplicates).toBe(0)
  expect(duplicateWrites).toBe(0)
  expect(tryingMax).toBeLessThanOrEqual(10)
  expect((file.match(/<!-- auto session=/g) ?? []).length).toBe(100)
  for (const [session, order] of newest) {
    const id = blockId('codex', session)
    expect((world.store![`agent:${id}`] as ProgressMirror).turnOrder).toBe(order)
    expect((file.match(new RegExp(`<!-- auto session=${id} `, 'g')) ?? []).length).toBe(1)
  }
})
