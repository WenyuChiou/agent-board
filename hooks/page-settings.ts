import type { SettingsLang } from './board-settings'
import type { Strings } from './i18n'
import { themeControls } from './page-look'

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

export const settingsToggle = (s: Strings): string => `<button type="button" class="icon-btn" id="settings-toggle" data-local data-settings-toggle aria-haspopup="dialog" aria-expanded="false" aria-controls="settings"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 1.5h3l.5 2 1 .6 2-.6 1.5 2.6-1.5 1.4v1l1.5 1.4-1.5 2.6-2-.6-1 .6-.5 2h-3l-.5-2-1-.6-2 .6L1.5 10 3 8.5v-1L1.5 6 3 3.5l2 .6 1-.6z"/><circle cx="8" cy="8" r="2.2"/></svg><span>${esc(s.settingsTitle)}</span></button>`

export const settingsPanel = (s: Strings, language: SettingsLang, isLan = false): string =>
  `<div id="settings" class="settings-overlay" data-lan="${isLan}" role="dialog" aria-modal="true" aria-labelledby="settings-title" hidden><div class="settings-panel">` +
  `<div class="settings-head"><h2 id="settings-title">${esc(s.settingsTitle)}</h2><button type="button" class="icon-btn" id="settings-close" data-local aria-label="${esc(s.settingsClose)}"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>` +
  `<section><h3><label for="settings-lang">${esc(s.settingsLanguage)}</label></h3><select id="settings-lang" data-local>` +
  (['auto', 'en', 'zh-TW', 'zh-CN'] as const).map(lang => `<option value="${lang}"${language === lang ? ' selected' : ''}>${esc(lang === 'auto' ? s.settingsAutomatic : lang === 'en' ? s.settingsEnglish : lang === 'zh-TW' ? s.settingsTraditional : s.settingsSimplified)}</option>`).join('') +
  `</select></section><section><h3>${esc(s.themeMenu)}</h3>${themeControls(s)}</section>` +
  `<section id="settings-notifications"><h3>${esc(s.settingsNotifications)}</h3><button type="button" id="settings-notify" data-local role="switch" aria-checked="false" aria-label="${esc(s.settingsNotifications)}">${esc(s.settingsOff)}</button></section>` +
  `<p id="settings-result" role="status" aria-live="polite" aria-atomic="true"></p></div></div>`

export const settingsCss = `
.settings-overlay{position:fixed;inset:0;z-index:40;display:grid;place-items:center;padding:16px;background:rgb(0 0 0 / .35)}
.settings-panel{width:100%;max-width:420px;max-height:calc(100dvh - 32px);overflow-y:auto;min-width:0;background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius-m);padding:var(--s4);box-shadow:0 8px 40px rgb(0 0 0 / .15)}
.settings-head{display:flex;align-items:center;justify-content:space-between;gap:var(--s2)}
.settings-head h2{margin:0;font-size:var(--text-lg)}
.settings-panel h3{margin:0 0 var(--s2);font-size:var(--text-md)}
.settings-panel section{padding-block:var(--s4);border-bottom:1px solid var(--line)}
.settings-panel button,.settings-panel select{min-width:48px;min-height:48px;max-width:100%;font:inherit}
.settings-panel select{width:100%;padding:0 var(--s2);background:var(--surface);color:var(--ink);border:1px solid var(--btn-line);border-radius:var(--radius-s)}
.settings-choices{display:flex;flex-wrap:wrap;gap:var(--s2)}
.settings-choices button,#settings-notify{display:flex;align-items:center;gap:var(--s2);padding:var(--s2) var(--s3);background:var(--surface);border:1px solid var(--btn-line);border-radius:var(--radius-s);cursor:pointer}
.settings-choices button[aria-checked="true"],#settings-notify[aria-checked="true"]{background:var(--current);border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
.settings-label{margin:var(--s3) 0 var(--s2);color:var(--muted)}
#settings-result{margin:var(--s3) 0 0;min-height:1.5em}
#settings-result.alert{color:var(--alert)}
`

