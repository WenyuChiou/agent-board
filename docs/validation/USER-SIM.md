# Simulated user, before every release

CI shows the code works. This check shows a new person can use it: an AI, or a person, plays a user who has never seen Agent Board, installs the release's package and walks every journey below, noting each place where that user would stop, guess or give up. Every release needs it under [RULES.md, R7](../dev/RULES.md#r7-releases-go-out-by-themselves); it is gate 5 in [RELEASING.md](../RELEASING.md). Every release needs a record, pre-releases included.

Any agent (Claude Code, Codex, Antigravity, Cursor, a cloud agent) or person may run it, the release's author included: the record is evidence for the release pull request's reviewer, not an approval. Nothing here needs a particular agent or tool.

## Before you start

1. **The exact package.** On the release pull request's head, run `npm pack --pack-destination <a folder outside the checkout>`. That file holds the same bytes npm will get. Wherever the README says `npx @wenyuchiou/agent-board`, run `npx --package <folder>/wenyuchiou-agent-board-X.Y.Z.tgz agent-board` instead, with the same arguments. Never run the steps from a checkout.
2. **A clean home.** Use a new, empty folder for each persona, and point every home and agent folder at it before you install, apply or start any agent: `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`, and the agents' own overrides `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`, `HERMES_HOME`, `GROK_HOME`, `OPENCLAW_STATE_DIR`, `DSH_HOME` and `CLAUDE_PROGRESS_FILE`. An override left set still points setup at that folder, even with the home moved. The `iso` function in [CONTRIBUTOR-PATH.md, step 4](../CONTRIBUTOR-PATH.md#4-run-the-checks) sets them all; on Windows, set the same names in the PowerShell session. Remove the folder afterwards. Never run in your own home: setup changes agent settings.
3. **Two systems.** One run on Windows (PowerShell), one on macOS or Linux (bash or zsh). Node 22 or newer, as the README asks.
4. **Agents.** Use real agents where they are installed, with no model turns needed. Where one is not, make a synthetic session the way `tests/e2e/` does, and write `synthetic` in that step's row.
5. **Stay in the user's shoes.** Read only what that user would: the README's Quick start and what the tool itself prints or shows. Do not read the source, `docs/dev/` or the tests to get past a step. Do not fix anything during the run.

## Personas

| | Persona | System | What they bring |
|---|---|---|---|
| P1 | First-timer with one agent | Windows | Uses Claude Code or Codex daily; has never used Agent Board; copies commands from the README |
| P2 | Several agents | macOS or Linux | Runs Claude Code, Codex and Antigravity side by side; wants one place to see them |
| P3 | Chinese-language user | either | Board set to `zh-TW` (and `zh-CN` once a release changes strings); walks J1, J4, J5 and J8 only |

## Journeys

Walk each journey from the README's own words. A step names what the user tries, not how.

| | Journey | The user tries to |
|---|---|---|
| J1 | Install | find the install commands in the README, preview what setup would change, then apply it |
| J2 | Repeat and keep | run the preview again and see nothing left to change; find their own existing agent settings untouched |
| J3 | Connect an agent | start a new session of their agent and see it appear on the board |
| J4 | Open the board | open it each way the README offers: `npx @wenyuchiou/agent-board`, the agent's own board command (`/agent-board`, `$agent-board`, `/progress`), and the page `agent-board --lan` opens |
| J5 | Answer a question | see an agent's question at the top, answer it (Copy, or Send when messaging is on), hide one already answered, show it again |
| J6 | Several agents | see each agent's rows apart, tell which is working, waiting or stuck |
| J7 | Finish and tidy | tick steps done, see finished work leave the board, archive a stopped session |
| J8 | Look and language | switch Light and Dark; read the board in the persona's language |
| J9 | Something goes wrong | an agent does not show up: find the fix from the README's Troubleshooting and the doctor's output alone |
| J10 | Stop and remove | stop the board's page, then uninstall, and find no leftovers outside what the guide says it keeps |

## What passes

Every step gets one result:

- **PASS:** it worked, and the user knew what to do next from the screen alone.
- **FRICTION:** it worked, but the user had to stop, guess, retry, or read past the README's Quick start.
- **FAIL:** it did not work, it said it worked when it did not, or it changed something it did not show first.

A step is FRICTION or FAIL when any of these is not true:

1. **No guessing.** The next action is on the screen: the command to run, the button to press.
2. **Commands work as written.** A command copied from the README runs unchanged in that shell (PowerShell and bash differ).
3. **Plain words.** Output says what happened, in the board's language: no stack trace, no raw JSON unless `--json` was asked for, no internal ids, no untranslated strings.
4. **Errors say what to do.** An error names what went wrong and the one next step, in the same place.
5. **No false success.** Nothing shows Sent, Replied, connected or done before it is (a Copy is not a Send).
6. **Nothing unannounced.** Apply changes only the files the preview listed; nothing else in the home folder changes.
7. **Undo works.** Hide, show again, archive, stop and uninstall do what they say, and no work is lost.
8. **Usable.** Works with the keyboard alone; readable in Light and Dark; every mark reads without colour.
9. **Fast enough.** Setup preview within 10 s, the board open within 5 s, a new session on the board within 10 s of its first event. Over the target is FRICTION; over three times the target is FAIL.

## What blocks a release

- Any FAIL, in any journey or persona.
- Any FRICTION without an issue. Open one per FRICTION (bug form, label `usersim`), link it in the record, and the release may go out with it.
- A journey not walked, unless the record says why (an agent not installed) and that journey is already covered by the other persona, or a run after a change left it out because no changed file reaches it and the earlier record walked it (below).

