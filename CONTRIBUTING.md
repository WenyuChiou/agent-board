# Contributing

Thanks for helping. This page covers setup, checks, the format rule and releases. [AGENTS.md](AGENTS.md) has the code layout and conventions; read it before a larger change.

## Set up

You need Claude Code 2.1.287 or newer.

```
git clone https://github.com/WenyuChiou/claude-progress-pane
cd claude-progress-pane
claude --plugin-dir .
```

`claude --plugin-dir .` runs this copy of the mod instead of an installed one. It also writes `.claude-plugin/types/`, which `tsc` and your editor need. That folder is gitignored.

## Run the checks

```
claude plugin validate .
claude plugin test .
tsc -p .
```

Run `claude --plugin-dir .` once first, or `tsc -p .` cannot find its types. Please run all three before you open a pull request, and say in the pull request if you could not.

A change comes with a test in `tests/`. Logic goes in a pure module under `hooks/` and is tested there; `hooks/register.tsx` stays thin. Recent commits start with `feat:` or `fix:`; do the same.

## The file format is versioned

[docs/FORMAT.md](docs/FORMAT.md) describes `progress.md`, which other tools write as well as this one. Treat it as a public interface.

- A change to `docs/FORMAT.md` needs parsing that stays backward compatible. Every file that was valid before must still be valid and read the same way.
- Add things as optional attributes on the auto marker. Readers that do not know an attribute ignore it. A new mark, state or line shape is a breaking change and needs a new format version, so open an issue first.
- Change `hooks/parse.ts`, its tests and `docs/FORMAT.md` in the same pull request. Add a test that reads a file written in the old shape.
- If you change the rule text in `hooks/rule.ts`, change `scripts/claude-md-rule.md` too.

## Screenshots

The images in `docs/images/` are generated. Do not edit them by hand. If your change alters how the pane looks, say so in the pull request.

## Releases

To release, in this order:

1. Raise `version` in `.claude-plugin/plugin.json`. Installed copies only update when it changes.
2. Add an entry to `CHANGELOG.md`, newest first, headed `## x.y.z — YYYY-MM-DD`. Name the tests that cover each change.
3. Run the checks above.
4. Push.
5. `claude plugin tag .`, then `git push --tags`.

## Bug reports

Include:

- The relevant part of your `progress.md`: the project heading and the block or task that goes wrong, with private names removed. Most bugs are about how one block or step is read, and the text answers that at once.
- What you expected and what the pane showed.
- The plugin version (`version` in `.claude-plugin/plugin.json`) and the Claude Code version (`claude --version`).
- Your operating system and terminal, if the bug is about how the pane looks.
- If it is about archiving or the journal, the matching lines from `progress-archive-YYYY-MM.md` or `progress-journal-YYYY-MM.md`.
- If another agent writes the block, which agent it is.
