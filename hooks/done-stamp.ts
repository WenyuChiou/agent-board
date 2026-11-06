// The hidden date the board puts at the end of a finished step (#922): ` <!-- done 2026-11-06 -->`.
// It is a comment, so every reader skips it (`readable` in parse.ts): a step's text and a task's
// fingerprint are what they were without it. The one exact form keeps a stamp and the line it
// sits on separable, so a press made on the line as it was drawn before the stamp still finds it.

const STAMP = / <!-- done (\d{4}-\d\d-\d\d) -->$/

// The day on the line's stamp, or null when it has none.
export const stampOf = (line: string): string | null => STAMP.exec(line)?.[1] ?? null

export const withoutStamp = (line: string): string => line.replace(STAMP, '')

// The line with its stamp set to `day`, in place of any stamp it had.
export const stamped = (line: string, day: string): string => `${withoutStamp(line)} <!-- done ${day} -->`
