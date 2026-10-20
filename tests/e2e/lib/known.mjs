import { basename } from 'node:path'

export const knownFailure = async (issue, fn) => {
  assertIssue(issue)
  const label = typeof issue === 'number' ? `#${issue}` : issue
  try {
    await fn()
  } catch (error) {
    console.log(`known failure ${label}: [${basename(process.argv[1] ?? 'scenario')}] ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  throw new Error(`${label} looks fixed: remove knownFailure(${typeof issue === 'number' ? issue : `'${issue}'`}) from this test`)
}

const assertIssue = issue => {
  if (!(Number.isInteger(issue) && issue > 0) && !(typeof issue === 'string' && /^hold:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(issue))) throw new Error(`Invalid known failure: ${issue}`)
}
