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
opened, pushed or reopened; when main moves on later, merge main or push again
before merging. A pull request with a merge conflict gets no run until main is
merged. The planner and pr-check still read the pull request's own base and head.
A test file the planner selects from the head must also exist in the merge, so a
pull request whose selected test main deleted or renamed fails until it merges
main.

On a pull request, selected Node groups run Node 22 on Ubuntu and Node 24 on
Windows, and plugin checks run on Ubuntu only. Pushes to main, the weekly run, a
manual run and a release PR run Node 22 and 24 on both systems and plugin
on both. Browser checks use
Node 24/Chromium on both systems. Plugin checks keep the pinned offline Claude
runner. Legacy installers and the Python reporter run without installing Claude.
Board and messaging have separate ten-minute jobs. No product dependency is
added to the npm package.

The always-run affected checks and CI validation jobs record the plan and require
literal success for every selected group. A skipped selected job fails validation.
Unaffected groups are shown as not run, never as passed tests. Missing metadata,
failed planning and cancelled or failed groups block validation.

Branch protection must require affected checks, CI validation and pr-check from
GitHub Actions. Requiring old expanded matrix row names would leave unaffected
PRs waiting for contexts that a skipped matrix never creates. The approved
migration runs the rollout in full first and preserves all other protections.
Existing PRs then merge main before using the new gate.
Branch protection also requires a pull request to be up to date with main before
it merges, so the merge CI tested is the one that lands.

A weekly full run and workflow_dispatch with full=true exercise the complete
catalog. Releases, manifest/governance/planner changes and unknown paths also
run the complete catalog. The separate weekly/manual soak remains unchanged.
I/O, archive, queue, lock and polling changes are marked as soak recommendations;
this signal does not claim a soak ran or silently start one.

Native hooks, real receiver/model ACKs and per-host UI/CLI acceptance remain
separate evidence. Selected synthetic CI cannot establish those capabilities.
