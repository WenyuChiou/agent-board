import { progressTail } from '../hooks/parse.ts'
import type { ProgressTail } from '../types'

// Decode like the board, but locate the cut line in the original bytes. Counting newline
// boundaries also preserves malformed UTF-8 before the cut; re-encoding it would move offsets.
export const reporterProgressTail = (original: Buffer): ProgressTail | null => {
  const text = original.toString('utf8')
  const tail = progressTail(text)
  if (tail === null) return null
  const count = text.slice(0, tail.offset).split('\n').length - 1
  let offset = 0
  for (let line = 0; line < count; line += 1) offset = original.indexOf(10, offset) + 1

  return { ...tail, offset }
}

export const reporterTail = (original: Buffer): { bytes: Buffer; fragment: Buffer | null } => {
  const tail = reporterProgressTail(original)
  if (tail === null) return { bytes: original, fragment: null }
  const fragment = original.subarray(tail.offset)
  const lines = fragment.toString('utf8').split('\n')
  if (/\S/.test(lines.slice(1).join('\n'))) return { bytes: original, fragment: null }
  const eol = original.includes(Buffer.from('\r\n')) ? '\r\n' : '\n'
  const replacement = Buffer.from(tail.close === null ? '' : `<!-- /auto session=${tail.close} -->${eol}`)
  const bytes = Buffer.concat([original.subarray(0, tail.offset), replacement])
  if (reporterProgressTail(bytes) !== null) throw new Error('INCOMPLETE_PROGRESS_TAIL')

  return { bytes, fragment }
}
