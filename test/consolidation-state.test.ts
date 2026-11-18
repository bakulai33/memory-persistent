import { describe, test, expect } from "bun:test"
import { emptyMemory } from "../src/storage"
import {
  emptyConsolidation,
  backoffMs,
  beginAttempt,
  deltaAttemptId,
  activeAttemptAt,
  finishSuccess,
  finishFailure,
  recoverStaleAttempt,
  retryDelayMs,
  canConsolidate,
} from "../src/consolidation"
import { addPendingTurn, applyDelta, collectDelta } from "../src/memory"

describe("consolidation state", () => {
  test("emptyConsolidation", () => {
    const c = emptyConsolidation()
    expect(c.state).toBe("idle")
    expect(c.attemptId).toBeNull()
    expect(c.consecutiveFailures).toBe(0)
  })

  test("beginAttempt", () => {
    const m = emptyMemory("s1")
    beginAttempt(m, "idA")
    expect(m.consolidation.state).toBe("running")
    expect(m.consolidation.attemptId).toBe("idA")
    expect(m.consolidation.startedAt).not.toBeNull()
  })

  test("finishSuccess guard", () => {
    const m = emptyMemory("s1")
    beginAttempt(m, "idB")
    const before = { ...m.consolidation }
    const ok = finishSuccess(m, "idA")
    expect(ok).toBe(false)
    expect(m.consolidation.state).toBe(before.state)
    expect(m.consolidation.attemptId).toBe("idB")
  })

  test("finishSuccess match", () => {
    const m = emptyMemory("s1")
    beginAttempt(m, "idA")
    const ok = finishSuccess(m, "idA")
    expect(ok).toBe(true)
    expect(m.consolidation.state).toBe("idle")
    expect(m.consolidation.consecutiveFailures).toBe(0)
    expect(m.consolidation.error).toBeNull()
  })

  test("finishFailure", () => {
    const m = emptyMemory("s1")
    beginAttempt(m, "idA")
    const ok = finishFailure(m, "idA", "boom")
    expect(ok).toBe(true)
    expect(m.consolidation.state).toBe("failed")
    expect(m.consolidation.error).toBe("boom")
    expect(m.consolidation.consecutiveFailures).toBe(1)
  })

  test("finishFailure redacts the error", () => {
    const m = emptyMemory("s2")
    beginAttempt(m, "idB")
    const ok = finishFailure(m, "idB", "auth failed: password=hunter2")
    expect(ok).toBe(true)
    expect(m.consolidation.error).toContain("[REDACTED]")
    expect(m.consolidation.error).not.toContain("hunter2")
  })

  test("recoverStaleAttempt stale", () => {
    const m = emptyMemory("s1")
    // A FOREIGN attempt: written by another process, never registered in this
    // one — so recovery must mark it stale (T2.4 protects registered
    // in-process attempts instead; see the registry tests below).
    m.consolidation.state = "running"
    m.consolidation.attemptId = "foreign"
    m.consolidation.startedAt = new Date(Date.now() - 6 * 60_000).toISOString()
    const ok = recoverStaleAttempt(m, Date.now())
    expect(ok).toBe(true)
    const state: string = m.consolidation.state
    expect(state).toBe("failed")
    expect(m.consolidation.consecutiveFailures).toBe(1)
  })

  test("recoverStaleAttempt fresh", () => {
    const m = emptyMemory("s1")
    beginAttempt(m, "idA")
    const ok = recoverStaleAttempt(m, Date.now())
    expect(ok).toBe(false)
  })

  test("backoffMs", () => {
    expect(backoffMs(0)).toBe(0)
    expect(backoffMs(1)).toBe(60_000)
    expect(backoffMs(2)).toBe(120_000)
    expect(backoffMs(3)).toBe(240_000)
    expect(backoffMs(4)).toBe(480_000)
    expect(backoffMs(5)).toBe(600_000)
    expect(backoffMs(50)).toBe(600_000)
  })

  test("finishFailure guards non-finite consecutiveFailures", () => {
    const m = emptyMemory("s3")
    beginAttempt(m, "attempt-nan")
    m.consolidation.consecutiveFailures = NaN as any
    const ok = finishFailure(m, "attempt-nan", "boom")
    expect(ok).toBe(true)
    expect(Number.isFinite(m.consolidation.consecutiveFailures)).toBe(true)
    expect(m.consolidation.consecutiveFailures).toBe(1)
  })

  test("backoffMs is finite for garbage input", () => {
    expect(Number.isFinite(backoffMs(NaN))).toBe(true)
    expect(Number.isFinite(backoffMs(-1))).toBe(true)
    expect(Number.isFinite(backoffMs(1.5))).toBe(true)
    expect(backoffMs(NaN)).toBe(0)
  })

  test("retryDelayMs is finite for missing failure count", () => {
    const m = emptyMemory("s2")
    m.needsConsolidation = true
    m.consolidation.state = "failed"
    m.consolidation.lastAttemptAt = new Date(Date.now() - 6 * 60_000).toISOString()
    m.consolidation.consecutiveFailures = NaN as any
    const wait = retryDelayMs(m)
    expect(Number.isFinite(wait)).toBe(true)
    expect(canConsolidate(m)).toBe(true)
  })
})

