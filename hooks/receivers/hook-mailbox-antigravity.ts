import { SURFACE_IDS } from '../messaging.ts'

// The hook reads the surface from the app data folder in its transcript path (scripts/hook-delivery.ts,
// antigravitySurface): the folder `antigravity-cli` is agy TUI; the folders `antigravity` and `antigravity-ide`
// both read as IDE (only the app was run).
// The turn-end (`Stop`) hook reads the model's ACK on both surfaces (#1416): the turn-start hook keeps the id and code of the message it
// handed over, and `Stop` reads the first line of each reply of that turn from the conversation's transcript. A line `ACK <code>` of a
// message handed over in the turn acknowledges it (only that line is kept); any other reply, or a turn with no hand-over, changes nothing.
// Not yet recorded live (the live run of #1416 is separate), so the card's Replied for Antigravity rests on the synthetic tests.
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
