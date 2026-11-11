# Releasing Agent Board

The maintainer session, or a collaborator when the maintainer is away, prepares a release, tags it and creates its GitHub release ([RULES.md, R7](dev/RULES.md#r7-releases-go-out-by-themselves)); the release pull request merges as [RULES.md, R3](dev/RULES.md#r3-merging) says. The release pull request needs an approval from someone who did not write it, as [CONTRIBUTING.md, Pull requests](../CONTRIBUTING.md#pull-requests) rule 8 says. Only the owner publishes to npm, because publishing needs the npm account's one-time code. Agents never run `npm login` or `npm publish`. The short version of these steps is in [CONTRIBUTING.md, Releases](../CONTRIBUTING.md#releases).

## Stable and pre-release

**Stable.** A release is stable only when its exact tagged commit passed the release gate below. Only a stable release gets GitHub's **Latest** label and npm's **`latest`** dist-tag. Every other release is a **pre-release**: a GitHub pre-release and npm dist-tag **`next`**. Both channels use the same version numbers, with no `-rc` suffix, so `plugin.json`, the git tag and npm always agree.

| | Stable | Pre-release |
|---|---|---|
| GitHub release | marked Latest | marked Pre-release |
| npm dist-tag | `latest`, which `npx @wenyuchiou/agent-board` installs | `next`: `npx @wenyuchiou/agent-board@next` |
| README version line | `Latest stable version: X.Y.Z` | `Latest stable version: <last stable>`, unchanged |

The README line names the latest stable version in every package, so a pre-release package never reads as though the last stable version were its own version.

The release gate, checked on the exact tagged commit:

1. **CI.** Every job of `.github/workflows/test.yml` is green on that commit, on Ubuntu and on Windows.
2. **Parity.** `docs/validation/<date>-parity-<version>.md` exists, run as [PARITY-CHECKLIST.md](validation/PARITY-CHECKLIST.md) says. Every FAIL in it names an open issue outside this release's must-ship set.
3. **Journeys.** The L1–L3 user-journey tests (`tests/e2e/`, #222) and the upgrade journeys (`tests/host-upgrade.test.mjs`: a home set up by 0.24.0, and one set up by 0.24.2, upgraded by this commit's setup, #877) pass on that commit.
4. **Must-ship.** No issue in the release's must-ship set is open. The set is the issues the milestone description names as must-ship.
5. **Simulated user.** `docs/validation/<date>-usersim-<version>.md` exists, run as [USER-SIM.md](validation/USER-SIM.md) says on the release pull request's head, with no FAIL and an issue for every FRICTION. Unlike gates 1–4, this one holds for every release: without it there is no release, not even a pre-release.

Nobody gives a go-ahead: a release that has its simulated-user record goes out, as stable when gates 1–4 also pass and as a pre-release otherwise ([RULES.md, R7](dev/RULES.md#r7-releases-go-out-by-themselves)).

A pre-release that passes the gate later is promoted in place, never re-tagged or published again:

```bash
gh release edit agent-board--vX.Y.Z --prerelease=false --latest
npm dist-tag add @wenyuchiou/agent-board@X.Y.Z latest --otp <code>
```

The owner runs the npm line. The same day, a promotion also does what a stable release does at steps 8 and 10 below:
- **The release notes.** Their first line, "Pre-release: this version did not pass the release gate (docs/RELEASING.md).", becomes "Stable since YYYY-MM-DD: this version passed the release gate on its tagged commit", followed by its parity and live-run records. Edit it with `gh release edit agent-board--vX.Y.Z --notes-file notes.md`.
- **The README line.** A pull request changes `Latest stable version:` to X.Y.Z in all three READMEs.
- **The milestone.** It is closed.

## Checklist

1. **Version.** Put the same `X.Y.Z` in `.claude-plugin/plugin.json` and `package.json`, the three README badges and the marketplace descriptions. `node --test tests/npm-package.test.mjs` fails when `package.json` and `plugin.json` disagree.
2. **CHANGELOG.** Run `node scripts/changelog-fold.mjs X.Y.Z` to preview, then add `--write`. It writes `## X.Y.Z — YYYY-MM-DD` from the fix and feature titles merged since the last release tag, any entry left under `## Unreleased` and any fragment left in `changelog.d/`. A title becomes one line, with its pull request number; check the preview and reword any line that does not read well for the person using agent-board. Run `git fetch --tags origin` first, and `git fetch --unshallow` in a shallow clone; without the last release tag the preview leaves out every title line. With `--write` its output ends with three questions for the next version's plan (the goal above this version's, one hard number it should move, which other field has solved a problem like ours); it only prints them.
3. **Generated files.** Rebuild as in [CONTRIBUTING.md, Releases](../CONTRIBUTING.md#releases) step 3: the board bundle and the released-files table, and both `--check` commands pass.
4. **Checks.** Run everything in [CONTRIBUTING.md, Run the checks](../CONTRIBUTING.md#run-the-checks). The npm test also checks that `npm pack` would publish only the files `package.json` lists.
5. **Pull request.** Title it `chore(release): Agent Board X.Y.Z`. Before the simulated-user run that is meant to be the last one starts, list in its body every pull request merged since the last release tag under [RULES.md, R2](dev/RULES.md#r2-nobody-approves-their-own-work)'s exception for a lane's own reviewer, with its merge commit, who read it in full and any issue opened; that reading is done (a pull request already read in full outside its lane counts), and the fix of any P0 or P1 it found has merged, before that run starts. Run the simulated user (gate 5) on its head, then commit the record. The record names the commit it ran on and is not itself published, so a later push that changes no file the release ships (what `npm pack` publishes, and the Claude Code plugin under `hooks/` and `.claude-plugin/`) and no guide (`docs/GUIDE*.md`) keeps it valid; any other push needs a new run, which may cover only what the push reaches ([USER-SIM.md, A run after a change](validation/USER-SIM.md#a-run-after-a-change)). Once the run that is meant to be the last one starts, merge nothing but the release pull request into `main` until the tag, and say so on the open pull requests, so the record still matches what the tag publishes. A P0 or P1 found after that run starts, in a pull request merged under that R2 exception, goes to the next release, unless the owner decides otherwise. Obtain the approval required by CONTRIBUTING rule 8 and squash-merge with `--match-head-commit` only once every CI job and all other checks required by rule 9 have succeeded on that exact head. Merge only when the head contains current `main`: run `git fetch origin` and `git merge-base --is-ancestor origin/main HEAD` right before the merge. If `main` has moved, merge it, add a CHANGELOG line for each fix or feature it brought, run the simulated user again, and check again before merging. If `main` still moved between the check and the merge, run the simulated user again on the merged commit before the tag. Then the tagged commit publishes the same files as the commit the record was made on.
6. **Tag.** On the merged commit, run `claude plugin tag . --dry-run`, then `claude plugin tag .`. Push only the new tag.
7. **Gate.** Check the release gate above: it decides stable or pre-release.
8. **GitHub release.** Write it from the version's CHANGELOG section, then a link comparing the previous tag with the new one. A pre-release's notes open with: "Pre-release: this version did not pass the release gate (docs/RELEASING.md)."

   ```bash
   awk '/^## X\.Y\.Z /{f=1;next} /^## /{f=0} f' CHANGELOG.md > notes.md
   # PREV is the previous release, for example 0.24.0
   printf '\n**Full changes:** https://github.com/WenyuChiou/agent-board/compare/agent-board--vPREV...agent-board--vX.Y.Z\n' >> notes.md
   # stable
   gh release create agent-board--vX.Y.Z --verify-tag --title "Agent Board X.Y.Z" --notes-file notes.md --latest
   # pre-release
   gh release create agent-board--vX.Y.Z --verify-tag --title "Agent Board X.Y.Z" --notes-file notes.md --prerelease --latest=false
   ```
9. **npm.** The owner publishes; see below.
10. **Close.** Close the milestone. For a stable release, update the README line to the new stable version.

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

Publishing from GitHub Actions with npm trusted publishing and `--provenance` is not set up yet; it is planned for the milestone "Phase 4: One installer". npm allows a trusted publisher only for a package that already exists, so it can only start after the first manual publish.
