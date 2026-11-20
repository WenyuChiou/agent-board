# C5: what a Claude Code plugin update changes, and when

Date: 2026-11-18. Plan: agent-board 0.25.1, check C5 (M0). Repository at main `a679f24f`.

## Questions

- (a) Does a plugin update replace `scripts/claude-approval.mjs` for a running Claude Code session, or only for a new one?
- (b) Is `claude plugin update agent-board@agent-board` the right command?
- (c) Can the person turn on automatic updates for this marketplace?

## Short answers

- (a) **Only a new session, or a running session after `/reload-plugins`.** After an update, a running session kept calling the old version's script path until the reload. The old version's files stay on disk, so that path keeps working. Observed twice, on a headless session (see "Not run" for the interactive part).
- (b) **It is the right update command, but not enough alone for a plugin that came from GitHub.** `claude plugin update` reads the local copy of the marketplace and did not fetch a newer one. It printed "already at the latest version" while a newer version was waiting in the remote. The two commands that work are `claude plugin marketplace update agent-board`, then `claude plugin update agent-board@agent-board`. `docs/GUIDE.md:223` already names both.
- (c) **Yes, but not from the command line and not by default.** Per Claude Code's documentation, a third-party marketplace has auto-update off by default, and the person turns it on in `/plugin`, tab Marketplaces, "Enable auto-update". Not run (see below). Even with it on, the running session keeps the old version until a reload or a new session.

## Versions

- Claude Code CLI 2.1.322 (`claude --version`).
- Node v24.14.0.
- Windows 11. Git for Windows.
- Public documentation read on 2026-11-18: the pages "Install and manage plugins" (discover-plugins), "Plugin loading reference", "Host and maintain a marketplace" and "Create a marketplace" on code.claude.com.
- Real plugin files this check relied on, at main `a679f24f`:
  - `hooks/hooks.json:7` runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-approval.mjs"` as the `PermissionRequest` command, timeout 45.
  - `hooks/hooks.json:2` also lists `"modules": ["./register.tsx"]`.
  - `.claude-plugin/plugin.json:3` and `.claude-plugin/marketplace.json:15` both pin `"version": "0.25.0"`.
  - `docs/GUIDE.md:112-113` is the install text (add the marketplace, then install). `docs/GUIDE.md:223` is the update text.

## Setup (so someone can repeat it)

Everything ran under `<temp>/tmp-c5/`. Two separate Claude Code homes (`home` and `home2`) were used. For each, these variables pointed inside it: `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_*`, `TEMP`, `TMP`. Also `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. The real home and its tool folders were not touched.

The synthetic plugin is a small copy of the real one, in its own git repository (`mkt`):

- Copied from main: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `scripts/claude-approval.mjs`.
- Changed in the copy:
  - Version `0.25.0` became `0.0.1`.
  - The `types` line was removed from `plugin.json`.
  - The `"modules"` line was removed from `hooks/hooks.json`. Without this the copy fails to load, because it does not carry `hooks/register.tsx`. So the board's own hook module was not exercised.
  - A last line `// SYNTHETIC-MARKER v1` was appended to the script. Each new version changed that marker and the version number.
- Later versions (0.0.3 and after) also added a small `scripts/trace.mjs` and two more hooks (`SessionStart`, `UserPromptSubmit`). It appends one line per call to a file: its own path, `CLAUDE_PLUGIN_ROOT`, and the marker found in the sibling `claude-approval.mjs`. This stands in for the real hook, which only fires on a permission request and needs a model.

Two kinds of marketplace were built:

1. **Folder marketplace** (home 1): `claude plugin marketplace add <path to mkt>`. Claude Code reports "Source: Folder" and reads the plugin in place.
2. **Git marketplace** (home 2): the way a GitHub marketplace behaves. `claude plugin marketplace add` only accepts `owner/repo`, an `https://` URL, or a folder, so a fake address `https://example.test/synthetic/agent-board.git` was mapped to a local bare repository with a git `url.insteadOf` rule in a git config file inside the experiment folder (`GIT_CONFIG_GLOBAL`). Nothing was downloaded. New versions were "published" by running `git fetch` into that bare repository.

## Steps and results

### 1. Folder marketplace: install and update (home 1)

1. `claude plugin marketplace add <mkt>`, then `claude plugin install agent-board@agent-board`.
   - First try failed to load: `Path not found ... hooks\register.tsx`. That is the `modules` line described above. After removing it: `Status: enabled`.
