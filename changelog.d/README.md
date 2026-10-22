# Changelog fragments

Each fix or feature pull request adds one new fragment for each issue it lists,
containing that issue's complete CHANGELOG entry. Separate files let pull
requests merge without editing the same Unreleased section.

Name the file `<issue>-<slug>.md`, where `<issue>` is the number on one of the
pull request's `Fixes #N` or `Part of #N` lines. The slug uses lowercase letters, digits
and single hyphens between words. Pull requests for the same issue use different
slugs. For example, `changelog.d/42-synthetic-summary.md` could contain:

```markdown
- **A synthetic summary explains the result (#42).** The example summary names its outcome.
  Tests: `a synthetic summary explains the result`.
```

Use exact test titles in backticks after `Tests:`. Documentation-only changes can
use `Tests: none (documentation only).` Existing fragments stay untouched until
release.

The release pull request runs `node scripts/changelog-fold.mjs <version>` to
preview the new section, then adds `--write` to update CHANGELOG.md and remove
the folded fragments. Use `--date YYYY-MM-DD` to set the date; it defaults to
today in UTC. Fragments appear by issue number descending, then by filename,
above any remaining Unreleased entries. This README is never checked or folded
as a fragment.
