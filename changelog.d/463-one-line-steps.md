- **A card on the serve page shows each step and each note as one line (#463).** Every step, and
  every step with its note, shows as one line cut to the width of the screen with an ellipsis, so a
  Chinese step does not wrap on a 375 px phone; opening it, by click or by keyboard (Enter or
  Space), shows the whole text, and it stays open when the page draws again. A card's notes (its
  background line, or a hand-kept task's note lines) show the same way. A Done button names a long
  step by its first words and keeps the whole step in its title, and a press still ticks the whole
  step. Done recently rows use the task title, clipped, never a step text. Nothing is cut from the
  record: a step that holds a whole work log is sent once folded to one line and capped at 400
  characters, the cap never splits a Chinese character or a surrogate pair, and a line break inside
  a step folds into one space. Stopped cards clip the same way.
  Tests: `a step longer than one line shows one line on the card and its full text on open`,
  `a Done button names a long step by its first words`,
  `Done recently rows show the task title, not a step text`,
  `a clipped step keeps its open state across a refresh`,
  `clipping a Chinese step never splits a character`,
  `the board model clips a step to one line and keeps the whole step for a press`,
  `a sixty-character Chinese step is sent whole for the page to cut by its width`,
  `a card's notes show as one line with the full text on open`,
  `on a 375 px phone every step and note is one line and opens to the whole text`.
- **One question asked in several places is one card (#463).** Questions with the same agent, the
  same folder the session ran in (`dir=`; `C:\a\b` and `C:/a/b` are one folder, and the heading of the
  project is not the folder) and the same words once trimmed and with spaces collapsed show as one
  card, with the oldest age and the newest source; the other copies stay in the question list. A
  question with no known folder stays its own card. Hide closes every copy recorded so far,
  including a stopped session's copy recorded after the live one; an answer closes the copies
  asked before it, and a later ask shows again. A session that only asked again (a renewal) does
  not cover another session's copy. A Hide pressed on an older question before another copy arrived
  is refused. The count beside Waiting on you counts the question once.
  Another agent, or another folder, is another question; two copies from one session and a copy
  the question list has no record of yet stay as they were.
  Tests: `the same question in a block and in an inbox capture shows as one card`,
  `the same question in two blocks of one agent and folder shows as one card with the oldest age`,
  `the same words from two different agents show as two cards`,
  `hiding or answering the one card closes every copy of it`,
  `the count beside Waiting on you counts the question once`,
  `a stopped session's copy joins the live card instead of listing the question again`,
  `two retained copies of one question show once under Older`,
  `a copy cut off in the middle of a write neither makes a card vanish nor changes its age`,
  `two blocks of one agent under one heading but in different folders show as two cards and Hide closes only the one`,
  `a question whose block has no folder stays its own card next to the same question in another block`,
  `a question stays on the board when another session's copy of it is renewed`,
  `hiding a question also hides a stopped session's copy that was recorded after it`,
  `folders that differ only by a backslash or a trailing space in their name show as two cards`,
  `a question another session finished stays closed when that session goes on to ask something else`,
  `a Hide pressed on an older question is refused once another copy of it has arrived`.
- **The HTML board shows a question that is in an agent block and in the inbox once (#463).** The
  test that pinned the old duplicate now pins one card and a count of one.
  Tests: `the HTML board shows a question that is in both an agent block and the inbox once, like the terminal board and --serve`.
- **The read-only-file journey finds a long step's Done button by its title (#463).** The button
  now shows the step's first words, so the journey looks it up by the whole step in its title and
  checks that the label is clipped.
  Tests: `L5 read-only file: a failed tick writes no journal line and shows a one-line reason`.
- **The four-day stopped-task journey finds a step by its visible line (#463).** A step now keeps
  its visible one-line text and its whole text side by side, so the journey looks at the visible
  line.
  Tests: `archiving a four-day stopped task retains its unanswered question and original observations`.
