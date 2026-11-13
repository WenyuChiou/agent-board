import { SURFACE_IDS } from './messaging'
import type { ReceiverRoutes, Route, RouteKind, RowState } from './messaging'
import { messagingReceiver as claude } from './receiver-record'
import { messagingReceiver as deepseek } from './receivers/deepseek'
import { messagingReceiver as antigravity } from './receivers/hook-mailbox-antigravity'
import { messagingReceiver as codex } from './receivers/hook-mailbox-codex'
import { messagingReceiver as cursor } from './receivers/hook-mailbox-cursor'
import { messagingReceiver as muse } from './receivers/hook-mailbox-muse'
import { messagingReceiver as opencode } from './receivers/opencode'

// A record module is plain data, so its lines read as strings here; the cast is the one place that trusts them, and a test checks each.
type RecordShape = { agent: string; kind: string; routes: { [state in RowState]: { line: string; record: string | null; surfaces: string[] } } }
const fromRecord = (one: RecordShape): ReceiverRoutes => {
  const read = (state: RowState): Route => one.routes[state] as Route
  return { agent: one.agent, kind: one.kind as RouteKind, routes: { idle: read('idle'), working: read('working'), ended: read('ended') } }
}

// The routes the board knows, one per receiver record in hooks/. The three adapters in scripts/ (the
// Codex owner connectors and the Antigravity stream) cannot be imported here, so their routes are copied
// below, and a test pins each copy to the record it came from. An agent not listed has no route: its
// card shows Copy.
export const RECEIVER_ROUTES: readonly ReceiverRoutes[] = [
  fromRecord(claude), fromRecord(deepseek), fromRecord(antigravity), fromRecord(codex), fromRecord(cursor), fromRecord(muse), fromRecord(opencode),
  { agent: 'codex', kind: 'live', routes: { idle: { line: 'now', record: null, surfaces: [] }, working: { line: 'stepEnd', record: null, surfaces: [] }, ended: { line: 'none', record: null, surfaces: [] } } },
  { agent: 'codex', kind: 'turn', routes: { idle: { line: 'none', record: null, surfaces: [] }, working: { line: 'now', record: 'docs/validation/2026-11-04-codex-cli-proxy-live.md', surfaces: [SURFACE_IDS.codexProxy] }, ended: { line: 'none', record: null, surfaces: [] } } },
  { agent: 'antigravity', kind: 'live', routes: { idle: { line: 'now', record: null, surfaces: [] }, working: { line: 'stepEnd', record: null, surfaces: [] }, ended: { line: 'none', record: null, surfaces: [] } } },
]
