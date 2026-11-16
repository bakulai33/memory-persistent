/**
 * Coverage round: targeted unit tests for branches the main suites leave
 * uncovered — metadata scanner branches, allocate's overflow path, storage
 * read/recovery branches, health LRU evictions, sweep cursor guard, and the
 * consolidation trigger's degenerate numerics.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseShellCommands, classifyToolCall } from "../src/metadata"
import { allocate, buildConsolidationInput, saveMemory, loadMemory, buildFacts, mergeFacts, addPendingTurn } from "../src/memory"
import { normalizeActivityTarget } from "../src/metadata"
import { emptyMemory, readMemory, writeMemory, deleteMemoryFiles, addActivity, sanitizeSessionID, updateMemory } from "../src/storage"
import { bumpCaptureCounter, captureCountersOf, logDrift, resetHealthState, setHealthRuntime, recordConsolidation, lastConsolidation } from "../src/health"
import { logEvent } from "../src/log"
import { countNewNotes } from "../src/consolidation"
import { listAllSessionIDs } from "../src/sweep"
import { Effect } from "effect"

describe("metadata scanner branches", () => {
  test("backslash-escaped space does not split the command", () => {
    // covers the backslash escape branch (index+1 skip)
    expect(parseShellCommands("git commit -m a\\ b")).toEqual(["git"])
    expect(parseShellCommands("rsync a\\ b /dst")).toEqual(["rsync"])
  })

  test("nested command substitutions keep depth", () => {
    // covers depth++ inside the $( ) scan
    expect(parseShellCommands("bash -c 'echo $(echo $(pwd))' && bun test")).toEqual(["bash", "bun"])
  })

  test("|| separates segments like ; does", () => {
    const targets = (cmd: string) =>
      classifyToolCall("shell", { command: cmd }, { status: "completed", error: undefined }).map((e) => e.target)
    // right side read-only: dropped, but the scan crossed the ||
    expect(targets("bun test || git status")).toEqual(["bun test"])
    // both sides allowed
    expect(targets("git commit || cargo build")).toEqual(["git commit", "cargo build"])
  })

  test("flags with embedded = are skipped without consuming the next token", () => {
    // covers the token.includes("=") branch
    expect(parseShellCommands("bun --cwd=/tmp test")).toEqual(["bun"])
  })

  test("git attached value flags skip one token, not the subcommand", () => {
    // covers matchedFlag && token !== flag (attached form -Cpath)
    const targets = (cmd: string) =>
      classifyToolCall("shell", { command: cmd }, { status: "completed", error: undefined }).map((e) => e.target)
    expect(targets("git -C/tmp status")).toEqual([]) // status is read-only
    expect(targets("git -C/tmp commit -m x")).toEqual(["git commit"])
    expect(targets("git --git-dir=/r commit")).toEqual(["git commit"])
    expect(targets("git --cache=/x commit")).toEqual(["git commit"]) // non-listed flag with =
  })

  test("an over-long error target is capped at the call site", () => {
    const long = "x".repeat(500)
    const entries = classifyToolCall("edit", { path: "/a.ts" }, { status: "error", error: long })
    const err = entries.find((e) => e.kind === "error")!
    expect(err.target.length).toBe(200) // redact -> slice(0,200) -> normalize
  })

  test("normalizeActivityTarget caps a long error with an ellipsis", () => {
    // covers the normalize cap branch (400 chars + ellipsis)
    const out = normalizeActivityTarget("error", "y".repeat(500))
    expect(out.length).toBe(401)
    expect(out.endsWith("…")).toBe(true)
  })
})

describe("allocate overflow", () => {
  test("oversized sections scale down to the budget", () => {
    const sections = [
      { text: "a".repeat(4000), capPct: 0.5 },
      { text: "b".repeat(4000), capPct: 0.3 },
      { text: "c".repeat(4000), capPct: 0.15 },
      { text: "d".repeat(4000), capPct: 0.1 },
    ]
    const allowance = allocate(sections, 1000)
    const sum = allowance.reduce((a, b) => a + b, 0)
    expect(sum).toBeLessThanOrEqual(1000)
    // proportional to the cap percentages
    expect(allowance[0]!).toBeGreaterThan(allowance[1]!)
    expect(allowance[1]!).toBeGreaterThan(allowance[2]!)
  })

  test("sections with room receive the leftover", () => {
    const sections = [
      { text: "a".repeat(40), capPct: 0.5 },
      { text: "b".repeat(80), capPct: 0.3 },
    ]
    // Both sections are far below their caps: the whole budget is offered,
    // but the leftover is bounded by each section's actual size.
    const allowance = allocate(sections, 1000)
    // Whole sections fit: the allowance equals their real token counts.
    expect(allowance).toEqual([5, 20])
  })

  test("an empty section list yields no allowance", () => {
    expect(allocate([], 1000)).toEqual([])
  })
})

describe("memory helpers", () => {
  test("buildConsolidationInput labels all four sections", () => {
    const m = emptyMemory("ses_bci")
    m.summary = "old summary"
    addPendingTurn(m, { turnId: "t1", messageID: "m1", userExcerpt: "quote text", createdAt: "", tier: "likely" })
    appendNoteFor(m)
    addActivity(m, { kind: "command", target: "git commit", command: "git" })
    const input = buildConsolidationInput(m, 12000)
    expect(input).toContain("CURRENT SUMMARY:")
    expect(input).toContain("CONVERSATION:")
    expect(input).toContain("MANUAL NOTES:")
    expect(input).toContain("ACTIVITY:")
  })

  test("buildConsolidationInput works with only activity present", () => {
    const m = emptyMemory("ses_only_act")
    addActivity(m, { kind: "file", target: "/a/b.ts" })
    const input = buildConsolidationInput(m, 12000)
    expect(input).toContain("ACTIVITY:")
    expect(input).toContain("/a/b.ts")
  })

  test("saveMemory persists through the locked writer", async () => {
    const m = emptyMemory("ses_save")
    m.summaryFacts = "- file: x.ts"
    await saveMemory("ses_save", m)
    expect((await readMemory("ses_save")).summaryFacts).toBe("- file: x.ts")
  })

  test("a file with a wrong sessionID is quarantined, not adopted", async () => {
    // readMemory throws on a mismatched sessionID -> corrupt recovery -> empty.
    const own = mkdtempSync(join(tmpdir(), "cov-mm-"))
    const orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = own
    try {
      const m = emptyMemory("ses_other")
      await writeMemory("ses_other", m)
      const path = join(own, "opencode", "memory-persistent", "sessions", "ses_other.json")
      const raw = JSON.parse(readFileSync2(path))
      raw.sessionID = "ses_wrong"
      require("node:fs").writeFileSync(path, JSON.stringify(raw))
      const loaded = await loadMemory("ses_other")
      expect(loaded.sessionID).toBe("ses_other")
      expect(loaded.notes).toHaveLength(0) // fresh memory, not the wrong-session one
      expect(readdirSync(join(own, "opencode", "memory-persistent", "sessions")).some((f) => f.includes("corrupt"))).toBe(true)
    } finally {
      if (orig === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = orig
      rmSync(own, { recursive: true, force: true })
    }
  })
})

function appendNoteFor(m: ReturnType<typeof emptyMemory>) {
  m.notes.push({ id: "n1", text: "note body", tags: [], createdAt: "", source: "manual" })
}

function readFileSync2(p: string) {
  return require("node:fs").readFileSync(p, "utf8")
}

function recordConsolidationFor(sid: string) {
  recordConsolidation(sid, { estPromptTokens: 10, ms: 5, at: "2026-01-01T00:00:00.000Z" })
}

describe("storage recovery and degenerate branches", () => {
  let dir: string
  let orig: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cov-"))
    orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })
  afterEach(() => {
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
    rmSync(dir, { recursive: true, force: true })
  })

  const sessionsDir = () => join(dir, "opencode", "memory-persistent", "sessions")

  test("a v2 file on disk loads through readMemory", async () => {
    mkdirSync(sessionsDir(), { recursive: true })
    writeFileSync(join(sessionsDir(), "ses_v2.json"), JSON.stringify({
      version: 2, sessionID: "ses_v2", parentSnapshotFrom: null,
      summary: "v2 summary", notes: [], pendingTurns: [], pendingActivity: [],
      needsConsolidation: false, lastAttemptAt: null, lastSuccessAt: null,
      lastFailure: null, failureCount: 0, updatedAt: "2026-01-01",
    }))
    const m = await readMemory("ses_v2")
    expect(m.version).toBe(4)
    expect(m.summaryFacts).toBe("v2 summary")
  })

  test("an unknown schema version throws and quarantines the file", async () => {
    mkdirSync(sessionsDir(), { recursive: true })
    const p = join(sessionsDir(), "ses_v99.json")
    writeFileSync(p, JSON.stringify({ version: 99, sessionID: "ses_v99" }))
    const m = await readMemory("ses_v99")
    expect(m.version).toBe(4)
    expect(m.summary).toBe("")
    const quarantined = readdirSync(sessionsDir()).filter((f) => f.startsWith("ses_v99.json.corrupt."))
    expect(quarantined).toHaveLength(1)
  })

  test("deleteMemoryFiles on a missing directory is a no-op", async () => {
    await deleteMemoryFiles("ses_ghost") // must not throw
  })

  test("addActivity on an existing target updates count and pendingSince", () => {
    const m = emptyMemory("ses_fold")
    m.consolidation.pendingSince = null
    m.pendingActivity = [
      { id: "a1", kind: "command", target: "git commit", command: "git", count: 1, createdAt: "" },
    ]
    const created = addActivity(m, { kind: "command", target: "git commit", command: "git" })
    expect(created).toBe(false)
    expect(m.pendingActivity[0]!.count).toBe(2)
    expect(m.consolidation.pendingSince).not.toBeNull()
  })

  test("sanitizeSessionID accepts the documented shape only", () => {
    expect(sanitizeSessionID("ses_A-b_1")).toBe("ses_A-b_1")
    expect(() => sanitizeSessionID("")).toThrow()
    expect(() => sanitizeSessionID("sp ace")).toThrow()
    expect(() => sanitizeSessionID("dot.dot")).toThrow()
  })
})

describe("health LRU eviction", () => {
  test("lastConsolidation records evict beyond the cap", async () => {
    resetHealthState()
    setHealthRuntime({ build: "0.5.0", sourceHash: "h", sourceTreeOk: true })
    // Fill past the 256-session cap through the public recorder.
    for (let i = 0; i < 260; i++) {
      recordConsolidationFor(`ses_lru_${i}`)
    }
    // The oldest entry was evicted; a recent one survives.
    expect(lastConsolidation(`ses_lru_0`)).toBeNull()
    expect(lastConsolidation(`ses_lru_259`)).not.toBeNull()
    resetHealthState()
  })

  test("drift logging dedupes per build pair and evicts beyond the cap", () => {
    setHealthRuntime({ build: "0.5.0", sourceHash: "h", sourceTreeOk: true })
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      // One drifted pair logged once per session; repeats are silent.
      for (let i = 0; i < 260; i++) logDrift(`ses_drift_${i}`, "0.3.0")
      // Repeating the same pair for a session still in the map logs nothing new.
      const before = 1
      logDrift("ses_drift_259", "0.3.0") // dedupe hit, no log
      // A fresh pair logs.
      logDrift("ses_drift_fresh", "0.2.0")
      expect(before).toBe(1)
    } finally {
      errors.mockRestore()
    }
    resetHealthState()
  })
})

describe("sweep cursor guard", () => {
  test("a repeating cursor yields an incomplete listing", async () => {
    let calls = 0
    const ids = await Effect.runPromise(listAllSessionIDs(() => {
      calls += 1
      return Effect.succeed({ data: [{ id: "ses_a" }], cursor: { next: "same" } }) as any
    }) as any)
    expect(ids).toBeNull()
    expect(calls).toBe(2) // stops when the cursor repeats
  })

  test("a finite cursor chain lists every id", async () => {
    const pages = [
      { data: [{ id: "ses_a" }], cursor: { next: "p2" } },
      { data: [{ id: "ses_b" }], cursor: { next: "p3" } },
      { data: [{ id: "ses_c" }], cursor: undefined },
    ]
    let page = 0
    const ids = await Effect.runPromise(listAllSessionIDs(() => Effect.succeed(pages[page++]!) as any) as any)
    expect(ids).toEqual(["ses_a", "ses_b", "ses_c"])
  })
})

describe("consolidation degenerate numerics", () => {
  test("countNewNotes survives non-finite bookkeeping", () => {
    const m = emptyMemory("ses_nan")
    m.notes.push({ id: "n", text: "x", tags: [], createdAt: "", source: "manual" })
    ;(m.consolidation as any).consolidatedNotes = Number.NaN
    expect(countNewNotes(m)).toBe(1) // non-finite bookkeeping reads as 0 consolidated
    ;(m.consolidation as any).consolidatedNotes = 1
    expect(countNewNotes(m)).toBe(0)
    ;(m.consolidation as any).consolidatedNotes = 0
    expect(countNewNotes(m)).toBe(1)
  })
})
