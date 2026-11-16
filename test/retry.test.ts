import { describe, test, expect } from "bun:test"
import { emptyMemory, addActivity, type PendingTurn } from "../src/storage"
import { addPendingTurn, appendNote, collectDelta, applyDelta } from "../src/memory"
import {
  beginAttempt,
  finishSuccess,
  finishFailure,
  shouldConsolidate,
  canConsolidate,
  retryDelayMs,
} from "../src/consolidation"

const turn = (id: string, excerpt: string): PendingTurn => ({
  turnId: id,
  messageID: id,
  userExcerpt: excerpt,
  createdAt: new Date().toISOString(),
})

const T0 = 1_752_000_000_000

/** Seeds one folded command activity (count 3) and a single pending turn. */
function seedBunTestMemory(sessionID: string) {
  const m = emptyMemory(sessionID)
  m.needsConsolidation = true
  for (let i = 0; i < 3; i++) addActivity(m, { kind: "command", target: "bun test" })
  addPendingTurn(m, turn("t1", "running the suite"))
  return m
}

describe("retry after failed consolidation", () => {
  test("(1) failed applyDelta keeps the flag and turns; retry succeeds after backoff", () => {
    const m = seedBunTestMemory("r1")
    beginAttempt(m, "att-1", T0)
    const delta = collectDelta(m)
    applyDelta(m, delta, "")
    finishFailure(m, "att-1", "boom", T0)

    expect(m.needsConsolidation).toBe(true)
    expect(m.pendingTurns.map((t) => t.turnId)).toEqual(["t1"])
    expect(m.pendingActivity).toEqual([])

    const later = T0 + 11 * 60_000
    expect(retryDelayMs(m, later)).toBe(0)
    expect(shouldConsolidate(m, later)).toBe(true)
    expect(canConsolidate(m, later)).toBe(true)

    beginAttempt(m, "att-2", later)
    const retry = collectDelta(m)
    expect(retry.activityIds).toEqual([])
    applyDelta(m, retry, "the user hardened the retry path")
    finishSuccess(m, "att-2", later)
    expect(m.summaryNarrative).toBe("the user hardened the retry path")
    expect(m.summaryFacts).toContain("- command: bun test (3x)")
    expect(m.pendingTurns).toEqual([])
  })

  test("(2) no count inflation: fail then succeed keeps the folded count at 3x [regression pin]", () => {
    const m = seedBunTestMemory("r2")
    beginAttempt(m, "att-1", T0)
    applyDelta(m, collectDelta(m), "")
    finishFailure(m, "att-1", "boom", T0)

    beginAttempt(m, "att-2", T0 + 11 * 60_000)
    applyDelta(m, collectDelta(m), "retry narrative")
    finishSuccess(m, "att-2", T0 + 11 * 60_000)

    expect(m.summaryFacts).toBe("- command: bun test (3x)")
    expect(m.summaryFacts).not.toContain("(6x)")
  })

  test("(3) a successful narrative survives a later failed attempt", () => {
    const m = emptyMemory("r3")
    m.needsConsolidation = true
    addActivity(m, { kind: "file", target: "src/a.ts" })
    beginAttempt(m, "att-1", T0)
    applyDelta(m, collectDelta(m), "MARKER-NARRATIVE-42")
    finishSuccess(m, "att-1", T0)

    addActivity(m, { kind: "file", target: "src/b.ts" })
    addPendingTurn(m, turn("t2", "more work"))
    beginAttempt(m, "att-2", T0 + 60_000)
    applyDelta(m, collectDelta(m), "")
    finishFailure(m, "att-2", "boom", T0 + 60_000)

    expect(m.summaryNarrative).toContain("MARKER-NARRATIVE-42")
    expect(m.summary).toContain("MARKER-NARRATIVE-42")
    expect(m.summaryFacts).toContain("src/a.ts")
    expect(m.summaryFacts).toContain("src/b.ts")
  })

  test("(4) consolidatedNotes is untouched by a failed attempt", () => {
    const m = emptyMemory("r4")
    m.needsConsolidation = true
    addActivity(m, { kind: "file", target: "src/a.ts" })
    appendNote(m, "note one")
    beginAttempt(m, "att-1", T0)
    applyDelta(m, collectDelta(m), "first narrative")
    finishSuccess(m, "att-1", T0)
    expect(m.consolidation.consolidatedNotes).toBe(1)

    appendNote(m, "note two") // captured but not consolidated yet
    addActivity(m, { kind: "file", target: "src/b.ts" })
    beginAttempt(m, "att-2", T0 + 60_000)
    applyDelta(m, collectDelta(m), "")
    finishFailure(m, "att-2", "boom", T0 + 60_000)

    expect(m.consolidation.consolidatedNotes).toBe(1)
    expect(m.needsConsolidation).toBe(true)
  })

  test("(5) non-empty narrative keeps the success branch behavior [regression pin]", () => {
    const m = seedBunTestMemory("r5")
    beginAttempt(m, "att-1", T0)
    applyDelta(m, collectDelta(m), "a real narrative")

    expect(m.pendingTurns).toEqual([])
    expect(m.pendingActivity).toEqual([])
    expect(m.summaryNarrative).toBe("a real narrative")
    expect(m.summaryFacts).toBe("- command: bun test (3x)")
    expect(m.consolidation.consolidatedNotes).toBe(0)
    expect(m.needsConsolidation).toBe(false)
  })
})
