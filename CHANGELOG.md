# Changelog

## Unreleased

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
  failed payload with the same name".






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
