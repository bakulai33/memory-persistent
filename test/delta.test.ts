import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  emptyMemory,
  addActivity,
  type PendingTurn,
  markDeleted,
  updateMemory,
  memoryPath,
} from "../src/storage"
import {
  addPendingTurn,
  appendNote,
  buildConsolidationPrompt,
  collectDelta,
  applyDelta,
  type Delta,
} from "../src/memory"
import { beginAttempt } from "../src/consolidation"

const turn = (id: string, excerpt: string): PendingTurn => ({
  turnId: id,
  messageID: id,
  userExcerpt: excerpt,
  createdAt: new Date().toISOString(),
})

describe("delta", () => {
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

  test("collectDelta returns pending ids, summary and facts", () => {
    const m = emptyMemory("s1")
    m.needsConsolidation = true
    m.summaryFacts = "old facts"
    addPendingTurn(m, turn("t1", "hello"))
    addPendingTurn(m, turn("t2", "world"))
    addActivity(m, { kind: "file", target: "src/index.ts" })
    addActivity(m, { kind: "command", target: "git commit" })
    addActivity(m, { kind: "error", target: "boom" })
    beginAttempt(m, "attempt-1")
    const delta = collectDelta(m)
    expect(delta.turnIds).toEqual(["t1", "t2"])
    expect(delta.activityIds).toEqual(m.pendingActivity.map((a) => a.id))
    expect(delta.summary).toBe("old facts")
    expect(delta.facts).toContain("- file: src/index.ts")
    expect(delta.facts).toContain("- command: git commit")
    expect(delta.facts).toContain("- error: boom")
    expect(delta.attemptId).toBe("attempt-1")
    expect(delta.notes).toEqual(m.notes)
  })

  test("buildConsolidationPrompt carries the delta sections and the budget", () => {
    const m = emptyMemory("s5")
    m.summaryFacts = "old facts"
    beginAttempt(m, "attempt-prompt")
    addPendingTurn(m, turn("t1", "hello"))
    addActivity(m, { kind: "file", target: "src/index.ts" })
    appendNote(m, "remember this")
    const delta = collectDelta(m)
    const prompt = buildConsolidationPrompt(delta, 900)
    expect(prompt).toContain("old facts")
    expect(prompt).toContain("- file: src/index.ts")
    expect(prompt).toContain("remember this")
    expect(prompt).toContain("900 token")
    expect(prompt).toContain("Jangan sertakan output mentah")
  })

  test("applyDelta keeps turns added during the model call", () => {
    const m = emptyMemory("s2")
    beginAttempt(m, "a1")
    addPendingTurn(m, turn("t1", "a"))
    addPendingTurn(m, turn("t2", "b"))
    const delta = collectDelta(m)
    addPendingTurn(m, turn("t3", "c"))
    applyDelta(m, delta, "narrative")
    expect(m.pendingTurns.map((t) => t.turnId)).toEqual(["t3"])
    expect(m.summary).toBe("narrative")
    expect(m.summaryNarrative).toBe("narrative")
  })

  test("applyDelta keeps activity added during the model call", () => {
    const m = emptyMemory("s2b")
    beginAttempt(m, "a1b")
    addActivity(m, { kind: "file", target: "src/index.ts" })
    const delta = collectDelta(m)
    addActivity(m, { kind: "command", target: "bun test" })
    applyDelta(m, delta, "narrative")
    expect(m.pendingActivity.map((a) => a.target)).toEqual(["bun test"])
  })

  test("applyDelta does not remove notes", () => {
    const m = emptyMemory("s3")
    beginAttempt(m, "a2")
    addPendingTurn(m, turn("t1", "a"))
    const delta = collectDelta(m)
    appendNote(m, "keep me")
    applyDelta(m, delta, "narr")
    expect(m.notes.length).toBe(1)
    expect(m.notes[0]?.text).toBe("keep me")
  })

  test("applyDelta is a no-op when attemptId differs", () => {
    const m = emptyMemory("s4")
    beginAttempt(m, "real")
    addPendingTurn(m, turn("t1", "a"))
    addActivity(m, { kind: "file", target: "src/index.ts" })
    appendNote(m, "note")
    const delta = collectDelta(m)
    const before = JSON.parse(JSON.stringify(m))
    const bad: Delta = { ...delta, attemptId: "other" }
    applyDelta(m, bad, "narr")
    expect(m).toEqual(before)
  })

  test("applyDelta after markDeleted does not recreate the file", async () => {
    const sid = "s-del"
    const m0 = emptyMemory(sid)
    beginAttempt(m0, "del-attempt")
    addPendingTurn(m0, turn("t1", "a"))
    const delta = collectDelta(m0)
    markDeleted(sid)
    await updateMemory(sid, (m) => {
      applyDelta(m, delta, "narr")
    })
    expect(existsSync(memoryPath(sid))).toBe(false)
  })
})