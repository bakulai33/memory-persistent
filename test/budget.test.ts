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

describe("B1 own wins, inherited per-block truncated (Task 3.3)", () => {
  test("own facts survive; inherited truncated from head under small budget (B1)", () => {
    const m = emptyMemory("ses_own")
    // Own facts long enough that tail-keep over the COMBINED text would cut
    // into own's HEAD — inverting to per-block must keep all own lines.
    m.summaryFacts = Array.from({ length: 8 }, (_, i) => `- file: src/own_module_${i}.ts`).join("\n")
    m.summaryFactsInherited = Array.from({ length: 8 }, (_, i) => `- file: src/inherited_${i}.ts`).join("\n")
    const out = buildInjection(m, 300)
    for (let i = 0; i < 8; i++) {
      expect(out).toContain(`src/own_module_${i}.ts`)
    }
    // Inherited tail must be visibly truncated, but the depth-LABEL survives
    // (label is the HEAD of the inherited block, kept via keep-head trunc).
    const i0 = out.indexOf("src/inherited_0.ts")
    const i7 = out.indexOf("src/inherited_7.ts")
    // At least one inherited tail member is dropped under the budget.
    expect(i0 === -1 || i7 === -1).toBe(true)
  })

  test("fallback: newest line prefix-cut when no whole line fits (A6)", () => {
    const m = emptyMemory("ses_fb")
    // Both lines live in the SAME fact text; the newest one is so big that no
    // whole line fits → only the NEWEST line survives, as a prefix.
    m.summaryFacts = `- command: old_tail\n- command: ${"a".repeat(4000)}`
    const out = buildInjection(m, 200)
    // old_tail (older line, same block) is fully dropped, not head-trimmed.
    expect(out).not.toContain("old_tail")
    // some "a…" prefix of the newest survives
    expect(out).toContain("aaa")
  })
})

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

  test("injeksiTidakMelebihiBudget", () => {
    // Sections DIELONGI dari cap-nya agar jalur `total > usable` di allocate()
    // dan penskalaan + reservasi separator diuji dengan serius.
    const m = emptyMemory("ses_budget")
    // facts cap = 0.35 * budget; untuk budget 1000 => 350 token. Buatkan 3000 token.
    m.summaryFacts = Array.from({ length: 400 }, (_, i) => `- command: bun test number ${i} with padding text`).join("\n")
    // activity cap = 0.10 * budget; untuk budget 1000 => 100 token. Buatkan 2000 token.
    m.pendingActivity = Array.from({ length: 400 }, (_, i) => ({ id: `a${i}`, kind: "command", target: `cmd ${i} with some padding text here`, command: "c", count: 1, createdAt: "" } as any))
    // conversation cap = 0.30 * budget; untuk budget 1000 => 300 token. Buatkan 2000 token.
    m.pendingTurns = Array.from({ length: 20 }, (_, i) => ({ turnId: `t${i}`, messageID: `m${i}`, userExcerpt: "word ".repeat(200), createdAt: "", tier: "likely" } as any))
    // notes cap = 0.15 * budget; untuk budget 1000 => 150 token. Buatkan 1500 token.
    m.notes = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, text: "note text ".repeat(300), tags: [], createdAt: "", source: "manual" } as any))

    for (const budget of [500, 1000, 5000]) {
      const tokens = defaultTokenCounter(buildInjection(m, budget))
      expect(tokens).toBeLessThanOrEqual(budget)
    }
  })

  test("sectionKecilTidakTerpotong", () => {
    const m = emptyMemory("ses_small")
    m.summary = "s".repeat(60000)
    m.pendingTurns = [{ turnId: "t1", messageID: "m1", userExcerpt: "IMPORTANT QUOTE", createdAt: "", tier: "likely" } as any]
    m.notes = [{ id: "n1", text: "IMPORTANT NOTE", tags: [], createdAt: "", source: "manual" } as any]
    const out = buildInjection(m, 5000)
    expect(out).toContain("IMPORTANT QUOTE")
    expect(out).toContain("IMPORTANT NOTE")
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