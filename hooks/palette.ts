import type { ProgressStepStatus } from '../types'

// 和色: traditional Japanese colours, one set for a dark terminal and one for a light one.
// The dark set is the softer, lighter shade of each hue; the light set the deeper one, so
// each keeps its contrast on its own background. Names are the colours' own.

export type Palette = {
  // In progress, the progress bar, links: 浅葱 / 藍
  accent: string
  // Finished: 若竹 / 常磐
  done: string
  // Waits on you: 山吹 / 琥珀
  waiting: string
  // Running on its own (CI, a long job, someone else): 藤紫 / 江戸紫
  running: string
  // Due within a week: 柿 / 代赭
  soon: string
  // Stuck, overdue, CI failed: 紅緋 / 茜
  alert: string
  // Frames, rules, the empty part of a bar: 利休鼠
  frame: string
  // Project names: 錆浅葱 / 鉄
  project: string
}

export const DARK: Palette = {
  accent: '#00A3AF',
  done: '#68BE8D',
  waiting: '#F8B500',
  running: '#A59ACA',
  soon: '#ED6D3D',
  alert: '#E83929',
  frame: '#888E7E',
  project: '#5C9291',
}

export const LIGHT: Palette = {
  accent: '#165E83',
  done: '#007B43',
  waiting: '#BF783A',
  running: '#745399',
  soon: '#BB5535',
  alert: '#B7282E',
  frame: '#888E7E',
  project: '#005243',
}

// The person's /config theme: `light`, `light-daltonized`, `light-ansi` take the light set;
// everything else (dark, auto, a custom theme) the dark one.
export const paletteFor = (theme: string): Palette => (/light/i.test(theme) ? LIGHT : DARK)

export type Tone = 'accent' | 'warn' | 'alert' | 'quiet' | 'done' | 'running' | 'soon'

export const toneColor = (palette: Palette, tone: Tone): string | undefined => {
  if (tone === 'accent') return palette.accent
  if (tone === 'warn') return palette.waiting
  if (tone === 'alert') return palette.alert
  if (tone === 'done') return palette.done
  if (tone === 'running') return palette.running
  if (tone === 'soon') return palette.soon

  return undefined
}

export const stepColor = (palette: Palette, status: ProgressStepStatus): string | undefined => {
  if (status === 'done') return palette.done
  if (status === 'doing') return palette.accent
  if (status === 'waiting') return palette.waiting
  if (status === 'running') return palette.running
  if (status === 'blocked') return palette.alert

  return undefined
}
