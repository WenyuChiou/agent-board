# Codex without Claude Code

Node.js 18 or newer and a checkout of this repository initialize a local board without
Claude Code, its plugin, a login, or a transcript reader. Preview the exact paths first:

```sh
node scripts/setup-codex.mjs --lang en
```

After the user approves those persistent changes, apply the same plan:

```sh
node scripts/setup-codex.mjs --lang en --apply
```

This writes the standalone script and `install-codex.json` ownership record under `~/.agent-board/`, creates
an empty `progress.md` only if absent, installs the shared `$agent-board` skill, and adds
lifecycle handlers to `~/.codex/hooks.json` (or the existing `CODEX_HOME`). Unrelated hooks
are preserved. It does not change `CODEX_HOME`, `config.toml`, credentials, global AGENTS
instructions, shell profiles or startup services, and never trusts hooks. The shared
skill is also discoverable by other agents that read `~/.agents/skills`.

Use `--progress-file /absolute/path/progress.md` to keep an existing local board, including
one created by Claude Code. `CLAUDE_PROGRESS_FILE` is honored for compatibility. A fresh
Codex-only installation defaults to `~/.agent-board/progress.md`; `.claude` is not required.
`--data-dir`, `--home` and `--codex-dir` permit isolated tests; `--home` does not override
an explicitly configured `CODEX_HOME`. Installation is repeatable. Edited files are named
as conflicts and not overwritten. An exact old generated board skill at the standard path
can be upgraded. Invalid or unreadable JSON aborts setup. Bootstrap uses the committed
bundle and does not download executable code.

## Open and report

Invoke `$agent-board`. The skill opens the localhost interactive web board and, when asked
to track work, reports real steps after each change. On desktop a URL-opening tool can put
that web page in a panel. It is not a native Codex pane. In CLI another terminal can run:

```sh
node ~/.agent-board/agent-board.mjs --watch
```

The existing keyboard actions, web controls and clipboard actions are the same as the
standalone board. On Windows use the absolute path printed by setup. To report, the agent
passes minimal task summaries as JSON on stdin to:

```sh
node ~/.agent-board/agent-board.mjs --codex-report
```

```json
{"title":"Check the installer","project":"Agent-Board","state":"working","steps":["- [x] Read setup","- [~] Run tests"]}
```

`CODEX_THREAD_ID` binds to the current thread, never a name or a conversation file.
`--session` is for explicit offline fixtures, not for a skill to select another chat.
The block id is derived from the full thread id; its full ownership digest prevents a
short-id collision from overwriting another block. Only that block changes. Explicit
reports work in an existing desktop conversation. Skill discovery may need a new turn
or restart. Semantic steps are explicit reports made by the skill, not inferred by hooks.

## Automatic lifecycle status

Codex must review and trust the exact hook definitions before they run. CLI exposes
`/hooks`; use the desktop hook review UI when available. Never use a trust-bypass flag
to count acceptance. Restart or resume as required by that Codex version, and verify
actual hook execution independently on each surface.

`SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Stop`, `Interrupt` and `SessionEnd`
update activity directly without Claude summarizing an inbox. Turn-scoped events require
a turn id. Stale turns are rejected and recent repeated events are no-ops. Retired turn
ids and event keys are bounded to 128 and 256 per session. This protects lifecycle replay;
it is not an authenticated message-delivery channel.

A real resume/start and new prompt reactivate the same session's block. Changing reporters
or starting a follow-up task is not evidence that a session ended: never mark a legacy
block `ended` merely to avoid duplicate cards. Finish a completed task as `done`, and keep
unfinished work waiting. `ended` is reserved for observed session termination or an explicit
decision to stop that work permanently.

Hooks keep only selected metadata. They ignore `transcript_path`, prompts, tool inputs,
assistant messages and permission decisions, never read transcripts, and call no model.
A permission event marks waiting; no output approves a tool or merge. `Stop` marks activity waiting, never conversation termination or task completion. Detailed steps and completion still come from explicit reports.
Disconnected or untrusted hooks cannot update activity; existing stale-time rules apply.

