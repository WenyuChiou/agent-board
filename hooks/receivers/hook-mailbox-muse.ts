import { SURFACE_IDS } from '../messaging.ts'
export const messagingReceiver = {
  host: 'Muse Code',
  agent: 'muse',
  kind: 'mailbox',
  surfaces: [{ name: 'CLI', id: SURFACE_IDS.cli, evidence: null }],
  tier: 3,
  primitive: 'unknown',
  isImplemented: true,
  routes: {
    idle: { line: 'nextTurn', record: null, surfaces: [] },
    working: { line: 'nextTurn', record: null, surfaces: [] },
    ended: { line: 'none', record: null, surfaces: [] },
  },
}
