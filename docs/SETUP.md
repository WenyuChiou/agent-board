# Set up the local board from any agent

Use Node.js 18+ and a checkout of this repository, or the npm package (Node.js 22+,
[below](#install-with-npm)). The same entry point previews every
applicable target before applying any change:

```sh
node scripts/setup-agent.mjs
node scripts/setup-agent.mjs --apply
```

Auto detection checks five signs: host-specific configuration paths, an earlier setup's
install record in the data folder (`--data-dir`, else `~/.agent-board`), Grok Build's own
`~/.grok/bin` program, commands on the PATH, and installed apps. On Windows a command counts
as `.exe`, `.cmd`, `.bat`, `.com` or `.ps1`. With `--home`, it checks only the first three,
since commands and apps belong to the account running setup. It does not read
conversations or credentials. A found command or app is a candidate, not an active
session or account access. Run setup without `--apply` first: its preview lists each file;
a bare `--apply` writes to the same agents and prints only how many files changed.
Gemini CLI is retired and setup never lists it. Gemini CLI and Antigravity share the
`.gemini` directory; setup finds Antigravity by its own folders in it (`antigravity-cli`,
`antigravity`, `antigravity-ide`), by `agy` or `antigravity` on the PATH, or by its app, and an
install an earlier release wrote for Gemini CLI can still be removed. Finding nothing exits 0 without writing anything and names the next command to
run. You can also select a known target with `--agent <name>`.
`--agent all` previews all supported targets; it does not install the AI applications.

Setup prints a short summary in the board's language (`--lang en`, `zh-TW` or `zh-CN`):
one line per agent, in a preview with the files it would change under that line, followed by numbered next steps. The lines say what would change,
what changed, what is already set up, or which conflicting files caused an agent to be
skipped. With `--apply`, agents without conflicts are still set up; a skipped agent's
line gives the `--agent <name>` command to retry after fixing its files. Setup exits
nonzero when every selected agent has a conflict. A second run with nothing to change
says each agent is already set up and writes nothing.

When several selected agents share files, apply also counts the files an earlier agent
already updated as already current. The next steps name each host's actual action:
start a new session for hooks already configured, or restart the named host to load its
generated plugin. Installing the files does not verify a live host connection.

Without `--lang`, setup uses `LANG`, then the system language, else English, and writes that language into the files it installs.

Whenever Claude Code's config folder exists (`CLAUDE_CONFIG_DIR`, else `~/.claude`), or
`claude` is on the PATH and `--home` was not given,
the next steps include both `claude plugin` commands to connect it, even alongside other
agents. If only Claude Code is found, setup prints its plugin guidance and exits 0.

Add `--json` for the existing machine-readable output, with the same `targets`, `plans`
and `applied` fields. An apply run that skips an agent for a conflict but sets up another
still reports `applied: true`, so scripts should check `plans[].conflicts`. Claude-only
detection, and finding no agent, keep empty `targets` and `plans` and
`applied` false, with exit 0. Other setup errors give one sentence with a next step; `--json` prints
them as one JSON line on stderr, `{"error":{"code":"...","message":"..."}}`, with
codes `INVALID_TARGETS`, `MISSING_ARGUMENT`, `INVALID_CONNECT_RECORD`, `SETUP_FAILED`
(with the failing `agent` and its `cause`) or `UNKNOWN` (with the system error's `cause` when there is one, or a `reason` in words when there is none). Conflicts stay in `plans` on stdout with no JSON stderr
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
Folder-based reports keep the existing path digest and, when the directory can be
resolved, an additional canonical-path digest. This lets a hook's directory alias and
the report subprocess's directory identify the same owner without storing either path.
Old records still match their exact path digest; an old alias-only record needs a fresh
hook before a different spelling can match. Missing or unreadable directories do not
gain alias matching, and ambiguous, stale, ended or background-run owners remain refused.
With an active Claude Code plugin connector, setup keeps its selected board and leaves
agents it already manages to that connector, without adding another hook or board script.

The installed skill opens the interactive web board. Reopen with:

```sh
node "$HOME/.agent-board/agent-board.mjs"
```

On Windows use the exact Node and script paths printed by setup. Closing a browser tab
leaves the local service running. Close the board (the red power button) stops it;
`--idle-minutes 30` opts into idle shutdown. No startup service is installed.

To run the normal archive sweep without a Claude session:

```sh
node "$HOME/.agent-board/agent-board.mjs" --tidy
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
The pane, `--watch` or the page must first observe the completed task and save its fingerprint
in `progress-seen.json`. A machine that runs only scheduled `--tidy` never records that
observation or the reserved entry recording the first run of the three-day rule, so it
counts nothing without that entry. The three days start at the later of the task's first
observation and that first run, giving work seen done under 0.24.0 three days from the upgrade. The command
does not create or update the observation file. Unknown, future or unreadable observations
keep manual tasks; an unreadable observation file stays untouched and does not prevent
eligible agent blocks from being archived.
Archive entries are saved before removing work from the board, and repeated runs do
not duplicate them. A failed persistence operation exits nonzero; retain the files and
retry after fixing its reported problem. `--json` remains read-only even with `--tidy`.
`--tidy` takes precedence over `--serve` (the old spelling), `--watch` and `--html`, so those combinations
run only the sweep. A running page also sweeps every hour; if the seen file cannot
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
node "$HOME/.agent-board/agent-board.mjs" --recover-hooks
```

The JSON result names the processed and remaining metadata counts for the selected
progress file. This command reads no stdin, starts no model, and changes no hook
trust. It can be used even when no further agent prompt is expected.

For maintenance, the installed program retains the compatibility flags
`--codex-doctor --agent <name>` and `--codex-remove --agent <name>`; removal previews
before `--apply`. Both print plain lines; add `--json` for the full result. Close that board first. Progress/history/session records remain, and
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
npx @wenyuchiou/agent-board
```

`npx @wenyuchiou/agent-board setup` runs this same `setup-agent.mjs` from the package and takes the
same options (`--agent`, `--home`, `--data-dir`, `--progress-file`). It writes the same
files: the board script lands at `~/.agent-board/agent-board.mjs`, and no hook points into
npm's cache, so clearing that cache breaks nothing. `npm install -g @wenyuchiou/agent-board` gives a
lasting `agent-board` command in place of `npx`.

In a terminal, setup prints its preview and, when there is something to set up, asks once: `Set these up? [Y/n]` (`要設定這些嗎？[Y/n]` on a Traditional Chinese system, `要设置这些吗？[Y/n]` on a Simplified Chinese one; Enter means yes). A yes writes the files, approves the board's hooks in Codex and Hermes Agent for the agents it set up, and, when `claude` is on the PATH and the plugin is not installed, runs `claude plugin marketplace add WenyuChiou/agent-board` (left out when Claude Code already knows that marketplace) and `claude plugin install agent-board@agent-board`. Each part prints done, or failed with the command to run by hand, and a failed part does not stop the others. A no writes nothing. Without a terminal (piped input, `--json`, an agent's shell tool that is not a terminal) setup only previews. `setup --apply` writes the files only, in a terminal too, and lists the approval and plugin commands: only a yes typed at the question approves hooks or installs the plugin. On a first plain `agent-board` run with nothing set up, the launcher hands over to the same question and opens the board after a yes. OpenCode and Gemini CLI use `/agent-board`; setup removes an unchanged old `/board` file and keeps one you edited.

A plain `agent-board` call opens the interactive local page on a desktop, from an agent or
in a non-interactive call. An interactive terminal over SSH or without a display opens the
terminal board; CI prints text. `--html` and the old spelling `--serve` start or reuse the local service and
open the page (`--serve` prints only the address, with no text board); `--lan` opens it and shows the phone address; `--watch` selects the terminal board, `--print` prints text, and `--json`
returns the board for agents.

Without `--lang` or a language it saved, the board follows the system language when it is Traditional or Simplified Chinese, and English otherwise; `--lang en`, `--lang zh-TW` or `--lang zh-CN` on the board command (as on `setup`) chooses. `--html --no-open` starts the page without opening a browser window (`--no-open` alone does not: in an interactive terminal over SSH or without a display it still gives the terminal board).

These board calls run the board script setup installed: the one beside `$CLAUDE_PROGRESS_FILE`, else
the board the Claude Code plugin's connector last connected, else
`~/.agent-board/agent-board.mjs`, else the Claude Code plugin's beside
`~/.claude/progress.md`. It never runs a second copy from the package, which would restart
the page the installed copy serves. When the installed copy comes from another release,
`agent-board` says so on stderr and names the command that updates it. For an independent
install, that is a setup preview for the same agents and data folder; add `--apply` to update
it, which still leaves files you edited alone. For the Claude Code plugin's copy, it is
updating the plugin, then `/progress connect`. Installing runs nothing: the package has no
dependencies and no install scripts. Pre-releases are on the `next` tag
(`npx @wenyuchiou/agent-board@next setup`); what makes a release stable is in [RELEASING.md](RELEASING.md).

## Install from a clone

Without npm, from a clone of this repository, with Node.js 22 or later:

```sh
git clone https://github.com/WenyuChiou/agent-board.git
cd agent-board
node scripts/setup-agent.mjs
```

In a terminal, `setup-agent.mjs` shows what it would change and,
when there is something to set up, asks once (`Set these up? [Y/n]`, or `要設定這些嗎？[Y/n]` and `要设置这些吗？[Y/n]` on a
Chinese system); a no writes nothing. Without a terminal to answer in, such as an agent's chat,
it only previews, and `node scripts/setup-agent.mjs --apply` writes. It takes the same options as
`npx @wenyuchiou/agent-board@next setup`, such as `--agent codex` or `--data-dir <folder>`. On
Windows, use the exact paths it prints. Then finish [the steps your agent needs](#after-setup-per-agent),
and open the board from this folder with `node bin/agent-board.mjs`; add `--data-dir <folder>`
when setup wrote the board there. A board the Claude Code plugin manages opens with
`/agent-board` in Claude Code, or from this folder with `--progress-file <path to its progress.md>`
(`~/.claude/progress.md` unless you moved it).

## Let an agent install it

Paste this into the agent you already use:

```text
Install Agent Board from https://github.com/WenyuChiou/agent-board on this computer.
Read its AGENTS.md, README and setup guide. Identify my current host and the other installed coding agents, then preview the common installer: node scripts/setup-agent.mjs.
Preserve existing settings and the shared progress path. Follow my approval requirements for persistent changes, then apply the applicable hooks, plugins and board command. Do not require or call another AI product to bootstrap this one.
Complete any required scoped host trust, read the settings back, and have this session report its own real task progress. Open the interactive board.
Verify actual hook events separately for CLI, desktop App and IDE. Installed files, transport acceptance and an ACK are different from a working progress connection.
Tell me which existing sessions need reload and which adapters remain unsupported or unverified. Never scan private conversations or silently skip a blocker.
```

## After setup, per agent

Start a new session of each agent: a session that was already open is not connected.

Open the board in the new session with `/agent-board`, or `$agent-board` in Codex. Cursor has no such command: use `npx @wenyuchiou/agent-board@next` in a terminal. In Hermes Agent, ask it for the Agent Board skill.

- **Claude Code** connects through its plugin, which a yes to setup installs. If you did not answer yes (setup only previewed, or ran `--apply` without a terminal): `claude plugin marketplace add WenyuChiou/agent-board`, then `claude plugin install agent-board@agent-board`. The plugin adds a `PermissionRequest` hook: when the page the board opened is in front of you and has drawn a request, Claude Code waits up to 30 seconds for Allow once or Deny there; otherwise, and in `bypassPermissions` or `dontAsk` mode, it asks in its own window as before. The page shows the command in full while it waits; the journal keeps only the decision, the tool, the command's first three words and a 12-character hash.
- **Codex:** a yes to setup trusts its hooks. If you did not answer yes, trust them in `/hooks` ([how](CODEX.md)).
- **OpenCode, OpenClaw:** reload their plugins.
- **dot and other web chats:** paste [the last section of AGENTS.md](../AGENTS.md#report-your-progress-to-the-progress-pane) into the agent's instructions, then save each block it writes and merge it into the progress file as [Remote reporters](REMOTE_REPORTERS.md#chat-relay-a-prompt-to-paste) shows.

To add a task of your own, write a `### title` with `- [ ] step` lines in `progress.md` ([the format](FORMAT.md)).

## Native status adapters

| Host | Installed adapter | Separate acceptance / remaining limit |
| --- | --- | --- |
| Codex | Seven hooks (six lifecycle, one plan mirror) and explicit own-thread reporter | Scoped native trust and actual CLI/desktop events; [details](CODEX.md) |
| Cursor | Conversation/generation lifecycle hooks | Native CLI/IDE execution and turn binding. On Windows, start `cursor-agent` from PowerShell or Command Prompt: started from Git Bash, it runs none of its hooks (setup says so) |
| OpenCode | Session event plugin and context-bound progress tool | Plugin reload; status events lack a turn id |
| Antigravity | Four named native hooks plus shared skill | Native CLI/App/IDE events; no session-end event or turn fence |
| Grok Build | SessionStart, UserPromptSubmit, Stop, SessionEnd, and a plan mirror on `todo_write` | Prompt/idle/end status; native execution unverified |
| Muse Code | Stop, SessionEnd | Coarse status and native execution unverified |
| Hermes Agent | `on_session_start`, `pre_llm_call`, `post_llm_call` (carries the reply) and `on_session_end` shell hooks in `config.yaml`, a plan mirror on its `todo` tool, plus the skill | Hermes asks once to trust each hook (or `--hermes-trust` adds only the board's commands to its allowlist); native execution unverified |
| OpenClaw | Independent metadata plugin and native skill | Native host execution unverified; requires sanitized lifecycle subscription API |
| DeepSeek Harness | Native Cordis lifecycle plugin, `agent_board` tool and skill | Checked live on Windows in dsh web 0.2.2-rc.1 (report, open, page stays up after dsh closes); CLI and Desktop unchecked |

## Portable host paths and lifecycle

Select one target or a comma-separated list, such as `--agent opencode,openclaw,grok,deepseek`.
They share the selected progress file. Each target's preview still lists its own persistent
changes; no receiving connection or model call is added by setup.

| Target | Native configuration | Override |
| --- | --- | --- |
| OpenCode | `~/.config/opencode/plugins/agent-board-local.js` and `commands/agent-board.md` | `--opencode-dir`, then `OPENCODE_CONFIG_DIR`, then `XDG_CONFIG_HOME/opencode` |
| OpenClaw | `~/.openclaw/openclaw.json`, `skills/agent-board/` and a private local plugin with its manifest | `--openclaw-dir`, then `OPENCLAW_STATE_DIR` |
| DeepSeek Harness | `~/.dsh/cordis.patch.yml`, `skills/agent-board/` and a private Cordis plugin | `--deepseek-dir`, then `DSH_HOME` |
| Grok Build | `~/.grok/hooks/agent-board-local.json` | `--grok-dir`, then `GROK_HOME` |
| Hermes Agent | the `hooks:` block of `config.yaml` in the Hermes folder, `~/.hermes` (`%LOCALAPPDATA%\hermes` on Windows) (only the board's four entries; other hooks and keys stay) and `skills/agent-board/` | `--hermes-dir`, then `HERMES_HOME` |

OpenClaw receives `session_start`, `session_end` and sanitized lifecycle start/end/error
events. Only the native session/run ids, state and the session's workspace folder are reported;
stale runs cannot replace the current one. It explicitly denies conversation access. Hosts lacking the subscription
API fail visibly rather than falling back to transcript access. Reload the plugin in each
host; installation cannot enumerate every previously open session. The plugin
registers a `progress_card` tool (`title`, `state`, `steps`) that reports to the board's report
writer for the plugin's own session, so it needs no folder lookup. When OpenClaw's own
`update_plan` call succeeds with a plan, the plugin copies each step's text and status into the
board's steps; the plugin reads no reply text, so the installed skill and the tool's description tell the agent to
send a closing question as a `- [?] <the question>` step before the turn ends; OpenCode's plugin does the same with its todo list, and Grok Build's `PostToolUse` hook (matcher `^todo_write$`, timeout 5 s, prints nothing) copies the full list from the tool's result.

DeepSeek uses `agent/created`, `agent/status` (running/idle) and `agent/disposed`, retaining
its own agent identity and sending the session's folder (`cwd` from the session header), so its block is filed under the workspace. The plugin runs in the Harness process, outside the shell sandbox, and registers one tool, `agent_board`: `action: open` starts the board page (detached) and returns the one line it prints, and `action: report` (`title`, `state`, `steps`) reports to the board's writer by the tool's own session id; the session start already told the board its folder. The installed skill tells DeepSeek to call that tool instead of a shell command, because its Windows sandbox writes only inside the workspace and cannot reach the board's address folder or progress file. No prompt, message or model hook is registered. Its owned entry is appended to a plain root YAML patch sequence;
complex/edited YAML is a conflict requiring review. Existing entries remain untouched.
A JSON config that is not a JSON object, or holds a number JSON cannot keep exactly (such as
an id past 2^53), is a conflict too, and is left untouched.
Native skill roots are used as well as the shared skill. Restart profiles without
configuration HMR. No credential, telemetry or provider setting is changed.

Hermes Agent runs its shell hooks from the `hooks:` mapping of `config.yaml`. Setup adds one
entry each under `on_session_start`, `pre_llm_call` (a turn begins, so the block says working and an
answered question closes; it prints nothing, because Hermes reads that hook's output as context for the
model), `post_llm_call` (its `extra.assistant_response` is the reply, so a closing question becomes a card)
and `on_session_end` (which Hermes fires after every turn, so it only marks the session idle), and one
`post_tool_call` entry with `matcher: todo`, which copies the whole list from the `todo` tool's result into
the block's steps. Entries are found again by the installed worker's name; other keys and
hooks are kept as they are. A `hooks:` written in flow style, or a root that is not a mapping, is a
conflict and the file is left untouched. Each command is double-quoted for Hermes's `shlex` split
(no shell), with forward slashes on Windows. Setup never sets `hooks_auto_accept` or passes
`--accept-hooks`: Hermes asks once at a terminal, and a chat gateway cannot ask, so for that
preview `--hermes-trust` and add `--apply`. That writes only the board's exact (event, command)
pairs into `shell-hooks-allowlist.json`; `--codex-remove --agent hermes` takes the same pairs out.
`HERMES_SESSION_ID`, when a tool's process has it, binds `--codex-report --agent hermes`.
Hermes puts the whole conversation in the input of `pre_llm_call` and `post_llm_call`. Past 1 MB, the Hermes
hook reads on to the end without keeping it, scans the first 1 MB for the event name, session, folder and
the reply, and keeps nothing else; a reply cut off there reports the status with no question. Other agents'
hooks still refuse an input over 1 MB.
The Hermes folder is `HERMES_HOME`, else `%LOCALAPPDATA%\hermes` on Windows, else `~/.hermes`, as Hermes chooses it.

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

These hooks report activity; Codex, Grok Build, Cursor CLI, OpenCode and Antigravity CLI
also put a reply's closing question under Needs you. Antigravity's hooks carry no reply text,
so the board reads the last reply from its own transcript file, whose format is undocumented
(checked on agy 1.5.2); it keeps only the closing question. Other semantic steps need a host-proven own-session
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
an active connect, that connector keeps managing Antigravity's hook and skill. While a host has the
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

## Gemini CLI is retired

Google's [consumer transition announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
ended free individual and Google AI Pro/Ultra Gemini CLI service on June 18, 2026, and
Antigravity CLI is Google's CLI now. Setup no longer finds or offers Gemini CLI, and
`--agent gemini` is refused with a message that names `--agent antigravity`; no file changes.
A Gemini CLI install from an earlier release keeps reporting to the board.

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
