- **Confirmed product workflows run in a real browser (#241).** Serial Chromium
  journeys exercise independent setup, preserved settings, question hiding and
  restoration, agent filters, themes, completion, queued Stop recovery and safe
  archival of older unanswered questions in disposable homes.
  The CI job retains synthetic evidence and keeps provider acceptance separate.
  Tests: `setup is idempotent and a reported Muse question remains recoverable across reloads`,
  `agent filters and light and dark themes operate on three synthetic agent cards`,
  `finishing and archiving manual work preserves active and hidden questions`,
  `a queued final Stop updates the visible card without another hook or manual recovery`,
  `archiving a four-day stopped task retains its unanswered question and original observations`.