When another program holds `progress.md` locked, a lifecycle hook keeps trying for about
two seconds, then saves the event's metadata under `pending/` in the data folder and exits 0.
The next hook run on that board applies pending events first. An explicit report still
fails and says it was not saved if the file stays locked.

This feature does not send replies to an active desktop thread. A file, mock or accepted
RPC is not proof of delivery. Test that separately with a disposable session and actual
ACK after the user confirms the binding.

## Inspect, repair and remove

```sh
node ~/.agent-board/agent-board.mjs --codex-doctor
node scripts/setup-codex.mjs
node scripts/setup-codex.mjs --apply
node ~/.agent-board/agent-board.mjs --codex-remove
node ~/.agent-board/agent-board.mjs --codex-remove --apply
```

Doctor checks generated file hashes and hook definitions, reporting hook trust as unknown.
Reinstall repairs missing generated files; edited files or hooks require review. Removal
takes only unchanged owned files and exact owned hook groups. It preserves progress,
session records, archives, journals and foreign hooks. Close a test board with its Close
button before removal. An interrupted write may leave a lock: inspect the owning process
before removing that specific lock, rather than deleting the data directory.

## Separate acceptance

Record the commit and Codex version for each surface:

| Test | Codex CLI | Codex desktop |
| --- | --- | --- |
| Clean install without Claude, idempotent reinstall | Required | Required |
| `$agent-board` opens the interactive page | Required | Required |
| Terminal `--watch` keyboard actions | Required | Not a desktop pane |
| Real reports: working, waiting, blocked step, done | Required | Required |
| Trusted hooks fire without manually running the reporter | Required | Required |
| Restart preserves thread ownership and other tasks | Required | Required |
| Edited skills and foreign hooks survive setup/removal | Required | Required |
| Actual ACK from a disposable session | Separate confirmed test | Separate confirmed test |

`node --test tests/codex-local.test.mjs` uses disposable fixtures. It does not prove either
Codex host executed hooks. A page with a real report proves report-to-UI connectivity,
not automatic lifecycle hooks or reverse delivery.

