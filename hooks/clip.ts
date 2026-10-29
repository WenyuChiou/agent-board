// How much of a step or a title the page keeps on one line (#463). The counts are characters, not
// pixels: only the browser knows how wide a line is, so the page's style cuts each line to its
// width with an ellipsis (a Chinese character is twice as wide as a Latin one). `LINE_ROOM` is a
// generous cap so a step that holds a whole work log does not fill the page twice; `LABEL_ROOM`
// keeps a button from being as long as the step it ticks.
export const LINE_ROOM = 400
export const LABEL_ROOM = 36

// The text on one line: every run of spaces, tabs and line breaks (a pasted step can hold
// CRLF) is one space, and what does not fit in `room` characters is replaced by `…`. It counts
// code points, so a Chinese character outside the first plane is never cut in half. Only the
// copy shown is changed; the record keeps the step as it was written.
export const clipLine = (text: string, room: number): { line: string } => {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)

  return { line: chars.length > room ? `${chars.slice(0, Math.max(1, room - 1)).join('').trimEnd()}…` : flat }
}
