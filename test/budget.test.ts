import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildInjection,
  SUMMARY_BUDGET_SHARE,
  SUMMARY_SHARE,
  applyDelta,
  type Delta,
} from "../src/memory"
import { defaultTokenCounter } from "../src/tokenizer"
import { emptyMemory, addActivity } from "../src/storage"
import { beginAttempt } from "../src/consolidation"
import { collectDelta } from "../src/memory"

describe("budget alignment", () => {
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

  test("SUMMARY_SHARE equals SUMMARY_BUDGET_SHARE", () => {
    expect(SUMMARY_SHARE).toBe(SUMMARY_BUDGET_SHARE)
    expect(SUMMARY_BUDGET_SHARE).toBe(0.5)
  })

  test("buildInjection with 10000-token summaryFacts and budget 5000 keeps summary section <= 2500 tokens", () => {
    const m = emptyMemory("s1")
    m.summaryFacts = "w".repeat(10000 * 4)
    const out = buildInjection(m, 5000)
    // only summary present
    expect(defaultTokenCounter(out)).toBeLessThanOrEqual(2500)
  })

  test("written summary <= floor(budget * 0.5) tokens", () => {
    const budget = 5000
    const m = emptyMemory("s2")
    m.summaryFacts = Array.from({ length: 300 }, (_, i) => `- file: src/legacy-${i}.ts`).join("\n")
    beginAttempt(m, "attempt-budget")
    addActivity(m, { kind: "error", target: "boom" })
    const delta = collectDelta(m)
    applyDelta(m, delta, "long narrative ".repeat(1000), budget)
    expect(defaultTokenCounter(m.summary)).toBeLessThanOrEqual(Math.floor(budget * 0.5))
  })

  test("buildInjection includes summaryFacts and summaryNarrative", () => {
    const m = emptyMemory("s3")
    m.summaryFacts = "FACTS-MARKER-XYZ"
    m.summaryNarrative = "NARRATIVE-MARKER-XYZ"
    const out = buildInjection(m, 5000)
    expect(out).toContain("FACTS-MARKER-XYZ")
    expect(out).toContain("NARRATIVE-MARKER-XYZ")
  })

  test("narrative survives when facts fill their slice", () => {
    const m = emptyMemory("s4")
    m.summaryFacts = Array.from({ length: 200 }, (_, i) => `- file: src/module-${i}.ts`).join("\n")
    m.summaryNarrative = "NARRATIVE-SURVIVES-MARKER"
    const out = buildInjection(m, 5000)
    expect(out).toContain("NARRATIVE-SURVIVES-MARKER")
  })
})