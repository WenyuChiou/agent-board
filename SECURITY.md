# Security

Agent Board runs inside Claude Code on your own machine. It reads and writes `progress.md`, its archive, journal and `progress.html` beside it, and runs `gh pr view` when GitHub's CLI is installed. The setup scripts edit your shell profile, `~/.claude/settings.json`, `~/.claude/CLAUDE.md` and, with `--agents`, other agents' global instruction files, and back each one up as `<file>.bak` first. Nothing is sent anywhere by the plugin itself.

## Reporting a problem

Please report a vulnerability privately, through GitHub's **Report a vulnerability** button on the repository's Security tab, rather than in a public issue. Include what an attacker could do, the steps to reproduce, and the versions (`claude plugin list`, `claude --version`).

You will get an answer within a week. Fixes go into the next release and are noted in `CHANGELOG.md`.

## Supported versions

Only the latest release gets fixes. With auto-update on (the setup script turns it on), installs follow it by themselves.
