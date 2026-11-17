# Changelog

## 0.6.0 — Honesty & Hardening

### Added

- Parser normalize logging for observability.
- Tombstone/reaper observability in logs and `memory_health`.
- Read-only measure report (`tools/measure.ts`) with `pending`, `notes`, and `hygiene` groups.
- Hygiene section: permission issues, corrupt backups, and stale tmp files are reported instead of silently ignored.

### Changed

- Session id validation cap: `[A-Za-z0-9_-]{1,128}`.
- Directory modes tightened to `0700` (files `0600`), repaired automatically on activation.
- Build record (`build.json`) is written atomically.
- Bidirectional exports contract: the package resolves through the `exports` map for both npm installs and local directory installs.
- Version 0.6.0.

### Fixed

- Sweep enumeration race.
- Temporary file cleanup.
- Redaction happens at the source, before anything is persisted to disk.
- Consolidation failure retry flag.

### Removed

- The fabricated loss metric from the measure report — the report is honest and contains only what was actually read from the files.
- Dead `SessionState.capture` state.

### Security / Privacy

- Best-effort secret redaction is documented (heuristics, not a guarantee).
- No telemetry; nothing leaves the machine except the consolidation model call to the configured model provider.
- Per-session isolation; there is no cross-session access.

### Notes

- Consolidation retry is idle-driven: it is scheduled on the next idle event after backoff (1→2→4→8→10 minutes); there is no standalone timer.
- Known upstream issue: <URL>
