import { AGENT_ICONS } from './agent-icons'
import type { Strings } from './i18n'
import { FONT_LICENSE, FONT_REGULAR, FONT_SEMIBOLD } from './page-fonts'
import { DARK, LIGHT, PAGE_DARK, PAGE_LIGHT } from './palette'

const cssVars = (values: Record<string, string>): string => Object.entries(values).map(([key, value]) => `--${key}:${value}`).join(';')

// A Simplified Chinese page reads its Chinese in the SC UI fonts first: the shared characters otherwise take
// Traditional glyph shapes on a Mac or Windows machine. The rest of the stack is unchanged, so every face
// stays available for any language.
const SANS_SC = 'Inter,"PingFang SC","Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei","PingFang TC","Noto Sans TC","Microsoft JhengHei UI","Microsoft JhengHei","Hiragino Sans",system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif'

export const pageTokens = (headHeight = '54px'): string => {
  const shared = {
    // Latin text is Inter, embedded below (the owner found Atkinson beside the system's CJK font a poor pair, 11-06).
    // Chinese uses each system's own UI sans: PingFang on a Mac, Noto Sans TC where installed, else Microsoft
    // JhengHei UI on Windows. A CJK web font would be megabytes, so none is embedded.
    'font-sans': 'Inter,"PingFang TC","Noto Sans TC","Microsoft JhengHei UI","Microsoft JhengHei","Hiragino Sans","PingFang SC","Noto Sans SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif',
    'font-mono': 'ui-monospace,"SF Mono","Cascadia Mono","Segoe UI Mono",Menlo,Consolas,"Liberation Mono",monospace',
    // Nothing on the page is smaller than 13px, and each size grows with the reader's own font size (max of the
    // floor and a rem value). xs (13) is the floor: ages, counts, small labels. sm (14) is body, buttons, meta
    // lines, steps and inputs. md (16) is row titles, shelf heads and the brand. lg (20; 18 on a phone, below)
    // is the card question, section headings and the empty-page heading. The owner asked for a smaller page
    // (11-06), so the scale is one step below the 14/16/18/22 it had. Line height is 1.5 up to 16px and 1.4
    // above; headings differ from row titles by size and space, not by weight.
    'text-xs': 'max(13px,.8125rem)', 'text-sm': 'max(14px,.875rem)', 'text-md': 'max(16px,1rem)', 'text-lg': 'max(20px,1.25rem)',
    'radius-s': '6px', 'radius-m': '10px', 'radius-round': '999px',
    // Spacing on a 4px scale; a control is at least 36px tall (44px under a coarse pointer, in the page's CSS).
    's1': '4px', 's2': '8px', 's3': '12px', 's4': '16px', 's5': '24px', 's6': '32px', 's7': '48px', 'hit': '36px',
    // Motion: hover and press 120ms, small things appearing or leaving 200ms, expanding, collapsing and moving
    // 260ms, a task that just arrived fades its highlight over 1.6s, the sending dots loop in 1.2s, a theme
    // pick fades colours only. Entering eases out; leaving eases in and is quicker.
    'dur-fast': '120ms', 'dur-base': '200ms', 'dur-layout': '260ms', 'dur-glow': '1.6s', 'dur-dots': '1.2s', 'dur-theme': '.28s',
    'ease-out': 'cubic-bezier(.2,0,0,1)', 'ease-in': 'cubic-bezier(.4,0,1,1)',
    // Hover, the open row and a press are the ink at 5%, 8% and 12% over whatever is underneath.
    'hover': 'color-mix(in srgb,var(--ink) 5%,transparent)', 'current': 'color-mix(in srgb,var(--ink) 8%,transparent)', 'press': 'color-mix(in srgb,var(--ink) 12%,transparent)',
    // Colour roles. Everything you press is ink, so the only colours on the page carry news: amber needs you, green is alive, red is wrong.
    'act': 'var(--ink)', 'on-act': 'var(--surface)', 'alive': 'var(--done)',
    // The progress bar's done and current cells (#1085) in the default Ink style: the ink at 60 % and full ink.
    // The page's `data-bar` picks Blue or Green over them.
    'bar-done': 'color-mix(in srgb,var(--ink) 60%,var(--surface))', 'bar-now': 'var(--ink)',
    'btn-line': 'color-mix(in srgb,var(--ink) 55%,var(--surface))',
    'ring': '0 0 0 3px color-mix(in srgb,var(--ink) 18%,transparent)',
    'head-h': headHeight,
    ...Object.fromEntries(AGENT_ICONS.map(icon => [`ag-${icon.file}`, icon.tile])),
  }
  const dark = `${cssVars(DARK)};${cssVars(PAGE_DARK)};color-scheme:dark`
  return `:root{${cssVars(LIGHT)};${cssVars(PAGE_LIGHT)};${cssVars(shared)};color-scheme:light}
:root:lang(zh-Hans){--font-sans:${SANS_SC}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark}}}
:root[data-theme="dark"]{${dark}}
@media (max-width:640px){:root{--text-lg:max(18px,1.125rem)}}`
}

