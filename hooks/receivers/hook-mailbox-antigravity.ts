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
    // docs/validation/2026-11-10-agy-live.md ran headless `agy` (stream JSON), not the interactive TUI, so it
    // is no record for any surface here. Record the idle route when a run of the TUI shows it.
    idle: { line: 'nextTurn', record: null, surfaces: [] },
    working: { line: 'nextTurn', record: null, surfaces: [] },
    ended: { line: 'none', record: null, surfaces: [] },
  },
}
