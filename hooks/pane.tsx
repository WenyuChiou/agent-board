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

import type { ProgressAnswer, ProgressStepStatus } from '../types'
import type { Strings } from './i18n'
import { askColor, stepColor, toneColor } from './palette'
import type { Palette } from './palette'
import { questionsPath } from './questions'
import { progressBar, replyHint } from './view'
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
  toggle: (key: string) => void
  // Opens or folds a section: waiting, due, others, recent, steps, hidden, idle.
  toggleSection: (id: string) => void
  continueHere: () => void
  archive: () => void
  takeOver: (row: TaskRow) => void
  handOver: (row: TaskRow) => void
  tick: (ref: StepRef) => void
  // An answer to one of this session's own questions, sent to Claude.
  answer: (item: WaitingItem, text: string) => void
  copyCommand: (item: WaitingItem, surface: RenderSurface) => void
  copyAskedResume: (item: WaitingItem, surface: RenderSurface) => void
  // Hides a question answered in its own session, on this machine only; sends nothing.
  hide: (item: WaitingItem) => void
  unhide: (item: WaitingItem) => void
  // Opens the reply box under a review, for what should change; sends nothing.
  revise: (item: WaitingItem) => void
  // A question for the side model, or a line starting with + to add a task.
  ask: (question: string) => void
  clearAnswer: () => void
  copyResume: (row: TaskRow, surface: RenderSurface) => void
  // Moves one task to the archive file now: an ended session's block or a hand-kept task.
  archiveRow: (row: TaskRow) => void
  confirmRow: (row: TaskRow) => void
  report: (surface: RenderSurface) => void
  toggleNotify: () => void
  toggleLegend: () => void
}

