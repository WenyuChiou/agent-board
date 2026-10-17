## What and why

<!-- One complete change: what it does and why. -->

## Checks

- [ ] `claude plugin validate --strict .`
- [ ] `claude plugin test .`
- [ ] `tsc -p .`
- [ ] `bash tests/setup.check.sh` / `tests/setup.check.ps1`, if a setup script changed
- [ ] `docs/FORMAT.md` updated, if the file format changed (backward compatible)
- [ ] `CHANGELOG.md` entry naming the tests that cover the change
- [ ] Images redrawn (`bun docs/preview/render.ts`), if the pane looks different
