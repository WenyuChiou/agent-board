import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

export const setupAgents = ['codex', 'cursor', 'opencode', 'gemini', 'grok', 'muse', 'hermes', 'openclaw', 'antigravity', 'deepseek']

export const findOnPath = (commands, extensions = ['.exe', '.cmd', '.bat', '.com', '.ps1']) => {
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path')
  const path = (pathKey ? process.env[pathKey] : '') || ''
  const filenames = process.platform === 'win32' ? commands.flatMap(command => extensions.map(extension => `${command}${extension}`)) : commands
  for (const entry of path.split(delimiter)) {
    const directory = process.platform === 'win32' ? entry.replace(/^"(.*)"$/, '$1') : entry
    if (!isAbsolute(directory)) continue
    for (const name of filenames) {
      const file = resolve(directory, name)
      try {
        const stat = statSync(file)
        if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) return file
      } catch {}
    }
  }
}

export const discoverSetupAgents = (home, data, hostDirs, isOwnHome) => {
  const signs = {
    codex: ['.codex'], cursor: ['.cursor'], opencode: ['.config/opencode'],
    gemini: ['.gemini/settings.json'], grok: ['.grok/config.toml', '.grok/sessions'], muse: ['.config/muse'],
    hermes: ['.hermes'], openclaw: ['.openclaw'], antigravity: ['.gemini/antigravity-cli', '.gemini/antigravity', '.gemini/antigravity-ide'], deepseek: ['.dsh'],
  }
  const commands = {
    codex: ['codex'], cursor: ['cursor-agent', 'cursor'], opencode: ['opencode'], gemini: ['gemini'],
    grok: ['grok'], muse: ['muse'], hermes: ['hermes'], openclaw: ['openclaw'], antigravity: ['agy', 'antigravity'], deepseek: ['dsh'],
  }
  const ownPrograms = { grok: join(home, '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok') }
  const apps = process.platform === 'win32'
    ? process.env.LOCALAPPDATA ? Object.fromEntries(Object.entries({ cursor: 'cursor', antigravity: 'Antigravity' }).map(([agent, folder]) => [agent, [join(process.env.LOCALAPPDATA, 'Programs', folder)]])) : {}
    : process.platform === 'darwin'
      ? Object.fromEntries(Object.entries({ codex: 'Codex', cursor: 'Cursor', antigravity: 'Antigravity' }).map(([agent, name]) => [agent, [join('/Applications', `${name}.app`), join(home, 'Applications', `${name}.app`)]]))
      : {}
  return setupAgents.filter(agent =>
    (hostDirs[agent] ? existsSync(hostDirs[agent]) : signs[agent].some(sign => existsSync(join(home, sign))))
    || existsSync(join(data, `install-${agent}.json`))
    || (ownPrograms[agent] !== undefined && existsSync(ownPrograms[agent]))
    || (isOwnHome && (findOnPath(commands[agent]) || apps[agent]?.some(app => existsSync(app)))),
  )
}

export const hasBoardPlugin = directory => {
  const plugin = 'agent-board@agent-board'
  const read = file => {
    try { return JSON.parse(readFileSync(join(directory, file), 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
  }
  const installed = read('plugins/installed_plugins.json')?.plugins?.[plugin]
  return Array.isArray(installed) ? installed.length > 0 : installed !== null && typeof installed === 'object'
}

export const setupRecordChanges = (plan, selected) => setupAgents.filter(other => !selected.includes(other)).map(other => join(plan.data, `install-${other}.json`)).filter(file => {
  try {
    const held = JSON.parse(readFileSync(file, 'utf8')).files ?? {}
    return plan.changes.some(change => Object.hasOwn(held, change.file))
  } catch { return false }
})
