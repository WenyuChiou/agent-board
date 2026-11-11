// Routes: what a message from the board does today, and the validation note that showed it live (null: none did).
export const messagingReceiver = {
  host: 'Gemini CLI',
  agent: 'gemini',
  kind: 'mailbox',
  surfaces: [{ name: 'CLI', evidence: null }],
  tier: 3,
  primitive: 'unknown',
  isImplemented: true,
  routes: {
    idle: { line: 'nextTurn', record: null },
    working: { line: 'nextTurn', record: null },
    ended: { line: 'none', record: null },
  },
}
