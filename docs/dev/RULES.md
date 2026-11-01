# Agent Board rules, on one page

Every person and every agent reads this page first. The longer pages ([CONTRIBUTING.md](../../CONTRIBUTING.md), [team-process.md](team-process.md), [RELEASING.md](../RELEASING.md), [CONTRIBUTOR-PATH.md](../CONTRIBUTOR-PATH.md)) explain the details. When one of them changes a rule here, it changes this page in the same pull request; the PR check fails otherwise (R5).

## Start here

- **What it is.** Agent Board shows what every coding agent on a computer is doing, on one board. Try it: `npx @wenyuchiou/agent-board setup`.
- **Find work.** Take an open issue labelled `ready` that has no assignee, and assign it to yourself: that is your claim (R4). Work mainly on your own issues.
- **Talk on the issue.** Questions, hand-overs and decisions go in comments on the issue or its pull request. If it is not on GitHub, the next person cannot see it.
- **Done means closed.** The pull request says `Fixes #N`; the issue closes when it merges, with how the change was checked.

## Every agent follows the same rules

- Claude Code, Codex, Antigravity, Cursor, cloud agents such as dot and Muse, and people by hand all follow this page. Each one reviews and merges others' pull requests on its own, from the review queue ([REVIEWING.md](REVIEWING.md)). No rule here depends on which agent you are.
- **Where an agent starts.** [AGENTS.md](../../AGENTS.md) is the entry point; it sends you here first. Codex, Antigravity and Cursor read `AGENTS.md` by themselves. Claude Code does not: the repository is also a Claude Code plugin, whose root `CLAUDE.md` is not loaded, so a Claude Code session is given this page's link in its first prompt, or its user adds `@AGENTS.md` to their own `CLAUDE.md`. The same goes for any other agent that reads neither.
- **An agent works in the role of the person who runs it** (CONTRIBUTING, [Roles](../../CONTRIBUTING.md#roles)). An agent of the owner or of a collaborator may review and merge other authors' pull requests, as that person may.
- **Who counts as the author.** The agent named in the `Author:` line, every agent it dispatched, and every agent that wrote part of the pull request or its brief. Another agent, of the same person or not, may review and approve it (R2).

## R1. Who decides what

- The owner (Wenyu) sets direction: the roadmap, the must-ship issues of each milestone, and rules R2, R3, R7 and R8. A question that only the owner can answer gets the `needs-owner` label; there should be few.
- Everything else is decided by the people doing the work: collaborators, the maintainer session and their agents. A change to process details (labels, merge order, wording) needs approval from two people who did not write it.

## R2. Nobody approves their own work

- The author never approves their own pull request. A review by the author's own agent, lane or subagent does not count.
- A review bot (Codex Code Review, Greptile) can stop a merge with an unresolved P0 or P1, but never approves one.
- The owner's agents all post from the owner's GitHub account, so GitHub cannot refuse an author's approval. The names do: the `Author:` line names the author, and `Review: APPROVE <full head sha> by <name>` the reviewer. `node scripts/pr-check.mjs --pr <N> --review-gate` fails when they are the same, or when the approval is not for the current head ([REVIEWING.md](REVIEWING.md)).

## R3. Merging

- A pull request merges once every required check is green on its current head and someone other than the author has approved that head (CONTRIBUTING rules 8 and 9). Branch protection and auto-merge are being turned on so this happens without anyone pressing merge; until then, any agent or person allowed to merge does it, Antigravity, Codex or dot as much as Claude Code, after the review gate passes ([REVIEWING.md, Merging](REVIEWING.md#merging)).
- A change to `.github/workflows/` also needs the owner's approval, because a workflow can widen what CI may do (CONTRIBUTING rule 12).

## R4. One issue, one owner

- Assign yourself before you start; one assignee per issue. If someone is assigned, comment on the issue instead of starting a competing pull request.
- When you stop for any reason, usage running out included, push, comment a `Handover:` on each issue and pull request you hold, and unassign yourself ([REVIEWING.md, When you have to stop](REVIEWING.md#when-you-have-to-stop)).
- An issue with no activity from its assignee for 24 hours may be unassigned by anyone, with a comment, and goes back to `ready`.
- One pull request is one feature, or up to three bug fixes, branched from current `main`. A finding outside your issue becomes an issue of its own.

## R5. Checks are code

- A rule that can be checked lives in `scripts/pr-check.mjs` or `scripts/review-queue.mjs`, not only in prose.
- A pull request that changes CONTRIBUTING.md, docs/dev/team-process.md or docs/RELEASING.md also changes this page, or says why not in a body line `Rules page: unchanged, <reason>`.

## R6. When something fails

- When the cause is still unknown after two fix attempts, stop and write a `Question:` on the issue.
- A raised timeout, a skipped test or an added retry is never the fix for a flaky test.

## R7. Releases go out by themselves

Nobody gives a go-ahead for a release ([RELEASING.md](../RELEASING.md)). Every release, pre-releases included, needs:

- the release pull request merged as R3 says, with the version agreed in `plugin.json`, `package.json`, the README badges and the marketplace text, the CHANGELOG folded and the generated files rebuilt;
- **a simulated user.** An AI acting as a new user installs the release's package, sets up, opens the board and walks every journey, on Windows and on macOS or Linux, as [USER-SIM.md](../validation/USER-SIM.md) says. Its record is `docs/validation/<date>-usersim-<version>.md`. Any agent or person may run it. A FAIL, or a FRICTION step with no issue, stops the release.

It goes out as **stable** when the release gate also passes on the tagged commit, and as a **pre-release** otherwise:

1. CI is green on Ubuntu and Windows.
2. The live parity record for the vendor apps exists ([PARITY-CHECKLIST.md](../validation/PARITY-CHECKLIST.md)); any collaborator with the apps installed may run it.
3. The L1–L3 journey tests pass (`tests/e2e/`).
4. Every must-ship issue of the milestone is closed.

The maintainer, or a collaborator when the maintainer is away, tags it and makes the GitHub release without asking. Publishing to npm needs the owner's one-time code until npm trusted publishing is set up; that is the one step left by hand. After a release, the owner answers the three next-version questions that `changelog-fold` prints.

## R8. What stays off GitHub

This repository is public: anyone can read every issue, pull request, comment, commit and CI log, and a deleted comment may already be copied.

- **Public here:** these rules and the process, the code, issues about the product, and validation records made with synthetic data.
- **Never anywhere in the repository:** tokens, keys, passwords and links that carry one. They live only in GitHub Actions secrets and environments. A leaked one is revoked first, then removed.
- **Kept off GitHub:** session logs and transcripts, write-ups of what went wrong in someone's session, anyone's home-folder paths, computer user names, email addresses and machine names, a person's own agent or harness settings, internal budgets such as GPU hours or spend, and anything someone said in private. They stay with the person they belong to, or in a private place the owner sets up and gives access to; an issue here says in plain words what the next person needs, without them.
- **Security problems** go to GitHub's private vulnerability report ([SECURITY.md](../../SECURITY.md#reporting-a-problem)), never to a public issue. Only the owner, and the people the owner adds to that report, can read it.
- **Checks.** The PR check fails a pull request that adds a home-folder path, a session id, a token or an email address to a document or its body. GitHub's secret scanning and push protection, turned on in the repository's settings, stop a known kind of token before it lands.
