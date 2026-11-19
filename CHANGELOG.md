# Changelog

## 0.6.1 — Hardening

### Added

- Preflight `selfcheck` CLI (`bun run selfcheck`): verifies the plugin's full local
  import graph (named imports, `export *` targets, nested modules) and exits 1 when
  the graph is broken or a hardcoded `/home/<user>/` path is present.
- `sweepMaxPages` option: bounds how many directory pages the sweep enumerates per
  run (default 50, clamped to 1–200).
- Warning in the injected summary when the last consolidation failed: the summary is
  labelled as possibly out of date (also covers stale/recovered failures).
- Redaction of common secret formats and of activity targets (see Security / Privacy).

### Changed

- Idle consolidation is non-blocking: the idle hook returns immediately and the work
  runs as a plugin-scoped fiber, one per session. Deleting a session interrupts its
  fiber and frees the slot; active attempts are protected from stale recovery while
  their fiber is alive (registration TTL: 30 minutes).
- Sections are capped before tokenization and the consolidation prompt is bounded, so
  verbose notes cannot blow up the injection or consolidation prompt.
- Manual notes are capped at 200 per session; the oldest are evicted when the cap is
  exceeded, and the cap is also applied when reading legacy files. The cap is fixed,
  not configurable.
- `memory_recall` / `memory_list` return previews of at most 500 characters per note
  inside a JSON payload capped at 32 KiB, with `truncated` and `totalNotes` flags.
- Retry is limited to transient errors (network, timeout, 5xx); 429/quota/auth and
  other 4xx errors are not retried. Attempts running longer than 5 minutes are marked
  failed unless their fiber is still registered as active.
- The deferral budget (3 times / 15 minutes) resets after a successful consolidation.
- Deletion is serialized with in-flight writes: the tombstone is re-checked before the
  rename, and the temporary file is unlinked when the write is skipped.
- Child/fork snapshots merge inherited chains instead of overwriting them: facts and
  notes are deduped, the lineage label is not replaced, and an empty child still gets
  a full snapshot.
- `memory_store` accepts omitted `tags` (coerced to `[]`) and rejects an explicit
  non-array shape.
- A consolidation with no changes skips the disk write; collection also skips a session
  that was deleted while the model call was running.
- Transient reads (`EACCES`, `EPERM`, `EISDIR`) are logged instead of quarantining the
  file; legacy v1/v2/v3 files are normalized to v4 semantics on read.
- Activity metadata records mutating git commands (branch delete/move/copy/force/
  upstream) and single-word commands that belong to an aggregated fact; the capture
  path signal is narrowed (`and/or` is no longer always, while `src/x` still is).
- Permission repair creates directories with mode `0700`; integer config options are
  clamped to safe ranges.
- Duplicate fact measurement is counted per file, not globally across files.
- Event-subscription failures are logged (`event-stream-failed`) instead of being
  dropped; the sweep remains the safety net.

### Fixed

- Delete/write race that could recreate a session file after deletion.
- Silent event-stream failure.
- Snapshot overwrite when the child already had its own memory.
- Unbounded `memory_recall` / `memory_list` payloads.
- Legacy files with more than 200 notes or non-array sections.
- Silent stale consolidation attempts and unnecessary retries of quota/auth errors.
- Health report hiding a failed summary and over-counting duplicates across files.

### Security / Privacy

- Redaction (best-effort) now covers JSON key/value secrets (`api_key`, `secret`,
  `token`, `password`, …), `Bearer` tokens, `sk-` keys, `npm_`, `ghp_`, AWS/Google/
  Slack/GitLab tokens, JWTs, credentials in known URL schemes, Authorization headers,
  and private-key blocks. Activity targets (commands, paths) are redacted too.
- No telemetry; the only network call remains the consolidation model call.
- Per-session isolation and the no-cross-session tool surface are unchanged.

### Notes

- Schema stays v4; no new dependencies and no migration step.
- Accepted limitations are documented in both READMEs (no fsync, per-process lock,
  `sourceHash` scope, synchronous logging, notes cap, payload bounds, selfcheck scope,
  background consolidation).
- Version 0.6.1.

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
- Known upstream issue: https://github.com/anomalyco/opencode/issues/64366