// The browser's theme is applied before paint; Settings delegates its presses after parsing.
export const themeHead = String.raw`
(() => {
  var root = document.documentElement;
  // No saved pick: the page follows the system, and shows which of the two it is following.
  var choice = '';
  var timer;
  var saved = '';
  // The live page starts on a new port each time, so its storage starts empty there; a cookie
  // is shared across ports and keeps the pick.
  try {
    var kept = /(?:^|;\s*)agent-board\.theme=(light|dark)(?:;|$)/.exec(document.cookie || '');
    if (kept) saved = kept[1];
  } catch (e) {}
  if (!saved) {
    try { saved = localStorage.getItem('agent-board.theme'); } catch (e) {}
  }
  if (saved === 'light' || saved === 'dark') choice = saved;
  var scheme = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function each(selector, run) { try { Array.prototype.forEach.call(document.querySelectorAll(selector) || [], run); } catch (e) {} }
  function apply() {
    if (choice) root.setAttribute('data-theme', choice);
    else root.removeAttribute('data-theme');
    var shown = choice || (scheme && scheme.matches ? 'dark' : 'light');
    each('[data-settings-toggle]', function (button) { button.setAttribute('data-now', shown); });
    each('[data-theme-set]', function (item) { item.setAttribute('aria-checked', String(item.getAttribute('data-theme-set') === (choice || 'system'))); });
  }
  function pick(next) {
    choice = next === 'system' ? '' : next;
    // Blocked storage only means the pick is not kept: this page still shows it.
    try { if (choice) localStorage.setItem('agent-board.theme', choice); else localStorage.removeItem('agent-board.theme'); } catch (e) {}
    try { document.cookie = 'agent-board.theme=' + (choice || 'system') + '; Path=/; SameSite=Strict; Max-Age=' + (choice ? 365 * 24 * 3600 : 0); } catch (e) {}
    root.classList.add('theming');
    clearTimeout(timer);
    apply();
    timer = setTimeout(() => { root.classList.remove('theming'); }, 300);
  }
  apply();
  try { if (scheme && scheme.addEventListener) scheme.addEventListener('change', apply); } catch (e) {}
  document.addEventListener('DOMContentLoaded', apply);
  document.addEventListener('click', function (event) {
    var node = event.target;
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute('data-theme-set') !== null) {
        pick(node.getAttribute('data-theme-set'));
        return;
      }
      node = node.parentNode;
    }
  });
})();
`

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

// Settings keeps the existing theme and shared progress-bar choices together.
const SWATCH = '<span class="sw" aria-hidden="true"><i class="c-x"></i><i class="c-x"></i><i class="c-c"></i><i class="c-t"></i></span>'
export const themeControls = (s: Strings): string =>
  `<div class="settings-choices" role="radiogroup" aria-label="${esc(s.themeMenu)}">` +
  (['light', 'dark', 'system'] as const).map(theme => `<button type="button" role="radio" aria-checked="false" data-local data-theme-set="${theme}" data-changed="${esc(s.settingsChanged(s.themeMenu, theme === 'light' ? s.themeLight : theme === 'dark' ? s.themeDark : s.settingsAutomatic))}">${esc(theme === 'light' ? s.themeLight : theme === 'dark' ? s.themeDark : s.settingsAutomatic)}</button>`).join('') +
  `</div><p class="settings-label">${esc(s.barStyleHead)}</p><div class="settings-choices" role="radiogroup" aria-label="${esc(s.barStyleHead)}">` +
  (['ink', 'blue', 'green'] as const).map(style => `<button type="button" role="radio" aria-checked="${style === 'ink'}" data-local data-bar-set="${style}" data-sw="${style}">${SWATCH}${esc(style === 'blue' ? s.barStyleBlue : style === 'green' ? s.barStyleGreen : s.barStyleInk)}</button>`).join('') +
  `</div>`

// The page footer's two pictures, drawn in a 16 by 16 box: GitHub's mark for the link to the
// project, and a power sign for Close the board. They stand in for words, so each is one people know.
export const GITHUB_PATH = 'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z'
export const POWER_PATH = 'M8 1.5v6M4.46 4.29a5.5 5.5 0 1 0 7.08 0'

// The Corner Light, the board's mark: a board with a light in its top right corner, on a 64 grid. Beside the
// name it shows the board's status (ink, breathing, amber or grey); docs/preview/brand.ts draws the same name
// large for the README.
export const BOARD_PATH = 'M31.04 8H20A12 12 0 0 0 8 20V44A12 12 0 0 0 20 56H44A12 12 0 0 0 56 44V32.96A1 1 0 0 0 54.35 32.2A16 16 0 0 1 31.8 9.65A1 1 0 0 0 31.04 8Z'
export const CORNER_LIGHT = { cx: 44, cy: 20, r: 12 }

