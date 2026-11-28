import assert from 'node:assert/strict'
import { EN } from '../../hooks/strings-en.ts'
import { ZH_TW } from '../../hooks/i18n.ts'
import { ZH_CN } from '../../hooks/strings-zh-cn.ts'

// Reads the one-use link a command printed (#1650). Pure: no I/O.
//
// The link is read by subtraction, one stream at a time, never by searching a joined blob:
// - it is the tail of the last non-empty stdout line, and nothing may follow it;
// - that tail is a whole one-use link (the server's own rule: a 16 to 128 character code);
// - the whole line is the product's wording for that link, in one of the given languages;
// - each stream holds the link the expected number of times, and what is left after taking the
//   link out holds no other address, no query token and none of the page tokens given.
// `notes` are the product's lines that name the link and more (the SSH forward, `ssh -L
// <port>:127.0.0.1:<port>`): a line on either stream that is a note of the link, whole, is taken out
// before that check, and its copy of the link still counts.
// With `lan`, stdout ends with the phone's block (#868, #1146) and it is read first, also by
// subtraction: the `serveLanAt` line with a private-network `http://<ip>:<port>/?t=<token>`
// address (the one printed address meant to carry a token), the QR code's lines, then the
// `serveLanWarn` line; or one of the `none` notes alone. What is left above it is read as before.
const LINK = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/open\/([A-Za-z0-9_-]{16,128})$/
const EXPECTED = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/open\/([A-Za-z0-9_-]+)$/
const LEFT = /\/open\/|127\.0\.0\.1|localhost|\[::1\]|[?&#](?:t|k)=/i
const LAN = /^http:\/\/(10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}:([1-9]\d{0,4})\/\?t=[\w-]+$/
const QR = /^(?:\u001b\[30;107m)?[\u2580\u2584\u2588 ]+(?:\u001b\[0m)?$/

const holdsNothingElse = (name, text, rest, secrets) => {
  assert.doesNotMatch(rest, LEFT, `${name} holds no other address or token: ${text}`)
  for (const secret of secrets) assert.equal(text.includes(secret), false, `${name} holds no page token: ${text}`)
}

// Takes the phone's block off the end of stdout: what is above it, and the phone's address (null
// when a note says there is none).
const takeLan = (stdout, { at, warn, none = [] }) => {
  const lines = stdout.split(/\r?\n/)
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  const last = lines.at(-1) ?? ''
  if (none.includes(last)) return { above: lines.slice(0, -1).join('\n'), lan: null }
  assert.ok(warn.includes(last), `the last line of stdout is the phone's warning or a note: ${stdout}`)
  const starts = lines.flatMap((line, index) => (line.includes('/?t=') ? [index] : []))
  assert.equal(starts.length, 1, `stdout holds one phone address: ${stdout}`)
  const head = lines[starts[0]]
  const lan = /http:\/\/[\d.]+:\d+\/\?t=[\w-]+/.exec(head)?.[0] ?? ''
  const found = LAN.exec(lan)
  assert.ok(found && Number(found[2]) <= 65535, `the phone's address is a whole private-network address: ${head}`)
  assert.ok(at.some(word => head === word(lan)), `the phone's address line is the product's wording: ${head}`)
  const code = lines.slice(starts[0] + 1, -1)
  assert.ok(code.every(line => QR.test(line)), `only the QR code is between the phone's address and the warning: ${stdout}`)
  return { above: lines.slice(0, starts[0]).join('\n'), lan }
}

export const readPrintedLink = (result, { wordings, expected, copies = { stdout: 1, stderr: 0 }, secrets = [], notes = [], lan }) => {
  assert.ok(Array.isArray(wordings) && wordings.length > 0, 'the address-line wordings are given')
  const phone = lan === undefined ? null : takeLan(result.stdout, lan)
  const stdout = phone === null ? result.stdout : phone.above
  const { stderr } = result
  const last = stdout.split(/\r?\n/).filter(line => line !== '').at(-1) ?? ''
  const at = last.lastIndexOf('http://')
  assert.ok(at >= 0, `the last line of stdout ends with the link: ${stdout}`)
  const link = last.slice(at)
  const found = expected === undefined ? LINK.exec(link) : link === expected ? EXPECTED.exec(link) : null
  assert.ok(found && Number(found[1]) <= 65535, `the whole printed address is a one-use link: ${last}`)
  assert.ok(wordings.some(word => last === word(link)), `the last line is the address line: ${last}`)
  for (const [name, text] of [['stdout', stdout], ['stderr', stderr]]) {
    assert.equal(text.split(link).length - 1, copies[name], `${name} holds the link ${copies[name]} time(s): ${text}`)
    const kept = text.split(/\r?\n/).filter(line => !notes.some(note => line === note(link))).join('\n')
    holdsNothingElse(name, text, kept.split(link).join('\n'), secrets)
  }
  return { link, port: Number(found[1]), code: found[2], ...(phone === null ? {} : { lan: phone.lan }) }
}

// The product's wordings by string name (`serveAt`, `boardPageLink`, ...), in every language by
// default, for `wordings`, `notes` and `lan`.
export const wordingsOf = (names, languages = [EN, ZH_TW, ZH_CN]) => languages.flatMap(words => names.map(name => {
  assert.ok(name in words, `a product wording: ${name}`)
  return words[name]
}))

// A command that failed prints no address and no page token on either stream.
export const noAddress = ({ stdout, stderr }, secrets = []) => {
  for (const [name, text] of [['stdout', stdout], ['stderr', stderr]]) holdsNothingElse(name, text, text, secrets)
}
