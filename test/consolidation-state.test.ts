import { describe, test, expect } from "bun:test"
import { emptyMemory } from "../src/storage"
import {
  emptyConsolidation,
  backoffMs,
  beginAttempt,
  finishSuccess,
  finishFailure,
  recoverStaleAttempt,
  retryDelayMs,
  canConsolidate,
} from "../src/consolidation"

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
    beginAttempt(m, "idA", Date.now() - 6 * 60_000)
    const ok = recoverStaleAttempt(m, Date.now())
    expect(ok).toBe(true)
    expect(m.consolidation.state).toBe("failed")
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
