import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fragmentIssue, isFragmentPath } from './changelog-fold.mjs'

// The open pull request cap the owner approved for CONTRIBUTING.md rule 10 (#229): per author, and in all.
export const AUTHOR_CAP = 2
export const TOTAL_CAP = 8

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const result = () => ({ problems: [], info: [] })
const problem = (check, message, fix) => ({ check, message, fix })
const isReleaseTitle = title => /^chore\(release\):/.test(title)
const linesOf = text => text.split(/\r?\n/)

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

export const issueLine = (body, title) => {
  const output = { issue: null, kind: null, ...result() }
  if (isReleaseTitle(title)) {
    output.info.push('issue: release pull requests need no issue line.')
    return output
  }
  const clean = stripComments(body)
  const first = linesOf(clean).find(line => line.trim())?.trim() ?? ''
  const match = first.match(/^(Fixes|Part of)\s+#(\d+)\b/i)
  if (!match) {
    output.problems.push(problem('issue', 'the first non-empty body line must name one issue.', 'add "Fixes #N" or "Part of #N" as the first line.'))
    return output
  }
  output.issue = Number(match[2])
  output.kind = match[1].toLowerCase()
  for (const closing of clean.matchAll(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi)) {
    if (Number(closing[2]) !== output.issue) {
      output.problems.push(problem('issue', `a closing keyword also names #${closing[2]}.`, 'remove the other closing reference so this pull request covers only its first issue.'))
    }
  }
  return output
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
  const boundary = '[\\s`,();.]'
  if (!new RegExp(`(?:^|${boundary})${escapeRegex(branch)}(?=$|${boundary})`).test(comma === -1 ? author : author.slice(comma + 1))) {
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

export const claimed = (comments, agent, branch) => {
  const output = result()
  const agentPattern = agent ? new RegExp(`\\b${escapeRegex(agent)}\\b`, 'i') : null
  if (!comments.some(comment => comment.body.includes(branch) && agentPattern?.test(comment.body))) {
    output.problems.push(problem('claim', 'no issue comment claims this branch for this agent.', 'comment on the issue with "Claim: <agent>, <branch>" before starting work.'))
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

export const fragmentChanges = ({ paths = [], addedPaths = [], headPaths, issue, isRelease }) => {
  const output = result()
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
    else if (issue !== null && issue !== undefined && Number(number) !== issue) output.problems.push(problem('changelog', `the fragment ${path} is named for a different issue than #${issue}.`, `rename it to changelog.d/${issue}-<slug>.md.`))
  }
  for (const path of fragments.filter(path => !fresh.includes(path))) {
    output.problems.push(problem('changelog', `an existing fragment was edited or removed: ${path}.`, 'restore that fragment and add a new file with a different slug; only chore(release): pull requests fold existing fragments.'))
  }
  if (fresh.length > 1) output.problems.push(problem('changelog', 'more than one fragment was added.', 'combine this pull request entry into exactly one new changelog.d/<issue>-<slug>.md file.'))
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
export const changelog = ({ text, added, issue, titles, isRelease, isDocsOnly, isRequired = true, paths = [], addedPaths = [], headPaths }) => {
  const output = fragmentChanges({ paths, addedPaths, headPaths, issue, isRelease })
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
    for (const path of fresh) output.problems.push(...changelogEntry({ entry: added.filter(item => item.path === path).map(item => item.text).join('\n'), issue, titles, isDocsOnly, location: 'fragment' }).problems)
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

export const cap = ({ open, number, body, perAuthor = AUTHOR_CAP, total = TOTAL_CAP }) => {
  const output = result()
  const isExempt = pr => isReleaseTitle(pr.title) || pr.isGovernance || pr.labels.some(label => labelName(label) === 'cap-exempt')
  if (open.some(pr => pr.number === number && isExempt(pr))) return output
  // Older pull requests keep their slots: sort by creation and judge only this one's place.
  const counted = open.filter(pr => !isExempt(pr)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number)
  const keyOf = pr => authorKey(pr.body ?? '') ?? `unnamed #${pr.number}`
  const self = counted.find(pr => pr.number === number) ?? { number, body }
  const queue = counted.includes(self) ? counted : [...counted, self]
  const ahead = queue.slice(0, queue.indexOf(self) + 1)
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

export const verdict = (comments, head) => {
  const output = result()
  const last = comments.map(comment => comment.body.match(/^Review:\s*(APPROVE|REQUEST CHANGES)\s+([0-9a-f]{7,40})\b/m)).filter(Boolean).at(-1)
  if (!last) output.info.push('review: no review verdict yet.')
  else output.info.push(`review: ${last[1]} for ${last[2].slice(0, 7)}, ${head.startsWith(last[2]) ? 'the current head.' : 'an older head; the current head has no verdict yet.'}`)
  return output
}

export const checkPr = data => {
  const output = result()
  const add = checked => {
    output.problems.push(...checked.problems)
    output.info.push(...(checked.info ?? []))
  }
  const issue = issueLine(data.body, data.title)
  const author = authorLine(data.body, data.branch)
  const isRelease = isReleaseTitle(data.title)
  add(issue)
  add(author)
  add(naming(data.title, data.branch))
  add(sections(data.body, data.template))
  add(changelog({ text: data.changelogText, added: data.added, paths: data.paths, addedPaths: data.addedPaths, headPaths: data.headPaths, issue: issue.issue, titles: testTitles(data.testFiles), isRelease, isDocsOnly: data.paths.every(path => path.endsWith('.md') || /^(docs|\.github)\//.test(path)), isRequired: /^(feat|fix)[(!:]/.test(data.title) }))
  add(privateData({ added: data.added, body: data.body }))
  add(binaryImages(data.changedPaths))
  if (issue.issue !== null) {
    // false: GitHub answered that the issue does not exist; null: not looked up (offline).
    if (data.issueData === null) output.info.push('issue status: skipped (offline).')
    else if (data.issueData === false) {
      output.problems.push(problem('issue', `issue #${issue.issue} does not exist in this repository.`, 'use the number of an open issue covering this change.'))
    } else if ('pull_request' in data.issueData || data.issueData.state !== 'open') {
      output.problems.push(problem('issue', `#${issue.issue} must be an open issue, not a pull request or a closed issue.`, 'use the number of an open issue covering this change.'))
    }
    if (data.issueComments === null) output.info.push('claim: skipped (offline).')
    else if (data.issueData !== false) add(claimed(data.issueComments, author.agent, data.branch))
  }
  if (data.open === null) output.info.push('cap: skipped (offline).')
  else if (isRelease || data.paths.some(isGovernancePath) || data.labels?.some(label => labelName(label) === 'cap-exempt')) output.info.push('cap: this pull request is exempt.')
  else add(cap({ open: data.open, number: data.number, body: data.body }))
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
      data = { number: pr.number, title: pr.title, body: pr.body ?? '', branch: pr.head?.ref, head: pr.head?.sha, isDraft: pr.draft, labels: pr.labels }
      base = pr.base?.sha
    } else if (options['--pr']) {
      let pr
      try {
        pr = readJson(command('gh', ['pr', 'view', options['--pr'], '-R', repo, '--json', 'number,title,body,headRefName,headRefOid,baseRefName,baseRefOid,isDraft,labels'], cwd))
      } catch {
        throw new Error('network check failed for gh pr view; use --body-file with --offline to check without GitHub.')
      }
      data = { number: pr.number, title: pr.title, body: pr.body ?? '', branch: pr.headRefName, head: pr.headRefOid, isDraft: pr.isDraft, labels: pr.labels }
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
      const issue = issueLine(data.body, data.title).issue
      if (issue !== null) {
        data.issueData = await api(`issues/${issue}`, { isMissingAllowed: true })
        data.issueComments = data.issueData === false ? [] : await api(`issues/${issue}/comments`, { isList: true })
      }
      const open = []
      for (const pr of await api('pulls?state=open', { isList: true })) {
        const files = await api(`pulls/${pr.number}/files`, { isList: true })
        open.push({ number: pr.number, title: pr.title, body: pr.body ?? '', createdAt: pr.created_at, labels: pr.labels, isGovernance: files.some(file => isGovernancePath(file.filename)) })
      }
      data.open = open
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
