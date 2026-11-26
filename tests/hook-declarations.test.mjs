import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })

const { agentHooks, DELETE, writeConfig } = await import('../hooks/connect-pure.ts')
const { antigravityHooks, hookCommandArgs, localAgents, planEvents, statusEvents } = await import('../hooks/local-agents.ts')
const { openclawLocalPlugin, deepseekPatch } = await import('../hooks/portable-agents.ts')
const { HOOK_TIMEOUTS } = await import('../hooks/hook-safety.ts')
const { EN } = await import('../hooks/strings-en.ts')
const { runCodexLocal } = await import('../scripts/codex-local.ts')

void [antigravityHooks, hookCommandArgs, planEvents, statusEvents, openclawLocalPlugin, deepseekPatch, HOOK_TIMEOUTS]

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const BASE_VERSION = '0.25.1'
const BASE_TAG = `agent-board--v${BASE_VERSION}`
const tempDirs = []
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const extractBaseRelease = t => {
  const available = spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${BASE_TAG}^{commit}`], { encoding: 'utf8', windowsHide: true })
  assert.ifError(available.error)
  if (available.status !== 0) {
    assert.ok(!process.env.CI, `${BASE_TAG} is missing in CI; the board job fetches the whole history with its tags`)
    t.skip(`${BASE_TAG} is missing locally; run git fetch --tags to compare hook declarations`)
    return null
  }
  const folder = mkdtempSync(join(tmpdir(), 'hook-decl-v0251-'))
  tempDirs.push(folder)
  const archive = spawnSync('git', ['-C', repoRoot, 'archive', '--format=tar', BASE_TAG, 'scripts', 'hooks', 'bin', 'package.json'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  assert.ifError(archive.error)
  assert.equal(archive.status, 0, archive.stderr?.toString('utf8') || `git archive ${BASE_TAG} failed`)
  const untar = spawnSync('tar', ['-x', '-f', '-'], { cwd: folder, input: archive.stdout, encoding: 'utf8', windowsHide: true })
  assert.ifError(untar.error)
  assert.equal(untar.status, 0, untar.stderr || `tar extract ${BASE_TAG} failed`)
  assert.equal(JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).version, BASE_VERSION, `${BASE_TAG} must match baseline ${BASE_VERSION}`)
  return folder
}

// Parses Hermes YAML `hooks:` entries (`event` -> ordered list of `{ command, timeout, matcher }`)
// so changes to matchers, timeouts or events inside YAML fail explicitly even when command text matches.
const parseHermesYamlHooks = text => {
  const events = {}
  const lines = text.split(/\r?\n/)
  let hooksIndent = null
  let currentEvent = null
  let eventIndent = null
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = raw.search(/\S/)
    if (hooksIndent === null) {
      if (trimmed === 'hooks:') hooksIndent = indent
      continue
    }
    if (indent <= hooksIndent) { hooksIndent = null; currentEvent = null; continue }
    const keyMatch = /^([A-Za-z0-9_]+)\s*:(?:\s*(?:\[\])?\s*)?$/.exec(trimmed)
    if (keyMatch && (eventIndent === null || indent <= eventIndent)) {
      currentEvent = keyMatch[1]
      eventIndent = indent
      events[currentEvent] ??= []
      continue
    }
    if (currentEvent !== null && trimmed.startsWith('-')) {
      const cmdMatch = /\bcommand\s*:\s*("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^,}\]]+)/.exec(trimmed)
      const timeoutMatch = /\btimeout\s*:\s*(\d+)/.exec(trimmed)
      const matcherMatch = /\bmatcher\s*:\s*("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^,}\s#]+)/.exec(trimmed)
      const decode = value => {
        if (value === undefined) return undefined
        if (value.startsWith('"')) return JSON.parse(value)
        if (value.startsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
        return value
      }
      events[currentEvent].push({
        command: decode(cmdMatch?.[1]),
        timeout: timeoutMatch ? Number(timeoutMatch[1]) : undefined,
        ...(matcherMatch ? { matcher: decode(matcherMatch[1]) } : {}),
      })
    }
  }
  return { events }
}

// Extracts comparable structural declarations from generated hook files by host shape.
export const extractHookDeclarations = (shape, content) => {
  if (content === null) return { removed: true }
  if (typeof content === 'symbol') return { symbol: content.description ?? String(content) }
  if (shape === 'hermes-yaml') return parseHermesYamlHooks(content)
  if (shape === 'text') return { text: content }
  const json = JSON.parse(content)
  if (shape === 'grouped') {
    const events = {}
    for (const [event, groups] of Object.entries(json.hooks ?? {})) {
      events[event] = (Array.isArray(groups) ? groups : []).map(group => ({
        ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
        hooks: (Array.isArray(group.hooks) ? group.hooks : []).map(h => ({
          type: h.type,
          ...(h.name !== undefined ? { name: h.name } : {}),
          ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
          command: h.command,
        })),
      }))
    }
    return { topKeys: Object.keys(json).filter(k => k !== 'hooks').sort(), events }
  }
  if (shape === 'flat') {
    const events = {}
    for (const [event, entries] of Object.entries(json.hooks ?? {})) {
      events[event] = (Array.isArray(entries) ? entries : []).map(entry => ({
        ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
        command: entry.command,
      }))
    }
    return { version: json.version, events }
  }
  if (shape === 'antigravity') return json
  if (shape === 'openclaw-json') return json
  throw new Error(`Unknown shape: ${shape}`)
}

export const compareHookDeclarations = (label, expectedDecl, actualDecl) => {
  const diffs = []
  try {
    assert.deepStrictEqual(actualDecl, expectedDecl)
  } catch {
    if (expectedDecl?.events && actualDecl?.events) {
      const expectedEvents = Object.keys(expectedDecl.events).sort()
      const actualEvents = Object.keys(actualDecl.events).sort()
      for (const e of actualEvents) if (!expectedEvents.includes(e)) diffs.push(`${label}: added event ${e}`)
      for (const e of expectedEvents) if (!actualEvents.includes(e)) diffs.push(`${label}: removed event ${e}`)
      for (const e of expectedEvents.filter(one => actualEvents.includes(one))) {
        const expList = expectedDecl.events[e]
        const actList = actualDecl.events[e]
        if (!Array.isArray(expList) || !Array.isArray(actList)) {
          if (JSON.stringify(expList) !== JSON.stringify(actList)) diffs.push(`${label}.${e}: structure changed`)
          continue
        }
        if (expList.length !== actList.length) diffs.push(`${label}.${e}: group/entry count ${expList.length} -> ${actList.length}`)
        for (let i = 0; i < Math.min(expList.length, actList.length); i++) {
          const eg = expList[i]
          const ag = actList[i]
          if (eg?.matcher !== ag?.matcher) diffs.push(`${label}.${e}[${i}]: matcher ${JSON.stringify(eg?.matcher)} -> ${JSON.stringify(ag?.matcher)}`)
          if (eg?.timeout !== ag?.timeout) diffs.push(`${label}.${e}[${i}]: timeout ${eg?.timeout} -> ${ag?.timeout}`)
          if (eg?.hooks && ag?.hooks) {
            if (eg.hooks.length !== ag.hooks.length) diffs.push(`${label}.${e}[${i}]: hooks count ${eg.hooks.length} -> ${ag.hooks.length}`)
            for (let j = 0; j < Math.min(eg.hooks.length, ag.hooks.length); j++) {
              if (eg.hooks[j]?.timeout !== ag.hooks[j]?.timeout) diffs.push(`${label}.${e}[${i}].hooks[${j}]: timeout ${eg.hooks[j]?.timeout} -> ${ag.hooks[j]?.timeout}`)
              if (eg.hooks[j]?.type !== ag.hooks[j]?.type) diffs.push(`${label}.${e}[${i}].hooks[${j}]: type ${eg.hooks[j]?.type} -> ${ag.hooks[j]?.type}`)
              if (eg.hooks[j]?.name !== ag.hooks[j]?.name) diffs.push(`${label}.${e}[${i}].hooks[${j}]: name ${eg.hooks[j]?.name} -> ${ag.hooks[j]?.name}`)
              if (eg.hooks[j]?.command !== ag.hooks[j]?.command) diffs.push(`${label}.${e}[${i}].hooks[${j}]: command changed`)
            }
          } else if (eg?.command !== ag?.command) {
            diffs.push(`${label}.${e}[${i}]: command changed`)
          }
        }
      }
    }
    if (diffs.length === 0) diffs.push(`${label}: declaration mismatch`)
  }
  return diffs
}

const assertDeclarationsEqual = (label, expectedDecl, actualDecl) => {
  const diffs = compareHookDeclarations(label, expectedDecl, actualDecl)
  assert.deepStrictEqual(diffs, [], `${label} changed vs ${BASE_VERSION}:\n${diffs.join('\n')}`)
  assert.deepStrictEqual(actualDecl, expectedDecl, `${label} full declaration mismatch vs ${BASE_VERSION}`)
}

test('#1825: 0.25.2 plugin hooks.json matches 0.25.1 across events, matchers, timeouts and groups', t => {
  const baseDir = extractBaseRelease(t)
  if (!baseDir) return
  const expected = extractHookDeclarations('grouped', readFileSync(join(baseDir, 'hooks', 'hooks.json'), 'utf8'))
  const actual = extractHookDeclarations('grouped', readFileSync(join(repoRoot, 'hooks', 'hooks.json'), 'utf8'))
  assertDeclarationsEqual('hooks/hooks.json', expected, actual)
})

const shapeOfConnectTarget = target => {
  if (target.agent === 'hermes') return 'hermes-yaml'
  if (target.agent === 'cursor') return 'flat'
  if (target.agent === 'antigravity') return 'antigravity'
  if (target.agent === 'openclaw' && target.file.endsWith('.json')) return 'openclaw-json'
  if (target.agent === 'codex' || target.agent === 'gemini' || target.agent === 'grok' || target.agent === 'muse') return 'grouped'
  return 'text'
}

const foreignSeedForConnect = target => {
  if (target.agent === 'codex' || target.agent === 'grok' || target.agent === 'muse' || target.agent === 'gemini') {
    const event = target.agent === 'gemini' ? 'AfterTool' : 'PostToolUse'
    return `${JSON.stringify({ hooks: { [event]: [{ matcher: 'foreign_tool', hooks: [{ type: 'command', command: 'echo foreign', timeout: 7 }] }] } }, null, 2)}\n`
  }
  if (target.agent === 'cursor') return `${JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [{ command: 'echo foreign', timeout: 7 }] } }, null, 2)}\n`
  if (target.agent === 'antigravity') return `${JSON.stringify({ 'foreign-hook': { PreInvocation: [{ type: 'command', command: 'echo foreign', timeout: 7 }] } }, null, 2)}\n`
  if (target.agent === 'hermes') return 'model: default\nhooks:\n  post_tool_call:\n    - {command: "echo foreign", timeout: 30, matcher: "foreign_tool"}\n'
  if (target.agent === 'openclaw' && target.file.endsWith('.json')) return `${JSON.stringify({ plugins: { load: { paths: ['/foreign/plugin.js'] }, entries: { foreign: { enabled: true } }, allow: ['foreign'] } }, null, 2)}\n`
  return ''
}

test('#1825: 0.25.2 /progress connect generated hook declarations match 0.25.1 across OS, path and Node contexts (empty, foreign additions and removals)', async t => {
  const baseDir = extractBaseRelease(t)
  if (!baseDir) return
  const baseConnect = await import(pathToFileURL(join(baseDir, 'hooks', 'connect-pure.ts')).href)

  // `script` is the reporter in the data folder, as every connect passes it (connectContext in
  // scripts/connect-transaction.ts, scripts/legacy-connect.ts, scripts/codex-local.ts): a removal
  // knows our hooks by it, so another name would leave them in and compare no removal at all.
  const contexts = [
    {
      name: 'linux-with-board',
      home: '/home/syn-user',
      sep: '/',
      isWindows: false,
      script: '/home/syn-user/project/progress-report.sh',
      inbox: '/home/syn-user/.claude/inbox',
      codexHome: '/home/syn-user/.codex',
      grokHome: '/home/syn-user/.grok',
      hermesHome: '/home/syn-user/.hermes',
      openclawHome: '/home/syn-user/.openclaw',
      opencodeHome: '/home/syn-user/.config/opencode',
      board: '/home/syn-user/project/progress.md',
      node: '/opt/node-22/bin/node',
      progress: '/home/syn-user/project/progress.md',
    },
    {
      name: 'windows-encoded',
      home: 'C:\\Users\\syn user',
      sep: '\\',
      isWindows: true,
      script: 'C:\\Users\\syn user\\my proj\\progress-report.ps1',
      inbox: 'C:\\Users\\syn user\\.claude\\inbox',
      codexHome: 'C:\\Users\\syn user\\.codex',
      grokHome: 'C:\\Users\\syn user\\.grok',
      hermesHome: 'C:\\Users\\syn user\\.hermes',
      openclawHome: 'C:\\Users\\syn user\\.openclaw',
      opencodeHome: 'C:\\Users\\syn user\\.config\\opencode',
      board: 'C:\\Users\\syn user\\my proj\\progress.md',
      node: 'C:\\Program Files\\nodejs\\node.exe',
      progress: 'C:\\Users\\syn user\\my proj\\progress.md',
    },
    {
      name: 'windows-direct-antigravity-node',
      home: 'C:\\Users\\syn',
      sep: '\\',
      isWindows: true,
      script: 'C:\\Users\\syn\\proj\\progress-report.ps1',
      inbox: 'C:\\Users\\syn\\.claude\\inbox',
      codexHome: 'C:\\Users\\syn\\.codex',
      grokHome: 'C:\\Users\\syn\\.grok',
      hermesHome: 'C:\\Users\\syn\\.hermes',
      openclawHome: 'C:\\Users\\syn\\.openclaw',
      opencodeHome: 'C:\\Users\\syn\\.config\\opencode',
      board: 'C:\\Users\\syn\\proj\\progress.md',
      node: 'C:\\Program Files\\nodejs\\node.exe',
      antigravityNode: 'C:\\PROGRA~1\\nodejs\\node.exe',
      progress: 'C:\\Users\\syn\\proj\\progress.md',
    },
    {
      name: 'linux-no-board',
      home: '/home/syn-user',
      sep: '/',
      isWindows: false,
      script: '/home/syn-user/.agent-board/progress-report.sh',
      inbox: '/home/syn-user/.claude/inbox',
      codexHome: '/home/syn-user/.codex',
      grokHome: '/home/syn-user/.grok',
      hermesHome: '/home/syn-user/.hermes',
      openclawHome: '/home/syn-user/.openclaw',
      opencodeHome: '/home/syn-user/.config/opencode',
      node: '/usr/local/bin/node',
    },
  ]

  for (const ctx of contexts) {
    const baseTargets = baseConnect.agentHooks(ctx)
    const headTargets = agentHooks(ctx)
    const signature = list => list.map(one => ({ agent: one.agent, file: one.file, setupFile: one.setupFile, old: one.old, generated: Boolean(one.generated) }))
    assert.deepStrictEqual(signature(headTargets), signature(baseTargets), `${ctx.name}: target file/agent inventory changed`)

    for (let i = 0; i < baseTargets.length; i++) {
      const b = baseTargets[i]
      const h = headTargets[i]
      if (b.label === '') continue // skip board skills/commands; this test pins hook declarations
      const shape = shapeOfConnectTarget(b)

      // 1) Addition into empty config
      const baseEmpty = b.edit('', false)
      const headEmpty = h.edit('', false)
      assertDeclarationsEqual(`${ctx.name}/${b.agent}(${b.file}) empty add`, extractHookDeclarations(shape, baseEmpty), extractHookDeclarations(shape, headEmpty))

      // 2) Addition alongside foreign hooks & removal preserving foreign hooks (shared config targets)
      const seed = b.generated ? '' : foreignSeedForConnect(b)
      if (seed !== '') {
        const baseWithForeign = b.edit(seed, false)
        const headWithForeign = h.edit(seed, false)
        assert.equal(typeof headWithForeign, 'string', `${ctx.name}/${b.agent}: shared config merge must not collide`)
        assertDeclarationsEqual(`${ctx.name}/${b.agent}(${b.file}) foreign add`, extractHookDeclarations(shape, baseWithForeign), extractHookDeclarations(shape, headWithForeign))

        const baseRemoved = b.edit(baseWithForeign, true)
        const headRemoved = h.edit(headWithForeign, true)
        assert.equal(typeof headRemoved, 'string', `${ctx.name}/${b.agent}: removal from shared config must keep foreign hooks`)
        assertDeclarationsEqual(`${ctx.name}/${b.agent}(${b.file}) foreign remove`, extractHookDeclarations(shape, baseRemoved), extractHookDeclarations(shape, headRemoved))
      } else if (b.generated && typeof baseEmpty === 'string' && typeof headEmpty === 'string') {
        assert.equal(b.edit(baseEmpty, true), baseConnect.DELETE, `${ctx.name}/${b.agent}: 0.25.1 generated file remove`)
        assert.equal(h.edit(headEmpty, true), DELETE, `${ctx.name}/${b.agent}: 0.25.2 generated file remove`)
      }
    }
  }
})

const configSpecForLocalAgent = (agent, paths) => {
  if (agent === 'codex') return { file: join(paths.codexDir, 'hooks.json'), shape: 'grouped' }
  if (agent === 'cursor') return { file: join(paths.home, '.cursor', 'hooks.json'), shape: 'flat' }
  if (agent === 'gemini') return { file: join(paths.home, '.gemini', 'settings.json'), shape: 'grouped' }
  if (agent === 'grok') return { file: join(paths.grokDir, 'hooks', 'agent-board-local.json'), shape: 'grouped' }
  if (agent === 'muse') return { file: join(paths.home, '.config', 'muse', 'settings.json'), shape: 'grouped' }
  if (agent === 'hermes') return { file: join(paths.hermesDir, 'config.yaml'), shape: 'hermes-yaml' }
  if (agent === 'antigravity') return { file: join(paths.home, '.gemini', 'config', 'hooks.json'), shape: 'antigravity' }
  if (agent === 'openclaw') return { file: join(paths.openclawDir, 'openclaw.json'), shape: 'openclaw-json' }
  if (agent === 'deepseek') return { file: join(paths.deepseekDir, 'cordis.patch.yml'), shape: 'text' }
  if (agent === 'opencode') return { file: join(paths.opencodeDir, 'plugins', 'agent-board-local.js'), shape: 'text' }
  throw new Error(`Unknown agent: ${agent}`)
}

const seedForeignLocalConfig = (agent, spec) => {
  // grok (`agent-board-local.json`) and opencode (`agent-board-local.js`) are dedicated owned files;
  // pre-existing content in those files is treated as a collision rather than a shared config.
  if (agent === 'grok' || agent === 'opencode') return
  mkdirSync(join(spec.file, '..'), { recursive: true })
  if (agent === 'codex' || agent === 'muse' || agent === 'gemini') {
    const event = agent === 'gemini' ? 'AfterTool' : 'PostToolUse'
    writeFileSync(spec.file, writeConfig({ hooks: { [event]: [{ matcher: 'foreign_tool', hooks: [{ type: 'command', command: 'echo foreign', timeout: 7 }] }] } }))
  } else if (agent === 'cursor') {
    writeFileSync(spec.file, writeConfig({ version: 1, hooks: { beforeSubmitPrompt: [{ command: 'echo foreign', timeout: 7 }] } }))
  } else if (agent === 'antigravity') {
    writeFileSync(spec.file, writeConfig({ 'foreign-hook': { PreInvocation: [{ type: 'command', command: 'echo foreign', timeout: 7 }] } }))
  } else if (agent === 'hermes') {
    writeFileSync(spec.file, 'model: default\nhooks:\n  post_tool_call:\n    - {command: "echo foreign", timeout: 30, matcher: "foreign_tool"}\n')
  } else if (agent === 'openclaw') {
    writeFileSync(spec.file, writeConfig({ plugins: { load: { paths: ['/foreign/plugin.js'] }, entries: { foreign: { enabled: true } }, allow: ['foreign'] } }))
  } else if (agent === 'deepseek') {
    writeFileSync(spec.file, '- insert:\n    - id: foreign-plugin\n      name: "/foreign.mjs"\n')
  }
}

test('#1825: 0.25.2 standalone setup generated hook declarations match 0.25.1 across all agents, additions and removals', async t => {
  const baseDir = extractBaseRelease(t)
  if (!baseDir) return
  const baseCodexLocal = await import(pathToFileURL(join(baseDir, 'scripts', 'codex-local.ts')).href)

  // Use one fixed synthetic root path across both 0.25.1 and 0.25.2 runs so base64 bootstraps
  // containing encoded paths and process.execPath match byte-for-byte.
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'hook-decl-local-'))
  tempDirs.push(fixtureRoot)

  const paths = {
    home: join(fixtureRoot, 'home'),
    dataDir: join(fixtureRoot, 'data'),
    progress: join(fixtureRoot, 'proj', 'progress.md'),
    codexDir: join(fixtureRoot, 'codex-home'),
    grokDir: join(fixtureRoot, 'grok-home'),
    hermesDir: join(fixtureRoot, 'hermes-home'),
    opencodeDir: join(fixtureRoot, 'opencode-home'),
    openclawDir: join(fixtureRoot, 'openclaw-home'),
    deepseekDir: join(fixtureRoot, 'deepseek-home'),
  }
  const commonFlags = [
    '--home', paths.home,
    '--data-dir', paths.dataDir,
    '--progress-file', paths.progress,
    '--codex-dir', paths.codexDir,
    '--grok-dir', paths.grokDir,
    '--hermes-dir', paths.hermesDir,
    '--opencode-dir', paths.opencodeDir,
    '--openclaw-dir', paths.openclawDir,
    '--deepseek-dir', paths.deepseekDir,
    '--json',
    '--apply',
  ]

  const resetFixture = withForeign => {
    for (const sub of ['home', 'data', 'proj', 'codex-home', 'grok-home', 'hermes-home', 'opencode-home', 'openclaw-home', 'deepseek-home']) {
      rmSync(join(fixtureRoot, sub), { recursive: true, force: true })
    }
    mkdirSync(join(fixtureRoot, 'home'), { recursive: true })
    mkdirSync(join(fixtureRoot, 'data'), { recursive: true })
    mkdirSync(join(fixtureRoot, 'proj'), { recursive: true })
    writeFileSync(paths.progress, '# Synthetic board\n')
    if (withForeign) {
      for (const agent of localAgents) seedForeignLocalConfig(agent, configSpecForLocalAgent(agent, paths))
    }
  }

  const runSuite = async (runner, withForeign) => {
    resetFixture(withForeign)
    const installed = {}
    const removed = {}
    for (const agent of localAgents) {
      const spec = configSpecForLocalAgent(agent, paths)
      await runner(['--codex-setup', '--agent', agent, ...commonFlags], paths.progress, EN, undefined, { output: () => {} })
      installed[agent] = extractHookDeclarations(spec.shape, existsSync(spec.file) ? readFileSync(spec.file, 'utf8') : null)
      await runner(['--codex-remove', '--agent', agent, ...commonFlags], paths.progress, EN, undefined, { output: () => {} })
      removed[agent] = extractHookDeclarations(spec.shape, existsSync(spec.file) ? readFileSync(spec.file, 'utf8') : null)
    }
    return { installed, removed }
  }

  const baseEmpty = await runSuite(baseCodexLocal.runCodexLocal, false)
  const headEmpty = await runSuite(runCodexLocal, false)
  const baseForeign = await runSuite(baseCodexLocal.runCodexLocal, true)
  const headForeign = await runSuite(runCodexLocal, true)

  for (const agent of localAgents) {
    assertDeclarationsEqual(`local/${agent} empty install`, baseEmpty.installed[agent], headEmpty.installed[agent])
    assertDeclarationsEqual(`local/${agent} empty remove`, baseEmpty.removed[agent], headEmpty.removed[agent])
    assertDeclarationsEqual(`local/${agent} foreign install`, baseForeign.installed[agent], headForeign.installed[agent])
    assertDeclarationsEqual(`local/${agent} foreign remove`, baseForeign.removed[agent], headForeign.removed[agent])
  }
})

test('#1658: hook declaration comparator fails on changed matchers, timeouts, events, groups or removals even when commands stay unchanged', () => {
  const baseCodex = extractHookDeclarations('grouped', writeConfig({
    hooks: {
      PostToolUse: [{ matcher: 'update_plan', hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 10 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 10 }] }],
    },
  }))

  const changedMatcher = extractHookDeclarations('grouped', writeConfig({
    hooks: {
      PostToolUse: [{ matcher: 'write_plan', hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 10 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 10 }] }],
    },
  }))
  assert.ok(compareHookDeclarations('codex', baseCodex, changedMatcher).some(d => d.includes('matcher')))

  const changedTimeout = extractHookDeclarations('grouped', writeConfig({
    hooks: {
      PostToolUse: [{ matcher: 'update_plan', hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 10 }] }],
    },
  }))
  assert.ok(compareHookDeclarations('codex', baseCodex, changedTimeout).some(d => d.includes('timeout')))

  const addedEvent = extractHookDeclarations('grouped', writeConfig({
    hooks: {
      PostToolUse: [{ matcher: 'update_plan', hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 10 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 10 }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 3 }] }],
    },
  }))
  assert.ok(compareHookDeclarations('codex', baseCodex, addedEvent).some(d => d.includes('added event SessionEnd')))

  const removedEvent = extractHookDeclarations('grouped', writeConfig({
    hooks: {
      PostToolUse: [{ matcher: 'update_plan', hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 10 }] }],
    },
  }))
  assert.ok(compareHookDeclarations('codex', baseCodex, removedEvent).some(d => d.includes('removed event Stop')))

  const addedGroup = extractHookDeclarations('grouped', writeConfig({
    hooks: {
      PostToolUse: [
        { matcher: 'update_plan', hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 10 }] },
        { matcher: 'other_plan', hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 10 }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 10 }] }],
    },
  }))
  assert.ok(compareHookDeclarations('codex', baseCodex, addedGroup).some(d => d.includes('group/entry count')))

  const baseHermes = extractHookDeclarations('hermes-yaml', 'hooks:\n  post_tool_call:\n    - {command: "sh hook.sh", timeout: 10, matcher: todo}\n')
  const changedHermesMatcher = extractHookDeclarations('hermes-yaml', 'hooks:\n  post_tool_call:\n    - {command: "sh hook.sh", timeout: 10, matcher: plan}\n')
  assert.ok(compareHookDeclarations('hermes', baseHermes, changedHermesMatcher).some(d => d.includes('matcher')))
})
