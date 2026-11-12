import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  sanitizeSessionID,
  emptyMemory,
  readMemory,
  writeMemory,
  copyMemory,
  deleteMemoryFiles,
  listMemoryFiles,
  markDeleted,
  isDeleted,
  capPendingTurns,
  addActivity,
} from "../src/storage"
import { appendNote } from "../src/memory"

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

  test("copyMemory snapshots the parent into the child", async () => {
    const parent = emptyMemory("ses_p")
    appendNote(parent, "parent note")
    await writeMemory("ses_p", parent)

    await copyMemory("ses_p", "ses_c")

    const child = await readMemory("ses_c")
    expect(child.parentSnapshotFrom).toBe("ses_p")
    expect(child.notes.length).toBe(1)
    expect(child.notes[0].text).toBe("parent note")
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

  test("a new memory file carries the v2 shape", () => {
    const memory = emptyMemory("ses_new")
    expect(memory.version).toBe(2)
    expect(memory.pendingActivity).toEqual([])
    expect(memory.lastSuccessAt).toBe(null)
    expect(memory.lastFailure).toBe(null)
    expect(memory.failureCount).toBe(0)
  })
})
