// Reads the board script out of the text of a hooks/board-script.ts, as a release tag holds it.
// Tags up to 0.24.0 hold it as one JSON string on one line; later ones as one JSON string per
// bundle line inside an array, so that pull requests changing different code merge (#573).
// JSON allows the CR of a CRLF line ending between array entries, so either ending reads the same.
const marker = 'export const BOARD_SCRIPT = '

export const bundleCode = source => {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error('hooks/board-script.ts has an unsupported format')
  const encoded = source.slice(start + marker.length)
  const value = encoded.startsWith('[') ? JSON.parse(encoded.slice(0, encoded.lastIndexOf(']') + 1)) : JSON.parse(encoded)
  const code = Array.isArray(value) && value.every(line => typeof line === 'string') ? value.join('\n') : value
  if (typeof code !== 'string') throw new Error('hooks/board-script.ts has an unsupported format')
  return code
}
