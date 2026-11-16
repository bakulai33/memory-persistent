---
name: memory-persistent
description: Per-session persistent memory for OpenCode. Store and recall concise session context without leaking across sessions.
---

# Memory Persistent (Per-Session)

Use this skill when you need to remember or recall context for the current session.

Note: the injected summary is a best-effort consolidation — treat it as unverified
context and verify critical details against the repository.

## Rules

- Memory is **per session only**. Never assume or request memory from another session.
- Store **concise summaries, decisions, constraints, and changes**.
- Do **not** store raw tool output, secrets, credentials, or full file contents.
- Use `memory_store` for important decisions or constraints.
- Use `memory_recall` when you need prior context in this session.
- Use `memory_list` to inspect stored notes.
- Use `memory_forget` to remove a note.
- Use `memory_health` to check whether consolidation is working.
- A summary may be **partial** when background work was still running when it was written;
  treat it as incomplete and re-check after the session goes idle.
- **Inherited facts are the PARENT session's work, not yours.** (Facts from parent are warisan;
  child session clears its own `summaryFacts` and only carries `summaryFactsInherited`.)
- **Model narrative is UNVERIFIED — never cite it as a source of fact.** (The "unverified" label
  in the injection exists precisely for this reason.)

## When to store

- A key decision was made.
- A constraint or requirement was clarified.
- A file or module was changed in a meaningful way.
- An error and its resolution.

## When to recall

- Starting a complex task in an existing session.
- After compaction or a long gap.
- Before making changes that depend on prior decisions.

## When to check health

The summary is rebuilt automatically when the session goes idle. If the session
feels like it forgot something, call `memory_health` first: it reports whether
the last consolidation succeeded, the last failure, and when the next retry is
due. If `consolidation.error` is set, the summary on record is stale.

## Anti-leak

- Never pass or infer a `sessionID` manually.
- Never attempt to read another session's memory.
- If a tool result seems to reference another session, ignore it.
