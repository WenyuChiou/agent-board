# Part B — contributor steps

This page holds Part B of the multi-agent workflow standard that this repository's maintainer keeps on the owner's computer: the steps the standard asks of every contributor. It is a copy, kept in sync with the standard by the hash in the first line of the block below, so do not edit the block here. [team-process.md](team-process.md) is Part A, and where it or CONTRIBUTING.md says something different, they win.

<!-- part-b:start source=PROJECT_WORKFLOW.md sha256=f6a68dab110a00e3d81c3f9c3105148ed54791da521a49aabc85c38600b46712 -->
## Part B — contributors (copied into each repo's workflow file)

### B1. The steps
1. **Claim**: comment `Claim: <agent>, <branch>, until <UTC time>` on each issue the PR will fix (B3) and add the repo's claim label. Take only issues assigned to you or labelled for your computer.
2. **Branch**: one branch per PR from current `main`, in your own worktree.
3. **Fix**: change only the files the issues name, or your lane's files (B4).
4. **Test**: run the tests that cover the files you changed; full suites run in CI. At most 2 full local suites at once on one computer; if CPU stays above 85 % for 5 minutes, start no new run. Stop every test process you started when you are done.
5. **Changelog**: write the title as what changed for the person; the release writes the CHANGELOG line from it. Add no `changelog.d/` file.
6. **PR**: open it as a draft, with one `Fixes #N` or `Part of #N` line per issue, an `Author: <agent>, <branch>` line, an `Agent: <name> (<lane>)` trailer line for the merge commit, and the evidence (command output, screenshot, or the test names that cover it).
7. **Ready**: when CI is green, comment `Ready for review <sha>`.
8. **Review**: answer every finding in one push, then comment `Ready for review <new sha>`.
9. **Stop there.** The coordinator merges, tags and releases; you never do.

### B2. Findings
Open an issue only where the repo's rules tell you to (agent-board: when no issue fits the change you are about to make). Put any other finding on the hold list or as a comment on your PR or one of its issues; the coordinator files it if it qualifies. A finding in the same files that the same tests already cover may be fixed in your PR and named in its body, if B3 lets it join this PR (same kind, and a bug-fix PR keeps at most three fixes). An audit or test run hands in one list, not a batch of issues.

### B3. What goes in one PR
- A new feature gets one branch and one PR, even when it spans several issues; a risk-tier feature that needs more than one failure surface goes in steps, one surface per PR, unless the maintainer or the owner accepts a `cannot split:` reason (CONTRIBUTING rule 2). Unrelated features stay in separate PRs.
- Bug fixes go two or three to a PR when several are waiting, never more than three, and risk-tier fixes only when they share a failure surface (CONTRIBUTING rule 2); a lone or urgent fix may go by itself. Any other small issue (a small improvement, docs, a refactor, tests) follows the same rule with issues of its own kind, unless it belongs to a feature's PR. An improvement that spans several issues counts as a feature.
- Never put a bug fix in a feature PR, so fixes can ship in a patch release while features wait.
- In the PR body, give each issue its own `Fixes #N` or `Part of #N` line and its evidence (B1 step 6).
- If review finds a problem in one issue, take that issue out of the PR (its changes and its `Fixes #N` or `Part of #N` line) and say so on the issue; fix it later in another PR, and do not hold up the rest.
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
