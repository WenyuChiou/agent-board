import assert from 'node:assert/strict'

// Reads the one-use link a command printed (#1650). Pure: no I/O.
export const readPrintedLink = ({ stdout, stderr }, { secrets = [] } = {}) => {
  const out = `${stdout}${stderr}`
  const links = [...out.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/open\/([\w-]+)/g)]
  assert.ok(links.length > 0, `the command prints a one-use link: ${out}`)
  for (const secret of secrets) assert.equal(out.includes(secret), false, `the command prints no page token: ${out}`)
  assert.doesNotMatch(out, /[?&]t=/, `the command prints no page token: ${out}`)
  const [link, port, code] = links.at(-1)
  return { link, port: Number(port), code }
}

export const noAddress = ({ stdout, stderr }, secrets = []) => {
  const out = `${stdout}${stderr}`
  assert.doesNotMatch(out, /http:\/\/127\.0\.0\.1:(\d+)\/open\/([\w-]+)/, `the command prints no one-use link: ${out}`)
  assert.doesNotMatch(out, /[?&]t=/, `the command prints no page token: ${out}`)
  for (const secret of secrets) assert.equal(out.includes(secret), false, `the command prints no page token: ${out}`)
}
