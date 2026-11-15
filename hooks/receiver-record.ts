import { SURFACE_IDS } from './messaging.ts'

// What hooks/receiver.ts gives, for the generated messaging table (#720). The CLI note used a
// stand-in model rather than a real one.
// Desktop Code is not here: the receiver does not start in a session a program started.
// `routes` says, for a session that is idle, working or ended, when a message from the board
// arrives (`line`) and which dated note in docs/validation/ showed that route live (`record`, or
// null when none did). The board offers Send only on a route with a record (#1351). That note ran a
// real Claude Code process (the receiver, the hub, the page) against a stand-in for the model, so it
// shows what Claude Code does with a message, not that a real model follows the ACK line. It shows an
// idle session starting on the message at once, a working one taking it when its turn ended, and a
// stopped one (Esc) not getting it. The delivery is Claude Code's own, so the two routes cite the note
// for that; the note does not show that a real model follows the ACK line.
export const messagingReceiver = {
  host: 'Claude Code',
  agent: 'claude',
  kind: 'live',
  surfaces: [{ name: 'CLI', id: SURFACE_IDS.claude, evidence: 'docs/validation/2026-11-03-send-to-claude.md' }],
  tier: 1,
  primitive: '[P1]',
  isImplemented: true,
  routes: {
    idle: { line: 'now', record: 'docs/validation/2026-11-03-send-to-claude.md', surfaces: [SURFACE_IDS.claude] },
    working: { line: 'stepEnd', record: 'docs/validation/2026-11-03-send-to-claude.md', surfaces: [SURFACE_IDS.claude] },
    ended: { line: 'none', record: null, surfaces: [] },
  },
}
