export type InstallContext = {
  program: string
  flags: readonly string[]
  dataDir?: string
}
export type InstallStep = {
  target: 'setup' | 'board'
  mode?: string
  agent?: string
  codexBin?: string | { placeholder: string }
  apply?: boolean
  extra?: readonly string[]
}
export const installContext: (args: readonly string[]) => Pick<InstallContext, 'flags'>
export const installCommand: (
  context: InstallContext,
  step: InstallStep,
  quote: (word: string) => string,
  render?: (program: string, argv: string[], isRunnable: boolean) => string,
) => { argv: string[]; text: string; isRunnable: boolean }
