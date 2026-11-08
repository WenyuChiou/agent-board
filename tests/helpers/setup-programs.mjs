import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

export const setupPrograms = (root, env, programs = ['codex', 'hermes', 'claude']) => {
  const bin = join(root, 'synthetic bin')
  const calls = join(root, 'program-calls.jsonl')
  mkdirSync(bin, { recursive: true })
  const record = `
const fs = require('node:fs')
const path = require('node:path')
const record = value => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(value) + '\\n')
`
  for (const program of programs) {
    let text = `${record}\nrecord({ program: ${JSON.stringify(program)}, args: process.argv.slice(2) })\n`
    if (program === 'codex') text += `
const hooksFile = path.join(process.env.CODEX_HOME, 'hooks.json')
const trustedFile = path.join(process.env.CODEX_HOME, 'synthetic-trust.json')
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  record({ program: 'codex', method: message.method, params: message.params })
  if (!message.id) return
  if (process.env.AGENT_BOARD_TEST_CODEX_FAIL) {
    process.stdout.write(JSON.stringify({ id: message.id, error: { code: -1, message: 'synthetic failure' } }) + '\\n')
    return
  }
  let result = {}
  if (message.method === 'hooks/list') {
    const hooks = Object.entries(JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks).map(([event, groups], i) => ({
      sourcePath: hooksFile, eventName: event[0].toLowerCase() + event.slice(1),
      command: groups[0].hooks[0].command, key: 'synthetic-' + i,
      enabled: true, currentHash: 'sha256:' + 'a'.repeat(64),
      trustStatus: fs.existsSync(trustedFile) ? 'trusted' : 'untrusted',
    }))
    result = { data: [{ hooks, errors: [] }] }
  }
  if (message.method === 'config/batchWrite') {
    fs.writeFileSync(trustedFile, JSON.stringify(message.params))
    fs.writeFileSync(message.params.filePath, '# synthetic Codex trust\\n' + Object.entries(message.params.edits[0].value).map(([key, value]) => '[hooks.state.' + key + ']\\ntrusted_hash = ' + JSON.stringify(value.trusted_hash)).join('\\n') + '\\n')
  }
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n')
})
`
    if (program === 'claude') text += `
const argv = process.argv.slice(2)
const failure = process.env.AGENT_BOARD_TEST_CLAUDE_FAIL
if (failure === 'all' || failure === argv[1]) process.exit(17)
// 'silent' stands for an install that exits 0 but leaves no plugin behind.
if (argv[1] === 'install' && failure !== 'silent') {
  const directory = path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'agent-board@agent-board': [{ scope: 'user' }] } }))
}
`
    if (process.platform === 'win32') {
      const script = program === 'codex' ? join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : join(bin, `${program}.cjs`)
      mkdirSync(dirname(script), { recursive: true })
      writeFileSync(script, text)
      if (program === 'codex') writeFileSync(join(dirname(dirname(script)), 'package.json'), '{"name":"@openai/codex"}')
      const target = program === 'codex' ? '%dp0%/node_modules/@openai/codex/bin/codex.js' : `%dp0%/${program}.cjs`
      writeFileSync(join(bin, `${program}.cmd`), `@echo off\r\nset "dp0=%~dp0"\r\n"${process.execPath}" "${target}" %*\r\n`)
    } else writeFileSync(join(bin, program), `#!${process.execPath}\n${text}`, { mode: 0o755 })
  }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = [bin, dirname(process.execPath), ...(process.platform === 'win32' ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'] : ['/usr/bin', '/bin'])].join(delimiter)
  return {
    calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [],
    clear: () => writeFileSync(calls, ''),
  }
}
