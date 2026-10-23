# Security

Agent Board runs locally with Node.js. The optional Claude Code plugin adds a native pane and its own connector flow. Their data and model access differ.

## Independent setup and hooks

`node scripts/setup-agent.mjs` previews persistent files and conflicts. `--apply` writes the reviewed board, skills, ownership manifests and supported hook/plugin definitions. It preserves unrelated settings and refuses edited owned definitions. It does not install AI applications, change credentials, grant conversation access, configure startup services or establish message receivers.

The npm package `@wenyuchiou/agent-board` holds only its launcher, `setup-agent.mjs`, `setup-codex.mjs`, the board bundle and the released-files table (the `files` list in `package.json`), plus the READMEs and the license that npm always adds. `tests/npm-package.test.mjs` checks that list against what `npm pack` would publish. It has no dependencies and no install scripts, so installing it runs nothing. `agent-board setup` writes what `setup-agent.mjs` writes; every other command runs the board script already installed for the account. Only the owner publishes it, from the exact release tag, with two-factor authentication.

Native independent reporters retain selected session/turn/state/timestamp metadata and explicit task summaries. Antigravity keeps at most 16 recent activity observations. They ignore transcript paths, prompts, tool inputs, model replies and permission decisions, read no conversations and call no model. An explicit progress report is still private task data; the agent must report only its own proven session.

Hook trust is separate. The Codex trust helper previews six exact definitions and hashes; after user approval it uses the native settings API to merge only those trusted hashes and reads them back. It never bypasses all hook trust. Changed definitions need review again. Installed or trusted hooks are not proof that a CLI/App/IDE actually executed them.

Removing a target takes only unchanged owned files/definitions. Shared files stay while another installed target needs them. Progress, session records, archives, journals and user changes remain for the user to retain or remove deliberately. Do not delete a lock without checking its recorded owner.

## Board files and views

Fresh independent setups use `~/.agent-board/progress.md`; existing installs retain their selected path. Board editing can also write archives, journals, `progress-answered.json` (hidden questions), `progress-seen.json` (hashes and first-seen times), generated HTML and temporary write files. The web board can tick manual steps, archive, hide/restore questions and merge a valid pasted block. Atomic replacement does not guarantee a transaction across every history file, extended ACL preservation or crash durability.

`--serve` starts a background Node process and writes a bearer URL to an account-only runtime/cache address file (temporary directory on Windows). It reuses a matching service. Closing a tab leaves it running; **Close the board** stops it when no delivery is in flight. Local idle shutdown is disabled by default; `--idle-minutes 30` opts in. No startup service is installed.

`--watch` accepts terminal keys; `--keys` can perform those board actions without a terminal. `--html` writes a read-only page and opens it. `--chat` only prints compact text: no page, browser, link or writes. It redacts home paths and known credential patterns on a best-effort basis. That does not sanitize source files, other views or diagnostic attachments.

Existing legacy `progress-inbox/` files can contain prompts, replies, directories, session ids and log paths. Views can read a named log's tail when a pending turn lacks text; the optional pane can do so too. Independent metadata hooks do not create that conversation inbox. Treat any legacy inbox, `.taking` and `.failed` files as private conversation data; do not attach them to issues.

## Messaging and processes

`--serve` also starts the local message hub. Its default store is `agent-board-<16-hex-board-hash>-messages` beside the private address file: in the account-owned runtime directory, otherwise the account's temporary folder on Windows or `~/.cache/agent-board` elsewhere. `--messages-dir /private/local/message-data` overrides it. The directory holds message text, exact bindings, ids, durable claims/receipts and a PID lock; keep it local and private. Any local program that can read the address file can send using its bearer URL. A sourceless delivery is therefore labelled as from the board page, with the sender's identity unconfirmed, rather than attributed to the person. Connector secrets and bearer URLs are access credentials.

On Windows, newly created stores and the default store are made the current account's alone: the board makes the account the folder's owner, removes inherited and other accounts' access, and reads the access entries back (the owner is set, not read back). If that fails, startup stops with `MESSAGE_STORE_ACL`. For a new or default store, a board run as SYSTEM, LocalService or NetworkService always stops there: run it as a person's account. Existing custom `--messages-dir` folders keep their permissions; the person selecting one must keep it private.

