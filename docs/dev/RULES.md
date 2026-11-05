# Agent Board rules, on one page

Every person and every agent reads this page first. The longer pages ([CONTRIBUTING.md](../../CONTRIBUTING.md), [team-process.md](team-process.md), [RELEASING.md](../RELEASING.md), [CONTRIBUTOR-PATH.md](../CONTRIBUTOR-PATH.md)) explain the details. When one of them changes a rule here, it changes this page in the same pull request; the PR check fails otherwise (R5). Each rule is written in one place: [docs/README.md](../README.md) lists every file and what it is for, and another page links to a rule instead of repeating it, so two copies cannot drift apart.

## Start here

- **What it is.** Agent Board shows what every coding agent on a computer is doing, on one board. Try it: `npx @wenyuchiou/agent-board setup`.
- **Find work.** Take an open issue labelled `ready` that has no assignee. The team assigns itself: that is its claim (R4). A contributor outside the team, who cannot assign themselves, claims with a `Claim:` comment ([CONTRIBUTING rule 3](../../CONTRIBUTING.md#pull-requests)). Work mainly on your own issues.
- **Talk on the issue.** Questions, hand-overs and decisions go in comments on the issue or its pull request. If it is not on GitHub, the next person cannot see it.
- **What a feature must be.** The owner's product rules are in [product-principles.md](product-principles.md). Read them before you design or change anything that a person or an agent sees.
- **Done means closed.** The pull request says `Fixes #N`; the issue closes when it merges, with how the change was checked.

## Every agent follows the same rules

- Claude Code, Codex, Antigravity, Cursor, cloud agents such as dot and Muse, and people by hand all follow this page. No rule here depends on which agent you are.
- **Where an agent starts.** [AGENTS.md](../../AGENTS.md) is the entry point; it sends you here first. Codex, Antigravity and Cursor read `AGENTS.md` by themselves. Claude Code does not: the repository is also a Claude Code plugin, whose root `CLAUDE.md` is not loaded, so a Claude Code session is given this page's link in its first prompt, or its user adds `@AGENTS.md` to their own `CLAUDE.md`. The same goes for any other agent that reads neither.
- **An agent works in the role of the person who runs it** (CONTRIBUTING, [Roles](../../CONTRIBUTING.md#roles)). An agent of the owner or of a collaborator may review and merge other authors' pull requests, as that person may.
- **One GitHub account, many agents.** The owner runs many different agents from one GitHub account, and a collaborator may do the same from theirs, so GitHub cannot tell the agents apart and its own approval button is not used. The `Author: <agent>, <branch>` line of a pull request says who wrote it, and the `by <name>` of a `Review:` line says who reviewed it. Name the agent and where it runs, as in `claude (desktop)` or `codex (superd6)`. A person working by hand writes their own name, as in `Author: eric, <branch>` or `by eric`; when a person has an agent do the work, the agent's name goes there.
- **Who counts as the author.** The agent named in the `Author:` line, every agent it dispatched, and every agent that wrote part of the pull request or its brief. Any other agent or session, of the same person or not, is not an author and may review and approve it (R2). R2 has one exception: on a lane's own pull requests, a read-only reviewer the lane starts new for that review may approve, although the lane dispatched it.
- **One driver per pull request.** The agent in the `Author:` line drives its pull request to the merge. Another agent continues it only after a `Handover:` from that agent ([CONTRIBUTING rule 14](../../CONTRIBUTING.md#pull-requests)), or after 24 hours with no word from it, or as [team-process, From claim to merge](team-process.md#from-claim-to-merge) says after a `Review: REQUEST CHANGES`; it then adds its own name to the `Author:` line and says so in a comment. Two agents never push to one branch at the same time.
- **Status goes in the body.** After a push, update the pull request body's Evidence for the new head instead of posting a status comment. Comments on a pull request are for `Ready for review`, `Reviewing:`, `Review:`, `Handover:` and `Question:` lines, and for answers to review findings.

## R1. Who decides what

- The owner (Wenyu) sets direction: the roadmap, the must-ship issues of each milestone, and rules R2 and R3. A question that only the owner can answer gets the `needs-owner` label; there should be few.
- The owner's approval is needed only for what decides who may approve and merge, and what CI may do: `.github/workflows/`, sections R2 and R3 of this page, CONTRIBUTING rules 8, 9 and 12, and the team-process sections From claim to merge and Standing approvals ([CONTRIBUTING rule 12](../../CONTRIBUTING.md#pull-requests)). The roadmap is the owner's too (above): issue #209 and [universal-messaging-roadmap.md](universal-messaging-roadmap.md). So are the product rules in [product-principles.md](product-principles.md).
- **The owner writes the owner's approval by hand.** No agent posts an approval in the owner's name, not even when the owner asks for it in a chat: the owner writes it on the issue or the pull request themselves (CONTRIBUTING rule 12; owner, 2026-11-03).
- **There is no project manager.** No agent decides scope or order for another. The issue's milestone and labels set the order; when two agents disagree, the reviewer decides, and only a question about the roadmap or a milestone's scope gets `needs-owner`. A comment on someone else's pull request from anyone not reviewing it is advice.
- Everything else is decided by the people doing the work: collaborators, the maintainer session and their agents. A change to process details (labels, merge order, wording) needs one approval from an agent or person who did not write it.

## R2. Nobody approves their own work

- The author never approves their own pull request. A review by the author's own agent, lane or subagent does not count, except a lane's own reviewer on that lane's own pull requests (below).
- A review bot (Codex Code Review, Greptile) can stop a merge with an unresolved P0 or P1, but never approves one.
- The approval is the comment `Review: APPROVE <full head sha> by <name>`, where `<name>` is not an author of the pull request.
- **The one exception: a lane's own reviewer** (owner: 2026-11-03 and 2026-11-04 for the maintainer lane, 2026-11-04 for every lane). A lane is the owner or any collaborator (anyone the owner has given write access to this repository, CONTRIBUTING rule 8) working by hand, or one of their agents, together with the agents it dispatches, such as the maintainer session, dot, Muse, or a Codex or Antigravity lane. A contributor without write access has no lane: their pull requests still need an approval from a collaborator, the maintainer or the owner, or one of their agents, that wrote none of it (rule 8). The exception covers a pull request whose every author (above) is one lane, with no part written by another agent or person and no handover from one. On such a pull request, the verdict of a reviewer the lane runs for that head counts. That reviewer is a read-only Codex run or a subagent, started new for this review: never a resumed session or agent that wrote or briefed any part of the pull request. It writes nothing, so the lane posts its verdict for it. Its verdict counts only when:
  - the reviewer read the exact head the verdict names, in full, and read for itself on GitHub the issues named on the pull request's first lines and the test evidence for that head (its CI runs and the preflight output in the body), not a summary the lane wrote;
  - the reviewer read every P0 or P1 finding on the pull request, from a bot or anyone else, and every `Question:` about it, on the pull request or on an issue named on its first lines, each with the author's answer, and agrees that each finding is fixed in the head or does not apply, and that each question is answered. A finding or question settled this way does not wait for whoever raised it to come back; a question only the owner can answer (R1) still waits for the owner;
  - the reviewer approved. When the lane disagrees with one of its findings, the approval comes from a reviewer who is not an author, as usual. The lane posts every verdict its reviewers give on the pull request, `Review: REQUEST CHANGES` included, and a reviewer it starts later for the same pull request is given every earlier reviewer's findings as posted: a lane does not keep starting new reviewers in search of an approval;
  - the lane posts it as `Review: APPROVE <full head sha> by <reviewer and model>, <lane>'s reviewer`, followed by every finding the reviewer reported, or "no findings", and what was done with each: applied in which commit, or not applied and why; then each P0, P1 and `Question:` from others, with a link to its answer.

  Everything else still applies: rule 9's conditions before a merge, rule 12's owner approval of governance files and workflows, and a bot's P0 or P1 (below). A P0, P1 or `Question:` that arrives after the approval holds the merge until a reviewer the lane starts new for it, given every earlier finding, agrees as above that it is fixed or answered. It does not cover a release pull request, which keeps an approval from someone who did not write it ([RELEASING.md](../RELEASING.md)). Anyone may still review after the merge; a finding then becomes an issue.

  Each day that another lane has a pull request merged under this exception that nobody outside that lane has read in full, the maintainer reads at least one, oldest first; each day that the maintainer lane has one, dot reads at least one the same way (owner, 2026-11-04). Anyone outside a lane may read that lane's at any time. The reader posts `Review: APPROVE <merge commit sha> by <reader>, read in full outside <lane>` on the merged pull request, or opens an issue for a P0 or P1 (below). Before each release, and before the release pull request's last simulated-user run starts ([RELEASING.md](../RELEASING.md), step 5), every pull request merged under this exception since the last release tag and not yet read that way is read in full by someone outside its lane: the maintainer reads the other lanes', and the release pull request's reviewer reads the maintainer lane's (owner, 2026-11-04). The release pull request's body lists every one of them, with its merge commit, who read it and any issue opened. A P0 or P1 that the lane's reviewer missed, found either way, becomes an issue, and from then on that lane's pull requests need an approval from a reviewer who is not an author, until the owner says otherwise on that issue. One found before the release pull request's last simulated-user run starts holds the release until its fix has merged; one found after that goes to the next release, unless the owner decides otherwise.
- **A review stays on the pull request's issue.** Each finding in a `Review: REQUEST CHANGES` names the rule it breaks or the steps that show the bug. A finding with neither is advice: welcome, but it does not hold the merge.
- A later round checks the earlier findings and what the new push changed. Something new found in code that an earlier round already read becomes an issue of its own, unless it is a P0 or P1.
- A review bot's P0 or P1 that arrives after Ready is fixed, or the author shows on the pull request, with evidence, why it does not apply; the reviewer decides.

## R3. Merging

- A pull request merges once every required check is green on its current head and someone other than the author has approved that head (CONTRIBUTING rules 8 and 9), or, on a lane's own pull request, the lane's reviewer has as R2 says. Then anyone with write access may merge it, the author included: any collaborator, the maintainer, the owner, or any of their agents. Nobody waits for a particular person.
- A change to `.github/workflows/` also needs the owner's approval, because a workflow can widen what CI may do (CONTRIBUTING rule 12).

## R4. One issue, one owner

- The team assigns itself before it starts; one assignee per issue. A contributor outside the team claims with a `Claim:` comment instead (CONTRIBUTING rule 3). If someone is assigned or holds a live claim, comment on the issue instead of starting a competing pull request.
- An issue with no activity from its assignee for 24 hours may be unassigned by anyone, with a comment, and goes back to `ready`.
- **A plan is an issue.** Whoever has a plan opens an issue with its goal, what counts as done and the files it touches; a large plan becomes one issue per step.
- **Who adds `ready`.** Any agent or person on the team who did not write the issue may add `ready` to it, after posting a comment on it that starts `Ready check:` and answers four points: the goal is clear; the issue says what counts as done; no question is open and nothing it waits on is still unmerged; and it fits the current roadmap (#209) and its milestone, with no conflict or drift. An issue that would change the roadmap or a milestone's scope gets `needs-owner` instead, and only the owner makes it `ready` (R1).
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
- **a simulated user.** An AI acting as a new user installs the release's package, sets up, opens the board and walks every journey, on Windows and on macOS or Linux, as [USER-SIM.md](../validation/USER-SIM.md) says. Its record is `docs/validation/<date>-usersim-<version>.md`. Any agent or person may run it. A FAIL, or a FRICTION step with no issue, stops the release. After a change to the release pull request's head, a run may cover only the journeys the change reaches; after two such runs in a row the next is full, and so is the run before a stable release. Once the run meant to be the last starts, nothing but the release pull request merges into `main` until the tag.

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
- **Checks.** The PR check fails a pull request that adds a home-folder path, a session id, a token or an email address to a document or its body. Once the owner turns them on in the repository's settings, GitHub's secret scanning and push protection will also stop a known kind of token before it lands; they are not on yet.
