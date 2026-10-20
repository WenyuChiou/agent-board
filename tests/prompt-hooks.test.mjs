import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Node loads standalone TypeScript directly; pure plugin modules use the host's
// extensionless imports, so resolve only those local paths for these tests.
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })

const { boardPromptHelper, boardRequestWords, BOARD_REQUEST, boardPromptText, isBoardRequest, promptReceiptScript } = await import('../hooks/board-commands.ts')
const { STRINGS } = await import('../hooks/strings.ts')
const BOARD_WORDS = boardRequestWords(Object.values(STRINGS))
const BOARD_PROMPT_HELPER = boardPromptHelper(BOARD_WORDS)
const PROMPT_RECEIPT_SCRIPT = promptReceiptScript(BOARD_WORDS)

test('a board request receipt stores no prompt words', async () => {
  const { readTurn, answerAgentPrompt } = await import('../hooks/inbox.ts')
  const classify = new Function(`${BOARD_PROMPT_HELPER}; return isBoardRequest`)()
  for (const prompt of ['$agent-board', '/board', '/agent-board', ' \n/board\n ']) {
    for (const payload of [{ prompt }, { extra: { user_message: prompt } }, { parts: [{ type: 'text', text: prompt }] }]) {
      assert.equal(classify(payload), true)
      assert.equal(BOARD_REQUEST.test(boardPromptText(payload)), true)
      const body = JSON.stringify({ session_id: 'synthetic-owner', board_request: classify(payload) })
      assert.ok(!body.includes(prompt.trim()))
      const receipt = readTurn('codex-prompt-1792216380000-1.json', body)
      assert.equal(receipt.isBoardRequest, true)
      assert.equal(receipt.prompt, '')
      assert.equal(receipt.answer, '')
      assert.equal(receipt.transcript, '')
      assert.equal(answerAgentPrompt(undefined, receipt, receipt.at + 1), null)
    }
  }
  for (const prompt of ['/board please fix this', '$agent-board and choose 100', 'where do things stand?']) assert.equal(classify({ prompt }), false)
  assert.equal(classify({ parts: [{ text: '/board' }, { text: 'PRIVATE_REAL_ANSWER' }] }), false)
  assert.equal(readTurn('codex-prompt-1792216380000-1.json', JSON.stringify({ session_id: 'legacy', prompt: 'PRIVATE_INPUT' })).isBoardRequest, undefined)
  for (const prompt of ['/board', '$agent-board', '/agent-board', 'PRIVATE_REAL_ANSWER']) {
    const result = spawnSync(process.execPath, ['-e', PROMPT_RECEIPT_SCRIPT], { input: JSON.stringify({ session_id: 'synthetic-owner', prompt, last_assistant_message: 'PRIVATE_FAKE_REPLY', transcript_path: '/PRIVATE_TRANSCRIPT' }), encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { session_id: 'synthetic-owner', ...(prompt === 'PRIVATE_REAL_ANSWER' ? {} : { board_request: true }) })
    assert.ok(!result.stdout.includes('PRIVATE_'))
    assert.ok(!result.stdout.includes(prompt))
  }
})

test('a board-only reply restores an existing question on every board surface and rejects stale restoration', async () => {
  const { answerAgentPrompt, blockId, readTurn, restoreAgentBoardQuestion, withAgentPrompts } = await import('../hooks/inbox.ts')
  const { emptyMirror } = await import('../hooks/mirror.ts')
  const { applyDigest } = await import('../hooks/digest.ts')
  const { upsertAutoBlock } = await import('../hooks/blocks.ts')
  const { parseProgress } = await import('../hooks/parse.ts')
  const { buildView } = await import('../hooks/view.ts')
  const { boardText, chatText } = await import('../hooks/board.ts')
  const { dashboardHtml } = await import('../hooks/dashboard.ts')
  const { serveModel } = await import('../hooks/serve.ts')
  const { emptyQuestions, observeQuestions } = await import('../hooks/questions.ts')
  const { EN } = await import('../hooks/strings-en.ts')
  const at = 1792216380000
  const session = 'synthetic-board-owner'
  const mirror = { ...applyDigest(emptyMirror(blockId('codex', session), 'demo', at, '/demo', 'codex'), { title: 'Limit', context: '', done: '', next: 'Continue', ask: 'Per-key limit', why: '100 or 300 a minute?' }, at), resume: session, turnOrder: at * 2 }
  const prompt = readTurn(`codex-prompt-${at + 1000}-1.json`, JSON.stringify({ session_id: session }))
  const answered = answerAgentPrompt(mirror, prompt, at + 1000)
  assert.ok(answered.tasks.every(one => one.waiting !== 'you'))
  const board = readTurn(`codex-turn-${at + 2000}-1.json`, JSON.stringify({ session_id: session, prompt: 'where do things stand?', last_assistant_message: 'Progress  ● 1 waiting  ▸ 0 in progress  ⚑ 0 due soon  ✓ 0 done today' }))
  const restored = restoreAgentBoardQuestion(answered, board, at + 2000)
  assert.equal(restored.state, mirror.state)
  assert.equal(restored.tasks.filter(one => one.waiting === 'you').length, 1)
  assert.equal(restored.promptQuestion, null)
  assert.equal(restoreAgentBoardQuestion(restored, board, at + 3000), null)
  const later = { ...prompt, at: at + 3000 }
  assert.equal(restoreAgentBoardQuestion(answerAgentPrompt(answered, later, at + 3000), board, at + 4000), null)
  assert.equal(restoreAgentBoardQuestion(answered, { ...board, session: 'foreign-session' }, at + 4000), null)
  assert.equal(restoreAgentBoardQuestion({ ...answered, confirmedAt: at + 3000 }, board, at + 4000), null)
  assert.equal(restoreAgentBoardQuestion({ ...answered, tasks: answered.tasks.map(one => ({ ...one, subject: 'New work' })) }, board, at + 4000), null)
  const receipt = { id: prompt.id, agent: prompt.agent, session, at: prompt.at, updated: at + 1000 }
  assert.deepEqual(withAgentPrompts(restored, [receipt], at + 4000), restored)
  const projects = one => parseProgress(upsertAutoBlock('# Progress\n', one, EN))
  let ledger = observeQuestions(emptyQuestions(), projects(mirror), null, [], at).ledger
  ledger = observeQuestions(ledger, projects(answered), null, [], at + 1000).ledger
  assert.equal(ledger.records.filter(one => one.isUnresolved).length, 0)
  ledger = observeQuestions(ledger, projects(restored), null, [], at + 2000).ledger
  assert.equal(ledger.records.filter(one => one.isUnresolved).length, 1)
  const view = buildView(projects(restored), [], null, at + 3000, 0, {}, EN, [], {}, ledger)
  for (const text of [boardText(view, [], EN), chatText(view, [], [], EN, '/synthetic'), dashboardHtml(view, EN, '/synthetic/progress.md', ''), JSON.stringify(serveModel(view, [], EN))]) assert.ok(text.includes('100 or 300 a minute?'), text.slice(0, 500))
})

test('the native OpenCode prompt callback flags exact board commands without retaining their text', async () => {
  const { opencodePlugin } = await import('../hooks/local-agents.ts')
  const saved = []
  const source = opencodePlugin('node', '/synthetic/board.mjs', '/synthetic/progress.md', 'Progress')
  const factory = new Function('spawnSync', 'tool', `${source.replace(/^import .*\n/gm, '').replace('export const AgentBoardLocal', 'const AgentBoardLocal')}\nreturn AgentBoardLocal`)((_node, _args, options) => { saved.push(JSON.parse(options.input)); return { status: 0, stdout: '' } }, Object.assign(value => value, { schema: { string: () => ({}), enum: () => ({}), array: () => ({}) } }))
  const hooks = await factory({ client: { session: { get: async ({ path }) => ({ data: { id: path.id } }) } } })
  await hooks['chat.message']({ sessionID: 'synthetic-owner' }, { parts: [{ type: 'text', text: '/board' }] })
  assert.equal(saved[0].board_request, true)
  assert.ok(!JSON.stringify(saved[0]).includes('/board'))
  await hooks['chat.message']({ sessionID: 'synthetic-owner' }, { parts: [{ type: 'text', text: 'PRIVATE_REAL_ANSWER' }] })
  assert.equal(saved[1].board_request, undefined)
  assert.ok(!JSON.stringify(saved[1]).includes('PRIVATE_REAL_ANSWER'))
  const { EN } = await import('../hooks/strings-en.ts')
  await hooks['chat.message']({ sessionID: 'synthetic-owner' }, { parts: [{ type: 'text', text: `${EN.boardCommandPrompt}\n\nProgress  ● 1  ▸ 0  ⚑ 0  ✓ 0` }] })
  assert.equal(saved[2].board_request, true)
  assert.ok(!JSON.stringify(saved[2]).includes(EN.boardCommandPrompt))
})

const source = readFileSync(new URL('../hooks/connect-pure.ts', import.meta.url), 'utf8')
const ctx = { inbox: '/synthetic/progress-inbox' }
const template = (name, end, withPrompt = true) => {
  const start = source.indexOf(`export const ${name} =`)
  assert.ok(start >= 0)
  const code = stripTypeScriptTypes(source.slice(start, source.indexOf(end, start)), { mode: 'strip' }).replace('export const', 'const')
  return new Function('BOARD_PROMPT_HELPER', `const OPENCLAW_ID = 'agent-board'; ${code}; return ${name}`)(BOARD_PROMPT_HELPER)(ctx, withPrompt)
}

test('pre-prompt plugin templates retain the exact bytes released in 0.20.5 and 0.23.1', () => {
  const legacy = [
    ['opencodePlugin', '\nconst OPENCLAW_ID', '20b3fd9ec5b02ee9c2090490a0853dfe47fca270392c57de92f55dad2069e645'],
    ['openclawPlugin', '\n// The standalone board', 'feb2b8ff0af006c582ab0de7165f18fa3fa107fb49e24b0dec414c19cfcf413f'],
  ]
  for (const [name, end, hash] of legacy) assert.equal(createHash('sha256').update(template(name, end, false)).digest('hex'), hash)
})

test('generated OpenCode and OpenClaw prompt callbacks retain only verified binding metadata', async () => {
  const saved = []
  const instantiate = (script, suffix) => new Function('mkdirSync', 'renameSync', 'writeFileSync', 'join', `${script.replace(/^import .*\n/gm, '').replace('export const AgentBoard', 'const AgentBoard').replace('export default', 'const plugin =')}\n${suffix}`)(() => {}, () => {}, (name, body) => saved.push({ name, body }), (...parts) => parts.join('/'))
  let hasMessages = false
  const factory = instantiate(template('opencodePlugin', '\nconst OPENCLAW_ID'), 'return AgentBoard')
  const hooks = await factory({ directory: '/demo', client: { session: { get: async ({ path }) => ({ data: { id: path.id, ...(path.id === 'subagent' ? { parentID: 'parent' } : {}) } }), messages: () => { hasMessages = true; throw new Error('prompt fetched messages') } } } })
  await hooks['chat.message']({ sessionID: 'subagent' }, {})
  assert.equal(saved.length, 0)
  await hooks['chat.message']({ sessionID: 'prompt-owner' }, { message: { content: 'PRIVATE_NEW_INPUT' } })
  assert.equal(hasMessages, false)
  assert.deepEqual(JSON.parse(saved[0].body), { session_id: 'prompt-owner', cwd: '/demo' })
  const callbacks = new Map()
  instantiate(template('openclawPlugin', '\n// The standalone board'), 'return plugin').register({ on: (name, fn) => callbacks.set(name, fn) })
  for (const kind of ['inter_session', 'internal_system', undefined]) callbacks.get('before_prompt_build')({ prompt: 'PRIVATE_NEW_INPUT' }, { sessionId: 'prompt-owner', inputProvenance: { kind } })
  assert.equal(saved.length, 1)
  callbacks.get('before_prompt_build')({ prompt: 'PRIVATE_NEW_INPUT' }, { sessionId: 'prompt-owner', workspaceDir: '/demo', inputProvenance: { kind: 'external_user' } })
  assert.equal(saved.length, 2)
  assert.deepEqual(JSON.parse(saved[1].body), { session_id: 'prompt-owner', cwd: '/demo' })
  assert.ok(saved.every(one => one.name.includes('-prompt-') && !one.body.includes('PRIVATE_NEW_INPUT')))
})

test('legacy prompt callbacks flag board commands without retaining their text', async () => {
  const { EN } = await import('../hooks/strings-en.ts')
  const prompts = ['/board', '$agent-board', '/agent-board', `${EN.boardCommandPrompt}\n\nProgress  ● 1  ▸ 0  ⚑ 0  ✓ 0`]
  const saved = []
  const instantiate = (script, suffix) => new Function('mkdirSync', 'renameSync', 'writeFileSync', 'join', script.replace(/^import .*\n/gm, '').replace('export const AgentBoard', 'const AgentBoard').replace('export default', 'const plugin =') + '\n' + suffix)(() => {}, () => {}, (name, body) => saved.push({ name, body }), (...parts) => parts.join('/'))
  const factory = instantiate(template('opencodePlugin', '\nconst OPENCLAW_ID'), 'return AgentBoard')
  const hooks = await factory({ directory: '/synthetic', client: { session: { get: async ({ path }) => ({ data: { id: path.id } }) } } })
  for (const text of prompts) await hooks['chat.message']({ sessionID: 'synthetic-owner' }, { parts: [{ type: 'text', text }] })
  const callbacks = new Map()
  instantiate(template('openclawPlugin', '\n// The standalone board'), 'return plugin').register({ on: (name, callback) => callbacks.set(name, callback) })
  for (const prompt of prompts) callbacks.get('before_prompt_build')({ prompt }, { sessionId: 'synthetic-owner', inputProvenance: { kind: 'external_user' } })
  assert.equal(saved.length, 8)
  for (const one of saved) assert.deepEqual(JSON.parse(one.body), { session_id: 'synthetic-owner', ...(one.name.includes('opencode-') ? { cwd: '/synthetic' } : { cwd: '' }), board_request: true })
})

const sh = process.platform === 'win32' ? existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'sh' : '/bin/sh'
const shellPath = path => path.replaceAll('\\', '/')
const fixture = async fn => {
  const home = mkdtempSync(join(tmpdir(), 'board-prompt-144b-'))
  try { await fn(home) } finally { rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) }
}
const receipts = home => existsSync(join(home, 'progress-inbox')) ? readdirSync(join(home, 'progress-inbox')).map(file => ({ file, body: readFileSync(join(home, 'progress-inbox', file), 'utf8') })) : []

