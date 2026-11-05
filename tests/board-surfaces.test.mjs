import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chat } from './e2e/lib/surfaces.mjs'
import { ISOLATED_VARIABLES } from './e2e/lib/spawn.mjs'

test('the journey chat reader runs the retained chat surface', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-board-e2e-chat-reader-'))
  try {
    const script = join(root, 'probe.mjs')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const env = { ...process.env, ...Object.fromEntries(ISOLATED_VARIABLES.map(name => [name, join(root, name)])) }
    const result = await chat({ script, root, env })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), ['--chat'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
