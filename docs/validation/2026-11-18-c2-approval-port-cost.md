# C2: what does finding a port's listener and its command line cost inside the approval hook on Windows?

Date: 2026-11-18. Plan: `docs/dev/plan-0.25.1.md` (M0 table, C2 row, line 66; M4, lines 106-112; section 4, lines 172-194), at main a679f24f. Issue: #1651.

## Question and limit

The M4 fix makes the Claude Code approval hook check, before it sends a command, that the process listening on `127.0.0.1:<port>` is the one named in the address file, and that its command line is the board script. C2 asks what that lookup costs on Windows. The limit is 2 s added. If the lookup is over budget, the hook returns no decision and the card says to answer in the window.

## Versions and machine

| Item | Value |
|---|---|
| OS | Windows 11 Home, build 10.0.26300 |
| CPU | 8 cores, 16 logical, 9800X3D class |
| Node | v24.14.0 |
| Windows PowerShell | 5.1.26100.9818 (`System32\WindowsPowerShell\v1.0\powershell.exe`, the one the hook already uses at `scripts/claude-approval.mjs:154`) |
| netstat | `System32\netstat.exe` |
| `wmic.exe` | not present on this build, so not measured |
| Board code | main a679f24f, read only, nothing changed |
| Machine state | normal use, real windows open. 711 processes before the runs and 711 after (`tasklist /fo csv /nh` line count). Whole-machine CPU busy averaged 38% over the run (includes the measurement itself). |

## How the hook spawns things (what I copied)

`scripts/claude-approval.mjs:112-113` and `:154-158`: `execFileSync` on an absolute `System32` path, `{ encoding: 'utf8', windowsHide: true, stdio: 'pipe', timeout }`, and for PowerShell `-NoProfile -NonInteractive -Command <script>` with `PSModulePath` set to the system modules. The measurement script spawns the same way. The plan does not name exact commands, so I measured the obvious ones. All of them are the system's own table.

## Methods

Each takes the port, returns the owning process id and, except E, its command line.

| Id | What it runs | Spawns |
|---|---|---|
| A | `netstat.exe -ano -p TCP`, parse the `LISTENING` line for `127.0.0.1:<port>`; then `powershell -NoProfile -NonInteractive -Command "(Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=<pid>').CommandLine"` | 2 |
| B | PowerShell `Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort <port>` for `OwningProcess`; then the same CIM call as A in a second PowerShell | 2 |
| C | One PowerShell that runs `Get-NetTCPConnection` and then `Get-CimInstance Win32_Process` and prints `pid\|commandline` | 1 |
| D | As A, but the second step uses `Get-WmiObject -Class Win32_Process` | 2 |
| E | `netstat -ano -p TCP` alone (process id only, no command line): the floor for the table lookup | 1 |
| F | The command-line step of A alone, for a known process id | 1 |

