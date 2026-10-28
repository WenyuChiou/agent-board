import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  InputProps,
  LinkProps,
  RenderElement,
  RenderSurface,
  TextProps,
} from 'claude-code'

import type { PressOutcome, ProgressAnswer, ProgressPressResult, ProgressStepStatus, ResolveResult } from '../types'
import type { Strings } from './i18n'
import { ZH_TW } from './i18n'
import { agentLabel } from './strings'
import { askColor, stepColor, toneColor } from './palette'
import type { Palette } from './palette'
import { OLDER_SHOWN, progressBar, replyHint } from './view'
import type { Focus, PrView, StepRef, TaskRow, Tone, View, ViewStep, WaitingItem } from './view'

// The pane's drawing, from the view and a set of actions; it never touches the engine,
// so every press goes through an action register.tsx wires up.
//
// It answers the person's questions in the order they ask them, and shows more only when
// asked (progressive disclosure):
//   1. Does anything need me?   the counts, then the one most pressing thing, with the
//                               buttons its kind calls for (ask.ts)
//   2. Where is this session?   a short card: title, background, bar, the step now and
//                               the next; every step behind 全部 N 步
//   3. Everything else          what waits, what is due, other work and what got done,
//                               each folded to one line until opened
// Secondary text takes the palette's `muted`, never the terminal's dim, so it stays
// readable on a light background.

export type PaneUi = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Input: ElementConstructor<InputProps> | null
  Link: ElementConstructor<LinkProps> | null
}

export type PaneActions = {
  press: (key: string, run: () => PressOutcome | Promise<PressOutcome>) => void
  forget: (key: string) => void | Promise<unknown>
  toggle: (key: string) => PressOutcome | Promise<PressOutcome>
  // Opens or folds a section: waiting, due, others, recent, steps, hidden, idle.
  toggleSection: (id: string) => PressOutcome | Promise<PressOutcome>
  continueHere: () => PressOutcome | Promise<PressOutcome>
  archive: () => PressOutcome | Promise<PressOutcome>
  // Clean up: the scheduled sweep (the hourly one, `--tidy`), not the archive of every finished task (#464).
  cleanUp: () => PressOutcome | Promise<PressOutcome>
  takeOver: (row: TaskRow) => PressOutcome | Promise<PressOutcome>
  handOver: (row: TaskRow) => PressOutcome | Promise<PressOutcome>
  tick: (ref: StepRef) => PressOutcome | Promise<PressOutcome>
  // An answer to one of this session's own questions, sent to Claude.
  answer: (item: WaitingItem, text: string) => PressOutcome | Promise<PressOutcome>
  copyCommand: (item: WaitingItem, surface: RenderSurface) => PressOutcome | Promise<PressOutcome>
  copyAskedResume: (item: WaitingItem, surface: RenderSurface) => PressOutcome | Promise<PressOutcome>
  // Hides a question answered in its own session, on this machine only; sends nothing.
  hide: (item: WaitingItem) => PressOutcome | Promise<PressOutcome>
  resolve: (item: WaitingItem) => void
  unhide: (item: WaitingItem) => PressOutcome | Promise<PressOutcome>
  // Opens the reply box under a review, for what should change; sends nothing.
  revise: (item: WaitingItem) => PressOutcome | Promise<PressOutcome>
  // A question for the side model, or a line starting with + to add a task.
  ask: (question: string) => PressOutcome | Promise<PressOutcome>
  clearAnswer: () => PressOutcome | Promise<PressOutcome>
  copyResume: (row: TaskRow, surface: RenderSurface) => PressOutcome | Promise<PressOutcome>
  // Moves one task to the archive file now: an ended session's block or a hand-kept task.
  archiveRow: (row: TaskRow) => PressOutcome | Promise<PressOutcome>
  confirmRow: (row: TaskRow) => PressOutcome | Promise<PressOutcome>
  report: (surface: RenderSurface) => PressOutcome | Promise<PressOutcome>
  toggleNotify: () => PressOutcome | Promise<PressOutcome>
  toggleLegend: () => PressOutcome | Promise<PressOutcome>
}

export type PaneModel = {
  results?: Record<string, PressResult>
  view: View
  expanded: string
  // The review whose reply box is open, by item key.
  revising: string
  opened: readonly string[]
  answer: ProgressAnswer | null
  resolveResult?: ResolveResult | null
  path: string
  width: number
  hasTaskTools: boolean
  isNotifyOn: boolean
  isLegendOpen: boolean
  hasQuestionsProblem?: boolean
  hasPendingQuestionsProblem?: boolean
  palette: Palette
  s: Strings
}

export type PressResult = ProgressPressResult

