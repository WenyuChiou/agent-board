export const retiredAgents: readonly ['gemini']
export const setupAgents: readonly ['codex', 'cursor', 'opencode', 'grok', 'muse', 'hermes', 'openclaw', 'antigravity', 'deepseek']
export const findOnPath: (commands: string[], extensions?: string[]) => string | undefined
export const discoverSetupAgents: (home: string, data: string, hostDirs: Partial<Record<string, string>>, isOwnHome: boolean) => (typeof setupAgents)[number][]
export const hasBoardPlugin: (directory: string) => boolean
export const isBoardPluginDisabled: (directory: string) => boolean
export const setupRecordChanges: (plan: { data: string; changes: { file: string }[] }, selected: readonly string[]) => string[]
