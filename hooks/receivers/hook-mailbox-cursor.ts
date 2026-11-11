// Routes: what a message from the board does today, and the validation note that showed it live (null: none did).
export const messagingReceiver = {
  host: 'Cursor',
  agent: 'cursor',
  kind: 'mailbox',
  surfaces: [{ name: 'IDE (Composer)', evidence: null }, { name: 'cursor-agent CLI', evidence: null }],
  tier: 3,
  primitive: 'unknown',
  isImplemented: true,
  routes: {
    idle: { line: 'chatOpen', record: null },
    working: { line: 'chatOpen', record: null },
    ended: { line: 'none', record: null },
  },
}
