- **Every card names its agent by brand, a noted choice question keeps its options, and Reply comes first with at most three buttons (#461).**
  A question step is read for its options in the order the agent's own `options`, then the
  question, then the note, so `Which metric, win rate or Elo? — the reports will follow it`
  keeps its two buttons whatever the note says, unless the note asks a yes/no question, holds a link or a
  command, or opens by asking for a look or an action: then the note decides the kind and a stray `or`
  or `還是` in the question does not make a choice. The page and the pane print `Codex`,
  `Claude Code` or `Gemini CLI` from the `agentNames` table instead of the lower-case name
  (an agent with no brand name keeps its own name; a hand-kept task names no agent), and
  the terminal board and `progress.html` say `Codex is working` the same way while their
  reply hint keeps the lower-case name. On the page a card shows at most three action
  buttons (the reply box's own Send button and `More` are not counted): the answers, then
  the reply box, then the other actions, with `Copy resume command` last and the rest
  behind one `More` button that keeps its state across a refresh; a question with more than
  three answers keeps every answer visible.
  Tests: `a choice question with a note keeps its two options as buttons`,
  `a note that holds a choice does not replace the options in the question`,
  `options the agent gave win over options found in the question or the note`,
  `a question with no choice still takes its options from the note`,
  `a note that asks or points to something of its own decides the kind, whatever the question holds`,
  `agent labels read only brand names owned by the table and preserve an empty agent`,
  `the page names each agent by its brand name on questions, rows, turns and older questions`,
  `a Claude Code card says Claude Code and a hand-kept task names no agent`,
  `an agent without a brand name keeps its own name`,
  `every card kind on the page carries its agent's mark`,
  `the pane names agents by brand name`,
  `a question card puts the answer buttons first and Copy resume command last`,
  `a card with more than three actions shows three and the rest behind More`,
  `a card with three actions or fewer shows no More button`,
  `a question with four answers keeps all four visible`,
  `More opens and closes by keyboard and keeps its state across a refresh`.
