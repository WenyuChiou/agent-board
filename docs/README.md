# Which file is for what

Each rule and each process step is written in one file, listed here. Another page links to it instead of repeating it, so two copies cannot drift apart. Start with [docs/dev/RULES.md](dev/RULES.md).

"Owner" below means the change needs the owner's written approval of its content ([CONTRIBUTING rule 12](../CONTRIBUTING.md#pull-requests)). "Non-author" means one approval from an agent or person who did not write it ([RULES.md, R1](dev/RULES.md#r1-who-decides-what)).

## Rules and process

| File | What it is for | Who approves a change |
|---|---|---|
| [docs/dev/RULES.md](dev/RULES.md) | The rules, on one page. Every agent and person reads it first. | R2, R3: owner. The rest: non-author |
| [AGENTS.md](../AGENTS.md) | Where an agent starts: the commands, the checks and a map of the code. | non-author |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How a pull request is made, reviewed and merged. | rules 8, 9, 12: owner. The rest: non-author |
| [docs/dev/team-process.md](dev/team-process.md) | How the owner's own agents share the work: lanes, merge order, hand-overs. | From claim to merge, Standing approvals: owner. The rest: non-author |
| [docs/CONTRIBUTOR-PATH.md](CONTRIBUTOR-PATH.md) | The same steps as commands, for someone working from another computer or from outside the team. | non-author |
| [docs/dev/brief-rules.md](dev/brief-rules.md) | The checklist pasted into every task brief. | non-author |
| [docs/dev/reviewers.json](dev/reviewers.json) | Who the review queue suggests as reviewer. A suggestion only. | non-author |
| [docs/dev/CI.md](dev/CI.md) | Which CI jobs run for which change. | non-author |
| [.github/](../.github) | CI workflows, and the issue and pull request templates. | workflows: owner, each file on its own. Templates: non-author |
| [scripts/pr-check.mjs](../scripts/pr-check.mjs), [scripts/review-queue.mjs](../scripts/review-queue.mjs) | The rules a machine checks (R5). | non-author |
| [scripts/review-queue-post.mjs](../scripts/review-queue-post.mjs) | Posts the review queue every hour and takes `claimed` off claims that ran out, from `.github/workflows/review-queue.yml`. | non-author (the workflow: owner) |

## Releases

| File | What it is for | Who approves a change |
|---|---|---|
| [docs/RELEASING.md](RELEASING.md) | How a version is cut, checked and published. | non-author |
| [docs/validation/USER-SIM.md](validation/USER-SIM.md), [docs/validation/PARITY-CHECKLIST.md](validation/PARITY-CHECKLIST.md) | How a simulated user and the vendor apps check a release. | non-author |
| [CHANGELOG.md](../CHANGELOG.md) | What changed for the person using Agent Board, one line per change. Nothing else. | the release pull request (a pull request may add its own line under Unreleased, CONTRIBUTING rule 6) |
| [changelog.d/](../changelog.d/README.md) | Closed: the old fragments wait here for the next release to fold them. Pull requests add none. | only the release pull request |
| `docs/validation/<date>-*.md` | Dated records of a check someone ran. | non-author |

## Direction

| File | What it is for | Who approves a change |
|---|---|---|
| [docs/dev/universal-messaging-roadmap.md](dev/universal-messaging-roadmap.md), roadmap issue #209 | Where the product is going, and in what order. | owner |
| [docs/dev/architecture-positioning.md](dev/architecture-positioning.md) | What Agent Board is, and is not, next to other tools. | non-author |

## For everyone

| File | What it is for | Who approves a change |
|---|---|---|
| [README.md](../README.md) (also in 繁體中文 and 简体中文) | What Agent Board is and how to install it. | non-author |
| [docs/GUIDE.md](GUIDE.md), [docs/SETUP.md](SETUP.md) and the other pages in docs/ | How to use and set it up. | non-author |
| [SECURITY.md](../SECURITY.md) | How to report a security problem privately. | non-author |
| [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | How people here treat each other. | non-author |
