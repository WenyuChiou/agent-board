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
Board and messaging have separate ten-minute jobs. On Windows the board set runs in ten parts
and the journeys in three (#1059: Windows runners vary 1.5-1.9x between jobs of one commit, and
four parts left `tests/codex-local.test.mjs` too close to its budget; #1718: part 5 of six ran
past its 480 s with every test passing; #1762: a part of seven ran over its 480 s in 4 of 11 runs, on runners
up to 1.6x slower; #1722: journeys part 2 of two ran up to 545 s of its ten
minutes and was once cancelled at the limit; `tests/e2e/l3c-message-store-ownership.test.mjs`
took up to 294.4 s of such a part and now runs in a part of its own). Each Windows part runs its
files one at a time (`CI_TEST_SERIAL`), and the other Windows jobs run at most two files at once. When
three spawn-heavy files ran side by side on the 4-vCPU runner, every test ran about 1.35x slower, and
the tests with the tightest time limits failed, a different one each run (#910). Each part runs a share
of the other files, dealt out slowest first, each to the part with the least time so far (`partFiles`, #1059):
on Windows one file at a time, each in its own Node run, and on Ubuntu in one Node run. A file weighs its measured time in `tests/ci-test-times.json` (#1762), else about its slowest Windows time, read back from its time budget, and a file with no budget 5 s. `tests/codex-local.test.mjs`, `tests/board.test.mjs`, `tests/legacy-connect.test.mjs` and `tests/opencode-receiver.test.mjs` take
far longer than the rest (about 8 and 5 minutes there), so every part runs them, each part taking the tests that the same table deals it: slowest first, each to the part with the least time so far, so every part gets the same time from them whatever the number of parts, and the parts together run each test once. A test the table does not know (added since it was made) goes to the part its title hashes to, and no other test moves. `tests/messaging.test.mjs` is dealt the same way in the local exchange job. Refresh the table, in the pull request that adds or removes many tests or a test file, with `node scripts/ci-test-times.mjs <job logs of a main run>`; `tests/ci-impact.test.mjs` also fails when the table says the heaviest Windows board part would take over the part budget on a runner 1.6 times slower than the table, which means adding a part or making tests faster. Before the table, the shares of seven parts were measured by hand and any other number of parts started every part from zero, so the slowest other file went to part 1, the part with the largest share, and part 1 ran over its 480 s (#1733). On Ubuntu the board set runs in three parts: files run side by side there, but
Node runs one file's tests one after another, so a single part ran about as long as `codex-local` alone
(449.9 s of that file in a 498.5 s run, over the 480 s part budget; #1130). In two parts a part still ran
483.6 s on `main` 68980f8c with tests that had taken 358.7 s on the pull request's own run, so three (#1764). A serial run times one file at a time and records the times, and a step
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
GitHub Actions. pr-check reads the `Review:` verdict comments when it runs, and a
comment starts no pull request run, so `pr-check-rerun.yml` starts the pull
request's newest pr-check run of the head again, once it has finished, when a
team member or an app posts, edits or deletes a comment that mentions `Review:`
in any letter case (#1258). When it cannot, it leaves the check as it is and
says why in a comment on the pull request: the pull request changes
`pr-check.yml` itself; another open pull request has the same head branch; the
run waits for a maintainer's approval (approving it runs the check); no run is
listed for the head, or the run does not finish, within 9 minutes; GitHub
refuses the re-run (a run older than 30 days, or re-run 50 times) or does not
answer in time; or a step before its script fails or passes its time limit.
When the run it waited for has finished but the pull request has closed, or
has a new head, it stops with nothing said: a closed pull request needs no
check, and after a push the new head's own run reads the comment, while starting
the old run again would cancel that one. An outside account's comment
(#1535), and a comment a workflow posts with its own token, start nothing; the
next pull request event reads them. Requiring old expanded matrix row names would leave unaffected
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

## Windows runner sampler

Every job that runs tests on Windows runs `scripts/ci-sampler.ps1` there in the background (#1249). It wakes every 250 ms, and when a wake-up comes more than a second late it writes one line to `gaps.jsonl`: the gap on the monotonic clock (`gapMs`) and on the wall clock (`wallMs`), the busy and idle CPU time the system counted over the same gap, summed over all `cores` (`systemBusyMs`, `systemIdleMs`), how long its own reads took (`readMs`), and as hints the ten processes that gained the most CPU since the last look (`top`, `totalCpuMs`: processes still running only), free memory and the disk queue. Its two steps each have a one-minute limit and `continue-on-error`, so they cannot fail or hold a job, and each job has two minutes more on Windows than on Ubuntu, one for each, so they never take time its tests had. A free-memory read that fails is `null`, not 0. The stop step prints a summary and the 20 largest gaps to the job log, each with `accounted` = (busy + idle) / (gap × cores), the share of the gap the system's CPU counters moved through. Nothing is uploaded, and the sampler gives no verdict: what a paused VM looks like in these fields is not known yet, and a rule comes once real gap records from `main` have been read.
