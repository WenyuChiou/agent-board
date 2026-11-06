import { BOARD_SCRIPT } from './board-script'
import { boardScriptFor } from './connect-pure'
import { HOOK_VERSION } from './hook-safety'
import { LANGS } from './i18n'
export * from './connect-pure'

export const boardScript = (path: string, lang: string): string => boardScriptFor(path, lang, BOARD_SCRIPT)

// npm setup writes this same board with its own first line, which also names the Codex folder
// (#1047). The board runs only when its body is this release's and its first line is nothing but
// that JSON for this progress file; any other file is installed again before it runs.
export const isOwnBoard = (installed: string, path: string): boolean => {
  const prefix = 'globalThis.AGENT_BOARD = '
  const cut = installed.indexOf('\n')
  if (cut < 0 || !installed.startsWith(prefix) || installed.slice(cut + 1) !== BOARD_SCRIPT) return false
  const head = installed.slice(prefix.length, cut)
  try {
    const value: unknown = JSON.parse(head)
    if (typeof value !== 'object' || value === null || Array.isArray(value) || JSON.stringify(value) !== head) return false
    const { hookVersion, path: file, lang, codexRoot, ...rest } = value as Record<string, unknown>
    return Object.keys(rest).length === 0 && hookVersion === HOOK_VERSION && file === path && LANGS.some(one => one === lang) && (codexRoot === undefined || typeof codexRoot === 'string')
  } catch { return false }
}
