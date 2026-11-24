import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { invokeChanging, terminal } from './helpers/setup-fixture.mjs'

// The rows of #1806's case table: terminal setup and Codex's hook approval when Codex's trust, the hooks or Codex itself
// change between the read before the question and the work after the yes. The stand-in Codex trusts the hooks while
// CODEX_HOME/synthetic-trust.json exists, and answers by CODEX_HOME/synthetic-codex-mode ('fail', 'exit').

const approvalPart = "Approve the board's hooks in Codex"
const held = "Codex: the board's hooks are still trusted."
const trustFile = f => join(f.env.CODEX_HOME, 'synthetic-trust.json')
const modeFile = f => join(f.env.CODEX_HOME, 'synthetic-codex-mode')
const hooksFile = f => join(f.env.CODEX_HOME, 'hooks.json')
const configFile = f => join(f.env.CODEX_HOME, 'config.toml')
const script = f => join(f.root, 'data', 'agent-board.mjs')
const callsFile = f => join(f.root, 'program-calls.jsonl')
const snapshotFile = f => join(f.root, 'calls-before-answer.jsonl')
const listOf = stdout => stdout.split('This will:')[1]?.split('Set these up? [Y/n]')[0] ?? ''
const afterOf = stdout => stdout.split('Set these up? [Y/n]')[1] ?? ''
const nextOf = stdout => stdout.split('Next steps:')[1] ?? ''
const writes = f => f.commands.calls().filter(call => call.method === 'config/batchWrite')
const snapshot = f => existsSync(snapshotFile(f)) ? readFileSync(snapshotFile(f), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
// Node code run as setup reads the answer: keep the calls Codex had by then.
const keepCalls = f => `fs.existsSync(${JSON.stringify(callsFile(f))}) ? fs.copyFileSync(${JSON.stringify(callsFile(f))}, ${JSON.stringify(snapshotFile(f))}) : fs.writeFileSync(${JSON.stringify(snapshotFile(f))}, '')`
const revoke = f => `fs.rmSync(${JSON.stringify(trustFile(f))}, { force: true })`
const grant = f => `fs.writeFileSync(${JSON.stringify(trustFile(f))}, '{}')`
const setMode = (f, mode) => `fs.writeFileSync(${JSON.stringify(modeFile(f))}, ${JSON.stringify(mode)})`
const clearMode = f => `fs.rmSync(${JSON.stringify(modeFile(f))}, { force: true })`

// Codex set up by an earlier setup, trusted or not; `repair` removes the board script, so setup has a file to write
// back and leaves hooks.json as it is.
const installed = (f, { isTrusted, repair = true } = {}) => {
  delete f.env.AGENT_BOARD_SETUP_TTY
  const result = f.invoke(['--agent', 'codex', '--lang', 'en', '--apply'])
  f.env.AGENT_BOARD_SETUP_TTY = '1'
  assert.equal(result.status, 0, result.stderr)
  if (isTrusted) writeFileSync(trustFile(f), '{}')
  if (repair) rmSync(script(f))
  f.commands.clear()
}
const config = f => existsSync(configFile(f)) ? readFileSync(configFile(f), 'utf8') : null

test('terminal setup repairing a Codex that trusts the board hooks lists no approval, writes none, and says they are still trusted (#1806)', () => terminal(f => {
  installed(f, { isTrusted: true })
  const before = config(f)
  const result = invokeChanging(f, ['--agent', 'codex', '--lang', 'en'], keepCalls(f))
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!listOf(result.stdout).includes(approvalPart), `no approval on the list\n${result.stdout}`)
  const after = afterOf(result.stdout)
  assert.match(after, /Codex files: done\./, result.stdout)
  assert.ok(after.includes(held), `the read after the yes says the trust held\n${result.stdout}`)
  assert.equal(writes(f).length, 0, 'no approval written')
  assert.equal(config(f), before, 'config.toml as before')
}, ['codex']))

test('terminal setup names the Codex trust step and approves nothing when the trust it read is revoked before the yes (#1806)', () => terminal(f => {
  installed(f, { isTrusted: true })
  const before = config(f)
  const result = invokeChanging(f, ['--agent', 'codex', '--lang', 'en'], revoke(f))
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!listOf(result.stdout).includes(approvalPart), result.stdout)
  const after = afterOf(result.stdout)
  assert.match(after, /Codex files: done\./, result.stdout)
  assert.ok(!after.includes(held) && !after.includes(`${approvalPart}:`), `no trust claimed and no approval part\n${result.stdout}`)
  assert.match(nextOf(result.stdout), /Codex: the board's hooks for .* are not trusted\. Approve them: .*--codex-trust/, result.stdout)
  assert.equal(writes(f).length, 0, 'no approval written')
  assert.equal(config(f), before, 'config.toml as before')
}, ['codex']))

