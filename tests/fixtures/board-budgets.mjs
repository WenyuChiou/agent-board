// Reviewed scale and latency targets for the pure board view (#192).
// A median avoids a single scheduler pause on a slow CI runner; no retry raises the limit.
export const BOARD_BUDGETS = Object.freeze({
  blocks: 300,
  liveBlocks: 100,
  ledgerRecords: 1000,
  buildViewMs: 50,
  warmupRuns: 3,
  measuredRuns: 5,
})
