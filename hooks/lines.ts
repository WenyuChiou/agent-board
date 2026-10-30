// The same lines as `text.split(/\r?\n/)`, without the regular expression: on a 600 KB line that
// split took most of a pane refresh (#569). A `\r` goes only where a `\n` follows it, as there.
export const splitLines = (text: string): string[] => {
  const lines = text.split('\n')
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]
    if (line?.endsWith('\r')) lines[index] = line.slice(0, -1)
  }
  return lines
}
