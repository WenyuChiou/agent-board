import { channel } from 'node:diagnostics_channel'
import { performance } from 'node:perf_hooks'

// Observe only this synthetic hub's protocol milestones. Never retain request bodies,
// headers, query strings, credentials or raw errors in a public failure diagnostic.
export const receiptTrace = address => {
  const origin = new URL(address).origin
  const started = performance.now(), records = [], tracked = new WeakMap()
  const subscriptions = []
  const listen = (name, callback) => {
    const one = channel('undici:request:' + name)
    one.subscribe(callback)
    subscriptions.push(() => one.unsubscribe(callback))
  }
  listen('create', ({ request }) => {
    if (String(request.origin) !== origin || !/^\/api\/messages\/(?:send|poll|receipt)$/.test(request.path)) return
    const record = { action: request.path.split('/').at(-1), phase: 'created', status: null, at: Math.round(performance.now() - started) }
    tracked.set(request, record)
    records.push(record)
    if (records.length > 12) records.shift()
  })
  listen('headers', ({ request, response }) => {
    const record = tracked.get(request)
    if (record) { record.phase = 'headers'; record.status = response.statusCode; record.after = Math.round(performance.now() - started) }
  })
  listen('trailers', ({ request }) => {
    const record = tracked.get(request)
    if (record) { record.phase = 'complete'; record.after = Math.round(performance.now() - started) }
  })
  listen('error', ({ request }) => {
    const record = tracked.get(request)
    if (record) { record.phase = 'error'; record.after = Math.round(performance.now() - started) }
  })
  return {
    snapshot: () => records.map(record => ({ ...record })),
    close: () => subscriptions.splice(0).forEach(stop => stop()),
  }
}
