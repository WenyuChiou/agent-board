import { eolOf, linesOf, manualTaskLast, scanBlocks, seenOf } from './blocks'
import { readable } from './parse'
import { sha256 } from './sha256'

const TASK = /^###\s+(.+?)\s*#*\s*$/, PROJECT = /^##\s+(.+?)\s*#*\s*$/
export type UndoKind = 'archive' | 'done'
export type UndoSpan = {
  kind: UndoKind; title: string; project: string; session: string | null; start: number; end: number
  archiveFile?: string; archiveAfter?: string; archiveEntries?: readonly string[]; journalFile?: string; journalLines?: ReadonlyArray<readonly [string, number]>
}
export type UndoRecord = {
  kind: UndoKind; title: string; project: string; session: string | null; before: string; afterHash: string
  blockLines: readonly string[]; sectionIdx: number; beforeSections: number; afterSections: number
  afterSessionFps: readonly string[]; afterBlockFp: string | null; occurrence: number; titleCount: number; afterTitleCount: number
  nextProject: string | null; nextProjectIdx: number; nextItemAnchor: string | null; anchorIdx: number; anchorTotal: number
  archiveFile?: string; archiveEntries: readonly string[]; archiveTargets: ReadonlyArray<readonly [number, string]>
  journalFile?: string; journalLines: ReadonlyArray<readonly [string, number]>
}
export type UndoOutcome = { ok: true; text: string } | { ok: false; reason: 'changed' | 'gone' }
export type ArchiveUndoOutcome = { ok: true; text: string } | { ok: false; reason: 'changed' }
type Sec = { heading: number; end: number }

const normProj = (p: string): string => p.replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
const sectionsOf = (seen: readonly string[], project: string): Sec[] => {
  const heads = seen.flatMap((line, i) => PROJECT.test(line) ? [i] : [])
  if (project === '') return [{ heading: -1, end: heads[0] ?? seen.length }]
  const want = normProj(project)
  return heads.flatMap((h, idx) => normProj(PROJECT.exec(seen[h]!)?.[1] ?? '') === want ? [{ heading: h, end: heads[idx + 1] ?? seen.length }] : [])
}
const sectionItemStarts = (lines: readonly string[], seen: readonly string[], sec: Sec): number[] => {
  const spans = scanBlocks(lines), out: number[] = []
  for (let i = sec.heading + 1; i < sec.end;) {
    const owned = spans.find(s => i >= s.start && i <= s.end)
    if (owned !== undefined) { out.push(owned.start); i = owned.end + 1; continue }
    if (TASK.test(seen[i] ?? '')) out.push(i)
    i += 1
  }
  return out
}
const manualRangesIn = (lines: readonly string[], seen: readonly string[], sec: Sec | undefined) => {
  if (sec === undefined) return []
  const spans = scanBlocks(lines), slots: Array<{ start: number; end: number; heading: string }> = []
  for (let i = sec.heading + 1; i < sec.end;) {
    const owned = spans.find(s => i >= s.start && i <= s.end)
    if (owned !== undefined) { i = owned.end + 1; continue }
    const heading = TASK.exec(seen[i] ?? '')?.[1]
    if (heading === undefined) { i += 1; continue }
    const last = Math.min(manualTaskLast(lines, seen, i), sec.end - 1)
    slots.push({ start: i, end: last, heading }); i = last + 1
  }
  return slots
}
const blockFp = (project: string, lines: readonly string[]): string => sha256(JSON.stringify([project, lines]))
const sessionFps = (lines: readonly string[], session: string): string[] =>
  scanBlocks(lines).filter(b => b.session === session).map(b => `${b.project}\0${b.isClosed ? 1 : 0}\0${blockFp(b.project, lines.slice(b.start, b.end + 1))}`)
