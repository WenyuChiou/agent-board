import { SURFACE_IDS } from '../messaging.ts'

// The Codex desktop app receiver (scripts/codex-app-receiver.ts, #557). The app runs a private Codex server with no outside
// way into a conversation it shows, so the board runs an idle app conversation's next turn in the background with Codex's
// own resume command, once the app has let go of it (quit; Codex refuses a second writer while the app holds it). A message
// while a turn runs is never sent: the board refuses it, and so does the receiver. The board's route table keeps a copy of
// this record in the shared Codex live entry (hooks/receiver-routes.ts), and a test pins the two together.
export const messagingReceiver = {
  host: 'Codex',
  agent: 'codex',
  kind: 'live',
  surfaces: [{ name: 'Desktop App', id: SURFACE_IDS.codexApp, evidence: 'docs/validation/2026-11-22-codex-app-reopen-live.md' }],
  routes: {
    idle: { line: 'reopen', record: 'docs/validation/2026-11-22-codex-app-reopen-live.md', surfaces: [SURFACE_IDS.codexApp] },
    working: { line: 'stepEnd', record: null, surfaces: [] },
    ended: { line: 'none', record: null, surfaces: [] },
  },
  tier: 2,
  primitive: 'unknown',
  isImplemented: true,
}
