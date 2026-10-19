# Set up the local board from any agent

Use Node.js 18+ and a checkout of this repository. The same entry point previews every
applicable target before applying any change:

```sh
node scripts/setup-agent.mjs
node scripts/setup-agent.mjs --apply
```

Auto detection checks host-specific configuration paths, not conversations or credentials.
It reports candidates, not active sessions or account access. A `.gemini` directory alone
does not identify Gemini CLI: Antigravity uses that parent too. If the current host has
not created its configuration yet, select its known target with `--agent <name>`.
`--agent all` previews all supported targets; it does not install the AI applications.

Preview lists persistent files, hook definitions, conflicts and remaining capabilities.
Apply the reviewed scope under the user's authorization. Preserve unrelated settings and
edited files. A missing adapter remains `adapter-pending`; file installation is never
proof that the host loaded it. Native trust/enablement and reload requirements vary by
host, and CLI, App and IDE need separate execution checks.

Independent setup needs neither Claude Code nor another model. It creates one shared
`~/.agent-board/progress.md` on a fresh machine and retains an existing owned board path.
Use `--progress-file /absolute/path/progress.md` to select another existing local board.
Each target has an ownership manifest; shared files remain while another target needs
them. Only an agent's own proven native id may report its task steps.

The installed skill opens the interactive web board. Reopen with:

```sh
node ~/.agent-board/agent-board.mjs --serve
```

On Windows use the exact Node and script paths printed by setup. Closing a browser tab
leaves the local service running. Close the board stops it; `--idle-minutes 30` opts into
idle shutdown. No startup service is installed.

## Native status adapters

| Host | Installed adapter | Separate acceptance / remaining limit |
| --- | --- | --- |
| Codex | Six lifecycle hooks and explicit own-thread reporter | Scoped native trust and actual CLI/desktop events; [details](CODEX.md) |
| Cursor | Conversation/generation lifecycle hooks | Native CLI/IDE execution and turn binding |
| OpenCode | Session event plugin and context-bound progress tool | Plugin reload; status events lack a turn id |
| Antigravity | Four named native hooks plus shared skill | Native CLI/App/IDE events; no session-end event or turn fence |
| Grok Build | SessionStart, Stop, SessionEnd | Coarse status; no working-turn event integrated |
| Muse Code | Stop, SessionEnd | Coarse status and native execution unverified |
| Hermes Agent | Board and skill | Independent native hook adapter pending |
| OpenClaw | Board and skill | Independent native plugin pending; no conversation grant added |

## Antigravity native hooks

```sh
node scripts/setup-agent.mjs --agent antigravity
node scripts/setup-agent.mjs --agent antigravity --apply
```

Setup merges only the `agent-board-local` definition in `~/.gemini/config/hooks.json`.
The [official native schema](https://antigravity.google/docs/hooks) puts events under a
named definition, with command handlers directly under non-tool events. Edited or disabled
owned definitions become conflicts instead of being overwritten or silently enabled.
Removal preserves unrelated named definitions.

On Windows the generated command uses Windows PowerShell's encoded-command mode to
forward stdin to the exact Node executable and reporter paths. This avoids Antigravity's
`cmd /c` argument escaping failure for quoted paths such as `C:\Program Files\nodejs`.
No PowerShell profile or execution-policy setting is changed.

The reporter binds the native `conversationId`, ignoring transcript paths, prompts,
workspace paths, tool inputs and model text. Its own session record retains at most 16
event/state/timestamp observations. SessionStart and Stop mean waiting; PreInvocation
and PostInvocation mean working. PostInvocation may precede tools, so only Stop settles
the loop. Stop never marks the conversation ended; no undocumented SessionEnd is added.

The App, CLI and IDE share the global path but load it independently. Already-open
sessions may need reload. These hooks report activity; semantic task steps remain explicit
agent reports. No permission handler, transcript reader or remote-control tunnel is installed.

## Legacy Gemini CLI compatibility

Google's [consumer transition announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
ended free individual and Google AI Pro/Ultra Gemini CLI service on June 18, 2026. Supported
enterprise and paid API-key use remains separate. The explicit `--agent gemini` target is
retained for those hosts. It does not stand for Antigravity, and a binary starting does
not prove its account can run a model.

## Verify the result

Read settings back, observe a native event for the exact session, and read that session's
progress block. Check returning from idle updates the same block without saying the
conversation ended. If a relay lacks direct authorization, surface the blocker and wait
for an exact new report; see [connection observations](MESSAGING.md#connecting-a-session-that-was-already-open).
Progress, live receiving and an actual model ACK are separate checks. Supported transports,
surface-specific evidence and limits are listed in [messaging](MESSAGING.md).

See the [2026-10-19 native acceptance record](validation/2026-10-19-native-hooks.md)
for the observed CLI events, cross-host ACKs, the Windows failure and its retest.
