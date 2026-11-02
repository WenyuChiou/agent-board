import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { addedLines, testTitles, titleKnown } from './pr-check.mjs'
import { fragmentIssue, isFragmentPath } from './changelog-fold.mjs'
import { isBundleFile } from './bundle-text.mjs'

const tables = [['hooks/i18n.ts', 'ZH_TW'], ['hooks/strings-en.ts', 'EN'], ['hooks/strings-zh-cn.ts', 'ZH_CN']]
const homeNames = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROGRESS_FILE']
const maxBuffer = 64 * 1024 * 1024
const read = path => readFileSync(path, 'utf8')
const isTest = path => /^tests\/(?:.*\/)?[^/]+\.test\.(mjs|ts|tsx)$/.test(path)
const splitPaths = text => text.split('\0').filter(Boolean)

export const accountTestLockPath = ({ platform = process.platform, account = userInfo() } = {}) => {
  const identity = platform === 'win32'
    ? createHash('sha256').update(String(account.homedir)).digest('hex')
    : String(account.uid)
  // userInfo reads the account database, unlike HOME, USERPROFILE or the temp environment.
  return join(account.homedir, `.agent-board-preflight-tests-${identity}`)
}

export const testLockDirectoryProblem = (stat, { platform = process.platform, uid = userInfo().uid } = {}) => {
  if (stat.isSymbolicLink()) return 'test lock directory is a symbolic link.'
  if (!stat.isDirectory()) return 'test lock directory is not a directory.'
  if (platform !== 'win32') {
    if (stat.uid !== uid) return 'test lock directory belongs to another account.'
    if (stat.mode & 0o022) return 'test lock directory is writable by group or others.'
  }
  return null
}

const prepareTestLockDirectory = directory => {
  try { mkdirSync(directory, { mode: 0o700 }) } catch (error) {
    if (error?.code !== 'EEXIST') throw new Error('test lock directory could not be created; check account directory access.')
  }
  let stat
  try { stat = lstatSync(directory) } catch {
    throw new Error('test lock directory could not be inspected; check account directory access.')
  }
  const problem = testLockDirectoryProblem(stat)
  if (problem) throw new Error(problem)
}

const isLiveProcess = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

