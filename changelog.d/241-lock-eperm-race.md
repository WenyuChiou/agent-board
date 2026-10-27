- **A busy board lock on Windows is no longer reported as "access denied", so a hook no longer drops its event (#241).**
  Creating the lock while its owner is deleting it fails with EPERM and the file is gone a moment later. The lock now
  tries again, a few times with pauses of at most 10 ms, and reports `LOCK_DENIED` only when the refusal repeats with no
  file there; an EPERM from checking the lock file while it is released counts as busy, and one that stays refused is
  reported as it is. A real permission refusal still ends in `LOCK_DENIED`, after a bounded number of tries.
  Tests: `a lock create refused with EPERM while the lock file is absent takes the lock instead of reporting LOCK_DENIED`,
  `a lock create that stays refused with EPERM while the lock file is absent still reports LOCK_DENIED after a bounded number of tries`,
  `a lock whose stat is refused with EPERM while it is released counts as busy, and a stat that stays refused is reported`,
  `a Codex hook whose lock create gets EPERM twice exits 0 and its event lands on the board or in pending`.
- **A hook run whose reporter fails saves its event, and a failed recovery frees its claim (#241).**
  Any other failed event (not a report, and not a refusal of the event itself such as INVALID_SESSION) is now saved
  to the pending queue and recovery is asked for, instead of only being logged; the log keeps the failure code and adds
  REPORTER_QUEUED. A recovery whose first pass ends before it takes the board lock now releases its claim, so the
  next hook's recovery starts at once instead of waiting 30 seconds with events queued.
  Tests: `a hook run whose reporter fails saves the event to pending instead of dropping it`,
  `a recovery whose first pass fails before the lock releases its claim, so the next hook's recovery runs at once`,
  `a reporter error is logged and the previous block is kept`.
