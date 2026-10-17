import type { ProgressStepStatus } from '../types'
import { askRole, DARK, LIGHT, stepRole, toneRole } from './palette'
import type { Palette } from './palette'
import type { Strings } from './i18n'
import type { Focus, TaskRow, View, ViewStep, WaitingItem } from './view'

// progress.html: the same view as the pane, as a page any browser keeps open in a window of
// its own, beside progress.md. Built from the file alone (no session's own card), so every
// session writes the same page and every agent's work is on it. It reloads itself every 30
// seconds and keeps the sections the person opened, and follows the system's light or dark.

const GLYPH: Record<ProgressStepStatus, string> = {
  done: '✓',
  doing: '▸',
  todo: '○',
  waiting: '●',
  running: '◐',
  blocked: '!',
  cancelled: '–',
}

const LEGEND: readonly ProgressStepStatus[] = ['done', 'doing', 'todo', 'waiting', 'running', 'blocked', 'cancelled']

const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Each colour role as a CSS variable, light by default and dark under the system's choice.
export const vars = (palette: Palette): string =>
  Object.entries(palette)
    .map(([key, value]) => `--${key}:${value}`)
    .join(';')

export const htmlLang = (s: Strings): string => (s.lang === 'en' ? 'en' : s.lang === 'zh-CN' ? 'zh-Hans' : 'zh-Hant')

const steps = (list: readonly ViewStep[]): string =>
  `<ol class="steps">${list
    .map(
      step =>
        `<li class="${step.isCurrent ? 'now' : ''}"><span class="n">${step.number ?? ''}</span>` +
        `<span class="g" style="color:var(--${roleOf(step.status)})">${GLYPH[step.status]}</span>` +
        `<span class="t${step.status === 'done' || step.status === 'cancelled' ? ' quiet' : ''}">${esc(step.text)}</span>` +
        (step.note === '' ? '' : `<span class="note" style="color:var(--${roleOf(step.status)})">${esc(step.note)}</span>`) +
        '</li>',
    )
    .join('')}</ol>`

const roleOf = stepRole
const toneVar = toneRole
const askVar = askRole

const bar = (done: number, total: number): string => {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  return `<span class="bar"><span style="width:${percent}%;background:var(--${done === total && total > 0 ? 'done' : 'accent'})"></span></span>`
}

const waitingItem = (item: WaitingItem, s: Strings): string =>
  `<div class="ask"><div><span class="chip" style="color:var(--${askVar(item.kind)})">${esc(s.chip(s.ask[item.kind]))}</span>` +
  `<b>${esc(item.text)}</b></div>` +
  `<div class="where">${esc(item.project)} › ${esc(item.task)}${item.agent === '' ? '' : ` · ${esc(item.agent)}`}</div>` +
  (item.note === '' ? (item.context === '' ? '' : `<div class="quiet">${esc(s.contextLine(item.context))}</div>`) : `<div>${esc(item.note)}</div>`) +
  // A backticked word in another kind of question is a name, not something to run.
  (item.command === null || item.kind !== 'do' ? '' : `<code>${esc(item.command)}</code>`) +
  (item.link === null ? '' : `<a href="${esc(item.link)}">${esc(s.openLink)}</a>`) +
  `<div class="quiet">${esc(item.where === 'manual' ? '' : s.replyElsewhere(item.project, item.agent))}${item.when === '' ? '' : ` · ${esc(item.when)}`}</div></div>`

