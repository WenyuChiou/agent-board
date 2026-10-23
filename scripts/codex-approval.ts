// Pure: legacy-connect imports it, and the plugin's tests load legacy-connect, where a module
// may import only its own files and claude-code. Each caller hashes config.toml itself.
import type { CodexBinary, CodexTrustObservation } from './codex-host'

// configHash is the sha of Codex's config.toml when Codex confirmed the approval, or
// null when there was none. Untrusting or turning hooks off in /hooks changes that
// file, not hooks.json. An approval saved without it never matches, so the next
// successful check replaces it.
// binary is the codex executable found when the approval was remembered. A Codex upgrade replaces that file,
// and a new release can stop trusting our hooks without changing hooks.json or
// config.toml, so a different one found later does not confirm the approval unasked.
export type CodexApproval = { source: string; sourceHash: string; configHash?: string | null; binary?: CodexBinary }
export type CodexCheck = CodexTrustObservation & { configHash: string | null }
// What the connect found beside Codex's answer: the executable (null when there is none,
// undefined when it cannot be read), and whether config.toml or that executable changed
// after legacy-connect.json was last written, which a 0.23 approval cannot have seen.
export type CodexFound = { binary: CodexBinary | null | undefined; isSeedStale: boolean }
export const CODEX_NOT_FOUND: CodexFound = { binary: null, isSeedStale: false }

// binary has no default: a default would turn undefined (found, unreadable) into null (none found).
export const codexApproval = (observation: CodexCheck | undefined, source: string, sourceHash: string | null, configHash: string | null | undefined, approval: CodexApproval | undefined, wasTrusted: boolean | undefined, beforeHash: string | null, binary: CodexBinary | null | undefined): { trusted: boolean; approval: CodexApproval | undefined } => {
  const samePath = (one: string, other: string): boolean => one.replace(/\\/g, '/') === other.replace(/\\/g, '/')
  const withBinary = (fields: { source: string; sourceHash: string; configHash: string | null }): CodexApproval => binary === null || binary === undefined ? fields : { ...fields, binary }
  if (observation !== undefined) {
    if (sourceHash === null || !samePath(observation.source, source) || observation.sourceHash !== sourceHash) return { trusted: false, approval }
    if (!observation.trusted) return { trusted: false, approval: undefined }
    // Codex's yes covers the config.toml it read; one changed since then is not confirmed.
    if (configHash === undefined || observation.configHash !== configHash) return { trusted: false, approval }
    return { trusted: true, approval: withBinary({ source, sourceHash, configHash }) }
  }
  if (sourceHash === null || configHash === undefined || binary === undefined) return { trusted: false, approval }
  if (approval !== undefined) {
    // With no Codex found the approval stands; one found that is not the Codex that said yes must be asked.
    const isSameBinary = binary === null || approval.binary !== undefined && samePath(approval.binary.path, binary.path) && approval.binary.size === binary.size && approval.binary.mtime === binary.mtime
    return { trusted: samePath(approval.source, source) && approval.sourceHash === sourceHash && approval.configHash === configHash && isSameBinary, approval }
  }
  if (wasTrusted === true && beforeHash === sourceHash) return { trusted: true, approval: withBinary({ source, sourceHash, configHash }) }
  return { trusted: false, approval }
}