// Action keys use `${card.key}::verb`, so results follow a card through redraws.
export const pressTarget = (view: View, button: string, s: Strings = ZH_TW): { key: string; revision: string; label: string } => {
  if (button === 'section::hidden') return { key: button, revision: '', label: s.hiddenCount(view.hidden.length) }
  if (button === 'section::idle') return { key: button, revision: '', label: s.idleCount(view.idle.length) }
  if (button === 'section::stopped') return { key: button, revision: '', label: s.stoppedCount(view.stopped.length) }
  if (button === 'section::steps') return { key: button, revision: '', label: view.current?.title ?? '' }
  if (button === 'section::waiting') return { key: button, revision: '', label: s.sectionWaiting }
  if (button === 'section::due') return { key: button, revision: '', label: s.sectionDue }
  if (button === 'section::recent') return { key: button, revision: '', label: s.sectionRecent }
  if (button === 'section::health') return { key: button, revision: '', label: s.sectionHealth }
  if (button === 'section::reminder') return { key: button, revision: '', label: s.sectionQuestionReminders }
  if (button === 'section::older') return { key: button, revision: '', label: s.sectionOlderQuestions }
  if (button === 'section::stoppedAsking') return { key: button, revision: '', label: s.stoppedAsking(view.stoppedAsking ?? 0) }
  if (button === 'section::olderAll') return { key: button, revision: '', label: s.showAllQuestions(view.older?.length ?? 0) }
  if (button === 'section::others') return { key: button, revision: '', label: view.current === null ? s.sectionActive : s.sectionOther }
  if (button === 'focus::more') return { key: button, revision: '', label: s.moreWaiting(view.waiting.length - (view.focus?.type === 'ask' ? 1 : 0)) }
  if (button === 'continue' && view.current !== null) return { key: button, revision: JSON.stringify([view.current.title, view.current.steps]), label: view.current.title }
  if (button === 'clean') return { key: button, revision: '', label: s.cleanUp }
  if (button === 'archive') return { key: button, revision: '', label: view.recent.map(item => item.title).join(', ') }
  const asks = [...view.waiting, ...view.hidden, ...(view.reminder ?? []), ...(view.older ?? [])]
  const ask = asks.sort((a, b) => b.key.length - a.key.length).find(item => button === `ask::${item.key}` || button.startsWith(`${item.key}::`))
  if (ask !== undefined) return { key: ask.key, revision: JSON.stringify([ask.questionId, ask.text, ask.note]), label: ask.task }
  const rows = [...view.due, ...view.active, ...view.idle, ...view.stopped, ...view.groups.flatMap(group => group.rows)]
  const row = rows.find(item => button === item.key)
    ?? rows.sort((a, b) => b.key.length - a.key.length).find(item => button.startsWith(`${item.key}::`))
  if (row !== undefined) return { key: row.key, revision: JSON.stringify([row.title, row.steps]), label: row.title }
  return { key: button, revision: '', label: '' }
}

export const GLYPH: Record<ProgressStepStatus, string> = {
  done: '✓',
  doing: '▸',
  todo: '○',
  waiting: '●',
  running: '◐',
  blocked: '!',
  cancelled: '–',
}

// The review whose reply box Needs changes opened: by its words too, so the same task asking
// something new starts with the box closed.
export const reviseKey = (item: WaitingItem): string => `${item.key} ${item.text} — ${item.note}`

// In the order of the strings' legendWords.
const LEGEND: readonly ProgressStepStatus[] = ['done', 'doing', 'todo', 'waiting', 'running', 'blocked', 'cancelled']