// "Agent Board" in Inter SemiBold (SIL OFL 1.1) outlined to paths, so the page needs no font for it: 100 units
// from the baseline to the top of a capital, with the light between the two words. This is the small cut,
// tuned to read at a 13 px capital height.
const NAME_PATH = 'm 0 0 l 34.9 -100 l 22.8 0 l 35.7 100 l -19.7 0 l -17.8 -51.9 q -2.6 -8.1 -5.4 -18.3 q -2.8 -10.1 -6.3 -23.1 l 3.8 0 q -3.4 13.1 -6.1 23.3 q -2.7 10.3 -5.1 18.1 l -17.2 51.9 l -19.6 0 z m 20.3 -24.8 l 0 -14.4 l 52.7 0 l 0 14.4 l -52.7 0 z m 115.3 54.5 q -9 0 -15.6 -2.3 q -6.7 -2.3 -11 -6.2 q -4.2 -4 -6.1 -8.9 l 14.8 -5.3 q 1.2 2.1 3.3 4.3 q 2.1 2.2 5.6 3.6 q 3.5 1.5 9 1.5 q 8.1 0 13 -3.8 q 4.9 -3.8 4.9 -11.9 l 0 -14.1 l -1.5 0 q -1.3 2.7 -3.7 5.5 q -2.5 2.9 -6.7 4.8 q -4.2 2 -10.7 2 q -8.6 0 -15.6 -4.1 q -7 -4.1 -11.2 -12.2 q -4.1 -8.1 -4.1 -20.3 q 0 -12.4 4.2 -20.9 q 4.1 -8.5 11.1 -12.9 q 7 -4.5 15.7 -4.5 q 11.1 0 20.1 4.5 q 9 4.4 14.3 12.9 q 5.3 8.5 5.3 20.9 l 0 37.9 q 0 10 -4.5 16.5 q -4.6 6.6 -12.5 9.8 q -7.9 3.2 -18.1 3.2 z m 0.2 -44.6 q 5.7 0 9.6 -2.7 q 4 -2.7 6.1 -7.9 q 2.1 -5.2 2.1 -12.4 q 0 -7.1 -2.1 -12.4 q -2 -5.3 -6 -8.3 q -4 -3 -9.7 -3 q -5.9 0 -9.9 3.1 q -4 3.1 -6 8.5 q -2 5.3 -2 12.1 q 0 7 2 12.1 q 2 5.2 6 8 q 4 2.9 9.9 2.9 z m 86.1 16.4 q -11.4 0 -19.5 -4.7 q -8.2 -4.8 -12.6 -13.4 q -4.4 -8.7 -4.4 -20.4 q 0 -11.7 4.4 -20.4 q 4.3 -8.7 12.2 -13.6 q 8 -5 18.7 -5 q 6.9 0 13.1 2.2 q 6.2 2.3 11 6.9 q 4.8 4.6 7.5 11.8 q 2.7 7.1 2.7 17 l 0 5.5 l -61.3 0 l 0 -11.9 l 52.7 0 l -8.2 3.5 q 0 -6.3 -2 -11.1 q -1.9 -4.8 -5.8 -7.5 q -3.8 -2.7 -9.6 -2.7 q -5.8 0 -9.8 2.7 q -4 2.8 -6.1 7.3 q -2.1 4.5 -2.1 10.1 l 0 8.2 q 0 7.1 2.4 12 q 2.4 4.9 6.7 7.4 q 4.4 2.5 10.2 2.5 q 3.8 0 6.9 -1.2 q 3.1 -1.1 5.4 -3.2 q 2.3 -2.2 3.5 -5.4 l 16 3.3 q -1.8 6 -6.2 10.6 q -4.3 4.5 -10.9 7 q -6.5 2.5 -14.9 2.5 z m 65 -45.5 l 0 44 l -17.4 0 l 0 -75 l 16.5 0 l 0.2 18.5 l -1.4 0 q 3.2 -9.7 9.3 -14.6 q 6.1 -4.9 15.3 -4.9 q 7.7 0 13.5 3.3 q 5.8 3.3 8.9 9.6 q 3.2 6.3 3.2 15.4 l 0 47.7 l -17.4 0 l 0 -45 q 0 -7.6 -3.9 -11.8 q -3.9 -4.3 -10.7 -4.3 q -4.7 0 -8.3 2 q -3.6 2 -5.7 5.8 q -2.1 3.9 -2.1 9.3 z m 100.8 -31 l 0 13.7 l -39.9 0 l 0 -13.7 l 39.9 0 z m -31.9 -17.9 l 17.4 0 l 0 71.8 q 0 4.1 1.8 6 q 1.7 1.9 5.7 1.9 q 1.2 0 3.2 -0.3 q 1.9 -0.3 3.6 -0.2 l 0 13.8 q -2.7 0.8 -4.6 0.9 q -2 0 -4.8 0 q -10.8 0 -16.6 -5.4 q -5.7 -5.3 -5.7 -15.3 l 0 -73.2 z m 98.4 92.9 l 0 -100 l 38.2 0 q 10.8 0 18 3.4 q 7.2 3.4 10.7 9.3 q 3.6 5.8 3.6 13.3 q 0 6.1 -2.4 10.4 q -2.3 4.3 -6.2 7 q -4 2.7 -8.9 3.8 l 0 1.1 q 5.4 0.2 10.2 3.2 q 4.9 2.9 8.1 8.3 q 3.1 5.4 3.1 13 q 0 7.7 -3.8 13.9 q -3.7 6.2 -11.3 9.7 q -7.5 3.6 -19 3.6 l -40.3 0 z m 17.9 -15 l 19.6 0 q 9.9 0 14.3 -3.8 q 4.4 -3.8 4.4 -9.8 q 0 -4.5 -2.2 -8.1 q -2.2 -3.6 -6.3 -5.6 q -4 -2.1 -9.6 -2.1 l -20.2 0 l 0 29.4 z m 0 -42.4 l 18 0 q 4.8 0 8.6 -1.7 q 3.7 -1.8 5.9 -5 q 2.2 -3.2 2.2 -7.6 q 0 -5.9 -4.1 -9.6 q -4.1 -3.8 -12.2 -3.8 l -18.4 0 l 0 27.7 z m 103.9 58.9 q -11 0 -19 -4.8 q -8.1 -4.9 -12.5 -13.6 q -4.4 -8.7 -4.4 -20.2 q 0 -11.7 4.4 -20.5 q 4.4 -8.7 12.5 -13.5 q 8 -4.9 19 -4.9 q 11 0 19 4.9 q 8.1 4.8 12.5 13.5 q 4.4 8.8 4.4 20.5 q 0 11.5 -4.4 20.2 q -4.4 8.7 -12.5 13.6 q -8 4.8 -19 4.8 z m 0 -14.1 q 6.1 0 10.1 -3.3 q 4.1 -3.3 6.1 -8.9 q 2 -5.5 2 -12.4 q 0 -6.9 -2 -12.5 q -2 -5.5 -6.1 -8.8 q -4 -3.3 -10.1 -3.3 q -6.1 0 -10.1 3.3 q -4 3.3 -6 8.8 q -2 5.5 -2 12.5 q 0 6.9 2 12.4 q 2 5.6 6 8.9 q 4 3.3 10.1 3.3 z m 72.9 14.1 q -7.2 0 -12.9 -2.5 q -5.7 -2.6 -9 -7.7 q -3.2 -5 -3.2 -12.4 q 0 -6.3 2.3 -10.5 q 2.4 -4.2 6.5 -6.7 q 4 -2.4 9.1 -3.7 q 5.1 -1.3 10.6 -1.8 q 6.6 -0.8 10.7 -1.3 q 4 -0.5 6 -1.7 q 1.9 -1.3 1.9 -3.8 l 0 -0.3 q 0 -3.7 -1.5 -6.3 q -1.5 -2.6 -4.4 -4 q -2.9 -1.4 -7.2 -1.4 q -4.4 0 -7.6 1.4 q -3.2 1.3 -5.2 3.5 q -2 2.1 -2.9 4.6 l -16.2 -3.3 q 2.2 -6.6 6.9 -10.9 q 4.6 -4.4 11 -6.5 q 6.4 -2.2 13.9 -2.2 q 5.3 0 10.7 1.3 q 5.4 1.2 9.9 4.2 q 4.5 2.9 7.3 7.9 q 2.7 4.9 2.7 12.5 l 0 29 q 0 7.4 -5.2 12.4 q -5.2 5.1 -14.1 7.7 q -9 2.5 -20.1 2.5 z m 4.5 -12.9 q 5.4 0 9.3 -2.2 q 3.9 -2.1 6.1 -5.6 q 2.2 -3.6 2.2 -7.7 l 0 -8.9 q -0.9 0.7 -2.9 1.3 q -2.1 0.6 -4.6 1.1 q -2.5 0.4 -4.9 0.8 q -2.5 0.3 -4.2 0.5 q -3.9 0.6 -7 1.8 q -3.2 1.2 -5 3.4 q -1.7 2.1 -1.7 5.6 q 0 3.2 1.6 5.4 q 1.7 2.2 4.5 3.3 q 2.9 1.2 6.6 1.2 z m 52.9 11.4 l 0 -75 l 16.9 0 l 0 12.5 l 0.8 0 q 2 -6.5 7.1 -10 q 5 -3.5 11.5 -3.5 q 1.4 0 3.2 0.1 q 1.9 0.1 3.1 0.3 l 0 16.1 q -1 -0.4 -3.5 -0.6 q -2.4 -0.3 -4.7 -0.3 q -4.9 0 -8.7 2.1 q -3.9 2.1 -6.1 5.7 q -2.1 3.7 -2.1 8.4 l 0 44.2 l -17.5 0 z m 78.7 1.3 q -8.9 0 -15.9 -4.5 q -7 -4.5 -11 -13.2 q -4.1 -8.6 -4.1 -21 q 0 -12.5 4.2 -21.1 q 4.1 -8.6 11.1 -13 q 7 -4.5 15.6 -4.5 q 6.7 0 11 2.3 q 4.2 2.2 6.8 5.3 q 2.5 3.1 3.7 5.8 l 0.8 0 l 0 -37.4 l 17.4 0 l 0 62.6 q 0 12.4 -5.1 21 q -5.2 8.7 -14.2 13.2 q -9 4.5 -20.3 4.5 z m 4.7 -14.3 q 5.7 0 9.7 -3.1 q 4 -3 6 -8.5 q 2.1 -5.5 2.1 -12.8 q 0 -7.4 -2 -12.8 q -2.1 -5.4 -6.1 -8.4 q -4 -3 -9.7 -3 q -5.9 0 -9.8 3.1 q -4 3.1 -6 8.6 q -2 5.5 -2 12.5 q 0 6.9 2 12.5 q 2 5.5 6 8.7 q 4 3.2 9.8 3.2 z'
const NAME_LIGHT = { cx: 420.94, cy: -40.27, r: 16.44 }

