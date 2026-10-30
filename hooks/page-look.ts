import { AGENT_ICONS } from './agent-icons'
import type { Strings } from './i18n'
import { FONT_LICENSE, FONT_REGULAR, FONT_SEMIBOLD } from './page-fonts'
import { DARK, LIGHT, PAGE_DARK, PAGE_LIGHT } from './palette'

const cssVars = (values: Record<string, string>): string => Object.entries(values).map(([key, value]) => `--${key}:${value}`).join(';')

export const pageTokens = (headHeight = '54px'): string => {
  const shared = {
    'font-sans': '"Atkinson Hyperlegible Next",system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans TC","Noto Sans SC","Hiragino Sans","PingFang TC","PingFang SC","Microsoft JhengHei","Microsoft YaHei",sans-serif',
    'font-mono': 'ui-monospace,"SF Mono","Cascadia Mono","Segoe UI Mono",Menlo,Consolas,"Liberation Mono",monospace',
    // Nothing on the page is smaller than 14px, and each size grows with the reader's own font size (max of the
    // floor and a rem value). xs (14) is the floor: ages, counts, small labels. sm (16) is body, buttons, meta
    // lines, steps and inputs. md (18) is row titles, shelf heads and the brand. lg (22; 20 on a phone, below)
    // is the card question, section headings and the empty-page heading. Line height is 1.5 up to 16px and 1.4
    // from 18px; headings differ from row titles by size and space, not by weight.
    'text-xs': 'max(14px,.875rem)', 'text-sm': 'max(16px,1rem)', 'text-md': 'max(18px,1.125rem)', 'text-lg': 'max(22px,1.375rem)',
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
    'head-h': headHeight,
    ...Object.fromEntries(AGENT_ICONS.map(icon => [`ag-${icon.file}`, icon.tile])),
  }
  const dark = `${cssVars(DARK)};${cssVars(PAGE_DARK)};color-scheme:dark`
  return `:root{${cssVars(LIGHT)};${cssVars(PAGE_LIGHT)};${cssVars(shared)};color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark}}}
:root[data-theme="dark"]{${dark}}
@media (max-width:640px){:root{--text-lg:max(20px,1.25rem)}}`
}

// This runs before styles and delegates presses because the switch is parsed later.
export const themeHead = String.raw`
(() => {
  var root = document.documentElement;
  // No saved pick: the page follows the system, and shows which of the two it is following.
  var choice = '';
  var timer;
  var saved = '';
  // The live page starts on a new port each time, so its storage starts empty there; a cookie
  // is shared across ports and keeps the pick. progress.html, a file, keeps it in storage.
  try {
    var kept = /(?:^|;\s*)agent-board\.theme=(light|dark)(?:;|$)/.exec(document.cookie || '');
    if (kept) saved = kept[1];
  } catch (e) {}
  if (!saved) {
    try { saved = localStorage.getItem('agent-board.theme'); } catch (e) {}
  }
  if (saved === 'light' || saved === 'dark') choice = saved;
  var scheme = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function apply() {
    if (choice) root.setAttribute('data-theme', choice);
    else root.removeAttribute('data-theme');
    var shown = choice || (scheme && scheme.matches ? 'dark' : 'light');
    document.querySelectorAll('[data-theme-pick]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-theme-pick') === shown));
    });
  }
  apply();
  try { if (scheme && scheme.addEventListener) scheme.addEventListener('change', apply); } catch (e) {}
  document.addEventListener('DOMContentLoaded', apply);
  document.addEventListener('click', function (event) {
    var node = event.target;
    while (node && node !== document) {
      var picked = node.getAttribute && node.getAttribute('data-theme-pick');
      if (picked === 'light' || picked === 'dark') {
        choice = picked;
        // Blocked storage only means the pick is not kept: this page still shows it.
        try { localStorage.setItem('agent-board.theme', choice); } catch (e) {}
        try { document.cookie = 'agent-board.theme=' + choice + '; Path=/; SameSite=Strict; Max-Age=' + 365 * 24 * 3600; } catch (e) {}
        root.classList.add('theming');
        clearTimeout(timer);
        apply();
        timer = setTimeout(() => { root.classList.remove('theming'); }, 300);
        return;
      }
      node = node.parentNode;
    }
  });
})();
`

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

const THEME_ICONS = [
  '<circle cx="8" cy="8" r="3"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>',
  '<path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1z"/>',
] as const

export const themeSwitch = (s: Strings): string =>
  `<div class="seg" role="group" aria-label="${esc(s.themeLabel)}">${(['light', 'dark'] as const).map((pick, index) => {
    const label = [s.themeLight, s.themeDark][index] ?? ''
    return `<button type="button" data-local data-theme-pick="${pick}" aria-pressed="false" aria-label="${esc(label)}"><svg class="i" viewBox="0 0 16 16" aria-hidden="true">${THEME_ICONS[index]}</svg><span class="tl">${esc(label)}</span></button>`
  }).join('')}</div>`

// Bubble a, the board's mark: a lowercase a whose foot turns out into a speech-bubble tail, an agent
// talking to you. One path on a 64 grid, in the brand colour.
export const MARK_PATH = 'M 51 14.5 V 36 C 51 46 52 54 57.5 59 C 50.6 59 43.71 56.77 40.01 51.67 Q 34.7 55 28 55 Q 18.47 55 11.74 48.26 Q 5 41.53 5 32 Q 5 22.47 11.74 15.74 Q 18.47 9 28 9 Q 34.9 9 40.34 12.54 Q 40.74 11.48 41.61 10.61 Q 43.22 9 45.5 9 Q 47.78 9 49.39 10.61 Q 51 12.22 51 14.5 Z M 40 32 Q 40 27.03 36.49 23.51 Q 32.97 20 28 20 Q 23.03 20 19.51 23.51 Q 16 27.03 16 32 Q 16 36.97 19.51 40.49 Q 23.03 44 28 44 Q 32.97 44 36.49 40.49 Q 40 36.97 40 32 Z'
const MARK = `<path class="lg-mark" d="${MARK_PATH}"/>`

