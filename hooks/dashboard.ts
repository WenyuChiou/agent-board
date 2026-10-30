import type { ProgressStepStatus } from '../types'
import type { PendingTurn } from './board'
import { clip } from './mirror'
import { askRole, stepRole, toneRole } from './palette'
import type { Palette } from './palette'
import { agentMark, agentMarkCss, agentRowCss, boardMark, faviconLink, filterStore, htmlLang, pageBaseCss, pageTokens, sheetCss, themeHead, themeSwitch } from './page-look'
import { serveModel } from './serve'
import { agentLabel } from './strings'
import type { Strings } from './i18n'
import type { TaskRow, View, ViewStep, WaitingItem } from './view'
import { OLDER_SHOWN } from './view'

// progress.html: the board page's order (the agent row, Needs you, Working now, the projects, a closed
// Done shelf) as a page any browser keeps open in a window of its own, beside progress.md. Built from the file and pending inbox turns, without a session's
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

export { htmlLang }

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

const textRole = (role: string): string => role === 'waiting' ? 'waiting-text' : role
const roleOf = (status: ProgressStepStatus): string => textRole(stepRole(status))
const toneVar = (tone: Parameters<typeof toneRole>[0]): string => textRole(toneRole(tone))
const askVar = (kind: Parameters<typeof askRole>[0]): string => textRole(askRole(kind))

const bar = (done: number, total: number): string => {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  return `<span class="bar"><span style="width:${percent}%;background:var(--${done === total && total > 0 ? 'done' : 'accent'})"></span></span>`
}

// The id the agent row and the filter use for an agent: its lower-case name, Claude Code for none, own for a hand-kept task.
const idOf = (agent: string, isOwn: boolean): string => (isOwn ? 'own' : agent.trim().toLowerCase() || 'claude')

const waitingItem = (item: WaitingItem, s: Strings): string =>
  `<div class="ask" data-agent="${esc(idOf(item.agent, item.where === 'manual'))}"><div><span class="kind" style="color:var(--${askVar(item.kind)})">${esc(s.ask[item.kind])}</span>` +
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
    `<details class="row" data-key="${esc(it.key)}" data-agent="${esc(idOf(it.agent, it.auto === null))}"><summary><span class="title">${esc(it.title)}</span>` +
    `<span class="tail" style="color:var(--${it.due === null ? 'muted' : toneVar(it.due.tone)})">${esc(it.due === null ? `${it.done}/${it.total}` : it.due.left)}</span>` +
    `<span class="meta" style="color:var(--${toneVar(it.tone)})">${agentMark(it.agent, it.auto === null)}${bar(it.done, it.total)} ${esc(meta.join(' · '))}</span></summary>` +
    (it.runs === undefined ? '' : `<p class="quiet">${esc(it.runs)}</p>`) +
    (it.context === '' ? '' : `<p class="quiet">${esc(s.contextLine(it.context))}</p>`) +
    steps(it.steps) +
    '</details>'
  )
}

const section = (id: string, title: string, count: number, tone: string, hint: string, body: string, isOpen: boolean): string =>
  count === 0
    ? ''
    : `<details class="section" data-key="section:${id}"${isOpen ? ' open' : ''}><summary><span class="title">${esc(title)}</span>` +
      `<span class="count" style="color:var(--${textRole(tone)})">${count}</span>${hint === '' ? '' : `<span class="quiet">${esc(hint)}</span>`}</summary>${body}</details>`


type Chip = { id: string; name: string; needs: number; working: number; isUnreadable: boolean }

