import type { CodexTrustObservation } from './codex-host'

export type CodexApproval = { source: string; sourceHash: string }

export const codexApproval = (observation: CodexTrustObservation | undefined, source: string, sourceHash: string | null, approval: CodexApproval | undefined, wasTrusted: boolean | undefined, beforeHash: string | null): { trusted: boolean; approval: CodexApproval | undefined } => {
  const sameSource = (path: string): boolean => path.replace(/\\/g, '/') === source.replace(/\\/g, '/')
  if (observation !== undefined) {
    if (sourceHash === null || !sameSource(observation.source) || observation.sourceHash !== sourceHash) return { trusted: false, approval }
    return { trusted: observation.trusted, approval: observation.trusted ? { source, sourceHash } : undefined }
  }
  if (sourceHash === null) return { trusted: false, approval }
  if (approval !== undefined) return { trusted: sameSource(approval.source) && approval.sourceHash === sourceHash, approval }
  if (wasTrusted === true && beforeHash === sourceHash) return { trusted: true, approval: { source, sourceHash } }
  return { trusted: false, approval }
}
