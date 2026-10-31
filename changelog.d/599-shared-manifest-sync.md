- **Setup / Multi-agent upgrades** · Updating or connecting one local agent keeps shared setup records in sync across every installed agent on the machine, so later upgrades or removals do not report false conflicts (#599).
  Tests: `updating shared runtime files for one agent synchronizes sibling install manifests without INSTALL_CONFLICT`.
