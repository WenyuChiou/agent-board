# Contributing

Read [AGENTS.md](AGENTS.md) for code layout and conventions. Keep changes scoped, use synthetic data, and report checks and limitations in the PR.

## Set up

Clone the repository and use Node 22.18+ or 24 for the tests (the installed bundle supports Node 18+). Use Bun 1.4.2 when rebuilding generated files. `package.json` is only the npm package's manifest: it has no dependencies and no scripts, so there is nothing to install.

Independent development and installation do not require Claude Code. Optional pane validation uses Claude Code 2.1.301 in CI, pinned in `.github/workflows/test.yml`; `plugin validate` and `plugin test` are offline and need no model login.

## Run the checks

From the repository root, with Node 22.18+ or 24 and npm (for `npx`), the checks CI runs on every pull request:

```sh
node --test tests/exchange.test.mjs tests/messaging.test.mjs tests/pr-check.test.mjs tests/preflight.test.mjs tests/changelog-fold.test.mjs tests/team-stats.test.mjs
node --test tests/board.test.mjs tests/board-storage.test.mjs tests/codex-local.test.mjs tests/local-lock.test.mjs tests/prompt-hooks.test.mjs tests/codex-host.test.mjs tests/codex-fallback.test.mjs tests/legacy-connect.test.mjs tests/connect-worker.test.mjs
node --test tests/npm-package.test.mjs
npx --yes bun@1.4.2 scripts/build-board.ts --check
npx --yes bun@1.4.2 scripts/build-released.ts --check
node scripts/pr-check.mjs --pr <N>
```

