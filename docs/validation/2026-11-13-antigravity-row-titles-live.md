# Live Antigravity Multi-Conversation Row Title Check (2026-11-13)

## Scope

Verified Antigravity CLI (`agy`) conversation row naming and shared-title disambiguation against the local Agent Board build in an isolated disposable home directory (`<isolated-home>`) without modifying or reading the user's real `~/.gemini` or `~/.agent-board` state.

## Environment and Setup

- Isolated environment variables: `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, and `LANG=en`.
- Installed local Antigravity hooks into `<isolated-home>` via `node scripts/setup-agent.mjs --agent antigravity --home <isolated-home> --lang en --apply`.
- Seeded only CLI authentication/config files in `<isolated-home>/.gemini/` without any conversation history or summary files.
- Initialized a fresh synthetic git repository under `<isolated-home>/proj`.

## Conversations Exercised

1. **Conversation 1 (`<conv-1>`)**: `agy -p "Alpha payment queue audit\nDo not run tools. Reply with one word: AlphaOK" --disable-slash-commands --output-format json`
   - Hook lifecycle observed: `SessionStart`, `PreInvocation`, `PostInvocation`, `Stop`.
   - First-turn title fell back cleanly to line 1 of the unwrapped `<USER_REQUEST>` entry in `<isolated-home>/.gemini/antigravity-cli/brain/<conv-1>/.system_generated/logs/transcript.jsonl`:
     - `title`: `Alpha payment queue audit`
     - `titleSource`: `prompt`
     - `context`: `Started 2026-11-13 18:43:33.697`
2. **Conversation 2 (`<conv-2>`)**: `agy -p "Beta cache eviction plan\nDo not run tools. Reply with one word: BetaOK" --disable-slash-commands --output-format json`
   - `title`: `Beta cache eviction plan` (`titleSource`: `prompt`)
   - `context`: `Started 2026-11-13 18:43:45.002`
3. **Conversation 1 Resumed (`<conv-1>`, turn 2)**: `agy --conversation <conv-1> -p "Do not run tools. Reply with one word: AlphaTwoOK" --disable-slash-commands --output-format json`
   - Picked up the protobuf entry written to `jetbox_summaries_proto.pb` (`titleSource`: `summary`) while preserving original millisecond `startedAt` (`Started 2026-11-13 18:43:33.697`).
4. **Conversation 3 (`<conv-3>`, same prompt as Conversation 2)**: `agy -p "Beta cache eviction plan\nDo not run tools. Reply with one word: BetaTwoOK" --disable-slash-commands --output-format json`
   - `title`: `Beta cache eviction plan` (`titleSource`: `prompt`)
   - `context`: `Started 2026-11-13 18:44:10.811`

## Observed Board Output (`agent-board.mjs --print`)

```text
Progress  ● 0 waiting  ▸ 0 in progress  ⚑ 0 due soon  ✓ 0 done today

✓ Nothing needs you right now

▸ antigravity  3 items
  Alpha payment queue audit
    0/1 next: Waiting for the next instruction · Antigravity · just now
    Started 2026-11-13 18:43:33.697
    ○ 1 Waiting for the next instruction
  Beta cache eviction plan
    0/1 next: Waiting for the next instruction · Antigravity · just now
    Started 2026-11-13 18:43:45.002
    ○ 1 Waiting for the next instruction
  Beta cache eviction plan
    0/1 next: Waiting for the next instruction · Antigravity · just now
    Started 2026-11-13 18:44:10.811
    ○ 1 Waiting for the next instruction
```

## Cleanup

Deleted `<isolated-home>` recursively after capturing sanitized results.
