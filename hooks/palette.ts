import type { ProgressStepStatus } from '../types'
import type { AskKind } from './ask'

// 和色: traditional Japanese colours, one set for a dark terminal and one for a light one.
// The dark set is the softer, lighter shade of each hue; the light set the deeper one. Every
// colour used for text is at least 4.5:1 against its terminal's ground (#1e2022 / #fbfaf5);
// `frame` draws only lines and the empty part of a bar. Names are the colours' own.

export type Palette = {
  // In progress, the progress bar, links: 浅葱 / 藍
  accent: string
  // Finished: 若竹 / 常磐
  done: string
  // Waits on you: 山吹 / 鶯茶
  waiting: string
  // Running on its own (CI, a long job, someone else): 藤紫 / 江戸紫
  running: string
  // Due within a week: 柿 / 代赭
  soon: string
  // Stuck, overdue, CI failed: 薔薇 / 茜
  alert: string
  // Frames, rules, the empty part of a bar: 利休鼠 / 灰
  frame: string
  // Secondary text (background, times, counts). Never the terminal's own dim, which turns
  // faint grey on a light background: 銀鼠 / 墨
  muted: string
  // Project names: 錆浅葱 / 鉄
  project: string
}

export const DARK: Palette = {
  accent: '#00A3AF',
  done: '#68BE8D',
  waiting: '#F8B500',
  running: '#A59ACA',
  soon: '#ED6D3D',
  alert: '#E9546B',
  frame: '#6E7268',
  muted: '#AFAFB0',
  project: '#5C9291',
}

export const LIGHT: Palette = {
  accent: '#165E83',
  done: '#007B43',
  waiting: '#715C1F',
  running: '#745399',
  soon: '#BB5535',
  alert: '#B7282E',
  frame: '#9EA19A',
  muted: '#595857',
  project: '#005243',
}

// The person's /config theme: `light`, `light-daltonized`, `light-ansi` take the light set;
// everything else (dark, auto, a custom theme) the dark one.
export const paletteFor = (theme: string): Palette => (/light/i.test(theme) ? LIGHT : DARK)

export type Tone = 'accent' | 'warn' | 'alert' | 'quiet' | 'done' | 'running' | 'soon'

export type Role = keyof Palette

// Which role each meaning takes; the pane reads the colour, the HTML page the role's CSS
// variable, so both stay in step.
export const toneRole = (tone: Tone): Role => {
  if (tone === 'accent') return 'accent'
  if (tone === 'warn') return 'waiting'
  if (tone === 'alert') return 'alert'
  if (tone === 'done') return 'done'
  if (tone === 'running') return 'running'
  if (tone === 'soon') return 'soon'

  return 'muted'
}

// The chip in front of a step that waits on the person: what kind of thing it asks.
export const askRole = (kind: AskKind): Role => {
  if (kind === 'confirm' || kind === 'choose') return 'waiting'
  if (kind === 'do') return 'soon'
  if (kind === 'review') return 'running'
  if (kind === 'wait') return 'muted'

  return 'accent'
}

export const stepRole = (status: ProgressStepStatus): Role => {
  if (status === 'done') return 'done'
  if (status === 'doing') return 'accent'
  if (status === 'waiting') return 'waiting'
  if (status === 'running') return 'running'
  if (status === 'blocked') return 'alert'

  return 'muted'
}

export const toneColor = (palette: Palette, tone: Tone): string => palette[toneRole(tone)]
export const askColor = (palette: Palette, kind: AskKind): string => palette[askRole(kind)]
export const stepColor = (palette: Palette, status: ProgressStepStatus): string => palette[stepRole(status)]

// Page surfaces differ from terminal surfaces while sharing the same colour roles.
export const PAGE_LIGHT = {
  ground: '#F3F5F7', surface: '#FCFDFE', inset: '#EAEFF2', ink: '#172026', muted: '#525B63',
  line: '#E0E6EB', 'line-strong': '#C8D2DA', 'on-accent': '#FFFFFF',
  accent: '#185A7D', done: '#00733E',
  waiting: '#8A5D00', 'waiting-text': '#8A5200', 'waiting-fill': '#F4B41A', 'waiting-on': '#231800',
  running: '#6B4C8C', soon: '#A64B2A', alert: '#B0252B', project: '#005243',
  'surf-cli-bg': '#ECEFF2', 'surf-cli-line': '#CFD7DE', 'surf-cli-ink': '#434B52',
  'surf-app-bg': '#E7F2F8', 'surf-app-line': '#B8D4E3', 'surf-app-ink': '#185A7D',
  'receipt-wait': '#664D00', 'receipt-wait-bg': '#FBF3DC', 'receipt-wait-line': '#DFC98A',
  'receipt-done': '#006636', 'receipt-done-bg': '#EDF7F1', 'receipt-done-line': '#A5D4B8',
  'receipt-fail': '#A82026', 'receipt-fail-bg': '#FCEEEF', 'receipt-fail-line': '#E8B5B8',
  // The logo's one colour: the dark waiting amber, deepened here so it keeps 3:1 on a light tab bar too.
  brand: '#B36A00',
  scrim: 'rgba(10,12,13,.38)',
  shadow: '0 1px 2px rgba(0,0,0,.05),0 2px 8px -4px rgba(0,0,0,.08)',
}

export const PAGE_DARK = {
  ground: '#141617', surface: '#1e2022', inset: '#25282b', ink: '#e6e4dc',
  line: '#2e3134', 'line-strong': '#43474b', 'on-accent': '#141617',
  waiting: '#F8B500', 'waiting-text': '#F8B500', 'waiting-fill': '#F8B500', 'waiting-on': '#141617',
  alert: '#EE5E75', project: '#6BA3A2',
  'surf-cli-bg': '#25282B', 'surf-cli-line': '#3D4145', 'surf-cli-ink': '#C9C7BE',
  'surf-app-bg': '#182930', 'surf-app-line': '#2B4C59', 'surf-app-ink': '#5EC2CC',
  'receipt-wait': '#F8B500', 'receipt-wait-bg': '#2E281B', 'receipt-wait-line': '#66501B',
  'receipt-done': '#68BE8D', 'receipt-done-bg': '#1B2B22', 'receipt-done-line': '#2F5E43',
  'receipt-fail': '#F27286', 'receipt-fail-bg': '#331F23', 'receipt-fail-line': '#733842',
  brand: '#F8B500',
  scrim: 'rgba(10,12,13,.6)',
  shadow: '0 1px 2px rgba(0,0,0,.2),0 2px 8px -4px rgba(0,0,0,.4)',
}
