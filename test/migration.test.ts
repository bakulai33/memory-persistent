import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateV1, migrateV2, readMemory, memoryDir, type MemoryFileV1, type MemoryFileV2 } from "../src/storage"
import { canConsolidate } from "../src/consolidation"

const v1 = (overrides: Partial<MemoryFileV1> = {}): MemoryFileV1 => ({
  version: 1,
  sessionID: "ses_v1",
  parentSnapshotFrom: null,
  summary: "old summary",
  notes: [],
  pendingTurns: [],
  needsConsolidation: false,
  lastAttemptAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
})

describe("migrateV1", () => {
  test("keeps every conversation turn", () => {
    const migrated = migrateV1(
      v1({
        pendingTurns: [
          { turnId: "t1", messageID: "m1", userExcerpt: "please fix the bug", touchedFiles: [], errors: [], createdAt: "" },
          { turnId: "t2", messageID: "m2", userExcerpt: "and add tests", touchedFiles: [], errors: [], createdAt: "" },
        ],
      }),
    )
    expect(migrated.pendingTurns.length).toBe(2)
    expect(migrated.pendingTurns[0]?.userExcerpt).toBe("please fix the bug")
  })

  test("turns a file tool entry into file activity", () => {
    const migrated = migrateV1(
      v1({
        pendingTurns: [
          { turnId: "t1", messageID: "m1", userExcerpt: "edit: /repo/src/index.ts", touchedFiles: [], errors: [], createdAt: "" },
        ],
      }),
    )
    expect(migrated.pendingTurns.length).toBe(0)
    expect(migrated.pendingActivity).toEqual([
      { id: expect.any(String), kind: "file", target: "/repo/src/index.ts", command: null, count: 1, turnID: undefined, createdAt: expect.any(String) },
    ])
  })

  test("turns an allowed shell command into command activity", () => {
    const migrated = migrateV1(
      v1({
        pendingTurns: [
          { turnId: "t1", messageID: "m1", userExcerpt: "shell: bun", touchedFiles: [], errors: [], createdAt: "" },
        ],
      }),
    )
    expect(migrated.pendingActivity[0]?.kind).toBe("command")
    expect(migrated.pendingActivity[0]?.target).toBe("bun")
  })

  test("drops trivial shell entries", () => {
    const migrated = migrateV1(
      v1({
        pendingTurns: [
          { turnId: "t1", messageID: "m1", userExcerpt: "shell: cd", touchedFiles: [], errors: [], createdAt: "" },
          { turnId: "t2", messageID: "m2", userExcerpt: "shell: grep", touchedFiles: [], errors: [], createdAt: "" },
        ],
      }),
    )
    expect(migrated.pendingActivity.length).toBe(0)
  })

  test("does not read a shell entry as a file path", () => {
    const migrated = migrateV1(
      v1({
        pendingTurns: [
          { turnId: "t1", messageID: "m1", userExcerpt: "shell: cd", touchedFiles: ["shell: cd"], errors: [], createdAt: "" },
        ],
      }),
    )
    expect(migrated.pendingActivity.length).toBe(0)
    expect(migrated.pendingActivity.some((a) => a.target === "cd")).toBe(false)
  })

  test("preserves the summary, notes and flags", () => {
    const migrated = migrateV1(
      v1({
        summary: "kept summary",
        notes: [{ id: "n1", text: "kept note", tags: ["t"], createdAt: "", source: "manual" }],
        needsConsolidation: true,
      }),
    )
    expect(migrated.summary).toBe("kept summary")
    expect(migrated.notes.length).toBe(1)
    expect(migrated.needsConsolidation).toBe(true)
    expect(migrated.version).toBe(4)
  })

  test("gives the migrated file the consolidation state", () => {
    const migrated = migrateV1(v1())
    expect(migrated.consolidation.lastAttemptAt).toBe(null)
    expect(migrated.consolidation.error).toBe(null)
    expect(migrated.consolidation.consecutiveFailures).toBe(0)
    expect(migrated.consolidation.state).toBe("idle")
  })
})

