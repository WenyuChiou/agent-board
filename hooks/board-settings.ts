import type { Lang } from './i18n'

export type SettingsLang = Lang | 'auto'

export const isSettingsLang = (value: unknown): value is SettingsLang =>
  value === 'auto' || value === 'en' || value === 'zh-TW' || value === 'zh-CN'

export const settingsLangOf = (text: string | null): SettingsLang | null => {
  try {
    const data: unknown = JSON.parse(text ?? '')
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
    const lang = (data as Record<string, unknown>).lang
    return isSettingsLang(lang) ? lang : null
  } catch { return null }
}

// Automatic is an explicit choice to follow the system, including over a baked language.
export const boardLanguage = (flag: Lang | 'auto' | null, saved: SettingsLang | null, baked: Lang | null, system: Lang | null): Lang => {
  const picked = flag ?? saved ?? baked
  return picked === 'auto' || picked === null ? system ?? 'en' : picked
}

export const isLanguageOverridden = (flag: Lang | 'auto' | null, saved: SettingsLang | null, baked: Lang | null, system: Lang | null): boolean => {
  if (flag === null) return false
  const effectiveWithFlag = boardLanguage(flag, saved, baked, system)
  const effectiveWithoutFlag = boardLanguage(null, saved, baked, system)
  return effectiveWithFlag !== effectiveWithoutFlag
}

// Both page settings preserve unknown keys and refuse to replace a damaged JSON object.
export const withBoardSettings = (text: string | null, patch: Record<string, unknown>): string | null => {
  try {
    const data: unknown = text === null || text.trim() === '' ? {} : JSON.parse(text)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
    return `${JSON.stringify({ ...(data as Record<string, unknown>), ...patch }, null, 2)}\n`
  } catch { return null }
}
