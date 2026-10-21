# Prompt receipt contracts — 2026-10-19

This change uses the following published contracts or previously inspected host
source. Callback execution below uses synthetic fixtures, not running AI hosts.

| Legacy inbox adapter | Verified prompt facility | Primary evidence |
| --- | --- | --- |
| Codex | `UserPromptSubmit` | Inspected native hook config declares that exact serde event; [existing isolated native evidence](2026-10-19-native-hooks.md) observed it. |
| Gemini CLI | `BeforeAgent` | [Official hook reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md), after user submission and before planning. |
| Cursor | `beforeSubmitPrompt` | [Official hooks documentation](https://cursor.com/docs/hooks). |
| Grok Build | `UserPromptSubmit` | [Pinned event declaration](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-hooks/src/event.rs). |
| Muse Code | `UserPromptSubmit` | [Official SDK hook reference](https://meta-models.github.io/muse-code-sdk/next/guides/plugins/reference/hook-events/); published next SDK contract, native execution unverified. |
| Hermes Agent | `pre_llm_call` | [Official shell-hook guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md), explicitly the prompt-submit equivalent. |
| OpenCode 1.19.3 | `chat.message` | [Pinned plugin SDK](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/plugin/src/index.ts); verify exact top-level session metadata first. |
| OpenClaw | `before_prompt_build` | [Official origin contract](https://docs.openclaw.ai/plugins/hooks/prompt-and-session); require `ctx.inputProvenance.kind === 'external_user'`. |

OpenClaw origins that are absent, internal or inter-session do not answer a
question. Older hosts without that classification keep their questions until a
later explicit report/turn; a generic `trigger: user` is insufficient. No guessed
prompt facility is added for Antigravity or DeepSeek. Their activity observers
continue to report activity, and Hermes's independent adapter remains pending.
The independent OpenClaw plugin keeps `allowConversationAccess: false` and does
not register the conversation-bearing prompt hook. Its generic run-start events
do not prove a human prompt and therefore do not answer questions. This limitation
does not affect the separate legacy inbox plugin, which already has conversation
access and checks the host's explicit origin classification.

The legacy prompt path requires a stored mirror and exactly one visible, closed
block with the matching id, agent and native resume binding. Missing, archived,
fenced, duplicated, foreign or incomplete blocks are left alone. Prompt prose,
reply fields and transcript paths are stripped during normalization. No prompt
sets `firstPrompt`, reads a transcript or enters model digest selection.

`turnOrder` retains its existing milliseconds-times-two plus end-bit encoding,
including saved seconds migration. A separate `promptOrder`, on that same scale,
requires a strict increase over the last folded turn and prompt. Unknown or invalid
stored source orders preserve questions even when the session is known and
its heartbeat is recent; only a valid positive turn/prompt source order or an
explicit confirmation barrier establishes causality. Equal, unknown or nonpositive
prompt clocks, future timestamps and unsafe numeric orders are ignored rather than
inventing freshness. POSIX reporter clocks
have second precision, so a same-second prompt may conservatively wait for the
next real report. At a tied clock, inbox processing sorts prompt before turn and
end; no third rank is silently applied to saved numbers.

Prompt intake bypasses the model queue and uses the bounded write queue. It stores
an immutable metadata receipt under its own key, never replacing the agent owner
record. Agent mirror reads project those receipts over stale raw owner writes;
strictly newer owner turns ignore an older prompt. In-flight summaries revalidate
the effective mirror on each write attempt/retry. The progress file retains the
existing read/transform/write/readback protocol: it is best effort across separate
processes, not filesystem compare-and-swap. Passive pane polling does not repair a
raw file overwritten by a noncooperating writer. Inbox receipt-map updates
also share the write queue so prompt and summary persistence cannot lose each
other's receipts within a plugin instance.

Read-only pending previews skip prompt metadata without retiring any report or
question. Filesystem mtime is display/intake metadata, not proof that a prompt
answered a report. Preview callers have no accepted owner binding or stored
source barrier, so even plausible prompt timestamps cannot authorize hiding
pending work. Claimed/processed input and verified receipt handling determine
when those reports leave the preview. Future/overflow prompt clocks, missing
report source clocks and sessions without a board mirror all retain pending
reports and questions, while prompt prose and transcript paths stay excluded.

The immutable receipt must read back exactly before its claimed inbox input can
be acknowledged or removed. A denied write, a write that reports success without
persisting, or a readback error retains the claim for retry, without model work.
These causal barriers are retained conservatively: an age cutoff cannot prove
that an old paused writer will never publish its mirror again.

Composition with manual completion must resolve completion overlays from the raw
owner first, then project prompt receipts. `confirmedAt` supplies a separate
source-time barrier: unknown, equal, older, invalid or future source clocks leave
completion intact; a proven prompt after confirmation may resume work, keeping
already completed steps done. Receipt arrival and mirror heartbeat times never
substitute for the prompt source clock. The pure composition fixture covers both
orders around confirmation. Parent integration must also exercise the actual
completion store resolver and its raw-owner fingerprint; this branch does not
change that independently developed resolver.

Independent native reporters keep their established first-prompt initialization
semantics. Since #243, a real prompt no longer answers their prior explicit `[?]` steps: the
hooks never read the prompt's words, so a step stays waiting until the agent reports again or
the person marks it answered on the board. Generic busy, retry or run-start activity does not
answer it either. Native Codex replay/retired-turn guards
still protect newer questions. The no-create rule above applies to legacy inbox
receipts, not native session initialization.

Exact pre-prompt OpenCode/OpenClaw templates were compared with both release tags
0.20.5 and 0.23.1 and baseline 844c327. The byte identities agree; the Node fixture
pins their hashes for the synthetic inbox path. Grok's known one- and five-second
end-hook templates are also adopted. Edited templates still collide and are
preserved; no header-only ownership rule was introduced.

Offline checks include pure order/binding tests, mocked inbox/model concurrency,
actual generated callback execution against stub transports, native Node metadata
reporting, and connection/removal/upgrade fixtures. No private conversations,
permanent host settings, native AI application or model calls were used. Full
plugin TypeScript checking still requires the unavailable generated SDK.
