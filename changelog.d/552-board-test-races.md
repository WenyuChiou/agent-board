- **Board tests avoid a sweep setup race and retry Windows cleanup (#552).** The hourly sweep fixture is ready before the server starts, and the run helper retries removal when Windows holds a temporary directory.
  Tests: `the page's server runs the hourly sweep and writes nothing when the seen file cannot be read`, `a --serve whose server cannot start says so without mentioning a page`.
