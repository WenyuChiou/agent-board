// done [x] · doing [~] · todo [ ] · waiting [?] (on you) · running [>] (CI, a long run,
// someone else) · blocked [!] · cancelled [-]
export type ProgressStepStatus = 'done' | 'doing' | 'todo' | 'waiting' | 'running' | 'blocked' | 'cancelled'

export type QuestionSource = {
  kind: 'block' | 'own' | 'manual' | 'inbox'
  project: string
  task: string
  context: string
  text: string
  agent: string
  session: string
  // Complete structured source, retained independently of display clipping.
  data: string
}

export type QuestionRecord = {
  producerRevisions?: string[]
  producerSources?: string[]
  id: string
  scope: string
  words: string
  occurrence: number
  copies: number
  isWaiting: boolean
  isPresent: boolean
  firstObserved: number
  incarnation: string
  producer?: string
  source?: QuestionSource
  isUnresolved?: boolean
  isArchived?: boolean
}

export type QuestionLedger = {
  version: 1
  next: number
  records: QuestionRecord[]
  legacy: Record<string, string>
}
export type QuestionProofs = { retired: string[]; consumed: string[] }

// `line` (0-based) and `raw` (the line as written) let a press tick exactly this line.
export type ProgressStep = { text: string; status: ProgressStepStatus; depth: number; line: number; raw: string; questionToken?: string }

// working: Claude is mid-turn · waiting: idle with open steps · done: every step done ·
// ended: the session closed with open steps
export type ProgressSessionState = 'working' | 'waiting' | 'done' | 'ended'

// A pull request's checks rolled into one word: none ran, some still running, all passed,
// or at least one failed.
export type ProgressCi = 'none' | 'pending' | 'pass' | 'fail'

// The pull request of a session's branch, as `gh pr view` reports it.
export type ProgressPr = {
  number: number
  url: string
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  ci: ProgressCi
  failed: number
  review: 'approved' | 'changes' | 'required' | null
}

// Present on a block a session's mod writes itself, between its auto markers. `resume` is
// the full session id and `dir` the folder it ran in, for a resume command; `pr` and `ci`
// say how its pull request stands.
export type ProgressAuto = {
  session: string
  // Which agent writes the block (`agent=`): claude when the marker names none.
  agent: string
  state: ProgressSessionState
  updated: number
  resume: string | null
  dir: string | null
  pr: number | null
  ci: ProgressCi | null
}

export type ProgressTask = {
  title: string
  // The `###` heading's line (0-based), -1 for steps written without one.
  line: number
  notes: string[]
  steps: ProgressStep[]
  auto: ProgressAuto | null
  due: string | null
}

export type ProgressProject = { name: string; tasks: ProgressTask[] }

export type ProgressTail = { offset: number; tasks: number; close: string | null }

export type ProgressSnapshot = {
  path: string
  isMissing: boolean
  error: string | null
  mtimeMs: number
  size: number
  projects: ProgressProject[]
  tornTail?: ProgressTail | null
}

// One task of Claude's own list (TaskCreate / TaskUpdate / TodoWrite), as the mod mirrors it.
export type ProgressMirrorTask = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
  waiting: 'you' | 'run' | null
  // What Claude needs from the person, or what it waits on, in one line (`metadata.why`).
  why: string | null
  // What kind of answer (`metadata.ask`: confirm, choose, input, do, review, wait), the
  // options to choose from, a command to run, a link to look at.
  ask: string | null
  options: string[]
  command: string | null
  link: string | null
  blocked: string | null
  blockedBy: string[]
  questionRevision?: string
  // A confirmed transfer reported by this task's owner, not a suggestion or a transport receipt.
  handoffTo?: string
}

export type ProgressMirror = {
  sessionId: string
  // Which agent's session this is: claude for the session the mod runs in; another agent's
  // when the mod writes that agent's block from what its hook reported.
  agent: string
  project: string
  // The folder the session runs in; empty in a mirror stored before 0.5.0.
  cwd: string
  branch: string
  pr: ProgressPr | null
  title: string
  // One line of background: why this work exists and what it should end up as.
  context: string
  isTitleFinal: boolean
  firstPrompt: string
  state: ProgressSessionState
  // Distinguishes an active turn from work continuing between turns.
  isTurnRunning?: boolean
  // Only ids and counts survive a turn; notification and command words do not.
  backgroundJobs?: number
  backgroundJobIds?: string[]
  backgroundReleases?: string[]
  backgroundReleaseCount?: number
  tasks: ProgressMirrorTask[]
  // Exact canceled text from an uncached completed block, outside completed-work counts.
  // A fresh producer mirror can supersede this snapshot without guessing a recipient.
  retainedCancelled?: string[]
  // Retained even after a task is deleted, so reusing its id cannot reuse an ask revision.
  questionSequence?: string
  updated: number
  // Where the steps come from: Claude's Task list, or each turn summed up when the session
  // has none (`turns`). A Task call replaces the summed-up steps.
  source: 'tasks' | 'turns'
  // A task the mod marked waiting because the turn ended on a question; cleared when the
  // person answers (the next turn starts).
  autoAsk: string | null
  // One line for whoever takes over, written at the last compaction.
  handoff: string
  // How many steps the list had when the title and background were last written.
  namedSteps: number
  // For another agent's session: the last reply summed up, so the same turn reported twice
  // (two hooks of one turn, or Grok running Cursor's hooks too) counts once.
  lastAnswer: string
  // For another agent's session: that agent's own session id, written as `resume=` so the
  // board's page can send a reply into the session once it has closed.
  resume?: string
  // For another agent's session: where the newest inbox file folded in falls (turnOrder), so
  // a file taken again after a later one changes nothing.
  turnOrder?: number
  // Newest prompt receipt, on the same binary timestamp scale as turnOrder. Kept
  // separately so adding prompt events never reinterprets saved turn/end ranks.
  promptOrder?: number
  // Existing question steps provisionally answered by the latest prompt, never prompt text.
  promptQuestion?: { order: number; state: ProgressSessionState; autoAsk: string | null; tasks: ProgressMirrorTask[] } | null
  // A person's completion rejects older (or undated) inbox turns without stopping new work.
  confirmedAt?: number
  // Claude's steps the person has answered since they were asked: task id to the stepKey of
  // the words they answered. A step stops waiting on them while its words match, until Claude
  // asks again (a TaskUpdate that sets waiting to the person, or a turn that ends on a
  // question) or its words change.
  answered?: Record<string, string>
}

// What the pane shows under its input box: a side question's answer, what a quick add
// wrote, or a report. `copied` says the text is also on the clipboard.
export type ProgressAnswer = { question: string; text: string; isAsking: boolean; copied?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'agent-board': {
      snapshot: ProgressSnapshot
      here: string[]
      mine: ProgressMirror | null
      now: number
      hasTaskTools: boolean
      expanded: string
      answer: ProgressAnswer | null
      isNotifyOn: boolean
      theme: string
      today: number
      isLegendOpen: boolean
      opened: string[]
      doneSeen: Record<string, number>
      hiddenAsks: string[]
      questionLedger: QuestionLedger
      hasQuestionsProblem: boolean
      hasPendingQuestionsProblem: boolean
      firstSeen: Record<string, number>
      revising: string
      lang: string
    }
  }
}