// The logo's and the icon's states are a class on the picture: is-idle, is-working, is-waiting, is-offline.
// Everything is scoped to .ab-logo and .ab-icon; the keyframes are named ab-l-* and ab-i-*. The page's own
// stylesheet carries this, so the pictures stay free of a style element the page's policy would need a nonce for.
export const LOGO_STATES = ['is-idle', 'is-working', 'is-waiting', 'is-offline'] as const
export const LOGO_CSS = `.ab-logo{overflow:visible}.ab-logo .ab-name{fill:var(--ink);transition:opacity .45s cubic-bezier(.45,0,.55,1)}.ab-logo .ab-light{fill:var(--ink);transition:fill .45s cubic-bezier(.45,0,.55,1)}.ab-logo .ab-halo{fill:var(--brand);opacity:0}.ab-logo .ab-light,.ab-logo .ab-halo,.ab-logo .ab-hit{transform-box:fill-box;transform-origin:center}.ab-logo .ab-hit{transition:transform .3s cubic-bezier(.2,.7,.2,1)}.ab-logo:hover .ab-hit{transform:scale(1.14)}.ab-logo:active .ab-hit{transform:scale(.88)}.ab-logo.is-working .ab-light{animation:ab-l-breathe 2.4s cubic-bezier(.45,0,.55,1) infinite}@keyframes ab-l-breathe{0%,100%{transform:scale(1)}50%{transform:scale(.78)}}.ab-logo.is-waiting .ab-light{fill:var(--brand);animation:ab-l-turn 1.2s cubic-bezier(.45,0,.55,1) 1}.ab-logo.is-waiting .ab-halo{animation:ab-l-flash 1.6s cubic-bezier(.1,.6,.3,1) 1,ab-l-glow 4.8s cubic-bezier(.45,0,.55,1) 1.6s infinite}@keyframes ab-l-turn{0%{transform:scale(.86)}40%{transform:scale(1.18)}100%{transform:scale(1)}}@keyframes ab-l-flash{0%{opacity:.6;transform:scale(1)}100%{opacity:0;transform:scale(1.9)}}@keyframes ab-l-glow{0%,100%{opacity:0;transform:scale(1.05)}50%{opacity:.3;transform:scale(1.6)}}.ab-logo.is-offline .ab-name{opacity:.55}.ab-logo.is-offline .ab-light{fill:var(--muted)}@media (prefers-reduced-motion:reduce){.ab-logo *{animation:none!important;transition:none!important}.ab-logo.is-working .ab-light{transform:scale(.8)}.ab-logo.is-waiting .ab-halo{opacity:.28;transform:scale(1.5)}}`
export const ICON_CSS = `.ab-icon{overflow:visible}.ab-icon .ab-board{fill:var(--ink);transition:opacity .45s cubic-bezier(.45,0,.55,1)}.ab-icon .ab-dot{fill:var(--ink);transition:fill .45s cubic-bezier(.45,0,.55,1)}.ab-icon .ab-halo{fill:var(--brand);opacity:0}.ab-icon .ab-dot,.ab-icon .ab-halo,.ab-icon .ab-hd{transform-box:view-box;transform-origin:44px 20px}.ab-icon .ab-hb{transform-box:view-box;transform-origin:32px 32px}.ab-icon .ab-hb,.ab-icon .ab-hd{transition:transform .3s cubic-bezier(.2,.7,.2,1)}.ab-icon:hover .ab-hd{transform:scale(1.08)}.ab-icon:active .ab-hd{transform:scale(.9)}.ab-icon:active .ab-hb{transform:scale(.96)}.ab-icon.is-working .ab-dot{animation:ab-i-breathe 2.4s cubic-bezier(.45,0,.55,1) infinite}@keyframes ab-i-breathe{0%,100%{transform:scale(1)}50%{transform:scale(.8)}}.ab-icon.is-waiting .ab-dot{fill:var(--brand);animation:ab-i-turn 1.2s cubic-bezier(.45,0,.55,1) 1}.ab-icon.is-waiting .ab-halo{animation:ab-i-flash 1.6s cubic-bezier(.1,.6,.3,1) 1,ab-i-glow 4.8s cubic-bezier(.45,0,.55,1) 1.6s infinite}@keyframes ab-i-turn{0%{transform:scale(.86)}40%{transform:scale(1.12)}100%{transform:scale(1)}}@keyframes ab-i-flash{0%{opacity:.6;transform:scale(1)}100%{opacity:0;transform:scale(2.1)}}@keyframes ab-i-glow{0%,100%{opacity:0;transform:scale(1.05)}50%{opacity:.22;transform:scale(1.45)}}.ab-icon.is-offline .ab-board{fill:none;stroke:var(--ink);stroke-width:3;opacity:.6}.ab-icon.is-offline .ab-dot{fill:none;stroke:var(--muted);stroke-width:3}@media (prefers-reduced-motion:reduce){.ab-icon *{animation:none!important;transition:none!important}.ab-icon.is-working .ab-dot{transform:scale(.84)}.ab-icon.is-waiting .ab-halo{opacity:.2;transform:scale(1.4)}}.ab-icon.is-arriving .ab-board{animation:ab-i-arrive-b .5s cubic-bezier(.2,0,0,1) both}.ab-icon.is-arriving .ab-dot{animation:ab-i-arrive-d .7s cubic-bezier(.3,1.6,.5,1) .45s both}@keyframes ab-i-arrive-b{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:none}}@keyframes ab-i-arrive-d{from{transform:scale(0)}to{transform:scale(1)}}@media (prefers-reduced-motion:reduce){.ab-icon.is-arriving *{animation:none!important}}`