These lists are the ones in `.github/workflows/test.yml`; if they ever differ, the workflow is right. Fetch release tags (`git fetch --tags origin`) before the released-files check. Rebuild changed bundle sources with `npx --yes bun@1.4.2 scripts/build-board.ts`; never hand-edit `hooks/board-script.ts`. `pr-check.mjs` says what a pull request still lacks under [Pull requests](#pull-requests); before opening one, run it with `--body-file <file> --title "<title>"`.

For the optional plugin and legacy installers:

```sh
claude plugin validate --strict .
claude plugin test .
bash tests/setup.check.sh
powershell -NoProfile -ExecutionPolicy Bypass -File tests/setup.check.ps1
python3 -B scripts/remote-reporter/test_pipeline.py
```

`claude` comes from npm (`npm install -g @anthropic-ai/claude-code@2.1.301`, the version CI pins); `plugin validate` and `plugin test` are offline and need no login. Run the installer check matching the changed script/OS; each uses temporary fixtures. Windows CI uses `python` for the stdlib reporter tests. None of these checks sends model prompts.

Run strict TypeScript for changed standalone modules with Node typings from your development environment. Full `tsc -p .` additionally needs the host-generated `.claude-plugin/types/` SDK, written when Claude Code loads the local plugin (`claude --plugin-dir .`). It is gitignored and must not be invented or edited. If unavailable, report full typechecking as unrun; passing standalone checks does not replace it. Do not start model work merely to claim an offline check passed.

CI runs plugin/installer/reporter checks on Linux and Windows; Node 22/24 exchange, messaging and board checks on both systems; the Node 22/24 PR-check tests and npm package tests on both systems, in jobs of their own; and the PR check (`.github/workflows/pr-check.yml`). It checks generated bundles/releases, but not full `tsc -p .`.

## Changes and evidence

Put logic in pure `hooks/` modules; engine calls stay in `hooks/register.tsx`. User-visible strings belong in all three tables. Use meaningful behavioral tests for messaging, state, storage and ownership changes. CHANGELOG entries name their covering tests. Commits and pull requests follow [Pull requests](#pull-requests).

Record progress, native hook execution, UI controls, transport acceptance and actual model ACKs separately. Identify the native host and surface; an owned app-server is not a CLI TTY or a desktop chat. A mock, tagged file or accepted RPC cannot prove live delivery. Never use a normal reply as tool/merge approval. Real model tests require an authorized disposable binding and a bounded prompt budget; stop only your own test processes afterward.

For optional OpenCode SDK/DeepSeek loader checks, use the pinned packages and disposable prefix in the [portable acceptance record](docs/validation/2026-10-19-portable-hosts.md). `scripts/check-host-contracts.mjs --runtime-dir <prefix>` uses the actual packages with synthetic host objects; it is not native model acceptance. Normal installation adds no npm dependencies.

## Pull requests

Several agents (Claude Code sessions, Codex, Antigravity, cloud agents such as dot and Muse, and agents on other computers) work in this repository at the same time. These rules keep their work from overlapping. They apply to every agent and person. [docs/CONTRIBUTOR-PATH.md](docs/CONTRIBUTOR-PATH.md) walks through them with the exact commands; where the two disagree, this section wins. [docs/dev/team-process.md](docs/dev/team-process.md) sets how much work is open at once, when a finding becomes an issue, and how a pull request moves from claim to merge. `node scripts/pr-check.mjs` checks rule 2's issue lines and its three-fix limit on a `fix` title, and rules 6 and 10; the `Author:` line, the template sections and pictures' alt text (rule 7); the branch and title names (rules 4 and 5); that a claim names you and your branch (rule 3, not yet its end time: #303); private data in the body and added docs; and, when you run it yourself, the board bundle (rule 5). It runs on your computer and on every pull request; the rest is the reviewer's to check.

1. **Nothing reaches `main` except through a pull request.** Never push to `main`. Never force-push a branch: bring it up to date by merging (rule 4).
2. **One feature, one pull request; bug fixes two or three together.** Start from an issue; open one if none fits. A feature gets one branch and one pull request, even when it spans several issues, unless it is split into steps (below). Bug fixes go two or three to a pull request when several are waiting, never more than three; a lone or urgent fix may go alone. Other small issues (docs, tests, chores) follow the same rule with issues of their own kind. Never put a bug fix in a feature pull request. The body opens with one `Fixes #N` or `Part of #N` line for each issue, one right after the other, and you claim every one of those issues (rule 3). When an issue is split into steps, each step's pull request opens with `Part of #N` and the last one with `Fixes #N`. Anything else you find goes in a comment on one of your issues, not into the same pull request; the maintainer files it if it qualifies. A release pull request needs no issue and has no `Fixes` line.
3. **Find work, then claim it.** Work ready to start carries the label `ready`; `for-agent` means any agent may take it and `for-dot` means dot or Muse. The issue body says who it is planned for (`Executor`), what must pass (`Acceptance tests`) and what must land first (`Blocked by`); the body is the current scope. Leave issues labelled `blocked` alone, and those labelled `claimed` unless the claim has run out (below). Before you branch, check the open pull requests (`gh pr list --state open`) and the issue's comments. To claim, comment on the issue

   `Claim: <agent>, <branch>, until <YYYY-MM-DD HH:MM> UTC`

   at most two days ahead, and add the `claimed` label. If you cannot edit labels, say so in the comment; the maintainer sets them. Renew it with a new `Claim:` comment before it runs out. A claim past its time with no pull request may be taken over after a `Claim taken over: <agent>, <branch>` comment. A claim waiting for a free slot (rule 10) says `waiting for a slot` in place of a time; it runs out 7 days after its comment unless renewed the same way. If someone has an open pull request or a live claim, do not start a competing one: comment on theirs. If an earlier claim turns up after yours, withdraw yours.
4. **Branch from current `main`**, named `<type>/<short-slug>` (`fix/question-ledger-write`). When `main` moves, merge it into your branch (`git fetch origin`, `git merge origin/main`) and push; never rebase a pushed branch. The reviewer may do this merge for you, so run `git pull --ff-only` before you commit again. If `main` moved before the merge, the reviewer reviews the new head. Without write access to this repository, push the branch to your fork and open the pull request from there: the PR check and CI run on it the same way, though GitHub may hold CI runs from a first-time contributor's fork until the maintainer approves them.
5. **Commits** use `<type>: <summary>` or `<type>(<scope>): <summary>` (for example `feat`, `fix`, `docs`, `test`, `refactor`, `chore`), with a body that says why. The pull request title uses the same form. Commit regenerated files (`hooks/board-script.ts`, `hooks/released.ts`) together with the source change that needs them.
6. **CHANGELOG.** A fix or feature pull request adds one new file for each issue it names, `changelog.d/<issue>-<slug>.md` (for example `changelog.d/229-changelog-fragments.md`), holding that issue's entry exactly as it will read in the CHANGELOG. The entry names its issue (`#N`) and names its covering tests by their exact titles, each in backticks after `Tests:`. A fix or feature pull request that changes only documentation writes `Tests: none (documentation only).` Do not edit `CHANGELOG.md` or another pull request's fragment: only the release pull request ([Releases](#releases)) raises the version and folds the fragments into a dated section. Until 0.24.0 ships, an entry under `## Unreleased` is still accepted.
7. **The pull request body** names its author (`Author: <agent>, <branch>`) and fills in every section of the template: the evidence and the head it is for, each check with its result, each check you did not run with `not run:` and why, and what it leaves out. Pictures are synthetic and their alt text says so. Open it as a draft. When the PR check and CI pass, mark it ready (`gh pr ready <N>`) and comment `Ready for review <full head sha>`. After that, change it only when the reviewer asks: answer each finding in a comment, push the fix, and comment `Ready for review <new head sha>`.
8. **Authors never merge.** Any agent or person may open issues and pull requests, but only the reviewer merges: the owner, or the Claude Code session the owner has named maintainer of this repository (governance files, workflow files included, also need the owner's written approval first, rule 12). No author decides that its own pull request is done. A pull request the maintainer wrote gets its verdict from a separate review of the diff (a code-review subagent the maintainer runs, or the owner), never from the maintainer alone; the maintainer posts the subagent's verdict as given.
9. **The reviewer verifies before merging.** The reviewer:
   - reads the whole diff against the issues on the first lines of the body: those issues, nothing extra, and no bug fix in a feature pull request;
   - reruns the checks that cover the change on its own copy, rather than trusting the reported results;
   - comments on the pull request `Review: APPROVE <full head sha>` with what was verified, or `Review: REQUEST CHANGES <full head sha>` with the findings, naming the reviewer (`by owner`, `by maintainer` or `by code-review subagent`); any later push needs a new verdict;
   - merges only the head named in `Review: APPROVE <head sha>`, once every CI job in `.github/workflows/` is green, not only the ones GitHub marks as required. The merge is a squash merge of that head: `gh pr merge <N> --squash --match-head-commit <head sha>`.
   - then deletes the branch, and comments on each closed issue with the merge commit and the evidence.

   A pull request that reports a check it did not run is not ready to merge. A merge with no `Review: APPROVE` for the merged head breaks this rule: the reviewer opens an issue (rule 11) and reviews it after the fact.
10. **At most two open pull requests per author, and eight in all.** The author is the agent named on the `Author:` line, the words before its first comma, ignoring case and backticks. An agent that a coordinating session dispatches adds its lane in brackets, the name of the session that sent it (`Author: codex (phase1), fix/x`), and each agent and lane together counts as one author, so two sessions that both send work to Codex do not share its two slots. Drafts count. Release pull requests, governance pull requests (rule 12) and pull requests the owner labels `cap-exempt` do not count. Older pull requests keep their slots: the PR check fails the newest one over a limit. Check `gh pr list --state open` first, split large work into step pull requests (rule 2), and open the next step when one of yours has merged. If yours does not fit, close it and later open a new pull request from the same branch, or keep your claim `waiting for a slot`. Do not reopen the closed one: GitHub keeps its first creation time, so it would take a slot ahead of newer pull requests.
11. **Undoing what a merged pull request did** needs an issue that names that pull request. A revert also goes through a pull request.
12. **Governance files** (`AGENTS.md`, `CONTRIBUTING.md`, `.github/`) change only with the owner's written approval of the content, file by file: in a comment the owner writes on the issue or the pull request, or in a chat with the maintainer. The pull request body quotes the owner's approving words, and nothing else from the chat, with their date and where they were given. The maintainer then reviews and merges it as in rule 9, as for any other pull request. A workflow can widen what CI is allowed to do, so a pull request that changes `.github/workflows/` needs the owner's approval for each workflow file it changes before the maintainer merges it. A change to the text after the approval needs a new one. An agent's comment is not approval, and while agents post from the owner's GitHub account, a comment counts only when the owner confirms to the maintainer that it is theirs.
13. **The PR check.** `scripts/pr-check.mjs` runs on every pull request (`.github/workflows/pr-check.yml`), using the copy on `main`, and says in words what is missing and how to fix it. A pull request whose PR check fails is not ready for review. If you think the check is wrong about your pull request, say so in a comment; change the check only in its own pull request.
14. **Handing over.** If you stop before the work is done, push your branch and comment on each of your issues `Handover: <branch>, done: …, left: …, checks run: …`, then remove `claimed` from each. Your claims end there. The next agent claims the issues as in rule 3 and may continue on your branch.

### How the maintainer organizes the work

The owner names one Claude Code session maintainer of this repository. It plans and reviews; implementation goes to other agents.

- **Triage.** The maintainer reads each new issue, sets its milestone and labels, and writes `Executor`, `Acceptance tests` and `Blocked by` into the issue body (the Task form has these fields). It adds `ready` when an agent can start, and `blocked` while something must land first. A change of scope is an edit to the issue body with a dated `Updated:` line, not only a comment.
- **Review.** Every pull request gets a review of its diff by the owner, the maintainer or a code-review subagent the maintainer runs; one the maintainer wrote, by a subagent or the owner only (rule 8). The verdict is posted as in rule 9.
- **Merge.** The maintainer merges; a governance pull request, workflow changes included, only once the owner has approved its content (rule 12).
- **Questions.** Ask on the issue, in a comment starting `Question:`, and add the `question` label. The maintainer answers in the same issue, in a comment starting `Answer:`, and removes the label. Only an answer on GitHub counts: a chat, a log or a notes file the asking agent cannot read is not an answer. While you wait, keep working on what the question does not touch, or hand over (rule 14).
- **The owner.** A question only the owner can decide gets the `needs-owner` label; the maintainer asks the owner and writes the answer in the issue.

## The file format is versioned

[FORMAT.md](docs/FORMAT.md) is a public interface shared with other writers. Preserve every valid older shape. Add optional marker attributes compatibly; a new mark, state or line shape needs a format-version decision first. Change parser, writer, tests and the format specification and translated guides together when behavior changes. Keep the three rule languages and `scripts/claude-md-rule.md` synchronized if changing the Claude rule.

## Images

README pictures are SVGs that `bun docs/preview/render.ts` draws from synthetic data with the board's own code, in the README's own language, with alt text that says synthetic; README pictures use their dark version, the same look as the social preview. Never hand-edit a generated SVG. Do not add a gallery to the guides. Historical assets remain in `docs/images/`. `node docs/preview/png.mjs` renders social previews; its fonts/tool requirements are documented in the preview sources. A synthetic render is not native acceptance evidence. Keep bearer URLs, conversations and private identifiers out of public images.

## Releases

The full checklist, what makes a release stable, and the npm steps are in [docs/RELEASING.md](docs/RELEASING.md). In short:

1. Update `.claude-plugin/plugin.json` and `package.json` to the same version, the three README badges and concise marketplace descriptions. Keep support claims aligned with evidence.
2. Run `node scripts/changelog-fold.mjs x.y.z` to see what it will do, then `node scripts/changelog-fold.mjs x.y.z --write`. It moves every fragment in `changelog.d/` and any entry left under `## Unreleased` into `## x.y.z — YYYY-MM-DD` and removes the folded fragments.
3. Fetch tags (`git fetch --tags origin`), then run `bun scripts/build-released.ts` with Bun 1.4.2. It records this version's generated-file ownership; do not edit its output manually.
   Run `bun scripts/build-board.ts`, then regenerate the released table once more. Both `--check` commands must pass together. The bundle omits its mutable pre-tag fingerprint and its own exact tagged fingerprint. Newer source with the same manifest version includes the frozen tag's fingerprint so upgrades still recognize it; historical board and command ownership remain included.
4. Run applicable checks and generated-file checks, including `node --test tests/npm-package.test.mjs`, which fails when `package.json` and `plugin.json` disagree. State any unavailable full SDK typecheck.
5. Open a regular PR titled `chore(release): Agent Board x.y.z` (pr-check treats a title starting `chore(release):` as a release). The reviewer verifies it as in [Pull requests](#pull-requests) and, under the owner's authorization, squash-merges the exact tested head (`--match-head-commit`) once every CI job is green.
6. On the merged release commit, run `claude plugin tag . --dry-run`, then `claude plugin tag .`. Push only the new exact tag, for example `git push origin agent-board--v0.23.0`. Never replace an existing release tag or push unrelated local tags.
7. Pick the channel by the release gate in docs/RELEASING.md. A stable release gets a GitHub release marked Latest and npm's `latest` tag; any other release is a GitHub pre-release and npm's `next` tag. Write the GitHub release notes from the version's CHANGELOG section. Only the owner publishes to npm, from the exact tagged commit, typing the one-time code; agents never run `npm login` or `npm publish`.

## Support matrix

Keep README, setup and messaging capabilities synchronized across languages. Distinguish native activity, explicit task reports, web/terminal UI and live receiving. Record actual version/platform/surface evidence and keep unsupported or untested adapters visible. Do not turn a generated configuration or another vendor's successful test into a blanket support claim.

## Bug reports

Prefer a synthetic reproduction, the Agent Board/affected host versions, CLI/App/IDE, OS and expected/actual behavior. Claude's version is relevant only to its optional plugin. Do not request raw real progress or conversation files. Report sensitive findings privately as [SECURITY.md](SECURITY.md) describes.
