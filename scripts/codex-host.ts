import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

type Json = Record<string, unknown>
type Hook = { key: string; currentHash: string; sourcePath: string; eventName: string; command: string; enabled: boolean; trustStatus: string }
export type CodexHookIdentity = { event: string; command: string }
export type CodexTrustObservation = { source: string; sourceHash: string; trusted: boolean; hooks: { event: string; key: string; hash: string; trust: string }[] }

// npm installs on Windows put only shims on PATH; run the package's own native
// binary directly and never a .cmd through a shell.
export const findCodexExecutable = (pathValue: string, platform: string, arch: string): string | undefined => {
  for (const entry of pathValue.split(platform === 'win32' ? ';' : ':')) {
    // Windows allows a PATH entry in quotes.
    const directory = platform === 'win32' ? entry.replace(/^"(.*)"$/, '$1') : entry
    if (!isAbsolute(directory)) continue
    try {
      const file = realpathSync(join(directory, platform === 'win32' ? 'codex.exe' : 'codex'))
      const stat = statSync(file)
      if (stat.isFile() && (platform === 'win32' ? /\.exe$/i.test(file) : (stat.mode & 0o111) !== 0)) return file
    } catch {}
    if (platform !== 'win32') continue
    try {
      const fd = openSync(join(directory, 'codex.cmd'), 'r')
      let text: string
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.size > 64 * 1024) continue
        const buffer = Buffer.alloc(64 * 1024)
        text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8')
      } finally { closeSync(fd) }
      // npm probes for a sibling node.exe before its one package launcher target.
      const launcher = text.replace(/^\s*IF EXIST "%dp0%\\node\.exe" \(\s*$/gim, '')
      const targets = [...launcher.matchAll(/"%dp0%\\([^"\r\n]*)"/gi)]
      if (targets.length !== 1 || !/^node_modules\\@openai\\codex\\bin\\codex\.js$/i.test(targets[0]![1]!)) continue
      const root = realpathSync(join(directory, 'node_modules', '@openai', 'codex'))
      if ((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Json).name !== '@openai/codex') continue
      const inside = (file: string): string | undefined => {
        const real = realpathSync(file), path = relative(root, real)
        return path !== '' && !path.startsWith('..') && !isAbsolute(path) && statSync(real).isFile() ? real : undefined
      }
      if (inside(join(root, 'bin', 'codex.js')) === undefined) continue
      const triple = arch === 'x64' ? 'x86_64-pc-windows-msvc' : arch === 'arm64' ? 'aarch64-pc-windows-msvc' : undefined
      if (triple === undefined) continue
      for (const base of [join(root, 'node_modules', '@openai', `codex-win32-${arch}`), root]) {
        try {
          const file = inside(join(base, 'vendor', triple, 'bin', 'codex.exe'))
          if (file !== undefined) return file
        } catch {}
      }
    } catch {}
  }
  return undefined
}

// Our hooks as Codex lists them. Not listed, or turned off in /hooks, is a no.
const ownedHooks = (response: Json, config: string, expected: readonly CodexHookIdentity[]): Hook[] => {
  const data = response.data
  if (!Array.isArray(data) || data.length === 0 || data.some(entry => entry === null || typeof entry !== 'object' || !Array.isArray(entry.hooks) || !Array.isArray(entry.errors) || entry.errors.length > 0)) throw new Error('HOOK_DISCOVERY_FAILED')
  const hooks = data.flatMap(entry => entry.hooks as unknown[]).filter((value): value is Hook => {
    if (value === null || typeof value !== 'object') return false
    const hook = value as Partial<Hook>
    return typeof hook.sourcePath === 'string' && resolve(hook.sourcePath) === resolve(config) && expected.some(one => one.event === hook.eventName && one.command === hook.command)
  })
  if (hooks.length !== expected.length || expected.some(one => hooks.filter(hook => hook.eventName === one.event && hook.command === one.command).length !== 1)) throw new Error('OWNED_HOOKS_NOT_FOUND')
  if (hooks.some(hook => hook.enabled === false)) throw new Error('HOOK_DISABLED')
  return hooks
}