// `hint` is the tooltip, already escaped. A picture beside the page's own heading is decoration (`isDecorative`).
const named = (isDecorative: boolean): string => (isDecorative ? 'aria-hidden="true"' : 'role="img" aria-label="Agent Board"')
const tip = (hint: string): string => (hint ? `<title>${hint}</title>` : '')
export const boardLogo = (hint: string): string =>
  `<svg class="ab-logo is-idle" width="108" height="18" viewBox="-3 -103 830.63 135.66" ${named(false)}>${tip(hint)}<circle class="ab-halo" cx="${NAME_LIGHT.cx}" cy="${NAME_LIGHT.cy}" r="${NAME_LIGHT.r}"/><path class="ab-name" d="${NAME_PATH}"/><g class="ab-hit"><circle class="ab-light" cx="${NAME_LIGHT.cx}" cy="${NAME_LIGHT.cy}" r="${NAME_LIGHT.r}"/></g></svg>`
export const boardIcon = (size: number, hint = '', isDecorative = false, extra = ''): string =>
  `<svg class="ab-icon is-idle${extra}" width="${size}" height="${size}" viewBox="0 0 64 64" ${named(isDecorative)}>${tip(hint)}<circle class="ab-halo" cx="${CORNER_LIGHT.cx}" cy="${CORNER_LIGHT.cy}" r="${CORNER_LIGHT.r}"/><g class="ab-hb"><path class="ab-board" d="${BOARD_PATH}"/></g><g class="ab-hd"><circle class="ab-dot" cx="${CORNER_LIGHT.cx}" cy="${CORNER_LIGHT.cy}" r="${CORNER_LIGHT.r}"/></g></svg>`

