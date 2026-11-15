import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  },
})

const { EN } = await import('../hooks/strings-en.ts')
const { ZH_TW } = await import('../hooks/i18n.ts')
const { ZH_CN } = await import('../hooks/strings-zh-cn.ts')
const { parseProgress } = await import('../hooks/parse.ts')
const { buildView } = await import('../hooks/view.ts')
const { routeText, serveModel, servePage } = await import('../hooks/serve.ts')
const { pageDom } = await import('./e2e/lib/surfaces.mjs')
const { SURFACE_IDS } = await import('../hooks/messaging.ts')

const now = Date.parse('2026-11-15T12:00:00Z')
const session = '11111111-2222-4333-8444-555555555555'
const title = 'Synthetic resumed conversation'
const hints = [
  'Resume this Codex conversation on the computer, then submit one prompt in Codex to reconnect. Once connected, send from the board on that computer; reopening alone does not reconnect it.',
  '在電腦上續接這個 Codex 對話，再於 Codex 送出一次提示以重新連線。連上後再從那台電腦的看板傳送；只重新開啟對話還不會連線。',
  '在电脑上恢复这个 Codex 对话，再在 Codex 中发送一次提示以重新连接。连接后再从那台电脑的看板发送；仅重新打开对话还不会连接。',
]
const languages = [['en', EN], ['zh-TW', ZH_TW], ['zh-CN', ZH_CN]]
const routes = [{ agent: 'codex', kind: 'live', routes: {
  idle: { line: 'now', record: 'docs/validation/synthetic-codex-route.md', surfaces: [SURFACE_IDS.cli, SURFACE_IDS.codexDaemon] },
  working: { line: 'none', record: null, surfaces: [] },
  ended: { line: 'none', record: null, surfaces: [] },
} }]
const model = (s, state = 'ended', connections = [], isLan = false, agent = 'codex', steps = '- [~] Await the next message', { allowResume = false, dir = null } = {}) => {
  const file = `## Synthetic\n<!-- auto session=abcdef01 agent=${agent} resume=${session} state=${state} updated=${new Date(now).toISOString()}${dir === null ? '' : ` dir=${encodeURIComponent(dir)}`} -->\n### ${title}\n${steps}\n<!-- /auto session=abcdef01 -->\n`
  const view = buildView(parseProgress(file), [], null, now, 0, {}, s)
  return serveModel(view, [], s, new Set(), isLan, { connections, mailboxes: [], messages: [] }, allowResume, { now, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [] }, routes)
}
const rowOf = value => {
  const row = [...value.stopped, ...value.idle, ...value.groups.flatMap(one => one.rows)].find(one => one.title === title)
  assert.ok(row, 'the controlled ended task is present')
  return row
}
const staleConnection = { id: 'synthetic-codex-connection', agent: 'codex', session, surface: SURFACE_IDS.cli, turn: 'session', scope: 'session', expires: now + 60_000 }

for (const [index, [lang, s]] of languages.entries()) test(`an ended Codex card explains the prompt needed after resume in ${lang} (#1505)`, async () => {
  const value = model(s)
  const row = rowOf(value)
  assert.equal(row.lineText, hints[index])
  assert.equal(row.canSend, false)
  assert.equal(row.delivery, undefined)
  const dom = await pageDom(servePage(s, 'synthetic-resume-nonce'), value, async () => ({ ok: true, json: async () => ({ ok: true }) }))
  assert.ok(dom.text().includes(hints[index]), 'the page renders the instruction beside its existing resume action')
  assert.ok(dom.text().includes(s.serveCopyResume))
})

test('an old receiver does not make an ended Codex session sendable (#1505)', () => {
  const row = rowOf(model(EN, 'ended', [staleConnection], false, 'codex', undefined, { dir: '/synthetic-project' }))
  assert.equal(row.lineText, hints[0])
  assert.equal(row.canSend, false)
  assert.equal(row.delivery, undefined)
})