// The row of agent icons: one button per agent on the board and one for the person's own to-dos, each with
// the number of questions waiting on the person and a dot when it worked in the last 30 minutes. Pressing
// one filters the page to that agent (the script below); the name is the button's label.
const chipRow = (chips: readonly Chip[], s: Strings): string =>
  chips.length === 0
    ? ''
    : `<nav class="agents" id="agents" aria-label="${esc(s.pgAgents)}"><div class="col agents-in">${chips
        .map(chip => {
          const parts = [chip.needs > 0 ? s.pgTipNeeds(chip.needs) : '', chip.working > 0 ? s.pgTipWorking(chip.working) : '', chip.isUnreadable ? s.pgTipCantRead : ''].filter(part => part !== '')
          const label = `${chip.name}: ${parts.length > 0 ? parts.join(', ') : s.pgChipEmpty}`
          const badge = chip.isUnreadable ? '<span class="badge bad">!</span>' : chip.needs > 0 ? `<span class="badge">${chip.needs}</span>` : ''
          return `<button type="button" class="chip${chip.working > 0 ? ' working' : ''}" data-agent="${esc(chip.id)}" aria-pressed="false" aria-label="${esc(label)}" title="${esc(label)}">${agentMark(chip.id === 'own' ? '' : chip.id, chip.id === 'own')}<span class="c-name">${esc(chip.name)}</span>${badge}</button>`
        })
        .join('')}</div><div class="col agent-note" id="agent-note"></div></nav>`

// The page's own rules over the shared tokens, agent row and sheet. No text is below 14px; the row of
// agent icons is the only thing that scrolls sideways.
const DASH_CSS = `
html{scrollbar-gutter:stable}
body{overflow-wrap:anywhere}
.col{width:100%;max-width:808px;margin:0 auto;padding-left:max(var(--s5),env(safe-area-inset-left,0px));padding-right:max(var(--s5),env(safe-area-inset-right,0px))}
.head .topbar{flex-wrap:nowrap;min-height:56px;padding-block:0;gap:var(--s3)}
.brand{flex-wrap:wrap;gap:0 var(--s3)}
.brand .meta{font-size:var(--text-xs)}
button{font:inherit}
${agentRowCss}
${sheetCss}
main{display:flex;flex-direction:column;gap:var(--s6);padding-top:var(--s5);padding-bottom:var(--s6);min-width:0}
a{color:var(--accent)}
.quiet{margin:0;color:var(--muted)}
.t-alert{color:var(--alert)}
.link{border:0;background:none;padding:0;min-height:var(--hit);color:var(--accent);font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.sheet>.ask,.sheet>.quiet,.sheet>.empty{margin:0;padding:var(--s4)}
.sheet>.ask+.ask{border-top:1px solid var(--line)}
.sheet>details.section{border-width:1px 0 0;border-radius:0}
.empty{color:var(--muted)}
.ask{display:grid;gap:var(--s1);min-width:0}
.ask .where{color:var(--muted);display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap}
.kind{font-size:var(--text-xs);font-weight:600;margin-right:var(--s2)}
code{display:block;max-width:100%;overflow-x:auto;white-space:pre;font:var(--text-xs)/1.5 var(--font-mono);padding:6px var(--s2);border:1px solid var(--line);border-radius:var(--radius-s);background:var(--inset);color:var(--ink)}
details.section{border-top:1px solid var(--line-strong)}
details.section>summary{padding:var(--s3) 0}
summary{cursor:pointer;display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--s1) var(--s3);list-style:none;min-height:var(--hit)}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸";color:var(--muted)}
details[open]>summary::before{content:"▾"}
summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.section>summary .title{font-size:var(--text-lg);line-height:1.4;font-weight:600}
.section>summary .count{font-size:var(--text-xs);font-variant-numeric:tabular-nums}
.section>p,.section>.group{margin:0 0 var(--s3)}
.group h3{margin:var(--s3) 0 var(--s2);font-size:var(--text-xs);font-weight:600;color:var(--muted);display:flex;flex-wrap:wrap;gap:var(--s1) var(--s3)}
.group h3 span{font-weight:400}
details.row{border-top:1px solid var(--line)}
details.row>summary{padding:var(--s3) var(--s2);align-items:center}
.row .title{flex:1 1 12em;min-width:0;font-size:var(--text-md);line-height:1.4;font-weight:600}
.row .tail{font-size:var(--text-xs);font-variant-numeric:tabular-nums}
.row .meta{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2);min-width:0;padding-left:var(--s4)}
.bar{display:inline-block;width:52px;height:4px;border-radius:var(--radius-round);background:var(--frame);overflow:hidden;flex:none}
.bar span{display:block;height:100%}
.row>p,.row>.steps{margin:0 var(--s2) var(--s3)}
.steps{list-style:none;margin:0;padding:0;display:grid;gap:var(--s1)}
.steps li{display:grid;grid-template-columns:2ch 22px minmax(0,1fr);column-gap:var(--s2);align-items:baseline}
.steps .n{color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.steps .g{text-align:center}
.steps .now .t{font-weight:600}
.steps .note{grid-column:3}
.working-empty{margin:0;color:var(--muted)}
.sec-title{margin:0 0 var(--s2);font-size:var(--text-lg);line-height:1.4;font-weight:600;display:flex;gap:var(--s3);align-items:baseline}
.sec-title .count{font-size:var(--text-xs);color:var(--muted);font-weight:400;font-variant-numeric:tabular-nums}
.rows{border-top:1px solid var(--line-strong)}
footer{color:var(--muted);display:grid;gap:var(--s1);border-top:1px solid var(--line);padding-top:var(--s4)}
.legend{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4)}
@media (max-width:640px){
  .col{padding-left:max(var(--s3),env(safe-area-inset-left,0px));padding-right:max(var(--s3),env(safe-area-inset-right,0px))}
  .head{position:static}
  .agents{top:0}
  main{gap:var(--s5);padding-top:var(--s4)}
}
`

