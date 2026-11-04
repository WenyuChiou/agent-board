import { accessSync, constants, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

// A squash merge's subject is its pull request title and number. A fix or feature gets its CHANGELOG line from that
// title, unless it added a fragment or wrote its own line in CHANGELOG.md, which already holds its entry.
const commitSubject = /^(?:fix|feat)(?:\([^)]*\))?!?:\s*(.+?)\s*\(#([1-9]\d*)\)\s*$/

export const isTitleOnlyCommit = ({ subject = '', paths = [] } = {}) => {
  const match = subject.match(commitSubject)
  if (!match || paths.some(path => path === 'CHANGELOG.md' || isFragmentPath(path))) return null
  return { summary: match[1], number: Number(match[2]), prNumber: match[2] }
}

export const titleCommitNumbers = (commits = []) => {
  const numbers = []
  for (const commit of commits) {
    const info = isTitleOnlyCommit(commit)
    if (info) numbers.push(info.number)
  }
  return [...new Set(numbers)]
}

export const commitEntries = (commits = []) => {
  const seenNumbers = new Set()
  const entries = []
  for (const commit of commits) {
    const info = isTitleOnlyCommit(commit)
    if (!info || seenNumbers.has(info.prNumber)) continue
    seenNumbers.add(info.prNumber)
    // A title that already ends in its issue number, as in 'fix: x (#560) (#579)', keeps only the pull request's.
    const summary = info.summary.replace(/(?:\s*\(#\d+\))+$/, '').replace(/[.\s]+$/, '')
    entries.push(`- ${summary.charAt(0).toUpperCase()}${summary.slice(1)} (#${info.prNumber}).`)
  }
  return entries
}

export const unreadableMerges = (commits = []) => {
  const unreadable = []
  for (const { subject = '', paths = [] } of commits) {
    if (paths.some(path => path === 'CHANGELOG.md' || isFragmentPath(path))) continue
    if (commitSubject.test(subject)) continue
    const isFixOrFeat = /^(?:fix|feat)[(!:]/i.test(subject) || /^Merge\s+(?:pull\s+request\s+#\d+|.*?\b(?:fix|feat)\b)/i.test(subject)
    if (isFixOrFeat) {
      const prMatch = subject.match(/#([1-9]\d*)\b/)
      unreadable.push(prMatch ? `#${prMatch[1]}` : subject.trim())
    }
  }
  return [...new Set(unreadable)]
}

// Each commit since the last release tag on main, with the files it changed.
export const readCommits = ({ cwd = process.cwd(), run = spawnSync } = {}) => {
  const git = args => run('git', args, { cwd, encoding: 'utf8' })
  const tag = git(['describe', '--tags', '--abbrev=0', '--match', 'agent-board--v*'])
  if (tag.status !== 0 || !tag.stdout.trim()) {
    const isShallow = git(['rev-parse', '--is-shallow-repository']).stdout?.trim() === 'true'
    return { commits: [], note: isShallow ? 'this clone is shallow, so no release tag was found; run git fetch --unshallow and fold again' : 'no release tag found, so no pull request titles were read' }
  }
  const log = git(['log', `${tag.stdout.trim()}..HEAD`, '--format=%x1e%s', '--name-only'])
  if (log.status !== 0) return { commits: [], note: 'git log failed, so no pull request titles were read' }
  const commits = log.stdout.split('\x1e').filter(item => item.trim()).map(item => {
    const [subject, ...paths] = item.split(/\r?\n/)
    return { subject: subject.trim(), paths: paths.map(path => path.trim()).filter(Boolean) }
  })
  return { commits, note: null }
}

export const foldText = ({ text, fragments = [], commits = [], version, date, intoExisting = false }) => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('version must be digits.digits.digits')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('date must be a valid YYYY-MM-DD')
  const headings = [...text.matchAll(/^## ([^\r\n]*)(?:\r?\n|$)/gm)]
  const unreadable = unreadableMerges(commits)
  const existingMatch = headings.find(match => match[1] === version || match[1].startsWith(`${version} `))
  if (existingMatch) {
    if (!intoExisting) {
      throw new Error(`version ${version} already has a heading; to fold into the existing heading after a late merge, run with --into-existing (or remove the ## ${version} section and run again)`)
    }
    const existingIndex = headings.indexOf(existingMatch)
    const headingStart = existingMatch.index
    const headingEnd = headings[existingIndex + 1]?.index ?? text.length
    const existingSection = text.slice(headingStart, headingEnd)
    const existingNumbers = new Set([...existingSection.matchAll(/#([1-9]\d*)\b/g)].map(m => m[1]))

    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const ordered = orderFragments(fragments.filter(item => item.path !== 'changelog.d/README.md').map(parseFragment))
    const fragmentEntries = ordered.map(item => stripTests(item.text).trim().replace(/\r?\n/g, eol))
    const newFragmentEntries = []
    const foldedFragmentPaths = ordered.map(item => item.path)
    for (let i = 0; i < ordered.length; i++) {
      if (!existingNumbers.has(ordered[i].issue)) {
        newFragmentEntries.push(fragmentEntries[i])
      }
    }

    const fromTitles = commitEntries(commits)
    const newFromTitles = fromTitles.filter(entry => {
      const m = entry.match(/#([1-9]\d*)\)\.$/)
      return !m || !existingNumbers.has(m[1])
    })

    const unreleasedStart = headings.findIndex(match => /^Unreleased\s*$/.test(match[1]))
    const unreleasedHeading = headings[unreleasedStart]
    const unreleasedEnd = unreleasedHeading ? headings[unreleasedStart + 1]?.index ?? text.length : 0
    const unreleased = unreleasedHeading ? stripTests(text.slice(unreleasedHeading.index + unreleasedHeading[0].length, unreleasedEnd)).trim() : ''

    const newEntries = [...newFragmentEntries, ...newFromTitles, ...(unreleased ? [unreleased] : [])]

    if (!newEntries.length && !foldedFragmentPaths.length) {
      return {
        text,
        heading: existingMatch[0].trim(),
        fragments: [],
        unreleasedCount: 0,
        titleCount: 0,
        unreadableCount: unreadable.length,
        unreadable,
      }
    }

    const trimmedSection = existingSection.trimEnd()
    const updatedSection = (newEntries.length ? trimmedSection + eol + eol + newEntries.join(eol + eol) : trimmedSection) + eol
    const suffix = text.slice(headingEnd)
    let newText = text.slice(0, headingStart) + updatedSection + (suffix ? (suffix.startsWith(eol) ? '' : eol) + suffix : '')
    if (unreleasedHeading) {
      const uMatch = newText.match(/^## Unreleased\s*(?:\r?\n|$)/m)
      if (uMatch) {
        const uStart = uMatch.index
        const afterU = newText.slice(uStart + uMatch[0].length)
        const nextH = afterU.search(/^## /m)
        if (nextH !== -1) {
          newText = newText.slice(0, uStart + uMatch[0].length) + (afterU.slice(nextH).startsWith(eol) ? '' : eol) + afterU.slice(nextH)
        }
      }
    }
    return {
      text: newText,
      heading: existingMatch[0].trim(),
      fragments: foldedFragmentPaths,
      unreleasedCount: (unreleased.match(/^- /gm) ?? []).length,
      titleCount: newFromTitles.length,
      unreadableCount: unreadable.length,
      unreadable,
    }
  }

  const start = headings.findIndex(match => /^Unreleased\s*$/.test(match[1]))
  const heading = headings[start]
  const end = heading ? headings[start + 1]?.index ?? text.length : headings[0]?.index ?? text.length
  const unreleased = heading ? stripTests(text.slice(heading.index + heading[0].length, end)).trim() : ''
  const ordered = orderFragments(fragments.filter(item => item.path !== 'changelog.d/README.md').map(parseFragment))
  const fromTitles = commitEntries(commits)
  if (!ordered.length && !unreleased && !fromTitles.length) throw new Error('nothing to release')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const title = `## ${version} — ${date}`
  const entries = [...ordered.map(item => stripTests(item.text).trim().replace(/\r?\n/g, eol)), ...fromTitles, ...(unreleased ? [unreleased] : [])]
  const prefix = text.slice(0, heading?.index ?? end)
  const prefixEol = prefix.match(/\r?\n(?=[^\n]*$)/)?.[0] ?? eol
  const separator = prefix && !/(?:\r?\n){2}$/.test(prefix) ? (prefix.endsWith('\n') ? prefixEol : prefixEol + prefixEol) : ''
  const suffix = text.slice(end)
  return {
    text: prefix + separator + title + eol + eol + entries.join(eol + eol) + eol + (suffix ? eol + suffix : ''),
    heading: title,
    fragments: ordered.map(item => item.path),
    unreleasedCount: (unreleased.match(/^- /gm) ?? []).length,
    titleCount: fromTitles.length,
    unreadableCount: unreadable.length,
    unreadable,
  }
}

export const ambitionQuestions = [
  "What goal sits above this version's goal?",
  'Which one hard number should the next version move?',
  'Which other field has already solved a problem like ours?',
]

export const parseArgs = (argv, now = new Date()) => {
  const [version, ...args] = argv
  const options = { version, date: now.toISOString().slice(0, 10), isWrite: false, intoExisting: false }
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (seen.has(arg)) throw new Error(`duplicate option: ${arg}`)
    seen.add(arg)
    if (arg === '--write') options.isWrite = true
    else if (arg === '--into-existing') options.intoExisting = true
    else if (arg === '--date' && args[i + 1]) options.date = args[++i]
    else throw new Error('use node scripts/changelog-fold.mjs <version> [--date YYYY-MM-DD] [--into-existing] [--write]')
  }
  return options
}

export const runFold = ({ cwd = process.cwd(), argv = process.argv.slice(2), now = new Date(), log = console.log, checkWritable = path => accessSync(path, constants.W_OK), commitsOf = readCommits } = {}) => {
  const options = parseArgs(argv, now)
  const directory = join(cwd, 'changelog.d')
  const fragments = existsSync(directory) ? readdirSync(directory).filter(name => name !== 'README.md').map(name => {
    const path = `changelog.d/${name}`
    if (fragmentIssue(path) === null) throw new Error(`invalid fragment name: ${path}`)
    return { path, text: readFileSync(join(cwd, path), 'utf8') }
  }) : []
  const { commits, note } = commitsOf({ cwd })
  const folded = foldText({ ...options, text: readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8'), fragments, commits })
  if (options.isWrite) {
    // Removing a file needs write access to its folder on Linux and macOS.
    for (const path of ['CHANGELOG.md', ...folded.fragments, ...(folded.fragments.length ? ['changelog.d'] : [])]) checkWritable(join(cwd, path))
    writeFileSync(join(cwd, 'CHANGELOG.md'), folded.text)
    for (const path of folded.fragments) unlinkSync(join(cwd, path))
  }
  log(`${options.isWrite ? 'Wrote' : 'Dry run:'} ${folded.heading}`)
  log(`Fragments (${folded.fragments.length}):${folded.fragments.length ? '\n' + folded.fragments.join('\n') : ' none'}`)
  log(`From pull request titles: ${folded.titleCount}${note ? ` (${note})` : ''}`)
  log(`Unreadable fix or feature merges: ${folded.unreadableCount}${folded.unreadable.length ? ` (${folded.unreadable.join(', ')})` : ''}`)
  log(`Unreleased entries kept: ${folded.unreleasedCount}`)
  if (options.isWrite) {
    log(`Removed ${folded.fragments.length} folded fragment(s).`)
    // Output only: the questions never prompt or block the release.
    log('\nBefore planning the next version, answer in its plan:')
    ambitionQuestions.forEach((question, index) => log(`${index + 1}. ${question}`))
  }
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