export type PaneModel = {
  view: View
  expanded: string
  // The review whose reply box is open, by item key.
  revising: string
  opened: readonly string[]
  answer: ProgressAnswer | null
  path: string
  width: number
  hasTaskTools: boolean
  isNotifyOn: boolean
  isLegendOpen: boolean
  hasQuestionsProblem?: boolean
  palette: Palette
  s: Strings
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
  const color = (tone: Tone): string => toneColor(palette, tone)
  const isOpen = (id: string): boolean => model.opened.includes(id)

  const spacer = () => <Box flexGrow={1} />
  const muted = (text: string, wrap: 'wrap' | 'truncate-end' = 'wrap') => (
    <Text color={palette.muted} wrap={wrap}>
      {text}
    </Text>
  )

  // A section folded to one line: its name, its count, a word on what is inside, and ▸ / ▾.
  const fold = (id: string, title: string, count: number, tone: Tone, hint: string) => (
    <Box flexDirection="row" marginTop={1}>
      <Button key={`section::${id}`} plain onPress={() => actions.toggleSection(id)}>
        {`${isOpen(id) ? '▾' : '▸'} ${title}`}
      </Button>
      <Text color={color(tone)}>{` ${count}`}</Text>
      {hint !== '' && <Text color={palette.muted} wrap="truncate-end">{`  ${hint}`}</Text>}
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
      const hint = replyHint(item, s)
      return (
        <Box flexDirection="column">
          {run !== null && <Text color={palette.accent} wrap="wrap">{`$ ${run}`}</Text>}
          {run !== null && (
            <Box marginTop={1}>
              <Button key={`${item.key}::copy`} onPress={press => actions.copyCommand(item, press.surface)}>
                {s.copyCommand}
              </Button>
            </Box>
          )}
          {open !== null && Link !== null && <Link href={open} label={s.openLink} />}
          {muted(hint.where)}
          {hint.reopen !== null && (
            <Box marginTop={1}>
              <Button key={`${item.key}::resume`} onPress={press => actions.copyAskedResume(item, press.surface)}>
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
          <Button key={`${item.key}::done`} variant="primary" onPress={() => actions.tick(step)}>
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
              if (text.trim() !== '') actions.answer(item, text.trim())
            }}
          />
        </Box>
      )
    const buttons = (pairs: ReadonlyArray<[string, string, boolean]>) => (
      <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
        {pairs.map(([label, answer, isPrimary]) =>
          isPrimary ? (
            <Button key={`${item.key}::${label}`} variant="primary" onPress={() => actions.answer(item, answer)}>
              {label}
            </Button>
          ) : (
            <Button key={`${item.key}::${label}`} onPress={() => actions.answer(item, answer)}>
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
              <Button key={`${item.key}::copy`} onPress={press => actions.copyCommand(item, press.surface)}>
                {s.copyCommand}
              </Button>
            )}
            <Button key={`${item.key}::did`} variant="primary" onPress={() => actions.answer(item, s.didIt)}>
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
            <Button key={`${item.key}::${s.looksGood}`} variant="primary" onPress={() => actions.answer(item, s.looksGoodAnswer)}>
              {s.looksGood}
            </Button>
            <Button key={`${item.key}::revise`} onPress={() => actions.revise(item)}>
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
        {`${item.project} › ${item.task}${item.agent === '' ? '' : ` · ${item.agent}`}`}
      </Text>
      {item.note !== '' && <Text wrap="wrap">{item.note}</Text>}
      {item.note === '' && item.context !== '' && muted(s.contextLine(item.context))}
      {item.when !== '' && muted(item.when)}
      {item.canHide === false ? muted(s.questionReviewOnly) : item.where !== 'manual' && muted(s.archiveLive)}
      {askActions(item)}
      {item.hideKey !== '' && item.canHide !== false && (
        <Box marginTop={1}>
          <Button key={`${item.key}::hide`} onPress={() => actions.hide(item)}>
            {s.answeredHide}
          </Button>
        </Box>
      )}
    </Box>
  )

  // What a row offers once opened: take it over here, reopen the session that left it, tick
  // its step, hand it to Claude, or put it in the archive now instead of waiting for cleanup.
  const rowActions = (row: TaskRow) => {
    const confirm = row.confirm == null ? null : <Button key={`${row.key}::done`} onPress={() => actions.confirmRow(row)}>{s.confirmDone}</Button>
    const archive = row.archive === null ? null : (
      <Button key={`${row.key}::archive`} onPress={() => actions.archiveRow(row)}>
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
            <Button key={`${row.key}::take`} variant="primary" onPress={() => actions.takeOver(row)}>
              {s.takeOver}
            </Button>
          )}
          {resume !== null && (
            <Button key={`${row.key}::resume`} onPress={press => actions.copyResume(row, press.surface)}>
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
        <Button key={`${row.key}::tick`} variant="primary" onPress={() => actions.tick(next)}>
          {s.tickStep}
        </Button>
        <Button key={`${row.key}::hand`} onPress={() => actions.handOver(row)}>
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
            {askDetail(it.item)}
          </Box>
        )}
        {it.type === 'due' && rowFocus(it.row, `⚑ ${it.row.due?.left ?? ''}`, 'alert')}
        {it.type === 'blocked' && rowFocus(it.row, s.stuckLead, 'alert')}
        {more > 0 && !isOpen('waiting') && (
          <Box marginTop={1}>
            <Button key="focus::more" plain onPress={() => actions.toggleSection('waiting')}>
              {s.moreWaiting(more)}
            </Button>
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
    const meta = [row.due === null ? '' : row.due.date, showProject ? row.project : '', row.agent, row.status, row.pr, row.when].filter(
      part => part !== '',
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Button key={row.key} plain onPress={() => actions.toggle(row.key)}>
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
        {isRowOpen && (
          <Box paddingLeft={2} flexDirection="column" marginTop={1}>
            {bar(row.done, row.total, 12, true)}
            {row.context !== '' && muted(s.contextLine(row.context))}
            {row.handoff !== '' && muted(s.handoffLine(row.handoff))}
            {steps(row.steps)}
            {rowActions(row)}
          </Box>
        )}
      </Box>
    )
  }

  // A waiting step folded to a line; opened, the same detail the focus shows.
  const waitingRow = (item: WaitingItem) => (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        {chip(item)}
        <Button key={`ask::${item.key}`} plain onPress={() => actions.toggle(item.key)}>
          {item.text}
        </Button>
        {spacer()}
        <Text color={palette.muted} wrap="truncate-end">{` ${item.project}`}</Text>
      </Box>
      {model.expanded === item.key && <Box paddingLeft={2}>{askDetail(item)}</Box>}
    </Box>
  )

  // A question marked answered, muted, with the way to list it again.
  const hiddenRow = (item: WaitingItem) => (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      {muted(item.text)}
      {muted(`${item.project} › ${item.task}`)}
      <Box marginTop={1}>
        <Button key={`${item.key}::unhide`} onPress={() => actions.unhide(item)}>
          {s.showAgain}
        </Button>
      </Box>
    </Box>
  )

  // The counts at the top; each opens what it counts. A zero stays, in the muted colour.
  const overview = () => {
    const { waiting, active, due, today } = view.overview
    const count = (id: string, glyph: string, n: number, word: string, hue: string) => (
      <Box flexDirection="row">
        <Text color={n > 0 ? hue : palette.muted}>{`${glyph} ${n}`}</Text>
        <Button key={`count::${id}`} plain onPress={() => actions.toggleSection(id)}>
          {` ${word}`}
        </Button>
      </Box>
    )

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
        {count('waiting', '●', waiting, s.countWaiting, palette.waiting)}
        {count('others', '▸', active, s.countActive, palette.accent)}
        {count('due', '⚑', due, s.countDue, palette.soon)}
        {count('recent', '✓', today, s.countToday, palette.done)}
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
          <Button key="section::steps" plain onPress={() => actions.toggleSection('steps')}>
            {showAll ? s.foldSteps : s.allSteps(current.total)}
          </Button>
          {current.state === 'waiting' && (
            <Button key="continue" variant="primary" onPress={actions.continueHere}>
              {s.continueText}
            </Button>
          )}
        </Box>
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
      {model.hasQuestionsProblem && <Text color={palette.alert}>{s.questionsUnreadable(questionsPath(model.path))}</Text>}
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

      {card()}
      {view.current === null && view.pr !== null && <Box marginTop={1}>{prLine(view.pr)}</Box>}

      {view.waiting.length > 0 && fold('waiting', s.sectionWaiting, view.waiting.length, 'warn', '')}
      {isOpen('waiting') && view.waiting.map(waitingRow)}
      {(['reminder', 'older'] as const).map(id => {
        const items = view[id] ?? []
        return items.length === 0 ? null : <Box flexDirection="column">
          {fold(id, id === 'reminder' ? s.sectionQuestionReminders : s.sectionOlderQuestions, items.length, 'quiet', s.questionAgingHint)}
          {isOpen(id) && items.map(item => <Box flexDirection="column">{waitingRow(item)}{muted(item.when)}</Box>)}
        </Box>
      })}
      {view.hidden.length > 0 && (
        <Box marginTop={1}>
          <Button key="section::hidden" plain onPress={() => actions.toggleSection('hidden')}>
            {`${isOpen('hidden') ? '▾' : '▸'} ${s.hiddenCount(view.hidden.length)}`}
          </Button>
        </Box>
      )}
      {isOpen('hidden') && view.hidden.map(hiddenRow)}
      {view.idle.length > 0 && (
        <Box marginTop={1}>
          <Button key="section::idle" plain onPress={() => actions.toggleSection('idle')}>
            {`${isOpen('idle') ? '▾' : '▸'} ${s.idleCount(view.idle.length)}`}
          </Button>
        </Box>
      )}
      {isOpen('idle') && view.idle.map(row => (
        <Box key={`idle::${row.key}`} flexDirection="column" marginTop={1} paddingLeft={1}>
          {taskRow(row, true)}
          {row.question !== null && muted(row.question)}
        </Box>
      ))}
      {view.stopped.length > 0 && (
        <Box marginTop={1}>
          <Button key="section::stopped" plain onPress={() => actions.toggleSection('stopped')}>
            {`${isOpen('stopped') ? '▾' : '▸'} ${s.stoppedCount(view.stopped.length)}`}
          </Button>
        </Box>
      )}
      {isOpen('stopped') && view.stopped.map(row => (
        <Box key={`stopped::${row.key}`} flexDirection="column" marginTop={1} paddingLeft={1}>
          {taskRow(row, true)}
          {row.question !== null && muted(row.question)}
        </Box>
      ))}

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
            <Box flexDirection="row">
              <Text color={palette.done}>✓ </Text>
              <Text color={palette.muted} wrap="truncate-end">
                {[item.project, item.title, item.when].filter(part => part !== '').join(' · ')}
              </Text>
            </Box>
          ))}
          <Box>
            <Button key="archive" plain onPress={actions.archive}>
              {s.archiveNow}
            </Button>
          </Box>
        </Box>
      )}

      {Input !== null && (
        <Box flexDirection="column" marginTop={1}>
          <Input key="ask" placeholder={s.askPlaceholder} submitLabel={s.send} onSubmit={actions.ask} />
        </Box>
      )}
      {model.answer !== null && (
        <Box flexDirection="column" marginTop={1}>
          {muted(s.question(model.answer.question))}
          <Text wrap="wrap">{model.answer.isAsking ? s.thinking : model.answer.text}</Text>
          {!model.answer.isAsking && (
            <Box flexDirection="row" gap={1}>
              {model.answer.copied === true && <Text color={palette.accent}>{s.copied}</Text>}
              <Button key="clear-answer" plain onPress={actions.clearAnswer}>
                {s.clear}
              </Button>
            </Box>
          )}
        </Box>
      )}

      <Box flexDirection="row" marginTop={1} gap={2}>
        <Button key="report" plain onPress={press => actions.report(press.surface)}>
          {s.report}
        </Button>
        <Button key="notify" plain onPress={actions.toggleNotify}>
          {model.isNotifyOn ? s.notifyOnButton : s.notifyOffButton}
        </Button>
        <Button key="legend" plain onPress={actions.toggleLegend}>
          {model.isLegendOpen ? s.legendClose : s.legend}
        </Button>
      </Box>
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
      <Text color={palette.muted} wrap="truncate-start">
        {model.path}
      </Text>
    </Box>
  )
}
