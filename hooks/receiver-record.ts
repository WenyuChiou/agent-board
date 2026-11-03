// What hooks/receiver.ts gives, for the generated messaging table (#720). On its own, so a script
// can import it without the mod's other modules. The CLI's evidence stays null until a run with a
// real model is recorded; docs/validation/2026-11-03-send-to-claude.md says what has been run.
export const messagingReceiver = {
  host: 'Claude Code',
  surfaces: [{ name: 'CLI', evidence: null }, { name: 'Desktop Code', evidence: null }],
  tier: 1,
  primitive: '[P1]',
  isImplemented: true,
}
