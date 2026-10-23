// Pure: legacy-connect imports it, and the plugin's tests load legacy-connect, where a module
// may import only its own files and claude-code. Each caller hashes config.toml itself.
import type { CodexTrustObservation } from './codex-host'

// configHash is the sha of Codex's config.toml when Codex confirmed the approval, or
// null when there was none. Untrusting or turning hooks off in /hooks changes that
// file, not hooks.json. An approval saved without it never matches, so the next
// successful check replaces it.
export type CodexApproval = { source: string; sourceHash: string; configHash?: string | null }
export type CodexCheck = CodexTrustObservation & { configHash: string | null }

export const codexApproval = (observation: CodexCheck | undefined, source: string, sourceHash: string | null, configHash: string | null | undefined, approval: CodexApproval | undefined, wasTrusted: boolean | undefined, beforeHash: string | null): { trusted: boolean; approval: CodexApproval | undefined } => {
  const sameSource = (path: string): boolean => path.replace(/\\/g, '/') === source.replace(/\\/g, '/')
  if (observation !== undefined) {
    if (sourceHash === null || !sameSource(observation.source) || observation.sourceHash !== sourceHash) return { trusted: false, approval }
    if (!observation.trusted) return { trusted: false, approval: undefined }
    // Codex's yes covers the config.toml it read; one changed since then is not confirmed.
    if (configHash === undefined || observation.configHash !== configHash) return { trusted: false, approval }
    return { trusted: true, approval: { source, sourceHash, configHash } }
  }
  if (sourceHash === null || configHash === undefined) return { trusted: false, approval }
  if (approval !== undefined) return { trusted: sameSource(approval.source) && approval.sourceHash === sourceHash && approval.configHash === configHash, approval }
  if (wasTrusted === true && beforeHash === sourceHash) return { trusted: true, approval: { source, sourceHash, configHash } }
  return { trusted: false, approval }
}
