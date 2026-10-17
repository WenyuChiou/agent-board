# Security

Agent Board runs inside Claude Code on your own machine. It reads and writes `progress.md`, its archive, journal and `progress.html` beside it, and runs `gh pr view` when GitHub's CLI is installed. The setup scripts edit your shell profile, `~/.claude/settings.json`, `~/.claude/CLAUDE.md` and, with `--agents`, other agents' global instruction files, and back each one up as `<file>.bak` first. `/progress connect` adds a hook to each installed agent's own config (the files are listed in the [guide](docs/GUIDE.md#other-agents)) and writes `progress-report.sh` (Windows: `progress-report.ps1`) beside `progress.md`. It also writes `agent-board.mjs` there, a read-only script that prints the board, and a command or skill file for each installed agent that runs it (listed in the [guide](docs/GUIDE.md#the-board-in-every-agent)); the script reads `progress.md`, the inbox and, for a Codex turn, the session log the turn names, and writes only `progress.html` when run with `--html`. `/progress connect remove` takes all of them out again. To sum up a turn, the plugin asks Claude Haiku through Claude Code's own model access, sending that turn's request and reply. Nothing else is sent anywhere by the plugin itself.

## Reporting a problem

Please report a vulnerability privately, through GitHub's **Report a vulnerability** button on the repository's Security tab, rather than in a public issue. Include what an attacker could do, the steps to reproduce, and the versions (`claude plugin list`, `claude --version`).

You will get an answer within a week. Fixes go into the next release and are noted in `CHANGELOG.md`.

## Supported versions

Only the latest release gets fixes. With auto-update on (the setup script turns it on), installs follow it by themselves.
