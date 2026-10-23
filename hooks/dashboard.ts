import type { ProgressStepStatus } from '../types'
import type { PendingTurn } from './board'
import { clip } from './mirror'
import { askRole, stepRole, toneRole } from './palette'
import type { Palette } from './palette'
import { agentMark, agentMarkCss, boardMark, pageBaseCss, pageTokens, themeHead, themeSwitch } from './page-look'
import type { Strings } from './i18n'
import type { Focus, TaskRow, View, ViewStep, WaitingItem } from './view'

// progress.html: the same view as the pane, as a page any browser keeps open in a window of
// its own, beside progress.md. Built from the file and pending inbox turns, without a session's
// own card, so every agent's work is on it. It reloads itself every 30
// seconds and keeps the sections the person opened and their chosen page theme.

const GLYPH: Record<ProgressStepStatus, string> = {
  done: '✓',
  doing: '▸',
  todo: '•',
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
  `<div class="ask"><div><span class="chip" style="color:var(--${askVar(item.kind)})">${esc(s.ask[item.kind])}</span>` +
  `<b>${esc(item.text)}</b></div>` +
  `<div class="where">${agentMark(item.agent, item.where === 'manual')}${esc(item.project)} › ${esc(item.task)}${item.agent === '' ? '' : ` · ${esc(item.agent)}`}</div>` +
  (item.note === '' ? (item.context === '' ? '' : `<div class="quiet">${esc(s.contextLine(item.context))}</div>`) : `<div>${esc(item.note)}</div>`) +
  // A backticked word in another kind of question is a name, not something to run.
  (item.command === null || item.kind !== 'do' ? '' : `<code>${esc(item.command)}</code>`) +
  (item.link === null ? '' : `<a href="${esc(item.link)}">${esc(s.openLink)}</a>`) +
  `<div class="quiet">${esc(item.where === 'manual' ? '' : s.replyElsewhere(item.task, '', item.agent))}${item.when === '' ? '' : ` · ${esc(item.when)}`}</div>` +
  '</div>'

const row = (it: TaskRow, s: Strings, showProject: boolean): string => {
  const meta = [it.due === null ? '' : it.due.date, showProject ? it.project : '', it.agent, it.status, it.pr, it.when].filter(
    part => part !== '',
  )
  return (
    `<details class="row" data-key="${esc(it.key)}"><summary><span class="title">${esc(it.title)}</span>` +
    `<span class="tail" style="color:var(--${it.due === null ? 'muted' : toneVar(it.due.tone)})">${esc(it.due === null ? `${it.done}/${it.total}` : it.due.left)}</span>` +
    `<span class="meta" style="color:var(--${toneVar(it.tone)})">${agentMark(it.agent, it.auto === null)}${bar(it.done, it.total)} ${esc(meta.join(' · '))}</span></summary>` +
    (it.context === '' ? '' : `<p class="quiet">${esc(s.contextLine(it.context))}</p>`) +
    steps(it.steps) +
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

export const dashboardHtml = (view: View, s: Strings, path: string, stamp: string, pending: readonly PendingTurn[] = []): string => {
  pending = view.hasPendingQuestions ? pending.filter(turn => !turn.isQuestion) : pending
  const { active, due, today } = view.overview
  const waiting = view.overview.waiting + pending.filter(turn => turn.isQuestion).length
  const nearest = view.due[0]
  const counts = [
    ['●', waiting, s.countWaiting, 'waiting'],
    ['▸', active, s.countActive, 'accent'],
    ['⚑', due, s.countDue, 'soon'],
    ['✓', today, s.countToday, 'done'],
  ] as const

  const sections = [
    ['inbox', s.boardInbox, pending.length],
    ['waiting', s.sectionWaiting, view.waiting.length],
    ['reminder', s.sectionQuestionReminders, view.reminder?.length ?? 0],
    ['older', s.sectionOlderQuestions, view.older?.length ?? 0],
    ['idle', s.idleCount(view.idle.length), view.idle.length],
    ['stopped', s.viewStopped, view.stopped.length],
    ['due', s.sectionDue, view.due.length],
    ['others', s.sectionActive, view.active.length],
    ['recent', s.sectionRecent, view.recent.length],
  ] as const

  return `<!doctype html>
<html lang="${htmlLang(s)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(s.paneTitle)} · Agent Board</title>
<script>${themeHead}</script>
<style>
${pageTokens()}
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
${pageBaseCss}
${agentMarkCss()}
:root{--shadow:0 1px 2px rgba(0,0,0,.05),0 2px 8px -4px rgba(0,0,0,.08)}
.dashboard-shell{display:grid;grid-template-columns:200px minmax(0,780px);column-gap:36px;align-items:start}
main{max-width:780px;min-width:0;margin:0;padding:18px 0 40px;gap:18px}
.dash-nav{position:sticky;top:var(--head-h,70px);display:grid;gap:4px;padding:20px 0;max-height:calc(100dvh - var(--head-h,70px));overflow:auto}
.dash-nav h2{font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0 0 6px;padding:0 10px}
.dash-nav button{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:36px;padding:6px 10px;border:1px solid transparent;border-radius:9px;text-align:left;background:transparent;font-size:14px;cursor:pointer}
.dash-nav button:hover{background:var(--surface);border-color:var(--line)}.dash-nav .ct{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.where .ag{margin-right:6px}.head .meta{font-size:12px}.head .brand{flex-wrap:wrap}.head .brand .meta{margin-left:auto}
.counts{display:grid;grid-template-columns:repeat(4,1fr);gap:0;border:1px solid var(--line);border-radius:14px;background:var(--surface);overflow:hidden}.counts>span{padding:12px;border-left:1px solid var(--line)}.counts>span:first-child{border-left:0}
.focus{border:1px solid var(--line);border-radius:14px;background:var(--surface);padding:16px;box-shadow:var(--shadow)}
details.section{border:1px solid var(--line);padding:0;border-radius:14px;background:var(--surface);box-shadow:var(--shadow);overflow:clip;scroll-margin-top:calc(var(--head-h,70px) + 12px)}
.section>summary{padding:12px 16px}.section>.ask,.section>.quiet,.section>.steps,.section>p{margin:12px 16px}.section>.group{margin:0;padding:12px 16px}.group h3{font-weight:650}
details.row{margin:0;border-top:1px solid var(--line);padding:0}.row>summary{padding:11px 16px}.row>p,.row>.steps{margin:10px 16px 16px}.row .title{font-weight:600}.row .meta{flex-wrap:wrap;gap:6px}
.ask{gap:8px;padding:8px 0}.chip{border:1px solid currentColor;border-radius:999px;padding:3px 8px;font-size:12px}.steps li{gap:4px 8px;padding:5px 8px;border-radius:8px}.steps .g{width:22px;height:22px;display:grid;place-items:center;font-size:inherit;cursor:default;user-select:none}.steps li{grid-template-columns:2ch 22px minmax(0,1fr)}.steps .now{background:var(--inset)}
footer{font-size:12.5px;overflow-wrap:anywhere}code{background:var(--inset);border:1px solid var(--line);border-radius:8px}
@media (max-width:760px){.dashboard-shell{grid-template-columns:minmax(0,1fr)}.dash-nav{position:static;display:flex;flex-wrap:wrap;gap:6px;padding:16px 0 0;max-height:none}.dash-nav h2{flex-basis:100%}.dash-nav button{background:var(--surface);border-color:var(--line)}main{padding-top:16px}}
@media (max-width:600px){.counts{grid-template-columns:repeat(2,1fr)}.counts>span:nth-child(3){border-left:0}.counts>span:nth-child(n+3){border-top:1px solid var(--line)}.head .brand .meta{margin-left:0;flex-basis:100%}.head .brand{column-gap:8px}}
</style>
</head>
<body>
<header class="head" id="head"><div class="wide topbar"><div class="brand">${boardMark}<h1>${esc(s.paneTitle)}</h1><span class="meta">${esc(stamp)}</span></div>${themeSwitch(s)}</div></header>
<div class="wide dashboard-shell"><nav class="dash-nav" aria-label="${esc(s.dashSections)}"><h2>${esc(s.dashSections)}</h2>${sections.filter(([, , count]) => count > 0).map(([id, title, count]) => `<button type="button" data-section="dash-${id}"><span>${esc(title)}</span>${id === 'idle' ? '' : `<span class="ct">${count}</span>`}</button>`).join('')}</nav>
<main>
${view.warning ? `<p role="status" style="color:var(--alert)">${esc(view.warning)}</p>` : ''}
${view.pruned ? `<p role="status" class="quiet">${esc(view.pruned)}</p>` : ''}
<section class="counts">${counts
    .map(([glyph, n, word, role]) => `<span><span style="color:var(--${n > 0 ? role : 'muted'})">${glyph} ${n}</span> ${esc(word)}</span>`)
    .join('')}</section>
${view.focus === null && pending.some(turn => turn.isQuestion) ? '' : focus(view.focus, s)}
${section(
  'inbox',
  s.boardInbox,
  pending.length,
  'accent',
  '',
  `<p class="quiet">${esc(s.dashInboxHint)}</p>` + pending.map(turn =>
    `<div class="ask"><div class="where">${agentMark(turn.agent)}${esc([turn.project, turn.agent].filter(part => part !== '').join(' · '))}</div>` +
    `<div><span style="color:var(--${turn.isQuestion ? 'waiting' : 'accent'})">${turn.isQuestion ? '●' : '◐'}</span> ${turn.isQuestion ? esc(clip(turn.text, 200)) : ''}</div></div>`,
  ).join(''),
  true,
)}
${section('waiting', s.sectionWaiting, view.waiting.length, 'waiting', '', view.waiting.map(item => waitingItem(item, s)).join(''), true)}
${section('reminder', s.sectionQuestionReminders, view.reminder?.length ?? 0, 'muted', s.questionAgingHint, (view.reminder ?? []).map(item => waitingItem(item, s)).join(''), false)}
${section('older', s.sectionOlderQuestions, view.older?.length ?? 0, 'muted', s.questionAgingHint, (view.older ?? []).map(item => waitingItem(item, s)).join(''), false)}
${view.hidden.length === 0 ? '' : `<p class="quiet">${esc(s.hiddenCount(view.hidden.length))}</p>`}
${view.idle.length === 0 ? '' : `<details class="section" data-key="section:idle"><summary><span class="quiet">${esc(s.idleCount(view.idle.length))}</span></summary>${view.idle.map(it => row(it, s, true)).join('')}</details>`}
${view.stopped.length === 0 ? '' : `<details class="section" data-key="section:stopped"><summary><span class="quiet">${esc(s.stoppedCount(view.stopped.length))}</span></summary>${view.stopped.map(it => row(it, s, true)).join('')}</details>`}
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
  `<ul class="steps">${view.recent.map(item => `<li><span></span><span style="color:var(--done)">✓</span><span class="quiet">${esc([item.project, item.title, item.when].filter(part => part !== '').join(' · '))}${(item.questions ?? []).map(question => `<br>${esc([question.text, question.note].filter(Boolean).join(' — '))}`).join('')}</span></li>`).join('')}</ul>`,
  false,
)}
<footer><div class="legend">${LEGEND.map((status, index) => `<span><span style="color:var(--${roleOf(status)})">${GLYPH[status]}</span> ${esc(s.legendWords[index] ?? status)}</span>`).join('')}<span>${esc(s.legendDue)}</span></div>
<div>${esc(s.legendCleanup)}</div><div>${esc(s.progressFileShown)}</div></footer>
</main></div>
<script>
(function () {
  var key = 'progress-open';
  var open = {};
  try { open = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) {}
  document.querySelectorAll('details[data-key]').forEach(function (el) {
    var id = el.getAttribute('data-key');
    if (id.indexOf('section:') === 0) el.id = 'dash-' + id.slice(8);
    if (id in open) el.open = open[id];
    el.addEventListener('toggle', function () {
      open[id] = el.open;
      try { localStorage.setItem(key, JSON.stringify(open)); } catch (e) {}
    });
  });
  document.querySelectorAll('button[data-section]').forEach(function (button) {
    button.addEventListener('click', function () {
      var section = document.getElementById(button.getAttribute('data-section'));
      if (section) { section.open = true; section.scrollIntoView({ block: 'start' }); }
    });
  });
  if (typeof ResizeObserver === 'function') {
    var head = document.getElementById('head');
    new ResizeObserver(function () { document.documentElement.style.setProperty('--head-h', head.offsetHeight + 'px'); }).observe(head);
  }
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
