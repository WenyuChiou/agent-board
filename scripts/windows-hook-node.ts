import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'

// Bind an absolute executable: cmd's PATH and working-directory lookup can differ
// from a setup probe. An existing Windows short path may avoid executable quotes.
// `earlier` holds the commands setup wrote last time: a program among them that is still this
// file is kept without a probe, so a slow probe cannot change the command and its hook hash (#625).
export const windowsHookNode = (executable: string, earlier: string[] = []): string | undefined => {
  if (process.platform !== 'win32') return undefined
  if (/^[A-Za-z]:[\\/][A-Za-z0-9_.~\\/-]+\.exe$/i.test(executable)) return executable
  if (!/^[A-Za-z]:[\\/][A-Za-z0-9_.~\\/ -]+\.exe$/i.test(executable)) return undefined
  for (const command of earlier) {
    const kept = command.split(' ')[0] ?? ''
    if (isSameFile(executable, kept)) return kept
    // A program setup wrote last time that is still there runs the same hook, so it is kept
    // even when this run's Node is a copy in another folder: rewriting the command would drop
    // the approval the host bound to it (#1662).
    if (isExistingFile(kept)) return kept
  }
  try {
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', 'for %I in ("%AGENT_BOARD_NODE_EXECUTABLE%") do @echo %~sI'], {
      env: { ...process.env, AGENT_BOARD_NODE_EXECUTABLE: executable }, windowsVerbatimArguments: true,
      encoding: 'utf8', windowsHide: true, timeout: 1500, maxBuffer: 4096,
    })
    if (result.error || result.status !== 0) return undefined
    const candidate = result.stdout.trim()
    if (isSameFile(executable, candidate)) return candidate
  } catch {}
  return undefined
}

// A path setup wrote that still names a file, whatever Node this run started from.
const isExistingFile = (candidate: string): boolean => {
  if (!/^[A-Za-z]:[\\/][A-Za-z0-9_.~\\/-]+\.exe$/i.test(candidate)) return false
  try { return statSync(candidate).isFile() } catch { return false }
}

// realpath on Windows can preserve an 8.3 alias. Nonzero file identities
// verify the alias without assuming its spelling expands to the long path.
const isSameFile = (executable: string, candidate: string): boolean => {
  if (!/^[A-Za-z]:[\\/][A-Za-z0-9_.~\\/-]+\.exe$/i.test(candidate)) return false
  try {
    const expected = statSync(executable, { bigint: true })
    const actual = statSync(candidate, { bigint: true })
    return actual.isFile() && expected.isFile() && actual.ino > 0n && actual.dev === expected.dev && actual.ino === expected.ino
  } catch { return false }
}