test('terminal setup that listed the Codex approval writes none and says the hooks are trusted when they are approved before the yes (#1806)', () => terminal(f => {
  installed(f, { isTrusted: false })
  const result = invokeChanging(f, ['--agent', 'codex', '--lang', 'en'], grant(f))
  assert.equal(result.status, 0, result.stderr)
  assert.ok(listOf(result.stdout).includes(approvalPart), `the approval is listed\n${result.stdout}`)
  const after = afterOf(result.stdout)
  assert.ok(after.includes(held), result.stdout)
  assert.ok(!after.includes(`${approvalPart}: done.`) && !after.includes('failed'), result.stdout)
  assert.equal(writes(f).length, 0, 'nothing left to approve')
}, ['codex']))

test('terminal setup asks Codex again after its applies when hooks.json is rewritten while it waits, with the approval listed or not (#1806)', () => {
  // Another setup empties the board's hooks from hooks.json while the question waits; in the first run Codex also stops
  // trusting them.
  const rewrite = f => `fs.writeFileSync(${JSON.stringify(hooksFile(f))}, '{"hooks":{}}\\n')`
  const sevenHooks = f => Object.keys(JSON.parse(readFileSync(hooksFile(f), 'utf8')).hooks).length === 7
  terminal(f => {
    installed(f, { isTrusted: true })
    const result = invokeChanging(f, ['--agent', 'codex', '--lang', 'en'], `${rewrite(f)}; ${revoke(f)}`)
    assert.ok(!listOf(result.stdout).includes(approvalPart), result.stdout)
    const after = afterOf(result.stdout)
    assert.ok(/Codex files: done\./.test(after) ? sevenHooks(f) : /Codex files: failed\. Run: /.test(after), `the apply wrote the hooks back or says it failed\n${result.stdout}`)
    assert.ok(!after.includes(held), `the earlier read no longer counts\n${result.stdout}`)
    if (/Codex files: done\./.test(after)) assert.match(nextOf(result.stdout), /--codex-trust/, result.stdout)
    assert.equal(writes(f).length, 0, 'no approval written for the person')
  }, ['codex'])
  terminal(f => {
    installed(f, { isTrusted: false })
    const result = invokeChanging(f, ['--agent', 'codex', '--lang', 'en'], rewrite(f))
    assert.ok(listOf(result.stdout).includes(approvalPart), result.stdout)
    const after = afterOf(result.stdout)
    if (/Codex files: done\./.test(after)) {
      assert.ok(sevenHooks(f), result.stdout)
      assert.equal(writes(f).length, 1, result.stdout)
      assert.equal(Object.keys(writes(f)[0].params.edits[0].value).length, 7)
      assert.ok(after.indexOf(`${approvalPart}: done.`) > after.indexOf('Codex files: done.'), result.stdout)
    } else {
      assert.match(after, new RegExp(`${approvalPart}: failed\\. Run: `), result.stdout)
      assert.equal(writes(f).length, 0)
    }
  }, ['codex'])
})

test('terminal setup that rewrites hooks.json lists the Codex approval, gives it when Codex does not trust the rewritten hooks, and says they are still trusted when it does (#1806)', () => {
  for (const isTrusted of [false, true]) terminal(f => {
    installed(f, { isTrusted, repair: false })
    writeFileSync(hooksFile(f), '{"hooks":{}}\n')
    const result = invokeChanging(f, ['--agent', 'codex', '--lang', 'en'], keepCalls(f))
    assert.equal(result.status, 0, result.stderr)
    assert.ok(listOf(result.stdout).includes(approvalPart), result.stdout)
    const after = afterOf(result.stdout)
    if (isTrusted) {
      assert.equal(writes(f).length, 0, result.stdout)
      assert.ok(after.includes(held) && !after.includes(`${approvalPart}: done.`), result.stdout)
    } else {
      assert.equal(writes(f).length, 1, result.stdout)
      assert.equal(Object.keys(writes(f)[0].params.edits[0].value).length, 7)
      assert.ok(after.includes(`${approvalPart}: done.`), result.stdout)
    }
  }, ['codex'])
})

