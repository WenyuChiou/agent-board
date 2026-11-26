import { expect, test } from 'claude-code/testing'

import { splitLines } from '../hooks/lines'
import { currentStepIndex, isCutMarker, isHereProject, NO_OPTIONS, optionsComment, optionsOf, parseProgress, progressTail, readable, validOptions } from '../hooks/parse'

test('splitting progress.md into lines gives the same lines as the regular expression for every mix of CR and LF', () => {
  const alphabet = ['a', '\r', '\n']
  for (let length = 0; length <= 9; length += 1) {
    for (let combination = 0; combination < alphabet.length ** length; combination += 1) {
      let value = combination
      let text = ''
      for (let index = 0; index < length; index += 1) {
        text += alphabet[value % alphabet.length]!
        value = Math.floor(value / alphabet.length)
      }
      expect(splitLines(text)).toEqual(text.split(/\r?\n/))
    }
  }
})

test('a cut auto marker preserves earlier tasks and cannot swallow later complete blocks', () => {
  const blocks = Array.from({ length: 7 }, (_, i) => `<!-- auto session=${10000000 + i} agent=codex state=working -->\n### Task ${i}\n- [ ] Next\n${i === 3 ? '<!-- /auto se' : `<!-- /auto session=${10000000 + i} -->`}\n`).join('\n')
  const source = `## Day\n### Hand kept\n- [ ] Keep\n${blocks}<!-- /auto se`
  const tasks = parseProgress(source).flatMap(project => project.tasks)
  expect(tasks.map(task => task.title)).toEqual(['Hand kept', ...Array.from({ length: 7 }, (_, i) => `Task ${i}`)])
  expect(tasks.slice(1).map(task => task.auto?.session)).toEqual(Array.from({ length: 7 }, (_, i) => String(10000000 + i)))
  expect(progressTail(source)?.tasks).toBe(1)
  expect(source.slice(progressTail(source)?.offset)).toContain('<!-- /auto se')
})

test('torn-tail detection leaves fenced examples and ordinary multiline comments alone', () => {
  for (const source of ['```\n<!-- /auto se\n```\n', '<!-- ordinary comment\n<!-- /auto se\n-->\n']) {
    expect(progressTail(source)).toBe(null)
    expect(parseProgress(source)).toEqual([])
  }
  expect(readable(['<!-- ordinary comment', '## Hidden', '-->', '## Visible'])).toEqual(['', null, '', '## Visible'])
  expect(progressTail('## Day\n<!-- auto session=unfinished -->\n### Keep\n- [ ] Next')).toBe(null)
})

test('a cut marker hiding tasks before a comment close warns without making the tasks readable', () => {
  const source = '<!-- auto session=example\n### Hidden\n- [ ] Hidden step\n-->\n'
  expect(parseProgress(source)).toEqual([])
  expect(progressTail(source)).toEqual({ offset: 0, tasks: 1, close: null })
  expect(readable(source.split('\n'))).toEqual(['', null, null, '', ''])
})

test('a marker cut before its name still shows the blocks after it', () => {
  for (const cut of ['<!-- /au', '<!-- aut', '<!-- question=ab']) {
    const source = `## Day\n${cut}\n<!-- auto session=abcdef12 agent=aider -->\n### Keep\n- [ ] Next\n<!-- /auto session=abcdef12 -->\n`
    expect(parseProgress(source)[0]?.tasks[0]?.auto?.session).toBe('abcdef12')
    expect(progressTail(source)?.offset).toBe('## Day\n'.length)
  }
})

test('a cut marker followed by an arrow in a task line hides nothing', () => {
  const source = '## Day\n<!-- auto session=damaged\n## Later\n### Keep\n- [ ] map a --> b\n'
  expect(parseProgress(source).flatMap(project => project.tasks).map(task => task.title)).toEqual(['Keep'])
  expect(progressTail(source)?.offset).toBe('## Day\n'.length)
})

test('a cut end marker is restored only when it can close the open session', () => {
  for (const cut of ['<!-- /au', '<!-- /auto session=abcdef']) {
    expect(progressTail(`## Day\n<!-- auto session=abcdef12 -->\n### Keep\n${cut}`)?.close).toBe('abcdef12')
  }
  expect(progressTail('## Day\n<!-- auto session=abcdef12 -->\n### Keep\n<!-- /auto session=other')?.close).toBe(null)
  expect(progressTail('## Day\n<!-- auto session=abcdef12 -->\n### Keep\n<!-- /auto session=abcdef12   ')?.close).toBe(null)
})

