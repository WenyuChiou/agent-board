import { SURFACE_IDS } from './messaging.ts'

// What hooks/receiver.ts gives, for the generated messaging table (#720, #1814). Follows the 2026-11-03 stand-in check
// (`docs/validation/2026-11-03-send-to-claude.md`) with the 2026-11-16 live run against a real model.
// Desktop Code registers as `Claude Desktop Code` when a desktop surface attaches (#1842), with `record: null`
// until its dated live check in `docs/validation/` covers it.
// `routes` says, for a session that is idle, working or ended, when a message from the board
// arrives (`line`) and which dated note in docs/validation/ showed that route live (`record`, or
// null when none did). The board offers Send only on a route with a record (#1351). The cited note ran a
// real Claude Code CLI session against a real model (Haiku), showing an idle session starting on the message
// at once (`now`) and a working session taking it when its turn ended (`stepEnd`), both with `ACK <code>`.
export const messagingReceiver = {
  host: 'Claude Code',
  agent: 'claude',
  kind: 'live',
  surfaces: [
    { name: 'CLI', id: SURFACE_IDS.claude, evidence: 'docs/validation/2026-11-16-send-to-claude-live.md', earlier: 'docs/validation/2026-11-03-send-to-claude.md' },
    { name: 'Desktop Code', id: SURFACE_IDS.claudeDesktop, evidence: null },
  ],
  tier: 1,
  primitive: '[P1]',
  isImplemented: true,
  routes: {
    idle: { line: 'now', record: 'docs/validation/2026-11-16-send-to-claude-live.md', surfaces: [SURFACE_IDS.claude] },
    working: { line: 'stepEnd', record: 'docs/validation/2026-11-16-send-to-claude-live.md', surfaces: [SURFACE_IDS.claude] },
    ended: { line: 'none', record: null, surfaces: [] },
  },
}
