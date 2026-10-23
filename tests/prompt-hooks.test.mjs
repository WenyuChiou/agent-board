import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { classifierDiagnostic, observeClassifier } from './fixtures/classifier-diagnostic.mjs'
import { assertPromptReceiptCount, promptReceiptDiagnostic } from './fixtures/prompt-receipt-diagnostic.mjs'
import { inspect } from 'node:util'

// Node loads standalone TypeScript directly; pure plugin modules use the host's
// extensionless imports, so resolve only those local paths for these tests.
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })

const { boardPromptHelper, boardRequestWords, BOARD_REQUEST, BOARD_REQUEST_HINTS, boardPromptText, isBoardRequest, promptReceiptScript } = await import('../hooks/board-commands.ts')
const { STRINGS } = await import('../hooks/strings.ts')
const { legacyOpenClawPlugin, legacyOpenCodePlugin } = await import('../hooks/legacy-hook-plugins.ts')
const { opencodePlugin, openclawPlugin } = await import('../hooks/connect-pure.ts')
const BOARD_WORDS = boardRequestWords(Object.values(STRINGS))
const BOARD_PROMPT_HELPER = boardPromptHelper(BOARD_WORDS)
const PROMPT_RECEIPT_SCRIPT = promptReceiptScript(BOARD_WORDS)

test('every board request contains a word the reporters\' timeout fallback looks for', () => {
  // The sh fallback copies each hint into a case pattern, so a hint holds only letters, digits and hyphens.
  for (const hint of BOARD_REQUEST_HINTS) assert.match(hint, /^[A-Za-z0-9-]+$/)
  const commands = ['/board', '$agent-board', '/agent-board']
  // The command list follows BOARD_REQUEST: a command it no longer matches fails here.
  for (const command of commands) assert.ok(BOARD_REQUEST.test(command), command)
  for (const prompt of [...BOARD_WORDS, ...commands, '<name>agent-board</name>']) {
    assert.ok(BOARD_REQUEST_HINTS.some(hint => prompt.toLowerCase().includes(hint.toLowerCase())), prompt)
  }
})

test('the legacy reporters read and classify within 2000 ms, under the hosts\' 3 s hook timeout', async () => {
  const { HOOK_INPUT_TIMEOUT } = await import('../hooks/hook-safety.ts')
  const { reporterPs1, reporterSh } = await import('../hooks/connect-pure.ts')
  assert.equal(HOOK_INPUT_TIMEOUT, 2000)
  assert.ok(reporterSh('/synthetic/inbox').includes('sleep 2 &'))
  assert.ok(reporterPs1().includes('-ge 2000'))
})

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
  const source = opencodePlugin('node', '/synthetic/board.mjs', '/synthetic/progress.md', 'Progress', process.env.HOME)
  const factory = new Function('createRequire', 'spawnSync', 'tool', `${source.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace('export const AgentBoardLocal', 'const AgentBoardLocal')}\nreturn AgentBoardLocal`)(createRequire, (_node, _args, options) => { saved.push(JSON.parse(options.input)); return { status: 0, stdout: '' } }, Object.assign(value => value, { schema: { string: () => ({}), enum: () => ({}), array: () => ({}) } }))
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

const ctx = { home: '/synthetic', inbox: '/synthetic/progress-inbox' }
const template = (name, _end, withPrompt = true, context = ctx) =>
  ({ opencodePlugin, openclawPlugin })[name](context, withPrompt)

test('pre-prompt plugin templates retain the exact bytes released in 0.20.5 and 0.23.1', () => {
  const legacy = [
    [legacyOpenCodePlugin, '20b3fd9ec5b02ee9c2090490a0853dfe47fca270392c57de92f55dad2069e645'],
    [legacyOpenClawPlugin, 'feb2b8ff0af006c582ab0de7165f18fa3fa107fb49e24b0dec414c19cfcf413f'],
  ]
  for (const [generate, hash] of legacy) assert.equal(createHash('sha256').update(generate(ctx, false)).digest('hex'), hash)
})

test('prompt plugin templates released before the board-request flag are still recognised as ours', async () => {
  const { agentHooks, COLLISION } = await import('../hooks/connect-pure.ts')
  const hooks = agentHooks({ ...ctx, home: '/synthetic', sep: '/', isWindows: false, script: '/synthetic/progress-report.sh', codexHome: '/synthetic/.codex', grokHome: '/synthetic/.grok', hermesHome: '/synthetic/.hermes', openclawHome: '/synthetic/.openclaw' })
  // Hashes come from the prompt templates in agent-board--v0.23.5:hooks/connect-pure.ts.
  const legacy = [
    ['opencode', 'opencodePlugin', '\nconst OPENCLAW_ID', 'd40d4a969cfa7c8dda1db8d15260cfe288e12ab4a277c048f9f9439023f8a367'],
    ['openclaw', 'openclawPlugin', '\n// The standalone board', '56ac9f27f891b21fe62c044976101d8a589d455e043d16038ab7e171165ce542'],
  ]
  for (const [agent, name, end, hash] of legacy) {
    const old = (agent === 'opencode' ? legacyOpenCodePlugin : legacyOpenClawPlugin)(ctx, true, false)
    assert.equal(createHash('sha256').update(old).digest('hex'), hash)
    const hook = hooks.find(one => one.agent === agent && one.generated)
    assert.ok(hook)
    assert.equal(hook.edit(old, false), template(name, end))
    assert.equal(hook.edit(old + '// personal edit\n', false), COLLISION)
  }
})

