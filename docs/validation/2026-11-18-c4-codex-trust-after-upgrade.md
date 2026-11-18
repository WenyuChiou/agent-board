# C4: why an upgrade dropped Codex's hook approval (#1303)

- **Date:** 2026-11-18
- **Check:** C4 of `docs/dev/plan-0.25.1.md` (section 3, M0). It feeds M2.
- **Verdict:** pass. The cause is settled for the upgrade #1303 reported.

## Question

Why did an upgrade drop Codex's hook approval when the hook text had not changed? If this cannot be settled, "trust not confirmed now" becomes an ask and the Codex ceiling for the 0.25.0 upgrade becomes 4 steps.

## Answer

Codex's approval does not cover only the command text. It covers the whole hook definition, and it is stored against the hook's position in `hooks.json`.

The 0.24.2 to 0.24.3 upgrade did two things:

1. It raised the `UserPromptSubmit` timeout from 3 to 10 seconds. The command stayed byte for byte the same, but Codex's hash changed, so Codex reports the hook as `modified`.
2. It added a new hook, `PostToolUse`, which nobody had approved, so Codex reports it as `untrusted`.

That is the two hooks the issue saw. The upgrade did not touch the approvals: `config.toml` was byte-equal before and after. The stored approval simply stopped matching.

The check also found two ways to lose the approval when the board's hook definition is the same or the release did not change it. See "Other ways to lose the approval".

## Versions

| Item | Version |
|---|---|
| agent-board tags | 0.24.0 (`2facf8ad`), 0.24.1 (`7971d828`), 0.24.2 (`4a9785f0`), 0.24.3 (`bd586106`), 0.25.0 (`dd510176`) |
| agent-board main | `a679f24f` |
| Codex CLI | 0.167.0, the npm package's native Windows x64 binary, not signed in |
| Second Codex build | 0.167.0-alpha.3.2, the binary bundled with the Codex desktop app, read-only use |
| Node | v24.14.0 |
| System | Windows 11 Home 10.0.26300 |

The scripts, hooks, launcher and `package.json` are identical at 0.25.0 and `a679f24f`: `git diff --stat agent-board--v0.25.0 a679f24f -- scripts hooks bin package.json` prints nothing. The step "0.25.0 to main" therefore installs the same code again. It says nothing about what the real 0.25.1 will do.

## Steps to repeat

Everything ran in temporary homes with synthetic hooks. No model was called and nothing was signed in.

