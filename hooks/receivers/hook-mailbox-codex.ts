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
    // The first live run queued the message while the interactive CLI session was idle; the second sent it while a
    // turn ran, and the Stop hook handed it over at the step end in the same turn (#319). Only the terminal ran, and
    // only there does a Stop take a message, so the step-end line is the CLI's own; elsewhere a working card keeps Copy.
    idle: { line: 'nextTurn', record: 'docs/validation/2026-11-12-codex-cli-mailbox-live.md', surfaces: [SURFACE_IDS.cli] },
    working: { line: 'nextTurn', record: 'docs/validation/2026-11-26-codex-cli-stop-live.md', surfaces: [SURFACE_IDS.cli], surfaceLines: { [SURFACE_IDS.cli]: 'stepEnd' } },
    ended: { line: 'none', record: null, surfaces: [] },
  },
}
