import assert from 'node:assert/strict'

// Reads the one-use link a command printed (#1650). Pure: no I/O.
//
// The link is read by subtraction, one stream at a time, never by searching a joined blob:
// - it is the tail of the last non-empty stdout line, and nothing may follow it;
// - that tail is a whole one-use link (the server's own rule: a 16 to 128 character code);
// - the whole line is the product's wording for that link, in one of the given languages;
// - each stream holds the link the expected number of times, and what is left after taking the
//   link out holds no other address, no query token and none of the page tokens given.
const LINK = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/open\/([A-Za-z0-9_-]{16,128})$/
const EXPECTED = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/open\/([A-Za-z0-9_-]+)$/
const LEFT = /\/open\/|127\.0\.0\.1|localhost|\[::1\]|[?&#](?:t|k)=/i

const holdsNothingElse = (name, text, rest, secrets) => {
  assert.doesNotMatch(rest, LEFT, `${name} holds no other address or token: ${text}`)
  for (const secret of secrets) assert.equal(text.includes(secret), false, `${name} holds no page token: ${text}`)
}

export const readPrintedLink = ({ stdout, stderr }, { wordings, expected, copies = { stdout: 1, stderr: 0 }, secrets = [] }) => {
  assert.ok(Array.isArray(wordings) && wordings.length > 0, 'the address-line wordings are given')
  const last = stdout.split(/\r?\n/).filter(line => line !== '').at(-1) ?? ''
  const at = last.lastIndexOf('http://')
  assert.ok(at >= 0, `the last line of stdout ends with the link: ${stdout}`)
  const link = last.slice(at)
  const found = expected === undefined ? LINK.exec(link) : link === expected ? EXPECTED.exec(link) : null
  assert.ok(found && Number(found[1]) <= 65535, `the whole printed address is a one-use link: ${last}`)
  assert.ok(wordings.some(word => last === word(link)), `the last line is the address line: ${last}`)
  for (const [name, text] of [['stdout', stdout], ['stderr', stderr]]) {
    const pieces = text.split(link)
    assert.equal(pieces.length - 1, copies[name], `${name} holds the link ${copies[name]} time(s): ${text}`)
    holdsNothingElse(name, text, pieces.join('\n'), secrets)
  }
  return { link, port: Number(found[1]), code: found[2] }
}

// A command that failed prints no address and no page token on either stream.
export const noAddress = ({ stdout, stderr }, secrets = []) => {
  for (const [name, text] of [['stdout', stdout], ['stderr', stderr]]) holdsNothingElse(name, text, text, secrets)
}
