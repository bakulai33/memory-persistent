import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyDelta,
  buildFacts,
  collectDelta,
  mergeSummary,
  type Delta,
} from "../src/memory"
import { addActivity, emptyMemory } from "../src/storage"
import { beginAttempt } from "../src/consolidation"
import { defaultTokenCounter } from "../src/tokenizer"

const deltaWith = (facts: string): Delta => ({
  attemptId: "attempt-hybrid",
  turnIds: [],
  activityIds: [],
  turns: [],
  notes: [],
  summary: "",
  facts,
})

describe("hybrid facts and narrative", () => {
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

  test("buildFacts carries file, command and error lines", () => {
    const m = emptyMemory("s1")
    addActivity(m, { kind: "file", target: "src/index.ts" })
    addActivity(m, { kind: "command", target: "git commit" })
    addActivity(m, { kind: "error", target: "boom" })
    const facts = buildFacts(collectDelta(m))
    expect(facts).toContain("- file: src/index.ts")
    expect(facts).toContain("- command: git commit")
    expect(facts).toContain("- error: boom")
  })

  test("buildFacts drops blank and padded lines", () => {
    const facts = buildFacts(deltaWith("  - file: src/index.ts  \n\n- command: git commit\n- error: boom\n"))
    expect(facts).toBe("- file: src/index.ts\n- command: git commit\n- error: boom")
  })

  test("mergeSummary keeps the facts when the model produces no narrative", () => {
    const summary = mergeSummary("- file: src/index.ts\n- command: git commit", "", 5000)
    expect(summary.length).toBeGreaterThan(0)
    expect(summary).toContain("- file: src/index.ts")
    expect(summary).toContain("- command: git commit")
  })

  test("mergeSummary never exceeds the budget", () => {
    const facts = Array.from({ length: 200 }, (_, i) => `- file: src/module-${i}.ts`).join("\n")
    const narrative = "the model explains why the change happened. ".repeat(500)
    for (const budget of [1, 5, 50, 250, 1000, 5000]) {
      expect(defaultTokenCounter(mergeSummary(facts, narrative, budget))).toBeLessThanOrEqual(budget)
    }
  })

  test("mergeSummary keeps the newest facts when the facts exceed the budget", () => {
    const facts = Array.from({ length: 100 }, (_, i) => `- file: src/file-${i}.ts`).join("\n")
    const summary = mergeSummary(facts, "", 60)
    expect(defaultTokenCounter(summary)).toBeLessThanOrEqual(60)
    expect(summary).toContain("- file: src/file-99.ts")
  })

  test("applyDelta persists the facts when the model call fails", () => {
    const m = emptyMemory("s2")
    beginAttempt(m, "attempt-down")
    addActivity(m, { kind: "file", target: "src/index.ts" })
    const delta = collectDelta(m)
    applyDelta(m, delta, "", 5000)
    expect(m.summaryFacts).toContain("- file: src/index.ts")
    expect(m.summaryNarrative).toBe("")
    expect(m.summary).toContain("- file: src/index.ts")
    expect(m.pendingActivity).toHaveLength(0)
  })

  test("applyDelta keeps facts and narrative in separate halves", () => {
    const m = emptyMemory("s3")
    beginAttempt(m, "attempt-split")
    addActivity(m, { kind: "command", target: "git commit" })
    const delta = collectDelta(m)
    applyDelta(m, delta, "the model narrative", 5000)
    expect(m.summaryFacts).toContain("- command: git commit")
    expect(m.summaryFacts).not.toContain("the model narrative")
    expect(m.summaryNarrative).toBe("the model narrative")
    expect(m.summaryNarrative).not.toContain("- command: git commit")
    expect(m.summary).toContain("- command: git commit")
    expect(m.summary).toContain("the model narrative")
  })

  test("applyDelta clamps the merged summary to the budget", () => {
    const m = emptyMemory("s4")
    m.summaryFacts = Array.from({ length: 300 }, (_, i) => `- file: src/legacy-${i}.ts`).join("\n")
    beginAttempt(m, "attempt-budget")
    addActivity(m, { kind: "error", target: "boom" })
    const delta = collectDelta(m)
    applyDelta(m, delta, "long narrative ".repeat(1000), 120)
    expect(defaultTokenCounter(m.summary)).toBeLessThanOrEqual(120)
    // The persisted fact record still knows about the newest fact, and the
    // budgeted summary shows it too because the tail is the fresh half.
    expect(m.summaryFacts).toContain("- error: boom")
    expect(m.summary).toContain("- error: boom")
  })
})
