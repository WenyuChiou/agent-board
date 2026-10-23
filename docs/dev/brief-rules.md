# Brief checklist

Codex brief authors and agents reading for-dot issues paste this checklist into every task brief to catch recurring review problems.

1. Branch from current origin/main. Merge `origin/main` before Ready and after every review request. Never rebase or force-push.
2. Keep engine calls in `hooks/register.tsx`; a helper receiving `$` is a top-level const there. Pure modules take `now`; use no semicolons, single quotes, named exports, and `is`/`has` booleans.
3. Put each new user-visible string in `ZH_TW` (`hooks/i18n.ts`), `EN`, and `ZH_CN` at the same place, and nowhere else.
4. Add one new `changelog.d/<issue>-<slug>.md` fragment (see `changelog.d/README.md`): name `#N`, claim only what the diff does, and end with `Tests:` and the exact test titles. The release pull request folds it into CHANGELOG.md.
5. A test that starts an asynchronous process stops it in `finally` and waits for it to exit on every OS. Blocking `spawnSync`, `execSync`, and `execFileSync` already wait; Linux CI cannot see a Windows leak.
6. When `hooks/parse.ts`, `blocks.ts`, or `view.ts` changes, keep `docs/FORMAT.md` and all three guides consistent with it.
7. Never edit `hooks/board-script.ts` by hand: rebuild with Bun 1.4.2, or write "maintainer rebuilds at merge" under Checks.
8. Run `node scripts/preflight.mjs --body-file <body> --title <title>` and paste its output under Checks.
9. The engine sends `process.run` options as `e.init` (`{ argv, init: { cwd, env, stdin, timeoutMs } }`). A mock must read them from there.
10. On your own computer, run only the test files your change touches, and only one test run at a time. Never run full suites, long soak runs, mutation sweeps or the L5 busy-machine test (it keeps up to three CPUs busy) there. The exception is `claude plugin test .`, which runs every `tests/*.test.ts` and `tests/*.test.tsx` file: when your change touches one of those files, run it once, alone, before Ready. CI runs the full suites and the busy-machine test on every pull request, and `.github/workflows/soak.yml` runs the soak weekly and on demand. The busy-machine test skips itself unless `CI` is set or `AGENT_BOARD_HEAVY_TESTS=1`.
