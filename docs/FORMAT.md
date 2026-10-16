# progress.md format, version 1

`progress.md` is the one file the project-progress pane reads. Anything that can write a text file can put its work on the pane: Claude Code, Codex CLI, Gemini CLI, Cursor, Aider, Continue, a shell script, or a person with an editor.

This page says what the pane's parser accepts and what the pane's writer produces. It is written from the code (`hooks/parse.ts`, `hooks/blocks.ts`, `hooks/mirror.ts`, `hooks/ask.ts`, `hooks/journal.ts`, `hooks/view.ts`). Where this page and the code disagree, the code wins and this page has a bug.

In this page "must" and "should" are meant as in RFC 2119, and "the pane" means the project-progress mod.

Contents: [File](#file) · [Structure](#structure) · [Steps](#steps-and-marks) · [Tasks](#tasks) · [Agent blocks](#agent-blocks) · [Lifecycle](#lifecycle) · [Waiting steps](#waiting-steps-and-ask-kinds) · [Example](#worked-example) · [Checklist](#writing-a-block-from-another-agent) · [Versioning](#versioning)

## File

| | |
|---|---|
| Default path | `~/.claude/progress.md`. On Windows, `%USERPROFILE%\.claude\progress.md`. |
| Override | The environment variable `CLAUDE_PROGRESS_FILE`, a full path. No other variable moves the file. On Windows `USERPROFILE` is read before `HOME`. |
| Encoding | UTF-8. Do not write a byte order mark. |
| Line endings | LF or CRLF. Both are read. |
| Missing file | Read as empty. The first writer creates it. |
| Companions | The archive and journal files, in the same folder (see [Lifecycle](#lifecycle)). |

The pane checks the file's modification time and size every 2 seconds and parses it again when either changed.

**Line endings when writing.** Keep the style the file already has. When the pane rewrites the file it uses CRLF for every line if the file contains any CRLF, and LF otherwise, and it ends the file with a line break.

**Concurrent writers.** There is no lock. The pane reads the whole file, changes its own lines, writes the whole file, then reads it back and tries again (up to three times) if its block is not there. Other writers should do the same: read right before you write, change only your lines, write, and read back. If you can, write a temporary file in the same folder and rename it over `progress.md`, so no reader sees a half-written file. (When the pane reads zero bytes from a file it saw with content a moment ago, it assumes a write is in progress and reads again. It has no such guard against a partial file.)

## Structure

A file is made of lines. Only the line shapes below mean anything. Every other line (free text, tables, `#` and `####` headings, numbered lists) is ignored, so a person can keep notes in the file without breaking it.

| Line | Shape | Meaning |
|---|---|---|
| Title | `# text` | Ignored. Optional. The pane writes `# 專案進度` when it creates the file. |
| Project | `## name` | Starts a project. `##` must be followed by whitespace. Trailing `#` characters are dropped. |
| Task | `### title` | Starts a task in the current project. Same rules. |
| Note | `> text` | A note on the current task. May be indented. The text is trimmed. |
| Step | `- [mark] text` | A step of the current task. See [Steps and marks](#steps-and-marks). |
| Block start | `<!-- auto … -->` | Starts an [agent block](#agent-blocks). |
| Block end | `<!-- /auto … -->` | Ends it. |

A step that comes before any `###` goes into a task with no title. A step or task before any `##` goes into a project with no name. The pane shows these as `（未命名）` and `（未分類）`. Avoid both. A `>` note that comes before the first `###` of its project is dropped.

**Ignored regions.**

- Fenced code. A line that starts (after optional spaces) with three backticks or three tildes toggles the fence, whichever character opens or closes it. Everything between, and the fence lines themselves, are skipped. An unclosed fence hides the rest of the file.
- HTML comments. `<!-- … -->` is removed from a line, and a comment that opens without closing hides lines until `-->`. The exception is the block markers, which are read first, as whole lines.

**Names.** A project name is its heading text. The pane puts the current session's project first. A heading belongs to a session's project when the heading's first word (up to the first space, `(`, `（`, `·` or `—`, compared without case) equals the repository name, the repository folder name, or the session folder name. `## persona_framework (PFC)` belongs to a session in the repository `persona_framework`. Name your project heading after the repository.

## Steps and marks

```
- [x] Reproduce the bug
  - [~] Add a failing test — runs only on CI
- [?] Pick a version — 0.6 or 1.0?
```

A step line is: optional indentation, a bullet (`-`, `*` or `+`), whitespace, `[`, one mark character, `]`, whitespace, then the text. Text is trimmed. A line that does not have all of these is not a step. In particular `- [x]` with nothing after the bracket is not a step, and a numbered item (`1. [ ] …`) is not a step.

| Mark | Meaning | Status name in the code |
|---|---|---|
| `[x]` | Done. `[X]` is read the same. | done |
| `[~]` | Doing: the step being worked on now. | doing |
| `[ ]` | Not started. | todo |
| `[?]` | Waiting on the person: they must answer, decide, do something, or tick it. | waiting |
| `[>]` | Running: waiting on something that moves on its own (CI, a long job, someone else). | running |
| `[!]` | Blocked: stuck. The step's note says why. | blocked |
| `[-]` | Cancelled. Counts as neither done nor open. | cancelled |

Any other character between the brackets makes the line a non-step.

**Counting.** A task's progress is the number of `[x]` steps over the number of steps that are not `[-]`, nested steps included. A task is complete when it has at least one counted step and all of them are `[x]`. The current step is the first `[~]`, or if there is none, the first step that is neither `[x]` nor `[-]`. A task row's one-line status takes the first blocked step, else the first waiting, else the first running, else the current step.

**Nesting.** Indentation sets how deep a step is drawn: one level per 2 columns (a tab counts as 4), at most 3 levels. It is only for drawing. A parent is not done because its children are, and every step, nested or not, is counted on its own.

**Note on a step.** The first ` — ` in the step text (space, em dash U+2014, space) splits the text from a note. `Recommendation letter — waiting for Prof. Lee` is the step "Recommendation letter" with the note "waiting for Prof. Lee". A hyphen or an en dash does not split. The note says what a `[?]` step needs, what a `[>]` step waits on, or why a `[!]` step is stuck. The note on a `[?]` step also decides its [ask kind](#waiting-steps-and-ask-kinds).

## Tasks

A task is a `###` heading with its notes and steps.

**Hand-kept tasks** are tasks outside any agent block: the ones a person or an agent writes without markers, and the ones the pane's quick add writes. Their `>` notes are the task's background, with any due-date phrase removed, joined by ` · `. If one note starts with `背景：` that note alone is the background.

**Background line.** In an agent block the background is the first note that starts with the literal Chinese label `背景：` (a full-width or ASCII colon both work), followed by one line of text in any language. The pane does not recognise `Background:`. Other `>` notes of a block are not shown by the pane; people reading the file see them.

```
> 背景：Duplicate charges happen when a provider retries a webhook.
```

**Due date.** The first match, looking at the task title and then each note in order (never the steps), of:

```
(截止|due) <separators> <date>        date = [YYYY-]M-D or [YYYY-]M/D
```

- `截止` or `due`, in any letter case.
- Then any run of spaces, `:` and `：`, or nothing at all.
- Then the date: one or two digits for the month, a `-` or `/`, one or two digits for the day. A year may come first, as four digits followed by `-`. `2026-10-31`, `2026-10/31`, `10/31` and `10-31` are read; `2026/10/31` is not.
- There is no word boundary: `overdue 3-4` is a due date.
- `/` is stored as `-`.

A date without a year means that day this year, or next year's if this year's is more than 60 days past. Dates are compared with today in UTC. An open hand-kept task due within 14 days, or already late, is listed under "due soon" instead of with other work. It is marked urgent when it is due within 3 days or late, and "soon" within 7. A block can carry a date too, but a block in state `waiting` is listed with the questions instead.

Examples: `> due 10-31`, `> due: 2026-11-05`, `> 截止 11/20`.

## Agent blocks

An agent block is the part of the file one session owns. The session writes it and rewrites it, and only it. The pane's Claude Code writer produces one per session. Other agents write theirs the same way.

```
<!-- auto session=2be48af2 agent=claude state=waiting updated=2026-10-16T14:32:05.123Z -->
### Task title
> One line of status for people reading the file
> 背景：Why this work exists and what it should end as
- [x] A finished step
- [?] A step that needs you — what it needs, in one line
<!-- /auto session=2be48af2 -->
```

### Markers

Start marker, on a line of its own, starting in column 0:

```
<!-- auto session=<8 chars> agent=<name> state=<working|waiting|done|ended> updated=<ISO 8601> [resume=<full session id>] [dir=<percent-encoded folder>] [pr=<n> ci=<none|pending|pass|fail>] -->
```

End marker, same placement:

```
<!-- /auto session=<8 chars> -->
```

A marker with anything but spaces before or after it on its line is not a marker. `<!--auto … -->` without a space also works, but write the form above.

An attribute is `name=value`, where the name is letters, digits, `_` or `-`, and the value is any text without whitespace. Names and the fixed values are lower case. Unknown attributes are ignored, so a writer may add its own.

| Attribute | Writers must give it | Value and effect |
|---|---|---|
| `session` | Yes. The parser needs only this one. | Identifies the block. Any text without whitespace; use 8 characters, `[0-9a-f]`, and use the same id for the end marker and for every rewrite. Two blocks must not share an id. |
| `agent` | Yes | Name of the agent in lower case: `claude`, `codex`, `gemini`, `cursor`, `aider`, `continue`, or your own. Shown as a label for every agent but `claude`. If missing: `claude`. |
| `state` | Yes | `working`, `waiting`, `done` or `ended`; see [States](#states). If missing or not one of these: `waiting`. |
| `updated` | Yes | When the block was last written, ISO 8601, read with `Date.parse`. Write UTC with a trailing `Z`, for example `2026-10-16T14:32:05Z`. A time with no zone is read as the local time of the machine running the pane. If missing or unreadable the block's age is unknown: it is never shown as stopped, and once it has an end marker the next archive sweep moves it out. |
| `resume` | No | The agent's full session id. Used only when `agent=claude`, to show the command `claude --resume <id>` for an ended or stopped session. |
| `dir` | No | The session's folder, percent-encoded as `encodeURIComponent` does (spaces become `%20`). Used with `resume` to show `cd '<dir>' && claude --resume <id>`, or a PowerShell `Set-Location` for a Windows path. An undecodable value is ignored. |
| `pr` | No | A pull request number, a positive integer. Shown as `PR #n`. Other values are ignored. |
| `ci` | No | `none`, `pending`, `pass` or `fail`. Shown after the PR number, only when `pr` is present. Other values are ignored. |

### Body

Between the markers, in this order:

1. `### title`, one line, exactly one per block. It names the outcome in plain words. Put it directly under the start marker. A block can hold a second `###`, but the pane reads it as a separate hand-kept task, without the block's state.
2. Optional `> ` lines. By habit the first is a status line for people (the pane's writer puts the state, branch and pull request there, in Chinese). The pane does not read it.
3. Optional `> 背景：…`, the background line.
4. Steps, one line each, in the order they will be done. Nesting is allowed; the pane's own writer writes a flat list.
5. Never a `##` heading. A `##` always starts a new project and ends the block.

Blocks with no steps are not worth writing. The pane's writer removes a session's block when its list becomes empty.

### Placement

Put the block under the `## project` heading of its repository, after what is already in that section, with a blank line before the start marker and after the end marker. If the heading is not in the file, add it at the end of the file first. The pane's writer does exactly this.

### Rules

1. One block per session. Reuse the same `session` id for the whole session.
2. Rewrite only between your own markers. Replace the whole block each time; it is derived state.
3. Never edit, move or delete another session's block, or anything outside your own markers. Leave every other line as it is.
4. Keep both markers. A block without an end marker still reads, but it is never archived, and a writer that rewrites it has to guess where it stops (at the first blank line, a second `###`, the next block or the next `##`).
5. Update `updated=` on every write. Update `state=` whenever it changes.

### States

| `state` | Means | What the pane does |
|---|---|---|
| `working` | The agent is running now. | Shows the task as being worked on. `[?]` steps are still listed as questions. |
| `waiting` | The agent stopped and steps remain. It is the person's turn. | Lists the block's `[?]` steps under "waiting on you". With none, lists a general "waiting for your reply". |
| `done` | Every step is finished. | Shows the task as recently finished, and archives it. |
| `ended` | The session closed with steps left. | Shows the task as left behind and open to take over, with its open steps. |

A task with all steps done is shown as finished whatever its `state` says, but only `state=done` makes the block leave after 12 hours.

## Lifecycle

### Stopped sessions

A block in state `working` or `waiting` whose `updated` is more than 12 hours old is treated as `ended`: the pane says the session stopped, and no longer raises its `[?]` steps as questions. Nothing in the file changes. Writing the block again (new `updated`) brings it back. This covers agents that crash or whose terminal closes before they can write `state=ended`.

### Archive

Old work moves out of `progress.md` into a monthly file in the same folder, so the file stays about what is open.

| What | When it leaves |
|---|---|
| A block with `state=done` | More than 12 hours after `updated` |
| A block in any other state (`working`, `waiting`, `ended`) | More than 3 days after `updated` |
| A hand-kept task whose steps are all done | 24 hours after the pane first saw every step done (the pane keeps that time itself, not in the file) |

Only blocks with their end marker move. A block without one stays until someone fixes it. The session that is running the sweep never moves its own block.

The sweep runs when a Claude Code session with the mod starts, once an hour while it stays open, and on `/progress 整理` (or `/progress archive`). If no such session is running, nothing is archived and nothing is lost.

The archive file is named after `progress.md`: `progress-archive-YYYY-MM.md`, in the same folder. For `CLAUDE_PROGRESS_FILE=/work/board.md` it is `/work/board-archive-YYYY-MM.md`. The month is the UTC month of the sweep. The file starts with `# 進度封存`. Each moved task is added as

```
## <project> · <YYYY-MM-DD>
### Task title
> …
- [x] …
```

that is, the block without its markers under a heading with the project and the UTC date of `updated`. For a hand-kept task the date is the day the pane first saw it done, and the entry runs from its `###` line to its last non-blank line before the next heading. Whenever a sweep moves something, it also collapses the blank lines it left and **removes every `##` section in the file whose body is blank**, including an empty one a person wrote. Do not leave a bare `##` heading in the file as a placeholder.

### Journal

`progress-journal-YYYY-MM.md`, in the same folder (for `board.md`, `board-journal-YYYY-MM.md`). The month is the local month. One line per finished step:

```
# 工作日誌
- 2026-10-16 14:32 · checkout-service · Add retry to payment webhook · Wire the key into the handler
```

The line is `- YYYY-MM-DD HH:MM · project · task · step`, local time, 24-hour clock. The separator is space, middle dot (U+00B7), space. In a field the pane replaces any run of whitespace with one space and any ` · ` with `・`, and writes `（未命名）` for an empty field. The file starts with `# 工作日誌` and a line break. A line is read when it matches `^- (\d{4}-\d{2}-\d{2}) \d{2}:\d{2} · (.+?) · (.+?) · (.+)$`.

The pane writes a line when a Claude step becomes completed and when a person ticks a hand-kept step in the pane. It does not watch other agents' blocks. An agent may append lines of the same shape: the pane counts them in "finished today" and in the weekly report (the current and the previous month's files). Appending is optional.

## Waiting steps and ask kinds

A `[?]` step is a question for the person. The pane gives each one a kind, which labels it and decides how urgent it looks. The kinds:

| Kind | Label | The person is asked to |
|---|---|---|
| `confirm` | 確認 | Say yes or no. |
| `choose` | 選一個 | Pick one of the options. |
| `input` | 填資料 | Type something in: a value, a name, a path. |
| `do` | 動手 | Do something themselves, often by running a command. |
| `review` | 看一下 | Look at something, often at a link, and say if it is fine. |
| `wait` | 等別人 | Nothing for now; someone else has to answer first. The person ticks it when it has arrived. |
| `reply` | 回覆 | Reply in general. The default. |

Questions the person can settle now (`confirm`, `choose`, `do`, `review`) are listed before `input` and `reply`, and `wait` last. A session's own questions come before other sessions'.

**What the person can do from the pane.** For the Claude session that owns the pane, each kind has its buttons (yes/no, one per option, copy the command, open the link, a reply box); a press is sent back to that session as a prompt. For a block written by any other session, the pane shows the question, its kind and its agent, and says to answer in that session: it cannot reach it. For a hand-kept step, the pane offers one button that ticks the line to `[x]` in the file.

### How a writer sets the kind

**From Claude Code,** a `TaskUpdate` (or `TaskCreate`) `metadata` object:

| Key | Value | Effect |
|---|---|---|
| `waiting` | `"you"` (also `"user"`, `"me"`, `"human"`, `"使用者"`, `"我"`, any case) | Step is `[?]`. |
| `waiting` | `"run"`, or any other value that is not empty | Step is `[>]`. |
| `why` | One line | The note after ` — `. If `why` is missing, `reason`, `question`, `ask` and `note` are tried in that order, so an `ask` given without `why` is written as the note (`ask: "choose"` becomes `— choose`). Always give `why`. |
| `ask` | `confirm`, `choose`, `input`, `do`, `review`, `wait` or `reply` | The kind, in the owning session's pane. |
| `options` | Array of strings | The choices for `choose`. |
| `command` | String | The command for `do`. |
| `link` | String | The link for `review`. |
| `blocked` | A reason, or `true` for none | Step is `[!]`, with the reason as its note. Wins over `waiting`. |

A key set to `null` clears it. Clearing `waiting` also clears `why`, `ask`, `options`, `command` and `link`. Marking the step completed clears all of it. In the file a step is written as `[x]` completed, else `[!]` blocked, else `[?]` waiting on you, else `[>]` waiting on a run, else `[~]` in progress, else `[ ]`.

Only the note travels through the file. `ask`, `options`, `command` and `link` stay in the owning session, so another session's pane works the kind out again from the words of the note. Write the note as a plain sentence that carries the question.

**From any other agent,** word the note (the text after ` — `; if there is no note, the step text) so the rules below find the kind. The pane tries them in this order and takes the first that matches. Matching ignores letter case.

| # | Kind | Matches when |
|---|---|---|
| 1 | `wait` | The note (not the step text) starts with `waiting for` or `等`, `在等`, `等待`. |
| 2 | `choose` | The words hold `A or B` followed by `?` (or `？`). The first option is what stands before `or`, back to the last `,` `:` `;` or `。`; the second is what follows, up to the `?`. Needs two options, each at most 24 characters. `還是` and `或是` work as `or`. |
| 3 | `confirm` | The words end with `OK?` or `okay?`, or in Chinese with `嗎`, `可以嗎`, `好嗎`, `要不要`, `可不可以` or `是否`, or start with `可以`, `要不要` or `能不能`. |
| 4 | `review` | The note or step holds an `http://` or `https://` link, or the words hold `review`, `看一下`, `看看`, `檢查`, `過目`, `預覽`, `校對` or `讀一下`. The link is kept. |
| 5 | `do` | The note or step holds a command in backticks, or one of the verbs `run`, `push`, `install`, `click`, `log in`, `login` (or a Chinese one such as `跑`, `執行`, `按`, `點`, `安裝`, `設定`) starts within the first 8 characters of the words. The backticked command is kept. |
| 6 | `input` | The words hold `key`, `token`, or a Chinese word such as `提供`, `告訴我`, `哪個`, `路徑`, `帳號`, `金鑰`, `網址`. |
| 7 | `reply` | None of the above. |

Writing tips that follow from the table:

| To get | Write | Not |
|---|---|---|
| `confirm` | `- [?] Deploy build 214 — Deploy it to staging, OK?` | `Deploy it to staging?` (becomes `reply`) |
| `choose` | `- [?] Key lifetime — 24 hours or 7 days?` or `- [?] Database — Which one: SQLite or Postgres?` | `Use SQLite or Postgres?` (the first option becomes `Use SQLite`); `24 hours or 7 days` (no `?`) |
| `do` | ``- [?] Seed the database — run `make seed` on your machine`` | |
| `review` | `- [?] Check the preview — https://example.com/preview` | |
| `input` | `- [?] Staging credentials — paste the staging API key` | |
| `wait` | `- [?] Recommendation letter — waiting for Prof. Lee to reply` | `Waiting on Prof. Lee` (needs `waiting for`; becomes `reply`) |

**Known limits of the words.** These are heuristics, and a wrong kind only changes a label and an order; the step is still listed.

- `or` is matched inside words, not only on its own. In a note that holds a `?`, a word such as `for`, `more`, `work`, `port` or `before` can make the text around it look like two options: `Is this OK for production?` is read as `choose`, between `Is this OK f` and `production`. Choose the words so that `or` appears only where you mean a choice.
- A plain English yes/no question is not `confirm`; only an ending of `OK?` or `okay?` is.
- The verbs for `do` are matched without a word boundary, so `Push to main?` is `do`.

## Worked example

Two projects, two agent blocks and a hand-kept task. The Claude block has a pull request, the Codex block has a nested list, and the job-search task is written by hand.

```markdown
# Project progress

## checkout-service (payments)

<!-- auto session=2be48af2 agent=claude state=waiting updated=2026-10-16T14:32:05.123Z resume=2be48af2-6193-5040-aacc-e0546d6784f1 dir=%2Fhome%2Fana%2Fcheckout-service pr=482 ci=pending -->
### Make the payment webhook idempotent
> Waiting for your reply · fix/webhook-retry · PR #482 · checks running
> 背景：Duplicate charges happen when the provider retries a webhook; one delivery must charge once.
- [x] Reproduce the duplicate charge
- [x] Add the idempotency key table
- [~] Wire the key into the handler
- [?] Key lifetime — 24 hours or 7 days?
- [>] Integration suite — waiting for CI on PR #482
- [ ] Update the runbook
<!-- /auto session=2be48af2 -->

## metrics-exporter

<!-- auto session=9c41d0e7 agent=codex state=working updated=2026-10-16T14:40:12Z -->
### Move the exporter to the new client library
> Codex is working · branch codex/new-client
> 背景：The old exporter drops labels, so dashboards show gaps.
- [x] List the metrics the old exporter emits
- [~] Port the counters
  - [x] request_total
  - [~] error_total
  - [ ] retry_total
- [?] Staging credentials — paste the staging API key
- [ ] Compare the output with staging
<!-- /auto session=9c41d0e7 -->

## Job search

### Summer internship at Northwind
> due 2026-10-31
> Referral from Priya. Recruiter is Sam.
- [x] Update the resume
- [?] Recommendation letter — waiting for Prof. Lee to reply
- [>] Application portal — submitted, waiting for the confirmation email
- [ ] Follow up after one week
```

How the pane reads it:

- `checkout-service (payments)` is the project of a session in the repository `checkout-service`. The Claude block is `waiting`, so the pane lists its `[?]` step under "waiting on you". That step is a `choose` with the options "24 hours" and "7 days". The block's `pr=482 ci=pending` is the pull request and the state of its checks.
- The Codex block is `working` and carries the label `codex`. Its 7 steps are counted flat, 2 of them done; the three nested steps count like any other. Its `[?]` step is an `input` (the words hold `key`). The pane lists it as a question to answer in the Codex session.
- The job-search task is hand-kept. It is due `2026-10-31`, so it moves to "due soon" once that is 14 days away. Its `[?]` step is a `wait`: the pane offers one button, and pressing it changes the line to `[x]`. The other note, "Referral from Priya. Recruiter is Sam.", is its background.
- The Claude block's first note (`Waiting for your reply · …`) is for people reading the file. The pane's own writer puts the state, branch and pull request there, in Chinese. The pane does not read it.

## Writing a block from another agent

1. Read `progress.md`, or start an empty file. Read the file again right before every write.
2. Make an 8-character id once per session, for example 8 hex characters from your random source. Keep it for the whole session.
3. Find `## <repository name>`. If it is not there, add it at the end of the file.
4. Write the start marker with `session`, `agent=<your name>`, `state=working` and `updated=<now, UTC, ending in Z>`. Add `pr` and `ci` if you know them. Leave out `resume` and `dir`: the pane builds a resume command for `claude` only.
5. Write `### <title>` naming the outcome, then a one-line `> ` status, then `> 背景：<why this work exists>`.
6. Write the whole plan as steps, the one you are on as `[~]`. Mark any step that needs the person `[?]` and give it ` — <one line>` worded as in [Waiting steps and ask kinds](#waiting-steps-and-ask-kinds).
7. Write the end marker with the same id.
8. After each step, re-read the file, replace your block (start marker to end marker) with a new copy, set the step's mark, set `updated=` to now, and write the file. Touch nothing else.
9. When you hand control back to the person with steps left, set `state=waiting`. When you start again, set `state=working`.
10. When every step is `[x]` (or `[-]`), set `state=done` and update `updated=`.
11. If you stop for good with steps left, set `state=ended`. If you cannot tell that a session ended, do nothing: after 12 hours without a write the pane shows the block as stopped.

If you cannot write markers, write a plain hand-kept task (a `###` with steps) under your project. It shows in the pane, but it has no state, never shows as stopped, and leaves only 24 hours after the pane sees all its steps done.

## Versioning

This is version 1. The file carries no version field. What the version means is the set of rules above, as read by the parser in `hooks/parse.ts`.

A change to this page must keep every file that is valid today valid and read the same way. New attributes go on the start marker, where readers that do not know them ignore them. New marks, new states and new line shapes are not backward-compatible and need a new version. Contributors: see [CONTRIBUTING.md](../CONTRIBUTING.md).