export const drawPane = (ui: PaneUi, model: PaneModel, actions: PaneActions): RenderElement => {
  const { Box, Text, Button, Input, Link } = ui
  const { view, palette, s } = model
  const shown = new Set<string>()
  const resultLine = (key: string, result: PressResult) => (
    <Box flexDirection="column">
      <Text key={`${key}::result`} wrap="wrap" color={result.tone === 'alert' ? palette.alert : palette.accent}>{result.text}</Text>
      {result.copyText !== undefined && (Input === null
        ? <Text wrap="wrap">{result.copyText}</Text>
        : <Input
            key={`${key}::copy-text`}
            value={result.copyText}
            autoFocus
            onSubmit={() => actions.press(key === 'report' ? key : `${key}::copy-text`, () => ({ text: result.text, tone: result.tone, copyText: result.copyText }))}
          />)}
    </Box>
  )
  const buttonPress = (
    key: string,
    run: (event: Parameters<NonNullable<ButtonProps['onPress']>>[0]) => PressOutcome | Promise<PressOutcome>,
    isDisplay = false,
  ): NonNullable<ButtonProps['onPress']> => event => {
    if (isDisplay) return Promise.resolve().then(() => run(event)).then(() => actions.forget(key), () => actions.press(key, () => ({ text: s.settingSaveFailed, tone: 'alert' })))
    return actions.press(key, () => run(event))
  }
  const cardResult = (key: string) => {
    const result = model.results?.[key]
    const current = result === undefined ? undefined : pressTarget(view, result.button, s)
    if (result === undefined || shown.has(key) || result.tone !== 'alert' && current?.revision !== result.revision) return null
    shown.add(key)
    return resultLine(key, result)
  }
  const color = (tone: Tone): string => toneColor(palette, tone)
  const isOpen = (id: string): boolean => model.opened.includes(id)
  const resultTask = model.resolveResult?.key.replace(/::[^:]*$/, '') ?? ''
  const hasDetachedResult = resultTask !== '' && !view.stopped.some(row => row.key === resultTask) && !view.recent.some(item => item.key === resultTask)
  const hasResult = (item: WaitingItem): boolean => {
    const result = model.resolveResult
    return result !== null && result !== undefined && (result.kind === 'changed' ? item.key === result.key : item.questionId !== undefined && result.questionId === item.questionId)
  }

  const shelfQuestions = (items: readonly WaitingItem[], key: string) => (
    <Box flexDirection="column">
      {items.map(item => (
        <Box key={`${item.key}::question`} flexDirection="column">
          <Text color={palette.muted}>{[item.text, item.note].filter(Boolean).join(' — ')}</Text>
          {item.questionId !== undefined && <Button key={`${item.key}::resolve`} plain onPress={() => actions.resolve(item)}>{s.resolveQuestion}</Button>}
          {hasResult(item) && <Text color={palette.muted}>{model.resolveResult?.text}</Text>}
        </Box>
      ))}
      {model.resolveResult?.key.startsWith(`${key}::`) && !items.some(item => item.key === model.resolveResult?.key || item.questionId === model.resolveResult?.questionId) && (
        <Box key={`${model.resolveResult.key}::question`} flexDirection="column">
          <Text color={palette.muted}>{model.resolveResult.text}</Text>
        </Box>
      )}
    </Box>
  )

  const spacer = () => <Box flexGrow={1} />
  const muted = (text: string, wrap: 'wrap' | 'truncate-end' = 'wrap') => (
    <Text color={palette.muted} wrap={wrap}>
      {text}
    </Text>
  )

  // A section folded to one line: its name, its count, a word on what is inside, and ▸ / ▾.
  const fold = (id: string, title: string, count: number, tone: Tone, hint: string) => (
    <Box flexDirection="column">
      <Box flexDirection="row" marginTop={1}>
        <Button key={`section::${id}`} plain onPress={buttonPress(`section::${id}`, () => actions.toggleSection(id), true)}>
          {`${isOpen(id) ? '▾' : '▸'} ${title}`}
        </Button>
        <Text color={color(tone)}>{` ${count}`}</Text>
        {hint !== '' && <Text color={palette.muted} wrap="truncate-end">{`  ${hint}`}</Text>}
      </Box>
      {cardResult(`section::${id}`)}
    </Box>
  )

  // `━━━━───` in the accent, or in 若竹 once it is full.
  const bar = (done: number, total: number, width: number, showPercent: boolean) => {
    const { filled, rest } = progressBar(done, total, width)
    const percent = total === 0 ? 0 : Math.round((done / total) * 100)

    return (
      <Box flexDirection="row">
        <Text color={done === total && total > 0 ? palette.done : palette.accent}>{filled}</Text>
        <Text color={palette.frame}>{rest}</Text>
        {showPercent && <Text color={palette.muted}>{` ${percent}%`}</Text>}
      </Box>
    )
  }

  const stepRow = (step: ViewStep, room: number) => (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={palette.muted}>{step.number === null ? ' '.repeat(room + 1) : `${String(step.number).padStart(room)} `}</Text>
        <Text color={stepColor(palette, step.status)}>{`${GLYPH[step.status]} `}</Text>
        <Text
          bold={step.isCurrent}
          color={step.status === 'done' || step.status === 'cancelled' ? palette.muted : undefined}
          wrap="wrap"
        >
          {step.text}
        </Text>
        {step.isCurrent && <Text color={palette.accent}>{s.now}</Text>}
      </Box>
      {step.note !== '' && (
        <Box paddingLeft={room + 3}>
          <Text color={stepColor(palette, step.status)} wrap="wrap">
            {step.note}
          </Text>
        </Box>
      )}
    </Box>
  )

  const steps = (list: readonly ViewStep[]) => {
    const room = String(Math.max(0, ...list.map(step => step.number ?? 0))).length

    return list.map(step => stepRow(step, room))
  }

  const prLine = (pr: PrView) => (
    <Box flexDirection="row">
      {Link !== null ? (
        <Link href={pr.url} label={pr.text} />
      ) : (
        <Text color={color(pr.tone)} wrap="truncate-end">
          {pr.text}
        </Text>
      )}
      {Link !== null && pr.tone !== 'quiet' && <Text color={color(pr.tone)}> ●</Text>}
    </Box>
  )

  // What the person can do about one waiting step, by what it asks and whose it is.
  const askActions = (item: WaitingItem) => {
    // Another session's (or agent's) question is answered there, but a command to run or a
    // link to open is the person's to use from here, whoever asked.
    if (item.where === 'other') {
      const run = item.kind === 'do' ? item.command : null
      const open = item.kind === 'review' ? item.link : null
      const hint = replyHint(item, s, true, true)
      return (
        <Box flexDirection="column">
          {run !== null && <Text color={palette.accent} wrap="wrap">{`$ ${run}`}</Text>}
          {run !== null && (
            <Box marginTop={1}>
              <Button key={`${item.key}::copy`} onPress={buttonPress(`${item.key}::copy`, press => actions.copyCommand(item, press.surface))}>
                {s.copyCommand}
              </Button>
            </Box>
          )}
          {open !== null && Link !== null && <Link href={open} label={s.openLink} />}
          {muted(hint.where)}
          {hint.reopen !== null && (
            <Box marginTop={1}>
              <Button key={`${item.key}::resume`} onPress={buttonPress(`${item.key}::resume`, press => actions.copyAskedResume(item, press.surface))}>
                {s.copyResume}
              </Button>
            </Box>
          )}
        </Box>
      )
    }
    const step = item.step
    if (item.where === 'manual') {
      return step === null ? null : (
        <Box flexDirection="row" marginTop={1}>
          <Button key={`${item.key}::done`} variant="primary" onPress={buttonPress(`${item.key}::done`, () => actions.tick(step))}>
            {item.kind === 'wait' ? s.arrivedDone : s.done}
          </Button>
        </Box>
      )
    }
    const reply = (placeholder: string) =>
      Input === null ? null : (
        <Box marginTop={1}>
          <Input
            key={`${item.key}::reply`}
            placeholder={placeholder}
            submitLabel={s.reply}
            onSubmit={text => {
              actions.press(`${item.key}::reply`, () => text.trim() === '' ? { text: s.pressEmpty, tone: 'alert' } : actions.answer(item, text.trim()))
            }}
          />
        </Box>
      )
    const buttons = (pairs: ReadonlyArray<[string, string, boolean]>) => (
      <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
        {pairs.map(([label, answer, isPrimary]) =>
          isPrimary ? (
            <Button key={`${item.key}::${label}`} variant="primary" onPress={buttonPress(`${item.key}::${label}`, () => actions.answer(item, answer))}>
              {label}
            </Button>
          ) : (
            <Button key={`${item.key}::${label}`} onPress={buttonPress(`${item.key}::${label}`, () => actions.answer(item, answer))}>
              {label}
            </Button>
          ),
        )}
      </Box>
    )
    const command = item.command

    if (item.kind === 'confirm') {
      return buttons([
        [s.yes, s.yesAnswer, true],
        [s.no, s.noAnswer, false],
      ])
    }
    if (item.kind === 'choose' && item.options.length > 0) {
      return (
        <Box flexDirection="column">
          {buttons(item.options.map((option, index) => [option, option, index === 0] as [string, string, boolean]))}
          {reply(s.noneOfThese)}
        </Box>
      )
    }
    if (item.kind === 'do') {
      return (
        <Box flexDirection="column">
          {command !== null && <Text color={palette.accent} wrap="wrap">{`$ ${command}`}</Text>}
          <Box flexDirection="row" gap={1} marginTop={1}>
            {command !== null && (
              <Button key={`${item.key}::copy`} onPress={buttonPress(`${item.key}::copy`, press => actions.copyCommand(item, press.surface))}>
                {s.copyCommand}
              </Button>
            )}
            <Button key={`${item.key}::did`} variant="primary" onPress={buttonPress(`${item.key}::did`, () => actions.answer(item, s.didIt))}>
              {s.didIt}
            </Button>
          </Box>
        </Box>
      )
    }
    // Looks good and Needs changes side by side: with Looks good alone, a person who had already
    // asked for changes in the chat had only an approval to press.
    if (item.kind === 'review') {
      const link = item.link
      return (
        <Box flexDirection="column">
          {link !== null && Link !== null && <Link href={link} label={s.openLink} />}
          <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
            <Button key={`${item.key}::${s.looksGood}`} variant="primary" onPress={buttonPress(`${item.key}::${s.looksGood}`, () => actions.answer(item, s.looksGoodAnswer))}>
              {s.looksGood}
            </Button>
            <Button key={`${item.key}::revise`} onPress={buttonPress(`${item.key}::revise`, () => actions.revise(item), true)}>
              {s.needsChanges}
            </Button>
          </Box>
          {model.revising === reviseKey(item) && reply(s.whatToChange)}
        </Box>
      )
    }
    if (item.kind === 'wait') return buttons([[s.ready, s.readyAnswer, true]])

    return reply(s.replyPlaceholder)
  }

  const chip = (item: WaitingItem) => <Text color={askColor(palette, item.kind)}>{s.chip(s.ask[item.kind])}</Text>

  // A waiting step in full: the task it belongs to, why, and what can be done about it.
  const askDetail = (item: WaitingItem) => (
    <Box flexDirection="column">
      <Text color={palette.project} wrap="truncate-end">
        {`${item.project} › ${item.task}${item.where === 'manual' ? '' : ` · ${agentLabel(item.agent || 'claude', s)}`}`}
      </Text>
      {item.note !== '' && <Text wrap="wrap">{item.note}</Text>}
      {item.note === '' && item.context !== '' && muted(s.contextLine(item.context))}
      {item.when !== '' && muted(item.when)}
      {item.canHide === false ? muted(s.questionReviewOnly) : item.where !== 'manual' && muted(s.archiveLive)}
      {askActions(item)}
      {item.hideKey !== '' && item.canHide !== false && (
        <Box marginTop={1}>
          <Button key={`${item.key}::hide`} onPress={buttonPress(`${item.key}::hide`, () => actions.hide(item))}>
            {s.answeredHide}
          </Button>
        </Box>
      )}
      {cardResult(item.key)}
    </Box>
  )

  // What a row offers once opened: take it over here, reopen the session that left it, tick
  // its step, hand it to Claude, or put it in the archive now instead of waiting for cleanup.
  const rowActions = (row: TaskRow) => {
    const confirm = row.confirm == null ? null : <Button key={`${row.key}::done`} onPress={buttonPress(`${row.key}::done`, () => actions.confirmRow(row))}>{s.confirmDone}</Button>
    const archive = row.archive === null ? null : (
      <Button key={`${row.key}::archive`} onPress={buttonPress(`${row.key}::archive`, () => actions.archiveRow(row))}>
        {s.archiveThis}
      </Button>
    )
    if (row.auto === 'ended') {
      const resume = row.resume
      if (!row.isHere && resume === null) {
        return (
          <Box flexDirection="column">
            {muted(s.continueElsewhere(row.project))}
            {archive !== null && <Box marginTop={1}>{archive}</Box>}
            {confirm}
          </Box>
        )
      }

      return (
        <Box flexDirection="row" marginTop={1} gap={1}>
          {row.isHere && (
            <Button key={`${row.key}::take`} variant="primary" onPress={buttonPress(`${row.key}::take`, () => actions.takeOver(row))}>
              {s.takeOver}
            </Button>
          )}
          {resume !== null && (
            <Button key={`${row.key}::resume`} onPress={buttonPress(`${row.key}::resume`, press => actions.copyResume(row, press.surface))}>
              {s.copyResume}
            </Button>
          )}
          {archive}
          {confirm}
        </Box>
      )
    }
    if (row.auto !== null) {
      return <Box flexDirection="column">{muted(row.isHere ? s.heldElsewhere : s.continueElsewhere(row.project))}{muted(s.archiveLive)}</Box>
    }
    const next = row.next
    if (next === null) return archive === null ? null : <Box marginTop={1}>{archive}</Box>

    return (
      <Box flexDirection="row" marginTop={1} gap={1}>
        <Button key={`${row.key}::tick`} variant="primary" onPress={buttonPress(`${row.key}::tick`, () => actions.tick(next))}>
          {s.tickStep}
        </Button>
        <Button key={`${row.key}::hand`} onPress={buttonPress(`${row.key}::hand`, () => actions.handOver(row))}>
          {s.handOver}
        </Button>
        {archive}
        {confirm}
      </Box>
    )
  }

  const rowFocus = (row: TaskRow, lead: string, tone: Tone) => (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={color(tone)}>{`${lead} `}</Text>
        <Text bold wrap="wrap">
          {row.title}
        </Text>
      </Box>
      <Text color={palette.project} wrap="truncate-end">
        {row.project}
      </Text>
      <Text wrap="wrap">{row.status}</Text>
      {row.context !== '' && muted(s.contextLine(row.context))}
      {row.handoff !== '' && muted(s.handoffLine(row.handoff))}
      {rowActions(row)}
      {cardResult(row.key)}
    </Box>
  )

  // 1. The one thing that needs the person most, or a word that nothing does.
  const focus = (it: Focus | null) => {
    if (it === null) {
      const doing = view.current
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={palette.done}>{s.nothingForYou}</Text>
          {doing !== null && doing.state === 'working' && muted(doing.status)}
        </Box>
      )
    }
    const more = view.waiting.length - (it.type === 'ask' ? 1 : 0)

    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={palette.muted}>{s.mostNeeded}</Text>
        {it.type === 'ask' && (
          <Box flexDirection="column">
            <Box flexDirection="row">
              {chip(it.item)}
              <Text bold wrap="wrap">
                {it.item.text}
              </Text>
            </Box>
            {!(model.expanded === it.item.key && (
              isOpen('waiting') && view.waiting.some(item => item.key === it.item.key) ||
              isOpen('reminder') && (view.reminder ?? []).some(item => item.key === it.item.key) ||
              isOpen('older') && (view.older ?? []).some(item => item.key === it.item.key)
            )) && askDetail(it.item)}
          </Box>
        )}
        {it.type === 'due' && rowFocus(it.row, `⚑ ${it.row.due?.left ?? ''}`, 'alert')}
        {it.type === 'blocked' && rowFocus(it.row, s.stuckLead, 'alert')}
        {more > 0 && !isOpen('waiting') && (
          <Box flexDirection="column" marginTop={1}>
            <Button key="focus::more" plain onPress={buttonPress('focus::more', () => actions.toggleSection('waiting'), true)}>
              {s.moreWaiting(more)}
            </Button>
            {cardResult('focus::more')}
          </Box>
        )}
      </Box>
    )
  }

  // One task folded to a line (title, count, where it stands); opened, its bar, background,
  // every step and what can be done with it.
  const taskRow = (row: TaskRow, showProject: boolean) => {
    const isRowOpen = model.expanded === row.key
    const tail = row.due === null ? `${row.done}/${row.total}` : row.due.left
    const meta = [row.due === null ? '' : row.due.date, showProject ? row.project : '', row.auto === null ? '' : agentLabel(row.agent || 'claude', s), row.status, row.pr, row.when].filter(
      part => part !== '',
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Button key={row.key} plain onPress={buttonPress(row.key, () => actions.toggle(row.key), true)}>
            {`${isRowOpen ? '▾' : '▸'} ${row.title}`}
          </Button>
          {spacer()}
          <Text color={row.due === null ? palette.muted : color(row.due.tone)}>{` ${tail}`}</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text color={row.tone === 'quiet' ? palette.muted : color(row.tone)} wrap="truncate-end">
            {meta.join(' · ')}
          </Text>
        </Box>
        {!isRowOpen && cardResult(row.key)}
        {isRowOpen && (
          <Box paddingLeft={2} flexDirection="column" marginTop={1}>
            {bar(row.done, row.total, 12, true)}
            {row.context !== '' && muted(s.contextLine(row.context))}
            {row.handoff !== '' && muted(s.handoffLine(row.handoff))}
            {steps(row.steps)}
            {rowActions(row)}
            {cardResult(row.key)}
          </Box>
        )}
      </Box>
    )
  }

  // A waiting step folded to a line; opened, the same detail the focus shows. Folded, a failed
  // fold says why beside its line, since there is no open card to hold it.
  const waitingRow = (item: WaitingItem) => (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        {chip(item)}
        <Button key={`ask::${item.key}`} plain onPress={buttonPress(`ask::${item.key}`, () => actions.toggle(item.key), true)}>
          {item.text}
        </Button>
        {spacer()}
        <Text color={palette.muted} wrap="truncate-end">{` ${item.project}`}</Text>
      </Box>
      {model.expanded !== item.key && cardResult(item.key)}
      {model.expanded === item.key && <Box paddingLeft={2}>{askDetail(item)}</Box>}
    </Box>
  )

  // A question marked answered, muted, with the way to list it again.
  const hiddenRow = (item: WaitingItem) => (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      {muted(item.text)}
      {muted(`${item.project} › ${item.task}`)}
      <Box marginTop={1}>
        <Button key={`${item.key}::unhide`} onPress={buttonPress(`${item.key}::unhide`, () => actions.unhide(item))}>
          {s.showAgain}
        </Button>
      </Box>
      {cardResult(item.key)}
    </Box>
  )

  // The counts at the top; each opens what it counts. A zero stays, in the muted colour.
  const overview = () => {
    const { waiting, active, due, today } = view.overview
    const count = (id: string, glyph: string, n: number, word: string, hue: string) => (
      <Box flexDirection="row">
        <Text color={n > 0 ? hue : palette.muted}>{`${glyph} ${n}`}</Text>
        <Button key={`count::${id}`} plain onPress={buttonPress(`count::${id}`, () => actions.toggleSection(id), true)}>
          {` ${word}`}
        </Button>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
          {count('waiting', '●', waiting, s.countWaiting, palette.waiting)}
          {count('others', '▸', active, s.countActive, palette.accent)}
          {count('due', '⚑', due, s.countDue, palette.soon)}
          {count('recent', '✓', today, s.countToday, palette.done)}
        </Box>
        {['waiting', 'others', 'due', 'recent'].map(id => cardResult(`count::${id}`))}
      </Box>
    )
  }

  // 2. This session: short by default, every step behind 全部 N 步.
  const card = () => {
    const current = view.current
    if (current === null) return null
    const showAll = isOpen('steps')
    const now = current.steps.find(step => step.isCurrent)
    const next = current.steps.find(
      step => step.number !== null && !step.isCurrent && step.status !== 'done' && step.status !== 'cancelled',
    )

    return (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={palette.frame} paddingX={1}>
        <Box flexDirection="row">
          <Text color={palette.project} wrap="truncate-end">
            {current.branch === '' ? current.project : `${current.project} · ${current.branch}`}
          </Text>
          {spacer()}
          <Text color={palette.muted}>{`${current.done}/${current.total}`}</Text>
        </Box>
        <Text bold wrap="wrap">
          {current.title}
        </Text>
        {current.context !== '' && (
          <Text color={palette.muted} wrap={showAll ? 'wrap' : 'truncate-end'}>
            {s.contextLine(current.context)}
          </Text>
        )}
        {bar(current.done, current.total, model.width, true)}
        <Text color={current.tone === 'quiet' ? palette.muted : color(current.tone)} wrap="wrap">
          {current.status}
        </Text>
        {showAll ? (
          <Box flexDirection="column" marginTop={1}>
            {steps(current.steps)}
          </Box>
        ) : (
          <Box flexDirection="column">
            {now !== undefined && !current.status.includes(now.text) && <Text wrap="truncate-end">{s.nowStep(now.text)}</Text>}
            {next !== undefined && muted(s.nextStepLine(next.text), 'truncate-end')}
          </Box>
        )}
        {view.pr !== null && prLine(view.pr)}
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Button key="section::steps" plain onPress={buttonPress('section::steps', () => actions.toggleSection('steps'), true)}>
            {showAll ? s.foldSteps : s.allSteps(current.total)}
          </Button>
          {current.state === 'waiting' && (
            <Button key="continue" variant="primary" onPress={buttonPress('continue', actions.continueHere)}>
              {s.continueText}
            </Button>
          )}
        </Box>
        {cardResult('section::steps')}
        {cardResult('continue')}
      </Box>
    )
  }

  const nearest = view.due[0]
  const isEmpty =
    view.current === null &&
    view.waiting.length === 0 &&
    view.due.length === 0 &&
    view.active.length === 0 &&
    view.idle.length === 0 &&
    view.stopped.length === 0 &&
    view.recent.length === 0

  return (
    <Box flexDirection="column">
      <Text bold>{s.paneTitle}</Text>
      {view.warning && <Text color={palette.alert}>{view.warning}</Text>}
      {view.isCleanable && (
        <Box flexDirection="column">
          <Button key="clean" plain onPress={buttonPress('clean', actions.cleanUp)}>
            {s.cleanUp}
          </Button>
        </Box>
      )}
      {cardResult('clean')}
      {view.details && <Text color={palette.muted}>{view.details}</Text>}
      {view.pruned && <Text color={palette.muted}>{view.pruned}</Text>}
      {model.hasPendingQuestionsProblem && <Text color={palette.alert}>{s.inboxQuestionNotKept}</Text>}
      {model.hasQuestionsProblem && <Text color={palette.alert}>{s.questionsUnreadable()}</Text>}
      {overview()}

      {!model.hasTaskTools && view.current === null && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={palette.waiting}>{s.noTaskTools}</Text>
          {muted(s.noTaskToolsHow)}
          {muted(s.noTaskToolsManual)}
        </Box>
      )}

      {isEmpty ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{s.empty}</Text>
          {muted(s.emptyHow)}
        </Box>
      ) : (
        focus(view.focus)
      )}

      {Object.entries(model.results ?? {}).filter(([key, result]) => {
        const current = pressTarget(view, result.button, s)
        return result.label !== '' && (current.key !== key || view.hidden.some(item => item.key === key) && result.button.endsWith('::hide'))
      }).map(([key, result]) => {
        shown.add(key)
        return <Box flexDirection="column" marginTop={1}>
          {muted(result.label)}
          {resultLine(key, result)}
        </Box>
      })}

      {card()}
      {view.current === null && view.pr !== null && <Box marginTop={1}>{prLine(view.pr)}</Box>}

      {view.waiting.length > 0 && fold('waiting', s.sectionWaiting, view.waiting.length, 'warn', '')}
      {isOpen('waiting') && view.waiting.map(waitingRow)}
      {(view.stoppedAsking ?? 0) > 0 && <Box flexDirection="column">
        <Button key="section::stoppedAsking" plain onPress={buttonPress('section::stoppedAsking', () => actions.toggleSection('older'), true)}>
          {`${isOpen('older') ? '▾' : '▸'} ${s.stoppedAsking(view.stoppedAsking!)}`}
        </Button>
        {cardResult('section::stoppedAsking')}
      </Box>}
      {(['reminder', 'older'] as const).map(id => {
        const items = view[id] ?? []
        const shownItems = id === 'older' && !isOpen('olderAll') ? items.slice(0, OLDER_SHOWN) : items
        return items.length === 0 ? null : <Box flexDirection="column">
          {fold(id, id === 'reminder' ? s.sectionQuestionReminders : s.sectionOlderQuestions, items.length, 'quiet', s.questionAgingHint)}
          {isOpen(id) && shownItems.map(item => <Box flexDirection="column">{waitingRow(item)}{muted(item.when)}</Box>)}
          {isOpen(id) && shownItems.length < items.length && <Button key="section::olderAll" plain onPress={buttonPress('section::olderAll', () => actions.toggleSection('olderAll'), true)}>{s.showAllQuestions(items.length)}</Button>}
          {cardResult('section::olderAll')}
        </Box>
      })}
      {view.hidden.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Button key="section::hidden" plain onPress={buttonPress('section::hidden', () => actions.toggleSection('hidden'), true)}>
            {`${isOpen('hidden') ? '▾' : '▸'} ${s.hiddenCount(view.hidden.length)}`}
          </Button>
          {cardResult('section::hidden')}
        </Box>
      )}
      {isOpen('hidden') && view.hidden.map(hiddenRow)}
      {view.idle.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Button key="section::idle" plain onPress={buttonPress('section::idle', () => actions.toggleSection('idle'), true)}>
            {`${isOpen('idle') ? '▾' : '▸'} ${s.idleCount(view.idle.length)}`}
          </Button>
          {cardResult('section::idle')}
        </Box>
      )}
      {isOpen('idle') && view.idle.map(row => (
        <Box key={`idle::${row.key}`} flexDirection="column" marginTop={1} paddingLeft={1}>
          {taskRow(row, true)}
          {row.question !== null && muted(row.question)}
        </Box>
      ))}
      {view.stopped.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Button key="section::stopped" plain onPress={buttonPress('section::stopped', () => actions.toggleSection('stopped'), true)}>
            {`${isOpen('stopped') ? '▾' : '▸'} ${s.stoppedCount(view.stopped.length)}`}
          </Button>
          {cardResult('section::stopped')}
        </Box>
      )}
      {isOpen('stopped') && view.stopped.map(row => (
        <Box key={`stopped::${row.key}`} flexDirection="column" marginTop={1} paddingLeft={1}>
          {taskRow(row, true)}
          {shelfQuestions(row.questions ?? [], row.key)}
        </Box>
      ))}
      {hasDetachedResult && (
        <Box key={`stopped::${resultTask}`} flexDirection="column" marginTop={1} paddingLeft={1}>
          {muted([model.resolveResult?.project, model.resolveResult?.title].filter(Boolean).join(' · '))}
          {shelfQuestions([], resultTask)}
        </Box>
      )}

      {view.due.length > 0 &&
        fold('due', s.sectionDue, view.due.length, 'soon', nearest === undefined ? '' : s.nearestDue(nearest.title, nearest.due?.left ?? ''))}
      {isOpen('due') && (
        <Box flexDirection="column" paddingLeft={1}>
          {view.due.map(row => (
            <Box marginTop={1}>{taskRow(row, true)}</Box>
          ))}
        </Box>
      )}

      {view.groups.length > 0 &&
        fold(
          'others',
          view.current === null ? s.sectionActive : s.sectionOther,
          view.active.length,
          'accent',
          view.groups.map(group => group.project).join(s.listSep),
        )}
      {isOpen('others') &&
        view.groups.map(group => (
          <Box flexDirection="column" marginTop={1} paddingLeft={1}>
            <Box flexDirection="row">
              <Text color={palette.project} bold wrap="truncate-end">
                {group.isHere ? s.thisProject(group.project) : group.project}
              </Text>
              {spacer()}
              <Text color={palette.muted}>{` ${group.summary}`}</Text>
            </Box>
            <Box flexDirection="column" paddingLeft={1}>
              {group.rows.map(row => taskRow(row, false))}
            </Box>
          </Box>
        ))}

      {view.recent.length > 0 && fold('recent', s.sectionRecent, view.recent.length, 'done', '')}
      {isOpen('recent') && (
        <Box flexDirection="column" paddingLeft={1}>
          {view.recent.map(item => (
            <Box key={item.key} flexDirection="column">
              <Box flexDirection="row">
                <Text color={palette.done}>✓ </Text>
                <Text color={palette.muted} wrap="truncate-end">
                  {[item.project, item.title, item.when].filter(part => part !== '').join(' · ')}
                </Text>
              </Box>
              {shelfQuestions(item.questions ?? [], item.key)}
            </Box>
          ))}
          <Box>
            <Button key="archive" plain onPress={buttonPress('archive', actions.archive)}>
              {s.archiveNow}
            </Button>
          </Box>
          {cardResult('archive')}
        </Box>
      )}

      {Input !== null && (
        <Box flexDirection="column" marginTop={1}>
          <Input key="ask" placeholder={s.askPlaceholder} submitLabel={s.send} onSubmit={text => actions.press('ask', () => actions.ask(text))} />
          {cardResult('ask')}
        </Box>
      )}
      {model.answer !== null && (
        <Box flexDirection="column" marginTop={1}>
          {muted(s.question(model.answer.question))}
          <Text wrap="wrap">{model.answer.isAsking ? s.thinking : model.answer.text}</Text>
          {!model.answer.isAsking && (
            <Box flexDirection="row" gap={1}>
              {model.answer.copied === true && <Text color={palette.accent}>{s.copied}</Text>}
              <Button key="clear-answer" plain onPress={buttonPress('clear-answer', actions.clearAnswer)}>
                {s.clear}
              </Button>
            </Box>
          )}
        </Box>
      )}
      {cardResult('clear-answer')}

      <Box flexDirection="row" marginTop={1} gap={2}>
        <Button key="report" plain onPress={buttonPress('report', press => actions.report(press.surface))}>
          {s.report}
        </Button>
        <Button key="notify" plain onPress={buttonPress('notify', actions.toggleNotify, true)}>
          {model.isNotifyOn ? s.notifyOnButton : s.notifyOffButton}
        </Button>
        <Button key="legend" plain onPress={buttonPress('legend', actions.toggleLegend, true)}>
          {model.isLegendOpen ? s.legendClose : s.legend}
        </Button>
      </Box>
      {cardResult('report')}
      {cardResult('notify')}
      {cardResult('legend')}
      {model.isLegendOpen && (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {LEGEND.map((status, index) => (
              <Box flexDirection="row">
                <Text color={stepColor(palette, status)}>{GLYPH[status]}</Text>
                <Text color={palette.muted}>{` ${s.legendWords[index] ?? status}`}</Text>
              </Box>
            ))}
            <Text color={palette.muted}>{s.legendDue}</Text>
          </Box>
          {muted(s.legendAsk)}
          {muted(s.legendCleanup)}
        </Box>
      )}
      {Object.entries(model.results ?? {}).filter(([key, result]) => {
        const current = pressTarget(view, result.button, s)
        return !shown.has(key) && (result.tone === 'alert' || current.key !== key || current.revision === result.revision)
      }).map(([key, result]) => <Box flexDirection="column" marginTop={1}>
        {result.label !== '' && muted(result.label)}
        {resultLine(key, result)}
      </Box>)}
      <Text color={palette.muted}>
        {s.progressFileShown}
      </Text>
      {(view.health?.length ?? 0) > 0 && fold('health', s.sectionHealth, view.health!.length, 'quiet', '')}
      {isOpen('health') && (view.health ?? []).map(line => muted(line))}
    </Box>
  )
}
