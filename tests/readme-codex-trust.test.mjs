import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const sourceRoots = ['../hooks/', '../scripts/'].map(path => new URL(path, import.meta.url).href)
const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (sourceRoots.some(root => context.parentURL?.startsWith(root)) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
let codexDoctorOutput, STRINGS
try {
  ;[{ codexDoctorOutput }, { STRINGS }] = await Promise.all([import('../scripts/codex-local.ts'), import('../hooks/strings.ts')])
} finally {
  loader.deregister()
}

const copies = [
  { file: 'README.md', lang: 'en', row: 'An agent is not on the board', consent: 'if you approve' },
  { file: 'README.zh-TW.md', lang: 'zh-TW', row: '某個 agent 沒出現在看板上', consent: '確認同意後' },
  { file: 'README.zh-CN.md', lang: 'zh-CN', row: '某个 agent 没出现在看板上', consent: '确认同意后' },
]
const preview = 'npx @wenyuchiou/agent-board --codex-trust --codex-bin "<path-to-codex>" --json'
const result = {
  agent: 'codex', progress: '/synthetic-board/progress.md', changes: [], conflicts: [], alreadyGone: [],
  installed: true, reportHook: 'installed', hooksTrusted: false, capabilities: { lifecycle: 'native-hooks' },
}

test('the README troubleshooting names the Codex trust preview beside /hooks in all three languages', () => {
  for (const { file, row, consent } of copies) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    const line = text.split('\n').find(line => line.startsWith(`| ${row} |`))
    assert.ok(line, `${file}: troubleshooting row exists`)
    assert.ok(line.includes(`\`${preview}\``), `${file}: the row supplies a complete JSON preview command`)
    assert.ok(line.includes('`/hooks`'), `${file}: the CLI alternative remains beside the command`)
    assert.ok(line.includes(consent) && line.includes('`--apply`'), `${file}: applying requires an explicit decision after preview`)
    assert.ok(!preview.includes('--apply'), 'the displayed preview does not apply trust')
  }
})

test("the doctor's output for untrusted hooks contains the trust command with the supplied Codex path", () => {
  const command = 'node "/synthetic board/agent-board.mjs" --codex-trust --codex-bin "/synthetic bin/codex"'
  const before = structuredClone(result)
  for (const { lang } of copies) {
    const s = STRINGS[lang]
    const output = codexDoctorOutput(result, s, 'synthetic-setup --preview', command)
    assert.ok(output.includes(s.localSummary.untrusted), `${lang}: untrusted state is visible`)
    assert.ok(output.includes(s.localSummary.trustRun(command)), `${lang}: the detected path survives in the runnable preview`)
    assert.ok(!output.includes('--apply'), `${lang}: the doctor does not apply trust`)
    const trusted = codexDoctorOutput({ ...result, hooksTrusted: true }, s, 'synthetic-setup --preview', command)
    assert.ok(trusted.includes(s.localSummary.trusted), `${lang}: trusted state stays visible`)
    assert.ok(!trusted.includes(command), `${lang}: already trusted hooks need no new trust step`)
  }
  assert.deepEqual(result, before, 'formatting the doctor output does not change its input')
})
