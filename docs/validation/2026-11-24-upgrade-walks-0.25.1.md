# Upgrade walks — Agent Board 0.25.1, 2026-11-24

Two walks the owner asked for on top of the release gate (#1791: 「1–4、9、11 + walk (a)(b)」): a person with an earlier install updates it the way the README says, on Windows 11. They complement the simulated-user record, which starts from an empty home.

**How they ran.** The steps were run by Antigravity CLI (`agy`, Gemini), which did not write this milestone, from a written brief; it recorded each step's exit code and output and judged nothing. The maintainer (AB01 PM-main, Claude) read the full logs and gives the results below. Every step ran in Windows PowerShell 5.1 through a runner that points every home, temp and agent folder variable USER-SIM.md lists at a new empty walk home, and npm at a local registry serving two packages: `latest` = 0.25.0 (packed from `bf0283fcaf3cabc7d68b93834a8e3be4308c9e72`, the 0.25.0 release pull request's head, sha256 `9b19c5c3322d7e1e0e97b260a0c4774ac41c3e62544368961b2babc809a9b46a`) and `next` = 0.25.1, as npm will read them while the release is on `next`. Synthetic data only; no real home or agent config was read or changed.

| Run | 0.25.1 package | Walks |
|---|---|---|
| 1 | packed from `2e44862ef88795fe1ccaa009c940102399bf82c2`, sha256 `412d4e4a765402e9d885639a25f98bf087139ce2b9b2447e4f32fb220afd5349` | (a), (b) |
| 2 | packed from `25307db7b7f3eec83e93e0ec6538bed925dba173` (after #1794 merged in), sha256 `f171e4fd2fdf841821c7bfa9e9d36e853db7b4344ff9a816ca974bc42535cbd2` | (a) again, with Hermes's own save of `config.yaml` |

## Walk (a): Codex and Hermes set up by 0.25.0, updated with `setup`

Before the person's steps: `npx @wenyuchiou/agent-board@0.25.0 setup --agent codex,hermes --apply`, then the Codex trust step setup printed (preview, then `--apply`), then the doctor. In run 2 the walk home's `config.yaml` was then saved the way Hermes saves its settings (PyYAML, a top-level `toolsets` list whose item sits at the left edge, #1588).

The person's steps: `npx @wenyuchiou/agent-board@next setup`, then the same with `--apply`, then any trust command it printed, then the doctor and `npx @wenyuchiou/agent-board@next --print`.

| Step | Run 1 | Run 2 |
|---|---|---|
| 0.25.0 trust step (before the walk) | exit 1, "the Codex control server did not respond" (0.25.0's trust step); `hooksTrusted: false` | exit 0, "trusted the board's 7 hooks"; `hooksTrusted: true` |
| `setup` preview | "Shared: would update 2 setup files", "Hermes Agent: would update 1 setup file", the agents found on PATH each with the files they would create | same |
| `setup --apply` | "Shared: updated 2 setup files", "Codex: updated 1 setup file", "Hermes Agent: updated 1 setup file"; printed the Codex trust command (the hooks were never trusted) | the same three lines, then "Codex: the board's hooks are still trusted." (#1303); no trust command |
| trust from the printed command | preview and `--apply` exit 0, "trusted the board's 7 hooks ... Start a new Codex session." | not needed |
| doctor after | `hooksTrusted: true` | `hooksTrusted: true` |
| `--print` | "✓ Nothing needs you right now" | same |
| Hermes `config.yaml` | unchanged byte for byte (its hooks were already 0.25.1's); the "updated 1 setup file" is the install record, now 0.25.1 | the person's file, as Hermes saved it, unchanged byte for byte; install record now 0.25.1. Before #1794 setup refused this file shape whole ("setup cannot safely update ~\.hermes\config.yaml", #1588; seen in the parity run) |

**Result: PASS.** Run 2: 4 person steps (preview, apply, doctor, board). Run 1: 6, two of them the trust step 0.25.0 had failed to do. The update also sets up the other agents it finds on PATH; the preview names each file it would create, so nothing is unannounced.

## Walk (b): only the Claude Code plugin, 0.25.0, updated after the release

Before the person's steps: the plugin marketplace added and the plugin installed from a local stand-in of the GitHub marketplace holding 0.25.0 (`claude plugin list`: 0.25.0); one `claude -p` session (the owner signed in for this walk) wrote the board script. Then the 0.25.1 release reached the stand-in marketplace.

| Step | Output |
|---|---|
| `npx @wenyuchiou/agent-board@next --print` | "the board script at `<home>\.claude\agent-board.mjs` is from 0.25.0; the Claude Code plugin wrote it. To update it, update the agent-board plugin in Claude Code, then run /progress connect." |
| `claude plugin marketplace update agent-board` | "Successfully updated marketplace: agent-board" |
| `claude plugin update agent-board@agent-board` | "Plugin "agent-board" updated from 0.25.0 to 0.25.1 for scope user. Restart to apply changes." |
| a new `claude -p` session | exit 0; the plugin rewrote the board script, which now carries the version string 0.25.1 |
| `claude plugin list` | 0.25.1 |
| `npx @wenyuchiou/agent-board@next --print` | "✓ Nothing needs you right now", no notice |

**Result: PASS.** 3 person steps after the notice (marketplace update, plugin update, new session). #1794 changed no plugin file, so run 2 did not repeat this walk.

## From npm, after the publish

The owner published 0.25.1 to npm under `next`. Its checksum is the one `npm pack` gives for the tagged commit `8ccb458bfde41ac5745ed10f3f1dad8e610462c4` (`4f569428a396217275deea0583abcaea5c97df26`, 18 files). Walks (a) and (b) then ran once more, by the same runner from the same briefs, in new empty walk homes. This time npm read the public registry with an empty cache in each home. Walk (a)'s cache shows `agent-board-0.25.0.tgz` and `agent-board-0.25.1.tgz`, and walk (b)'s shows `agent-board-0.25.1.tgz` (its 0.25.0 came from the plugin), all from registry.npmjs.org. In walk (b) the stand-in marketplace held the real tagged commits: its `main` moved from the `agent-board--v0.25.0` commit to the `agent-board--v0.25.1` commit, as GitHub's did at the release. The maintainer read the full logs.

| Walk | What happened | Result |
|---|---|---|
| (a) | Before the walk: 0.25.0 `setup --agent codex,hermes --apply`; the printed Codex trust step, preview then `--apply`, "trusted the board's 7 hooks"; doctor `hooksTrusted: true`; then Hermes saved `config.yaml` its own way. The person's steps: the `setup` preview, "Shared: would update 2 setup files", "Hermes Agent: would update 1 setup file". `setup --apply`, "Shared: updated 2 setup files", "Codex: updated 1 setup file", "Hermes Agent: updated 1 setup file", "Codex: the board's hooks are still trusted." The doctor, `hooksTrusted: true`. `--print`, "✓ Nothing needs you right now". The Hermes `config.yaml`, Codex `hooks.json` and `config.toml` are unchanged byte for byte; the Codex and Hermes install records now say 0.25.1. | **PASS**: 4 person steps, as in run 2 |
| (b) | Before the walk: the plugin installed at 0.25.0, and one session wrote the board script; then the release reached the marketplace. The person's steps: `--print` gave the same notice as in the walk (b) table above ("the board script at `<home>\.claude\agent-board.mjs` is from 0.25.0; the Claude Code plugin wrote it. ..."); `claude plugin marketplace update agent-board`; `claude plugin update agent-board@agent-board`, "updated from 0.25.0 to 0.25.1"; a new `claude -p` session rewrote the board script, which now carries 0.25.1. `claude plugin list` then gave 0.25.1, and `--print` "✓ Nothing needs you right now", with no notice. | **PASS**: 3 person steps after the notice, as before |

## Notes (not failures)

- Walk (b): the notice ends "then run /progress connect", but the new session already rewrote the script; the step is not needed. Wording only.
- Walk (b), before the walk: `claude plugin install` prints "2 userConfig options not yet set": Claude Code's own line.
- Walk (a): the update's "Apply these changes" line names agents that were not set up before (`--agent codex,cursor,opencode,grok,hermes,openclaw,antigravity`), because setup sets up every agent it finds.

Logs, walk homes and the runner stay with the maintainer, off GitHub.
