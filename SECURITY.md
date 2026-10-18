# Security

Agent Board runs inside Claude Code on your own machine. The standalone board runs with Node.js. What it can read, change or send depends on how you use it.

## Board views and page

The board commands and skills that `/progress connect` writes normally run `--serve`: using one starts a background server, opens the browser, writes an address file and prints the token link into that agent's conversation. If the server is already running, it reuses that page. In a chat app, the skill runs `--chat`, which prints no link.

Running `agent-board.mjs` without an action prints the board. `--watch` without a terminal only redraws it. These views read `progress.md`, its journal, the answered-question list and pending inbox files. For a pending turn that names a session log (Codex's does) and has no prompt, they can also read the log's tail. The pane can read that tail when the prompt or reply is missing. These views do not consume inbox files.

`--chat` prints a short text view without writing files, opening a browser or starting a server. It hides home-directory paths and common credential forms, including known token prefixes, password/token assignments, authorization headers and secret parameters in links. This is best-effort pattern matching, not a guarantee that all private information is removed. Review its output before sharing. This redaction covers `--chat` output only: it does not clean the source files, other views or diagnostic attachments.

## Local file changes

- The pane writes tasks and steps to `progress.md`, completed work to `progress-archive-*.md`, finished steps to `progress-journal-*.md`, and a browser view to `progress.html`. Marking a question answered writes the shared `progress-answered.json` list beside the default `progress.md` (a custom progress filename changes that list's name too). The pane and the terminal board in `--watch` or `--serve` also keep `progress-seen.json` beside it: a hash of each task that carries no time of its own and when it was first seen, so work idle for more than 7 days can step aside; it holds no task text.
- In a terminal, `--watch` accepts keys to tick hand-kept steps, archive tasks, hide or show answered questions, and write/open HTML. `--keys` can perform those actions too. `--html` writes `progress.html` and opens it. The board page (`--serve`) can tick steps, archive one task or tidy finished work, hide/show questions, and merge a pasted progress block into `progress.md`.
- Connected hooks save the JSON supplied by an agent in `progress-inbox/`; it can contain prompts, replies, session identifiers, working directories and session-log paths. The reporters do not redact that input. The pane reads and renames inbox files, deletes successfully handled files, retries retained `.taking` files and keeps invalid or repeatedly failing reports as `.failed` files. The sh and PowerShell reporters also delete old `.json` files; the OpenCode and OpenClaw plugins do not. Treat the inbox and retained failures as private conversation data.
- `/progress connect` edits installed agents' hook or plugin config blocks and writes reporter scripts, `agent-board.mjs`, and each agent's board command or skill. For OpenClaw, it sets `allowConversationAccess: true`, letting the plugin read that conversation. Session startup also connects agents by default unless auto-connect is disabled. The [guide](docs/GUIDE.md#other-agents) lists the files. The setup scripts can edit the shell profile, Claude settings and instructions, and, with `--agents`, other agents' global instructions; existing files they change are backed up as `<file>.bak` first. Backups may contain private settings too.
- `/progress connect remove` leaves the inbox, reporter scripts, progress files (including archives and journals) and `.bak` backups behind; delete them yourself if you no longer want them. The guide's [uninstall section](docs/GUIDE.md#update-and-uninstall) lists where they are.
- `--serve` also writes a local address file containing the server's token in an account-only runtime/cache directory (the temporary directory on Windows), and removes it when the server stops. File updates can create temporary files during a write.

## Processes and model calls

The pane runs `git branch --show-current` to identify the branch and `gh pr view` through your installed GitHub CLI to check its pull request and CI state. Through your own Claude Code login/model access, it sends prompt and reply text to Claude Haiku for turn summaries, the session's first request plus step names for titles, and up to 6,000 characters of a compaction summary for a handoff line. The pane's side-question box also sends your question to the model over the session's transcript through that same login. These calls use your account's allowance or billing.

Board commands run `node`; `--serve` starts a background Node.js server. Opening a view or copying text can run the system browser or clipboard helper. The plugin also uses system commands to rename/delete files and check installed tool versions; connected hooks run the reporter through `sh` or PowerShell, or an agent's own plugin runtime.

On the loopback board page, sending a reply to an ended Codex or Grok Build session can start `codex exec resume` or `grok -r` in that session's folder. Those agents act with their own permissions, credentials and network access. Sessions still open and agents without this send support require you to copy the reply into their own window. The LAN page refuses replies that would start an agent and omits resume commands; it still allows board file changes.

## Network access

`--serve` listens on loopback (`127.0.0.1`) by default, so its page is reachable only from the same computer; any program on this computer that has the link can use it. `--serve --lan` opens a second HTTP listener on a private network address and prints a separate link and QR code containing a token. The token is an access key: requests without the correct token are refused. Host, origin and JSON checks also restrict requests.

The token is not encryption and does not identify a particular person. Anyone on that network with the LAN link can read the board and use its allowed controls, including changing board files, importing blocks and stopping the server. HTTP traffic can expose the link and board contents to others who can observe the network. A private network address does not make a café or hotel network trusted. Use a trusted network; do not share the link, QR code or screenshots containing them.

Use the page's **Close** button to stop serving (if a reply is running, wait for it to finish and try again). Closing a browser tab alone does not stop the background server immediately: the LAN listener expires after 10 minutes without a LAN request, and the server after 30 minutes without a request when no reply is running. Open pages poll and keep it alive. A new token is issued each time the board server or its LAN listener restarts, so stopping it makes its old link useless.

Haiku calls and GitHub CLI requests use their respective services. Resumed agents may contact their providers or other services as part of their work. LAN mode shares the board over your network; syncing its files with another application follows that application's sharing settings.

## Reporting a problem

Report vulnerabilities and other security-sensitive problems privately through GitHub's [**Report a vulnerability**](https://github.com/WenyuChiou/agent-board/security/advisories/new) on the repository's Security tab. Describe what an attacker could do and how to reproduce it with synthetic data. Do not include credentials or an unedited conversation, even in a private report.

For an ordinary public bug report, include:

- Claude Code (`claude --version`), plugin (`claude plugin list`), Node.js (`node --version`) and affected agent versions.
- Your operating system, which agent is affected, what you did and what you expected versus what happened.
- The output of `/progress connect status`, reviewed first for private information.

Do not attach raw inbox, `.taking`, `.failed`, progress, archive, journal or session-log files. Remove prompts, replies, private paths, tokens (including board links/QR codes) and personal or project names from any output or screenshot. Prefer a small example you wrote from scratch; there is no automatic cleaner for diagnostic files.

Synthetic example (replace the version placeholders before reporting):

```text
OS: demo OS; Claude Code: <version>; Agent Board: <version>
Node.js: <version>; agent: Codex <version>
Action: finished a turn in demo-1. Expected: a board row. Actual: no row.
/progress connect status: <reviewed status, with private details removed>
```

You will get an answer within a week. Fixes go into the next release and are noted in `CHANGELOG.md`.

## Supported versions

Only the latest release gets fixes. With auto-update on (the setup script turns it on), installs follow it by themselves.
