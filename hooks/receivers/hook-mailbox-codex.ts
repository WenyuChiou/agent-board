import { SURFACE_IDS } from '../messaging.ts'
export const messagingReceiver = {
  host: 'Codex',
  agent: 'codex',
  kind: 'mailbox',
  surfaces: [{ name: 'CLI', id: SURFACE_IDS.cli, evidence: 'docs/validation/2026-11-12-codex-cli-mailbox-live.md' }],
  tier: 3,
  primitive: 'unknown',
  isImplemented: true,
  routes: {
    // The live run queued the message while the interactive CLI session was idle; a message queued during a turn
    // is not recorded yet, so a working session keeps Copy.
    idle: { line: 'nextTurn', record: 'docs/validation/2026-11-12-codex-cli-mailbox-live.md', surfaces: [SURFACE_IDS.cli] },
    working: { line: 'nextTurn', record: null, surfaces: [] },
    ended: { line: 'none', record: null, surfaces: [] },
  },
}
