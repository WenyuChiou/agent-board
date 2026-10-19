# Codex trust fallback implementation checkpoint

Base c5ee776. Only synthetic absolute mock control scripts were run; no real Codex/model/settings/trust mutations.

The native worker now probes exact three-event ownership/trust before acquiring the canonical lock, rechecks source bytes after installation, and retains/restores a managed instruction section until approved. A read-only status projects current approval without AGENTS writes. Existing nonempty override is effective; empty override is left alone. Marker edits preserve outside bytes and refuse malformed/multiple sections. Generated reporting commands use only a positively owned board. Existing reporter/board failures prevent fallback retirement even if definitions were approved.

The existing trust setter remains six-definition-only and was not called. PATH discovery accepts only absolute executable candidates; unsupported Windows shims remain unknown. Each read-only control request is bounded to one second in the worker, with no CODEX_HOME changes.

First focused batch:

ℹ tests 48
ℹ pass 47
ℹ fail 1
ℹ skipped 0
ℹ duration_ms 28930.6916

Its sole failure was the old status migration assertion comparing projected current readiness to stored metadata. The original exact migration assertion now checks the canonical record, with additional assertions for projected unknown approval.

Second focused batch:

ℹ tests 48
ℹ pass 45
ℹ fail 3
ℹ skipped 0
ℹ duration_ms 41844.5062

All three failures were a new fixture ReferenceError: a changed-definition scenario was placed before its config constant. The scenario was moved after positive approval. The slice 10 batch below verifies that correction and the empty-override and owned-artifact retirement safeguards.

Slice 10 first focused batch (`issue-102-slice10-focused-first.log`): 52 tests, 51 passed, one failed, 56.914 seconds. The newly added adversarial fixture changed hooks while the instructions file was read. The original approval snapshot incorrectly retired the fallback. Rechecking the source fingerprint and positively owned board/reporter after reading each instruction file closes this observed window.

Slice 10 final focused batch (`issue-102-slice10-focused-final.log`): 52 tests, 52 passed, zero failed or skipped, 51.336 seconds. This runs all 17 inspector mocks plus fallback, legacy-transaction and bootstrap tests. Empty overrides remain empty; replacing an owned board or reporter retains existing fallback even after approval; changed hook definitions restore fallback in each language.

Strict standalone TypeScript, strict plugin validation, pinned Bun bundle generation/check and whitespace validation passed on the frozen final runtime. The prior pane assertion now expects managed Codex instructions to remain while approval is unknown.

The exact Claude Code 2.1.301 full plugin run (`issue-102-slice10-plugin.log`) finished with 483 passed and five failed, 488 total across nine files, 317.92 seconds. One existing inbox-read fixture timed out at 5016.53 ms against its unchanged 5000 ms limit; its cause remains unproven. Four pane notification assertions expected the old summary-only/silent Codex setup behavior. They are narrowly updated to require exactly one notification containing the original summary and the new unknown-trust notice, or the exact new notice when hook bytes stay unchanged. These four assertion changes still need a fresh plugin run; no runtime change or timeout increase follows this result. Full Node acceptance and exact-head CI also remain pending. No #102 completion claim.

The shared native lock coordinates cooperating installers. A noncooperating external writer can still alter source or instructions after the final comparison and before a write; these checks do not provide a filesystem CAS. Approval discovery is read-only, and unsupported discovery retains fallback rather than guessing a trust hash.

## Integrated release validation

Merged release head `186b85ad46dee91112b3fbd4d4260143da7bd0da` into `d199cf5`, keeping #102 under Unreleased and the 0.23.3 entries separate. The bundle was regenerated with pinned Bun 1.4.2 and its current-board fingerprint exclusion. Strict standalone TypeScript, strict plugin validation, Bun bundle check and whitespace validation passed before the frozen suites.

At frozen runtime `ccdc093`, exact offline Claude Code 2.1.301 passed **488/488** plugin tests across nine files in 188.58 seconds (`issue-102-integrated-plugin.log`). All four corrected notification fixtures passed; the unchanged inbox-read case passed in 3283.08 ms under its original 5000 ms limit. Prior red results remain evidence; the later pass does not establish the earlier timeout's cause.

The complete 11-file CI Node suite ran with concurrency 1: **257 passed, zero failed, two platform skips**, 259 total in 383.444 seconds (`issue-102-integrated-node.log`). Synthetic inspector paths use absolute temporary mock/missing executables. The pane memory adapter bypasses native observation; the generated worker failure fixture stops at NODE_REQUIRED. A separate read-only call-site audit found no test route to real Codex PATH discovery.

After both readers exited, merged the actual published release ancestor `5610ce6a051ba772ee074ac50bdcbc22c6195f6f`. Runtime and fixture SHA-256 inputs remained identical to the frozen suite snapshot. Pinned Bun `build-released.ts --check` passed with the published `agent-board--v0.23.3` tag visible (`issue-102-integrated-released.log`); the ownership table was not edited by hand.

