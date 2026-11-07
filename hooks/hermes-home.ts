// Where Hermes Agent keeps config.yaml, its skills and its hook trust file, chosen the way Hermes itself
// chooses (hermes_constants.py): HERMES_HOME, else %LOCALAPPDATA%\hermes on Windows, else ~/.hermes.
// Pure, so the board and the plugin's connector share it: they pass the platform and environment in.
// A --home that names another account's folder keeps to that folder, since the running account's
// LOCALAPPDATA belongs to the running account.
type HermesEnv = { HERMES_HOME?: string; LOCALAPPDATA?: string; USERPROFILE?: string; HOME?: string }

const sameFolder = (a: string, b: string): boolean => {
  const clean = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return clean(a) === clean(b)
}

export const hermesHome = (home: string, sep: string, env: HermesEnv, platform: string): string => {
  const named = env.HERMES_HOME?.trim()
  if (named) return named
  if (platform !== 'win32') return [home, '.hermes'].join(sep)
  const local = env.LOCALAPPDATA?.trim()
  const own = env.USERPROFILE ?? env.HOME
  return local && own !== undefined && sameFolder(own, home) ? [local, 'hermes'].join(sep) : [home, 'AppData', 'Local', 'hermes'].join(sep)
}