// A shape this code does not know (a new hash format, a missing key, an enabled flag that is
// not a boolean) says nothing about approval.
const shapeProblem = (hooks: Hook[], count: number): string | undefined => {
  if (hooks.some(hook => typeof hook.key !== 'string' || hook.key === '')) return 'HOOK_FORMAT_UNSUPPORTED'
  if (new Set(hooks.map(hook => hook.key)).size !== count) return 'OWNED_HOOKS_NOT_FOUND'
  if (hooks.some(hook => hook.enabled !== true || !/^sha256:[a-f0-9]{64}$/.test(hook.currentHash) || typeof hook.trustStatus !== 'string')) return 'HOOK_FORMAT_UNSUPPORTED'
  return undefined
}

const matchingHooks = (response: Json, config: string, expected: readonly CodexHookIdentity[]): Hook[] => {
  const hooks = ownedHooks(response, config, expected)
  const problem = shapeProblem(hooks, expected.length)
  if (problem !== undefined) throw new Error(problem)
  return hooks
}

// On Windows, killing codex.exe leaves the processes it started running; taskkill /T ends the
// tree. Only a child that has not exited: its pid could already belong to someone else.
const killTree = (child: ChildProcess): void => {
  if (process.platform === 'win32' && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    try {
      spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill()).on('exit', code => { if (code !== 0) child.kill() })
      return
    } catch {}
  }
  child.kill()
}

