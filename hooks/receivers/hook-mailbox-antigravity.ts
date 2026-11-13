import { SURFACE_IDS } from '../messaging.ts'

// The hook reads the surface from the app data folder in its transcript path (scripts/hook-delivery.ts,
// antigravitySurface): the folder `antigravity-cli` is agy TUI; the folders `antigravity` and `antigravity-ide`
// both read as IDE (only the app was run).
export const messagingReceiver = {
  host: 'Antigravity',
  agent: 'antigravity',
  kind: 'mailbox',
  surfaces: [{ name: '2.0 Desktop App', id: SURFACE_IDS.antigravityIde, evidence: 'docs/validation/2026-11-13-antigravity-app-mailbox-live.md' }, { name: 'IDE', id: SURFACE_IDS.antigravityIde, evidence: null }, { name: 'agy TUI', id: SURFACE_IDS.antigravityTui, evidence: 'docs/validation/2026-11-12-antigravity-tui-mailbox-live.md' }],
  tier: 3,
  primitive: 'unknown',
  isImplemented: true,
  routes: {
    // The TUI record queued a message while its session was idle; the desktop app record queued one while the
    // conversation was idle and one while a turn ran. The editor has no run; the app's routes cover it only if it
    // writes to the `antigravity` or `antigravity-ide` folder. No run queued to a TUI session during a turn. On the
    // idle route agy TUI cites its own note.
    idle: {
      line: 'nextTurn', record: 'docs/validation/2026-11-13-antigravity-app-mailbox-live.md', surfaces: [SURFACE_IDS.antigravityTui, SURFACE_IDS.antigravityIde],
      surfaceRecords: { [SURFACE_IDS.antigravityTui]: 'docs/validation/2026-11-12-antigravity-tui-mailbox-live.md' },
    },
    working: { line: 'nextTurn', record: 'docs/validation/2026-11-13-antigravity-app-mailbox-live.md', surfaces: [SURFACE_IDS.antigravityIde] },
    ended: { line: 'none', record: null, surfaces: [] },
  },
}
