// Syntax is deliberately explicit: standalone hex tokens (7+, exactly 40 => hash),
// drive-rooted paths or /Users/ and /home/ (including bare roots), UUIDs or
// nonempty same-line session=/session: tokens (no resume-id length constraint),
// valid JSON object fragments, and lines over 300 Unicode code points. CSI escapes
// are ignored. Locations are 1-based in the resulting plain text, using code points.
export const neverShown = drawn => {
  const text = drawn.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const findings = []
  const add = (kind, value, offset) => {
    const before = text.slice(0, offset)
    const line = before.split('\n').length
    const column = [...before.slice(before.lastIndexOf('\n') + 1)].length + 1
    findings.push({ kind, line, column, value })
  }
  for (const match of text.matchAll(/\b[\da-f]{7,}\b/gi)) add(match[0].length === 40 ? 'hash' : 'commit-id', match[0], match.index)
  for (const match of text.matchAll(/(?<![\w/\\:.~-])(?:[A-Z]:[\\/]|\/(?:Users|home)\/)[^\s<>"'`|]*/gi)) add('path', match[0], match.index)
  for (const match of text.matchAll(/\b[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\b/gi)) add('session-id', match[0], match.index)
  for (const match of text.matchAll(/\bsession[ \t]*[=:][ \t]*(\S+)/gi)) {
    const offset = match.index + match[0].lastIndexOf(match[1])
    if (!findings.some(one => one.kind === 'session-id' && one.value === match[1] && one.line === text.slice(0, offset).split('\n').length)) add('session-id', match[1], offset)
  }

  // Balance braces outside strings so nested objects, quoted braces and multiline
  // turns work, while ordinary prose such as {choose one} is not called JSON.
  const stack = []
  const objects = []
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      // A literal newline cannot belong to a valid JSON string. A broken log
      // line must not hide a later, otherwise valid JSON turn.
      if (char === '\n' || char === '\r') {
        stack.length = 0
        quoted = false
        escaped = false
      } else if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"' && stack.length > 0) quoted = true
    else if (char === '{') stack.push(index)
    else if (char === '}' && stack.length > 0) {
      const start = stack.pop()
      const value = text.slice(start, index + 1)
      try { JSON.parse(value); objects.push({ start, end: index + 1, value }) } catch {}
    }
  }
  objects.sort((a, b) => a.start - b.start)
  let end = -1
  for (const object of objects) if (object.start >= end) {
    add('raw-json', object.value, object.start)
    end = object.end
  }
  let offset = 0
  for (const line of text.split('\n')) {
    const value = line.replace(/\r$/, '')
    if ([...value].length > 300) add('long-line', value, offset)
    offset += line.length + 1
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
}
