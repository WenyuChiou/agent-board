# Releasing Agent Board

The maintainer session prepares, reviews and merges a release and creates its GitHub release. Only the owner publishes to npm, because publishing needs the npm account's one-time code. Agents never run `npm login` or `npm publish`. The short version of these steps is in [CONTRIBUTING.md, Releases](../CONTRIBUTING.md#releases).

## Stable and pre-release

**Stable.** A release is stable only when its exact tagged commit passed the release gate below. Only a stable release gets GitHub's **Latest** label and npm's **`latest`** dist-tag. Every other release is a **pre-release**: a GitHub pre-release and npm dist-tag **`next`**. Both channels use the same version numbers, with no `-rc` suffix, so `plugin.json`, the git tag and npm always agree.

| | Stable | Pre-release |
|---|---|---|
| GitHub release | marked Latest | marked Pre-release |
| npm dist-tag | `latest`, which `npx @wenyuchiou/agent-board` installs | `next`: `npx @wenyuchiou/agent-board@next` |
| README version line | updated | unchanged |

The release gate, checked on the exact tagged commit:

1. **CI.** Every job of `.github/workflows/test.yml` is green on that commit, on Ubuntu and on Windows.
2. **Parity.** `docs/validation/<date>-parity-<version>.md` exists, run as [PARITY-CHECKLIST.md](validation/PARITY-CHECKLIST.md) says. Every FAIL in it names an open issue outside this release's must-ship set.
3. **Journeys.** The L1–L3 user-journey tests (`tests/e2e/`, #222) pass on that commit. While #222 is open, no release can be stable.
4. **Must-ship.** No issue in the release's must-ship set is open. The set is the issues the milestone description names as must-ship.

A pre-release that passes the gate later is promoted in place, never re-tagged or published again:

```bash
gh release edit agent-board--vX.Y.Z --prerelease=false --latest
npm dist-tag add @wenyuchiou/agent-board@X.Y.Z latest --otp <code>
```

## Checklist

1. **Version.** Put the same `X.Y.Z` in `.claude-plugin/plugin.json` and `package.json`, the three README badges and the marketplace descriptions. `node --test tests/npm-package.test.mjs` fails when `package.json` and `plugin.json` disagree.
2. **CHANGELOG.** Run `node scripts/changelog-fold.mjs X.Y.Z` to preview, then add `--write`. It folds every `changelog.d/` fragment, and any entry left under `## Unreleased`, into `## X.Y.Z — YYYY-MM-DD`.
3. **Generated files.** Rebuild as in [CONTRIBUTING.md, Releases](../CONTRIBUTING.md#releases) step 3: the board bundle and the released-files table, and both `--check` commands pass.
4. **Checks.** Run everything in [CONTRIBUTING.md, Run the checks](../CONTRIBUTING.md#run-the-checks). The npm test also checks that `npm pack` would publish only the files `package.json` lists.
5. **Pull request.** Title it `chore(release): Agent Board X.Y.Z`, review it, then squash-merge the exact tested head.
6. **Tag.** On the merged commit, run `claude plugin tag . --dry-run`, then `claude plugin tag .`. Push only the new tag.
7. **Gate.** Check the release gate above, and decide stable or pre-release.
8. **GitHub release.** Write it from the version's CHANGELOG section. A pre-release's notes open with: "Pre-release: this version did not pass the release gate (docs/RELEASING.md)."

   ```bash
   awk '/^## X\.Y\.Z /{f=1;next} /^## /{f=0} f' CHANGELOG.md > notes.md
   # stable
   gh release create agent-board--vX.Y.Z --verify-tag --title "Agent Board X.Y.Z" --notes-file notes.md --latest
   # pre-release
   gh release create agent-board--vX.Y.Z --verify-tag --title "Agent Board X.Y.Z" --notes-file notes.md --prerelease --latest=false
   ```
9. **npm.** The owner publishes; see below.
10. **Close.** Close the milestone. For a stable release, update the README version line.

## Publish to npm (owner only)

Publish from a clean copy of the exact tag. Nothing below changes npm except `npm publish`:

```bash
git fetch --tags origin
git switch --detach agent-board--vX.Y.Z
git status --short                       # must print nothing
node --test tests/npm-package.test.mjs   # must pass
npm pack --dry-run                       # the files package.json names, the READMEs and LICENSE: nothing else
npm whoami                               # the account that owns the package
npm publish --dry-run --access public --tag latest      # stable: must say "with tag latest" (next: --tag next)
npm publish --access public --tag latest --otp <code>   # stable
npm publish --access public --tag next --otp <code>     # pre-release
npm view @wenyuchiou/agent-board dist-tags           # latest or next now points at X.Y.Z
```

`package.json` sets `publishConfig.tag` to `next`, so an `npm publish` without `--tag` can never make a release stable by accident. A version number can be used only once on npm. A broken release is fixed by the next patch version. If one must be warned about, use `npm deprecate @wenyuchiou/agent-board@X.Y.Z "<reason>" --otp <code>`; do not unpublish it.

### The first publish

The package is published under the owner's npm scope as `@wenyuchiou/agent-board`. npm refuses the unscoped `agent-board` as too similar to the existing, unrelated `agentboard` package. A scoped package is private unless published as public, so `package.json` sets `publishConfig.access` to `public`, and the publish commands pass `--access public` too. No placeholder version was published. The command people run is still `agent-board`.

1. Turn on two-factor authentication for the npm account, for authorization and writes (npmjs.com → Account → Two-Factor Authentication). An earlier placeholder attempt, for the unscoped name, failed with `E403`.
2. Make the first publish a stable release: `npm publish --access public --tag latest --otp <code>`. Do not make the first version a `next` one. npm's documentation does not say what `latest` points to after a package's first publish under another tag, and `npx @wenyuchiou/agent-board` needs `latest`.
3. If 0.24.0 does not pass the gate, publish nothing to npm yet. Publish the first version that passes.
4. Check it from a scratch folder: `npm view @wenyuchiou/agent-board dist-tags`, then `npx @wenyuchiou/agent-board@X.Y.Z --version`.

Publishing from GitHub Actions with npm trusted publishing and `--provenance` is not set up yet; it is planned for 0.27.0. npm allows a trusted publisher only for a package that already exists, so it can only start after the first manual publish.
