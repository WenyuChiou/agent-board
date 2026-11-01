- **Tests / Hook load** · Hook-load reports no longer accept the closed #241 timing exception: failed or missing measurements now fail the run, without claiming the measured latency was fixed (#604).
  Tests: `L5 hook load results: every failed measurement fails after the closed issue is removed`, `L5 hook load results: missing measurements fail and complete successful measurements pass`.
