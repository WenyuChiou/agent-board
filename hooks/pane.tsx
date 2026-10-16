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
import { stepColor, toneColor } from './palette'
import type { Palette } from './palette'
import { progressBar } from './view'
import type { PrView, StepRef, TaskRow, Tone, View, ViewStep, WaitingItem } from './view'

// The pane's drawing, from the view and a set of actions; it never touches the engine,
// so every press goes through an action register.tsx wires up.
//
// Three tiers, top to bottom: the counts (what waits on you, what is open, what is due,
// what got done today), this session's task as a numbered timeline, then everything else
// by project. Every glyph keeps one meaning and one colour throughout; 說明 lists them.

export type PaneUi = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Input: ElementConstructor<InputProps> | null
  Link: ElementConstructor<LinkProps> | null
}

export type PaneActions = {
  toggle: (key: string) => void
  continueHere: () => void
  archive: () => void
  takeOver: (row: TaskRow) => void
  handOver: (row: TaskRow) => void
  tick: (ref: StepRef) => void
  // A question for the side model, or a line starting with + to add a task.
  ask: (question: string) => void
  clearAnswer: () => void
  copyResume: (row: TaskRow, surface: RenderSurface) => void
  report: (surface: RenderSurface) => void
  toggleNotify: () => void
  toggleLegend: () => void
}

