// Syntax is deliberately explicit: mixed digit/letter hex tokens (7+, 40 => hash),
// drive-rooted paths or /Users/ and /home/ (including bare roots), UUIDs or
// same-line session=/session: hex ids (8+ with a digit), including clipped UUIDs,
// JSON objects or opening keys, and lines over 300 Unicode code points. CSI escapes
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
  // Classify session spans first, so UUID pieces do not become commit ids.
  const sessions = []
  const session = (value, start) => {
    if (!sessions.some(one => one.start === start)) {
      sessions.push({ start, end: start + value.length })
      add('session-id', value, start)
    }
  }
  for (const match of text.matchAll(/\b[\da-f]{8}-(?:[\da-f]{4}-){3}(?:[\da-f]{12}\b|[\da-f]{0,11}(?:…|\.{3}))/gi)) session(match[0], match.index)
  for (const match of text.matchAll(/\bsession[ \t]*[=:][ \t]*([\da-f]{8,})(?![\w-])/gi)) {
    if (/\d/.test(match[1])) session(match[1], match.index + match[0].lastIndexOf(match[1]))
  }
  for (const match of text.matchAll(/\b[\da-f]{7,}\b/gi)) {
    if (sessions.some(one => match.index >= one.start && match.index < one.end)) continue
    if (match[0].length === 40 || (/\d/.test(match[0]) && /[a-f]/i.test(match[0]))) add(match[0].length === 40 ? 'hash' : 'commit-id', match[0], match.index)
  }
  for (const match of text.matchAll(/(?<![\w/\\:.~-])(?:[A-Z]:[\\/]|\/(?:Users|home)\/)[^\s<>"'`|]*/gi)) add('path', match[0], match.index)

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
      try {
        JSON.parse(value)
        const before = text.slice(text.lastIndexOf('\n', start - 1) + 1, start)
        const after = text.slice(index + 1).split('\n')[0]
        const isEmpty = /^\{\s*\}$/.test(value)
        const isStandalone = !before.trim() && !after.trim()
        const hasKey = /(?:"[^"\n]+"|[\w.-]+)[ \t]*:[ \t]*$/.test(before)
        if (!isEmpty || isStandalone || hasKey) objects.push({ start, end: index + 1, value })
      } catch {}
    }
  }
  objects.sort((a, b) => a.start - b.start)
  let end = -1
  for (const object of objects) if (object.start >= end) {
    add('raw-json', object.value, object.start)
    end = object.end
  }
  // A screen-width cut can remove the closing brace; the opening key still leaks.
  for (const match of text.matchAll(/\{\s*"[^"\n]*"\s*:/g)) {
    if (!objects.some(one => match.index >= one.start && match.index < one.end)) add('raw-json', match[0], match.index)
  }
  let offset = 0
  for (const line of text.split('\n')) {
    const value = line.replace(/\r$/, '')
    if ([...value].length > 300) add('long-line', value, offset)
    offset += line.length + 1
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
}