describe("readMemory migration", () => {
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

  test("migrateV2 keeps old summary in summaryFacts", () => {
    const v2: MemoryFileV2 = {
      version: 2,
      sessionID: "ses_v2",
      parentSnapshotFrom: null,
      summary: "old summary",
      notes: [],
      pendingTurns: [],
      pendingActivity: [],
      needsConsolidation: false,
      lastAttemptAt: "2026-01-01T00:00:00.000Z",
      lastSuccessAt: null,
      lastFailure: "boom",
      failureCount: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    const migrated = migrateV2(v2)
    expect(migrated.version).toBe(4)
    expect(migrated.summaryFacts).toBe("old summary")
    expect(migrated.build).toBe("0.3.0")
    expect(migrated.consolidation.lastAttemptAt).toBe("2026-01-01T00:00:00.000Z")
    expect(migrated.consolidation.error).toBe("boom")
    expect(migrated.consolidation.consecutiveFailures).toBe(2)
    expect(migrated.consolidation.state).toBe("failed")
  })

  test("migrasiV3KeV4MemisahkanFacts", async () => {
    mkdirSync(memoryDir(), { recursive: true })
    const v3 = {
      version: 3,
      sessionID: "ses_v3m",
      parentSnapshotFrom: null,
      build: "0.4.0",
      summary: "old summary",
      summaryFacts: "- command: bun test (17x)",
      summaryNarrative: "narr",
      notes: [],
      pendingTurns: [],
      pendingActivity: [],
      needsConsolidation: false,
      consolidation: { state: "idle", attemptId: null, startedAt: null, finishedAt: null, error: null, consecutiveFailures: 0, deferrals: 0, deferredSince: null, lastAttemptAt: null, consolidatedNotes: 0 },
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    writeFileSync(join(memoryDir(), "ses_v3m.json"), JSON.stringify(v3))
    const v4 = await readMemory("ses_v3m")
    expect(v4.summaryFacts).toBe(v3.summaryFacts)
    expect(v4.summaryFactsInherited).toBe("")
    expect(v4.captureCounters).toEqual({ always: 0, likely: 0, noiseSkipped: 0 })
  })

  test("reads a v1 file and returns it as v3", async () => {
    mkdirSync(memoryDir(), { recursive: true })
    writeFileSync(
      join(memoryDir(), "ses_old.json"),
      JSON.stringify(
        v1({
          sessionID: "ses_old",
          pendingTurns: [
            { turnId: "t1", messageID: "m1", userExcerpt: "a real question", touchedFiles: [], errors: [], createdAt: "" },
          ],
        }),
      ),
    )
    const memory = await readMemory("ses_old")
    expect(memory.version).toBe(4)
    expect(memory.pendingTurns.length).toBe(1)
    expect(memory.pendingTurns[0]?.userExcerpt).toBe("a real question")
  })
})

describe("migration needsConsolidation coercion", () => {
  test("v2 non-boolean needsConsolidation becomes boolean", () => {
    for (const value of [1, "true"]) {
      const v2: MemoryFileV2 = {
        version: 2,
        sessionID: "ses_v2",
        parentSnapshotFrom: null,
        summary: "",
        notes: [],
        pendingTurns: [],
        pendingActivity: [],
        needsConsolidation: value as any,
        lastAttemptAt: new Date(Date.now() - 6 * 60_000).toISOString(),
        lastSuccessAt: null,
        lastFailure: null,
        failureCount: 0,
        updatedAt: new Date().toISOString(),
      }
      const migrated = migrateV2(v2)
      expect(typeof migrated.needsConsolidation).toBe("boolean")
      expect(migrated.needsConsolidation).toBe(false)
    }
  })

  test("v1 non-boolean needsConsolidation becomes boolean", () => {
    for (const value of [1, "true"]) {
      const migrated = migrateV1(v1({ needsConsolidation: value as any }))
      expect(typeof migrated.needsConsolidation).toBe("boolean")
      expect(migrated.needsConsolidation).toBe(false)
    }
  })

  test("migrated file is not permanently blocked", () => {
    const v2: MemoryFileV2 = {
      version: 2,
      sessionID: "ses_v2b",
      parentSnapshotFrom: null,
      summary: "",
      notes: [],
      pendingTurns: [],
      pendingActivity: [],
      needsConsolidation: 1 as any,
      lastAttemptAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      lastSuccessAt: null,
      lastFailure: null,
      failureCount: 0,
      updatedAt: new Date().toISOString(),
    }
    const migrated = migrateV2(v2)
    migrated.needsConsolidation = true
    expect(canConsolidate(migrated)).toBe(true)
  })
})
