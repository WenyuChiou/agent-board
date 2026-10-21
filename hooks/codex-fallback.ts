// Marker edits preserve every byte outside one unambiguous managed section.
const marker = /<!-- (agent-board|claude-progress-pane):(start|end) -->/g
const commandLine = /^node --input-type=commonjs -e "const p=String\.fromCodePoint\([\d,]+\);process\.argv\.splice\(1,0,p\);process\.argv\.push\('--codex-report','--agent','codex','--progress-file',String\.fromCodePoint\([\d,]+\)\);import\(require\('node:url'\)\.pathToFileURL\(p\)\.href\)"$/
// The start and end of the one managed section; undefined when there is none, null when ambiguous.
const managedMarks = (text: string): [RegExpMatchArray, RegExpMatchArray] | null | undefined => {
  const marks = [...text.matchAll(marker)]
  if ((text.match(/<!--\s*(?:agent-board|claude-progress-pane)\s*:\s*(?:start|end)\b/gi) ?? []).length !== marks.length) return null
  if (marks.length === 0) return undefined
  const first = marks[0]!, last = marks[1]
  if (marks.length !== 2 || first[2] !== 'start' || last?.[2] !== 'end' || first[1] !== last[1]) return null
  return [first, last]
}
export const managedFallback = (text: string, content: string | null): string | null => {
  const marks = managedMarks(text)
  if (marks === null) return null
  if (marks === undefined) return content === null ? text : text + (text === '' || text.endsWith('\n') ? '' : '\n') + '<!-- agent-board:start -->\n' + content + '\n<!-- agent-board:end -->\n'
  const [first, last] = marks
  if (content !== null) {
    const command = content.split(/\r?\n/).find(line => commandLine.test(line))
    if (command === undefined) return text
    const start = first.index! + first[0].length
    // Blocks have no ownership hashes. Refresh only generated command lines so
    // personal instructions and the section's original line endings survive.
    const section = text.slice(start, last.index).replace(/[^\r\n]+/g, line => commandLine.test(line) ? command : line)
    return text.slice(0, start) + section + text.slice(last.index)
  }
  return text.slice(0, first.index) + text.slice(last.index! + last[0].length)
}

// The generated command lines a reconnect refreshes, so a status check never warns
// about a hand-edited line or text outside the section that reconnecting leaves alone.
export const managedCommandLines = (text: string): string[] => {
  const marks = managedMarks(text)
  if (!marks) return []
  return (text.slice(marks[0].index! + marks[0][0].length, marks[1].index).match(/[^\r\n]+/g) ?? []).filter(line => commandLine.test(line))
}

// Numeric literals keep board/progress paths out of shell interpolation on both hosts.
export const codexFallbackCommand = (board: string, progress: string): string => {
  const points = (value: string): string => Array.from(value, one => one.codePointAt(0)).join(',')
  return `node --input-type=commonjs -e "const p=String.fromCodePoint(${points(board)});process.argv.splice(1,0,p);process.argv.push('--codex-report','--agent','codex','--progress-file',String.fromCodePoint(${points(progress)}));import(require('node:url').pathToFileURL(p).href)"`
}