test('cut markers accept spaces and tabs after the comment opening but U+0085 opens an ordinary comment', () => {
  for (const cut of ['<!--auto', '<!-- \tauto', '<!--\tauto']) expect(isCutMarker(cut)).toBe(true)
  expect(isCutMarker('<!--\u0085auto')).toBe(false)
  expect(readable(['<!--\u0085auto', '## Hidden', '-->'])).toEqual(['', null, ''])
})

test('cut markers trim only trailing spaces tabs and carriage returns', () => {
  for (const ending of [' ', '\t', '\r', ' \t\r']) expect(isCutMarker(`<!-- auto${ending}`)).toBe(true)
  for (const ending of ['\uFEFF', '\x1f']) {
    const line = `<!-- auto${ending}`
    expect(isCutMarker(line)).toBe(false)
    expect(readable([line, '## Hidden', '-->'])).toEqual(['', null, ''])
  }
})

test('an ordinary comment that starts with the word auto hides its lines as before and shows no warning', () => {
  const source = '## P\n### Keep me\n<!-- auto archive of old work\n## Old\n### Old task\n-->\n'
  expect(parseProgress(source).flatMap(project => project.tasks).map(task => task.title)).toEqual(['Keep me'])
  expect(progressTail(source)).toBe(null)
  for (const cut of ['<!-- aut', '<!-- auto', '<!-- auto se', '<!-- /auto session=ab', '<!-- question=ab']) expect(isCutMarker(cut)).toBe(true)
  for (const comment of ['<!--', '<!-- auto archive of old work', '<!-- auto sessions=', '<!-- /auto archive', '<!-- questions=']) expect(isCutMarker(comment)).toBe(false)
})

test('cut-marker look-ahead counts project headings and block markers inside a code fence', () => {
  for (const boundary of ['## Example', '<!-- auto session=example -->', '<!-- /auto session=example -->']) {
    const source = `<!-- auto se\n\`\`\`\n${boundary}\n\`\`\`\n### Visible\n-->\n`
    expect(readable(source.split('\n'))).toEqual(['<!-- auto se', null, null, null, '### Visible', '-->', ''])
    expect(parseProgress(source)[0]?.tasks[0]?.title).toBe('Visible')
  }
})

test('cut-marker look-ahead counts comment closes inside a code fence', () => {
  const source = '<!-- auto se\n```\n-->\n```\n### Visible\n'
  expect(readable(source.split('\n'))).toEqual(['', null, null, null, null, null])
  expect(progressTail(source)).toBe(null)
})

const SAMPLE = `# 專案進度

## alpha
### 修登入
> fix/login · 截止 10-31
- [x] 重現
- [~] 修 token 過期
- [?] 確認要不要登出所有裝置
- [>] 跑 CI
- [!] 部署 — 缺金鑰
- [-] 改 UI
- [ ] 開 PR

## persona_framework (PFC)
<!-- auto session=2be48af2 state=waiting updated=2026-10-16T10:00:00.000Z -->
### 進度面板
> 等你回覆
- [x] 讀 API
- [ ] 寫測試
  - [ ] 子步驟
<!-- /auto session=2be48af2 -->

\`\`\`
## not-a-project
- [ ] not a step
\`\`\`

<!--
## hidden
-->
`

test('reads projects, tasks, notes, every status and the due date', () => {
  const projects = parseProgress(SAMPLE)
  expect(projects.map(p => p.name)).toEqual(['alpha', 'persona_framework (PFC)'])

  const login = projects[0]?.tasks[0]
  expect(login?.title).toBe('修登入')
  expect(login?.due).toBe('10-31')
  expect(login?.auto).toBe(null)
  expect(login?.steps.map(s => s.status)).toEqual([
    'done',
    'doing',
    'waiting',
    'running',
    'blocked',
    'cancelled',
    'todo',
  ])
})

test('a block between auto markers carries its session, state and time', () => {
  const panel = parseProgress(SAMPLE)[1]?.tasks[0]
  expect(panel?.title).toBe('進度面板')
  expect(panel?.auto).toEqual({
    session: '2be48af2',
    agent: 'claude',
    state: 'waiting',
    updated: Date.parse('2026-10-16T10:00:00.000Z'),
    resume: null,
    dir: null,
    pr: null,
    ci: null,
  })
  expect(panel?.steps.map(s => s.depth)).toEqual([0, 0, 1])
})

test('highlights the [~] step, else the first open one', () => {
  const [alpha, pfc] = parseProgress(SAMPLE)
  expect(alpha?.tasks[0] && currentStepIndex(alpha.tasks[0])).toBe(1)
  expect(pfc?.tasks[0] && currentStepIndex(pfc.tasks[0])).toBe(1)
})

