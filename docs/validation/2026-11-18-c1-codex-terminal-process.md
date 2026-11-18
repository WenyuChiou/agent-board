# C1: can Codex's hook name the Codex terminal process? 2026-11-18

Check C1 of the 0.25.1 plan (`docs/dev/plan-0.25.1.md:65`), for M5a (`docs/dev/plan-0.25.1.md:114`), #1652 and #1613. Code is cited at main `a679f24f`.

## Verdict

**Fail. M5a cannot ship as designed.**

On Windows with Codex 0.167.0, a plain `codex` runs its session on a shared background server, and that server runs the hooks. The hook's parent chain leads to the server. Above the server it can reach at most the window that started the server, never this session's own window.

| Route | Who runs the hook | Records with the terminal in the parent chain | After the window closes, the process the walk finds |
|---|---|---|---|
| Shared server started by hand, Windows | The server | **0 of 33** | **Still running**, at the end of every watch (up to 80 s) |
| Shared server started by hand, Linux | The server | **0 of 31** | **Still running** after the last close |
| In-process, Windows | The terminal | 50 of 50 | Gone within 2 ms |
| In-process, Linux | The terminal | 24 of 24 | Gone within 20 to 346 ms |

The 0 of 33 and 0 of 31 apply to a server started by hand, whose parent is the test program. A server that a plain `codex` starts for itself has that first terminal as its parent (two recorded starts, both of which then stopped on the socket path described below). So the first window can appear in the chain, and every later window would walk up to the first window's terminal, which is the wrong process.

The walk works only on the in-process route, and the board's receiver cannot reach a session on that route (`docs/validation/2026-11-13-codex-cli-wake-live.md:46`). The route the receiver can reach is the one where the walk cannot find the terminal.

A careless build would fail silently. The server is also named `codex.exe`, so "the nearest `codex.exe`" returns a live process with a valid start time. That process outlives the window, so a board message could start a turn in a closed window. M5a's own bar forbids this (`docs/dev/plan-0.25.1.md:118`).

## Question

On Codex CLI, can the script Codex's hook runs name the Codex terminal process within the hook's time limit, and does that process live as long as the window? Windows and Linux.

## Versions

| Item | Windows | Linux (WSL 2) |
|---|---|---|
| System | Windows 11, build 10.0.26300 | Ubuntu 24.04.3, kernel 6.6.87.2 |
| Codex CLI | 0.167.0 (npm install, native `codex.exe`) | 0.153.0 (real ELF binary, already on the computer) |
| Node | 24.14.0 | 22.19.0 |
| Other | Windows PowerShell 5.1.26100.9818, Python 3.14.0 | Python 3.12.3 |

The `codex` on the WSL path is the Windows npm shim under `/mnt/c`. It was not used. The Linux runs used the separate ELF binary.

No real model call was made and no credits were used. Codex talked to a small local stand-in server that answers every request with "ok".

## The hook's time limit

Read from the `hooks.json` that `scripts/setup-agent.mjs --agent codex --apply` generated in a temporary home. The values come from `hooks/hook-safety.ts:17` through `hooks/hook-safety.ts:33`.

| Event | Limit |
|---|---|
| SessionStart, PermissionRequest, Interrupt, SessionEnd | 3 s |
| UserPromptSubmit, Stop, PostToolUse (`update_plan`) | 10 s |

The board's own SessionStart hook, run the way Codex runs it, took 298 ms minimum, 309 ms median and 444 ms maximum (10 runs, all exit 0).

## How to repeat it

1. Make a temporary home and point `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_*`, `TEMP` and `TMP` inside it. Point `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` at the closed port `127.0.0.1:9`, with `NO_PROXY=127.0.0.1,localhost`.
2. Write this `config.toml`, and mark the project folder trusted:

   ```toml
   model = "mock-model"
   model_provider = "mock"
   approval_policy = "never"
   sandbox_mode = "read-only"
   check_for_update_on_startup = false

   [model_providers.mock]
   name = "mock"
   base_url = "http://127.0.0.1:<port>/v1"
   wire_api = "responses"
   requires_openai_auth = false

   [features]
   hooks = true
   plugins = false
   daemon_auto_start = false   # in-process runs; the server runs set this to true
   ```

3. Declare a test hook for SessionStart (3 s), UserPromptSubmit (10 s), Stop (10 s) and SessionEnd (3 s). Trust it with the calls `scripts/codex-host.ts:277` and `scripts/codex-host.ts:289` use (`hooks/list`, then `config/batchWrite`).
4. The test hook is a Node script. It reads the hook's input, walks up from its own process id, and saves each process's id, parent id, name, start time and command line, with the walk's duration.
   - **Windows, nearest-parent walk:** one `powershell.exe -NoProfile -NonInteractive` that runs `Get-CimInstance Win32_Process -Filter "ProcessId=<id>"` once per step.
   - **Windows, whole-table walk:** one `Get-CimInstance Win32_Process` call for all processes, with the chain worked out in Node.
   - **Linux:** reads `/proc/<id>/stat` and `/proc/<id>/cmdline`.
