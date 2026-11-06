// Data only: this module never reads processes, files, account paths or the environment.
const linuxPidNamespace = identity => {
  if (typeof identity !== 'string') return null
  const match = /^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+(?::time:\[\d+\])?:(pid:\[\d+\])$/i.exec(identity)
  return match?.[0] === identity ? match[1] : null
}

// A PID can be probed only in the namespace that assigned it. Missing legacy metadata
// cannot establish that relationship, even when this namespace reports ESRCH.
export const testLockNamespaceProblem = ({ platform, recordedIdentity, selfIdentity }) => {
  if (platform !== 'linux') return null
  if (recordedIdentity === undefined) return 'legacy'
  if (recordedIdentity === null || selfIdentity == null) return 'unknown'
  const recorded = linuxPidNamespace(recordedIdentity)
  const current = linuxPidNamespace(selfIdentity)
  return recorded !== null && recorded === current ? null : 'namespace'
}