// RGB notation keeps encoded hex colours from resembling private session ids.
const rgb = (hex: string): string => `rgb(${(hex.slice(1).match(/../g) ?? []).map(channel => parseInt(channel, 16)).join(',')})`

// The tab icon: the Corner Light in ink while all is calm, its light amber while something needs the person.
// The page swaps between the two (the link's data-needs holds the second).
const faviconSvg = (isLit: boolean): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>.b{fill:${rgb(PAGE_LIGHT.ink)}}.d{fill:${rgb(isLit ? PAGE_LIGHT.brand : PAGE_LIGHT.ink)}}@media (prefers-color-scheme:dark){.b{fill:${rgb(PAGE_DARK.ink)}}.d{fill:${rgb(isLit ? PAGE_DARK.brand : PAGE_DARK.ink)}}}</style><path class="b" d="${BOARD_PATH}"/><circle class="d" cx="${CORNER_LIGHT.cx}" cy="${CORNER_LIGHT.cy}" r="${CORNER_LIGHT.r}"/></svg>`
const faviconHref = (isLit: boolean): string => `data:image/svg+xml,${encodeURIComponent(faviconSvg(isLit))}`

export const faviconLink = `<link rel="icon" type="image/svg+xml" href="${faviconHref(false)}" data-needs="${faviconHref(true)}">`

// A person for the tasks you keep by hand; mid grey so it reads on both themes' tiles. The grey is
// written as rgb() because "#8a8d86" encodes to "%238a8d86", which the privacy checks read as an id.
const OWN_MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="rgb(138,141,134)" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="5.6" r="2.6"/><path d="M3 13.8c.6-2.5 2.6-3.8 5-3.8s4.4 1.3 5 3.8"/></svg>'

// A space after each arc or curve command keeps a run such as "013a2093" out of the page, where
// the privacy checks would read it as an id; the path draws the same.
const spaced = (path: string): string => path.replace(/([AaCc])(?=\d)/g, '$1 ')

export const agentMarkCss = (): string =>
  '.ag{width:24px;height:24px;border-radius:var(--radius-s);display:inline-grid;place-items:center;flex:none;background:var(--muted);color:var(--on-accent);font:600 var(--text-xs)/1 var(--font-sans);vertical-align:middle}.ag-other{background:var(--inset);color:var(--muted)}' +
    `.ag-own{background:var(--inset) url("data:image/svg+xml,${encodeURIComponent(OWN_MARK)}") center/76% 76% no-repeat;outline:1px solid var(--line-strong);outline-offset:-1px}` + AGENT_ICONS.map(icon => {
    // A hex color gains "23" in a data URL, which can resemble an eight-hex id.
    const channels = icon.ink?.match(/^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i)
    const ink = channels ? `rgb(${channels.slice(1).map(channel => parseInt(channel, 16)).join(',')})` : icon.ink ?? 'white'
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${icon.viewBox ?? '0 0 24 24'}" fill="${ink}"${icon.isEvenOdd ? ' fill-rule="evenodd"' : ''}>${(icon.paths ?? []).map(path => `<path d="${spaced(path)}"/>`).join('')}</svg>`
    return `.ag-${icon.file}{background:var(--ag-${icon.file})${icon.paths ? ` url("data:image/svg+xml,${encodeURIComponent(svg)}") center/76% 76% no-repeat` : ''}}` + (icon.letter && !icon.paths ? `.ag-${icon.file}::before{content:"${icon.letter}"}` : '')
  }).join('')

