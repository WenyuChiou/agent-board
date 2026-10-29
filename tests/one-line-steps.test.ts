import { test, expect } from 'claude-code/testing'
import { clipLine, LABEL_ROOM, LINE_ROOM } from '../hooks/clip'
import { parseProgress } from '../hooks/parse'
import { serveModel } from '../hooks/serve'
import { STRINGS } from '../hooks/strings'
import { buildView } from '../hooks/view'

const EN = STRINGS.en
const NOW = Date.parse('2026-10-28T12:00:00Z')
const HOUR = 60 * 60 * 1000
const iso = (at: number): string => new Date(at).toISOString()

const modelOf = (text: string) => serveModel(buildView(parseProgress(text), [], null, NOW, 0, {}, EN), [], EN)

// A UTF-16 half of a pair with no other half beside it.
const LONE_HALF = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

test('clipping a Chinese step never splits a character', () => {
  const chinese = '整理本週的實驗記錄並把每一個結果都寫進報告裡再請老師過目。'.repeat(20)
  // Each of these characters takes two UTF-16 units; the last one that fits must not be cut in half.
  const rare = '𠮷'.repeat(LINE_ROOM + 40)
  const edge = `${'a'.repeat(LINE_ROOM - 2)}𠮷𠮷𠮷`
  for (const text of [chinese, rare, edge]) {
    const { line } = clipLine(text, LINE_ROOM)
    expect(line).toBeDefined()
    expect(Array.from(line ?? '')).toHaveLength(LINE_ROOM)
    expect(line?.endsWith('…')).toBe(true)
    expect(LONE_HALF.test(line ?? '')).toBe(false)
    expect(text.startsWith((line ?? '').slice(0, -1))).toBe(true)
  }
  // The same through the board's model; the record keeps the whole step.
  const file = `## 專案\r\n<!-- auto session=aaaa1111 agent=codex state=working updated=${iso(NOW - HOUR)} -->\r\n### 整理實驗\r\n- [x] ${chinese}\r\n- [~] ${rare}\r\n- [ ] 下一步\r\n<!-- /auto session=aaaa1111 -->\r\n`
  const steps = modelOf(file).groups[0]?.rows[0]?.steps ?? []
  expect(steps.map(step => step.text)).toEqual([chinese, rare, '下一步'])
  expect(steps.map(step => step.line !== undefined)).toEqual([true, true, false])
  for (const step of steps) if (step.line !== undefined) expect(LONE_HALF.test(step.line)).toBe(false)
})

test('Done recently rows show the task title, not a step text', () => {
  const heading = `Wrote the whole work log into the heading: ${'checked one more thing, '.repeat(24)}done`
  const step = `Long finished step ${'with a long account of what happened '.repeat(6)}`
  const file = (title: string) => `## demo\n<!-- auto session=aaaa1111 agent=codex state=done updated=${iso(NOW - HOUR)} -->\n### ${title}\n- [x] A short finished step\n- [x] ${step}\n<!-- /auto session=aaaa1111 -->\n`
  const long = modelOf(file(heading)).recent[0]
  // A heading that is a whole log is the task title, clipped to one line; the full title stays beside it.
  expect(long?.title).toBe(heading)
  expect(Array.from(long?.line ?? '').length).toBeLessThanOrEqual(LINE_ROOM)
  expect(long?.line?.endsWith('…')).toBe(true)
  expect(heading.startsWith((long?.line ?? '').slice(0, -1))).toBe(true)
  expect(long?.line).not.toContain('A short finished step')
  // A short title is shown as it is, and a long step under it never takes its place.
  const short = modelOf(file('Weekly review')).recent[0]
  expect(short?.title).toBe('Weekly review')
  expect(short?.line).toBeUndefined()
  expect(JSON.stringify(short)).not.toContain('Long finished step')
})

test('the board model clips a step to one line and keeps the whole step for a press', () => {
  const longStep = `Write the report ${'and then check every table twice, '.repeat(20)}`.trim()
  const withNote = `Review the draft — ${'the note holds the whole work log '.repeat(20)}`.trim()
  const file = `## Home\n### Weekly plan\n- [x] A short step\n- [ ] ${longStep}\n- [ ] ${withNote}\n- [ ] First line\n`
  const row = modelOf(file).groups[0]?.rows[0]
  const lines = (row?.steps ?? []).map(step => step.line)
  // A step that is one line already has no second copy; the others are folded to one line, and only a whole work log reaches the model's generous cap.
  expect(lines[0]).toBeUndefined()
  expect(Array.from(lines[1] ?? '').length).toBeLessThanOrEqual(LINE_ROOM)
  expect(lines[1]?.endsWith('…')).toBe(true)
  // A step and its note are one step: the line is clipped from both, the parts stay apart.
  expect(lines[2]?.startsWith('Review the draft — the note holds')).toBe(true)
  expect(row?.steps[2]).toMatchObject({ text: 'Review the draft', note: withNote.slice('Review the draft — '.length) })
  expect(lines[3]).toBeUndefined()
  // The Done button names the next step by its first words; a press still sends the whole step.
  expect(row?.next).toBe(longStep)
  expect(Array.from(row?.nextLabel ?? '')).toHaveLength(LABEL_ROOM)
  expect(longStep.startsWith((row?.nextLabel ?? '').slice(0, -1))).toBe(true)
  // Carriage returns and line breaks inside a pasted step fold into one line.
  expect(clipLine('first part\r\nsecond part\rthird part', LINE_ROOM)).toEqual({ line: 'first part second part third part' })
  expect(clipLine('already one line', LINE_ROOM)).toEqual({ line: 'already one line' })
  expect(clipLine('two  spaces and a\ttab', LINE_ROOM)).toEqual({ line: 'two spaces and a tab' })
})

test('a sixty-character Chinese step is sent whole for the page to cut by its width', () => {
  // Sixty of these are about 120 columns wide: no character count fits every screen, so the model
  // cuts nothing here, and the page clips to the width it has (see the 375 px browser test).
  const text = '整'.repeat(60)
  const step = modelOf(`## demo\n### Review\n- [ ] ${text}\n`).groups[0]?.rows[0]?.steps[0]
  expect(step?.text).toBe(text)
  expect(step?.line ?? text).toBe(text)
})
