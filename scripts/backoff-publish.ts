import { statSync } from 'node:fs'

const isPublishingRecord = (file: string): boolean => {
  try { return statSync(file).size === 0 } catch { return false }
}

// After a claim-collision backoff, a winning server running writePrivateRuntimeFile
// creates a 0-byte file first while Windows ACL checks run (#1808). Wait briefly
// while that 0-byte reservation is still being published instead of starting a second child.
export const waitForPublishedRecord = async <T>(
  file: string,
  check: () => Promise<T | null>,
  deadline: number,
  publishWindowMs = 5_000,
  intervalMs = 50,
): Promise<T | null> => {
  const publishUntil = Math.min(deadline, performance.now() + publishWindowMs)
  while (isPublishingRecord(file) && performance.now() < publishUntil) {
    await new Promise(done => setTimeout(done, intervalMs))
  }
  if (isPublishingRecord(file)) return null
  return check()
}
