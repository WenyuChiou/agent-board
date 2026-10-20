# Changelog

## Unreleased

- **User-journey tests (#222).**
  Exercise first run, a working day and work across agents and sessions on isolated boards. Async drivers run the shipped terminal, watch, read-only chat, serve page and HTML without opening a browser. Pane journeys use the in-memory engine, a real inbox-shaped prompt and shared answer-ledger files; messaging journeys use synthetic owned native transports. Poll budgets include the page script’s own interval. Recent completions are checked on page/HTML, with chat’s finished-today count read from its journal.
  Tests: `first run: with no progress file every surface says in words that nothing is here yet`, `first run: no surface shows a stack trace, a file path or a session id on an empty board`, `first run: the first block from each host appears on the terminal board within budget`, `first run: the first block appears on the serve page within budget`, `a working day: each session shows one row with agent, project, task and state`, `a working day: steps ticked by an agent show on every surface within budget`, `a working day: an ask answered from the terminal board leaves the waiting count with a visible result`, `a working day: --chat shows the ask and says where to answer it`, `a working day: an ask answered from the serve page leaves the waiting count with a visible result`, `a working day: finished work appears on page and HTML, chat reads today’s journal, and hidden rows stay hidden`, `a working day: the copy-resume action gives each host's native resume command`, `a working day: every press along the day shows a result or a reason next to its card`, `first run: the pane opens on an empty board with words, then shows the first block within one poll`, `a working day: an ask answered from the pane leaves the waiting count with a visible result`, `L3 across agents: a Codex ask on a Claude pane says where to answer it, and once Codex has its answer it leaves every surface`, `across sessions: two pane sessions on one file agree on an answer within one poll`, `messages: a Claude pane shows the Codex fallback while native reply remains tracked by #58`, `across agents: an Antigravity ask answered from the terminal board leaves the page and --chat`, `across agents: a Hermes ask answered from the serve page leaves the terminal board`, `across sessions: an archived session's questions are resolved or carried, never lost`, `across sessions: a resumed session takes its row back without a second row`, `messages: a Codex session reaches its own other Codex session, which acknowledges, and the receipt shows on the sender's card`, `messages: an Antigravity session reaches its own other Antigravity session and the receipt shows on the card`, `messages: Codex to Antigravity and Antigravity to Codex each deliver, acknowledge and show the receipt`, `messages: an answer goes back to the sender as a second message and shows on the sender's card`, `messages: Codex to a Claude session is delivered natively or the card names the copy fallback in words`, `messages: Antigravity to a Hermes session is delivered natively or the card names the copy fallback in words`, `messages: every sender-receiver pair either delivers with a receipt or names the fallback in words`, `messages: a send to a session that just disconnected says so on the card instead of waiting forever`, `messages: a receiver that never acknowledges leaves the card saying the delivery is uncertain`, `across sessions: an ask of a stopped session leaves the waiting count and stays with its task on the stopped shelf`, `across sessions: an ask of an ended session leaves the waiting count and stays with its task on the stopped shelf`, `messages: a message typed on the serve page reaches a Codex card's live session and the card shows the receipt`, `messages: a message typed on the serve page reaches an Antigravity card's live session and the card shows the receipt`.
  Known gaps, checked and expected to fail until fixed: `a working day: archiving removes finished work from the live file and keeps its questions` (#211, hold:terminal-archive-ask; the question is still checked never to be lost), `L3b messages: a delivered message to another agent shows on the Claude pane` and `messages: a delivered message shows on every surface, not only the serve page` (#232). Separate assertions keep native pane reply (#58), receipt visibility on terminal/chat/pane (#232), Hermes receiving (#233), visible footer paths (#250), outgoing sender receipts (hold:sender-receipt), raw ACK ids (hold:raw-ack-id), unsupported receiver adapters (hold:grok-receiver, hold:opencode-receiver, hold:openclaw-receiver, hold:gemini-receiver, hold:cursor-receiver, hold:muse-receiver, hold:deepseek-receiver) and the static combined transport/page poll deadline (hold:page-poll-budget) visible while their remaining checks stay strict.

- **Automatic connect keeps each board's connections separate (#212).** Sessions with their own data folder keep language choices only for that session and show manual connection results in status. A synced progress file keeps connecting automatically after you run `/progress connect` with it once (needed again after this update) when Claude uses its default config folder; a by-hand connect from another progress file takes over. Until then, the pane (once, when the session starts) and connection status explain how to turn automatic connect on, unless its connections were removed by hand; other progress files stay separate. If another data folder's unfinished connection cannot be checked because one of its files is busy, `/progress connect` keeps it and says which error to clear before trying again. A Hermes config that reports to another open board is left alone, including plain YAML, escaped non-ASCII paths and non-breaking spaces, wrapped paths, escaped backslashes and apostrophes, even after an unmatched quote in plain YAML. Connecting by hand also recovers from a crashed removal in another folder that used a different plugin version or has a conflicting unfinished file change. Temporary file locks keep unfinished connections available for recovery; removing connections also drops another folder’s conflicting journal. Connection status waits for startup connect to finish, and acknowledgement reuses its Codex check. Long settings do not prevent repair after a board is deleted. Status keeps unrelated warnings and drops warnings about folders that are gone. Repairs name the agents moved back, notices stay quiet once acknowledged, and language choices leave unfinished connections alone. Older unedited commands can be repaired; connecting by hand can move agents to this board.
  Tests: `a Hermes config re-saved in plain style still counts as another data folder's`, `an ordinary update of our own Hermes hook does not claim a repair`, `a blocked automatic connect still shows each agent's stored status`, `choosing a language leaves another folder's unfinished connection alone`, `choosing a language in a session with its own data folder changes no shared file: CLAUDE_CONFIG_DIR`, `choosing a language in a session with its own data folder changes no shared file: CLAUDE_PROGRESS_FILE`, `automatic connect ignores unreadable config paths for agents without an installed folder`, `a shared board skill names only the installed agents that read it`, `an older released skill from a deleted data folder can be repaired without an ownership record`, `an automatic connect takes back hosts whose reporter was removed`, `a generated connection from another language can move without an ownership record`, `a session with its own Claude data folder does not connect the machine's agents automatically`, `an automatic connect from a second data folder leaves hosts that report to another data folder alone and says so`, `connecting by hand from a second data folder moves the hosts and says so`, `automatic connect compares normalized data paths and reads escaped host path data`, `an automatic connect preserves a foreign encoded board command without a hook or ownership record`, `connecting by hand supersedes another data folder journal without rewriting that folder`, `an automatic repair names every agent it moved back, with or without Codex`, `a Hermes config saved with wrapped lines still counts as another data folder's`, `connect notices are not repeated at the next session start once acknowledged`, `a progress file in a subfolder of the Claude folder is its own data folder`, `automatic connect checks both Codex instruction files before changing any connection`, `automatic connect leaves every connection alone when an existing config cannot be read`, `a journal from a deleted data folder does not prevent automatic repair or replay a conflicting step`, `a pending connection in another live folder has one plain notice`, `an independent board command left in a config does not announce a repair`, `connect status in a separate data folder keeps the result of a manual connection`, `a long setting line in a Hermes config does not block automatic connect`, `once the other data folder is gone its warning leaves the connect status`, `a YAML command with combined apostrophe quoting or non-JSON escapes keeps its board`, `a Hermes config saved with escaped non-ASCII characters still counts as another data folder's`, `only a manual connect changes the machine's selected progress file`, `a progress file in a synced folder that was connected by hand still connects automatically`, `a progress file elsewhere that was never connected by hand does not connect automatically`, `connect from a crashed removal with another plugin version drops the other folder's unfinished connection`, `automatic connect waits for its result before the gate is checked`, `a synced progress file that was connected before this update says once how to turn automatic connect on in <lang>`, `a disabled automatic connect shows no progress file opt-in notice`, `the connection record path keeps the home separators`, `a Hermes config with an escaped non-breaking space still counts as another data folder's`, `a YAML escaped backslash before a folded line break stays a backslash`, `an unmatched quote in a plain YAML value does not hide a later escaped command`, `YAML named escapes decode every PyYAML character in path data`, `connect drops a conflicting unfinished removal from another live folder with the same bundle`, `acknowledgement preserves the checked Codex status without launching another probe`, `a busy file during recovery keeps another data folder's unfinished connection`, `a progress file whose connections were removed by hand gets no automatic connect notice`, `a stored automatic connect removal gets no progress file opt-in notice`, `connect status for a synced progress file explains how to turn automatic connect on`, `quoted connection paths after equals and opening parentheses decode their escapes`, `connection removal also drops another data folder's unfinished connection that cannot be replayed`, `a dismissed automatic connect notice stays dismissed after connect status`, `another data folder's unreadable unfinished connection says which error and how to retry`.

- **An old page tab says how to reconnect when its server stops (#242).** A failed connection turns off the buttons that need the server while keeping copy buttons usable. In all three languages, a notice pinned to the top of the page asks you to run the board with `--serve` again to open a new page; on a phone, it asks you to run `--serve --lan` on the computer and open the new address. Close also shows the offline notice at once when the server is gone or has restarted with a new key. A server that cannot start reports that failure in the terminal, without asking you to close an existing page. The notice is not announced again every 3 seconds. Failed presses clear their in-progress note and keep typed replies until a send succeeds. When the page reaches its server again, it restores the buttons and clears that notice, even when the board has not changed; offline presses are never queued or replayed. If the server answers but cannot read the board file, the page replaces the offline notice with an explanation of the file error. Tests: `a --serve whose server cannot start says so without mentioning a page`, `the phone page explains how to open a new address in every language without LAN access`, `an old page rejected by a restarted server shows the offline line`, `every press on a page whose server restarted with a new key shows the offline line at once`, `the page helper flush leaves a pending press available to resolve`, `L5 restarted server: an old page tab disables its buttons and says how to reconnect`, `a page that reaches its server again enables its buttons and clears the line`, `an old page tab keeps its copy buttons working while the board is unreachable`, `a press that finds the board gone keeps the typed reply`, `a reachable file error replaces the offline line and restores the previous button states`, `a board the page cannot read is named there with that file and its error, rather than shown as offline, and a phone is told the file name only`.

- **Docs: pull request rules an agent on another computer can follow (#229).** CONTRIBUTING.md, Pull requests, now says how to find ready work by label, claim it with an end time, keep a branch current by merging, open a draft and mark it ready, ask a question on the issue and hand work over; the open pull request cap is two per author and eight in all. `scripts/pr-check.mjs` runs on every pull request (`.github/workflows/pr-check.yml`) and its tests in a CI job of their own; the pull request template has an Evidence section and a Task issue form is added.
  Tests: none (documentation only).

- **Stopped sessions' questions stay with their tasks (#185).** Questions from ended, stopped or done sessions leave Waiting on you, its count, focus and notifications. A stopped task with questions stays under Stopped even when due or idle beyond seven days. The pane offers Resolve beside each question, including questions in Done recently, and shows success or the failure reason directly below the pressed button; a changed question or a newer pending report asks the person to look again. Repeated task titles keep each result beside its own Done recently row. Resolve closes the exact question and keeps its saved copy without changing the progress file. Archive still works after the session writes its block again, but an old resolution cannot stand in for an unsaved renewed or identical question. A saved resolution reports success even if the question list could not be updated. Result messages belong to the question pressed, survive unrelated report changes, clear when that question leaves the displayed task questions, and do not add a stopped task to the count. The same question stays resolved when its session wakes up; a session can ask again with new words or an explicit renewal. An older Agent Board version can reopen a resolved question under a new id. Done tasks keep questions in their recent-completion entry, then under Stopped when that entry leaves Done recently. A removed or reworded stopped question stays available for review under Older unanswered questions, including older inbox questions with different words. The pane keeps its own running session live after quiet hours; other surfaces use the last report and can show that session under Stopped after 12 quiet hours; newer inbox turns show while their block is stale. Questions marked answered stay out of task questions and remain in Hidden so they can be shown again. A live inbox question appears once while its block is stale. The terminal, keys board and chat show done sessions’ open questions under Done recently; chat also lists ended and stale sessions’ questions under their stopped count in all three languages. Live and hand-kept questions retain their 3/7-day aging rules. Terminal and serve-page task questions have no Resolve button. On upgrade, repeated questions with the same words can receive new identities when only some were previously shown, resetting their age and local hides because all copies now count. After you press Resolve, the same words can ask again once the agent ticks or removes that step, or the task is renamed. This also works on the terminal board and page, even if an older saved question list returns. A later task in the same session can ask those words too. After a resume, the pane keeps its own questions under Waiting on you before the first turn. Done tasks with resolved or hidden questions stay under Stopped with Archive after leaving Done recently. A refused Resolve keeps its notice beside the changed question. Results shown after a task moves still name its project and task in plain words. The Simplified Chinese button says 标为已处理. Tests: `a question from an ended session is not counted in Waiting on you`, `a question from a stopped session shows on the Stopped shelf with Resolve`, `a question of a working session still counts`, `resolving a stopped session's question closes its ledger record and keeps the copy`, `a resolved question does not come back when its session wakes up, and a new question still counts`, `the board script does not count a stopped session's question`, `resolving one of two identical stopped questions leaves the other identity open`, `a retained question from a replaced stopped session stays out of Waiting on you`, `stopped and done questions bypass aging, due dates, focus and notifications in every language`, `a new raw producer revision renews a resolved stopped question and survives inbox consumption`, `your own session's question stays under Waiting on you after 12 quiet hours while the session runs`, `a failed Resolve shows its reason under the pressed question`, `a woken session's new inbox question shows under Waiting on you while its block is stale`, `a done task's question stays on the Stopped shelf after it leaves Recent`, `a stopped task whose question was resolved can still be archived`, `a stopped question marked answered stays out of its task in the view`, `a changed question explains a refused Resolve beside its button`, `a resolved done question keeps its result beside the task after the task leaves the shelf`, `a reworded question of a stopped session stays reviewable under Older`, `an older resolution of the same words does not let a renewed question be archived`, `a failed Resolve stays beside its question through unrelated report changes`, `Resolve feedback stays with the matching Done recently row when titles repeat`, `Resolve refuses a stopped question that a newer pending inbox turn makes live`, `resolving the last question does not add a phantom stopped task when it moves to Due or Idle`, `archive still works after a resolved question's block is rewritten`, `a resolve result line never shows under a different question`, `a stopped question marked answered can be shown again`, `a done session's open question shows on the terminal board`, `a saved resolution succeeds even when the question index cannot be replaced`, `a question asked again after its resolved step was ticked counts under Waiting on you`, `a resolution does not hide the same words in a later task of that session`, `a retired resolution survives stale ledger replay without hiding a renewed question`, `a done task with a resolved or hidden question stays available to archive after a day`, `a detached Resolve result names its project and task without the repeated-title key`, `after a resume the pane's own question still counts under Waiting on you`, `the terminal board and the page retire a resolution once the agent ticks its step`, `the Simplified Chinese Resolve wording marks a question as handled`. Updated existing coverage: `a stopped task keeps its question on the Stopped shelf and is not counted as In progress`, `own, live external, manual and inbox questions share exact age shelves and actionable counts on every reader`, `a stopped session retains unresolved questions independently of its connection status`, `aged shelf hide actions keep identity and stale fingerprints while retained sources are explicitly review only`, `aged pane questions hide and restore their exact identity in en at 4 days`, `aged pane questions hide and restore their exact identity in en at 8 days`, `aged pane questions hide and restore their exact identity in zh-TW at 4 days`, `aged pane questions hide and restore their exact identity in zh-TW at 8 days`, `aged pane questions hide and restore their exact identity in zh-CN at 4 days`, `aged pane questions hide and restore their exact identity in zh-CN at 8 days`, `marking a question answered on the page or with h on the board writes only the hidden list, sends nothing, and shows it again`, `served questions keep hidden identities across reordered reports and a fresh board process in every language`, `a reply typed for one session is dropped when the box is redrawn for another session under the same title, and a new reply goes to the session shown`.

- **Docs: a shorter README that gets a new user started from any agent (#200, #202).** Each README (English, 繁體中文, 简体中文) is now about 190 lines instead of 293. It opens with one sentence and a light and dark picture of the pane's top, drawn from synthetic data by `docs/preview/render.ts` (`docs/images/pane-<lang>-<light|dark>.svg`), then has a quick start in three steps, one table with the command that connects each agent and opens its board, the four things you do on the board, a table of every agent with its icon, what it reports, how a reply reaches it and what was checked ("untested" where nothing was run), troubleshooting that starts from `--codex-doctor`, and a map of the docs. Only the Node.js 18+ and MIT badges are left; the version and a changelog link are the last line. The Codex CLI and Antigravity CLI pictures now sit one above the other at their own width, so their text is readable; only that pair keeps a visible caption, and the other pictures say they are synthetic in their alt text. The FAQ moved to the guides' new FAQ section. The `--watch` key table now lists `d`, Confirm done. Antigravity and DeepSeek Harness get letter icons, and the diagram now shows Antigravity among the tested agents. The zh-TW sample no longer uses a real account name in its paths. Tests: `L0 README: the README's first image has a light and a dark SVG source and a synthetic label` (`tests/e2e/l0-readme.test.mjs`, the L0 journey).

- **Asking an agent for the board keeps its question waiting (#144).** Board commands leave the agent's question under Waiting on you. With the Claude pane, asking in plain words puts the question back when the reply only shows the board; a later real answer takes it off Waiting on you and closes its question record. A question restored while another program was writing the file returns on the retry. Native reporters preserve questions for recognised board commands. Where Node runs, prompt receipts keep no prompt words. Where it does not, the receipt is written as before and the board drops the words when it reads it. A board look never counts as the answer to an agent's inbox question. Files written by 0.23.2 to 0.23.5 for OpenCode and OpenClaw are still recognised, and the next connect replaces them with the new version.
  Tests: `the board command sent to a session leaves its question waiting on you`, `a free-words board request followed by a board-only reply puts the question back once`, `a real answer after a board request still answers the question`, `a board request receipt stores no prompt words`, `a board-only reply restores an existing question on every board surface and rejects stale restoration`, `the native OpenCode prompt callback flags exact board commands without retaining their text`, `native board prompt commands preserve the waiting question and store no incoming words`, `legacy prompt callbacks flag board commands without retaining their text`, `the sh reporter writes a prompt receipt with no prompt words from stdin or an argument`, `the PowerShell reporter writes a prompt receipt with no prompt words`, `a reporter that cannot run node still writes the receipt and the board drops its words`, `a board reply in the same second as a real answer leaves the question answered`, `a board request, its restoring reply, then a real answer answers the question again`, `an expanded board command sent by Gemini or OpenCode counts as a board request`, `restoring several questions advances each revision beyond the previous one`, `a question followed by a board turn in one drain keeps the session waiting`, `a session end clears a provisional question before a later board turn`, `prompt plugin templates released before the board-request flag are still recognised as ours`, `a board turn after an inbox question in one drain does not settle that question`, `a board command prompt after an inbox question does not settle that question`.

  Regression tests: `a work turn followed by two board looks in one drain is still summed up`, `a board look whose block was undone after it was stored restores its question on the retry`.

- **An agent's inbox question leaves Waiting on you after that session continues (#149).** A later response with text from the same session, or an accepted prompt to it, closes the raw inbox question as well as its summed-up step, even after moving folders or without reporting one. If another write gets in the way while the question is being closed, the board tries again at the next check, and nothing the agent said is read twice. The answer still closes the question when the board file could not be read back, when the summary added no step, or when the question reaches the board up to ten minutes after the answer. After a plugin reload, an answer not yet recorded waits for that session's next turn. An empty stop event, rereading the same turn, another session's turn, an end or cleanup leaves the question open. Tests: `a turn whose block is undone after it was stored still settles its question on the next poll`, `a session with no steps whose summary stays silent still settles its question`, `an answer seen while this session did not yet know the question settles it once the ledger has it`, `a duplicate delivery of the asking turn leaves the question open`, `a committed turn keeps its answer evidence when the board read fails`, `a committed prompt keeps its answer evidence when the board read fails`, `an answer whose ledger write races is settled by the next poll, not lost`, `a prompt whose ledger write races is settled by the next poll without replaying its receipt`, `a ledger this version cannot read leaves taken turns and prompts on the board without notices`, `a cursor stop file from the asking turn leaves the question open`, `a question asked without a working folder is settled by the same session's next turn`, `a question and its answer taken in the same inbox look settle the question`, `an inbox question is resolved by the next turn of the same session`, `an inbox question is resolved by the person's prompt to that session`, `an end, a cleanup or another session's turn does not resolve an inbox question`, `a prompt that answers another agent's question takes it off Waiting on you and closes its question record`, `codex: a turn that ends on a question stops waiting on you once the next turn in that session ends`, `gemini: a turn that ends on a question stops waiting on you once the next turn in that session ends`, `cursor: a turn that ends on a question stops waiting on you once the next turn in that session ends`, `grok: a turn that ends on a question stops waiting on you once the next turn in that session ends`, `muse: a turn that ends on a question stops waiting on you once the next turn in that session ends`, `hermes: a turn that ends on a question stops waiting on you once the next turn in that session ends`, `openclaw: a turn that ends on a question stops waiting on you once the next turn in that session ends`, `opencode: a turn that ends on a question stops waiting on you once the next turn in that session ends`.

- **A cut-off marker line in progress.md no longer hides later blocks and project sections (#239).** Every surface says, in its own language, that progress.md has a cut-off marker line and how many tasks may be hidden, and still shows every complete block. Only an unfinished `auto session=`, `/auto session=` or `question=` marker counts; ordinary comments, including ones that start with the word auto, stay hidden as before and show no warning. A complete start marker without an end marker stays on the board. When only blank lines follow the cut, a native reporter saves the cut-off text in a file next to the board, repairs the end and adds its report in one write; when text follows the cut, it leaves the file as it is and adds its report. A report that is refused or cannot be saved leaves the board unchanged, says that nothing changed, and leaves no extra file behind. The Python remote reporter reads cut markers by the same rule, and an empty stored board location uses the usual progress file. `docs/FORMAT.md` describes the rule. Tests: `L5 torn tail: the board warns in one line and still shows every complete block`, `L5 torn tail: a reporter append repairs the tail or reports why, never fails silently`, `a cut end marker with later blocks after it still lets reporters write and keeps the file's bytes`, `an old-style comment that starts like an auto marker still lets reporters write`, `a failed fragment save leaves no extra file next to the board`, `a refused fragment save says nothing changed in every language`, `an empty baked progress path uses the usual progress file`, `a torn tail keeps every byte of the torn fragment in a file beside progress.md`, `a block without an end marker at the end of the file stays on the board and is not set aside`, `an invalid report leaves the cut marker untouched and creates no saved fragment`, `restoring a cut end marker preserves non-ASCII session bytes and report text`, `a reporter repairs the cut-off end and adds its report by replacing the board once`, `a cut auto marker preserves earlier tasks and cannot swallow later complete blocks`, `torn-tail detection leaves fenced examples and ordinary multiline comments alone`, `a marker cut before its name still shows the blocks after it`, `a cut marker followed by an arrow in a task line hides nothing`, `a cut end marker is restored only when it can close the open session`, `cut markers accept spaces and tabs after the comment opening but U+0085 opens an ordinary comment`, `cut-marker look-ahead counts project headings and block markers inside a code fence`, `the pane and its HTML warn once about a torn tail without losing complete tasks`, `an ordinary comment that starts with the word auto hides its lines as before and shows no warning`, `a cut marker in the middle of the file is named without saying the end is cut`, `cut markers trim only trailing spaces tabs and carriage returns`, `cut-marker look-ahead counts comment closes inside a code fence`; Python checks: `a remote report after a cut marker stays visible (<!-- /auto se)`, `a remote report after a cut marker stays visible (<!-- /au)`, `a remote report after a cut marker stays visible (<!-- aut)`, `a remote report after a cut marker stays visible (<!-- question=ab)`, `a cut marker followed by an arrow in a task line hides nothing`, `an ordinary comment opening still hides example blocks`, `cut markers accept spaces and tabs after the comment opening but U+0085 opens an ordinary comment`, `cut-marker look-ahead counts project headings and block markers inside a code fence`, `an ordinary comment that starts with the word auto hides its lines as before and shows no warning`, `cut markers trim only trailing spaces tabs and carriage returns`, `cut-marker look-ahead counts comment closes inside a code fence`.

- **Claude stays working while a background job runs (#153).** A successful background launch keeps the session working after its turn ends. While that job still runs, a question in the launching turn’s reply does not create a Waiting on you step. If the job already finished when that reply ends, its question waits on you as usual. A job that finishes later does not bring that question back. A background process that never ends, such as a dev server, keeps the session working until it stops reporting. A real question in a later turn still waits on you while the job runs. Sessions without a Task list keep a placeholder step when needed, and a finished Task list shows “background job running” while work continues. Every completion notice releases its job, whether it finished, failed or stopped, including several notices together or one received before the launch returns. The placeholder step disappears after the last job ends. It also disappears when the session ends or resumes, even if the first resumed turn is aborted. The turn a completion notice starts may be aborted without leaving the placeholder behind. A person’s quoted notice releases nothing. Concurrent task edits and delayed summaries preserve released jobs and finished steps. Tracking a launch does not hold up the tool result or reread the transcript. Agents are counted when the host actually starts them in the background, including agents whose definition requires it. A foreground Agent run requested as background is not counted. Teammates and workflow agents are not counted. A question after this turn’s job finishes still waits on you while an older job runs. A completion without an id releases a job only when no job ids are tracked. A failed save of early releases does not discard the question. A running turn shows Claude working. Retried saves journal each finished step once. A task step or background launch is not lost when it lands during another save. A completion notice after a plugin reload releases its job. A background tool whose host supplies an empty id can finish normally. Session end clears the jobs. A restart or resume forgets jobs from the old process, and resumed sessions are tracked again. The existing 12-hour Stopped rule applies to inactive blocks; continued activity refreshes it. Other agents’ inbox reports are unchanged. Tests: `a turn that starts a background job leaves the block working, not waiting`, `a reply ending on a question does not mark a step asked while the turn's background job runs`, `the background job's completion notice lets the next turn end as waiting again`, `a turn without a background job still ends as waiting and still marks its question`, `one completion notice clears only one background job and unrelated prompts clear none`, `a turn with a running background job keeps a placeholder step and suppresses inferred and summarized questions in every language`, `background work uses the existing twelve hour stale rule and outlives a completed Task list`, `a background session without a Task list keeps a placeholder step instead of a summarized question`, `a background session without a summary still writes a working block with a placeholder step`, `a background completion received during a turn restores waiting and session end clears remaining jobs`, `a background summary that finishes after session end cannot restart work`, `a failed or stopped background job releases the session like a completed one`, `a background job that finishes inside the turn that started it leaves the block waiting, not working`, `two background jobs released in either order leave the block working until both end`, `a person's prompt that quotes a task notification releases no background job`, `a background summary that lands after a completion keeps that turn's finished steps`, `refused, errored and foreground tool calls create no background work or extra transcript read`, `turn tools include Bash before a task notification in the same turn`, `a resumed session forgets background jobs its old process started`, `a background release racing a task update is not overwritten`, `a question asked in a later turn while a background job runs still waits on you`, `a session resumed after it ended with a background job running is tracked again`, `a later turn without a Task list can ask a question while a background job runs`, `a background tool result returns before its mirror save finishes`, `every background notification in one prompt releases its job`, `an aborted turn started by a finished job removes the placeholder step`, `a question after a background job that finished in its own turn still waits on you`, `a question after a background job that finished in its own turn still waits on you without a Task list`, `a session that ends with a background job running leaves no placeholder step behind`, `an agent defined to run in the background is counted even when the call does not ask for it`, `an agent asked to run in the background while background tasks are off is not counted`, `clearing background jobs removes only the generated turn step and keeps the original mirror`, `a resumed session drops its old background placeholder before an aborted turn`, `a retried background save journals a concurrently completed step only once`, `a completion turn waits for a queued background launch before releasing it`, `a teammate or workflow agent the turn starts is not counted as a background job`, `a question after this turn's job finished still waits on you while an older background job runs`, `a question after this turn's job finished still waits on you while an older background job runs without a Task list`, `a completion without an id releases a job only when no job ids are tracked`, `a failed save of early background releases still records the question`, `a save with nothing to change does not undo a task step or launch written while it waited`, `a background job launched before a reload is released when its completion notice starts a turn`, `a background tool with an empty id can finish without leaving a job running`, `a turn after the last background completion does not save an empty release`, `a prompt turn and poll do no background bookkeeping before a job is launched`, `concurrent first task saves keep both steps`.

- **An agent's completed steps and question reach the board even when its question cannot be saved yet (#213).** Unsaved questions retry every two seconds and after restarting the session, without holding a processed turn for fifteen minutes. If even that saved copy cannot be stored, the turn is taken again later. A locked progress file or one damaged saved question no longer stops polling or other agents' turns. The pane shows the retry warning alongside the existing recovery advice, and clears the warning when saving works again. At most fifty questions await retry, for at most three days after the board takes their turn; completed questions are dropped, and delayed saves keep the turn's original time. Tests: `another agent's turn that ends on a question is written to the board even when the question file cannot be read`, `a question that could not be kept is kept on a later poll once the question file reads again`, `a question file that cannot be read shows one line at once instead of retrying the turn for hours`, `a race while keeping an agent's question retries on the next poll instead of fifteen minutes later`, `a fresh session keeps a pending inbox question from the store without its turn file`, `a session that starts while progress.md is locked still polls and takes turns`, `one damaged pending question does not hold other agents' turns`, `a pending question older than three days is dropped`, `a pending question whose step is already done is not kept`, `pending questions keep their turn time and unchanged retries do not rewrite them`, `pending questions keep only the newest fifty while the question file is unreadable`.
  If removing or loading a saved question fails, it is tried again on the next poll, and the agent's turn still finishes. Tests: `a failed pending question deletion does not hold a processed turn`, `a pending question that cannot be loaded at startup retries without stopping polling`. A question that cannot be saved no longer holds another agent's turn; failed removals keep retrying, even after expiry. A source agent's clock cannot expire a newly taken question. Old saved questions from another progress file are cleaned up, and failed startup cleanup leaves the board polling. Tests: `a pending question that cannot be saved does not hold another agent's turn`, `a saved question whose removal failed is removed on a later poll and the warning goes away`, `a captured question with an old source clock still gets its first save`, `expired pending questions from another progress path are pruned at startup`, `a failed startup prune still registers polling and takes turns`. Two existing tests now expect the turn files to be processed while their questions await retry, rather than left unprocessed: `immutable question capture read failure marks same-batch end sources processed with the question pending` and `immutable question capture write failure marks same-batch end sources processed with the question pending`.

- **A PR check says in words what a pull request still lacks (#228).** It checks the issue and claim, the Author line and branch, template sections, the CHANGELOG entry of fix and feature pull requests and its covering test titles, the open pull request limit (two per author, counting a dispatching lane as part of the name, and eight in all), and private data or images. Run it for an existing pull request, a local body file, or a CI event; failures explain how to fix them, never print a found secret, and in CI keep pull request text from being read as a workflow command. Tests: `pr-check accepts a conforming pull request body and a CHANGELOG entry whose test titles exist`, `pr-check fails a body without a Fixes or Part of line and says how to add it`, `pr-check fails an Author line that names another branch`, `pr-check fails an empty template section and an unchanged checkbox`, `pr-check fails a CHANGELOG title that no test has and names it`, `pr-check fails an entry added under a released version instead of Unreleased`, `pr-check matches template-literal test titles and placeholder names`, `pr-check fails the newest pull request over the cap and keeps older ones`, `pr-check counts each author and lane on its own and leaves governance pull requests out of the cap`, `pr-check finds a session id, a home-folder path and a token link in added docs and the body`, `pr-check requires synthetic alt text for images in the body`, `pr-check exempts releases, asks an entry only of fix and feature pull requests and permits Tests none only for documentation changes`, `pr-check tracks added line numbers across hunks and ignores deleted files and newline markers`, `pr-check checks naming and accepts both old and new branch claims`, `pr-check rejects embedded bitmaps and binary images except generated social previews`, `pr-check reports the last review verdict and distinguishes current and older heads`, `pr-check combines issue state claims cap and draft information without mutating inputs`, `pr-check reads committed files rather than dirty working files and appends a safe Markdown summary`, `pr-check prints each message on one line whatever line breaks the pull request text holds`, `pr-check checks CI event commits even when another branch is checked out and leaves the bundle to test.yml`, `pr-check leaves the bundle to CI in a checkout that converts line endings`, `pr-check reads gh API lists line by line and reports a missing issue as missing, not as a network error`, `pr-check prints usage and returns environment errors without exposing input secrets`, `pr-check judges pictures by name and a moved file at its old path as well as its new one`, `pr-check paginates CI API data and fails closed on network errors`.

- **Docs: the README's Codex CLI and Antigravity CLI pictures show the terminal board itself (#202).** They were two English browser screenshots, the same in every language. They are now SVG pictures that `docs/preview/render.ts` draws from synthetic data with the board's own code (`boardScreen`, the `--watch` screen), with that agent's question open, in each README's language, and in a light and a dark version that follow GitHub's theme. "The board's page" in the READMEs now says in a few lines what the page does; its phone and `--lan` detail moved to the guides' new "On a phone" section. The READMEs show no PNG or JPG screenshots any more: the historical connector screenshot and the zh-TW work screenshot are no longer shown (the files stay in `docs/images/live/`), and every picture says it uses synthetic data. Checked by rendering every picture and viewing it on a light and a dark page.

- **Pasting a live report whose clock is more than three days behind now refuses it and says that nothing was written (#161).** The message shows how many days behind it is, in every language. A `working` or `waiting` block can no longer arrive already old enough to be archived by tidy or the sweep; older `done` and `ended` blocks still merge as history. Tests: `a pasted working block whose clock is three weeks old is refused and nothing is written`, `a pasted done block with an old clock is still merged`, `a pasted working block is merged up to exactly three days old and refused a millisecond later`, `the board script refuses a pasted working block with a weeks-old clock in every language and writes nothing`. Two existing source-time tests keep their ordering and ownership checks: one moves its test clock to its 2020 fixture's date, the other now pastes a report a minute old.

- **Working notes name the agent doing the work (#154).** A Codex or other agent's block no longer says “Claude is working”, including after a prompt receipt. Existing notes correct themselves the next time their block is written. Waiting notes name no agent in all three languages, and the English waiting note now reads “Waiting for your next message” instead of “waiting on your reply”, since a waiting session is idle, not asking a question. `docs/FORMAT.md` shows the new words. Tests: `a Codex block set to working says Codex is working, not Claude`, `every agent's working block names that agent`, `a Claude block keeps its working and waiting words`, `the waiting line names no agent`.

- **The terminal and serve boards repair torn question ledgers (#168).** Interactive readers move malformed JSON or NUL bytes aside without overwriting a prior quarantine, recheck the moved bytes, and rebuild from source captures. A good ledger caught by a race is restored without replacing a newer one; unknown JSON shapes stay untouched. Missing-ledger installs cannot overwrite another writer, and a failed replace retains a complete copy. Chat and one-shot reads remain read-only. Tests: `the terminal board quarantines torn ledgers and rebuilds captured identities so hiding works again`, `the terminal board preserves unknown JSON ledgers and never overwrites a quarantine collision`, `ledger recovery accepts relative progress paths and treats shell-sensitive folders literally`, `a good ledger raced into quarantine is restored without replacing a newer ledger`, `a missing ledger install never replaces a concurrent writer or leaves its own skipped temp`, `a failed ledger replace restores the complete temp or keeps it when every move fails`, `--chat remains read-only beside interactive flags even with a torn question ledger`, `the serve page repairs a torn ledger and hides its captured question without changing the report`.

- **Codex fallback fixtures no longer spend the observation deadline starting another Node process (#214).** Their synthetic control host now answers over streams inside the CLI fixture, keeping ownership, drift and approval assertions independent of OS startup scheduling. Real subprocess protocol tests remain in `codex-host.test.mjs`. Production deadlines are unchanged, including the legacy transaction's one-second observation. A delayed synthetic reply verifies that approval stays unconfirmed, managed fallback instructions remain byte-identical, and the existing explanation is shown. Test: `the Codex trust check keeps the fallback and says why when the host answers too slowly`.

- **Press-error fixtures target the action rather than a numbered read (#226).** Once a snapshot settles, legacy question migration adds an answered-list read before the key action; the old third-read fault could therefore stop a pre-action view instead of testing redraw after a failed press. The synthetic fault now checks the action phase, and controlled clocks exercise both sides of the settlement boundary while preserving error, byte-retention and recovery assertions. Tests: `a press on the board names an answered list it cannot read or replace, with its error, and never writes over it`, `a press failure redraws the board after the question snapshot settles`.

- **Docs: a live parity checklist for every release, and its first record (#253).** CI cannot show what a person sees inside each agent's own app or CLI. `docs/validation/PARITY-CHECKLIST.md` says how to open the board from inside every installed mainstream agent before a release, with the UI and the CLI of one vendor as separate rows, six checks per row, how to keep the run from touching real settings, and how to take screenshots that show no private data. A surface with no row in the record ships as untested. `docs/validation/2026-10-20-parity-0.23.5.md` is the first run, on 0.23.5: which checks passed in each agent's app and CLI, which stopped at a sign-in or trust screen, and the five new problems it found (#285 to #289). Tests: none (documentation).

- **Native Antigravity test hooks finish before their fixture is removed (#159).** Windows CI reported a null child status after roughly 11.8 seconds; the old 10-second subprocess deadline omitted error and signal diagnostics, so its exact historical cause remains unconfirmed. The test now allows 30 seconds, awaits closed output streams, and on timeout terminates its owned process tree rather than only the outer shell. If closure cannot be confirmed within a further two seconds, it reports the owned PID and termination diagnostics while retaining the fixture. Windows pipe destruction is best effort: an unref'd fallback exits the failing test process with status 1 rather than waiting indefinitely for those handles. An isolated refusal probe verifies actual process exit before its outer watchdog, then stops only its recorded synthetic processes before cleanup. Async fixture cleanup keeps its existing bounded removal retries. Production commands and semantic assertions are unchanged. Tests: `native Antigravity hook commands bind conversationId, record metadata only and keep Stop resumable`, `native hook timeouts close their owned descendant tree before fixture cleanup`, `failed native tree termination reports a bounded error and retains its fixture`.

## 0.23.5 — 2026-10-19

- **A second `--serve` with another `--idle-minutes` keeps the open page (#166).** It used to stop the running page and start a new one, so the open tab stopped working and a reply typed there but not yet sent was lost. It now reuses the running page and, when that page's idle time differs from the one asked for, prints the one in effect. Tests: `--serve with a different idle preference reuses the running page and reports its effective timeout`, `--serve with an idle time that is not a number starts no page`.

- **A hand-kept task finished days ago no longer shows as done just now in `--html` or on the `--serve` page (#165).** The board script built its view with no completion times, so every finished hand-kept task counted as finished at the moment of reading. It now reads the times recorded in `progress-seen.json`, which the pane, `--watch` and `--serve` write; a task with no recorded time, or one in the future, gets no age and is left out of the recent list instead of being shown as new. So a one-shot `--html` lists a task finished just now only once one of those has seen it. Text, `--chat` and `--keys` output is unchanged, since they do not list recent completions. Tests: `manual completion observations map sidecar fingerprints to view keys without inventing times`, `manual completion observations preserve translated fallback keys and conservative repeated titles`, `the CLI view ages manual completions from sidecar fingerprints without renewing old or unknown times`.

- **Stopped sessions no longer count as In progress (#152).** A session that ended, or went quiet for more than 12 hours, stayed in the In progress list, so the count included work nobody was doing, and a stopped task with a question was counted both there and under Waiting on you. Such tasks now go to a Stopped shelf, closed at first and newest first, on the pane, the terminal and keys boards, `--chat`, progress.html and the serve page; `--all` and the `i` key open it with the idle shelf. A task due within 14 days stays under Due, and one idle for more than seven days stays on the idle shelf. Its questions stay under Waiting on you, and its row keeps every button. The group line no longer counts stopped tasks, since none are left in a group. Tests: `an ended or stale session's task moves to the Stopped shelf and leaves the In progress count`, `a stopped task with a question shows once under Waiting on you and is not also counted as In progress`, `progress.html and the serve page show stopped tasks in a closed shelf`, `every language has the stopped count words`, `the pane keeps stopped tasks behind one toggle and shows their actions when opened`, `the board script lists stopped tasks only with --all and names how many`. Existing tests that read an ended row from the In progress list now read it from the Stopped shelf, or open the shelf first; none lost a check.

- **`--chat` keeps a short number or plain word after a bare `key:` or `token:` (#167).** Task text such as `Per-key limit — key: 100` or `token: budget` was masked, so the line read as a credential. The value now stays when the label stands alone and the value is a number of up to five digits or one plain word (lower case, or with only its first letter in capitals). Everything else after such a label stays masked: a longer number such as a one-time code, letters mixed with digits, a code in capitals, a name like `api.key:` or `$key:`, an `=` assignment, a quoted name or value, a credential name such as `API_KEY` or `password`, and a known token prefix. Tests: `chat redaction keeps ordinary bare key and token labels while masking explicit and recognizable credentials`, `--chat keeps ordinary key and token budget text readable while hiding synthetic credentials`.

## 0.23.4 — 2026-10-19

- **Local setup no longer rounds large ids in an agent's config (#160).** `--codex-setup` and `--codex-remove` read an agent's JSON config with a plain parse and wrote it back, so an id past 2^53 in `openclaw.json` or a `hooks.json` (a Telegram or Discord id) came back rounded, and the bot stopped answering that person. They now read it as the connect path does: a config that is not a JSON object, or holds a number a parse would change, is one conflict, and nothing is written. This also changes two cases that used to stop setup with a parse error: a config that is not valid JSON is now a listed conflict, and an existing empty config is read as `{}`. Tests: `local setup leaves an openclaw.json holding an id past 2^53 untouched and reports the conflict`, `local setup leaves a hooks.json holding an id past 2^53 untouched and reports the conflict`, `local removal leaves native configs holding ids past 2^53 untouched and reports conflicts`, `local setup reports a config that is not valid JSON as one conflict and leaves it untouched`; `local setup preserves native config formatting when its content does not change` covers the unchanged-file case that already held.

- **A torn question ledger repairs itself (#151).** An interrupted write could leave the question list (`progress-questions.json`) cut off, and from then on hiding and archiving failed in every session, with nothing on screen. A list that is not JSON at all is now moved aside and rebuilt from its source copies. A list in a shape this version does not know is still left alone, since a newer version may have written it. The list is written to a temp file and moved into place. A rebuild never moves over a list another session put there meanwhile, and a replace that fails on Windows never leaves no list at all. The pane names the file when it stays unreadable or unwritable for three polls in a row; another session's write landing between two reads does not count. Tests: `a torn question ledger is moved aside and rebuilt from its source copies, so hiding a question works again`, `a question ledger that is valid JSON in an unknown shape is left alone and never written over`, `the question ledger is written to a temp file and moved into place, never truncated in place`, `the pane says when the question ledger cannot be read`, `a torn question ledger is told apart from one in an unknown shape`.

- **A question a prompt answered leaves Waiting on you for good (#143).** After the person sent another agent a prompt, the agent's block turned working and the step finished, but the finished step lost the words the question was recorded by. The question record stayed unresolved, so the pane, the terminal board and `--chat` kept listing it, and it aged into a reminder. The finished step now keeps the asked words, cleaned as the block writer cleans them, as the native reporters' `[?]` → `[x]` already does, and the record closes. The same holds for a Claude session without a Task list whose summed-up question the person's next prompt answers, and for another agent's summed-up question that its next turn answers. Tests: `a prompt keeps the answered question's words on its finished step, so the question's record closes`, `the person's next prompt keeps this session's summed-up question's words on its finished step, so its record closes`, `a prompt that answers another agent's question takes it off Waiting on you and closes its question record`; `another session prompt barrier survives an older digest read-back retry` now checks for the finished step instead of the question's absence; `without a Task list, a turn that changed something is summed up into steps and its question` and, for each of the eight agents, `<agent>: a turn that ends on a question stops waiting on you once the next turn in that session ends` now expect the asked words on the finished step, and the latter that the step's question record closes.

- Keep the tagged-adoption fixtures host-free after trust discovery is added: omit the general fixture's explicit missing executable only inside the empty-PATH, child-process-blocked cases. Preserve the no-native-attempt assertion. Tests: the four `bundled tagged board adoption` cases.

- Compare a denied historical-hide action with the exact bytes present after startup migration, while retaining the original legacy keys and later renewal/migration assertions. Test: `historical hide marks survive failed reads while an observed renewed question gets a fresh identity`.

- Bound page-fixture HTTP requests, synchronous JavaScript and the live-block terminal probe so a stalled helper cannot bypass the test's deadline. Tests: `live blocks of every agent refuse forged web archives without writes and terminal a and tidy preserve them`, `page Confirm done buttons act once with exact fingerprints and journal all new ticks in three languages`.

- Correct the pane test filesystem so dashboard/metadata writes, including direct same-size replacements, advance only their own timestamp. Preserve direct progress renewals and native Map behavior. Test: `mock file timestamps isolate sidecar writes and preserve explicit progress renewals`. This corrects a demonstrated mock artifact; it does not establish the cause of full-suite timeouts.

- **Keep Codex reporting instructions until current hooks are approved.** Wire bounded read-only trust observation into native setup, recheck exact source bytes and owned executables before retiring fallback, preserve managed fallback and effective override content, and project fresh read-only status in all three languages. Tests: `new or untrusted Codex hooks keep fallback and exact approval retires it in en` (also zh-TW/zh-CN), `lost or unsupported Codex trust restores effective override fallback while status writes no instructions`, `a trusted observation invalidated before the lock cannot retire fallback or overwrite foreign groups`, `a hook source change while reading instructions cannot retire an existing fallback`, `an empty override remains empty and does not shadow personal AGENTS rules with a generated fallback`, `approved definitions cannot retire existing fallback after the owned board is replaced` (also reporter), `managed fallback edits preserve outside bytes and refuse ambiguous owned markers`. Validation evidence, including failed suite results and focused checks, is retained in `docs/validation/2026-10-19-codex-fallback.md`.

- Preserve the existing Codex hook group positions and foreign entries on reconnect. Add a read-only current-definition trust query for legacy hooks; partial, changed, disabled, duplicate or unavailable discovery cannot establish approval. Tests: `reconnecting Codex preserves each owned group position and foreign hook groups`, `grouped hook renewal retains foreign entries inside a mixed group at their original positions` (`tests/connect-trust.test.ts`), and the control-query cases in `tests/codex-host.test.mjs`. Validation evidence and approval-discovery limits are recorded in `docs/validation/2026-10-19-codex-fallback.md`.

- Recognize the current version's frozen release tag when newer source keeps the same manifest version. A missing installer record no longer makes a known tagged board look foreign; edited personal files remain protected. The mutable pre-tag fingerprint stays outside its own bundle, preserving convergent release builds. Tests: `the bundled release table excludes its current board fingerprint and retains historical ownership`, `bundled tagged board adoption: exact 0.23.3 without prior ownership updates and becomes owned`, `bundled tagged board adoption: exact 0.23.2 without prior ownership updates and becomes owned`, `bundled tagged board adoption: a modified published board stays preserved and unowned`, `bundled tagged board adoption: exact seeded prior ownership still updates the published board`.

- Keep reminder identity stable when an unresolved question moves into retained storage. A native pane reply creates resolution evidence only after submission succeeds and the exact producer revision and source are rechecked; a dropped or failed submission leaves the original ask unread. Tests: `a question another agent asks notifies once, not the ones already there at the start`, `a pane button whose answer does not reach Claude leaves its step waiting on you, buttons and all`, `an accepted pane reply cannot mark a same-word producer renewal made during submission answered`, `retaining a question changes no reminder identity while a new producer incarnation can notify`.

- Fix Mark read on live reminder/older questions in the native pane and terminal: validate every age shelf at the action write boundary while retaining exact identity, source and retirement checks. Label retained copies and served-page shelves as review only where no mutation is supported. Tests: `Mark read on reminder and older terminal shelves saves the exact identity in every language`, `aged shelf hide actions keep identity and stale fingerprints while retained sources are explicitly review only`, and the six `aged pane questions hide and restore their exact identity` cases.

- **Age unanswered questions independently of connection activity.** Keep questions prominent through three days, group reminders through seven days, then retain them in a discoverable older shelf without actionable counts. Preserve immutable, content-addressed full source copies and original age across restart, inbox processing and explicit archive; end events never answer a pending ask, and multiple same-owner asks survive source cleanup and stale index writes; automatic archive retains unresolved sources. Opening a shelf grants no approval or completion. Exact resolved producer-token replays cannot recreate an unanswered incarnation; a new revision or changed question still resurfaces. Tests: `question age is pending at three days, a reminder through seven days, and older only after seven days`, `own, stopped external, manual and inbox questions share exact age shelves and actionable counts on every reader`, `complete retained source questions remain recoverable after explicit archival and storage checks refuse an uncopied replacement`, `automatic archive never removes an unresolved question even in an ended or done block beyond seven days`, `question retention failure refuses explicit archive and preserves the original source`.

## 0.23.3 — 2026-10-19

- Break the release fingerprint cycle introduced by the native worker bundle. The bundle keeps historical board ownership and current command/reporter hashes, while the full generated table records the current board externally. Test: `the bundled release table excludes its current board fingerprint and retains historical ownership`.

- Bound native worker failures to a short code so Node cannot flood the process output with the full verified data URL before reporting the error. Cleanup still checks the exact stage owner. Test: `a large verified module reports a bounded failure without embedding its data URL`.

- **Persist remove intent before recovering an older connect.** Save the native disable flag before any journal recovery. Account for an already-applied step's ownership, then remove the old scope instead of replaying its connect; a delayed automatic request stays disabled and a later explicit connect can re-enable. Foreign drift and changed-bundle journals remain fail-closed without losing disable intent. Tests: `remove intent survives interruption before recovering an older partial connect and retains its ownership` (also after), `a remove before pending recovery retains disable intent on drift without replaying connect` (also bundle).

- **Run the optional Claude connector through a native transaction.** Route connect/remove/automatic setup/language/status and notification acknowledgements through verified short-argv worker staging. Canonical native ownership and durable disable intent replace SDK writer authority across data roots; delayed automatic setup cannot undo removal. Pane/polling start before slow probes, and absent Node or damaged authority fails closed. Migrate recognized initial status metadata, preserve explicit language choices and foreign edits, and retain journal conflicts for recovery. Older active plugin writers must reload; this coordinates cooperating versions and makes no CAS or uncooperative-writer atomicity claim. Tests: `startup shows the pane and polls the inbox while a version probe waits and remove fences its delayed auto request`, `the setup adapter fails closed for node without falling back to engine config writes` (also bootstrap/worker/corrupt), `initial native status migrates only recognized display metadata and ignores later SDK seeds`, `native language preference at an explicit connect wins and delayed automatic seeds cannot revert it`, `native legacy connect and remove preserve foreign configuration and own every generated file in en` (also zh-TW/zh-CN), `a paused live worker fences legacy remove and the independent installer across data roots`, `a killed writer resumes fingerprint journal recovery before removal without retaining credential bodies`, `a killed remove keeps its disable intent and a delayed auto finishes recovery without reinstalling`, `configuration drift after the journal is prepared is retained as an explicit recovery conflict`, `the native worker bootstrap refuses changed code and unknown stage ownership before execution`.
- Keep verified Codex and Antigravity sessions connected across ordinary native work. Busy owners can send; inbound messages remain queued until their adapter is ready, without consuming a claim or inventing an ACK. Poll readiness does not weaken ownership, session, turn, deduplication, or permission checks.
  Tests: `receive=false renews an authenticated lease without claiming queued work`; `busy native owners remain connected and can send: codex` (also `antigravity`).

- Preserve canceled text from an uncached completed block when a later prompt renews activity. Bounded internal snapshots keep these `[-]` lines outside completed-work counts without inferring a recipient; a fresh producer mirror can supersede the snapshot. Tests: `uncached completion retains canceled pointers through the first old inbox and older prompt` (also equal/newer), `uncached completion retains bounded canceled text outside completed counts and fresh owner truth wins`.

- Resolve completion fences against the raw owner before applying prompt receipts. Delayed or equal-time prompts preserve completion; proven later prompts resume activity without restoring prior questions. Revalidate raw and effective snapshots while folding turns, and reconcile native cache/board records inside the common lock. Tests: `raw-owner completion and older prompts compose without restoring prior questions` (also equal/newer), `a held older model summary cannot stand over a pane confirmation on its raw owner`.

- **Confirm a whole task done in one press.** Add pane/page buttons and terminal `d` for manual tasks and stopped/ended agent blocks. Preserve canceled steps, journal every new tick, set block completion time, and protect the stored stopped-session mirror from late old turns. Live or changed selections are refused, including changes below the next step. Tests: `Confirm done preserves canceled and hidden steps and guards every agent at the live boundary in every language`, `Confirm done on the pane journals every new tick and protects the stopped mirror from late turns in en` (also zh-TW/zh-CN), `a pane Confirm done rechecks changed words and resumed sessions before writing`, `terminal Confirm done finishes every open step and refuses changes below the next step`, `page Confirm done buttons act once with exact fingerprints and journal all new ticks in three languages`, `Confirm done leaves every step open when its journal cannot be replaced and retries without duplicate ticks`.
  Persistence/concurrency coverage: `Confirm done distinguishes manual twins across repeated project headings and preserves unrelated concurrent work`, `Confirm done preserves a failed journal notice and retries every new entry once`, `Confirm done still journals its saved ticks and reports a completion overlay write failure`, `Confirm done preserves a newer stopped-session mirror before press` (also during write and between final get and set).
  `Confirm done changes only visible checkbox marks through comments and preserves CRLF` covers legal comment placement and hidden examples.
  Completion records never overwrite mutable owner mirrors and are retained without age-only expiry. The common local reporter reconciles exact board completion into session JSON before reusing old lifecycle steps; fresh explicit reports still supersede completion. Tests: `immutable completion overlays project exact or older mirrors and leave fresh genuine work unchanged`, `an old completion fence survives owner pruning and rejects delayed work while allowing a genuinely newer turn`, `repeated Confirm done presses journal each new step once`, `native lifecycle events retain a board-confirmed completion in session JSON instead of reopening old steps` (synthetic common-reporter fixtures for all ten local agent labels, not native model acceptance). Progress and SDK storage remain separate best-effort writes; no cross-process atomicity is claimed.
  Blocks without an initial owner cache also receive a completion fence. Tests: `Confirm done fences the first delayed legacy delivery even when the owner cache did not exist`, `block-sourced completion fences bind every agent and preserve equal newer and undated owner work`, `an absent owner becoming fresh during completion storage is preserved without false success`.
  A newer or semantically different cached task is refused before any completion write, including ended/done tasks and equal-clock content changes. Tests: `Confirm done refuses cached ended work with newer clock before capture` (also done and equal-clock content), `cached owner selection compares title steps statuses context and binding across translated lifecycle prose`.

- Native-hook test cleanup retries transient Windows file locks after assertions finish; persistent removal errors still fail. This covers the Node 22 Windows CI `ENOTEMPTY` teardown failure in the Antigravity hook command fixture without changing runtime hooks or test assertions.

- **Keep transferred work at its active owner.** Accept an explicit per-task `handoffTo` declaration and a named `HANDOFF` in turn digests. Preserve cancelled source pointers with recipient names, omit their Continue action, exclude them from completed-work journal entries, retain them across passive TaskList refresh and allow explicit reclamation. Cancelled-only tasks are closed with zero completed steps, including activity-only updates. Existing five-field digests and all progress marks remain compatible. Proposals and transport acceptance do not establish a handoff or approve actions. Tests: `a confirmed task handoff removes only the transferred owner responsibility and survives a passive list refresh`, `turn digests retain an explicit handoff as a cancelled pointer without treating proposals as transfers`, `handoff pointers preserve the recipient and count work only at its active owner in en` (also zh-TW/zh-CN), `a task handoff removes Continue while retaining the recipient in the pane and file`, `an inbox handoff summary keeps the source cancelled rather than offering its next step again`, `cancelled-only work is closed without counting a finished step and an empty task stays open`.

- Mixed handoff/ask metadata renews a question only if the final task stays open and waiting on the user. TaskList reloads retain the handoff recipient and question revision; explicit reclamation can renew that question without disturbing another hidden ask. Tests: `mixed handoff and ask metadata keeps producer revisions through reload and explicit reclamation in en` (also zh-TW/zh-CN).

## 0.23.2 — 2026-10-19

- **Keep unprocessed reports visible beside prompt metadata.** Read-only previews cannot establish that a prompt was accepted or answered a question. Skip prompts without hiding pending reports, including future/overflow timestamps, missing source clocks and sessions without a board binding. Prompt prose stays excluded. Tests: `pending previews keep reports and questions after future prompts` (also unsafe-order/unknown-source/unbound-session), `--chat keeps unprocessed reports and questions after future prompt metadata` (same variants).

- A known legacy session without a valid stored source clock keeps its questions; heartbeat time cannot establish that a prompt is newer. Tests: `a known agent without a valid stored source clock keeps its questions despite a later heartbeat`, `a known session with no stored source clock keeps its visible question on prompt intake`.

- Prompt barriers persist as separate immutable metadata receipts, read back before inbox cleanup. Denied, nonpersisting and unreadable receipts retry without a model call. Completion composition uses the prompt's source clock, preserving old/equal/unknown or invalid clocks and retaining the barriers against paused writers. Tests: `a prompt denied write retains its claim until its immutable receipt is verified` (also nonpersisting write/readback error), `a newer owner landing immediately before prompt persistence is never overwritten`, `immutable prompt receipts project over stale owner writes without answering newer work`, `prompt receipts compose after manual completion and only newer source prompts resume work`.

- **Answer other agents' questions when a new prompt arrives.** Verified prompt hooks clear only a newer receipt's existing, visible, closed block with the exact agent/session binding, then mark it working without reading a transcript or calling a model. Prompt intake bypasses slow summaries; an older in-flight summary rechecks the stored prompt barrier before writing. Existing binary turn/end order and legacy seconds migration stay unchanged. Connecting/removing covers the new hooks; exact pre-prompt Grok/OpenCode/OpenClaw output upgrades while personal edits stay preserved. Independent native prompt metadata also answers questions without treating ordinary activity as an answer. Tests: `another agent prompt immediately answers its visible question without a model or transcript read`, `unknown stale equal-clock and unclocked agent prompts change neither mirrors nor board`, `a prompt clears a question during an older model summary and that summary cannot reopen it`, `connecting installs and removes every verified shell prompt hook while preserving personal hooks`, `pre-prompt plugin templates retain the exact bytes released in 0.20.5 and 0.23.1`, `independent prompt metadata answers questions while ordinary activity and replay preserve newer questions`. Source contracts, clock/provenance limits and offline acceptance are in `docs/validation/2026-10-19-prompt-hooks.md`; no new native-host execution is claimed.

- **Keep live agent work out of the archive.** Explain the live-block rule on the pane, terminal and page in all three languages. Recheck session activity before writing an archive, including a session that resumed after selection. Cover every agent kind, custom blocks, the 12-hour boundary, ended sessions, tidy and forged web requests without writes. Tests: `every agent keeps live blocks safe across terminal and page at the twelve-hour boundary in every language`, `pane archive controls protect every live agent and explain why in en` (also zh-TW/zh-CN), `live blocks of every agent refuse forged web archives without writes and terminal a and tidy preserve them`.

- **Recover abandoned native setup and report locks conservatively.** Share one exclusive native lock with a bounded wait, retain live or unknown owners regardless of age, recover an expired lock only after its owning process is confirmed dead, and retain detected replacement files during cleanup. An abandoned recovery gate is retained and reported as busy. This hardens the independent installer/reporters; legacy `/progress connect` still needs its complete native transaction migration, so #93 remains open. Tests: `a paused live native writer cannot be displaced by an expired lock`, `a killed native holder is recovered only after the stale bound`, `two simultaneous reclaimers cannot replace the successor of a dead native owner`, `unknown owners and abandoned recovery gates are retained without running a native mutation`, `native lock cleanup preserves a replacement and releases after an action failure`, `an uncreatable native lock fails before the mutation runs`, `failed native lock initialization closes its descriptor and preserves a detected replacement`. The existing `setup refuses a config change after planning instead of overwriting another writer` remains the config snapshot check, not a claim of atomic comparison against noncooperating writes.

- **Resurface explicit same-word Claude asks.** Carry each task's producer revision through optional progress-file metadata and TaskList reloads. Explicit TaskUpdate and repeated matching end-of-turn questions renew only that question; heartbeats and unrelated updates preserve other hides. Tests: `an explicit same-word producer renewal resurfaces only its own question without an intermediate observation`, `explicit Claude ask events renew the hidden question immediately while another hidden question stays hidden`, `producer tokens survive equal-word question reordering and cannot inject hidden source comments`.

- **Preserve question retirement and migration history.** Immutable records survive stale active-ledger and acknowledgement replay, are read back before publishing transitions, and never expire with task age. Tests: `immutable retirement and legacy consumption survive stale active ledger and acknowledgement replay`, `retirement proofs reject stale active replay and proof storage failures keep renewed questions visible`, `a restarted served board applies immutable retirement evidence after stale active ledger replay`.

- **Keep unchanged questions hidden across step movement and whitespace edits.** Persist scoped question incarnations shared by the pane, terminal, served/generated pages and chat; distinguish duplicate asks, conservatively resurface ambiguous duplicate changes and renew observed resolved asks. Retain historical hide records and migrate them with durable markers; hiding remains visibility-only and Show again remains available. Tests: `a hidden question keeps its durable identity across unrelated step movement and cosmetic whitespace after restart`, `equal-word questions retain separate identities and an ambiguous duplicate removal transfers no hide`, `interleaved stale writers cannot reuse a hidden identity for another scope or a renewed incarnation`, `a durable legacy migration marker prevents a stale ledger from transferring the historical hide`, `a pane hide survives step movement and whitespace and a corrupt identity file refuses a new hide`, `an incomplete report cannot commit legacy migration and a falsely successful identity write cannot hide an ephemeral question`, `served questions keep hidden identities across reordered reports and a fresh board process in every language`. This supplies identity storage for future unanswered-question aging; it does not implement that policy.

- **Recover temporary message-poll failures within the existing lease.** Retry only polling after a network failure, timeout or HTTP 5xx; preserve the exact verified binding without renewing its lease on failure. Disconnect on ownership loss, authentication errors, stale turns or expiry. Never replay a durable claim or infer an ACK from recovery. Tests: `a temporary poll failure preserves a verified connection and delivers a queued message once`, `a lost poll response after durable claiming is never replayed or turned into an ACK`, `a forbidden or stale heartbeat closes the connection instead of retrying authentication`, `temporary board failures cannot keep an expired connection alive`, `native ownership loss during poll recovery closes the exact binding`. These use synthetic local transports, with no new native-model acceptance claim.
  Temporary message-store locks (`EPERM`, `EBUSY`, `EAGAIN`) return HTTP 503 instead of disconnecting a valid binding as a conflict. Empty polls leave durable state untouched. Tests: `a transient message-store rename failure recovers polling without replaying delivery`, `an idle or already claimed poll preserves the exact durable state`.

- **Show pending progress in chat.** Include bounded, redacted unprocessed reports after questions, with agent/project attribution and honest source age. They prevent a false empty-board message. Keep claimed/processed inbox copies out without treating fresh hook timestamps as proof of processing. Without a prose summary, show metadata rather than the original user prompt. Chat remains read-only. Tests: `a chat board shows unprocessed reports with honest age instead of a false empty state in every language`, `chat pending reports follow questions and share redaction and omission limits`, `chat never presents a raw user prompt as an unprocessed progress summary`, `a saved inbox digest appears once in chat even when its receipt cannot be written`, `--chat includes pending progress without claiming an empty board or mutating its sources`, `--chat does not duplicate a claimed digest or mistake a fresh heartbeat for processing`, `--chat shows pending metadata without forwarding a raw user prompt`.

- **Clarify remote reporting delays and reply limits.** Describe each sync interval plus transfer/merge/refresh time, retain source-age checks after failed sync, and remove the outdated claim that a remote card resumes a closed session. Explain self-declared names and where to answer without adding a display-name field to FORMAT v1. Existing runtime coverage: `default web and API refuse closed Codex and Grok sessions without starting a process`, `chat relay repeated imports change neither bytes nor freshness and equal-time edits conflict`. This documents mitigations for #51; no new remote delivery or native-session capability is claimed.

## 0.23.1 — 2026-10-19

- **Keep session ids out of the native pane and terminal too.** Identify questions by task and agent, remove id-only clipboard actions, and copy the exact resume command only when requested. The read-only page omits resume internals. Tests: `every agent keeps exact resume bindings without showing session identifiers in board text`, `another session shows its task without ids and copies only an actionable resume command`.

- **Keep connection internals off the progress board.** Show only actionable update waits/timeouts, without transport inventory or native session identifiers. Preserve Send, hide and restore. Test: `the page keeps actionable progress delays without connection inventory or native identifiers` (all three languages).
- **Restore the original README layout.** Retain tour/flow SVGs and the dark terminal illustration, correct outdated setup/privacy/surface claims, and align English Codex/Antigravity board examples at the bottom in all three languages. Images use synthetic data and are separate from native acceptance evidence.

- **Keep relay event order when pasting into the board.** Preserve source time; refuse older or same-time conflicting reports, leave exact retries unchanged, and never invent freshness for an invalid or future source clock. Unknown historical clocks require an explicit comparison bound to the exact two reports. Local and LAN imports share the same checks; imports confer no delivery or approval. Tests: `chat relay keeps newer progress and refuses an older question on both local and LAN imports`, `chat relay repeated imports change neither bytes nor freshness and equal-time edits conflict`, `chat relay refuses unknown and future source clocks without inventing an update time`, `chat relay reviews unknown historical clocks and rejects confirmations after either report changes`, `an ambiguous historical relay clock needs a review of that exact report pair in every language`.

- **Open the literal board path from legacy commands.** Keep ordinary paths readable; encode shell-sensitive paths before passing them to Node, preserving arguments and stdin on Windows and POSIX. Escape Gemini's enclosing TOML prompt separately; use the same command for OpenCode and every board skill. Retain exact historical-file adoption and preserve personal edits. Tests: `generated board commands pass literal shell-sensitive paths through Gemini and OpenCode wrappers`, `every legacy board skill uses the literal-path command and adopts only exact historical output`.
  Served-board test cleanup also waits for a killed fixture process and retries transient Windows file locks; persistent cleanup errors remain failures. Existing `a newer --serve does not start a second page while the page it would replace is sending a reply, shows that page with a note, and replaces it once the reply is in` covers the cleanup path.
  Its stand-in succeeds only after explicit release; deadline expiry fails. The hourly archive test defers unrelated frequent timers beyond its interval, preserving the archive callback and assertions without raising the default timeout.
  Runtime ownership checks and the release generator share raw/JSON/encoded path normalization; the release matrix checks both command forms on two Windows and two POSIX homes. Test: `release command normalization keeps platform paths and encoded paths portable`.

- **Write only visible, bounded local progress blocks.** Share the board scanner for every independent reporter: leave fenced examples unchanged, ignore hidden closing markers, and reject incomplete ownership spans or appends hidden by unfinished Markdown. These validation failures leave both progress and session metadata unchanged. Tests: `local reports preserve fenced examples and update only the visible owned block`, `local reports refuse hidden appends without changing progress or session state`, `local reports refuse a closing marker beyond another task block`, `local reports ignore a fenced closing marker while replacing their own complete block`.

- **Use OpenCode's effective config root in legacy connect.** Resolve `OPENCODE_CONFIG_DIR`, then `XDG_CONFIG_HOME/opencode`, then the default once for detection, plugin, board command, shared skill and owned instruction cleanup. Leave stale default directories untouched. Tests: `OpenCode connect uses its effective config root for automatic setup, repeat and removal`, its manual counterpart, `OpenCode explicit config root wins over XDG when using the Windows reporter`, `OpenCode generated paths use the exact Windows config root with spaces and non-ASCII`, `OpenCode config override wins over XDG and a stale default directory never indicates installation`.
  Keep setup notices strictly typecheckable by passing their narrowed arguments explicitly; the existing multilingual status tests cover their output.

- **Initialize more hosts independently.** Add OpenClaw metadata lifecycle subscriptions, a plugin manifest and native skill without conversation access; add DeepSeek Harness's Cordis lifecycle plugin, owned YAML patch and native skill. Grok prompt submission returns idle work to working. Respect OpenCode's config overrides and refuse foreign metadata or a moved installation root. Tests: `OpenClaw native metadata callbacks fence stale runs and never request conversation access`, `DeepSeek native callbacks report their own identity and preserve task completion`, `DeepSeek setup appends an owned native patch and preserves other YAML on removal`, `Grok prompt hooks return a waiting session to working through the native shell shape`, `OpenCode honors its config override for installation, doctor and removal`, `auto setup detects overridden host directories without scanning sessions`.
- **Check the shared message contract across hosts.** Synthetic adapters use one durable store, exchange in both directions, deduplicate ids and refuse inactive sources/targets. No new native receiver or model-delivery claim. Test: `portable agents share one durable synthetic hub without implicit native delivery or expiry`.
- **Preserve concurrent setup edits.** Compare the original planning snapshot under the installation lock, including other ownership records, instead of rereading a later snapshot that could hide another writer. Test: `setup refuses a config change after planning instead of overwriting another writer`.
- **Refresh the interactive board image.** Share one current English UI screenshot across all three READMEs, label its synthetic data, and retain the expanded installation prompt. Manually checked question hiding/restoration, card expansion, manual-step completion and service reuse; no image is claimed as a model-delivery result.

- **Wait for asynchronous progress observation in the regression test.** After writing a fresh exact-session report, poll for the server to observe it, as the real page does. Keep future timestamps and wrong sessions rejected. Test: `handoffs time out visibly until exact fresh progress appears, independently of a live receiver`. No runtime or release-bundle change.

## 0.23.0 — 2026-10-19

- **Refresh the documentation.** Shorten all three READMEs and guides, keep the common install prompt expanded, remove screenshot galleries, and update setup, format, security, development and release guidance. CLI, App and IDE evidence remain separate; legacy Gemini compatibility is not Antigravity. No file-format change.

- **Send only to live sessions by default.** Both web controls and the action API
  refuse to launch closed Codex/Grok sessions, including boards without a message
  store. Copy and Copy resume remain. Legacy resume requires `--allow-resume`, never
  becomes a message-hub fallback, and is removed when reopening without that flag.
  Tests: `an ordinary board never resumes a closed session even without messaging
  enabled`, `default web and API refuse closed Codex and Grok sessions without
  starting a process`, `reopening a board replaces an explicit resume opt-in when
  that flag is removed`.

- **Recheck the source before every forwarded message.** An inactive or unverifiable
  owner cannot enqueue during the interval before the next poll. Idle hook-only cards
  no longer use a running-task placeholder. A native Codex ACK waits for its matching
  completed turn, preserving the receiver while Stop hooks finish. Tests:
  `a Codex ACK before delayed native turn completion keeps its receiver online`,
  `ACK text from a failed native Codex turn cannot acknowledge delivery`,
  `an inactive source is refused
  before polling notices it and cannot enqueue a delivery`, `the generated Codex hook
  command runs through the platform shell with JSON on stdin`, `native Antigravity
  hook commands bind conversationId, record metadata only and keep Stop resumable`.

- **Keep the board focused on work.** Remove receiver diagnostics, visible session ids,
  duplicate healthy-connection rows and transport jargon. Send, copy, mark read and
  show again retain their exact internal binding and behavior. Coverage: `an existing
  card sends only to its exact live receiver and preserves mark read and unhide`.

- **Unify setup and install Antigravity's native hooks.** All three READMEs now start
  with an expanded, agent-neutral installation prompt and the common installer.
  Antigravity is the current consumer CLI entry; Gemini CLI is documented separately
  for enterprise/API compatibility. Detection no longer treats the shared `.gemini`
  parent as proof of Gemini CLI. Antigravity setup merges its named native schema,
  binds `conversationId`, records bounded metadata and keeps Stop resumable. Foreign
  or edited hooks remain untouched. Windows commands also survive the native executor's
  `cmd /c` quoting of paths containing spaces, without changing shell policy. Tests:
  `auto setup does not mistake an Antigravity
  profile or the shared gemini directory for Gemini CLI`, `Antigravity setup merges
  its named native hooks and removes only the owned definition`, `native Antigravity
  hook commands bind conversationId, record metadata only and keep Stop resumable`,
  `an edited Antigravity definition is a conflict rather than an automatic trust or overwrite`.

- **Keep the local board available after closing a tab.** Local idle shutdown is
  disabled by default; `--idle-minutes 30` opts in and zero disables it. The page
  explains its actual setting, reopening reuses a matching service, and Close the
  board still stops it. The separate LAN timeout is unchanged. Test: `a local board
  stays available by default while an explicit idle timeout closes only that server`.
  Windows concurrent reporters also wait within the existing lock deadline when
  exclusive creation meets a delete-pending `EPERM`; no lock is removed or permission
  changed. Test: `concurrent agents preserve every shared progress block and foreign
  manual text` (the Windows Node 24 CI exposed this race).

- **Observe connection handoffs instead of treating sends as completion.** A bounded
  local observation waits for an exact newer progress report, shows a timeout with
  recovery guidance, and never treats a relay claim or ACK as authorization. A status
  area distinguishes progress records from live receivers, including receivers with
  no progress card. It adds no send picker or copy-id button. Requests are ephemeral
  and never retry or change host settings. Tests: `a connection observation requires
  one exact newer report, never a relay claim or ACK`, `handoffs time out visibly until
  exact fresh progress appears, independently of a live receiver`, `a live receiver
  without a progress card is visible and disappears on disconnect`.

- **Receive messages through an owned Antigravity CLI stream.** An adapter can bind
  the host's initialized native conversation to the local message hub without
  starting or resuming a process. It requires a fresh user-input step and the next
  native result counter before recording an ACK, keeps a bounded response body,
  ignores permission requests and removes availability on reinitialization. It
  does not attach to existing editor UIs or claim automatic installation.
  Tests: `an owned Antigravity stream requires native input and the next matching
  result before its ACK`, `an Antigravity stream refuses a busy, foreign or
  unverified native owner`, `an Antigravity response without its ACK stays
  uncertain and is never replayed`.

- **Keep native ids on independent progress cards.** Local reporters now preserve
  their validated full native session id in `resume`, while the block retains its
  short owner-hash id. An exact live receiver can therefore match an installed
  reporter's card. Invalid ids do not acquire a binding; no directory or receiving
  lease is invented. This does not establish automatic desktop discovery.
  Tests: `independent local progress cards match only their full native session
  receiver`, `a local report with an invalid native id never invents a resume binding`.

- **Reply through the existing card.** A live receiver changes that session's existing
  Copy reply button to Send, using its full native session id and agent. The same card
  shows queue and ACK receipts; disconnecting restores Copy. Mark read and show again
  retain their existing actions. There is no separate target picker, and an offline
  card in messaging mode cannot silently resume a saved CLI session. Both Codex
  adapters now include the message-id ACK instruction for ordinary card text.
  The web card keeps Copy resume command and removes the extra Copy session ID
  button. Its receipt carries delivery status without a stale queued toast after ACK.
  Tests: `an existing card sends only to its exact live receiver and preserves mark
  read and unhide`, `a card cannot infer a receiving connection from a matching title,
  prefix or another agent`.

- **Route messages through live session adapters.** An opt-in loopback message hub and
  web target picker bind a receiver to its agent/session/turn, expire disconnected
  leases, persist message ids before delivery and distinguish queue, claim, transport
  acceptance and an actual ACK. The shared adapter API supports authenticated forwarding;
  a Codex existing-proxy adapter steers only a loaded exact thread/turn, while an
  exclusive-owner adapter starts a turn on its own idle loaded session and correlates
  the actual new-turn ACK. Both ignore approval RPCs. A disposable real app-server
  session passed self-delivery, duplicate suppression and conflict rejection; CLI,
  desktop and other-agent acceptance remain separate. See `docs/MESSAGING.md`.
  Tests: `AB-TEST-001 deduplicates exact retries and rejects conflicting contents or
  sources`, `the served message API authenticates connectors and persists claims across
  a server restart`, `a mock Codex proxy keeps steering and native ACK separate and never
  answers approval RPCs`, `an owned idle Codex session accepts only its actual new turn
  ACK and deduplicates self delivery` and the other `tests/messaging.test.mjs` cases.

Agent-assisted Codex hook trust previews six owned declarations and, after explicit user
consent, merges their exact hashes through Codex's config API. It preserves unrelated
settings and reads trust back; native host execution remains a separate acceptance step
(tests: `Codex trust requires an owned installation and an explicit host binary`,
`the installed Codex host grants only six reviewed hashes and preserves unrelated config`).

- **Wait for the test agent to start before counting it.** The existing newer-serve
  in-flight-reply test could see zero launches on a busy Windows host immediately after
  HTTP acceptance. It now waits for the launch while retaining the one-launch assertion.
  Test: "a newer --serve does not start a second page while the page it would replace is
  sending a reply, shows that page with a note, and replaces it once the reply is in".

- **Codex-only local setup and progress, without Claude Code** (#33, #35):
  `node scripts/setup-codex.mjs` previews the standalone board, skill, progress file,
  ownership record and lifecycle hooks; `--apply` installs them. Explicit reports bind to
  the current Codex thread. Trusted hooks update activity directly without transcripts,
  model calls or a Claude inbox consumer. Doctor does not claim runtime trust. CLI and
  desktop acceptance remain separate; the desktop view is a web UI, not a native pane,
  and active-session replies are not added. Tests: "Codex-only setup previews every
  persistent change without writing", "Codex-only setup initializes the board and skill
  without Claude and is idempotent", "Codex explicit reports bind the current thread and
  preserve other blocks byte for byte", "Codex hooks reject unbound sessions and stale
  turns without changing the board", "Codex lifecycle hooks never read transcripts or
  retain conversation and approval payloads", "Codex uninstall removes only owned
  integration files and preserves progress and foreign hooks".
- **Independent Cursor and OpenCode bootstrap:** `scripts/setup-agent.mjs --agent`
  adds native metadata adapters without Claude inbox consumption. OpenCode uses the
  documented plural `plugins/` directory and a session-bound progress tool; its status
  events explicitly lack turn binding. Shared files survive removal of one target.
  Tests: "Cursor initializes independently and binds conversation and generation
  metadata", "OpenCode metadata adapter and task tool work without reading messages or
  Claude", "removing one agent preserves the shared board and skill used by another
  agent". Neither host has been run live for this change.
- **Pasted blocks preserve local reporter bindings** (#105): a matching agent and short
  session id cannot replace a block carrying an owner or resume binding. Test: "a pasted
  block cannot overwrite a local reporter or resume binding with the same agent and session".
- **Shared bootstrap plan for nine targets:** `setup-agent.mjs --agent all` previews every
  integration, installs them sequentially after approval, and shares one progress file.
  Gemini, Grok and Muse have metadata-only coarse status adapters. Hermes/OpenClaw native
  adapters remain explicitly pending; Antigravity has explicit reporting only. Tests:
  "all targets initialize one shared board and explicitly name unfinished native adapters",
  "concurrent agents preserve every shared progress block and foreign manual text".

## 0.22.2 — 2026-10-18

Four smaller faults in `/progress connect`, found in an audit (#96).

- **Each approval is asked for once.** A connect you run by hand printed the Codex `/hooks`
  line and the Hermes `y` line twice: once as a notice and once in the status lines. The status
  lines now say it alone, and the Hermes status line now also names `--accept-hooks`. Test: "a
  hand-run connect names each approval it needs once".
- **A file that cannot be read says so.** A config, the board script, a board command or an
  old hook file that could not be read got the words for a file that could not be written.
  Reads now have their own words in all three languages, and the agent's status line points to
  them; a config that is read but is not valid JSON keeps its own words. Test: "a file that
  cannot be read is named as unreadable, not as unwritable".
- **Stored problems follow the language of the session that shows them.** A problem was stored
  in the words of the session that found it, so `/progress connect status` in another language
  showed it untranslated. Problems are now stored by their string's name and its values, and
  worded when shown; a record written by an earlier release still shows its words, and one
  stored problem that is unknown or damaged is left out without hiding the rest. Tests: "a
  problem stored by an English session is shown in the language of the session that asks", "a
  stored setup status keeps the agents and valid problems when another problem is unknown or
  damaged", "/progress connect status keeps valid problems and agents when a stored problem is
  unknown", "every stored problem names a string each language has, taking the arguments it is
  stored with".
- **A Node.js release candidate or nightly counts.** `v22.0.0-rc.1` or a nightly build read
  as no Node.js at all, so the board command was reported as needing Node.js. It is now read
  by its major version. Test: "a Node.js release candidate or nightly counts by its major
  version".

## 0.22.1 — 2026-10-18

`/progress connect remove` deletes the board's SKILL.md and then its folder, if the folder is
empty. A failed folder removal was ignored, so the remove said it was done while an empty
folder stayed, and a later remove never looked at it again (#95).

- **An empty skill folder that stays is named.** The removal runs first (it refuses a folder
  with anything in it); a folder that is gone, or stays because something else is in it, is
  fine. An empty folder that stays, or one that cannot be looked into, is named, the remove is
  reported incomplete, and `/progress connect status` lists it. The board script still goes,
  since nothing runs it once the skill is gone. A later remove tries the folder again. The
  message now says "this path", since it names folders too. Tests: "an empty skill folder that
  cannot be removed is named by the remove, and the status still lists it", "a second remove
  names the empty skill folder again, and takes it once it can", "a skill folder with another
  file in it stays and nothing is reported", "a skill folder that cannot be listed is reported
  and left in place", "an empty skill folder is reported when its removal is rejected", "an
  empty skill folder is reported when its removal is falsely successful", "an empty skill
  folder is removed successfully".

## 0.22.0 — 2026-10-18

Work nobody had touched for a week still filled the board. A hand-kept task carries no time,
so it stayed until every step was ticked, and a block was only archived while a Claude Code
pane ran (#97).

- **A task idle for more than 7 days steps aside on every surface.** The pane, the terminal
  board, the board's page and `progress.html` leave it out of Needs you now, the counts, the
  focus and the project lists, and show one collapsed **N idle 7+ days** line that lists
  them with how long each has been idle and its question, if it asks one. Exactly 7 days is
  not idle; a time in the future never is; work due within two weeks, finished work and this
  session's own task never step aside. Nothing in `progress.md` changes, and the idle rows
  keep their tick and archive actions. Tests: "a task idle exactly seven days stays on the
  board and one idle a millisecond longer is hidden", "an idle task's question leaves Waiting
  on you and the counts but stays in its idle row", "a task due within two weeks, this
  session's own block and a future timestamp are never hidden as idle", "the idle shelf keeps
  terminal and page row actions without putting its question back in Waiting on you", "the
  pane hides idle tasks behind one toggle and shows them with their age when opened",
  "progress.html lists idle tasks in a closed shelf with their count", "every language has
  the idle count words".
- **A task with no time of its own is aged from when its steps were first seen.**
  `progress-seen.json` beside `progress.md` keeps a hash of each such task and when the pane
  or the board first saw it; changing a step makes it fresh again, and two writers keep the
  earlier time. A task the record does not know, or any while the record cannot be read or
  written, stays on the board. A task gone from `progress.md` leaves the record only once the
  file has held still, so one read of a file caught empty does not reset every task's age.
  The pane reads the record when its stat changes. Tests: "a hand-kept task is aged from when
  its content was first seen, and editing a step makes it fresh again", "a hand-kept task the
  seen record does not know is never hidden", "the seen record keeps the earliest time per
  task, drops tasks no longer in the file only once it has held still, and reads a broken
  file as empty", "the pane records first observations once and keeps undated work visible
  when its record cannot be read or written", "one empty read of progress.md does not reset
  a task's first-seen time".
- **The terminal board.** `i` shows or folds the idle tasks in `--watch`; `--all` prints
  them; `--help` prints the flags. Only `--watch` and `--serve` write the record; a plain
  print and `--chat` only read it. Tests: "the board script leaves idle tasks off the board,
  names how many, and lists them with --all", "the board script's --chat run reads the seen
  record and writes nothing".

## 0.21.3 — 2026-10-18

`scripts/remote-reporter/merge.py` replaced a session's block with any fragment for that
session, without comparing which was newer. A report that arrived late, by git pull, a
cloud drive or a chat-relay block saved to a file, could put a `done` block back to
`working` (#82).

- **An older fragment never replaces a newer block.** The merge compares the two
  `updated=` times and prints one `session <id>: <outcome>` line per fragment: an older
  fragment is skipped, equal times with different content are a conflict that keeps the
  board's block, an identical import changes no bytes, and a newer fragment replaces the
  block. Arrival time is never used. The exit status stays 0 on a skip or a conflict, so a
  caller reads the outcome lines. Tests: "an older working fragment keeps the done block and
  reports why it was skipped", "different content at the same time keeps the existing block
  and reports a conflict", "an identical import changes no bytes and reports a no-op", "a
  newer fragment replaces the existing block and reports the replacement", "the pure merge
  returns each skipped, conflicting and identical outcome", "an older instant with a
  timezone offset is skipped", "equal instants with different timezone offsets report a
  conflict", "a fragment newer by a fraction of a second replaces the board block", "two
  fragments for one session keep the newer block and pass read-back verification", "a
  read-back retry keeps a newer concurrent update and reports the older fragment".
- **Times that cannot be compared keep the old behaviour, and say so.** When the board's
  block has no time, an unreadable one, or either time has no timezone, the fragment
  replaces the block and the outcome says the times could not be compared. A date alone
  counts as midnight UTC. A fragment whose own time is missing or not a date is still
  refused. A board block with no end marker is repaired whatever its time. Tests: "a board
  block with no time is replaced with a comparison warning", "a board block with an
  unreadable time is replaced with a comparison warning", "a board time without a timezone
  is replaced with a comparison warning", "a fragment time without a timezone replaces the
  board block with a comparison warning", "a date alone is compared as midnight UTC and
  skipped when older", "a fragment with a missing or unreadable time is refused and the
  board is unchanged", "a board block with no end marker is repaired even when its
  timestamp equals the fragment", "a board block with no end marker is repaired even when
  its timestamp is newer than the fragment".
- **Read-back checks each block against the fragment itself,** and a fragment that an open
  code fence or comment on the board would hide stops the merge before anything is
  written. Tests: "read-back checks an inserted block against the fragment itself",
  "read-back checks a replaced block against the fragment itself", "an open code fence
  aborts the merge cleanly before the board is written", "an open comment aborts the merge
  cleanly before the board is written".
- **`reporter.py` stamps each fragment at least one second after the previous one,** so two
  updates in the same second, or an update after the clock moved back, still read as newer;
  `retire` does the same. A previous time it cannot follow, or a previous fragment it cannot
  read, no longer stops an update. Tests: "reporter updates within one second advance the
  timestamp and merge while later clock times are kept", "a reporter update advances beyond
  the previous timestamp when the clock moves backwards", "retiring a session advances its
  timestamp so the ended block reaches the board", "a reporter update after the last
  representable timestamp uses the clock instead of failing", "a reporter update overwrites
  a previous fragment that is not valid UTF-8".

Known limit: a burst of updates can put the reporter's stamps ahead of the clock (1,000
updates in one second end about 17 minutes ahead); they fall back in step once real time
catches up. A clock that runs ahead can still make later work from another machine look
older, as `docs/REMOTE_REPORTERS.md` says.

## 0.21.2 — 2026-10-18

A question another agent (Codex, Gemini CLI, Cursor, Grok Build, Muse Code, Hermes Agent,
OpenClaw, OpenCode) ended its turn on reached the pane, the terminal board and the board page, but
not `progress.html`: until a Claude session summed the turn up into `progress.md`, the HTML
board showed nothing waiting (#42).

- **`progress.html` now lists the inbox's unprocessed turns in their own section,** with
  the waiting count raised by each question, both from the pane and from
  `agent-board.mjs --html`. A question shows its text, clipped to 200 characters; a turn
  that is not a question shows only its agent and project. The section says replies go
  back in that agent's own conversation, since the page cannot send one. Tests: "the HTML
  board shows pending questions with an empty progress file and cannot send replies",
  "progress.html shows unprocessed inbox questions before a digest and drops the pending
  copy afterwards", "the HTML board shows only the agent and project for a pending turn
  without a question", "progress.html shows only the agent and project for a pending turn
  without a question", "the static dashboard clips each pending question to two hundred
  characters", "the HTML board keeps a stale inbox question visible until it is
  processed", "the HTML board lists a question in both an agent block and the inbox like
  the terminal board and --serve".
- **The text is treated as untrusted.** It is HTML-escaped, and home folders and known
  credential forms are hidden before it is clipped, as `--chat` does. When the pane builds
  the page it reads no transcript and starts no process, so a transcript path in an inbox
  file cannot pass options to Node. Tests: "the HTML board escapes pending turn text and project
  names", "progress.html escapes inbox text and skips turns already recorded as
  processed", "the HTML board redacts home paths and credentials before clipping pending
  questions", "progress.html redacts home paths and credentials before clipping pending
  questions", "progress.html shows pending questions without reading transcripts or
  starting an agent", "progress.html starts no process for a pending turn whose
  transcript path is a Node option".
- **A broken inbox never stops the page.** When the record of processed turns is damaged
  or cannot be read, every inbox file counts as not processed yet, and `progress.html` is
  still written and reminders still run. Malformed inbox files are skipped, and claimed
  ones still are. Tests: "progress.html is still
  written and reminders run when inboxDone is malformed", "progress.html is still written
  and reminders run when reading inboxDone is denied", "the HTML board skips malformed
  inbox files without losing a valid question", "the HTML board skips claimed inbox files
  while keeping the question in progress.md".
- **Every board reads at most the newest 30 inbox files.** The terminal board,
  `--serve` and `--html` used to read every `.json` file in `progress-inbox/`; they now
  take the same files the pane does: the newest 30 whose names are an agent's turn or
  session end, so other `.json` files there are ignored. Tests:
  "progress.html reads only the newest thirty unprocessed inbox files", "the HTML board
  shows only the newest thirty inbox files", "the terminal and served boards show only the
  newest thirty inbox files".

Known gaps: `agent-board.mjs --html` cannot read the pane's record of processed turns.
Inbox files that were already in the folder when the pane first looked are recorded there
as read and left off the pane's page, but `--html` still lists them, as the terminal board
does. And the script still reads a log tail for a turn with no reply text, so `--html` can
show a bare ◐ line for a turn that the pane's page leaves out.

## 0.21.1 — 2026-10-18

Finishing a step in the Claude Code pane writes a line to this month's journal. When
that read or write failed, the pane said nothing: the step looked finished and its
history was simply missing (#68).

- **The pane now says when a step is done but its history was not saved,** in all three
  languages, under its own heading. The step stays done. The notice does not replace an
  aside that is still loading or a copied report, shows once and stays dismissed until
  the history is saved, then goes away. A journal that cannot be read is never
  overwritten with only the new lines. Tests: "a synthetic journal <read or write>
  failure keeps the step done and retries once in <language>" (en, zh-TW and zh-CN), "a synthetic
  journal failure leaves a loading aside in place", "a synthetic journal failure leaves a
  copied report in place", "a synthetic journal failure notice stays dismissed through
  failed turn retries", "a synthetic pending-store read failure without entries does not
  show a journal notice".
- **Unsaved lines are kept and retried,** with their original time and month: at the next
  step that finishes, the next message, when the session ends, and, for a session that
  ended first, when the next session starts. A retry adds only lines that are not in the
  journal yet, so nothing is written twice; one consequence is that two identical
  completions of the same step in the same minute are recorded once. A damaged retry
  record is set aside and new completions are still saved. Tests: "a synthetic journal
  write failure retains automatic completions until the next journal write", "a
  synthetic journal read-back failure retries an already saved line without a
  duplicate", "a restored pending journal saves each line once in its original month",
  "a synthetic pending journal is retried when its session ends", "synthetic pending
  journals from ended sessions are saved at the next session start", "a synthetic
  journal sweep keeps newer entries when its original lines all save", "a synthetic
  journal sweep keeps newer entries when one original month fails", "a synthetic journal
  sweep failure for another session does not promise a next message retry", "a
  synthetic corrupt pending journal is moved aside and new completions are saved", "a
  synthetic store write failure still saves the new journal line", "synthetic store and
  journal write failures keep new lines for a later retry".
- **A message never waits for the journal.** The retry at the start of a turn runs in the
  background, and the block's `working` state is now written without holding up the
  start of the turn (in the same order: the write queue keeps it). Test: "a synthetic held
  journal failure does not hold up or fail turn start".
- When the journal cannot be read, today's count keeps its last value, and resets to 0
  once the day has changed. Test: "a synthetic journal read failure preserves the count
  only until the local day changes".

## 0.21.0 — 2026-10-17

The board can now be read in a chat app. Hermes Agent and OpenClaw, which answer in
Telegram, used to run `--serve`: it sent back a link that only opens on the computer, with
its key in it, started a server and opened a browser, and a 24-task board is longer than
one Telegram message (#73).

- **`agent-board.mjs --chat` prints the board as plain text and starts nothing.** No page,
  no browser, no address, no file written. Questions waiting on you come first, each with
  the agent and project that asked, then one line per task with its next step, then what
  was finished today (from the journal, by the local calendar day). It keeps to about 3,500
  characters and, when there is more, ends with `+N more`. Questions marked answered or
  hidden are left out and counted in one line, as on the terminal board, and a damaged
  answered list drops no question. A project started in your home folder, which is named
  after it, is shown as `~`. Whatever goes wrong, even a fault that is no file, it prints
  one short plain line with the home folder hidden, never a stack trace, and exits with
  status 1; a file it cannot read is told with a message that says only that nothing was
  changed, since `--chat` writes nothing (it no longer uses the board's "files may
  already have changed"). Tests: "--chat prints the board as plain text and starts
  nothing: no page, no browser, no link, no file written", "--chat leaves out a question
  marked answered, and a damaged answered list drops none", "--chat that fails for a
  reason that is no file says so in one plain line with the home folder hidden, never as
  a stack trace", "a session started in the home folder is shown as ~, not by the
  person’s name", "--chat names what was done today from the journal, and keeps to one message
  however long the board is", "a chat board puts the questions first, each with its
  project and agent, and leaves answered and hidden ones out", "a chat board of 24 tasks
  fits in one message where the terminal board does not, and a longer one ends with how
  many it left out", and "what was done today comes from the journal by the local calendar
  day, in the weekly report’s words".
- **One function hides the home folder and the credential forms the board knows, in
  everything `--chat` prints.** Your home folder becomes `~` (both slash styles, with a
  space in its name, and in any letter case on Windows; "CI/CD", "24/7", "10/17" and
  "and/or" are left alone). Another account's folder goes too, its name read up to the
  slash after it, spaces included (`/mnt/c/Users/Jane Doe/...`). `key=...`, `token: ...`,
  `--password ...`, `Bearer ...`, `Basic ...`, `user:pass@` in an address (the user may
  be empty and the password may hold an `@` or a `/`: it runs to the last `@` before a
  space), the key prefixes (`sk-`, `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `AKIA...`,
  `ASIA...` and the like) and login tokens that start `eyJ` become `•••`, and a `?t=` key
  is taken out of an address. A quote that is never closed hides the rest of its line. A
  long line is clipped before this runs, and the clip drops the word it falls in and any
  start of a folder (`C:\Users\Jane` of `C:\Users\Jane Doe`) left at the end, so neither a
  secret nor part of a name is left half shown. A reply that an agent left waiting is
  hidden whole before its question is picked and cut to 120 characters, so a token is
  never cut in half or loses its underscores first. A secret in any other shape is not
  recognised, and the help and docs say only that. Tests: "chat redaction replaces the
  home folder with ~ in both slash styles, even with a space in its name, and leaves
  CI/CD, 24/7, 10/17 and and/or alone", "chat redaction masks the credential forms it
  knows, drops tokens from links, and keeps the rest of the line", "a token in a waiting
  reply is hidden before its question is picked and cut, so no piece of it reaches the
  chat", "--chat hides a token in a waiting reply before its question is picked, so no
  piece of it reaches the chat", "a clipped line never shows the start of the home folder
  or of another account’s folder, even a name with a space in it", "--chat hides the home
  folder, with a space in its name, and the credentials it knows, in everything it
  prints", and "a chat board has no colour, no page address and no home folder or
  credential, whatever the board holds".
- **A question keeps the underscores inside its words, on every surface.** The question a
  reply ends on (the waiting line of an agent whose turn no session has taken in, and the
  `[?]` step written for a Claude Code turn that ended on a question) used to lose every
  `_`, so `snake_case` read `snakecase` and `ghp_16C7...` lost the underscore that makes
  it a token. An underscore inside a word now stays; one at the edge of a word, which is
  Markdown's emphasis (`_this_`, `__that__`), is still taken out. No earlier test pinned the
  old result. The test "the question a reply ends on: its last paragraph only, without
  code or markdown" gains two lines that do.
- **The Hermes Agent skill runs `--chat` and sends what it prints as it is, with no link.**
  The shared skill for the other agents now starts with the chat rule: in a chat app, run
  `--chat` and send what it prints with no code block or link; otherwise run `--serve` as
  before. OpenClaw, which always answers in a chat app, reads it first. Both are in all
  three languages. A Hermes skill written by an earlier release is still recognised as
  the plugin's own and is updated; one you edited is kept. On Windows the plugin writes
  the board's path with `\`, so a file that has `/` there is kept too. A chat reply
  counts as a look at the board, so it makes no block of its own, and neither does the
  request an earlier release's shared skill made. Tests: "Hermes Agent’s board skill runs
  --chat and sends the output as it is, while the shared skill puts the chat app rule
  first and keeps --serve for any other", "Hermes Agent’s skill from an
  earlier release is still the plugin’s own and is updated, and an edited one is kept",
  "a chat board counts as a look at the board in every language, so the chat reply does
  not make a block of its own", and the 0.20.5 upgrade test "an installation from 0.20.5
  with no record upgrades silently: its board script, every agent’s board command and
  skill, and its reporter, with no agent’s hook passed over", which now picks the older
  skill text it expects by its own wording.

## 0.20.11 — 2026-10-17

A press on the board, or a reply from its page, now acts only on the line it showed, never on
another session's block or another step that took its place (#76, which replaces part of #59).

Why: the board and its page find a target by project and title (a repeated title gets `#2`,
and a question also by its step number), and the check before a write compared only the line's
text, not which block the line belongs to. So a second session with the same project and title,
or a hand-kept step reworded under the same key, could receive a tick, an archive or a reply
meant for the first.

- **Every row and question carries a short fingerprint: its block id and the exact step words
  shown.** It is worked out in one place (`fingerprint` in `hooks/board.ts`) for the page's
  model, the page's server and the terminal board alike, and holds the same for every agent's
  block (Claude Code, Codex, Gemini CLI, Cursor, Grok Build, Muse, Hermes, OpenClaw, OpenCode)
  and for a hand-kept task. A hand-kept task has no block id, so two of them with the same
  title and next step would look alike, and once the first is archived the second takes its
  key (`#2` goes away); their fingerprint therefore also holds how many tasks and questions
  share the project and title, and changes only when such a twin comes or goes. Tests: "a
  press on the page goes through only on the block and step words the page drew, for the block
  of every agent and for a hand-kept task", "two hand-kept tasks with the same title and next
  step are told apart by how many share them: a press meant for the first is refused once it
  has gone, on the page and on the board" and "two hand-kept questions with the same title and
  words are told apart by how many share them: a tick meant for the first is refused once it
  has gone".
- **On the page, a tick, an archive and a reply send the fingerprint back.** The server works
  it out again from the file as it is now, and when it differs (or is missing, as from a page
  opened before this version) it answers 409 with the existing "line changed" note and writes
  nothing. Hide and unhide send nothing to an agent and need no fingerprint. Tests: "a press
  on the page for a task whose block another session took under the same title is refused, and
  nothing is archived until the page draws the block that is there now", "a tick on the page
  for a hand-kept question that was reworded since the page drew it is refused, and the
  reworded step stays open" and "a second press on the page for the first of two hand-kept
  tasks with the same words is refused once it is archived, and the second task stays" (a
  double click). The 0.20.10 test "a newer --serve does not start a second page while the page
  it would replace is sending a reply, shows that page with a note, and replaces it once the
  reply is in" now sends the fingerprint, as the page does.
- **The terminal board keeps each line's fingerprint from its last draw.** `x`, `a` and `c`
  (which copies the command that reopens a session) act only while the line still has it, and
  otherwise show the existing "line changed" note; the next redraw shows the line as it is, and
  the key acts on that. Until a first draw has worked, no fingerprint is kept and these keys
  refuse every line. The keys read the state of the last draw instead of pinning the line
  again, and a draw now reads the files once for both the screen and the fingerprints. Tests:
  "the terminal board archives with a only the block it drew: another session’s block under the
  same title is left alone and named as changed", "the terminal board archives with a only the
  hand-kept task it drew: once the first of two with the same words has gone, the one that took
  its key is left and named as changed", "the terminal board ticks with x only the step it
  drew: a step that became next since is named as changed and left open", "on the board you
  work in, x and a act only on the line as the last draw showed it, and the line now there is
  acted on once drawn" and "on the board you work in, c copies the command only of the block the
  last draw showed: another session’s block under the same title is named as changed". The
  test "a key does nothing to a line that took the chosen one’s place before the screen showed
  it" now redraws before its last key, as the board does.
- **A reply being typed belongs to its session and question.** The page kept drafts under the
  title-based key alone, so a redraw for a second session with the same title left the text in
  its box and Send resumed the wrong session. The draft is now kept under the key, the session
  and the question; a redraw for another session or a new question starts an empty box and the
  old text is dropped. Test: "a reply typed for one session is dropped when the box is redrawn
  for another session under the same title, and a new reply goes to the session shown".
- Unchanged: a question answered in chat (#71), the "Already answered" and "Needs changes"
  choices (#65) and the session-ID and return hints with their copy buttons (#72) behave as
  before, a reply sent from a phone is still refused, and hiding or showing a question still
  writes only the hidden list.

## 0.20.10 — 2026-10-17

A newer board script no longer starts a second page while the page it would replace is
sending a reply to an agent (#77, replacing part of #59).

- **`--serve` keeps a page that will not close.** The old page refuses to close while a reply
  is on its way (up to 10 minutes). `letGo` ignored that refusal, took the page's address file
  away and started a second page, so both could send: in a synthetic check, one session got two
  turns 371 ms apart. `letGo` now says whether the page agreed to close and takes the address
  file only if it did. A page that refused, or whose process runs and holds the connection but
  says nothing, stays: `--serve` starts nothing, prints a note above the page's address (the
  address is still the last line an agent shows) and the next run after the reply replaces the
  page. The same holds for the address file 0.19.0 left beside `progress.md`. A file that names
  a dead process, or a running one with nothing of ours at its port (a number a restarted
  computer gave to another program), is still cleared, so the board is never locked out.
  Concurrent first starts were already safe (the exclusive address file lets one server
  publish) and are unchanged. Tests: "a newer --serve does not start a second page while the
  page it would replace is sending a reply, shows that page with a note, and replaces it once
  the reply is in", "an address file naming a dead process, or a running one with nothing at its
  port, does not keep the next --serve from starting a page" and "a page whose process runs and
  whose port takes the connection but says nothing is shown with the note, and no second page
  starts".
- **New text:** `serveKept` in the three string tables, and one sentence about it in the three
  guides (`docs/GUIDE.md`, `docs/GUIDE.zh-TW.md`, `docs/GUIDE.zh-CN.md`).

## 0.20.9 — 2026-10-17

The inbox no longer loses a report or its receipt when a read or write fails, and orders
reports from the shell and PowerShell reporters correctly (a follow-up to #40 and #53).

- **Inbox ordering compares shell seconds and PowerShell milliseconds in the same
  unit, including stored v0.19.1 order values.** A later seconds report can follow
  a millisecond report, while older turns stay older after upgrading. Tests:
  "reporter seconds and milliseconds share a chronological order", "the same
  reporter instant orders a turn before its end across timestamp units", and
  "legacy seconds order in a stored mirror still rejects older turns after migration".
- **Receipt failures retain inputs and existing records.** Both maps must be read
  and their writes verified before settled claims are deleted; errors surface in
  the pane with the retained path. Tests: "a receipt read failure cannot replace
  other inputs processed records", "a receipt write that returns success but does
  not persist cannot authorize deletion", and "receipt read-back failure retains
  input until a later read verifies persistence", "an unreadable claimed input
  keeps its bytes and immediately names the failure", and "a denied board write
  immediately names the retained claim and persistence failure".
- **Malformed and sessionless inbox inputs are retained as `.failed` files with
  diagnostics, without processed receipts.** Quarantine cannot overwrite earlier
  evidence. Tests: "malformed JSON remains available for diagnosis rather than
  being acknowledged and deleted", "a report missing its session remains
  available for diagnosis", and "quarantining invalid input preserves an earlier
  failed payload with the same name". A later payload of the same name takes the next
  free name (`.failed.1`). Each retained file is named once, and a model that gave no
  summary is still retried quietly, as before.

## 0.20.8 — 2026-10-17

A session start no longer hides a setup problem. It names each one once, and tells a
configured hook from a working board command (#38).

- **Every setup problem is named, once.** A session start used to say nothing of a config it
  could not read or write, or of an OpenClaw too old to hook in, though connecting by hand
  named them. Now it names each such problem, with its path and what to do, the first time
  it finds it. Later starts stay quiet while the problem stays the same, and one that goes
  away and comes back is named again. A machine with nothing new to report hears nothing.
  Tests: "a setup failure a session start used to hide is announced once, the next start
  stays quiet, and /progress connect status still lists it", "a config a session start
  cannot read is named once, and nothing in it is changed", "an agent whose config cannot
  be written is named, and the agents after it are still hooked in", "an OpenClaw older
  than 2026.4.24 is not hooked in, what an earlier connect put there comes back out, and
  connecting by hand says why" and "a problem that goes away and comes back is announced
  again".
- **`/progress connect status`, agent by agent.** It shows what the last connect found and
  writes nothing:
  - each agent's reporting hook: configured, not configured, config not understood, or too
    old;
  - what the agent still asks of the person: Codex's approval in `/hooks`, Hermes Agent's
    question, OpenClaw's gateway restart;
  - whether its board command is ready;
  - then the problems.

  `/progress connect` run by hand ends with the same lines, the problems below them. A
  removal that could not finish leaves its problems for the status. A written hook is no longer
  taken for a working board: the board command has a state of its own. Tests: "the status
  says what each agent still needs, Codex approving, Hermes Agent asking and OpenClaw
  restarting, apart from whether its board command is ready", "once the hooks are taken
  out, the status says so rather than showing the last setup", "a removal that could not
  finish is still shown by the status, with what is left", "each agent’s board command
  is ready only when a board file it reads is in place and Node.js runs, and a hook that
  failed does not hide it", "the setup status in every language names each agent, its hook,
  what it still needs and its board command, then the problems" and "a stored setup state
  is checked before it is shown, so an older or damaged record is not".
- **Node.js is checked.** The board commands and the terminal board run Node.js 18 or newer,
  which a native Codex install does not bring. When a board command is in place, the
  session runs `node --version`. If there is no Node.js, or only one too old, it says so
  once and marks every board command as needing Node.js; the reporting hooks still go in.
  It checks from Claude Code's own PATH, so it says to ignore it when `node --version`
  works in a terminal.
  The READMEs and guides no longer say Codex always brings Node.js. Tests: "without Node.js
  the board commands are named as needing it, once, while the reporting hooks are
  configured", "a Node.js older than the board needs is named with its version when
  connecting by hand" and "a Node.js version is read from node --version, and only 18 or
  newer runs the board".

## 0.20.7 — 2026-10-17

Connecting, updating and removing the plugin never overwrite or delete a file the person
changed, and an installation from an earlier release still upgrades without a word (#37).

- **A file is replaced only when its bytes are the plugin's own.** A command, skill,
  board script or reporter is rewritten or removed only when it is exactly what this
  version writes, what the plugin recorded writing last time, or what a tagged release
  wrote. A familiar name or first line is not enough. Anything else stays as it is, and
  its path is named, even when no new agent connects. An empty file and extra files in a
  skill folder stay too. Tests: "generated files require exact current or recorded bytes,
  never a familiar name or header", "automatic connection and removal preserve personal
  commands and skills, including edits after installation", "a collision is announced
  even when all installed reporting hooks were already connected" and "recorded
  generated bytes permit an upgrade while unreadable or subsequently edited artifacts
  stay intact".
- **An installation from before the plugin kept a record upgrades silently.**
  `hooks/released.ts` holds a hash of every board script, reporter, skill and Gemini CLI
  and OpenCode `/board` command each tagged release generated, in each language, with
  the machine's paths taken out. A file from 0.17.1 to 0.20.6 that matches is the
  plugin's own, so its board, every agent's `/board` command and skill and its reporter
  are brought up to date, and no agent's hook is passed over. A file edited by a single
  byte is still kept and named. `scripts/build-released.ts` writes the table from the
  git tags with no new dependency, and CI fails while it is out of date. Tests: "sha256
  gives the standard digests, past one block and over UTF-8", "a file an earlier release
  wrote is known by its exact bytes with this machine’s paths in it, and an edited one is
  not", "an installation from 0.20.5 with no record upgrades silently: its board script,
  every agent’s board command and skill, and its reporter, with no agent’s hook passed
  over", "board commands and skills written before --serve (0.17.1 to 0.18.1), with no
  record, upgrade silently in every agent", "a released file edited by hand, with no
  record, is still preserved byte for byte and named" and "an exact pre-ownership board
  and command from a release upgrade in the language they hold, while a modified old
  board stays".
- **Removal says what it could not remove.** A disconnection is reported only once the
  file is gone. A failed delete lists its exact paths, leaves the remaining board
  commands with the board script they run, and can be retried; reporter scripts and
  inbox data stay. Tests: "failed and falsely successful deletes report exact leftovers,
  retain the board, and permit a later retry" and "a failed primary plugin deletion is
  not counted as disconnected and other cleanup continues". This is the verified-removal
  part of #39; the wider uninstall documentation stays open there.
- **Clearer notices while connecting.** A reporting script that cannot be written is named
  as one, not as a board command, and a plugin file this plugin recorded writing in an
  earlier version is brought up to date without announcing the agent as newly connected.
  Tests: "a reporter that cannot be written is named as the reporter, and no agent is
  hooked in to run it" and "a plugin file this plugin recorded writing in an earlier
  version is brought up to date without announcing the agent again".

## 0.20.6 — 2026-10-17

Another agent's question says how to get back to the session that asked it, for every
agent (#49).

- **A way back to every agent's session.** 0.19.3 named the session that asked a question,
  but offered its ID only for a Claude Code session. Now, under another session's question,
  the pane, the terminal board, the board's page and `progress.html` show that session's
  whole ID, to find it in that agent's own session list. Where the agent reopens a session
  by ID, a line of its own gives the command that does it once that session is closed, in
  the session's folder: `claude --resume`, `codex resume`, `grok -r`, `gemini --resume`,
  `hermes --resume` or `opencode -s`. Cursor and OpenClaw sessions get the ID only. A
  session that left no ID says plainly that there is no way back to it from here: a block
  written by hand under the AGENTS.md rule, or one pasted from a web chat such as Muse. A
  phone on the local network gets the ID but not the command or its folder. The pane
  (**Copy session ID**) and the board's page (that, and **Copy resume command** where there
  is one) copy for any agent, and the note after copying names that agent's list and
  command. On
  the terminal board, `c` copies the whole command where there is one, since its line is
  cut to the terminal's width, else the ID (unless the step has a command or link of its
  own).
- **Another agent's session is named by its own ID.** The hint named another agent's
  session by its block id, which the agent never shows. It now uses the start of the
  agent's own session ID, which its session list shows; for an ID in parts, such as
  Hermes Agent's, which starts with the day, the start of its last part.
- **An ended session reopens with its own agent's command.** A Codex, Grok Build, Gemini
  CLI, Hermes Agent or OpenCode session that has ended shows
  `cd '<folder>' && <its command> <id>`, as a Claude Code session already did.
- **IDs with underscores are kept; IDs starting with a dash are not.** Hermes Agent's and
  OpenCode's session IDs hold underscores (`ses_…`), and the block marker dropped them. An
  ID must now start with a letter or a digit, so one that the commands above would read as
  a flag (`--dangerously-bypass-approvals-and-sandbox`) is never offered, for any agent,
  Claude Code included.
- **The command keeps its folder one string.** PowerShell reads the curly single quotes
  (‘ ’ ‚ ‛) as quotes, so a Windows folder holding one could end the folder early and run
  what followed; they are now doubled like `'`. A folder that is not a whole path (`-`) is
  left out, so `cd` never reads it as a flag.
- Tests: in `tests/features.test.ts` "every agent’s question says where to answer it and
  how to get back to that session, or plainly that there is none, on every surface" (the
  terminal board at 120 and 80 columns), "the terminal board, progress.html and the board
  page name the session that asked, and c copies the whole command that reopens it",
  "an ended session offers the command that reopens it where it ran", "another agent’s
  question marked answered shows no way back anywhere, and one still asked offers both c
  and h" and "a Claude
  Code block with no resume id offers its block id to copy only when it is a plain id"; in
  `tests/pane.test.tsx` "another agent’s question is answered there, but its command can
  be copied and its link opened from here", which now says there is no way back for a block
  with no ID, and "an item from another session in the same folder names that session’s
  task and id", which now copies a Codex session's ID and shows its command.

## 0.20.5 — 2026-10-17

An answered question can be put away without answering it again (#52).

- **Already answered, hide.** A question from any agent stayed in Waiting on you until its
  session changed its block. A session with a Task list keeps its `[?]` step until Claude
  marks it or the person writes in that session (0.20.4), so a question answered somewhere
  else kept coming back. Every question
  from a session's block, whichever agent wrote it (Claude Code, Codex, Gemini CLI,
  Cursor, Grok Build, Muse, Hermes Agent, OpenClaw, OpenCode, or one written by hand under
  the AGENTS.md rule), can now be marked answered: **Already answered, hide**
  (zh-TW 已回覆，先隱藏) in the pane and on the board's page, `h` on the terminal board.
  It sends nothing to any session and changes no block: it adds the question to
  `progress-answered.json` beside `progress.md`, which the pane, the terminal board, the
  board's page and `progress.html` all read, so it leaves Waiting on you, its count and
  Needs you now on each of them. A task whose questions are all hidden goes back with the
  work in progress instead of saying it waits on you, and a reply sent from its line goes
  as typed rather than as the answer to that question. **N answered, hidden** lists the
  hidden ones with **Show again** in the pane and on the page; `u` on the terminal board
  shows them all again. A hand-kept question is the person's own and is ticked instead.
  A session that stops or ends keeps its questions in its own row, as before; one hidden
  there stays out of the row's status and its reply framing, and is listed again only if
  the session asks something new.
- **How a question is matched.** By its session's block id, the step's place in that
  block, and its words as the block holds them. The session that asked works out the same
  key from its Task list through the line it writes, so headings, empty subjects and `—`
  in a subject agree. Two questions with the same words are hidden one at a time, and
  ticking one never moves a mark onto the other. A blocked step is written `[!]`, so it
  cannot be marked. A press changes only the question pressed. When `progress.md` has held
  still for a poll, a mark whose question left its session's block is dropped, so the same
  words asked again later show; a session with no block in the file yet keeps its marks.
  That clean-up waits its turn in the write queue without holding up the write that
  noticed it, and is dropped if the file moved in the meantime, on disk or in this
  session's last look; the next quiet poll makes it again from the file as it is.
- **The list is written with care.** A press reads, changes, writes and reads back the
  list in the session's write queue, so a press in another session or on the board is
  kept. A list another program holds is never written over: the pane says the press did
  not stick (zh-TW 記不下「已回覆」，這一項還留在清單上。), and the terminal board and its
  page name the list with its error, as they do the board's other files. A list written
  in the last 5 seconds that is not JSON (most likely caught half-written) is not written
  over either, and the press says it did not stick on every surface. A list left broken
  longer than that, or dated well ahead of the clock, hides nothing and is written anew
  by the next press. A look in the pane that cannot read the list keeps the one in hand
  and reads it again at the next poll. The list is read before `progress.md` at a
  session's start without drawing `progress.html` from an empty file, and a press redraws
  `progress.html` at once.
- **A quick answer goes only to the question it was pressed on.** The board's page offers
  yes/no and choice buttons that go into an ended Codex or Grok session. A line's key now
  holds its question's words, so a press made while the page showed one question is
  refused once the same step asks another, and a hidden question offers none. The
  terminal board does the same for `y`/`n` and `1`–`9`.
- **Needs changes beside Looks good.** A review this session asks had one button, **Looks
  good**, which tells Claude the work is fine. Someone who had asked for changes in the
  chat could only press that. It now has **Needs changes** too, which opens the box for
  what should change and sends nothing until the person sends it. The box closes when the
  same task asks something new.
- Tests: in `tests/logic.test.ts` "a question marked answered leaves Waiting on you until
  that session asks something new", "this session and every other reader key a question
  the same way, whatever its words, and two alike stay apart", "a question from every
  agent that writes a block can be marked answered"; in `tests/pane.test.tsx` "a question
  marked answered leaves Waiting on you until that session asks something new, and nothing
  is sent", "a review this session asks offers Needs changes beside Looks good, and marking
  it answered sends nothing", "the answered list survives a session start, a read that
  fails and a press that cannot read it, and forgets a question that left the file", "a
  mark for a question that is gone is cleared without holding up a write that looks at
  the file from inside the queue", "a clean-up of the answered list waits while
  progress.md moves, so a question hidden meanwhile stays hidden", "an answered list that
  is not JSON is left alone while it may be half-written, and written anew once it has
  stayed broken"; in
  `tests/features.test.ts` "the terminal board, progress.html and the board page leave out
  a question marked answered and say how many are hidden", "the terminal board and the
  board page mark any agent's question answered without sending it anything, and show it
  again", "a quick answer pressed while the page showed one question is refused once the
  same step asks another", "a reply on the line of a task whose question was marked
  answered goes as it was typed, and the line no longer opens as asking"; in
  `tests/board.test.mjs` "the board script leaves out a
  question a pane on this machine marked answered", "marking a question answered on the
  page or with h on the board writes only the hidden list, sends nothing, and shows it
  again", "a press on the board names an answered list it cannot read or replace, with its
  error, and never writes over it", "a hide on the page that cannot replace the answered
  list is answered with that file and its error".

## 0.20.4 — 2026-10-17

A question you answered in its own session stops waiting on you (#57).

- **Your message marks a Task-list session's `[?]` steps answered.** When Claude marked a
  step `waiting: "you"` with `TaskUpdate`, the step stayed under Waiting on you after the
  person answered in that session, until Claude marked the task done or cleared `waiting`
  itself, which it often did not. A review left up this way kept its "Looks good" button,
  so one click told Claude the opposite of what the person had just written. Now the
  person's own message marks every open step of that session that waits on them as
  answered, also when they type it while Claude is still working. What the step asked
  stays, for Claude. An answered step leaves Waiting on you, its buttons and the count, and
  the block writes it as Claude's to do with the note "answered, waiting on Claude", so the
  board's page and other sessions no longer offer to answer it either. The mark is kept in
  the session's mirror with the step's words. It ends when Claude's `TaskUpdate` sets
  `waiting: "you"` again, even in the same words, or when the step's subject or note
  changes. A turn that ends on a question can ask on the step again too, as a plain
  question without the buttons of the one the person answered. Claude moving other steps,
  or a re-read of the Task list, keeps the mark.
- **A pane button marks its own step when pressed.** Only that step stops waiting, and the
  answer it sends names the step (for example `關於「檢查圖 2」：看過了，沒問題`). If the answer does
  not reach Claude (another hook holds it back), the step waits again, buttons and all.
- **Only the person's message counts.** Who wrote a prompt is read from its origin at
  `prompt.submit`: typed, from Remote Control, a Slack ping, an app or script that drives
  Claude Code through the SDK, or another plugin's prompt sent as the person's own words
  (`asUser`). A background task's notification, a scheduled prompt, another session's
  message, a hidden prompt, a slash command, a dropped prompt or a turn with no typed text
  (a continuation) does not mark these steps. Neither does an event an app sends down the
  person's path: one that opens with a tag of hyphenated words (`<task-notification>`,
  `<side-sessions-event>`, `<ci-monitor-event>`, `<cross-session-message>`, …) or with
  `[SYSTEM NOTIFICATION`, with any `<system-reminder>` blocks in front of it taken off
  first. Another session's block is never touched. `docs/FORMAT.md` says so.
- **The board's page answers only the question it showed.** A reply goes with the question
  the page drew it under, and is refused when the task asks something else since or nothing
  at all, as a task kept its key while its question changed (an ended Grok Build or Codex
  session's reply box). Before, it went out as the answer to whatever the task asked now.
- **Every agent.** A Claude session without a Task list already settled its question when
  the next prompt started a turn; a test now pins it. Codex, Gemini CLI, Cursor, Grok Build,
  Muse, Hermes Agent, OpenClaw and OpenCode tell the board only when a turn ends, so their
  question is settled when the next turn in that session ends; a test per agent pins it. A
  block an agent writes by hand is that agent's to change (#52).
- Tests: "a review Claude marked as waiting on you stops waiting once you write in that
  session, so 沒問題 cannot answer it, and shows again only when Claude asks again", "only
  your own message settles this session’s waiting steps: not a background task’s notice, an
  app event, a turn with no typed text, or another session’s question", "a pane button
  answers only the step it belongs to: another step waiting on you stays", "a pane button
  whose answer does not reach Claude leaves its step waiting on you, buttons and all", "your
  message typed while Claude is still working answers too; a notice delivered into that turn
  does not", "your message marks every step of a Task list that waited on you answered,
  keeps what it asked, and only Claude asking again or new words bring it back", "a turn
  that ends on a question after you answered a step asks it plainly, without the buttons of
  the question you answered", "an answered mark goes with its step: deleted, its id taken by
  a new step, or no longer listed", "only the person’s own message is an answer: not a
  notice, a schedule, another session, an app’s event, a hidden prompt or a command",
  "<agent>: a turn that ends on a question stops waiting on you once the next turn in that
  session ends" (one per agent), and the turn-session check in "without a Task list, a turn
  that changed something is summed up into steps and its question", "a press on the page is
  worked out from the file as it is now: a line that is gone is refused, and a reply goes with
  its question", and "a reply goes into a closed Grok session once, in its own folder, and the
  page waits for its answer before it closes" (`tests/board.test.mjs`).

## 0.20.3 — 2026-10-17

- **A remote reporter can close a session and start a fresh one.** `reporter.py
  retire <chat-id> ["reason"]` writes the chat's last fragment again as `ended`,
  keeping its project line, title, notes and steps and adding the reason as a note,
  then gives the chat a new session id, so a clean break leaves no block reading as
  live. A session already `done` or `ended` is left as it is, and only the id is
  new. It refuses a chat that is not in the registry, and one that has not reported
  yet: neither has a block on the board to close. A reason with a control character
  or a comment marker, and a fragment that is no longer a valid block, are refused
  before anything is written. Once a chat's id and fragment are lost, its block
  still waits out the usual staleness and archive rules, and
  `docs/REMOTE_REPORTERS.md` says so. Tests: `test_pipeline.py` "15a
  retire ok" to "15h board shows ended" (the old block merges in place as `ended`,
  once), "15i retired fragment keeps its project line, title, notes and steps, and
  adds the reason", "15j retire refuses a chat not in the registry", "15k refused
  retire mints nothing", "15l retire refuses a session that never reported, and
  mints nothing", "15m retire after done leaves the done block as it was and mints
  a new id", "15n a reason with a comment opening is refused without a traceback,
  and nothing changes", "15o a bad reason is refused on a done session too, and
  mints nothing", "15p a fragment that is not a valid block is refused, and nothing
  changes".
- **The remote reporter guide says the conversation wins.** For a remote reporter
  the conversation with the user is the source of truth and the board a mirror; a
  remote `[?]` step says where to answer; the transports table says how far behind
  each one can leave the board; and a reporter closes its session (`done` or
  `ended`) when the conversation ends. Docs only.

## 0.20.2 — 2026-10-17

What the reviews of 0.18.1 left open, most harmful first.

- **A project named with a comment opening no longer hides the blocks after it.** A
  folder name (Linux allows `<!--` in one) or a project typed into a quick add went into
  its `##` heading as it was, and the reader then skipped every line up to the next
  `-->`. The heading now writes `<!--` and `-->` as a space, as the heading for another
  agent's turn in that folder already was, and keeps a leading `#` (`## #work` reads back
  as `#work`). The section is found by the cleaned name, else by the name as an earlier
  version wrote it, so a second session in that folder, Claude's or another agent's,
  joins the same heading; a name with nothing left goes under the uncategorized
  heading. A project whose name starts with a bracket (`（未分類）`, `(PFC)
  notes`) is now matched by its whole name: it has no first word, so before, every such
  heading was taken for one project, and a session with no folder joined `## (PFC)
  notes`. Tests: "a project folder or quick-add project named with a comment opening
  hides no block after its heading, and keeps one heading", "a folder with a comment mark
  in its name gets one heading, whether a Claude session or another agent writes there
  first", "a project heading an earlier
  version wrote, with a leading # or an arrow in it, is still joined, and a project of
  only marks goes under the uncategorized one", "a project whose name starts with a
  bracket is matched whole, so the uncategorized heading never joins another one".
- **What the user asked reaches the model fenced when a task is named and named
  again.** 0.18.1 fenced the request in the prompt that sums up a turn; the prompts that
  name a task, and look at its name again three steps later, still sent it bare. They
  now put it between `<request>` tags too, in all three languages, with no tag inside
  that could close the fence early. Tests: "what the user asked reaches the model fenced
  as data when the task is named and named again, in every language", "the request a
  task is named and named again from stays inside its fence, whatever tags it holds".
- **A connect run by hand takes the language picked in another session.** Whether the
  person had picked a language was read once, when the session started, so a session
  started before another session's `/progress lang auto` wrote the board script and
  skills in its own language at a `/progress connect`. The plugin's `language` option
  and the stored `/progress lang` are now read at the connect itself. Test: "a connect
  run by hand takes the language another session picked after this one started, auto
  included".
- **`Status:` and `Summary:` lead into a printed board, like `Here is where things
  stand:`.** A reply that opens with one of them before the board is a look, not work.
  A lead saying something was done is still work, in English now too (`Status: fixed
  429:`, `Progress after I added the tests:`); `updated` is not counted, since `Here's
  the updated board:` is a look. `了` still makes a lead work: after any verb it says
  something was done (`目前改了 429 看板如下：`), and narrowing it to `好了` and `完成了`
  would drop that turn's work to spare a block. The captured Grok Build replies have no
  lead line, so they still count as looks. Test: "a status or summary line that leads
  into the board is a look, while a lead saying something was changed is still work".
- **The guide names the plugin's Pane language for the board script.** The sentence on
  `--lang` named only `/progress lang`; the **Pane language** option in `/config` comes
  before it, and the three guides now say so. The order was already right in the code;
  a test now pins it: "the plugin’s language option gives the board script and skill
  their language ahead of the one /progress lang last picked".
- **A remote reporter's merge cannot open a comment in a heading either.** `merge.py`
  wrote a new block's `## <project>` heading from the fragment's first line or from
  `--under` as it was, so a heading holding `<!--` hid the blocks after it, the way the
  first entry above describes. It now refuses a heading holding `<!--` or `-->`, as
  `reporter.py` already refused one in `BOARD_PROJECT`. Test: "8k a new heading with a
  comment opening or close is refused", for both marks, through `--under` and through
  the fragment's own heading.

## 0.20.1 — 2026-10-17

- **Terminal history survives read and write failures.** Only `ENOENT` is treated
  as a missing file. Unreadable progress/archive/journal files abort the action;
  failed writes report the path and error with a nonzero `--keys` exit instead of
  claiming success. History is saved before the board changes, so a later failure
  can leave an extra history entry; retrying an archive does not duplicate that
  entry. Replacements retain POSIX permission bits and clean up owned temp files.
  Tests: "an EACCES reading the archive aborts the action and preserves every
  existing file", "a failed journal temp write preserves old bytes and reports
  incomplete persistence", "an archive saved before a failed board replacement
  survives retry without a duplicate entry", "an archive entry with a longer last
  step does not suppress a distinct shorter task", and "replacing board and history
  retains their POSIX permission bits despite a restrictive umask".
- **The board's page says the same.** A tick, archive, tidy or pasted block on
  the page that meets a file it cannot read or write is answered with that file
  and its error, shown as a failure, instead of a bare server error; a board it
  cannot read is named the same way instead of being shown as offline. A phone
  opened with `--lan` is told the file's name only, not its folder. Its archive
  and tidy, like the terminal board's archive, skip an entry the archive already
  holds. `--html` names `progress.html` when it cannot write it. Tests: "a press
  on the page that cannot write its history is answered with that file and its
  error, and progress.md is left as it was", and "a board the page cannot read is
  named there with that file and its error, rather than shown as offline, and a
  phone is told the file name only".

## 0.20.0 — 2026-10-17

- **The board's page can be opened from a phone on the same Wi-Fi.**
  `node ~/.claude/agent-board.mjs --serve --lan` also opens the page at a
  private address of the computer (192.168.x.x, 10.x.x.x or
  172.16-31.x.x, never a public one) and prints that address with a QR
  code drawn in the terminal, which a phone's camera opens; `--lan
  <address>` picks one of the computer's addresses. The QR code is made by
  the board script itself, with no new dependency. That page has a key of
  its own, answers only requests sent to its own address, and closes after
  10 minutes without a request from the network, or with the computer's
  page. It is plain HTTP on the network, so a reply to an agent, which
  runs a program on the computer, is offered there only as a copy and
  refused if sent; ticking, archiving, pasting a block and closing work as
  on the computer. Neither the command to resume a Claude session nor the
  path of `progress.md` is sent there, since both name the account's
  folders. An address given to `--lan` that is not one of the computer's
  own is named as such. "The board's page" in the README and the guide say how,
  and why to keep it to a network you trust. Tests: "a QR code reads back
  as the text it was made from: sized to fit it, with its three corner
  squares, and none past version 10", "as text, a QR code puts two rows on
  a line inside its quiet zone: black on white with colour, light on dark
  without", "the page goes on the local network at a private address of
  this computer, a real adapter's first, never a public one", "on the
  local network the page answers only its own address, with its own
  token, and says it closes sooner", "from the local network a reply to
  an agent is offered as a copy, and refused if sent, since it would run
  a program on the computer", "on the local network every agent's task
  shows as on the computer, except that a reply that would run grok or
  codex is a copy and no resume command is sent", and in
  `tests/board.test.mjs` "with --lan the page also opens
  on the local network, with a token of its own, where a phone can tick
  but not send to an agent", "--serve --lan prints the page's network
  address and a QR code of it, and a second run gives the same address".

## 0.19.4 — 2026-10-17

- **The page's address, key and all, is no longer kept beside
  `progress.md`.** `--serve` kept it in `progress-serve.json` in the same
  folder, and that folder is often a git repository that syncs itself. It
  is now kept in a folder only your account can use: the folder for running
  programs (`XDG_RUNTIME_DIR`) when it is yours alone, else
  `~/.cache/agent-board` (the temp folder on Windows), in a file named for
  the `progress.md` it serves, readable by you only. The file 0.19.0 left
  beside `progress.md` is removed, and its page asked to close, the next
  time `--serve` runs. Tests: in `tests/board.test.mjs`, "the page's address
  stays out of progress.md's folder, and a file left by a page that is gone
  does not keep the next one from starting".
- **Two `--serve` at the same moment open one page, not two.** A new page
  writes its address file only when there is none; when another page wrote
  first, the new one stops and its `--serve` prints the other's address. A
  file left by a page that is gone (it does not answer, also after five
  more seconds when it still runs) is removed first, and so is one cut
  short by a crash or holding no page address, once it is ten seconds old.
  The same `progress.md` named two ways (`C:/x` and `C:\x`) has one page
  too. Tests: in `tests/board.test.mjs`, "two --serve run at the same moment
  open one page between them, and a server started while it runs stops at
  once", "an address file cut short by a crash is cleared once it is old,
  and the next --serve starts a page", "the same progress.md named two ways
  brings back the same page".
- **Archiving now dates a finished hand-kept task on the right day.** The
  page's **Archive now** and `/progress tidy` put a task the pane had seen
  done less than a day ago under the day before. It now goes under the day
  it was seen done, or today when it never was. Tests: "archived at the
  person's word, a finished hand-kept task carries the day it was seen
  done, or today when it never was", "/progress tidy archives a finished
  hand-kept task under the day it was done, not the day before", and in
  `tests/board.test.mjs` "ticking and tidying from the page write
  progress.md the way the pane does, and a pasted block is merged into it",
  which now checks the day.
- `tsc -p .` reports no errors again. Seven had built up in the tests and in
  one engine call over earlier releases; the fixes change only types, not
  what runs.

## 0.19.3 — 2026-10-17

The reply hint names the session that asked (#49).

- **A question from another session says which session to answer in.** The hint under
  it said "Reply in the <project> session", but several sessions often share one folder,
  and the desktop app lists sessions by title, so the person could see the question and
  not find where to answer it. It now names the task and the session's short ID, plus
  the agent when it is not Claude: `Reply in the "Rate-limit the public endpoints"
  session (7f3c19ab, codex). Can't reply from here.` The same words are in the pane, the
  terminal board, `progress.html` and the board page, in all three languages.
- **A Claude Code session's question offers its ID to copy.** The pane's item has a
  **Copy session ID** button, and `c` on the terminal board copies it, so the person can
  find that session in the session list or reopen it with `claude --resume`. The full ID
  comes from the block's `resume=`; a block without one gives its short ID, and only when
  that is a plain ID (6 to 64 letters, digits and dashes), since anyone can write the
  file and the clipboard must not get a command dressed as an ID. Another agent's ID
  finds no Claude Code session, so its question offers none. `docs/FORMAT.md` says so.
- Tests: "an item from another session in the same folder names that session’s task
  and id", "the terminal board, progress.html and the board page name the session that
  asked, and c copies a Claude Code session’s id", "a Claude Code block with no resume id
  offers its block id to copy only when it is a plain id", and "another agent’s question
  is answered there, but its command can be copied and its link opened from here"
  (changed).

## 0.19.2 — 2026-10-17

Waiting on you lists only questions (#48).

- **A session that asked nothing is no longer listed as waiting on you.** Every turn's
  end writes `state=waiting`, and a block in that state with no `[?]` step got a "waiting
  on your reply" item in Waiting on you with nothing to answer: a Claude Code session
  that had just finished a turn, a Codex session waiting on CI (`[>]`), or the older of
  two sessions on one pull request, which then looked like the same work listed twice.
  Such a block now stays with the work in progress, showing its next step, its running
  step or what it is doing, or under Due soon when it has a date close by. Waiting on you
  holds `[?]` steps (and, on the terminal board and the board page, inbox turns not read
  yet that end on a question), the same in the pane, the terminal board, `progress.html`
  and the board page. With it go the desktop notification "<agent> asks: waiting on your
  reply" that every such turn's end sent, and its place in the status line's waiting
  count. `docs/FORMAT.md` says so for `state=waiting`. Tests: "a turn that ends with no
  question, or waits only on CI, is not listed as waiting on the person", "the view sorts
  work into this session, waiting on you, due soon, other and done".

## 0.19.1 — 2026-10-17

Another agent's turn is no longer lost on its way to the board (#40).

- **An inbox file stays until its turn is on the board.** A session took a file from
  `progress-inbox/` by renaming it, recorded it as read, and deleted it after summing it
  up, whether or not the block reached the board: a `progress.md` that could not be
  written lost the turn without a word. The file is now deleted only once the block is
  read back from the board, or the turn held nothing to track; otherwise it stays taken
  and a later look tries again. Test: "an inbox turn the board will not take stays in the
  inbox and reaches the board on a later look".
- **No summary from the model no longer empties a block.** When the model gave no answer
  and the reply asks nothing, an empty summary replaced the block's open steps, and could
  mark it done. Such a turn now waits for a later look, and on its last try it leaves the
  steps as they are. A reply that ends on a question still gets its step at once, as
  before. Tests: "a reply that asks nothing, with no summary from the model, is not
  dropped from the board but tried again", "on its last try, a turn the model gives no
  summary for keeps the block’s open steps", "a model call that never answers gives up
  after 30 seconds, and later inbox files are still read".
- **A file a closed session left taken is taken again, not deleted unread.** A taken
  file's name now carries when it was taken and the attempt
  (`<name>.<session>-<time>-<attempt>.taking`). One left for 15 minutes is taken again
  by any open session, and after 8 attempts it is kept as `<name>.failed` rather than
  deleted; why it failed is kept in the store (`inboxFailed`). A name an earlier version
  gave is taken again after a day, the wait the old sweep gave it. A left file does not
  change the folder, so the inbox is also listed once a minute, and files taken again
  count toward the 20 a look takes. A file another look took again while this one's
  queue waited is left to that look. Tests: "a file a closed session left taken is taken
  again rather than swept away unread", "a file left taken past its last try is kept as a
  .failed file, not deleted", "a taken inbox file is left to its session for a while, then
  taken again, and set aside after its last try", "the record of why inbox files are
  still there keeps the newest notes only".
- **A turn taken again changes nothing once a later one is on the board.** Each agent
  session's block remembers where the newest inbox file folded in falls (by the time in
  its name, and in the same second a session's end after its turn); an older turn taken
  again (after a later turn, or the session's end, got through) leaves the block as it
  is, without writing it again, so an ended session is not brought back. Test: "a turn
  taken again after its session ended does not bring the session back".
- **A file that cannot be read stays for a later look**, and a turn already on the board
  whose file could not be deleted is deleted at the next look without being summed up
  again. Tests: "an inbox file that cannot be read stays taken for a later look", "a turn
  already on the board whose file could not be deleted is not summed up again".
- Known limit: a session still running an earlier version sweeps taken files older than
  a day, as before, until it restarts.

## 0.19.0 — 2026-10-17

- **A board page you can click, for the agents that are not Claude Code.**
  `node ~/.claude/agent-board.mjs --serve` prints the board, then starts its
  page on 127.0.0.1 in the background (or brings back the one already open)
  and gives its address on the last line; `--no-open` only prints it.
  `/board` in Gemini CLI and OpenCode and the `agent-board` skill (Codex, Grok
  Build, OpenClaw, Hermes Agent and the rest) now run it, so asking for the
  board opens the page. On it: tick the next step of a hand-kept task, archive
  a task, **Archive now**, copy an answer, a resume command or a command. Its
  writes are the terminal board's (a temp file, read back, made again when
  another session wrote meanwhile), so the page changes `progress.md` the way
  the pane does. A tick goes only to the step the page showed: if that step
  was done elsewhere meanwhile, the press is refused. Run in a browser on a synthetic `progress.md`: a tick and
  **Archive now**, seen in the file, the journal and the archive. Tests: "the
  page offers a send only into a Grok or Codex session that has closed; an
  open one, Claude and a hand-kept task each get their own way", "a press on
  the page is worked out from the file as it is now: a line that is gone is
  refused, and a reply goes with its question", and in `tests/board.test.mjs`
  "ticking and tidying from the page write progress.md the way the pane does,
  and a pasted block is merged into it", "--serve starts the page in the
  background once, and the next --serve brings back the same page".
- **Answer a Grok Build or Codex session from the page.** Only one that has
  ended (`state=ended`), so the page is its only writer; a session still open
  is answered in its own window. Only by the session's own id, a UUID, so a
  reply never goes to the newest session of a folder or to one with a
  similar name, and only in the session's own folder (`dir=`): Grok Build
  runs `grok -r <id> --single=<reply>`, Codex runs `codex exec resume <id> -`
  with the reply on stdin (on Windows its `.cmd` needs the shell, and only
  constants and the checked id go through it). The program is looked for in the PATH folders
  only, never in the session's folder. A reply is sent in the background, one
  at a time per session: what the agent answered shows on the page when it
  comes, named with the agent and the task, the page does not close while a
  reply is on its way, and one that runs past 10 minutes is stopped with
  everything it started. A page drawn
  when another session held that line does not send into the new one.
  Another agent's block now keeps that agent's own session id as `resume=`.
  Tests: "a send runs the agent with constants and a checked id only, and
  Codex on Windows takes the reply on stdin", "an agent's block keeps that
  agent's own session id as resume=, so the page can answer into it", and in
  `tests/board.test.mjs`, through a stand-in for Grok Build, "a reply goes
  into a closed Grok session once, in its own folder, and the page waits for
  its answer before it closes".
- **Paste a web chat's block (Muse, dot) into the page.** The page offers the
  chat prompt of `docs/REMOTE_REPORTERS.md` to copy, and takes the block the
  chat prints, fence and all: checked the way `validate.py --block` checks
  one, put under its `## project`, replacing only the same agent's closed
  block, never Claude's or another agent's, with `updated=` set to the time of
  the paste. Its marker is written again from the fields that were checked,
  so a pasted block cannot name a session id or a folder for the page to
  answer into; `merge.py` drops `resume=` and `dir=` from a remote fragment
  for the same reason (check "8j a fragment never names a session id or
  folder for the board page to answer into" in
  `scripts/remote-reporter/test_pipeline.py`). A title that opens a
  comment is refused too, as `validate.py` refuses it. Tests: "a block pasted from a web chat joins its project, then
  replaces its own earlier copy, with the time it was pasted", "a pasted block
  never takes the place of Claude’s, another agent’s or an unclosed block, and
  one that would hide its own end is refused".
- **Only the page can use the page.** It listens on 127.0.0.1 only, with a
  random token in its address (the page sends it as a header). A request
  naming another host is refused, so a name rebound to 127.0.0.1 cannot read
  it; a write must be JSON, from the page itself, at most 64 KB. The page's
  script runs by nonce under a content security policy, sets every word from
  the file as text, opens only `https` links and never passes its address on.
  On Windows the board starts the browser and the clipboard tool by their full
  path, from its own folder, so a `cmd.exe` or `clip.exe` in a cloned
  repository is never run in their place (checked by hand with a planted one).
  It closes after 30 minutes nobody looks at it, or with its button. Tests:
  "the page server answers only its own host, with its token, and takes
  writes only as JSON from the page", "the page runs only its own script, and
  the chat prompt in it cannot close the script it sits in", and in
  `tests/board.test.mjs` "the page answers only with its token and its own
  host, and closing it stops the server".
- **On a phone.** The page fits a phone's width (16px text boxes, 44px buttons
  on touch screens), but it is served on the computer only. From a phone,
  reach a Claude Code session through Remote Control. Opening the page from a
  phone over your own network is not offered yet.
- **Muse Code gets the board skill.** Its config folder now counts as a reason
  to write `~/.agents/skills/agent-board/SKILL.md`, which Muse Code reads; not
  run on Muse Code itself. Test: "each agent gets a board command in the form
  it reads, and a missing reporter never makes a hook exit 2".
- **A turn that showed the board and the page's address is still only a look
  at the board,** not work, also when the model puts the address inside the
  code block it shows the board in. Test: "a reply that ends with the board
  page’s address is still only a look at the board".

## 0.18.1 — 2026-10-17

What the scan after the 0.17.1 merge left open, most harmful first.

- **A comment opening in a block's words no longer hides the blocks after it.** A
  summed-up title such as `TITLE: <!-- x`, a step, a branch name or a first request
  holding `<!--` was written into the block as it was, and the reader then skipped
  every line up to the next `-->`, the next session's block markers with them. Every
  line the mod writes into a block now leaves out `<!--` and writes `-->` as `->`. Test: "a
  comment opening in a summed-up title, a step, a branch or a first request is written
  as plain words, so it hides no block after it".
- **A short report before the printed board is work again.** 0.17.1 let up to about
  40 characters stand before the board in a look at it, so `Fixed the 429 header and
  added a test.` above the board was taken for a look, and that turn's work never
  reached the pane. Only a short line that points at the board and ends in a colon
  (`Here is where things stand:`, `目前進度：`) may stand there now, and not one that
  says work was done (`目前已修好 429 看板如下：`). A blank line between the opening fence
  and the board no longer turns a look into work. A single bullet, or a wrap-up longer
  than about 160 Latin characters (80 Chinese ones), after the board still counts as
  work: it reads the same as work told there, and a look taken for work only leaves a
  block the person sees and archives, while work taken for a look is lost without a
  word. The live Grok Build replies still count as looks. Test: "a short report before
  the printed board is work, a lead-in line
  or a blank line inside its fence is still a look, and a bullet or a long wrap-up after
  it keeps its block".
- **One unreadable inbox file no longer strands the turns taken with it.** A payload
  nested about 100,000 deep overflowed the stack while its words were looked for, and
  the files that session had already taken in the same look were left unread until the
  day-old sweep deleted them. The search now stops 32 levels down, and a file that
  cannot be read is passed over. Test: "an inbox file nested too deep to read strands
  no taken file, and the turn taken before it still gets its block".
- **Two sessions in different languages no longer take turns rewriting the board
  files.** The board script and the board skills and commands were written in each
  session's language, so a desktop session and a terminal session whose `LANG` differed
  rewrote them at every start. A language taken from Claude Code's setting or `LANG` now
  keeps the one the files hold; only a language the person picked (`/progress lang`, the
  plugin's `language` option) replaces it. `/progress lang`, `auto` included, rewrites
  them at once, and with the `autoConnect` option off, at the next `/progress connect`.
  Tests: "a session whose system speaks another language leaves the board script and
  skill in the language they hold, until the person picks one, auto included", "with
  the autoConnect option off, going back to auto reaches the board script and skill at
  the next connect run by hand".
- **Hermes hooks that Hermes folded onto two lines are left as they are.** Hermes 0.16.0
  and 0.19.0 save `config.yaml` with PyYAML at its usual 80 columns, which splits the
  Windows command onto a second line; the next session start no longer takes that for a
  missing hook, rewrites it and asks the person to approve it again. Test: "Hermes hooks
  of ours that Hermes folded onto two lines are left as they are, so a session start says
  nothing".
- **What the user asked reaches the model fenced as data, like the reply.** When a turn
  is summed up, the first request and this turn's request now sit between `<request>`
  tags too, in all three languages, with no tag inside that could close the fence early.
  Test: "what the user asked, first and this turn, reaches the model fenced as data like
  the reply, in every language".

Checked and left as they are: the Hermes command inside a double-quoted YAML value
reads back unchanged with a `'`, `"` or `\` in the path (checked with the PyYAML 6.0.3
Hermes runs, which is what loads `config.yaml`), and a Windows path cannot hold a `"`.
A comment naming the reporter script does not keep a first Hermes connection quiet: a
session start always names Hermes and Codex, which ask the person to approve a changed
hook, and the other agents' configs are JSON, which holds no comments.

## 0.18.0 — 2026-10-17

- **Work in the board from any agent, as in the pane.** `node
  ~/.claude/agent-board.mjs --watch` in a terminal now takes keys: ↑↓ and
  Enter pick and open a line, `x` ticks the next step of a hand-kept task
  (into the work log too), `a` archives a hand-kept task or a stopped session’s block,
  `1`–`9` or `y`/`n` copy the answer to another agent's question to paste
  there, `c` copies a command, `o` opens the browser view, `q` quits. The
  choice stays on its line when lines above it come or go. Writes go through a
  temporary file, are read back and are made again if another session wrote
  meanwhile; they reuse the pane's own `setManualStep` and `takeTask`. Run for
  real in tmux beside Codex 0.163.0: a tick, an archive, and a Codex answer
  reaching the board through Codex's hook. `--keys "down x"` plays keys
  without a terminal, for tests. Tests: "on the board you work in, each line
  offers what the pane offers: answers to copy, a step to tick, a block to
  archive", "the board you work in marks the chosen line and lists only the
  keys that do something on it", "the chosen line stays chosen when a line
  above it comes or goes", "keys played on the board tick a hand-kept step,
  archive a stopped block, and leave a line in the journal"
  (`tests/board.test.mjs`).
- **Its writes hold up when another session writes at the same moment**
  (found in review, each one reproduced first):
  - **An archive is no longer lost.** The block goes into the archive file
    before it leaves `progress.md`, as in the pane. A retry after another
    session's write no longer drops it with "Could not find that task".
  - **A tick made on a retry is reported and journaled.** Before, it showed
    as "not there".
  - **Each board uses a temp file of its own.** Two boards at once no
    longer write over each other's temp file. A failed rename (on Windows,
    a file another program holds open) is tried again.
  - **A key never acts on a line the screen has not shown yet.** If another
    session replaced the chosen line, the key only moves the choice there
    and says so.
  - **Escape sequences in another agent's text are dropped.** They no longer
    reach the terminal or the copied answer.
  - **The board is easier to live with.** Copying counts as done when the
    terminal took it (OSC 52, over SSH too). A clipboard tool gets 2
    seconds. The cursor comes back however the board ends. Keys that arrive
    together (a held arrow) are all read, each on the line the one before
    left chosen, and the rest wait after a tick or an archive. Alt with a
    letter does nothing. A tick is journaled once, even on a retry.

  Tests: "another session writing while the board ticks or archives loses
  neither the tick nor the archived block", "a key does nothing to a line
  that took the chosen one’s place before the screen showed it", "escape
  sequences from another agent’s text never reach the terminal or the
  clipboard".
- **The board command in Hermes Agent and OpenClaw, tested live**: Hermes
  0.19.0 loaded the agent-board skill with `skill_view` and ran it with
  `terminal`; OpenClaw 2026.10.4 read it from `~/.agents/skills` and ran it
  with `exec`. The README table marks both ✅.
- **README badges name what was tested.** The CI badge gives way to the
  version, the Claude Code it needs (2.1.287 or newer) and one badge per
  agent tested live, with the version tested: green where the table says ✅,
  yellow-green where it works only in part. The table now says that the board
  inside an agent is text to read, and acting on it is done in the terminal
  board. Above the table, "At a glance" sorts the agents into works fully,
  works in part (with the limit) and not working yet.

## 0.17.2 — 2026-10-17

- **A reply full of board marks no longer holds up the inbox.** 0.17.1 looks
  for the board's count line (`● … ▸ … ⚑ … ✓ …`) in every reply another
  agent sends. A long line holding every mark but the ✓ made that search take
  seconds per kilobyte, growing fast with length (92 s for 4.8 KB), and every
  open session runs it every 5 seconds. Each count now takes all its digits,
  each gap stops at the next mark, and only a line of up to 400 characters is
  tried; the check for a list beside the board no longer crosses a run of
  blank lines again from each one. Found by the scan after the 0.17.1 merge
  and its review. Test: "a reply full of board marks with no
  count line is read at once, not tried for seconds".

## 0.17.1 — 2026-10-17

- **Fixes from a live test with Grok Build 1.0.62.**
  - **A look at the board asked in plain words gets no block.** Grok Build
    picked the board skill on its own for 我想看一下目前所有專案的進度 ("I
    want to see where all my projects stand"), so the request named no board
    command, and the turn got a block of its own holding a copy of another
    project's question. A reply that starts with the printed board (its count
    line, alone in a fence or unfenced) and adds at most a sentence after it
    now counts as a look at the board, whatever the request said. Work told
    before the board, as a list, or at more length after it still gets its
    block.
  - **End hooks get 5 seconds.** Grok Build's and Muse Code's session-end
    hook had 1 second; on Windows PowerShell alone took 0.6 of it in the live
    test, so a slow start could lose the session's end.
  - **An update to a hook already in place is made without a word.** A
    session that rewrites its own hook in an agent's config (as this release
    does for those timeouts) no longer announces the agent as newly
    connected. Codex and Hermes still say so, since each asks the person to
    approve a changed hook again.

  Tests: "a reply that is the printed board and a sentence is a look at the
  board, asked in plain words, while work that shows it too is not", "a Grok
  Build turn that printed the board for a plain request gets no block, and
  copies no other project’s question", "each agent’s config gets the hook in
  the shape it reads, and nothing else of the person’s changes", "an agent
  hooked in by an earlier version gets the new hook without a word", "a
  changed hook of ours in Codex is still announced, since Codex asks to
  approve it again", "a first connection to a config holding only an empty
  hook list is still announced".

## 0.17.0 — 2026-10-17

Brings the fixes below to existing installs (`claude plugin update` only
picks up a new version), and fixes what the live Muse, dot, Cursor and Hermes
runs on Windows found.

- **`/progress tidy` archives finished work now**, as the README says, and so
  does the pane's archive button: a block marked done a minute ago goes at
  once, a hand-kept task with every step ticked too. The half-day wait stays
  for the automatic tidy, and a stopped session still gets its three days.
  Test: "asked to tidy, a block done a minute ago goes now, while a stopped
  one still gets its three days".
- **The README's agents table says what works, agent by agent**: whether its
  turns reach the board and whether the board works inside it, as tested live
  (✅), working with a limit (⚠️, which one), written from docs and not run (❔)
  or not working (❌), with the version tested. CONTRIBUTING says when a mark
  may change.
- **From a review of #22, #25, #26 and this release.**
  - Hermes hooks of ours that Hermes had rewritten in block style are left as
    they are, so a session start no longer rewrites `config.yaml` and says it
    connected Hermes each time. Test: "Hermes hooks of ours that Hermes
    rewrote in block style are left as they are, so a session start says
    nothing".
  - An OpenClaw that has not saved its config yet is asked its version, so an
    old one is left out there too. Test: "an OpenClaw that has not saved its
    config yet is asked its version, and an old one is left out".
  - Grok Build also counts as installed by the `.metadata_version` or
    `agent_id` it writes, besides its `config.toml` and `sessions`. Tests: "a
    ~/.grok that only another tool put hooks in is not taken for Grok Build",
    "taking the hooks out also takes out a Grok hook an earlier version left in
    a ~/.grok without Grok".
  - A comment after `hooks: {}` stays. Test: "a comment after an empty Hermes
    hooks: {} stays when ours go in under it".
  - The guides say tidy now skips the wait and also moves another session's
    done block, and the READMEs point dot and Muse on the web to the chat-relay
    prompt.
- The guides say why Cursor on Windows can stop at "blocked" (another tool's
  PowerShell hook run through bash) and why a one-off `hermes -q` question
  shows as stopped.

- **Hardening from a review of the whole plugin.**
  - **Home folders with Chinese names.** On Windows, agents' turns now reach
    the board when the home folder's name is not plain ASCII. The PowerShell
    reporter used to hold the inbox's path. PowerShell 5.1 reads a script with
    no byte-order mark in the system's code page, so the reporter saved every
    turn into a garbled folder that the board never read. The reporter now
    finds the inbox beside itself.
  - **Numbers JSON cannot keep.** Connect no longer rewrites an agent's JSON
    config that holds a number it would change: an id past 2^53, `1e400`,
    `1e-400`, or more digits than a double keeps. Such a file is left alone.
  - **Unchanged configs.** A config whose contents would not change keeps its
    own formatting (indent, line ends) instead of being rewritten, and
    announced, at every session start.
  - **One agent's failure.** An agent whose config cannot be written is named,
    and the agents after it are still hooked in. When OpenClaw's plugin file
    cannot be written, the config entry that would load it is not written
    either. A board command that cannot be written is named as one and
    leaves the agent's hook in.
  - **Session-log paths in inbox files.** An inbox file can name a JSON file
    with no conversation in it (a key file) as its session log. That file now
    gives the model nothing; before, its last 20 lines were sent. Raw text is
    read only from Cursor's `agent-transcripts` folder.
  - **Folder names with a line break or a comment opening.** A working folder
    with a line break or `<!--` in its name becomes a one-line project heading
    that hides nothing after it.

  Tests: "the Windows reporter finds its inbox beside itself and holds only
  ASCII, so PowerShell 5.1 reads it under a home folder named in any
  language", "a config holding a number JSON cannot keep as written is left
  alone", "a config already holding our hooks keeps its own formatting, while
  one that needs them is written", "an agent whose config cannot be written is
  named, and the agents after it are still hooked in", "an OpenClaw whose
  plugin file cannot be written gets no config entry that would load a missing
  file", "a board command that cannot be written is named as one, and the
  agent is still hooked in", "a JSON file named as a session log that holds no conversation gives
  the model nothing, while a plain-text log still gives its tail", "a working
  folder with a line break or a comment opening in its name becomes a
  one-line project name that hides nothing".
- **Fixes from a live test with Muse, dot, Hermes and Cursor.**
  - **Grok Build is no longer found where it is not installed.** Other tools
    (Orca among them) put hooks in `~/.grok/hooks` before Grok Build is there,
    and that folder was enough for connect to say "connected" to Grok Build
    and write the shared skill. Grok Build now counts as installed once its
    own `config.toml` or `sessions` folder is in `~/.grok`. `/progress connect
    remove` takes out a hook file of ours wherever it finds one, so the hook
    an earlier connect left in such a folder comes out too; run `/progress
    connect` after it to turn connecting at session start back on.
  - **`/progress tidy` says what it does**: when nothing is left to archive,
    the reply says what goes when, and the count no longer calls every
    archived task finished. (This release also makes it archive finished work
    at once; see the first entry.)
  - **A prompt to paste for a chat relay.** [Remote
    reporters](docs/REMOTE_REPORTERS.md#chat-relay-a-prompt-to-paste) gives the
    block with its exact markers for a chat assistant to repeat, since one
    left to guess invented markers the merge refuses.

  Tests: "a ~/.grok folder with only another tool’s hooks in it is not taken
  for Grok Build, and connect remove still takes out a hook left there", "old
  done blocks go to the month's archive file, after what it already holds",
  "/progress connect hooks the installed agents into the pane once, keeps
  their own hooks, and takes ours back out".

## 0.16.0 — 2026-10-17

- **The board in every agent.** Connecting (by hand or at a session's start)
  now also writes `agent-board.mjs` beside `progress.md`, a script that prints
  the board from the file with no Claude Code needed (`--watch` keeps it on
  screen, `--html` opens it in the browser), and gives each installed agent a
  command that shows it:
  - `/board` in Gemini CLI and OpenCode, which paste the board into the prompt;
  - `$agent-board` in Codex and `/agent-board` in Cursor, Grok Build and
    OpenClaw, from one skill in `~/.agents/skills`;
  - `/agent-board` in Hermes Agent and Antigravity, from their own skill
    folders.

  Board files never count as connecting an agent; the reply says how to open
  the board in each one. Turns no Claude Code session has taken in yet are
  listed as they came, a question first, and a turn that only showed the board
  is not counted as work, even from Codex, whose `Stop` leaves the request out
  (it is read from the session log). Run for real in Codex 0.163.0, Gemini
  CLI 0.64.0 and OpenCode 1.19.3 against a mock model; the screenshots are in
  `docs/images/live/`. Tests: "the board for other agents puts what waits on
  you first, then each project, then turns no session has taken in", "the
  board only peeks at the inbox: a session’s end drops its turn, the newest
  turn of a session wins, and a reply is shown by its last line of prose", "a
  board line is cut to the terminal, counting a CJK character as two columns",
  "a turn that only showed the board is not work, in any language or agent",
  "a Codex turn that showed the board is known by its session log, since its
  Stop leaves the request out", "each agent gets a board command in the form
  it reads, and a missing reporter never makes a hook exit 2", "connecting
  writes the board script and each installed agent’s board command, says how
  to open them, and removing takes them out", "an agent’s turn that only
  showed the board gets no block", and "the board script prints the board
  from the file it was written for, in its language" (`tests/board.test.mjs`).
- **A missing reporter no longer makes an agent loop.** When
  `progress-report.sh` was gone (`~/.claude` deleted, or the plugin removed
  without `/progress connect remove`), `sh` exited 2, which Gemini CLI, Codex,
  Grok Build and Muse Code read as "block" and ran the agent again, for ever.
  Found in a live Gemini CLI run. Every POSIX hook command now ends in
  `|| true`; existing hooks are rewritten at the next session's start. Test:
  "each agent gets a board command in the form it reads, and a missing
  reporter never makes a hook exit 2".

- **From the whole-project review.**
  - A Hermes Agent hook of ours that a YAML dumper had rewritten in block style
    left its `timeout:` line behind when it was replaced, breaking
    `config.yaml` at every session's start; the whole item now goes. Test: "a
    Hermes hook of ours rewritten in block style comes out whole, so
    connecting again leaves valid YAML".
  - A session log is read from its last 256 KB, folded in one pass, and the
    board script keeps it while the file is unchanged: a 20 MB Codex log took
    seconds before. Test: "only the end of a long session log is read, so a
    tens-of-megabytes Codex log stays quick".
  - When two open Claude Code sessions take turns of the same agent session at
    once, the second to finish folds its turns onto what the first wrote
    instead of writing over it. Traced, not tested: the mock engine runs one
    session.
  - A turn counts as only showing the board when its request is the command
    itself or the command's own words, so work on the board script is kept.
    Test: "a turn that only showed the board is not work, in any language or
    agent".
  - A session log must be JSON lines or text (or an older Gemini CLI
    `chats/*.json`), so a credentials file named in an inbox file is never
    read. Test: "only a session log is opened, never a key, env or credentials
    file, nor a path that climbs out of its folder".
  - Removing takes the emptied skill folders out too, and the guides say the
    board needs Node.js 18 and that a JSON config is rewritten with two-space
    indents once.

- **`/progress connect` wires a stock Hermes Agent.** Hermes writes
  `hooks: {}` into a new `config.yaml`, and connect took that empty map for a
  flow-style block it could not follow, so it left Hermes out and said it
  could not read the file. The empty map now becomes a `hooks:` block with
  ours under it, and our lines end the way the file's do (`\r\n` on
  Windows); a flow-style block with anything in it is still left alone. A
  `hooks:` key with a comment after it is followed in a Windows file too.
  Connecting again leaves the block where it is instead of moving it to the
  end of the file. Found by a live run on
  Windows. Tests: "a Hermes config.yaml with the empty hooks: {} it ships
  with gets our hooks in its place, Windows line ends and all", "Hermes
  Agent’s hooks go into its config.yaml beside the person’s own, once, and
  come back out cleanly".
- **Connecting no longer stops an older OpenClaw from starting.** OpenClaw's
  config check takes `hooks.allowConversationAccess` from 2026.4.24 on, and
  an older one refuses to start with it in `openclaw.json` (2026.3 also wants
  a manifest beside a plugin file). Connect, by hand or at a session's start,
  now leaves an OpenClaw older than 2026.4.24 out, takes back out what an
  earlier connect put there, and says so when you connect by hand. The
  version is the one `openclaw --version` prints, else the one that last
  saved the config, which an update leaves as it was. A config with nothing
  of ours in it is never rewritten to take ours out, and a connect that only
  left agents out no longer also says it found none. Found by a live run
  against OpenClaw 2026.3.8. Tests: "an OpenClaw older than 2026.4.24 reads
  as too old, from its config or from what it prints, and a config with
  nothing of ours is not rewritten to take ours out", "an OpenClaw older than
  2026.4.24 is not hooked in, what an earlier connect put there comes back
  out, and connecting by hand says why", "an OpenClaw updated since it last
  saved its config is hooked in, since the installed one says which version
  it is".

## 0.15.0 — 2026-10-17

- **OpenClaw reports too.** Connecting (by hand or at a session's start) writes
  a one-file OpenClaw plugin, `~/.openclaw/agent-board.mjs`
  (`$OPENCLAW_STATE_DIR`), and the `openclaw.json` entry that loads it: its
  path in `plugins.load.paths`, the plugin enabled with
  `allowConversationAccess` (OpenClaw hands a plugin a turn's words only with
  it), and its id added to `plugins.allow` when that list is in use. The
  person's own settings stay, a config hand-written as JSON5 is left alone,
  and `/progress connect remove` takes the file and the entry back out. The
  plugin writes each finished turn (`agent_end`) into the inbox itself, skips
  OpenClaw's heartbeat and memory runs, and ends the block on `session_end`
  but not on a compaction or a restart. A turn run in OpenClaw's own workspace
  folder is filed under the project "OpenClaw". Tested live against OpenClaw
  2026.10.4 with a mock model; its `session_end` did not fire in a one-shot
  local run, so the end is covered by tests only. Tests: "OpenClaw gets a
  plugin file and the config entry that loads it, beside the person’s own
  plugins, and both come back out", "the OpenClaw plugin skips heartbeat and
  memory runs and ends a session on anything but a compaction or restart", "a
  real OpenClaw turn from its plugin becomes a block under OpenClaw, not under
  its workspace folder", "a session hooks OpenClaw in by a plugin file and its
  config entry, names it once, and takes both back out".

## 0.14.0 — 2026-10-17

- **Installing is all it takes.** Each Claude Code session now hooks in every
  coding agent installed on this machine that is not hooked in yet (Codex,
  Gemini CLI, Cursor, OpenCode, Grok Build, Hermes Agent, Muse Code), an agent
  installed later included, and says once, in the pane and by a notification,
  which it connected, what Codex and Hermes Agent still ask of you, and how to
  undo it. Nothing is said when nothing changed. `/progress connect remove`
  takes the hooks out and stops this until `/progress connect` is run again,
  and the new option "Connect other agents automatically" (`autoConnect`)
  turns it off. Install is two lines; `/progress connect` still connects at
  once and names any config it could not edit. Tests: "a session hooks in the
  agents installed here without /progress connect, and says so in the pane and
  once by notification", "an agent already hooked in is left as it is, and
  nothing is said", "once the hooks are taken out, a session does not put them
  back", "with the autoConnect option off, a session hooks nothing in".

## 0.13.0 — 2026-10-17

One contract for agents that are not hooked in: each writes its block as a
fragment (a `## project` line and a FORMAT.md block), and one merge step puts
it into `progress.md`.

- **Agents on another machine can report.** A cloud VM or a chat assistant has
  no hook and no shared folder, so it builds a fragment, any transport carries
  it (git, a chat relay, a synced drive), and
  `scripts/remote-reporter/merge.py` merges it: it reads the file the way the
  pane does (code fences, comments, CRLF, `<!--auto` spellings), replaces only
  that block or places a new one under its own project (refusing one without a
  project), keeps the file's mode and line endings, writes atomically and reads
  back. The reporter keeps its session registry in `~/.claude/remote-reporter/`,
  never in the plugin folder. docs/REMOTE_REPORTERS.md covers transports, what
  has no inward channel, and the risks. Stdlib Python; CI runs it on Ubuntu and
  Windows. Checks: "8e new block without a project is refused", "9a block
  inside a fence is never replaced", "10a CRLF board: block replaced, not
  duplicated", "10b CRLF board keeps CRLF everywhere", "12a board keeps its
  mode", "13a registry under $CLAUDE_CONFIG_DIR/remote-reporter".
- **An opt-in local exchange for Codex and dot** (Node 22.18+ or 24):
  explicit progress reports, session bindings, message claims and immutable
  terminal receipts, with no hooks, user configuration, conversations or
  credentials collected. `report` writes the same fragment, which reaches the
  board only through the merge script, and refuses a file that holds anything
  but its own block; a lock left by a crash is named rather than failing on a
  missing file. Tests: "dot reports only explicit minimal fields and emits a
  backward-compatible progress block", "report refuses to overwrite a
  fragment.md that holds anything but its own block", "a report reaches a real
  board through the remote reporter merge script, beside the blocks already
  there", "one consumer claims a message and a restart never replays uncertain
  delivery", "a lock left without its file gives LOCK_HELD naming the folder,
  and status lists it", "a decision written before a crash wins over a stale
  uncertain receipt and repairs it", "the CLI performs a synthetic dot round
  trip without any external runtime".
- **A host-supplied, verified Codex owner adapter** steers an expected active
  turn with `turn/steer`. The owner is checked before a command is claimed, so
  a thread that loads later still gets it, and a failure before sending is a
  final `rejected`. Mock-tested only; no live Codex session was reached. Tests:
  "a verified owner can steer only its loaded thread and the expected active
  turn", "a thread that loads after the first attempt can still receive the
  command", "a failure after the claim but before the steer request is a
  terminal rejection", "lost acknowledgements stay uncertain and are never sent
  a second time".

## 0.12.0 — 2026-10-17

Hardening, from a security and robustness review.

- **Other agents' words reach Claude as data, not instructions.** The note a
  session's first turn gets about other work in its project, the 接手做完
  prompt and the note after a compaction now quote the file's titles and
  steps inside a fenced block, after a sentence saying they are file content
  that other agents can write and are not to be followed. Each line is one
  line of at most 120 characters, with no backticks or `<!--`. The first-turn
  note goes in as a hidden (meta) row, the shape the engine takes from a
  plugin. Tests: "file text reaches Claude as data: one line, no backticks or
  comment openings, at most 120 characters, in a fence after a note",
  "another session’s block whose step says to run a command reaches Claude
  fenced as data and clipped", "another agent’s ended block reaches Claude
  with its step clipped and its command quoted without backticks".
- **A model call that never answers no longer stops the inbox.** Every call
  to the model gives up after 30 seconds and counts as no answer, and a
  session takes its inbox files before it asks the model, so the next look
  five seconds later goes ahead. Test: "a model call that never answers gives
  up after 30 seconds, and later inbox files are still read".
- **`resume=` and `dir=` are checked.** A resume id is kept only when it is 6
  to 64 letters, digits and dashes, and a folder that decodes to a control
  character is ignored, so a block cannot put a command of its own into the
  resume command the pane copies. docs/FORMAT.md says so. Test: "a resume id
  that is not a plain session id gives no resume command, nor does a folder
  with a line break".
- **Fewer model calls and a smaller store.** Of a burst of turns from one
  agent session, only the last two are summed up; the earlier ones only move
  on what is remembered. A stored mirror keeps the last 3000 characters of
  the last reply and the first 1200 of the first request, and the record of
  taken inbox files keeps at most the newest 2000. Tests: "a burst of turns
  from one agent session asks the model about the last two only, and what is
  stored stays small", "a burst of turns from one agent session is summed up
  from its last two turns only".
- **The reply the model sums up is fenced.** The digest prompt quotes it
  between `<reply>` and `</reply>` (a tag inside the reply is taken out) and
  says, in all three languages, to treat it as data. The question's label and
  why stay at 48 and 120 characters however they arrive. Test: "an over-long
  ASK is clipped to a short label and question, and the reply is fenced as
  data in every language".
- **The writer skips what the parser skips.** A block or heading inside a
  code fence or an HTML comment was ignored when reading but could be
  replaced or archived when writing. One function (`readable` in
  `hooks/parse.ts`) now decides for both. Test: "a block pasted inside a code
  fence is never archived or rewritten".
- **Two sessions writing at once no longer undo each other.** Archiving, 封存,
  ticking a step, a quick add and another agent's block now read the file
  back after writing, as this session's own block did, and make the change
  again over a write that landed in between, without archiving anything
  twice. Test: "a write another session makes between this one’s read and
  write is not lost, and nothing is archived twice".
- **Each inbox file is read by one session, then deleted.** A session takes a
  file by renaming it to a name of its own, which only one rename can do,
  reads what it renamed and deletes it once summed up; the folder no longer
  depends on the reporter script to empty it (OpenCode's plugin never did).
  A taken file left behind by a session that closed half-way goes after a
  day. Tests: "an inbox file is claimed by renaming it, read by that session
  only, and removed once read", "an inbox file taken by a session is renamed
  to a name of its own, which no session reads as a new file".
- **Windows is told by the system.** `CLAUDE_PROGRESS_FILE=C:/Users/me/...`
  used to get sh hooks; now `OS=Windows_NT` or a drive letter means Windows,
  and the path's own separator is kept. Tests: "Windows is told by the system
  or a drive letter, not by the slashes in the path", "on Windows, a progress
  file written with forward slashes still gets the PowerShell reporter".
- **The installers remove the old name only after the new one is in.**
  `setup.sh` and `setup.ps1` install `agent-board` first and uninstall
  `project-progress@claude-progress-pane` only once that worked, saying
  "Removed" only when it was. With `--no-install` / `-NoInstall` or without
  `claude`, an old install found in settings.json is named with the two
  commands that remove it. Installer checks: "old name: the new plugin is
  installed before the old one is uninstalled", "old name: \"Removed\" is said
  once the uninstall worked", "old name: a failed install leaves the old
  plugin in and says nothing of removing it", "old name: with --no-install it
  is still found in settings.json, with the two commands to remove it".
- **An upgrade does not sum up old turns again.** When the store has no
  record of the inbox (the first run, or the store left under the plugin's
  earlier name), the files already there count as read. Test: "an upgrade’s
  first look at the inbox counts the files already there as read".
- **A person's own hook is not taken for ours.** Only a command that runs
  `progress-report.sh` or `.ps1` by its path counts as the plugin's, so a hook
  of `my-progress-report.sh` stays when connecting and removing. Test: "a
  person’s own hook that only mentions the reporter’s name, like
  my-progress-report.sh, is kept".
- The README and the guides say that an open session deletes each inbox file
  once read, for when you check whether a hook ran.

## 0.11.0 — 2026-10-17

- **Hermes Agent reports to the pane.** `/progress connect` adds two shell
  hooks to `~/.hermes/config.yaml` (`$HERMES_HOME`): `post_llm_call` for each
  turn, whose words Hermes puts under `extra`, and `on_session_finalize` for
  the end (Hermes fires its `on_session_end` after every turn). The YAML is
  edited line by line, beside the person's own hooks, and a `hooks:` block in
  flow style is left alone. Hermes asks once before it runs a new hook.
  Tests: "Hermes Agent’s hooks go into its config.yaml beside the person’s
  own, once, and come back out cleanly", "Hermes Agent’s turn is read from
  under extra, and its session finalize is the end, not its per-turn session
  end", "a real Hermes Agent turn, its words under extra, becomes a block
  waiting on the person".
- **Grok Build's blocks are named from the request.** Grok's `Stop` carries
  the reply but not the request, so its block was titled with the reply and
  had no background line. The request is now read from Grok's session log,
  which streams messages in ACP chunks. Tests: "a Grok Build session log gives
  back the request and reply it streamed in chunks", "a real Grok Build turn
  takes its request from the session log and ends on the shutdown stop".
- **A session log is opened only when it is one.** The path came straight
  from the inbox file, which any program on the machine can write; now only a
  `.json`, `.jsonl` or `.txt` path with no `..` in it is read. Test: "only a
  session log is opened, never a key or env file, nor a path that climbs out
  of its folder".
- **Tested live against the real CLIs**: Gemini CLI 0.64.0, OpenCode 1.19.3,
  Hermes Agent 0.19.0 and Grok Build 1.0.62 each ran a turn against a mock
  model; their payloads are now tests. Tests: "a real Gemini CLI turn and its
  session end become one ended block, its request taken from AfterAgent", "a
  real OpenCode turn from its plugin becomes a block waiting on the person",
  and the Hermes and Grok tests above.
- **README rewritten**: a table of supported agents with icons and what was
  tested live, a quick start, what you get, colours and marks, and answers to
  common questions (a new computer, an agent that doesn't show up, what leaves
  the machine, Windows, uninstalling). The guides gain "Pick the colours",
  Hermes Agent, and troubleshooting for a missing agent and a new computer,
  and now name the `agent-board.*` hook files. SECURITY.md says what
  `/progress connect` changes and that turns are summed up by Claude Haiku.
- **A promotional card** (`docs/images/social-preview.png`, with `-zh-TW` and
  `-zh-CN`): the pitch, the agents it works with, and the pane with a question
  just in. The tour lists Hermes Agent, keeps its window's rounded corners,
  and its handoff ring no longer crosses Chinese text.

## 0.10.0 — 2026-10-17

- **New name: Agent Board.** The pane follows Claude Code, Codex, Gemini CLI, Cursor,
  OpenCode, Grok Build and Muse Code, so a name starting with "claude" said too
  little. The new one says what it is: one board for all your agents.
  - The plugin is `agent-board`, from the `agent-board` marketplace, in the
    `WenyuChiou/agent-board` repository:
    `claude plugin install agent-board@agent-board`.
  - The tour, the social preview, the READMEs, the guides and the page title of
    `progress.html` carry the new name, and the plugin has a description that
    says what it is for.
  - The tour reads better at README size: the pane window is larger, every
    line of small text is bigger, and each moment eases in and out (headlines
    rise into place, the pane's frames dissolve into each other, the end card
    grows in) instead of a flat fade.
  - The "How it works" picture is redrawn: three numbered columns (who
    reports, the one file, where you see it), type about half again as large,
    and shorter words.
  - `/progress connect` writes Grok Build's and OpenCode's hook files as
    `agent-board.json` and `agent-board.js`, and takes away the `progress-pane` ones it
    wrote before, so no turn is reported twice. The section between
    `claude-progress-pane` markers in an agent's instructions is still found
    and removed.
  - The setup scripts uninstall `project-progress@claude-progress-pane` and
    remove its marketplace before they install `agent-board@agent-board`. An auto-update
    turned off under the old name stays off, and an agent section or a
    CLAUDE.md block under the old markers is replaced rather than doubled.
  - Unchanged: the `/progress` command, `~/.claude/progress.md` and its format,
    `CLAUDE_PROGRESS_FILE`, and the reporter script `progress-report.sh`.

  Tests: `/progress connect hooks the installed agents into the pane once,
  keeps their own hooks, and takes ours back out` (now with an old Grok file),
  `each agent’s config gets the hook in the shape it reads, and nothing else of
  the person’s changes`, and the four "old name" installer checks in
  `tests/setup.check.sh` and `tests/setup.check.ps1`.

  BREAKING CHANGE: an install under the old name does not update to this one by
  itself. Run the setup script once, or the five commands in the guide
  (Update and uninstall → Coming from the old name). The pane's language and
  notification choices, kept per plugin, go back to their defaults.
- **Codex, tested for real.** Codex CLI 0.163.0 ran one turn of `codex exec`
  against a stand-in model server. `/progress connect` had installed the hooks,
  and Codex ran its Stop and SessionEnd hooks. The reporter saved both payloads,
  and an open Claude Code session turned them into Codex's block. That run
  found three things, now fixed:
  - **No name.** Codex's Stop carries the reply but not the request, so the
    block had no name or background. The request is now read from the session
    log the payload points to.
  - **Wrong state.** `codex exec` writes the turn and the session end in the
    same second, and sorting by file name put the end first, so the block said
    "waiting" for a finished session. Files are now taken by time, with a turn
    before its session's end.
  - **"(unnamed)" title.** A block with no name now falls back to the request or
    its first step.

  Test: `a real Codex turn and its session end, written in the same second,
  become one ended block named from the request`, built on the payloads and
  log lines Codex actually wrote.
- **A short tour at the top of the README** (about 48 seconds, each screen
  held long enough to read). It replaces the banner and the
  three-frame demo, in three acts:
  - Why: five agents, one of them waiting on you, then the pane.
  - What it does: answering with one press, every agent reporting through its
    own hooks, a handoff line and take-over.
  - Where it runs and how it looks: the surfaces and systems, then
    the light and dark 和色 palettes with each colour's name, and an end card
    with the install command.

  A timeline along the bottom shows how far the tour has come. It is one SVG per
  language and theme, drawn from `drawPane` by `docs/preview/render.ts`, and
  animated with CSS alone, so GitHub plays it. With reduced motion, it shows one
  still frame. The banner remains only as the social preview.
- **README speaks to the reader's problem first.** It opens with the situation:
  several agents running, and one of them stuck waiting on you without you
  knowing. Then it says what the pane does about that, and only then lists the
  features, in plain words. The tour's captions follow the same order.
- **Faster poll.** The path of `progress.md` is worked out once per session
  instead of on every 2-second poll and 5-second inbox look. The test that
  simulates an hour went from about 4.8 s to about 2.8 s, which takes it well
  clear of the 5 s test timeout it had been brushing against.

- **Set up from any agent.** The README's install section is now three shell
  lines, ending with `claude -p "/progress connect"`. It also gives a prompt to
  paste into Codex, Gemini CLI, Cursor, Grok, Muse or any agent that can run
  commands, so that agent does the setup. Checked in a clean home directory:
  after a real `marketplace add` and `install`, `claude -p "/progress connect"`
  connected the agents found there.

## 0.9.0 — 2026-10-17

The pane no longer depends on an agent remembering to report. Each agent's own
harness says when a turn ends, and the pane sums the turn up.

- **Progress without a Task list.** A session that keeps no Task list still
  shows up: a turn that edited a file or ran a command is summed up by Haiku
  into a title, a line of background, what it finished, the next step and what
  it ended up asking. The block keeps the last six finished turns and says
  `source=turns`; the first TaskCreate replaces the summed-up steps with the
  real list. A turn that only answered a question leaves nothing behind.
  Tests: `without a Task list, a turn that changed something is summed up into
  steps and its question`, `a turn that only answered a question leaves no
  block behind`, and the pure `the model’s summary of a turn …`, `a turn counts
  as work …`, `a summed-up list keeps the last six finished turns …`.
- **A question at the end of a turn waits on you.** When a turn ends on a
  question and Claude marked nothing as waiting, the step in progress waits on
  you with the question as its note, and you get a notification. Your next
  prompt clears it. Tests: `a turn that ends on a question waits on you even
  when Claude did not mark it, until you answer`, `the question a reply ends
  on …`, `a question marks the step in progress …`.
- **Background follows the goal.** Once the list has grown by three steps since
  the title and background were written, Haiku looks at both again and keeps
  them when the goal is the same.
- **Handoff at compaction.** A compaction leaves one line in the block (what is
  done, what is stuck, the next step) as a `Handoff:` / `交接：` note. The
  opened row shows it, and **Take over and finish** passes it on. `docs/FORMAT.md`
  documents the note and the `source` attribute. Tests: `a compaction leaves a
  handoff line in the block`, `a stopped session’s handoff line shows on its row
  and goes with 接手做完`, `a handoff note is its own line …`.
- **Other agents through their own hooks: `/progress connect`.** One command
  finds the agents installed here and adds a turn-end hook to each:
  - Codex: `Stop` in `hooks.json`. Codex asks you to approve it once in `/hooks`.
  - Gemini CLI: `AfterAgent` in `settings.json`.
  - Cursor: `afterAgentResponse` and `stop` in `hooks.json`.
  - OpenCode: a plugin on `session.idle`.
  - Grok Build: a file in `~/.grok/hooks`.
  - Muse Code: `Stop` in `settings.json`, with the `schema_version` it needs.

  Each hook runs `progress-report.sh` (or `.ps1`), written beside
  `progress.md`. The script has no dependencies, saves the hook's input into
  `progress-inbox/`, clears files older than two days, prints nothing (`{}`
  for Cursor) and always exits 0, because some agents read exit 2 as "keep
  going". Every 5 seconds an open session checks the folder: a stat, plus a
  listing only when the folder changed. It stamps new files in the store so
  only one session reads each, and sums the agent's turns up into its own
  block. If one turn is reported twice, it counts once: two hooks of the same
  turn, or Grok Build also running Cursor's hooks.

  Your own hooks stay. A config file that is not plain JSON is left alone and
  named. The AGENTS.md section that setup `--agents` wrote for that agent is
  removed, and setup now skips agents that are connected.
  `/progress connect remove` takes it all out. Payload fields come from each
  agent's source code or docs; none of these agents was run live here.
  Tests: `/progress connect hooks the installed agents into the pane once …`,
  `another agent’s turn, left in the inbox by its hook, becomes its block once
  …`, `each agent’s hook payload reads as a turn …`, `each agent’s config gets
  the hook in the shape it reads …`, and `agents: an agent hooked by /progress
  connect gets no section` in both setup checks.
- **README.** 56 lines instead of 294 in each language: what it is, the
  interaction demo, three points, install, what to type, how it works. The rest
  moves to `docs/GUIDE.md` (and `GUIDE.zh-TW.md`, `GUIDE.zh-CN.md`). The demo's
  three frames are as tall as the shortest, so none leaves an empty window. The
  `progress.html` screenshots are gone.

## 0.8.0 — 2026-10-17

- **Archive a row now.** Open a stopped session or a task you keep by hand and
  press **Archive** (封存, 归档): it moves to this month's archive file right
  away, in the same form the sweep writes, instead of waiting half a day or
  three. A task that changed since the pane drew it (its heading now has a
  twin, its block lost its end marker, its heading sits inside a session's
  block) is left where it is, and the pane says so.
  Tests: `封存 on a row takes that task out of the file now and into this
  month’s archive`, `封存 of a task someone changed meanwhile says so and leaves
  the file alone`, and the two pure `封存 …` tests in `tests/features.test.ts`.
- **Reminders.** A question another session or agent asks you notifies once,
  and work due today or late notifies once a day. What was already said is kept
  in the plugin's store, shared by every open session, so one question pings
  once however many sessions are open. Questions already in the file when a
  session starts count as said (the pane opening shows them), and the very
  first run says nothing about what is already there. The notifications toggle
  covers these too.
  Tests: `a question another agent asks notifies once, not the ones already
  there at the start`, `work due today notifies once that day`, `with
  notifications off, reminders stay quiet`, `the first run ever says nothing
  about what is already in the file`, `reminders: another session’s question
  once, and work due today or late once a day`.
- **The repository's front page.** The README opens with a banner and an
  animated demo of the pane (the question that needs you, everything waiting by
  kind, the pane after you answer), and has a "How it works" diagram, each in
  English, 繁體中文 and 简体中文 and in a light and a dark version that follows
  GitHub's theme. They are SVG drawn from `drawPane` itself by
  `docs/preview/render.ts`, which lays the pane out like a terminal
  (`docs/preview/terminal.ts`); `docs/preview/png.mjs` takes the `progress.html`
  screenshots and a 1280 × 640 social preview. The PNG screenshots of the pane
  are gone.
- **Community files**: issue forms (bug, idea), a pull request template with
  the checks, `SECURITY.md` and `CODE_OF_CONDUCT.md`.

## 0.7.1 — 2026-10-17

Found by running the whole thing for real: installing from GitHub into a clean
config, updating from 0.5.2, a headless Claude Code session doing a small task,
and agents on three different models (as `codex`, `gemini`, `cursor`), each
given only the AGENTS.md section, writing to one `progress.md` at the same
time. All of it worked: every block, label and kind of question read right, and
nothing outside the agents' own blocks changed. These are the rough edges it
showed.

- **Other agents in one step.** `setup.sh --agents` (`setup.ps1 -Agents auto`)
  puts the AGENTS.md section into the global instructions of the agents
  installed here: Codex (`$CODEX_HOME/AGENTS.md`, or `AGENTS.override.md` when
  that one has text), Gemini CLI (`~/.gemini/GEMINI.md`), OpenCode
  (`~/.config/opencode/AGENTS.md`), between markers, keeping the rest of each
  file. `--agents=codex,gemini` names them, `--remove-agents` takes it out.
  Without the option, the script says which agents it found.
  Checks: `agents: …` in `tests/setup.check.sh` and `tests/setup.check.ps1`.
- **Another agent's command and link, from here.** Its question is still
  answered in its own session, but a command it asks you to run now shows with
  **Copy command**, and a link with **Open it**.
  Test: `another agent's question is answered there, but its command can be
  copied and its link opened from here`.
- **English titles are no longer chopped.** Titles and background lines are cut
  by terminal width (a CJK character is two cells), at a word, with `…`: an
  English title got 24 characters and read `Add README describing in`.
  Test: `titles and background are cut by terminal width, at a word in English,
  never mid-word`.
- **progress.html** shows a backticked word as a command only in a step that
  asks you to run something; in a question it is a name.
- **The AGENTS.md section** says the `###` title is the agent's to word, other
  `>` lines are allowed, and only commands go in backticks: the test agents
  asked about the first two and put a file name in backticks.
- **Setup** sets the language option to `auto` after a fresh install, so
  Claude Code stops saying an option is not set. A language you picked stays.

## 0.7.0 — 2026-10-16

Includes 0.6.0, which was not released on its own.

- **Questions by kind.** A step that waits on you is a confirm, a choice, an
  input, something to do, something to review, or a wait for someone else,
  from `metadata.ask` / `options` / `command` / `link` or from its words
  (Chinese and English). Each kind gets its own controls in the pane (Yes / No,
  one button per option, Copy command / Did it, Open it / Looks good, Ready, a
  reply box), and a press goes back to this session as the answer. Another
  session's question says where to answer it. `A，還是 B？` and `A, or B?`
  read as a choice too.
  Tests: `what a waiting step asks decides its buttons: confirm, choose, do,
  review, input, wait`; `a question this session asks is answered from the
  pane, with the buttons its kind calls for`; `English questions: a yes or no
  is a confirm, "or" inside a word is no choice, waiting reads the step too`;
  `a choice with a comma before 還是 / or still reads both options`.
- **Needs you first.** The pane opens on the one thing that needs you most (an
  answer here, then elsewhere, then a deadline today, then something stuck),
  and folds waiting, due soon, other work and done to one line each; a press
  opens a section and it stays open in the next session. This session's card
  shows the step in progress and the next; every step is one press away.
  Tests: `the focus is the most pressing thing: an answer here, then
  elsewhere, then today, then stuck, then waiting on others`; `folded sections
  open on a press and stay open in the next session`; `on the phone (no input
  box) the pane still draws, focus first, with its buttons`.
- **It does not pile up.** A session silent for 12 hours shows as stopped and
  its questions leave 等你處理. Done blocks leave for the monthly archive after
  12 hours, others after 3 days, a hand-kept task a day after it was first seen
  done; the sweep runs every hour. A block with no readable time is never
  archived, and a section someone left empty stays.
  Tests: `a session silent for half a day counts as stopped: its questions stay
  in its row, not in 等你處理`; `blocks leave after half a day when done and
  after three days otherwise`; `finished hand-kept tasks leave a day after they
  were first seen done, whole, and nothing else moves`; `a hand-kept task done
  for a day leaves for the archive by itself, and the next hour clears a done
  block`; `archiving never ages out a block with no time, and keeps a section
  someone left empty`.
- **Readable on light terminals.** Secondary text uses a muted colour from
  each 和色 set instead of the terminal's dim, which turned faint grey on white.
  Every text colour is at least 4.5:1 on its ground: light 琥珀 became 鶯茶
  `#715C1F`, dark 紅緋 became 薔薇 `#E9546B`.
  Test: `on a light terminal no text falls back to the terminal dim`.
- **English, 繁體中文, 简体中文.** The pane, the words written into the file
  and the rule follow the plugin's `language` option (`/config`), then
  `/progress lang`, then Claude Code's `language` setting, then the system
  locale. The parser reads `Context:` and `Background:` as well as `背景：`,
  and `due MM-DD` as well as `截止 MM-DD`.
  Tests: `languages: the setting, the stored choice and the system pick the
  language, in that order`; `with the language option set to English, the
  pane, the file and the rule speak English`; `/progress lang switches the
  language and remembers it; auto goes back to the system`; `a file written in
  English reads back: Context, due, and an English quick add`.
- **A window of its own.** Every session writes `progress.html` beside
  `progress.md` (at most once a minute, only when it changed): the whole file's
  view as a page that reloads every 30 seconds, keeps the sections you opened,
  follows the system's light or dark mode and fits a phone. `/progress open`
  opens it in the default browser.
  Tests: `progress.html shows the whole file: counts, the focus, folded
  sections, steps, and escapes what it shows`; `progress.html is written beside
  progress.md, and /progress open opens it in the browser`.
- **Other agents.** Blocks carry `agent=`; a block from Codex, Gemini or another
  agent is labelled and says where to answer it. `docs/FORMAT.md` specifies the
  file; `AGENTS.md` ends with a section to paste into another project's
  `AGENTS.md` / `GEMINI.md` / `.cursorrules`; `CONTRIBUTING.md` has the checks
  and the release steps. `CLAUDE_CONFIG_DIR` moves the default file with it.
- **How the file is read (still format version 1).** `due` must start a word
  (`overdue 3-4` is no longer a date); `2026/10/31` is read; a month or day
  that does not exist is no date. `Context:` and `Background:` count as the
  background line, so a hand-kept task with such a note shows that note alone.
  A block with no readable `updated` is never archived (it used to leave at the
  first sweep). Archive headings use the local date and the pane language;
  journal lines write the pane language's word for an empty field. `可以`,
  `要不要` and `能不能` opening a question make it a confirm.
  Test: `可以 / 能不能 opening a question make a confirm; a date that does not
  exist is no due date; the journal speaks the pane language`.
- **Auto-update.** `setup.ps1` and `setup.sh` set `"autoUpdate": true` on the
  marketplace's entry in `~/.claude/settings.json`, after
  `claude plugin marketplace add` (which writes the entry anew without it). An
  `"autoUpdate": false` you set stays.
  Checks: `auto-update: …` in `tests/setup.check.sh` and
  `tests/setup.check.ps1`.
- **README** in English, 繁體中文 and 简体中文: features first, then a
  step-by-step start, with screenshots in `docs/images/` drawn by the pane's
  own code.
- **MIT license** (`LICENSE`, `license` in `plugin.json`).

## 0.6.0 — 2026-10-16

- **和色.** The pane is drawn in traditional Japanese colours: 浅葱 / 藍 for work in
  progress, 若竹 / 常磐 done, 山吹 / 琥珀 waiting on you, 藤紫 running, 柿 due soon,
  紅緋 / 茜 stuck, 利休鼠 for frames. A dark and a light set, picked from the
  `/config` theme and repainted when it changes (`hooks/palette.ts`).
  Tests: `two 和色 sets: the light one under a light theme, the dark one
  otherwise`; `the pane takes the light 和色 set under a light theme, and 說明
  lists every mark`.
- **At a glance.** Four counts on top: waiting on you, open, due soon, finished
  today. This session's steps are numbered, the one in progress marked
  「← 現在」, with a percentage on the bar. Other work is grouped by project,
  this one first, each row with a short bar. 說明 lists every mark.
  Test: `other work is grouped by project, this one first, with numbered steps,
  notes and background`.
- **Background.** When the model names the task it also writes one line of
  background (why the work exists, what it should end as); it is written into
  the block as `> 背景：…`, so every session's pane shows it, and the take-over
  and hand-over prompts carry it. A hand-kept task's own `>` notes are its
  background. A step that needs you carries `metadata.why`, shown under it and
  in 等你處理 with the task it belongs to; the rule asks Claude to write it.
  Tests: `the task gets a line of background with its name, and a step that
  needs you says why`; `the model answer becomes a title and a line of
  background`.

## 0.5.2 — 2026-10-16

- **`CLAUDE_CODE_ENABLE_TODO_TOOLS` moves to the shell profile.** In
  `~/.claude/settings.json` the key also reached Claude desktop-app sessions,
  which keep their own task list: they got the Task tools and reminders to use
  them, against the app's own list. `setup.ps1` now adds
  `$env:CLAUDE_CODE_ENABLE_TODO_TOOLS = "1"` to `$PROFILE.CurrentUserCurrentHost`
  (or `-ProfilePath`), once, in the profile's own encoding. `setup.sh` adds
  `export CLAUDE_CODE_ENABLE_TODO_TOOLS=1` to `~/.zshrc`, `~/.bashrc`
  (`~/.bash_profile` on macOS) or `~/.profile`; fish gets a line to add by hand.
  When pwsh is installed, `setup.ps1` prints the command that writes its
  profile too.
- **settings.json is edited in place.** Both scripts take out the key 0.5.0 and
  0.5.1 wrote (value `"1"` only) and the old zip dir in
  `CLAUDE_CODE_PLUGIN_DIRS` by changing just those lines, so the file keeps its
  indent, key order, line endings and UTF-8 BOM; before, `setup.ps1` re-wrote
  the whole file through `ConvertTo-Json` (4-space indent, a diff on every
  line). Each edit is checked against the parsed file; when it cannot be exact,
  or the file is not UTF-8 JSON, the file is left alone and the script says so.
  Neither script creates `settings.json` any more.
- **The key stays in settings.json until the shell can set it**: while
  PowerShell's execution policy (Restricted, AllSigned, unset on Windows
  PowerShell, or unreadable) may keep the profile from running, and under fish. The script
  says what to change. Otherwise terminal sessions would lose the Task tools
  too.
- **The pane's hint** for a session without Task tools points to the shell
  profile, and says desktop-app and git-bash sessions keep `progress.md` by
  hand. Test: `without Task tools the pane points to the shell profile, not
  settings.json`.
- **Installer checks.** `tests/setup.check.ps1` and `tests/setup.check.sh` run
  the scripts against temp folders: settings.json edits (middle, last and only
  key, CRLF, a BOM, a value of `"0"`, a `CLAUDE_CODE_PLUGIN_DIRS` entry with
  `$` and a quote, an edit that cannot be exact, bytes that are not UTF-8), the
  profile line added once, a UTF-16 profile, a blocked or unreadable execution
  policy (faked), zsh and fish. `claude plugin test` does not run them.

## 0.5.1 — 2026-10-16

- **A step ticked in the pane is journaled too.** 完成 / 完成這步 on a hand-kept
  step (job hunting, say) now adds its line to the journal, so 週報 lists it
  beside the steps Claude finished. Test: `the pane acts: tick a step, hand a
  task to Claude, take over, ask aside`.

## 0.5.0 — 2026-10-16

- **Its own repository and marketplace.** Install with
  `claude plugin marketplace add WenyuChiou/claude-progress-pane` and the setup
  script; update with `claude plugin update`. The zip and its installer are
  gone. `scripts/setup.ps1` / `setup.sh` install the plugin, set
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` and move a zip install over: its folder
  leaves `CLAUDE_CODE_PLUGIN_DIRS`, so the mod does not load twice, and its
  block leaves `CLAUDE.md`. They also run piped from a URL (`irm … | iex`)
  once the repository is public.
- **Quick add.** A line starting with `+` in the pane's box, or `/progress 加 …`,
  becomes a hand-kept task under its project, with its due date and steps.
  Tests: `a quick add reads the project, the due date and the steps`; `a quick
  add lands at the end of its section, or a new one, and reads back with its
  date`; `a + line in the pane adds a task to the file, under its project`.
- **Pull request and CI.** Through the person's own `gh`, the card shows the
  branch's PR as a link, re-checks every two minutes while checks run, and
  writes `pr=` / `ci=` into the block so other sessions' rows show it.
  Tests: `gh's answer becomes one word for CI, and words for the card`; `the
  pull request shows on the card and in the block, and a finished CI run
  notifies`.
- **Notifications.** A step that needs you, the list finishing, and CI
  finishing each raise one desktop notification; 通知：開/關 or
  `/progress 通知 關` turns them off. Tests: `a step that needs you and a
  finished list each notify once`; `a step that needs you notifies, the whole
  list finishing notifies, and 通知：關 silences both`.
- **Status line.** With the pane closed or not placed, one line under the
  prompt. Tests: `the status line says where things stand, and nothing when
  nothing does`; `with the pane closed, the line under the prompt carries the
  progress`.
- **Journal and report.** Each finished step is a line in
  `progress-journal-YYYY-MM.md`; 週報 / `/progress 週報` / `/progress 今天`
  copy what finished, what is open and what waits on you. The task is now
  named when its first step is created, so the journal carries the real name.
  Tests: `finished steps are found once, journaled as lines, and read back`;
  `the report groups what finished by task, then lists open work and what
  waits on you`; `finished steps reach the journal, and 週報 copies a report of
  them`.
- **Resume.** A block carries its session's full id and folder; an ended
  session's row offers 複製續接指令 (`cd … && claude --resume …`, or
  `Set-Location` on Windows). Tests: `the marker carries the resume id, the
  folder and the pull request, and reads back`; `an ended session offers the
  command that reopens it where it ran`; `an ended session elsewhere offers
  its resume command, copied for the terminal`.
- **The rule rides the system prompt.** The mod adds how Claude should keep the
  Task list to each session that has the Task tools, instead of the installer
  writing it into `CLAUDE.md`, so uninstalling leaves nothing behind. Where an
  organization manages Claude Code that hook does not run in a personally
  installed plugin; `setup -KeepRule` keeps the rule in `CLAUDE.md` there.
  Test: `the rule rides the system prompt only while the session has a Task list`.

## 0.4.0 — 2026-10-16

Takes in every fix from the local review of 0.3.0 (`UPSTREAM_ISSUES.md`, numbered
as there). Each test named below fails on 0.3.0 and passes here; 33 tests in all.
A copy with those local fixes can take this version as is.

- **Windows test fixture.** The fake file system maps `X:\home\...` back to
  `/home/...`, so the tests see the mod's reads and writes on every host.
- **1. A 完成 press could be overwritten.** Every write this session makes (its
  block, a tick, an archive, `/progress 整理`) goes through one queue.
  Test: `a 完成 press while Claude's own write is on its way: both land`.
- **2. A press could tick the wrong line, or a newer mark.** Steps carry their
  line and text; a press ticks that line if it still reads the same, else the
  one identical line in the file, else nothing.
  Tests: `a press ticks the exact line it showed, and nothing once that line
  changed`; `a press still finds its step after lines above it moved, unless
  the step has a twin`.
- **3. A failed read could empty a file.** A file that exists but cannot be read
  stops the write. A zero-byte read of a file the last poll saw with content is
  read again. `/progress 整理` says when it could not read. Archives are one
  file per month, `progress-archive-YYYY-MM.md`.
  Tests: `a progress.md that cannot be read is never rewritten`; `a progress.md
  holding only whitespace still gets this session's block`; `an archive file
  that cannot be read is left alone, and so is progress.md`; `old done blocks
  go to the month's archive file, after what it already holds`.
- **4. Archiving a block without its end marker.** Only closed blocks are
  archived, whole.
  Test: `archive moves a closed block whole and leaves an unclosed one where it is`.
- **5. Closing the pane by hand did not stick.** Only `mirror:` and `hinted:`
  store keys age out.
  Test: `the person's own store settings are never aged out`.
- **6. 接手做完 dropped step names past the fold.** Rows keep every open step.
  Test: `a task row keeps every open step for the take-over prompt, past the fold`.
- **7. Repeated titles shared keys.** Repeats get `#2`, `#3`, …; covered by the
  first test under 2.
- **8. Two quick side questions could cross.** A reply to a question no longer
  shown is dropped. No test, as in the local copy.

Two of the known issues listed there are fixed too:

- **An end marker closes only its own block** (`session=` must match, or be absent).
- **A block whose end marker was deleted by hand** ends at its first blank line,
  a second `###`, the next block or the next `##`, so hand-kept tasks after it
  are no longer overwritten.
  Test: `an end marker closes only its own block, and an unclosed block stops
  before hand-kept tasks`.

Still open: two sessions writing at the same moment (the last write wins;
needs a lock the mods API does not offer), a half-written read that is not
empty, the cost of side questions after the prompt cache expires, and desktop
sessions without Task tools.

## 0.3.0

Interactive pane: rows open to their steps and actions, 完成 / 完成這步 /
交給 Claude / 接手做完 / 繼續 / 封存, and a side-question box.

## 0.2.0

Mirrors Claude's Task list, survives compaction, plain-language pane.