const row = (it: TaskRow, s: Strings, showProject: boolean): string => {
  const meta = [it.due === null ? '' : it.due.date, showProject ? it.project : '', it.agent, it.status, it.pr, it.when].filter(
    part => part !== '',
  )
  return (
    `<details class="row" data-key="${esc(it.key)}"><summary><span class="title">${esc(it.title)}</span>` +
    `<span class="tail" style="color:var(--${it.due === null ? 'muted' : toneVar(it.due.tone)})">${esc(it.due === null ? `${it.done}/${it.total}` : it.due.left)}</span>` +
    `<span class="meta" style="color:var(--${toneVar(it.tone)})">${bar(it.done, it.total)} ${esc(meta.join(' · '))}</span></summary>` +
    (it.context === '' ? '' : `<p class="quiet">${esc(s.contextLine(it.context))}</p>`) +
    steps(it.steps) +
    (it.resume === null ? '' : `<p class="quiet">${esc(s.copyResume)}</p><code>${esc(it.resume)}</code>`) +
    '</details>'
  )
}

const focus = (it: Focus | null, s: Strings): string => {
  if (it === null) return `<section class="focus calm">${esc(s.nothingForYou)}</section>`
  const body =
    it.type === 'ask'
      ? waitingItem(it.item, s)
      : `<div><b style="color:var(--alert)">${esc(it.type === 'due' ? `⚑ ${it.row.due?.left ?? ''}` : s.stuckLead)}</b> <b>${esc(it.row.title)}</b></div>` +
        `<div class="where">${esc(it.row.project)}</div><div>${esc(it.row.status)}</div>`

  return `<section class="focus"><div class="label">${esc(s.mostNeeded)}</div>${body}</section>`
}

const section = (id: string, title: string, count: number, tone: string, hint: string, body: string, isOpen: boolean): string =>
  count === 0
    ? ''
    : `<details class="section" data-key="section:${id}"${isOpen ? ' open' : ''}><summary><span class="title">${esc(title)}</span>` +
      `<span class="count" style="color:var(--${tone})">${count}</span>${hint === '' ? '' : `<span class="quiet">${esc(hint)}</span>`}</summary>${body}</details>`

