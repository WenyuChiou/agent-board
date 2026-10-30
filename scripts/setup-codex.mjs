// The checked-in bundle makes bootstrap work with Node alone, without Bun or Claude Code.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = readFileSync(new URL('../hooks/board-script.ts', import.meta.url), 'utf8')
const code = JSON.parse(source.slice(source.indexOf('export const BOARD_SCRIPT = ') + 'export const BOARD_SCRIPT = '.length, source.lastIndexOf(']') + 1)).join('\n')
const dir = mkdtempSync(join(tmpdir(), 'agent-board-setup-'))
try {
  const script = join(dir, 'agent-board.mjs')
  writeFileSync(script, code)
  const result = spawnSync(process.execPath, [script, '--codex-setup', ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
