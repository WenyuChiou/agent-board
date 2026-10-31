- **OpenCode / Exit** · When OpenCode exits with several sessions the board could not end in time, their timeouts are logged in one write kept inside the shared exit limit, so the exit no longer runs past it on a slow Windows disk (#576).
  Tests: `opencode: two sessions in one process both end within one shared deadline`.
