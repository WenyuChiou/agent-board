// Routes: what a message from the board does today, and the validation note that showed it live (null: none did).
export const messagingReceiver = {
  host: 'Antigravity',
  agent: 'antigravity',
  kind: 'mailbox',
  surfaces: [{ name: '2.0 Desktop App', evidence: null }, { name: 'IDE', evidence: null }, { name: 'agy TUI', evidence: null }],
  tier: 3,
  primitive: 'unknown',
  isImplemented: true,
  routes: {
    idle: { line: 'nextTurn', record: 'docs/validation/2026-11-10-agy-live.md' },
    working: { line: 'nextTurn', record: null },
    ended: { line: 'none', record: null },
  },
}
