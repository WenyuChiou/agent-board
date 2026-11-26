# Codex terminal on its background daemon: a timing run, Windows, 2026-11-26

This is a timing run for #1652, not a delivery run. It measured when a Codex window's process exits and when the daemon closes the thread, so the receiver's process check (a Codex window found, its thread taking a message at the next tick) rests on measured times. No model call was made (a local stand-in server answered "ok"), so no board message was delivered. No thread ids, tokens or home-folder paths are written here; `<T>` stands for a thread id, and the run used a test home, a short folder of its own, so nothing touched a real Codex home.

## Versions and setup

| Item | Value |
|---|---|
| Codex CLI (`codex.exe`, npm install) | 0.167.0 |
| Daemon (`initialize` userAgent, `daemon version`) | 0.167.0 (the managed copy the daemon installs under the test home) |
| System | Windows 11 10.0.26300; Node 24.14.0; Python 3.14.0 |
| Clock | system wall clock. Python `time.time()` for the window driver and the commands, Node `Date.now()` for notices (arrival time at the bare client). Process start and exit times from `GetProcessTimes` (FILETIME), same clock. All values below are seconds, ms precision. |
| Window | ConPTY made with `CreatePseudoConsole` (Python ctypes), shell host `cmd.exe /k`, then `codex` typed. The window is 120x30. Needs `STARTF_USESTDHANDLES` set (with no handles) or the child inherits the driver's own stdio instead of the pseudo console. |
| Home | a test home holds HOME, USERPROFILE, APPDATA, LOCALAPPDATA, CODEX_HOME, XDG_*, TEMP, TMP. Proxies point to 127.0.0.1:9. Socket path stayed short, no `SUN_LEN` failure. |
| config.toml | as in the C1 note, with `daemon_auto_start = true`, `[features] hooks = false`, `plugins = false`, project folder trusted |
| Daemon start | **by hand with `codex app-server daemon start`** (and `daemon restart` later), not by a plain `codex`. A plain `codex` auto-start was not tried (the daemon was already needed by the bare client). The plain `codex` windows did join this daemon (their threads appeared on it). `daemon start` also started a second process, `codex.exe app-server daemon pid-update-loop` (an updater), stopped at the end. |

Commands: `codex.exe app-server daemon start|restart`; a bare client that runs `codex.exe app-server proxy` and speaks the websocket framing of `scripts/ws-stdio.mjs` over its stdio; a window driver; windows typed: `codex`, `codex resume <T>`, `codex -c thread_unload_delay_secs=300`, `/new`, `/quit`.

## A plain `codex` window (never joined by the bare client)

| Item | Result |
|---|---|
| `thread/started` after Enter on `codex` | 1.574, 1.001, 2.344, 1.125, 0.909 s (5 runs), **before any prompt** was typed. The TUI creates and loads its thread at start. |
| Process chain | `cmd.exe` (shell host) > `node.exe` (npm launcher, command line `node ...\codex.js`) > `codex.exe` (the client; command line is just the exe path, **no thread id, no flags**). Launcher starts 0.03 to 0.29 s after Enter, `codex.exe` 0.05 to 0.2 s after the launcher. |
| Short-lived helpers | two more `codex.exe` children of the client, alive about 40 to 60 ms each, start 0.2 to 1.1 s after Enter, command line unreadable (gone before the query). Absent in the in-process (`-c`) run. |
| `thread/loaded/list` | lists the thread from `thread/started` on |
| `thread/read` of a TUI-created thread (`includeTurns:false`) | `source: "vscode"`, `originator`: see below, `cwd` the project folder, `cliVersion 0.167.0`, `threadSource: "user"`, `ephemeral: false`, `status idle` |
| `originator` | **Belongs to the daemon, not the thread's creator.** Daemon whose first `initialize` came from the bare client: the TUI's thread read the bare client's name. After a daemon restart with the TUI first: `originator = "codex-tui"`, and the bare client's `initialize` userAgent then also said `codex-tui`. `source` was `"vscode"` in every case. So neither field tells a TUI-created thread from another client's. |
| Extra thread | the first turn (one synthetic prompt) started a second thread, `ephemeral: true`, no environments, closed about 43 s later by itself. The receiver ignores `ephemeral` threads. |
| Prompt needed to create the thread? | No. A prompt was only needed so the saved session exists for `resume` (a thread with no turn has no saved file). |

## Resume, `/new`, `-c`

