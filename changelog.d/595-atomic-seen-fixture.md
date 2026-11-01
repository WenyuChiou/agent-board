- **Tests / Hourly sweep** · The damaged seen-file check no longer exposes an empty file while replacing its test data, avoiding an intermittent false failure (#595).
  Tests: `the page's server runs the hourly sweep and writes nothing when the seen file cannot be read`.