Exact-head CI and root trust/final review remain required. These are local synthetic checks, not an actual native hook-approval claim. No real host API, model, permanent settings or trust mutation was used.

## Combined question-aging validation

Merged actual main `04950f102ca8a4d644badbefb0c0bdea5e2dcf79` at frozen runtime `364db438be5d790537b74c4411a3fe57c2438f37`. Preserved both features' Unreleased/guide text and the separate 0.23.3 entries, regenerated the bundle with pinned Bun, and retained the release fingerprint loader and type/API guards. Supported standalone strict TypeScript, strict plugin validation, both Bun generated-file checks and whitespace validation passed before the readers.

The fresh exact Claude 2.1.301 plugin suite finished **515 passed, one failed**, 516 tests across ten files in 225.59 seconds (`issue-102-combined-plugin.log`). The existing `an invalid input does not prevent a later valid session from reaching the board` fixture reported 6878.24 ms and only `Error: timed out after 5000 ms`, without a failed assertion or stack. Its test body is unchanged by the merge and passed in 911.92 ms on the earlier runtime, which does not establish this timeout's cause. No timeout increase, assertion change, runtime fix or full plugin retry followed this result.

The fresh complete 11-file Node suite ran with concurrency 1: **259 passed, zero failed, two platform skips**, 261 total in 318.549 seconds (`issue-102-combined-node.log`). All runtime and test SHA-256 inputs match the snapshot captured before the readers. The combined plugin timeout remains unresolved; prior green counts are not reused as combined acceptance. Root trust/final review and exact-head CI remain required.

After root's historical-table reader exited, one ignored fixture registered only the original failing test and measured its original mocked callbacks. All three original assertions and the default 5000 ms limit remained unchanged. It passed in **749.72 ms**: probeStart began at 1 ms and ended at 409 ms; clock.advance began at 410 ms and ended at 740 ms; assertions finished at 740 ms. The first mocked callback arrived at 340 ms and model.complete returned at 686 ms. The detailed timeline is retained in `issue-102-isolated-diagnostic.log`. A preceding diagnostic-copy CRLF parsing error registered zero tests and is retained separately in `issue-102-isolated-preparation-error.log`. No product code changed. This isolated pass does not prove the full-suite timeout's cause or replace combined full-plugin acceptance; no full rerun followed.

## Frozen tagged-adoption integration

Merged common fix `fc1c494c0bf54f263da5d62bb569e0b4995740ba` at runtime `254e8d447fd1474de19d4f3500790f064abd49b2`. Kept both changelog branches, regenerated the 450892-character bundle with pinned Bun, and passed supported standalone strict TS, strict plugin validation, Bun board check and whitespace checks. No full released-table scan was repeated. The ignored diagnostic copy was renamed to `.fixture.tsx` before collection. The complete runtime/test SHA snapshot (`issue-102-adoption-inputs.json`) matched after the reader exited.

The one authorized fresh exact Claude Code 2.1.301 full plugin run finished **506 passed, ten failed**, 516 tests across ten files in 294.39 seconds (`issue-102-adoption-plugin.log`). All ten failures are in `tests/pane.test.tsx`, each reporting only `Error: timed out after 5000 ms`; no assertion mismatch was reported. Reported durations were:

| Case | Reported ms |
| --- | ---: |
| progress.html beside progress.md and opening the browser | 5576.14 |
| progress.html pending inbox question and processed-copy cleanup | 8511.87 |
| first run does not announce existing work | 6568.94 |
| unmarked end-of-turn question waits until answered | 6132.34 |
| own review answer retires waiting until Claude asks again | 10085.36 |
| only the person's own message settles this session | 5062.99 |
| failed pane reply leaves the original step waiting | 7473.32 |
| Codex next turn ends its previous question | 9235.77 |
| pane first observations with unreadable/unwritable storage | 5683.92 |
| empty progress read preserves first-seen time | 11438.00 |

The two page/Codex failure reports also retain dropped `ui.status` diagnostics (`no implementation for ui.status`); no causal link is established. The prior invalid+valid inbox timeout case passed in this run at 1204.83 ms, which likewise does not establish a cause. Original assertions and the 5000 ms limit remain unchanged. No product fix, blind retry, Node suite or actual-main merge followed this result; root requested a terminal checkpoint before the next slice. Final combined plugin acceptance, fresh Node validation after actual-main integration, and root trust/CI review remain pending.

## Focused mock timestamp correction

On actual-main integration `720a952`, corrected only the pane filesystem fixture: an internal progress write increments `world.mtime`, while any sidecar Map set advances that file's `world.mtimes` entry. File stat respects sidecar entries; direct fixture `world.mtime++` still renews progress. The instance-only Map setter calls `Map.prototype.set.call` rather than capturing a previous override, preserving native Map branding and avoiding wrapper nesting on fixture restart. It does not mutate the global prototype. The existing explicit per-file seed is used for newest-thirty inbox ordering. No product code or `ui.status` mock changed, and no existing assertions or timeout values changed.

