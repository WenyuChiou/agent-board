# Agent marks: sources and UI verification

Issue: #442. This checks the identity and rendering of all eleven marks, not native host delivery. Existing `isTested` flags and support claims are unchanged.

| Agent | Mark used | Source and decision |
|---|---|---|
| Claude Code | Claude spark | Existing Simple Icons 16.35.0 vector retained. |
| Codex | OpenAI mark | Existing Lobe Icons 1.95.1 vector retained; a separate official Codex product SVG was not established. |
| Gemini CLI | Gemini spark | Existing Simple Icons 16.35.0 vector retained. |
| Cursor | Cursor cube | Existing Simple Icons 16.35.0 vector retained; [official brand reference](https://cursor.com/brand). |
| OpenCode | Block O | Existing Simple Icons 16.35.0 vector retained; [official brand reference](https://opencode.ai/brand). |
| Grok Build | Grok mark | Existing Lobe Icons 1.95.1 vector retained. |
| Hermes Agent | Nous girl | Existing compact Lobe Icons 1.95.1 vector visually matches the [official app icon](https://github.com/NousResearch/hermes-agent/blob/8084684936a951e6c539675f8f81e5b5c35b866f/assets/icon-master.svg); it is not a byte-identical copy of that larger app asset. |
| Muse Code | Blue Muse brand mark | The owner supplied the handwritten M and the parent matched it to the icon on [Meta's official Muse page](https://ai.meta.com/muse/). The vector is from Lobe Icons 1.100.0; this establishes the Muse brand identity, not a separate official Muse Code SVG. |
| Antigravity | Official white icon | Replaces A, using the SVG linked by [Google's press page](https://www.antigravity.google/press). |
| DeepSeek Harness | Official whale | Replaces D, using the [official repository favicon](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/apps/web/public/favicon.svg). |
| OpenClaw | Lobster | Existing Lobe Icons 1.95.1 vector retained. |

Simple Icons assets use the project's existing CC0 source; Lobe Icons assets use MIT. Brand marks belong to their respective owners. References above do not assert vendor endorsement or that every retained asset is an official product SVG.

The Antigravity input is `antigravity-icon__white.svg` from `https://www.antigravity.google/assets/image/brand/antigravity-icon__white.svg`, SHA-256 `5b8121138dcb017642ccf15d9f5cda738e61d8d70a12277c9cf5aeec3e575e81`. Its original path and `0 0 180 180` viewport are preserved.

The DeepSeek input is `apps/web/public/favicon.svg` from the commit linked above, SHA-256 `9e983b4f649c25c6ca0623a50be1a6e705fd8f49f756638b980fa13b40575ab6`. Its original path and `0 0 50 50` viewport are preserved; the monochrome glyph uses the board's existing white foreground on its blue tile. This follows the compatible-tool identity described in the repository's [brand guidelines](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/BRAND_GUIDELINES.md).

The Muse vector is [`muse.svg` at Lobe Icons commit `cc639da879a3f404f5ded8ec41cdfdc63abd8317`](https://github.com/lobehub/lobe-icons/blob/cc639da879a3f404f5ded8ec41cdfdc63abd8317/packages/static-svg/icons/muse.svg), SHA-256 `313cdfd22d49e43572a35a39faef92b5ee656dafbc9f753438b05350d6140a20`. Its 24-unit path is unchanged. The blue ink `#0082FB` and white tile follow that snapshot's [Muse style constants](https://github.com/lobehub/lobe-icons/blob/cc639da879a3f404f5ded8ec41cdfdc63abd8317/src/Muse/style.ts). The tile is written as canonical six-digit `#FFFFFF` for the README's existing color contract. Meta's official page uses the matching blue handwritten M as an image labelled `Muse icon`. The owner's third-party image served as a lead, not the asset shipped by the board.

The shared registry drives the served page, static dashboard and README renderer. Complete slugs such as `hermes-agent` and `deepseek-harness` now select the same marks as native short names. Existing 24-unit artwork keeps its previous transform; the Antigravity and DeepSeek imports carry their source viewports. Optional ink preserves Muse's blue while other marks retain white. The web SVG serializes hex ink as equivalent RGB: percent-encoding a hex color would otherwise create an eight-hex sequence that trips the existing privacy guard. The guard is unchanged. Fifteen affected icon, chip, cover and flow SVGs and the installed bundle were rebuilt from sources. Historical tour and promotional images were retained: rebuilding those exposed older unrelated UI changes, which are outside this icon correction.

## User-flow evidence

On Windows with Node 24.14.0, the parent first used the real installer in a new synthetic home: preview made no home writes, apply installed eight files, and repeating apply left their bytes unchanged. No native host session or model was started.

The parent then operated the actual installed board through the in-app browser, selecting and clearing each of the eleven agent filters in both Light and Dark (22 selections), combining the Antigravity and project filters, and visually inspecting the marks. This initial candidate displayed the official Antigravity arch, DeepSeek whale, retained Hermes/Nous and OpenCode marks, and the then-selected Muse letter fallback.

A headed Playwright 1.62.0 replay checked Light and Dark at desktop 1365 × 1100 with device scale factors 1 and 2, and at 390 × 844 with scale factor 2. All six initial configurations passed: 66 agent selections and clears, six project/agent combinations, eleven correctly mapped 24px tiles per configuration, ten SVG marks plus the then-current Muse fallback, and no horizontal page overflow or page errors. Parent inspection of the saved desktop and mobile screenshots confirmed the small marks remained legible. Finite CSS transitions were disabled only for deterministic screenshots, not shipping behavior.

The initial replay completed four desktop configurations, then timed out clicking a mobile drawer that the selected filter had already closed. That failed run was retained. The replay was corrected to check `aria-expanded` before closing and only the two mobile configurations were rerun; both passed. This is not a claim that the original six-case command passed.

After the owner supplied the actual Muse brand mark, a new installed synthetic board was used for its delta check. The parent selected and cleared Muse in both themes and visually checked the blue glyph. A targeted replay passed all six desktop/DPI/mobile combinations again for Muse only, including six project/agent combinations. It inspected all eleven SVG backgrounds and 24px dimensions on the updated bundle, checked Muse's blue foreground, and found zero horizontal overflow or page errors. Other agents' accepted filter-flow evidence was reused.

Owned servers are closed through the board's UI. Installation, screenshots and replay receipts remain task-local; no private progress, bearer URL or host binding is published here. These checks establish synthetic UI behavior, not native reporting, message delivery, model ACKs or performance.

## Regression checks

Both tests are in `tests/board.test.mjs`, which the existing Node 22/24 CI matrix runs:

- `official agent marks retain their source viewport on every board surface`
- `agent aliases and fallback labels keep the correct identity without changing native acceptance`

They check pinned source path fingerprints, CSS SVG geometry, viewport and ink, bundled source, generated icon/chip geometry, Muse parity in all six localized theme covers, all short/display/slug names, escaped unknown-agent fallback, own-task rendering, and the unchanged native acceptance flags. The cover assertion was first run against the missed Muse cover redraws and failed as expected; the six covers were then regenerated from source.
