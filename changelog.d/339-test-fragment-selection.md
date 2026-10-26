### Fixed

- **Test-only CI stays narrow beside release notes (#339).** A required CHANGELOG fragment no longer selects unrelated test files in an affected suite. Removing the only affected test still forces a complete plan; runtime and unknown changes retain conservative selection.
  Tests: `test-only CI selection stays narrow beside a changelog fragment`, `a changelog fragment does not hide removal of the only affected test`, `runtime and unknown changes keep conservative CI selection beside a changelog fragment`.
