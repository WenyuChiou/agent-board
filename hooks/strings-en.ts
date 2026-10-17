import type { AskKind } from './ask'
import type { Lang, Strings } from './i18n'

// English strings for the pane. Same keys, same order as ZH_TW in i18n.ts.

export const EN: Strings = {
  lang: 'en' as Lang,

  // Time and dates
  justNow: 'just now',
  minutesAgo: (n: number): string => `${n} min ago`,
  hoursAgo: (n: number): string => `${n} h ago`,
  yesterday: 'yesterday',
  daysAgo: (n: number): string => `${n} ${n === 1 ? 'day' : 'days'} ago`,
  overdue: (n: number): string => `${n} ${n === 1 ? 'day' : 'days'} overdue`,
  dueToday: 'due today',
  daysLeft: (n: number): string => `${n} ${n === 1 ? 'day' : 'days'} left`,

  // Where a task or step stands
  stuck: (text: string): string => `stuck: ${text}`,
  waitsOnYou: (text: string): string => `waiting on you: ${text}`,
  runningStep: (text: string): string => `running: ${text}`,
  doingStep: (text: string): string => `doing: ${text}`,
  nextStep: (text: string): string => `next: ${text}`,
  noSteps: 'no steps yet',
  suffixCancelled: ' (canceled)',
  suffixWaiting: ' (waiting on you)',
  suffixRunning: ' (running)',
  suffixBlocked: ' (stuck)',
  foldedDone: (n: number): string => `${n} ${n === 1 ? 'step' : 'steps'} done`,
  foldedRest: (n: number): string => `${n} ${n === 1 ? 'step' : 'steps'} left`,
  waitingReply: 'waiting on your reply',
  allDone: 'all done',
  claudeWorking: 'Claude is working',
  agentWorking: (agent: string): string => `${agent} is working`,
  sessionStopped: (when: string): string => `session stopped, last active ${when}`,
  sessionEnded: 'session ended, can be taken over',
  uncategorized: '(uncategorized)',
  unnamed: '(unnamed)',
  groupCount: (n: number): string => `${n} ${n === 1 ? 'item' : 'items'}`,
  groupWaiting: (n: number): string => `${n} waiting`,
  groupStuck: (n: number): string => `${n} stuck`,
  groupStopped: (n: number): string => `${n} stopped`,
  groupWorking: (n: number): string => `${n} working`,

  // The line under the prompt
  statusPrefix: 'Progress',
  statusWaiting: (n: number): string => `${n} waiting on you`,
  statusDue: (n: number): string => `${n} due soon`,

  // Pull requests
  ciPass: 'CI passed',
  ciFail: (n: number): string => (n > 0 ? `CI: ${n} failed` : 'CI failed'),
  ciPending: 'CI running',
  reviewApproved: 'approved',
  reviewChanges: 'changes requested',
  reviewRequired: 'waiting for review',
  prMerged: 'merged',
  prClosed: 'closed',
  prDraft: 'draft',

  // What a waiting step asks
  ask: {
    confirm: 'Confirm',
    choose: 'Choose',
    input: 'Input',
    do: 'Do',
    review: 'Review',
    wait: 'Waiting',
    reply: 'Reply',
  } as Record<AskKind, string>,
  chip: (word: string): string => `[${word}] `,
  answerText: (subject: string, answer: string): string => `About "${subject}": ${answer}`,

  // Desktop notifications
  noticeNeedsYou: (text: string): string => `Needs you: ${text}`,
  noticeAsked: (who: string, text: string): string => `${who} asks: ${text}`,
  noticeDue: (title: string, left: string): string => `Due: ${title} (${left})`,
  noticeDone: (title: string, n: number): string => `Done: ${title} (${n}/${n})`,
  noticeCi: (pr: number, words: string): string => `PR #${pr} ${words}`,
  notifyTitle: (project: string): string => `Progress · ${project}`,

  // Words written into progress.md and its archive and journal
  stateWorking: 'Claude is working',
  stateWaiting: 'waiting on your reply',
  stateDone: 'done',
  stateEnded: 'session ended, can be taken over',
  fileTitle: '# Project progress',
  contextNote: (text: string): string => `> Context: ${text}`,
  handoffNote: (text: string): string => `> Handoff: ${text}`,
  dueNote: (date: string): string => `> due ${date}`,
  archiveTitle: '# Progress archive',
  journalTitle: '# Work log',
  defaultProject: 'To do',

  // The report 週報 copies
  reportToday: (day: string): string => `Today's progress (${day})`,
  reportDays: (n: number, from: string, to: string): string =>
    `Progress over the last ${n} ${n === 1 ? 'day' : 'days'} (${from} – ${to})`,
  reportDone: 'Done',
  reportNone: '- (no finished steps in this period)',
  reportOpen: 'In progress',
  reportWaiting: 'Waiting on me',
  reportNext: (text: string): string => `next ${text}`,
  listSep: ', ',
  pairSep: ': ',

  // Quick add
  jobSteps: ['Update résumé', 'Write cover letter', 'Apply', 'Follow up'],
  quickAdded: (project: string, title: string, steps: number, due: string | null): string =>
    `Added to "${project}": ${title} (${steps} ${steps === 1 ? 'step' : 'steps'}${due === null ? '' : `, due ${due}`})`,
  quickEmpty: 'What to add? For example: "+ Job search: Google internship due 11-01; update résumé; apply".',
  quickUnreadable: "Can't read the progress file, so nothing was added.",

  // Text sent to Claude (or to Haiku), in the person's language
  namePrompt: (request: string, steps: string): string =>
    `User request:\n${request}\n\nSteps:\n${steps}\n\n` +
    'Reply with two lines, in English, no quotes:\n' +
    'Line 1: a title for this piece of work, 3 to 7 words, naming what it should produce. No punctuation.\n' +
    'Line 2: one sentence of background, under 20 words, for someone who has not seen this conversation: why it is being done and what it will lead to.',
  digestPrompt: (goal: string, prompt: string, answer: string, title: string, context: string, steps: string): string =>
    `What the user first asked for:\n${goal}\n\nWhat the user said this turn:\n${prompt}\n\nThe AI's last reply this turn:\n${answer}\n\n` +
    `Current title: ${title || '-'}\nCurrent background: ${context || '-'}\nCurrent steps:\n${steps || '-'}\n\n` +
    'Reply with exactly these five lines, in English, no quotes, - when there is nothing:\n' +
    'TITLE: a title for the work, 3 to 7 words, naming what it should produce; copy the current one if the goal has not changed\n' +
    'CONTEXT: one sentence of background, under 20 words: why and what it leads to; copy the current one if the goal has not changed\n' +
    'DONE: what this turn finished, under 10 words; - if it only answered a question\n' +
    'NEXT: the next step, under 10 words; - if everything is done\n' +
    'ASK: what the AI is waiting for the user to answer or do, as "short label — the question as asked"; - if nothing',
  refreshPrompt: (request: string, steps: string, title: string, context: string): string =>
    `User request:\n${request}\n\nSteps:\n${steps}\n\nCurrent title: ${title}\nCurrent background: ${context || '-'}\n\n` +
    'Reply with two lines, in English, no quotes. Copy the current two lines if the goal has not changed:\n' +
    'Line 1: a title for this piece of work, 3 to 7 words, naming what it should produce. No punctuation.\n' +
    'Line 2: one sentence of background, under 20 words: why it is being done and what it will lead to.',
  handoffPrompt: (title: string, summary: string): string =>
    `Below is the compacted summary of an AI coding session working on "${title}":\n\n${summary}\n\n` +
    'Write one handoff line for whoever takes over, in English, under 30 words: what is done, what is stuck (skip if nothing), the next step. No quotes.',
  asideSuffix: '(Side-pane question: answer in English in three sentences or fewer, and do not change any files.)',
  asideNotStarted: "This session hasn't started yet. Say something to Claude first, then ask.",
  asideFailed: "Couldn't get an answer. Try again.",
  resumeHead: '[Progress pane] The conversation was just compacted. Progress before compaction (synced from the Task list):',
  resumeGoal: (title: string, project: string): string => `goal: ${title} (${project})`,
  resumeContext: (text: string): string => `context: ${text}`,
  resumeDone: (done: number, total: number): string => `done ${done}/${total}`,
  resumeDoing: (text: string): string => `doing: ${text}`,
  resumeNext: (list: string): string => `next: ${list}`,
  resumeWaiting: (list: string): string => `waiting on the user or stuck: ${list}`,
  resumeTail: 'First check the latest state with TaskList, then pick up at the "doing" step. Do not rebuild tasks that already exist.',
  compactKeep: 'Keep the status of each step on the Task list, especially the step in progress and the steps not started yet.',
  othersHead: '[Progress pane] This project has work from other sessions in progress.md:',
  othersEnded: (title: string, step: string, done: number, total: number): string =>
    `- "${title}" session ended, stopped at: ${step} (done ${done}/${total})`,
  othersHeld: (title: string, done: number, total: number): string => `- "${title}" is being handled in another session (done ${done}/${total})`,
  othersTail: 'Take over only when the user asks to continue. When you take over, rebuild the remaining steps with TaskCreate. Do not redo what another session is handling.',
  none: '(none)',
  takeOverHead: (title: string, project: string, done: number, total: number): string =>
    `Take over "${title}" (${project}; the earlier session did not finish, done ${done}/${total}).`,
  takeOverLeft: (list: string): string => `left: ${list}`,
  takeOverHandoff: (text: string): string => `Handoff: ${text}`,
  takeOverTail: 'First rebuild the remaining steps with TaskCreate, then start from the first unfinished one.',
  handOverHead: (title: string, project: string): string => `Help me with "${title}" (${project}).`,
  handOverContext: (text: string): string => `context: ${text}.`,
  handOverNext: (step: string): string => `The next step is "${step}".`,
  handOverTail: 'The section for this task in progress.md is the current state. Tick each step there when it is done.',
  continueText: 'continue',
  stepSep: '; ',

  // /progress
  commandDescription: 'Agent Board: show the pane; open (the web page), connect (other agents), tidy, sync, add …, report, today, notify on|off, lang en|zh-TW|zh-CN',
  commandHint: '[open|connect|tidy|sync|add …|report|today|notify on|off|lang …]',
  tidyUnreadable: "Can't read the progress or archive file. No files were changed.",
  tidyNothing: 'Nothing to archive.',
  tidyMoved: (n: number): string => `Archived ${n} finished ${n === 1 ? 'task' : 'tasks'}.`,
  synced: 'Re-synced from the Task list.',
  copiedSuffix: ' (copied to clipboard)',
  notifyOn: 'Desktop notifications on: when something needs you, another session asks, work is due, work is done, or CI finishes.',
  notifyOff: 'Desktop notifications off.',
  paneOpened: (path: string): string => `Progress pane opened: ${path}`,
  paneNotOpened: (reason: string): string => `Couldn't open the progress pane: ${reason}`,
  connectDone: (list: string): string => `Connected: ${list}. After you restart them, every turn they finish reports to the pane.`,
  connectNone: 'No agent to connect was found (Codex, Gemini CLI, Cursor, OpenCode, Grok Build, Muse Code).',
  connectCodexTrust: 'Codex runs a new hook only after you approve it once in its /hooks.',
  connectSkipped: (name: string, path: string): string => `Could not read ${name}'s config, so it was left alone: ${path}`,
  connectRemoved: (list: string): string => `Disconnected: ${list}.`,
  connectNothingRemoved: 'No agent was connected.',
  langSet: 'The pane now speaks English.',
  langUnknown: 'Supported languages: en, zh-TW, zh-CN, auto.',

  // The pane
  paneTitle: 'Progress',
  legendWords: ['Done', 'Doing', 'To do', 'Waiting on you', 'Running', 'Stuck', 'Canceled'],
  now: ' ← now',
  replyElsewhere: (project: string, agent: string): string =>
    `Reply in the ${project} session${agent === '' ? '' : ` (${agent})`}. Can't reply from here.`,
  arrivedDone: 'It arrived, done',
  done: 'Done',
  reply: 'Reply',
  yes: 'Yes',
  yesAnswer: 'Yes, go ahead',
  no: 'No',
  noAnswer: 'No, hold off',
  noneOfThese: 'None of these? Type a reply',
  copyCommand: 'Copy command',
  didIt: 'Did it',
  openLink: 'Open it',
  looksGood: 'Looks good',
  looksGoodAnswer: 'Reviewed, looks good',
  whatToChange: 'What should change?',
  ready: 'Ready',
  readyAnswer: 'Ready, go on',
  replyPlaceholder: 'Reply to Claude…',
  contextLine: (text: string): string => `Context: ${text}`,
  handoffLine: (text: string): string => `Handoff: ${text}`,
  continueElsewhere: (project: string): string => `Continue in the ${project} session.`,
  heldElsewhere: 'Another session is working on it.',
  takeOver: 'Take over and finish',
  copyResume: 'Copy resume command',
  tickStep: 'Mark step done',
  handOver: 'Hand to Claude',
  nothingForYou: '✓ Nothing needs you right now',
  mostNeeded: 'Needs you now',
  stuckLead: '! Stuck',
  moreWaiting: (n: number): string => `${n} more waiting on you ▸`,
  countWaiting: 'waiting',
  countActive: 'in progress',
  countDue: 'due soon',
  countToday: 'done today',
  nowStep: (text: string): string => `▸ now: ${text}`,
  nextStepLine: (text: string): string => `○ next: ${text}`,
  foldSteps: '▾ Hide steps',
  allSteps: (n: number): string => `▸ All ${n} ${n === 1 ? 'step' : 'steps'}`,
  noTaskTools: "This session has no Task tools, so progress won't sync automatically.",
  noTaskToolsHow:
    'For claude started from a terminal: add CLAUDE_CODE_ENABLE_TODO_TOOLS=1 to your shell profile ($PROFILE in PowerShell; re-running the setup script adds it), then start it in a new window. Not in settings.json: its env also reaches the desktop app.',
  noTaskToolsManual: 'Sessions without it, like the desktop app or git-bash, keep progress.md by hand.',
  empty: 'No work in progress right now.',
  emptyHow: 'Once Claude starts on a Task list, it shows up here. You can also type "+ project: thing to do" below to add one.',
  sectionWaiting: 'Waiting on you',
  sectionDue: 'Due soon',
  nearestDue: (title: string, left: string): string => `nearest: ${title} ${left}`,
  sectionActive: 'In progress',
  sectionOther: 'Other open work',
  thisProject: (name: string): string => `${name} (this project)`,
  sectionRecent: 'Done recently',
  archiveNow: 'Archive now',
  archiveThis: 'Archive',
  archivedOne: (title: string): string => `Archived “${title}”.`,
  archiveGone: 'Could not find that task; it may have changed or been archived already.',
  askPlaceholder: 'Ask something; start with + to add a task',
  send: 'Send',
  question: (text: string): string => `Q: ${text}`,
  thinking: 'Thinking…',
  copied: 'Copied to clipboard',
  clear: 'Clear',
  report: 'Weekly report',
  notifyOnButton: 'Notifications: on',
  notifyOffButton: 'Notifications: off',
  legend: 'Legend',
  legendClose: 'Hide legend',
  legendDue: '⚑ due within two weeks',
  legendAsk: '[Confirm] yes or no · [Choose] pick an option · [Input] type a reply · [Do] press "Did it" when finished · [Review] reply once you have looked · [Waiting] press once it arrives',
  legendCleanup: 'A session quiet for half a day counts as stopped. Finished work moves to the archive after half a day, stopped work after three days, and hand-written tasks a day after every step is ticked. Open a stopped session or a hand-written task and press Archive to move it now.',
  answered: (text: string): string => `Replied to Claude: ${text}`,
  commandOf: (step: string): string => `Command to run for "${step}"`,
  resumeOf: (title: string): string => `Command to resume "${title}". Paste it into the terminal and run it.`,
  fileUnreadable: "Can't read the progress file",
  dashStamp: (time: string): string => `updated ${time}`,
  windowOpened: (path: string): string => `Opened in your browser: ${path}`,
  windowFailed: (path: string): string => `Couldn't open a browser; open it yourself: ${path}`,
}
