import type { ReceiverRoutes, RouteKind, RowState } from './messaging'
import { messagingReceiver as claude } from './receiver-record'
import { messagingReceiver as deepseek } from './receivers/deepseek'
import { messagingReceiver as antigravity } from './receivers/hook-mailbox-antigravity'
import { messagingReceiver as codex } from './receivers/hook-mailbox-codex'
import { messagingReceiver as cursor } from './receivers/hook-mailbox-cursor'
import { messagingReceiver as gemini } from './receivers/hook-mailbox-gemini'
import { messagingReceiver as muse } from './receivers/hook-mailbox-muse'

// A record module is plain data, so its lines read as strings here; the cast is the one place that trusts them, and a test checks each.
type RecordShape = { agent: string; kind: string; routes: { [state in RowState]: { line: string; record: string | null } } }
const fromRecord = (one: RecordShape): ReceiverRoutes => ({ agent: one.agent, kind: one.kind as RouteKind, routes: one.routes as ReceiverRoutes['routes'] })

// The routes the board knows, one per receiver record in hooks/. The three adapters in scripts/ (the
// Codex owner connectors and the Antigravity stream) cannot be imported here, so their routes are copied
// below, and a test pins each copy to the record it came from. An agent not listed has no route: its
// card shows Copy.
export const RECEIVER_ROUTES: readonly ReceiverRoutes[] = [
  fromRecord(claude), fromRecord(deepseek), fromRecord(antigravity), fromRecord(codex), fromRecord(cursor), fromRecord(gemini), fromRecord(muse),
  { agent: 'codex', kind: 'live', routes: { idle: { line: 'now', record: null }, working: { line: 'stepEnd', record: null }, ended: { line: 'none', record: null } } },
  { agent: 'codex', kind: 'turn', routes: { idle: { line: 'none', record: null }, working: { line: 'now', record: 'docs/validation/2026-11-04-codex-cli-proxy-live.md' }, ended: { line: 'none', record: null } } },
  { agent: 'antigravity', kind: 'live', routes: { idle: { line: 'now', record: null }, working: { line: 'stepEnd', record: null }, ended: { line: 'none', record: null } } },
]
