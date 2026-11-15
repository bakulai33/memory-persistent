import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyMemory, writeMemory, readMemory, addActivity } from "../src/storage"
import { appendNote, addPendingTurn } from "../src/memory"
import { copyMemory } from "../src/memory"
import { emptyConsolidation } from "../src/consolidation"

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
    expect(child.notesInherited!.length).toBe(1)
    expect(child.notesInherited![0].text).toBe("parent note")

    // diverge
    appendNote(child, "child note")
    await writeMemory("child", child)

    const parentAfter = await readMemory("parent")
    expect(parentAfter.notes.length).toBe(1) // no backflow
    const childAfter = await readMemory("child")
    expect(childAfter.notes.length).toBe(1) // note anak sendiri
    expect(childAfter.notesInherited!.length).toBe(1) // warisan tetap terpisah
  })

  test("copyMemory builds a labeled idle child snapshot", async () => {
    const parent = emptyMemory("snap_p")
    parent.summaryFacts = "- file: src/a.ts"
    addPendingTurn(parent, { turnId: "t1", messageID: "m1", userExcerpt: "parent quote", createdAt: new Date().toISOString() })
    addActivity(parent, { kind: "file", target: "src/b.ts" })
    appendNote(parent, "parent note")
    await writeMemory("snap_p", parent)

    await copyMemory("snap_p", "snap_c")

    const child = await readMemory("snap_c")
    expect(child.version).toBe(4)
    expect(child.parentSnapshotFrom).toBe("snap_p")
    expect(child.inheritedDepth).toBe(1)
    // facts parent menjadi warisan; claim pekerjaan anak mulai kosong
    expect(child.summaryFacts).toBe("")
    expect(child.summaryFactsInherited).toContain("src/a.ts")
    expect(child.summaryFactsInherited).toContain("src/b.ts")
    // note parent menjadi warisan, bukan claim anak
    expect(child.notes.length).toBe(0)
    expect(child.notesInherited!.map((n) => n.text)).toEqual(["parent note"])
    // kutipan turn parent TIDAK diwarisi (keputusan final)
    expect(child.pendingTurns).toEqual([])
    // anak lahir tanpa pending & konsolidasi
    expect(child.pendingActivity).toEqual([])
    expect(child.needsConsolidation).toBe(false)
    expect(child.consolidation.state).toBe("idle")
    expect(child.consolidation.attemptId).toBeNull()
    expect(child.captureCounters).toEqual({ always: 0, likely: 0, noiseSkipped: 0 })
  })

  test("a running consolidation on the parent leaves the child idle", async () => {
    const parent = emptyMemory("run_p")
    parent.needsConsolidation = true
    parent.consolidation = {
      ...emptyConsolidation(),
      state: "running",
      attemptId: "att-1",
      startedAt: new Date().toISOString(),
    }
    addActivity(parent, { kind: "error", target: "boom.ts" })
    await writeMemory("run_p", parent)

    await copyMemory("run_p", "run_c")

    const child = await readMemory("run_c")
    expect(child.needsConsolidation).toBe(false)
    expect(child.consolidation.state).toBe("idle")
    expect(child.consolidation.attemptId).toBeNull()
    expect(child.consolidation.startedAt).toBeNull()
    expect(child.pendingActivity).toEqual([])
    // parent tidak terganggu
    const parentAfter = await readMemory("run_p")
    expect(parentAfter.consolidation.state).toBe("running")
    expect(parentAfter.consolidation.attemptId).toBe("att-1")
  })

  test("a five-generation chain keeps depth, dedupes lines, newest curated at head", async () => {
    const gen0 = emptyMemory("gen0")
    gen0.summaryFacts = "- command: bun test (9x)"
    await writeMemory("gen0", gen0)

    let prev = "gen0"
    for (let i = 1; i <= 5; i++) {
      await copyMemory(prev, `gen${i}`)
      const cur = await readMemory(`gen${i}`)
      // generasi ini mengerjakan pekerjaannya sendiri, lalu konsolidasi jadi facts
      cur.summaryFacts = `- file: src/gen${i}.ts\n- command: bun test (${i}x)`
      cur.pendingActivity = [
        { id: `fresh-${i}`, kind: "file", target: `fresh-${i}.ts`, command: null, count: 1, createdAt: new Date().toISOString() },
      ]
      await writeMemory(`gen${i}`, cur)
      prev = `gen${i}`
    }

    const last = await readMemory("gen5")
    expect(last.inheritedDepth).toBe(5)
    const lines = last.summaryFactsInherited.split("\n").filter(Boolean)
    // urutan HEAD = kurasi terbaru (activity pending parent terakhir)
    expect(lines[0]).toBe("- file: fresh-4.ts")
    // tidak ada baris duplikat (kunci kind+target, suffix (Nx) dilucuti)
    const keys = lines.map((line) => {
      const m = line.match(/^- (file|command|error): (.+?)(?: \(\d+x\))?$/)
      return m ? `${m[1]}\u0000${m[2]}` : line
    })
    expect(new Set(keys).size).toBe(keys.length)
    // facts tiap generasi selamat dalam rantai
    for (let i = 1; i <= 4; i++) {
      expect(lines).toContain(`- file: src/gen${i}.ts`)
    }
  })
})
