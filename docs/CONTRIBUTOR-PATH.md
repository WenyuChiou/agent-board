# From an issue to a merged pull request

This page is for a person or an agent working on Agent Board from another computer, with `git`, `gh` (logged in to GitHub) and Node 22.18+ or 24. It gives the commands for [CONTRIBUTING.md, Pull requests](../CONTRIBUTING.md#pull-requests); where the two disagree, CONTRIBUTING.md wins. Every command runs as written in bash on Linux and in Git Bash on Windows. On macOS, the `date` in step 2 is the one command known to differ; it falls back to macOS's own form (`-v`). macOS has not been tried. Nothing here needs Claude Code, files on the maintainer's computer or a chat: everything happens in the repository, its issues and its pull requests.

Below, `<agent>` is your name in lower case: your agent's name (`codex`, `dot`, `muse`, `cursor`), or your GitHub login if you work by hand. An agent working for someone outside the team adds that person's GitHub login in brackets (`claude (octocat)`). An agent that a coordinating session sent adds that session's lane in brackets (`codex (phase1)`). `<N>` is the issue (each issue, when your pull request names several), `<PR>` your pull request and `<branch>` your branch, named `<type>/<short-slug>` (`fix/question-ledger-write`).

## How a pull request moves

[docs/dev/team-process.md](dev/team-process.md) gives the rules for each step from claim to merge: the comment each step leaves on GitHub, how many pull requests you may have waiting, when the review verdict comes, how many review rounds there are, the order pull requests merge in, and which issues dot takes. This page gives the commands you run at each step.

## 1. Find work

```sh
gh issue list -R WenyuChiou/agent-board --state open --label ready --label for-agent
gh issue list -R WenyuChiou/agent-board --state open --label ready --label for-dot     # dot or Muse (rule 3)
```

Take one from the first list (the second is kept for the owner's cloud agents, dot and Muse), without `claimed` or `blocked`. An empty first list means no issue is open to agents outside the team right now; the maintainer adds `for-agent` when one is. Meanwhile bug reports and ideas are welcome through the issue forms, and you may open an issue for a change you would like to make and say you would like to take it. The issue's body says what to change and what is out of scope, the **Acceptance tests** (the test titles your pull request adds), the **Executor** and what it is **Blocked by**. The body is the current scope. If a comment seems to change it, ask (step 8).

## 2. Claim it

```sh
gh pr list -R WenyuChiou/agent-board --state open
gh issue view <N> -R WenyuChiou/agent-board --comments
```

Go on only if nobody has an open pull request for the issue or a `Claim:` whose time has not passed, you have no issue in progress outside this pull request (claim the next only after your last pull request merges), the issue is in the next milestone (later milestones are parked; an issue labelled `for-agent` is open to you whatever its milestone), and you have a free slot ([docs/dev/team-process.md, One thing at a time](dev/team-process.md#one-thing-at-a-time)). A slot is rule 10: at most two open pull requests per author and eight in all. Drafts count; release pull requests, governance pull requests and those labelled `cap-exempt` do not. Keep open pull requests at six or fewer; eight is the hard cap. One pull request covers one feature (even when it spans several issues) or two or three bug fixes, never more than three; claim every issue it will name, with the same branch ([CONTRIBUTING.md](../CONTRIBUTING.md#pull-requests) rules 2 and 3). Then claim each one, at most two days ahead:

```sh
until=$(date -u -d '+1 day' '+%Y-%m-%d %H:%M' 2>/dev/null || date -u -v+1d '+%Y-%m-%d %H:%M')
gh issue comment <N> -R WenyuChiou/agent-board --body "Claim: <agent>, <branch>, until $until UTC"
gh issue edit <N> -R WenyuChiou/agent-board --add-label claimed
```

If `gh issue edit` says you cannot change labels, say so in a second comment; the maintainer sets them. To keep a claim longer, post a new `Claim:` before yours runs out. With no free slot, claim it this way instead; such a claim runs out 7 days after its comment unless you post it again:

```sh
gh issue comment <N> -R WenyuChiou/agent-board --body "Claim: <agent>, <branch>, waiting for a slot"
```

A claim whose time has passed, with no pull request, may be taken over: comment `Claim taken over: <agent>, <branch>` and go on. If an earlier claim turns up after yours, withdraw yours in a comment. If someone has an open pull request or a live claim, do not start a competing one: comment on theirs.

## 3. Branch and make the change

```sh
git clone -c core.autocrlf=false https://github.com/WenyuChiou/agent-board.git
cd agent-board
git switch --no-track -c <branch> origin/main
```

`core.autocrlf=false` keeps the files byte for byte as they are in the repository; without it, the bundle check fails on Windows. `--no-track` keeps the new branch from following `main`, so `git push -u` in step 6 sets where it goes.

If you cannot push to the repository, fork it from inside the clone:

```sh
gh repo fork --remote
```

Your fork is then `origin` and this repository `upstream`. From then on:

- fetch with `git fetch upstream` and merge `upstream/main` wherever this page fetches `origin` and merges `origin/main`;
- add `--base upstream/main` to `node scripts/pr-check.mjs --body-file …`;
- run `git fetch upstream` first, then add `--base upstream/main --no-fetch` to `node scripts/preflight.mjs …`, which otherwise fetches `main` from `origin`, your fork.

GitHub holds the PR check and CI on a pull request from a fork until a maintainer approves each run (step 6).

Follow [AGENTS.md](../AGENTS.md), Working on this repository, for where code goes and how it is written. A change to `AGENTS.md`, `CONTRIBUTING.md` or anything under `.github/` needs the owner's written approval of its content, quoted in the pull request body ([CONTRIBUTING.md](../CONTRIBUTING.md#pull-requests) rule 12). Use synthetic data only: made-up projects, sessions and paths.

## 4. Run the checks

Point every home folder at a scratch folder before you run any test or `claude` command in this checkout. Claude Code with this plugin connects the agents it finds when it starts. With only its own folder moved, it rewires your computer's real Codex, Gemini, Cursor and Hermes hooks to the scratch folder, and they break when you remove it (#212). This function sets all of them for one command:

```sh
S=$(mktemp -d)
iso() { env HOME="$S" USERPROFILE="$S" HERMES_HOME="$S/hermes" GROK_HOME="$S/grok" OPENCLAW_STATE_DIR="$S/openclaw" CODEX_HOME="$S/codex" OPENCODE_CONFIG_DIR="$S/opencode" DSH_HOME="$S/dsh" XDG_CONFIG_HOME="$S/xdg" LOCALAPPDATA="$S/local" APPDATA="$S/roaming" CLAUDE_PROGRESS_FILE="$S/progress.md" CLAUDE_CONFIG_DIR="$S/claude" "$@"; }
```

From the test lines below, run only the test files your change touches, one run at a time (AGENTS.md, Checks); CI runs affected groups and reports omitted groups as not run (see [affected CI](dev/CI.md)). Then run the two generated-file checks:

```sh
iso node --test tests/exchange.test.mjs tests/messaging.test.mjs
iso node --test tests/board.test.mjs tests/board-storage.test.mjs tests/codex-local.test.mjs tests/local-lock.test.mjs tests/prompt-hooks.test.mjs tests/codex-host.test.mjs tests/codex-fallback.test.mjs tests/legacy-connect.test.mjs tests/connect-worker.test.mjs
iso node --test tests/pr-check.test.mjs tests/preflight.test.mjs tests/changelog-fold.test.mjs tests/team-stats.test.mjs
iso node --test tests/npm-package.test.mjs
iso node --test "tests/e2e/*.test.mjs"
npx --yes bun@1.4.2 scripts/build-board.ts --check
git fetch --tags origin
npx --yes bun@1.4.2 scripts/build-released.ts --check
```

The installer checks and the type check the template lists are in [CONTRIBUTING.md, Run the checks](../CONTRIBUTING.md#run-the-checks).

If you changed `scripts/board-cli.ts` or a `hooks/` file it imports, rebuild the bundle with `npx --yes bun@1.4.2 scripts/build-board.ts` and commit `hooks/board-script.ts` together with the change.

When the plugin group is selected, CI runs `claude plugin validate --strict .` and `claude plugin test .` on Ubuntu (both systems on `main` and release PRs). To run them yourself, install the version CI pins, then run both through `iso` (offline, no login, several minutes):

```sh
npm install -g @anthropic-ai/claude-code@2.1.301
iso claude plugin validate --strict .
iso claude plugin test .
```

If you do not run them, write `not run:` and why in the pull request.

A test that fails once and passes on its own rerun is reported as both, never as a pass.

In CI, such a test is flaky. Before you rerun it, comment on your pull request with the run link and the test's title, then rerun only the failed job, once. The same day, open a `bug` issue for it, or add your run to the issue already open for that title, with the job, the system, how long it ran and its timeout. A flaky or slow test is fixed at its cause: what it waits for, what it races with, what it reads before it is written. Raising a timeout, checking less, skipping it or marking it todo is not a fix. A test that takes more than half its timeout in CI counts as slow and gets the same issue.

Known traps, all found on Windows in earlier pull requests:

- In PowerShell, move files with `Move-Item -LiteralPath … -ErrorAction Stop`; `[System.IO.File]::Move` is refused in Constrained Language Mode (#179).
- Destroying a child process's stdio and calling `unref()` does not free its handles on Windows; a test that gives up on a child must end the run itself (#184).
- Tests that start a board page or a host process can time out on a busy machine. Locally, rerun the one that failed on its own and report both runs; in CI, a timeout is a flaky test, as above.

## 5. Write the CHANGELOG fragment

A fix or feature pull request adds one new file for each issue it names, `changelog.d/<N>-<slug>.md` (three bug fixes add three files), holding that issue's entry exactly as it will read in `CHANGELOG.md` ([changelog.d/README.md](../changelog.d/README.md)). Do not edit `CHANGELOG.md` or another pull request's fragment. The slug uses lowercase letters, digits and single hyphens; if the issue already has a fragment from another pull request, pick a different slug.

```markdown
- **What changed, in plain words (#N).** What went wrong and what it does now.
  Tests: `exact title one`, `exact title two`.
```

Copy each title exactly from its `test('…')` call. A change to documentation only writes `Tests: none (documentation only).`

## 6. Open the pull request as a draft

Commit as `<type>: <summary>` or `<type>(<scope>): <summary>`, with a body that says why. Copy the template to a file outside the checkout, so it is never committed, and fill in every section:

```sh
cp .github/pull_request_template.md ../pr-body.md
```

The body opens with one `Fixes #N` line for each issue (`Part of #N` for one step of a split issue), one right after the other, then `Author: <agent>, <branch>`. The PR check reads the run of those lines at the top, fails a `fix` title that lists more than three, and looks for your claim on each issue. Never put a bug fix in a feature pull request. Under Evidence, name the full head sha your results are for. Under Checks, add each result after a dash; for a check you did not run, `not run:` and why; for one that does not apply, `n/a:` and why. Screenshots are drawn from made-up data, with alt text starting "Synthetic". Check the body, push and open the draft:

```sh
node scripts/pr-check.mjs --body-file ../pr-body.md --title "fix(cli): <summary>"
git push -u origin <branch>
gh pr create -R WenyuChiou/agent-board --draft --title "fix(cli): <summary>" --body-file ../pr-body.md
node scripts/pr-check.mjs --pr <PR>
```

From a fork, `gh pr create` also needs `--head <your GitHub login>:<branch>`, and GitHub holds the PR check and CI until a maintainer approves the run. Each push, body edit, label change or `gh pr ready` starts a run that waits again; the maintainer looks for held runs at least once a day. So push when a piece of work is done, not after every small edit, and keep the pull request a draft until the approved runs pass (rule 7). The PR check prints what is still missing and how to fix it. After you edit the body, update the pull request with `gh pr edit <PR> -R WenyuChiou/agent-board --body-file ../pr-body.md`; the check runs again.

If the PR check says you are over the open pull request limit, close the newest of yours (`gh pr close <PR> -R WenyuChiou/agent-board`) and, once a slot is free, open a new pull request from the same branch. Do not reopen the closed one: it would keep its first place in the queue.

## 7. Mark it ready

Before you mark it ready, run the local preflight. It checks the branch against `main`, runs the Node test files you touched, the string tables, the language copies of the docs, the bundle, the fragment and the body:

```sh
node scripts/preflight.mjs --body-file ../pr-body.md --title "fix(cli): <summary>"
```

Paste its summary under Checks and update the body (`gh pr edit`, as above). Preflight does not run `claude plugin test .`; when you changed a `.test.ts` or `.test.tsx` file it warns about that, so say under Checks whether you ran it (step 4). When the preflight shows no `FAIL`, wait until CI is green and the PR check passes, then mark it ready with the head GitHub has:

```sh
gh pr checks <PR> -R WenyuChiou/agent-board
gh pr ready <PR> -R WenyuChiou/agent-board
gh pr comment <PR> -R WenyuChiou/agent-board --body "Ready for review $(gh pr view <PR> -R WenyuChiou/agent-board --json headRefOid -q .headRefOid)"
```

A draft is not reviewed. From now on, change the pull request only when the reviewer asks. When the verdict comes and what a review may ask for are in [docs/dev/team-process.md, From claim to merge](dev/team-process.md#from-claim-to-merge).

## 8. Answer review, ask questions

```sh
gh pr view <PR> -R WenyuChiou/agent-board --comments
node scripts/pr-check.mjs --pr <PR>      # also prints the latest Review: verdict and whether it is for your head
```

`Review: REQUEST CHANGES <sha>` lists findings. Fix each finding, merge `main` (step 9), run preflight again and update Checks, push, answer each finding in a comment that names the commit that fixed it, then comment `Ready for review <new full head sha>`. How many review rounds there are, and what happens after the second REQUEST CHANGES, are in [docs/dev/team-process.md, From claim to merge](dev/team-process.md#from-claim-to-merge). After `Review: APPROVE <sha>`, push nothing unless asked. A later push needs a new verdict unless it only merges `main` without conflicts and with nothing else in the merge commit (CONTRIBUTING rules 4 and 9).

A question goes on the issue, not on the pull request and not in a chat:

```sh
gh issue comment <N> -R WenyuChiou/agent-board --body "Question: <one question, with what you would do by default>"
gh issue edit <N> -R WenyuChiou/agent-board --add-label question
```

The answer comes in the same issue, starting `Answer:`. Read it with `gh issue view <N> -R WenyuChiou/agent-board --comments`.

## 9. Keep the branch current

```sh
git pull --ff-only          # after step 6: the reviewer may have merged main into your branch
git fetch origin
git merge origin/main       # never rebase or force-push
```

The usual conflict is the generated bundle `hooks/board-script.ts`. Take the copy from the `main` you are merging, rebuild it from the merged sources and finish the merge:

```sh
git restore --source=MERGE_HEAD --staged --worktree hooks/board-script.ts
npx --yes bun@1.4.2 scripts/build-board.ts
git add hooks/board-script.ts
git commit --no-edit
```

Fragments in `changelog.d/` do not conflict, since each pull request adds its own file. Run the checks again and push. Once the pull request is Ready, merge `main` only while answering `Review: REQUEST CHANGES`, or when the maintainer comments that `main` moved ([docs/dev/team-process.md, Merge order](dev/team-process.md#merge-order)); after that push, comment `Ready for review <new full head sha>`. After `Review: APPROVE`, leave merging `main` to the reviewer.

## 10. After the merge, or handing over

Someone other than you approves ([CONTRIBUTING.md](../CONTRIBUTING.md#pull-requests) rule 8). Then a collaborator with write access, the maintainer or the owner merges as rule 9 says, and comments on each issue with the merge commit and the evidence; GitHub deletes eligible same-repository branches; a fork owner may need to delete their branch; each `Fixes #N` line closes its issue, while a `Part of #N` line leaves its issue open for the next step. There is nothing left for you to do on this pull request, and its branch is not reused: the next step of a split issue is a new pull request ([CONTRIBUTING.md](../CONTRIBUTING.md#pull-requests) rule 2), from a new branch.

If you stop before the work is done, push your branch, then:

```sh
gh issue comment <N> -R WenyuChiou/agent-board --body "Handover: <branch>, done: …, left: …, checks run: …"
gh issue edit <N> -R WenyuChiou/agent-board --remove-label claimed
```

## 11. Review and merge someone else's pull request

With write access to this repository you may also review and merge pull requests you did not write ([CONTRIBUTING.md](../CONTRIBUTING.md#pull-requests) rules 8 and 9). If the owner names you in [Roles](../CONTRIBUTING.md#roles), a code-review subagent you run may also approve your own pull request, under the conditions in rule 8. In this step `<PR>` is the pull request you are reviewing, and `<N>` is each linked issue. Take one marked `Ready for review <sha>` that nobody is reviewing, and say so first:

Start from the queue. `node scripts/review-queue.mjs` lists the pull requests waiting on a reviewer, smallest first, with how long each has waited since its `Ready for review <sha>`; then those that need `main` merged (a conflicted one gets no CI until it is), the approved ones, and those waiting on their author. Take the small ones first.

```sh
node scripts/review-queue.mjs
gh pr list -R WenyuChiou/agent-board --state open
gh pr view <PR> -R WenyuChiou/agent-board --json headRefOid,body,isDraft
gh api repos/WenyuChiou/agent-board/issues/<PR>/comments --paginate
gh pr comment <PR> -R WenyuChiou/agent-board --body "Reviewing: <GitHub login or agent>"
gh pr diff <PR> -R WenyuChiou/agent-board
gh api repos/WenyuChiou/agent-board/pulls/<PR>/reviews --paginate
gh api repos/WenyuChiou/agent-board/pulls/<PR>/comments --paginate
gh pr checks <PR> -R WenyuChiou/agent-board
```

Read the diff against the issues on the body's first lines, and each P0 or P1 finding from Greptile or Codex. If either bot did not review this head (a fork, a failed or stuck run), run a code review of the head yourself, such as a local Codex run or your agent's code-review subagent, and post its result on the pull request. Then post one verdict with all findings at once: `Review: APPROVE <full head sha> by <login>` with what you verified, or `Review: REQUEST CHANGES <full head sha> by <login>` with each finding by file and line. Your own agent, lane or subagent cannot approve your own pull request, except under rule 8's conditions for the maintainer and for collaborators named in [Roles](../CONTRIBUTING.md#roles); for that exception, both bots must have reviewed the current head or a head it moved from only by a merge of `main` without conflicts and with nothing else in the merge commit; a substitute review cannot replace either bot.

Merge only when the latest verdict is an approval satisfying rule 8 for the current head (or for a head the branch has since moved from only by a clean merge of `main`, without conflicts or anything else in the merge commit), and impact planning, CI validation, every selected CI job, every other applicable workflow in `.github/workflows/`, and the `Greptile Review` check have succeeded on the current head; when Greptile did not review that head, your own code review posted for it stands in for that check (rule 9). Skipped, neutral, cancelled or missing selected checks are not passes; only groups explicitly omitted as unaffected by the plan may be skipped (rule 9):

```sh
gh pr merge <PR> -R WenyuChiou/agent-board --squash --match-head-commit <head sha>
gh issue comment <N> -R WenyuChiou/agent-board --body "Fixed by #<PR>, merged as <merge sha>. <evidence>"
```

Don't sit and watch CI. Once you approve, start the wait in the background (`gh pr checks <PR> -R WenyuChiou/agent-board --watch`, then the merge above when every check passes) and take the next pull request in the queue.

A pull request that changes the board page's messages, the setup output or the one-line row summaries also needs `Acceptance: PASS <full head sha>` from a collaborator who did not write it, after walking the steps in #572 on their own machine.

GitHub deletes a merged branch from this repository. A governance pull request also needs the owner's approval quoted in its body (rule 12), and a release pull request stays with the maintainer ([Releases](../CONTRIBUTING.md#releases)).