test('pre-safety board-request plugins upgrade by exact bytes and preserve personal edits', async () => {
  const { agentHooks, COLLISION } = await import('../hooks/connect-pure.ts')
  const hooks = agentHooks({ ...ctx, sep: '/', isWindows: false, script: '/synthetic/progress-report.sh', codexHome: '/synthetic/.codex', grokHome: '/synthetic/.grok', hermesHome: '/synthetic/.hermes', openclawHome: '/synthetic/.openclaw' })
  // Hashes come from main f864aae's generated plugins before this safety wrapper.
  for (const [agent, prior, current, hash] of [
    ['opencode', legacyOpenCodePlugin, opencodePlugin, '78d56525458590086447cac30700f5102795ba2a1c88d3ba60c42e4e2f01faf2'],
    ['openclaw', legacyOpenClawPlugin, openclawPlugin, '4b3126f741792fa08b5680f0d884f83e5159d86d885115294e84df7fd95d8d1a'],
  ]) {
    const old = prior(ctx)
    assert.equal(createHash('sha256').update(old).digest('hex'), hash)
    const hook = hooks.find(one => one.agent === agent && one.generated)
    assert.equal(hook.edit(old, false), current(ctx))
    assert.equal(hook.edit(old + '// personal edit\n', false), COLLISION)
  }
})

test('generated OpenCode and OpenClaw prompt callbacks retain only verified binding metadata', async () => {
  const saved = []
  const instantiate = (script, suffix) => {
    const descriptors = new Map()
    const open = name => { const fd = descriptors.size + 1; descriptors.set(fd, name); return fd }
    return new Function('createRequire', 'closeSync', 'mkdirSync', 'openSync', 'renameSync', 'unlinkSync', 'writeFileSync', 'join', `${script.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace('export const AgentBoard', 'const AgentBoard').replace('export default', 'const plugin =')}\n${suffix}`)(createRequire, fd => descriptors.delete(fd), () => {}, open, () => {}, () => {}, (fd, body) => saved.push({ name: descriptors.get(fd), body }), (...parts) => parts.join('/'))
  }
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
  for (const kind of ['inter_session', 'internal_system', undefined]) await callbacks.get('before_prompt_build')({ prompt: 'PRIVATE_NEW_INPUT' }, { sessionId: 'prompt-owner', inputProvenance: { kind } })
  assert.equal(saved.length, 1)
  await callbacks.get('before_prompt_build')({ prompt: 'PRIVATE_NEW_INPUT' }, { sessionId: 'prompt-owner', workspaceDir: '/demo', inputProvenance: { kind: 'external_user' } })
  assert.equal(saved.length, 2)
  assert.deepEqual(JSON.parse(saved[1].body), { session_id: 'prompt-owner', cwd: '/demo' })
  assert.ok(saved.every(one => one.name.includes('-prompt-') && !one.body.includes('PRIVATE_NEW_INPUT')))
})