const archiveStarts = (lines: readonly string[]): number[] => readable(lines).flatMap((l, i) => l !== null && /^##\s/.test(l) ? [i] : [])
const archiveTargetsOf = (archiveAfter: string | undefined, entries: readonly string[]): ReadonlyArray<readonly [number, string]> => {
  if (archiveAfter === undefined || entries.length === 0) return []
  const lines = archiveAfter.replace(/\r\n/g, '\n').split('\n'), starts = archiveStarts(lines), targets: Array<readonly [number, string]> = []
  let ceiling = starts.length - 1
  for (const raw of [...entries].reverse()) {
    const needle = raw.replace(/\r\n/g, '\n').replace(/\n+$/, '')
    if (needle === '') continue
    let found = -1
    for (let i = ceiling; i >= 0; i -= 1) if (lines.slice(starts[i]!, starts[i + 1] ?? lines.length).join('\n').replace(/\n+$/, '') === needle) { found = i; break }
    if (found < 0) return []
    targets.push([found, needle]); ceiling = found - 1
  }
  return targets.sort((a, b) => b[0] - a[0])
}

// Captures the minimum baseline needed to restore one Archive or Confirm done action
// safely, refusing if that task, its sibling/section placement, or archive entry changed after.
export const recordUndo = (before: string, after: string, span: UndoSpan): UndoRecord => {
  const beforeLines = linesOf(before), beforeSeen = seenOf(beforeLines), afterLines = linesOf(after), afterSeen = seenOf(afterLines)
  const beforeSecs = sectionsOf(beforeSeen, span.project), afterSecs = sectionsOf(afterSeen, span.project)
  const sectionIdx = Math.max(0, beforeSecs.findIndex(s => span.start > s.heading && span.start < s.end))
  const beforeSec = beforeSecs[sectionIdx], afterSec = afterSecs[sectionIdx]
  const afterSessionFps = span.session === null ? [] : sessionFps(afterLines, span.session)
  let afterBlockFp: string | null = null, occurrence = 1, titleCount = 1, afterTitleCount = 0
  let nextProject: string | null = null, nextProjectIdx = 0, nextItemAnchor: string | null = null, anchorIdx = 0, anchorTotal = 0
  if (span.kind === 'done') {
    if (span.session !== null) {
      const blocks = scanBlocks(afterLines).filter(one => one.session === span.session)
      const idx = blocks.findIndex(one => one.start === span.start && one.isClosed)
      occurrence = idx >= 0 ? idx + 1 : 1
      afterBlockFp = idx >= 0 ? blockFp(blocks[idx]!.project, afterLines.slice(blocks[idx]!.start, blocks[idx]!.end + 1)) : null
    } else {
      const matching = manualRangesIn(afterLines, afterSeen, afterSec).filter(one => one.heading === span.title)
      titleCount = matching.length
      const idx = matching.findIndex(one => one.start === span.start)
      occurrence = idx >= 0 ? idx + 1 : 1
      afterBlockFp = idx >= 0 ? blockFp(span.project, afterLines.slice(matching[idx]!.start, matching[idx]!.end + 1)) : null
    }
  } else {
    if (span.session === null && afterSecs.length === beforeSecs.length) afterTitleCount = manualRangesIn(afterLines, afterSeen, afterSec).filter(one => one.heading === span.title).length
    if (beforeSec !== undefined && afterSecs.length < beforeSecs.length && beforeSec.end < beforeSeen.length) {
      nextProject = beforeSeen[beforeSec.end]!
      nextProjectIdx = beforeSeen.slice(0, beforeSec.heading).filter(l => l === nextProject).length
    } else if (beforeSec !== undefined && afterSec !== undefined && afterSecs.length === beforeSecs.length) {
      const afterItems = sectionItemStarts(afterLines, afterSeen, afterSec), beforeItems = sectionItemStarts(beforeLines, beforeSeen, beforeSec)
      const next = beforeItems.find(i => i > span.end)
      if (next !== undefined) {
        nextItemAnchor = beforeLines[next]!
        anchorIdx = beforeItems.filter(k => k < span.start && beforeLines[k] === nextItemAnchor).length
        anchorTotal = afterItems.filter(k => afterLines[k] === nextItemAnchor).length
      }
    }
  }
  return {
    kind: span.kind, title: span.title, project: span.project, session: span.session, before, afterHash: sha256(after),
    blockLines: beforeLines.slice(span.start, span.end + 1), sectionIdx, beforeSections: beforeSecs.length, afterSections: afterSecs.length,
    afterSessionFps, afterBlockFp, occurrence, titleCount, afterTitleCount, nextProject, nextProjectIdx, nextItemAnchor, anchorIdx, anchorTotal,
    ...(span.archiveFile === undefined ? {} : { archiveFile: span.archiveFile }),
    archiveEntries: span.archiveEntries ?? [], archiveTargets: archiveTargetsOf(span.archiveAfter, span.archiveEntries ?? []),
    ...(span.journalFile === undefined ? {} : { journalFile: span.journalFile }), journalLines: span.journalLines ?? [],
  }
}

const spliceReplaced = (current: string, start: number, end: number, replacement: readonly string[]): string => {
  const eol = eolOf(current), lines = linesOf(current)
  lines.splice(start, end - start + 1, ...replacement)
  return lines.join(eol) + (lines.length > 0 && (current.endsWith('\n') || current === '') ? eol : '')
}

const insertRestoredBlock = (current: string, record: UndoRecord): string | null => {
  const eol = eolOf(current), lines = linesOf(current), seen = seenOf(lines), block = [...record.blockLines], secs = sectionsOf(seen, record.project)
  if (record.afterSections === record.beforeSections) {
    const sec = secs[record.sectionIdx]
    if (sec === undefined) return null
    let at = sec.end
    while (at > sec.heading + 1 && (lines[at - 1] ?? '').trim() === '') at -= 1
    if (record.nextItemAnchor !== null) {
      const matches = sectionItemStarts(lines, seen, sec).filter(k => lines[k] === record.nextItemAnchor)
      if (matches.length !== record.anchorTotal || matches[record.anchorIdx] === undefined) return null
      at = matches[record.anchorIdx]!
    }
    const insert = [...(at > sec.heading + 1 && (lines[at - 1] ?? '').trim() !== '' ? [''] : []), ...block, ...(at < lines.length && (lines[at] ?? '').trim() !== '' ? [''] : [])]
    lines.splice(at, 0, ...insert)
    return lines.join(eol) + eol
  }
  const heading = `## ${record.project}`
  if (record.nextProject !== null) {
    const matches = seen.flatMap((line, i) => line === record.nextProject ? [i] : [])
    if (record.nextProjectIdx >= matches.length) return null
    const nextAt = matches[record.nextProjectIdx]!
    lines.splice(nextAt, 0, ...(nextAt > 0 && (lines[nextAt - 1] ?? '').trim() !== '' ? [''] : []), heading, ...block, '')
    return lines.join(eol) + eol
  }
  return (lines.length === 0 ? [heading, ...block] : [...lines, ...(lines.at(-1)?.trim() === '' ? [] : ['']), heading, ...block]).join(eol) + eol
}

// Reverts the recorded press onto `current` progress text, keeping unrelated edits
// added meanwhile and refusing if the target block moved, changed, or vanished.
export const applyUndo = (current: string, record: UndoRecord): UndoOutcome => {
  const lines = linesOf(current), seen = seenOf(lines), secs = sectionsOf(seen, record.project)
  if (record.kind === 'done') {
    if (record.session !== null) {
      const matching = scanBlocks(lines).filter(one => one.session === record.session)
      if (matching.length === 0) return { ok: false, reason: 'gone' }
      const target = matching[record.occurrence - 1]
      if (secs.length !== record.afterSections || target === undefined || !target.isClosed || record.afterBlockFp === null || JSON.stringify(sessionFps(lines, record.session)) !== JSON.stringify(record.afterSessionFps)) return { ok: false, reason: 'changed' }
      return { ok: true, text: sha256(current) === record.afterHash ? record.before : spliceReplaced(current, target.start, target.end, record.blockLines) }
    }
    const matching = manualRangesIn(lines, seen, secs[record.sectionIdx]).filter(one => one.heading === record.title)
    if (matching.length === 0) return { ok: false, reason: 'gone' }
    const target = matching[record.occurrence - 1]
    if (secs.length !== record.afterSections || matching.length !== record.titleCount || target === undefined || record.afterBlockFp === null || blockFp(record.project, lines.slice(target.start, target.end + 1)) !== record.afterBlockFp) return { ok: false, reason: 'changed' }
    return { ok: true, text: sha256(current) === record.afterHash ? record.before : spliceReplaced(current, target.start, target.end, record.blockLines) }
  }
  if (secs.length !== record.afterSections) return { ok: false, reason: 'changed' }
  if (record.session !== null && JSON.stringify(sessionFps(lines, record.session)) !== JSON.stringify(record.afterSessionFps)) return { ok: false, reason: 'changed' }
  if (record.session === null && record.afterSections === record.beforeSections && manualRangesIn(lines, seen, secs[record.sectionIdx]).filter(one => one.heading === record.title).length !== record.afterTitleCount) return { ok: false, reason: 'changed' }
  if (sha256(current) === record.afterHash) return { ok: true, text: record.before }
  const restored = insertRestoredBlock(current, record)
  return restored === null ? { ok: false, reason: 'changed' } : { ok: true, text: restored }
}

// Removes the exact entries written to `progress-archive-*.md` by an Archive
// press, refusing if any recorded entry (including duplicates) was edited or removed since.
export const applyArchiveUndo = (currentArchive: string, record: UndoRecord, archiveTitle: string): ArchiveUndoOutcome => {
  if (record.archiveEntries.length === 0) return { ok: true, text: currentArchive }
  const eol = eolOf(currentArchive), lines = currentArchive.replace(/\r\n/g, '\n').split('\n'), starts = archiveStarts(lines)
  if (record.archiveTargets.length > 0) {
    for (const [idx, needle] of record.archiveTargets) {
      if (idx < 0 || idx >= starts.length || lines.slice(starts[idx]!, starts[idx + 1] ?? lines.length).join('\n').replace(/\n+$/, '') !== needle) return { ok: false, reason: 'changed' }
      lines.splice(starts[idx]!, (starts[idx + 1] ?? lines.length) - starts[idx]!)
    }
  } else {
    for (const raw of [...record.archiveEntries].reverse()) {
      const needle = raw.replace(/\r\n/g, '\n').replace(/\n+$/, '')
      if (needle === '') continue
      const sNow = archiveStarts(lines), found = (() => { for (let i = sNow.length - 1; i >= 0; i -= 1) if (lines.slice(sNow[i]!, sNow[i + 1] ?? lines.length).join('\n').replace(/\n+$/, '') === needle) return i; return -1 })()
      if (found < 0) return { ok: false, reason: 'changed' }
      lines.splice(sNow[found]!, (sNow[found + 1] ?? lines.length) - sNow[found]!)
    }
  }
  const compact = lines.join('\n').trimEnd().replace(/\n{3,}/g, '\n\n')
  return { ok: true, text: compact.trim() === '' || compact.trim() === archiveTitle.trim() ? '' : `${compact}\n`.replace(/\n/g, eol) }
}
