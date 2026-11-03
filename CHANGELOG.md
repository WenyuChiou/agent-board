# Changelog

What changed for the person using Agent Board, one line per change, newest version first. How a change was built and tested is in its pull request. Entries up to 0.24.0 were shortened to this form on 2026-11-02; their full text is in `git show ddbef2a:CHANGELOG.md`.

## 0.24.2 — 2026-11-03

- **Board / Same-prefix sessions** · Independent sessions with the same short ID remain visible as other sessions, with separate unanswered questions. The first-turn work note retains these peers, and an ended peer can be archived without changing the current session (#674).

- **The local message hub is safe to leave on with `--serve` (#315, #163).** The board now keeps a private message store by default, recovers dead PID locks, deletes old finished messages, expires uncertain delivery, and limits queued messages and relay hops. The local hub can dismiss queued or uncertain messages so the next message can proceed. Adapters can mark when delivery begins, preserving clean rejection before any external write. Duplicate receivers stay on Copy even with explicit resume enabled and cannot acknowledge claims. Board JSON omits nonces. Store startup errors name the folder and reason, and Windows-created or default stores grant access only to the current account. Delivery identifies its source and uses a nonce boundary and a single ACK line; original receivers can report claims after a board restart. LAN messaging stays unavailable, receiver polling does not keep an idle page open, and explicit `--allow-resume` still works for closed sessions.
  On Windows, the default message folder is made the account's alone and read back before startup; a failed store start names its folder and gives advice that fits the cause. Run as the local Administrator, the check also reads the account's own entry, which Windows writes as `LA` instead of its SID, also when the board is started without `COMPUTERNAME`.
  A legacy PID-only lock without a live or unknown lifetime claim no longer keeps `--serve` from starting after a restart once the address that hub left beside it no longer answers, even when its number now belongs to another program (default folder only). Current lifetime claims with a live or uncheckable PID still block takeover and require verified manual recovery; a hub removes any address left from before when it takes the lock. A finished message keeps only a SHA-256 hash of its text, which is what an exact retry is compared with, and only open messages count toward the store's 1,000-message cap; the newest 1,000 finished messages are kept for retries, so a store full of finished messages still accepts new ones and the file stops growing with the number of messages sent. A message handed out and then expired or dismissed, and each session's latest delivery, stay their full 24 hours, so a retry of a message that may have arrived is not delivered again and a relay keeps its hop count. The file holds at most 2,000 records: past that, those of the two kinds older than 30 minutes go too, and only a burst of more than that within 30 minutes is refused (`MESSAGE_LIMIT`). Earlier releases cannot read a store saved this way: before going back to one, move both `messages.json` and `server.lock` out of the message folder, since 0.24.0 and earlier take the lock before they read the store and keep it after refusing the file. A receiver that restarts with its old connection and secret replaces that connection instead of leaving both contested. Registrations reserve an `origin` field (only `local` for now) and each message records its sender's origin; one helper builds and splits `agent:session` addresses. docs/MESSAGING.md states the message id rule: clients mint `AB-` plus a UUID, the hub never mints one, and a retry with the same id gets the same receipt. The card shows the agent's words after its ACK, never the nonce, and a retried send never returns it. Two `--serve` started together open one page even when one of them loses the message folder's lock, and a store that cannot be read gives its lock back. A store another program holds for a moment, as a virus scanner can on Windows, is written on a short retry instead of answering busy; a temp file left by a hub killed while saving is deleted when the next one starts, and one a save could not remove no longer blocks the saves after it. Two hubs starting together can no longer both hold the message folder: a lock file caught between being created and holding its pid counts as in use, and a hub that recovers a dead hub's lock moves it aside first and puts back one another hub had just taken. A finished message also keeps only the first 200 characters of its reply.
  `tests/e2e/soak.mjs` now runs a messaging soak after the board soak (`.github/workflows/soak.yml`, Ubuntu and Windows, never per pull request): 200 registered sessions, half of them ended, and 5,000 messages including uncertain, rejected and contested ones. It checks that the hub's memory and its file level off, that finished messages and ended registrations retire, that a poll costs no more file operations than with 10 sessions, that hooks stay inside their time limit with a full store, and that a hub killed mid-delivery starts again with its claimed messages uncertain and none handed out twice. Its report is `messaging-report.json` and `.md` beside the board soak's.

- **Keep concurrent hub recovery exclusive (#315).** Current writers publish a PID and nonce claim before lock acquisition and hold it through shutdown; outer recovery participates too. A delayed recovery previously displaced a newer lock and admitted two live stores. Unknown or partial claims remain blocked, closed stores reject further access, and only proven-dead immutable claims retire. This guarantee requires cooperating current writers in a fixed local directory; stop older instances before upgrading. It does not establish mixed-version or network-filesystem exclusivity.
  The soak validates exact claim bytes and owned hub PIDs, including its known restart; partial publications must finish before passing. Recovery advice preserves uncertain messages and requires verified stale ownership metadata. Windows documentation and shutdown assertions use the protected runtime child.
  Page snapshots reuse the progress projects already read for that page, while handoff requests still check current progress before recording their baseline.
  The page also draws from the validated proof snapshot after its own writes, refreshing it when migration creates a proof, so enabling the hub stays within the existing idle I/O guard.

- Messaging: several `--serve` started at the same moment all print the page's address instead of one stopping with `MESSAGE_STORE_CLAIM_BLOCKED` when it reads a claim another start is writing or removing (#800).

- Setup: the doctor and the removal print plain lines in the board's language unless `--json` is asked for (#796).

- Board: the terminal board shows Needs you for a blocked step, as the page does (#786).

- Setup: the preview names each file it would change, under its agent (#787).

- Board: the board script knows the files 0.24.1 wrote, so it tells them apart from files the person changed (#793).

## 0.24.1 — 2026-11-03

- Setup / Windows: the README's board commands and `--codex-trust` with the Codex that npm installed work on Windows PowerShell 5.1, and each setup and doctor error now says what went wrong and what to do next instead of asking for `--json` (#779).
- Setup / plugin-connected computers: setup keeps the board the Claude Code plugin connected instead of starting a second one, and puts back a missing file it installed instead of calling it a conflict (#781).
- Pane / Archive without Node: `/progress tidy` and the pane's Archive button archive a done task again on a computer where node is not on the path (#755).
- Contributing / Review queue: `node scripts/review-queue.mjs` says when Codex's security review did not run on a pull request's latest commit (#750).
- Contributing / CHANGELOG: the release's CHANGELOG fold reads every pull request merged since the last tag, not only those on main's first line of history, and checks that none is missing (#744).
- Contributing / Review queue: a pull request that changes docs/dev/RULES.md is treated as a governance change (#731).
- Contributing / CHANGELOG: a fix or feature pull request writes no changelog entry: the release writes each CHANGELOG line from the pull request title (#718).
- Tests / native hooks: native Antigravity checks observe the recorded event after a hook safely queues it for automatic recovery (#706).
- Antigravity / Windows fallback: long Windows installation paths no longer repeat shared directories in an oversized PowerShell fallback command (#705).
- Page / message receipts: a card's durable message receipt replaces its earlier Queued hint, so Replied no longer appears beside stale enqueue feedback (#701).
- Codex / reporting: withdrawing an agent-started Codex run no longer removes a block whose full session id contradicts its owner; the board file stays exactly as it was, as it does for an explicit report (#682).
- Codex / reporting: independent local sessions sharing a short report id keep saving their own progress without overwriting each other (#677).
- CI / Merged pull request updates: updating evidence on an already merged pull request no longer rejects issues closed by that merge (#673).
- Contributing / Review queue: a merge notice is cancelled while a `Review: REQUEST CHANGES` for the head stands unresolved (#660).
- Tests / Preflight: preflight test runs for one account now share a lock across different temporary directories, and unfamiliar lock-folder entries are left alone without blocking tests (#645).
- Contributing / Review queue: `node scripts/review-queue.mjs` shows what Codex and Greptile said about each Ready pull request's head and where its merge notice stands, then lists who is away and which claims ran out (#642).
- Contributing / Review queue: `node scripts/review-queue.mjs` suggests a reviewer for each waiting pull request from `docs/dev/reviewers.json`, never the author's own agent (#642).
- CI / Preflight: a failed touched Node check now names up to three failing cases while keeping paths and tokens redacted, so its diagnostic identifies the useful failure without exposing the raw test log (#639).
- Page / Polling: an unchanged page poll now returns an empty response and keeps the current view (#635).
- Questions / Quoted choices: answer buttons no longer keep quote marks or brackets that wrap a choice question, including questions extracted from an agent's reply, in every language (#634).
- Tests / Windows pane checks: pane checks keep automatic setup in the cases that exercise it and run in three files, with every existing assertion retained (#630).
- Tests / Windows recovery evidence: a concurrent-writer recovery failure includes helper, lock and pending-event timestamps in its assertion message, while successful runs stay quiet (#626).
- Codex / Windows hooks: the Codex hook command works for a Node path with a space and no 8.3 name, and a home folder with `’` no longer skips the hook (#625).
- Codex / Windows hooks: on Windows, Codex 0.164 runs its hooks through PowerShell, and the hook command setup wrote, every word in double quotes, failed there, so the board got no Codex events (#623).
- CI / Plugin on Windows: a pull request that changes what the plugin loads also runs the plugin check on Windows (#613).
- Page / Working now: with no agent at work, Working now no longer says that no agent did anything when one waits on you (it points to Needs you) or stopped in the last 30 minutes (it names the agent and how long ago) (#612).
- Codex / Trusting hooks: approving the board's Codex hooks prints one short line saying what happened and what to do next, instead of about 40 lines of JSON with paths and hashes; `--json` still prints the full details (#611).
- Tests / Preflight: preflight now reports completed checks as they finish, names each touched Node test before starting it, and prevents cooperating local runs from testing at the same time (#605).
- Tests / Hook load: hook-load reports no longer accept the closed #241 timing exception: failed or missing measurements now fail the run, without claiming the measured latency was fixed (#604).
- Questions / Moving a project: moving the same live agent block to another project heading removes its former question from Waiting on you while retaining its original record and evidence (#602).
- Codex / Doctor: running `--codex-doctor --agent codex` without `--codex-bin` auto-discovers the installed Codex binary or inspects `config.toml` to surface missing hook trust or unverified state instead of unconditional unknown (#601).
- Antigravity / Resumed conversations: resumed Antigravity conversations receive their bound report instructions on the first observed turn, and local agents without a session flag match their active working folder automatically (#600).
- Setup / Multi-agent upgrades: updating or connecting one local agent keeps shared setup records in sync across every installed agent on the machine, so later upgrades or removals do not report false conflicts (#599).
- Terminal board / Steps written as records: a step written as a JSON record shows its own text instead of the raw JSON and the session id inside it (#598).
- Tests / Hourly sweep: the damaged seen-file check no longer exposes an empty file while replacing its test data, avoiding an intermittent false failure (#595).
- Page / Windows start: the first page start on Windows runs one PowerShell instead of four (#591).
- Reporters / Pending event time: events queued by a late-starting hook worker now retain the same UTC event time as other pending events (#590).
- Docs / Team routine: the review queue now also lists every lane worktree older than 2 hours that has no open or draft pull request, one line each with its branch and age (#583).
- Plugin / Windows: the plugin loads again from a Windows git checkout: the board bundle keeps LF line endings, so it stays under the 1 MiB that Claude Code reads from one module (#582).
- Claude Code / Plugin loads on every checkout: no module goes over Claude Code's 1 MiB limit, also on a checkout with CRLF line endings (#582).
- Terminal board / Stop and SSH access: the stop command now says when a busy page could not close, and the SSH link opens the page (#580).
- Contributing / Reviews: the maintainer offers its own pull requests to the collaborators first; a code-review subagent or Codex reviews one only when no collaborator has commented `Reviewing:` within four hours of Ready (#577).
- Contributing / Review queue and flaky tests: `node scripts/review-queue.mjs` lists the pull requests waiting on a reviewer, smallest first, with the hours each has waited (#577).
- Tests / Messaging: the sender-receiver matrix runs one test per sender and receiver pair, each with its own time limit (#575).
- Contributing / Fewer merge conflicts: the generated board bundle is now stored one line per line, so two pull requests that change different code merge without a conflict, and the pull request keeps getting its CI run (#573).
- Pane / Large progress files: a large `progress.md` with a very long line no longer makes the pane slow to update (#569).
- Codex / Start note: a new Codex session you start in a project is told, before its first turn, what the other sessions there still have open or left unfinished in the last 7 days, the same note a Claude Code session already gets (#564).
- Docs / CHANGELOG: CHANGELOG entries now say what changed for you in a sentence or three, and the test titles stay in the pull request (#563).
- Pane / Archive: a done task archived on the same day as an identical archived one is kept as a second entry (#560).
- Setup speaks to the person (#553).
- Board tests avoid a sweep setup race and retry Windows cleanup (#552).
- Page / A logo of its own: the board's mark is now Bubble a: a lowercase a whose foot turns into a speech-bubble tail, in one amber colour, in the page header and the browser tab (#551).
- Page / Needs you first, then what is moving: the page opens on what needs you, then what is working now, then your projects, with a closed shelf of finished work at the end (#546).
- Page / Sidebar on wide screens: from a narrow docked window up, a sidebar lists the views, the agents and the projects with their counts; it folds to a rail of icons and back, and a project and an agent filter work together (#546).
- Page / Calmer colours and a simpler footer: actions are ink and only what needs you is amber; green means alive and red means something is wrong (#546).
- Terminal board: it looks like the page, with the same colours and order, no flicker, and one-key answers to yes/no and two-option questions (#545).
- One command opens the board where you are (#544).
- Core / Runs: prevent session ID truncation and prefix collisions across concurrent subagents and multi-agent runs, using full canonical identifiers and composite keys for block matching, parent scoping, and observation caches (#539).
- Docs / README key points: each README now sums the board up in three points (one Markdown file, every agent on one board, questions first) and links to the page on how the board works beside memory tools, in all three languages (#534).
- Page / Stopped after a set time: configurable session inactivity staleness allows the board to mark quiet sessions stopped at a requested duration, enabling prompt completion and archive without waiting twelve hours (#532).
- Docs / The board beside memory tools: a new page, `docs/dev/architecture-positioning.md`, explains how Agent Board differs from memory tools and how the two work together (#530).
- The archive journey waits for its question ledger (#519).
- A hand edit to progress.md made while the board writes its block is kept (#506).
- Keep strongly identified agent runs out of the board (#501).
- Tests / Pasted block clock: the test for a pasted block with a weeks-old clock places it an hour past 21 days, so a small clock step on the test machine no longer fails it (#493).
- Pull requests from outside the team get their own caps and claim rules, and a small docs fix needs no issue (#482).
- A new look and the board's own logo (#478).
- The page picks an agent first and opens on Needs you (#477).
- Tasks and questions grouped by agent (#476).
- The background `--serve` test waits for the page to exit before removing its folder (#471).
- Page / Windows start: the page start on Windows runs one PowerShell with 30 s, so a slow first start no longer ends with no page (#468).
- The README opens with what Agent Board does, the phone route and a start for each main agent (#467).
- Every agent the README lists is walked from setup to a card on the board in a synthetic home, and the README says which were not run live (#466).
- Setup guides a Claude-only computer, reports every error as one sentence with its next step, and reads a byte-order mark in every JSON host config (#465).
- Clean up archives the finished hand-kept tasks its count shows (#464).
- A card on the serve page shows each step and each note as one line (#463).
- One question asked in several places is one card (#463).
- The HTML board shows a question that is in an agent block and in the inbox once (#463).
- The read-only-file journey finds a long step's Done button by its title (#463).
- The four-day stopped-task journey finds a step by its visible line (#463).
- A turn that comes back as JSON no longer becomes a question (#462).
- Every card names its agent by brand, a noted choice question keeps its options, and Reply comes first with at most three buttons (#461).
- A synthetic big board for the tests (#460).
- The messaging tests start their page in the order `--serve` does on Windows (#458).
- Verify the actual owned classifier process has exited after a Windows timeout, so an interrupted or recycled PID marker cannot falsely report a live process (#457).
- Fix the strict runtime type contracts for nullable archive lines, completed-session view state and the existing local-session cache guard without changing their data-safety behavior (#455).
- Common setup accepts a UTF-8 BOM in existing Codex hook JSON (#451).
- The sender matrix keeps its own test watchdog (#447).
- Antigravity now shows its official SVG mark, DeepSeek Harness its official whale, and Muse Code the blue Muse brand mark (#442).
- One new answer alone wakes the question pass (#440).
- The README cover uses the approved preview target (#438).
- L2 working-day batches use explicit ordered update times, so rapid same-millisecond writes cannot make the latest-agent check depend on a recency tie (#434).
- A session that asks and stays silent for seven days is archived, and its question is kept under Older unanswered questions (#400).
- Waiting shows one line for the questions of stopped sessions, and Older lists each with its age (#400).
- Only a conversation a person started is a row; a run an agent started for itself joins its parent's row (#399).
- The first /progress can wait up to five seconds for the existing startup upgrade before retrying the current installed live-board script (#393).
- A Windows lock creation that ends its bounded wait with EPERM and no lock file reports a permission failure instead of a busy lock (#392).
- Every line of the terminal board fits the terminal's width (#383).
- Agent blocks dated more than five minutes ahead show a future-time marker (#382).
- Hooks / Dropped queued events: a queued hook event dropped on replay leaves one line in `~/.agent-board/hook-errors.log` naming the agent, the event and the reason (#375).
- On Windows, the board page keeps its address and token in a dedicated runtime folder with an explicit, non-inherited grant for the current account only (#340).
- CI runs only the groups a pull request's changed paths affect, and the final gate fails when a selected check did not succeed (#339).
- A pull request runs each Node line and each system once (#339).
- Test-only CI stays narrow beside release notes (#339).
- Reporters / Matching cut-tail detection: native reporters detect cut tails with the same UTF-8 rules as the board, including headings with non-breaking spaces (#298).
- Progress / Hidden cut markers: a cut report marker now warns when it hides task headings inside a comment, while ordinary comments and fenced examples remain quiet (#297).
- A Claude `/agent-board` command opens the live board page (#294).
- The Claude desktop app's footer names the command that opens the board (#286).
- Page / Memory on Linux: the background page no longer grows by about 50 MB outside its JavaScript memory over a long session (#266).
- The parity matrix separates each agent's app and CLI (#252).
- Queued lifecycle events recover without another prompt (#241).
- Legacy hook regressions distinguish PATH selection from input deadlines (#241).
- Concurrent hook acceptance observes bounded recovery (#241).
- The generated Antigravity and Codex hook commands are now tested to reach Node without PowerShell on Windows (#241).
- Observe L5 queued hooks through bounded autonomous recovery (#241).
- Delayed hook events preserve their source time and cannot replace newer work (#241).
- A busy board lock on Windows is no longer reported as "access denied", so a hook no longer drops its event (#241).
- A hook run whose reporter fails saves its event, and a failed recovery frees its claim (#241).
- Confirmed product workflows run in a real browser (#241).
- Reporters / Windows input: on a busy Windows computer, an agent's event is no longer dropped while PowerShell starts (#241).
- Antigravity's Windows hooks avoid a PowerShell startup when Node is verified (#241).
- Make the L5 writer journeys prove contention and the rename retry (#241).
- Archive now counts and keeps every task it archived, also two that share a title (#231).
- Confirm done works on every marker shape FORMAT.md accepts, and is not offered on a step-less hand-kept task (#142).

## 0.24.0 — 2026-10-25

- Reduce repeated allocation in standalone question polls (#428).
- Newly started background board pages favor a smaller adaptive heap after a burst of questions (#428).
- Persistent terminal and web boards use directory change hints to revalidate immutable question companions only when needed, check current metadata before actions, and fall back to full checks when monitoring fails (#428).
- Repeated page reads keep inbox work flat and measure question recovery on the actual shelf (#428).
- Report measured soak successes as passes before handling registered known failures, keeping the measurement limits and failure markers (#425).
- Antigravity receives a report command bound to its native conversation when the session or first invocation starts (#285).
- A question's saved copy of its block holds the block's state and step marks, not its lines, so the question list stays under the host's 4 MB write limit (#419).
- A board with thousands of question files no longer gets the pane unloaded at session start, and the inbox no longer waits behind a question pass for each session or behind the clean-up of the question files (#416, #371, #156).
- The idle poll no longer runs the question pass again when nothing it reads has changed: not when a remembered answer ages out, and not when this session's own state changes without touching progress.md (#416).
- The README opens with the AI agents it connects, shows every picture in the dark look, and splits its key commands into two tables (#407).
- Turns taken from a large backlog no longer run out of tries and get set aside while they wait (#397).
- Old conversations no longer reappear as new after a backlog of held turns drains (#396).
- The soak checks the real hooks under load (#395).
- An approved Codex reports each turn once again: connect no longer puts the reporting instructions back when it cannot ask Codex (#391).
- User-journey tests: a clock jump keeps a file time's part below a millisecond (#386).
- The board keeps its saved records and files to a fixed size, and a session start does the same work on a store four times as big (#373, #156).
- A session start on a busy board no longer stalls Claude Code's hooks worker, so /progress stays (#371).
- Contributors: one pull request now covers a whole feature, or two or three bug fixes (#370).
- A prompt is no longer lost when its board check runs out of time (part of #351).
- A hook event is no longer lost when Windows PowerShell starts slowly (part of #241).
- A prompt reporter that cannot save its timeout receipt now says so, and a stopped reporter's leftover files are removed (part of #351).
- Tests for the FORMAT.md writers, the sh sweep and the report deadline now catch what the #381 review found they missed (#351).
- The codex-local tests no longer stop a process by a pid they have seen exit (#351).
- Interrupted codex-local tests stop their synthetic process trees (#351).
- Windows reporter tests allow more time on slow CI runners (#351).
- The README opens with a 29-second animated cover in six scenes, and its first screen is reordered (#344, #318).
- The team process page names the maintainer as coordinator, says this repository runs supervised, and carries the steps every contributor follows (#339).
- The board's first question-ledger write uses a hard link before starting a move program (#327).
- The pane places its own question-ledger files with a Node hard link before starting a move command (#327).
- The board page and progress.html get a light and dark switch and a sorting sidebar (#314, #259).
- Agent Board is on npm as `@wenyuchiou/agent-board`, with a stable release channel (#308).
- The reply-in-flight replacement test waits for each fixture phase (#295).
- Open the live board page when the app cannot show the pane (#294).
- Open the board page when the app cannot show the pane (#286).
- Agent turns that 0.23.x set aside while their question could not be saved reach the board (#290).
- `/progress connect` hooks Antigravity, not only its skill (#285, #241).
- The Codex host tests no longer race a cold Node start (#268).
- Reconnecting Codex refreshes stale fallback commands (#251).
- Default views name files in words, not paths (#250).
- Other writers no longer lose their block when they write progress.md alongside the hooks on Windows (#249).
- A tick or confirm-done whose progress-file save fails takes back the work-log lines it added (#248).
- Codex and Cursor sessions show their working folder name (#246).
- A hook that finds progress.md locked keeps its event (#244).
- Generated hooks count startup time and queue interrupted events (part of #241).
- OpenCode progress reports survive an idle session (part of #217).
- A new prompt to Codex or another local agent leaves its open question waiting (#243).
- Live checks for Send to Claude and Send to Codex are recorded (#235, #316, #318, #319).
- Docs: AGENTS.md lists the preflight and the CHANGELOG fragments (#229).
- A step-by-step page for agents on other computers (#229).
- Docs: findings go to your issue, and preflight comes before review (#229).
- Contributors: the pull request rules now ask for a CHANGELOG fragment (#229).
- How work moves, and the numbers that show it (#229).
- Docs: the maintainer merges workflow changes once the owner approves them (#229).
- User-journey tests: the journey audit's first-run, working-day and cross-agent titles and the isolation self-tests (#222).
- User-journey tests: line width at 100 columns, the page server's idle poll, a week of waiting, and the journeys job on Node 22 and 24 (#222).
- User-journey tests: the fake clock moves at real speed (#222).
- A long soak of the terminal board and the page server, with its report (#222).
- Time, scale, failure and retirement journeys (#222, step 3).
- User-journey tests (#222).
- User-journey tests pass the PowerShell module path on Windows (#222).
- OpenCode: the progress tool says why a report was refused, a one-shot run ends its row, and rows are filed under the session's folder (#217).
- Every press shows its result beside its own card (#211).
- Quick section and notification presses wait for the previous save, so a failed save cannot undo a later change (#250).
- Reporting hook failures are bounded and leave local diagnostics (#191, #244, #241).
- A stopped block that still asks is archived by the automatic archive once its three days are over, with its question kept (#174).
- Archiving a row no longer removes another row's block when two blocks share a session id (#162).
- The question files beside progress.md no longer pile up, and an idle poll no longer reads them again (#156).
- An idle poll is down to a few file checks, and one file read that never answers no longer stops the 2-second poll from redrawing (#156, #222).
- A turn read after a newer prompt keeps its finished steps and does not reopen the answered question (#145).
- Contributors: one CHANGELOG fragment per pull request, folded at release (#229).
- Dev: a Node-only preflight and the brief checklist (part of #229).
- Automatic connect keeps each board's connections separate (#212).
- An old page tab says how to reconnect when its server stops (#242).
- Docs: pull request rules an agent on another computer can follow (#229).
- Stopped sessions' questions stay with their tasks (#185).
- Docs: a shorter README gets a new user started from any agent (#200, #202).
- Asking an agent for the board keeps its question waiting (#144).
- Regression tests: `a work turn followed by two board looks in one drain is still summed up`, `a board look whose block was undone after it was stored restores its question on the retry`.
- An agent's inbox question leaves Waiting on you after that session continues (#149).
- A cut-off marker line in progress.md no longer hides later blocks and project sections (#239).
- Claude stays working while a background job runs (#153).
- An agent's completed steps and question reach the board even when its question cannot be saved yet (#213).
- A PR check says in words what a pull request still lacks (#228).
- Docs: the README's Codex CLI and Antigravity CLI pictures show the terminal board itself (#202).
- Pasting a live report whose clock is more than three days behind now refuses it and says that nothing was written (#161).
- Working notes name the agent doing the work (#154).
- The terminal and serve boards repair torn question ledgers (#168).
- Codex fallback fixtures no longer spend the observation deadline starting another Node process (#214).
- Press-error fixtures target the action rather than a numbered read (#226).
- Docs: a live parity checklist for every release, and its first record (#253, #285, #289).
- Native Antigravity test hooks finish before their fixture is removed (#159).
- Local setup preserves Cursor and Muse config key order (#171).
- The standalone board can run its normal archive sweep with `--tidy` (#188).

## 0.23.5 — 2026-10-19

- A second `--serve` with another `--idle-minutes` keeps the open page (#166).
- A hand-kept task finished days ago no longer shows as done just now in `--html` or on the `--serve` page (#165).
- Stopped sessions no longer count as In progress (#152).
- `--chat` keeps a short number or plain word after a bare `key:` or `token:` (#167).

## 0.23.4 — 2026-10-19

- Local setup no longer rounds large ids in an agent's config (#160).
- A torn question ledger repairs itself (#151).
- A question a prompt answered leaves Waiting on you for good (#143).
- Keep the tagged-adoption fixtures host-free after trust discovery is added: omit the general fixture's explicit missing executable only inside the empty-PATH, child-process-blocked cases.
- Compare a denied historical-hide action with the exact bytes present after startup migration, while retaining the original legacy keys and later renewal/migration assertions.
- Bound page-fixture HTTP requests, synchronous JavaScript and the live-block terminal probe so a stalled helper cannot bypass the test's deadline.
- Correct the pane test filesystem so dashboard/metadata writes, including direct same-size replacements, advance only their own timestamp.
- Keep Codex reporting instructions until current hooks are approved.
- Preserve the existing Codex hook group positions and foreign entries on reconnect.
- Recognize the current version's frozen release tag when newer source keeps the same manifest version.
- Keep reminder identity stable when an unresolved question moves into retained storage.
- Fix Mark read on live reminder/older questions in the native pane and terminal: validate every age shelf at the action write boundary while retaining exact identity, source and retirement checks.
- Age unanswered questions independently of connection activity.

## 0.23.3 — 2026-10-19

- Break the release fingerprint cycle introduced by the native worker bundle.
- Bound native worker failures to a short code so Node cannot flood the process output with the full verified data URL before reporting the error.
- Persist remove intent before recovering an older connect.
- Run the optional Claude connector through a native transaction.
- Keep verified Codex and Antigravity sessions connected across ordinary native work.
- Preserve canceled text from an uncached completed block when a later prompt renews activity.
- Resolve completion fences against the raw owner before applying prompt receipts.
- Confirm a whole task done in one press.
- Native-hook test cleanup retries transient Windows file locks after assertions finish; persistent removal errors still fail.
- Keep transferred work at its active owner.
- Mixed handoff/ask metadata renews a question only if the final task stays open and waiting on the user.

## 0.23.2 — 2026-10-19

- Keep unprocessed reports visible beside prompt metadata.
- A known legacy session without a valid stored source clock keeps its questions; heartbeat time cannot establish that a prompt is newer.
- Prompt barriers persist as separate immutable metadata receipts, read back before inbox cleanup.
- Answer other agents' questions when a new prompt arrives.
- Keep live agent work out of the archive.
- Recover abandoned native setup and report locks conservatively (#93).
- Resurface explicit same-word Claude asks.
- Preserve question retirement and migration history.
- Keep unchanged questions hidden across step movement and whitespace edits.
- Recover temporary message-poll failures within the existing lease.
- Show pending progress in chat.
- Clarify remote reporting delays and reply limits (#51).

## 0.23.1 — 2026-10-19

- Keep session ids out of the native pane and terminal too.
- Keep connection internals off the progress board.
- Restore the original README layout.
- Keep relay event order when pasting into the board.
- Open the literal board path from legacy commands.
- Write only visible, bounded local progress blocks.
- Use OpenCode's effective config root in legacy connect.
- Initialize more hosts independently.
- Check the shared message contract across hosts.
- Preserve concurrent setup edits.
- Refresh the interactive board image.
- Wait for asynchronous progress observation in the regression test.

## 0.23.0 — 2026-10-19

- Refresh the documentation.
- Send only to live sessions by default.
- Recheck the source before every forwarded message.
- Keep the board focused on work.
- Unify setup and install Antigravity's native hooks.
- Keep the local board available after closing a tab.
- Observe connection handoffs instead of treating sends as completion.
- Receive messages through an owned Antigravity CLI stream.
- Keep native ids on independent progress cards.
- Reply through the existing card.
- Route messages through live session adapters.
- Agent-assisted Codex hook trust previews six owned declarations and, after explicit user consent, merges their exact hashes through Codex's config API.
- Wait for the test agent to start before counting it.
- Codex-only local setup and progress, without Claude Code (#33, #35).
- Independent Cursor and OpenCode bootstrap.
- Pasted blocks preserve local reporter bindings (#105).
- Shared bootstrap plan for nine targets.

## 0.22.2 — 2026-10-18

- Four smaller faults in `/progress connect`, found in an audit (#96).
- Each approval is asked for once.
- A file that cannot be read says so.
- Stored problems follow the language of the session that shows them.
- A Node.js release candidate or nightly counts.

## 0.22.1 — 2026-10-18

- `/progress connect remove` deletes the board's SKILL.md and then its folder, if the folder is empty (#95).
- An empty skill folder that stays is named.

## 0.22.0 — 2026-10-18

- Work nobody had touched for a week still filled the board (#97).
- A task idle for more than 7 days steps aside on every surface.
- A task with no time of its own is aged from when its steps were first seen.
- The terminal board.

## 0.21.3 — 2026-10-18

- `scripts/remote-reporter/merge.py` replaced a session's block with any fragment for that session, without comparing which was newer (#82).
- An older fragment never replaces a newer block.
- Times that cannot be compared keep the old behaviour, and say so.
- Read-back checks each block against the fragment itself,.
- `reporter.py` stamps each fragment at least one second after the previous one,.

## 0.21.2 — 2026-10-18

- A question another agent (Codex, Gemini CLI, Cursor, Grok Build, Muse Code, Hermes Agent, OpenClaw, OpenCode) ended its turn on reached the pane, the terminal board and the board page, but not `progress.html`: until a Claude session summed the turn up into `progress.md`, the HTML board showed nothing waiting (#42).
- `progress.html` now lists the inbox's unprocessed turns in their own section,.
- The text is treated as untrusted.
- A broken inbox never stops the page.
- Every board reads at most the newest 30 inbox files.

## 0.21.1 — 2026-10-18

- Finishing a step in the Claude Code pane writes a line to this month's journal (#68).
- The pane now says when a step is done but its history was not saved,.
- Unsaved lines are kept and retried,.
- A message never waits for the journal.
- When the journal cannot be read, today's count keeps its last value, and resets to 0 once the day has changed.

## 0.21.0 — 2026-10-17

- The board can now be read in a chat app (#73).
- `agent-board.mjs --chat` prints the board as plain text and starts nothing.
- One function hides the home folder and the credential forms the board knows, in everything `--chat` prints.
- A question keeps the underscores inside its words, on every surface.
- The Hermes Agent skill runs `--chat` and sends what it prints as it is, with no link.

## 0.20.11 — 2026-10-17

- A press on the board, or a reply from its page, now acts only on the line it showed, never on another session's block or another step that took its place (#76, which replaces part of #59).
- Every row and question carries a short fingerprint: its block id and the exact step words shown (#2).
- On the page, a tick, an archive and a reply send the fingerprint back.
- The terminal board keeps each line's fingerprint from its last draw.
- A reply being typed belongs to its session and question.

## 0.20.10 — 2026-10-17

- A newer board script no longer starts a second page while the page it would replace is sending a reply to an agent (#77, replacing part of #59).
- `--serve` keeps a page that will not close.
- New text.

## 0.20.9 — 2026-10-17

- The inbox no longer loses a report or its receipt when a read or write fails, and orders reports from the shell and PowerShell reporters correctly (a follow-up to #40 and #53).
- Inbox ordering compares shell seconds and PowerShell milliseconds in the same unit, including stored v0.19.1 order values.
- Receipt failures retain inputs and existing records.
- Malformed and sessionless inbox inputs are retained as `.failed` files with diagnostics, without processed receipts.

## 0.20.8 — 2026-10-17

- A session start no longer hides a setup problem (#38).
- Every setup problem is named, once.
- `/progress connect status`, agent by agent.
- `/progress connect` run by hand ends with the same lines, the problems below them.
- Node.js is checked.

## 0.20.7 — 2026-10-17

- Connecting, updating and removing the plugin never overwrite or delete a file the person changed, and an installation from an earlier release still upgrades without a word (#37).
- A file is replaced only when its bytes are the plugin's own.
- An installation from before the plugin kept a record upgrades silently.
- Removal says what it could not remove.
- Clearer notices while connecting.

## 0.20.6 — 2026-10-17

- Another agent's question says how to get back to the session that asked it, for every agent (#49).
- A way back to every agent's session.
- Another agent's session is named by its own ID.
- An ended session reopens with its own agent's command.
- IDs with underscores are kept; IDs starting with a dash are not.
- The command keeps its folder one string.

## 0.20.5 — 2026-10-17

- An answered question can be put away without answering it again (#52).
- Already answered, hide.
- How a question is matched.
- The list is written with care.
- A quick answer goes only to the question it was pressed on.
- Needs changes beside Looks good.

## 0.20.4 — 2026-10-17

- A question you answered in its own session stops waiting on you (#57).
- Your message marks a Task-list session's `[?]` steps answered.
- A pane button marks its own step when pressed.
- Only the person's message counts.
- The board's page answers only the question it showed.
- Every agent (#52).

## 0.20.3 — 2026-10-17

- A remote reporter can close a session and start a fresh one.
- The remote reporter guide says the conversation wins.

## 0.20.2 — 2026-10-17

- What the reviews of 0.18.1 left open, most harmful first.
- A project named with a comment opening no longer hides the blocks after it.
- What the user asked reaches the model fenced when a task is named and named again.
- A connect run by hand takes the language picked in another session.
- `Status:` and `Summary:` lead into a printed board, like `Here is where things stand:`.
- The guide names the plugin's Pane language for the board script.
- A remote reporter's merge cannot open a comment in a heading either.

## 0.20.1 — 2026-10-17

- Terminal history survives read and write failures.
- The board's page says the same.

## 0.20.0 — 2026-10-17

- The board's page can be opened from a phone on the same Wi-Fi.

## 0.19.4 — 2026-10-17

- The page's address, key and all, is no longer kept beside `progress.md`.
- Two `--serve` at the same moment open one page, not two.
- Archiving now dates a finished hand-kept task on the right day.
- `tsc -p .` reports no errors again.

## 0.19.3 — 2026-10-17

- The reply hint names the session that asked (#49).
- A question from another session says which session to answer in.
- A Claude Code session's question offers its ID to copy.

## 0.19.2 — 2026-10-17

- Waiting on you lists only questions (#48).
- A session that asked nothing is no longer listed as waiting on you.

## 0.19.1 — 2026-10-17

- Another agent's turn is no longer lost on its way to the board (#40).
- An inbox file stays until its turn is on the board.
- No summary from the model no longer empties a block.
- A file a closed session left taken is taken again, not deleted unread.
- A turn taken again changes nothing once a later one is on the board.
- A file that cannot be read stays for a later look.

## 0.19.0 — 2026-10-17

- A board page you can click, for the agents that are not Claude Code.
- Answer a Grok Build or Codex session from the page.
- Paste a web chat's block (Muse, dot) into the page.
- Only the page can use the page.
- On a phone.
- Muse Code gets the board skill.
- A turn that showed the board and the page's address is still only a look at the board,.

## 0.18.1 — 2026-10-17

- What the scan after the 0.17.1 merge left open, most harmful first.
- A comment opening in a block's words no longer hides the blocks after it.
- A short report before the printed board is work again.
- One unreadable inbox file no longer strands the turns taken with it.
- Two sessions in different languages no longer take turns rewriting the board files.
- Hermes hooks that Hermes folded onto two lines are left as they are.
- What the user asked reaches the model fenced as data, like the reply.

## 0.18.0 — 2026-10-17

- Work in the board from any agent, as in the pane.
- Its writes hold up when another session writes at the same moment.
- The board command in Hermes Agent and OpenClaw, tested live.
- README badges name what was tested.

## 0.17.2 — 2026-10-17

- A reply full of board marks no longer holds up the inbox.

## 0.17.1 — 2026-10-17

- Fixes from a live test with Grok Build 1.0.62.

## 0.17.0 — 2026-10-17

- Brings the fixes below to existing installs (`claude plugin update` only picks up a new version), and fixes what the live Muse, dot, Cursor and Hermes runs on Windows found.
- `/progress tidy` archives finished work now.
- The README's agents table says what works, agent by agent.
- From a review of #22, #25, #26 and this release.
- The guides say why Cursor on Windows can stop at "blocked" (another tool's PowerShell hook run through bash) and why a one-off `hermes -q` question shows as stopped.
- Hardening from a review of the whole plugin.
- Fixes from a live test with Muse, dot, Hermes and Cursor.

## 0.16.0 — 2026-10-17

- The board in every agent.
- Board files never count as connecting an agent; the reply says how to open the board in each one.
- A missing reporter no longer makes an agent loop.
- From the whole-project review.
- `/progress connect` wires a stock Hermes Agent.
- Connecting no longer stops an older OpenClaw from starting.

## 0.15.0 — 2026-10-17

- OpenClaw reports too.

## 0.14.0 — 2026-10-17

- Installing is all it takes.

## 0.13.0 — 2026-10-17

- One contract for agents that are not hooked in: each writes its block as a fragment (a `## project` line and a FORMAT.md block), and one merge step puts it into `progress.md`.
- Agents on another machine can report.
- An opt-in local exchange for Codex and dot.
- A host-supplied, verified Codex owner adapter.

## 0.12.0 — 2026-10-17

- Hardening, from a security and robustness review.
- Other agents' words reach Claude as data, not instructions.
- A model call that never answers no longer stops the inbox.
- `resume=` and `dir=` are checked.
- Fewer model calls and a smaller store.
- The reply the model sums up is fenced.
- The writer skips what the parser skips.
- Two sessions writing at once no longer undo each other.
- Each inbox file is read by one session, then deleted.
- Windows is told by the system.
- The installers remove the old name only after the new one is in.
- An upgrade does not sum up old turns again.
- A person's own hook is not taken for ours.
- The README and the guides say that an open session deletes each inbox file once read, for when you check whether a hook ran.

## 0.11.0 — 2026-10-17

- Hermes Agent reports to the pane.
- Grok Build's blocks are named from the request.
- A session log is opened only when it is one.
- Tested live against the real CLIs.
- README rewritten.
- A promotional card.

## 0.10.0 — 2026-10-17

- New name: Agent Board.
- BREAKING CHANGE: an install under the old name does not update to this one by itself.
- Codex, tested for real.
- A short tour at the top of the README.
- A timeline along the bottom shows how far the tour has come.
- README speaks to the reader's problem first.
- Faster poll.
- Set up from any agent.

## 0.9.0 — 2026-10-17

- The pane no longer depends on an agent remembering to report.
- Progress without a Task list.
- A question at the end of a turn waits on you.
- Background follows the goal.
- Handoff at compaction.
- Other agents through their own hooks: `/progress connect`.
- Each hook runs `progress-report.sh` (or `.ps1`), written beside `progress.md`.
- Your own hooks stay.
- README.

## 0.8.0 — 2026-10-17

- Archive a row now.
- Reminders.
- The repository's front page.
- Community files.

## 0.7.1 — 2026-10-17

- Other agents in one step.
- Another agent's command and link, from here.
- English titles are no longer chopped.
- progress.html.
- The AGENTS.md section.
- Setup.

## 0.7.0 — 2026-10-16

- Includes 0.6.0, which was not released on its own.
- Questions by kind.
- Needs you first.
- It does not pile up.
- Readable on light terminals (#715).
- English, 繁體中文, 简体中文.
- A window of its own.
- Other agents.
- How the file is read (still format version 1).
- Auto-update.
- README.
- MIT license.

## 0.6.0 — 2026-10-16

- 和色.
- At a glance.
- Background.

## 0.5.2 — 2026-10-16

- `CLAUDE_CODE_ENABLE_TODO_TOOLS` moves to the shell profile.
- settings.json is edited in place.
- The key stays in settings.json until the shell can set it.
- The pane's hint.
- Installer checks.

## 0.5.1 — 2026-10-16

- A step ticked in the pane is journaled too.

## 0.5.0 — 2026-10-16

- Its own repository and marketplace.
- Quick add.
- Pull request and CI.
- Notifications.
- Status line.
- Journal and report.
- Resume.
- The rule rides the system prompt.

## 0.4.0 — 2026-10-16

- Takes in every fix from the local review of 0.3.0 (`UPSTREAM_ISSUES.md`, numbered as there).
- Windows test fixture.
- 1. A 完成 press could be overwritten.
- 2. A press could tick the wrong line, or a newer mark.
- 3. A failed read could empty a file.
- 4. Archiving a block without its end marker.
- 5. Closing the pane by hand did not stick.
- 6. 接手做完 dropped step names past the fold.
- 7. Repeated titles shared keys (#2, #3).
- 8. Two quick side questions could cross.
- Two of the known issues listed there are fixed too.
- An end marker closes only its own block.
- A block whose end marker was deleted by hand.

## 0.3.0

- Interactive pane: rows open to their steps and actions, 完成 / 完成這步 / 交給 Claude / 接手做完 / 繼續 / 封存, and a side-question box.

## 0.2.0

- Mirrors Claude's Task list, survives compaction, plain-language pane.

