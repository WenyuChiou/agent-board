import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fragmentIssue, isFragmentPath } from './changelog-fold.mjs'

// The open pull request cap the owner approved for CONTRIBUTING.md rule 10 (#229): per author, and in all.
export const AUTHOR_CAP = 2
export const TOTAL_CAP = 8
// Pull requests from outside the team (CONTRIBUTING.md, Outside contributors; #482): two open per GitHub login and
// four in all, counted apart from the team's.
export const OUTSIDE_LOGIN_CAP = 2
export const OUTSIDE_TOTAL_CAP = 4
// A small docs fix from outside the team (CONTRIBUTING.md rule 2) needs no issue line, claim or changelog fragment.
export const SMALL_DOCS_FILES = 3
export const SMALL_DOCS_LINES = 50
// Larger than either of these, an outside pull request gets a note (never a failure).
export const OUTSIDE_NOTE_LINES = 500
export const OUTSIDE_NOTE_FILES = 15
// The most issues a fix pull request may name (CONTRIBUTING.md rule 2); a feature pull request has no limit.
export const FIX_ISSUE_CAP = 3

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const result = () => ({ problems: [], info: [] })
const problem = (check, message, fix) => ({ check, message, fix })
const isReleaseTitle = title => /^chore\(release\):/.test(title)
// The type is read as rule 6 reads it for the CHANGELOG: the word before "(", "!" or ":".
const isFixTitle = title => /^fix[(!:]/.test(title)
const linesOf = text => text.split(/\r?\n/)

// The owner's agents all post as the OWNER, so only another association is outside; an association that is not
// known (a local --body-file run) reads as the team and changes nothing.
export const isOutsideAssociation = association => typeof association === 'string' && association.trim() !== '' && !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association.trim().toUpperCase())

// A docs: pull request that changes only README*.md or docs/**/*.md (not docs/FORMAT.md or docs/dev/), in at most
// three files and 50 added lines.
const isSmallDocsPath = path => {
  const lower = path.toLowerCase()
  return /^README[^/]*\.md$/.test(path) || (/^docs\/.+\.md$/.test(lower) && lower !== 'docs/format.md' && !lower.startsWith('docs/dev/'))
}
export const isSmallDocsFix = ({ title, paths, added }) => /^docs(?::|\()/.test(title)
  && paths.length > 0 && paths.length <= SMALL_DOCS_FILES && paths.every(isSmallDocsPath) && added.length <= SMALL_DOCS_LINES

export const stripComments = body => body.replace(/<!--[\s\S]*?(?:-->|$)/g, '')

const diffPath = value => {
  if (value.startsWith('"')) {
    // Git quotes non-ASCII names as UTF-8 octal bytes, rather than JSON escapes.
    const bytes = []
    const inner = value.slice(1, -1)
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '\\') {
        const octal = inner.slice(i + 1).match(/^[0-7]{3}/)?.[0]
        if (octal) {
          bytes.push(parseInt(octal, 8))
          i += 3
          continue
        }
        const escaped = inner[++i]
        bytes.push(...Buffer.from(({ t: '\t', n: '\n', r: '\r' })[escaped] ?? escaped ?? ''))
      } else {
        const code = inner.codePointAt(i)
        bytes.push(...Buffer.from(String.fromCodePoint(code)))
        if (code > 0xffff) i++
      }
    }
    value = Buffer.from(bytes).toString('utf8')
  }
  return value === '/dev/null' ? null : value
}

export const addedLines = unifiedDiff => {
  const added = []
  let path = null
  let line = null
  for (const text of linesOf(unifiedDiff)) {
    if (text.startsWith('diff --git ')) {
      path = null
      line = null
    } else if (line !== null && text.startsWith('+')) {
      if (path) added.push({ path, line, text: text.slice(1) })
      line++
    } else if (text.startsWith('+++ ')) {
      // Git ends the line with a tab when the path holds a space.
      path = diffPath(text.slice(4).replace(/\t$/, ''))?.replace(/^b\//, '') ?? null
    } else if (/^@@ /.test(text)) {
      line = Number(text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)?.[1])
      if (!Number.isFinite(line)) line = null
    } else if (line !== null && text.startsWith(' ')) {
      line++
    }
  }
  return added
}

