import { eolOf, linesOf, manualTaskLast, scanBlocks, seenOf, sectionOfProject } from './blocks'
import { readable } from './parse'
import { sha256 } from './sha256'

const TASK = /^###\s+(.+?)\s*#*\s*$/
const PROJECT = /^##\s+(.+?)\s*#*\s*$/
const AUTO_START = /^<!--\s*auto\s+(.*?)\s*-->\s*$/

export type UndoKind = 'archive' | 'done'
export type UndoSpan = {
  kind: UndoKind; title: string; project: string; session: string | null; start: number; end: number
  archiveFile?: string; archiveEntries?: readonly string[]; journalFile?: string; journalLines?: ReadonlyArray<readonly [string, number]>
}
export type UndoRecord = {
  kind: UndoKind; title: string; project: string; session: string | null; before: string; afterHash: string
  blockLines: readonly string[]; afterBlockFp: string | null; occurrence: number; titleCount: number; afterTitleCount: number
  nextProject: string | null; nextItemAnchor: string | null; archiveFile?: string; archiveEntries: readonly string[]
  journalFile?: string; journalLines: ReadonlyArray<readonly [string, number]>
}
export type UndoOutcome = { ok: true; text: string } | { ok: false; reason: 'changed' | 'gone' }
export type ArchiveUndoOutcome = { ok: true; text: string } | { ok: false; reason: 'changed' }
type TaskSlot = { start: number; end: number; heading: string }

const sectionBounds = (seen: readonly string[], project: string): { heading: number; end: number } | null => {
  if (project !== '') return sectionOfProject(seen, project)
  const next = seen.findIndex(line => PROJECT.test(line))
  return { heading: -1, end: next < 0 ? seen.length : next }
}

const manualTaskRanges = (lines: readonly string[], seen: readonly string[], project: string): TaskSlot[] => {
  const section = sectionBounds(seen, project)
  if (section === null) return []
  const spans = scanBlocks(lines), slots: TaskSlot[] = []
  for (let index = section.heading + 1; index < section.end;) {
    const owned = spans.find(span => index >= span.start && index <= span.end)
    if (owned !== undefined) { index = owned.end + 1; continue }
    const heading = TASK.exec(seen[index] ?? '')?.[1]
    if (heading === undefined) { index += 1; continue }
    const last = Math.min(manualTaskLast(lines, seen, index), section.end - 1)
    slots.push({ start: index, end: last, heading })
    index = last + 1
  }
  return slots
}

const blockFp = (project: string, lines: readonly string[]): string => sha256(JSON.stringify([project, lines]))

const siblingAfter = (seen: readonly string[], project: string, end: number): string | null => {
  const section = sectionBounds(seen, project)
  if (section === null) return null
  for (let i = end + 1; i < section.end; i += 1) if (AUTO_START.test(seen[i] ?? '') || TASK.test(seen[i] ?? '')) return seen[i]!
  return null
}

const projectAfter = (seen: readonly string[], project: string): string | null => {
  const section = sectionBounds(seen, project)
  if (section === null) return null
  for (let i = section.end; i < seen.length; i += 1) if (PROJECT.test(seen[i] ?? '')) return seen[i]!
  return null
}

// Captures the minimum baseline needed to restore one Archive or Confirm done action
// safely, refusing if that task, its sibling count, or its archive entry changed after.
export const recordUndo = (before: string, after: string, span: UndoSpan): UndoRecord => {
  const beforeLines = linesOf(before), beforeSeen = seenOf(beforeLines)
  const afterLines = linesOf(after), afterSeen = seenOf(afterLines)
  const blockLines = beforeLines.slice(span.start, span.end + 1)
  let afterBlockFp: string | null = null
  let occurrence = 1, titleCount = 1, afterTitleCount = 0

  if (span.kind === 'done') {
    if (span.session !== null) {
      const found = scanBlocks(afterLines).find(one => one.session === span.session && one.isClosed)
      afterBlockFp = found === undefined ? null : blockFp(found.project, afterLines.slice(found.start, found.end + 1))
    } else {
      const matching = manualTaskRanges(afterLines, afterSeen, span.project).filter(one => one.heading === span.title)
      titleCount = matching.length
      const idx = matching.findIndex(one => one.start === span.start)
      occurrence = idx >= 0 ? idx + 1 : 1
      const target = idx >= 0 ? matching[idx] : undefined
      afterBlockFp = target === undefined ? null : blockFp(span.project, afterLines.slice(target.start, target.end + 1))
    }
  } else if (span.session === null) {
    afterTitleCount = manualTaskRanges(afterLines, afterSeen, span.project).filter(one => one.heading === span.title).length
  }

  return {
    kind: span.kind, title: span.title, project: span.project, session: span.session, before, afterHash: sha256(after),
    blockLines, afterBlockFp, occurrence, titleCount, afterTitleCount,
    nextProject: span.kind === 'archive' ? projectAfter(beforeSeen, span.project) : null,
    nextItemAnchor: span.kind === 'archive' ? siblingAfter(beforeSeen, span.project, span.end) : null,
    ...(span.archiveFile === undefined ? {} : { archiveFile: span.archiveFile }),
    archiveEntries: span.archiveEntries ?? [],
    ...(span.journalFile === undefined ? {} : { journalFile: span.journalFile }),
    journalLines: span.journalLines ?? [],
  }
}

