type TextWork = { splits: number; lineReads: number; countTries: number; countUnits: number; longestCount: number }

// Only the supplied text and its line arrays are observed. The plugin sandbox freezes built-in
// prototypes; these proxies leave them alone and keep every character and native string operation.
export const countedText = (source: string): { text: string; work: TextWork } => {
  const work = { splits: 0, lineReads: 0, countTries: 0, countUnits: 0, longestCount: 0 }
  const linesOf = (lines: string[]): string[] => new Proxy(lines, {
    get: (target, key, receiver) => {
      if (typeof key === 'string' && /^\d+$/.test(key)) work.lineReads += 1
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      if (key === 'findIndex') return (predicate: (line: string, index: number) => boolean): number => target.findIndex((line, index) => {
        work.lineReads += 1
        // A count candidate's length is checked before the regex coerces it to text. Counting that
        // coercion distinguishes a skipped long line from a line actually offered to the regex.
        const candidate = new Proxy(Object(line), {
          get: (item, field) => field === Symbol.toPrimitive ? () => {
            work.countTries += 1
            work.countUnits += line.length
            work.longestCount = Math.max(work.longestCount, line.length)
            return line
          } : Reflect.get(item, field),
        }) as string
        return predicate(candidate, index)
      })
      return (...args: unknown[]): unknown => {
        const result = Reflect.apply(value, receiver, args)
        return Array.isArray(result) ? linesOf(result) : result
      }
    },
  })
  const textOf = (text: string): string => new Proxy(Object(text), {
    get: (target, key) => {
      if (key === Symbol.toPrimitive) return () => text
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return (...args: unknown[]): unknown => {
        if (key === 'split') work.splits += 1
        const result = Reflect.apply(value, text, args)
        if (key === 'replace' && typeof result === 'string') return textOf(result)
        return Array.isArray(result) ? linesOf(result) : result
      }
    },
  }) as string
  return { text: textOf(source), work }
}