test('steps without a ### heading still land in a task', () => {
  const [only] = parseProgress('## 求職\n- [ ] 改履歷\n- [x] 問推薦人\n')
  expect(only?.tasks).toHaveLength(1)
  expect(only?.tasks[0]?.steps).toHaveLength(2)
})

test('a project heading matches the repo it names', () => {
  expect(isHereProject('Persona_Framework — PFC', ['persona_framework'])).toBe(true)
  expect(isHereProject('alpha', ['persona_framework'])).toBe(false)
})

test('options markers attach cleaned choice lists to waiting steps inside owned auto blocks and round-trip safely', () => {
  const stepText = 'Which database should I use?'
  const block = [
    '## synthetic-api',
    '<!-- auto session=ab12cd34 agent=codex state=waiting updated=2026-10-30T12:00:00.000Z -->',
    '### Pick storage',
    `- [?] ${stepText}`,
    '<!-- options=["Postgres","SQLite","MySQL"] -->',
    '- [x] Done step',
    '<!-- options=["IgnoreA","IgnoreB"] -->',
    '<!-- /auto session=ab12cd34 -->',
    '### Hand kept',
    `- [?] ${stepText}`,
    '<!-- options=["HandA","HandB"] -->',
  ].join('\n')
  const parsed = parseProgress(block)
  expect(parsed[0]?.tasks[0]?.steps[0]?.options).toEqual(['Postgres', 'SQLite', 'MySQL'])
  expect(parsed[0]?.tasks[0]?.steps[1]?.options).toBeUndefined()
  expect(parsed[0]?.tasks[1]?.steps[0]?.options).toBeUndefined()
  expect(readable(block.split('\n')).filter(line => line?.includes('<!-- options='))).toEqual(['<!-- options=["Postgres","SQLite","MySQL"] -->', '<!-- options=["IgnoreA","IgnoreB"] -->', '<!-- options=["HandA","HandB"] -->'])
  expect(readable(['<!-- options=cut', '## Next', '### Keep']).slice(1)).toEqual(['## Next', '### Keep'])
  expect(isCutMarker('<!-- options=["Postgres"')).toBe(true)
  expect(isCutMarker('<!--   options=')).toBe(true)

  const escaped = ['_config.yml', 'c -- d']
  const escapedBlock = [
    '## synthetic-api',
    '<!-- auto session=ab12cd34 agent=codex state=waiting updated=2026-10-30T12:00:00.000Z -->',
    '### Escape test',
    `- [?] ${stepText}`,
    optionsComment(escaped),
    '<!-- /auto session=ab12cd34 -->',
  ].join('\n')
  const reparsed = parseProgress(escapedBlock)
  expect(reparsed[0]?.tasks[0]?.steps[0]?.options).toEqual(['_config.yml', 'c -- d'])
})

test('short comment openings like <!-- opt stay hidden while <!-- options= stays a cut marker (#1277)', () => {
  expect(isCutMarker('<!-- opt')).toBe(false)
  expect(isCutMarker('<!-- o')).toBe(false)
  expect(isCutMarker('<!-- options=')).toBe(true)

  const parsed = parseProgress('## P\n### T\n- [x] a\n<!-- opt\n## Hidden\n### Hidden task\n- [ ] secret\n-->')
  expect(parsed.map(project => project.name)).toEqual(['P'])
  expect(parsed[0]?.tasks.map(task => task.title)).toEqual(['T'])
})

test('a choice is measured in characters, not UTF-16 units: 120 emoji are kept and 121 refused (#1277)', () => {
  const emoji = '\u{1F600}'
  expect(emoji.length).toBe(2)
  expect(validOptions([emoji.repeat(120), 'SQLite'])).toEqual([emoji.repeat(120), 'SQLite'])
  expect(validOptions([emoji.repeat(121), 'SQLite'])).toBeNull()
  expect(validOptions([emoji.repeat(61), 'SQLite'])).toEqual([emoji.repeat(61), 'SQLite'])
  // A rare CJK character outside the first plane counts as one too; ASCII and common CJK keep their bounds.
  expect(validOptions(['\u{20BB7}'.repeat(120), '中'.repeat(120)])).toEqual(['\u{20BB7}'.repeat(120), '中'.repeat(120)])
  expect(validOptions(['中'.repeat(121), 'SQLite'])).toBeNull()
  expect(validOptions(['a'.repeat(121), 'SQLite'])).toBeNull()

  const line = optionsComment([emoji.repeat(120), 'SQLite'])
  expect(line).not.toBe('')
  expect(optionsOf(line)).toEqual([emoji.repeat(120), 'SQLite'])
  expect(optionsComment([emoji.repeat(121), 'SQLite'])).toBe('')
  expect(optionsOf(`<!-- options=${JSON.stringify([emoji.repeat(121), 'SQLite'])} -->`)).toBeNull()
})