`$PSModuleAutoLoadingPreference='None'` (used by the hook's ACL script at `:143`) cannot be used for the CIM and WMI steps: it makes `Get-CimInstance` and `Get-WmiObject` fail with "not recognized". My first smoke run showed this and I removed it from those steps.

## Steps to repeat

1. Make a folder and point every home variable inside it (`HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `TEMP`, `TMP`).
2. The script (`measure.mjs`, in `<temp>/.../m0/tmp-c2/`) starts a synthetic listener: a child `node -e` that listens on `127.0.0.1` port 0 and prints the port, so its command line contains a marker string. It records the child's process id.
3. It checks each method finds that process id and a command line (all six did).
4. It runs the methods round-robin, 25 rounds, in three cases:
   1. Listener alive.
   2. Port with no listener (a port bound and released).
   3. Process already exited: it kills only its own child by the recorded id, waits for the exit event, then repeats the port lookup (3) and the command-line lookup by the dead process id (3b, method F only).
5. `node measure.mjs 25 out.json` with the environment from step 1. About 5 minutes.

Statistics: nearest-rank percentiles over 25 runs, so the p95 is the 24th-smallest value and the max is the slowest of 25. "First" is the first timed round of that case, after one untimed sanity call of each method in the same process, reported separately. All times are wall-clock milliseconds around `execFileSync`, process start to exit.

## Results (ms, n = 25 per cell)

### Case 1: listener alive (found process id and command line)

| Method | First | Median | p95 | Max |
|---|---|---|---|---|
| A netstat + CIM | 615.1 | 611.9 | 690.7 | 808.9 |
| B Get-NetTCPConnection + CIM (2 spawns) | 1963.3 | 1900.4 | 1963.3 | **2061.6** |
| C one PowerShell, both calls | 1460.6 | 1478.4 | 1614.6 | 1698.8 |
| D netstat + Get-WmiObject | 503.4 | 513.1 | 573.4 | 642.7 |
| E netstat only (no command line) | 26.0 | 24.2 | 28.2 | 38.4 |
| F command line only, known id | 555.0 | 585.5 | 663.2 | 706.8 |

All 25 runs of every method returned an id, and a command line where the method asks for one. A smoke run of 2 rounds on the same machine gave the same picture (A 574 ms, B 1848 ms, C 1511 ms, D 461 ms).

### Case 2: port has no listener

| Method | First | Median | p95 | Max | What it returned |
|---|---|---|---|---|---|
| A | 24.6 | 22.6 | 24.6 | 26.8 | nothing found (25 of 25) |
| B | 1370.3 | 1344.9 | 1458.8 | 1468.3 | PowerShell error, non-zero exit (25 of 25) |
| C | 1502.1 | 1353.5 | 1418.7 | 1502.1 | PowerShell error, non-zero exit (25 of 25) |
| D | 32.3 | 24.5 | 35.5 | 40.4 | nothing found (25 of 25) |
| E | 26.9 | 22.6 | 26.9 | 29.6 | nothing found (25 of 25) |

### Case 3: the process has already exited

Port lookup after the listener's process ended (its port no longer listens):

| Method | First | Median | p95 | Max | What it returned |
|---|---|---|---|---|---|
| A | 21.6 | 22.2 | 25.6 | 29.5 | nothing found (25 of 25) |
| B | 1344.8 | 1348.3 | 1484.1 | 1618.4 | PowerShell error, non-zero exit (25 of 25) |
| C | 1425.3 | 1370.6 | 1469.8 | 1514.1 | PowerShell error, non-zero exit (25 of 25) |
| D | 23.6 | 24.8 | 29.8 | 30.4 | nothing found (25 of 25) |
| E | 21.5 | 22.5 | 26.2 | 29.0 | nothing found (25 of 25) |

Command-line lookup for a process id that has exited (the address file names an id that is gone, and only the command line is asked for):

| Method | First | Median | p95 | Max | What it returned |
|---|---|---|---|---|---|
| F | 578.9 | 591.5 | 627.7 | 679.4 | exit 0, **empty output** (25 of 25) |

## What the numbers say

- Finding the listener with `netstat -ano` costs about 24 ms (max 38). The command line is the expensive part: every PowerShell start with a CIM or WMI query costs about 0.5 to 0.6 s.
- A and D (netstat, then PowerShell for the command line) fit: A's slowest of 25 was 0.81 s, D's 0.64 s. Both leave more than 1.1 s of the 2 s limit.
- B does not fit: its median is 1.9 s and one of 25 runs was 2.06 s. A 2 s timeout on B would refuse a real, healthy board part of the time.
- C is under 2 s on this machine (max 1.70 s) but with 0.3 s of room on a quiet moment, and it spends 1.3 to 1.5 s even when the answer is "nobody listens". The cost sits in loading the networking module, not in finding the answer.
- The "first" column shows no cold-start penalty. That is not a cold-start measurement: my smoke run a minute earlier had already loaded PowerShell and the CIM provider into the operating system's cache (see not run).
- Where A fails it fails fast: a port with no listener, or a listener that has exited, comes back "not found" in 22 to 30 ms with no PowerShell started. So the common refusal case costs almost nothing.

## Which method fits, and what it returns when it fails

**Method A fits** (median 0.61 s, p95 0.69 s, max 0.81 s). D is about 0.1 s faster but `Get-WmiObject` does not exist in PowerShell 7, so A is the safer choice for a spawn that names `powershell.exe` today and may change; the hook already pins the 5.1 path, so D also works. I would pick A.

What it returns, per case, and so what the hook must do:

| Case | A returns | Hook should |
|---|---|---|
| Listener found, command line names the board script | process id + command line | go on to the path check, then send |
| No listener on the port (or the listener already exited) | no matching row, 25 ms | print nothing: Claude Code's own prompt |
| Listener found, but its process id differs from the address file's | a different id | print nothing |
| Process id found, but command line empty (process exited between the two steps, or access denied for another account's process) | exit 0, empty output | **treat as a refusal**: empty is not a match. This is the case that looks like success if the code only checks the exit code |
| netstat or PowerShell fails, or the timeout fires | `execFileSync` throws | print nothing |

Set the budget on the lookup (for example 2 s for the whole lookup, both spawns together). Against A the worst observed is 0.81 s, so a timeout at 2 s would not have fired in 25 runs of A.

Inference, not measured: the existing discovery already spends part of `DISCOVERY_MS` (10 s, `scripts/claude-approval.mjs:27`) on whoami and PowerShell ACL checks; the new lookup adds to that and should have its own timer so it cannot eat the board's reply window.

## Not run, and why

- **Cold start** (first PowerShell after a reboot or long idle): not run; I cannot clear the operating system's cache without admin rights and without disturbing the machine. A real first-ever lookup may be slower than "first" above. Worth a note in the release gate, not a blocker given A's 1.2 s of room.
- **The real hook end to end** (`claude-approval.mjs` reading an address file and posting to a listener): not run. The task was the cost of the lookup alone, and the hook change is M4's work.
- **Linux and macOS**: out of scope for C2 (Windows). Not run.
- **`wmic`**: absent on this Windows build, so not measured.
- **PowerShell 7**: not installed here; no downloads allowed. Not run.
- **Other Windows locales**: this machine shows Chinese system messages, and netstat still printed `LISTENING`, so the parse worked here. A locale where netstat translates the state word is not tested. Inference: match the foreign address `0.0.0.0:0` instead of the word `LISTENING` to avoid depending on language.
- **Listeners on `::1` or `0.0.0.0`**: not run; the board's address file names `127.0.0.1` (`scripts/claude-approval.mjs:105`).
- **Heavy machine load, antivirus differences**: one run in normal use (38% CPU busy, 711 processes). Other machines can be slower; A has about 1.2 s of room.
- **A second full run**: one full run of 25 plus a 2-round smoke run. Not repeated.

## Verdict

**Pass, with method A.** A netstat lookup plus one PowerShell CIM query finds a port's listener and its command line in 0.61 s median, 0.81 s worst of 25, inside the 2 s limit, and a port with no listener or an exited process is refused in about 25 ms. `Get-NetTCPConnection` (B, C) is the slow choice: B went over 2 s once in 25 and C spends about 1.4 s even when nothing listens.

Effect on the plan:
- M4 stays as designed, and section 4's "the system's own table" can be named: `netstat -ano -p TCP` for the process id, `Get-CimInstance Win32_Process` for the command line.
- The "over budget, no decision" fallback stays as the failure rule, not the expected path.
- M4's tests should add one case the plan does not list: a process id that exists in the table but whose command line comes back empty is a refusal.
- Avoid `Get-NetTCPConnection` in the hook.