Official schema and trust rules: [Codex hooks](https://learn.chatgpt.com/docs/hooks).

Installation and hook trust are separate. Agent-assisted trust needs one explicit user
confirmation for six exact definitions, instead of asking the person to navigate a CLI:

```sh
node /path/to/installed/agent-board.mjs --codex-trust --codex-bin /absolute/path/to/codex
# After the person approves the displayed config.toml scope and six hashes:
node /path/to/installed/agent-board.mjs --codex-trust --codex-bin /absolute/path/to/codex --apply
```

Resolve the actual executable; do not guess a desktop binary location. Preview does not
write. Apply requires an intact owned installation, rediscovers the same definitions,
and uses `hooks/list` plus `config/batchWrite` to merge only their `hooks.state` trusted
hashes into the user config. It preserves unrelated settings, disabled state and comments,
then reads trust back. It starts no model thread, reads no transcript and never uses the
invocation-wide hook-trust bypass. A changed definition needs a new preview and consent.

This was tested against Codex 0.163.0-alpha.10.2 in an isolated child-process home, without
changing the real CODEX_HOME or credentials. The native test is opt-in via
`AGENT_BOARD_TEST_CODEX=/absolute/path/to/codex node --test tests/codex-local.test.mjs`.
If the host API does not support the operation, report that clearly and offer CLI `/hooks`
as the manual fallback. Do not invent a desktop review screen. When the host reports
`untrusted`, automatic progress remains disconnected. Trusted definitions still need a
real hook event to establish execution on each CLI/desktop surface.

## Cursor and OpenCode without a Codex or Claude session

The same bootstrap supports explicit targets, with the same preview/approval/apply flow:

```sh
node scripts/setup-agent.mjs --agent cursor
node scripts/setup-agent.mjs --agent cursor --apply
node scripts/setup-agent.mjs --agent opencode
node scripts/setup-agent.mjs --agent opencode --apply
```

Cursor uses `~/.cursor/hooks.json`, preserving unrelated flat hook entries. `sessionStart`
provides the host conversation id to the skill through session environment variables;
`beforeSubmitPrompt`, `stop`, `afterAgentResponse` and `sessionEnd` report lifecycle state.
Generation ids bind turns. Missing generation ids fail explicitly instead of silently
claiming equivalent support across Cursor IDE and CLI versions.

OpenCode installs `~/.config/opencode/plugins/agent-board-local.js` (plural `plugins`, as
the current official documentation specifies). Its event adapter reads session metadata
only, skips child sessions, and never calls `session.messages`. `session.status` has no
turn id, so its capability report explicitly lists that limitation. The plugin exposes
`agent_board_progress`; semantic reports bind to `context.sessionID`, not an id chosen by
the model. A minimal SDK stand-in tests the adapter, not OpenCode's actual plugin loader.

The script, board and skill are shared; each target has a separate ownership manifest.
Adding another target retains the selected board path. Removing one target retains shared
files while another installed target still needs them. Use `--agent cursor` or
`--agent opencode` with `--codex-doctor` / `--codex-remove`. The names of these maintenance
flags are retained for compatibility with the initial Codex entry. Never count another
agent's setup or synthetic fixture as live host verification.

Sources: [Cursor hooks](https://cursor.com/docs/hooks),
[OpenCode plugins](https://opencode.ai/docs/plugins/),
[OpenCode custom tool context](https://opencode.ai/docs/custom-tools/#context).

## Shared bootstrap for all listed agents

```sh
node scripts/setup-agent.mjs --agent all
node scripts/setup-agent.mjs --agent all --apply
```

The first command previews all nine targets before writing any integration file. After
approval, the second installs sequentially. `--agent auto` selects existing configuration
directories; this is discovery of candidates, not proof that a host binary is installed.
Explicit comma-separated targets are also accepted. This installs Agent Board integration
files, not the AI applications or their credentials. `--grok-dir` and `--hermes-dir` allow
isolating those targets without changing their environment variables.

All targets share one local progress file and the same report schema. A full session id is
namespaced by agent, so different agents do not overwrite one another. A bounded common
write lock preserves concurrent reports. Removing a target keeps shared files required by
another target. The generic explicit report command accepts `--agent <name>`; use only a
session id actually provided by that host, never a guessed name or a transcript scan.

| Target | Native adapter in this change | Remaining limit |
| --- | --- | --- |
| Codex | Lifecycle hooks, thread and turn metadata | Host trust and live CLI/desktop verification |
| Cursor | Lifecycle hooks, conversation and generation ids | IDE/CLI parity needs live checks |
| OpenCode | Session status plugin and bound task tool | Status events have no turn id |
| Legacy Gemini CLI | SessionStart, BeforeAgent, AfterAgent, SessionEnd | Separate enterprise/API compatibility; not Antigravity |
| Grok Build | SessionStart, Stop, SessionEnd | Coarse status; no working-turn event |
| Muse Code | Stop, SessionEnd | Coarse status; no working-turn event |
| Hermes Agent | Board and agent-specific skill installed | Native adapter pending |
| OpenClaw | Shared board and skill installed | Native adapter pending; no conversation grant added |
| Antigravity | Named native lifecycle hooks and board skill | No session-end event or turn fence; verify CLI/App/IDE separately |

Doctor distinguishes `installed`, `ready` and `connected`. Pending native adapters never
report ready; `connected` stays unverified until host execution is observed. Shared-file
tests are not evidence that every host discovered its adapter or accepted its hook schema.
This release is a common foundation; full multi-agent and desktop acceptance remains separate. See the [native CLI record](validation/2026-10-19-native-hooks.md).

Progress sharing is local file interoperability. It does not imply active-session messaging,
remote synchronization, a real dot connection, or tool/merge approval from ordinary replies.

The opt-in [connected-session messaging](MESSAGING.md) feature provides a separate web
card reply action and host-adapter API. Its live connection and ACK acceptance are independent
of this progress integration. No receiving target is inferred from an agent name or card.