// Runs inside the page's existing closure, sharing its authenticated calls and card model.
export const settingsScript = String.raw`
  var settings = document.getElementById('settings');
  var isLan = settings.getAttribute('data-lan') === 'true';
  var settingsButton = document.getElementById('settings-toggle');
  var settingsResult = document.getElementById('settings-result');
  var settingsLanguage = document.getElementById('settings-lang');
  var languageKept = settingsLanguage.value || 'auto';
  var notifyButton = document.getElementById('settings-notify');
  var notificationType = typeof Notification === 'function' && typeof Notification.requestPermission === 'function' && (!isLan || window.isSecureContext !== false) ? Notification : null;
  var notificationsOn = false;
  var permissionAsked = false;
  var notified = new Set();
  var notificationModel = null;
  try {
    notificationsOn = localStorage.getItem('agent-board.notifications') === 'on';
    permissionAsked = localStorage.getItem('agent-board.notification-permission') === 'asked';
    var seen = JSON.parse(localStorage.getItem('agent-board.notified') || '[]');
    if (Array.isArray(seen)) seen.forEach(function (key) { if (typeof key === 'string') notified.add(key); });
  } catch (error) {}
  function settingsSay(text, isError) {
    settingsResult.textContent = text;
    settingsResult.className = isError ? 'alert' : '';
  }
  function openSettings() {
    settings.hidden = false;
    settingsButton.setAttribute('aria-expanded', 'true');
    document.getElementById('shell').inert = true;
    document.getElementById('settings-close').focus();
  }
  function closeSettings() {
    settings.hidden = true;
    settingsButton.setAttribute('aria-expanded', 'false');
    document.getElementById('shell').inert = false;
    settingsButton.focus();
  }
  settingsButton.addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  settings.addEventListener('click', function (event) { if (event.target === settings) closeSettings(); });
  document.addEventListener('keydown', function (event) {
    if (settings.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeSettings(); return; }
    var active = document.activeElement;
    if (event.key === 'Tab') {
      var controls = Array.prototype.slice.call(settings.querySelectorAll('button, select')).filter(function (one) { return !one.disabled && !one.closest('[hidden]'); });
      var at = controls.indexOf(active);
      if (at < 0 || event.shiftKey && at === 0 || !event.shiftKey && at === controls.length - 1) {
        event.preventDefault();
        var next = controls[event.shiftKey ? controls.length - 1 : 0];
        if (next) next.focus();
      }
    }
    if (active && active.getAttribute('role') === 'radio' && ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].indexOf(event.key) !== -1) {
      var radios = Array.prototype.slice.call(active.parentNode.querySelectorAll('[role="radio"]'));
      var step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : radios.length - 1;
      var radio = radios[(radios.indexOf(active) + step) % radios.length];
      if (radio) { event.preventDefault(); radio.focus(); radio.click(); }
    }
  });
  document.querySelectorAll('[data-theme-set]').forEach(function (node) {
    node.addEventListener('click', function () { settingsSay(node.getAttribute('data-changed')); });
  });
  settingsLanguage.addEventListener('change', function () {
    var lang = settingsLanguage.value;
    settingsLanguage.disabled = true;
    call('/api/language', { lang: lang }).then(function (data) {
      if (!data.ok) { settingsLanguage.value = languageKept; settingsSay(data.note || w('pressFailed'), true); return; }
      languageKept = lang;
      settingsSay(data.note);
      try { sessionStorage.setItem('agent-board.settings-changed', 'language'); } catch (error) {}
      window.location.reload();
    }, function () { settingsLanguage.value = languageKept; settingsSay(w('pressFailed'), true); }).finally(function () { settingsLanguage.disabled = false; });
  });
  try {
    if (sessionStorage.getItem('agent-board.settings-changed') === 'language') {
      sessionStorage.removeItem('agent-board.settings-changed');
      openSettings();
      settingsSay(w('settingsLanguageChanged'));
    }
  } catch (error) {}
  function notificationState() {
    if (!notificationType || notificationType.permission !== 'granted') notificationsOn = false;
    notifyButton.setAttribute('aria-checked', String(notificationsOn));
    notifyButton.textContent = w(notificationsOn ? 'settingsOn' : 'settingsOff');
    try { localStorage.setItem('agent-board.notifications', notificationsOn ? 'on' : 'off'); } catch (error) {}
  }
  function notifyWaiting(model) {
    notificationModel = model;
    if (!notificationsOn || !notificationType || notificationType.permission !== 'granted') return;
    (model.asks || []).forEach(function (ask) {
      if (ask.isOwn || ask.isSending || ask.receipt && ask.receipt.canHide) return;
      var key = JSON.stringify([ask.agent, ask.questionId || ask.key, ask.text]);
      if (notified.has(key)) return;
      try {
        var notice = new notificationType(ask.text, { body: agentName(ask.agent), tag: key });
        notice.onclick = function () { window.focus(); notice.close(); };
        notified.add(key);
        try { localStorage.setItem('agent-board.notified', JSON.stringify(Array.from(notified))); } catch (error) {}
      } catch (error) { settingsSay(w('settingsUnavailable'), true); }
    });
  }
  notificationState();
  if (!notificationType) {
    if (isLan) document.getElementById('settings-notifications').hidden = true;
    else { notifyButton.disabled = true; notifyButton.title = w('settingsUnavailable'); }
  }
  notifyButton.addEventListener('click', function () {
    if (notificationsOn) { notificationsOn = false; notificationState(); settingsSay(w('settingsChanged', w('settingsNotifications'), w('settingsOff'))); return; }
    if (!notificationType) return;
    notifyButton.disabled = true;
    var permission;
    if (notificationType.permission === 'default' && !permissionAsked) {
      permissionAsked = true;
      try { localStorage.setItem('agent-board.notification-permission', 'asked'); } catch (error) {}
      try { permission = notificationType.requestPermission(); } catch (error) { permission = Promise.reject(error); }
    } else permission = Promise.resolve(notificationType.permission);
    Promise.resolve(permission).then(function (value) {
      notificationsOn = value === 'granted';
      notificationState();
      settingsSay(value === 'denied' ? w('settingsDenied') : w('settingsChanged', w('settingsNotifications'), w(notificationsOn ? 'settingsOn' : 'settingsOff')), value === 'denied');
      if (notificationModel) notifyWaiting(notificationModel);
    }, function () { notificationsOn = false; notificationState(); settingsSay(w('settingsUnavailable'), true); }).finally(function () { notifyButton.disabled = false; });
  });
`
