import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupPrograms } from './setup-programs.mjs'

export const runPrinted = (command, f, removed = ['CODEX_HOME']) => {
  const env = { ...f.env }
  for (const name of removed) delete env[name]
  return process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    : spawnSync(command, { shell: true, env, encoding: 'utf8', timeout: 30_000 })
}

export const syntheticCodex = (f, custom) => {
  const commands = setupPrograms(f.root, f.env, ['codex'])
  const bin = join(f.root, 'synthetic bin', process.platform === 'win32' ? 'codex.cmd' : 'codex')
  const script = process.platform === 'win32' ? join(f.root, 'synthetic bin', 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : bin
  // The synthetic host knows its profile; the board must obtain that profile from the printed argv.
  writeFileSync(script, readFileSync(script, 'utf8').replaceAll('process.env.CODEX_HOME', JSON.stringify(custom)))
  return { commands, bin }
}

export const commandIn = (said, template) => {
  const [before, after] = template.split('{command}')
  const line = said.split(/\r?\n/).find(one => one.includes(before)) ?? ''
  const rest = line.slice(line.indexOf(before) + before.length)
  return after ? rest.slice(0, rest.lastIndexOf(after)) : rest
}
