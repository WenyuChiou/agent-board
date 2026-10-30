# Changelog fragments

Each fix or feature pull request adds one new fragment for each issue it lists,
containing that issue's complete CHANGELOG entry. Separate files let pull
requests merge without editing the same Unreleased section.

Name the file `<issue>-<slug>.md`, where `<issue>` is the number on one of the
pull request's `Fixes #N` or `Part of #N` lines. The slug uses lowercase letters, digits
and single hyphens between words. Pull requests for the same issue use different
slugs. For example, `changelog.d/42-synthetic-summary.md` could contain:

```markdown
- **Page / Needs you first** · The page opens on what needs you, with every agent in one row (#42).
  Tests: `a synthetic page opens on what needs you`.
```

The bold part is `area / topic`. The area names what the person uses, for example Page, Terminal board, Pane, Setup, Codex, Claude Code, Antigravity, Cursor, Questions, Messaging, Storage, Docs, Tests or CI. After ` · ` come one to three plain sentences about what changed for the person, not how it was built, ending with the issue number `(#N)`.

The `Tests:` line names the covering tests by their exact titles in backticks, separated by commas, for reviewers and `scripts/pr-check.mjs`. Documentation-only changes write `Tests: none (documentation only).` Existing fragments stay untouched until release.

The release pull request runs `node scripts/changelog-fold.mjs <version>` to
preview the new section, then adds `--write` to update CHANGELOG.md and remove
the folded fragments. Use `--date YYYY-MM-DD` to set the date; it defaults to
today in UTC. Fragments appear by issue number descending, then by filename,
above any remaining Unreleased entries. This README is never checked or folded
as a fragment. The fold leaves each entry's `Tests:` line out of CHANGELOG.md.
