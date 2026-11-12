import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyMemory, writeMemory, readMemory } from "../src/storage"
import { appendNote } from "../src/memory"
import { copyMemory } from "../src/storage"

describe("child snapshot", () => {
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

  test("copyMemory snapshots the parent then diverges", async () => {
    const parent = emptyMemory("parent")
    appendNote(parent, "parent note")
    await writeMemory("parent", parent)

    await copyMemory("parent", "child")

    const child = await readMemory("child")
    expect(child.parentSnapshotFrom).toBe("parent")
    expect(child.notes.length).toBe(1)
    expect(child.notes[0].text).toBe("parent note")

    // diverge
    appendNote(child, "child note")
    await writeMemory("child", child)

    const parentAfter = await readMemory("parent")
    expect(parentAfter.notes.length).toBe(1) // no backflow
    const childAfter = await readMemory("child")
    expect(childAfter.notes.length).toBe(2)
  })
})
