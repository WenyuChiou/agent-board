import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fragmentIssue, isFragmentPath, titleCommitNumbers } from './changelog-fold.mjs'
import { bundleFiles, isBundleFile } from './bundle-text.mjs'

// Pull requests from outside the team (CONTRIBUTING.md, Outside contributors; #482): two open per GitHub login and
// four in all. The team has no limit on open pull requests (#607).
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
// A team pull request titled chore(changelog): shortens every fragment to one line under Unreleased and removes it.
const isFoldTitle = title => /^chore\(changelog\):/.test(title)
// The type is read as rule 6 reads it for the CHANGELOG: the word before "(", "!" or ":".
const isFixTitle = title => /^fix[(!:]/.test(title)
const linesOf = text => text.split(/\r?\n/)

// The owner's agents all post as the OWNER, so only another association is outside; an association that is not
// known (a local --body-file run) reads as the team and changes nothing.
export const isOutsideAssociation = association => typeof association === 'string' && association.trim() !== '' && !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association.trim().toUpperCase())
const isKnownAssociation = association => typeof association === 'string' && association.trim() !== ''

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
  const output = { issue: null, kind: null, issues: [], items: [], ...result() }
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
  output.items = listed
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

const linkedIssues = body => {
  const items = []
  for (const line of linesOf(stripComments(body ?? '')).map(text => text.trim()).filter(Boolean)) {
    const match = line.match(/^(Fixes|Closes|Resolves|Part of)\s+#(\d+)\b/i)
    if (!match) break
    items.push({ number: Number(match[2]), kind: match[1].toLowerCase() === 'part of' ? 'part of' : 'fixes' })
  }
  return items
}

// Two open pull requests must not both claim to fix the same issue (#1240 and #1213 on #1203).
// Only the later pull request (later createdAt, or higher PR number) is flagged; the original stays unflagged.
// "Part of #N" marks split steps that share a parent issue (#209), so those are left alone.
export const duplicatePr = ({ body = '', title = '', number = null, branch = null, head = null, createdAt = null, open = [] } = {}) => {
  const output = result()
  if (isReleaseTitle(title) || open === null || open === undefined) return output
  const fixing = [...new Set(issueLine(body, title).items.filter(item => item.kind === 'fixes').map(item => item.number))]
  if (!fixing.length) return output
  // A local run (--body-file) has no number. Its own open pull request is the one at its head commit and on its branch, else
  // the one at its head commit (the local branch name may differ), else the one on its branch (commits not pushed yet), so a
  // fork reusing the branch name, or another pull request at the same commit, still counts (#1348). When more than one fits
  // equally (two forks with one branch name and one commit), the run says it cannot tell, skips them all and compares from the
  // earliest, so it never flags its own; the check on the pull request has the number. With none yet, every open one is earlier.
  const atHead = number === null && head ? open.filter(other => other?.headSha === head) : []
  const atHeadOnBranch = atHead.filter(other => branch && other?.headRef === branch)
  const onBranch = number === null && branch ? open.filter(other => other?.headRef === branch) : []
  const candidates = (atHeadOnBranch.length ? atHeadOnBranch : atHead.length ? atHead : onBranch)
    .slice().sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
  const own = candidates[0] ?? null
  if (candidates.length > 1) output.info.push(`duplicate-pr: open pull requests ${candidates.map(other => `#${other.number}`).join(', ')} all match this branch or head commit, so this run cannot tell which is its own; the check on the pull request decides.`)
  const selfNumber = number ?? own?.number ?? null
  const selfCreated = createdAt ?? own?.createdAt ?? null
  const selfTime = selfCreated ? Date.parse(selfCreated) : NaN
  const reported = new Set()
  for (const other of open) {
    if (!other || candidates.includes(other) || (selfNumber !== null && other.number === selfNumber)) continue
    if (selfNumber !== null) {
      const otherTime = other.createdAt ? Date.parse(other.createdAt) : NaN
      const isOtherEarlier = Number.isFinite(selfTime) && Number.isFinite(otherTime) && selfTime !== otherTime
        ? otherTime < selfTime
        : typeof other.number === 'number' && other.number < selfNumber
      if (!isOtherEarlier) continue
    }
    const otherFixing = new Set(linkedIssues(other.body ?? '').filter(item => item.kind === 'fixes').map(item => item.number))
    for (const issueNumber of fixing) {
      if (!otherFixing.has(issueNumber)) continue
      const key = `${issueNumber}:${other.number}`
      if (reported.has(key)) continue
      reported.add(key)
      output.problems.push(problem(
        'duplicate-pr',
        `issue #${issueNumber} already has an open pull request #${other.number}.`,
        `finish or close #${other.number} first, or use "Part of #${issueNumber}" for an agreed split step (CONTRIBUTING rule 3).`,
      ))
    }
  }
  return output
}

const normalizeTitlePart = text => String(text ?? '')
  .toLowerCase()
  .replace(/[`'"]/g, '')
  .replace(/^[\s.,:;!?()[\]-]+|[\s.,:;!?()[\]-]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim()

export const issueTitleKeys = title => {
  const full = normalizeTitlePart(title)
  if (!full) return []
  const keys = new Set([full])
  const stripped = full.match(/^(?:bug|task|feat|fix|docs|test|refactor|chore|perf|ci|build|style|revert|rules)(?:\([^)]*\))?:\s*(.+)$/i)?.[1]
  const body = stripped ? normalizeTitlePart(stripped) : ''
  // Only match across prefixes when the descriptive title carries enough context on its own.
  if (body && body.length >= 16 && body.split(' ').length >= 3) keys.add(body)
  return [...keys]
}

// GitHub's /issues endpoint includes pull requests (which carry pull_request); only open issues count here so a pull
// request sharing its own issue's title (#1259 and #1257) never reads as a duplicate issue.
export const duplicateIssue = ({ title = '', number = null, action = null, openIssues = [] } = {}) => {
  const output = result()
  const keys = new Set(issueTitleKeys(title))
  if (!keys.size || openIssues === null || openIssues === undefined) return output
  for (const existing of openIssues) {
    if (!existing || existing.pull_request) continue
    if (existing.number === number) continue
    // On an edited event, check newer open issues too so renaming an older issue to match a newer one still flags (#1355).
    if (action !== 'edited' && number !== null && typeof existing.number === 'number' && existing.number >= number) continue
    if (existing.state && existing.state !== 'open') continue
    if (issueTitleKeys(existing.title).some(key => keys.has(key))) {
      output.problems.push(problem(
        'duplicate-issue',
        `open issue #${existing.number} already has a matching title.`,
        `comment on #${existing.number} instead of opening a second issue, or rename this issue if it covers a separate problem (docs/dev/team-process.md).`,
      ))
    }
  }
  return output
}

