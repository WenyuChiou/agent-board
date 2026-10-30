// Pure decision function: decides whether `agent-board` with no flags should print
// plain text, start the terminal board (--watch), or open the desktop web page (--serve).
//
// 1. Not an interactive terminal (piped stdout, CI set, or agent env vars present): 'text'
// 2. Interactive terminal without display (SSH_CONNECTION / SSH_TTY on any OS, or Linux without DISPLAY): 'terminal'
// 3. Interactive terminal with display (desktop): 'page'

export type Surface = 'text' | 'terminal' | 'page'

export const AGENT_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CODEX_THREAD_ID',
  'CURSOR_AGENT',
  'CURSOR_SESSION_ID',
  'OPENCODE',
  'OPENCODE_CONFIG_DIR',
  'GEMINI_CLI',
  'GROK_SESSION_ID',
  'MUSE_SESSION_ID',
  'MUSE_HOME',
  'HERMES_HOME',
  'HERMES_SESSION_ID',
  'OPENCLAW_STATE_DIR',
  'DSH_HOME',
  'DEEPSEEK_HOME',
  'AGENT_BOARD_AGENT',
  'AGENT_BOARD_SESSION_ID',
] as const

export interface SurfaceInput {
  env?: Record<string, string | undefined>
  isTty?: boolean
  platform?: NodeJS.Platform
}

export const pickSurface = ({
  env = process.env,
  isTty = Boolean(process.stdout?.isTTY),
  platform = process.platform,
}: SurfaceInput = {}): Surface => {
  if (!isTty) return 'text'
  if (env.CI && env.CI !== '0' && env.CI !== 'false') return 'text'
  if (AGENT_ENV_VARS.some(name => {
    const val = env[name]
    return typeof val === 'string' && val.length > 0 && val !== '0' && val !== 'false'
  })) {
    return 'text'
  }

  const isSsh = Boolean((env.SSH_CONNECTION && env.SSH_CONNECTION.length > 0) || (env.SSH_TTY && env.SSH_TTY.length > 0))
  if (isSsh) return 'terminal'

  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return 'terminal'
  }

  return 'page'
}
