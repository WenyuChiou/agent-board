import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'

// Bind an absolute executable: cmd's PATH and working-directory lookup can differ
// from a setup probe. An existing Windows short path may avoid executable quotes.
// `earlier` holds the commands setup wrote last time: a program among them that is still this
// file is kept without a probe, so a slow probe cannot change the command and its hook hash (#625).
// An encoded launch of this same Node stays encoded (undefined), so its bytes do not change either (#1662).
export const windowsHookNode = (executable: string, earlier: string[] = []): string | undefined => {
  if (process.platform !== 'win32') return undefined
  for (const command of earlier) {
    if (encodedProgram(command) === executable) return undefined
    const kept = command.split(' ')[0] ?? ''
    if (isSameFile(executable, kept)) return kept
  }
  if (/^[A-Za-z]:[\\/][A-Za-z0-9_.~\\/-]+\.exe$/i.test(executable)) return executable
  if (!/^[A-Za-z]:[\\/][A-Za-z0-9_.~\\/ -]+\.exe$/i.test(executable)) return undefined
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

// The Node a hook command setup wrote runs, as setup spelled it: the first word inside an encoded
// PowerShell launch, the Node a quote-free command passes on as its first argument (its program
// word may be the 8.3 name), a quoted first word, or an unquoted one (hooks/local-agents.ts).
export const hookProgram = (command: string): string => encodedProgram(command) ?? quoteFreeProgram(command) ?? /^"([^"]+)"/.exec(command)?.[1] ?? command.split(' ')[0] ?? ''

// antigravityCommand writes `process.argv=JSON.parse("[...]")` first inside its base64 source.
const quoteFreeProgram = (command: string): string | undefined => {
  const encoded = /^\S+ --input-type=commonjs -e eval\(Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)\.toString\('utf8'\)\)$/.exec(command)?.[1]
  if (encoded === undefined) return undefined
  const literal = /^process\.argv=JSON\.parse\(("(?:[^"\\]|\\.)*")\);/.exec(Buffer.from(encoded, 'base64').toString('utf8'))?.[1]
  try {
    const args: unknown = JSON.parse(JSON.parse(literal ?? ''))
    return Array.isArray(args) && typeof args[0] === 'string' ? args[0] : undefined
  } catch { return undefined }
}

// encodedLaunch writes `& 'program' ...` in UTF-16LE base64, doubling each single quote it holds.
const encodedProgram = (command: string): string | undefined => {
  const encoded = /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command)?.[1]
  if (encoded === undefined) return undefined
  const source = Buffer.from(encoded, 'base64').toString('utf16le')
  if (!source.startsWith("& '")) return undefined
  let program = ''
  for (let at = 3; at < source.length; at++) {
    const char = source[at] ?? ''
    if (!/['‘’‚‛]/.test(char)) { program += char; continue }
    if (source[at + 1] !== char) return program
    program += char
    at++
  }
  return undefined
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
