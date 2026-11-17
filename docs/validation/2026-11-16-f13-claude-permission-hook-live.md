# Live check F13: can Claude Code's `PermissionRequest` hook wait for a press and answer?

Part of #1321. Feeds D3 (Approvals on the board).

## Question
F13: does Claude Code's `PermissionRequest` hook let the board's hook wait for the press and return allow or deny, and what does the terminal show while it waits? And Antigravity, if it has such a hook.

## Host
- Windows 11 Home, Node 24.14.0.
- Claude Code v2.1.322 (its banner), model Haiku 5.5, `--permission-mode default`, in the kept test home.
- Antigravity CLI `agy` 1.5.9 (`agy --version`), files read only, no model turn.
- Run by a Claude Code session (Claude Opus 5.5) for the PM session, 2026-11-16, 18:14 to 19:09 US Eastern (23:14 to 00:09 UTC). Session ids, transcript paths and home paths are left out.

## Setup
- A new scratch project in the kept test home. Its `.claude/settings.json` turned the board's plugin off for that project (`"enabledPlugins": {"agent-board@agent-board": false}`), so the live board of another session in the same home was not touched, and added one `PermissionRequest` hook: `node <scratch>/standin-perm.mjs <project>/log`, `"timeout": 60`.
- The stand-in hook stands for the board's hook. It reads the event from stdin, saves it, waits up to a set time for a "press" file, prints that file's JSON as its answer, or prints nothing when the wait ends. A press was made by writing the file from outside the session.
- A second project had the same hook with `"timeout": 8` and a 30 s wait, to see what a hook killed by Claude Code's own limit does.
- Each case: `claude --model haiku --permission-mode default "Use the Bash tool to run exactly this command and nothing else, then reply DONE: echo f13-<case> > f13-<case>.txt"`, interactive in a terminal tab. Cases e1 to e4 used `claude -p` with the same prompt, the last two with every `CLAUDE*` and `ANTHROPIC*` variable of the calling session cleared.

## What happened
The event the hook got (ids and paths replaced): `hook_event_name "PermissionRequest"`, `tool_name "Bash"`, `tool_input {"command":"echo f13-a > f13-a.txt","description":"Write f13-a marker text to f13-a.txt"}`, `permission_mode "default"`, `permission_suggestions [{"type":"addDirectories",...,"destination":"session"}]`, plus `session_id`, `transcript_path`, `cwd`, `prompt_id`. No request id: the hook call itself is the request.

| Case | Hook did | Terminal showed | Result |
|---|---|---|---|
| a, allow | waited 15.1 s, then printed `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` | during the wait, Claude Code's own prompt: "Bash command ... echo f13-a > f13-a.txt ... Do you want to proceed? ❯ 1. Yes 2. Yes, and always allow access to ... from this project 3. Yes, and switch to auto mode 4. No". After the press: "● Bash(echo f13-a > f13-a.txt) ⎿ (No output) ⎿ Allowed by PermissionRequest hook", then "● DONE" | file written |
| b, deny with a message | waited 9.5 s, then printed `"decision":{"behavior":"deny","message":"F13-DENY-REASON: the person pressed Deny on the board (synthetic check)."}` | "● Bash(echo f13-b > f13-b.txt) ⎿ Error: F13-DENY-REASON: the person pressed Deny on the board (synthetic check). ⎿ Denied by PermissionRequest hook", and the model: "The command was not run. The Bash call was denied: the result said the person pressed Deny on the permission board. I haven't retried it" | no file; the message reached the model |
| c, no press | waited 15 s, printed nothing, exited 0 | the same prompt as in a, still waiting after the hook ended | the host's own prompt holds |
| d, hook killed at its 8 s limit | log has "d hook start (wait 30000 ms)" and no end line | the same prompt, still waiting | the host's own prompt holds |
| e1 and e3, `-p`, no press | 5 s wait, nothing printed | `-p` printed "I couldn't run the command. The Bash call was blocked because creating `f13-e1.txt` ... needs your approval, and this session can't show that prompt." | refused, no file |
| e2 and e4, `-p`, allow | answered after 2.3 s and 3.7 s | "DONE" | file written |

After all cases the project's `.claude` folder held only the `settings.json` written for the test: no `settings.local.json`, so neither an allow nor a deny added a standing rule.

Antigravity: `agy` 1.5.9 has no `PermissionRequest` hook. The test home's `hooks.json` holds `SessionStart`, `PreInvocation`, `PostInvocation` and `Stop` for the board; the hook event names found in the program are `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `SessionStart`, `Stop` and `Notification`. Its changelog names `auto_approve` as a `PreToolUse` answer ("Fixed a `PreToolUse` hook returning `auto_approve`, or a wildcard `command(*)` allow rule, bypassing an organization's admin-enforced review") and says the default Agent Mode is now Auto, "including headless `-p` runs".

## Result
**PASS for Claude Code.** A `PermissionRequest` hook can wait (15 s shown) and answer allow, or deny with a message the model reads. While it waits, the terminal shows Claude Code's own prompt. No answer, or a hook killed by its limit, leaves that prompt. In `-p`, no answer means refused. No standing rule is added.

**Antigravity: no `PermissionRequest` hook.** Its route is `PreToolUse` with `auto_approve` or `deny`, which is F16 and not run here.

## Not shown
- The desktop app with a `PermissionRequest` hook (only the terminal and `-p` were run). F14 drove the desktop app's stdio route for questions only.
- A person answering the terminal prompt while the hook still waits: which answer wins, and whether the hook is stopped.
- The board's own hook (`scripts/claude-approval.mjs`) with a real page: this run used a stand-in hook so as not to touch another session's board in the same home. F10 has a run of the real hook against a stand-in board.
- Antigravity live (F16).

## What it means for the plan
- D3's Claude Code line holds as written: the hook can wait for the press and answer allow or deny, deny can carry the "Deny and say why" text, and nothing standing is added.
- The "30 s fallback to the host's own prompt" needs no extra work in the terminal: the prompt is already on screen during the wait, and it stays when the hook gives no answer or is killed. The row should still say "asked in its window" after the fallback, since the person may answer there at any time.
- D3's `-p` line is confirmed: with `-p`, a call no hook decides is refused.
- No "Done when" changes.