2. Installed to `plugins/cache/agent-board/agent-board/0.0.1/` (4 files). `installed_plugins.json` recorded `version 0.0.1` and the git commit.
3. Committed version 0.0.2 in `mkt`, then ran `claude plugin update agent-board@agent-board`. Output: `updated from 0.0.1 to 0.0.2 for scope user. Restart to apply changes.`
4. On disk afterwards:
   - `cache/.../0.0.1/` still there, with its original script (last line `v1`, hash `e47d9f7e...`) plus a new file `.orphaned_at`.
   - `cache/.../0.0.2/` new, script last line `v2` (hash `91dfd7d1...`).
   - `installed_plugins.json` now points at `0.0.2`.
5. Running the update again printed `read from its folder ... nothing to update. Edits there take effect at the next session start or /reload-plugins` and `already at the latest version (0.0.2)`.

For a folder marketplace the update did not need a separate marketplace refresh, because Claude Code reads the folder directly. A real person gets the plugin from GitHub, so the git case below is the one that matters.

### 2. Git marketplace: which commands are needed (home 2)

1. Added the fake https address, installed version 0.0.1 (copied into the cache, marketplace clone kept under `plugins/marketplaces/`).
2. Published 0.0.2 to the bare repository (`git ls-remote` showed the new commit).
3. **`claude plugin update agent-board@agent-board` alone**: `already at the latest version (0.0.1)`, exit 0. Nothing changed on disk.
4. **`claude plugin marketplace update agent-board`**: `Replacing the existing marketplace clone... Successfully updated marketplace`.
5. **`claude plugin update agent-board@agent-board`** again: `updated from 0.0.1 to 0.0.2 ... Restart to apply changes.`
6. On disk: `0.0.1/` kept (now with `.orphaned_at`), `0.0.2/` new. The old files are intact and unchanged.

Result: for a git or GitHub marketplace the update is a two-command step. The docs agree: `claude plugin marketplace update` with no name "refreshes every marketplace's listing but leaves your installed plugins at their current versions", and a plugin update then installs from the refreshed listing.

### 3. Running session: which script path does a hook use after an update? (home 2)

Method: `claude -p --input-format stream-json --output-format stream-json`, started as a child of a small Node program (`<temp>/tmp-c5/driver/live.mjs`) that owns the process. No model sign-in exists in this home, so each prompt ends with `terminal_reason=api_error`, but the `SessionStart` and `UserPromptSubmit` hooks run before that, which is what is measured. The program recorded the child's process id and only that process was involved.

Sequence in one session, with the trace file recording each hook call:

1. Session starts at plugin version A. Prompt 1.
2. While the session is still alive: publish version B, `claude plugin marketplace update agent-board`, `claude plugin update agent-board@agent-board` (printed `updated from A to B ... Restart to apply changes.`).
3. Prompt 2 (after the update).
4. Send `/reload-plugins`.
5. Prompt 3 (after the reload).

Run 1 (A = 0.0.3, B = 0.0.4), what the hook ran:

| Hook call | Script path version | Marker |
|---|---|---|
| SessionStart | 0.0.3 | v3 |
| Prompt 1 | 0.0.3 | v3 |
| Prompt 2, after the update | **0.0.3** | **v3** |
| Prompt 3, after `/reload-plugins` | **0.0.4** | **v4** |

Run 2 (A = 0.0.4, B = 0.0.5) gave the same pattern: the session started on 0.0.4 and stayed on 0.0.4 after the update, then moved to 0.0.5 after the reload. In both runs the `/reload-plugins` message itself fired no prompt hook. Each run sent 4 messages, and its 4 trace lines are SessionStart plus three prompts. In run 2 the new session started at the version run 1 had installed, which shows a new session picks up the latest installed version by itself.

What this shows:

- `${CLAUDE_PLUGIN_ROOT}` for a running session is fixed when the plugin set is loaded (session start or `/reload-plugins`), not when each hook fires.
- The update does not move or delete the old version, so a running session's hook keeps working from the old directory.
- The documentation says the same: "hook commands ... keep using the previous version's path. Run `/reload-plugins` to switch hooks".

### 4. How long the old files stay

The update writes an `.orphaned_at` marker (a millisecond timestamp) into the old version directory. The documentation says the old directory is removed in a background cleanup 14 days later. The 14 days is from the documentation only; it was not observed.

### 5. Automatic updates (documentation only)

From the pages named under "Versions":

