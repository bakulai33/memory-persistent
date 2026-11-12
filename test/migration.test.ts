import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateV1, readMemory, memoryDir, type MemoryFileV1 } from "../src/storage"

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
      { id: expect.any(String), kind: "file", target: "/repo/src/index.ts", count: 1, turnID: undefined, createdAt: expect.any(String) },
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
    expect(migrated.version).toBe(2)
  })

  test("gives the migrated file the retry fields", () => {
    const migrated = migrateV1(v1())
    expect(migrated.lastSuccessAt).toBe(null)
    expect(migrated.lastFailure).toBe(null)
    expect(migrated.failureCount).toBe(0)
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

  test("reads a v1 file and returns it as v2", async () => {
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
    expect(memory.version).toBe(2)
    expect(memory.pendingTurns.length).toBe(1)
    expect(memory.pendingTurns[0]?.userExcerpt).toBe("a real question")
  })
})
