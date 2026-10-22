Fixes #
Author: <agent>, <branch>

<!-- First lines: one `Fixes #N` or `Part of #N` line for each issue (`Part of #N` for one step of an issue split into steps), one right after the other. One feature per pull request, or two or three bug fixes, never more than three (CONTRIBUTING.md, Pull requests). Release pull request: delete the Fixes line. Run `node scripts/pr-check.mjs --pr <N>` after opening; CI runs it too. -->

## What and why

<!-- One complete change: the problem, then the fix. -->

## Tests

<!-- The tests that cover the change, by exact title, as in the CHANGELOG entry. -->

## Evidence

<!-- The full head sha this evidence is for; each command you ran with its pass/fail/skip counts; the CI run link once it has run. A result from an earlier head names that head. A failure stays reported as a failure, with its rerun. -->

## Checks

<!-- Tick what you ran and add its result after a dash. For a check you did not run, leave it unticked and add `not run:` and why, or `n/a:` and why it does not apply. -->

- [ ] Node suites CI runs (`.github/workflows/test.yml`)
- [ ] Bundle/released files current (`npx --yes bun@1.4.2 scripts/build-board.ts --check`; `scripts/build-released.ts --check`)
- [ ] `claude plugin validate --strict .`
- [ ] `claude plugin test .`
- [ ] Applicable strict standalone typechecks; full `tsc -p .` reported unrun if the SDK types are unavailable
- [ ] `bash tests/setup.check.sh` / `tests/setup.check.ps1`, if a setup script changed
- [ ] `docs/FORMAT.md` updated, if the file format changed (backward compatible)
- [ ] A new `changelog.d/<issue>-<slug>.md` fragment for each issue, naming the issue and the tests that cover the change, for fix and feature pull requests (release pull request: run `scripts/changelog-fold.mjs` instead)
- [ ] `node scripts/pr-check.mjs` passes
- [ ] `node scripts/preflight.mjs --body-file <f> --title <t>` output pasted under Checks before Ready (no review without it)
- [ ] Native/model evidence and CLI/App/IDE limits stated separately; no private data, session ids, home-folder paths or board links attached

## Screenshots

<!-- Synthetic only: drawn from made-up data, never a real board. Alt text starts with "Synthetic". Write "None." if there are none. -->

## Not covered

<!-- What this pull request leaves out, with links to the issue or comment that tracks each part (CONTRIBUTING rule 2). Write "Nothing." if nothing. -->
