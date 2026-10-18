# Contributing

Thanks for helping. This page covers setup, checks, the format rule and releases. [AGENTS.md](AGENTS.md) has the code layout and conventions; read it before a larger change.

## Set up

You need Claude Code 2.1.287 or newer (the minimum `README.md` gives). CI installs 2.1.301, pinned in `.github/workflows/test.yml`.

```
git clone https://github.com/WenyuChiou/agent-board
cd agent-board
claude --plugin-dir .
```

`claude --plugin-dir .` runs this copy of the mod instead of an installed one. It also writes `.claude-plugin/types/`, which `tsc` and your editor need. That folder is gitignored.

## Run the checks

```
claude plugin validate --strict .
claude plugin test .
tsc -p .
bash tests/setup.check.sh
powershell -NoProfile -ExecutionPolicy Bypass -File tests/setup.check.ps1
```

Run `claude --plugin-dir .` once first, or `tsc -p .` cannot find its types. `--strict` is what CI passes to `validate`.

The last two are the installer checks. They run `scripts/setup.sh` and `scripts/setup.ps1` against temp folders (never your own `~/.claude` or shell profile), and `claude plugin test` does not run them. Run the one that matches the script you changed: `setup.check.sh` needs bash and python3, and CI runs `setup.check.ps1` on Windows.

CI runs `claude plugin validate --strict .`, `claude plugin test .` and the installer check for its system, on Ubuntu and on Windows, for every pull request and every push to `main`. It does not run `tsc -p .`. Please run the checks that apply to your change before you open a pull request, and say in the pull request if you could not.

A change comes with a test in `tests/`. Logic goes in a pure module under `hooks/` and is tested there; `hooks/register.tsx` stays thin. Every user-visible string goes into the strings tables, all three of them (`hooks/i18n.ts`, `hooks/strings-en.ts`, `hooks/strings-zh-cn.ts`); [AGENTS.md](AGENTS.md) says how. Commit subjects start with a type, as in `feat:`, `fix:` or `ci:`.

## The file format is versioned

[docs/FORMAT.md](docs/FORMAT.md) describes `progress.md`, which other tools write as well as this one. Treat it as a public interface.

- A change to `docs/FORMAT.md` needs parsing that stays backward compatible. Every file that was valid before must still be valid and read the same way.
- Add things as optional attributes on the auto marker. Readers that do not know an attribute ignore it. A new mark, state or line shape is a breaking change and needs a new format version, so open an issue first.
- Change the code that reads the format (`hooks/parse.ts`, and `hooks/view.ts` and `hooks/ask.ts` for a task's notes), its tests and `docs/FORMAT.md` in the same pull request. Add a test that reads a file written in the old shape.
- If you change the rule text in `hooks/rule.ts`, change it in all three languages, and change `scripts/claude-md-rule.md` (the Traditional Chinese rule) too.

## Images

The images in `docs/images/` are drawn by the pane's own code from the sample data in `docs/preview/samples.ts`, in each language. They share one look with the promotional card (the brand helpers in `docs/preview/render.ts`): a deep blue ground, dark cards, the board mark and each agent's tile. Do not edit them by hand. If your change alters how the pane looks, redraw them:

```
bun docs/preview/render.ts     # the SVGs: the tour, how it works, the promotional card, the agent icons
node docs/preview/png.mjs      # the social preview PNGs from the promotional cards; needs Playwright and Node 22.2+
```

`render.ts` needs `.claude-plugin/types/` (run `claude --plugin-dir .` once) for its JSX setting. It ends by running `docs/preview/fonts.py`, which puts the letters each SVG uses into it (Inter, JetBrains Mono, Noto Sans TC and SC, all under the SIL Open Font License), since GitHub shows an SVG as an image and an image cannot load a font. That needs Python 3 with fontTools 4.60 or newer (`pip install "fonttools>=4.60" brotli`); the first run downloads the fonts into `docs/preview/out/fonts/`. `terminal.ts` is the small layout engine that turns `drawPane`'s tree into a character grid and the grid into SVG.

## Releases

To release, in this order:

1. Raise `version` in `.claude-plugin/plugin.json`. Installed copies only update when it changes.
2. Add an entry to `CHANGELOG.md`, newest first, headed `## x.y.z — YYYY-MM-DD`. Name the tests that cover each change.
3. After the last merge of `main`, run `bun scripts/build-released.ts` (Bun 1.4.2, with the tags fetched: `git fetch --tags`). It adds the files this release generates to `hooks/released.ts`, so a later version still knows them as its own, and CI's `--check` fails until it is run.
4. Run the checks above.
5. Push.
6. `claude plugin tag .`, then `git push --tags`.

## The agents table

The "Supported agents" section of the three READMEs sorts the agents into works fully, works in part (with its limit in one line) and not supported yet, and its table says, per agent, whether its turns reach the board and whether the board works inside it: ✅ works, ⚠️ works with a limit, ❔ not verified yet, ❌ not supported yet. Change a mark only on evidence: a live run whose hook fired and whose block the pane drew (keep its payload as a test, and put the version in "Verified on"), or a run that failed (say how, in one line). An agent's new version that was not run keeps the version that was. Keep the list, the table and the agent badges at the top in step: a green badge for works fully, yellow-green for works in part, none for the rest.

## Bug reports

Include:

- The relevant part of your `progress.md`: the project heading and the block or task that goes wrong, with private names removed. Most bugs are about how one block or step is read, and the text answers that at once.
- What you expected and what the pane showed.
- The plugin version (`version` in `.claude-plugin/plugin.json`) and the Claude Code version (`claude --version`).
- Your operating system and terminal, if the bug is about how the pane looks, and the pane language (`en`, `zh-TW` or `zh-CN`) if it is about wording.
- If it is about archiving or the journal, the matching lines from `progress-archive-YYYY-MM.md` or `progress-journal-YYYY-MM.md`.
- If another agent writes the block, which agent it is.
