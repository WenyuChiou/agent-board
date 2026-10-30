import { accessSync, constants, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const fragmentIssue = path => path.match(/^changelog\.d\/([1-9]\d*)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/)?.[1] ?? null
export const isFragmentPath = path => path.startsWith('changelog.d/') && path !== 'changelog.d/README.md'

export const parseFragment = ({ path, text }) => {
  const issue = fragmentIssue(path)
  if (issue === null) throw new Error(`invalid fragment name: ${path}`)
  if (!new RegExp(`#${issue}(?!\\d)`).test(text)) throw new Error(`${path} does not name #${issue}`)
  if (!/\bTests?:/.test(text)) throw new Error(`${path} has no Tests: line`)
  return { path, text, issue }
}

export const orderFragments = fragments => [...fragments].sort((a, b) => {
  const left = BigInt(a.issue)
  const right = BigInt(b.issue)
  return left === right ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : left > right ? -1 : 1
})

const testList = /^Tests?:\s*(?:none \([^)]*\)|(?:`[^`]*`|"[^"]*")(?:\s*(?:,|;|,?\s+and)?\s*(?:`[^`]*`|"[^"]*"))*)\.?\s*$/
// A title opens with a backtick or a double quote and closes with the same
// mark; the other mark inside it is just a character.
const isOpen = text => {
  let mark = ''
  for (const char of text) {
    if (mark) mark = char === mark ? '' : mark
    else if (char === '`' || char === '"') mark = char
  }
  return mark !== '' || /(?:,|;|\band)\s*$/.test(text)
}
const isBoundary = body => body === undefined || body.trim() === '' || /^(?:- |#)/.test(body)

// A Tests line, or a Tests sentence at the end of a line, goes when it holds
// only test titles and the entry ends after it or another Tests line follows. A
// list that wraps goes on while a title is open or the line ends with a comma,
// a semicolon or "and". Anything else, such as a list with more of the entry
// after it, is kept as written.
export const stripTests = text => {
  const lines = text.split(/(?<=\n)/)
  const bodies = lines.map(line => line.replace(/\r?\n$/, ''))
  const kept = []
  for (let i = 0; i < lines.length; i++) {
    const inline = bodies[i].match(/^(.*[.!?)])[ \t]+(Tests?:.*)$/)
    const whole = bodies[i].match(/^[^\S\r\n]*(Tests?:.*)$/)
    if (!inline && !whole) {
      kept.push(lines[i])
      continue
    }
    let list = whole ? whole[1] : inline[2]
    let last = i
    while (isOpen(list) && !isBoundary(bodies[last + 1]) && /^\s/.test(bodies[last + 1])) list += ' ' + bodies[++last].trim()
    if (testList.test(list) && (isBoundary(bodies[last + 1]) || /^\s*Tests?:/.test(bodies[last + 1]))) {
      if (inline) kept.push(inline[1] + lines[last].slice(bodies[last].length))
    } else kept.push(...lines.slice(i, last + 1))
    i = last
  }
  return kept.join('')
}

export const foldText = ({ text, fragments = [], version, date }) => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('version must be digits.digits.digits')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('date must be a valid YYYY-MM-DD')
  const headings = [...text.matchAll(/^## ([^\r\n]*)(?:\r?\n|$)/gm)]
  if (headings.some(match => match[1] === version || match[1].startsWith(`${version} `))) throw new Error(`version ${version} already has a heading`)
  const start = headings.findIndex(match => /^Unreleased\s*$/.test(match[1]))
  const heading = headings[start]
  const end = heading ? headings[start + 1]?.index ?? text.length : headings[0]?.index ?? text.length
  const unreleased = heading ? stripTests(text.slice(heading.index + heading[0].length, end)).trim() : ''
  const ordered = orderFragments(fragments.filter(item => item.path !== 'changelog.d/README.md').map(parseFragment))
  if (!ordered.length && !unreleased) throw new Error('nothing to release')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const title = `## ${version} — ${date}`
  const entries = [...ordered.map(item => stripTests(item.text).trim().replace(/\r?\n/g, eol)), ...(unreleased ? [unreleased] : [])]
  const prefix = text.slice(0, heading?.index ?? end)
  const prefixEol = prefix.match(/\r?\n(?=[^\n]*$)/)?.[0] ?? eol
  const separator = prefix && !/(?:\r?\n){2}$/.test(prefix) ? (prefix.endsWith('\n') ? prefixEol : prefixEol + prefixEol) : ''
  const suffix = text.slice(end)
  return {
    text: prefix + separator + title + eol + eol + entries.join(eol + eol) + eol + (suffix ? eol + suffix : ''),
    heading: title,
    fragments: ordered.map(item => item.path),
    unreleasedCount: (unreleased.match(/^- /gm) ?? []).length,
  }
}

export const parseArgs = (argv, now = new Date()) => {
  const [version, ...args] = argv
  const options = { version, date: now.toISOString().slice(0, 10), isWrite: false }
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (seen.has(arg)) throw new Error(`duplicate option: ${arg}`)
    seen.add(arg)
    if (arg === '--write') options.isWrite = true
    else if (arg === '--date' && args[i + 1]) options.date = args[++i]
    else throw new Error('use node scripts/changelog-fold.mjs <version> [--date YYYY-MM-DD] [--write]')
  }
  return options
}

export const runFold = ({ cwd = process.cwd(), argv = process.argv.slice(2), now = new Date(), log = console.log, checkWritable = path => accessSync(path, constants.W_OK) } = {}) => {
  const options = parseArgs(argv, now)
  const directory = join(cwd, 'changelog.d')
  const fragments = existsSync(directory) ? readdirSync(directory).filter(name => name !== 'README.md').map(name => {
    const path = `changelog.d/${name}`
    if (fragmentIssue(path) === null) throw new Error(`invalid fragment name: ${path}`)
    return { path, text: readFileSync(join(cwd, path), 'utf8') }
  }) : []
  const folded = foldText({ ...options, text: readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8'), fragments })
  if (options.isWrite) {
    // Removing a file needs write access to its folder on Linux and macOS.
    for (const path of ['CHANGELOG.md', ...folded.fragments, ...(folded.fragments.length ? ['changelog.d'] : [])]) checkWritable(join(cwd, path))
    writeFileSync(join(cwd, 'CHANGELOG.md'), folded.text)
    for (const path of folded.fragments) unlinkSync(join(cwd, path))
  }
  log(`${options.isWrite ? 'Wrote' : 'Dry run:'} ${folded.heading}`)
  log(`Fragments (${folded.fragments.length}):${folded.fragments.length ? '\n' + folded.fragments.join('\n') : ' none'}`)
  log(`Unreleased entries kept: ${folded.unreleasedCount}`)
  if (options.isWrite) log(`Removed ${folded.fragments.length} folded fragment(s).`)
  return folded
}

export const main = (argv = process.argv.slice(2)) => {
  try {
    runFold({ argv })
    return 0
  } catch (error) {
    console.error(`changelog-fold: ${error.message.replace(/[\r\n]+/g, ' ')}`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
