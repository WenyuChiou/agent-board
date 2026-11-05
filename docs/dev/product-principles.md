# Product principles

These are the owner's rules for what Agent Board is and how a feature is judged ([RULES.md, R1](RULES.md#r1-who-decides-what): the owner sets direction). Read this page before you design or change anything that a person or an agent sees. A change that goes against one of these rules needs the owner's word on its issue first. Each rule names the issue that carries it out.

## 1. Fewer steps, not fewer things

- Count the person's steps end to end, before and after the change. A change that removes something but adds a step for the person is a regression. This is the bar in roadmap issue #209, "How we judge a feature".
- A person should have few things to work, and each one should be very useful. Owner, 2026-11-03: 「這種產品就是本身人需要操作的功能需要少 但是非常有用」.

## 2. One command

Owner, 2026-11-03: 「接口單一才越好…一個統一指令…簡單 無腦且很厲害」 (one way in, simple, brainless and powerful).

- **In an agent:** `/agent-board`, the same in every agent, opens the board's page (the HTML UI) directly. It shows the person no board text in the chat; at most one line with the link, and only when no window could open (#865, #868).
- **Going:** `/board` and `--serve`. No command file, skill, help line or guide will ask a person to type them (#868). `progress.html` goes too (#865).
- **In a terminal:** plain `agent-board` opens the terminal board (`--watch`), which can do everything the page does (#844).
- **Claude Code:** the native `/progress` pane stays, and it can open the page (#865).
- **No flags, one step:** no flag is needed in everyday use, and installing takes one step (#868).

## 3. No Copy: every answer and message is sent

Owner, 2026-11-03: 「我們希望都是能夠立刻收到 (在板子上直接傳訊 都不要用copy)」 (every agent should receive at once, sent straight from the board, never by copy).

- An answer or a message from the board reaches the agent: at once where the agent allows it, otherwise at its next step. A Copy button is not an accepted way to answer (#844).
- **Judge each AI twice:** for a person who works in its terminal and for a person who uses its app. Count both people's steps (#851). The support table names each surface the way a person sees it (#852).

## 4. One board, for every agent and every screen

- **Every agent, the same way:** every connected agent gets the same command, the same board and the same sending. A fix is checked on every connected agent and on every way to open the board (owner, 2026-10-17).
- **The phone:** the phone page sends like the computer's page. It is also the path for personal and cloud agents such as Muse and dot. Owner: due across 0.24.3 to 0.24.5 (#866).

## 5. Agents use the board too

Owner, 2026-11-03: 「AI還能夠從agent-board了解其他AI的session的進度 甚至有時候還可以透過他傳訊 (類似muse可以通知本地的某個session)」 (an AI learns the other sessions' progress from the board, and can send through it, as Muse telling a local session about work).

- **Reading and sending:** any agent can read the other sessions' progress whenever it needs to, and can send to them through the board. Muse or dot can hand work to a local session the same way (#869, #317, #866).
- **What an agent may not do:** it never approves tool use (owner, 2026-11-03).
- **Planned with it (#869, #317):** a message from an agent shows as from that agent, not from the person. What another agent wrote reaches a model as quoted data, never as an instruction.
- **Cloud agents:** a cloud agent sees only the rows that the person marked as shared, and those rows are redacted. Connecting one never asks the person to open an account they do not already have (#209, row C).

## 6. A status you can trust

- **Source and age:** every status says where it comes from and how old it is, and it says "unsure" when it is stale (#209).
- **Private data:** nothing private goes onto GitHub ([RULES.md, R8](RULES.md#r8-what-stays-off-github)). A shared row goes out redacted (#209, row C).

## 7. Rules borrowed from good product design

The owner chose these on 2026-11-04 from well-known product and design practice. Each one makes the person do one thing less, or never do a thing twice.

- **It never breaks.** After any update the board still opens. When something fails, it falls back to a state that works and does not leave the person with nothing. Owner, 2026-10-22: 「不能像上次一次/progress直接不能用」 (#371).
- **Show only what needs you.** The first screen shows what needs the person now. Old questions and finished work fold away and retire by themselves (owner: 「適度退休」; #790, #511).
- **You can take it back.** The person can undo an archive or a "done" (#566), and stop a run that a press started (#565). This is "user control and freedom" in Jakob Nielsen's usability heuristics.
- **The product carries the complexity.** Complexity does not disappear; someone carries it (Larry Tesler's law of conservation of complexity). Setup and the board carry it, so the person does not. For example, one-step install handles each agent's files (#868).
- **Focus means saying no.** Each version does a few things well. A feature that goes against these rules needs the owner's word on its issue first (Steve Jobs on focus; Dieter Rams, "less, but better").
- **Design is how it works.** What counts is that a thing works with one press, not only how it looks: an answer that arrives beats a nicer button (Steve Jobs: design is not just how it looks and feels, but how it works).
- **The person decides.** An agent never makes a choice that is the person's. A message says who sent it, and a status the board is not sure of says "unsure" (Microsoft's Guidelines for Human-AI Interaction; Google's People + AI Guidebook).
