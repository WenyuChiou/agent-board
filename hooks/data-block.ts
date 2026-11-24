import { type Strings, ZH_TW } from './i18n.ts'

// Text from progress.md, which any program can write, made fit to show Claude as data: one
// line, no backtick to close the fence it sits in, no comment or marker opening, at most
// `limit` characters.
export const asData = (text: string, limit = 120): string => {
  const line = text
    .replace(/`/g, "'")
    .replace(/<!--|-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...line]

  return chars.length <= limit ? line : `${chars.slice(0, limit - 1).join('')}…`
}

// Lines of file text for Claude, inside a fence and after a sentence saying they are data,
// not instructions; each line should already have been through asData.
export const dataBlock = (lines: readonly string[], s: Strings = ZH_TW): string[] =>
  lines.length === 0 ? [] : [s.dataNote, '```text', ...lines, '```']
