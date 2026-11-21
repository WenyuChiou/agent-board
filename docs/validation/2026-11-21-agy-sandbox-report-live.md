# agy's terminal sandbox and the board report (#1384)

Date: 2026-11-21. Verdict: **cause found and fix shown live.** A report the sandbox refuses is saved in `TEMP`, and the conversation's next hook brings it to the board: its steps show and its `[?]` question reaches Needs you.

## Versions

- agy (Antigravity CLI) 1.5.10 for the `--print` run and 1.5.13 for the TUI run, default model, Windows 11 build 10.0.26300.
- Node v24.14.0.
- The kept test home of `docs/validation/PARITY-CHECKLIST.md`, with agent-board installed from the branch of #1384 (`setup --agent antigravity --apply`): at 402f1657 for the `--print` run, at 4ee28f78 for the TUI run.

## Cause

A probe script, run by the model as its own terminal command, tried a file create in each place and a TCP connect to a closed port on 127.0.0.1:

| agy setting | Board folder (inside the user profile, outside the project) | `TEMP` | 127.0.0.1 |
|---|---|---|---|
| default mode, no sandbox | ok | ok | reaches the port |
| `enableTerminalSandbox: true`, `toolPermission: proceed-in-sandbox` | `EPERM` | ok | reaches the port |

- `EPERM` on the lock's create, with no lock file there, is what `withLocalLock` reports as `LOCK_DENIED`, the 11-12 failure.
- agy's docs say `auto` mode turns the terminal sandbox on by itself and is the default where offered. Both accounts tried here print `--mode auto is not available for this account`, so the sandbox is on only for some people, or when they turn it on.
- agy's own hooks are not sandboxed: they write the same folder.

## Live run

1. The kept home's agy settings got the two sandbox keys above (a copy kept, put back afterwards).
2. A one-line synthetic prompt in `agy --print` asked the model to run the board report from its hook's instructions, with a plan titled "Synthetic live 1384", one done step and one `[?]` step.
3. The report printed `"saved": true` and the note that the report reaches the board at the conversation's next step.
4. After the run, `progress.md` held the block with both steps, its state `waiting`. `agent-board --json` listed the question in `needs`. The spool folder was empty.

## Live run in the interactive TUI

On 4ee28f78's build, where a saved report comes back only through a hook of its own conversation:

1. The same two sandbox keys in the kept home's agy settings (a copy kept, put back afterwards).
2. `agy -i "<prompt>"` started the TUI with a one-line synthetic prompt as its first message, asking the model to run the board report once with a plan titled "Synthetic TUI 1384", one done step and one `[?]` step. Nothing was typed into the TUI.
3. The model ran the command in the sandbox; it printed `"saved": true` and the note.
4. When the turn ended, the conversation's own hook brought the report in: `progress.md` held the block with both steps, its state `waiting`; `agent-board --json` listed the question in `needs`; the spool folder was empty; the hook error log had no new line.
5. The TUI's footer showed `auto` as its approval mode.

## Not shown

- The Antigravity desktop app with the sandbox on.
- macOS and Linux sandboxes: the CI tests use a read-only folder instead.
- `auto` mode itself, which neither account offers.