5. Start a shell inside a pseudo console the test owns (`CreatePseudoConsole` on Windows, `pty.fork` on Linux). Type `codex`, wait for "Ask Codex", wait 3.5 s, type `Synthetic test: reply ok`, press Enter, and wait for the Stop hook.
6. Wait 2 s, then close the pseudo console (`ClosePseudoConsole`, or closing the master side on Linux). Read each process's exit time. Windows uses `GetProcessTimes`; Linux polls `/proc` every 10 ms.
7. For a resumed session, do the same with `codex resume --last`.
8. For the shared server route, start the server first and connect the window to it:

   ```text
   codex app-server --listen ws://127.0.0.1:<port> --analytics-default-enabled --managed-daemon
   codex --remote ws://127.0.0.1:<port>
   ```

   Linux 0.153.0 used `codex app-server --listen ws://127.0.0.1:<port>` without the two extra flags.

**Why the server was started by hand.** A plain `codex` did try to start the shared server here. It started `codex.exe app-server --listen unix://<temp>/... --analytics-default-enabled --managed-daemon`, which stopped with `path must be shorter than SUN_LEN`. The window then said `app server did not become ready`. This check keeps every home inside one long temporary folder, so the socket path was too long. A short directory link did not help, because Codex resolved it back to the long path. The hand-started server uses the same program and the same flags, with a loopback websocket in place of the socket. It differs in one way that matters here: its parent is the test program, while an auto-started server's parent is the terminal that started it.

## Results on Windows

### Who is in the parent chain

In-process, started from PowerShell:

```text
node.exe (test hook)
  <- powershell.exe -NoProfile -Command (Codex's hook shell)
  <- codex.exe (the terminal process)
  <- node.exe codex.js (npm launcher)
  <- powershell.exe (the person's shell)
```

Shared server:

```text
node.exe (test hook)
  <- powershell.exe -NoProfile -Command (Codex's hook shell)
  <- codex.exe app-server --listen ws://... --managed-daemon (the server)
  <- the test program that started the server
```

The terminal process is not in this second chain, because the test program started this server. The hook's input and its environment variable names do not name it either. The input keys were `cwd`, `hook_event_name`, `last_assistant_message`, `model`, `permission_mode`, `prompt`, `reason`, `session_id`, `source`, `stop_hook_active`, `transcript_path` and `turn_id`. The variables whose names start with `CODEX`, `TERM`, `WT_`, `SESSIONNAME` or `AGENT` were `CODEX_HOME`, `CODEX_MANAGED_BY_NPM`, `CODEX_MANAGED_PACKAGE_ROOT` and `TERM`.

### How long the walk took (ms)

"Limit clock" runs from the start of Codex's hook shell to the end of the test hook. Codex's own timer starts slightly earlier, so the real figure is a little higher.

| Route and walk | Sessions | Records | Walk min / median / max | Limit clock min / median / max |
|---|---|---|---|---|
| In-process, nearest-parent | 12 | 35 | 1227 / 1602 / 1817 | 1413 / 1777 / 1993 |
| In-process, whole-table | 5 | 15 | 528 / 568 / 1014 | 703 / 749 / 1198 |
| Shared server, nearest-parent | 10 | 33 | 1154 / 1327 / 1499 | 1342 / 1515 / 1676 |

SessionStart alone, the 3 s event:

| Route and walk | Records | Walk min / median / max | Limit clock min / median / max |
|---|---|---|---|
| In-process, nearest-parent | 11 | 1337 / 1607 / 1739 | 1528 / 1805 / 1922 |
| In-process, whole-table | 5 | 544 / 602 / 1014 | 736 / 802 / 1198 |
| Shared server, nearest-parent | 7 | 1193 / 1330 / 1443 | 1381 / 1525 / 1626 |

**One hook hit the limit.** In 1 of the 19 SessionStart hooks that used the nearest-parent walk, Codex stopped the hook and showed `Hook failed` and `hook timed out after 3s` in the window. That hook saved no record. None of the 5 whole-table SessionStart hooks timed out. The computer was in normal use during the runs.

Adding the walk to the board's own hook was not measured. By inference from the two medians, the total would be about 1.1 s with the whole-table walk and about 2.1 s with the nearest-parent walk, against the 3 s limit.

### When each process exits after the window closes (ms)

| Route | Sessions | Terminal `codex.exe` | npm launcher `node.exe` | Person's shell | Server |
|---|---|---|---|---|---|
| In-process | 17 | 2 in every session | 26 to 36 | 27 to 39 | none |
| Shared server | 10 | 1 to 2 | 18 to 21 | 20 to 24 | **did not exit** |

The launcher and shell columns leave out the 2 sessions that started `codex.exe` directly, which have neither.

On the shared server, the SessionEnd hook arrived **61.4 s** and **61.5 s** after the window closed (2 sessions watched for 80 s). On the in-process route, no SessionEnd hook arrived in the 5 to 8 s watched after each close.

### Resumed sessions