export const boardMark = `<svg class="mark" viewBox="0 0 64 64" aria-hidden="true">${MARK}</svg>`

// RGB notation keeps encoded hex colours from resembling private session ids.
const rgb = (hex: string): string => `rgb(${(hex.slice(1).match(/../g) ?? []).map(channel => parseInt(channel, 16)).join(',')})`
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>.lg-mark{fill:${rgb(PAGE_LIGHT.brand)}}@media (prefers-color-scheme:dark){.lg-mark{fill:${rgb(PAGE_DARK.brand)}}}</style>${MARK}</svg>`

export const faviconLink = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON)}">`

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
@font-face{font-family:'Atkinson Hyperlegible Next';src:url(data:font/woff2;base64,${FONT_REGULAR}) format('woff2');font-weight:400;font-display:swap;/* ${FONT_LICENSE} */}
@font-face{font-family:'Atkinson Hyperlegible Next';src:url(data:font/woff2;base64,${FONT_SEMIBOLD}) format('woff2');font-weight:600;font-display:swap}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--ground)}
body{margin:0;background:var(--ground);color:var(--ink);font:var(--text-sm)/1.5 var(--font-sans);-webkit-font-smoothing:antialiased}
[hidden]{display:none!important}
button{font:inherit;color:inherit}
svg.i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.wide{max-width:1180px;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.head{display:block;position:sticky;top:0;z-index:6;background:var(--ground);border-bottom:1px solid var(--line)}
.topbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px 12px;padding-block:10px}.topbar>.seg{margin-left:auto}
.brand{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 auto}
.brand h1{margin:0;font-size:var(--text-md);line-height:1.4;font-weight:650}
.mark{width:30px;height:30px;flex:none}.lg-mark{fill:var(--brand)}
.seg{display:inline-flex;padding:2px;gap:2px;border:1px solid var(--line);border-radius:var(--radius-m);background:var(--surface)}
.seg button{border:1px solid transparent;background:transparent;color:var(--muted);min-height:28px;padding:0 8px;border-radius:var(--radius-m);display:inline-flex;align-items:center;gap:6px;font-size:var(--text-xs);cursor:pointer}
.seg button:hover{color:var(--ink);background:var(--inset)}
.seg button[aria-pressed="true"]{background:var(--ground);color:var(--ink);border-color:var(--muted)}
@media (pointer:coarse){.seg button{min-height:44px}}
.quiet,.meta{color:var(--muted)}
button:hover,.btn:hover,summary:hover{background-color:var(--inset)}
@media (prefers-reduced-motion:no-preference){.theming,.theming *,.theming *::before,.theming *::after{transition:background-color var(--dur-theme) ease,border-color var(--dur-theme) ease,color var(--dur-theme) ease,fill var(--dur-theme) ease,box-shadow var(--dur-theme) ease!important}}
@media (max-width:600px){.seg .tl{display:none}.seg button{padding:0 7px}.brand h1{font-size:var(--text-md)}.mark{width:28px;height:28px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
`

// The row of agent icons, shared by the live page and progress.html (the script that fills it differs).
export const agentRowCss = `
.agents{position:sticky;top:var(--head-h,56px);z-index:4;background:var(--ground);border-bottom:1px solid var(--line)}
.agents-in{display:flex;gap:var(--s2);overflow-x:auto;scrollbar-width:none;scroll-snap-type:x proximity;padding-top:var(--s2);padding-bottom:var(--s2)}
.agents-in::-webkit-scrollbar{display:none}
/* When the icons do not fit the row scrolls sideways and the edge that has more fades, so the last icon shows partly; it never wraps. */
.agents-in.more-right{-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 28px),transparent)}
.agents-in.more-left{-webkit-mask-image:linear-gradient(to left,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(to left,#000 calc(100% - 28px),transparent)}
.agents-in.more-left.more-right{-webkit-mask-image:linear-gradient(to right,transparent,#000 28px,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(to right,transparent,#000 28px,#000 calc(100% - 28px),transparent)}
.chip{position:relative;flex:none;scroll-snap-align:start;display:inline-flex;align-items:center;gap:var(--s2);min-width:44px;height:44px;padding:0 7px;border:1px solid transparent;border-radius:var(--radius-m);background:transparent;cursor:pointer;transition:background-color var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out)}
.chip .ag{width:28px;height:28px}
/* A presence dot at the icon's bottom-right; a ring around the icon would read as selected. */
.chip[data-presence="offline"] .ag,.chip[data-presence="notseen"] .ag{background-color:var(--muted)}
.chip.working::after{content:'';position:absolute;left:25px;top:25px;width:14px;height:14px;border:2px solid var(--ground);border-radius:var(--radius-round);background:var(--running);pointer-events:none}
.chip .c-name{max-width:0;overflow:hidden;white-space:nowrap;font-weight:600;line-height:1.5;transition:max-width var(--dur-layout) var(--ease-out)}
.chip[aria-pressed="true"]{border-color:var(--ink);background:var(--current);padding-right:var(--s3)}
.chip[aria-pressed="true"] .c-name{max-width:18em}
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
