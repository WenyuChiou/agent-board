# Changelog fragments (closed)

`CHANGELOG.md` is the only changelog. A new pull request adds no file here:
the release writes one line for each fix and feature from its squash-merge
title (CONTRIBUTING rule 6).

The fragments written before that change were shortened to one line each under
`## Unreleased` in CHANGELOG.md on 2026-11-03; their full text is in
`git show cd1cea3:changelog.d/<name>`. A pull request opened before the change
may still carry a fragment. The next release folds it with
`node scripts/changelog-fold.mjs <version> --write`, which removes it; after
that, this README is the only file here.
