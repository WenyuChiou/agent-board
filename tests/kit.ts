import { test as kitTest } from 'claude-code/testing'

export * from 'claude-code/testing'

type Config = Exclude<Parameters<typeof kitTest>[1], Body>
type Body = NonNullable<Parameters<typeof kitTest>[2]>

// The kit gives a test 5 s unless the test names its own limit. On a Windows runner a pane test takes 2-3.5 s as its
// normal time, so a 2-4 s stall of the runner crossed 5 s in six different tests, none of them slow on Ubuntu.
// 15 s keeps a hung test failing well inside the job's 15-minute limit. A test that names its own limit keeps it.
const DEFAULT_TIMEOUT_MS = 15_000

export const test = (name: string, configOrBody: Config | Body, body?: Body): void => {
  if (typeof configOrBody === 'function') return kitTest(name, { timeoutMs: DEFAULT_TIMEOUT_MS }, configOrBody)
  return kitTest(name, { timeoutMs: DEFAULT_TIMEOUT_MS, ...configOrBody }, body!)
}
