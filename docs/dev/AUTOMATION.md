# Keeping work moving while nobody watches

**Status: proposal only. Nothing on this page is set up.** Each option needs the owner's decision, and a workflow file needs the owner's approval of that file (CONTRIBUTING rule 12).

The rules ([RULES.md](RULES.md), [REVIEWING.md](REVIEWING.md)) let any agent author, review and merge, so work moves whenever an agent is running. What they cannot do is start an agent. These are two ways to start one on a schedule, and a third piece that makes the review rule something GitHub enforces.

## Option A: a scheduled task on the owner's computer

A scheduled task (Task Scheduler on Windows, cron or launchd elsewhere) starts one agent every hour, in a clean checkout, with one prompt:

```text
Work through the review queue of WenyuChiou/agent-board as docs/dev/REVIEWING.md says:
review what waits, merge what passes the review gate, then stop.
Write a Handover on anything you leave unfinished.
```

- **Good:** it uses agents and accounts the owner already has (Claude Code, Codex, Antigravity), with no new secrets.
- **Costs:** it runs only while the computer is on, it uses the owner's agent usage, and it adds load to a computer that already runs many hooks and agents.
- **Needed:** one run at a time (skip a start while the last run is still going), a hard time limit per run, logs kept on the computer and never on GitHub (RULES.md, R8), and the agent's permission settings allowing only `git`, `gh`, `node` and the repository folder.

## Option B: a reviewer in GitHub Actions

A workflow runs an AI reviewer on GitHub's machines when a pull request is marked ready, and on a schedule for the queue.

- **Good:** it runs with every computer off. It posts as the workflow's own bot account, a different GitHub identity from the owner, so GitHub itself shows that the author did not approve.
- **Costs:** it needs a model API key stored as an Actions secret, and it is billed by the API, separate from anyone's agent plan.
- **Needed:** the key only in an environment that runs from `main`, never for a pull request from a fork; no step that runs the pull request's own code with the key present; actions pinned to full commit shas, as the other workflows here are; read-only permissions apart from posting comments.

## The review gate as a required check

`node scripts/pr-check.mjs --pr <N> --review-gate` already refuses a merge whose newest verdict does not approve the current head, or names the author as its reviewer. Today the merging agent runs it by hand. To make GitHub refuse such a merge, a workflow would run it on every verdict and push, and branch protection would require its result.

Proposed `.github/workflows/review-gate.yml`, for review; it is not in the repository:

```yaml
# Runs the review gate from main's own copy of pr-check, so a pull request cannot loosen it.
name: review-gate
on:
  pull_request:
    types: [opened, edited, reopened, synchronize, ready_for_review]
  issue_comment:
    types: [created, edited, deleted]
permissions:
  contents: read
  pull-requests: read
  issues: read
concurrency:
  group: review-gate-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true
jobs:
  review-gate:
    name: review gate
    if: github.event_name == 'pull_request' || github.event.issue.pull_request
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@<full sha of the pinned version>
        with:
          ref: main
          persist-credentials: false
      - uses: actions/setup-node@<full sha of the pinned version>
        with:
          node-version: 24
      - name: Review gate
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number || github.event.issue.number }}
        run: node scripts/pr-check.mjs --pr "$PR" --review-gate --no-bundle
```

Two points to check before it is adopted:

- **Where the check is reported.** A run started by a comment reports against `main`, not against the pull request's head. To count as a required check, its result has to be posted to the head commit as a status, which needs `statuses: write`.
- **The diff checks.** `--pr` also runs the diff checks against a checkout of the pull request. The gate step may need the pull request's commits fetched, or a gate-only mode that skips the diff.
