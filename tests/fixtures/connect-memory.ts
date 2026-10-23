import { connectLegacy } from '../../scripts/legacy-connect'
import { CODEX_NOT_FOUND } from '../../scripts/codex-approval'
import type { ConnectState, ConnectTransaction, LegacyConnectRequest } from '../../scripts/connect-transaction'
import { setupSeed, withoutSection } from '../../hooks/connect'
import { sha256 } from '../../hooks/sha256'

type Flags = { unreadable?: Set<string>; unwritable?: Set<string>; unremovable?: Set<string>; retainedOnRemove?: Set<string>; rejectedOnRemove?: Set<string>; unlistable?: Set<string>; isRemoveRefused?: (path: string) => boolean; reads?: string[] }
const normalized = (path: string): string => path.replace(/^[a-zA-Z]:[\\/]/, '/').replace(/\\/g, '/')

// UI fixtures model only the worker boundary. Native process/lock/journal behavior
// is exercised separately by legacy-connect.test.mjs with real temporary files.
export const memoryConnect = (files: Map<string, string>, dirs: Set<string> | undefined, request: LegacyConnectRequest, bundle: string, flags: Flags): { state: ConnectState; result: ReturnType<typeof connectLegacy> | null } => {
  const control = normalized(request.home).replace(/\/$/, '') + '/.agent-board/legacy-connect.json'
  const existing = files.get(control)
  const authority = control.replace('legacy-connect.json', 'legacy-connect-authority')
  if (files.has(authority) && existing === undefined) throw new Error('MISSING_CONNECT_STATE')
  const state: ConnectState = existing === undefined ? { version: 1, revision: 0, disabled: request.seed?.disabled === true, owned: { ...request.seed?.owned }, notified: request.seed?.notified ?? [], ...(request.seed?.boardLang === undefined ? {} : { boardLang: request.seed.boardLang }) } : JSON.parse(existing) as ConnectState
  if (existing === undefined) state.setup = setupSeed(request.seed?.setup)
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || typeof state.disabled !== 'boolean' || state.owned === null || typeof state.owned !== 'object') throw new Error('INVALID_CONNECT_STATE')
  const save = (): void => { files.set(control, JSON.stringify(state)); files.set(authority, '1\n') }
  const exists = (file: string): boolean => {
    const path = normalized(file)
    return files.has(path) || dirs?.has(path) === true || [...files.keys()].some(key => key.startsWith(path + '/'))
  }
  const read = (file: string): string => {
    const path = normalized(file)
    flags.reads?.push(path)
    if (flags.unreadable?.has(path)) throw new Error('EFBIG')
    return files.get(path) ?? ''
  }
  const change = (file: string, text: string | null, generated = false): void => {
    const path = normalized(file)
    if (text === null) {
      if (flags.unremovable?.has(path) || flags.isRemoveRefused?.(path) || flags.retainedOnRemove?.has(path)) throw new Error('EACCES')
      files.delete(path)
      delete state.owned[file]
    } else {
      if (flags.unwritable?.has(path)) throw new Error('EACCES')
      files.set(path, text)
      if (generated) state.owned[file] = sha256(text)
    }
    save()
  }
  const transaction = {
    state, exists, read,
    maybe: (file: string): string | null => { try { return read(file) } catch { return null } },
    previous: (file: string): string | undefined => { const text = read(file); return sha256(text) === state.owned[file] ? text : undefined },
    change,
    own: (file: string, text: string): void => { if (read(file) !== text) throw new Error('INSTALL_CHANGED'); state.owned[file] = sha256(text); save() },
    tidy: (file: string): boolean => {
      const path = normalized(file)
      if (flags.rejectedOnRemove?.has(path) || flags.unlistable?.has(path)) return false
      if ([...files.keys()].some(key => key.startsWith(path + '/'))) return true
      if (flags.unremovable?.has(path) || flags.retainedOnRemove?.has(path)) return false
      dirs?.delete(path)
      return true
    },
    dropSection: (agent: string, home: string, codex: string, opencode: string, sep: string): void => {
      const targets: Record<string, string[]> = { codex: [[codex, 'AGENTS.md'].join(sep), [codex, 'AGENTS.override.md'].join(sep)], gemini: [[home, '.gemini', 'GEMINI.md'].join(sep)], opencode: [[opencode, 'AGENTS.md'].join(sep)] }
      for (const file of targets[agent] ?? []) { const before = read(file); const after = withoutSection(before); if (before !== after) change(file, after) }
    },
  } as unknown as ConnectTransaction
  save()
  if (request.mode === 'status') return { state, result: null }
  if (request.mode === 'ack') {
    if (request.acknowledgement?.revision === state.revision) state.notified = request.acknowledgement.keys.filter(key => state.setup?.problems.some(problem => problem.key === key))
    save()
    return { state, result: null }
  }
  if (request.mode === 'language') { state.boardLang = request.boardLang; state.revision += 1; save(); return { state, result: null } }
  if (request.mode === 'auto' && state.disabled) return { state, result: null }
  state.disabled = request.mode === 'remove' ? true : request.mode === 'connect' ? false : state.disabled
  if (request.boardLang !== undefined) state.boardLang = request.boardLang
  save()
  const isWin = /^[a-zA-Z]:[\\/]/.test(request.home)
  // No Codex here: none found, and nothing for a 0.23 approval to have missed.
  const result = connectLegacy(transaction, request, bundle, isWin, undefined, CODEX_NOT_FOUND)
  state.revision += 1
  save()
  return { state, result }
}