const spliceReplaced = (current: string, start: number, end: number, replacement: readonly string[]): string => {
  const eol = eolOf(current), lines = linesOf(current)
  lines.splice(start, end - start + 1, ...replacement)
  const trailing = lines.length > 0 && (current.endsWith('\n') || current === '') ? eol : ''
  return lines.join(eol) + trailing
}

const insertRestoredBlock = (current: string, record: UndoRecord): string => {
  const eol = eolOf(current), lines = linesOf(current), seen = seenOf(lines), block = [...record.blockLines]
  const section = sectionBounds(seen, record.project)
  if (section !== null) {
    let at = section.end
    while (at > section.heading + 1 && (lines[at - 1] ?? '').trim() === '') at -= 1
    if (record.nextItemAnchor !== null) {
      const anchorAt = seen.findIndex((line, i) => i > section.heading && i < section.end && line === record.nextItemAnchor)
      if (anchorAt >= 0) at = anchorAt
    }
    const insert: string[] = []
    if (at > section.heading + 1 && (lines[at - 1] ?? '').trim() !== '') insert.push('')
    insert.push(...block)
    if (at < lines.length && (lines[at] ?? '').trim() !== '') insert.push('')
    lines.splice(at, 0, ...insert)
    return lines.join(eol) + eol
  }
  const heading = `## ${record.project}`
  if (record.nextProject !== null) {
    const nextAt = seen.findIndex(line => line === record.nextProject)
    if (nextAt >= 0) {
      lines.splice(nextAt, 0, ...(nextAt > 0 && (lines[nextAt - 1] ?? '').trim() !== '' ? [''] : []), heading, ...block, '')
      return lines.join(eol) + eol
    }
  }
  return (lines.length === 0 ? [heading, ...block] : [...lines, ...(lines.at(-1)?.trim() === '' ? [] : ['']), heading, ...block]).join(eol) + eol
}

// Reverts the recorded press onto `current` progress text, keeping unrelated edits
// added meanwhile and refusing if the target block moved, changed, or vanished.
export const applyUndo = (current: string, record: UndoRecord): UndoOutcome => {
  const lines = linesOf(current), seen = seenOf(lines)
  if (record.kind === 'done') {
    if (record.session !== null) {
      const matching = scanBlocks(lines).filter(one => one.session === record.session)
      if (matching.length === 0) return { ok: false, reason: 'gone' }
      const target = matching[0]!
      if (matching.length > 1 || !target.isClosed || record.afterBlockFp === null || blockFp(target.project, lines.slice(target.start, target.end + 1)) !== record.afterBlockFp) {
        return { ok: false, reason: 'changed' }
      }
      return { ok: true, text: sha256(current) === record.afterHash ? record.before : spliceReplaced(current, target.start, target.end, record.blockLines) }
    }
    const matching = manualTaskRanges(lines, seen, record.project).filter(one => one.heading === record.title)
    if (matching.length === 0) return { ok: false, reason: 'gone' }
    if (matching.length !== record.titleCount) return { ok: false, reason: 'changed' }
    const target = matching[record.occurrence - 1]
    if (target === undefined || record.afterBlockFp === null || blockFp(record.project, lines.slice(target.start, target.end + 1)) !== record.afterBlockFp) {
      return { ok: false, reason: 'changed' }
    }
    return { ok: true, text: sha256(current) === record.afterHash ? record.before : spliceReplaced(current, target.start, target.end, record.blockLines) }
  }
  if (record.session !== null && scanBlocks(lines).some(one => one.session === record.session)) return { ok: false, reason: 'changed' }
  if (record.session === null && manualTaskRanges(lines, seen, record.project).filter(one => one.heading === record.title).length !== record.afterTitleCount) {
    return { ok: false, reason: 'changed' }
  }
  return { ok: true, text: sha256(current) === record.afterHash ? record.before : insertRestoredBlock(current, record) }
}

// Removes the verbatim entries written to `progress-archive-*.md` by an Archive
// press, refusing if any entry was edited, extended, or removed since.
export const applyArchiveUndo = (currentArchive: string, record: UndoRecord, archiveTitle: string): ArchiveUndoOutcome => {
  if (record.archiveEntries.length === 0) return { ok: true, text: currentArchive }
  const eol = eolOf(currentArchive), lines = currentArchive.replace(/\r\n/g, '\n').split('\n')
  for (const raw of [...record.archiveEntries].reverse()) {
    const needle = raw.replace(/\r\n/g, '\n').replace(/\n+$/, '')
    if (needle === '') continue
    const starts = readable(lines).flatMap((line, index) => line !== null && /^##\s/.test(line) ? [index] : [])
    let found = -1
    for (let i = starts.length - 1; i >= 0; i -= 1) {
      if (lines.slice(starts[i]!, starts[i + 1] ?? lines.length).join('\n').replace(/\n+$/, '') === needle) { found = i; break }
    }
    if (found < 0) return { ok: false, reason: 'changed' }
    lines.splice(starts[found]!, (starts[found + 1] ?? lines.length) - starts[found]!)
  }
  const compact = lines.join('\n').trimEnd().replace(/\n{3,}/g, '\n\n')
  return { ok: true, text: compact.trim() === '' || compact.trim() === archiveTitle.trim() ? '' : `${compact}\n`.replace(/\n/g, eol) }
}
