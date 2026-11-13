import { SURFACE_IDS } from '../messaging.ts'

// The hook reads the surface from the app data folder in its transcript path (scripts/hook-delivery.ts,
// antigravitySurface): the CLI's folder is agy TUI; the desktop app and the IDE both read as IDE.
export const messagingReceiver = {
  host: 'Antigravity',
  agent: 'antigravity',
  kind: 'mailbox',
  surfaces: [{ name: '2.0 Desktop App', id: SURFACE_IDS.antigravityIde, evidence: null }, { name: 'IDE', id: SURFACE_IDS.antigravityIde, evidence: null }, { name: 'agy TUI', id: SURFACE_IDS.antigravityTui, evidence: 'docs/validation/2026-11-12-antigravity-tui-mailbox-live.md' }],
  tier: 3,
  primitive: 'unknown',
  isImplemented: true,
  routes: {
    // The live runs queued the message while the interactive TUI session was idle; a message queued during a
    // turn is not recorded yet, so a working session keeps Copy. The app and the editor have no record.
    idle: { line: 'nextTurn', record: 'docs/validation/2026-11-12-antigravity-tui-mailbox-live.md', surfaces: [SURFACE_IDS.antigravityTui] },
    working: { line: 'nextTurn', record: null, surfaces: [] },
    ended: { line: 'none', record: null, surfaces: [] },
  },
}