// A lane that files a finding marks it, with a title starting `Finding:` or `[finding]` (after an optional `type(scope):`) or
// with --finding, and links the pull request it came from (#1325). Only that structure counts, never the body's wording: two
// review rounds of #1348 showed prose cues reading ordinary reports as findings and colours as pull request links.
export const findingLink = ({ title = '', body = '', number = null, repo = null, isFinding = false } = {}) => {
  const output = result()
  const hasFindingTitle = /^\s*(?:[a-z]+(?:\([^)]*\))?!?:\s*)?(?:\[\s*finding\s*\]|finding\s*:)/i.test(String(title ?? ''))
  if (!isFinding && !hasFindingTitle) return output
  const clean = stripComments(body ?? '')
  // The answer may itself start with #, as the form's placeholder `#1299` does; only the next heading, indented or not, ends
  // the section. Blank lines may be CRLF, as a body edited on the web is.
  const fromPrSection = clean.match(/^#{2,3}[ \t]*Pull request it came from(?:[ \t]*\r?\n)+(?![ \t]*#{1,6}[ \t])([^\r\n]+)/im)?.[1]?.trim() ?? ''
  // Standalone Fixes/Part of lines are left out, so "Part of #209" does not stand in for the source pull request.
  const withoutLeadingIssues = linesOf(clean).filter(line => !/^\s*(?:Fixes|Part of|Closes|Resolves)\s+#\d+\b/i.test(line)).join('\n')
  // A source is a pull request URL, #N in the form's section, or "PR #N" / "pull request #N": a bare #N may be a colour or an issue.
  const validRef = pattern => [...withoutLeadingIssues.matchAll(pattern)].some(match => Number(match[1]) !== number)
  // A pull request address is the issue itself only in this repository; with no repository named, the same number counts as it.
  const isThisRepo = name => repo === null || name.toLowerCase() === String(repo).toLowerCase()
  const hasPullUrl = [...withoutLeadingIssues.matchAll(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/([1-9]\d*)\b/gi)]
    .some(match => !(Number(match[2]) === number && isThisRepo(match[1])))
  const hasSectionNumber = [...fromPrSection.matchAll(/(?:^|[^\w#])#([1-9]\d*)\b/g)].some(match => Number(match[1]) !== number)
  const hasExplicitPr = validRef(/\b(?:pull\s*request|pr)\s*#([1-9]\d*)\b/gi)
  if (hasPullUrl || hasSectionNumber || hasExplicitPr) return output

  output.problems.push(problem(
    'finding-link',
    'a finding filed by a lane must link the pull request it came from.',
    'link the source pull request in the issue body, for example "Found in PR #1299" or the pull request\'s address.',
  ))
  return output
}

export const checkIssue = ({ title = '', body = '', number = null, action = null, repo = null, association = null, openIssues = null, isFinding = false } = {}) => {
  const output = result()
  const add = next => {
    output.problems.push(...next.problems)
    output.info.push(...next.info)
  }
  if (openIssues === null) output.info.push('duplicate-issue: skipped (offline).')
  else add(duplicateIssue({ title, number, action, openIssues }))
  add(findingLink({ title, body, number, repo, association, isFinding }))
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
  // The weekly table and the review queue name the agent by the words before the comma, so a line without one would count as a new author each time.
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

// The release writes each fix and feature's CHANGELOG line from its pull request title, so a new pull request adds no
// fragment to changelog.d/. One opened before that change keeps its fragment, which the release folds in place of
// the title; a fragment already on main is not edited, except by the release or a chore(changelog): pull request
// that folds every fragment.
export const fragmentChanges = ({ paths = [], addedPaths = [], headPaths, isRelease, isFold = false }) => {
  const output = result()
  if (isRelease || isFold) {
    const who = isRelease ? 'the release' : 'the fold'
    const fix = isRelease ? 'run node scripts/changelog-fold.mjs <version> --write and include the fragment removals.' : 'shorten each remaining fragment to one line under ## Unreleased and remove it.'
    if (headPaths === undefined || headPaths === null) output.info.push('changelog: unfolded fragment check skipped; head tree listing is unavailable.')
    else if ([...headPaths].some(isFragmentPath)) output.problems.push(problem('changelog', `${who} leaves fragments unfolded in changelog.d/.`, fix))
    return output
  }
  const fresh = addedPaths.filter(isFragmentPath)
  for (const path of fresh) {
    if (fragmentIssue(path) === null) output.problems.push(problem('changelog', `invalid fragment name: ${path}.`, 'remove the fragment: the release writes this pull request\'s CHANGELOG line from its title (CONTRIBUTING rule 6).'))
    else output.info.push(`changelog: ${path} is kept as this pull request's entry; a new pull request adds no fragment (CONTRIBUTING rule 6).`)
  }
  for (const path of paths.filter(path => isFragmentPath(path) && !fresh.includes(path))) {
    output.problems.push(problem('changelog', `an existing fragment was edited or removed: ${path}.`, 'restore that fragment; only chore(release): pull requests fold existing fragments.'))
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

// isRequired: a fix or feature that edits CHANGELOG.md writes its own line under Unreleased, because the release
// then leaves its title out. Every other pull request needs no entry.
export const changelog = ({ text, added, issue, titles, isRelease, isFold = false, isDocsOnly, isRequired = true, paths = [], addedPaths = [], headPaths, title = '', releaseNumbers = [] }) => {
  const output = fragmentChanges({ paths, addedPaths, headPaths, isRelease, isFold })
  if (isFold) {
    output.info.push('changelog: Unreleased lines not checked for a pull request that folds the old fragments.')
    return output
  }
  if (isRelease) {
    const versionMatch = title.match(/(?:^|\s)v?(\d+\.\d+\.\d+)\b/)
    const version = versionMatch ? versionMatch[1] : null
    const lines = linesOf(text)
    const escapedVersion = version ? version.replace(/\./g, '\\.') : null
    const headingIndex = escapedVersion ? lines.findIndex(line => new RegExp(`^## ${escapedVersion}(?:\\s|$)`).test(line)) : -1
    if (headingIndex === -1) {
      if (releaseNumbers.length > 0) {
        output.problems.push(problem('changelog', version ? `CHANGELOG.md has no section for version ${version}.` : 'the release pull request title must name the version being released.', version ? `run node scripts/changelog-fold.mjs ${version} --write.` : 'name the version in the title, e.g. chore(release): 1.1.0.'))
        return output
      }
      output.info.push('changelog: skipped for a release pull request.')
      return output
    }
    const nextHeadingIndex = lines.findIndex((line, idx) => idx > headingIndex && /^## /.test(line))
    const sectionLines = lines.slice(headingIndex, nextHeadingIndex === -1 ? lines.length : nextHeadingIndex)
    const sectionText = sectionLines.join('\n')
    const sectionNumbers = new Set([...sectionText.matchAll(/#([1-9]\d*)\b/g)].map(m => Number(m[1])))
    const missing = releaseNumbers.filter(n => !sectionNumbers.has(n))
    if (missing.length > 0) {
      output.problems.push(problem(
        'changelog',
        `the release section for ${version} is missing pull request ${missing.map(n => `#${n}`).join(', ')}.`,
        `run node scripts/changelog-fold.mjs ${version} --write to include late merges before releasing.`
      ))
      return output
    }
    output.info.push(`changelog: release section for ${version} includes all ${releaseNumbers.length} merged fix and feature pull requests.`)
    return output
  }
  // A kept fragment must still fold at release: it names its own issue and its covering tests.
  for (const path of addedPaths.filter(path => fragmentIssue(path) !== null)) {
    const entry = added.filter(item => item.path === path).map(item => item.text).join('\n')
    output.problems.push(...changelogEntry({ entry, issue: fragmentIssue(path), titles, isDocsOnly, location: 'fragment' }).problems)
  }
  const lines = linesOf(text)
  const start = lines.findIndex(line => /^## Unreleased\s*$/.test(line))
  const next = lines.findIndex((line, index) => index > start && /^## /.test(line))
  const end = next === -1 ? lines.length : next
  const nonblank = added.filter(line => line.path === 'CHANGELOG.md' && line.text.trim())
  const inside = start === -1 ? [] : nonblank.filter(line => line.line > start + 1 && line.line <= end && !/^## /.test(line.text))
  const fromTitle = 'remove the CHANGELOG.md change, and the release writes the line from the pull request title'
  if (!inside.length && !isRequired) {
    output.info.push('changelog: no entry needed; the release writes the line from the pull request title.')
    return output
  }
  if (start === -1) {
    output.problems.push(problem('changelog', 'CHANGELOG.md has no Unreleased section.', `${fromTitle}, or add "## Unreleased" above the newest version heading and put the entry under it.`))
    return output
  }
  if (!inside.length) {
    const outside = nonblank.filter(line => line.line < start + 1 || line.line > end)
    const headings = [...new Set(outside.map(item => lines.slice(0, item.line).filter(line => /^## /.test(line)).at(-1) ?? 'the preamble'))]
    output.problems.push(problem('changelog', outside.length ? `the added entry landed under ${headings.join(', ')} instead of Unreleased.` : 'no entry was added under Unreleased.', outside.length ? `move the entry under "## Unreleased" at the top, or ${fromTitle}.` : `${fromTitle}, or add its line under Unreleased.`))
    return output
  }
  const checked = changelogEntry({ entry: inside.map(line => line.text).join('\n'), issue, titles, isDocsOnly })
  output.problems.push(...checked.problems)
  if (!checked.problems.length) output.info.push('changelog: Unreleased entry accepted; the release uses it in place of the title.')
  return output
}

export const needsBundle = paths => paths.some(path => /^(scripts|hooks)\//.test(path))

// Every agent posts from one GitHub account, so the weekly table and the review queue tell agents apart by the
// Author line: the words before its first comma, with a dispatching lane in brackets as part of the name.
export const authorKey = body => {
  const author = stripComments(body).match(/^Author:[ \t]*(.*)$/m)?.[1] ?? ''
  return author.split(',')[0].replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase() || null
}

const labelName = label => (typeof label === 'string' ? label : label.name)

// A reopened pull request keeps its creation time and would take a slot ahead of newer ones, so it is opened anew.
const outsideCapFix = 'wait until one of the open outside pull requests merges or closes, or close this one and open a new pull request from the same branch later; do not reopen the closed one, since GitHub keeps its first creation time and it would take a slot ahead of newer ones.'

// Only a pull request from outside the team (the author is not the owner, a member or a collaborator) is limited: two
// open per GitHub login and four in all, drafts included. The team has no limit (#607), so checkPr never calls this
// for a team pull request and a team pull request is not counted here. No exemption applies: a release, governance or
// cap-exempt pull request from outside takes a slot too.
export const cap = ({ open, number, login = null, perLogin = OUTSIDE_LOGIN_CAP, outsideTotal = OUTSIDE_TOTAL_CAP }) => {
  const output = result()
  // Older pull requests keep their slots: sort by creation and judge only this one's place.
  const counted = open.filter(pr => Boolean(pr.isOutside)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number)
  const self = counted.find(pr => pr.number === number) ?? { number, login }
  const queue = counted.includes(self) ? counted : [...counted, self]
  const ahead = queue.slice(0, queue.indexOf(self) + 1)
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

const dayMs = 24 * 60 * 60 * 1000
// "Claim taken over:" is a claim too (CONTRIBUTING.md rule 3).
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

// Changelog fragments and the generated files (the board bundle and its parts, the release table) are not the author's lines to review.
const isGeneratedPath = path => path.startsWith('changelog.d/') || isBundleFile(path) || path === 'hooks/released.ts'
// team-process.md holds the sections CONTRIBUTING rule 12 calls governance (From claim to merge, Standing approvals).
const isOutsideGovernance = path => path === 'AGENTS.md' || path === 'CONTRIBUTING.md' || path === 'docs/dev/team-process.md' || path === 'package.json' || path.startsWith('.github/') || path.startsWith('.claude-plugin/')

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
// An email address names a person (docs/dev/RULES.md, R8); git@, noreply addresses and the reserved example domains do not.
const emailPattern = /\b([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g
const isPlaceholderEmail = ([, local, domain]) => /^(?:git|no-?reply)$/i.test(local) || /^no-?reply\b/i.test(local) ||
  /(?:^|\.)(?:example\.(?:com|org|net)|example|invalid|test|localhost)$/i.test(domain) || /(?:^|\.)users\.noreply\.github\.com$/i.test(domain)
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const homePattern = /(?:[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}|\/(?:Users|home)\/)([^\\/\s"'`]+)/gi
// A web address, such as https://github.com/users/<name>, is not a home folder; file:///home/…,
// ssh://host/home/… and vscode-remote://wsl+Ubuntu/home/… still are.
const webAddress = /\bhttps?:\/\/[^\s"'`/][^\s"'`]*/gi
const attachmentPrefix = 'https://github.com/user-attachments/assets/'
const attachmentIdPattern = new RegExp(`^(${uuidPattern.source})([)>]*)$`, 'i')
const publicAttachmentId = address => {
  if (!address.startsWith(attachmentPrefix)) return null
  return attachmentIdPattern.exec(address.slice(attachmentPrefix.length))?.[1] ?? null
}
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
    // A public screenshot's asset UUID is not a session. Other UUIDs on the same
    // line and every other privacy check still see their original text.
    const sessionText = text.replace(webAddress, address => {
      const id = publicAttachmentId(address)
      return id === null ? address : address.replace(id, '<attachment-id>')
    })
    if ([...sessionText.matchAll(uuidPattern)].some(match => new Set(match[0].replace(/-/g, '').toLowerCase()).size > 2)) {
      add('session id', 'use a placeholder such as <session-id>; a made-up id of repeated digits, such as 00000000-0000-0000-0000-000000000001, also passes.')
    }
    if ([...text.replace(webAddress, ' ').matchAll(homePattern)].some(match => !placeholders.has(match[1].toLowerCase()) && !/^[<$%]/.test(match[1]))) {
      add('home-folder path', 'use ~ or <home> instead of a personal home folder.')
    }
    if (tokenPatterns.some(pattern => [...text.matchAll(pattern)].length > 0)) {
      add('token or token link', 'remove it, and revoke the token if it was real.')
    }
    // Addresses inside a link count too: a link can carry one in its path or query.
    if ([...text.matchAll(emailPattern)].some(match => !isPlaceholderEmail(match))) {
      add('email address', 'use a GitHub login or a placeholder such as name@example.com; this repository is public (docs/dev/RULES.md, R8).')
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

// docs/dev/RULES.md is the one-page summary of these three files (its R5): a change to one of them changes it too,
// or the body says why not.
const rulesSources = ['CONTRIBUTING.md', 'docs/dev/team-process.md', 'docs/RELEASING.md']
export const rulesPage = ({ paths = [], body = '', headPaths }) => {
  const output = result()
  const changed = paths.filter(path => rulesSources.includes(path))
  if (!changed.length) return output
  // A deleted or renamed-away page is not a changed one; headPaths is unknown only where the tree cannot be listed.
  const isPresent = headPaths === undefined || headPaths === null || [...headPaths].includes('docs/dev/RULES.md')
  if (!isPresent) {
    output.problems.push(problem('rules-page', `${changed.join(', ')} changed, and docs/dev/RULES.md is not in the head.`, 'keep docs/dev/RULES.md, changed to match (docs/dev/RULES.md, R5).'))
    return output
  }
  if (paths.includes('docs/dev/RULES.md')) return output
  if (linesOf(stripComments(body)).some(line => /^\s*Rules page: unchanged, \S/.test(line))) {
    output.info.push('rules page: unchanged, with a reason in the body.')
    return output
  }
  output.problems.push(problem('rules-page', `${changed.join(', ')} changed, but docs/dev/RULES.md did not.`, 'change docs/dev/RULES.md to match, or add a body line "Rules page: unchanged, <reason>" (docs/dev/RULES.md, R5).'))
  return output
}

// The board's page is built by its own script in the browser, so render.ts cannot draw it: its README picture is a
// screenshot of the real page, one per README language, dark only.
const pageShot = /^docs\/images\/page-(en|zh-TW|zh-CN)-dark\.png$/
// Judged by name, not by git's binary guess, which a .gitattributes line in the pull request could change.
export const binaryImages = paths => {
  const output = result()
  for (const path of paths) {
    if (/\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(path) && !/^docs\/images\/social-preview[^/]*\.png$/.test(path) && !pageShot.test(path)) {
      output.problems.push(problem('images', `binary image added or changed: ${safeText(path)}.`, 'README pictures must be SVGs drawn by docs/preview/render.ts; the one exception is the page screenshot docs/images/page-<en|zh-TW|zh-CN>-dark.png (CONTRIBUTING.md, Images).'))
    }
  }
  return output
}

// A lane's own reviewer says so in the parentheses right after its name, as one of their comma-separated notes:
// `by codex (read-only, started new for this review), lane x` (RULES R2). Only that whole note counts, so a line
// that says "not started new for this review", or says it anywhere else, is not one.
const isFreshLine = line => {
  const notes = line.match(/[ \t]by[ \t]+[^\r\n(,]*\(([^)\r\n]*)\)/i)?.[1] ?? ''
  return notes.split(',').some(note => note.trim().toLowerCase() === 'started new for this review')
}

// On the light and normal tiers a reviewer the author's lane started new for this review may approve, whatever its
// name; on the risk tier, or with no tier named, a reviewer named like the author is the author approving (RULES R2).
export const isLaneReviewer = (review, tier) => review?.isFresh === true && (tier === 'light' || tier === 'normal')

const isBotUser = user => user?.type === 'Bot' || /\[bot\]$/i.test(user?.login ?? '')

export const reviewOf = item => {
  if (!item) return null
  const isBot = typeof item === 'object' && isBotUser(item.user)
  const body = typeof item === 'string' ? item : item.body ?? ''
  const match = body.match(/^Review:\s*(APPROVE|REQUEST CHANGES)\s+`?([0-9a-fA-F]{7,40})`?(?:[ \t]+by[ \t]+([^\r\n,]+))?/mi)
  if (match && !(match[1].toUpperCase() === 'APPROVE' && isBot)) {
    const reviewer = match[3]?.trim() || (typeof item === 'object' ? item.user?.login ?? null : null)
    const isFresh = isFreshLine(body.slice(match.index).split(/\r?\n/, 1)[0])
    return {
      kind: match[1].toUpperCase(),
      sha: match[2].toLowerCase(),
      ...(reviewer ? { reviewer } : {}),
      ...(isFresh ? { isFresh } : {}),
    }
  }
  if (!isBot && typeof item === 'object' && item.state === 'APPROVED' && item.commit_id) {
    const reviewer = item.user?.login ?? null
    return { kind: 'APPROVE', sha: item.commit_id.toLowerCase(), ...(reviewer ? { reviewer } : {}) }
  }
  if (typeof item === 'object' && item.state === 'CHANGES_REQUESTED' && item.commit_id) {
    const reviewer = item.user?.login ?? null
    return { kind: 'REQUEST CHANGES', sha: item.commit_id.toLowerCase(), ...(reviewer ? { reviewer } : {}) }
  }
  return null
}

// The tier the body names on its `Tier:` line (RULES R2), or null when it names none.
export const tierOf = body => stripComments(body ?? '').match(/^Tier:[ \t]*`?(risk|normal|light)\b/mi)?.[1].toLowerCase() ?? null

// A risk-tier pull request changes one failure surface and names it on a `Surface:` line (CONTRIBUTING rule 2, #1490).
// It applies to pull requests numbered above SURFACE_FROM, the issue (#1490) the rule and this check came in with; a local
// --body-file run has no number and is checked as new.
export const SURFACE_FROM = 1490
export const SURFACE_LINES = 300
const surfaceValues = ['delivery', 'setup-writes', 'data', 'wording', 'rules-text', 'launch']
const isRulesTextPath = path => ['SECURITY.md', 'AGENTS.md', 'CONTRIBUTING.md'].includes(path) || path.startsWith('docs/dev/')
const setupOnlyPaths = new Set(['scripts/setup-agent.mjs', 'scripts/setup-codex.mjs', 'scripts/setup-discovery.mjs', 'scripts/setup.sh', 'scripts/setup.ps1', 'scripts/install-control.ts', 'scripts/connect-transaction.ts', 'scripts/legacy-connect.ts', 'scripts/settings-agents.ts', 'hooks/settings-agents.ts', 'hooks/connect.ts', 'hooks/connect-pure.ts', 'hooks/connect-worker.ts'])
const isDeliveryPath = path => path.startsWith('hooks/receivers/') || ['hooks/messaging.ts', 'scripts/board-messaging.ts', 'scripts/message-client.mjs', 'scripts/codex-receiver.mjs'].includes(path)
// Not counted toward the size note: tests, generated files and the string tables.
const isUncountedForSurface = path => path.startsWith('tests/') || isGeneratedPath(path) || /^hooks\/strings-[^/]+\.ts$/.test(path) || path === 'hooks/i18n.ts'
// The body's lines as a reader sees them, so an example `Surface:` line is not read: no fenced code (``` or ~~~ after at most
// three spaces, closed only by a line of the same character at least as long, as CommonMark has it) and no HTML comment (an
// unclosed `<!--` hides the rest). A comment marker inside a fence or a code span on one line (`<!--`), and a fence marker
// inside a comment, are plain text. With isPlaceKept a fence line and each line inside it stay as null, so that two lines
// with a fence between them are not read as neighbours.
const visibleLines = (text, { isPlaceKept = false } = {}) => {
  const shown = []
  let fence = null
  let isComment = false
  for (const raw of text.split(/\r?\n/)) {
    if (fence !== null) {
      const close = raw.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1]
      if (close !== undefined && close[0] === fence[0] && close.length >= fence.length) fence = null
      if (isPlaceKept) shown.push(null)
      continue
    }
    const open = isComment ? undefined : raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1]
      if (isPlaceKept) shown.push(null)
      continue
    }
    let kept = ''
    let at = 0
    while (at < raw.length) {
      if (isComment) {
        const end = raw.indexOf('-->', at)
        if (end === -1) break
        at = end + 3
        isComment = false
        continue
      }
      const comment = raw.indexOf('<!--', at)
      const tick = raw.indexOf('`', at)
      if (tick !== -1 && (comment === -1 || tick < comment)) {
        // A code span: a run of backticks closed by a run of the same length later on the line; an unclosed run is text.
        const run = raw.slice(tick).match(/^`+/)[0]
        let close = -1
        for (let from = tick + run.length; from < raw.length;) {
          const next = raw.indexOf('`', from)
          if (next === -1) break
          const other = raw.slice(next).match(/^`+/)[0]
          if (other.length === run.length) { close = next; break }
          from = next + other.length
        }
        const end = close === -1 ? tick + run.length : close + run.length
        kept += raw.slice(at, end)
        at = end
        continue
      }
      if (comment === -1) {
        kept += raw.slice(at)
        break
      }
      kept += raw.slice(at, comment)
      at = comment + 4
      isComment = true
    }
    shown.push(kept)
  }
  return shown
}
// The tier as a reader sees it, for the surface check: a `Tier:` line outside fences and comments.
const visibleTier = body => visibleLines(body).map(line => line.match(/^Tier:[ \t]*`?(risk|normal|light)\b/i)?.[1].toLowerCase()).find(Boolean) ?? null
// The `Surface:` lines a reader sees: every value (found), and those that are filled in (the template's own
// `Surface: <...>` line is a placeholder, not a value).
const surfaceLine = body => {
  const found = visibleLines(body).flatMap(line => line.match(/^Surface:[ \t]*(.*)$/i)?.[1].trim() ?? [])
  return { found, filled: found.filter(value => value !== '' && !value.startsWith('<')) }
}
export const surface = ({ body = '', title = '', number = null, paths = [], numstat, tier = visibleTier(body) } = {}) => {
  const output = result()
  if (tier !== 'risk' || isReleaseTitle(title) || (number !== null && number <= SURFACE_FROM)) return output
  const fail = (message, fix) => output.problems.push(problem('surface', message, fix))
  const how = 'name the one failure surface on a line of its own in the body, for example `Surface: delivery` (delivery, setup-writes, data, wording, rules-text or launch, or `none` when the only reason for the tier is the lane under risk-tier review; CONTRIBUTING.md rule 2).'
  const { found, filled } = surfaceLine(body)
  if (filled.length > 1) {
    fail(`the body has ${filled.length} \`Surface:\` lines; it names its surface once.`, 'keep one `Surface:` line; put an example inside a code fence.')
    return output
  }
  const line = filled[0]
  if (!line) {
    fail(found.some(value => value.startsWith('<')) ? 'the `Surface:` line is still the template\'s placeholder.' : 'a risk-tier pull request has no `Surface:` line.', how)
    return output
  }
  const [named, ...reasonParts] = line.split(/,[ \t]*cannot split:/i)
  const reason = reasonParts.join(',').trim()
  if (reasonParts.length && (!reason || /^<[^<>]*>$/.test(reason))) {
    fail('the `Surface:` line says `cannot split:` with no reason, or only the template\'s `<reason>`.','write the reason after `cannot split:`, for the maintainer or the owner to accept or refuse before the first review.')
    return output
  }
  const values = named.split('+').map(value => value.replace(/`/g, '').trim().toLowerCase())
  // `none`: risk tier only because the lane is under risk-tier review, and no surface changed. It stands alone.
  const isNone = values.length === 1 && values[0] === 'none' && !reasonParts.length
  const unknown = isNone ? [] : values.filter(value => !surfaceValues.includes(value))
  if (unknown.length) {
    fail(`the \`Surface:\` line names ${unknown.map(value => `"${value || ' '}"`).join(', ')}, which is not a surface.`, how)
    return output
  }
  if (new Set(values).size < values.length) {
    fail('the `Surface:` line names the same surface twice.', how)
    return output
  }
  if (values.length > 2) {
    fail(`the \`Surface:\` line names ${values.length} surfaces; \`cannot split:\` covers two at most.`, 'split the change into one pull request per surface, or two with `cannot split: <reason>`.')
    return output
  }
  if (values.length > 1 && !reasonParts.length) {
    fail(`the \`Surface:\` line names ${values.length} surfaces without a reason.`, 'split the change into one pull request per surface; if a split would leave main broken between steps, end the line with `, cannot split: <reason>`.')
  }
  if (reasonParts.length) output.info.push(`surface: "cannot split: ${reason}" waits for the maintainer's or the owner's answer before the first review.`)
  if (paths.some(isRulesTextPath) && !values.includes('rules-text')) {
    fail('this pull request changes a rules or security file (SECURITY.md, AGENTS.md, CONTRIBUTING.md or docs/dev/) but its `Surface:` line is not `rules-text`.', 'put the rules-text change in its own pull request with `Surface: rules-text`.')
  }
  if (Array.isArray(numstat)) {
    const lines = numstat.filter(item => !isUncountedForSurface(item.path)).reduce((sum, item) => sum + item.added + item.deleted, 0)
    if (lines > SURFACE_LINES) output.info.push(`surface note: ${lines} changed lines (tests, generated files and string tables not counted) is more than about ${SURFACE_LINES}; check that this is still one surface.`)
  }
  if (values.includes('delivery') && !values.includes('setup-writes') && paths.some(path => setupOnlyPaths.has(path))) {
    output.info.push('surface note: `Surface: delivery`, but the diff touches setup files; check that this is not a setup-writes change.')
  }
  if (values.includes('setup-writes') && !values.includes('delivery') && paths.some(isDeliveryPath)) {
    output.info.push('surface note: `Surface: setup-writes`, but the diff touches message delivery files; check that this is not a delivery change.')
  }
  return output
}

// A risk-tier pull request on a surface that handles events arriving in any order lists its cases before the first push
// (CONTRIBUTING rule 2, RULES R6, #1503), and stops at ROUND_CAP review rounds. Both apply to pull requests numbered above
// CASES_FROM, the issue they came in with; a local --body-file run has no number and is checked as new.
export const CASES_FROM = 1503
export const ROUND_CAP = 5
const caseSurfaces = ['delivery', 'setup-writes', 'data', 'launch']
// The case table has one accepted form, the template's, and nothing else is read as a table (#1503):
//   | State | Event | Expected result | Test |     these four names in this order, in any letter case
//   |---|---|---|---|                               four cells of dashes, colons allowed
//   | <state> | <event> | <result> | <test> |       one line for each case: outer pipes, four cells, \| for a pipe in a cell
// The rows are the unbroken run of lines that start with a pipe. A blank line, a code fence, a comment on its own line or
// prose ends the table, and a line starting with a pipe after that fails, as any other shape does, with CASE_FORM as the fix.
const CASE_COLUMNS = ['state', 'event', 'expected result', 'test']
const CASE_FORM = 'write the table as the template has it: the header line "| State | Event | Expected result | Test |", the line "|---|---|---|---|", then one line for each case that starts and ends with "|" and has four cells. Write a pipe inside a cell as "\\|", keep blank lines, code fences, comments, prose and any second table out of the rows, and leave a blank line under the last row unless a heading or the end of the body comes next.'
// The cells of a line with outer pipes, split at each pipe that has no backslash before it; null for any other line.
const tableCells = line => {
  const parts = line.trim().split(/(?<!\\)\|/)
  if (parts.length < 3 || parts[0] !== '' || parts.at(-1) !== '') return null
  return parts.slice(1, -1).map(cell => cell.replace(/\\\|/g, '|').trim())
}
// A template placeholder such as <state>, or three dots, is an empty cell.
const isPlaceholderCell = cell => /^<[^<>]*>$/.test(cell) || /^(?:\.{3}|…)$/.test(cell)
// The table under a "## Cases" heading: { rows } with four cells a row, { error } when the section has pipes in any
// other shape than the accepted form, or null with no table at all.
const caseTable = body => {
  const lines = visibleLines(body, { isPlaceKept: true })
  const start = lines.findIndex(line => line !== null && /^ {0,3}##[ \t]+Cases[ \t]*#*[ \t]*$/i.test(line))
  if (start === -1) return null
  const end = lines.findIndex((line, i) => i > start && line !== null && /^ {0,3}#{1,6}[ \t]/.test(line))
  const section = lines.slice(start + 1, end === -1 ? undefined : end)
  const isRow = line => typeof line === 'string' && /^ {0,3}\|/.test(line)
  // The line under a table's header, with or without outer pipes ("--- | ---").
  const isRuleLine = line => typeof line === 'string' && /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/.test(line)
  const cellCount = line => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).length
  // As in GFM, a rule line starts a table only under a header line of as many cells ("a | b" over "--- | ---"):
  // another table, before or after this one. Under prose such as "Example:" it is prose.
  const isTableStart = (line, i) => isRuleLine(line) && typeof section[i - 1] === 'string' && section[i - 1].trim() !== '' && cellCount(section[i - 1]) === cellCount(line)
  const first = section.findIndex(isRow)
  // With no line that starts with a pipe, only a table GitHub shows (a rule line under a header) is one in the wrong
  // form; prose with a pipe in it is no table (#1520).
  if (first === -1) return section.some(isTableStart) ? { error: 'its lines do not start with "|"' } : null
  let last = first
  while (isRow(section[last])) last++
  if (section.slice(last).some(isRow)) return { error: 'a blank line, a code fence, a comment or prose splits its rows, or a second table follows it' }
  // On GitHub a line right under the last row can join the table as one more row, so a blank line, a heading or the end
  // of the section comes next (#1513).
  if (last < section.length && (typeof section[last] !== 'string' || section[last].trim() !== '')) return { error: 'the line right under its last row is not blank; on GitHub such a line can show as one more row' }
  if (section.some((line, i) => (i < first || i >= last) && isTableStart(line, i))) return { error: 'the section has a second table, with or without outer pipes' }
  const [header, rule, ...rows] = section.slice(first, last).map(tableCells)
  if (!header || header.length !== 4 || header.some((cell, i) => cell.toLowerCase() !== CASE_COLUMNS[i])) return { error: 'its header is not "| State | Event | Expected result | Test |"' }
  if (!rule || rule.length !== 4 || rule.some(cell => !/^:?-+:?$/.test(cell))) return { error: 'the line under its header is not "|---|---|---|---|"' }
  const odd = rows.findIndex(cells => !cells || cells.length !== 4)
  if (odd !== -1) return { error: `row ${odd + 1} ${rows[odd] ? `has ${rows[odd].length} cells where four are read` : 'does not start and end with "|"'}` }
  // `at` is the header row's place among visibleLines(body, { isPlaceKept: true }), the list cases() reads its line from.
  return { rows: rows.map(cells => cells.map(cell => isPlaceholderCell(cell) ? '' : cell)), at: start + 1 + first }
}
// The cells of each case-table row, or none when the body has no table in the accepted form; preflight reads the tests
// to run from the Test column (#1520).
export const caseRows = body => caseTable(body)?.rows ?? []
// From FAIL_FIRST_FROM on, each row names its test by its exact title in backticks, and a Ready pull request carries the
// `Fail-first:` line preflight prints for its head (CONTRIBUTING rules 2 and 8, #1520). A local --body-file run has no
// number and is checked as new.
export const FAIL_FIRST_FROM = 1520
const failFirstForm = /^(\d+) of (\d+) new or changed tests? fail on ([0-9a-f]{7,40}) and pass on ([0-9a-f]{7,40})\.?$/i
// The value of each `Fail-first:` line a reader sees (none in a code fence or a comment). Preflight reads a body with
// this too, so the two never disagree on whether a line is there.
export const failFirstValues = body => visibleLines(body).flatMap(text => {
  const match = text.match(/^[ \t]*(?:[-*][ \t]+)?(?:(?:PASS|WARN|FAIL)[ \t]+)?Fail-first:[ \t]*(.*)$/i)
  return match ? [match[1].trim()] : []
})
const failFirst = ({ body, rows, titles, head, isDraft, fail, output, isRequired = false }) => {
  // Where the surface requires the table, rows with no test are reported with the table's other checks.
  const untested = isRequired ? 0 : rows.filter(cells => !cells[3]).length
  if (untested) fail(`${untested} rows of the case table name no test.`, 'name in the Test column, in backticks, the title of the test for each row; on a draft, the title planned (CONTRIBUTING.md rule 2).')
  if (titles) {
    rows.forEach((cells, i) => {
      if (!cells[3]) return
      const spans = [...cells[3].matchAll(/`([^`\n]+)`/g)].map(match => match[1])
      if (spans.some(span => titleKnown(span, titles))) return
      if (isDraft) output.info.push(`cases: row ${i + 1} of the case table names no test of tests/ yet; name its exact title in backticks once the test is written.`)
      else fail(`row ${i + 1} of the case table names no test of tests/ in backticks.`, 'write the test\'s exact title in backticks in the Test column, as it is in tests/ at the head, with <name> for each variable of a template title; code beside it may stay (CONTRIBUTING.md rule 2).')
    })
  }
  // The line comes from the run on the head that will be reviewed, so a draft has none yet.
  if (isDraft) return
  const how = 'run `node scripts/preflight.mjs --body-file <file> --title <title>` on the head and paste its `Fail-first:` line under Checks, or write "Fail-first: none, <reason>" when no test the table names can fail without the change (CONTRIBUTING.md rule 8).'
  const found = failFirstValues(body)
  const lines = found.filter(value => value !== '' && !value.startsWith('<'))
  if (lines.length > 1) {
    fail(`the body has ${lines.length} \`Fail-first:\` lines; it gives one, for the head.`, 'keep the line preflight printed for the head; put an example inside a code fence.')
    return
  }
  if (!lines.length) {
    fail(`a Ready risk-tier pull request with a case table has no \`Fail-first:\` line.${found.some(value => value.startsWith('<')) ? ' The template\'s placeholder is still there.' : ''}`, how)
    return
  }
  const line = lines[0].replace(/`/g, '')
  const none = line.match(/^none\b[ \t]*,?[ \t]*(.*)$/i)
  if (none) {
    if (!none[1].trim() || /^<[^<>]*>$/.test(none[1].trim())) fail('the `Fail-first:` line says `none` with no reason.', 'write the reason after `none`, for example "Fail-first: none, the change is a sentence only a person can judge".')
    return
  }
  const counts = line.match(failFirstForm)
  if (!counts) {
    fail('the `Fail-first:` line is neither the line preflight prints nor "none, <reason>".', how)
    return
  }
  const [, counted, total, , passOn] = counts
  if (head && !head.toLowerCase().startsWith(passOn.toLowerCase())) fail(`the \`Fail-first:\` line is for ${passOn}, not the head ${head.slice(0, 8)}.`, 'run preflight again on the head and paste the line it prints.')
  if (Number(total) === 0) fail('the `Fail-first:` line counts no new or changed test.', 'name in the case table a new or changed test that fails without the change, or write "Fail-first: none, <reason>".')
  else if (Number(counted) !== Number(total)) fail(`the \`Fail-first:\` line says ${counted} of ${total}: a test it counts passes on the base too, fails here, or gave no verdict.`, 'fix or replace each test preflight names, so that it fails on the merge base and passes on the head, then run preflight again.')
}
export const cases = ({ body = '', title = '', number = null, tier = visibleTier(body), titles = null, head = null, isDraft = false } = {}) => {
  const output = result()
  if (tier !== 'risk' || isReleaseTitle(title) || (number !== null && number <= CASES_FROM)) return output
  const { filled } = surfaceLine(body)
  const named = filled.length === 1 ? filled[0].split(/,[ \t]*cannot split:/i)[0].split('+').map(value => value.replace(/`/g, '').trim().toLowerCase()) : []
  const on = named.filter(value => caseSurfaces.includes(value))
  const fail = (message, fix) => output.problems.push(problem('cases', message, fix))
  const isFailFirst = number === null || number > FAIL_FIRST_FROM
  // A case table the body has where none is required (another surface, or under `Cases: none`) is held to the same
  // tests, and to the form pr-check reads (#1520).
  const heldAnyway = () => {
    const table = isFailFirst ? caseTable(body) : null
    if (table?.error) fail(`the "## Cases" table is not in the form pr-check reads: ${table.error}.`, CASE_FORM)
    else if (table?.rows?.length) failFirst({ body, rows: table.rows, titles, head, isDraft, fail, output })
  }
  if (!on.length) {
    heldAnyway()
    return output
  }
  const how = 'write "Cases: <n> rows" above a "## Cases" table, or "Cases: none, <reason>" when the change handles no event that can arrive while another is under way (CONTRIBUTING.md rule 2).'
  // Each `Cases:` line is read once, its value with its place, so every later check reads the same line (Fable 5.2, #1514).
  const found = visibleLines(body, { isPlaceKept: true }).flatMap((text, at) => {
    const match = typeof text === 'string' ? text.match(/^Cases:[ \t]*(.*)$/i) : null
    return match ? [{ value: match[1].trim(), at }] : []
  })
  const lines = found.filter(({ value }) => value !== '' && !value.startsWith('<'))
  if (lines.length > 1) {
    fail(`the body has ${lines.length} \`Cases:\` lines; it names its cases once.`, 'keep one `Cases:` line; put an example inside a code fence.')
    return output
  }
  if (!lines.length) {
    fail(`a risk-tier pull request on ${on[0]} has no \`Cases:\` line.${found.some(({ value }) => value.startsWith('<')) ? ' The template\'s placeholder is still there.' : ''}`, how)
    return output
  }
  const line = lines[0].value.replace(/`/g, '')
  const none = line.match(/^none\b[ \t]*,?[ \t]*(.*)$/i)
  if (none) {
    if (!none[1].trim() || /^<[^<>]*>$/.test(none[1].trim())) fail('the `Cases:` line says `none` with no reason.', 'write the reason after `none`, for example "Cases: none, the change handles one event in one state".')
    heldAnyway()
    return output
  }
  const rows = line.match(/^(\d+)[ \t]+rows?\b/i)
  if (!rows) {
    fail('the `Cases:` line is neither "<n> rows" nor "none, <reason>".', how)
    return output
  }
  const table = caseTable(body)
  if (table?.error) {
    fail(`the "## Cases" table is not in the form pr-check reads: ${table.error}.`, CASE_FORM)
    return output
  }
  if (!table?.rows.length) {
    fail('the `Cases:` line names a table, but the body has no "## Cases" table.', `add a "## Cases" section with one row for each case; ${CASE_FORM}`)
    return output
  }
  output.info.push(`cases: ${table.rows.length} rows.`)
  // The line goes above the table (CONTRIBUTING rule 2), so a reader meets the count before the rows.
  if (lines[0].at > table.at) fail('the `Cases:` line is below the case table.', 'move "Cases: <n> rows" above the table, as in the template (CONTRIBUTING.md rule 2).')
  if (Number(rows[1]) !== table.rows.length) fail(`the \`Cases:\` line says ${rows[1]} rows; the table has ${table.rows.length}.`, `make the line say "Cases: ${table.rows.length} rows", or add the rows it counts.`)
  const blank = table.rows.filter(cells => cells.slice(0, 3).some(cell => !cell)).length
  if (blank) fail(`${blank} rows of the case table leave State, Event or Expected result empty.`, 'fill in the state, the event and the expected result of each row.')
  // The table is written before any code, with the title of the test planned for each row, so a draft needs it too.
  const untested = table.rows.filter(cells => !cells[3]).length
  if (untested) fail(`${untested} rows of the case table name no test.`, 'name in the Test column the title of the test planned for each row; the table has it before any code is written, on a draft too (RULES.md, R6).')
  if (isFailFirst) failFirst({ body, rows: table.rows, titles, head, isDraft, fail, output, isRequired: true })
  return output
}

// The distinct heads with a `Review: REQUEST CHANGES`, over the whole pull request: several verdicts on one head are one
// round, a short sha and its full sha are one head, and an APPROVE does not reset the count. A bot's review is input for
// the reviewer, not a verdict (team-process, From claim to merge), so it starts no round.
export const roundsOf = comments => {
  const heads = []
  const add = head => { if (!heads.some(sha => sha.startsWith(head) || head.startsWith(sha))) heads.push(head) }
  for (const comment of comments ?? []) {
    if (comment && typeof comment === 'object' && isBotUser(comment.user)) continue
    // A verdict quoted in a code fence or an HTML comment is an example, not a round.
    const shown = typeof comment === 'string' ? visibleLines(comment).join('\n')
      : comment && typeof comment.body === 'string' ? { ...comment, body: visibleLines(comment.body).join('\n') } : comment
    const review = reviewOf(shown)
    if (review?.kind === 'REQUEST CHANGES') add(review.sha)
    // A review that requests changes is a round whatever its text says, even when its body quotes an earlier approval.
    if (comment && typeof comment === 'object' && comment.state === 'CHANGES_REQUESTED' && typeof comment.commit_id === 'string' && comment.commit_id) add(comment.commit_id.toLowerCase())
  }
  return heads.length
}
export const rounds = (comments, { body = '', title = '', number = null, isDraft = false, tier = visibleTier(body) } = {}) => {
  const output = result()
  if (tier !== 'risk' || isReleaseTitle(title) || (number !== null && number <= CASES_FROM)) return output
  const count = roundsOf(comments)
  if (count < 3) return output
  const lines = visibleLines(body).flatMap(line => line.match(/^Round cap:[ \t]*(.*)$/i)?.[1].trim().replace(/`/g, '') ?? []).filter(value => value !== '' && !value.startsWith('<'))
  const split = lines.find(value => /^#\d+(?:[ \t]*,[ \t]*#\d+)*\.?$/.test(value))
  const isWords = lines.some(value => /^one more round,[ \t]*words only\.?$/i.test(value))
  if (count < ROUND_CAP) {
    output.info.push(`review rounds: ${count} of ${ROUND_CAP}.`)
  } else if (split) {
    output.info.push(`review rounds: ${count}; stopped, the rest is in ${split.replace(/\.$/, '')}.`)
  } else if (count === ROUND_CAP && isWords) {
    output.info.push(`review rounds: ${count}; one more round, docs and comments only.`)
  } else if (isDraft) {
    output.info.push(`review rounds: ${count}; at the cap of ${ROUND_CAP}, so it needs a "Round cap:" line before it is ready (RULES.md, R6).`)
  } else {
    output.problems.push(problem('rounds', `this pull request has had ${count} review rounds; it stops at ${ROUND_CAP} (RULES.md, R6).`, 'push no further fix: the maintainer says in a "Round cap:" comment what is settled; keep that part, open an issue for each open finding and name them on a body line "Round cap: #A, #B"; at exactly five rounds with only words left, the line "Round cap: one more round, words only" gives one more (team-process.md, From claim to merge).'))
  }
  return output
}

export const verdict = (comments, head, options = {}) => {
  const output = result()
  const { isDraft = false, authorAgent = null, number = null, tier = null } = options
  const reviews = (comments ?? []).map(comment => reviewOf(comment)).filter(Boolean)
  const last = reviews.at(-1)

  if (!last) {
    output.info.push('review: no review verdict yet.')
    if (!isDraft && number !== null) {
      output.problems.push(problem('review', 'a ready pull request needs a qualifying review approval on the current head.', 'request a review and post "Review: APPROVE <head> by <reviewer>".'))
    }
    return output
  }

  const isExactHead = head.toLowerCase().startsWith(last.sha) || last.sha.startsWith(head.toLowerCase())
  if (!isExactHead) {
    output.info.push(`review: ${last.kind} for ${last.sha.slice(0, 7)}, an older head; the current head has no verdict yet.`)
    if (!isDraft && number !== null) {
      output.problems.push(problem('review', `the review approval was for an older head (${last.sha.slice(0, 7)}); the current head (${head.slice(0, 7)}) needs a fresh review.`, 'request a new review on the current head.'))
    }
    return output
  }

  if (last.kind !== 'APPROVE') {
    output.info.push(`review: ${last.kind} for ${last.sha.slice(0, 7)}, the current head.`)
    if (!isDraft && number !== null) {
      output.problems.push(problem('review', `the latest review requested changes on ${last.sha.slice(0, 7)}.`, 'address the review findings and request a new review.'))
    }
    return output
  }

  if (authorAgent && last.reviewer && last.reviewer.toLowerCase().includes(authorAgent.toLowerCase()) && !isLaneReviewer(last, tier)) {
    output.info.push(`review: APPROVE for ${last.sha.slice(0, 7)}, the current head.`)
    if (!isDraft && number !== null) {
      output.problems.push(problem('review', 'an author cannot approve their own pull request (RULES.md, R2).', 'request an independent review from another lane or reviewer; on the light and normal tiers, a reviewer your lane starts new for this review says so on its verdict line ("started new for this review").'))
    }
    return output
  }

  output.info.push(`review: ${last.kind} for ${last.sha.slice(0, 7)}, the current head.`)
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
    output.problems.push(problem('outside', 'a release pull request comes from the team (the maintainer, or a collaborator while the maintainer is away), not from outside it.', 'open a fix or feature pull request; only the team raises the version (CONTRIBUTING.md, Releases).'))
  }
  add(naming(data.title, data.branch))
  add(sections(data.body, data.template))
  add(changelog({ text: data.changelogText, added: data.added, paths: data.paths, addedPaths: data.addedPaths, headPaths: data.headPaths, issue: issue.issue, titles: testTitles(data.testFiles), isRelease, isFold: !isOutside && isFoldTitle(data.title), isDocsOnly: data.paths.every(path => path.endsWith('.md') || /^(docs|\.github)\//.test(path)), isRequired: /^(feat|fix)[(!:]/.test(data.title) && data.paths.includes('CHANGELOG.md'), title: data.title, releaseNumbers: data.releaseNumbers ?? [] }))
  add(privateData({ added: data.added, body: data.body }))
  add(rulesPage({ paths: data.paths, body: data.body, headPaths: data.headPaths }))
  add(binaryImages(data.changedPaths))
  add(surface({ body: data.body, title: data.title, number: data.number, paths: data.paths, numstat: data.numstat }))
  add(cases({ body: data.body, title: data.title, number: data.number, isDraft: data.isDraft, titles: testTitles(data.testFiles ?? []), head: data.head }))
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
    // The team needs no claim (#607), so only an outside author's issue is read for one.
    if (isSmallDocs) output.info.push('claim: a small docs fix needs none.')
    else if (isOutside) {
      if (lookups.some(item => (item.issueComments ?? null) === null)) output.info.push('claim: skipped (offline).')
      // An outside author's claim is judged by the login that wrote it, so the Author line's name does not enter.
      for (const { number, issueData, issueComments } of lookups) {
        if (!issueComments || issueData === false) continue
        add(outsideClaim({ comments: issueComments, login: data.login, branch: data.branch, issue: lookups.length > 1 ? number : null, now: data.now }))
      }
      for (const { number, issueData } of lookups) if (issueData) add(outsideIssue(issueData, number))
    }
  }
  // An unknown author (a local --body-file run) is judged as the team, so say what was not checked: CI knows the
  // author and holds an outside contributor to the claim and the cap.
  if (!isOutside && !isSmallDocs && !isKnownAssociation(data.association)) {
    output.info.push('claim and cap: not checked, the author is unknown here. The team needs neither; a contributor from outside the team needs both (CONTRIBUTING rules 3 and 10), and CI checks them.')
  }
  // The team has no limit on open pull requests (#607); only an outside author's are counted.
  if (issue.items.some(item => item.kind === 'fixes')) {
    if (data.open === null) output.info.push('duplicate-pr: skipped (offline).')
    else add(duplicatePr({ body: data.body, title: data.title, number: data.number, branch: data.branch, head: data.head, createdAt: data.createdAt, open: data.open }))
  }
  if (isOutside) {
    if (data.open === null) output.info.push('cap: skipped (offline).')
    else add(cap({ open: data.open, number: data.number, login: data.login }))
    add(outsideNotes({ paths: data.paths, numstat: data.numstat }))
  }
  if (data.prComments === null) output.info.push('review: skipped (offline).')
  else {
    add(verdict(data.prComments, data.head, { isDraft: data.isDraft, authorAgent: author.agent, number: data.number, tier: tierOf(data.body) }))
    add(rounds([...data.prComments, ...(data.prReviews ?? [])], { body: data.body, title: data.title, number: data.number, isDraft: data.isDraft }))
    // A round can be a review state alone, so reviews that could not be read leave the count unknown, never zero.
    if (data.isReviewsUnread && visibleTier(data.body) === 'risk' && !isRelease && data.number !== null && data.number > CASES_FROM) {
      output.problems.push(problem('rounds', 'the reviews of this pull request could not be read, so its review rounds are not counted.', 'run the check again; the round count reads every review, and it stops a risk-tier pull request at its cap (RULES.md, R6).'))
    }
  }
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
  node scripts/pr-check.mjs --issue <N> [--finding] [--comment-issue] [-R owner/repo] [--repo-dir <dir>]
  node scripts/pr-check.mjs --issue-title <title> [--issue-body-file <file>] [--finding] [-R owner/repo] [--repo-dir <dir>]
  node scripts/pr-check.mjs --event <file> [--comment-issue] [--repo-dir <dir>]

Options:
  --offline        Skip issue, claim, open-PR cap and review network checks
  --no-bundle      Skip the Bun board bundle check
  --finding        Check the issue as a finding filed by a lane
  --comment-issue  Post or update a notice comment when an issue check finds problems
  --help           Print this usage

Default repository: WenyuChiou/agent-board. Default base: origin/main.
Exit codes: 0 passed, 1 check problems, 2 usage or environment error.
`

const parseArgs = argv => {
  const options = {}
  const flags = new Set(['--offline', '--no-bundle', '--finding', '--comment-issue', '--help'])
  const values = new Set(['--pr', '-R', '--repo-dir', '--body-file', '--title', '--base', '--issue', '--issue-title', '--issue-body-file', '--event'])
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (Object.hasOwn(options, key)) throw new Error(`duplicate option ${key}`)
    if (flags.has(key)) options[key] = true
    else if (values.has(key) && argv[i + 1] && !argv[i + 1].startsWith('-')) options[key] = argv[++i]
    else throw new Error(`unknown option or missing value: ${safeText(key)}`)
  }
  if (options['--help']) return options
  if (['--pr', '--body-file', '--issue', '--issue-title', '--event'].filter(key => options[key]).length !== 1) {
    throw new Error('choose exactly one of --pr, --body-file, --issue, --issue-title or --event; use --help for usage.')
  }
  if (options['--body-file'] ? !options['--title'] : options['--title'] || options['--base']) throw new Error('--body-file needs --title; --title and --base belong only to --body-file mode.')
  if (options['--issue-body-file'] && !options['--issue-title']) throw new Error('--issue-body-file belongs only to --issue-title mode.')
  if (options['--comment-issue'] && !options['--issue'] && !options['--event']) throw new Error('--comment-issue belongs only to --issue or --event mode.')
  if (options['--pr'] && !/^[1-9]\d*$/.test(options['--pr'])) throw new Error('--pr must be a positive integer.')
  if (options['--issue'] && !/^[1-9]\d*$/.test(options['--issue'])) throw new Error('--issue must be a positive integer.')
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

const printCheckResult = (checked, header, { isEvent = false } = {}) => {
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, reportMarkdown(checked, header)) } catch { throw new Error('could not append the GitHub step summary.') }
  }
  const printed = report(checked, header)
  if (isEvent) {
    // GitHub Actions reads no command of either syntax until this random token comes back; the error
    // messages printed outside it are fixed text and numbers, never pull request text.
    const token = randomBytes(16).toString('hex')
    console.log(`::stop-commands::${token}\n${printed}\n::${token}::`)
  } else {
    console.log(printed)
  }
  return checked.problems.length ? 1 : 0
}

const issueNoticeMarker = '<!-- issue-check:notice -->'
const isActionsBot = user => user?.type === 'Bot' && /^github-actions(?:\[bot\])?$/i.test(user?.login ?? '')
const quietNotice = text => safeText(oneLine(text)).replace(/(^|[^\w.%+-])@(?=[A-Za-z0-9])/g, '$1@\u200b')

const apiWriter = (options, repo, cwd, run = spawnSync) => async (method, path, payload) => {
  const endpoint = `repos/${repo}/${path}`
  const failed = () => new Error(`network write failed for ${endpoint}.`)
  if (!options['--event']) {
    const executed = run('gh', ['api', '--method', method, endpoint, '--input', '-'], { cwd, encoding: 'utf8', maxBuffer, input: JSON.stringify(payload) })
    if (executed.error || executed.status !== 0) throw failed()
    return executed.stdout.trim() ? JSON.parse(executed.stdout) : null
  }
  try {
    const base = process.env.GITHUB_API_URL ?? 'https://api.github.com'
    const response = await fetch(new URL(`${base.replace(/\/$/, '')}/${endpoint}`), {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    })
    if (!response.ok) throw new Error('unsuccessful API write')
    return null
  } catch {
    throw failed()
  }
}

const syncIssueNotice = async ({ checked, api, write, number }) => {
  const comments = await api(`issues/${number}/comments`, { isList: true })
  const existing = (Array.isArray(comments) ? comments : []).find(comment => isActionsBot(comment?.user) && (comment?.body ?? '').startsWith(issueNoticeMarker))
  if (!checked.problems.length && !existing) return
  const body = checked.problems.length
    ? [
        issueNoticeMarker,
        '**issue-check** flagged the following problem(s) on this issue:',
        '',
        ...checked.problems.flatMap(item => [`- **${quietNotice(item.check)}:** ${quietNotice(item.message)}`, `  - Fix: ${quietNotice(item.fix)}`]),
      ].join('\n')
    : `${issueNoticeMarker}\n**issue-check:** all checks passed.`
  if (existing && existing.body === body) return
  if (existing) await write('PATCH', `issues/comments/${existing.id}`, { body })
  else await write('POST', `issues/${number}/comments`, { body })
}

const runIssueCheck = async ({ options, cwd, repo, issue, action = null }) => {
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repository must be owner/repo.')
  const api = options['--offline'] ? null : apiReader(options, repo, cwd)
  let target = issue
  if (options['--issue']) {
    if (!api) throw new Error('network check failed for --issue; pass --issue-title with --offline to check locally.')
    target = await api(`issues/${options['--issue']}`)
  }
  if (!target || typeof target.title !== 'string') throw new Error('issue metadata is incomplete or invalid.')
  if (target.pull_request) throw new Error(`#${target.number} is a pull request, not an issue.`)
  if (target.state === 'closed') {
    console.log('pr-check: issue check not run: the issue is closed.')
    return 0
  }
  const openIssues = api ? await api('issues?state=open', { isList: true }) : null
  const checked = checkIssue({
    title: target.title,
    body: target.body ?? '',
    number: target.number ?? null,
    action,
    repo,
    association: target.author_association ?? null,
    openIssues,
    isFinding: Boolean(options['--finding']),
  })
  if (options['--comment-issue'] && api && target.number) {
    await syncIssueNotice({ checked, api, write: apiWriter(options, repo, cwd), number: target.number })
  }
  const header = target.number ? `issue #${target.number}` : 'new issue'
  return printCheckResult(checked, header, { isEvent: Boolean(options['--event']) })
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
    if (options['--issue'] || options['--issue-title']) {
      const issue = options['--issue-title']
        ? { number: null, title: options['--issue-title'], body: options['--issue-body-file'] ? readText(resolve(options['--issue-body-file'])) : '', state: 'open' }
        : null
      return await runIssueCheck({ options, cwd, repo, issue })
    }
    if (options['--event']) {
      const event = readJson(readText(resolve(options['--event'])))
      if (event.issue && !event.pull_request) {
        if (!event.repository) throw new Error('event must contain issue and repository metadata.')
        return await runIssueCheck({ options, cwd, repo: event.repository.full_name, issue: event.issue, action: event.action ?? null })
      }
      const pr = event.pull_request
      if (!pr || !event.repository) throw new Error('event must contain pull_request and repository metadata.')
      // Merged metadata cannot enter the merge queue again, but its public body still needs privacy checks.
      if (pr.state === 'closed' && pr.merged === true) {
        const checked = privateData({ added: [], body: pr.body ?? '' })
        if (checked.problems.length) {
          console.log(report(checked, 'merged pull request metadata'))
          return 1
        }
        console.log('pr-check: contribution checks not run: the pull request is already merged; metadata privacy check passed.')
        return 0
      }
      repo = event.repository.full_name
      // author_association and user.login are in the event's pull_request; both stay undefined when it has none.
      data = { number: pr.number, title: pr.title, body: pr.body ?? '', branch: pr.head?.ref, head: pr.head?.sha, isDraft: pr.draft, labels: pr.labels, association: pr.author_association, login: pr.user?.login, createdAt: pr.created_at ?? null }
      base = pr.base?.sha
    } else if (options['--pr']) {
      let pr
      try {
        pr = readJson(command('gh', ['pr', 'view', options['--pr'], '-R', repo, '--json', 'number,title,body,headRefName,headRefOid,baseRefName,baseRefOid,isDraft,labels,author,createdAt'], cwd))
      } catch {
        throw new Error('network check failed for gh pr view; use --body-file with --offline to check without GitHub.')
      }
      // gh pr view has no author_association field; it is read from the open pull request list below.
      data = { number: pr.number, title: pr.title, body: pr.body ?? '', branch: pr.headRefName, head: pr.headRefOid, isDraft: pr.isDraft, labels: pr.labels, login: pr.author?.login, createdAt: pr.createdAt ?? null }
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
    if (isReleaseTitle(data.title)) {
      const tagCheck = spawnSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'agent-board--v*'], { cwd, encoding: 'utf8', maxBuffer })
      const lastTag = tagCheck.status === 0 ? tagCheck.stdout.trim() : null
      if (lastTag) {
        const logCheck = spawnSync('git', ['log', `${lastTag}..${base}`, '--format=%x1e%s', '--name-only'], { cwd, encoding: 'utf8', maxBuffer })
        if (logCheck.status === 0) {
          const commits = logCheck.stdout.split('\x1e').filter(item => item.trim()).map(item => {
            const [subject, ...paths] = item.split(/\r?\n/)
            return { subject: subject.trim(), paths: paths.map(path => path.trim()).filter(Boolean) }
          })
          data.releaseNumbers = titleCommitNumbers(commits)
        }
      }
    }
    data.issueData = null
    data.issueComments = null
    data.open = null
    data.prComments = null
    if (!options['--offline']) {
      const api = apiReader(options, repo, cwd)
      // Open pull requests are read both for an outside author's cap (#607) and to flag a second pull request fixing the
      // same issue (#1325). Team authors still skip issue-comment claim lookups.
      const isTeam = () => isKnownAssociation(data.association) && !isOutsideAssociation(data.association)
      const parsedIssue = issueLine(data.body, data.title)
      if (!isTeam() || parsedIssue.items.some(item => item.kind === 'fixes')) {
        const open = []
        for (const pr of await api('pulls?state=open', { isList: true })) {
          open.push({ number: pr.number, title: pr.title, body: pr.body ?? '', createdAt: pr.created_at, labels: pr.labels, isOutside: isOutsideAssociation(pr.author_association), association: pr.author_association, login: pr.user?.login ?? null, headRef: pr.head?.ref ?? null, headSha: pr.head?.sha ?? null })
        }
        data.open = open
        const own = open.find(pr => pr.number === data.number)
        if (own) {
          data.association ??= own.association
          data.login ??= own.login ?? undefined
          data.createdAt ??= own.createdAt ?? null
        }
      }
      const [first, ...more] = [...new Set(parsedIssue.issues)]
      const lookup = async number => {
        const issueData = await api(`issues/${number}`, { isMissingAllowed: true })
        return { issueData, issueComments: issueData === false || isTeam() ? [] : await api(`issues/${number}/comments`, { isList: true }) }
      }
      if (first !== undefined) {
        Object.assign(data, await lookup(first))
        data.moreIssues = {}
        for (const number of more) data.moreIssues[number] = await lookup(number)
      }
      if (data.number === null) data.prComments = []
      else {
        const comments = await api(`issues/${data.number}/comments`, { isList: true })
        const hasApproval = (Array.isArray(comments) ? comments : []).some(c => {
          const r = reviewOf(c)
          return r && r.kind === 'APPROVE'
        })
        // The verdict reads the reviews only while no comment approves; the round count reads them
        // always, since an approval does not restart it (RULES.md, R6).
        let reviews = []
        try { reviews = await api(`pulls/${data.number}/reviews`, { isList: true }) } catch { data.isReviewsUnread = true }
        data.prReviews = Array.isArray(reviews) ? reviews : []
        data.prComments = [...(Array.isArray(comments) ? comments : []), ...(hasApproval ? [] : data.prReviews)]
      }
    }
    const checked = checkPr(data)
    if (needsBundle(data.paths)) {
      if (options['--event']) checked.info.push('bundle: checked by test.yml ("Board bundle up to date").')
      else if (options['--no-bundle']) checked.info.push('bundle: skipped (--no-bundle).')
      else if (git(cwd, 'rev-parse', 'HEAD').trim() !== data.head) checked.info.push('bundle not checked: check out the pull request\'s head.')
      // A checkout that converts line endings (core.autocrlf, eol=crlf) writes the bundle with CRLF,
      // and the bundle check would fail on a current bundle; so the file itself is looked at.
      else if (bundleFiles(cwd).some(path => existsSync(join(cwd, path)) && readFileSync(join(cwd, path), 'utf8').includes('\r\n'))) checked.info.push('bundle not checked: hooks/board-script*.ts have CRLF line endings in this checkout; CI checks the bundle, or clone with -c core.autocrlf=false.')
      else if (bundleIsCurrent(cwd)) checked.info.push('bundle: board bundle is current.')
      else checked.problems.push(problem('bundle', 'the board bundle (hooks/board-script.ts and its parts) is out of date.', 'run "npx --yes bun@1.4.2 scripts/build-board.ts" and commit hooks/board-script*.ts with the source change.'))
    }
    const header = `${data.number === null ? 'new pull request' : `#${data.number}`} ${data.branch} at ${data.head.slice(0, 7)}`
    return printCheckResult(checked, header, { isEvent: Boolean(options['--event']) })
  } catch (error) {
    console.error(`pr-check: ${oneLine(safeText(error.message))}`)
    return 2
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