test('terminal setup lists the Codex approval when Codex gives no answer before the question, and reports it by what Codex says after the yes (#1806)', () => {
  for (const mode of ['fail', 'exit']) terminal(f => {
    installed(f, { isTrusted: true })
    writeFileSync(modeFile(f), mode)
    // Codex answers again by the yes, and trusts the hooks.
    const result = invokeChanging(f, ['--agent', 'codex', '--lang', 'en'], clearMode(f))
    assert.ok(listOf(result.stdout).includes(approvalPart), `no answer is never read as trusted\n${result.stdout}`)
    const after = afterOf(result.stdout)
    assert.ok(after.includes(held) && !after.includes(`${approvalPart}: done.`), result.stdout)
    assert.equal(writes(f).length, 0)
  }, ['codex'])
  terminal(f => {
    installed(f, { isTrusted: true })
    writeFileSync(modeFile(f), 'exit')
    const before = config(f)
    const result = invokeChanging(f, ['--agent', 'codex', '--lang', 'en'], keepCalls(f))
    assert.ok(listOf(result.stdout).includes(approvalPart), result.stdout)
    const after = afterOf(result.stdout)
    assert.match(after, /Codex files: done\./, result.stdout)
    assert.match(after, new RegExp(`${approvalPart}: failed\\. Run: .*--codex-trust --apply --codex-bin `), result.stdout)
    assert.ok(!after.includes(`${approvalPart}: done.`) && !after.includes(held), result.stdout)
    assert.equal(config(f), before)
  }, ['codex'])
})

test('terminal setup claims no Codex approval when Codex stops answering after the yes, with the approval listed or not (#1806)', () => {
  terminal(f => {
    installed(f, { isTrusted: true })
    const before = config(f)
    const result = invokeChanging(f, ['--agent', 'codex', '--lang', 'en'], setMode(f, 'exit'))
    assert.equal(result.status, 0, result.stderr)
    assert.ok(!listOf(result.stdout).includes(approvalPart), result.stdout)
    const after = afterOf(result.stdout)
    assert.match(after, /Codex files: done\./, result.stdout)
    assert.ok(!after.includes(held) && !after.includes(`${approvalPart}:`), result.stdout)
    assert.match(nextOf(result.stdout), /--codex-trust/, result.stdout)
    assert.equal(config(f), before)
  }, ['codex'])
  terminal(f => {
    installed(f, { isTrusted: false })
    const before = config(f)
    const result = invokeChanging(f, ['--agent', 'codex', '--lang', 'en'], setMode(f, 'exit'))
    assert.ok(listOf(result.stdout).includes(approvalPart), result.stdout)
    const after = afterOf(result.stdout)
    assert.match(after, /Codex files: done\./, result.stdout)
    assert.match(after, new RegExp(`${approvalPart}: failed\\. Run: `), result.stdout)
    assert.equal(config(f), before)
  }, ['codex'])
})

test('terminal setup answered no writes nothing and keeps the Codex trust step only where Codex does not trust the hooks (#1806)', () => {
  for (const isTrusted of [true, false]) terminal(f => {
    installed(f, { isTrusted })
    const result = invokeChanging(f, ['--agent', 'codex', '--lang', 'en'], keepCalls(f), f.invoke, 'n\n')
    assert.equal(existsSync(script(f)), false, 'no file written')
    assert.equal(writes(f).length, 0, 'no approval written')
    const next = nextOf(result.stdout)
    assert.match(next, /--apply/, result.stdout)
    if (isTrusted) assert.doesNotMatch(next, /--codex-trust/, `no trust step while Codex trusts the hooks\n${result.stdout}`)
    else assert.match(next, /--codex-trust/, result.stdout)
  }, ['codex'])
})

test('terminal setup that also sets up a new agent starts no Codex from PATH before the yes, lists the Codex approval, and gives it only when Codex does not trust the hooks (#1806)', () => {
  for (const isTrusted of [true, false]) terminal(f => {
    installed(f, { isTrusted })
    const result = invokeChanging(f, ['--agent', 'codex,cursor', '--lang', 'en'], keepCalls(f))
    assert.equal(snapshot(f).filter(call => call.program === 'codex').length, 0, `no Codex started before the answer\n${result.stdout}`)
    assert.ok(listOf(result.stdout).includes(approvalPart), result.stdout)
    const after = afterOf(result.stdout)
    if (isTrusted) {
      assert.equal(writes(f).length, 0, result.stdout)
      assert.ok(after.includes(held) && !after.includes(`${approvalPart}: done.`), result.stdout)
    } else {
      assert.equal(writes(f).length, 1, result.stdout)
      assert.equal(Object.keys(writes(f)[0].params.edits[0].value).length, 7)
      assert.ok(after.includes(`${approvalPart}: done.`), result.stdout)
    }
  }, ['codex'])
})
