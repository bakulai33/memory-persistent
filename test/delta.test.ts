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
  runConsolidation,
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
    m.summary = "combined old summary"
    addPendingTurn(m, turn("t1", "hello"))
    addPendingTurn(m, turn("t2", "world"))
    addActivity(m, { kind: "file", target: "src/index.ts" })
    addActivity(m, { kind: "command", target: "git commit" })
    addActivity(m, { kind: "error", target: "boom" })
    beginAttempt(m, "attempt-1")
    const delta = collectDelta(m)
    expect(delta.turnIds).toEqual(["t1", "t2"])
    expect(delta.turns).toEqual([
      { turnId: "t1", excerpt: "hello" },
      { turnId: "t2", excerpt: "world" },
    ])
    expect(delta.activityIds).toEqual(m.pendingActivity.map((a) => a.id))
    expect(delta.summary).toBe("combined old summary")
    expect(delta.facts).toContain("- file: src/index.ts")
    expect(delta.facts).toContain("- command: git commit")
    expect(delta.facts).toContain("- error: boom")
    expect(delta.attemptId).toBe("attempt-1")
    expect(delta.notes).toEqual(m.notes)
  })

  test("buildConsolidationPrompt carries turn excerpts, not turn ids", () => {
    const m = emptyMemory("s5")
    m.summary = "old combined summary"
    beginAttempt(m, "attempt-prompt")
    addPendingTurn(m, turn("turn-id-9", "the user wants cobalt widgets"))
    addActivity(m, { kind: "file", target: "src/index.ts" })
    appendNote(m, "remember this")
    const delta = collectDelta(m)
    const prompt = buildConsolidationPrompt(delta, 900)
    expect(prompt).toContain("the user wants cobalt widgets")
    expect(prompt).not.toContain("turn-id-9")
    expect(prompt).toContain("old combined summary")
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
    addActivity(m, { kind: "file", target: "src/index.ts" })
    const delta = collectDelta(m)
    addPendingTurn(m, turn("t3", "c"))
    applyDelta(m, delta, "narrative")
    expect(m.pendingTurns.map((t) => t.turnId)).toEqual(["t3"])
    expect(m.summaryFacts).toBe("- file: src/index.ts")
    expect(m.summaryNarrative).toBe("narrative")
    expect(m.summary).toContain("- file: src/index.ts")
    expect(m.summary).toContain("narrative")
    expect(m.summaryFacts).not.toContain("narrative")
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

  test("applyDelta redacts the narrative before storing it", () => {
    const m = emptyMemory("s5")
    beginAttempt(m, "a5")
    addPendingTurn(m, turn("t1", "a"))
    const delta = collectDelta(m)
    applyDelta(m, delta, "used key AKIAIOSFODNN7EXAMPLE for the deploy")
    expect(m.summaryNarrative).toContain("[REDACTED]")
    expect(m.summaryNarrative).not.toContain("AKIA")
    expect(m.summary).not.toContain("AKIA")
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

  test("applyDelta accumulates facts and the next delta carries the narrative", () => {
    const m = emptyMemory("s6")
    beginAttempt(m, "cycle-1")
    addActivity(m, { kind: "file", target: "src/index.ts" })
    const first = collectDelta(m)
    applyDelta(m, first, "first cycle narrative")
    expect(m.summaryFacts).toBe("- file: src/index.ts")
    expect(m.summaryNarrative).toBe("first cycle narrative")
    expect(m.summary).toContain("first cycle narrative")

    beginAttempt(m, "cycle-2")
    addActivity(m, { kind: "command", target: "bun test" })
    const second = collectDelta(m)
    expect(second.summary).toContain("first cycle narrative")
    const prompt = buildConsolidationPrompt(second, 900)
    expect(prompt).toContain("first cycle narrative")

    applyDelta(m, second, "second cycle narrative")
    expect(m.summaryFacts).toContain("- file: src/index.ts")
    expect(m.summaryFacts).toContain("- command: bun test")
    expect(m.summaryNarrative).toBe("second cycle narrative")
    expect(m.summary).toContain("- file: src/index.ts")
    expect(m.summary).toContain("- command: bun test")
    expect(m.summary).toContain("second cycle narrative")
    expect(m.summaryFacts).not.toContain("second cycle narrative")
  })

  test("runConsolidation runs collect, generate, apply in order with no lock during generate", async () => {
    const delta: Delta = {
      attemptId: "attempt-orchestration",
      turnIds: [],
      activityIds: [],
      turns: [],
      notes: [],
      summary: "",
      facts: "",
    }
    const order: string[] = []
    let locked = false
    let generateSawLock = true
    const result = await runConsolidation({
      collect: async () => {
        locked = true
        order.push("collect")
        try {
          return delta
        } finally {
          locked = false
        }
      },
      generate: async () => {
        order.push("generate")
        generateSawLock = locked
        return "narrative"
      },
      apply: async () => {
        locked = true
        order.push("apply")
        locked = false
      },
    })
    expect(result).toBe("applied")
    expect(order).toEqual(["collect", "generate", "apply"])
    expect(generateSawLock).toBe(false)
  })

  test("runConsolidation skips when collect returns null", async () => {
    let generated = 0
    let applied = 0
    const result = await runConsolidation({
      collect: async () => null,
      generate: async () => {
        generated += 1
        return "narrative"
      },
      apply: async () => {
        applied += 1
      },
    })
    expect(result).toBe("skipped")
    expect(generated).toBe(0)
    expect(applied).toBe(0)
  })

  test("runConsolidation reports a generate failure and calls fail", async () => {
    const delta: Delta = {
      attemptId: "attempt-failure",
      turnIds: [],
      activityIds: [],
      turns: [],
      notes: [],
      summary: "",
      facts: "",
    }
    const failures: { delta: Delta; error: string }[] = []
    let applied = 0
    const result = await runConsolidation({
      collect: async () => delta,
      generate: async () => {
        throw new Error("provider down")
      },
      apply: async () => {
        applied += 1
      },
      fail: async (failedDelta, error) => {
        failures.push({ delta: failedDelta, error })
      },
    })
    expect(result).toBe("failed")
    expect(applied).toBe(0)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.error).toContain("provider down")
    expect(failures[0]?.delta).toBe(delta)
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