export const issueLine = (body, title, { isOptional = false } = {}) => {
  const output = { issue: null, kind: null, issues: [], ...result() }
  if (isReleaseTitle(title)) {
    output.info.push('issue: release pull requests need no issue line.')
    return output
  }
  const clean = stripComments(body)
  // The list is the run of issue lines that opens the body; the first other line ends it.
  const listed = []
  for (const line of linesOf(clean).map(text => text.trim()).filter(Boolean)) {
    const match = line.match(/^(Fixes|Part of)\s+#(\d+)\b/i)
    if (!match) break
    listed.push({ number: Number(match[2]), kind: match[1].toLowerCase() })
  }
  if (!listed.length) {
    if (isOptional) output.info.push('issue: a small docs fix needs no issue line.')
    else output.problems.push(problem('issue', 'the first non-empty body line must name one issue.', 'add "Fixes #N" or "Part of #N" as the first line.'))
    return output
  }
  output.issue = listed[0].number
  output.kind = listed[0].kind
  output.issues = listed.map(item => item.number)
  for (const number of new Set(output.issues.filter((item, index) => output.issues.indexOf(item) !== index))) {
    output.problems.push(problem('issue', `#${number} is listed more than once.`, 'give each issue one "Fixes #N" or "Part of #N" line.'))
  }
  if (listed.length > FIX_ISSUE_CAP && isFixTitle(title)) {
    output.problems.push(problem('issue', `a fix pull request names ${listed.length} issues; the most is ${FIX_ISSUE_CAP}.`, `keep ${FIX_ISSUE_CAP} or fewer issue lines and move the other bug fixes to another pull request (CONTRIBUTING.md, Pull requests, rule 2).`))
  }
  for (const closing of clean.matchAll(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi)) {
    if (!output.issues.includes(Number(closing[2]))) {
      output.problems.push(problem('issue', `a closing keyword also names #${closing[2]}.`, output.issues.length === 1 ? 'remove the other closing reference so this pull request covers only its first issue.' : 'remove the other closing reference so this pull request closes only the issues on its first lines.'))
    }
  }
  return output
}

// The branch as a whole word: "fix/a" is not named by "fix/ab", and it may sit in backticks or before punctuation.
const namesBranch = (text, branch, boundary = '[\\s`,();.]') => {
  return new RegExp(`(?:^|${boundary})${escapeRegex(branch)}(?=$|${boundary})`).test(text)
}

export const authorLine = (body, branch) => {
  const output = { agent: null, ...result() }
  const author = stripComments(body).match(/^Author:[ \t]*(.*)$/m)?.[1]?.trim() ?? ''
  const comma = author.indexOf(',')
  const name = comma === -1 ? '' : author.slice(0, comma).replace(/`/g, '').trim()
  // The cap counts the words before the comma, so a line without one would count as a new author each time.
  if (!name || name.toLowerCase() === '<agent>') {
    output.problems.push(problem('author', 'the Author line needs "<agent>, <branch>", with the comma.', 'write "Author: <your agent name>, <this branch>".'))
  } else {
    output.agent = name.split(/\s+/)[0].toLowerCase()
  }
  if (!namesBranch(comma === -1 ? author : author.slice(comma + 1), branch)) {
    output.problems.push(problem('author', 'the Author line does not name this pull request branch.', 'put the exact current branch on the Author line, optionally in backticks.'))
  }
  return output
}

export const naming = (title, branch) => {
  const output = result()
  if (!/^(feat|fix|docs|test|refactor|chore|perf|ci|build|style|revert)(\([^)]+\))?!?: \S/.test(title)) {
    output.problems.push(problem('naming', 'the title does not use the conventional form.', 'use "fix: summary" or "feat(scope): summary", with a supported type.'))
  }
  if (!/^(feat|fix|docs|test|refactor|chore|perf|ci|build|style|revert)\/[a-z0-9][a-z0-9._-]*$/.test(branch)) {
    output.problems.push(problem('naming', 'the branch does not use type/short-slug.', 'use a supported type and a lowercase slug, for example "fix/question-ledger".'))
  }
  return output
}

export const sections = (body, template) => {
  const output = result()
  const clean = stripComments(body)
  const headings = [...clean.matchAll(/^## (.+)\r?$/gm)]
  for (const heading of stripComments(template).matchAll(/^## (.+)\r?$/gm)) {
    const name = heading[1].trim()
    const index = headings.findIndex(item => item[1].trim().toLowerCase() === name.toLowerCase())
    const found = headings[index]
    if (!found || !clean.slice(found.index + found[0].length, headings[index + 1]?.index ?? clean.length).trim()) {
      output.problems.push(problem('sections', `the "${name}" section is missing or empty.`, `add "## ${name}" and explain its result, or why it is not applicable.`))
    }
  }
  const items = new Set([...stripComments(template).matchAll(/^- \[ \] (.+)\r?$/gm)].map(match => match[1].trim()))
  for (const match of clean.matchAll(/^- \[([ xX])\] (.+)\r?$/gm)) {
    if (items.has(match[2].trim())) {
      output.problems.push(problem('sections', 'a template checkbox has no result or reason.', match[1] === ' ' ? 'tick it and add the result, or add "not run:" and why, or "n/a:" and why.' : 'add the result after a dash on the checked item.'))
    }
  }
  return output
}

// A pull request that names several issues passes each number, so the message names the issue that lacks the claim.
export const claimed = (comments, agent, branch, issue = null) => {
  const output = result()
  const agentPattern = agent ? new RegExp(`\\b${escapeRegex(agent)}\\b`, 'i') : null
  if (!comments.some(comment => comment.body.includes(branch) && agentPattern?.test(comment.body))) {
    output.problems.push(issue === null
      ? problem('claim', 'no issue comment claims this branch for this agent.', 'comment on the issue with "Claim: <agent>, <branch>" before starting work.')
      : problem('claim', `no comment on #${issue} claims this branch for this agent.`, `comment on #${issue} with "Claim: <agent>, <branch>" before starting work; each issue of the pull request needs its own claim.`))
  }
  return output
}

const unescapeTitle = text => text.replace(/\\(['"\\`])/g, '$1')
const templateVariable = /\$\{[^}]*\}/g
const spanPlaceholder = /<[^>]+>/g

// Literal parts in order, each variable at least one character; no regular expression is
// built from pull request text, so a long title cannot make the check hang.
const fitsTemplate = (span, parts) => {
  if (!span.startsWith(parts[0])) return false
  let at = parts[0].length
  for (const part of parts.slice(1, -1)) {
    const found = span.indexOf(part, at + 1)
    if (found === -1 || found < at + 1) return false
    at = found + part.length
  }
  const last = parts.at(-1)
  return span.length - last.length >= at + 1 && span.endsWith(last)
}

export const testTitles = files => {
  const exact = new Set()
  const templates = []
  const shapes = new Set()
  for (const { path, text } of files) {
    if (!/^tests\/(?:.*\/)?[^/]+\.test\.(mjs|ts|tsx)$/.test(path)) continue
    const calls = /\b(?:test|it)(?:\.(?:skip|only|todo))?\s*\(\s*('(?:\\[^\r\n]|[^'\\\r\n])*'|"(?:\\[^\r\n]|[^"\\\r\n])*"|`(?:\\[^\r\n]|[^`\\\r\n])*`)/g
    for (const match of text.matchAll(calls)) {
      const title = unescapeTitle(match[1].slice(1, -1))
      if (match[1][0] === '`' && title.match(templateVariable)) {
        // A title of variables and punctuation only, such as `${name}`, would match any span.
        if (/\p{L}/u.test(title.replace(templateVariable, ''))) {
          templates.push(title.split(templateVariable))
          shapes.add(title.replace(templateVariable, '\0'))
        }
      } else {
        exact.add(title)
      }
    }
  }
  return { exact, templates, shapes }
}

// A span with <name> placeholders names a template title of the same shape, never a fixed one,
// so "<any>" alone matches nothing.
export const titleKnown = (span, titles) => titles.exact.has(span)
  || (span.match(spanPlaceholder) ? titles.shapes.has(span.replace(spanPlaceholder, '\0')) : titles.templates.some(parts => fitsTemplate(span, parts)))

const listedIssues = (issue, issues) => [...new Set(issues?.length ? issues : issue === null || issue === undefined ? [] : [issue])]

// issues: every issue on the body's first lines; a fragment may be named for any of them, once each.
export const fragmentChanges = ({ paths = [], addedPaths = [], headPaths, issue, issues, isRelease }) => {
  const output = result()
  const listed = listedIssues(issue, issues)
  const fragments = paths.filter(isFragmentPath)
  const fresh = addedPaths.filter(isFragmentPath)
  if (isRelease) {
    if (headPaths === undefined || headPaths === null) output.info.push('changelog: unfolded fragment check skipped; head tree listing is unavailable.')
    else if ([...headPaths].some(isFragmentPath)) output.problems.push(problem('changelog', 'the release leaves fragments unfolded in changelog.d/.', 'run node scripts/changelog-fold.mjs <version> --write and include the fragment removals.'))
    return output
  }
  for (const path of fresh) {
    const number = fragmentIssue(path)
    if (number === null) output.problems.push(problem('changelog', `invalid fragment name: ${path}.`, 'use changelog.d/<issue>-<lowercase-slug>.md; see changelog.d/README.md.'))
    else if (listed.length && !listed.includes(Number(number))) {
      const names = listed.map(item => `#${item}`).join(', ')
      output.problems.push(problem('changelog', `the fragment ${path} is named for a different issue than ${names}.`, listed.length === 1 ? `rename it to changelog.d/${listed[0]}-<slug>.md.` : `rename it to changelog.d/<issue>-<slug>.md, with <issue> one of ${names}.`))
    }
  }
  for (const path of fragments.filter(path => !fresh.includes(path))) {
    output.problems.push(problem('changelog', `an existing fragment was edited or removed: ${path}.`, 'restore that fragment and add a new file with a different slug; only chore(release): pull requests fold existing fragments.'))
  }
  if (listed.length < 2) {
    if (fresh.length > 1) output.problems.push(problem('changelog', 'more than one fragment was added.', 'combine this pull request entry into exactly one new changelog.d/<issue>-<slug>.md file.'))
  } else {
    // One fragment for each issue the body lists, so two for the same number still say too much.
    const numbers = fresh.map(fragmentIssue).filter(number => number !== null)
    for (const number of new Set(numbers.filter((item, index) => numbers.indexOf(item) !== index))) {
      output.problems.push(problem('changelog', `more than one fragment was added for #${number}.`, `combine them into exactly one new changelog.d/${number}-<slug>.md file.`))
    }
  }
  return output
}

export const changelogEntry = ({ entry, issue, titles, isDocsOnly, location = 'Unreleased entry' }) => {
  const output = result()
  if (issue !== null && issue !== undefined && !new RegExp(`#${issue}(?!\\d)`).test(entry)) {
    output.problems.push(problem('changelog', `the new entry does not name #${issue}.`, `add #${issue} to the ${location}.`))
  }
  const marker = /\bTests?:/.exec(entry)
  if (!marker) {
    output.problems.push(problem('changelog', 'the entry does not name its covering tests.', 'add "Tests:" followed by exact test titles in backticks.'))
    return output
  }
  const tail = entry.slice(marker.index + marker[0].length)
  const hasNone = /^\s*none\b/i.test(tail)
  if (hasNone) {
    if (!isDocsOnly) output.problems.push(problem('changelog', '"Tests: none" is only allowed for documentation-only changes.', 'name the tests covering this code change after "Tests:".'))
  }
  let hasKnown = false
  for (const match of tail.matchAll(/`([^`\n]+)`/g)) {
    if (/\.test\.(mjs|ts|tsx)$/.test(match[1])) continue
    if (titleKnown(match[1], titles)) hasKnown = true
    else output.problems.push(problem('changelog', `"${match[1]}" is not the title of any test in tests/.`, 'copy the exact title from its test(\'…\') call, or add the test; use <name> where a template title varies.'))
  }
  if (!hasKnown && !hasNone) output.problems.push(problem('changelog', 'the entry contains no known covering test title.', 'include at least one exact test title in backticks after "Tests:".'))
  return output
}

// Rule 6 asks an entry of fix and feature pull requests; any other entry is checked when there is one.
export const changelog = ({ text, added, issue, issues, titles, isRelease, isDocsOnly, isRequired = true, paths = [], addedPaths = [], headPaths }) => {
  const output = fragmentChanges({ paths, addedPaths, headPaths, issue, issues, isRelease })
  if (isRelease) {
    output.info.push('changelog: skipped for a release pull request.')
    return output
  }
  const fresh = addedPaths.filter(isFragmentPath)
  const lines = linesOf(text)
  const start = lines.findIndex(line => /^## Unreleased\s*$/.test(line))
  const next = lines.findIndex((line, index) => index > start && /^## /.test(line))
  const end = next === -1 ? lines.length : next
  const nonblank = added.filter(line => line.path === 'CHANGELOG.md' && line.text.trim())
  const inside = start === -1 ? [] : nonblank.filter(line => line.line > start + 1 && line.line <= end && !/^## /.test(line.text))
  if (fresh.length) {
    if (inside.length) output.problems.push(problem('changelog', 'the entry is both in changelog.d/ and under Unreleased; keep only the fragment.', 'remove the added Unreleased entry from CHANGELOG.md.'))
    // Each fragment names the issue in its own file name; one named for no listed issue is judged against the first.
    const ownIssue = path => (issues ?? []).find(item => item === Number(fragmentIssue(path))) ?? issue
    // A fix or feature pull request that names several issues needs a fragment for each (rule 6).
    const listed = listedIssues(issue, issues)
    if (isRequired && listed.length > 1) {
      const named = new Set(fresh.map(path => Number(fragmentIssue(path))))
      for (const number of listed.filter(item => !named.has(item))) {
        output.problems.push(problem('changelog', `no fragment was added for #${number}.`, `add changelog.d/${number}-<slug>.md (rule 6: one fragment for each issue).`))
      }
    }
    for (const path of fresh) output.problems.push(...changelogEntry({ entry: added.filter(item => item.path === path).map(item => item.text).join('\n'), issue: ownIssue(path), titles, isDocsOnly, location: 'fragment' }).problems)
    return output
  }
  // An Unreleased entry names one issue, so several issues can only be covered by fragments.
  const several = listedIssues(issue, issues)
  if (isRequired && several.length > 1) {
    output.problems.push(problem('changelog', 'a pull request that names several issues adds a fragment for each; an Unreleased entry covers one issue.', `add changelog.d/<issue>-<slug>.md for each listed issue (${several.map(item => `#${item}`).join(', ')}).`))
    return output
  }
  const notNeeded = () => output.info.push('changelog: no entry needed; rule 6 asks one of fix and feature pull requests.')
  if (start === -1) {
    if (isRequired) output.problems.push(problem('changelog', 'CHANGELOG.md has no Unreleased section.', 'add a fragment in changelog.d/ (see changelog.d/README.md), or add "## Unreleased" above the newest version heading and put the entry under it.'))
    else notNeeded()
    return output
  }
  if (!inside.length && !isRequired) {
    notNeeded()
    return output
  }
  if (!inside.length) {
    const outside = nonblank.filter(line => line.line < start + 1 || line.line > end)
    const headings = [...new Set(outside.map(item => lines.slice(0, item.line).filter(line => /^## /.test(line)).at(-1) ?? 'the preamble'))]
    output.problems.push(problem('changelog', outside.length ? `the added entry landed under ${headings.join(', ')} instead of Unreleased.` : 'no entry was added under Unreleased.', outside.length ? 'move the entry under a new "## Unreleased" at the top, or add a fragment in changelog.d/.' : 'add a fragment in changelog.d/ naming the issue and covering tests (see changelog.d/README.md).'))
    return output
  }
  const entry = inside.map(line => line.text).join('\n')
  const checked = changelogEntry({ entry, issue, titles, isDocsOnly })
  output.problems.push(...checked.problems)
  if (!checked.problems.length) output.info.push('changelog: legacy Unreleased entry accepted; new pull requests use changelog.d/ (see changelog.d/README.md).')
  return output
}

export const needsBundle = paths => paths.some(path => /^(scripts|hooks)\//.test(path))

// Rule 12 governance files; a pull request that changes one is not counted for the cap.
export const isGovernancePath = path => path === 'AGENTS.md' || path === 'CONTRIBUTING.md' || path.startsWith('.github/')

// Every agent posts from one GitHub account, so the cap counts the agent on the Author line:
// the words before its first comma, with a dispatching lane in brackets as part of the name.
export const authorKey = body => {
  const author = stripComments(body).match(/^Author:[ \t]*(.*)$/m)?.[1] ?? ''
  return author.split(',')[0].replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase() || null
}

const labelName = label => (typeof label === 'string' ? label : label.name)
// A reopened pull request keeps its creation time and would take a slot ahead of newer ones, so it is opened anew.
const capFix = 'close it and open a new pull request from the same branch when one merges, or keep the claim "waiting for a slot"; the owner may label it "cap-exempt".'

const outsideCapFix = 'wait until one of the open outside pull requests merges or closes, or close this one and open a new pull request from the same branch later; do not reopen the closed one, since GitHub keeps its first creation time and it would take a slot ahead of newer ones.'

// isOutside: the author is not the owner, a member or a collaborator. Such a pull request counts only against the
// outside caps (per login and in all), the team's does not count against those, and the release, governance and
// cap-exempt exemptions are the team's.
export const cap = ({ open, number, body, isOutside = false, login = null, perAuthor = AUTHOR_CAP, total = TOTAL_CAP, perLogin = OUTSIDE_LOGIN_CAP, outsideTotal = OUTSIDE_TOTAL_CAP }) => {
  const output = result()
  const isExempt = pr => isReleaseTitle(pr.title) || pr.isGovernance || pr.labels.some(label => labelName(label) === 'cap-exempt')
  if (!isOutside && open.some(pr => pr.number === number && isExempt(pr))) return output
  // Older pull requests keep their slots: sort by creation and judge only this one's place.
  const counted = open.filter(pr => Boolean(pr.isOutside) === isOutside && (isOutside || !isExempt(pr))).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number)
  const keyOf = pr => authorKey(pr.body ?? '') ?? `unnamed #${pr.number}`
  const self = counted.find(pr => pr.number === number) ?? { number, body, login }
  const queue = counted.includes(self) ? counted : [...counted, self]
  const ahead = queue.slice(0, queue.indexOf(self) + 1)
  if (isOutside) {
    if (ahead.length > outsideTotal) {
      output.problems.push(problem('cap', `${ahead.length} outside pull requests would be open, over the ${outsideTotal} in all; counted: ${counted.map(pr => `#${pr.number}`).join(', ')}.`, outsideCapFix))
    }
    const mine = typeof (self.login ?? login) === 'string' ? (self.login ?? login).toLowerCase() : null
    const own = mine ? ahead.filter(pr => typeof pr.login === 'string' ? pr.login.toLowerCase() === mine : pr === self) : []
    if (own.length > perLogin) {
      output.problems.push(problem('cap', `"${self.login ?? login}" would have ${own.length} open pull requests, over ${perLogin} per login: ${own.map(pr => pr.number === null ? 'this one' : `#${pr.number}`).join(', ')}.`, outsideCapFix))
    }
    return output
  }
  if (ahead.length > total) {
    output.problems.push(problem('cap', `${ahead.length} pull requests would be open, over the ${total} in all; counted: ${counted.map(pr => `#${pr.number}`).join(', ')}.`, capFix))
  }
  const author = keyOf(self)
  const own = ahead.filter(pr => keyOf(pr) === author)
  if (own.length > perAuthor) {
    output.problems.push(problem('cap', `"${author}" would have ${own.length} open pull requests, over ${perAuthor} per author: ${own.map(pr => pr.number === null ? 'this one' : `#${pr.number}`).join(', ')}.`, `${capFix} A dispatched agent names its lane in brackets on the Author line, as in "codex (phase1)".`))
  }
  return output
}

const dayMs = 24 * 60 * 60 * 1000
// "Claim taken over:" is a claim too (CONTRIBUTING.md rule 3), as the team's claimed() reads it.
const isClaimComment = comment => /^\s*Claim(?: taken over)?:/i.test(comment.body ?? '')
const loginOf = comment => (typeof comment.user?.login === 'string' ? comment.user.login : null)
const writtenAt = comment => Date.parse(comment.created_at ?? '')
// Whether comment a came before comment b: by creation time, else by place in the list (GitHub lists oldest first).
const isBefore = (comments, a, b) => {
  const [first, second] = [writtenAt(a), writtenAt(b)]
  return Number.isFinite(first) && Number.isFinite(second) && first !== second ? first < second : comments.indexOf(a) < comments.indexOf(b)
}

// A person may follow the branch name with more punctuation than the Author line does.
const claimBoundary = '[\\s`\'",:;()!?*<>\\[\\].]'

// When a claim runs out: its "until" time, "2026-10-28 21:04 UTC" or "2026-10-28T21:04Z" (always read as UTC).
// "waiting for a slot" runs out 7 days after its comment and a claim with no readable time after 2, the longest rule 3
// allows; a comment with no date counts as still live.
const claimEnd = comment => {
  const until = String(comment.body).match(/\buntil\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/i)
  if (until) return Date.UTC(Number(until[1]), Number(until[2]) - 1, Number(until[3]), Number(until[4]), Number(until[5]))
  const written = writtenAt(comment)
  return Number.isFinite(written) ? written + (/waiting for a slot/i.test(comment.body) ? 7 : 2) * dayMs : Infinity
}

// The claim an outside pull request needs: a comment starting "Claim:" that the author wrote from their own login and
// that names the branch, and no other login that claimed the issue earlier and still holds a live claim (rule 3: the
// earlier claim wins, so a claim another login posts after the author's own does not block). The author's own claim
// running out while the pull request is open is not a failure. A Handover: comment ends its writer's claim.
export const outsideClaim = ({ comments, login, branch, issue = null, now = Date.now() }) => {
  const output = result()
  const on = issue === null ? '' : ` on #${issue}`
  if (typeof login !== 'string' || !login) {
    output.problems.push(problem('claim', "the pull request author's GitHub login is unknown, so the claim cannot be checked.", 're-run the check; it reads the login from the pull request.'))
    return output
  }
  const own = login.toLowerCase()
  const ownClaim = comments.find(comment => isClaimComment(comment) && loginOf(comment)?.toLowerCase() === own && namesBranch(comment.body, branch, claimBoundary))
  if (!ownClaim) {
    output.problems.push(problem('claim', `no comment${on} starting "Claim:" from ${login} names this branch.`, `comment${on} from your own GitHub account "Claim: <agent>, <branch>, until <YYYY-MM-DD HH:MM> UTC" before starting work; a claim another login wrote does not count.`))
  }
  // Each other login's latest claim sets when it runs out; isEarlier says it claimed the issue before the author did.
  const held = new Map()
  for (const comment of comments) {
    const who = loginOf(comment)?.toLowerCase()
    if (!who || who === own) continue
    // An earlier claim carries over to a renewal only if it had not run out by then; one that had is over and the new claim is a new one.
    if (isClaimComment(comment)) {
      const prev = held.get(who)
      held.set(who, { comment, isEarlier: (prev?.isEarlier && !(claimEnd(prev.comment) <= writtenAt(comment))) || !ownClaim || isBefore(comments, comment, ownClaim) })
    } else if (/^\s*Handover:/i.test(comment.body ?? '')) held.delete(who)
  }
  const holders = [...held.values()].filter(item => item.isEarlier && claimEnd(item.comment) > now).map(item => loginOf(item.comment))
  if (holders.length) {
    output.problems.push(problem('claim', `${holders.join(', ')} ${holders.length === 1 ? 'holds' : 'hold'} a live claim${on}.`, 'take an issue nobody holds, or wait until that claim runs out; do not start a competing pull request, comment on theirs (CONTRIBUTING.md rule 3).'))
  }
  return output
}

// An outside author takes an issue labelled ready and for-agent, and not blocked.
export const outsideIssue = (issueData, number) => {
  const output = result()
  const labels = (Array.isArray(issueData.labels) ? issueData.labels : []).map(label => String(labelName(label)).toLowerCase())
  const missing = ['ready', 'for-agent'].filter(name => !labels.includes(name))
  if (missing.length) {
    output.problems.push(problem('issue', `#${number} is not labelled ${missing.map(name => `"${name}"`).join(' and ')}.`, 'take an open issue labelled "ready" and "for-agent", or open an issue and say you would like to take it (CONTRIBUTING.md, Outside contributors).'))
  }
  if (labels.includes('blocked')) {
    output.problems.push(problem('issue', `#${number} is labelled "blocked".`, 'take an issue that is not blocked (CONTRIBUTING.md rule 3).'))
  }
  return output
}

// Changelog fragments and the two generated files are not the author's lines to review.
const isGeneratedPath = path => path.startsWith('changelog.d/') || path === 'hooks/board-script.ts' || path === 'hooks/released.ts'
const isOutsideGovernance = path => path === 'AGENTS.md' || path === 'CONTRIBUTING.md' || path === 'package.json' || path.startsWith('.github/') || path.startsWith('.claude-plugin/')

// Notes for the reviewer, never a failure: a large change, and a change to a file the maintainer looks at first.
// numstat: { path, added, deleted } for each changed file; without it the size is not judged.
export const outsideNotes = ({ paths = [], numstat }) => {
  const output = result()
  const ask = 'ask on the issue first (CONTRIBUTING.md, Outside contributors)'
  if (Array.isArray(numstat)) {
    const counted = numstat.filter(item => !isGeneratedPath(item.path))
    const lines = counted.reduce((sum, item) => sum + item.added + item.deleted, 0)
    if (lines > OUTSIDE_NOTE_LINES || counted.length > OUTSIDE_NOTE_FILES) {
      output.info.push(`outside note: ${lines} changed lines in ${counted.length} ${counted.length === 1 ? 'file' : 'files'} (changelog fragments and generated files not counted) is more than about ${OUTSIDE_NOTE_LINES} lines or ${OUTSIDE_NOTE_FILES} files; ${ask}.`)
    }
  }
  const governed = paths.filter(isOutsideGovernance)
  if (governed.length) {
    output.info.push(`outside note: this pull request changes ${governed.slice(0, 5).join(', ')}${governed.length > 5 ? ` and ${governed.length - 5} more` : ''}; ${ask}.`)
  }
  return output
}

const tokenPatterns = [
  /[?&#](?:t|token|access_token|key)=[A-Za-z0-9_\-.~%]{16,}/g,
  /\bBearer\s+[A-Za-z0-9_\-.=]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
]
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const homePattern = /(?:[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}|\/(?:Users|home)\/)([^\\/\s"'`]+)/gi
// A web address, such as https://github.com/users/<name>, is not a home folder; file:///home/…,
// ssh://host/home/… and vscode-remote://wsl+Ubuntu/home/… still are.
const webAddress = /\bhttps?:\/\/[^\s"'`/][^\s"'`]*/gi
// ana and li are the made-up people of docs/preview/samples.ts.
const placeholders = new Set(['you', 'me', 'user', 'username', 'name', 'example', 'jane', 'john', 'alice', 'bob', 'ana', 'li', 'someone', 'runner', '...', '…'])
const safeText = text => {
  let safe = String(text).replace(uuidPattern, '<session-id>').replace(homePattern, '<home>')
  for (const pattern of tokenPatterns) safe = safe.replace(pattern, '<redacted token>')
  return safe.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

export const privateData = ({ added, body }) => {
  const output = result()
  const entries = [
    ...added.filter(item => /\.(md|svg|html)$/i.test(item.path) || item.path.startsWith('docs/')),
    ...linesOf(body).map((text, index) => ({ path: null, line: index + 1, text })),
  ]
  for (const { path, line, text } of entries) {
    const location = path ? `${safeText(path)} line ${line}` : `body line ${line}`
    const add = (kind, fix) => output.problems.push(problem('private-data', `${kind} in ${location}.`, fix))
    if ([...text.matchAll(uuidPattern)].some(match => new Set(match[0].replace(/-/g, '').toLowerCase()).size > 2)) {
      add('session id', 'use a placeholder such as <session-id>; a made-up id of repeated digits, such as 00000000-0000-0000-0000-000000000001, also passes.')
    }
    if ([...text.replace(webAddress, ' ').matchAll(homePattern)].some(match => !placeholders.has(match[1].toLowerCase()) && !/^[<$%]/.test(match[1]))) {
      add('home-folder path', 'use ~ or <home> instead of a personal home folder.')
    }
    if (tokenPatterns.some(pattern => [...text.matchAll(pattern)].length > 0)) {
      add('token or token link', 'remove it, and revoke the token if it was real.')
    }
    if (path && /\.svg$/i.test(path) && /data:image\/(png|jpe?g|gif|webp)/i.test(text)) {
      add('embedded bitmap image', 'draw the SVG from synthetic data with docs/preview/render.ts instead.')
    }
  }
  const imageFix = 'use only pictures drawn from made-up data, and start the alt text with "Synthetic".'
  for (const match of body.matchAll(/!\[([^\]]*)\]\([^)]*\)|<img\b[^>]*>/gi)) {
    const attribute = [...match[0].matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)].find(item => item[1].toLowerCase() === 'alt')
    const alt = match[1] ?? attribute?.slice(2).find(value => value !== undefined)
    if (!alt || !/synthetic/i.test(alt)) {
      const line = linesOf(body.slice(0, match.index)).length
      output.problems.push(problem('private-data', `image without synthetic alt text in body line ${line}.`, imageFix))
    }
  }
  return output
}

// Judged by name, not by git's binary guess, which a .gitattributes line in the pull request could change.
export const binaryImages = paths => {
  const output = result()
  for (const path of paths) {
    if (/\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(path) && !/^docs\/images\/social-preview[^/]*\.png$/.test(path)) {
      output.problems.push(problem('images', `binary image added or changed: ${safeText(path)}.`, 'README pictures must be SVGs drawn by docs/preview/render.ts (CONTRIBUTING.md, Images).'))
    }
  }
  return output
}

export const reviewOf = body => {
  const match = (body ?? '').match(/^Review:\s*(APPROVE|REQUEST CHANGES)\s+`?([0-9a-fA-F]{7,40})\b/m)
  return match ? { kind: match[1], sha: match[2].toLowerCase() } : null
}

export const verdict = (comments, head) => {
  const output = result()
  const last = comments.map(comment => reviewOf(comment.body)).filter(Boolean).at(-1)
  if (!last) output.info.push('review: no review verdict yet.')
  else output.info.push(`review: ${last.kind} for ${last.sha.slice(0, 7)}, ${head.startsWith(last.sha) ? 'the current head.' : 'an older head; the current head has no verdict yet.'}`)
  return output
}

export const checkPr = data => {
  const output = result()
  const add = checked => {
    output.problems.push(...checked.problems)
    output.info.push(...(checked.info ?? []))
  }
  // Only the pull request's own association is read here; an unknown one is the team (a local --body-file run).
  const isOutside = isOutsideAssociation(data.association)
  // The small docs lane is for outside pull requests; the team's rules do not change.
  const isSmallDocs = isOutside && isSmallDocsFix(data)
  const issue = issueLine(data.body, data.title, { isOptional: isSmallDocs })
  const author = authorLine(data.body, data.branch)
  const isRelease = isReleaseTitle(data.title)
  add(issue)
  add(author)
  if (isOutside && isRelease) {
    output.problems.push(problem('outside', 'a release pull request comes from the maintainer, not from outside the team.', 'open a fix or feature pull request; only the maintainer raises the version (CONTRIBUTING.md, Releases).'))
  }
  add(naming(data.title, data.branch))
  add(sections(data.body, data.template))
  add(changelog({ text: data.changelogText, added: data.added, paths: data.paths, addedPaths: data.addedPaths, headPaths: data.headPaths, issue: issue.issue, issues: issue.issues, titles: testTitles(data.testFiles), isRelease, isDocsOnly: data.paths.every(path => path.endsWith('.md') || /^(docs|\.github)\//.test(path)), isRequired: /^(feat|fix)[(!:]/.test(data.title) }))
  add(privateData({ added: data.added, body: data.body }))
  add(binaryImages(data.changedPaths))
  if (issue.issue !== null) {
    // The first issue is read from issueData and issueComments; each further one from moreIssues[number].
    const lookups = [...new Set(issue.issues)].map((number, index) => {
      const found = index === 0 ? data : data.moreIssues?.[number]
      return { number, issueData: found?.issueData, issueComments: found?.issueComments }
    })
    // false: GitHub answered that the issue does not exist; null (or no lookup): not looked up (offline).
    if (lookups.some(item => (item.issueData ?? null) === null)) output.info.push('issue status: skipped (offline).')
    for (const { number, issueData } of lookups) {
      if (issueData === false) {
        output.problems.push(problem('issue', `issue #${number} does not exist in this repository.`, 'use the number of an open issue covering this change.'))
      } else if (issueData && ('pull_request' in issueData || issueData.state !== 'open')) {
        output.problems.push(problem('issue', `#${number} must be an open issue, not a pull request or a closed issue.`, 'use the number of an open issue covering this change.'))
      }
    }
    if (isSmallDocs) output.info.push('claim: a small docs fix needs none.')
    else {
      if (lookups.some(item => (item.issueComments ?? null) === null)) output.info.push('claim: skipped (offline).')
      // An outside author's claim is judged by the login that wrote it, so the Author line's name does not enter.
      for (const { number, issueData, issueComments } of lookups) {
        if (!issueComments || issueData === false) continue
        const more = lookups.length > 1 ? number : null
        add(isOutside ? outsideClaim({ comments: issueComments, login: data.login, branch: data.branch, issue: more, now: data.now }) : claimed(issueComments, author.agent, data.branch, more))
      }
      if (isOutside) for (const { number, issueData } of lookups) if (issueData) add(outsideIssue(issueData, number))
    }
  }
  if (data.open === null) output.info.push('cap: skipped (offline).')
  else if (!isOutside && (isRelease || data.paths.some(isGovernancePath) || data.labels?.some(label => labelName(label) === 'cap-exempt'))) output.info.push('cap: this pull request is exempt.')
  else add(cap({ open: data.open, number: data.number, body: data.body, isOutside, login: data.login }))
  if (isOutside) add(outsideNotes({ paths: data.paths, numstat: data.numstat }))
  if (data.prComments === null) output.info.push('review: skipped (offline).')
  else add(verdict(data.prComments, data.head))
  if (data.isDraft) output.info.push(`draft: the reviewer starts when you run \`gh pr ready ${data.number}\` and comment \`Ready for review ${data.head}\`.`)
  return output
}

// Each message is one line, so text from a pull request cannot start a line of its own. GitHub Actions
// also reads the older "##[" commands anywhere in a line; main's ::stop-commands:: wrapper covers those.
const oneLine = text => String(text).replace(/[\r\n\u2028\u2029\u0085]+/g, ' ')

export const report = ({ problems, info }, header) => safeText([
  `pr-check: ${oneLine(header)}`,
  ...problems.flatMap(item => [`FAIL ${oneLine(item.check)}: ${oneLine(item.message)}`, `     Fix: ${oneLine(item.fix)}`]),
  ...info.map(item => `info ${oneLine(item)}`),
  problems.length ? `pr-check: ${problems.length} problem${problems.length === 1 ? '' : 's'}` : 'pr-check: all checks passed',
].join('\n'))

const markdownText = text => safeText(text).replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]).replace(/[\\`*_[\]{}()#+.!|~-]/g, '\\$&').replace(/\r?\n/g, ' ')

export const reportMarkdown = ({ problems, info }, header) => [
  `## pr-check: ${markdownText(header)}`,
  '',
  ...problems.flatMap(item => [`- **FAIL ${markdownText(item.check)}:** ${markdownText(item.message)}`, `  - Fix: ${markdownText(item.fix)}`]),
  ...info.map(item => `- info ${markdownText(item)}`),
  '',
  problems.length ? `pr-check: ${problems.length} problem${problems.length === 1 ? '' : 's'}` : 'pr-check: all checks passed',
  '',
].join('\n')

const usage = `Usage:
  node scripts/pr-check.mjs --pr <N> [-R owner/repo] [--repo-dir <dir>]
  node scripts/pr-check.mjs --body-file <file> --title <title> [--base <ref>] [--repo-dir <dir>]
  node scripts/pr-check.mjs --event <file> [--repo-dir <dir>]

Options:
  --offline       Skip issue, claim, open-PR cap and review network checks
  --no-bundle     Skip the Bun board bundle check
  --help          Print this usage

Default repository: WenyuChiou/agent-board. Default base: origin/main.
Exit codes: 0 passed, 1 check problems, 2 usage or environment error.
`

const parseArgs = argv => {
  const options = {}
  const flags = new Set(['--offline', '--no-bundle', '--help'])
  const values = new Set(['--pr', '-R', '--repo-dir', '--body-file', '--title', '--base', '--event'])
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (Object.hasOwn(options, key)) throw new Error(`duplicate option ${key}`)
    if (flags.has(key)) options[key] = true
    else if (values.has(key) && argv[i + 1] && !argv[i + 1].startsWith('-')) options[key] = argv[++i]
    else throw new Error(`unknown option or missing value: ${safeText(key)}`)
  }
  if (options['--help']) return options
  if (['--pr', '--body-file', '--event'].filter(key => options[key]).length !== 1) throw new Error('choose exactly one of --pr, --body-file or --event; use --help for usage.')
  if (options['--body-file'] ? !options['--title'] : options['--title'] || options['--base']) throw new Error('--body-file needs --title; --title and --base belong only to --body-file mode.')
  if (options['--pr'] && !/^[1-9]\d*$/.test(options['--pr'])) throw new Error('--pr must be a positive integer.')
  return options
}

const maxBuffer = 64 * 1024 * 1024
const command = (program, args, cwd) => {
  const executed = spawnSync(program, args, { cwd, encoding: 'utf8', maxBuffer })
  if (executed.error || executed.status !== 0) throw new Error(`${program} ${args[0]} failed${executed.error?.code ? ` (${executed.error.code})` : ''}.`)
  return executed.stdout
}
const git = (cwd, ...args) => command('git', args, cwd)
const readText = path => {
  try { return readFileSync(path, 'utf8') } catch { throw new Error('could not read the requested input file.') }
}
const readJson = text => {
  try { return JSON.parse(text) } catch { throw new Error('input or API response is not valid JSON.') }
}

// isList reads every page of a list; with isMissingAllowed, GitHub's "not found" or "gone" (404, 410)
// returns false rather than failing. run stands in for spawnSync in the tests.
export const apiReader = (options, repo, cwd, run = spawnSync) => async (path, { isList = false, isMissingAllowed = false } = {}) => {
  // No leading slash: Git for Windows' shell would turn "/repos/…" into a folder path before gh sees it.
  const endpoint = `repos/${repo}/${path}`
  const failed = () => new Error(`network check failed for ${endpoint}; ${options['--event'] ? 're-run the job' : '--offline skips those checks'}.`)
  if (!options['--event']) {
    // --jq prints one JSON value per line across all pages; --slurp would need gh 2.48 or later.
    const listed = `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100`
    const executed = run('gh', isList ? ['api', '--paginate', '--jq', '.[] | tojson', listed] : ['api', endpoint], { cwd, encoding: 'utf8', maxBuffer })
    if (!executed.error && executed.status !== 0 && isMissingAllowed && /\(HTTP (?:404|410)\)/.test(executed.stderr ?? '')) return false
    if (executed.error || executed.status !== 0) throw failed()
    try {
      return isList ? linesOf(executed.stdout).filter(line => line.trim()).map(line => JSON.parse(line)) : JSON.parse(executed.stdout)
    } catch {
      throw failed()
    }
  }
  try {
    const base = process.env.GITHUB_API_URL ?? 'https://api.github.com'
    const first = new URL(`${base.replace(/\/$/, '')}/${endpoint}`)
    first.searchParams.set('per_page', '100')
    let url = first
    const items = []
    const seen = new Set()
    while (url) {
      // A pagination response must never send the authorization token to another host.
      if (url.origin !== first.origin || seen.has(url.href)) throw new Error('invalid pagination link')
      seen.add(url.href)
      const response = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
        signal: AbortSignal.timeout(30000),
        redirect: 'error',
      })
      if ((response.status === 404 || response.status === 410) && isMissingAllowed) return false
      if (!response.ok) throw new Error('unsuccessful API response')
      const page = await response.json()
      if (!isList) return page
      if (!Array.isArray(page)) throw new Error('invalid API list')
      items.push(...page)
      const next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1]
      url = next ? new URL(next, url) : null
    }
    return items
  } catch {
    throw failed()
  }
}

// The pull request's own code runs here, so it gets no GitHub token; CI checks the bundle in test.yml instead.
const bundleIsCurrent = cwd => {
  const env = { ...process.env }
  delete env.GITHUB_TOKEN
  delete env.GH_TOKEN
  const args = ['--yes', 'bun@1.4.2', 'scripts/build-board.ts', '--check']
  const options = { cwd, env, encoding: 'utf8', maxBuffer, timeout: 300000 }
  let executed
  if (process.platform === 'win32') {
    // npx is a .cmd file on Windows and needs a shell; the full path beside node keeps the checkout's own files out of the lookup.
    const npx = join(dirname(process.execPath), 'npx.cmd')
    executed = spawnSync(`"${existsSync(npx) ? npx : 'npx.cmd'}" ${args.join(' ')}`, { ...options, shell: true })
  } else {
    executed = spawnSync('npx', args, options)
  }
  if (!executed.error && executed.status === 0) return true
  if (!executed.error && /out of date/.test(`${executed.stdout}${executed.stderr}`)) return false
  throw new Error('the bundle check could not finish (npx or Bun did not run); run "npx --yes bun@1.4.2 scripts/build-board.ts --check" yourself, or pass --no-bundle.')
}

const requireCommit = sha => {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error('pull request metadata needs full commit SHAs.')
}

export const main = async (argv = process.argv.slice(2)) => {
  // Windows would otherwise run a git.exe or gh.exe from the checked-out pull request before the real one.
  if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1'
  try {
    const options = parseArgs(argv)
    if (options['--help']) {
      console.log(usage)
      return 0
    }
    const cwd = resolve(options['--repo-dir'] ?? process.cwd())
    let repo = options['-R'] ?? 'WenyuChiou/agent-board'
    let data
    let base
    let baseRef
    if (options['--event']) {
      const event = readJson(readText(resolve(options['--event'])))
      const pr = event.pull_request
      if (!pr || !event.repository) throw new Error('event must contain pull_request and repository metadata.')
      repo = event.repository.full_name
      // author_association and user.login are in the event's pull_request; both stay undefined when it has none.
      data = { number: pr.number, title: pr.title, body: pr.body ?? '', branch: pr.head?.ref, head: pr.head?.sha, isDraft: pr.draft, labels: pr.labels, association: pr.author_association, login: pr.user?.login }
      base = pr.base?.sha
    } else if (options['--pr']) {
      let pr
      try {
        pr = readJson(command('gh', ['pr', 'view', options['--pr'], '-R', repo, '--json', 'number,title,body,headRefName,headRefOid,baseRefName,baseRefOid,isDraft,labels,author'], cwd))
      } catch {
        throw new Error('network check failed for gh pr view; use --body-file with --offline to check without GitHub.')
      }
      // gh pr view has no author_association field; it is read from the open pull request list below.
      data = { number: pr.number, title: pr.title, body: pr.body ?? '', branch: pr.headRefName, head: pr.headRefOid, isDraft: pr.isDraft, labels: pr.labels, login: pr.author?.login }
      base = pr.baseRefOid
      baseRef = pr.baseRefName
    } else {
      data = { number: null, title: options['--title'], body: readText(resolve(options['--body-file'])), branch: git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), head: git(cwd, 'rev-parse', 'HEAD').trim(), isDraft: false, labels: [] }
      base = git(cwd, 'merge-base', options['--base'] ?? 'origin/main', 'HEAD').trim()
    }
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repository must be owner/repo.')
    if (typeof data.title !== 'string' || typeof data.body !== 'string' || typeof data.branch !== 'string' || !Array.isArray(data.labels) || (data.number !== null && (!Number.isSafeInteger(data.number) || data.number < 1))) throw new Error('pull request metadata is incomplete or invalid.')
    requireCommit(base)
    requireCommit(data.head)
    const hasCommit = sha => {
      const checked = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, encoding: 'utf8', maxBuffer })
      if (checked.error) throw new Error('git cat-file failed to run.')
      return checked.status === 0
    }
    if (![base, data.head].every(hasCommit)) {
      if (options['--pr'] && !options['--offline']) {
        if (typeof baseRef !== 'string' || baseRef.startsWith('-')) throw new Error('invalid base branch in pull request metadata.')
        git(cwd, 'fetch', '--no-tags', 'origin', baseRef, `refs/pull/${data.number}/head`)
      } else throw new Error('base or head commit is missing locally; fetch both commits before checking.')
      if (![base, data.head].every(hasCommit)) throw new Error('base or head commit is still missing after git fetch.')
    }
    const range = `${base}...${data.head}`
    // --no-renames: a moved file counts as removed and added, so its old path and its new content are both judged.
    data.added = addedLines(git(cwd, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=0', range))
    data.paths = linesOf(git(cwd, 'diff', '--name-only', '--no-renames', range)).filter(Boolean).map(diffPath)
    data.changedPaths = linesOf(git(cwd, 'diff', '--name-only', '--no-renames', '--diff-filter=ACMRT', range)).filter(Boolean).map(diffPath)
    data.addedPaths = linesOf(git(cwd, 'diff', '--name-only', '--no-renames', '--diff-filter=A', range)).filter(Boolean).map(diffPath)
    // Lines added and removed in each file, for the size note on an outside pull request; a binary file shows "-".
    data.numstat = linesOf(git(cwd, 'diff', '--numstat', '--no-ext-diff', '--no-renames', range)).filter(Boolean).map(line => {
      const [added, deleted, ...name] = line.split('\t')
      return { path: diffPath(name.join('\t')), added: Number(added) || 0, deleted: Number(deleted) || 0 }
    }).filter(item => item.path)
    data.template = git(cwd, 'show', `${base}:.github/pull_request_template.md`)
    const headPaths = new Set(linesOf(git(cwd, 'ls-tree', '-r', '--name-only', data.head)).filter(Boolean).map(diffPath))
    data.headPaths = headPaths
    data.changelogText = headPaths.has('CHANGELOG.md') ? git(cwd, 'show', `${data.head}:CHANGELOG.md`) : ''
    data.testFiles = linesOf(git(cwd, 'ls-tree', '-r', '--name-only', data.head, '--', 'tests')).filter(path => /\.test\.(mjs|ts|tsx)"?$/.test(path)).map(diffPath).map(path => ({ path, text: git(cwd, 'show', `${data.head}:${path}`) }))
    data.issueData = null
    data.issueComments = null
    data.open = null
    data.prComments = null
    if (!options['--offline']) {
      const api = apiReader(options, repo, cwd)
      const [first, ...more] = [...new Set(issueLine(data.body, data.title).issues)]
      const lookup = async number => {
        const issueData = await api(`issues/${number}`, { isMissingAllowed: true })
        return { issueData, issueComments: issueData === false ? [] : await api(`issues/${number}/comments`, { isList: true }) }
      }
      if (first !== undefined) {
        Object.assign(data, await lookup(first))
        data.moreIssues = {}
        for (const number of more) data.moreIssues[number] = await lookup(number)
      }
      const open = []
      for (const pr of await api('pulls?state=open', { isList: true })) {
        // An outside pull request has no governance exemption, so its files are not listed.
        const isOutside = isOutsideAssociation(pr.author_association)
        const files = isOutside ? [] : await api(`pulls/${pr.number}/files`, { isList: true })
        open.push({ number: pr.number, title: pr.title, body: pr.body ?? '', createdAt: pr.created_at, labels: pr.labels, isGovernance: files.some(file => isGovernancePath(file.filename)), isOutside, association: pr.author_association, login: pr.user?.login ?? null })
      }
      data.open = open
      const own = open.find(pr => pr.number === data.number)
      if (own) {
        data.association ??= own.association
        data.login ??= own.login ?? undefined
      }
      data.prComments = data.number === null ? [] : await api(`issues/${data.number}/comments`, { isList: true })
    }
    const checked = checkPr(data)
    if (needsBundle(data.paths)) {
      if (options['--event']) checked.info.push('bundle: checked by test.yml ("Board bundle up to date").')
      else if (options['--no-bundle']) checked.info.push('bundle: skipped (--no-bundle).')
      else if (git(cwd, 'rev-parse', 'HEAD').trim() !== data.head) checked.info.push('bundle not checked: check out the pull request\'s head.')
      // A checkout that converts line endings (core.autocrlf, eol=crlf) writes the bundle with CRLF,
      // and the bundle check would fail on a current bundle; so the file itself is looked at.
      else if (existsSync(join(cwd, 'hooks', 'board-script.ts')) && readFileSync(join(cwd, 'hooks', 'board-script.ts'), 'utf8').includes('\r\n')) checked.info.push('bundle not checked: hooks/board-script.ts has CRLF line endings in this checkout; CI checks the bundle, or clone with -c core.autocrlf=false.')
      else if (bundleIsCurrent(cwd)) checked.info.push('bundle: board bundle is current.')
      else checked.problems.push(problem('bundle', 'hooks/board-script.ts is out of date.', 'run "npx --yes bun@1.4.2 scripts/build-board.ts" and commit hooks/board-script.ts with the source change.'))
    }
    const header = `${data.number === null ? 'new pull request' : `#${data.number}`} ${data.branch} at ${data.head.slice(0, 7)}`
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, reportMarkdown(checked, header)) } catch { throw new Error('could not append the GitHub step summary.') }
    }
    const printed = report(checked, header)
    if (options['--event']) {
      // GitHub Actions reads no command of either syntax until this random token comes back; the error
      // messages printed outside it are fixed text and numbers, never pull request text.
      const token = randomBytes(16).toString('hex')
      console.log(`::stop-commands::${token}\n${printed}\n::${token}::`)
    } else {
      console.log(printed)
    }
    return checked.problems.length ? 1 : 0
  } catch (error) {
    console.error(`pr-check: ${oneLine(safeText(error.message))}`)
    return 2
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
