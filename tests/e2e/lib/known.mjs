import { basename } from 'node:path'

// mayPass is for a marker whose failure depends on load or timing: a lucky run may pass, and that
// is not a fix, so it is logged instead of failing the test as "looks fixed". The line names what
// lifts the marker, since such a marker never fails on its own once the bug is fixed.
// Only a failed assertion counts, so a hold body computes what it reads before the call: a screen
// that is missing then fails plainly instead of passing for the known failure.
export const knownFailure = async (issue, fn, { mayPass = false } = {}) => {
  assertIssue(issue)
  const label = typeof issue === 'number' ? `#${issue}` : issue
  try {
    await fn()
  } catch (error) {
    // Only a failed assertion is the known failure. A crash, a timeout or a mistake in the test
    // itself must fail the test, never pass for the marker.
    if (error?.code !== 'ERR_ASSERTION') throw error
    console.log(`known failure ${label}: [${basename(process.argv[1] ?? 'scenario')}] ${error.message}`)
    return
  }
  if (mayPass) {
    console.log(`known failure ${label}: passed this time, which depends on load and is not a fix. Remove the marker when ${typeof issue === 'number' ? `${label} closes` : `${label} is lifted`}.`)
    return
  }
  throw new Error(`${label} looks fixed: remove knownFailure(${typeof issue === 'number' ? issue : `'${issue}'`}) from this test`)
}

const assertIssue = issue => {
  if (!(Number.isInteger(issue) && issue > 0) && !(typeof issue === 'string' && /^hold:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(issue))) throw new Error(`Invalid known failure: ${issue}`)
}
