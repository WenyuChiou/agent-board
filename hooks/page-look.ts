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

// This runs before styles and delegates presses because the menu is parsed later. The theme button
// opens a small menu (#1085): Light / Dark / System, then the progress bar's three styles. The
// theme pick is this browser's; a style pick goes to the board (the page's own script sends it),
// so the pane and the terminal board show the same one.
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
    // The button's icon follows the theme on screen; each theme item says whether it is the pick.
    each('[data-theme-toggle]', function (button) { button.setAttribute('data-now', shown); });
    each('[data-theme-set]', function (item) { item.setAttribute('aria-checked', String(item.getAttribute('data-theme-set') === (choice || 'system'))); });
  }
  function menuOf(button) { return button && button.parentNode && button.parentNode.querySelector ? button.parentNode.querySelector('[data-look-menu]') : null; }
  function close(focus) {
    each('[data-look-menu]', function (menu) { menu.hidden = true; });
    each('[data-theme-toggle]', function (button) {
      if (focus && button.getAttribute('aria-expanded') === 'true' && button.focus) button.focus();
      button.setAttribute('aria-expanded', 'false');
    });
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
  document.addEventListener('keydown', function (event) { if (event && event.key === 'Escape') close(true); });
  document.addEventListener('click', function (event) {
    var node = event.target;
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute('data-theme-toggle') !== null) {
        var menu = menuOf(node);
        var isOpen = node.getAttribute('aria-expanded') === 'true';
        close(false);
        if (menu && !isOpen) {
          menu.hidden = false;
          node.setAttribute('aria-expanded', 'true');
          var first = menu.querySelector('[aria-checked="true"]') || menu.querySelector('button');
          if (first && first.focus) first.focus();
        }
        return;
      }
      if (node.getAttribute && node.getAttribute('data-theme-set') !== null) {
        pick(node.getAttribute('data-theme-set'));
        close(true);
        return;
      }
      if (node.getAttribute && node.getAttribute('data-bar-set') !== null) { close(true); return; }
      if (node.getAttribute && node.getAttribute('data-look-menu') !== null) return;
      node = node.parentNode;
    }
    close(false);
  });
})();
`

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

const THEME_ICONS = {
  moon: '<path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1z"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>',
} as const

// One icon button for the look: its icon follows the theme on screen, and it opens a menu of the
// three themes and the progress bar's three styles (#1085). Each style item shows a small bar in its colours.
const SWATCH = '<span class="sw" aria-hidden="true"><i class="c-x"></i><i class="c-x"></i><i class="c-c"></i><i class="c-t"></i></span>'
export const themeToggle = (s: Strings): string =>
  `<span class="look"><button type="button" class="icon-btn" data-local data-theme-toggle data-now="light" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(s.themeMenu)}" title="${esc(s.themeMenu)}"><svg class="i i-moon" viewBox="0 0 16 16" aria-hidden="true">${THEME_ICONS.moon}</svg><svg class="i i-sun" viewBox="0 0 16 16" aria-hidden="true">${THEME_ICONS.sun}</svg></button>` +
  `<span class="look-menu" role="menu" data-look-menu aria-label="${esc(s.themeMenu)}" hidden>` +
  (['light', 'dark', 'system'] as const).map(theme => `<button type="button" role="menuitemradio" aria-checked="false" data-local data-theme-set="${theme}">${esc(theme === 'light' ? s.themeLight : theme === 'dark' ? s.themeDark : s.themeSystem)}</button>`).join('') +
  `<span class="look-head" role="presentation">${esc(s.barStyleHead)}</span>` +
  (['ink', 'blue', 'green'] as const).map(style => `<button type="button" role="menuitemradio" aria-checked="${style === 'ink'}" data-local data-bar-set="${style}" data-sw="${style}">${SWATCH}${esc(style === 'blue' ? s.barStyleBlue : style === 'green' ? s.barStyleGreen : s.barStyleInk)}</button>`).join('') +
  `</span></span>`

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
.mark{width:30px;height:30px;flex:none}.lg-mark{fill:var(--brand)}
.icon-btn{display:inline-grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:var(--radius-m);background:transparent;color:var(--muted);cursor:pointer;transition:background-color var(--dur-fast) var(--ease-out),color var(--dur-fast) var(--ease-out)}
.icon-btn:hover{background:var(--hover);color:var(--ink)}
.icon-btn:active{background:var(--press)}
[data-theme-toggle] .i-sun,[data-theme-toggle][data-now="dark"] .i-moon{display:none}
[data-theme-toggle][data-now="dark"] .i-sun{display:block}
/* the look menu (#1085): it opens above the button, which sits in the page's foot */
.look{position:relative;display:inline-flex}
.look-menu{position:absolute;bottom:calc(100% + var(--s1));left:0;z-index:20;min-width:176px;display:grid;padding:var(--s1);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-m);box-shadow:var(--shadow)}
.look-menu button{display:flex;align-items:center;gap:var(--s2);min-height:var(--hit);padding:0 var(--s2);border:0;border-radius:var(--radius-s);background:transparent;text-align:left;cursor:pointer;font-size:var(--text-sm);white-space:nowrap}
.look-menu button[aria-checked="true"]{font-weight:600}
.look-menu button[aria-checked="true"]::after{content:'';margin-left:auto;width:8px;height:4px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;transform:translateY(-2px) rotate(-45deg)}
.look-head{padding:var(--s2) var(--s2) var(--s1);margin-top:var(--s1);border-top:1px solid var(--line);font-size:var(--text-xs);color:var(--muted)}
@media (pointer:coarse){.look-menu button{min-height:44px}}
@media (pointer:coarse){.icon-btn{width:44px;height:44px}}
.quiet,.meta{color:var(--muted)}
button:hover,.btn:hover,summary:hover{background-color:var(--hover)}
@media (prefers-reduced-motion:no-preference){.theming,.theming *,.theming *::before,.theming *::after{transition:background-color var(--dur-theme) ease,border-color var(--dur-theme) ease,color var(--dur-theme) ease,fill var(--dur-theme) ease,box-shadow var(--dur-theme) ease!important}}
@media (max-width:600px){.brand h1{font-size:var(--text-md)}.mark{width:28px;height:28px}}
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
