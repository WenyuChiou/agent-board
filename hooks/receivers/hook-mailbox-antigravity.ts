// The Antigravity app and its IDE are one program on the person's computer, sharing the
// same global hook path, so they share one row. `agy` in a terminal is the `agy` a person
// runs; the board-started stream is a note on its row, not a row of its own.
export const messagingReceiver = {
  host: 'Antigravity',
  surfaces: [{ name: 'Antigravity app', evidence: null }, { name: '`agy` in a terminal', evidence: null, note: 'boardStarted' }],
  tier: 3,
  primitive: 'unknown',
  isImplemented: true,
}
