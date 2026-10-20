import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runProcess } from './surfaces.mjs'
import { readFileSync, utimesSync } from 'node:fs'
import { join, resolve } from 'node:path'

const visibleLines = source => {
  let isFenced = false
  let isComment = false
  const visible = []
  for (const match of source.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0].replace(/\r?\n$/, '')
    if (/^\s*(```|~~~)/.test(line) && !isComment) {
      isFenced = !isFenced
      continue
    }
    if (isFenced) continue
    if (!isComment && /^<!--\s*(?:auto\s|\/auto\b).*-->\s*$/.test(line)) {
      visible.push({ text: line, start: match.index, end: match.index + line.length })
      continue
    }
    let rest = line
    if (isComment) {
      const end = rest.indexOf('-->')
      if (end < 0) continue
      rest = rest.slice(end + 3)
      isComment = false
    }
    rest = rest.replace(/<!--[\s\S]*?-->/g, '')
    const open = rest.indexOf('<!--')
    if (open >= 0) {
      rest = rest.slice(0, open)
      isComment = true
    }
    if (rest === line) visible.push({ text: line, start: match.index, end: match.index + line.length })
  }
  return visible
}

export const block = (world, {
  project = 'api-gateway', agent = 'codex', session = 'a1000001', state = 'working',
  updated = new Date(world.now).toISOString(), title = 'Prepare the gateway',
  steps = ['- [~] Check the routes'], resume, dir,
} = {}) => {
  assert.match(session, /^[a-f0-9]{8}$/)
  const source = world.exists('progress.md') ? world.read('progress.md') : ''
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const marker = `<!-- auto session=${session} agent=${agent} state=${state} updated=${updated}${resume ? ` resume=${resume}` : ''}${dir ? ` dir=${encodeURIComponent(dir)}` : ''} -->`
  const replacement = [marker, `### ${title}`, '> Context: Synthetic journey scenario', ...steps, `<!-- /auto session=${session} -->`].join(eol)
  const lines = visibleLines(source)
  const starts = lines.filter(line => new RegExp(`^<!-- auto session=${session} `).test(line.text))
  assert.ok(starts.length <= 1, `Duplicate visible block: ${session}`)
  let result
  if (starts.length) {
    const start = starts[0]
    const end = lines.find(line => line.start > start.start && /^<!--\s*(?:auto\s|\/auto\b)|^##\s/.test(line.text))
    assert.equal(end?.text, `<!-- /auto session=${session} -->`, 'Refuse to cross another block or project')
    result = source.slice(0, start.start) + replacement + source.slice(end.end)
  }
  else {
    const heading = lines.find(line => line.text === `## ${project}`)
    if (heading) {
      const start = heading.end
      const next = lines.find(line => line.start > start && /^## /.test(line.text))
      const end = next ? next.start : source.length
      result = source.slice(0, end) + (source.slice(0, end).endsWith('\n') ? '' : eol) + replacement + eol + source.slice(end)
    } else result = source + (source && !source.endsWith('\n') ? eol : '') + `## ${project}${eol}${replacement}${eol}`
  }
  world.write('progress.md', result)
  return session
}

// Field names: hooks/inbox.ts readTurn; native metadata variants: tests/codex-local.test.mjs.
// Legacy notify payloads (Codex/Gemini/Cursor/Grok/Hermes/OpenCode/OpenClaw/Muse) are
// exercised by tests/logic.test.ts and tests/board.test.mjs, not real host transcripts.
const shapes = {
  codex: (id, cwd, text) => ({ 'thread-id': id, cwd, 'last-assistant-message': text }),
  gemini: (id, cwd, text) => ({ session_id: id, cwd, prompt_response: text }),
  antigravity: (id, cwd, text) => ({ conversationId: id, cwd, last_assistant_message: text }),
  cursor: (id, cwd, text) => ({ conversation_id: id, workspace_roots: [cwd], last_assistant_message: text }),
  grok: (id, cwd, text) => ({ sessionId: id, workspaceRoot: cwd, hookEventName: 'Stop', lastAssistantMessage: text }),
  hermes: (id, cwd, text) => ({ session_id: id, extra: { cwd, response: text } }),
  openclaw: (id, cwd, text) => ({ session_id: id, cwd, last_assistant_message: text }),
  opencode: (id, cwd, text) => ({ sessionID: id, directory: cwd, text }),
  muse: (id, cwd, text) => ({ session_id: id, cwd, response: text }),
  deepseek: (id, cwd, text) => ({ session_id: id, cwd, last_assistant_message: text }),
}

export const turn = (world, host, payload = {}, { at = world.now } = {}) => {
  assert.ok(shapes[host], `Unsupported turn host: ${host}`)
  const { session = `${host}-synthetic-session`, project = 'api-gateway', text = 'Checked the synthetic routes.', ...extra } = payload
  world.turnSequence = (world.turnSequence ?? 0) + 1
  const file = world.write(`progress-inbox/${host}-turn-${Math.floor(at / 1000)}-${world.turnSequence}.json`, JSON.stringify({ ...shapes[host](session, join(world.root, project), text), ...extra }))
  utimesSync(file, new Date(at), new Date(at))
  return file
}

export const hookHosts = ['codex', 'grok', 'antigravity']
export const hook = async (world, host, event, payload = {}) => {
  assert.ok(hookHosts.includes(host), `No tested native shell executor for ${host}`)
  const run = (file, args, input, extra = {}) => runProcess(file, args, { env: world.env, cwd: world.root, input, ...extra })
  const installed = world.hookInstalled ??= new Set()
  if (!installed.has(host)) {
    const result = await run(process.execPath, [resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'scripts/setup-codex.mjs'), '--home', world.home, '--agent', host, '--progress-file', world.path, '--apply'])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    installed.add(host)
  }
  const config = host === 'codex' ? join(world.env.CODEX_HOME, 'hooks.json') : host === 'grok' ? join(world.env.GROK_HOME, 'hooks', 'agent-board-local.json') : join(world.home, '.gemini', 'config', 'hooks.json')
  const saved = JSON.parse(readFileSync(config, 'utf8'))
  const events = host === 'antigravity' ? saved['agent-board-local'] : saved.hooks
  const entry = events[event]?.[0]
  const command = entry?.command ?? entry?.hooks?.[0]?.command
  assert.ok(command, `No generated ${host} hook for ${event}`)
  const id = payload.session_id ?? payload.conversationId ?? `${host}-journey-session`
  if (host === 'codex') world.env.CODEX_THREAD_ID = id
  const input = JSON.stringify({ session_id: id, conversationId: id, hook_event_name: event, turn_id: 'journey-turn', ...payload })
  const isWindows = process.platform === 'win32'
  // These are the platform-shell contracts in codex-local.test.mjs, including
  // Antigravity's distinct cmd /c executor.
  const args = isWindows ? host === 'antigravity' ? ['/c', command] : ['/d', '/s', '/c', `"${command}"`] : ['-c', command]
  return run(isWindows ? world.env.ComSpec || 'cmd.exe' : '/bin/sh', args, input, { windowsVerbatimArguments: isWindows && host !== 'antigravity' })
}