| Route | Resumed sessions | Result |
|---|---|---|
| In-process | 3 | The terminal was in every chain. SessionStart came with `source=resume` in 2. In the third it was the hook that timed out |
| Shared server, resumed within seconds of the close | 3 | **No SessionStart hook at all.** UserPromptSubmit and Stop ran under the server |
| Shared server, resumed after the thread had unloaded | 1 | SessionStart came with `source=resume`, under the server |

### What could be mistaken for the terminal

- **The server.** It has the same image name, `codex.exe`. Only its command line (`app-server`) tells them apart. This is the dangerous case.
- **The npm launcher.** It is a `node.exe` directly above the terminal, and it exits 26 to 36 ms after it. It has the same name as the hook's own `node.exe`, and it does not exist when `codex.exe` is started directly.
- **The hook's shell.** It is a `powershell.exe`, the same name as the person's shell, and it ends with the hook.
- **Sub-processes of the terminal**, such as `git.exe`. These are children, so a walk upward never lands on them.

## Results on Linux

Codex 0.153.0, the only real Linux Codex present. Its feature list has no `daemon_auto_start`, and a plain `codex` ran the session in-process.

| Route | Sessions | Hook records | Terminal found | Walk (ms) min / median / max | Terminal exit after close (ms) |
|---|---|---|---|---|---|
| In-process, new sessions | 5 | 15 | 15 of 15 | 0.77 / 0.97 / 2.23 | 20 / 112 / 346 (8 closes) |
| In-process, resumed | 3 | 9 | 9 of 9 | 0.84 / 1.07 / 1.98 | 20 / 51 / 152 |
| Shared server, new and resumed | 8 | 31 | **0 of 31** | 0.71 / 0.85 / 2.37 | 51 / 117 / 132 |

- From the start of the hook's Node process to its end took at most 50 ms, so the time limit is no concern on Linux.
- The npm launcher exited 51 to 386 ms after the close.
- On the shared server route, every record's nearest `codex` was the server, and the server was still running after the last window closed.
- The first in-process row's 8 closes include 3 resumed sessions whose typed prompt was never submitted, so they produced no hook records. The resumed row passed the prompt on the command line instead.
- An earlier Linux warm-up series is left out, because its record folder mixed two runs.

## What was not run, and why

- **A plain `codex` joined to an auto-started server.** The socket path was too long in this check's temporary folder. The hand-started server stands in for it. A 2026-11-13 run on a short path found the same thing: "The daemon runs the session's hooks" (`docs/validation/2026-11-13-codex-cli-wake-live.md:60`).
- **A current Linux Codex.** Only 0.153.0 is present and downloads were not allowed. Whether a current Linux build starts the shared server by default is not known from this check. On Windows 0.167.0 it does (`daemon_auto_start` is stable and on).
- **A real terminal window being closed.** Closing the pseudo console stands in for it.
- **Leaving Codex with `/quit` or Ctrl+C, a crash, or closing the window during a running turn.**
- **Two windows on one thread.**
- **The Codex desktop app and IDE extension (#557), and macOS.**
- **M5a's live record** (Send to turn start). It depends on this check.
- **Any other sign of the window on the shared server route.** Only the parent chain, the hook input and the environment variable names were examined.

Three things about how the check ran:
- The short directory link lived in `<temp>` for a few minutes, outside the experiment folder. It was removed.
- A first start of the test program crashed and left one test `codex.exe`. It was stopped by its exact process id after its working folder was confirmed to be inside the experiment folder.
- Codex's auto-update process never started in any run.

## Effect on the plan

- **M5a:** the plan's failure line applies (`docs/dev/plan-0.25.1.md:65`, `docs/dev/plan-0.25.1.md:197`). The owner decided on 2026-11-18: Codex keeps the 10-minute route (`scripts/codex-receiver.mjs:43`) until there is another sign that a person is there, and #1652 moves to 0.26.0.
- **The cause is where the hook runs, not what it says.** By inference, a different hook text would not help on the shared server, because the server starts the hook. So this result does not by itself ask for a hook change in 0.26.0.
- **Support table:** "now" for "a session with a live process record" would apply only to in-process sessions, which the receiver cannot reach. The honest line for Codex stays "after about 10 minutes".
- **M7, closing a card (`docs/dev/plan-0.25.1.md:138`):** a Codex session on the shared server has no usable process record. Its card falls to SessionEnd, measured at 61.4 s and 61.5 s after two closes of one thread. Moment 5's 60 s bar covers only Claude Code and a Codex session with a process record (`docs/dev/plan-0.25.1.md:26`), so no 60 s bar applies to this card, and that bar now covers almost no plain Codex session. Otherwise it shows "the window may be closed".
- **Any later use of a walk:**
  - Never accept a process by the name `codex.exe` alone. When the walk reaches a process whose command line has `app-server`, it must stop there and return unknown, not keep walking.
  - Record the identity on UserPromptSubmit too, because a quick resume on the shared server sends no SessionStart.
  - Prefer the 10 s event, because the nearest-parent walk hit the 3 s limit once in 19 tries.
