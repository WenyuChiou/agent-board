# Contributing

Read [AGENTS.md](AGENTS.md) for code layout and conventions. Keep changes scoped, use synthetic data, and report checks and limitations in the PR.

## Set up

Clone the repository and use Node 22.18+ or 24 for the tests (the installed bundle supports Node 18+). Use Bun 1.4.2 when rebuilding generated files. There is no package manifest or runtime dependency installation.

Independent development and installation do not require Claude Code. Optional pane validation uses Claude Code 2.1.301 in CI, pinned in `.github/workflows/test.yml`; `plugin validate` and `plugin test` are offline and need no model login.

## Run the checks

From the repository root:

```sh
node --test tests/board.test.mjs tests/board-storage.test.mjs tests/codex-local.test.mjs
node --test tests/exchange.test.mjs tests/messaging.test.mjs
bun scripts/build-board.ts --check
bun scripts/build-released.ts --check
```

Fetch release tags before the released-files check. Rebuild changed bundle sources with `bun scripts/build-board.ts`; never hand-edit `hooks/board-script.ts`.

For the optional plugin and legacy installers:

```sh
claude plugin validate --strict .
claude plugin test .
bash tests/setup.check.sh
powershell -NoProfile -ExecutionPolicy Bypass -File tests/setup.check.ps1
python3 -B scripts/remote-reporter/test_pipeline.py
```

Run the installer check matching the changed script/OS; each uses temporary fixtures. Windows CI uses `python` for the stdlib reporter tests. None of these checks sends model prompts.

Run strict TypeScript for changed standalone modules with Node typings from your development environment. Full `tsc -p .` additionally needs the host-generated `.claude-plugin/types/` SDK, written when Claude Code loads the local plugin (`claude --plugin-dir .`). It is gitignored and must not be invented or edited. If unavailable, report full typechecking as unrun; passing standalone checks does not replace it. Do not start model work merely to claim an offline check passed.

CI runs six jobs: plugin/installer/reporter checks on Linux and Windows, and Node 22/24 exchange, messaging and board checks on both systems. It checks generated bundles/releases, but not full `tsc -p .`.

## Changes and evidence

Put logic in pure `hooks/` modules; engine calls stay in `hooks/register.tsx`. User-visible strings belong in all three tables. Use meaningful behavioral tests for messaging, state, storage and ownership changes. CHANGELOG entries name their covering tests. Commit subjects start with `feat:`, `fix:`, `docs:` or another appropriate type.

Record progress, native hook execution, UI controls, transport acceptance and actual model ACKs separately. Identify the native host and surface; an owned app-server is not a CLI TTY or a desktop chat. A mock, tagged file or accepted RPC cannot prove live delivery. Never use a normal reply as tool/merge approval. Real model tests require an authorized disposable binding and a bounded prompt budget; stop only your own test processes afterward.

For optional OpenCode SDK/DeepSeek loader checks, use the pinned packages and disposable prefix in the [portable acceptance record](docs/validation/2026-10-19-portable-hosts.md). `scripts/check-host-contracts.mjs --runtime-dir <prefix>` uses the actual packages with synthetic host objects; it is not native model acceptance. Normal installation adds no npm dependencies.

## The file format is versioned

[FORMAT.md](docs/FORMAT.md) is a public interface shared with other writers. Preserve every valid older shape. Add optional marker attributes compatibly; a new mark, state or line shape needs a format-version decision first. Change parser, writer, tests and the format specification and translated guides together when behavior changes. Keep the three rule languages and `scripts/claude-md-rule.md` synchronized if changing the Claude rule.

## Images

Keep the original README tour/flow SVGs and dark terminal illustration. The bottom pair uses English Codex/Antigravity board screenshots labelled synthetic. Do not add a gallery to the guides. Historical assets remain in `docs/images/`. Generated SVGs come from `bun docs/preview/render.ts`; never hand-edit them. `node docs/preview/png.mjs` renders social previews; its fonts/tool requirements are documented in the preview sources. A synthetic render is not native acceptance evidence. Keep bearer URLs, conversations and private identifiers out of public images.

## Releases

1. Update `.claude-plugin/plugin.json`, the three README badges and concise marketplace descriptions. Keep support claims aligned with evidence.
2. Add a dated `## x.y.z — YYYY-MM-DD` CHANGELOG entry, naming covering tests.
3. Fetch tags (`git fetch --tags origin`), then run `bun scripts/build-released.ts` with Bun 1.4.2. It records this version's generated-file ownership; do not edit its output manually.
4. Run applicable checks and generated-file checks. State any unavailable full SDK typecheck.
5. Open a regular PR, wait for all required CI checks, and merge the exact tested head under the owner's authorization.
6. On the merged release commit, run `claude plugin tag . --dry-run`, then `claude plugin tag .`. Push only the new exact tag, for example `git push origin agent-board--v0.23.0`. Never replace an existing release tag or push unrelated local tags.

## Support matrix

Keep README, setup and messaging capabilities synchronized across languages. Distinguish native activity, explicit task reports, web/terminal UI and live receiving. Record actual version/platform/surface evidence and keep unsupported or untested adapters visible. Do not turn a generated configuration or another vendor's successful test into a blanket support claim.

## Bug reports

Prefer a synthetic reproduction, the Agent Board/affected host versions, CLI/App/IDE, OS and expected/actual behavior. Claude's version is relevant only to its optional plugin. Do not request raw real progress or conversation files. Report sensitive findings privately as [SECURITY.md](SECURITY.md) describes.
