import { SURFACE_IDS } from '../messaging.ts'

// The hook identifies both desktop and IDE as IDE; it cannot distinguish the two.
export const messagingReceiver = {
  host: 'Antigravity',
  agent: 'antigravity',
  kind: 'mailbox',
  surfaces: [{ name: '2.0 Desktop App', id: SURFACE_IDS.antigravityIde, evidence: null }, { name: 'IDE', id: SURFACE_IDS.antigravityIde, evidence: null }, { name: 'agy TUI', id: SURFACE_IDS.antigravityTui, evidence: null }],
  tier: 3,
  primitive: 'unknown',
  isImplemented: true,
  routes: {
    // The note ran the `agy` command line (headless stream), so it is recorded for the agy TUI row only.
    idle: { line: 'nextTurn', record: 'docs/validation/2026-11-10-agy-live.md', surfaces: [SURFACE_IDS.antigravityTui] },
    working: { line: 'nextTurn', record: null, surfaces: [] },
    ended: { line: 'none', record: null, surfaces: [] },
  },
}
