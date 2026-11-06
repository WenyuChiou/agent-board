import { localDay } from './journal'

// The archive and the journal each start a file a month beside progress.md. The last three months
// stay where they are; older ones move to an `archives/` folder, and are never deleted (#922).
export const KEPT_MONTHS = 3
export const OLD_MONTHS_FOLDER = 'archives'

const monthIndex = (year: number, month: number): number => year * 12 + month - 1

// `<stem>-archive-2026-07.md`, and its later parts `<stem>-archive-2026-07-2.md`; the same for the journal.
const monthFile = (stem: string): RegExp =>
  new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(?:archive|journal)-(\\d{4})-(\\d{2})(?:-\\d+)?\\.md$`, 'i')

// Which of the files beside progress.md move: those of a month before the last three, whose name is
// not already taken in the archives folder. A taken name stays where it is and the next pass tries again.
export const oldMonthFiles = (stem: string, names: readonly string[], taken: readonly string[], now: number): string[] => {
  const [year, month] = localDay(now).split('-').map(Number)
  const oldest = monthIndex(year ?? 0, month ?? 1) - (KEPT_MONTHS - 1)
  const isTaken = new Set(taken.map(name => name.toLowerCase()))
  const pattern = monthFile(stem)

  return names.filter(name => {
    const found = pattern.exec(name)
    if (found === null) return false

    return monthIndex(Number(found[1]), Number(found[2])) < oldest && !isTaken.has(name.toLowerCase())
  })
}