1. Extract each release without a checkout: `git archive agent-board--v0.24.2 bin scripts hooks package.json | tar -x -C <temp>/src/v0.24.2`.
2. Make a new folder `<temp-home>`. Point `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, the `XDG_*` folders, `TMP` and `TEMP` inside it.
3. Install: `node <temp>/src/v0.24.2/scripts/setup-agent.mjs --agent codex --home <temp-home> --apply --json`.
4. Approve: `node <temp-home>/.agent-board/agent-board.mjs --codex-trust --codex-bin <codex.exe> --apply --json`.
5. Save `.codex/hooks.json` and `.codex/config.toml`. Start `<codex.exe> app-server --stdio`, send `initialize`, `initialized` and `hooks/list`, and save the answer.
6. Upgrade: `node <temp>/src/v0.24.3/scripts/setup-agent.mjs --agent codex --home <temp-home> --apply --json`.
7. Save the same files and ask `hooks/list` again. Compare the files byte by byte and each stored `trusted_hash` with Codex's `currentHash`.
8. Read the result: `node <temp-home>/.agent-board/agent-board.mjs --codex-doctor --agent codex --codex-bin <codex.exe> --json`.

For what the hash covers, one synthetic `hooks.json` was approved through Codex's `config/batchWrite`. One thing was then changed at a time, and `hooks/list` was asked after each change.

## Results

### Four upgrades

| Upgrade | Hooks | Approved after the upgrade | `config.toml` byte-equal | `hooks.json` byte-equal | Doctor, before and after |
|---|---|---|---|---|---|
| 0.24.2 to 0.24.3 | 6 to 7 | 5 of 7 | yes | no | true, then false |
| 0.24.3 to 0.25.0 | 7 to 7 | 7 of 7 | yes | yes | true, then true |
| 0.25.0 to `a679f24f` | 7 to 7 | 7 of 7 | yes | yes | true, then true |
| 0.24.2 to `a679f24f` | 6 to 7 | 5 of 7 | yes | no | true, then false |

### The trust entries in the 0.24.2 to 0.24.3 upgrade

Entries look like this in `config.toml`:

```toml
[hooks.state.'<temp-home>\.codex\hooks.json:user_prompt_submit:0:0']
trusted_hash = "sha256:c9c959c1d3dc1058f623001179322232be9e9deb0d7eadfc24f326488285036f"
```

The key is the source file, the event, the group's index and the handler's index. Hashes below show the first 12 characters.

| Slot | Stored `trusted_hash` | Codex's `currentHash` after the upgrade | Equal | Codex says |
|---|---|---|---|---|
| `permission_request:0:0` | `80ce4914f3d0` | `80ce4914f3d0` | yes | trusted |
| `session_start:0:0` | `ee9c107136b1` | `ee9c107136b1` | yes | trusted |
| `session_end:0:0` | `d8e039db2164` | `d8e039db2164` | yes | trusted |
| `stop:0:0` | `d93302fb510f` | `d93302fb510f` | yes | trusted |
| `interrupt:0:0` | `160db04b98e0` | `160db04b98e0` | yes | trusted |
| `user_prompt_submit:0:0` | `c9c959c1d3dc` | `5f839f9d8fc1` | **no** | **modified** |
| `post_tool_use:0:0` | none | `aeed2622ea8e` | **no** | **untrusted** |

For `user_prompt_submit`, the command was 2814 bytes with the same SHA-256 before and after (`ccf5b27f1401af19…`). The only field of the hook that changed was `timeoutSec`, from 3 to 10.

Running the issue's closing steps in that home gave `changes: 2` in the preview, left `config.toml` unchanged, and then 7 of 7 approved after `--apply`. That matches the issue's "trusted the board's 2 hooks".

The two changes come from `b2ca14aa` (#917, the `UserPromptSubmit` timeout) and `9f9b56bd` (#962, `PostToolUse`). Today's value is at `hooks/hook-safety.ts:17`. The timeout reaches `hooks.json` at `scripts/codex-local.ts:1414`.

### What the hash covers

Reference: one approved `SessionStart` hook with a command and a timeout of 3. Codex CLI 0.167.0.

| Change | Hash | Slot | Codex says |
|---|---|---|---|
| Same file written again | same | same | trusted |
| JSON reformatted | same | same | trusted |
| CRLF line ends | same | same | trusted |
| Handler keys in another order | same | same | trusted |
| An unknown extra field in the handler | same | same | trusted |
| **The file the command runs is rewritten** | same | same | trusted |
| Another event added after it | same | same | trusted |
| Another event listed before it | same | same | trusted |
| A second group added after it | same | same | trusted |
| **Timeout 3 to 10** | changed | same | modified |
| Timeout 3 to 4 | changed | same | modified |
| Timeout removed | changed | same | modified |
| Command: one character added | changed | same | modified |
| Command: one trailing space | changed | same | modified |
| `statusMessage` added | changed | same | modified |
| Group `matcher` added | changed | same | modified |
| `async` set to true | changed | same | modified |
| **A person's group placed before it** | same | moved to `session_start:1:0` | untrusted |
| The same handler under another event | changed | moved | untrusted |
| Put back to the approved definition (tried twice) | same | same | trusted |

The last row matters: nothing is erased. The stored entry stops matching and starts matching again when the definition comes back.

The hashes and approvals were the same in both Codex builds tested (CLI 0.167.0 and app 0.167.0-alpha.3.2, 7 of 7 hooks).

### Every release step

One home was upgraded through each tag. Before each step every hook was approved again, so each row counts only what that step lost.

| Step | Hooks | Approved after | What lost the approval | Hook runner file changed |
|---|---|---|---|---|
| 0.24.0 to 0.24.1 | 6 to 6 | **0 of 6** | All 6 commands changed. On `Stop`, the one compared in full, only the first word differs: `"C:\Program Files\nodejs\node.exe"` became `C:\PROGRA~1\nodejs\node.exe` | yes |
| 0.24.1 to 0.24.2 | 6 to 6 | 6 of 6 | nothing | no |
| 0.24.2 to 0.24.3 | 6 to 7 | **5 of 7** | `UserPromptSubmit` timeout 3 to 10, and the new `PostToolUse` | yes |
| 0.24.3 to 0.25.0 | 7 to 7 | 7 of 7 | nothing | **yes** |
| 0.25.0 to `a679f24f` | 7 to 7 | 7 of 7 | nothing (same code) | no |

Two of the four real release steps lost the approval. In 0.24.3 to 0.25.0 the hook runner file and the board script both changed and all 7 approvals held.

### Other ways to lose the approval

Each row starts from 0.25.0 with every hook approved.

| Case | Result |
|---|---|
| A. The same version run again | 7 of 7 approved |
| B. Upgrade to `a679f24f`, nothing else | 7 of 7 approved |
| **C. The person's own approved `SessionStart` hook sits after the board's, then an upgrade** | The two groups swap slots. Both hashes are unchanged, both hooks become `modified`, 6 of 8 approved, doctor false |
| **C2. Same as C, with no upgrade, only the same version run again** | The same swap. The board's trust step repairs the board's hook. **The person's own hook stays `modified`** |
| D. The person's own hook sits before the board's | 8 of 8 approved |
| **E. The upgrade is started by the same `node.exe` copied to another folder** | All 7 commands change (on `Stop`, the first word was read and is the new Node path), 0 of 7 approved. The doctor from that Node says false. The trust command from the Node on `PATH` stops with `OWNED_CODEX_INSTALL_REQUIRED` |
| F. The person removed the `Stop` approval before the upgrade | `config.toml` byte-equal across the upgrade, `Stop` stays `untrusted`, 6 of 7 approved, doctor false |
| G. No Codex can be found | The doctor answers `unknown` |

Case C comes from `scripts/codex-local.ts:1432`, which always puts the board's group last. Case E comes from the Node path written into the command at `scripts/codex-local.ts:1407` and `scripts/windows-hook-node.ts:8-15`.

## What is proven and what is inferred

**Proven by a run, on Windows with Codex 0.167.0:**

- A trust entry is keyed by source file, event, group index and handler index.
- The hash changes with the event, matcher, command, timeout, `statusMessage` and `async`. It does not change with JSON formatting, key order, unknown fields, other hooks, or the contents of a file the command runs.
- The #1303 upgrade lost its approval through one timeout change and one new hook.
- Setup does not write `config.toml` during an upgrade, so it neither repairs nor revokes an approval.
- A revoked approval stayed revoked across an upgrade.
- A rewritten hook runner file does not lose the approval while the command line stays the same.

**Inferred, not run:**

- The exact hash formula is unknown. I tried 378 canonical JSON forms and none matched, so only the inputs are known. The product should keep asking Codex and never compute this hash itself (`scripts/codex-host.ts:245-248`).
- Linux and macOS should behave the same way, because the entry format comes from Codex. This was not tested.
- A Node version manager that gives each Node version its own folder should lose the approval at each Node update, as case E did.
- The plugin route (#1161 item E) probably has the same cause. See "Not run".

## How setup can confirm trust after an upgrade

Setup can ask Codex, using the read-only path the doctor already has (`scripts/codex-local.ts:1709-1728`, `trustCodex(..., false)` at `scripts/codex-host.ts:269-285`). No hook has to change.

1. **Before writing:** ask `hooks/list` and record each board hook's `trustStatus`.
2. **Write the files.** Do not write `config.toml`.
3. **After writing:** ask `hooks/list` again and match the board's hooks by event and command.
4. **Decide:**
   - All `trusted`: confirmed. Print one line.
   - Approved before and not approved now: the upgrade lost it. Ask, and name each hook and what changed.
   - Not approved before: the person's earlier choice stands. Do not approve it.
   - Codex not found or no answer: not confirmed. Never infer approval from `config.toml`, because `inspectCodexConfigToml` can only answer `false` or `unknown` (`scripts/codex-host.ts:122-130`).

Measured on this computer:

- The doctor's read-back took 546 ms at the median of 5 runs (511 to 716 ms).
- It found Codex by itself in the one run without `--codex-bin` (444 ms).
- `config.toml` was byte-equal after every read-back preview that ran.

Steps 1 and 4 are a design. Only the read-back itself was run, through the doctor and the trust preview. No prototype of the new `setup --update` flow was built.

## Not run

- **Linux and macOS.** Only Windows was available.
- **A Codex version with a different hash scheme.** Only two builds of 0.167.0 were available, and nothing may be installed for this check.
- **A hook firing in a real Codex session.** Approval state was read from `hooks/list` only, with no sign-in and no model call.
- **The Codex app's own approval prompt.** Nothing was clicked or typed in any window.
- **The plugin route end to end (#1161 item E).** I ran each tag's `agentHooks` edit on a synthetic file. My harness did not make it recognise the earlier hook as its own, so it appended groups and the trust result there means nothing. The one usable observation: 0.24.2 wrote `UserPromptSubmit` with timeout 3 and 0.24.3 wrote timeout 10 with the same command.
- **A real 0.25.1 upgrade.** It does not exist yet, and `a679f24f` ships the same code as 0.25.0.
- **Tags before 0.24.0.** The walk starts at 0.24.0, the first tag with a `package.json`. Older tags were not walked.

## Verdict and effect on the plan

**Pass.** The failure branch of C4 does not apply, so the J11a ceiling for Codex stays at 3 (plan section 7, gate line 5). That ceiling holds on the path where Codex confirms all hooks after the upgrade.

Changes this result asks of the plan:

1. **M2's ask rule, first clause.** "A hook's command changed" alone misses a timeout change. M2's read-back of Codex's trust still catches #1303 (plan line 85). Wider wording is optional, for clearer reporting: a hook's definition changed (command, timeout, matcher, status message, async), a hook was added, or a hook moved slot.
2. **"No hook change" in 0.25.1.** Gate line 9 already compares events, matchers, timeouts, groups, additions and removals, and the definition on plan line 10 should match it. Rewriting the hook runner file is safe for approval as long as the command line stays byte-equal.
3. **Keep the read-back in M2.** A version comparison cannot see cases C, E, F or G.
4. **Two defects need a home in M2, each with a test (#1661, #1662):**
   - Setup moves the board's group behind a person's later group, and the person's own approval is lost with no way for the board to restore it (`scripts/codex-local.ts:1432`).
   - Running setup from a Node in another folder rewrites all 7 commands.
5. **The J11a walk must still run on the release build** (section 7, gate line 10a), because `a679f24f` is the same code as 0.25.0.

The open question on #1303 and #1314, whether approval is bound to the command text or to a file hash, now has an answer: neither. It is bound to the hook's definition and its slot, and never to the contents of a file.