| Run | Result |
|---|---|
| `codex resume <T>` (thread had been unloaded) | **No `thread/started`.** First notice: `thread/status/changed idle` (then `thread/tokenUsage/updated`, `thread/goal/cleared`) about 1.25 s after Enter. Launcher and `codex.exe` command lines both **name the thread id**. |
| `/new` typed in the window | new `thread/started` 0.10 s after Enter. **No new process, command line unchanged.** The old thread unloaded 60.0 s after the `/new` Enter (`thread/closed`). |
| `codex -c thread_unload_delay_secs=300` | in its own process: **no `thread/started` and no other notice on the daemon** in 38 s watched, nothing in `thread/loaded/list`. One `codex.exe` only (no helpers), command line carries the `-c` text. |

## Window open and idle

Thread listed at 10.0, 30.2, 70.4 and 120.8 s after open: yes at every check (also in all 1 s polls, and for a second window's thread for 150 s).

## Closing (default delay, config key unset)

| Close method | Moment (t0) | Client `codex.exe` exit after t0 | Launcher / shell exit after t0 | `thread/closed` after t0 | Gap client exit to `thread/closed` |
|---|---|---|---|---|---|
| Close the pseudo console | `ClosePseudoConsole` called | +0.001 | +0.019 / +0.019 | **+60.014** | 60.013 |
| same, window on a resumed thread | same | +0.002 | +0.024 / +0.025 | +60.016 | about 60.01 |
| same, second window (two-window run) | same | +0.002 | +0.02 | +60.025 | 60.02 |
| `/quit` typed, Enter | Enter written | +0.024 | +0.02 | +60.022 | 59.998 |
| Kill the shell host (`cmd.exe`) by id | `TerminateProcess` | **did not exit**; launcher `node.exe` and `codex.exe` still alive 312 s later, thread still listed | shell exits at once | none until the pseudo console was closed; then +0.005 exit and +60.015 | 60.01 after the later exit |

Notes: exit code of the client after pseudo-console close is `0xC000013A` (Ctrl-C), after `/quit` 0. One oddity: the first `/quit` Enter (1.1 s after the text) was taken as a message to the model, and no quit happened; the second attempt (2.5 s between text and Enter) quit at once.

## Delay set in config.toml (daemon restarted each time)

| Setting | `config/read` with the thread's cwd reports | Close (pseudo console) to `thread/closed` |
|---|---|---|
| unset | `thread_unload_delay_secs: null` (key present, value null; the daemon then uses 60) | +60.014 |
| 20 | 20 | **+20.017** (client exit +0.002, gap 20.015) |
| 300 | 300 | **+300.013** (client exit +0.002, gap 300.011) |

## Two windows on two threads

Window A and B open, both threads listed. A closed (pseudo console): A's client exit +0.001; **B's `codex.exe` still existed**; B's thread stayed listed in all 144 polls (60 s and beyond); A's `thread/closed` at **+60.014**. B closed later by its own close: +60.025.

## A bare client, no window

`thread/resume` (`excludeTurns:true`) then, 5.43 s later, `thread/unsubscribe` (answer `unsubscribed`): no `thread/started` on join; the thread then stayed listed and **`thread/closed` came 60.013 s after the unsubscribe** (65.4 s after the join).

## Where the process check and `thread/loaded/list` disagree

| Situation | Client process exists | Thread listed |
|---|---|---|
| 0 to 60 s after a window closes | no (gone in 1 to 2 ms) | yes |
| Two windows, one closed | yes (the other window) | yes for the closed one for 60 s |
| Bare client joined and left, no window | no | yes for 60 s |
| Shell host killed, client alive | yes | yes |
| `-c` window (in-process) | yes | never listed |

## What this means for the receiver

- `originator` and `source` do not mark TUI-created threads, so the receiver does not try to tell who created a thread.
- A resumed thread sends no `thread/started`: the receiver times a thread from the first time it sees it listed and idle.
- The first `thread/closed` comes 60.01 s after the last leave; `config/read` for an unset delay gives `null`, which the receiver reads as 60 s.
- Killing only the terminal's host process does not end the client or its attachment to the thread; only closing the console or `/quit` does. The process check then reads "a window is open".
- Each first turn also starts a short-lived `ephemeral` thread, which the receiver ignores.

## Not done

A model turn, a real terminal window (a pseudo console was used), and the daemon's auto-start by a plain `codex`.
