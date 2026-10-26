- **The sender matrix keeps its own test watchdog (#447).** The full synthetic
  sender/receiver matrix no longer shares the other L3b journeys' parent timer.
  Every pair, assertion, concurrency limit and existing watchdog is retained.
  Tests: `messages: every sender-receiver pair either delivers with a receipt or names the fallback in words`.
