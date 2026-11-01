# Simulated user, before every release

CI shows the code works. This check shows a new person can use it: an AI, or a person, plays a user who has never seen Agent Board, installs the release's package and walks every journey below, noting each place where that user would stop, guess or give up. Every release needs it under [RULES.md, R7](../dev/RULES.md#r7-releases-go-out-by-themselves); it is gate 5 in [RELEASING.md](../RELEASING.md). Every release needs a record, pre-releases included.

Any agent (Claude Code, Codex, Antigravity, Cursor, a cloud agent) or person may run it, the release's author included: the record is evidence for the release pull request's reviewer, not an approval. Nothing here needs a particular agent or tool.

## Before you start

1. **The exact package.** On the release commit, run `npm pack --pack-destination <a folder outside the checkout>`. That file holds the same bytes npm will get. Wherever the README says `npx @wenyuchiou/agent-board`, run `npx --package <folder>/wenyuchiou-agent-board-X.Y.Z.tgz agent-board` instead, with the same arguments. Never run the steps from a checkout.
2. **A clean home.** Use a new, empty home folder for each persona: `HOME` on macOS or Linux; `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` on Windows. Remove it afterwards. Never run in your own home: setup changes agent settings.
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
| J4 | Open the board | open it each way the README offers: `npx @wenyuchiou/agent-board`, the agent's own board command (`/agent-board`, `$agent-board`, `/progress`), and the `--serve` page |
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
- A journey not walked, unless the record says why (an agent not installed) and that journey is already covered by the other persona.

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
Install only from the npm pack file of the release commit, in a new empty home folder, never my own.
Play each persona the page names for this system. Read only the README's Quick start and what the tool shows.
Do not read the source or fix anything. Mark every step PASS, FRICTION or FAIL by the page's criteria, with times.
Write the record in the page's format with no user names, email addresses, machine names or home-folder paths in it, open a usersim issue for each FRICTION and FAIL, and remove the temporary home folder.
```