test('legacy prompt callbacks flag board commands without retaining their text', async () => {
  const { EN } = await import('../hooks/strings-en.ts')
  const prompts = ['/board', '$agent-board', '/agent-board', `${EN.boardCommandPrompt}\n\nProgress  ● 1  ▸ 0  ⚑ 0  ✓ 0`]
  const saved = []
  const instantiate = (script, suffix) => {
    const descriptors = new Map()
    const open = name => { const fd = descriptors.size + 1; descriptors.set(fd, name); return fd }
    return new Function('createRequire', 'closeSync', 'mkdirSync', 'openSync', 'renameSync', 'unlinkSync', 'writeFileSync', 'join', `${script.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace('export const AgentBoard', 'const AgentBoard').replace('export default', 'const plugin =')}\n${suffix}`)(createRequire, fd => descriptors.delete(fd), () => {}, open, () => {}, () => {}, (fd, body) => saved.push({ name: descriptors.get(fd), body }), (...parts) => parts.join('/'))
  }
  const factory = instantiate(template('opencodePlugin', '\nconst OPENCLAW_ID'), 'return AgentBoard')
  const hooks = await factory({ directory: '/synthetic', client: { session: { get: async ({ path }) => ({ data: { id: path.id } }) } } })
  for (const text of prompts) await hooks['chat.message']({ sessionID: 'synthetic-owner' }, { parts: [{ type: 'text', text }] })
  const callbacks = new Map()
  instantiate(template('openclawPlugin', '\n// The standalone board'), 'return plugin').register({ on: (name, callback) => callbacks.set(name, callback) })
  for (const prompt of prompts) await callbacks.get('before_prompt_build')({ prompt }, { sessionId: 'synthetic-owner', inputProvenance: { kind: 'external_user' } })
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

test('prompt receipt diagnostics distinguish fixed failure codes without exposing fixture data', () => fixture(async home => {
  const log = join(home, '.agent-board', 'hook-errors.log')
  mkdirSync(join(home, '.agent-board'))
  const result = { status: 0, signal: null, stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR', error: Object.assign(new Error('PRIVATE_ERROR'), { code: 'PRIVATE_CODE', path: '/PRIVATE_PATH' }) }
  const context = { program: 'sh', mode: 'stdin', classifier: 'missing', isBoardCommand: true, elapsedMs: 2345.4, budgetMs: 2000, actualReceipts: 0, expectedReceipts: 1 }
  for (const code of ['INPUT_TIMEOUT', 'REPORTER_TIMEOUT', 'INCOMPLETE_INPUT', 'REPORTER_FAILED']) {
    writeFileSync(log, `2026-10-20T00:00:00.0000000Z gemini prompt ${code}\n`)
    assert.throws(() => assertPromptReceiptCount(result, context, home), failure => {
      assert.equal(failure.code, 'ERR_ASSERTION')
      assert.equal(failure.actual, 0)
      assert.equal(failure.expected, 1)
      assert.ok(failure.message.includes(`"fixtureHistoryCodes":["${code}"]`))
      assert.match(failure.message, /"launchToReturnMs":2345,"reporterBudgetMs":2000/)
      assert.match(failure.message, /"status":0,"signal":null,"errorCode":"OTHER"/)
      assert.ok(!/PRIVATE_|board-prompt-144b/.test(inspect(failure)))
      assert.ok(failure.message.length < 1024)
      return true
    })
  }
}))

test('prompt receipt diagnostics leave a passing count untouched without reading a log', () => {
  let reads = 0
  const result = { get status() { reads += 1; return 0 } }
  assertPromptReceiptCount(result, { actualReceipts: 1, expectedReceipts: 1 }, Symbol('not a path'))
  assert.equal(reads, 0, 'a passing count must not construct the diagnostic')
})

test('prompt receipt diagnostics bound and allowlist fixture log history', () => fixture(async home => {
  const context = { program: 'PRIVATE_PROGRAM', mode: 'PRIVATE_MODE', classifier: 'PRIVATE_FAILURE', elapsedMs: Infinity, budgetMs: -1 }
  assert.match(promptReceiptDiagnostic({}, context, home), /"logState":"absent"/)
  mkdirSync(join(home, '.agent-board'))
  const log = join(home, '.agent-board', 'hook-errors.log')
  writeFileSync(log, 'PRIVATE_PAYLOAD'.repeat(10000) + '\n2026-10-20T00:00:00Z gemini prompt PRIVATE_CODE\n' + '2026-10-20T00:00:00Z codex prompt REPORTER_TIMEOUT\n'.repeat(8))
  const diagnostic = promptReceiptDiagnostic({ status: 999, signal: 'PRIVATE_SIGNAL' }, context, home)
  assert.ok(!/PRIVATE_|board-prompt-144b/.test(diagnostic))
  assert.equal((diagnostic.match(/REPORTER_TIMEOUT/g) ?? []).length, 4)
  assert.match(diagnostic, /"launchToReturnMs":null,"reporterBudgetMs":0/)
  assert.ok(diagnostic.length < 1024)
}))

test('classifier diagnostics keep only bounded phase and numeric evidence', () => fixture(async home => {
  const { reporterPs1 } = await import('../hooks/connect-pure.ts')
  const diagnostic = join(home, "classifier's-$&-probe.txt")
  const original = reporterPs1(), observed = observeClassifier(original, diagnostic)
  assert.equal(classifierDiagnostic(diagnostic), 'classifier diagnostic unavailable')
  assert.ok(observed.includes(diagnostic.replaceAll("'", "''")))
  assert.equal(observed.match(/REPORTER_TIMEOUT/g).length, original.match(/REPORTER_TIMEOUT/g).length)
  for (const line of original.split('\n').filter(line => /Wait\(|WaitForExit\(|ElapsedMilliseconds|\.Kill\(|\.Dispose\(/.test(line))) assert.ok(observed.includes(line))
  assert.ok(observed.indexOf('[IO.File]::WriteAllText(') > observed.lastIndexOf('if ($ownsReceipt)'))
  assert.throws(() => observeClassifier(original + original, diagnostic), /anchor must be unique/)
  writeFileSync(diagnostic, '\uFEFFstart|0|MethodInvocationException|-2146233087|Win32Exception|-2147467259|2|-1|-1|-1|34')
  assert.equal(classifierDiagnostic(diagnostic), 'classifier phase=start started=0 type=MethodInvocationException hresult=-2146233087 innerType=Win32Exception innerHresult=-2147467259 nativeCode=2 exit=-1 stdoutChars=-1 stderrChars=-1 elapsedMs=34')
  for (const body of ['PRIVATE_PATH', 'start|0|PRIVATE/path|1||0|0|-1|-1|-1|34', 'start|0||0||0|0|-1|-1|-1|' + '1'.repeat(100), 'start|0||0||0|0|-1|-1|-1|34|PRIVATE_PAYLOAD']) {
    writeFileSync(diagnostic, body)
    assert.equal(classifierDiagnostic(diagnostic), 'classifier diagnostic invalid')
  }
}))

test('generated PowerShell bounds application lookup to one executable', async () => {
  const { reporterPs1, reporterSh } = await import('../hooks/connect-pure.ts')
  // Get-Command searches every module before it reports a missing Node, which can spend
  // more than a second of the reporter budget. The reporter walks PATH and PATHEXT
  // itself and stops at the first match, so ProcessStartInfo.FileName gets one path,
  // never a space-joined array of paths.
  for (const source of [reporterPs1(), reporterSh('/synthetic/inbox')]) {
    assert.doesNotMatch(source, /Get-Command node/)
    assert.match(source, /\[IO\.File\]::Exists\(\$candidate\)\) \{ \$node = \$candidate; break \}/)
    assert.match(source, /\$start\.FileName = \$node\b/)
    assert.match(source, /\[IO\.Path\]::IsPathRooted\(\$folderPath\)/)
  }
})

test('the sh reporter writes a prompt receipt with no prompt words from stdin or an argument', () => fixture(async home => {
  const { reporterSh, shellQuote } = await import('../hooks/connect-pure.ts')
  const { powershellReporter } = await import('../hooks/hook-reporters.ts')
  const file = join(home, 'progress-report.sh')
  const diagnostic = join(home, 'classifier-probe.txt')
  const diagnostics = []
  // The reporter logs here, so each run can tell whether it timed out.
  const env = { ...process.env, HOME: home, USERPROFILE: home }, log = join(home, '.agent-board', 'hook-errors.log'), timedOut = new Set()
  // On Windows the sh reporter hands over to an embedded PowerShell reporter; observe its classifier as for ps1.
  const source = reporterSh(shellPath(join(home, 'progress-inbox'))), embedded = shellQuote(powershellReporter(true))
  assert.equal(source.split(embedded).length, 2)
  writeFileSync(file, source.replace(embedded, () => shellQuote(observeClassifier(powershellReporter(true), diagnostic))))
  for (const mode of ['stdin', 'argument']) for (const prompt of ['/board', 'PRIVATE_REAL_ANSWER']) {
    const raw = JSON.stringify({ session_id: `synthetic-${mode}-${prompt === '/board'}`, cwd: '/synthetic/中文', prompt, transcript_path: 'PRIVATE_TRANSCRIPT' })
    rmSync(diagnostic, { force: true })
    const logged = existsSync(log) ? readFileSync(log, 'utf8').length : 0
    const result = spawnSync(sh, [shellPath(file), 'gemini', 'prompt', ...(mode === 'argument' ? [raw] : [])], { env, input: mode === 'stdin' ? raw : undefined, encoding: 'utf8', windowsHide: true })
    if (existsSync(log) && readFileSync(log, 'utf8').slice(logged).includes('REPORTER_TIMEOUT')) timedOut.add(`synthetic-${mode}-${prompt === '/board'}`)
    diagnostics.push(`${mode} ${prompt === '/board' ? 'board' : 'answer'}: ${classifierDiagnostic(diagnostic)}`)
    assert.equal(result.status, 0, result.stderr)
  }
  const saved = receipts(home)
  assert.equal(saved.length, 4, diagnostics.join('; '))
  for (const { body } of saved) {
    assert.ok(!/[^\x20-\x7e]/.test(body))
    const { cwd, ...receipt } = JSON.parse(body)
    // The POSIX sh timeout fallback leaves a non-ASCII folder out (#351), so only a run that logged
    // REPORTER_TIMEOUT may miss it; the classifier keeps it.
    assert.ok(cwd === '/synthetic/中文' || (cwd === undefined && timedOut.has(receipt.session_id)), body)
    assert.deepEqual(receipt, { session_id: receipt.session_id, ...(receipt.session_id.endsWith('true') ? { board_request: true } : {}) })
    assert.ok(!body.includes('PRIVATE_') && !body.includes('/board'))
  }
}))

test('the PowerShell reporter writes a prompt receipt with no prompt words', { skip: process.platform !== 'win32' }, () => fixture(async home => {
  const { reporterPs1 } = await import('../hooks/connect-pure.ts')
  const file = join(home, 'progress-report.ps1')
  const diagnostic = join(home, 'classifier-probe.txt')
  const diagnostics = []
  writeFileSync(file, observeClassifier(reporterPs1(), diagnostic))
  assert.ok(!reporterPs1().includes('[Console]::OutputEncoding'))
  for (const prompt of ['/board', '$agent-board', '/agent-board', 'PRIVATE_REAL_ANSWER']) {
    rmSync(diagnostic, { force: true })
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, 'codex', 'prompt'], { input: JSON.stringify({ session_id: 'synthetic-owner', cwd: '/synthetic/中文', prompt, transcript_path: 'PRIVATE_TRANSCRIPT' }), encoding: 'utf8', windowsHide: true })
    diagnostics.push(classifierDiagnostic(diagnostic))
    assert.equal(result.status, 0, result.stderr)
  }
  const saved = receipts(home)
  assert.equal(saved.length, 4, diagnostics.join('; '))
  const values = saved.map(one => JSON.parse(one.body))
  assert.equal(values.filter(one => one.board_request === true).length, 3, diagnostics.join('; '))
  assert.ok(values.every(one => one.cwd === '/synthetic/中文'))
  assert.ok(saved.every(one => !/[^\x20-\x7e]/.test(one.body)))
  assert.ok(saved.every(one => !one.body.includes('PRIVATE_') && !one.body.includes('/board') && !one.body.includes('$agent-board')))
}))

test('a reporter that cannot run node still writes the receipt and the board drops its words', () => fixture(async home => {
  const { reporterPs1, reporterSh, shellQuote } = await import('../hooks/connect-pure.ts')
  const { readTurn } = await import('../hooks/inbox.ts')
  const { HOOK_INPUT_TIMEOUT } = await import('../hooks/hook-safety.ts')
  const seen = new Set()
  const tools = join(home, 'tools')
  mkdirSync(tools)
  for (const name of ['mkdir', 'date', 'cat', 'mv', 'rm', 'find', 'uname', 'sleep', 'tail']) {
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
  if (powershell) {
    // MSYS delegates to the official Windows shell. Retain that dependency,
    // not its containing PATH entries, so Node is still genuinely missing.
    assert.ok(existsSync(powershell))
    const file = join(tools, 'powershell.exe')
    writeFileSync(file, `#!/bin/sh\nexec ${shellQuote(shellPath(powershell))} "$@"\n`)
    chmodSync(file, 0o755)
  }
  for (const prompt of ['/board', 'PRIVATE_REAL_ANSWER']) for (const mode of ['stdin', 'argument']) {
    const raw = JSON.stringify({ session_id: 'synthetic-fallback', cwd: '/synthetic/中文', prompt, transcript_path: 'PRIVATE_TRANSCRIPT' })
    // Keep diagnostics in this owned fixture, not a developer or CI profile.
    // PSModulePath remains inherited; this is isolation, not a timing repair.
    const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: shellPath(tools) }
    // Both hosts must retain a receipt when Node is missing, fails, or returns nothing.
    for (const failure of ['missing', 'failed', 'empty']) {
      const node = join(tools, 'node')
      if (failure === 'missing') {
        rmSync(node, { force: true }); rmSync(`${node}.cmd`, { force: true })
        const absent = spawnSync(sh, ['-c', 'command -v node'], { env, encoding: 'utf8', windowsHide: true })
        assert.equal(absent.error, undefined)
        assert.notEqual(absent.status, null)
        assert.notEqual(absent.status, 0, 'the fixture must not restore Node through the PowerShell dependency')
        assert.equal(absent.stdout, '')
      }
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
        const started = performance.now()
        const result = spawnSync(program, args, { env, input: mode === 'stdin' ? raw : undefined, encoding: 'utf8', windowsHide: true })
        const context = { program: program === sh ? 'sh' : 'powershell', mode, classifier: failure, isBoardCommand: prompt === '/board', elapsedMs: performance.now() - started, budgetMs: HOOK_INPUT_TIMEOUT, expectedReceipts: before + 1, actualReceipts: null }
        // Only failed assertions read the bounded fixture log, after return.
        assert.equal(result.status, 0, result.status === 0 ? undefined : promptReceiptDiagnostic(result, context, home))
        assert.equal(result.stderr === '', true, result.stderr === '' ? undefined : promptReceiptDiagnostic(result, context, home))
        const saved = receipts(home)
        context.actualReceipts = saved.length
        assertPromptReceiptCount(result, context, home)
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

test('legacy SDK reporters remove their partial temporary files and preserve foreign collisions', async () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'legacy-sdk-write-'))
  const original = { open: fs.openSync, close: fs.closeSync, write: fs.writeFileSync, now: Date.now }
  // Patch the mutable built-in object, then refresh the generated ESM imports.
  const mutable = createRequire(import.meta.url)('node:fs')
  try {
    for (const [agent, name, end] of [['opencode', 'opencodePlugin', '\nconst OPENCLAW_ID'], ['openclaw', 'openclawPlugin', '\n// The standalone board']]) {
      for (const collision of [false, true]) {
        const inbox = join(home, `${agent}-${collision}`), stamp = original.now()
        fs.mkdirSync(inbox)
        const temporary = join(inbox, `${agent}-prompt-${stamp}-${process.pid}.tmp`)
        if (collision) original.write(temporary, 'FOREIGN_BYTES')
        const file = join(home, `${agent}-${collision}.mjs`)
        original.write(file, template(name, end, true, { home, inbox }))
        const descriptors = new Set()
        let injected = 0
        const isInbox = path => typeof path === 'string' && path.startsWith(inbox + sep)
        mutable.openSync = (path, ...args) => { const fd = original.open(path, ...args); if (isInbox(path)) descriptors.add(fd); return fd }
        mutable.closeSync = fd => { try { return original.close(fd) } finally { descriptors.delete(fd) } }
        mutable.writeFileSync = (path, body, ...args) => {
          if (isInbox(path) || descriptors.has(path)) {
            original.write(path, 'PARTIAL', ...args)
            injected++
            throw Object.assign(Error('PRIVATE_SYNTHETIC_WRITE_FAILURE'), { code: 'ENOSPC' })
          }
          return original.write(path, body, ...args)
        }
        Date.now = () => stamp
        syncBuiltinESMExports()
        try {
          const plugin = await import(pathToFileURL(file).href)
          if (agent === 'opencode') {
            const hooks = await plugin.AgentBoard({ directory: '/synthetic-workspace', client: { session: { get: async ({ path }) => ({ data: { id: path.id } }) } } })
            await hooks['chat.message']({ sessionID: 'synthetic-owner' })
          } else {
            const hooks = new Map()
            plugin.default.register({ on: (event, callback) => hooks.set(event, callback) })
            await hooks.get('before_prompt_build')({}, { sessionId: 'synthetic-owner', inputProvenance: { kind: 'external_user' } })
          }
        } finally {
          mutable.openSync = original.open; mutable.closeSync = original.close; mutable.writeFileSync = original.write
          Date.now = original.now
          syncBuiltinESMExports()
        }
        assert.equal(descriptors.size, 0, 'owned file descriptors are closed')
        assert.equal(injected, collision ? 0 : 1, 'exercise a partial write or an actual exclusive-open collision')
        assert.deepEqual(fs.readdirSync(inbox), collision ? [temporary.slice(inbox.length + 1)] : [])
        if (collision) assert.equal(readFileSync(temporary, 'utf8'), 'FOREIGN_BYTES')
        const log = readFileSync(join(home, '.agent-board', 'hook-errors.log'), 'utf8')
        assert.match(log, /REPORTER_FAILED/)
        assert.ok(!log.includes('PRIVATE_') && !log.includes(home))
      }
    }
  } finally {
    mutable.openSync = original.open; mutable.closeSync = original.close; mutable.writeFileSync = original.write
    Date.now = original.now
    syncBuiltinESMExports()
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})

// The inbox caps (#373). The limits are written out here, not read from the code under test.
const { reporterPs1: capReporterPs1, reporterSh: capReporterSh } = await import('../hooks/connect-pure.ts')
const { inboxDropped, prunedSince } = await import('../hooks/retention.ts')
const CAP_POWERSHELL = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null
const CAP_DAY = 24 * 60 * 60 * 1000
const CAP_PAYLOAD = '{"session_id":"synthetic-cap"}'

test('the generated sh reporter uses no brace intervals on old mawk', () => {
  assert.doesNotMatch(capReporterSh('/synthetic/progress-inbox'), /[\])]{[0-9]/)
})

const seedFile = (inbox, name, bytes, ageMs) => {
  mkdirSync(inbox, { recursive: true })
  const file = join(inbox, name)
  writeFileSync(file, 'x'.repeat(bytes))
  const at = new Date(Date.now() - ageMs)
  utimesSync(file, at, at)
}

const capCommand = (kind, home) => {
  const script = join(home, kind === 'sh' ? 'progress-report.sh' : 'progress-report.ps1')
  writeFileSync(script, kind === 'sh' ? capReporterSh(shellPath(join(home, 'progress-inbox'))) : capReporterPs1())
  return kind === 'sh' ? [sh, [shellPath(script), 'codex', 'turn']] : [CAP_POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'codex', 'turn']]
}

const runCapReporter = (kind, home) => {
  const [program, args] = capCommand(kind, home)
  const result = spawnSync(program, args, { env: { ...process.env, HOME: home, USERPROFILE: home }, input: CAP_PAYLOAD, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
}

const droppedLog = inbox => readFileSync(join(inbox, 'dropped.log'), 'utf8')

const capOldestOfFiles = kind => fixture(async home => {
  const inbox = join(home, 'progress-inbox')
  // The oldest turn file is index 0. The taken and failed files are older than all of them and the
  // others newest, so a cap that counted or removed any of them would show.
  for (let i = 0; i < 1000; i += 1) seedFile(inbox, `codex-turn-${i}-1.json`, 20, (2000 - i) * 1000)
  seedFile(inbox, 'codex-turn-5000-1.json.failed', 20, 5000 * 1000)
  seedFile(inbox, 'codex-turn-5001-1.json.synthetic-session-1-1.taking', 20, 5000 * 1000)
  seedFile(inbox, 'codex-turn-5002-1.tmp', 20, 0)
  seedFile(inbox, 'codex-prompt-5003-1.receipt', 20, 0)
  // A .json file that is not a turn file is not counted either.
  seedFile(inbox, 'notes.json', 20, 0)
  runCapReporter(kind, home)
  const names = readdirSync(inbox)
  assert.equal(names.filter(name => name.endsWith('.json') && name !== 'notes.json').length, 1000)
  assert.ok(!names.includes('codex-turn-0-1.json'), 'the oldest turn file is removed')
  assert.ok(names.includes('codex-turn-1-1.json'), 'the next oldest stays')
  for (const kept of ['codex-turn-5000-1.json.failed', 'codex-turn-5001-1.json.synthetic-session-1-1.taking', 'codex-turn-5002-1.tmp', 'codex-prompt-5003-1.receipt', 'notes.json']) assert.ok(names.includes(kept), kept)
  assert.match(droppedLog(inbox), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ 1 cap\n$/)
  assert.deepEqual(inboxDropped(droppedLog(inbox), 0), { age: 0, cap: 1 })
})

const capOldestOfBytes = kind => fixture(async home => {
  const inbox = join(home, 'progress-inbox')
  for (let i = 0; i < 5; i += 1) seedFile(inbox, `codex-turn-${i}-1.json`, 400000, (2000 - i) * 1000)
  // Neither of these counts toward the 1572864 bytes: if they did, 3 files would have to go, not 2.
  seedFile(inbox, 'codex-turn-5001-1.json.synthetic-session-1-1.taking', 700000, 5000 * 1000)
  seedFile(inbox, 'codex-turn-5002-1.tmp', 300000, 0)
  runCapReporter(kind, home)
  const names = readdirSync(inbox)
  const turns = names.filter(name => name.endsWith('.json'))
  assert.equal(turns.length, 4, 'three of the five, and the one the reporter wrote')
  assert.ok(!names.includes('codex-turn-0-1.json') && !names.includes('codex-turn-1-1.json'), 'the two oldest go')
  assert.ok(names.includes('codex-turn-2-1.json'), 'the third stays')
  assert.ok(turns.reduce((sum, name) => sum + fs.statSync(join(inbox, name)).size, 0) <= 1572864)
  assert.ok(names.includes('codex-turn-5001-1.json.synthetic-session-1-1.taking') && names.includes('codex-turn-5002-1.tmp'))
  assert.match(droppedLog(inbox), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ 2 cap\n$/)
})

const capCountsAge = kind => fixture(async home => {
  const inbox = join(home, 'progress-inbox')
  for (let i = 0; i < 3; i += 1) seedFile(inbox, `codex-turn-${i}-1.json`, 20, 5 * CAP_DAY)
  seedFile(inbox, 'codex-turn-3-1.json', 20, CAP_DAY)
  seedFile(inbox, 'codex-turn-4-1.json.failed', 20, 5 * CAP_DAY)
  seedFile(inbox, 'codex-turn-5-1.json.synthetic-session-1-1.taking', 20, 5 * CAP_DAY)
  runCapReporter(kind, home)
  assert.deepEqual(readdirSync(inbox).filter(name => /^codex-turn-\d-1\.json/.test(name)).sort(), ['codex-turn-3-1.json', 'codex-turn-4-1.json.failed', 'codex-turn-5-1.json.synthetic-session-1-1.taking'])
  assert.match(droppedLog(inbox), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ 3 age\n$/)
})

const seedDropped = now => {
  const lines = []
  const sums = new Map()
  for (let back = 9; back >= 0; back -= 1) {
    const day = new Date(now - back * CAP_DAY).toISOString().slice(0, 10)
    for (const reason of ['age', 'cap']) {
      let sum = 0
      for (let i = 1; i <= 14; i += 1) {
        const count = i + back + (reason === 'cap' ? 100 : 0)
        lines.push(`${day}T12:34:56Z ${count} ${reason}${i % 2 === 0 ? '\r' : ''}\n`)
        sum += count
      }
      if (back <= 8) sums.set(`${day} ${reason}`, sum)
    }
  }
  lines.push('not a count\n', `${new Date(now).toISOString().slice(0, 10)}T12:34:56Z 99 other\n`)
  return { text: lines.join(''), sums }
}

const assertFolded = (inbox, seeded, now, reason) => {
  const today = new Date(now).toISOString().slice(0, 10)
  const sums = new Map(seeded.sums)
  sums.set(`${today} ${reason}`, sums.get(`${today} ${reason}`) + 1)
  const expected = [...sums].map(([key, sum]) => `${key.slice(0, 10)}T00:00:00Z ${sum} ${key.slice(11)}`)
  assert.deepEqual(droppedLog(inbox).trimEnd().split('\n'), expected)
  assert.deepEqual(readdirSync(inbox).filter(name => name.startsWith('dropped.log')), ['dropped.log'])
}

const capFoldsCounts = (kind, isPaneCount = false) => fixture(async home => {
  const now = Date.now()
  const inbox = join(home, 'progress-inbox')
  seedFile(inbox, 'codex-turn-0-1.json', 20, 5 * CAP_DAY)
  const seeded = seedDropped(now)
  writeFileSync(join(inbox, 'dropped.log'), seeded.text)
  runCapReporter(kind, home)
  if (isPaneCount) {
    const own = `${new Date(now).toISOString().slice(0, 19)}Z 1 age\n`
    assert.deepEqual(inboxDropped(droppedLog(inbox), prunedSince(now)), inboxDropped(seeded.text + own, prunedSince(now)))
  } else assertFolded(inbox, seeded, now, 'age')
})

const capKeepsNewTurn = kind => fixture(async home => {
  const inbox = join(home, 'progress-inbox')
  for (let i = 0; i < 1000; i += 1) seedFile(inbox, `codex-turn-${i}-1.json`, 20, -3600000 - i * 1000)
  runCapReporter(kind, home)
  const names = readdirSync(inbox).filter(name => name.endsWith('.json'))
  assert.equal(names.length, 1000)
  assert.ok(names.some(name => !/^codex-turn-\d+-1\.json$/.test(name)), 'the newly written turn stays')
  assert.ok(!names.includes('codex-turn-0-1.json'), 'the oldest seeded turn goes')
  assert.match(droppedLog(inbox), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ 1 cap\n$/)
})

const runCapAsync = ([program, args], home) => new Promise((resolve, reject) => {
  const child = spawn(program, args, { env: { ...process.env, HOME: home, USERPROFILE: home }, windowsHide: true })
  child.on('error', reject)
  child.on('close', resolve)
  child.stdin.end(CAP_PAYLOAD)
})

const capCountsOnce = kind => fixture(async home => {
  const inbox = join(home, 'progress-inbox')
  for (let i = 0; i < 6; i += 1) seedFile(inbox, `codex-turn-${i}-1.json`, 20, 5 * CAP_DAY)
  const command = capCommand(kind, home)
  const codes = await Promise.all([1, 2, 3, 4].map(() => runCapAsync(command, home)))
  assert.deepEqual(codes, [0, 0, 0, 0])
  assert.deepEqual(readdirSync(inbox).filter(name => /^codex-turn-\d-1\.json$/.test(name)), [])
  const lines = droppedLog(inbox).trimEnd().split('\n')
  assert.ok(lines.every(line => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \d+ age$/.test(line)), lines.join('|'))
  const dropped = inboxDropped(droppedLog(inbox), 0)
  assert.equal(dropped.cap, 0)
  // Where a second delete of a file already deleted fails, each file is counted once. Windows can let
  // two reporters that delete one file at the same moment both succeed, so there a count may be high, never low.
  if (process.platform === 'win32') assert.ok(dropped.age >= 6, String(dropped.age))
  else assert.equal(dropped.age, 6)
})

const isNotWindows = process.platform !== 'win32'
test('the sh reporter removes the oldest turn file once the inbox passes 1000 files and counts it', () => capOldestOfFiles('sh'))
test('the PowerShell reporter removes the oldest turn file once the inbox passes 1000 files and counts it', { skip: isNotWindows }, () => capOldestOfFiles('ps1'))
test('the sh reporter removes the oldest turn files until the inbox is under 1572864 bytes and counts them', () => capOldestOfBytes('sh'))
test('the PowerShell reporter removes the oldest turn files until the inbox is under 1572864 bytes and counts them', { skip: isNotWindows }, () => capOldestOfBytes('ps1'))
test('the sh reporter counts the turn files its 2-day cleanup removes and leaves taken and failed files', () => capCountsAge('sh'))
test('the PowerShell reporter counts the turn files its 2-day cleanup removes and leaves taken and failed files', { skip: isNotWindows }, () => capCountsAge('ps1'))
test('the sh reporter folds the count file by UTC day and reason and keeps sums through 8 days back', () => capFoldsCounts('sh'))
test('the PowerShell reporter folds the count file by UTC day and reason and keeps sums through 8 days back', { skip: isNotWindows }, () => capFoldsCounts('ps1'))
test("the pane's count after a sh reporter trim equals the true total", () => capFoldsCounts('sh', true))
test("the pane's count after a PowerShell reporter trim equals the true total", { skip: isNotWindows }, () => capFoldsCounts('ps1', true))
test('the sh reporter keeps its new turn when 1000 seeded turns are an hour ahead', () => capKeepsNewTurn('sh'))
test('the PowerShell reporter keeps its new turn when 1000 seeded turns are an hour ahead', { skip: isNotWindows }, () => capKeepsNewTurn('ps1'))
test('several sh reporters at once lose no count of the turn files they remove', () => capCountsOnce('sh'))
test('several PowerShell reporters at once lose no count of the turn files they remove', { skip: isNotWindows }, () => capCountsOnce('ps1'))

test('the generated OpenCode and OpenClaw plugins keep the inbox to 1000 files and 1572864 bytes and count what they remove', async () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'plugin-inbox-cap-'))
  try {
    for (const [agent, name, end] of [['opencode', 'opencodePlugin', '\nconst OPENCLAW_ID'], ['openclaw', 'openclawPlugin', '\n// The standalone board']]) {
      for (const scenario of ['files', 'bytes']) {
        const now = Date.now()
        const seeded = seedDropped(now)
        const inbox = join(home, `${agent}-${scenario}`)
        if (scenario === 'files') {
          for (let i = 0; i < 1000; i += 1) seedFile(inbox, `codex-turn-${i}-1.json`, 20, (2000 - i) * 1000)
          seedFile(inbox, 'codex-turn-5000-1.json.failed', 20, 5000 * 1000)
          seedFile(inbox, 'codex-turn-5001-1.json.synthetic-session-1-1.taking', 20, 5000 * 1000)
          seedFile(inbox, 'notes.json', 20, 0)
          writeFileSync(join(inbox, 'dropped.log'), seeded.text)
        } else {
          for (let i = 0; i < 5; i += 1) seedFile(inbox, `codex-turn-${i}-1.json`, 400000, (2000 - i) * 1000)
          seedFile(inbox, 'codex-turn-5001-1.json.synthetic-session-1-1.taking', 700000, 5000 * 1000)
          seedFile(inbox, 'notes.json', 300000, 0)
        }
        const file = join(home, `${agent}-${scenario}.mjs`)
        writeFileSync(file, template(name, end, true, { home, inbox }))
        const plugin = await import(pathToFileURL(file).href)
        if (agent === 'opencode') {
          const hooks = await plugin.AgentBoard({ directory: '/synthetic-workspace', client: { session: { get: async ({ path }) => ({ data: { id: path.id } }) } } })
          await hooks['chat.message']({ sessionID: 'synthetic-owner' })
        } else {
          const hooks = new Map()
          plugin.default.register({ on: (event, callback) => hooks.set(event, callback) })
          await hooks.get('before_prompt_build')({}, { sessionId: 'synthetic-owner', inputProvenance: { kind: 'external_user' } })
        }
        const names = readdirSync(inbox)
        const turns = names.filter(one => one.endsWith('.json') && one !== 'notes.json')
        assert.ok(names.includes('notes.json'), `${agent} ${scenario}: a .json file that is not a turn file stays`)
        assert.ok(turns.some(one => one.startsWith(`${agent}-prompt-`)), `${agent} ${scenario}: the plugin keeps the file it wrote`)
        assert.ok(names.some(one => one.endsWith('.taking')), `${agent} ${scenario}: a taken file stays`)
        assert.ok(!names.includes('codex-turn-0-1.json'), `${agent} ${scenario}: the oldest goes`)
        if (scenario === 'files') {
          assert.equal(turns.length, 1000)
          assert.ok(names.includes('codex-turn-1-1.json') && names.includes('codex-turn-5000-1.json.failed'))
          assertFolded(inbox, seeded, now, 'cap')
        } else {
          assert.equal(turns.length, 4)
          assert.ok(!names.includes('codex-turn-1-1.json') && names.includes('codex-turn-2-1.json'))
          assert.match(droppedLog(inbox), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ 2 cap\n$/)
        }
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})


const runCapPlugin = async (agent, home, inbox, suffix) => {
  const name = agent === 'opencode' ? 'opencodePlugin' : 'openclawPlugin'
  const end = agent === 'opencode' ? '\nconst OPENCLAW_ID' : '\n// The standalone board'
  const file = join(home, `${agent}-${suffix}.mjs`)
  writeFileSync(file, template(name, end, true, { home, inbox }))
  const plugin = await import(pathToFileURL(file).href)
  if (agent === 'opencode') {
    const hooks = await plugin.AgentBoard({ directory: '/synthetic-workspace', client: { session: { get: async ({ path }) => ({ data: { id: path.id } }) } } })
    await hooks['chat.message']({ sessionID: 'synthetic-owner' })
  } else {
    const hooks = new Map()
    plugin.default.register({ on: (event, callback) => hooks.set(event, callback) })
    await hooks.get('before_prompt_build')({}, { sessionId: 'synthetic-owner', inputProvenance: { kind: 'external_user' } })
  }
}

const capRecoversDropped = async kind => {
  for (const [name, ageMs, isRecovered] of [
    ['dropped.log.12345', 120000, true],
    ['dropped.log.12345', 10000, false],
    ['dropped.log.12345.678', 120000, false],
  ]) {
    await fixture(async home => {
      const inbox = join(home, 'progress-inbox')
      seedFile(inbox, 'codex-turn-0-1.json', 1600000, 2000)
      const copy = join(inbox, name)
      const stamp = new Date().toISOString().slice(0, 19) + 'Z'
      const text = `${stamp} 7 age\n${stamp} 11 cap\n`
      writeFileSync(copy, text)
      const mtime = new Date(Date.now() - ageMs)
      utimesSync(copy, mtime, mtime)
      if (kind === 'opencode') await runCapPlugin(kind, home, inbox, 'recover-dropped')
      else runCapReporter(kind, home)
      assert.equal(existsSync(copy), !isRecovered, `${kind}: ${name}, age ${ageMs}`)
      if (!isRecovered) assert.equal(readFileSync(copy, 'utf8'), text)
      assert.deepEqual(inboxDropped(droppedLog(inbox), prunedSince(Date.now())), isRecovered ? { age: 7, cap: 12 } : { age: 0, cap: 1 })
      assert.deepEqual(readdirSync(inbox).filter(one => one.startsWith('dropped.log.')), isRecovered ? [] : [name])
    })
  }
}

test('the sh reporter recovers an old unclaimed dropped-log copy and leaves fresh and claimed copies', () => capRecoversDropped('sh'))
test('the PowerShell reporter recovers an old unclaimed dropped-log copy and leaves fresh and claimed copies', { skip: isNotWindows }, () => capRecoversDropped('ps1'))
test('the OpenCode plugin recovers an old unclaimed dropped-log copy and leaves fresh and claimed copies', () => capRecoversDropped('opencode'))

for (const agent of ['opencode', 'openclaw']) {
  test(`the pane's count after an ${agent} plugin trim equals the true total`, () => fixture(async home => {
    const now = Date.now()
    const inbox = join(home, 'progress-inbox')
    for (let i = 0; i < 1000; i += 1) seedFile(inbox, `codex-turn-${i}-1.json`, 20, (2000 - i) * 1000)
    const seeded = seedDropped(now)
    writeFileSync(join(inbox, 'dropped.log'), seeded.text)
    await runCapPlugin(agent, home, inbox, 'pane-count')
    const own = `${new Date(now).toISOString().slice(0, 19)}Z 1 cap\n`
    assert.deepEqual(inboxDropped(droppedLog(inbox), prunedSince(now)), inboxDropped(seeded.text + own, prunedSince(now)))
  }))

  test(`the ${agent} plugin keeps its new turn when 1000 seeded turns are an hour ahead`, () => fixture(async home => {
    const inbox = join(home, 'progress-inbox')
    for (let i = 0; i < 1000; i += 1) seedFile(inbox, `codex-turn-${i}-1.json`, 20, -3600000 - i * 1000)
    await runCapPlugin(agent, home, inbox, 'future-turns')
    const names = readdirSync(inbox).filter(name => name.endsWith('.json'))
    assert.equal(names.length, 1000)
    assert.ok(names.some(name => name.startsWith(`${agent}-prompt-`)))
    assert.ok(!names.includes('codex-turn-0-1.json'))
    assert.match(droppedLog(inbox), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ 1 cap\n$/)
  }))
}
