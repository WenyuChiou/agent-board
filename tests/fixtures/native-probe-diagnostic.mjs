import assert from 'node:assert/strict'

// Fixed fields only: never copy the error object, fixture paths, PIDs or output.
const code = (value, known) => value == null ? null : known.includes(value) ? value : 'OTHER'
const duration = value => Number.isFinite(value) ? Math.min(999999999, Math.max(0, Math.round(value))) : null
const boolean = value => typeof value === 'boolean' ? value : null

export const nativeProbeDiagnostic = (result, marker, elapsedMs, budgetMs) => {
  const present = marker !== null && typeof marker === 'object' && !Array.isArray(marker)
  return `native cleanup probe ${JSON.stringify({
    elapsedMs: duration(elapsedMs), budgetMs: duration(budgetMs),
    status: Number.isInteger(result.status) && Math.abs(result.status) <= 255 ? result.status : null,
    signal: code(result.signal, ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGINT']),
    errorPresent: result.error !== undefined,
    errorCode: code(result.error?.code, ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EIO', 'ENOBUFS']),
    markerPresent: present,
    isStarted: boolean(present ? marker.isStarted : undefined),
    isVerified: boolean(present ? marker.isVerified : undefined),
    keepFixture: boolean(present ? marker.keepFixture : undefined),
    code: code(present ? marker.code : undefined, ['NATIVE_HOOK_UNREAPED', 'ETIMEDOUT']),
  })}`
}

export const assertNativeProbeReturned = (result, marker, elapsedMs, budgetMs) => {
  const diagnostic = nativeProbeDiagnostic(result, marker, elapsedMs, budgetMs)
  // Preserve the exact undefined check without rendering Error.path/spawnargs.
  assert.equal(result.error === undefined, true, diagnostic)
  return diagnostic
}