// Native short names and complete product slugs identify the same agent.
export const AGENT_ALIASES: Record<string, string> = Object.fromEntries(AGENT_ICONS.flatMap(icon => [[icon.file.split('-')[0] ?? icon.file, icon.file], [icon.file, icon.file]]))

// The model gives Claude Code's blocks and hand-kept tasks the agent ''; `isOwn` marks the
// hand-kept ones, the person's own.
export const agentMark = (agent: string, isOwn = false): string => {
  const first = isOwn ? '' : agent.toLowerCase().split(/\s+/)[0] || 'claude'
  const file = Object.prototype.hasOwnProperty.call(AGENT_ALIASES, first) ? AGENT_ALIASES[first] : undefined
  return `<span class="ag ag-${file ?? (first ? 'other' : 'own')}" aria-hidden="true">${file ? '' : esc((Array.from(first)[0] ?? '').toUpperCase())}</span>`
}

// The one motion primitive: a block opens and closes by its grid row track (1fr to 0fr) and opacity, so
// the blocks beside it follow its height. `.fx` is a block that can leave (`.gone`); `.fold` is one
// that opens on its parent's `.open`. With reduced motion every transition and animation is off, so
// each change lands at once and every state sentence is still on the page.
export const motionCss = `
.fx{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows var(--dur-layout) var(--ease-out),opacity var(--dur-base) var(--ease-out)}
.fx>.fx-in{min-height:0;overflow:hidden}
.fx.gone{grid-template-rows:0fr;opacity:0;transition-duration:var(--dur-base),var(--dur-fast);transition-timing-function:var(--ease-in)}
.fold{display:grid;grid-template-rows:0fr;transition:grid-template-rows var(--dur-layout) var(--ease-out)}
.fold>.fold-in{min-height:0;overflow:hidden}
.open>.fold,.open>.fx>.fx-in>.fold{grid-template-rows:1fr}
@keyframes glow{from{background:var(--current)}to{background:transparent}}
@keyframes dot{0%,100%{opacity:.25}50%{opacity:1}}
/* switching a view: the new content rises 6px and fades in; nothing else moves */
@keyframes enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.enter{animation:enter var(--dur-layout) var(--ease-out)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}.dots i{opacity:.7}}
`

// The agent filter is kept the way the theme is: in a cookie, which every port of the live page shares,
// and in storage for a page that is a file. The reader and writer are text for the page's own script.
export const filterStore = String.raw`
  function savedFilter() {
    var kept = '';
    try { var found = /(?:^|;\s*)agent-board\.filter=([a-z0-9-]+)(?:;|$)/.exec(document.cookie || ''); if (found) kept = found[1]; } catch (e) {}
    if (!kept) { try { kept = localStorage.getItem('agent-board.filter') || ''; } catch (e) {} }
    return kept;
  }
  function saveFilter(agent) {
    try { if (agent) localStorage.setItem('agent-board.filter', agent); else localStorage.removeItem('agent-board.filter'); } catch (e) {}
    try { document.cookie = 'agent-board.filter=' + agent + '; Path=/; SameSite=Strict; Max-Age=' + (agent ? 365 * 24 * 3600 : 0); } catch (e) {}
  }
`

// The row of agent icons never wraps: when it is full it scrolls sideways, and the edge that has more fades.
// Returns the function that works that out again (after a redraw or a press); for the page's own script.
export const agentFade = String.raw`
  function agentFade(row) {
    if (!row) return function () {};
    function sync() {
      var tail = row.scrollWidth - row.clientWidth - row.scrollLeft > 2;
      var head = row.scrollLeft > 2;
      var next = String(row.className || '').replace(/\s*\bmore-(?:left|right)\b/g, '') + (head ? ' more-left' : '') + (tail ? ' more-right' : '');
      if (next !== row.className) row.className = next;
    }
    if (typeof row.addEventListener === 'function') row.addEventListener('scroll', sync);
    if (typeof window.addEventListener === 'function') window.addEventListener('resize', sync);
    return sync;
  }
`

export const pageBaseCss = `
@font-face{font-family:Inter;src:url(data:font/woff2;base64,${FONT_REGULAR}) format('woff2');font-weight:400;font-display:swap;/* ${FONT_LICENSE} */}
@font-face{font-family:Inter;src:url(data:font/woff2;base64,${FONT_SEMIBOLD}) format('woff2');font-weight:600;font-display:swap}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--ground)}
body{margin:0;background:var(--ground);color:var(--ink);font:var(--text-sm)/1.5 var(--font-sans);-webkit-font-smoothing:antialiased}
[hidden]{display:none!important}
button{font:inherit;color:inherit}
svg.i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.wide{max-width:1180px;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.head{display:block;position:sticky;top:0;z-index:6;background:var(--ground);border-bottom:1px solid var(--line)}
.topbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px 12px;padding-block:10px}.topbar>.seg{margin-left:auto}
.brand{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 auto}
.brand h1{margin:0;font-size:var(--text-md);line-height:1.4;font-weight:650}
.icon-btn{display:inline-grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:var(--radius-m);background:transparent;color:var(--muted);cursor:pointer;transition:background-color var(--dur-fast) var(--ease-out),color var(--dur-fast) var(--ease-out)}
.icon-btn:hover{background:var(--hover);color:var(--ink)}
.icon-btn:active{background:var(--press)}
@media (pointer:coarse){.icon-btn{width:44px;height:44px}}
.quiet,.meta{color:var(--muted)}
button:hover,.btn:hover,summary:hover{background-color:var(--hover)}
@media (prefers-reduced-motion:no-preference){.theming,.theming *,.theming *::before,.theming *::after{transition:background-color var(--dur-theme) ease,border-color var(--dur-theme) ease,color var(--dur-theme) ease,fill var(--dur-theme) ease,box-shadow var(--dur-theme) ease!important}}
@media (max-width:600px){.brand h1{font-size:var(--text-md)}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
`

