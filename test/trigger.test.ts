import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyMemory, addActivity, type PendingTurn } from "../src/storage"
import { addPendingTurn, appendNote } from "../src/memory"
import { shouldConsolidate, countNewNotes } from "../src/consolidation"

const turn = (id: string, excerpt: string): PendingTurn => ({
  turnId: id,
  messageID: id,
  userExcerpt: excerpt,
  createdAt: new Date().toISOString(),
})

describe("trigger (delta threshold)", () => {
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

  test("a single note alone does not trigger", () => {
    const m = emptyMemory("s1")
    m.needsConsolidation = true
    appendNote(m, "just one note")
    expect(countNewNotes(m)).toBe(1)
    expect(shouldConsolidate(m)).toBe(false)
  })

  test("four pending turns trigger", () => {
    const m = emptyMemory("s2")
    m.needsConsolidation = true
    for (let i = 0; i < 4; i++) addPendingTurn(m, turn(`t${i}`, `turn ${i}`))
    expect(shouldConsolidate(m)).toBe(true)
  })

  test("eight activity entries trigger", () => {
    const m = emptyMemory("s3")
    m.needsConsolidation = true
    for (let i = 0; i < 8; i++) addActivity(m, { kind: "file", target: `src/f${i}.ts` })
    expect(shouldConsolidate(m)).toBe(true)
  })

  test("one new note plus a large delta (>= 500 tokens) triggers", () => {
    const m = emptyMemory("s4")
    m.needsConsolidation = true
    appendNote(m, "remember this")
    m.summary = "word ".repeat(600)
    expect(shouldConsolidate(m)).toBe(true)
  })

  test("needsConsolidation false → false", () => {
    const m = emptyMemory("s5")
    m.needsConsolidation = false
    for (let i = 0; i < 4; i++) addPendingTurn(m, turn(`t${i}`, `turn ${i}`))
    m.needsConsolidation = false
    expect(shouldConsolidate(m)).toBe(false)
  })

  test("idle longer than 10 minutes triggers", () => {
    const m = emptyMemory("s6")
    m.needsConsolidation = true
    m.consolidation.lastAttemptAt = new Date(Date.now() - 11 * 60_000).toISOString()
    expect(shouldConsolidate(m, Date.now())).toBe(true)
  })

  test("countNewNotes uses consolidatedNotes marker", () => {
    const m = emptyMemory("s7")
    appendNote(m, "a")
    appendNote(m, "b")
    m.consolidation.consolidatedNotes = 1
    expect(countNewNotes(m)).toBe(1)
  })
})