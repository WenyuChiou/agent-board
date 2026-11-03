# Changelog fragments (closed)

`CHANGELOG.md` is the only changelog. A new pull request adds no file here:
the release writes one line for each fix and feature from its squash-merge
title (CONTRIBUTING rule 6).

The fragments in this folder were written before that change, and a pull
request opened before it may keep the one it has. Leave them as they are. The
next release folds them into CHANGELOG.md with
`node scripts/changelog-fold.mjs <version> --write`, which removes them; after
that, this README is the only file here.
