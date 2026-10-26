export const generatedHookCommand = command => {
  const powershell = /-EncodedCommand\s+([A-Za-z0-9+/]+={0,2})/i.exec(command)
  if (powershell) return { args: null, text: Buffer.from(powershell[1], 'base64').toString('utf16le') }
  const direct = /--input-type=commonjs\s+-e\s+eval\(Buffer\.from\('([A-Za-z0-9+/]+={0,2})','base64'\)\.toString\('utf8'\)\)/.exec(command)
  if (!direct) return { args: null, text: command }
  const source = Buffer.from(direct[1], 'base64').toString('utf8')
  const literal = /^process\.argv=JSON\.parse\(("(?:\\[\s\S]|[^"\\])*")\);/.exec(source)?.[1]
  if (!literal) throw new Error('the direct hook command has no argument data')
  const args = JSON.parse(JSON.parse(literal))
  if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) throw new Error('the direct hook command has invalid argument data')
  return { args, text: args.join(' ') }
}