## A run after a change

When the release pull request's head changes after a record (`main` merged, a fix pushed), the next run may cover only what the change reaches. It takes less time and still skips nothing the change could break. It builds on an earlier record of this release that walked every journey each persona walks (see Personas), on each persona's system; a journey it leaves out is one that record walked, and the scope comment names the row.

1. **Scope from the files.** Run `git diff --name-only <the record's commit>..<the new head>`. Each changed file reaches the journeys in this table, and the run covers every journey that any changed file reaches. A test or CI file reaches none, unless the build of a shipped file reads it. The generated files `hooks/board-script*.ts` and `hooks/released.ts` reach what their changed sources reach; when one changes while none of its sources does, that is a full run. A change to how they are built (`scripts/build-board.ts`, `scripts/build-released.ts`, or the pinned Bun version) is a full run.

   | Changed file | Journeys |
   |---|---|
   | `scripts/setup-agent.mjs`, `scripts/setup-codex.mjs`, `scripts/codex-local.ts` | J1, J2, J3 (the hooks setup writes), J9, J10 |
   | `bin/agent-board.mjs` | every saved step replayed (step 4), plus a walk of each command it changed |
   | `hooks/serve.ts`, `hooks/dashboard.ts`, the page's styles | J4 to J8 on the page, with new screenshots |
   | `scripts/board-cli.ts` | J4 and J5 on the terminal board, in a real terminal |
   | `scripts/board-messaging.ts`, `scripts/board-serve.ts`, `hooks/receiver*.ts` | J4 and J5 with several pages at once, and Send |
   | `hooks/i18n.ts`, `hooks/strings-*.ts` | each screen whose words changed, and P3's journeys in full |
   | `hooks/board.ts`, `hooks/board-status.ts`, `hooks/view.ts`, `hooks/parse.ts`, `hooks/blocks.ts` | J3 to J8 |
   | `README*.md`, `docs/GUIDE*.md` | the steps that use the changed lines, plus J1 |
   | any other file the release ships: what `npm pack` publishes, what the board script bundles, or the Claude Code plugin (`hooks/`, `.claude-plugin/`) | a full run; the plugin is loaded from a checkout of the new head (`claude --plugin-dir <folder>`), not installed from GitHub |

2. **Always in.** Every step that was FAIL in an earlier run on this release, and for each issue the release fixed, the step that showed it (the record row that links the issue, else the steps its report names): marked FAIL with `#NNN back` if it shows again.
3. **Before the run.** Post the scope on the release pull request: the changed files, the journeys they reach, and what is left out and why.
4. **Replay, then walk.** Replay every saved step of the earlier run (step 7) on the new package and compare the output with the earlier output, with times, ports and tokens masked. A replay that checks only printed output does not show that an agent still appears on the board: a step that sets up an agent also checks the board. Walk by hand every step in scope and every step whose output changed. Retake the screenshots of any page that changed.
5. **Say how each row ran.** In the Note column, start a row that was not walked on the record's head with `replayed, same output:` or `carried from <commit>:`. A carried row is a step out of scope that no saved script covers, such as a look at a page that did not change; it keeps the result it had in the record of that commit. A row with neither was walked on the head the Package line names.
6. **A full run** after two runs in a row that were not full, and before a release goes out as stable.
7. **Save the steps.** Each runner saves every step as a script, with its raw output, so the next run can replay it. They stay with the runner, off GitHub: like the record, they hold paths and tokens until masked ([RULES.md, R8](../dev/RULES.md#r8-what-stays-off-github)).

## The record

Write `docs/validation/<date>-usersim-<version>.md` in the release pull request:

```md
# Simulated user, X.Y.Z

Package: wenyuchiou-agent-board-X.Y.Z.tgz from <full commit sha>, sha256 <hash>
Run by: <agent or person>, <date>
Systems: Windows 11, PowerShell 7, Node 24.x; macOS 15, zsh, Node 22.x

| Persona | Journey | Step | Result | Time | Note | Issue |
|---|---|---|---|---|---|---|
| P1 | J1 | preview | PASS | 4 s | | |
| P1 | J9 | find the fix | FRICTION | | Troubleshooting names the doctor, but not for Antigravity | #NNN |

Summary: N PASS, N FRICTION (all with issues), 0 FAIL.
```

Screenshots of each journey's last screen go next to it, from the clean home only. The record is public ([RULES.md, R8](../dev/RULES.md#r8-what-stays-off-github)): before you commit any text, output or picture, replace computer user names, email addresses, machine names, home-folder paths, session ids and tokens with placeholders such as `<home>`, and say in the alt text that the data is synthetic. Name the runner by agent or GitHub login only. The PR check fails a record that still holds a home-folder path, a session id, a token or an email address.

## Prompt to give an agent

Paste this into any agent, with the version filled in:

```text
Run the simulated-user check in docs/validation/USER-SIM.md for Agent Board X.Y.Z, on this computer.
Install only from the npm pack file of the release pull request's head, in a new empty home folder, never my own.
Play each persona the page names for this system. Read only the README's Quick start and what the tool shows.
Do not read the source or fix anything. Mark every step PASS, FRICTION or FAIL by the page's criteria, with times.
Save each step as a script, with its raw output, so the next run can replay it.
Write the record in the page's format with no user names, email addresses, machine names or home-folder paths in it, open a usersim issue for each FRICTION and FAIL, and remove the temporary home folder.
```