The new `mock file timestamps isolate sidecar writes and preserve explicit progress renewals` regression invokes the exact registered in-memory FS handlers inside an offline SDK fixture. It checks dashboard/metadata writes, progress stat, sidecar stat/list consistency, progress writes and an explicit progress renewal. With the old helper it failed in 10.38 ms: expected progress timestamp 10, received 11 after a dashboard write (`issue-102-mtime-red.log`). The same test passed in 12.85 ms after the helper correction (`issue-102-mtime-green.log`), under the unchanged default 5000 ms limit. Its normalized test-body SHA-256 is `717aa18f9954f62b281e973750376705c36642436b854622deca0ba34ca24c4b` in both runs. This proves the fixture metadata correction, not a polling-performance improvement or the cause of previous timeouts/large Node walltime stalls.

The initial internal-write-only fix left direct sidecar replacements unstamped. Expanded the same regression with a direct same-size metadata replacement and native Map get/set checks. Before the instance setter fix it failed in 12.15 ms: expected metadata timestamp greater than 11, received 11 (`issue-102-mtime-direct-red.log`). The unchanged expanded test passed in 12.64 ms afterward (`issue-102-mtime-direct-green.log`), under the same 5000 ms limit; its normalized body SHA-256 is `5f9045ab744f0d6c94d84ae8c127dfa389d44b1fa8c33360f3408241b8d84ca3` in both runs. Two unreadable-file fixture setups replaced their Map after startup; they now clear/reseed that same instance so its setter remains installed, with their assertions untouched. No `mtimes[FILE]` seed was found.

No full suite was run after this change. The focused regression proves timestamp isolation and direct-replacement compatibility, not the cause or resolution of full-suite timeouts or prior large Node walltime stalls. Final-input hashes are retained in `issue-102-mtime-inputs.json`; all previous full-suite failures remain retained. Parent-owned board timeout guards are outside this scoped commit.

## Adoption fixture integration

The first PR #141 CI head, `7645141`, failed the four actual bundled-adoption
cases because the shared fixture now supplied an explicit missing control binary.
The preload correctly blocked that attempted spawn, failing the existing
no-child-process assertion before any host could execute. These four cases now
omit that shared option while retaining their own allowlisted home, empty PATH
and child-process blocker. General trust fixtures still use an explicit synthetic
or missing executable, and the no-native-attempt assertion is unchanged.

All four adoption cases passed afterward on Node 24.12.0 in 4.514 seconds
(`issue-102-adoption-guard-green.log`). The initial CI failures are retained in
the acceptance workspace, not replaced by this focused result. Product code,
trust and permanent settings are unchanged by this fixture correction.

## Bounded page fixtures

The next complete 11-file Node attempt on actual-main merge `720a952` was interrupted
without a final suite summary. Two page cases had failed after reporting
849953.37 ms and 1294043.54 ms; the cause remains unproven. Its partial log is
`issue-102-final-node.log`, with interruption evidence retained separately. It is
not a green full-suite result. The exact test runner was no longer present in a
subsequent normalized-command process check; no unrelated processes were killed.

The page test helper now bounds HTTP requests at 5000 ms, synchronous VM script
evaluation at 1000 ms and the forged-archive terminal subprocess at 5000 ms.
Original assertions and outer 30000 ms test limits remain unchanged. The two
previously stalled cases passed **2/2** in 12.162 seconds: live-block archive
protection in 2223.94 ms and three-language Confirm done in 4544.56 ms
(`issue-102-bounded-pages.log`). This proves the bounded helper's positive paths,
not the cause of the earlier stalls. Final complete suites and exact-head CI
remain required.

## Historical hide snapshot fixture

At `7645141`, CI and local full plugin runs reached the same assertion failure in `historical hide marks survive failed reads while an observed renewed question gets a fresh identity`. Ubuntu CI recorded 516 passed/one failed in 113.32 seconds; local `issue-102-fixed-plugin.log` recorded 516 passed/one failed in 296.16 seconds, with this case failing in 1063.47 ms. The expected bytes were the initial compact two-key JSON, while the actual bytes retained both legacy keys and added the legitimate durable question/migration keys during startup. These are assertion failures, not 5000 ms timeout failures; their logs remain retained.

The fixture now captures exact ANSWERED bytes immediately before making the file unreadable, first asserts the original `[other, key]` prefix, and checks byte equality against that snapshot after the denied press. All later renewal/migration assertions and the 5000 ms limit remain unchanged. No product code changed.

One focused offline Claude Code 2.1.301 SDK run passed this complete case in **2910.37 ms** (`issue-102-hide-snapshot-focused.log`). Its normalized test-body SHA-256 is `0db1fd7bc1be18c8c8d60adce67986a24552c6d7ee6007f63f1b7df60a4b2525`; final source hashes are retained in `issue-102-hide-snapshot-inputs.json`. No full rerun was performed in this packet, and no overall timing-cause claim follows from the focused pass.