test('the sh reporter writes a prompt receipt with no prompt words from stdin or an argument', () => fixture(async home => {
  const { reporterSh } = await import('../hooks/connect-pure.ts')
  const file = join(home, 'progress-report.sh')
  writeFileSync(file, reporterSh(shellPath(join(home, 'progress-inbox'))))
  for (const mode of ['stdin', 'argument']) for (const prompt of ['/board', 'PRIVATE_REAL_ANSWER']) {
    const raw = JSON.stringify({ session_id: `synthetic-${mode}-${prompt === '/board'}`, cwd: '/synthetic/中文', prompt, transcript_path: 'PRIVATE_TRANSCRIPT' })
    const result = spawnSync(sh, [shellPath(file), 'gemini', 'prompt', ...(mode === 'argument' ? [raw] : [])], { input: mode === 'stdin' ? raw : undefined, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
  }
  const saved = receipts(home)
  assert.equal(saved.length, 4)
  for (const { body } of saved) {
    assert.ok(!/[^\x20-\x7e]/.test(body))
    const receipt = JSON.parse(body)
    assert.deepEqual(receipt, { session_id: receipt.session_id, cwd: '/synthetic/中文', ...(receipt.session_id.endsWith('true') ? { board_request: true } : {}) })
    assert.ok(!body.includes('PRIVATE_') && !body.includes('/board'))
  }
}))

test('the PowerShell reporter writes a prompt receipt with no prompt words', { skip: process.platform !== 'win32' }, () => fixture(async home => {
  const { reporterPs1 } = await import('../hooks/connect-pure.ts')
  const file = join(home, 'progress-report.ps1')
  writeFileSync(file, reporterPs1())
  assert.ok(!reporterPs1().includes('[Console]::OutputEncoding'))
  for (const prompt of ['/board', '$agent-board', '/agent-board', 'PRIVATE_REAL_ANSWER']) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, 'codex', 'prompt'], { input: JSON.stringify({ session_id: 'synthetic-owner', cwd: '/synthetic/中文', prompt, transcript_path: 'PRIVATE_TRANSCRIPT' }), encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
  }
  const saved = receipts(home)
  assert.equal(saved.length, 4)
  const values = saved.map(one => JSON.parse(one.body))
  assert.equal(values.filter(one => one.board_request === true).length, 3)
  assert.ok(values.every(one => one.cwd === '/synthetic/中文'))
  assert.ok(saved.every(one => !/[^\x20-\x7e]/.test(one.body)))
  assert.ok(saved.every(one => !one.body.includes('PRIVATE_') && !one.body.includes('/board') && !one.body.includes('$agent-board')))
}))

test('a reporter that cannot run node still writes the receipt and the board drops its words', () => fixture(async home => {
  const { reporterPs1, reporterSh, shellQuote } = await import('../hooks/connect-pure.ts')
  const { readTurn } = await import('../hooks/inbox.ts')
  const seen = new Set()
  const tools = join(home, 'tools')
  mkdirSync(tools)
  for (const name of ['mkdir', 'date', 'cat', 'mv', 'rm', 'find']) {
    const located = spawnSync(sh, ['-c', `command -v ${name}`], { encoding: 'utf8', windowsHide: true })
    assert.equal(located.status, 0, located.stderr)
    const file = join(tools, name)
    writeFileSync(file, `#!/bin/sh\nexec ${shellQuote(located.stdout.trim())} "$@"\n`)
    chmodSync(file, 0o755)
  }
  const ps = join(home, 'progress-report.ps1'), shell = join(home, 'progress-report.sh')
  writeFileSync(ps, reporterPs1())
  writeFileSync(shell, reporterSh(shellPath(join(home, 'progress-inbox'))))
  const powershell = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null
  for (const prompt of ['/board', 'PRIVATE_REAL_ANSWER']) for (const mode of ['stdin', 'argument']) {
    const raw = JSON.stringify({ session_id: 'synthetic-fallback', cwd: '/synthetic/中文', prompt, transcript_path: 'PRIVATE_TRANSCRIPT' })
    const env = { ...process.env, PATH: shellPath(tools) }
    // Both hosts must retain a receipt when Node is missing, fails, or returns nothing.
    for (const failure of ['missing', 'failed', 'empty']) {
      const node = join(tools, 'node')
      if (failure === 'missing') { rmSync(node, { force: true }); rmSync(`${node}.cmd`, { force: true }) }
      else {
        const status = failure === 'failed' ? 17 : 0
        writeFileSync(node, `#!/bin/sh\nprintf 'synthetic node error' >&2\nexit ${status}\n`)
        chmodSync(node, 0o755)
        if (process.platform === 'win32') writeFileSync(`${node}.cmd`, `@echo synthetic node error >&2\r\n@exit /b ${status}\r\n`)
      }
      const runs = [[sh, [shellPath(shell), 'gemini', 'prompt', ...(mode === 'argument' ? [raw] : [])]]]
      if (powershell) runs.push([powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, 'codex', 'prompt', ...(mode === 'argument' ? [raw] : [])]])
      for (const [program, args] of runs) {
        const before = receipts(home).length
        const result = spawnSync(program, args, { env, input: mode === 'stdin' ? raw : undefined, encoding: 'utf8', windowsHide: true })
        assert.equal(result.status, 0, `${program} ${failure}: ${result.stderr}`)
        assert.equal(result.stderr, '', `${program} ${failure}`)
        const saved = receipts(home)
        assert.equal(saved.length, before + 1, `${program} ${failure}`)
        const receipt = saved.find(one => !seen.has(one.file))
        seen.add(receipt.file)
        assert.deepEqual(JSON.parse(receipt.body), JSON.parse(raw))
        const turn = readTurn(receipt.file, receipt.body)
        assert.equal(turn.prompt, '')
        assert.equal(turn.answer, '')
        assert.equal(turn.transcript, '')
        assert.equal(turn.isBoardRequest, prompt === '/board' ? true : undefined)
      }
    }
  }
}))

