Fixes #

<!-- One issue per pull request (CONTRIBUTING.md, Pull requests). Other findings go into new issues. Release pull request: delete the Fixes line. -->

## What and why

<!-- One complete change: the problem, then the fix. -->

## Tests

<!-- The tests that cover the change, by exact title. -->

## Checks

<!-- Tick what you ran and give its result. For a check you could not run, say why. -->

- [ ] Applicable Node board, storage, local reporter and messaging/exchange tests
- [ ] Bundle/released files current, if generated output changed
- [ ] `claude plugin validate --strict .`
- [ ] `claude plugin test .`
- [ ] Applicable strict standalone typechecks; report if full `tsc -p .` SDK types are unavailable
- [ ] `bash tests/setup.check.sh` / `tests/setup.check.ps1`, if a setup script changed
- [ ] `docs/FORMAT.md` updated, if the file format changed (backward compatible)
- [ ] `CHANGELOG.md` entry under `## Unreleased` naming the tests that cover the change (release pull request: rename `## Unreleased` to the version and date instead)
- [ ] Native/model evidence and CLI/App/IDE limits stated separately; no private data or board tokens attached

## Not covered

<!-- What this pull request leaves out, with links to the follow-up issues. -->
