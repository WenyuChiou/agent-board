# Setting up your own agents

Agent Board's rules ([RULES.md](RULES.md)) say what every agent does in this repository. This page is about your own computer: settings that keep your agents from stalling or piling up while they work here. They live in your own agent settings, not in this repository, and none of them is checked; apply the ones your agents support. Do not commit your own settings here ([RULES.md, R8](RULES.md#r8-what-stays-off-github)).

## Every hook gets a timeout

A hook that never exits holds the agent's next step until the agent gives up on it. In Claude Code that wait is 600 seconds when a hook sets no `timeout`, and the step then goes ahead anyway, so a stuck hook costs ten minutes each time and protects nothing.

- Give every hook a `timeout`, in seconds, in your `settings.json` (`"timeout": 10` next to its `"command"`). About 10 s suits a prompt or edit hook, 30 s a hook that checks every shell command, and at most 120 s a session-start hook.
- A plugin's hooks come with the plugin. If one stalls, turn the plugin off until it is fixed.
- To find a stall, look for the same hook cancelled again and again in your agent's session logs (Claude Code records `hook_cancelled`).

## Keep the number of runs small

Several agents on one computer slow each other down and use up a plan's limits faster.

- At most five lanes plus the maintainer on this repository, and at most two Codex runs at once on one computer ([team-process.md](team-process.md)). Count before you start another one.
- Give each lane its own worktree and branch, and remove the worktree when its pull request merges or closes.
- A background test run gets a time limit (`--timeout`, or `timeout N` before the command), so a hung run cannot outlive the session.

## Before your usage runs out

Push your branch, comment `Handover: <branch>, last commit <sha>, done: …, left: …` on each issue and pull request you hold, and unassign yourself ([REVIEWING.md, When you have to stop](REVIEWING.md#when-you-have-to-stop)). Then the next agent can pick the work up from GitHub alone.