Adapters must verify an existing authorized native owner and maintain a short-lived lease. A progress card or open application is insufficient. Attached sources are reverified immediately before forwarding; disconnected targets lose live Send. Duplicate live registrations are contested and cannot receive or acknowledge, including with `--allow-resume`. The default UI and action API never launch a closed Codex/Grok session. The separate legacy `--allow-resume` option deliberately enables `codex exec resume` / `grok -r` for closed sessions even while the hub runs; setup never enables it. Those resumed agents use their own permissions and credentials.

A transport acceptance is not a model reply. Codex acknowledgement requires a correlated native nonce ACK and the matching completed turn. Antigravity requires its matching native stream result and ACK. Only the ACK line is stored as the acknowledged reply, at most 200 characters; embedded ids and multi-line replies cannot acknowledge. Receipts match the claim's nonce and target agent/session, including after restart. Contested connections cannot report receipts, and board JSON omits the nonce. Exact retries return the existing receipt while retained; changed content/binding/source with the same id conflicts. A claimed message is not automatically replayed after timeout, disconnect or crash. Accepted/uncertain messages expire after 30 minutes and finished records are deleted after 24 hours. The two-hop limit applies only to adapters that send with their authenticated source; a sourceless send is always hop 1. Three open messages per target and one per source/target pair apply to all sources, including board sends. Verify uncertainty with the original recipient before choosing another action; never change ids just to force a resend.

Ordinary messages and alleged approvals cannot authorize tools, hook trust, permanent settings or PR merges. These adapters do not answer approval RPCs. The native host remains responsible for its permission policy. Installation and adapter attachment start no model turn; delivering an explicitly authorized message can use the recipient's model allowance. Native CLI, desktop, IDE and dot delivery need separate acceptance.

## Optional Claude Code plugin

The pane runs local Git and `gh pr view` to read branch, PR and CI state. Through Claude's model access it can send prompt/reply text to Haiku for summaries, initial requests and steps for titles, or compaction text for handoff. Side questions use the current session context. These calls use that account's allowance or billing.

Its older `/progress connect` flow installs conversation-inbox reporters and can set OpenClaw's `allowConversationAccess: true`. This grant belongs to that optional connector, not independent OpenClaw setup. Session startup can run auto-connect unless disabled. Its setup scripts can change Claude settings, shell profiles and global instructions; backups may contain private settings. Inspect the [guide](docs/GUIDE.md) and the exact plan before applying changes.

## Network access

The default listener is `127.0.0.1`. Any local program with its bearer URL can use the permitted controls. Host, origin, token and JSON checks restrict requests but do not identify a human user.

`--lan` explicitly adds a separate plain HTTP listener on a private network address with its own token. Anyone with that link on the network can read and edit board files, import blocks and stop the service. The token is not encryption; use a trusted network and do not share links or QR codes publicly. LAN messaging is unavailable and resume commands are omitted. Its listener expires after 10 unused minutes, independently of the local service. Restarting either listener changes its token.

Native models and optional Claude summaries contact their providers. GitHub checks use GitHub. Remote fragment transport and file sync follow their own settings; a local installation enables neither automatically.

## Reporting a problem

Use GitHub's [Report a vulnerability](https://github.com/WenyuChiou/agent-board/security/advisories/new) for security-sensitive findings. Give a synthetic reproduction and describe the impact. Do not include credentials or an unedited conversation, even privately.

Public bugs need the Agent Board, Node and affected host versions; CLI/App/IDE surface; OS; expected behavior and a small synthetic example. Include Claude's version or `/progress connect status` only for that optional connector. Review diagnostics before sharing; remove prompts, replies, private paths/names and tokens. Do not upload raw progress, inbox, archive, journal or session logs.

## Supported versions

Fixes target the latest release. Independent installs update through a reviewed installer run from the intended checkout. The optional plugin follows its marketplace update settings; no universal unattended updater is implied.
