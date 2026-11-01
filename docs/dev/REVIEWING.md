# Reviewing a pull request

Any agent or person who may review (CONTRIBUTING rule 8) follows this page: Claude Code, Codex, Antigravity, Cursor, dot, or a person by hand. It is the same review whoever runs it, so nobody needs a prompt pasted each time. [RULES.md](RULES.md) R2 and R3 are the rules behind it; [CONTRIBUTOR-PATH.md, step 11](../CONTRIBUTOR-PATH.md#11-review-and-merge-someone-elses-pull-request) has the commands.

## Who may review

- Not the author. The author is the agent in the `Author:` line, every agent it dispatched, and every agent that wrote part of the pull request or its brief. Their review does not count, whoever's account it posts from.
- Another agent may review, even one of the same person and on the same GitHub account. Because the owner's agents all post from one account, GitHub cannot tell them apart; the names can. The author's name is the agent before the first comma of the body's `Author:` line, with its lane in brackets (`claude (cloud)`); the reviewer's is the name after `by` in the verdict (`codex (desktop)`). Use the same name every time you work here.
- A review bot (Codex Code Review, Greptile) is input, never an approval.

## When to review

Nobody hands you a review. At the start of each work block, and after each merge, run the queue and take what waits there before new work of your own (team-process, From claim to merge). This is how pull requests move while the owner is away.

## Before you start

1. Run `node scripts/review-queue.mjs` and take a pull request marked `Ready for review <full head sha>` that nobody is reviewing.
2. Comment `Reviewing: <agent or GitHub login>`, so nobody does the same work. Say so if you stop.
3. While you review, do not push to the branch, and do not merge. Findings go in your verdict; the author fixes them.

## What you check

- [ ] **Scope.** The diff does what the issues on the body's first lines ask: those issues, nothing extra, and no bug fix inside a feature. Anything else is a must-fix: take it out, or open an issue for it.
- [ ] **Rules.** Nothing in the diff contradicts [RULES.md](RULES.md), CONTRIBUTING.md, [team-process.md](team-process.md) or [RELEASING.md](../RELEASING.md). A change to one of those three also changes RULES.md, or the body says `Rules page: unchanged, <reason>`.
- [ ] **Governance.** A change to `AGENTS.md`, `CONTRIBUTING.md`, `.github/` or the governance sections of team-process.md quotes the owner's approval of that content in the body, with its date and where it was given (CONTRIBUTING rule 12).
- [ ] **Tests and CI.** The tests named in the body exist and cover the change. Every required check is green on the current head; a skipped, cancelled or missing check is not a pass.
- [ ] **Review bots.** Every P0 or P1 from Codex or Greptile is fixed in the head, or the author explains on the pull request why it does not apply. If a bot did not review this head, run a code review of it yourself and post the result.
- [ ] **Users.** A change to the board page's messages, the setup output or the row summaries has its USER-SIM rows under Checks ([USER-SIM.md](../validation/USER-SIM.md)), with no FAIL and an issue for each FRICTION.
- [ ] **Off GitHub.** No session log, home-folder path, email address, personal setting or token in the diff, the body or a picture ([RULES.md, R8](RULES.md#r8-what-stays-off-github)).
- [ ] **Behaviour.** Nothing in the diff breaks what already works. Anything that is not a must-fix becomes a note for later, not another review round.

## Your verdict

Post one comment with every finding at once, starting with one of these lines:

```text
Review: APPROVE <full head sha> by <agent or GitHub login>
Review: REQUEST CHANGES <full head sha> by <agent or GitHub login>
```

Under an approval, say what you verified. Under a request for changes, give each finding by file and line. A later push needs a new verdict, unless it only merged `main` without conflicts.

## Merging

After the verdict, merging is a separate step, and any agent or person who may merge (CONTRIBUTING rule 8) may take it, the reviewer included. First run the review gate:

```sh
node scripts/pr-check.mjs --pr <PR> --review-gate
```

It fails unless the newest verdict approves the current head and names someone other than the author. Merge only when it passes and every required check is green on that head, as CONTRIBUTOR-PATH step 11 says (`gh pr merge <PR> --squash --match-head-commit <head sha>`). Never use an administrator's bypass.

## When you have to stop

Usage running out is the usual reason; any reason counts. Before you stop, on each issue and pull request you hold:

1. Push your branch.
2. Comment `Handover: <branch>, last commit <sha>, done: …, left: …, checks run: …` (CONTRIBUTING rule 14).
3. Unassign yourself, so the next agent or person can take it from the queue.

If you could not do this, anyone may unassign you after 24 hours without activity, with a comment (RULES.md, R4).

## Prompt to give an agent

```text
Review pull request <PR> of WenyuChiou/agent-board as docs/dev/REVIEWING.md says.
You are not its author. Name yourself in the verdict. Do not push to its branch while you review.
```
