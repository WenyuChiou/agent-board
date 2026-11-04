# Plan for 0.24.3

The owner chose this cut-down plan on 2026-11-04, after 0.24.2 became the stable release. It came from a re-plan, an adversarial review of that re-plan, and a check against [product-principles.md](product-principles.md). The issues live in milestone "0.24.3 One command, and answer Codex from the board". The roadmap is #209.

**Theme:** the board opens by itself, the answer gets there, and the status does not lie. **Size:** 20 issues, about 1.5 to 2 weeks. Three were added on 2026-11-04, after the cut: #881 and #491, for the README, its pictures and the video, and #884, for the AI's own read of the board.

**0.24.3 is a major change.** It removes:
- the `/board` command files;
- typing `--serve`, since `/agent-board` starts the page;
- `progress.html` and `--html`;
- the plain-text board for people;
- Copy.

People use the page that `/agent-board` opens, the terminal board and Claude Code's `/progress` pane. An AI reads the board as JSON (#884), and `--chat` keeps working for one more version. The README and the release notes say this first (#881).

## What is in 0.24.3, and why

| Goal | Issues | Why it is in |
|---|---|---|
| The board opens by itself | #868, #865, #859 | No agent's board command opened the page in the 0.24.2 parity record (FRICTION #865). This was the owner's top complaint. `/agent-board` opens the page, the `/board` files go, `--serve` works only until setup rewrites the files, and skills stop printing board text. #865 also finds out why no window opened from Antigravity and the Codex app. |
| Codex receives | #557, then #319 only if needed | Codex comes first in #209's order. The review found the likely cause: the connector writes plain JSON into `codex app-server proxy`, which needs a WebSocket handshake. Fix that and take a live receipt before any larger work. |
| Send, not Copy, where a path exists | #844, #826 | Every answer in the parity record went by copy. The cards send wherever a path exists today, and the row says honestly when the answer arrives. Each host with no path gets a gap issue. |
| The status does not lie | #860, #861, #863, #856, #862 | In the parity record a running turn never showed as working, one question showed as four rows, a stopped session showed as working, and the page took about 20 s. |
| Small owner asks | #870, #790, #854, #855 | Grey icons that look broken, old questions that stay listed, and setup that finds no agent in a new home. |
| An AI reads the board itself | #884 | Without the text board, Hermes, OpenClaw, Codex, OpenCode and DeepSeek would lose their read for a whole version. The owner, 2026-11-04: 「那就是要有一個給AI自己讀的方式 但人類仍以UI為主 看不能用訊息的方式 或是怎麼樣 這個得討論」. On the plan that followed he said 「可以」: `agent-board --json` now, and the push and MCP in 0.24.4. |
| It never breaks | #877 | 0.24.3 renames commands and rewrites every skill. A 0.24.2→0.24.3 upgrade journey runs before the tag. |
| The README shows what ships, and sells it | #881, #491 | The README and 24 of its pictures still show `/board`, `--serve`, `progress.html` or Copy. The owner asked for the pictures to be redrawn, a 45-second cover that sells the board, and MP4s of it for social media. |

## Order

The owner approved this order on 2026-11-04 ("Order is fine"). It simplifies the entry first and strengthens the features after (「那應該要先精簡入口吧 加強功能這樣?」).

| Wave | Work | Issues | Why here |
|---|---|---|---|
| 1 | The board opens by itself, with one command | #868, #865, #859 | The entry itself, and the owner's top complaint |
| 1 | An AI reads the board itself | #884 | Lands with #865, which removes the text board, so no agent goes without a read |
| 1 | It opens fast | #862 | A page that opens by itself but takes 20 s is still a poor entry |
| 1 | Setup finds the agents | #854, #855 | The first step of the entry. Two small bugs, one pull request |
| 1 | The upgrade does not break | #877 | Wave 1 renames the command and rewrites every skill, so it ships with this test |
| alongside | The Codex handshake fix and a live receipt | #557 | About half a day. Its result decides whether #319 is needed and which agents wave 3 reaches |
| 2 | The status does not lie | #860, #861, #863, #856 | Once the entry is simple, what it shows must be right |
| 3 | Send, not Copy | #844, #826; #319 only if #557 fails | Needs #557's result to know which agents have a path |
| 4 | Small fixes | #870, #790 | Small and independent; any free lane takes them |
| 4 | The README, its pictures and the 45-second video | #881, #491 | Last, so the pictures show what ships. The owner approves the story text before the video is recorded |
| gate | Acceptance before the release | #877's journey, and a sitting of about 2 hours with the owner if he agrees (decision 3 below) | The release gate |

Until Codex has quota again on 11-07, three Claude lanes run: wave 1's page and skill work (#868, #865, #884, #859, #862), setup and upgrade (#854, #855, #877), and #557. Their files barely overlap. From 11-07, Codex takes the mechanical parts, such as skill text and string tables.

## What moved, and why

Focus means saying no ([product-principles.md, section 7](product-principles.md)).
- **0.24.4,** "The phone sends, agents read and send, idle apps wake":
  - the phone send (#866), after the owner approves its design;
  - agents reading and sending: #721 with PR #842, #723, #317, #869. The JSON read lands in 0.24.3 (#884). 0.24.4 adds:
    - the push, for three kinds only (#869);
    - MCP serving the same JSON (#721);
    - the MCP entry in each host, now including OpenClaw, Codex, OpenCode and DeepSeek (#723);
    - the removal of `--chat`;
  - idle apps waking: #318, #722, #858;
  - #686;
  - setup writing into another agent's config, after a consent design;
  - the usersim FRICTIONs, #851, #852 and #803.
- **0.25.0:** older view bugs, CI flakes and process issues.

## What the removals touch

The removals reach other files, commands and issues. Each list is a comment on the issue that does the removal:
- #868: the `/board` files and `--serve`;
- #865: `progress.html` and the text board;
- #844: Copy.

Each pull request handles every item on its list, or moves an item to its own issue with the owner's OK.

## Corrections the review made to the re-plan

- **Codex delivery.** The failure is likely our own connector bug, not the Codex proxy. The details are on #557.
- **#319** is labelled blocked. It cannot ship without clearing #318 first.
- **Agents reading progress through MCP.** This needs #723's MCP entry, not only #721. Until both land, agents read `agent-board --json` (#884).
- **Text output for agents.** Keeping it would conflict with the owner's rule, so agents get a JSON read instead (#884).
- **Old names.** They work only until setup rewrites them, not forever.
- **"Done when" lists** name only agents that can be tested. Gemini CLI's service has ended.

## Still for the owner to decide

1. The phone design (#866 step 2):
   - pair by QR code from the computer's page, with a credential per phone;
   - the hub delivers each send, through an allow-list;
   - local network only until 0.25.
2. Muse and dot in 0.24.5: start with one bot.
3. One 2-hour acceptance sitting with the owner at the 0.24.3 release.