test('resume guidance leaves active Codex routes and other agents unchanged (#1505)', () => {
  for (const [, s] of languages) {
    assert.equal(routeText('now', true, 'codex', s, 'idle'), s.serveLineNow('Codex'))
    assert.equal(routeText('now', true, 'codex', s, 'working'), s.serveLineNowWorking('Codex'))
    assert.equal(routeText('none', false, 'cursor', s, 'ended'), s.serveLineNone('Cursor'))
    assert.equal(rowOf(model(s, 'ended', [], false, 'cursor')).lineText, '')
  }
})

test('the network card keeps resume commands and delivery private (#1505)', () => {
  const row = rowOf(model(EN, 'ended', [], true, 'codex', undefined, { dir: '/synthetic-project' }))
  assert.equal(row.lineText, hints[0])
  assert.equal(row.canSend, false)
  assert.equal(row.delivery, undefined)
  assert.equal(row.resume, null)
})

test('a fresh hook state removes the ended hint without bypassing route checks (#1505)', () => {
  const ended = rowOf(model(EN, 'ended', [staleConnection]))
  const waiting = rowOf(model(EN, 'waiting', [staleConnection]))
  assert.equal(ended.lineText, hints[0])
  assert.notEqual(waiting.lineText, hints[0])
  assert.equal(waiting.canSend, true)
})

test('an ended Codex task with a question step keeps its reconnect instruction (#1505)', () => {
  for (const [, s] of languages) {
    const value = model(s, 'ended', [], false, 'codex', '- [?] Choose the next step — Continue or stop?')
    const row = rowOf(value)
    assert.equal(row.lineText, s.serveCodexResumePrompt)
    assert.equal(row.canSend, false)
    assert.equal(row.delivery, undefined)
  }
})

test('state and ownership warnings keep priority over resume advice and verified reopen stays sendable (#1505)', () => {
  for (const [, s] of languages) {
    assert.equal(routeText('none', false, 'codex', s, 'ended', 'STATE_UNKNOWN'), s.serveLineStateUnknown)
    assert.equal(routeText('none', false, 'codex', s, 'ended', 'SHADOWED'), s.serveLineShadowed)
    assert.equal(routeText('none', false, 'codex', s, 'ended', 'TURN_RUNNING'), s.serveSendBusy('Codex'))
    assert.equal(routeText('reopen', true, 'codex', s, 'ended'), s.serveLineReopen('Codex'))
  }
})

test('the explicit legacy resume option keeps its computer and LAN instructions (#1505)', () => {
  for (const [, s] of languages) {
    const computer = rowOf(model(s, 'ended', [], false, 'codex', undefined, { allowResume: true, dir: '/synthetic-project' }))
    assert.equal(computer.line, 'reopen')
    assert.equal(computer.canSend, true)
    assert.equal(computer.lineText, s.serveLineReopen('Codex'))
    const lan = rowOf(model(s, 'ended', [], true, 'codex', undefined, { allowResume: true, dir: '/synthetic-project' }))
    assert.equal(lan.lineText, '')
    assert.equal(lan.canSend, false)
    assert.equal(lan.resume, null)
    assert.equal(lan.delivery, undefined)
    assert.equal(lan.info, s.serveLanSend('Codex'))
  }
})

test('the resumed Codex daemon card preserves its watch delay alongside the ended hint (#1505)', () => {
  for (const [, s] of languages) {
    const connection = { ...staleConnection, surface: SURFACE_IDS.codexDaemon }
    const ended = rowOf(model(s, 'ended', [connection]))
    assert.equal(ended.lineText, s.serveCodexResumePrompt)
    assert.equal(ended.canSend, false)
    assert.equal(ended.delivery, undefined)
    const waiting = rowOf(model(s, 'waiting', [connection]))
    assert.equal(waiting.lineText, s.serveLineSoon('Codex'))
    assert.equal(waiting.canSend, true)
    assert.equal(waiting.delivery.id, connection.id)
    assert.equal(routeText('now', true, 'codex', s, 'working', undefined, SURFACE_IDS.codexDaemon), s.serveLineNowWorking('Codex'))
  }
})
