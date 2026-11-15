# Risk-tier paths

This list is part of [RULES.md, R2](RULES.md#r2-nobody-approves-their-own-work), and a governance file under [CONTRIBUTING rule 12](../../CONTRIBUTING.md#pull-requests) like R2 itself: it changes only with the owner's approval of the content.

A pull request that changes one of these paths takes the risk tier's review as R2 says. Each is something a person's configuration, permissions, tokens, data deletion, setup or hooks depend on. The list is the floor: a change elsewhere that reaches the same things is risk tier too.

The large shared files `hooks/serve.ts`, `hooks/blocks.ts`, `hooks/register.tsx`, `hooks/receivers/`, `scripts/board-cli.ts`, `scripts/board-serve.ts` and `scripts/server-runtime.ts` are not listed, because most changes to them reach none of these things (owner, 2026-11-12; #1358). A change to one of them is risk tier only when it reaches one of these four: tokens, the page's host or origin checks, what is written to or deleted from `progress.md`, or what a hook runs.

- `package.json`
- `.claude-plugin/`
- `SECURITY.md`
- `bin/agent-board.mjs`
- `scripts/setup-agent.mjs`
- `scripts/setup-codex.mjs`
- `scripts/setup-discovery.mjs`
- `scripts/setup.sh`
- `scripts/setup.ps1`
- `scripts/install-control.ts`
- `scripts/connect-transaction.ts`
- `scripts/legacy-connect.ts`
- `scripts/settings-agents.ts`
- `scripts/codex-approval.ts`
- `scripts/codex-local.ts`
- `scripts/windows-hook-node.ts`
- `scripts/hook-recovery-owner.ts`
- `scripts/private-folder.ts`
- `scripts/runtime-folder.ts`
- `hooks/hooks.json`
- `hooks/connect.ts`
- `hooks/connect-pure.ts`
- `hooks/connect-worker.ts`
- `hooks/local-agents.ts`
- `hooks/portable-agents.ts`
- `hooks/hook-reporters.ts`
- `hooks/hook-safety.ts`
- `hooks/hook-recovery.ts`
- `hooks/legacy-hook-plugins.ts`
- `hooks/settings-agents.ts`
- `hooks/tidy.ts`
- `hooks/retention.ts`
- `hooks/old-months.ts`
- `hooks/old-months-run.ts`
- `hooks/ledger-move.ts`
