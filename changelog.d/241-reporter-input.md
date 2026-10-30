- **Reporters / Windows input** · On a busy Windows computer, an agent's event is no longer dropped while PowerShell starts (#241).
  Tests: `the PowerShell reporter reads a complete input before it loads any module`, `the PowerShell reporter calls no cmdlet between its input clock and the payload`.
