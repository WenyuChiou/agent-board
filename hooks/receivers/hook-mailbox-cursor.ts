import { SURFACE_IDS } from '../messaging.ts'

// The hook does not distinguish the IDE from cursor-agent CLI when it registers.
export const messagingReceiver = {
  host: 'Cursor',
  agent: 'cursor',
  kind: 'mailbox',
  surfaces: [{ name: 'IDE (Composer)', id: SURFACE_IDS.cursor, evidence: null }, { name: 'cursor-agent CLI', id: SURFACE_IDS.cursor, evidence: null }],
  tier: 3,
  primitive: 'unknown',
  isImplemented: true,
  routes: {
    idle: { line: 'chatOpen', record: null, surfaces: [] },
    working: { line: 'chatOpen', record: null, surfaces: [] },
    ended: { line: 'none', record: null, surfaces: [] },
  },
}
