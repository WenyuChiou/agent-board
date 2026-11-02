# Set up the local board from any agent

Use Node.js 18+ and a checkout of this repository, or the npm package (Node.js 22+,
[below](#install-with-npm)). The same entry point previews every
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

Setup prints a short summary in the board's language (`--lang en`, `zh-TW` or `zh-CN`):
one line per agent, followed by numbered next steps. The lines say what would change,
what changed, what is already set up, or which conflicting files caused an agent to be
skipped. With `--apply`, agents without conflicts are still set up; a skipped agent's
line gives the `--agent <name>` command to retry after fixing its files. Setup exits
nonzero when every selected agent has a conflict. A second run with nothing to change
says each agent is already set up and writes nothing.

Whenever Claude Code's config folder exists (`CLAUDE_CONFIG_DIR`, else `~/.claude`),
the next steps include both `claude plugin` commands to connect it, even alongside other
agents. If only Claude Code is found, setup prints its plugin guidance and exits 0.

Add `--json` for the existing machine-readable output, with the same `targets`, `plans`
and `applied` fields. An apply run that skips an agent for a conflict but sets up another
still reports `applied: true`, so scripts should check `plans[].conflicts`. Claude-only
detection keeps empty `targets` and `plans` and
`applied` false. Other setup errors give one sentence with a next step; `--json` prints
them as one JSON line on stderr, `{"error":{"code":"...","message":"..."}}`, with
codes `INVALID_TARGETS`, `MISSING_ARGUMENT`, `SETUP_FAILED` (with the failing `agent`
and its `cause`) or `UNKNOWN`. Conflicts stay in `plans` on stdout with no JSON stderr
line. A leading UTF-8 byte-order mark in a JSON host config is read; setup writes that
file back without it, and refuses malformed JSON whether or not it starts with one.

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

To run the normal archive sweep without a Claude session:

```sh
node ~/.agent-board/agent-board.mjs --tidy
```

Use the exact installed Node and script paths for a scheduler, including on Windows.
The flag performs one sweep and exits; it installs no schedule or service and opens no
page. Choosing this command authorizes the normal sweep: done agent blocks older than
12 hours and stopped blocks older than 3 days move to the monthly archive beside the
selected progress file. Unanswered questions, incomplete blocks and missing/future
timestamps stay. Completed hand-kept tasks use a three-day threshold; in 0.24.1 scheduled
`--tidy` only counts them and moves none. The details line shows how many can be archived.
If `--tidy` moves nothing else and counts due tasks, it prints that count.
This is an observation, not the exact completion time.
The pane, `--watch` or `--serve` must first observe the completed task and save its fingerprint
in `progress-seen.json`. A machine that runs only scheduled `--tidy` never records that
observation or the reserved entry recording the first run of the three-day rule, so it
counts nothing without that entry. The three days start at the later of the task's first
observation and that first run, giving work seen done under 0.24.0 three days from the upgrade. The command
does not create or update the observation file. Unknown, future or unreadable observations
keep manual tasks; an unreadable observation file stays untouched and does not prevent
eligible agent blocks from being archived.
Archive entries are saved before removing work from the board, and repeated runs do
not duplicate them. A failed persistence operation exits nonzero; retain the files and
retry after fixing its reported problem. `--chat` remains read-only even with `--tidy`.
`--tidy` takes precedence over `--serve`, `--watch` and `--html`, so those combinations
run only the sweep. A running `--serve` page also sweeps every hour; if the seen file cannot
be read, that hourly pass writes nothing. A person's Clean up on the pane or page archives
finished hand-kept tasks whose three days are up, exactly the ones the count line counts,
plus what the normal sweep moves. It writes to the same monthly archive before the board.
If the seen file cannot be read, Clean up archives nothing, writes nothing and says why.
Unattended sweeps (pane start and hourly, `--tidy`, and page hourly) only count hand-kept
tasks in 0.24.1 and move none. The size warning is one sentence with one Clean up button;
the button also shows whenever the count is above zero, even without a size warning.
Numbers and the count sit in the details line. The pane's Archive now and `/progress tidy`,
the page's Archive now, and a row's Archive still move finished work immediately.
Archive moves save work in monthly files, never delete it.

If a lifecycle hook cannot write the selected board, its metadata enters a local
pending queue. The installed worker starts one bounded recovery job for that board,
with at most three passes within eight seconds including launch delay. It preserves
the original event time and drops events superseded by newer session activity.
This recovery never sends messages or replays uncertain deliveries. A persistent
lock or an unavailable reporter leaves the metadata and records
`HOOK_RECOVERY_NEEDED` in the local hook diagnostics. After resolving the reported
problem, run an explicit pass with the exact installed Node and script paths:

```sh
node ~/.agent-board/agent-board.mjs --recover-hooks
```

The JSON result names the processed and remaining metadata counts for the selected
progress file. This command reads no stdin, starts no model, and changes no hook
trust. It can be used even when no further agent prompt is expected.

For maintenance, the installed program retains the compatibility flags
`--codex-doctor --agent <name>` and `--codex-remove --agent <name>`; removal previews
before `--apply`. Close that board first. Progress/history/session records remain, and
shared files stay while another installed target needs them. Do not use the legacy
Claude setup scripts as a prerequisite for this installer.

The optional Claude pane's `/progress connect` also resolves OpenCode's configuration
from `OPENCODE_CONFIG_DIR`, then `XDG_CONFIG_HOME/opencode`, then `~/.config/opencode`.
Detection, plugin, board command and owned instruction cleanup use that same root;
stale default directories are left alone. Its status records configuration, not a native ACK.
Generated board commands preserve literal paths with spaces or shell metacharacters on
Windows and POSIX. Updating them still preserves personal edits and unrelated files.

The optional connector requires Node.js 18+ for its native worker; setup and
removal fail closed without it. Ownership, disable intent, last setup status and
the remembered Codex approval live in `~/.agent-board/legacy-connect.json`,
shared across Claude data roots and protected by the independent installer's
home-level lock. Reload older plugin sessions before migration: writers that
ignore the lock are not coordinated.
Automatic probes run after pane/polling startup and outside the mutation lock,
and only for the default Claude data folder (`CLAUDE_CONFIG_DIR` unset or `~/.claude`) with the
default progress file or the one last connected by hand; any other session
connects only when you run `/progress connect` in it.
Removal records disable intent before cleanup, fencing delayed automatic setup.
Damaged authority or recovery records are retained and reported rather than reset.
Status may initialize recognized legacy display metadata; it does not change host
configuration or prove native execution.

## Install with npm

From 0.24.0, the same installer is on npm as `@wenyuchiou/agent-board`. With Node.js 22+ (what the
package's `engines` field asks for) and no checkout:

```sh
npx @wenyuchiou/agent-board setup
npx @wenyuchiou/agent-board setup --apply
npx @wenyuchiou/agent-board --serve
```

`npx @wenyuchiou/agent-board setup` runs this same `setup-agent.mjs` from the package and takes the
same options (`--agent`, `--home`, `--data-dir`, `--progress-file`). It writes the same
files: the board script lands at `~/.agent-board/agent-board.mjs`, and no hook points into
npm's cache, so clearing that cache breaks nothing. `npm install -g @wenyuchiou/agent-board` gives a
lasting `agent-board` command in place of `npx`.

Every other call (`--serve`, `--watch`, `--chat`, `--html`, or none to print the board)
runs the board script setup installed: the one beside `$CLAUDE_PROGRESS_FILE`, else
`~/.agent-board/agent-board.mjs`, else the Claude Code plugin's beside
`~/.claude/progress.md`. It never runs a second copy from the package, which would restart
the page the installed copy serves. When the installed copy comes from another release,
`agent-board` says so on stderr and names the command that updates it. For an independent
install, that is a setup preview for the same agents and data folder; add `--apply` to update
it, which still leaves files you edited alone. For the Claude Code plugin's copy, it is
updating the plugin, then `/progress connect`. Installing runs nothing: the package has no
dependencies and no install scripts. Pre-releases are on the `next` tag
(`npx @wenyuchiou/agent-board@next setup`); what makes a release stable is in [RELEASING.md](RELEASING.md).

## Native status adapters

| Host | Installed adapter | Separate acceptance / remaining limit |
| --- | --- | --- |
| Codex | Six lifecycle hooks and explicit own-thread reporter | Scoped native trust and actual CLI/desktop events; [details](CODEX.md) |
| Cursor | Conversation/generation lifecycle hooks | Native CLI/IDE execution and turn binding |
| OpenCode | Session event plugin and context-bound progress tool | Plugin reload; status events lack a turn id |
| Antigravity | Four named native hooks plus shared skill | Native CLI/App/IDE events; no session-end event or turn fence |
| Grok Build | SessionStart, UserPromptSubmit, Stop, SessionEnd | Prompt/idle/end status; native execution unverified |
| Muse Code | Stop, SessionEnd | Coarse status and native execution unverified |
| Hermes Agent | Board and skill | Independent native hook adapter pending |
| OpenClaw | Independent metadata plugin and native skill | Native host execution unverified; requires sanitized lifecycle subscription API |
| DeepSeek Harness | Native Cordis lifecycle plugin and skill | Loader/event contract checked; full CLI/Web/Desktop execution unverified |

## Portable host paths and lifecycle

Select one target or a comma-separated list, such as `--agent opencode,openclaw,grok,deepseek`.
They share the selected progress file. Each target's preview still lists its own persistent
changes; no receiving connection or model call is added by setup.

| Target | Native configuration | Override |
| --- | --- | --- |
| OpenCode | `~/.config/opencode/plugins/agent-board-local.js` and `commands/board.md` | `--opencode-dir`, then `OPENCODE_CONFIG_DIR`, then `XDG_CONFIG_HOME/opencode` |
| OpenClaw | `~/.openclaw/openclaw.json`, `skills/agent-board/` and a private local plugin with its manifest | `--openclaw-dir`, then `OPENCLAW_STATE_DIR` |
| DeepSeek Harness | `~/.dsh/cordis.patch.yml`, `skills/agent-board/` and a private Cordis plugin | `--deepseek-dir`, then `DSH_HOME` |
| Grok Build | `~/.grok/hooks/agent-board-local.json` | `--grok-dir`, then `GROK_HOME` |

OpenClaw receives `session_start`, `session_end` and sanitized lifecycle start/end/error
events. Only the native session/run ids and state are reported; stale runs cannot replace
the current one. It explicitly denies conversation access. Hosts lacking the subscription
API fail visibly rather than falling back to transcript access. Reload the plugin in each
host; installation cannot enumerate every previously open session.

DeepSeek uses `agent/created`, `agent/status` (running/idle) and `agent/disposed`, retaining
its own agent identity. Its owned entry is appended to a plain root YAML patch sequence;
complex/edited YAML is a conflict requiring review. Existing entries remain untouched.
A JSON config that is not a JSON object, or holds a number JSON cannot keep exactly (such as
an id past 2^53), is a conflict too, and is left untouched.
Native skill roots are used as well as the shared skill. Restart profiles without
configuration HMR. No credential, telemetry or provider setting is changed.

OpenCode's metadata lookup must return the exact session before it reports; missing or
foreign responses are ignored. Changing an installed host directory requires removing
the old scoped installation first, so an orphan plugin cannot continue reporting.
OpenCode sends no session end for a one-shot `opencode run`, so as OpenCode exits the
plugin ends the top-level sessions it reported that had finished their reply, within 2 s
plus the worker's 500 ms grace.
A session still replying is left as it is and goes stale by age. Quitting OpenCode ends
its rows too; a resumed session reopens its row. New OpenCode blocks are filed under the
folder the session ran in. The progress tool takes each step as one Markdown task line
(`- [~] Current step`); a refused report names the board's reason, such as `INVALID_STEP`.

All these hooks report activity only. Semantic steps need a host-proven own-session
report; only OpenCode's generated tool supplies that context directly. This setup does
not make the other hosts' incoming message transports available. See the
[portable acceptance record](validation/2026-10-19-portable-hosts.md).

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

The Claude plugin's `/progress connect` writes the same four commands under its own
`agent-board` definition, next to the board skill, and runs them through `progress-hook.mjs`
beside its progress file. Where this installer's `agent-board-local` definition is there,
the connect writes none and takes out one it wrote before. When this installer runs after
the connect, both definitions report until the connect next runs (the next Claude Code
session, or `/progress connect`). This installer takes over the skill file the connect
wrote, and the connect then leaves this installer's skill as it is. While a host has the
skill but neither definition,
`--codex-doctor --agent antigravity` says `skill only, no report hook`.

On Windows the generated command starts the exact Node executable directly
(`node.exe --input-type=commonjs -e ...`), with the reporter paths carried inside it, so
no PowerShell start sits in front of Node. Setup binds an absolute path that
needs no quotes, using the Windows short (8.3) name of a path with spaces such as
`C:\Program Files\nodejs` only after its file identity matches the running Node. Antigravity's
`cmd /c` argument escaping cannot keep the quotes a spaced path needs, and a bare `node`
would let `PATH` or the event's working directory choose another program. When setup cannot
verify such a path (the volume has no short names, say), the command uses Windows
PowerShell's encoded-command mode, which forwards stdin to the exact Node and reporter paths
but puts a PowerShell start in front of Node; running setup again rewrites it as a direct
command once one is possible.
Codex's commands carry no wrapper from this installer. No PowerShell profile or
execution-policy setting is changed.

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

Local reports use the same Markdown scanner as the board. Fenced examples stay unchanged;
an unfinished code fence/comment or incomplete owned block is refused before either the
board or session record changes. Close the Markdown construct or restore the exact owned
block, then retry. A successful write must produce one visible task for that session.

See the [2026-10-19 native acceptance record](validation/2026-10-19-native-hooks.md)
for the observed CLI events, cross-host ACKs, the Windows failure and its retest.

Codex hook installation is separate from current native approval. The optional connector retains managed reporting fallback until its exact current definitions are approved in /hooks, using bounded read-only control discovery outside the install lock. An approval Codex confirmed is remembered with the hooks.json it was given for and the sha of Codex's config.toml at that time. A check that cannot get an answer from Codex keeps that approval while both files are unchanged; any change counts, including untrusting or disabling hooks in /hooks, which rewrites config.toml. The approval also names the Codex executable found when it was remembered (real path, size, modification time); when Codex cannot be asked and a different or unreadable executable is found, as after a Codex upgrade, the approval is not confirmed, and with no executable found it holds. An answer in a shape this release does not know (a new hash format, no enabled flag) counts as no answer, unless it calls one of the hooks anything but trusted, which is a no. A Codex answer that the definitions are unapproved, disabled or not listed, or a check that cannot get an answer from Codex after either file changed, retains or restores fallback on connect. Status projects current readiness without modifying AGENTS. Existing nonempty AGENTS.override.md is treated as the effective instruction file. Only positively owned board scripts can become generated fallback commands.
