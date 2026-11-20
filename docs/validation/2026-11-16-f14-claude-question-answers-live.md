# Live check F14: can a `PreToolUse` hook answer Claude Code's question tool?

Part of #1321. Feeds "Answer or send: the controls for each kind of prompt".

## Question
F14: does a Claude Code `PreToolUse` hook that returns the answers for its question tool (`AskUserQuestion`) close the question in the terminal and the desktop app, and in what form are several choices and "Other" given?

## Host
- Windows 11 Home, Node 24.14.0.
- Claude Code v2.1.322, model Haiku 5.5, `--permission-mode default`, in the kept test home.
- Run by a Claude Code session (Claude Opus 5.5) for the PM session, 2026-11-16, 19:03 to 19:08 US Eastern (00:03 to 00:08 UTC on 11-17). Session ids and home paths are left out.

## Setup
- A new scratch project with the board's plugin turned off for that project (as in F13) and one hook: `"PreToolUse": [{"matcher": "AskUserQuestion", "hooks": [{"type": "command", "command": "node <scratch>/standin-ask.mjs <project>/log", "timeout": 60}]}]`. A second project had no hook, as the control.
- The stand-in hook waits 8 s (standing for the wait on a press), then prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"answered on the board (F14 stand-in)","updatedInput":{...tool_input, "answers": {...}}}}`. `answers` is keyed by each question's text. One choice: the label. Several choices: the labels joined with ", ". Other: the typed text. Case "none" prints nothing.
- Terminal: `claude --model haiku --permission-mode default "<prompt>"` in a terminal tab. Single prompt: "Use the AskUserQuestion tool once to ask me: 'Which color for the F14 test?' with the options Red, Green and Blue (one choice only). After the tool returns, reply with the tool result text verbatim and nothing else." The multi prompt asked two questions in one call, one with `multiSelect true`.
- Desktop app route: the desktop app could not be started from this session, so `sdk-route.mjs` drove `claude` exactly as the desktop app runs it, read from the app's own `claude` command lines: `claude -p --model haiku --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --permission-mode default --setting-sources user,project,local`, one user message on stdin, logging every `tool_use`, `control_request` and `tool_result`. It answers a `can_use_tool` control request itself (with "Red"), as the app's question card would. Run twice, the second time with every `CLAUDE*` and `ANTHROPIC*` variable of the calling session cleared; same result.

## What happened
| Case | Hook log | What the host showed |
|---|---|---|
| single, terminal | answered after 8.0 s: `{"Which color for the F14 test?":"Green"}` | during the wait: "✶ Booping… (running PreToolUse hook · 6s · ↓ 77 tokens)", no question on screen. Then "● User answered Claude's questions: ⎿ · Which color for the F14 test? → Green", and the model: "Green" |
| multi, terminal | `{"Which fruits for the F14 test?":"Apple, Cherry","Which size for the F14 test?":"Medium"}` | "· Which fruits for the F14 test? → Apple, Cherry · Which size for the F14 test? → Medium", model: "Apple, Cherry / Medium" |
| Other, terminal | `{"Which color for the F14 test?":"F14-OTHER typed on the board: purple"}` | "· Which color for the F14 test? → F14-OTHER typed on the board: purple", model: `The user answered: "Which color for the F14 test?"="F14-OTHER typed on the board: purple"` |
| none, terminal | "none no output" after 8 s | the question came up in the terminal as usual: "Which color for the F14 test? ❯ 1. Red 2. Green 3. Blue 4. Type something. 5. Chat about this" |
| desktop route, hook | answered after 8.0 s: Green | `tool_use AskUserQuestion`, then no `control_request` at all, then `tool_result: "Your questions have been answered: \"Which color for the F14 test?\"=\"Green\". ..."`, `result success permission_denials=[]` |
| desktop route, no hook (control) | (no hook) | `tool_use AskUserQuestion`, then `control_request can_use_tool tool=AskUserQuestion`, answered by the driver with Red, then `tool_result: "... \"Which color for the F14 test?\"=\"Red\". ..."` |

## Result
**PASS.** A `PreToolUse` hook on `AskUserQuestion` that returns `permissionDecision: "allow"` and `updatedInput` with an `answers` object closes the question:
- in the terminal, the question never shows; the transcript shows "User answered Claude's questions" with the hook's answers;
- on the desktop app's route, the app is never asked (no `can_use_tool` request), so its question card never opens.

Form: `answers` is an object keyed by the exact question text. One choice is the option label; several choices are the labels joined with ", " (`"Apple, Cherry"`); "Other" is the free text itself. A hook that prints nothing leaves the host's own question.

## Not shown
- The real desktop app window (its stdio route was driven with the app's own flags instead).
- During the hook's wait the terminal shows only "running PreToolUse hook" and no question, so the person at the terminal cannot answer there until the hook ends. Not timed past 8 s.
- A label that itself contains ", " with several choices (the joined form cannot tell it apart).

## What it means for the plan
- "Answer or send", one choice from options, Claude Code: confirmed. The board's hook should key `answers` by the question text, send the label for one choice, labels joined with ", " for several, and the typed text for Other.
- The wait is different from F13: while the board waits, the terminal shows no question at all. The 30 s limit and the "no open page returns at once" rule from D3 matter more here, because nothing else can answer during the wait. Suggest the same rule for the question hook: wait only while a page is open and has drawn the question, at most 30 s, then print nothing so the host's own question appears.
- No "Done when" changes.
