# How work moves

This page sets how much work is open at once, when a finding becomes an issue, and how a pull request goes from claim to merge. It applies to every agent and person working in this repository: Claude Code sessions, Codex, dot and Muse, and agents on other computers. [CONTRIBUTING.md, Pull requests](../../CONTRIBUTING.md#pull-requests) has the rules each pull request must meet; where the two disagree, CONTRIBUTING.md wins.

If you work from outside the team, [CONTRIBUTOR-PATH.md](../CONTRIBUTOR-PATH.md) gives every step you need. The parts of this page about lanes, Codex runs, dot and Muse, the roadmap line and the weekly table are about the owner's own agents.

## Mode and settings

This repository follows the multi-agent workflow standard that its maintainer keeps on the owner's computer. [Part B](#part-b--contributors-copied-into-each-repos-workflow-file), at the end of this page, is a copy of the steps that standard asks of every contributor. Where this page or CONTRIBUTING.md says something different, they win.

- **Mode:** supervised. The coordinator is the maintainer: the Claude Code session on the owner's computer that the owner has named maintainer of this repository (CONTRIBUTING rule 8). A collaborator with write access, the maintainer or the owner merges once someone other than the author has approved (rule 8); the maintainer tags releases and makes the GitHub release ([RELEASING.md](../RELEASING.md)). Supervised concerns the owner's computer only: sessions there push only when the owner says so. It is not a rule for other contributors, who push their own branches as [CONTRIBUTOR-PATH.md](../CONTRIBUTOR-PATH.md) says. This mode changes only after the owner turns on automatic pushes for this repository.
- **Lanes and files:** lanes own no files. A `for-dot` issue names the files allowed ([Who takes which issue](#who-takes-which-issue)); any other issue says what to change. `hooks/board-script.ts` and `hooks/released.ts` are generated: never edit or merge them by hand; rebuild them with Bun 1.4.2, or write "maintainer rebuilds at merge" under Checks ([brief-rules.md](brief-rules.md) item 7). Everyone shares the string tables (`hooks/i18n.ts`, `hooks/strings-en.ts`, `hooks/strings-zh-cn.ts`). Host hooks, tests that start processes, `hooks/pane.tsx`, `hooks/register.tsx` and connect stay with agents that can run the plugin tests locally.
- **Caps:** at most five lanes plus the maintainer, and at most two Codex runs at once on one computer. Pull requests: [One thing at a time](#one-thing-at-a-time).
- **Releases:** the maintainer prepares, reviews and merges the release pull request under the owner's authorization; only the owner publishes to npm ([CONTRIBUTING.md, Releases](../../CONTRIBUTING.md#releases), [RELEASING.md](../RELEASING.md)).
- **Agents on other computers** take issues labelled `for-agent` and `ready`; `for-dot` is for dot or Muse (CONTRIBUTING rule 3). No label names a computer.
- **Hold list:** there is none in this repository. A finding goes in an issue of its own, or in a comment on the issue that already has it ([When a finding becomes an issue](#when-a-finding-becomes-an-issue)).
- **Where Part B differs here, and why.** CONTRIBUTING.md is the rule here, so where Part B asks for something else, do this:
  - Which issue (B1 step 1, B7): one labelled `ready` and `for-agent` (`for-dot` for dot or Muse), not `blocked`, and not `claimed` unless the claim has run out (rule 3). No issue is assigned or labelled by computer.
  - Claim, Ready, review and Handover (B1 steps 1, 7 and 8, B6): [From claim to merge](#from-claim-to-merge) and rules 3, 7 and 14 ask for more: the claim's end time and the `claimed` label; `gh pr ready` and the preflight output with Ready; an answer to each finding in a comment and a merge of `main` before the new Ready; a push before a Handover, the checks run in it, and removing `claimed`.
  - Findings (B2): anyone may open an issue for a finding, including audit or test findings, with no limit, and there is no hold list ([When a finding becomes an issue](#when-a-finding-becomes-an-issue)); a finding outside the issues on the pull request stays out, even when it concerns the same files (CONTRIBUTING rules 2 and 9).
  - Merge (B1 step 9): the instruction "you never do" does not apply here. A collaborator with write access, the maintainer or the owner may review and merge as CONTRIBUTING rules 8, 9 and 12 permit; the maintainer handles release tags and the GitHub release.
  - Files (B1 step 3, B4): lanes own no files, and the string tables have no lane sections, so a new key goes in the same place in all three tables (AGENTS.md, Conventions in the code).
  - Tests (B1 step 4): only the test files your change touches, one run at a time; no full suite runs on your own computer, except `claude plugin test .` (AGENTS.md, Checks).
  - Stacked pull requests (B5): none. Branch from current `main` (rule 4) and claim the next issue only after your pull request merges ([One thing at a time](#one-thing-at-a-time)).
  - Blocked (B6): ask in a comment starting `Question:` and add the `question` label; while you wait, keep working on what the question does not touch, or hand over (CONTRIBUTING.md, Questions; rule 14). You need not end your session. Wenyu, named in B6, is the owner.
  - The `Agent:` trailer (B1 step 6, B7) is not required yet. Until CONTRIBUTING.md asks for it, the `Author:` line (rule 10) is what tells agents apart.

## One thing at a time

- Each author (an agent and its lane, CONTRIBUTING rule 10) works on one pull request at a time: one feature (it may span several issues), or two or three bug fixes, never more than three (CONTRIBUTING rule 2). It has at most one pull request waiting for review or CI. Claim the next issues after that pull request merges.
- An author has at most two open pull requests (CONTRIBUTING rule 10). Open pull requests stay at six or fewer; eight is the hard cap.
- Work in the next milestone only. Milestones after the next one are parked: no claims there until the release before them ships. An issue labelled `for-agent` is the exception: the maintainer labels it so an agent outside the team can take it whatever its milestone. Each new milestone opens with at most 15 issues, each with an owner, and the rest wait in Later.

## When a finding becomes an issue

Anyone may open an issue through the issue forms: a bug, something the board says that is untrue, or an idea. Search the open issues first: the same problem on another surface is a comment on the issue that already has it. Keep to one problem per issue, including findings from an audit or a test run. There is no limit on how many issues are open or opened in a day. A finding outside the pull request you are working on goes in an issue of its own or a comment on the issue that already has it, never into that pull request (CONTRIBUTING rule 2).

## Closing more than we open

Every day the maintainer posts one line on the roadmap issue (#209). It gives the issues opened and closed that day, the open total, the open count per milestone, the open pull requests and the review queue. `node scripts/team-stats.mjs --date <YYYY-MM-DD>` prints that line for one UTC day; without `--date` it counts the current UTC day so far. The aim is at least six issues closed a day, and twice as many closed as opened. An issue closes only with evidence: the pull request that fixed it and how that was checked.

## From claim to merge

Each step is one comment on GitHub, so an agent on another computer can see whose turn it is without a chat:

| Step | Who | Comment |
|---|---|---|
| Claim | author | `Claim: <agent>, <branch>, until <YYYY-MM-DD HH:MM> UTC` on each issue the pull request names, and the `claimed` label (CONTRIBUTING rule 3) |
| Draft | author | the pull request, opened as a draft |
| Ready | author | once the PR check and CI pass: `gh pr ready`, then a comment that starts `Ready for review <full head sha>`, with the preflight output under Checks |
| Take a review | anyone who may review except the author (CONTRIBUTING rule 8) | a comment `Reviewing: <GitHub login or agent>` on a pull request marked Ready (rule 9) |
| Review | reviewer | `Review: APPROVE <full head sha>` or `Review: REQUEST CHANGES <full head sha>`, naming the reviewer (`by <GitHub login or agent>`), with all findings at once (CONTRIBUTING rule 9); the reviewer is not the author (rule 8) |
| Changes | author | an answer to each finding in a comment, the fixes, a merge of `main`, then a comment that starts `Ready for review <new head sha>` |
| Merge | a collaborator with write access, the maintainer or the owner | a squash merge of the current head once the approval and checks required by CONTRIBUTING rule 9 hold, then the evidence on each issue; a pull request that changes `.github/workflows/` merges as CONTRIBUTING rule 12 says |

- Any collaborator with write access, the maintainer or the owner may take a Ready pull request it did not write; the maintainer and collaborators named in CONTRIBUTING [Roles](../../CONTRIBUTING.md#roles) may also have their own pull requests approved by a code-review subagent they run, under rule 8's conditions. The maintainer makes sure each one gets a verdict within four hours of Ready during the maintainer's day, and by the next morning at the latest, and reviews it itself when nobody else has. There is no review without the preflight output. Every reviewer starts from `node scripts/review-queue.mjs` at the start of each work block and after each merge, so no Ready pull request waits unseen. The same output ends with the lanes whose worktree is more than 2 hours old and whose branch has no open or draft pull request (the rule is a draft within 1 hour and a report at 2); a failed lookup prints a note and never hides a lane.
- A pull request that changes the board page's messages, the setup output or the one-line row summaries also needs `Acceptance: PASS <full head sha>` from a collaborator who did not write it, after walking the steps in #572 as a new user would (owner, 2026-10-30).
- A review asks for what the issue, [brief-rules.md](brief-rules.md), CONTRIBUTING.md and AGENTS.md require, and for anything in the diff that breaks behaviour. Anything else becomes a note for later, not another review round.
- After a second REQUEST CHANGES, the reviewer's next comment gives each change by file and line. The third round is the last: after it, the reviewer or the maintainer takes the branch over and finishes it, as in a handover (CONTRIBUTING rule 14). From then on whoever took it over has written part of the pull request, so the verdict comes from someone else (CONTRIBUTING rule 8).

## Merge order

When several pull requests are green, pull requests that change neither `hooks/board-script.ts` nor the string tables merge first, smallest first. Then pull requests that change either merge one at a time, the oldest Ready first. For each, the maintainer merges `main` into the branch and rebuilds the bundle with Bun 1.4.2. A new verdict is required unless the update only merges `main` without conflicts and with nothing else in the merge commit (CONTRIBUTING rules 4 and 9). Once the current head has passed the checks and has the approval rule 9 requires, a collaborator with write access, the maintainer or the owner may merge. Afterwards the maintainer comments "main moved, merge it" on the other open pull requests.

Nobody waits idle on CI. After an approval, start a background wait that merges with `--match-head-commit <sha>` once every check passes, and take the next pull request in the queue. When main moves, the maintainer may update a branch that is behind (`gh pr update-branch`). That gives the branch a new head, so the old wait cannot merge it: once the new head passes the checks, start a new wait pinned to it. The approval carries over only when the update merged `main` without conflicts (CONTRIBUTING rule 9).

## Flaky and slow tests

A test that fails in CI and passes on a rerun of the same head is flaky; a test that takes more than half its timeout in CI is slow. Either one gets a `bug` issue the same day, with the run links, the job, the system, and the time against the timeout; a later failure adds its run to that issue. Before a rerun, the run link and the test's title go in a comment on the pull request, and only the failed job is rerun, once. The fix is at the cause: what the test waits for, what it races with, what it reads before it is written. Raising a timeout, checking less, skipping the test, marking it todo or calling the machine slow is not a fix (owner, 2026-10-26).

## Pull requests from forks

Checks on a pull request from a fork wait for approval from a collaborator with write access, the maintainer or the owner, for every outside contributor and every push (the repository's Actions setting).

- **Approving a run.** A collaborator with write access, the maintainer or the owner may approve a held run; the maintainer looks for held runs at least once a day. Before approving, read the whole diff under Files changed, `.github/`, `scripts/` and `tests/` first: a pull request's own workflow files decide what its run does, and CI runs its own test files. Approve the run for the newest head only.
- **If many arrive at once.** The owner can limit issues, comments and pull requests to people who have contributed before, for one week: `gh api -X PUT repos/WenyuChiou/agent-board/interaction-limits -f limit=contributors_only -f expiry=one_week`. `gh api -X DELETE repos/WenyuChiou/agent-board/interaction-limits` lifts it. It is a brake for a flood, not a standing rule.
- **A pull request that skips the rules** gets one comment pointing to [CONTRIBUTOR-PATH.md](../CONTRIBUTOR-PATH.md) and what is missing. It is closed only if nothing changes in a week.

## Who takes which issue

- Issues labelled `for-dot` and `ready` suit an agent working only through GitHub: pure modules with plain Node tests, documentation in all three languages, and the Python reporter. The issue names the files allowed, the exact test titles and the fragment text.
- Host hooks, tests that start processes, `hooks/pane.tsx`, `hooks/register.tsx` and connect stay with agents that can run the plugin tests locally.
- The maintainer sets `for-dot` and `ready`, the claim adds `claimed`, and `blocked` means wait.

## How each agent is doing

Every week the maintainer posts, for each agent (`node scripts/team-stats.mjs --week` prints the table for the 7 UTC days ending on `--date`):

- pull requests merged;
- issues closed;
- the share of pull requests approved at the first review (aim: half or more);
- review rounds per pull request (aim: 1.5 or fewer);
- regressions (aim: none). A regression is an issue with a line that starts `Regression of #N` or `Caused by #N`, naming the merged pull request that caused it (CONTRIBUTING rule 11).

The agent is the words before the first comma of the pull request's `Author:` line (CONTRIBUTING rule 10), so write them the same way every time; a pull request without the line counts as `unknown`.

An agent below these aims two weeks running takes smaller issues for a while: one at a time, a single module with Node tests, and briefs whose Checks the maintainer writes. It goes back to normal after two first-review approvals in a row.

<!-- part-b:start source=PROJECT_WORKFLOW.md sha256=f6a68dab110a00e3d81c3f9c3105148ed54791da521a49aabc85c38600b46712 -->
## Part B — contributors (copied into each repo's workflow file)

### B1. The steps
1. **Claim**: comment `Claim: <agent>, <branch>, until <UTC time>` on each issue the PR will fix (B3) and add the repo's claim label. Take only issues assigned to you or labelled for your computer.
2. **Branch**: one branch per PR from current `main`, in your own worktree.
3. **Fix**: change only the files the issues name, or your lane's files (B4).
4. **Test**: run the tests that cover the files you changed; full suites run in CI. At most 2 full local suites at once on one computer; if CPU stays above 85 % for 5 minutes, start no new run. Stop every test process you started when you are done.
5. **Changelog**: add one fragment file per issue, `changelog.d/<issue>-<slug>.md`; never edit `CHANGELOG.md`.
6. **PR**: open it as a draft, with one `Fixes #N` or `Part of #N` line per issue, an `Author: <agent>, <branch>` line, an `Agent: <name> (<lane>)` trailer line for the merge commit, and the evidence (command output, screenshot, or the test names that cover it).
7. **Ready**: when CI is green, comment `Ready for review <sha>`.
8. **Review**: answer every finding in one push, then comment `Ready for review <new sha>`.
9. **Stop there.** The coordinator merges, tags and releases; you never do.

### B2. Findings
Open an issue only where the repo's rules tell you to (agent-board: when no issue fits the change you are about to make). Put any other finding on the hold list or as a comment on your PR or one of its issues; the coordinator files it if it qualifies. A finding in the same files that the same tests already cover may be fixed in your PR and named in its body, if B3 lets it join this PR (same kind, and a bug-fix PR keeps at most three fixes). An audit or test run hands in one list, not a batch of issues.

### B3. What goes in one PR
- A new feature gets one branch and one PR, even when it spans several issues. Unrelated features stay in separate PRs.
- Bug fixes go two or three to a PR when several are waiting, never more than three; a lone or urgent fix may go by itself. Any other small issue (a small improvement, docs, a refactor, tests) follows the same rule with issues of its own kind, unless it belongs to a feature's PR. An improvement that spans several issues counts as a feature.
- Never put a bug fix in a feature PR, so fixes can ship in a patch release while features wait.
- In the PR body, give each issue its own `Fixes #N` or `Part of #N` line and its evidence (B1 step 6).
- If review finds a problem in one issue, take that issue out of the PR (its changes, its changelog fragment and its `Fixes #N` or `Part of #N` line) and say so on the issue; fix it later in another PR, and do not hold up the rest.
- One branch per PR, and at most one PR of yours waiting for review or CI.

### B4. Shared files
- The repo file lists which files each lane owns. A PR that changes another lane's files needs one of its issues to name that lane.
- Locale mirrors (the same text in several languages) change together in one PR. In string tables, add new keys at the end of your lane's section.
- Bring your branch up to date by merging `main`; never rebase a pushed branch. The coordinator may merge `main` into your branch too: run `git pull --ff-only` before your next commit.
- Regenerate generated files with the repo's build command; never resolve them by hand.

### B5. Stacked PRs
At most one level, same lane, and the upper PR stays draft until the lower one merges. When the lower PR merges and its branch is auto-deleted, GitHub points the upper PR at `main`. Then:
1. check `gh pr view <N> --json baseRefName` says `main`; if not, `gh pr edit <N> --base main`;
2. merge `main` into the upper branch (after a squash merge, expect conflicts where your commits re-edit the lower PR's lines; regenerate generated files rather than resolving them);
3. push and comment `Ready for review <new sha>`.

### B6. When you are blocked
If you have waited on Wenyu for more than 30 minutes (waiting for CI, or for review while your PR is in the coordinator's queue, does not count), post on your PR or one of its issues either `Question: <one question>` or `Handover: <branch>, done: …, left: …`, and end your session. If you cannot push, add `worktree: <path>, head: <sha>` to the Handover. The coordinator brings the question to Wenyu and hands the work on. Never wait open-ended.

### B7. Agents on other computers
- If it is not on the issue or the PR, it did not happen. Local notes never hold a decision another computer needs.
- Take only issues labelled for your computer; they touch pure modules, docs or scripts you can test yourself.
- If you post from the coordinator's GitHub account, the `Author:` line and `Agent:` trailer are how your work is told apart.
<!-- part-b:end -->