export const dashboardHtml = (view: View, s: Strings, path: string, stamp: string, pending: readonly PendingTurn[] = [], now: number = Date.now()): string => {
  pending = view.hasPendingQuestions ? pending.filter(turn => !turn.isQuestion) : pending
  const model = serveModel(view, pending, s, new Set(), false, undefined, false, { now, repoOf: () => null, versions: { board: '', package: null }, unreadable: view.unreadable ?? [] })
  const grouped = model.view
  const byKey = new Map<string, TaskRow>([...view.active, ...view.due].map(it => [it.key, it]))
  const working = (grouped?.working ?? []).map(ref => byKey.get(ref.sourceKey ?? ref.key)).filter((it): it is TaskRow => it !== undefined)
  const workingKeys = new Set(working.map(it => it.key))
  const questions = pending.filter(turn => turn.isQuestion)
  const nearest = view.due[0]
  const chips: Chip[] = [
    ...(Object.values(grouped?.own.counts ?? {}).some(count => count > 0) ? [{ id: 'own', name: s.pgOwn, needs: grouped?.own.counts.needs ?? 0, working: 0, isUnreadable: false }] : []),
    ...(grouped?.agents ?? []).map(one => ({ id: one.agent, name: agentLabel(one.agent, s) || one.agent, needs: one.counts.needs, working: (grouped?.working ?? []).filter(ref => ref.agent === one.agent).length, isUnreadable: one.isUnreadable })),
  ]
  const names = Object.fromEntries(chips.map(chip => [chip.id, chip.name]))
  const inbox = pending.length === 0 ? '' : `<p class="quiet">${esc(s.dashInboxHint)}</p>` + pending.map(turn =>
    `<div class="ask" data-agent="${esc(idOf(turn.agent, false))}"><div class="where">${agentMark(turn.agent)}${esc([turn.project, turn.agent].filter(part => part !== '').join(' · '))}</div>` +
    `<div><span style="color:var(--${turn.isQuestion ? 'waiting-text' : 'accent'})">${turn.isQuestion ? '●' : '◐'}</span> ${turn.isQuestion ? esc(clip(turn.text, 200)) : ''}</div></div>`,
  ).join('')
  const needsN = view.waiting.length + questions.length
  const older = (view.older ?? []).slice(0, OLDER_SHOWN).map(item => waitingItem(item, s)).join('') + ((view.older?.length ?? 0) > OLDER_SHOWN ? `<details class="more" data-key="older:more"><summary>${esc(s.showAllQuestions(view.older!.length))}</summary>${view.older!.slice(OLDER_SHOWN).map(item => waitingItem(item, s)).join('')}</details>` : '')
  const dueRows = view.due.filter(it => !workingKeys.has(it.key))
  const groups = view.groups.map(group => ({ ...group, rows: group.rows.filter(it => !workingKeys.has(it.key)) })).filter(group => group.rows.length > 0)
  const projects = groups.reduce((n, group) => n + group.rows.length, 0)
  const noteRows = chips.filter(chip => chip.isUnreadable).map(chip => `<p data-agent="${esc(chip.id)}">${esc(s.pgUnreadable(chip.name))}</p>`).join('')
  const doneRows = `<ul class="steps">${view.recent.map(item => `<li><span></span><span style="color:var(--done)">✓</span><span class="quiet">${esc([item.project, item.title, item.when].filter(part => part !== '').join(' · '))}${(item.questions ?? []).map(question => `<br>${esc([question.text, question.note].filter(Boolean).join(' — '))}`).join('')}</span></li>`).join('')}</ul>`
  const literal = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c')
  const script = DASH_SCRIPT.replace('__NAMES__', () => literal(names)).replace('__NONE__', () => literal(s.pgNoQuestions('\u0001'))).replace('__NOTHING__', () => literal(s.nothingForYou))

  return `<!doctype html>
<html lang="${htmlLang(s)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(s.paneTitle)} · Agent Board</title>
${faviconLink}
<script>${themeHead}</script>
<style>
${pageTokens('56px')}
${pageBaseCss}
${agentMarkCss()}
${DASH_CSS}
</style>
</head>
<body>
<header class="head" id="head"><div class="col topbar"><div class="brand">${boardMark}<h1>${esc(s.paneTitle)}</h1><span class="meta">${esc(stamp)}</span></div>${themeSwitch(s)}</div></header>
${chipRow(chips, s).replace('<div class="col agent-note" id="agent-note"></div>', `<div class="col agent-note" id="agent-note">${noteRows}</div>`)}
<main class="col">
${view.warning ? `<p role="status" class="t-alert">${esc(view.warning)}</p>` : ''}
${view.details ? `<p class="quiet">${esc(view.details)}</p>` : ''}
${view.pruned ? `<p role="status" class="quiet">${esc(view.pruned)}</p>` : ''}
<section class="needs-wrap" id="dash-needs"><div class="sheet-tab"><h2 class="flag">${esc(s.pgNeeds)}<b id="needs-n">${needsN}</b></h2></div>
<div class="sheet">
<p class="empty" id="needs-empty"${needsN > 0 ? ' hidden' : ''}>${esc(s.nothingForYou)}</p>
${inbox}${view.waiting.map(item => waitingItem(item, s)).join('')}
${(view.stoppedAsking ?? 0) > 0 ? `<p class="quiet"><button type="button" class="link" data-section="dash-older">${esc(s.stoppedAsking(view.stoppedAsking!))}</button></p>` : ''}
${section('reminder', s.sectionQuestionReminders, view.reminder?.length ?? 0, 'muted', s.questionAgingHint, (view.reminder ?? []).map(item => waitingItem(item, s)).join(''), false)}
${section('older', s.sectionOlderQuestions, view.older?.length ?? 0, 'muted', s.questionAgingHint, older, false)}
</div></section>
${view.hidden.length === 0 ? '' : `<p class="quiet">${esc(s.hiddenCount(view.hidden.length))}</p>`}
<section class="sec" id="dash-working"><h2 class="sec-title">${esc(s.pgWorking)}<span class="count">${working.length}</span></h2>${working.length === 0 ? `<p class="working-empty">${esc(s.pgNoWorking)}</p>` : `<div class="rows">${working.map(it => row(it, s, true)).join('')}</div>`}</section>
${section('due', s.sectionDue, dueRows.length, 'soon', nearest === undefined ? '' : s.nearestDue(nearest.title, nearest.due?.left ?? ''), dueRows.map(it => row(it, s, true)).join(''), false)}
${section(
  'others',
  s.sectionActive,
  projects,
  'accent',
  groups.map(group => group.project).join(s.listSep),
  groups.map(group => `<div class="group"><h3>${esc(group.project)}<span>${esc(group.summary)}</span></h3>${group.rows.map(it => row(it, s, false)).join('')}</div>`).join(''),
  true,
)}
${view.idle.length === 0 ? '' : `<details class="section" data-key="section:idle"><summary><span class="quiet">${esc(s.idleCount(view.idle.length))}</span></summary>${view.idle.map(it => row(it, s, true)).join('')}</details>`}
${view.stopped.length === 0 ? '' : `<details class="section" data-key="section:stopped"><summary><span class="quiet">${esc(s.stoppedCount(view.stopped.length))}</span></summary>${view.stopped.map(it => row(it, s, true)).join('')}</details>`}
${view.background === undefined ? '' : `<p class="quiet">${esc(view.background)}</p>`}
${section('recent', s.pgDone, view.recent.length, 'done', '', doneRows, false)}
<footer><div class="legend">${LEGEND.map((status, index) => `<span><span style="color:var(--${roleOf(status)})">${GLYPH[status]}</span> ${esc(s.legendWords[index] ?? status)}</span>`).join('')}<span>${esc(s.legendDue)}</span></div>
<div>${esc(s.legendCleanup)}</div><div>${esc(s.progressFileShown)}</div></footer>
${(view.health?.length ?? 0) === 0 ? '' : `<details class="section sec" data-key="section:health"><summary><span class="title quiet">${esc(s.sectionHealth)}</span><span class="count" style="color:var(--muted)">${view.health!.length}</span></summary>${view.health!.map(line => `<p class="quiet">${esc(line)}</p>`).join('')}</details>`}
</main>
<script>${script}</script>
</body>
</html>
`
}

