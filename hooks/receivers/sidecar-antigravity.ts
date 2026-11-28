import { SURFACE_IDS } from '../messaging.ts'

// The Antigravity sidecar's wake (#1396). The desktop app runs the sidecar setup wrote (hooks/antigravity-sidecar.ts) only
// after the person switches it on in the app's Automations page. While it polls the board, a message sent to an idle
// conversation goes in at once: 10 s after the conversation's turn ended, the sidecar runs Antigravity's own `agentapi
// send-message` with one fixed line, and the turn that starts hands the message over through the hook mailbox
// (hook-mailbox-antigravity.ts). The board offers this route only while the sidecar polls (sidecarRoutes in
// hooks/messaging.ts); otherwise the mailbox's next-turn route stands. agy TUI runs no sidecar, and the editor shares the
// app's surface id. `sidecar` marks the entry hooks/receiver-routes.ts makes from this record.
export const messagingReceiver = {
  host: 'Antigravity',
  agent: 'antigravity',
  kind: 'mailbox',
  sidecar: true,
  // Its note records one live run (2026-11-27); naming it as a surface's evidence (2.0 Desktop App) is a follow-up.
  surfaces: [{ name: '2.0 Desktop App', id: SURFACE_IDS.antigravityIde, evidence: null }, { name: 'IDE', id: SURFACE_IDS.antigravityIde, evidence: null }],
  tier: 1,
  primitive: 'unknown',
  isImplemented: true,
  // Working: the sidecar wakes nothing while a turn runs, so the mailbox's next-turn route and its note stand.
  routes: {
    idle: { line: 'now', record: 'docs/validation/2026-11-17-antigravity-wake-live.md', surfaces: [SURFACE_IDS.antigravityIde] },
    working: { line: 'nextTurn', record: 'docs/validation/2026-11-13-antigravity-app-mailbox-live.md', surfaces: [SURFACE_IDS.antigravityIde] },
    ended: { line: 'none', record: null, surfaces: [] },
  },
}
