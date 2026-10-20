import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

export const seenWithin = async (read, predicate, ms) => {
  const start = performance.now()
  let last
  do {
    last = await read()
    const elapsed = performance.now() - start
    if (predicate(last) && elapsed <= ms) return elapsed
    if (elapsed >= ms) break
    await new Promise(done => setTimeout(done, Math.min(40, ms - elapsed)))
  } while (performance.now() - start <= ms)
  assert.fail(`Not seen within ${ms} ms. Last text: ${typeof last === 'string' ? last : JSON.stringify(last)}`)
}

export const noSilentPress = ({ surface, card, button, before, after }) => {
  assert.notEqual(after, before, `pressed ${button} on ${card} on ${surface}: nothing happened`)
}

export const noMachineIds = (text, world, { allow = [] } = {}) => {
  let visible = String(text)
  for (const value of allow) visible = visible.split(value).join('')
  const file = world.exists('progress.md') ? world.read('progress.md') : ''
  const ids = [...file.matchAll(/\b(?:session|resume)=([^\s>]+)/g)].map(match => match[1])
  for (const value of [...ids, world.root, world.home]) assert.ok(!visible.includes(value), `Machine id/path exposed: ${value}\n${visible}`)
  assert.doesNotMatch(visible, /\b[\da-f]{8}\b|\b[\da-f]{40}\b|\b[\da-f]{64}\b|(?<![A-Za-z])[A-Za-z]:[\\/]|\/home\/|\/Users\//i)
}
