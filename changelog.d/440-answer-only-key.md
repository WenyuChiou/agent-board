- **One new answer alone wakes the question pass (#440).** A register-level regression holds the other idle-key inputs fixed, verifies exactly one pass for a newly remembered answer, and keeps later idle polls quiet. The existing answer age-out regression remains in place.
  Tests: `adding one remembered answer alone runs exactly one question pass and later idle polls stay quiet`.
