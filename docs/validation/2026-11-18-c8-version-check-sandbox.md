# C8: can the version check reach npm from inside Codex's sandbox? (F4 of #1321)

Date: 2026-11-18. Verdict: **partial.** The two sandbox modes that could be run reach npm. The elevated Windows sandbox and the Codex desktop app were not run.

## Question

Plan 0.25.1 asks (`docs/dev/plan-0.25.1.md:72`, main `a679f24f`): can the version check reach npm from inside Codex's sandbox and the Codex app? If not, the check runs only from the page server, and a sandboxed run shows the line and the command. The check is specified at `docs/dev/plan-0.25.1.md:95-103` (M3): one request a day for the `latest` number, never from a hook, a dead registry costs under 2 s. The open question is item F4 of issue #1321.

## Versions

- Codex CLI 0.167.0, model gpt-6.2-sol, reasoning effort low, one-line synthetic prompt per run.
- Node v24.14.0 (the script runs inside Codex's sandbox with this Node).
- Windows 11, build 10.0.26300.
- Package `@wenyuchiou/agent-board`: registry `latest` was 0.25.0 on 2026-11-18.
- Repository copy at `a679f24f`. It has no version-check code yet, so this check used a stand-in script, not the board's code.

## The script

`vcheck.mjs` (about 10 lines, synthetic). It sends one HTTPS GET to `registry.npmjs.org`, path `/@wenyuchiou%2fagent-board/latest` (public version metadata only), with a 2000 ms socket timeout and a hard stop at 2100 ms. It prints `status=<code> version=<x> elapsed_ms=<n>`, or `error code=... message=...` on failure. A second script, `wprobe.mjs`, tries to write one file in the working folder and prints `allowed` or `denied`; it proves that a sandbox was really applied.

## Steps (to repeat)

1. Make a scratch folder inside an isolated test home (every home variable pointing into it). A Codex sign-in was needed, so the kept test home from `docs/validation/PARITY-CHECKLIST.md` was used, in a new sub-folder of its scratch project. The runs added that sub-folder and Codex's session records for these runs. Only `config.toml` was compared before and after, and its hash did not change (first 16 hex digits `1d76e81efb08e3a5`). The checklist's rule against a writable sandbox in that home is about rows that use the skill; these runs used no skill and ran only the two scripts below.
2. Control, outside any sandbox: `node vcheck.mjs`.
3. For each mode: `codex exec --skip-git-repo-check -s <mode> -m gpt-6.2-sol -c model_reasoning_effort=low --json "Run exactly: node vcheck.mjs  Then reply with its output verbatim."`, with standard input closed.
4. The Windows sandbox kind is chosen with `-c windows.sandbox="unelevated"`. Step 5 explains why it had to be set.
5. Repeat step 3 with the sandbox kind left unset and with `elevated`.

## Results

| Run | Result |
|---|---|
| Control, no sandbox, run 1 | `status=200 version=0.25.0 elapsed_ms=293` |
| Control, no sandbox, run 2 | `status=200 version=0.25.0 elapsed_ms=263` |
| `-s read-only`, unelevated sandbox | `status=200 version=0.25.0 elapsed_ms=480` |
| `-s workspace-write`, unelevated sandbox (default network setting) | `status=200 version=0.25.0 elapsed_ms=491` |
| `-s workspace-write`, unelevated, `sandbox_workspace_write.network_access=false` set explicitly | `status=200 version=0.25.0 elapsed_ms=314` |
| `-s read-only`, unelevated, write probe | `write=denied code=EPERM` |

What this shows:

- Both sandbox modes reached npm and came back inside the 2 s limit (314 to 491 ms against 263 to 293 ms outside; one sample each, so the 21 to 228 ms gap is not a measured cost).
- The read-only sandbox was real: a read-only run refused a file write with EPERM. So "network allowed" is not the same as "no sandbox". The write probe was not run under `workspace-write`, so those runs have no proof that their sandbox applied.
- Even with network access set to false for workspace-write, the unelevated Windows sandbox did not block the request. Inference, not tested here: the unelevated sandbox does not enforce the network switch, while the elevated one (which sets network rules) may.
- **No blocked run was seen, so no blocked-request error could be recorded.**

Other things found on the way (these matter for any later real-Codex check in the kept home):

- With the sandbox kind unset, every shell command, even `echo hello`, was refused by Codex before it ran: `CreateProcess ... powershell.exe -Command '...' rejected: blocked by policy`. This is not a network error. The read-only and workspace-write runs gave the same refusal, and so did turning the board's hooks off and `approval_policy=never`. Setting `windows.sandbox="unelevated"` fixed it.
- With `windows.sandbox="elevated"`, the run failed with `orchestrator_helper_launch_canceled: ShellExecuteExW failed to launch setup helper: 1223`. Windows error 1223 is "the user cancelled the elevation prompt". That run was started by me and ended by my own 200 s timeout, so a Windows elevation prompt may have appeared on screen; it was not touched, and whether it showed is not known. I did not retry it.
- Processes: the Codex processes still running afterwards were all older than this check; none of mine remain.

## Not run, and why

- **The elevated Windows sandbox:** it needs a machine-wide setup step with a Windows administrator prompt, which this check may not press. Needs the owner's sitting.
- **The Codex desktop app**: cannot be driven here (no keys, clicks or desktop control allowed). Needs the owner's sitting: in the app, ask a session to run `node vcheck.mjs` once under each approval and sandbox choice the app offers, and record the printed line or the error.
- Linux and macOS sandboxes: not available on this computer.
- A blocked-request run: nothing blocked, so the exact error is not recorded.
- The board's real version-check code: does not exist at `a679f24f`.
- Saved output of the sandboxed runs: the values above are what the runs printed, and the raw output was not kept.

## Verdict and effect on the plan

- **Partial.** For `codex exec` on Windows with the unelevated sandbox, in both modes, the version request works. That does not trigger the plan's fallback ("the check runs only from the page server").
- Not shown for the elevated sandbox or the app, which are the two cases most likely to differ. M3 as written has no page-server limit and expects the request to work from Codex CLI in its sandbox (plan lines 96 to 103). The fallback in the C8 row, where the check runs only from the page server, stays undecided until the elevated sandbox and the app are run in sitting 1. That choice is the owner's.
- The M3 "Done when" test (a dead registry costs under 2 s, started from Codex CLI) can run in the unelevated sandbox. In the home used here, a Codex run with no `windows.sandbox` was refused before it started, so a test started from a Codex run in that home must set it.
