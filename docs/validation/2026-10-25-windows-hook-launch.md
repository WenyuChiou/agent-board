# Windows hook launch evidence

This is the second small [#241](https://github.com/WenyuChiou/agent-board/issues/241)
fix, after [#444](https://github.com/WenyuChiou/agent-board/pull/444).
Its base is `a12cad2e9134a91405a926f4cf01287631982b56`.
All inputs below are synthetic. No native Antigravity app, CLI model, real
conversation, account hook setting or trust setting was exercised or changed.

## Cause and scope

The old command starts PowerShell before Node. A same-bundle A/B probe on
Windows with Node 24.14.0 alternated six lifecycle events through each launch
path, using the same isolated home and progress file, without artificial CPU
load. A diagnostic preload observed startup, worker import, reporter spawn,
file locks and progress-file I/O. Its own instrumentation adds overhead.

| Phase | PowerShell fallback, six samples | Direct Node, six samples |
|---|---:|---:|
| Complete command | 505–995 ms | 370–1035 ms |
| Wrapper creation to Node entry | 294–620 ms | 22–244 ms |
| Node entry to worker import | 2–5 ms | 4–9 ms |
| Worker import to reporter spawn | 6–14 ms | 9–144 ms |
| Reporter startup | 50–147 ms | 79–282 ms |
| File-lock calls | 0.9–1.7 ms | 4.8–16.6 ms |
| Progress-file I/O calls | 0.3–1.4 ms | 0.9–10.4 ms |

This isolates substantial wrapper overhead in this sample. Complete-command
ranges overlap, and direct execution was slower in two of the six pairs;
scheduling and downstream work still vary. It does not prove
that every queued native Stop has this cause or that the intermittent failure
has disappeared. Startup shortening alone does not drain a final queued Stop.

Setup chooses a quote-free absolute executable when possible. Otherwise, a
bounded, fixed Windows short-path query may provide an existing absolute
alias. Nonzero filesystem device/inode identities must match the current
Node; Windows realpath can preserve the alias's spelling. Unavailable,
unsafe or unverifiable aliases retain PowerShell. No short-path setting is
changed, and no runtime PATH lookup is emitted. This is not a receiver or
messaging-readiness check.

## Checks and retained failures

- Actual `cmd.exe` commands verify synthetic working → waiting updates,
  preservation of another agent's block, command length, spaces, apostrophes,
  Unicode, quote/newline stdin, stdout/stderr and exit code 37. Both launch
  paths are covered. A copied Node in a private spaced path plus an unavailable
  query executable forces the fallback even on runners with a quote-free Node.
  Duplicate case variants of the Windows ComSpec environment key are removed
  in this fixture so its deliberately unavailable query actually takes effect.
- Independent review reproduced a PATH `node.cmd` mismatch in the original
  candidate and a cwd `node.exe` mismatch in the proposed bare-name correction.
  The new actual-cmd regression failed before the absolute binding (exit 37)
  and passed afterward; it checks both cases against the bound file identity.
  Bare `node` and `node.exe` are rejected by the command factory.
- Ownership extraction decodes bounded JSON argument data without executing
  the command. Existing legacy-to-independent takeover and launch-stamp
  checks passed in a five-test targeted run.
- An all-host pending replay run had nine passing leaves and one failing
  DeepSeek leaf (missing session record); the parent group also failed. One
  unchanged targeted rerun passed all ten leaves and the parent, eleven tests
  total. The first failure's cause remains unproven and is retained.
- The first new fallback fixture attempted a denied Program Files hard link;
  a private copy replaced it. A subsequent overlong fixture command returned
  1 before the stand-in worker. The corrected short fixture asserts the
  command-length limit and passes. No production timeout or assertion was
  weakened. The first timing probe also had an invalid diagnostic preload;
  only the corrected twelve-sample A/B run above is timing evidence.
  A later fallback fixture first used duplicate-case ComSpec keys, so the
  original query still ran; its corrected environment passed without changing
  the production fallback. Earlier timing results precede the final absolute
  binding; the table above is the final twelve-command run, not a best-case rerun.
- TypeScript 5.9.3 with Node 24.10.1 typings passes strict checks for the new
  executable helper and changed pure command/ownership modules. Checking the
  runtime integration also reports the same five existing errors as the
  unchanged base: two nullable step-array errors, one session-state union
  error, and two nullable-original errors. It is not a clean runtime typecheck.
  Full plugin typechecking is unrun because the genuine generated SDK is
  unavailable; no SDK declaration was invented.

The CI result, final head and full touched-file preflight are recorded on the
pull request. The CI-only busy-machine test remains subject to its existing
limits and assertions. Pending recovery without another input and real
web-card/native ACK acceptance remain open in #241 and the messaging work.
