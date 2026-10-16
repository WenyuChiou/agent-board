// One line typed into the pane (or after `/progress 加`) made into a hand-kept task:
//   求職：Google 暑期實習 截止 11-01；改履歷；投遞
// The part before the colon is the project (else this session's), `截止 MM-DD` the due
// date, and each `；` starts a step.

import { ZH_TW } from './i18n'
import type { Strings } from './i18n'

export type QuickEntry = { project: string; title: string; due: string | null; steps: string[] }

const DUE = /\s*(?:截止|\bdue)[:：\s]*((?:\d{4}[-/])?\d{1,2}[-/]\d{1,2})\s*/i
// A colon right before `//` belongs to a URL, not to a project name.
const HEAD = /^([^：:]{1,24})[：:](?!\/\/)\s*(.+)$/
// A job-hunting task given no steps gets the usual ones (the strings' jobSteps).
const JOB = /求職|求职|實習|实习|intern|job|application/i

export const isQuickAdd = (input: string): boolean => /^\s*[+＋]/.test(input)

export const parseQuickAdd = (input: string, fallbackProject: string, s: Strings = ZH_TW): QuickEntry | null => {
  let text = input.trim().replace(/^[+＋]\s*/, '')
  let due: string | null = null
  const dated = DUE.exec(text)
  if (dated?.[1] !== undefined) {
    due = dated[1].replace(/\//g, '-')
    text = `${text.slice(0, dated.index)} ${text.slice(dated.index + dated[0].length)}`.trim()
  }
  const parts = text
    .split(/[；;]/)
    .map(part => part.replace(/\s+/g, ' ').trim())
    .filter(part => part !== '')
  const head = parts[0] ?? ''
  const named = HEAD.exec(head)
  const project = named?.[1]?.trim() || fallbackProject
  const title = (named?.[2] ?? head).trim()
  if (title === '') return null
  const given = parts.slice(1)
  const steps = given.length > 0 ? given : JOB.test(project) ? [...s.jobSteps] : [title]

  return { project, title, due, steps }
}

export const quickAddWords = (entry: QuickEntry, s: Strings = ZH_TW): string =>
  s.quickAdded(entry.project, entry.title, entry.steps.length, entry.due)
