# How work moves

This page sets how much work is open at once, when a finding becomes an issue, and how a pull request goes from claim to merge. It applies to every agent and person working in this repository: Claude Code sessions, Codex, dot and Muse, and agents on other computers. [CONTRIBUTING.md, Pull requests](../../CONTRIBUTING.md#pull-requests) has the rules each pull request must meet; where the two disagree, CONTRIBUTING.md wins.

## One thing at a time

- Each author (an agent and its lane, CONTRIBUTING rule 10) works on one issue at a time and has at most one pull request waiting for review or CI. Claim the next issue after that pull request merges.
- An author has at most two open pull requests (CONTRIBUTING rule 10). Open pull requests stay at six or fewer; eight is the hard cap.
- Work in the next milestone only. Milestones after the next one are parked: no claims there until the release before them ships. Each new milestone opens with at most 15 issues, each with an owner, and the rest wait in Later.

## When a finding becomes an issue

A finding becomes a new issue only if it:

- loses the person's work or data,
- tells the person something untrue, or
- blocks an open pull request.

Anything else you find goes in a comment on your own issue (CONTRIBUTING rule 2), and the maintainer files it if it qualifies. The same problem on another surface is a comment on the issue that already has it. An audit or a test run that finds many problems hands in one list in a comment, not a batch of issues. Until fewer than 60 issues are open, at most three new issues a day. An issue that CONTRIBUTING.md requires (a merge without an approving review, rule 9; undoing a merged pull request, rule 11) is always allowed and does not count toward that limit.

## Closing more than we open

Every day the maintainer posts one line on the roadmap issue (#209). It gives the issues opened and closed that day, the open total, the open count per milestone, the open pull requests and the review queue. `node scripts/team-stats.mjs --date <YYYY-MM-DD>` prints that line for one UTC day; without `--date` it counts the current UTC day so far. The aim is at least six issues closed a day, and twice as many closed as opened. An issue closes only with evidence: the pull request that fixed it and how that was checked.

## From claim to merge

Each step is one comment on GitHub, so an agent on another computer can see whose turn it is without a chat:

| Step | Who | Comment |
|---|---|---|
| Claim | author | `Claim: <agent>, <branch>, until <YYYY-MM-DD HH:MM> UTC` on the issue, and the `claimed` label (CONTRIBUTING rule 3) |
| Draft | author | the pull request, opened as a draft |
| Ready | author | once the PR check and CI pass: `gh pr ready`, then a comment that starts `Ready for review <full head sha>`, with the preflight output under Checks |
| Review | reviewer | `Review: APPROVE <full head sha>` or `Review: REQUEST CHANGES <full head sha>`, naming the reviewer (`by owner`, `by maintainer` or `by code-review subagent`), with all findings at once (CONTRIBUTING rule 9) |
| Changes | author | an answer to each finding in a comment, the fixes, a merge of `main`, then a comment that starts `Ready for review <new head sha>` |
| Merge | maintainer | a squash merge of the exact head named in `Review: APPROVE`, then the evidence on the issue; a pull request that changes `.github/workflows/` merges as CONTRIBUTING rule 12 says |

- The maintainer gives a verdict within four hours of Ready during the maintainer's day, and by the next morning at the latest. There is no review without the preflight output.
- A review asks for what the issue, [brief-rules.md](brief-rules.md), CONTRIBUTING.md and AGENTS.md require, and for anything in the diff that breaks behaviour. Anything else becomes a note for later, not another review round.
- After a second REQUEST CHANGES, the maintainer's next comment gives each change by file and line. The third round is the last: after it, the maintainer takes the branch over and finishes it, as in a handover (CONTRIBUTING rule 14). From then on the maintainer has written part of the pull request, so its verdict comes from a code-review subagent or the owner (CONTRIBUTING rule 8).

## Merge order

When several pull requests are green, pull requests that change neither `hooks/board-script.ts` nor the string tables merge first, smallest first. Then pull requests that change either merge one at a time, the oldest Ready first. For each, the maintainer merges `main` into the branch, rebuilds the bundle with Bun 1.4.2, reviews the new head and comments `Review: APPROVE <new head sha>` (CONTRIBUTING rules 4 and 9), waits for CI and merges. Afterwards the maintainer comments "main moved, merge it" on the other open pull requests.

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
