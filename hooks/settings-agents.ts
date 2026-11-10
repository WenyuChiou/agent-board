import type { Strings } from './i18n'

export type SettingsAgentRow = {
  agent: string
  name: string
  state: string
  button: 'setup' | 'remove' | null
  note?: string
}

export const settingsAgentState = (isSetUp: boolean, hasBlock: boolean, isUntrusted: boolean, isFound: boolean, s: Strings): Pick<SettingsAgentRow, 'state' | 'button'> =>
  isSetUp && hasBlock ? { state: s.settingsAgentOnBoard, button: 'remove' }
    : isSetUp && isUntrusted ? { state: s.settingsAgentApproval, button: 'setup' }
      : isSetUp ? { state: s.settingsAgentStart, button: 'remove' }
        : isFound ? { state: s.settingsAgentNotSetUp, button: 'setup' }
          : { state: s.settingsAgentNotInstalled, button: null }