export const dashboardHtml = (view: View, s: Strings, path: string, stamp: string): string => {
  const { waiting, active, due, today } = view.overview
  const nearest = view.due[0]
  const counts = [
    ['●', waiting, s.countWaiting, 'waiting'],
    ['▸', active, s.countActive, 'accent'],
    ['⚑', due, s.countDue, 'soon'],
    ['✓', today, s.countToday, 'done'],
  ] as const

  return `<!doctype html>
<html lang="${htmlLang(s)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(s.paneTitle)} · Agent Board</title>
<style>
:root{${vars(LIGHT)};--ground:#fbfaf5;--ink:#2b2b2b;--line:#e3e1d7;color-scheme:light}
@media (prefers-color-scheme:dark){:root{${vars(DARK)};--ground:#1e2022;--ink:#e6e4dc;--line:#34373a;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.6 "Hiragino Sans","Noto Sans TC","Noto Sans SC","Microsoft JhengHei","Microsoft YaHei",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:20px max(16px,env(safe-area-inset-left)) 40px max(16px,env(safe-area-inset-right));display:grid;gap:14px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
h1{font-size:1.4rem;margin:0;letter-spacing:.04em}
.meta,.quiet{color:var(--muted)}
.counts{display:flex;flex-wrap:wrap;gap:6px 18px;font-variant-numeric:tabular-nums}
.focus{border:1px solid var(--line);border-radius:10px;padding:12px 14px;display:grid;gap:4px}
.focus.calm{color:var(--done)}
.label{color:var(--muted);font-size:.85rem;letter-spacing:.06em}
.chip{margin-right:6px}
.where{color:var(--project)}
code{display:block;overflow-x:auto;font:13px/1.5 ui-monospace,"JetBrains Mono",Consolas,monospace;padding:6px 8px;border:1px solid var(--line);border-radius:6px;color:var(--accent)}
a{color:var(--accent)}
details.section{border-top:1px solid var(--line);padding-top:8px}
summary{cursor:pointer;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;list-style:none}
summary::before{content:"▸";color:var(--muted)}
details[open]>summary::before{content:"▾"}
summary:focus-visible{outline:1px dotted var(--accent);outline-offset:3px}
.section>summary .title{font-weight:700}
.group{margin:10px 0 0 4px}
.group h3{margin:0;font-size:.95rem;color:var(--project);display:flex;flex-wrap:wrap;gap:4px 10px}
.group h3 span{font-weight:400;color:var(--muted)}
details.row{margin:6px 0 0 8px}
.row .title{flex:1 1 12em;min-width:0}
.row .meta{flex-basis:100%;padding-left:1.2em;display:flex;align-items:center;gap:8px;min-width:0}
.bar{display:inline-block;width:52px;height:4px;border-radius:2px;background:var(--frame);overflow:hidden;flex:none}
.bar span{display:block;height:100%}
.steps{list-style:none;margin:6px 0;padding:0 0 0 1.2em;display:grid;gap:2px}
.steps li{display:grid;grid-template-columns:2ch 1.4em 1fr;column-gap:4px}
.steps .n{color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.steps .now .t{font-weight:700}
.steps .note{grid-column:3}
.ask{display:grid;gap:2px;margin:8px 0 0 4px}
footer{color:var(--muted);font-size:.85rem;display:grid;gap:4px;border-top:1px solid var(--line);padding-top:10px}
.legend{display:flex;flex-wrap:wrap;gap:2px 14px}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
</style>
</head>
<body>
<main>
<header><h1>${esc(s.paneTitle)}</h1><span class="meta">${esc(stamp)}</span></header>
<section class="counts">${counts
    .map(([glyph, n, word, role]) => `<span><span style="color:var(--${n > 0 ? role : 'muted'})">${glyph} ${n}</span> ${esc(word)}</span>`)
    .join('')}</section>
${focus(view.focus, s)}
${section('waiting', s.sectionWaiting, view.waiting.length, 'waiting', '', view.waiting.map(item => waitingItem(item, s)).join(''), true)}
${section('due', s.sectionDue, view.due.length, 'soon', nearest === undefined ? '' : s.nearestDue(nearest.title, nearest.due?.left ?? ''), view.due.map(it => row(it, s, true)).join(''), false)}
${section(
  'others',
  s.sectionActive,
  view.active.length,
  'accent',
  view.groups.map(group => group.project).join(s.listSep),
  view.groups
    .map(group => `<div class="group"><h3>${esc(group.project)}<span>${esc(group.summary)}</span></h3>${group.rows.map(it => row(it, s, false)).join('')}</div>`)
    .join(''),
  true,
)}
${section(
  'recent',
  s.sectionRecent,
  view.recent.length,
  'done',
  '',
  `<ul class="steps">${view.recent.map(item => `<li><span></span><span style="color:var(--done)">✓</span><span class="quiet">${esc([item.project, item.title, item.when].filter(part => part !== '').join(' · '))}</span></li>`).join('')}</ul>`,
  false,
)}
<footer><div class="legend">${LEGEND.map((status, index) => `<span><span style="color:var(--${roleOf(status)})">${GLYPH[status]}</span> ${esc(s.legendWords[index] ?? status)}</span>`).join('')}<span>${esc(s.legendDue)}</span></div>
<div>${esc(s.legendCleanup)}</div><div>${esc(path)}</div></footer>
</main>
<script>
(function () {
  var key = 'progress-open';
  var open = {};
  try { open = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) {}
  document.querySelectorAll('details[data-key]').forEach(function (el) {
    var id = el.getAttribute('data-key');
    if (id in open) el.open = open[id];
    el.addEventListener('toggle', function () {
      open[id] = el.open;
      try { localStorage.setItem(key, JSON.stringify(open)); } catch (e) {}
    });
  });
  try { var y = sessionStorage.getItem('progress-y'); if (y) window.scrollTo(0, +y); } catch (e) {}
  setTimeout(function () {
    try { sessionStorage.setItem('progress-y', String(window.scrollY)); } catch (e) {}
    location.reload();
  }, 30000);
})();
</script>
</body>
</html>
`
}
