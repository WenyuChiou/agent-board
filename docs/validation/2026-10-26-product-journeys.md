# Product journeys before browser automation

Manual baseline: `main` at `5200252`; automation base: `70bc288` after #446.
The owner requested hands-on product operation before
converting confirmed workflows to Playwright. The parent used a real independent
installation and localhost page with disposable home/configuration folders on Windows. No model or
native receiving transport was used, and no release is included.

| Journey | Parent operation | Browser regression |
|---|---|---|
| Preview, install and repeat preview | Confirmed exact file scope and zero repeat changes | Passed |
| Preserve foreign hooks and synthetic auth | Original values/bytes retained; no trust write | Passed |
| Empty board and web-chat progress import | Actual empty view and pasted Muse question | Passed |
| Copy-only reply | UI showed Copy and did not claim Sent/Replied | Copy availability checked; clipboard untouched |
| Hide an answered question | Left pending; hidden state survived reload | Passed |
| Show a hidden question again | Returned to pending without losing content | Passed |
| Multiple agents and filtering | Shared board with three synthetic agents | Passed |
| Light and Dark | Both inspected with real screenshots | Passed |
| Complete manual steps | Two presses advanced 0/2 to completed | Passed |
| Archive completed work | Two completed tasks moved; open/hidden questions stayed | Passed with archive/ledger checks |
| Final Stop during a transient lock | Actual generated command and page recovered without another input | Passed with source-time and drained-queue checks |
| Archive a four-day stopped task with an unanswered question | Found it under stopped work, archived it, then opened Older unanswered questions | Passed with stable ID, observation and source checks |
| Close the board | Service stopped and page displayed its closed notice | Parent operation only |

The five Chromium journeys run serially through the actual installed CLI and HTTP
server. Each has an isolated home, configuration, runtime folder and browser
context. They save traces, screenshots and command results outside the checkout.
No fake browser, in-memory page implementation or provider transport is used.
The Stop case drives the real installed shell command with synthetic event JSON
and a controlled transient file failure; it does not invoke Antigravity itself.
The aging case supplies an older source timestamp. It verifies preservation of
the first observation and source metadata, not four days of elapsed wall time.
The complete five-case candidate passed on the integrated base on Windows with
Node 24.14.0 and Playwright 1.62.1, zero failures, skips or cancellations.
Fixture setup preview paths are checked before writes, and live recovery owners
must exit before cleanup. Screenshot, trace and cleanup errors fail the journey;
they are not silently accepted after successful UI assertions.
These local results do not replace the final branch preflight or both CI systems.

The initial automated run failed three cases because its locators did not match
the real DOM. After correcting article/details boundaries and DOM button roles,
the three journeys passed with zero failures, skips or cancellations. Original
failure traces remain retained. Platform accessibility trees may describe a
pressed button as a checkbox; Playwright locators follow the actual DOM role.
An isolated Windows run later completed the UI assertions but failed removal of
its fixture with EPERM. Cleanup now verifies owned process exit and retries only
transient fixture-removal errors within a fixed bound. A failed cleanup remains
a failing test with retained diagnostics; it cannot turn a failed journey green.

An initial drive-root scratch runtime also failed Windows ownership protection;
the board failed closed. A normal user-Temp runtime succeeded. This record does
not claim every filesystem location is supported or that the failure was fixed.

## Required native acceptance

Browser checks do not establish native hooks or bidirectional receiving. Keep
separate rows for Codex app-server, CLI TUI, desktop chat and Antigravity CLI.
Each supported receiver needs a real matching ACK and visible Replied result.
Exercise duplicate/conflicting IDs, stale turns, wrong sessions, idle-online,
offline and uncertain outcomes without spawning a replacement conversation.
Unavailable providers remain untested. Approvals, trust and real model turns
require the owner's exact confirmation before execution.

Maintain this journey list when behavior changes: first operate the affected flow,
record what appeared and what persisted, then extend the browser regression.
Before release, use PARITY-CHECKLIST.md for native surfaces and retain unanswered
question aging, Mark read, collapse, completion and archive integrity checks.

For each product review, identify any changed journey, its happy path and its
recovery path. An agent must operate new installation/trust prompts, native
receiving, question resolution and destructive-looking archive controls at least
once on the intended surface before claiming native acceptance. Reuse unchanged
evidence with matching source/runtime inputs; do not consume new model turns just
because a review or session is new. Keep observations, protocol tests and actual
provider ACK/Replied results in separate rows, with untested rows visible.
