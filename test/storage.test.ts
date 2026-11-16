import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  sanitizeSessionID,
  emptyMemory,
  readMemory,
  writeMemory,
  deleteMemoryFiles,
  listMemoryFiles,
  markDeleted,
  isDeleted,
  memoryPath,
  capPendingTurns,
  addActivity,
} from "../src/storage"
import { appendNote, copyMemory } from "../src/memory"
import { canConsolidate, emptyConsolidation } from "../src/consolidation"

describe("storage", () => {
  let dir: string
  let orig: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-"))
    orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })

  afterEach(() => {
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
    rmSync(dir, { recursive: true, force: true })
  })

  test("sanitizeSessionID accepts valid", () => {
    expect(sanitizeSessionID("ses_abc-123")).toBe("ses_abc-123")
  })

  test("sanitizeSessionID rejects traversal", () => {
    expect(() => sanitizeSessionID("../etc")).toThrow()
    expect(() => sanitizeSessionID("a/b")).toThrow()
  })

  test("read missing returns empty", async () => {
    const m = await readMemory("ses_1")
    expect(m.sessionID).toBe("ses_1")
    expect(m.summary).toBe("")
    expect(m.notes.length).toBe(0)
  })

  test("write then read roundtrip", async () => {
    const m = emptyMemory("ses_2")
    m.summary = "hello"
    await writeMemory("ses_2", m)
    const r = await readMemory("ses_2")
    expect(r.summary).toBe("hello")
  })

  test("capPendingTurns keeps last 20", () => {
    const turns = Array.from({ length: 25 }, (_, i) => ({
      turnId: String(i),
      messageID: String(i),
      userExcerpt: `t${i}`,
      createdAt: new Date().toISOString(),
    }))
    const capped = capPendingTurns(turns, 20)
    expect(capped.length).toBe(20)
    expect(capped[0].userExcerpt).toBe("t5")
  })

  test("deleteMemoryFiles removes the memory file and its corrupt backups", async () => {
    await writeMemory("ses_del", emptyMemory("ses_del"))
    const { writeFile } = await import("node:fs/promises")
    await writeFile(join(dir, "opencode", "memory-persistent", "sessions", "ses_del.json.corrupt.111"), "junk")
    await writeFile(join(dir, "opencode", "memory-persistent", "sessions", "ses_del.json.corrupt.222"), "junk")

    await deleteMemoryFiles("ses_del")

    const entries = await listMemoryFiles()
    expect(entries.filter((e) => e.id === "ses_del").length).toBe(0)
  })

  test("deleteMemoryFiles is idempotent", async () => {
    await writeMemory("ses_del2", emptyMemory("ses_del2"))
    await deleteMemoryFiles("ses_del2")
    await deleteMemoryFiles("ses_del2")
    const entries = await listMemoryFiles()
    expect(entries.filter((e) => e.id === "ses_del2").length).toBe(0)
  })

  test("deleteMemoryFiles rejects an invalid session id", async () => {
    await expect(deleteMemoryFiles("../escape")).rejects.toThrow()
  })

  test("listMemoryFiles reports memory and corrupt entries", async () => {
    await writeMemory("ses_live", emptyMemory("ses_live"))
    const { writeFile } = await import("node:fs/promises")
    await writeFile(join(dir, "opencode", "memory-persistent", "sessions", "ses_bad.json.corrupt.999"), "junk")

    const entries = await listMemoryFiles()
    expect(entries).toContainEqual({ id: "ses_live", kind: "memory", file: "ses_live.json" })
    expect(entries).toContainEqual({ id: "ses_bad", kind: "corrupt", file: "ses_bad.json.corrupt.999" })
  })

  test("writeMemory does not recreate a deleted session", async () => {
    markDeleted("ses_gone")
    await writeMemory("ses_gone", emptyMemory("ses_gone"))
    const entries = await listMemoryFiles()
    expect(entries.filter((e) => e.id === "ses_gone").length).toBe(0)
  })

  test("the deleted guard is bounded to 256 ids", () => {
    for (let i = 0; i < 300; i++) markDeleted(`ses_b${i}`)
    expect(isDeleted("ses_b299")).toBe(true)
    expect(isDeleted("ses_b0")).toBe(false)
  })

  test("tombstone eviction is logged per evicted id", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      // Distinct fresh ids: whatever P entries earlier tests left in the
      // module-level tombstone map, P+257 > 256 evicts exactly P+1 ids FIFO,
      // so the FIRST fresh id is always among the evicted.
      const first = `ses_ev_${randomUUID().replace(/-/g, "")}`
      markDeleted(first)
      const ids = [first]
      for (let i = 1; i < 257; i++) {
        const id = `ses_ev_${randomUUID().replace(/-/g, "")}_${i}`
        ids.push(id)
        markDeleted(id)
      }
      const last = ids[ids.length - 1]!

      expect(isDeleted(first)).toBe(false)
      const evictLines = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("tombstone-evict"))
      expect(evictLines.some((l) => l.includes(`sid=${first}`))).toBe(true)
      expect(isDeleted(last)).toBe(true)
    } finally {
      errors.mockRestore()
    }
  })

  test("writing to a deleted session is a logged no-op", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      markDeleted("ses_gone2")
      await writeMemory("ses_gone2", emptyMemory("ses_gone2"))
      expect(existsSync(memoryPath("ses_gone2"))).toBe(false)
      const lines = errors.mock.calls.map((c) => String(c[0]))
      expect(lines.some((l) => l.includes("write-skipped-deleted") && l.includes("sid=ses_gone2"))).toBe(true)
    } finally {
      errors.mockRestore()
    }
  })

  test("copyMemory snapshots the parent into the child", async () => {
    const parent = emptyMemory("ses_p")
    appendNote(parent, "parent note")
    await writeMemory("ses_p", parent)

    await copyMemory("ses_p", "ses_c")

    const child = await readMemory("ses_c")
    expect(child.parentSnapshotFrom).toBe("ses_p")
    expect(child.notesInherited!.length).toBe(1)
    expect(child.notesInherited![0].text).toBe("parent note")
    expect(child.notes.length).toBe(0)
  })

  test("salinMemoriMenyisahkanFactsWarisan", async () => {
    const parent = emptyMemory("ses_parent")
    parent.summaryFacts = "- command: bun test (17x)"
    await writeMemory("ses_parent", parent)

    await copyMemory("ses_parent", "ses_child")
    const child = await readMemory("ses_child")

    expect(child.summaryFactsInherited).toContain("bun test")
    expect(child.summaryFacts).toBe("")
    expect(child.parentSnapshotFrom).toBe("ses_parent")
  })

  test("addActivity folds repeats and reports new entries", () => {
    const memory = emptyMemory("ses_a")
    expect(addActivity(memory, { kind: "command", target: "bun" })).toBe(true)
    expect(addActivity(memory, { kind: "command", target: "bun" })).toBe(false)
    expect(memory.pendingActivity.length).toBe(1)
    expect(memory.pendingActivity[0]?.count).toBe(2)
    expect(memory.needsConsolidation).toBe(true)
  })

  test("addActivity keeps different targets apart", () => {
    const memory = emptyMemory("ses_a")
    addActivity(memory, { kind: "command", target: "bun" })
    addActivity(memory, { kind: "command", target: "git" })
    addActivity(memory, { kind: "file", target: "bun" })
    expect(memory.pendingActivity.length).toBe(3)
  })

  test("addActivity caps the activity list at 40 entries", () => {
    const memory = emptyMemory("ses_a")
    for (let i = 0; i < 50; i++) addActivity(memory, { kind: "file", target: `/f${i}.ts` })
    expect(memory.pendingActivity.length).toBe(40)
    expect(memory.pendingActivity[0]?.target).toBe("/f10.ts")
  })

  test("a new memory file carries the v4 shape", () => {
    const memory = emptyMemory("ses_new")
    expect(memory.version).toBe(4)
    expect(memory.build).toBe("0.5.0")
    expect(memory.summaryFacts).toBe("")
    expect(memory.summaryNarrative).toBe("")
    expect(memory.pendingActivity).toEqual([])
    expect(memory.consolidation.state).toBe("idle")
  })

  test("readMemory recovers a stale running attempt in memory only", async () => {
    const staleStarted = new Date(Date.now() - 6 * 60_000).toISOString()
    const stale = {
      version: 4,
      sessionID: "ses_stale",
      parentSnapshotFrom: null,
      build: "0.4.0",
      summary: "",
      summaryFacts: "",
      summaryNarrative: "",
      notes: [],
      pendingTurns: [],
      pendingActivity: [],
      needsConsolidation: true,
      consolidation: {
        state: "running",
        attemptId: "attempt-stale",
        startedAt: staleStarted,
        finishedAt: null,
        error: null,
        consecutiveFailures: 0,
        deferrals: 0,
        deferredSince: null,
        lastAttemptAt: staleStarted,
        consolidatedNotes: 0,
      },
      updatedAt: new Date().toISOString(),
    }
    await writeMemory("ses_stale", stale as any)
    const first = await readMemory("ses_stale")
    expect(first.consolidation.state).toBe("failed")
    expect(first.consolidation.consecutiveFailures).toBe(1)
    expect(canConsolidate(first)).toBe(true)

    const second = await readMemory("ses_stale")
    expect(second.consolidation.state).toBe("failed")
    expect(second.consolidation.consecutiveFailures).toBe(1)

    await writeMemory("ses_stale", first)
    const third = await readMemory("ses_stale")
    expect(third.consolidation.state).toBe("failed")
    expect(third.consolidation.consecutiveFailures).toBe(1)
  })

  test("partial consolidation normalizes to a full object", async () => {
    const partial = {
      version: 4,
      sessionID: "ses_partial",
      parentSnapshotFrom: null,
      build: "0.4.0",
      summary: "",
      summaryFacts: "",
      summaryNarrative: "",
      notes: [],
      pendingTurns: [],
      pendingActivity: [],
      needsConsolidation: true,
      consolidation: { state: "running", startedAt: new Date(Date.now() - 6 * 60_000).toISOString() },
      updatedAt: new Date().toISOString(),
    }
    await writeMemory("ses_partial", partial as any)
    const m = await readMemory("ses_partial")
    expect(m.consolidation.state).toBe("failed")
    expect(m.consolidation.consecutiveFailures).toBe(1)
    expect(m.consolidation.attemptId).toBeNull()
    expect(m.consolidation.deferrals).toBe(0)
    expect(m.consolidation.consolidatedNotes).toBe(0)
    expect(Number.isFinite(m.consolidation.consecutiveFailures)).toBe(true)
    expect(canConsolidate(m)).toBe(true)
  })

  test("non-boolean needsConsolidation is normalized to false", async () => {
    for (const value of [1, "true"]) {
      const file = {
        version: 4,
        sessionID: `ses_nc_${String(value)}`,
        parentSnapshotFrom: null,
        build: "0.4.0",
        summary: "",
        summaryFacts: "",
        summaryNarrative: "",
        notes: [],
        pendingTurns: [],
        pendingActivity: [],
        needsConsolidation: value,
        consolidation: emptyConsolidation(),
        updatedAt: new Date().toISOString(),
      }
      await writeMemory(`ses_nc_${String(value)}`, file as any)
      const m = await readMemory(`ses_nc_${String(value)}`)
      expect(m.needsConsolidation).toBe(false)
    }
  })

  test("running attempt without startedAt is recovered", async () => {
    const lastAttemptAt = new Date(Date.now() - 6 * 60_000).toISOString()
    const file = {
      version: 4,
      sessionID: "ses_nostart",
      parentSnapshotFrom: null,
      build: "0.4.0",
      summary: "",
      summaryFacts: "",
      summaryNarrative: "",
      notes: [],
      pendingTurns: [],
      pendingActivity: [],
      needsConsolidation: true,
      consolidation: {
        state: "running",
        attemptId: "attempt-nostart",
        startedAt: null,
        finishedAt: null,
        error: null,
        consecutiveFailures: 0,
        deferrals: 0,
        deferredSince: null,
        lastAttemptAt,
        consolidatedNotes: 0,
      },
      updatedAt: new Date().toISOString(),
    }
    await writeMemory("ses_nostart", file as any)
    const m = await readMemory("ses_nostart")
    expect(m.consolidation.state).toBe("failed")
    expect(m.consolidation.consecutiveFailures).toBe(1)
    expect(canConsolidate(m)).toBe(true)
  })
})

