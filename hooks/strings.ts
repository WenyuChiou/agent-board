import { LANGS, ZH_TW } from './i18n'
import type { Lang, Strings } from './i18n'
import { EN } from './strings-en'
import { ZH_CN } from './strings-zh-cn'

export const STRINGS: Record<Lang, Strings> = { en: EN, 'zh-TW': ZH_TW, 'zh-CN': ZH_CN }

// `zh-TW`, `zh_tw`, `繁體`, `Traditional Chinese` → zh-TW; `zh-CN`, `简体`, `Chinese` → zh-CN;
// `en`, `English` → en; anything else → null.
export const langOf = (value: unknown): Lang | null => {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (text === '') return null
  const exact = LANGS.find(one => one.toLowerCase() === text)
  if (exact !== undefined) return exact
  if (/(zh[-_]?(tw|hk|mo|hant))|繁|traditional|taiwan|台灣|臺灣|香港/.test(text)) return 'zh-TW'
  if (/(zh[-_]?(cn|sg|hans))|简|simplified|chinese|中文|^zh\b/.test(text)) return 'zh-CN'
  if (/^en\b|english|英文|英語|英语/.test(text)) return 'en'

  return null
}

// The language the person picked: the plugin's own setting (/config), else what
// `/progress lang` stored. Both are the same in every session on the machine.
export const chosenLang = (option: unknown, stored: unknown): Lang | null => (option === 'auto' ? null : langOf(option)) ?? langOf(stored)

// What the pane speaks, first answer wins: the language the person picked, Claude Code's
// `language` setting, the system's LANG, English.
export const resolveLang = (option: unknown, stored: unknown, setting: unknown, env: unknown): Lang =>
  chosenLang(option, stored) ?? langOf(setting) ?? langOf(env) ?? 'en'
