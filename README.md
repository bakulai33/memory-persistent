[English](README.md) | Bahasa Indonesia

# memory-persistent

Per-session persistent memory for OpenCode V2 — a plugin + skill that lets the model
remember what happened in the current session, while that memory can never leak into
another session.

## Features

- **Hybrid** — automatic consolidation of the session plus manual notes.
- **Per-session** — memory files are stored per `sessionID`; there is no cross-session access.
- **Persistent** — memory survives a server restart.
- **Auto-cleanup** — memory files are removed when their session is deleted.

## Requirements

- OpenCode V2
- [Bun](https://bun.sh) (OpenCode loads TypeScript plugin sources directly)
- `effect` 4.x as a peer dependency (supplied by the OpenCode host)

## Installation

This plugin is **not published to the npm registry**. Install it from GitHub
or from a local directory.

### From GitHub

```bash
opencode plugin add opencode-memory-persistent@git+https://github.com/bakulai33/memory-persistent.git#v0.6.2
```

Then add it to `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    "opencode-memory-persistent@git+https://github.com/bakulai33/memory-persistent.git#v0.6.2"
  ]
}
```

or with plugin options:

```json
{
  "plugins": [
    {
      "package": "opencode-memory-persistent@git+https://github.com/bakulai33/memory-persistent.git#v0.6.2",
      "options": { "tokenBudget": 5000 }
    }
  ]
}
```

Pin the exact tag (or a commit SHA) so upgrades are explicit.

### From a local directory

```json
{
  "plugins": ["/path/to/memory-persistent"]
}
```

A local directory loads through the package `exports` map; no build step is needed.

## Configuration

| Option | Default | Meaning |
|---|---|---|
| `tokenBudget` | `5000` | Token budget of the memory injected into context |
| `sweepEnabled` | `true` | Enable the sweep for orphaned memory files |
| `sweepIntervalMs` | `21600000` (6 h) | Interval between periodic sweeps |
| `sweepMaxPages` | `50` | Maximum directory pages the sweep enumerates per run (clamped to 1–200) |
| `consolidationMode` | `stateless` | Consolidation call mode: `stateless` (prompt built from the delta only; session history is not sent) or `session` (session history included) |

## Lifecycle

| Event | What happens |
|---|---|
| Important prompt | Marked as a pending turn (heuristic, no model); the capture policy decides whether it is stored |
| State-changing tool | Recorded as activity: files changed, meaningful commands, or errors |
| Every request | Memory is injected as a system part (max `tokenBudget` tokens, default 5000) |
| Session idle | The hook returns immediately; consolidation runs in the background as a plugin-scoped fiber: state `idle` → `running` → `idle` (success) or `failed` |
| Consolidation runs > 5 minutes without finishing | The attempt is considered dead, recovered as `failed` (`consecutiveFailures++`), then retried after backoff |
| Consolidation fails | State `failed`, error recorded (redacted), retried on the next idle after a backoff of 1→2→4→8→10 minutes; the narrative batch is completed (pending turns are not lost) |
| Consolidation succeeds | State `idle`, `consecutiveFailures` = 0, `needsConsolidation` false when nothing is pending |
| Idle session with background work running | Consolidation is deferred (up to 3 times / 15 minutes); the summary may be partial |
| Session created (child) | Inherits a snapshot of the parent's memory |
| Session forked | Inherits a snapshot of the source session's memory |
| Session deleted | Memory files (and corrupt backups) are removed |
| Startup / periodic | Sweep removes orphaned memory files |

Recorded activity is deliberately narrow: only files written or modified, commands that
actually change state (`git`, `bun`, `npm`, `docker`, `pytest`, …), and every error.
Navigation and reads (`cd`, `ls`, `grep`, `cat`) are not stored because they only blur
the conversation.

## Anti-leak

- `sessionID` is always validated (`[A-Za-z0-9_-]{1,128}`); path traversal is rejected.
- Tools only operate on the session taken from the execution context — `sessionID` is
  never accepted from arguments.
- There is no tool to read another session.
- Child/fork sessions inherit a snapshot only at creation, then diverge; there is no
  synchronization back.
- Memory content is only summaries and notes; raw tool output is never stored.

## Capture policy

- `always`: prompts carrying decisions, errors, work commands, or file/path references,
  and long prompts.
- `likely`: other prompts that are not chatter.
- `noise`: short greetings/acknowledgements (`hi`, `ok`, `thanks`, …) and very short
  prompts — **not stored**.
- Durable intent is stored; chatter is dropped.

## Tools

| Tool | Purpose |
|---|---|
| `memory_store` | Store a concise note for this session |
| `memory_recall` | Recall this session's memory (optional `query`) |
| `memory_list` | List this session's notes |
| `memory_forget` | Delete a note by `id` |
| `memory_health` | Report this session's consolidation status |

## Schema

- **Schema version:** `4` (schema v4 with legacy facts separation)
- **Build record:** `build.json` stores `build: "0.6.2"` plus the source hash; drift is
  reported via `memory_health`
- **"unverified" label:** the model narrative is labelled
  "Notes (model-generated, unverified):" — never treated as a source of facts

## Facts vs inherited facts

- `summaryFacts`: deterministic facts of this session (files, commands, errors the
  plugin recorded itself)
- `summaryFactsInherited`: fact lines inherited from the parent session, stored **raw**
  in the file (filled when a child/fork is created); the label
  `"Inherited from parent session:"` is added at **injection** time, not stored in the file
- When memory is injected, facts are placed before the model narrative; facts are still
  written even if the narrative fails

## Capture marker split (EN / ID / prefix)

The capture policy uses three marker classes (priority order):

1. **EN word** (`\\bword\\b`) — whole English words, avoiding false positives like
   "shoulders" from "should"
2. **Prefix** (no right boundary `\b`) — e.g. "analyz", "lanjut", "praq", "raq"
3. **ID substring** — Indonesian affixes (di-, me-, ke-, -nya); matched as substrings
   inside words ("disetujui", "perbaiki", …)

Other rules: length > 120 **characters** → `always`; greetings → `noise`; shorter than
15 **characters** → `noise`.

## Input validation (`validateStoreInput`)

- Rejects text that is empty after trimming (`Rejected: text is empty`)
- Rejects text longer than 8192 characters (`Rejected: text too long (max 8 KB)`)
- Rejects if `tags` is not an array
- Rejects more than 16 tags
- Each tag must be a string of at most 64 characters without control characters
  (0x00–0x1F) (`Rejected: invalid tag`)

## Skill path derivation (not hard-coded)

- The path is derived dynamically: `resolveSkillPath()` uses `import.meta.url` and
  `dirname()` to locate `skills/memory-persistent/SKILL.md`
- Nothing is hard-coded as `/home/<user>/...` ⇒ the plugin can be installed anywhere

## Skill

`@memory-persistent` — covers when to store/recall, when to call `memory_health`, and
the prohibition on storing raw tool output or secrets.

## Operational notes

- **Restart the server if a plugin source reload fails.** The local plugin loader
  hot-reloads consistent content-only changes, but a failed evaluation — e.g. importing
  a name the target does not export — is cached and poisons every later reload in the
  same process; the plugin keeps running the previous build until the server restarts,
  and the startup self-check reports a broken source tree (`source-tree-inconsistent`).
- On activation the plugin checks the import graph for consistency. On any mismatch,
  activation is aborted with a `source-tree-inconsistent` log (FATAL) and the plugin is
  not registered. Fix the export/import names and restart the server.
- Consolidation uses **stateless model calls** (default): only the prompt built from the
  delta (facts + conversation + notes + activity) is sent; session history is not
  included. Memory stores deterministic facts plus an optional model narrative; facts
  are written even when the narrative fails.
  Since 0.6.2, if that stateless call fails with a quota/auth error (429, 401, 403,
  "usage limit reached"), the plugin makes **one** fallback call through
  `session.generate` with the same prompt and model. Session history is sent
  **only** on that fallback. The fallback emits a `consolidation fallback` log
  event, and `consolidation ok` carries `fallback: true` when it was used.
- The build record (`build.json`) stores the source hash; drift between activations is
  reported via `memory_health` and the log.

## Accepted limitations

These trade-offs are deliberate; they are documented so reading the source never
surprises you:

- **No `fsync` on memory writes.** Writes are atomic (`tmp` file + rename) but not
  flushed: on a hard power cut the newest write may be lost or left as a stale
  `.tmp.` leftover (cleaned up by the sweep and the permission repair). Accepted:
  this data is a session aid, not a ledger.
- **Locks are per-process.** The session lock serializes writes within one OpenCode
  process only. Two server processes on the same data directory could race; the
  atomic rename and the in-file `sessionID` check keep a corrupt file from being
  persisted, but last-writer-wins is possible. Accepted: in the supported setup a
  single server owns the data directory.
- **`sourceHash` covers `src/*.ts` only.** The build-record hash detects source drift
  in the plugin's own modules, not in skill files or host changes; it is a
  diagnostic, not a guarantee.
- **Log writes are synchronous but not fsync'd.** `plugin.log` is appended
  synchronously per event; a crash may lose the last lines. The log is a
  diagnostic trail, not an audit log. A manual benchmark of the steady-state
  path (`tools/log-bench.ts`, 500–1000 events) measured p95 ≈ 0.05–0.5 ms per
  event — far inside the 5 ms budget that would have forced an async queue —
  so synchronous logging stays.
- **Manual notes are capped at 200 per session (fixed, not configurable).** The oldest
  notes are evicted when the cap is exceeded (also applied when reading legacy files
  that exceed it).
- **Tool payloads are bounded.** `memory_recall` / `memory_list` return previews of
  at most 500 characters per note and a JSON payload capped at 32 KiB, with
  `truncated` and `totalNotes` flags when something was cut.
- **The selfcheck verifies the entry import graph, not types.** It proves every
  named import resolves to a real export; it does not type-check (run `tsc` for
  that) and it does not verify runtime behavior.
- **Consolidation runs in the background.** The `experimental.idle` hook returns
  immediately; consolidation runs as a plugin-scoped fiber, one per session.
  Deleting a session interrupts its consolidation fiber and frees the slot; slow
  model calls are protected from stale recovery while their fiber is alive
  (registration TTL: 30 minutes).

## Storage & privacy

- Memory lives locally under `${XDG_DATA_HOME:-~/.local/share}/opencode/memory-persistent/`:
  - `sessions/<sessionID>.json` — one file per session
  - `plugin.log` — structured `[memory-persistent] ...` lines the server does not
    capture; capped at 64 KiB (newest tail kept); its path is also reported by
    `memory_health` (`logPath`)
- Permissions: `0600` for files, `0700` for directories, repaired automatically on
  activation (`repairPermissions`). Corrupt files are moved aside as
  `.json.corrupt.<timestamp>`.
- Files are **plaintext JSON — there is no encryption at rest**. Rely on your usual
  user/disk security.
- **The only network traffic** is the consolidation model call when the session goes
  idle: it sends the prompt built from the delta (facts, conversation, notes, activity)
  to the model provider OpenCode already uses for your chat. Nothing else is contacted.
- Secrets are redacted **before anything is written to disk** — best-effort heuristics,
  not a guarantee. Covered formats include JSON key/value secrets (`api_key`,
  `secret`, `token`, `password`, …), `Bearer` tokens, `sk-` keys, `npm_`, `ghp_`,
  AWS/Google/Slack/GitLab tokens, JWTs, credentials in known URL schemes,
  `Authorization` headers, and private-key blocks. Activity targets (commands and
  paths) are redacted with the same rules.
- **No telemetry.** Nothing is sent to the plugin author or any analytics service.

## Measure

`tools/measure.ts` is a **read-only** CLI that reports tool effectiveness: it only reads
memory files and prints a JSON report — no numbers are fabricated; the report contains
only what was actually read from the files.

```bash
bun run tools/measure.ts <sessions-dir>
```

Main columns of the report (`MeasureReport`):

| Column | Meaning |
|---|---|
| `totalFiles` | Number of memory files read |
| `schemaVersions` | Distribution of schema versions (per `version` field, falling back to `schema`) |
| `builds` | Distribution of builds that wrote the files |
| `driftCount` | Files last written by a build other than the running one |
| `facts.sessions` | Files containing ≥ 1 fact line |
| `facts.ownLines` | Number of fact lines owned by the session itself |
| `facts.inheritedLines` | Number of fact lines inherited from the parent |
| `facts.genericPct` | Percentage of fact lines of the form `- <kind>: <target>` with a known kind |
| `facts.dupLines` | Extra occurrences of duplicated fact lines |

The report also carries a `pending` group (counts of pending turns and activity), a
`notes` group (own vs inherited note lines), and a `hygiene` group (permission issues,
corrupt backups, stale tmp files).

## Development

```bash
bun install
bun test
bun run check        # bun test && bunx tsc --noEmit
bun run selfcheck    # preflight: import graph + no hardcoded /home/<user>/ paths (exit 1 on mismatch)
bun run fixtures     # regenerate tool-call fixtures (needs the test/ directory — not shipped to npm; source checkouts only)
bun run measure      # read-only effectiveness report
```

## Limitations

- Secret redaction is **best-effort** (heuristics, not a guarantee).
- Parent turn quotes are not inherited in child/fork snapshots (only the summary +
  notes).
- The inherited-fact depth label defaults to `"parent"` (depth 1); for depth > 1 it
  renders `Inherited from N earlier sessions:` — depth is stored per inherited block
  (one number), not per line.
- Inherited chains grow inside the file; capping happens at injection time (token
  budget).
- A deleted session's file can reappear for at most one more sweep if its tombstone was
  evicted from the 256 cap.
- Consolidation retry is scheduled on the **next idle event** after backoff
  (1→2→4→8→10 minutes); there is no standalone timer.

## License

[MIT](LICENSE) © 2026 bakulai33
