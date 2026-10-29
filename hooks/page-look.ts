import { AGENT_ICONS } from './agent-icons'
import type { Strings } from './i18n'
import { DARK, LIGHT, PAGE_DARK, PAGE_LIGHT } from './palette'

const cssVars = (values: Record<string, string>): string => Object.entries(values).map(([key, value]) => `--${key}:${value}`).join(';')

export const pageTokens = (headHeight = '54px'): string => {
  const shared = {
    'font-sans': 'system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans TC","Noto Sans SC","Hiragino Sans","PingFang TC","PingFang SC","Microsoft JhengHei","Microsoft YaHei",sans-serif',
    'font-mono': 'ui-monospace,"SF Mono","Cascadia Mono","Segoe UI Mono",Menlo,Consolas,"Liberation Mono",monospace',
    'text-xs': '12px', 'text-sm': '14px', 'text-md': '16px', 'text-lg': '20px',
    'radius-s': '6px', 'radius-m': '10px', 'radius-round': '999px',
    'dur-theme': '.28s', 'head-h': headHeight,
    ...Object.fromEntries(AGENT_ICONS.map(icon => [`ag-${icon.file}`, icon.tile])),
  }
  const dark = `${cssVars(DARK)};${cssVars(PAGE_DARK)};color-scheme:dark`
  return `:root{${cssVars(LIGHT)};${cssVars(PAGE_LIGHT)};${cssVars(shared)};color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark}}}
:root[data-theme="dark"]{${dark}}`
}

// This runs before styles and delegates presses because the switch is parsed later.
export const themeHead = String.raw`
(() => {
  var root = document.documentElement;
  var choice = 'system';
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
  function apply() {
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
    document.querySelectorAll('[data-theme-pick]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-theme-pick') === choice));
    });
  }
  apply();
  document.addEventListener('DOMContentLoaded', apply);
  document.addEventListener('click', function (event) {
    var node = event.target;
    while (node && node !== document) {
      var picked = node.getAttribute && node.getAttribute('data-theme-pick');
      if (picked === 'system' || picked === 'light' || picked === 'dark') {
        choice = picked;
        try {
          if (choice === 'system') localStorage.removeItem('agent-board.theme');
          else localStorage.setItem('agent-board.theme', choice);
        // Blocked storage only means the pick is not kept: this page still shows it.
        } catch (e) {}
        try { document.cookie = 'agent-board.theme=' + choice + '; Path=/; SameSite=Strict; Max-Age=' + (choice === 'system' ? 0 : 365 * 24 * 3600); } catch (e) {}
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
  '<rect x="2" y="2.5" width="12" height="8.5" rx="1.5"/><path d="M5.5 14h5M8 11v3"/>',
  '<circle cx="8" cy="8" r="3"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>',
  '<path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1z"/>',
] as const

export const themeSwitch = (s: Strings): string =>
  `<div class="seg" role="group" aria-label="${esc(s.themeLabel)}">${(['system', 'light', 'dark'] as const).map((pick, index) => {
    const label = [s.themeSystem, s.themeLight, s.themeDark][index] ?? ''
    return `<button type="button" data-local data-theme-pick="${pick}" aria-pressed="${pick === 'system'}" aria-label="${esc(label)}"><svg class="i" viewBox="0 0 16 16" aria-hidden="true">${THEME_ICONS[index]}</svg><span class="tl">${esc(label)}</span></button>`
  }).join('')}</div>`

const SIGNAL_ROW = '<rect class="lg-ink" x="8" y="8" width="36" height="8"/><path class="lg-flag" d="M8 24H56L48 32L56 40H8Z"/><rect class="lg-ink" x="8" y="48" width="28" height="8"/>'

export const boardMark = `<svg class="mark" viewBox="0 0 64 64" aria-hidden="true">${SIGNAL_ROW}</svg>`

// RGB notation keeps encoded hex colours from resembling private session ids.
const rgb = (hex: string): string => `rgb(${(hex.slice(1).match(/../g) ?? []).map(channel => parseInt(channel, 16)).join(',')})`
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>.lg-ink{fill:${rgb(PAGE_LIGHT.ink)}}.lg-flag{fill:${rgb(PAGE_LIGHT.waiting)}}@media (prefers-color-scheme:dark){.lg-ink{fill:${rgb(PAGE_DARK.ink)}}.lg-flag{fill:${rgb(PAGE_DARK.waiting)}}}</style>${SIGNAL_ROW}</svg>`

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

export const pageBaseCss = `
*,*::before,*::after{box-sizing:border-box}
html{background:var(--ground)}
body{margin:0;background:var(--ground);color:var(--ink);font:var(--text-md)/1.55 var(--font-sans);-webkit-font-smoothing:antialiased}
[hidden]{display:none!important}
button{font:inherit;color:inherit}
svg.i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.wide{max-width:1180px;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.head{display:block;position:sticky;top:0;z-index:6;background:var(--ground);border-bottom:1px solid var(--line)}
.topbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px 12px;padding-block:10px}.topbar>.seg{margin-left:auto}
.brand{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 auto}
.brand h1{margin:0;font-size:var(--text-md);line-height:1.2;font-weight:650}
.mark{width:30px;height:30px;flex:none}.lg-ink{fill:var(--ink)}.lg-flag{fill:var(--waiting)}
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
