# Affected CI

Every PR push and main push computes an affected-check plan. Draft and Ready use
the same rules. The PR metadata checker still runs separately on every PR.

| Change | Product checks |
|---|---|
| Remote Python reporter | Reporter on Ubuntu and Windows |
| Legacy setup.ps1 or setup.sh | Installer on the matching system |
| One existing Node test | That file in its existing platform/Node matrix |
| New root Node test | Automatically included in the board group |
| README only | README contract (on a PR: Node 22 on Ubuntu, Node 24 on Windows) |
| Pane code | Its consumers, including plugin tests |
| Hooks, board bundle, plugin manifest, `package.json`, `.gitattributes`, the test workflow | The same, and the plugin checks, on Windows too |
| Board bundle source | Bundle verification and every bundle consumer |
| Package/plugin manifests, governance, planner, unknown paths | Every group |

The planner reads imports and literal file URLs from both base and head.
Explicit data-file edges cover installers, package contents, the Python parser
contract and README checks. Deleted imports remain relevant through the base
graph. Generated board sources are connected to their bundle consumers.
A shared source may correctly select several groups.

The base copy of the planner decides selection before any head test executes.
A first rollout with no base planner selects every group. Unclassifiable paths
also select every group. Unsafe paths, incomplete diff reads and graph errors
fail planning; they never become an empty passing plan.

On a pull request the test jobs check out GitHub's merge of the pull request into
main (`github.sha`), not its head, so a pull request that is behind main is tested
with main's newer changes. GitHub makes that merge when the pull request is
opened, pushed or reopened. A pull request that is only behind main merges as
it is once its checks pass. A pull request with a merge conflict gets no run
until main is merged. The planner and pr-check still read the pull request's own base and head.
A test file the planner selects from the head must also exist in the merge, so a
pull request whose selected test main deleted or renamed fails until it merges
main.

On a pull request, selected Node groups run Node 22 on Ubuntu and Node 24 on
Windows, and plugin checks run on Ubuntu. They also run on Windows when a changed
path is under `hooks/` (the generated board bundle included) or `.claude-plugin/`,
is `package.json`, `.gitattributes` or `.github/workflows/test.yml` (its Claude Code
version pin), or is a file the plugin loads from outside
`hooks/` (found by the same dependency walk, from the plugin's entry points only);
a plugin test file or a doc alone stays on Ubuntu, and so does a full plan on a pull
request (governance, planner or an unknown path) unless one of those paths changed. The planner writes the systems as `plugin_os`, as it
does `installers_os`. Pushes to main, the weekly run, a manual run and a release PR
run Node 22 and 24 on both systems and plugin on both. Browser checks use
Node 24/Chromium on both systems. Plugin checks keep the pinned offline Claude
runner. Legacy installers and the Python reporter run without installing Claude.
Board and messaging have separate ten-minute jobs. On Windows the board set runs in six parts
and the journeys in two (#1059: Windows runners vary 1.5-1.9x between jobs of one commit, and
four parts left `tests/codex-local.test.mjs` too close to its budget). Each Windows part runs its
files one at a time (`CI_TEST_SERIAL`), and the other Windows jobs run at most two files at once. When
three spawn-heavy files ran side by side on the 4-vCPU runner, every test ran about 1.35x slower, and
the tests with the tightest time limits failed, a different one each run (#910). Each part runs every
sixth (or second) file in one Node run. `tests/codex-local.test.mjs` and `tests/board.test.mjs` take
far longer than the rest (about 8 and 5 minutes there), so every part runs them, each part taking an
equal share of their tests. A serial run times one file at a time and records the times, and a step
after the tests checks them against the budgets in `scripts/ci-impact.mjs` (#902 step 4): a file over
its budget, or a part over 480 s, fails the job and names the slow files. The file budgets come from
step 1 of #902 (each file's share of the Windows board logs, x 1.5); the part budget is re-derived
from recent main runs, since a 420 s job wall already fails on main. A parallel run records no
per-file times, so the file check only applies to serial parts.

Every job that runs tests on Windows first tries to turn off Windows
Defender's real-time scanning (a failure there does not stop the job); the product's own antivirus
handling stays covered by its simulated tests. No
product dependency is added to the npm package.

The always-run affected checks and CI validation jobs record the plan and require
literal success for every selected group. A skipped selected job fails validation.
Unaffected groups are shown as not run, never as passed tests. Missing metadata,
failed planning and cancelled or failed groups block validation.

Branch protection must require affected checks, CI validation and pr-check from
GitHub Actions. Requiring old expanded matrix row names would leave unaffected
PRs waiting for contexts that a skipped matrix never creates. The approved
migration runs the rollout in full first and preserves all other protections.
That migration is done; a pull request now merges main only when GitHub reports
a conflict, or when the maintainer rebuilds the bundle that the merged result needs.
Branch protection does not require a pull request to be up to date with main
(the owner turned that off on 2026-10-31; the required checks are unchanged), so
the merge CI tested may be older than main when it lands. The run on the push to
main checks what landed.

A weekly full run and workflow_dispatch with full=true exercise the complete
catalog. Releases, manifest/governance/planner changes and unknown paths also
run the complete catalog. The separate weekly/manual soak remains unchanged.
I/O, archive, queue, lock and polling changes are marked as soak recommendations;
this signal does not claim a soak ran or silently start one.

Native hooks, real receiver/model ACKs and per-host UI/CLI acceptance remain
separate evidence. Selected synthetic CI cannot establish those capabilities.