describe("active attempt registry (T2.4)", () => {
  test("beginAttempt registers the attempt; finishing deletes it", () => {
    const m = emptyMemory("ses_reg")
    const id = deltaAttemptId()
    beginAttempt(m, id, 1_000_000)
    expect(activeAttemptAt(id)).toBe(1_000_000)
    expect(finishSuccess(m, id, 1_000_001)).toBe(true)
    expect(activeAttemptAt(id)).toBeNull()
  })

  test("finishFailure deletes the registration too", () => {
    const m = emptyMemory("ses_reg_fail")
    const id = deltaAttemptId()
    beginAttempt(m, id, 1_000_000)
    expect(finishFailure(m, id, "boom", 1_000_001)).toBe(true)
    expect(activeAttemptAt(id)).toBeNull()
  })

  test("a failed attempt without finish does not keep a permanent entry", () => {
    const lost = deltaAttemptId()
    beginAttempt(emptyMemory("ses_orphan_a"), lost, 0)
    // A later begin prunes registrations older than the TTL: a fiber that
    // died mid-run (crash) must not protect its attempt forever.
    const fresh = deltaAttemptId()
    beginAttempt(emptyMemory("ses_orphan_b"), fresh, 31 * 60_000)
    expect(activeAttemptAt(lost)).toBeNull()
    expect(activeAttemptAt(fresh)).toBe(31 * 60_000)
  })

  test("a live in-process attempt survives stale recovery (slow model kept)", () => {
    const m = emptyMemory("ses_slow")
    const id = deltaAttemptId()
    beginAttempt(m, id, 1_000_000)
    // 6 minutes later: past the 5 min running timeout, but the fiber is alive.
    expect(recoverStaleAttempt(m, 1_000_000 + 6 * 60_000)).toBe(false)
    expect(m.consolidation.state).toBe("running")
    expect(m.consolidation.attemptId).toBe(id)
  })

  test("an unregistered stale attempt is recovered after the registration TTL", () => {
    const m = emptyMemory("ses_zombie")
    const id = deltaAttemptId()
    beginAttempt(m, id, 0)
    // Simulate the fiber dying with the process: the TTL prunes the entry.
    beginAttempt(emptyMemory("ses_zombie_b"), deltaAttemptId(), 31 * 60_000)
    expect(recoverStaleAttempt(m, 31 * 60_000)).toBe(true)
    expect(m.consolidation.state).toBe("failed")
    expect(m.consolidation.error).toBe("stale attempt (timeout)")
    expect(m.consolidation.attemptId).toBeNull()
  })
})

describe("stale apply guard (T2.4)", () => {
  test("a live attempt applies its narrative despite the slow model call", () => {
    const m = emptyMemory("ses_live_apply")
    m.needsConsolidation = true
    addPendingTurn(m, { turnId: "t1", messageID: "m1", userExcerpt: "hello", createdAt: "" })
    const delta = collectDelta(m)
    beginAttempt(m, delta.attemptId!, 1_000_000)
    expect(recoverStaleAttempt(m, 1_000_000 + 6 * 60_000)).toBe(false)
    expect(applyDelta(m, delta, "fresh narrative")).toBe(true)
    expect(m.summaryNarrative).toBe("fresh narrative")
    expect(m.pendingTurns).toEqual([])
    expect(m.needsConsolidation).toBe(false)
  })

  test("a stale apply is a no-op returning false and keeps needsConsolidation", () => {
    const m = emptyMemory("ses_stale_apply")
    m.needsConsolidation = true
    addPendingTurn(m, { turnId: "t1", messageID: "m1", userExcerpt: "hello", createdAt: "" })
    const delta = collectDelta(m)
    beginAttempt(m, delta.attemptId!, 0)
    // Another writer recovers the stale attempt before our apply lands.
    beginAttempt(emptyMemory("ses_stale_b"), deltaAttemptId(), 31 * 60_000)
    expect(recoverStaleAttempt(m, 31 * 60_000)).toBe(true)
    expect(applyDelta(m, delta, "late narrative")).toBe(false)
    expect(m.summaryNarrative).not.toBe("late narrative")
    expect(m.pendingTurns.map((t) => t.turnId)).toEqual(["t1"])
    expect(m.needsConsolidation).toBe(true)
  })

  test("an apply for a superseded attemptId is rejected", () => {
    const m = emptyMemory("ses_mismatch")
    m.needsConsolidation = true
    const delta = collectDelta(m)
    expect(applyDelta(m, { ...delta, attemptId: "superseded" }, "late")).toBe(false)
    expect(m.needsConsolidation).toBe(true)
  })
})
