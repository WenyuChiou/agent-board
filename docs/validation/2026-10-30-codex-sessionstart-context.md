# Live check — a Codex `SessionStart` hook's `additionalContext` reaches the model (#564)

One check on Windows 11 with Codex CLI 0.164.0, made for #564 before its pull request. It answers one question from #502: does the text a Codex `SessionStart` hook returns as `hookSpecificOutput.additionalContext` reach the model, as [Codex's hooks page, SessionStart](https://learn.chatgpt.com/docs/hooks#sessionstart) says ("That `additionalContext` text is added as extra developer context", read again on 2026-11-01)?

This is the parity record that #564's item 4 asks for. It is a link and its limits, not an acceptance: neither this record nor closing #564 is an interactive or native acceptance PASS.

**Result: yes, for `codex exec`.** The model quoted, exactly, a 12-character version string that only a `SessionStart` hook's `additionalContext` carried.

**How:**
- **The hook:** one already installed in the user's Codex configuration, a `[[hooks.SessionStart]]` command (matcher `startup|resume|clear|compact|fork`) that prints `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "<text with a version string>"}}`, the same shape `scripts/codex-local.ts` prints for #564. Its output was checked by running it once by hand with a synthetic `startup` payload.
- **The run:** `codex exec -s read-only` in an empty scratch folder, prompt: "Before this prompt, did any developer context mention a personal shared rules version? If yes, quote the version string exactly. If not, say NONE. Do not run any commands or read files." The model answered with the version string and nothing else, in 208 tokens; it ran no command.
- **Not from elsewhere:** the string is not in the Codex `AGENTS.md` or any instruction file that file points to; it is a hash the hook computes when it runs.

**Not covered:**
- **Agent Board's own hook did not run inside Codex.** Two ways to add it for one run did not load it: a `-c hooks.SessionStart=[…]` override and a `.codex/hooks.json` in the untrusted scratch project (the hook's input file was never written). Installing it in the user's own `~/.codex/hooks.json`, or a scratch `CODEX_HOME` with a copied sign-in, was not done without the owner. What `scripts/codex-local.ts` prints for a `startup` payload is covered by `a Codex session a person starts gets the open work of other sessions in its folder at SessionStart, and a run or a resumed session gets none`.
- **Only `codex exec`.** An interactive Codex CLI session and the Codex app were not run. #564 gives the note to a session a person starts and none to a `codex exec` run (#501), so the path #564 uses in practice is the interactive one, which shares the hook engine but was not observed here.
- **The native gap.** The delivery observed here was `codex exec` with a different installed hook. Agent Board's startup output is unit-tested, as above. Its delivery through Agent Board's own hook to an interactive CLI session or the desktop app remains untested; #252 tracks this gap.
- **The parity matrix** (`docs/parity-matrix.json`) has no capability for a start note; adding one is a matrix change of its own (#252), not part of #564.