describe("activity command inference", () => {
  let dir: string
  let orig: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-"))
    orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })

  afterEach(() => {
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
    rmSync(dir, { recursive: true, force: true })
  })

  test("addActivity infers the binary from the target when command is absent", () => {
    const memory = emptyMemory("ses_inf")
    addActivity(memory, { kind: "command", target: "git commit" } as any)
    expect(memory.pendingActivity[0]?.command).toBe("git")
  })

  test("addActivity infers the binary for a target containing quotes", () => {
    const memory = emptyMemory("ses_infq")
    addActivity(memory, { kind: "command", target: 'git commit -m "msg"' } as any)
    expect(memory.pendingActivity[0]?.command).toBe("git")
  })

  test("readMemory normalizes a missing command from the target", async () => {
    await writeMemory("ses_norm", emptyMemory("ses_norm"))
    // write a raw v3 file with command omitted
    const { writeFile, mkdir } = await import("node:fs/promises")
    const path = join(dir, "opencode", "memory-persistent", "sessions", "ses_norm.json")
    const raw = {
      version: 4,
      sessionID: "ses_norm",
      parentSnapshotFrom: null,
      build: "0.4.0",
      summary: "",
      summaryFacts: "",
      summaryNarrative: "",
      notes: [],
      pendingTurns: [],
      pendingActivity: [
        { id: "a1", kind: "command", target: "git commit", count: 1, createdAt: new Date().toISOString() },
      ],
      needsConsolidation: false,
      consolidation: { state: "idle", attemptId: null, startedAt: null, finishedAt: null, error: null, consecutiveFailures: 0, deferrals: 0, deferredSince: null, lastAttemptAt: null, consolidatedNotes: 0 },
      updatedAt: new Date().toISOString(),
    }
    await writeFile(path, JSON.stringify(raw), { encoding: "utf8" })
    const m = await readMemory("ses_norm")
    expect(m.pendingActivity[0]?.command).toBe("git")
  })

  test("readMemory normalizes a missing command for a target containing quotes", async () => {
    const { writeFile } = await import("node:fs/promises")
    const path = join(dir, "opencode", "memory-persistent", "sessions", "ses_normq.json")
    const raw = {
      version: 4,
      sessionID: "ses_normq",
      parentSnapshotFrom: null,
      build: "0.4.0",
      summary: "",
      summaryFacts: "",
      summaryNarrative: "",
      notes: [],
      pendingTurns: [],
      pendingActivity: [
        { id: "a1", kind: "command", target: 'git commit -m "msg"', count: 1, createdAt: new Date().toISOString() },
      ],
      needsConsolidation: false,
      consolidation: { state: "idle", attemptId: null, startedAt: null, finishedAt: null, error: null, consecutiveFailures: 0, deferrals: 0, deferredSince: null, lastAttemptAt: null, consolidatedNotes: 0 },
      updatedAt: new Date().toISOString(),
    }
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(dir, "opencode", "memory-persistent", "sessions"), { recursive: true })
    await writeFile(path, JSON.stringify(raw), { encoding: "utf8" })
    const m = await readMemory("ses_normq")
    expect(m.pendingActivity[0]?.command).toBe("git")
  })
})