test('an options line with a comment opening or over-long entry is refused whole', () => {
  expect(validOptions(['Postgres <!-- private note -->', 'SQLite'])).toBeNull()
  expect(validOptions(['Postgres --> hidden', 'SQLite'])).toBeNull()
  expect(validOptions(['a'.repeat(121), 'SQLite'])).toBeNull()
  expect(validOptions(['', 'SQLite'])).toBeNull()
  expect(validOptions(['   ', 'SQLite'])).toBeNull()
  expect(validOptions(['OnlyOne'])).toBeNull()
  expect(validOptions(Array.from({ length: 10 }, (_, i) => `Option ${i + 1}`))).toBeNull()
  expect(validOptions(['  _config.yml  ', 'a'.repeat(120)])).toEqual(['_config.yml', 'a'.repeat(120)])

  expect(optionsComment(['Postgres <!-- hidden -->', 'SQLite'])).toBe('')
  expect(optionsComment(['a'.repeat(121), 'SQLite'])).toBe('')
  expect(optionsOf(`<!-- options=${JSON.stringify(['Postgres', 'x'.repeat(121)])} -->`)).toBeNull()
  expect(optionsOf('<!-- options=["a \\u002d\\u002d\\u003e b","SQLite"] -->')).toBeNull()
  expect(optionsOf('<!-- options=["\\u003c!-- a","SQLite"] -->')).toBeNull()
  expect(optionsOf(`<!-- options=${JSON.stringify(Array.from({ length: 10 }, (_, i) => `O${i}`))} -->`)).toBeNull()

  const blockWithBadOptions = [
    '## synthetic-api',
    '<!-- auto session=ab12cd34 agent=codex state=waiting updated=2026-10-30T12:00:00.000Z -->',
    '### Pick storage',
    '- [?] Which database should I use?',
    `<!-- options=${JSON.stringify(['Postgres', 'x'.repeat(121)])} -->`,
    '- [?] Which file?',
    '<!-- options=["\\u003c!-- bad","SQLite"] -->',
    '<!-- /auto session=ab12cd34 -->',
  ].join('\n')
  const parsed = parseProgress(blockWithBadOptions)
  // A refused line leaves the step with no choices (an empty list), never a part of the list;
  // a step with no line at all has none to refuse.
  expect(parsed[0]?.tasks[0]?.steps[0]?.options).toEqual([])
  expect(parsed[0]?.tasks[0]?.steps[1]?.options).toEqual([])
  expect(parseProgress(blockWithBadOptions.split('\n').filter(line => !line.startsWith('<!-- options=')).join('\n'))[0]?.tasks[0]?.steps.map(step => step.options)).toEqual([undefined, undefined])
  expect(parseProgress(blockWithBadOptions.replace(/^<!-- options=.*$/m, NO_OPTIONS))[0]?.tasks[0]?.steps[0]?.options).toEqual([])
})

test('a hand-kept task heading may end with a session trailer that names its writer, and the title stays plain', () => {
  const file = '## Home\n### Water the synthetic plants <!-- session=ab12cd34 -->\n- [ ] Fill the can\n### No trailer\n- [ ] Next\n### Bad <!-- session=a b -->\n- [ ] Other\n'
  const tasks = parseProgress(file).flatMap(project => project.tasks)
  expect(tasks.map(task => [task.title, task.writer, task.steps.length])).toEqual([
    ['Water the synthetic plants', 'ab12cd34', 1],
    ['No trailer', undefined, 1],
    ['Bad', undefined, 1],
  ])
})

test('a file with session trailers reads as the same file without them, apart from the writer a newer board names', () => {
  const plain = '## Home\n### Water the synthetic plants\n> Context: synthetic\n- [ ] Fill the can\n- [x] Find the can\n### Other\n- [?] Ask\n'
  const trailed = plain.replace('plants', 'plants <!-- session=ab12cd34 -->').replace('### Other', '### Other <!-- session=zz99zz99 -->')
  const withoutWriter = parseProgress(trailed).map(project => ({ ...project, tasks: project.tasks.map(({ writer: _writer, ...task }) => task) }))
  expect(withoutWriter).toEqual(parseProgress(plain))
})