test('an expanded board command sent by Gemini or OpenCode counts as a board request', async () => {
  const { STRINGS } = await import('../hooks/strings.ts')
  const { readTurn, isBoardTurn } = await import('../hooks/inbox.ts')
  const classify = new Function(`${BOARD_PROMPT_HELPER}; return isBoardRequest`)()
  for (const s of Object.values(STRINGS)) for (const prompt of [`${s.boardCommandPrompt}\n\nProgress  ● 1  ▸ 0  ⚑ 0  ✓ 0`, '<name>agent-board</name>\nPRIVATE_COMMAND_BODY']) {
    for (const agent of ['gemini', 'opencode']) {
      const payload = { session_id: 'expanded-owner', prompt }
      assert.equal(classify(payload), true)
      assert.equal(isBoardRequest(payload, BOARD_WORDS), true)
      assert.equal(isBoardTurn({ event: 'turn', prompt, answer: '' }), true)
      const result = spawnSync(process.execPath, ['-e', PROMPT_RECEIPT_SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { session_id: 'expanded-owner', board_request: true })
      assert.equal(readTurn(`${agent}-prompt-1792216380000-1.json`, JSON.stringify(payload)).isBoardRequest, true)
    }
  }
})

test('restoring several questions advances each revision beyond the previous one', async () => {
  const { answerAgentPrompt, blockId, restoreAgentBoardQuestion } = await import('../hooks/inbox.ts')
  const { emptyMirror, applyTaskCreate } = await import('../hooks/mirror.ts')
  const at = 1792216380000, session = 'multiple-questions'
  let mirror = emptyMirror(blockId('codex', session), 'demo', at, '/demo', 'codex')
  for (const id of ['one', 'two']) mirror = applyTaskCreate(mirror, { subject: id, metadata: { waiting: 'you', why: 'Choose?' } }, id, at)
  mirror = { ...mirror, resume: session, turnOrder: at * 2 }
  const turn = { id: mirror.sessionId, agent: 'codex', session, cwd: '', project: '', prompt: '', answer: '', transcript: '' }
  const answered = answerAgentPrompt(mirror, { ...turn, event: 'prompt', at: at + 1000 }, at + 1000)
  const restored = restoreAgentBoardQuestion(answered, { ...turn, event: 'turn', prompt: '/board', at: at + 2000 }, at + 2000)
  assert.deepEqual(restored.tasks.map(one => one.questionRevision), ['3', '4'])
  assert.equal(restored.questionSequence, '4')
})