export type PaneModel = {
  view: View
  expanded: string
  answer: ProgressAnswer | null
  path: string
  width: number
  hasTaskTools: boolean
  isNotifyOn: boolean
  isLegendOpen: boolean
  palette: Palette
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

const LEGEND: ReadonlyArray<[ProgressStepStatus, string]> = [
  ['done', '完成'],
  ['doing', '正在做'],
  ['todo', '還沒做'],
  ['waiting', '等你'],
  ['running', '在跑'],
  ['blocked', '卡住'],
  ['cancelled', '取消'],
]

const isQuietStep = (status: ProgressStepStatus): boolean => status === 'todo' || status === 'cancelled'

export const drawPane = (ui: PaneUi, model: PaneModel, actions: PaneActions): RenderElement => {
  const { Box, Text, Button, Input, Link } = ui
  const { view, palette } = model
  const color = (tone: Tone): string | undefined => toneColor(palette, tone)

  const spacer = () => <Box flexGrow={1} />

  const label = (text: string, count: number | null, tone: Tone, tail: RenderElement | null = null) => (
    <Box flexDirection="row" marginTop={1}>
      <Text bold color={palette.frame}>
        {text}
      </Text>
      {count !== null && <Text color={color(tone)}>{` ${count}`}</Text>}
      {spacer()}
      {tail}
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
        {showPercent && <Text color={palette.frame}>{` ${percent}%`}</Text>}
      </Box>
    )
  }

  const stepRow = (step: ViewStep, room: number) => (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={palette.frame}>{step.number === null ? ' '.repeat(room + 1) : `${String(step.number).padStart(room)} `}</Text>
        <Text color={stepColor(palette, step.status)} dimColor={isQuietStep(step.status)}>
          {`${GLYPH[step.status]} `}
        </Text>
        <Text
          bold={step.isCurrent}
          dimColor={step.status === 'done' || (isQuietStep(step.status) && !step.isCurrent)}
          wrap="wrap"
        >
          {step.text}
        </Text>
        {step.isCurrent && <Text color={palette.accent}> ← 現在</Text>}
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

  const context = (text: string) =>
    text === '' ? null : (
      <Text dimColor wrap="wrap">
        {`背景：${text}`}
      </Text>
    )

  const prLine = (pr: PrView) => (
    <Box flexDirection="row">
      {Link !== null ? (
        <Link href={pr.url} label={pr.text} />
      ) : (
        <Text color={color(pr.tone)} dimColor={pr.tone === 'quiet'} wrap="truncate-end">
          {pr.text}
        </Text>
      )}
      {Link !== null && pr.tone !== 'quiet' && <Text color={color(pr.tone)}> ●</Text>}
    </Box>
  )

  // The counts at the top; a zero stays, dim, so the line always reads the same way.
  const overview = () => {
    const { waiting, active, due, today } = view.overview
    const chip = (glyph: string, count: number, word: string, hue: string) => (
      <Box flexDirection="row">
        <Text color={count > 0 ? hue : palette.frame}>{`${glyph} ${count}`}</Text>
        <Text dimColor={count === 0}>{` ${word}`}</Text>
      </Box>
    )

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
        {chip('●', waiting, '等你', palette.waiting)}
        {chip('▸', active, '進行中', palette.accent)}
        {chip('⚑', due, '快到期', palette.soon)}
        {chip('✓', today, '今天完成', palette.done)}
      </Box>
    )
  }

  // What a row offers once opened: take it over here, reopen the session that left it, tick
  // its step, or hand it to Claude.
  const rowActions = (row: TaskRow) => {
    if (row.auto === 'ended') {
      const resume = row.resume
      if (!row.isHere && resume === null) return <Text dimColor>{`到 ${row.project} 的對話接著做。`}</Text>

      return (
        <Box flexDirection="row" marginTop={1} gap={1}>
          {row.isHere && (
            <Button key={`${row.key}::take`} variant="primary" onPress={() => actions.takeOver(row)}>
              接手做完
            </Button>
          )}
          {resume !== null && (
            <Button key={`${row.key}::resume`} onPress={press => actions.copyResume(row, press.surface)}>
              複製續接指令
            </Button>
          )}
        </Box>
      )
    }
    if (row.auto !== null) {
      return (
        <Text dimColor wrap="wrap">
          {row.isHere ? '另一個對話正在做。' : `到 ${row.project} 的對話接著做。`}
        </Text>
      )
    }
    const next = row.next
    if (next === null) return null

    return (
      <Box flexDirection="row" marginTop={1} gap={1}>
        <Button key={`${row.key}::tick`} variant="primary" onPress={() => actions.tick(next)}>
          完成這步
        </Button>
        <Button key={`${row.key}::hand`} onPress={() => actions.handOver(row)}>
          交給 Claude
        </Button>
      </Box>
    )
  }

  // One task: its title and count, then a short bar with where it stands; opened, its
  // background, every step and what can be done with it.
  const taskRow = (row: TaskRow, showProject: boolean, gapAbove = 1) => {
    const isOpen = model.expanded === row.key
    const tail = row.due === null ? `${row.done}/${row.total}` : row.due.left
    const meta = [row.due === null ? '' : row.due.date, showProject ? row.project : '', row.status, row.pr, row.when].filter(
      part => part !== '',
    )

    return (
      <Box flexDirection="column" marginTop={gapAbove}>
        <Box flexDirection="row">
          <Button key={row.key} plain onPress={() => actions.toggle(row.key)}>
            {`${isOpen ? '▾' : '▸'} ${row.title}`}
          </Button>
          {spacer()}
          <Text color={row.due === null ? palette.frame : color(row.due.tone)}>{` ${tail}`}</Text>
        </Box>
        <Box paddingLeft={2} flexDirection="row">
          {bar(row.done, row.total, 6, false)}
          <Text color={color(row.tone)} dimColor={row.tone === 'quiet'} wrap="truncate-end">
            {` ${meta.join(' · ')}`}
          </Text>
        </Box>
        {isOpen && (
          <Box paddingLeft={2} flexDirection="column" marginTop={1}>
            {context(row.context)}
            {steps(row.steps)}
            {rowActions(row)}
          </Box>
        )}
      </Box>
    )
  }

  const waitingRow = (item: WaitingItem) => {
    const step = item.step
    const detail = item.note !== '' ? item.note : item.context

    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color={palette.waiting}>● </Text>
        <Box flexDirection="column" flexGrow={1}>
          <Text bold wrap="wrap">
            {item.text}
          </Text>
          <Text color={palette.project} wrap="truncate-end">
            {`${item.project} › ${item.task}`}
          </Text>
          {detail !== '' && (
            <Text dimColor={item.note === ''} wrap="wrap">
              {detail}
            </Text>
          )}
          {item.when !== '' && <Text dimColor>{item.when}</Text>}
        </Box>
        {step !== null && (
          <Button key={`${item.key}::done`} onPress={() => actions.tick(step)}>
            完成
          </Button>
        )}
      </Box>
    )
  }

  const current = view.current
  const isEmpty =
    current === null &&
    view.waiting.length === 0 &&
    view.due.length === 0 &&
    view.active.length === 0 &&
    view.recent.length === 0

  return (
    <Box flexDirection="column">
      <Text bold>進度</Text>
      {overview()}

      {!model.hasTaskTools && current === null && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={palette.waiting}>這個對話沒有 Task 工具，進度不會自動同步。</Text>
          <Text dimColor wrap="wrap">
            從終端機開的 claude：把 CLAUDE_CODE_ENABLE_TODO_TOOLS=1 加進 shell 的 profile（PowerShell 是 $PROFILE，重跑 setup 腳本就會加），開新視窗再啟動就會同步。別放 settings.json，那裡的 env 也會進桌面 app。
          </Text>
          <Text dimColor wrap="wrap">桌面 app、git-bash 這類沒有它的對話，照常手動記在 progress.md。</Text>
        </Box>
      )}

      {isEmpty && (
        <Box flexDirection="column" marginTop={1}>
          <Text>目前沒有進行中的工作。</Text>
          <Text dimColor wrap="wrap">
            Claude 用 Task 清單開工後，這裡會自動出現；也可以在下面打「+ 專案：要做的事」自己加。
          </Text>
        </Box>
      )}

      {current === null && view.pr !== null && <Box marginTop={1}>{prLine(view.pr)}</Box>}

      {current !== null && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={palette.frame} paddingX={1}>
          <Box flexDirection="row">
            <Text color={palette.project} wrap="truncate-end">
              {current.branch === '' ? current.project : `${current.project} · ${current.branch}`}
            </Text>
            {spacer()}
            <Text color={palette.frame}>{`${current.done}/${current.total}`}</Text>
          </Box>
          <Text bold wrap="wrap">
            {current.title}
          </Text>
          {context(current.context)}
          <Box marginTop={1}>{bar(current.done, current.total, model.width, true)}</Box>
          <Text color={color(current.tone)} dimColor={current.tone === 'quiet'} wrap="wrap">
            {current.status}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {steps(current.steps)}
          </Box>
          {view.pr !== null && <Box marginTop={1}>{prLine(view.pr)}</Box>}
          {current.state === 'waiting' && (
            <Box flexDirection="row" marginTop={1}>
              <Button key="continue" variant="primary" onPress={actions.continueHere}>
                繼續
              </Button>
            </Box>
          )}
        </Box>
      )}

      {view.waiting.length > 0 && label('等你處理', view.waiting.length, 'warn')}
      {view.waiting.map(waitingRow)}

      {view.due.length > 0 && label('快到期', null, 'quiet')}
      {view.due.map(row => taskRow(row, true))}

      {view.groups.length > 0 && label(current === null ? '進行中' : '其他進行中', view.active.length, 'accent')}
      {view.groups.map(group => (
        <Box flexDirection="column" marginTop={1}>
          <Text color={palette.project} bold wrap="truncate-end">
            {group.isHere ? `${group.project}（這個專案）` : group.project}
          </Text>
          <Box flexDirection="column" paddingLeft={1}>
            {group.rows.map((row, index) => taskRow(row, false, index === 0 ? 0 : 1))}
          </Box>
        </Box>
      ))}

      {view.recent.length > 0 &&
        label(
          '最近完成',
          null,
          'quiet',
          <Button key="archive" plain dimColor onPress={actions.archive}>
            封存
          </Button>,
        )}
      {view.recent.map(item => (
        <Box flexDirection="row">
          <Text color={palette.done}>✓ </Text>
          <Text dimColor wrap="truncate-end">
            {[item.project, item.title, item.when].filter(part => part !== '').join(' · ')}
          </Text>
        </Box>
      ))}

      {Input !== null && (
        <Box flexDirection="column" marginTop={1}>
          <Input key="ask" placeholder="問一句；+ 開頭就新增一件事" submitLabel="送出" onSubmit={actions.ask} />
        </Box>
      )}
      {model.answer !== null && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor wrap="wrap">
            問：{model.answer.question}
          </Text>
          <Text wrap="wrap">{model.answer.isAsking ? '想一下…' : model.answer.text}</Text>
          {!model.answer.isAsking && (
            <Box flexDirection="row" gap={1}>
              {model.answer.copied === true && <Text color={palette.accent}>已複製到剪貼簿</Text>}
              <Button key="clear-answer" plain dimColor onPress={actions.clearAnswer}>
                清掉
              </Button>
            </Box>
          )}
        </Box>
      )}

      <Box flexDirection="row" marginTop={1} gap={1}>
        <Button key="report" plain dimColor onPress={press => actions.report(press.surface)}>
          週報
        </Button>
        <Button key="notify" plain dimColor onPress={actions.toggleNotify}>
          {model.isNotifyOn ? '通知：開' : '通知：關'}
        </Button>
        <Button key="legend" plain dimColor onPress={actions.toggleLegend}>
          {model.isLegendOpen ? '收起說明' : '說明'}
        </Button>
      </Box>
      {model.isLegendOpen && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {LEGEND.map(([status, word]) => (
            <Box flexDirection="row">
              <Text color={stepColor(palette, status)}>{GLYPH[status]}</Text>
              <Text dimColor>{` ${word}`}</Text>
            </Box>
          ))}
          <Text dimColor>⚑ 兩週內截止</Text>
        </Box>
      )}
      <Text dimColor wrap="truncate-start">
        {model.path}
      </Text>
    </Box>
  )
}