// A control-only app-server process: no thread/read, resume, model call or transcript access.
// A deadline is on the performance.now() clock, which a change of the wall clock cannot move.
const client = (executable: string, timeoutMs = 5000, deadline?: number, initializeMs = timeoutMs) => {
  if (!isAbsolute(executable)) throw new Error('ABSOLUTE_CODEX_BINARY_REQUIRED')
  const child = /\.m?js$/i.test(executable) ? spawn(process.execPath, [executable, 'app-server', '--stdio'], { windowsHide: true }) : spawn(executable, ['app-server', '--stdio'], { windowsHide: true })
  let next = 0, buffer = ''
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const fail = (): void => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CODEX_CONTROL_UNAVAILABLE')) }
    pending.clear()
  }
  child.on('error', fail); child.on('exit', fail)
  child.stderr.on('data', () => undefined)
  child.stdin.on('error', fail)
  child.stdout.on('data', chunk => {
    buffer += String(chunk)
    if (buffer.length > 2 * 1024 * 1024) { fail(); child.kill(); return }
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      let value: { id?: number; result?: Json; error?: unknown }
      try { value = JSON.parse(line) as typeof value } catch { continue }
      const item = value.id === undefined ? undefined : pending.get(value.id)
      if (!item) continue
      pending.delete(value.id!); clearTimeout(item.timer)
      if (value.error) item.reject(new Error('CODEX_CONTROL_REJECTED'))
      else item.resolve(value.result ?? {})
    }
  })
  const request = (method: string, params: Json, limitMs = timeoutMs): Promise<Json> => new Promise((done, reject) => {
    const remaining = deadline === undefined ? limitMs : Math.min(limitMs, deadline - performance.now())
    if (remaining <= 0) { reject(new Error('CODEX_CONTROL_TIMEOUT')); return }
    const id = ++next
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CODEX_CONTROL_TIMEOUT')) }, remaining)
    pending.set(id, { resolve: done, reject, timer })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
  return {
    request,
    initialize: async () => {
      await request('initialize', { clientInfo: { name: 'agent-board-hook-trust', version: '1' }, capabilities: { experimentalApi: true } }, initializeMs)
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
    },
    // A grandchild holding the pipes must not keep the connect worker alive after it answered.
    close: () => { killTree(child); fail(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy() },
  }
}

// A read-only observation for legacy three-event hooks as well as independent
// installations. Only Codex can report its current hashes/trust; never reproduce
// its hash algorithm or infer approval from a written hooks.json. The caller must
// recheck sourceHash before retiring its managed fallback instructions.
export const inspectCodexHooks = async (executable: string, config: string, expected: readonly CodexHookIdentity[], timeoutMs = 5000, deadline?: number, initializeMs = timeoutMs): Promise<CodexTrustObservation> => {
  if (expected.length === 0 || expected.length > 16 || expected.some(one => !/^[a-z][A-Za-z]+$/.test(one.event) || typeof one.command !== 'string' || one.command.trim() === '') || new Set(expected.map(one => JSON.stringify(one))).size !== expected.length) throw new Error('OWNED_HOOK_IDENTITIES_REQUIRED')
  const before = readFileSync(config)
  if ([timeoutMs, initializeMs].some(limit => !Number.isSafeInteger(limit) || limit < 1 || limit > 5000)) throw new Error('INVALID_CONTROL_TIMEOUT')
  const control = client(executable, timeoutMs, deadline, initializeMs)
  try {
    await control.initialize()
    const owned = ownedHooks(await control.request('hooks/list', { cwds: [process.cwd()] }), config, expected)
    const problem = shapeProblem(owned, expected.length)
    // Codex calling one of our hooks anything but trusted is a no even in a shape this code does
    // not know: a new hash format untrusts the hooks without touching config.toml. A wrong no
    // costs a double report, not a lost one.
    const isNo = owned.some(hook => typeof hook.trustStatus === 'string' && hook.trustStatus !== 'trusted')
    if (problem !== undefined && !isNo) throw new Error(problem)
    if (!before.equals(readFileSync(config))) throw new Error('HOOK_DEFINITION_CHANGED')
    const hooks = problem === undefined ? owned : []
    return { source: resolve(config), sourceHash: createHash('sha256').update(before).digest('hex'), trusted: !isNo, hooks: hooks.map(hook => ({ event: hook.eventName, key: hook.key, hash: hook.currentHash, trust: hook.trustStatus })) }
  } finally { control.close() }
}

export const trustCodex = async (executable: string, config: string, groups: Record<string, unknown>, apply: boolean) => {
  const before = readFileSync(config, 'utf8')
  const expected = Object.entries(groups).map(([event, group]) => ({ event: event[0]!.toLowerCase() + event.slice(1), command: (group as { hooks: { command: string }[] }).hooks[0]!.command }))
  if (expected.length !== 6) throw new Error('SIX_OWNED_HOOKS_REQUIRED')
  const control = client(executable)
  try {
    await control.initialize()
    const list = async (): Promise<Hook[]> => {
      const response = await control.request('hooks/list', { cwds: [process.cwd()] })
      return matchingHooks(response, config, expected)
    }
    const hooks = await list()
    const values = Object.fromEntries(hooks.map(hook => [hook.key, { trusted_hash: hook.currentHash }]))
    // Hook state is a user preference even when the definitions are project-local.
    // Codex ignores project-level trust state, so never write it next to that source.
    const plan = { file: join(resolve(process.env.CODEX_HOME || join(homedir(), '.codex')), 'config.toml'), hooks: hooks.map(hook => ({ event: hook.eventName, key: hook.key, hash: hook.currentHash, trust: hook.trustStatus })), changes: hooks.filter(hook => hook.trustStatus !== 'trusted').length }
    if (!apply || plan.changes === 0) return { ...plan, applied: false }
    if (readFileSync(config, 'utf8') !== before || JSON.stringify((await list()).map(hook => [hook.key, hook.currentHash])) !== JSON.stringify(hooks.map(hook => [hook.key, hook.currentHash]))) throw new Error('HOOK_DEFINITION_CHANGED')
    // Codex performs the TOML merge. Only the reviewed declarations receive trust;
    // enabled flags, foreign hooks, comments and unrelated settings stay under its editor.
    await control.request('config/batchWrite', { filePath: plan.file, edits: [{ keyPath: 'hooks.state', value: values, mergeStrategy: 'upsert' }], reloadUserConfig: true })
    const checked = await list()
    if (checked.some(hook => hook.trustStatus !== 'trusted')) throw new Error('TRUST_NOT_CONFIRMED')
    return { ...plan, applied: true, trusted: checked.length }
  } finally { control.close() }
}