// The row of agent icons, used by the live page.
export const agentRowCss = `
.agents{position:sticky;top:var(--head-h,56px);z-index:4;background:var(--ground);border-bottom:1px solid var(--line)}
.agents-in{display:flex;gap:var(--s2);overflow-x:auto;scrollbar-width:none;scroll-snap-type:x proximity;padding-top:var(--s2);padding-bottom:var(--s2)}
.agents-in::-webkit-scrollbar{display:none}
/* When the icons do not fit the row scrolls sideways and the edge that has more fades, so the last icon shows partly; it never wraps. */
.agents-in.more-right{-webkit-mask-image:linear-gradient(to right,var(--ink) calc(100% - 28px),transparent);mask-image:linear-gradient(to right,var(--ink) calc(100% - 28px),transparent)}
.agents-in.more-left{-webkit-mask-image:linear-gradient(to left,var(--ink) calc(100% - 28px),transparent);mask-image:linear-gradient(to left,var(--ink) calc(100% - 28px),transparent)}
.agents-in.more-left.more-right{-webkit-mask-image:linear-gradient(to right,transparent,var(--ink) 28px,var(--ink) calc(100% - 28px),transparent);mask-image:linear-gradient(to right,transparent,var(--ink) 28px,var(--ink) calc(100% - 28px),transparent)}
.chip{position:relative;flex:none;scroll-snap-align:start;display:inline-flex;align-items:center;gap:var(--s2);min-width:44px;height:44px;padding:0 7px;border:1px solid transparent;border-radius:var(--radius-m);background:transparent;cursor:pointer;transition:background-color var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out)}
.chip .ag{width:28px;height:28px}
/* A presence dot at the icon's bottom-right; a ring around the icon would read as selected. */
.chip[data-presence]::after,.chip.working::after{content:'';position:absolute;left:25px;top:25px;width:14px;height:14px;border:2px solid var(--ground);border-radius:var(--radius-round);pointer-events:none}
.chip[data-presence="open"]::after,.chip[data-presence="connected"]::after{border-color:var(--alive);background:var(--ground)}
.chip[data-presence="offline"]::after{border-radius:var(--radius-s);background:var(--muted)}
.chip[data-presence="notseen"]::after{background:linear-gradient(var(--muted),var(--muted)) center/8px 2px no-repeat var(--ground)}
.chip.working::after{border-color:var(--ground);border-radius:var(--radius-round);background:var(--alive)}
.chip .c-name{max-width:0;overflow:hidden;white-space:nowrap;font-weight:600;line-height:1.5;transition:max-width var(--dur-layout) var(--ease-out)}
.chip[aria-pressed="true"]{border-color:var(--ink);background:var(--current);padding-right:var(--s3)}
.chip[aria-pressed="true"] .c-name{max-width:24em}
.badge{position:absolute;top:-2px;right:-2px;min-width:22px;height:22px;padding:0 6px;border:2px solid var(--ground);border-radius:var(--radius-round);background:var(--waiting-fill);color:var(--on-accent);font-size:var(--text-xs);font-weight:600;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}
.badge.bad{background:var(--alert)}
.agent-note{display:grid;gap:var(--s1);padding-top:var(--s2);padding-bottom:var(--s2);color:var(--muted)}
.agent-note:empty{display:none}
.agent-note p{margin:0}.agent-note summary{cursor:pointer;display:inline}.agent-note summary::before{content:none}
`

// The Needs you sheet: a tab with a flag, then one raised sheet.
export const sheetCss = `
.needs-wrap{display:flex;flex-direction:column}
.sheet-tab{align-self:flex-start}
.sheet-tab h2{margin:0}
.flag{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:0 var(--s4) 0 var(--s3);background:var(--waiting-fill);color:var(--on-accent);font-size:var(--text-md);font-weight:600;line-height:1.4;font-variant-numeric:tabular-nums;clip-path:polygon(0 0,100% 0,calc(100% - 8px) 50%,100% 100%,0 100%);border-radius:var(--radius-s) 0 0 0}
.flag b{font-weight:600;margin-left:var(--s2)}
.sheet{background:var(--surface);border:1px solid var(--line-strong);border-radius:0 var(--radius-m) var(--radius-m) var(--radius-m)}
`

export const htmlLang = (s: Strings): string => (s.lang === 'en' ? 'en' : s.lang === 'zh-CN' ? 'zh-Hans' : 'zh-Hant')