- Third-party marketplaces have auto-update off. Official ones and ones added from claude.ai have it on.
- To turn it on: in a session, `/plugin`, tab Marketplaces, select the marketplace, "Enable auto-update". The toggle writes `autoUpdate` to the marketplace's entry in `known_marketplaces.json`, and to `extraKnownMarketplaces` in the settings file when one declares it. An `autoUpdate` set there takes precedence. An administrator can set the same field in managed settings.
- The marketplace file has no field that turns it on, so the plugin author cannot do it for the person.
- It runs in an interactive session, after the first message, after a random delay of up to ten minutes. It refreshes the marketplace and updates the cached plugin copies. The session shows `Plugin updated: <name> · Run /reload-plugins to apply`; the next session loads the new version.
- `DISABLE_UPDATES=1`, `DISABLE_AUTOUPDATER=1` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns the pass off and hides the toggle, unless `FORCE_AUTOUPDATE_PLUGINS=1` is set.
- The CLI help lists no command for auto-update: `claude plugin marketplace` has only `add`, `list`, `remove`, `update`; `claude plugin update` has no such option.
- A new copy is only fetched when the computed version changes. The version comes from `plugin.json` first. Both files in the real plugin pin the same version, so every release must raise it in both (`.claude-plugin/plugin.json:3`, `.claude-plugin/marketplace.json:15`), or people stay on the cached copy.

## Not run

- **An interactive session (terminal UI, desktop app Code tab, VS Code extension).** There is no signed-in model in a temporary home and I did not drive any window. The headless session above uses the same plugin loader, and the documentation describes the same behavior for the terminal ("The running session keeps the versions it already loaded"), so the interactive result is an inference. The desktop app and VS Code were not tested at all. The VS Code page says changes apply to open sessions without a restart; that was not tested and may differ for hooks.
- **The real `PermissionRequest` hook (`scripts/claude-approval.mjs`) firing.** It needs a real permission prompt from a model. A stand-in `UserPromptSubmit` hook was used to observe path resolution, which uses the same `${CLAUDE_PLUGIN_ROOT}` substitution. That the `PermissionRequest` hook resolves its path at the same moments is an inference.
- **The real plugin's `hooks/register.tsx` module.** Removed from the synthetic copy. What a reload does to it was not observed.
- **Turning on auto-update, and an automatic update actually happening.** The toggle is a screen in `/plugin`, and the update only runs in an interactive session after a random delay of up to ten minutes. Only the documentation was checked.
- **The 14-day cleanup of the old version directory.** Documentation only.
- **A real GitHub marketplace.** A local bare repository behind a fake address stood in; no network was used by the plugin commands.
- **macOS and Linux.** Windows only.

## Verdict and effect on the plan

**Pass on the three questions. One plan bar is not met yet (item 2).**

1. Plan section 4 ("How it reaches people") and owner question 6 say Claude Code does not update a third-party plugin by itself. That is right as a default, and the person can turn auto-update on in `/plugin`. The release notes should say so, with the path "/plugin, Marketplaces, agent-board, Enable auto-update". With auto-update on, the person types no command but still starts a new session or runs `/reload-plugins`.
2. **The step count does not fit the plan's bars yet.** The plan counts one command as one step (plan line 31). The two shell commands below make 3 steps each release, against 2 in moment 1 (plan line 22) and "at most 2 through the plugin" in gate line 5 (plan line 220). The first move to 0.25.1 becomes 4, against "the plugin walk at most 3". Claude Code's documentation describes one in-session action, "Update marketplace" under `/plugin`, Marketplaces, that refreshes the listing and updates the plugins. It was not run here. Sitting 1 runs and counts it; if it does not meet the bars, the changed bar goes to the owner. The release notes' exact command is two commands, not one: `claude plugin marketplace update agent-board`, then `claude plugin update agent-board@agent-board`. Add that a plugin update does nothing for a session that is already running; the person starts a new session or runs `/reload-plugins`. This confirms the sentence the plan wants to lead with ("you are not protected until you run this and start a new session") and shows that `/reload-plugins` is an alternative to a new session.
3. A person with a long-lived session stays on the old script after an update until a reload. The old files stay for about 14 days (documentation), so the old hook keeps working in that time. A session left running longer than that could lose the old path. This is an inference, not observed.
4. The plugin walk in gate line 10 stays as planned. No code change is needed from this check.
5. Every release must raise the version in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, or the update finds nothing.