const releaseTestLock = path => {
  try {
    unlinkSync(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

const acquireTestLock = (directory, onPublished) => {
  prepareTestLockDirectory(directory)
  const marker = `${process.pid}-${randomUUID()}.lock`
  const path = join(directory, marker)
  let isPublished = false
  try {
    const file = openSync(path, 'wx', 0o600)
    isPublished = true
    closeSync(file)
    onPublished?.()
    let isBlocked = false
    for (const name of readdirSync(directory)) {
      if (name === marker) continue
      const match = /^([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.lock$/i.exec(name)
      if (!match) continue
      const pid = Number(match[1])
      // Node's process.kill accepts signed 32-bit PIDs; larger values are not usable owner markers.
      if (!Number.isInteger(pid) || pid > 2147483647) continue
      let stat
      try { stat = lstatSync(join(directory, name)) } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      // Unfamiliar entries, including links and directories, never become stale markers.
      if (!stat.isFile() || stat.size !== 0) continue
      if (isLiveProcess(pid)) {
        isBlocked = true
        continue
      }
      releaseTestLock(join(directory, name))
    }
    if (isBlocked) {
      releaseTestLock(path)
      return null
    }
    return { path }
  } catch (error) {
    if (isPublished) releaseTestLock(path)
    throw error
  }
}

// Child diagnostics can contain private paths or terminal control characters.
export const safeLine = (value, { hasSpacedUnixPaths = false } = {}) => {
  let text = String(value).replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '')
  // A file URL must reach the path rules before its e:/ can look like a drive.
  if (hasSpacedUnixPaths) text = text.replace(/\bfile:\/\/[^/\s]*(?=\/)/gi, '')
  // Home directory names can contain spaces even in unquoted diagnostics.
  // TAP names need conservative path removal; status lines keep adjacent relative paths.
  const unixPath = hasSpacedUnixPaths
    ? /(^|[^\w])(?:file:\/\/)?\/(?:[^\s/"'`<>:|?]+(?: [^\s/"'`<>:|?]+)*\/)*(?:[^\s/"'`<>:|?]+(?: [^\s/"'`<>:|?]+)*?\.[\w-]+(?=$|[\s"'`<>,;:)])|[^\s"'`<>?]*)/g
    : /(^|[\s"'`(])(?:file:\/\/)?\/(?:[^\s/"'`<>:|?]+\/)*(?:[^\s/"'`<>:|?]+(?: [^\s/"'`<>:|?]+)*?\.[\w-]+(?=$|[\s"'`<>,;:)])|[^\s"'`<>?]*)/g
  text = text.replace(/(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:home|Users)\/)[^\\/"'`<>]+(?=[\\/])/gi, match => match.replaceAll(' ', '\ue000'))
  text = text.replace(/(?:[A-Za-z]:[\\/]|\\\\)(?:[^\s\\/"'`<>:|?]+(?: [^\s\\/"'`<>:|?]+)*[\\/])*(?:[^\s\\/"'`<>:|?]+(?: [^\s\\/"'`<>:|?]+)*?\.[\w-]+(?=$|[\s"'`<>,;:)])|[^\s"'`<>?]*)/g, '<path>')
    .replace(unixPath, '$1<path>')
    .replace(/([?&]t=)[^\s&#"'`<>]+/gi, '$1<token>')
    .replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]+/gi, '<token>')
  for (const name of [process.env.USERNAME, process.env.USER].filter(value => value && value.length > 2)) {
    text = text.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<user>')
  }
  return text
}

const failedTapNames = output => {
  const names = []
  let diagnosticIndent
  for (const line of output.split(/\r?\n/)) {
    const opening = /^(\s*)---\s*$/.exec(line)
    if (diagnosticIndent === undefined && opening) {
      diagnosticIndent = opening[1]
      continue
    }
    if (diagnosticIndent !== undefined) {
      const closing = /^(\s*)\.\.\.\s*$/.exec(line)
      if (closing?.[1] === diagnosticIndent) diagnosticIndent = undefined
      continue
    }
    const match = /^\s*not ok \d+ - (.+?)\s*$/.exec(line)
    if (!match || /\s+#\s*(?:TODO|SKIP)\b/i.test(match[1])) continue
    // TAP escapes paths and hashes; decode before the path sanitizer sees them.
    const name = safeLine(match[1].replace(/\\(.)/g, '$1'), { hasSpacedUnixPaths: true }).slice(0, 160)
    if (name && !names.includes(name)) names.push(name)
    if (names.length === 3) break
  }
  return names
}

// Keep literals as tokens so braces and helper names inside prose cannot become code.
export const codeTokens = text => {
  const tokens = []
  const pattern = /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|[\w$]+|=>|\?\.|\.\.\.|[^\s]/gy
  let match
  let line = 1
  while ((match = pattern.exec(text))) {
    const value = match[0]
    if (!/^\s|^\/\/|^\/\*/.test(value)) {
      if (value === '/' && (!tokens.length || /^(?:=|\(|\[|,|:|return|=>|!|\?|\|\||&&)$/.test(tokens.at(-1).value))) {
        const regex = /^\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\\r\n])+\/[a-z]*/.exec(text.slice(match.index))
        if (regex) {
          pattern.lastIndex = match.index + regex[0].length
          tokens.push({ value: '<regex>', line })
          continue
        }
      }
      const isString = /^["'`]/.test(value)
      tokens.push({ value: isString ? value.slice(1, -1).replace(/\\(['"`\\])/g, '$1') : value, raw: value, isString, line })
    }
    line += (value.match(/\n/g) ?? []).length
  }
  return tokens
}

export const objectKeys = (text, name) => {
  const tokens = codeTokens(text)
  let index = tokens.findIndex((token, i) => token.value === 'const' && tokens[i + 1]?.value === name)
  if (index === -1) throw new Error('table declaration is missing')
  while (tokens[index]?.value !== '=' && index < tokens.length) index++
  if (tokens[++index]?.value !== '{') throw new Error('table is not an object literal')
  const keys = []
  let depth = 1
  let isKey = true
  for (index++; index < tokens.length; index++) {
    const token = tokens[index]
    if (depth === 1 && isKey && token.value !== '}') {
      if ((!token.isString && !/^[\w$]+$/.test(token.value)) || tokens[index + 1]?.value !== ':') throw new Error('unsupported table key')
      keys.push(token.value)
      isKey = false
    }
    if (!token.isString) {
      if (['{', '[', '('].includes(token.value)) depth++
      if (['}', ']', ')'].includes(token.value)) depth--
      if (!depth) return keys
      if (depth === 1 && token.value === ',' && (tokens[index + 1]?.value === '}' || tokens[index + 2]?.value === ':')) isKey = true
    }
  }
  throw new Error('table object is incomplete')
}

export const engineProblems = text => {
  const tokens = codeTokens(text)
  const allowed = new Set()
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.isString) continue
    if (!depth && token.value === 'function') allowed.add(tokens[i + 1]?.value)
    if (!depth && token.value === 'const') {
      let at = i + 2
      while (at < tokens.length && tokens[at].value !== '=' && !['const', 'function', ';'].includes(tokens[at].value)) at++
      if (tokens[at]?.value === '=') {
        let nested = 0
        for (at++; at < tokens.length; at++) {
          const next = tokens[at]
          if (next.isString) continue
          if (!nested && next.value === '=>') { allowed.add(tokens[i + 1]?.value); break }
          if (!nested && [';', 'const', 'function', 'export'].includes(next.value)) break
          if (['(', '[', '{'].includes(next.value)) nested++
          if ([')', ']', '}'].includes(next.value)) nested--
        }
      }
    }
    if (!depth && token.value === 'import' && tokens[i + 1]?.value !== 'type') {
      let end = i + 1
      while (end < tokens.length && !tokens[end].isString) end++
      if (tokens[end]?.value.startsWith('.') || tokens[end]?.value === 'claude-code') {
        for (let at = i + 1; at < end; at++) {
          const item = tokens[at]
          if (/^[\w$]+$/.test(item.value) && !['from', 'as', 'type'].includes(item.value) && tokens[at + 1]?.value !== 'as') {
            // These SDK primitives receive the engine directly, rather than being user helpers.
            const original = tokens[at - 1]?.value === 'as' ? tokens[at - 2]?.value : item.value
            if (tokens[end].value !== 'claude-code' || ['read', 'update'].includes(original)) allowed.add(item.value)
          }
        }
      }
    }
    if (token.value === '{') depth++
    if (token.value === '}') depth--
  }
  return tokens.flatMap((token, i) => !token.isString && token.value !== 'async' && /^[\w$]+$/.test(token.value)
    && !['.', '?.', 'function'].includes(tokens[i - 1]?.value)
    && tokens[i + 1]?.value === '(' && tokens[i + 2]?.value === '$'
    && [',', ')'].includes(tokens[i + 3]?.value) && !allowed.has(token.value)
    ? [{ name: token.value, line: token.line }] : [])
}

export const bundleSources = cwd => {
  const sources = new Set(['scripts/build-board.ts'])
  const visit = path => {
    if (isBundleFile(path)) return
    if (sources.has(path)) return
    sources.add(path)
    if (!existsSync(join(cwd, path))) return
    const tokens = codeTokens(read(join(cwd, path)))
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (!token.isString || !token.value.startsWith('.') || !['from', 'import'].includes(tokens[i - 1]?.value)) continue
      let declaration = i - 1
      while (declaration >= 0 && !['import', 'export'].includes(tokens[declaration].value)) declaration--
      if (declaration < 0 || tokens[declaration + 1]?.value === 'type') continue
      const target = resolve(cwd, dirname(path), token.value)
      const found = [target, `${target}.ts`, `${target}.tsx`, `${target}.mjs`, join(target, 'index.ts')].find(candidate => existsSync(candidate) && statSync(candidate).isFile())
      if (!found) throw new Error('an imported bundle source is missing')
      const name = relative(cwd, found).replaceAll('\\', '/')
      if (name.startsWith('../')) throw new Error('bundle import leaves the repository')
      visit(name)
    }
  }
  visit('scripts/board-cli.ts')
  return sources
}

const testDeclarations = cwd => {
  const declarations = []
  const visit = path => {
    if (!existsSync(join(cwd, path))) return
    for (const item of readdirSync(join(cwd, path), { withFileTypes: true })) {
      const name = `${path}/${item.name}`
      if (item.isDirectory()) visit(name)
      else if (item.isFile() && isTest(name)) {
        const tokens = codeTokens(read(join(cwd, name)))
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i].isString || !['test', 'it'].includes(tokens[i].value) || tokens[i - 1]?.value === '.') continue
          let at = i + 1
          if (tokens[at]?.value === '.' && ['skip', 'only', 'todo'].includes(tokens[at + 1]?.value)) at += 2
          if (tokens[at]?.value === '(' && tokens[at + 1]?.isString) {
            declarations.push(testTitles([{ path: name, text: `test(${tokens[at + 1].raw})` }]))
          }
        }
      }
    }
  }
  visit('tests')
  return declarations
}

const parseArgs = argv => {
  const options = { base: 'origin/main' }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (seen.has(key)) throw new Error('duplicate option')
    seen.add(key)
    if (key === '--no-fetch') options.isNoFetch = true
    else if (['--base', '--body-file', '--title'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      options[{ '--base': 'base', '--body-file': 'bodyFile', '--title': 'title' }[key]] = argv[++i]
    } else throw new Error('use node scripts/preflight.mjs [--base origin/main] [--no-fetch] [--body-file <f> --title <t>]')
  }
  if (Boolean(options.bodyFile) !== Boolean(options.title)) throw new Error('--body-file and --title must be supplied together')
  return options
}

export const runPreflight = async ({ cwd = process.cwd(), base = 'origin/main', isNoFetch = false, bodyFile, title, run = spawnSync, lockPath = accountTestLockPath(), onCheck, onProgress, onLockPublished } = {}) => {
  const checks = []
  const add = (state, message) => {
    const item = { state, message: safeLine(message) }
    checks.push(item)
    onCheck?.(item)
  }
  const command = (program, args, options = {}) => run(program, args, {
    cwd, encoding: 'utf8', maxBuffer, timeout: 120000,
    env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' }, ...options,
  })
  const git = (...args) => {
    const executed = command('git', args)
    if (executed.error || executed.status !== 0) throw new Error('Git could not read the requested base or working tree')
    return executed.stdout
  }
  const check = async (label, action) => {
    try { await action() } catch { add('FAIL', `${label} could not finish; check its inputs and tools.`) }
  }
  let changed
  let added
  let mergeBase
  let newPaths
  try {
    let hasFetchFailed = false
    if (!isNoFetch) {
      const fetched = command('git', ['fetch', 'origin', 'main'])
      hasFetchFailed = Boolean(fetched.error || fetched.status !== 0)
      if (hasFetchFailed) add('FAIL', 'git fetch origin main failed; fetch main before running preflight again.')
    }
    const ancestor = command('git', ['merge-base', '--is-ancestor', base, 'HEAD'])
    if (ancestor.error || ![0, 1].includes(ancestor.status)) add('FAIL', 'the main merged check could not read the base or HEAD.')
    else {
      if (hasFetchFailed) add('WARN', 'the ancestry check used the local ref because fetch failed; freshness is unknown.')
      // main does not require an up-to-date branch, so a branch behind main can merge as it is; main is merged only for a conflict.
      if (ancestor.status === 1) add('WARN', 'the branch does not contain the latest main; that is fine unless GitHub shows a conflict, then merge origin/main (no rebase, no force-push).')
      else if (!hasFetchFailed) add('PASS', 'the branch contains the base.')
    }
    mergeBase = git('merge-base', base, 'HEAD').trim()
    const untracked = splitPaths(git('ls-files', '--others', '--exclude-standard', '-z'))
    newPaths = new Set([...splitPaths(git('diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', mergeBase)), ...untracked])
    changed = new Set([
      ...splitPaths(git('diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`)),
      ...splitPaths(git('diff', '--name-only', '--no-renames', '-z', 'HEAD')), ...untracked,
      ...splitPaths(git('diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD')),
    ])
    added = addedLines(git('diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=0', mergeBase))
    for (const path of untracked.filter(path => path.startsWith('tests/') || path === 'CHANGELOG.md' || fragmentIssue(path) !== null)) {
      read(join(cwd, path)).split(/\r?\n/).forEach((text, i) => added.push({ path, line: i + 1, text }))
    }
  } catch {
    add('FAIL', 'changed files could not be read; check the base and Git working tree.')
    return checks
  }

  await check('touched Node tests', () => {
    const paths = [...changed].filter(path => isTest(path) && path.endsWith('.mjs') && existsSync(join(cwd, path)))
    if (!paths.length) add('PASS', 'no touched Node test files need running.')
    let owner = null
    try { owner = paths.length ? acquireTestLock(lockPath, onLockPublished) : null } catch (error) {
      add('FAIL', error.message?.startsWith('test lock directory ') ? error.message : 'test lock directory could not be used; check account directory access.')
      return
    }
    if (paths.length && !owner) add('FAIL', 'another preflight test run is already active on this computer; finish it before running preflight again.')
    if (owner) {
      try {
        for (const path of paths) {
          const temp = mkdtempSync(join(tmpdir(), 'agent-board-preflight-'))
          try {
            const env = { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' }
            // A nested test runner must emit its own TAP, not the parent's IPC protocol.
            delete env.NODE_TEST_CONTEXT
            for (const name of Object.keys(env)) if (/^(GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|ANTHROPIC_API_KEY)$/i.test(name)) delete env[name]
            for (const name of homeNames) env[name] = name === 'CLAUDE_PROGRESS_FILE' ? join(temp, 'progress.md') : temp
            onProgress?.(`RUN ${safeLine(path)}`)
            const tested = command(process.execPath, ['--test', '--test-reporter=tap', path], { env, timeout: 600000 })
            const output = `${tested.stdout ?? ''}\n${tested.stderr ?? ''}`
            const count = output.match(/^# fail (\d+)\s*$/m)?.[1]
            const total = output.match(/^# tests (\d+)\s*$/m)?.[1]
            const isPassed = !tested.error && tested.status === 0 && count === '0'
            const failedNames = isPassed ? [] : failedTapNames(output)
            const failedDetail = failedNames.length ? `; failed: ${failedNames.join('; ')}` : ''
            add(isPassed ? 'PASS' : 'FAIL', `${path}: ${total ?? 'unknown'} tests, ${count ?? 'unknown'} failed${failedDetail}${tested.error || tested.signal ? '; the runner did not finish' : ''}.`)
          } finally {
            rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
          }
        }
      } finally {
        releaseTestLock(owner.path)
      }
    }
    if ([...changed].some(path => /^tests\/.*\.test\.tsx?$/.test(path))) add('WARN', 'run `claude plugin test .` once before Ready (not run here)')
    else add('PASS', 'no touched plugin tests need the Claude test runner.')
  })

  await check('string tables', () => {
    if (!tables.some(([path]) => changed.has(path))) { add('PASS', 'string tables are unchanged.'); return }
    const loader = `const tables = ${JSON.stringify(tables.map(([path, name]) => [pathToFileURL(join(cwd, path)).href, name]))}; const keys = []; for (const [path, name] of tables) keys.push(Object.keys((await import(path))[name])); console.log(JSON.stringify(keys))`
    const loaded = command(process.execPath, ['--input-type=module', '-e', loader])
    let keys
    let method = 'Node type stripping'
    try {
      if (loaded.error || loaded.status !== 0) throw new Error('load failed')
      keys = JSON.parse(loaded.stdout)
      if (keys.length !== 3 || !keys.every(list => Array.isArray(list) && list.every(key => typeof key === 'string'))) throw new Error('invalid tables')
    } catch {
      method = 'text scan'
      keys = tables.map(([path, name]) => objectKeys(read(join(cwd, path)), name))
    }
    const all = new Set(keys.flat())
    const missing = keys.flatMap((list, i) => [...all].filter(key => !list.includes(key)).map(key => `${tables[i][1]} lacks ${key}`))
    add(missing.length ? 'FAIL' : 'PASS', `string tables (${method}): ${missing.length ? missing.join(', ') : 'all top-level keys match'}.`)
    try {
      const newKeys = new Set()
      for (let i = 0; i < tables.length; i++) {
        const old = command('git', ['show', `${mergeBase}:${tables[i][0]}`])
        if (old.error || old.status !== 0) throw new Error('base table could not be read')
        const oldKeys = objectKeys(old.stdout, tables[i][1])
        for (const key of keys[i]) if (!oldKeys.includes(key)) newKeys.add(key)
      }
      const misplaced = [...newKeys].filter(key => keys.every(list => list.includes(key)) && new Set(keys.map(list => list[list.indexOf(key) - 1] ?? '<first>')).size > 1)
      add(misplaced.length ? 'WARN' : 'PASS', misplaced.length ? `put new string keys after the same neighbour in every table: ${misplaced.join(', ')}.` : 'new string keys have the same neighbour in every table.')
    } catch (error) {
      add('WARN', `string placement not checked: ${error.message}.`)
    }
  })

  for (const group of [['README.md', 'README.zh-TW.md', 'README.zh-CN.md'], ['docs/GUIDE.md', 'docs/GUIDE.zh-TW.md', 'docs/GUIDE.zh-CN.md']]) {
    const missing = group.some(path => changed.has(path)) ? group.filter(path => !changed.has(path)) : []
    add(missing.length ? 'WARN' : 'PASS', missing.length ? `update the language copies too: ${missing.join(', ')}.` : `${group[0]} language copies are synchronized or unchanged.`)
  }

  await check('board bundle scan', () => {
    const hasSource = [...bundleSources(cwd)].some(path => changed.has(path))
    const hasBundle = [...changed].some(isBundleFile)
    if (hasBundle && !hasSource) add('FAIL', 'never edit the bundle by hand')
    else if (hasSource && !hasBundle) add('WARN', "the board bundle is out of date: rebuild with `npx --yes bun@1.4.2 scripts/build-board.ts`, or write 'maintainer rebuilds at merge' under Checks")
    else add('PASS', 'board bundle and its sources changed together or are unchanged.')
  })

  await check('engine helper scan', () => {
    const problems = changed.has('hooks/register.tsx') ? engineProblems(read(join(cwd, 'hooks/register.tsx'))) : []
    if (!problems.length) add('PASS', 'engine helper declarations have no detected problem.')
    for (const item of problems) add('FAIL', `${item.name} at hooks/register.tsx line ${item.line}: the plugin engine refuses a helper that receives \`$\` unless it is a top-level const or function in register.tsx`)
  })

  const processFiles = new Map()
  for (const item of added.filter(item => item.path.startsWith('tests/'))) processFiles.set(item.path, `${processFiles.get(item.path) ?? ''}\n${item.text}`)
  const unsafe = [...processFiles].filter(([, text]) => {
    const tokens = codeTokens(text)
    return tokens.some((token, i) => !token.isString && ['spawn', 'exec', 'execFile', 'fork'].includes(token.value)
      && !['.', '?.'].includes(tokens[i - 1]?.value) && tokens[i + 1]?.value === '(')
      && !/\bfinally\b|\bkill\s*\(/.test(text)
  })
  if (!unsafe.length) add('PASS', 'added test process launches have cleanup markers or none were added.')
  for (const [path] of unsafe) add('WARN', `${path}: a test that starts a process must stop it in \`finally\` and wait for it to exit, on Windows too`)

  if (bodyFile && title) {
    await check('PR body check', () => {
      const checked = command(process.execPath, ['scripts/pr-check.mjs', '--body-file', resolve(cwd, bodyFile), '--title', title, '--no-bundle', '--base', base])
      const first = `${checked.stdout ?? ''}\n${checked.stderr ?? ''}`.split(/\r?\n/).find(line => /^FAIL |^pr-check:/.test(line) && !/^pr-check: new pull request/.test(line))
      add(!checked.error && checked.status === 0 ? 'PASS' : 'FAIL', checked.status === 0 ? 'PR body passed pr-check.' : `PR body: ${first ?? 'pr-check could not finish.'}`)
    })
  } else add('PASS', 'PR body check skipped; supply --body-file and --title to include it.')

  await check('CHANGELOG test titles', () => {
    const fragmentPaths = [...newPaths].filter(isFragmentPath)
    const fragments = fragmentPaths.filter(path => fragmentIssue(path) !== null)
    const invalid = fragmentPaths.filter(path => fragmentIssue(path) === null)
    for (const path of invalid) add('FAIL', `${path}: invalid fragment name; use changelog.d/<issue>-<lowercase-slug>.md with a positive issue number without leading zeros (see changelog.d/README.md).`)
    if (!invalid.length) {
      if (!changed.has('CHANGELOG.md') && !fragments.length && [...changed].some(path => !path.endsWith('.md') && !path.startsWith('docs/'))) add('WARN', 'add a fragment in changelog.d/ (see changelog.d/README.md)')
      else add('PASS', 'CHANGELOG is included or only documentation changed.')
    }
    const lines = existsSync(join(cwd, 'CHANGELOG.md')) ? read(join(cwd, 'CHANGELOG.md')).split(/\r?\n/) : []
    const start = lines.findIndex(line => /^## Unreleased\s*$/.test(line))
    const next = lines.findIndex((line, i) => i > start && /^## /.test(line))
    const touched = new Set(added.filter(item => item.path === 'CHANGELOG.md').map(item => item.line))
    const titles = testDeclarations(cwd)
    const problems = []
    const entries = fragments.map(path => added.filter(item => item.path === path).map(item => item.text).join('\n'))
    if (start !== -1) {
      let at = start + 1
      while (at < (next === -1 ? lines.length : next)) {
        const begin = at
        while (at < (next === -1 ? lines.length : next) && lines[at].trim()) at++
        const entry = lines.slice(begin, at).join('\n')
        if (Array.from({ length: at - begin }, (_, i) => begin + i + 1).some(line => touched.has(line))) {
          entries.push(entry)
        }
        at++
      }
    }
    for (const entry of entries) {
      const tail = entry.match(/\bTests:\s*([\s\S]*)/)?.[1] ?? ''
      for (const match of tail.matchAll(/`([^`\n]+)`/g)) {
        if (/\.test\.(mjs|ts|tsx)$/.test(match[1])) continue
        const count = titles.filter(declaration => titleKnown(match[1], declaration)).length
        if (count !== 1) problems.push(`${match[1]} (${count} test declarations)`)
      }
    }
    add(problems.length ? 'FAIL' : 'PASS', problems.length ? `CHANGELOG must name each test exactly once in tests/: ${problems.join(', ')}.` : 'new CHANGELOG test titles each name exactly one test, or none were listed.')
  })
  return checks
}

// Module callers can isolate synthetic CLI fixtures without a command-line lock override.
export const main = async (argv = process.argv.slice(2), { lockPath, onLockPublished } = {}) => {
  let checks
  const print = item => console.log(`${item.state} ${item.message}`)
  try { checks = await runPreflight({ ...parseArgs(argv), lockPath, onLockPublished, onCheck: print, onProgress: console.log }) } catch (error) {
    checks = [{ state: 'FAIL', message: safeLine(error.message) }]
    print(checks[0])
  }
  const counts = Object.fromEntries(['PASS', 'WARN', 'FAIL'].map(state => [state, checks.filter(item => item.state === state).length]))
  console.log(`preflight: ${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL`)
  return counts.FAIL ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main()