// Sections the person opened stay open, the agent filter is kept (as on the live page), and the page reloads
// itself every 30 seconds. The three __WORDS__ are filled in by dashboardHtml.
const DASH_SCRIPT = String.raw`
(function () {
  var key = 'progress-open';
  var open = {};
  var NAMES = __NAMES__;
  var NONE = __NONE__;
  var NOTHING = __NOTHING__;
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
  ${filterStore}
  var filter = savedFilter();
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip[data-agent]'));
  if (filter && !chips.some(function (chip) { return chip.getAttribute('data-agent') === filter; })) filter = '';
  function paint() {
    chips.forEach(function (chip) { chip.setAttribute('aria-pressed', String(chip.getAttribute('data-agent') === filter)); });
    document.querySelectorAll('main [data-agent], #agent-note [data-agent]').forEach(function (item) {
      item.hidden = !!filter && item.getAttribute('data-agent') !== filter;
    });
    document.querySelectorAll('main details.section, main .group').forEach(function (box) {
      var items = box.querySelectorAll('[data-agent]');
      box.hidden = !!filter && items.length > 0 && !Array.prototype.some.call(items, function (item) { return !item.hidden; });
    });
    var asks = Array.prototype.filter.call(document.querySelectorAll('.sheet > .ask'), function (item) { return !item.hidden; });
    document.getElementById('needs-n').textContent = String(asks.length);
    var empty = document.getElementById('needs-empty');
    empty.hidden = asks.length > 0;
    empty.textContent = filter ? NONE.split('\u0001').join(NAMES[filter] || filter) : NOTHING;
  }
  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var id = chip.getAttribute('data-agent');
      filter = filter === id ? '' : id;
      saveFilter(filter);
      paint();
    });
  });
  paint();
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
`
